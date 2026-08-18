import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEncoding, decodeText, textScore } from './encoding.ts';
import { splitLines, parseChapters, BUILTIN_RULES } from './chapter.ts';

/**
 * 真实 GBK 字节，用 Windows 936 代码页生成一次后固化在这里
 * （Node 只能解 GBK、编不出来，所以 fixture 不能在测试里现造）。
 * 原文：第一章 初入江湖 / 少年提剑出门，风雪满衣。/ 第二章 客栈遇故人 / 他在客栈里遇到了旧识。
 */
const GBK_SAMPLE = Buffer.from(
  'b5dad2bbd5c220b3f5c8ebbdadbafe0ac9d9c4eacce1bda3b3f6c3c5a3acb7e7d1a9c2fad2c2a1a3' +
    '0ab5dab6fed5c220bfcdd5bbd3f6b9cac8cb0acbfbd4dabfcdd5bbc0efd3f6b5bdc1cbbec9cab6a1a3',
  'hex',
);

/** 造一本 UTF-8 的书：每章带足够长的正文，越过平均章节长度下限 */
function makeBook(titles: string[], filler = '风雪夜归人，孤灯照旧影。'.repeat(47)): Buffer {
  return Buffer.from(titles.map((t) => `${t}\n${filler}\n`).join(''), 'utf8');
}

test('BOM 优先，且解码时被跳过', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一章 开端', 'utf8')]);
  const d = detectEncoding(buf);
  assert.equal(d.encoding, 'utf-8');
  assert.equal(d.confidence, 1);
  assert.equal(decodeText(buf, 'utf-8'), '第一章 开端', 'BOM 不该出现在正文里');
});

test('GBK 中文能被认出来——即使它整段都是合法的 UTF-8 字节', () => {
  // 这条是这个模块存在的理由：单看 UTF-8 校验会误判，必须靠常用字打分翻盘
  const d = detectEncoding(GBK_SAMPLE);
  assert.equal(d.encoding, 'gb18030');
  assert.ok(decodeText(GBK_SAMPLE, 'gb18030').startsWith('第一章 初入江湖'));
});

test('用错编码解出来的文本，打分必须明显低于用对的', () => {
  const right = textScore(decodeText(GBK_SAMPLE, 'gb18030'));
  const wrong = textScore(decodeText(GBK_SAMPLE, 'big5'));
  assert.ok(right > wrong, `gb18030(${right.toFixed(3)}) 应高于 big5(${wrong.toFixed(3)})`);
});

test('纯 ASCII 不该被判成 GB18030', () => {
  assert.equal(detectEncoding(Buffer.from('Chapter 1\nHello world.\n', 'utf8')).encoding, 'utf-8');
});

test('无 BOM 的中文 UTF-16 也能认出来', () => {
  // 中文 UTF-16 里汉字两个字节都非零，「数 0x00」那类启发式在这儿一个都数不到，
  // 只能靠打分。这条测例挡的就是有人再把那种判据加回来。
  const buf = Buffer.from('第一章 开端\n少年提剑出门。\n'.repeat(33), 'utf16le');
  assert.equal(detectEncoding(buf).encoding, 'utf-16le');
});

test('splitLines 的字节偏移在 GBK 下必须精确', () => {
  // 最关键的一条：offset 是要喂给 fs.read 的字节偏移，字符数在 GBK 下对不上
  const lines = splitLines(GBK_SAMPLE, 'gb18030');
  assert.equal(lines.length, 4);
  for (const line of lines) {
    const slice = GBK_SAMPLE.subarray(line.byteOffset, line.byteOffset + Buffer.byteLength(line.text, 'utf8'));
    assert.ok(
      new TextDecoder('gb18030').decode(slice).startsWith(line.text.slice(0, 3)),
      `偏移 ${line.byteOffset} 处读到的不是这一行`,
    );
  }
  assert.equal(lines[2].text, '第二章 客栈遇故人');
});

test('按偏移量切回去，读到的就是那一章', () => {
  // 整个应用「不存正文、按偏移读」的前提就是这条不变式
  const buf = makeBook(['第一章 初入江湖', '第二章 客栈遇故人', '第三章 雪夜刀光']);
  const { chapters, recognized, ruleName } = parseChapters(buf, 'utf-8');

  assert.ok(recognized);
  assert.equal(ruleName, 'standard');
  assert.equal(chapters.length, 3);

  for (const ch of chapters) {
    const text = buf.subarray(ch.offset, ch.offset + ch.length).toString('utf8');
    assert.ok(text.startsWith(ch.title), `第 ${ch.index} 章的偏移没落在标题上`);
  }
  // 首尾相接、覆盖全文，不能有空洞
  assert.equal(chapters[0].offset, 0);
  const last = chapters[chapters.length - 1];
  assert.equal(last.offset + last.length, buf.length);
});

test('正文里提到「第三章」不算标题', () => {
  const buf = Buffer.from(
    ['第一章 初入江湖', '风雪夜归人。'.repeat(94),
     '他想起第三章说过的那句话，于是又翻了一遍那本旧书，越读越觉得心惊。',
     '第二章 客栈遇故人', '孤灯照旧影。'.repeat(94)].join('\n'),
    'utf8',
  );
  const { chapters } = parseChapters(buf, 'utf-8');
  assert.equal(chapters.length, 2, '夹在正文里的那句不该被切成一章');
});

