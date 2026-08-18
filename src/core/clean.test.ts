import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_CLEAN_RULES,
  INDENT_RULE,
  cleanText,
  cleanLines,
  cleanDiff,
  validateRule,
  listCleanRules,
  loadCleanRules,
  setBuiltinEnabled,
  type CleanRule,
} from './clean.ts';
import { PURIFY_RULES } from './builtin-rules.ts';
import { openDb, setSetting } from './db.ts';

const R = BUILTIN_CLEAN_RULES;

test('章尾广告和网址行被删掉，正文一行不少', () => {
  const raw = [
    '第一章 起',
    '少年提剑出门，风雪满衣。',
    '手机站阅读 m.example.com',
    '请记住本站域名：www.example.net',
    '他走了很远。',
    'https://example.com/book/123',
    '天才一秒记住本站地址',
  ].join('\n');

  assert.deepEqual(cleanText(raw, R).split('\n'), [
    '第一章 起',
    '少年提剑出门，风雪满衣。',
    '他走了很远。',
  ]);
});

test('连续空行合并成一个', () => {
  const raw = '第一段\n\n\n\n第二段\n\n第三段';
  assert.equal(cleanText(raw, R), '第一段\n\n第二段\n\n第三段');
});

test('行首尾空白（含全角空格）被去掉', () => {
  assert.equal(cleanText('　　缩进过的一行　　', R), '缩进过的一行');
  assert.equal(cleanText('  西文空格也算  ', R), '西文空格也算');
});

test('缩进统一是可选的，默认不开', () => {
  const raw = '第一段\n第二段';
  assert.equal(cleanText(raw, R), raw, '默认不加缩进');
  assert.equal(
    cleanText(raw, [...R, { ...INDENT_RULE, enabled: true }]),
    '　　第一段\n　　第二段',
  );
});

test('正文里含网址的**句子**不该整行删掉', () => {
  // 收窄判据的理由：正文被吃掉用户发现不了，广告留着只是碍眼
  const line = '他在纸条上写下 www.example.com 这几个字，然后把纸条烧了。';
  assert.equal(cleanText(line, R), line, '整行只有网址才删，句子里提到不算');
});

test('每一行都能说出是被哪条规则动的', () => {
  const lines = cleanLines('正文\n手机站阅读 m.x.com', R);
  assert.equal(lines[0].after, '正文');
  assert.equal(lines[0].by, undefined, '没动过的行不该挂规则名');
  assert.equal(lines[1].after, null, '广告行被删');
  assert.equal(lines[1].by, '章尾广告行');
});

test('diff 预览只给出有变化的行', () => {
  const raw = ['正文一', '正文二', '手机站阅读', '正文三', '　　缩进'].join('\n');
  const diff = cleanDiff(raw, R);
  assert.equal(diff.length, 2, '五行里只有两行有变化');
  assert.equal(diff[0].after, null);
  assert.equal(diff[1].after, '缩进');
});

test('坏正则不会让整章打不开，只是这条规则不生效', () => {
  const bad: CleanRule = { name: '坏规则', pattern: '(', replacement: '', enabled: true };
  assert.equal(cleanText('正文', [bad, ...R]), '正文');
  // 但保存规则时必须明确报错，不能让用户以为存进去能用
  assert.throws(() => validateRule('('), /正则无效/);
});

test('停用的规则不生效', () => {
  const off = R.map((r) => ({ ...r, enabled: false }));
  const raw = '正文\n手机站阅读 m.x.com';
  assert.equal(cleanText(raw, off), raw);
});

test('清洗不改变原始输入（纯函数）', () => {
  const raw = '正文\n手机站阅读';
  const copy = raw;
  cleanText(raw, R);
  assert.equal(raw, copy);
});


// ── 内置规则的启停 ───────────────────────────────────────────

function withDb(fn: (db: ReturnType<typeof openDb>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'novel-clean-'));
  const db = openDb(join(dir, 'library.db'));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('默认关着的内置规则，开得起来', () => {
  // 判定原本写成 `r.enabled && !off.has(name)`——对默认开的规则没问题，
  // 但默认关的永远是 false，勾了也没用，不报错不留痕。缩进统一和二十条乌云净化全中招
  withDb((db) => {
    const before = listCleanRules(db).find((r) => r.name === INDENT_RULE.name)!;
    assert.equal(before.enabled, false, '默认就是关的');

    setBuiltinEnabled(db, INDENT_RULE.name, true);

    assert.equal(listCleanRules(db).find((r) => r.name === INDENT_RULE.name)!.enabled, true);
    assert.equal(
      loadCleanRules(db).find((r) => r.name === INDENT_RULE.name)!.enabled,
      true,
      '界面说开了，实际套用的也得是开的——两处判定必须一致',
    );
  });
});