test('识别不出章节时机械分段，并标明未识别', () => {
  const buf = Buffer.from('没有任何章节标记的散文。'.repeat(5000), 'utf8');
  const { chapters, recognized, ruleName } = parseChapters(buf, 'utf-8');
  assert.equal(recognized, false);
  assert.equal(ruleName, 'fallback-chunk');
  assert.ok(chapters.length >= 1);
  assert.ok(chapters[0].title.startsWith('未识别章节'));
  assert.equal(chapters[0].offset, 0);
});

test('有卷标记时建立两级目录', () => {
  const filler = '风雪夜归人。'.repeat(94);
  const buf = Buffer.from(
    [`第一卷 少年游`, `第一章 初入江湖`, filler, `第二章 客栈遇故人`, filler,
     `第二卷 江湖老`, `第三章 雪夜刀光`, filler].join('\n'),
    'utf8',
  );
  const { chapters } = parseChapters(buf, 'utf-8');
  assert.equal(chapters.length, 3);
  assert.equal(chapters[0].volume, '第一卷 少年游');
  assert.equal(chapters[2].volume, '第二卷 江湖老');
});

test('自定义规则完全取代内置规则（规则编辑器走这条）', () => {
  const buf = makeBook(['@@@ 楔子', '@@@ 其一', '@@@ 其二']);
  assert.equal(parseChapters(buf, 'utf-8').recognized, false, '内置规则认不出这种写法');

  const { chapters, recognized } = parseChapters(buf, 'utf-8', [{ name: 'custom', pattern: /^@@@/ }]);
  assert.ok(recognized);
  assert.equal(chapters.length, 3);
  assert.equal(chapters[1].title, '@@@ 其一');
});

test('命中多且均匀的规则，胜过命中少的', () => {
  const buf = Buffer.from(
    ['正文 第一章 开端', '风雪。'.repeat(187), '第二章 承',  '风雪。'.repeat(187),
     '第三章 转', '风雪。'.repeat(187), '第四章 合', '风雪。'.repeat(187)].join('\n'),
    'utf8',
  );
  const { ruleName, chapters } = parseChapters(buf, 'utf-8', BUILTIN_RULES);
  assert.equal(ruleName, 'standard', 'body-prefix 只命中 1 次，不该胜出');
  // 4 不是 3：standard 现在把「正文 …」也认成标题（legado 的 NAMED 那组词）。
  // 原来它只切出后 3 章，**「正文 第一章 开端」连同它下面的正文被整段丢掉了**——
  // buildChapters 从第一处命中开始，命中不到第一章就等于那段内容凭空消失
  assert.equal(chapters.length, 4);
  assert.equal(chapters[0].offset, 0, '第一章必须从文件开头起，不许丢内容');
});

// ── 纯数字标题（`1反动派？`）────────────────────────────

const enc = (s: string) => new TextEncoder().encode(s);

test('纯数字开头的标题能切开——真实书库里有这种格式', () => {
  // 《北洋反动派》505 万字原来只切出 2 章，因为它的章节是 `1反动派？` `2准备`
  const body = (n: number) => `${'正文内容。'.repeat(112)}\n`;
  const text = Array.from({ length: 30 }, (_, i) => `${i + 1}第${i + 1}节标题\n${body(i)}`).join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.equal(r.ruleName, 'bare-number');
  assert.equal(r.chapters.length, 30);
  assert.equal(r.chapters[0].title, '1第1节标题');
});

test('前导零的也认——《横刀》就是 `01 雁然`', () => {
  const text = Array.from(
    { length: 20 },
    (_, i) => `${String(i + 1).padStart(2, '0')} 标题${i}\n${'正文。'.repeat(187)}\n`,
  ).join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.equal(r.ruleName, 'bare-number');
  assert.equal(r.chapters.length, 20);
});

test('正文里的日期和时刻不会被当成章节', () => {
  // 《东京医途》「1994年12月14日，日本关东地区」、
  // 《捡个萝莉当老婆》「5点半，我领着嘉琪出了门」——两本都因此被误判过
  const lines = [
    '1994年12月14日，日本关东地区，群马县。',
    '5点半，我领着嘉琪出了门，外面竟开始下雨。',
    '20瓶香槟很快就倒完了。',
    '250！？',
    '10月8日',
    '7点不到的时候我到了学校。',
  ];
  const text = lines.map((l) => `${l}\n${'正文。'.repeat(187)}\n`).join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.notEqual(r.ruleName, 'bare-number', `被 bare-number 误切成 ${r.chapters.length} 章`);
});

test('数字乱跳的不算章节——序号必须连得成递增序列', () => {
  // 这是把「真章节」和「正文里的数字」分开的唯一判据
  const nums = [3, 1994, 7, 250, 12, 5, 88, 2, 41, 6];
  const text = nums.map((n) => `${n}某句话\n${'正文。'.repeat(187)}\n`).join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.notEqual(r.ruleName, 'bare-number');
});

test('「第N章」格式优先，不会被 bare-number 抢走', () => {
  const text = Array.from(
    { length: 20 },
    (_, i) => `第${i + 1}章 标题${i}\n${'正文。'.repeat(187)}\n`,
  ).join('');
  assert.equal(parseChapters(enc(text), 'utf-8').ruleName, 'standard');
});

test('命中太少不算——宁可整本一章，也不能乱切', () => {
  // 切错了用户看到的是一本被剁碎的书，比整本一章更难受
  const text = `1开头\n${'正文。'.repeat(200)}\n2结尾\n${'正文。'.repeat(200)}\n`;
  const r = parseChapters(enc(text), 'utf-8');
  assert.notEqual(r.ruleName, 'bare-number');
});

test('`一、神仙醋` 这种顿号序号能切开', () => {
  // 《饕餮娘子》《德云日记》都是这个格式。行首序号紧跟顿号是很强的信号，
  // 正文句子极少这么起头
  const cn = '一二三四五六七八九十'.split('');
  const text = cn.map((n, i) => `${n}、标题${i}\n${'正文内容。'.repeat(112)}\n`).join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.equal(r.ruleName, 'num-sep');
  assert.equal(r.chapters.length, 10);
  assert.equal(r.chapters[0].title, '一、标题0');
});

// ── 从 legado 的 txtTocRule.json 搬过来的那批格式 ──────────────
// 每条都对应一类真实存在的 txt 写法。规则来源见 chapter.ts 里 BUILTIN_RULES 的注释

/*
 * 造一本书：每行当一个标题，后面跟一段正文。
 *
 * **正文要够长**（560 字）：一章不到 500 字会被 `buildChapters` 并进上一章，
 * 而那正是这些测试要区分的东西——夹具比真实的书短一个量级的话，
 * 量到的就不是真实那条路（真实库里每章中位数 3200 字）。
 *
 * ⚠️ **卷标题后面不跟正文**：卷头下面紧跟着就是第一章，真实的书就是这么排的。
 * 跟了的话第一处章节命中之前就攒够 1 KB，`buildChapters` 会给它立一章「前言」，
 * 于是「卷不算章」那条测试莫名其妙多出一章——**夹具的锅，不是代码的**。
 */
const book = (lines: string[]) =>
  enc(lines.map((l) => (纯卷头(l) ? l : `${l}\n${'正文内容。'.repeat(112)}`)).join('\n'));

/** 只有「第一卷 少年游」这种**光是卷头**的行才不跟正文。
 *  ⚠️ 「第Ⅰ卷 梦开始的地方 第001章 降临」是卷和章写在同一行，它是章，要跟正文——
 *  第一版漏了这一条，那本书一个字正文都没有，当场掉进机械分段。 */
const 纯卷头 = (l: string) => /^第.{1,6}[卷部集篇]/.test(l) && !l.includes('章');

for (const [what, lines, rule] of [
  ['序章/楔子这种无编号标题', ['序章 人生若只如初见', '第一章 起', '第二章 承', '第三章 转'], 'standard'],
  ['量词在前的 `章一`', ['章一 初入江湖', '章二 客栈', '章三 雪夜', '章四 刀光'], 'unit-first'],
  ['`分节阅读_N`（下载来的 txt 极常见）', ['某书分节阅读_1', '某书分节阅读_2', '某书分节阅读_3', '某书分节阅读_4'], 'split-read'],
  ['`书名（12）`', ['雪中悍刀行（1）', '雪中悍刀行（2）', '雪中悍刀行（3）', '雪中悍刀行（4）'], 'title-num'],
  ['`☆、重生`（晋江系）', ['☆、重生', '☆、入宫', '☆、封妃', '☆、殉情'], 'star-title'],
  ['`Part 1`', ['Part 1 起源', 'Part 2 觉醒', 'Part 3 归途', 'Part 4 终焉'], 'chapter-en'],
  // num-sep 带 ascendingRun 判据，至少要 5 处命中才作数，所以这条给 6 章
  ['`1.反动派`', ['1.反动派', '2.准备', '3.出发', '4.归来', '5.再战', '6.终局'], 'num-sep'],
] as const) {
  test(`legado 规则：${what}`, () => {
    const r = parseChapters(book([...lines]), 'utf-8', BUILTIN_RULES);
    assert.equal(r.ruleName, rule);
    assert.equal(r.chapters.length, lines.length);
    assert.equal(r.chapters[0].title, lines[0]);
  });
}

test('中文数字序号也要能判递增——`一、` 那批不能因为读不出数字就免检', () => {
  // leadingNumber 认不出中文数字的话，`一、二、三…` 全是 NaN，
  // ascendingRun 就等于没跑，num-sep 会退回「只要格式像就收」
  const good = ['一、起', '二、承', '三、转', '四、合', '五、终', '六、余'];
  const r = parseChapters(book(good), 'utf-8', BUILTIN_RULES);
  assert.equal(r.ruleName, 'num-sep');
  assert.equal(r.chapters.length, 6);

  // 序号乱跳的是正文里的巧合，不是章节
  const bad = ['三十、他说', '五、我想', '一百、那天', '二、后来', '八十、于是', '七、结果'];
  assert.equal(parseChapters(book(bad), 'utf-8', BUILTIN_RULES).recognized, false);
});