test('默认开着的内置规则，关得掉', () => {
  withDb((db) => {
    const name = BUILTIN_CLEAN_RULES[0].name;
    assert.equal(listCleanRules(db).find((r) => r.name === name)!.enabled, true);
    setBuiltinEnabled(db, name, false);
    assert.equal(loadCleanRules(db).find((r) => r.name === name)!.enabled, false);
  });
});

test('老的「停用名单」数组格式还认', () => {
  withDb((db) => {
    setSetting(db, 'clean.disabledBuiltins', JSON.stringify([BUILTIN_CLEAN_RULES[0].name]));
    assert.equal(loadCleanRules(db).find((r) => r.name === BUILTIN_CLEAN_RULES[0].name)!.enabled, false);
  });
});

test('净化规则都是内置的，正则在 JS 里编译得过', () => {
  // 编译不过的话用户一勾就是运行时异常，而清洗跑在读正文的路径上
  withDb((db) => {
    const all = listCleanRules(db);
    for (const r of PURIFY_RULES) {
      const row = all.find((x) => x.name === r.name);
      assert.ok(row, `${r.name} 应该在内置列表里`);
      assert.equal(row.builtin, true);
      assert.ok(r.note, `${r.name} 得写一句说明——十几条规则光看名字判断不了该不该开`);
      assert.doesNotThrow(() => new RegExp(r.pattern, r.flags ?? 'gu'), `${r.name} 编译不过`);
    }
  });
});

test('会大段删除的规则必须默认关着', () => {
  // 整章模式 + 删到章尾 = 唯一能一次吃掉半章的形态。它必须是用户看过 diff 才开的
  for (const r of PURIFY_RULES) {
    if (r.whole && r.replacement === '') {
      assert.equal(r.enabled, false, `${r.name} 是整章模式而且会删东西，不许默认开`);
    }
  }
  /*
   * ⚠️ **判据是「会不会删」，不是「是不是整章模式」。** 原来这里只判 `r.whole`，
   * 而这条测试自己的名字写的是「会大段删除的」——两者不是一回事：
   * 「HTML 段落标签还原成换行」也是整章模式，但它把标签**换成换行**，
   * 文本只会变长；按老判据它会被拦下来，而拦的理由是假的。
   *
   * 空替换才是「删」。下面这条诱饵防的是「把判据放松成永远为真」。
   */
  const 删到章尾 = PURIFY_RULES.filter((r) => r.whole && r.replacement === '');
  assert.ok(删到章尾.length > 0, '一条「整章模式 + 空替换」的规则都没有了——这条判据变成了空转');
});

test('默认开的规则套在干净正文上，一个字都不动', () => {
  // 判据来自真实书库：抽 600 本的第 9 章，HTML/网址/本章完/求票/全角数字/零宽字符全是 0%。
  // 所以默认开的规则**在正常正文上必须完全无操作**——有任何改动都是误伤
  const prose = [
    '第一章 开端',
    '　　他推开门，看见院子里站着一个人。',
    '　　「你来了。」那人说——声音很轻。',
    '　　……',
    '　　“这世界真是太小了。”他冷笑道，“居然让我在这里撞到你。”',
    '　　江晓：？？？',
    '　　吼！！！',
    '　　<系统>提示：任务完成。',
    '　　（全文完）',
  ].join('\n');
  const on = [...BUILTIN_CLEAN_RULES, ...PURIFY_RULES].filter((r) => r.enabled);
  const out = cleanText(prose, on);
  // 去行首尾空白会把全角缩进去掉，比对时先各自去掉行首空白
  const strip = (t: string) => t.split('\n').map((l) => l.replace(/^[\s　]+/, '')).join('\n');
  assert.equal(strip(out), strip(prose), '默认开的规则动了正文');
});

test('（全文完）（全书完）（大结局）绝不能被删——那是作者写的结尾', () => {
  const on = PURIFY_RULES.filter((r) => r.enabled);
  for (const ending of ['（全文完）', '（全书完）', '（大结局）', '（完）']) {
    assert.equal(cleanText(ending, on).trim(), ending, `${ending} 被删了`);
  }
  // 只有这个是站点自动加的
  assert.equal(cleanText('（本章完）', on).trim(), '');
  assert.equal(cleanText('　　他走了。（本章完）', on).trim(), '他走了。');
});

test('真实书库里那个制作组页脚，默认规则就能吃掉', () => {
  // 抽的 500 本末章里 491 本长这样。这是这个规则集要解决的头号问题
  const tail = [
    '　　（全文完）',
    '==========================================================',
    '更多精校小说尽在知轩藏书下载：http://www.zxcs.me/',
    '==========================================================',
  ].join('\n');
  const out = cleanText(tail, [...BUILTIN_CLEAN_RULES, ...PURIFY_RULES].filter((r) => r.enabled));
  assert.equal(out.trim(), '（全文完）', `页脚没清干净：${JSON.stringify(out)}`);
});