test('`书名 序号` 要求书名部分一致，否则正文里的短句会被当章节', () => {
  const same = ['雪中悍刀行1', '雪中悍刀行2', '雪中悍刀行3', '雪中悍刀行4'];
  const r = parseChapters(book(same), 'utf-8', BUILTIN_RULES);
  assert.equal(r.ruleName, 'title-num');
  assert.equal(r.chapters.length, 4);

  // 《琥珀之剑》就栽在这里：正文里的属性面板被当成了章节标题
  const junk = ['水元素1', '风元素3', '地2', '光5', '法力10', '火3'];
  assert.equal(parseChapters(book(junk), 'utf-8', BUILTIN_RULES).recognized, false);
});

test('光有「序章/番外/后记」不算章节结构，必须至少有一处带编号的第N章', () => {
  // 《魅生》《案藏玄机》《辛亥：摇晃的中国》都栽在这里
  const onlyNamed = ['番外：长生学画', '番外：紫颜刺绣', '番外：紫府主顾', '番外：梨园新人'];
  assert.equal(parseChapters(book(onlyNamed), 'utf-8', BUILTIN_RULES).recognized, false);

  // 有编号的话，序章就作为补充一起收进来——这才是加 NAMED 的本意
  const mixed = ['序章 人生若只如初见', '第一章 起', '第二章 承', '番外 后来的事'];
  const r2 = parseChapters(book(mixed), 'utf-8', BUILTIN_RULES);
  assert.equal(r2.ruleName, 'standard');
  assert.deepEqual(r2.chapters.map((c) => c.title), mixed);
});

test('「楔子/番外/前言」后面跟普通汉字的是正文，不是标题', () => {
  // 抽样真实书库时撞出来的：《不可名状的赛博朋克》的「前言不搭后语的一句话，
  // 这是祝觉故意这么发的。」、《九龙拉棺》的「扉页上写的是歪歪斜斜的两个字，雪阳。」
  // 都被 NAMED 那一支收成了章节。legado 原规则的 `.{0,30}$` 拦不住（这两句才二十来字），
  // 靠的是「后面必须跟行尾/空白/标点/序号」这个前瞻
  const real = ['楔子', '楔子 秀吉的野望', '番外：', '终章 无限的旅路', '尾声（一）兄弟', '番外一'];
  const prose = [
    '前言不搭后语的一句话，这是祝觉故意这么发的。',
    '扉页上写的是歪歪斜斜的两个字，雪阳。',
    '序言中提到的那个人后来再没出现过。',
  ];
  for (const t of [...real, ...prose]) {
    const r = parseChapters(book(['第一章 起', t, '第二章 承', '第三章 转', '第四章 合']), 'utf-8', BUILTIN_RULES);
    assert.equal(
      r.chapters.some((c) => c.title === t),
      real.includes(t),
      `「${t}」${real.includes(t) ? '该收' : '该拒'}`,
    );
  }
});

test('`※※※` 这类分隔线不是标题——符号后面得有能读的字', () => {
  // 不加前瞻的话《光年》被切成 126 章、每一章都叫「※※※」，而且这种误判会
  // 盖过真规则：《天机》被切成 191 段、《藏地密码》499 段，全是场景分隔线。
  // 「章节数变多」根本不等于「切对了」——判据得看标题本身像不像目录
  const dividers = ['※※※', '◇◇◇◇', '★★★'];
  for (const d of dividers) {
    const r = parseChapters(book(['第一章 起', d, '第二章 承', d, '第三章 转', '第四章 合']), 'utf-8', BUILTIN_RULES);
    assert.ok(!r.chapters.some((c) => c.title === d), `「${d}」是分隔线，不该成章`);
  }
  // 真的星标题还要认得
  const real = ['☆、重生', '☆、入宫', '☆、封妃', '☆、殉情'];
  const r2 = parseChapters(book(real), 'utf-8', BUILTIN_RULES);
  assert.equal(r2.ruleName, 'star-title');
  assert.deepEqual(r2.chapters.map((c) => c.title), real);
});

test('markdown 标题前缀要剥掉——有的下载源直接导出成 md', () => {
  // 全库 19 本这么写，都是大书：《那年华娱》19MB 有 1603 处 `# 第一章 新生【修】`。
  // 不剥的话行首是 `#`，所有规则的 `^第` 一律匹配不上，整本掉进机械分段
  const r = parseChapters(book(['# 第1章 忧国忧民', '# 第2章 我要的是陆逊', '## 第3章 好大', '# 第4章 收尾']), 'utf-8', BUILTIN_RULES);
  assert.equal(r.ruleName, 'standard');
  assert.deepEqual(r.chapters.map((c) => c.title), ['第1章 忧国忧民', '第2章 我要的是陆逊', '第3章 好大', '第4章 收尾']);
  assert.equal(r.chapters[0].offset, 0, '`#` 那几个字节仍然算在这一章里');
});

test('罗马数字卷号 / 段N / 〔一〕标题 / 第N幕', () => {
  const cases: Array<[string, string[], string]> = [
    // 《星海猎人》6.1MB，985 章全靠这个
    ['罗马数字卷', ['第Ⅰ卷 梦开始的地方 第001章 降临', '第Ⅰ卷 梦开始的地方 第002章 酒吧',
      '第Ⅱ卷 迷路的死神 第087章 疯狂', '第Ⅱ卷 迷路的死神 第088章 苏醒'], 'volume-chapter'],
    // 《乌纱》395 处、《奉天承运》261 处，全库只有这两本用，零误伤
    ['段N', ['段一 廷杖', '段二 卖笑', '段三 手枪', '段四 夜行'], 'unit-first'],
    // 《斩龙》220 处
    ['〔一〕标题', ['〔一〕桃花带杀', '〔二〕隐于陈塘风月', '〔三〕盘算', '〔四〕夜访'], 'bracket-lead'],
    // 《琥珀之剑》11.3MB，1467 处
    ['第N幕', ['第一幕 梦中人', '第二幕 苏菲的世界', '第三幕 远行', '第四幕 归来'], 'mu'],
  ];
  for (const [what, lines, rule] of cases) {
    const r = parseChapters(book(lines), 'utf-8', BUILTIN_RULES);
    assert.equal(r.ruleName, rule, what);
    assert.equal(r.chapters.length, lines.length, what);
  }
});

test('「第N幕」单独成规则，不并进 standard 的量词', () => {
  // 全库 206 本行首出现「第N幕」，真假参半：《琥珀之剑》是真章节，
  // 《蛊真人》的「第一幕徐徐在他眼前消散」是正文。并进 UNIT 会往本来切得好的书里
  // 塞假章节；单独成规则则由打分决定，有真「第N章」的书天然赢过它
  const mixed = ['第一章 起', '第一幕，在此终结。', '第二章 承', '第三章 转', '第四章 合'];
  const r = parseChapters(book(mixed), 'utf-8', BUILTIN_RULES);
  assert.equal(r.ruleName, 'standard');
  assert.ok(!r.chapters.some((c) => c.title.includes('在此终结')));
});

test('「第N回合」判为正文——这是量出来的取舍，不是想当然', () => {
  // 全库普查：8172 本里有 514 本行首出现「第N回合」，其中 **513 本是正文**
  // （体育、卡牌、打斗小说：「第二回合比赛。」「第一回合，李白胜。」），
  // 只有《魔装》一本拿它当章节单位。所以 `回(?![合来事去])` 保的是 513 本。
  // 《魔装》那种可以让用户在章节规则编辑器里单独设一条——那个功能就是干这个的
  const prose = ['第一章 起', '第二回合比赛。', '第二章 承', '第三章 转', '第四章 合'];
  const r = parseChapters(book(prose), 'utf-8', BUILTIN_RULES);
  assert.deepEqual(r.chapters.map((c) => c.title), ['第一章 起', '第二章 承', '第三章 转', '第四章 合']);
});

test('legado 的负向断言：「第三部分」「第二节课」不是章节', () => {
  // 这几个字后面不加断言的话，正文里一提到就会被切一刀。
  // 断言集抄自 legado：节(?!课) 回(?![合来事去]) 等等
  for (const noise of ['第三部分是这样的', '他上了第二节课', '两人打到第五回合']) {
    const r = parseChapters(book(['第一章 起', noise, '第二章 承', '第三章 转']), 'utf-8', BUILTIN_RULES);
    assert.equal(r.chapters.length, 3, `「${noise}」不该被当成章节`);
    assert.deepEqual(r.chapters.map((c) => c.title), ['第一章 起', '第二章 承', '第三章 转']);
  }
});

test('卷不算章：卷集部篇留给 VOLUME_RULES，否则两级目录会塌成一级', () => {
  // legado 的「目录」规则把卷集部篇和章并在一起收，那是因为它没有独立的卷概念。
  // 我们有，所以 UNIT 里故意不放这四个字
  const r = parseChapters(
    book(['第一卷 少年游', '第一章 起', '第二章 承', '第二卷 江湖老', '第三章 转']),
    'utf-8',
    BUILTIN_RULES,
  );
  assert.deepEqual(r.chapters.map((c) => c.title), ['第一章 起', '第二章 承', '第三章 转']);
  assert.equal(r.chapters[0].volume, '第一卷 少年游');
  assert.equal(r.chapters[2].volume, '第二卷 江湖老');
});

test('`【一·六个传说】` 这种方括号序号能切开', () => {
  // 已有的 bracket 规则要求括号里带「章/节/回」，《帝王心术》这种没有
  const cn = '一二三四五六'.split('');
  const text = cn.map((n, i) => `【${n}·标题${i}】\n${'正文内容。'.repeat(112)}\n`).join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.equal(r.ruleName, 'bracket-num');
  assert.equal(r.chapters.length, 6);
});