test('连续横线不算分隔线——那是作者的破折号', () => {
  // 抽样里 25% 的书正文带连续横线，全是正常的破折号或场景分隔。
  // 分隔线规则的字符类**故意不收 — ─ ━**，这条钉住它
  const on = PURIFY_RULES.filter((r) => r.enabled);
  for (const line of ['————————', '────────', '━━━━━━━━']) {
    assert.equal(cleanText(line, on).trim(), line, `${line} 被当成分隔线删了`);
  }
  assert.equal(cleanText('========', on).trim(), '', '真正的分隔线要删掉');
  assert.equal(cleanText('=-=-=-=-=-', on).trim(), '=-=-=-=-=-', '混排的不算——反向引用要求同一个字符');
});

test('网文里的 <系统> 不是 HTML，不能删', () => {
  const on = PURIFY_RULES.filter((r) => r.enabled);
  assert.equal(cleanText('<系统>提示：你升级了', on).trim(), '<系统>提示：你升级了');
  assert.equal(cleanText('<主线任务>已完成', on).trim(), '<主线任务>已完成');
  assert.equal(cleanText('正文<br/>还在', on).trim(), '正文还在');
  assert.equal(cleanText('空&nbsp;格', on).trim(), '空格');
});

test('CRLF 的 \r 不算改动——它是文件格式，不是内容', () => {
  // 不摘 \r 的话「去行首尾空白」命中每一行，diff 预览会被刷屏，
  // 章末真正的删行永远排不进那 60 个名额。实测这个库 99.4% 的行都是 CRLF
  const crlf = '第一章 起\r\n少年提剑出门。\r\n他走了很远。\r';
  const lines = cleanLines(crlf, R);
  assert.deepEqual(lines.map((l) => l.after), ['第一章 起', '少年提剑出门。', '他走了很远。']);
  assert.equal(cleanDiff(crlf, R).length, 0, 'CRLF 文件在没有真改动时，diff 应该是空的');
});

test('diff 预览里删行优先——名额有限，丢内容的操作最该给用户看', () => {
  // 造一章：开头一堆会被改动的行（有缩进），末尾才是广告。
  // 按原顺序截断的话广告排在第 61 位之后，用户根本看不到
  const body = Array.from({ length: 80 }, (_, i) => `　　第 ${i} 段正文。`).join('\n');
  const raw = `${body}\n=========\n更多精校小说尽在某站下载：http://x.com/`;
  const on = [...BUILTIN_CLEAN_RULES, ...PURIFY_RULES].filter((r) => r.enabled);

  const diff = cleanDiff(raw, on);
  const dropped = diff.filter((l) => l.after === null);
  assert.equal(dropped.length, 2, `两条垃圾都得出现在预览里，实际 ${dropped.length} 条`);
  assert.ok(diff.length <= 60, '不能因此撑破名额');
});

/*
 * **从网页扒下来的 txt：HTML 要当排版信息用，不是当垃圾删掉。**
 *
 * 原来只有一条「HTML 残留」把标签全删了——`<br>` 和 `</p>` 一起没了，
 * 于是整章的段落分隔全丢，正文变成一堵墙。这是用户报的
 * 「txt 中的 html 也应该支持」。
 */
test('txt 里的 HTML：段落标签还原成换行，&nbsp; 还原成空格', () => {
  const 网页味的 = '<p>第一段。</p><p>第二段。<br/>第二段的下一行。</p><div>第三段&nbsp;带个空格</div>';
  const out = cleanText(网页味的, PURIFY_RULES);
  const 行 = out.split('\n').map((l) => l.trim()).filter(Boolean);

  assert.deepEqual(行, ['第一段。', '第二段。', '第二段的下一行。', '第三段 带个空格'],
    '每个 <p> / <br> / <div> 都该断成一行，&nbsp; 该是一个空格');
  assert.ok(!out.includes('<'), '标签本身不该留下');
});

/*
 * ⚠️ **不许误伤正文里的尖括号。** 网文里的「<系统>」「<主线任务>」是内容，
 * 判据是「`<` 后面必须跟 ASCII 字母或 `/`」——这条本来就写在那两条规则的注释里，
 * 而新加的那条如果放宽了，用户会发现自己书里的系统提示凭空少了一截。
 */
test('正文里的「<系统>」不许被当成 HTML', () => {
  const out = cleanText('他打开了<系统>面板，看到<主线任务>三个字。', PURIFY_RULES);
  assert.ok(out.includes('<系统>'), out);
  assert.ok(out.includes('<主线任务>'), out);
});