test('正文里的顿号列举不会被当成章节——守的是 num-sep 自己那条 `.{0,30}`', () => {
  // ⚠️ **这条测试写坏过三次，每次都是「断言在，但什么都没守住」。**
  // 三次的形状值得记下来，它们是「恒真断言」的三种典型死法：
  //
  //   一、**断言名指向一条不存在的规则**。原来写的是 `dun-num`，而那条早并进了
  //       `num-sep`，于是 `notEqual` 拿一个谁都不会返回的字符串去比，恒真。
  //   二、**样本没资格参赛**。改成 `num-sep` 之后依然恒真：原样本只有三行
  //       两百来字节，任何规则都过不了 `MIN_MEAN_CHAPTER_BYTES`，`ruleName`
  //       永远是 `fallback-chunk`，跟长度上限毫无关系。
  //   三、**挡住它的根本是另一条规矩**。把样本放大、序号也递增之后，长句仍然
  //       被拒——但拒它的是 `matchLines` 的 `MAX_TITLE_LEN = 40`（那条另有
  //       四条测试守着），不是 num-sep 的 `.{0,30}`。破坏 `.{0,30}` 照样全绿。
  //
  // 所以标题长度必须落在**只有 `.{0,30}` 说了算**的那个窗口里：
  // 序号 `N、` 之后超过 31 个字（num-sep 拒），而整行仍短于 40（MAX_TITLE_LEN 不管）。
  // 实测边界就在这儿：后缀 30 字 → num-sep 拿下，后缀 32 字 → 被拒。
  const body = '正文内容。'.repeat(400);
  const chapters = (title: (i: number) => string) =>
    Array.from({ length: 8 }, (_, i) => `${title(i)}\n${body}`).join('\n');
  const run = (suffixLen: number) =>
    parseChapters(
      // 序号必须**照样递增**：全写成 `1、` 的话是 `mostlyAscending` 挡掉的，
      // 长度上限又没参与，测试再一次变成恒真的
      enc(chapters((i) => `${i + 1}、${'一二三四五六七八九十'.repeat(56).slice(0, suffixLen)}`)),
      'utf-8',
    ).ruleName;

  // 正向对照：窗口下沿，num-sep 必须拿得下——没有这一半，
  // 「没被收走」既可能是长度上限干的，也可能是样本压根没资格参赛
  assert.equal(run(30), 'num-sep', '后缀 30 字（整行 32）应当被 num-sep 收走');

  // 真正要守的：只多两个字，越过 `.{0,30}` 但仍在 MAX_TITLE_LEN 之内
  assert.notEqual(run(32), 'num-sep', '后缀 32 字（整行 34）越过了 num-sep 的长度上限');
});

// ── splitLines 的分块解码（性能改造的正确性守卫）────────────

test('分块解码和逐行解码结果完全一致', () => {
  // splitLines 是章节偏移量的来源——错一个字节整本正文都读偏。
  // 改成分块解码之后，用「逐行解码」这个朴素实现当对照
  const naive = (buf: Uint8Array, encoding: 'utf-8') => {
    const dec = new TextDecoder(encoding);
    const out: Array<{ text: string; byteOffset: number }> = [];
    let start = 0;
    for (let i = 0; i <= buf.length; i++) {
      if (i === buf.length || buf[i] === 0x0a) {
        out.push({ text: dec.decode(buf.subarray(start, i)), byteOffset: start });
        start = i + 1;
      }
    }
    return out;
  };

  for (const text of [
    '',
    '只有一行没有换行',
    '第一行\n第二行\n',
    '\n\n\n连着三个空行在前面',
    `${'长行'.repeat(5000)}\n短行\n`,
    // 跨过 1MB 分块边界：块边界处的行不能被算两次或漏掉
    Array.from({ length: 3000 }, (_, i) => `第 ${i} 行，${'填充'.repeat(280)}`).join('\n'),
  ]) {
    const buf = new TextEncoder().encode(text);
    assert.deepEqual(
      splitLines(buf, 'utf-8').map((l) => [l.byteOffset, l.text]),
      naive(buf, 'utf-8').map((l) => [l.byteOffset, l.text]),
      `不一致：${JSON.stringify(text.slice(0, 30))}…（${buf.length} 字节）`,
    );
  }
});

test('GBK 下的字节偏移仍然对得上', () => {
  // 中文在 gb18030 里是两字节，字符位置和字节位置不等。
  // 分块解码要是按字符数算偏移，这里就会错
  const lines = splitLines(GBK_SAMPLE, 'gb18030');
  for (const l of lines) {
    if (!l.text) continue;
    const back = new TextDecoder('gb18030').decode(
      GBK_SAMPLE.subarray(l.byteOffset, l.byteOffset + Buffer.byteLength(l.text, 'utf8')),
    );
    assert.ok(back.startsWith(l.text[0]), `偏移 ${l.byteOffset} 处读到的不是这一行`);
  }
});

// ── 卷号在前 / 卷名夹中间（真实书库逼出来的）────────────

test('`卷一 卷土重来 第1章 人生无常` —— 卷号在「卷」后面', () => {
  // 原有的 volume-chapter 要求「第一卷」，这种写法一行都认不出来，
  // 《网游之纵横天下》9.4MB、《枭臣》8.3MB、《天下枭雄》7.1MB 全掉进机械分段
  const text = Array.from(
    { length: 30 },
    (_, i) => `卷一 卷土重来 第${i + 1}章 标题${i}\n${'正文内容。'.repeat(112)}\n`,
  ).join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.equal(r.ruleName, 'volume-first-chapter');
  assert.equal(r.chapters.length, 30);
});

test('`第一集 误入天庭 第一章 紫炎心` —— 「集」也是卷，且卷名夹在中间', () => {
  // 两处放宽缺一不可：字符类要有「集」，中间要允许卷名
  const cn = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const text = cn
    .map((n, i) => `第一集 误入天庭 第${n}章 标题${i}\n${'正文内容。'.repeat(112)}\n`)
    .join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.equal(r.ruleName, 'volume-chapter');
  assert.equal(r.chapters.length, 10);
});

test('紧挨着的 `第一卷第一章` 仍然认（放宽不能把老格式弄丢）', () => {
  const cn = ['一', '二', '三', '四', '五', '六', '七', '八'];
  const text = cn.map((n, i) => `第一卷第${n}章\n${'正文。'.repeat(187)}\n`).join('');
  assert.equal(parseChapters(enc(text), 'utf-8').ruleName, 'volume-chapter');
});

test('只在书末尾撞上几行的规则一律作废——否则前面整本书会凭空消失', () => {
  // 实测：《萌娘武侠世界》6.7MB，num-sep 只命中 4 行且全挤在 6.628M 处
  // （正文里的条件列表「一、朱元璋交出……」）。buildChapters 从第一处命中开始切，
  // **前面 6.6MB 不进任何章节**，而界面上显示「识别出 4 章」，看不出丢了东西。
  // 光看平均章长拦不住：那 4 行间隔 72/48/54 字节加一个 373KB 尾巴，平均反而只有 93KB
  const body = '正文内容。'.repeat(20_000); // 前面一大段没有任何标题
  const text = `${body}\n一、第一个条件\n二、第二个条件\n三、第三个条件\n四、第四个条件\n${'收尾。'.repeat(500)}`;
  const r = parseChapters(enc(text), 'utf-8');
  assert.equal(r.recognized, false, '这种命中不该被当成识别成功');
  assert.equal(r.ruleName, 'fallback-chunk');
  // 机械分段必须把整本都覆盖到，一个字节都不能漏
  const total = enc(text).length;
  assert.equal(r.chapters[0].offset, 0, '兜底分段要从文件开头切起');
  const last = r.chapters[r.chapters.length - 1];
  assert.equal(last.offset + last.length, total, '最后一段要盖到文件末尾');
});

test('正常书开头那点前言不算「命中太靠后」', () => {
  // 判据是「第一处命中在文件前一半」，别把「有个几 KB 简介」的正常书也拦掉
  const preface = '内容简介：'.repeat(200);
  const text =
    preface +
    '\n' +
    Array.from({ length: 20 }, (_, i) => `第${i + 1}章 标题\n${'正文。'.repeat(187)}\n`).join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.equal(r.ruleName, 'standard');
  // 21 = 前言 + 20 章。开头那 3 KB 简介不属于任何一章，原来读不到
  assert.equal(r.chapters.length, 21);
  assert.equal(r.chapters[0].title, '前言');
  assert.equal(r.chapters[0].offset, 0);
});

test('第一章之前的正文要立成「前言」，不能凭空消失', () => {
  // 远超 1 KB，但要留在文件前一半以内：「第一处命中不能超过半本」那条安全阀
  // 是防「规则只在书末尾撞上几行」的，跟前言无关，别把它一起测崩
  const lead = '这本书的开头有一大段没有标题的正文。'.repeat(60);
  const text = lead + '\n' + Array.from({ length: 8 }, (_, i) => `第${i + 1}章 标题\n${'正文。'.repeat(187)}\n`).join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.equal(r.chapters.length, 9);
  assert.equal(r.chapters[0].title, '前言');
  assert.equal(r.chapters[0].offset, 0);
  // 每一章首尾相接，整本书一个字节都不落在章节之外
  let cursor = 0;
  for (const c of r.chapters) {
    assert.equal(c.offset, cursor, `第 ${c.index} 章要紧接上一章`);
    cursor += c.length;
  }
  assert.equal(cursor, enc(text).length, '所有章节加起来必须等于整个文件');
});

test('开头只有书名作者那两行时不要多此一举建前言', () => {
  const text = '《某本书》 作者：某人\n\n' + Array.from({ length: 8 }, (_, i) => `第${i + 1}章 标题\n${'正文。'.repeat(187)}\n`).join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.equal(r.chapters.length, 8);
  assert.equal(r.chapters[0].title, '第1章 标题');
});

test('标题行写了两遍时，去掉前面那个空壳', () => {
  // 真实书库里 13 本、共 1124 处：文件里是「第1章 XXX\n第1章 XXX\n正文……」。
  // 不去重的话目录里每个标题出现两次，点开前一个是二三十字节的空壳。
  // 《火红年代：成为工业巨擘》597「章」里 291 处是这样。
  const text = Array.from({ length: 8 }, (_, i) =>
    `第${i + 1}章 标题${i + 1}\n第${i + 1}章 标题${i + 1}\n${'正文。'.repeat(400)}\n`).join('');
  const r = parseChapters(enc(text), 'utf-8');
  assert.equal(r.chapters.length, 8, '重复的标题行不该各自成章');
  assert.equal(r.chapters[0].title, '第1章 标题1');
  // 章节要从**真正的正文**那一行开始，不是从被重复的标题开始
  assert.ok(r.chapters[0].length > 1000, '首章不能是个几十字节的空壳');

  // **真的有两章同名时不能合并**——判据是「中间只隔了几十字节」
  const far = `第一章 同名\n${'正文。'.repeat(400)}\n第一章 同名\n${'正文。'.repeat(400)}\n`;
  assert.equal(parseChapters(enc(far), 'utf-8').chapters.length, 2, '隔着一整章正文的同名章要各算一章');
});

test('大半的「章」只有几十字节时，这条规则作废', () => {
  // 平均数拦不住这一类：少数几个真章会把它拽上去。实测《路明非挑战FGO》
  // 270 万字被切成 1949 章（正文里的选项行「【1、《JOJO的奇妙冒险》】」被当成标题），
  // 其中 1489 章短于 200 字节，而**平均每章 1389 字节**——高高越过了下限。
  //
  // 夹具要照着那个形状造：**平均值合格、中位数不合格**。
  // 60 条几十字节的选项行 + 20 段上万字节的真正文，用的是同一条规则
  // （真书里那些选项和真章节恰好都是【N、xxx】的写法）。
  // 第一版夹具没做到这一点，被「平均值太小」那条先拦掉了——
  // 于是把中位数判据去掉测试照样绿，**一条永远绿的断言等于没有断言**。
  const tiny = Array.from({ length: 60 }, (_, i) => `【${i + 1}、选项】
短。
`).join('');
  const big = Array.from({ length: 20 }, (_, i) => `【${i + 1}、正经段落】
${'正文。'.repeat(3000)}
`).join('');
  const r = parseChapters(enc(tiny + big), 'utf-8');
  const lens = r.chapters.map((c) => c.length).sort((a, b) => a - b);
  assert.ok(lens[lens.length >> 1] >= 200, `中位章长只有 ${lens[lens.length >> 1]} 字节，说明按选项行切碎了`);
  assert.ok(r.chapters.length < 60, `切了 ${r.chapters.length} 章，60 条选项行显然被当成了标题`);
});

test('太短的章并进上一章，而且一个字节都不丢', () => {
  const 正文 = '正文内容。'.repeat(150);          // 750 字，稳稳越过 500 字的门槛
  const 碎片 = '选项：';                          // 假标题后面几乎没有东西
  const text = [
    `第一章 起\n${正文}`,
    // 下面这三行是正文里的选项列表被当成了标题——真实库里《路明非挑战FGO》
    // 1949 章里 1489 章短于 200 字节，就是这么来的
    `第二章 承\n${碎片}`,
    `第三章 转\n${碎片}`,
    `第四章 合\n${正文}`,
  ].join('\n');
  const buf = new TextEncoder().encode(text);
  const r = parseChapters(buf, 'utf-8', BUILTIN_RULES);

  assert.deepEqual(
    r.chapters.map((c) => c.title),
    ['第一章 起', '第四章 合'],
    '两个碎片该并进第一章，而不是各占一章',
  );

  /*
   * **这条才是判据。** 只钉「章数变少」的话，把合并写成「短的直接扔掉」
   * 也能全绿——而那会真的吃掉正文。章节必须首尾相接、盖满整个文件。
   */
  let 走到 = 0;
  for (const c of r.chapters) {
    assert.equal(c.offset, 走到, `第 ${c.index + 1} 章没接上上一章的末尾`);
    走到 = c.offset + c.length;
  }
  assert.equal(走到, buf.length, '章节没盖满整个文件——有正文被吃掉了');

  // 并进去的那一章里，两个碎片和它们的假标题都还在
  const 第一章 = new TextDecoder().decode(buf.subarray(0, r.chapters[1].offset));
  assert.ok(第一章.includes('第二章 承') && 第一章.includes('第三章 转'),
    '假标题该变回正文的一部分，不是被删掉');
});

test('正常长度的章一个都不并', () => {
  const 正文 = '正文内容。'.repeat(150);
  const text = ['第一章 起', '第二章 承', '第三章 转'].map((t) => `${t}\n${正文}`).join('\n');
  const r = parseChapters(new TextEncoder().encode(text), 'utf-8', BUILTIN_RULES);
  assert.equal(r.chapters.length, 3, '够长的章不该被并——不然这条合并就是在毁目录');
});

test('连着一大串碎片：并到 500 字就收口，不是全并成一块', () => {
  // 1489 章短于 200 字节那种书的缩影：40 个 100 字左右的碎片连在一起。
  // 全并成一块的话是一个 4000 字的巨章，比切碎了还难读
  const 碎片 = '短。'.repeat(50);   // 100 字
  const text = Array.from({ length: 40 }, (_, i) => `第${i + 1}节\n${碎片}`).join('\n');
  const buf = new TextEncoder().encode(text);
  const r = parseChapters(buf, 'utf-8', BUILTIN_RULES);

  assert.ok(r.chapters.length >= 5 && r.chapters.length <= 12,
    `40 个碎片该并成七八章，实际 ${r.chapters.length} 章`);
  // 除了最后一章（它后面没东西可并），每一章都要真的够长
  for (const c of r.chapters.slice(0, -1)) {
    assert.ok(c.length >= 500 * 3, `「${c.title}」只有 ${c.length} 字节，没到 500 字`);
  }
  let 走到 = 0;
  for (const c of r.chapters) { assert.equal(c.offset, 走到); 走到 = c.offset + c.length; }
  assert.equal(走到, buf.length, '章节没盖满整个文件');
});
