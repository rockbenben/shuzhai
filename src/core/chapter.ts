// 章节解析（spec §2.2）。spec 说这是本工具最核心的模块，判据都写在这儿。
//
// **偏移量一律是字节，不是字符。** spec §11 的 chapter(offset, length) 要喂给 §12 的
// `fs.read` 定点读，那是字节偏移；而正则匹配天然发生在字符上，GBK 下两者不等。
// Node 的 TextEncoder 只支持 UTF-8，没法把字符位置换算回 GBK 字节位置——所以这里
// **按字节切行、逐行解码**，行的字节偏移直接就是结果，不需要任何换算。
//
// 按 0x0A 切对 UTF-8 / GB18030 / Big5 都成立：这几种编码的尾字节都不会取到 0x0A。
// UTF-16 不成立（每个 ASCII 字符都带一个 0x00），单独走一条路：它每个码元固定 2 字节，
// 字符下标 ×2 就是精确字节偏移（代理对是两个码元 4 字节，JS 的 length 也按码元算，仍然对得上）。

import { bomLength, type Encoding } from './encoding.ts';

export interface Line {
  text: string;
  /** 行首在原文件中的字节偏移 */
  byteOffset: number;
}

export interface Chapter {
  index: number;
  title: string;
  /** 章节起点的字节偏移（含标题行） */
  offset: number;
  /** 字节长度 */
  length: number;
  volume?: string;
}

export interface ParseResult {
  chapters: Chapter[];
  /** 命中的规则名；兜底分段时是 'fallback-chunk' */
  ruleName: string;
  /** false 表示没识别出章节、走了机械分段（spec §2.2 兜底策略） */
  recognized: boolean;
}

export interface ParseRule {
  name: string;
  pattern: RegExp;
  /**
   * 命中之后再筛一遍。给那些「光靠正则分不清标题和正文」的规则用。
   *
   * 目前只有 `bare-number` 需要：`^\d+标题` 这种格式在真实书库里确实存在
   * （《北洋反动派》的章节就是 `1反动派？` `2准备`），但同样的正则也会命中
   * 「1994年12月14日，日本关东地区」「5点半，我领着嘉琪出了门」这类正文句子。
   * 判别标准是**序号连不连得成递增序列**——实测这一条把两者分得干干净净。
   */
  refine?: (hits: Line[]) => Line[];
}

/**
 * 序号字符。含罗马数字（U+2160–U+217F）——《星海猎人》6.1MB 的卷号就是
 * `第Ⅰ卷 梦开始的地方 第001章 降临`，不认罗马数字的话行首匹配不上，
 * 后面那个 `第001章` 也就一起丢了，整本 985 章掉进机械分段。
 * 全库普查这个字符段只有这一本命中，中文正文里不会出现，零误伤
 */
const NUM = '[〇零一二三四五六七八九十百千万廿卅两\\d０-９\\u2160-\\u217f]';

/**
 * 章节量词，带负向断言。断言抄自 legado 的 `txtTocRule.json`——
 * 它是拿几百万本真实 txt 磨出来的，每一条都在挡一类具体的误判：
 * 「第二节课」不是章节、「第几回合」不是回。我们原来这几个字后面什么都不加，
 * 正文里出现这些词就会被当成章节标题切一刀。
 *
 * **卷/集/部/篇故意不在这里**，虽然 legado 的「目录」收了它们——
 * 那是因为 legado 没有独立的卷概念，只能一锅烩。我们有 `VOLUME_RULES` 和
 * 两级目录，把卷放进章节量词会让「第一卷 少年游」也被切成一章，
 * 两级目录当场塌成一级（`parse.test.ts` 的「有卷标记时建立两级目录」钉着这条）。
 * 只有卷没有章的书，走 `volume-only` 那条回落路径
 */
const UNIT = '(?:章|节(?!课)|節|回(?![合来事去])|话|話)';

/**
 * 无编号但确定是章节的标题词，同样来自 legado。
 * **必须和「第N章」写在同一条规则里**，不能单开一条：整本书里
 * 序章楔子番外加起来也就几处，单独成规则永远赢不了打分，
 * 于是《狩魔手记》那种「序章 人生若只如初见」开头的书就整本掉进机械分段
 */
const NAMED = '(?:序章|楔子|正文(?!完|结)|终章|後记|后记|尾声|番外|引子|[序前]言|卷首语|扉页)';

/**
 * 内置规则，有序。逐条试，最后按「命中最多且间隔最均匀」选一条胜出（spec §2.2）。
 * 全部锚定行首，配合下面的「标题行必须短」一起挡掉正文里提到「第一章」的误判。
 *
 * 规则语料大量参考 legado（阅读）的 `txtTocRule.json`：
 * https://github.com/LegadoTeam/legado —— 注意 `gedoor/legado` 已经被掏空只剩 README，
 * 源码在 LegadoTeam 这个组织下面。那份 26 条的规则表是本地 txt 切章的事实标准。
 * 我们和它的差别在**选规则的方式**：legado 按 serialNumber 顺序试、用户可手选，
 * 我们是全部试一遍按 `scoreRule` 打分自动选一条——所以规则可以多，
 * 挡误判的活交给打分和下面那几条安全阀
 */
export const BUILTIN_RULES: ParseRule[] = [
  { name: 'body-prefix', pattern: new RegExp(`^正文\\s*第\\s*${NUM}+\\s*[章节節回]`) },
  // `第一卷第一章` / `第一集 误入天庭 第一章 紫炎心`。
  // 两处放宽都是实测逼出来的：**「集」也是卷的说法**（《飘邈之旅》《星辰变》都用它），
  // 而且**卷名会夹在中间**——原来要求「第N卷」和「第M章」紧挨着，
  // 中间隔个卷名就一行都认不出来，整本掉进机械分段
  {
    name: 'volume-chapter',
    pattern: new RegExp(`^第${NUM}+[卷部集篇][^\\n]{0,16}?第\\s*${NUM}+\\s*[章节節回]`),
  },
  // `卷一 卷土重来 第1章 人生无常` —— **卷号在「卷」字后面**，和上面那条相反。
  // 上面那条要求 `第一卷`，这种写法它一个字都认不出来，整本书会掉进机械分段。
  // 实测这个库里 8.3MB 的《枭臣》、6.1MB 的《星海猎人》都是这个格式。
  // 卷名允许有（`卷一 山海盗 第一章 …`）也允许没有（`卷一 第1章 …`）
  {
    name: 'volume-first-chapter',
    pattern: new RegExp(`^[卷部篇]\\s*${NUM}+[^\\n]{0,16}?第\\s*${NUM}+\\s*[章节節回]`),
  },
  // `【第一章 紫炎心】`。legado「特殊符号 序号 标题」
  { name: 'bracket', pattern: new RegExp(`^[【\\[（(〖〔「『〈]\\s*第?\\s*${NUM}+\\s*${UNIT}`) },
  // legado 的「目录」，默认开的那条。除了「第N章」还收无编号的序章楔子番外，
  // 量词从原来的「章节節回」扩到话，全部带负向断言
  {
    name: 'standard',
    // 两处和 legado 不同：
    // 1. 不加它的 `.{0,30}$`——`matchLines` 已经卡了 40 字上限，再叠一层会让
    //    34–40 字的长标题（网文里不少）整条落空。
    // 2. NAMED 后面要跟行尾、空白、标点或序号。真标题长这样：「楔子」「番外：」
    //    「终章 无限的旅路」「尾声（一）兄弟」「番外一」；跟普通汉字的是正文——
    //    实测撞出来的是「**前言**不搭后语的一句话」「**扉页**上写的是歪歪斜斜的两个字」。
    //    legado 的长度上限拦不住这两句（都只有二十来字），前瞻才拦得住
    pattern: new RegExp(
      `^(?:${NAMED}(?=$|[\\s　\\p{P}]|${NUM})|第\\s*${NUM}+\\s*${UNIT})`,
      'u',
    ),
    refine: needsNumbered,
  },
  // legado「Chapter/Section/Part/Episode 序号 标题」。原来只认 chapter
  {
    name: 'chapter-en',
    pattern: /^(?:chapter|section|part|ＰＡＲＴ|episode|no[.、]?)\s*\d{1,4}\b.{0,30}$/i,
  },
  // `章一 初入江湖` / `卷三` / `段一 廷杖`。**量词在前、序号在后**，和「第一章」正好反过来。
  // legado「章/卷 序号 标题」，另加了「段」——《乌纱》395 处、《奉天承运》261 处都用它，
  // 而全库普查行首「段N」**只有这两本命中**，零误伤
  { name: 'unit-first', pattern: new RegExp(`^[卷章段][\\s　]*${NUM}{1,8}[\\s　]{0,4}.{0,30}$`) },
  // `第五十幕 地底之王（一）`。**不并进 `standard` 的 UNIT**：全库 206 本行首出现
  // 「第N幕」，真假参半——《琥珀之剑》1467 处是真章节，而《蛊真人》的
  // 「第一幕徐徐在他眼前消散」《地狱电影院》的「第一幕，在此终结。」是正文。
  // 并进去会往那些本来切得好的书里塞假章节；单独成一条规则则由打分决定，
  // 有真「第N章」的书天然赢过它
  { name: 'mu', pattern: new RegExp(`^第\\s*${NUM}{1,8}\\s*幕`) },
  // `〔一〕桃花带杀`。序号在括号里、标题跟在外面——已有的 bracket 要求括号里带量词，
  // bracket-num 要求闭括号在行尾，这种两条都不认。《斩龙》220 处，全库零误伤
  {
    name: 'bracket-lead',
    pattern: new RegExp(`^[〔〖]\\s*${NUM}{1,8}\\s*[〕〗]\\s*\\S.{0,30}$`),
  },
  // `xxx分节阅读_1` / `第3页`。下载来的 txt 里极常见，legado「字数分割 分节阅读」
  {
    name: 'split-read',
    pattern: new RegExp(`^(?:.{0,15}分[页节章段]阅读[-_ ]|第\\s*${NUM}{1,6}\\s*[页节]).{0,30}$`),
  },
  // `雪中悍刀行（12）` / `雪中悍刀行 12`。legado「书名 括号 序号」「书名 序号」
  {
    name: 'title-num',
    pattern: new RegExp(`^[一-龥]{1,20}[\\s　]{0,4}(?:[(（]${NUM}{1,8}[)）]|${NUM}{1,8})[\\s　]{0,4}$`),
    refine: sameStem,
  },
  // `☆、重生` / `★ 第一夜`。legado「特殊符号 标题(单个)」，晋江系的 txt 常见。
  // **后面必须有能读的字**：`※※※` `◇◇◇◇` 这类是场景分隔线，不是标题——
  // 不加这个前瞻的话《光年》被切成 126 章，每一章都叫「※※※」
  {
    name: 'star-title',
    pattern: /^[☆★✦✧◆◇※](?=.*[^\s\p{P}\p{S}]).{1,30}$/u,
  },
  { name: 'paren-num', pattern: new RegExp(`^[（(]\\s*${NUM}+\\s*[)）]\\s*$`) },
  // `一、神仙醋` / `01 雁然` / `3.准备`。行首序号紧跟分隔符是很强的信号——
  // 正文句子极少这么起头。分隔符集合取自 legado 的「数字/大写数字 分隔符 标题名称」，
  // 我们原来只认「、．」两个
  {
    name: 'num-sep',
    pattern: new RegExp(`^${NUM}{1,8}章?\\s*[:：,.，、．_—\\-]\\s*\\S.{0,30}$`),
    refine: mostlyAscending,
  },
  // `【一·六个传说】`。已有的 bracket 规则要求括号里带「章/节/回」，这种没有
  { name: 'bracket-num', pattern: new RegExp(`^[【\\[]\\s*${NUM}+\\s*[·、.．]\\s*[^\\]】]{1,24}[】\\]]\\s*$`) },
  // 放最后：它最容易误伤，让前面那些明确的格式先赢。
  // 数字后面紧跟「年月日点时分」等量词的一律不算——那是正文里的日期和时刻
  {
    name: 'bare-number',
    pattern: /^(\d{1,4})(?![\d年月日点時时分秒万千百％%])\D[^\n]{0,28}$/,
    refine: ascendingRun,
  },
];

/**
 * 只留下序号能连成递增序列的那些命中。
 *
 * 判据来自真实书库的实测：
 *   - 《北洋反动派》286 处命中 / 150 处连续递增 → 真章节（`1反动派？` `2准备`）
 *   - 《横刀》83 / 81 → 真章节（`01 雁然` `02 无相禅斗`）
 *   - 《捡个萝莉当老婆》78 / 10 → **全是正文**（「5点半，我领着嘉琪出了门」）
 *   - 《东京医途》83 / 2 → 也是正文（「1994年12月14日」）
 *
 * 光靠正则分不开前两组和后两组，序号递不递增能。
 * 找最长的一条递增链（允许跳号，网文缺章很常见），链太短就整条规则作废。
 */
const CN_DIGIT: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/**
 * 行首序号 → 数字。阿拉伯数字直接取，中文数字（`一百零八`）也要能读——
 * `num-sep` 收的是 `一、标题` 和 `1.标题` 两种，只认阿拉伯的话中文那批全成 NaN，
 * 递增判据就等于没跑
 */
function leadingNumber(s: string): number {
  const ar = /^([\d０-９]+)/.exec(s);
  if (ar) return Number(ar[1].replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10)));

  let total = 0;
  let cur = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      cur = CN_DIGIT[ch];
      seen = true;
    } else if (ch in CN_UNIT) {
      const u = CN_UNIT[ch];
      // 「十三」= 13：十前面没数字时算 1
      if (u === 10000) {
        total = (total + cur) * u;
        cur = 0;
      } else {
        total += (cur || 1) * u;
        cur = 0;
      }
      seen = true;
    } else break;
  }
  return seen ? total + cur : NaN;
}

/**
 * 「这批命中整体像不像一份章节表」。和 `ascendingRun` 是两回事：
 * 那个要**筛掉**不在链上的命中（`bare-number` 的场景，正文里的数字散落在真章节之间），
 * 这个只做**整体判定**，全收或全废。
 *
 * 分开写是因为 `ascendingRun` 的「最长链要占 40%」在这里会误杀一大片：
 * 中文小说的序号**换卷就重新从一开始**，`1、游原 2、原上 3、大家 1、明鸿 2、冷暖`
 * （《相府教子》）这种最长链只有三四条，占比远不到 40%。实测被它误杀的有
 * 《五大贼王》111 章、《大宋金手指》407 章、《挽天倾》357 章、《鬼股》165 章，
 * 全都掉进了机械分段或只剩几个卷。
 *
 * 判据改成看**相邻两条的关系**：递增一小步、原地不动（`（上）`/`（下）` 拆两条）、
 * 或者跳回小数字（换卷重编号），这三种都算正常；随机的数字（正文里的
 * 「2.85亿」「5万」「110」）三种都不占。
 */
function mostlyAscending(hits: Line[]): Line[] {
  if (hits.length < 5) return [];
  const nums = hits.map((h) => leadingNumber(h.text)).filter(Number.isFinite);
  if (nums.length < hits.length * 0.6) return [];

  let good = 0;
  let rise = 0;
  for (let i = 1; i < nums.length; i++) {
    const step = nums[i] - nums[i - 1];
    if (step > 0 && step <= 20) {
      good++;
      rise++;
    } else if (step === 0) good++;
    else if (nums[i] <= 3 && nums[i - 1] >= 3) good++; // 换卷，序号跳回开头
  }
  const pairs = nums.length - 1;
  // rise 那一半是底线：全是「原地不动」也能凑够 good，但那不是章节表
  if (pairs < 4 || good < pairs * 0.75 || rise < 4) return [];
  return hits;
}

function ascendingRun(hits: Line[]): Line[] {
  if (hits.length < 5) return [];
  const nums = hits.map((h) => leadingNumber(h.text));
  // 读不出序号的太多就别硬判——这条规则本来就不该管这种书
  if (nums.filter(Number.isFinite).length < hits.length * 0.6) return [];

  // 最长递增子序列。只认「后一个比前一个大、且没大太多」——
  // 章号跳过几章正常，从 3 跳到 1994 就不是章号了
  const from: number[] = new Array(hits.length).fill(-1);
  const len: number[] = new Array(hits.length).fill(1);
  let bestEnd = 0;
  for (let i = 1; i < hits.length; i++) {
    for (let j = i - 1; j >= 0 && i - j <= 40; j--) {
      const step = nums[i] - nums[j];
      if (step > 0 && step <= 20 && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        from[i] = j;
      }
    }
    if (len[i] > len[bestEnd]) bestEnd = i;
  }

  // 链太短说明这些数字只是正文里的巧合。**宁可不切也不能乱切**——
  // 切错了用户看到的是一本被剁碎的书，比整本一章更难受
  if (len[bestEnd] < 5 || len[bestEnd] < hits.length * 0.4) return [];

  const keep: Line[] = [];
  for (let i = bestEnd; i >= 0; i = from[i]) {
    keep.push(hits[i]);
    if (from[i] === -1) break;
  }
  return keep.reverse();
}

/**
 * 「书名 序号」这条规则必须**每次命中的书名部分都一样**——它本来就是
 * 「同一个书名重复出现、后面跟递增的序号」这个格式。
 *
 * 不加这条的话，正则 `^汉字{1,20}数字{1,8}$` 会去咬正文里任何一行
 * 「短句 + 数字结尾」。实测《琥珀之剑》11.3 MB 被它切成 34 章，
 * 标题是「水元素1」「风元素3」「地2」「光5」——全是正文里的属性面板；
 * 《温故一九四二》切出「十一」「十一」「温故一九四二」三章。
 * 这两本原来走机械分段，反而比切错强
 */
function sameStem(hits: Line[]): Line[] {
  if (hits.length < 3) return [];
  const stem = (t: string) => t.replace(/[\s　(（]*[〇零一二三四五六七八九十百千万廿卅两\d０-９]+[)）\s　]*$/, '');
  const tally = new Map<string, number>();
  for (const h of hits) tally.set(stem(h.text), (tally.get(stem(h.text)) ?? 0) + 1);
  const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  if (!best || best[1] < hits.length * 0.8) return [];
  return hits.filter((h) => stem(h.text) === best[0]);
}

/**
 * `standard` 里的 NAMED 那一支（序章/楔子/番外/后记…）**不能单独成立**——
 * 一本书里这些词加起来也就几处，光凭它们不构成章节结构。
 * 必须至少有一处是带编号的「第N章」，NAMED 才作为补充一起收进来。
 *
 * 实测挡掉的：《魅生》2.1 MB 只匹配到 13 条「番外：xxx」、
 * 《案藏玄机》1 MB 匹配到 3 条一模一样的「引子」、
 * 《辛亥：摇晃的中国》只匹配到「序言…」「后记…」两条。
 * 这三本正文的章节是别的格式，被这几处一带就整本切歪，前面的内容还会被丢掉
 */
function needsNumbered(hits: Line[]): Line[] {
  return hits.some((h) => /^第/.test(h.text)) ? hits : [];
}

/** 卷 / 部 / 篇。单独一张表：识别得出来就建两级目录，识别不出就单级（spec §2.2） */
export const VOLUME_RULES: ParseRule[] = [
  // 「折」也是卷：《乌纱》《奉天承运》的结构是「第一折 …」下面挂「段一 …」，
  // 折只有 8 处和 6 处，当章节太少、当卷正合适
  { name: 'volume', pattern: new RegExp(`^第\\s*${NUM}+\\s*[卷部集篇折](?!\\s*第)`) },
  { name: 'volume-bracket', pattern: new RegExp(`^[【\\[]\\s*第?\\s*${NUM}+\\s*[卷部集篇]`) },
  // `卷一 山海盗`。卷号在「卷」字后面，和上面两条相反——章节那边已经有
  // volume-first-chapter 认这种写法了，卷这边不补上就会出现「章分出来了、卷分不出来」
  { name: 'volume-first', pattern: new RegExp(`^[卷部篇]\\s*${NUM}+(?!\\s*第)`) },
];

/** 标题行长度上限。超过这个长度的行即使匹配也不算标题——正文里的「第三章说过……」会被这条挡掉 */
export const MAX_TITLE_LEN = 40;

/**
 * 平均章节长度的下限（字节）。低于它判定为误命中：
 * 「(一)」这类规则在带编号列表的书里会命中几百次，切出一堆几十字节的"章节"。
 * ponytail: 固定阈值，够用；真出现超短章节的书（微小说合集）再让用户在规则编辑器里覆盖。
 */
const MIN_MEAN_CHAPTER_BYTES = 200;

/**
 * 平均章节长度的**上限**（字节）。超过它说明这条规则只是零星撞上了几行，
 * 根本没找到章节结构——这时机械分段反而更好用。
 *
 * 这条是补出来的：`num-sep`（收「一、标题」「1.标题」，早先叫 dun-num）这类宽松规则
 * 在一本 6.7MB 的书里可能只命中 3–4 行
 * （正文里偶然出现的「一、」），却因为「命中数 ≥ 2 且平均章长超过下限」而胜出，
 * 把整本书切成 4 个 1.7MB 的「章节」——**比兜底的机械分段还糟**，
 * 而且看起来像是正常识别出来的。实测踩到两本（《萌娘武侠世界》《朕，都是为了大汉！》）。
 *
 * 取 40 万字节：GBK 下约 20 万字，比任何正常章节都长一个量级，
 * 而机械分段是 3 万字符，落在这条线以内。
 */
const MAX_MEAN_CHAPTER_BYTES = 400_000;

/**
 * 一半以上的「章」短于这个字节数，就说明这条规则撞上的是正文里的列表，不是目录。
 * 和 `MIN_MEAN_CHAPTER_BYTES` 同一个数：它拦的是「整体太碎」，
 * 这条拦的是「大部分碎、少数几个真章把平均值拉了上去」。
 */
/**
 * 一章至少要有这么多字，不够就并进上一章。
 *
 * **起因是用户的一句话**：「如果切的过小，应该自动合并，直到达到 500 字以上」。
 * 太短的「章」几乎全是误判——正文里的选项列表、条目清单、写了两遍的标题行
 * 被当成了标题（《路明非挑战FGO》1949 章里 1489 章短于 200 字节就是这么来的）。
 * 对读者来说，一本被剁成上千个几十字碎片的书，目录比没有更难用。
 *
 * **并进上一章，不是丢掉**：那一行假标题变回正文的一部分，一个字都不少。
 *
 * 500 是「字」不是字节，所以要按编码换算——同一句中文在 gb18030 里 2 字节、
 * utf-8 里 3 字节。这是个下限不是契约，中英混排时估得粗一点没关系。
 */
export const MIN_CHAPTER_CHARS = 500;

function bytesPerChar(encoding: Encoding): number {
  if (encoding === 'utf-8') return 3;
  return 2; // gb18030 / big5 / utf-16 的中文都是 2 字节
}

export const MIN_MEDIAN_CHAPTER_BYTES = 200;

/**
 * **标题行写了两遍**：文件里是「第1章 XXX
第1章 XXX
正文……」。
 *
 * 真实书库里量出来的：13 本、共 1124 处。最典型的《火红年代：成为工业巨擘》
 * 597 「章」里 291 处是这样——目录里每个标题出现两次，点开前一个是
 * 二三十字节的空壳。《这个明星很想退休》359 处、《我太想重生了》150 处。
 *
 * 两条判据缺一不可：标题**一模一样**，而且两次之间**只隔了几十字节**
 * （真的有两章同名时，中间隔着整整一章的正文）。
 *
 * 留后一条：章节从真正的正文那一行开始，被丢掉的只是重复的标题行本身。
 *
 * **要在打分之前做。** 不然那 291 个空壳会把中位章长压到 30 字节上下，
 * `MIN_MEDIAN_CHAPTER_BYTES` 一脚把这条本来正确的规则判掉，
 * 整本退回机械分段——把一本切得基本对的书变成了「未识别章节 1…35」。
 */
function dropRepeatedTitleLines(hits: Line[]): Line[] {
  const out: Line[] = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (prev && prev.text === h.text && h.byteOffset - prev.byteOffset < MIN_MEDIAN_CHAPTER_BYTES) out.pop();
    out.push(h);
  }
  return out;
}

/**
 * 单章大到这个地步就不正常了（字节）。
 *
 * 判据：兜底机械分段是 3 万字符（GBK 下约 6 万字节），这里取它的 20 倍。
 * 任何真实小说的一章都不会到 120 万字节（约 60 万字），到了只能是规则撞上了正文——
 * 「第二节课下课后」被当成「第二节」、「第四卷是什么呢？」被当成卷标题。
 *
 * **必须和「占了大半本」一起判**：单看这一条会误伤（一本书里偶尔有一章特别长是可能的，
 * 《我从凡间来》1127 章里就有一章 6.49MB，但它占全书才 27%，那个解析是好的）；
 * 单看占比又会误伤小书（两章的书最后一章天然占 50%）。
 */
const ABSURD_CHAPTER_BYTES = 1_200_000;

/** 兜底机械分段的粒度，spec §2.2 定的 30000 字 */
const FALLBACK_CHUNK_CHARS = 30_000;

/**
 * 把文件字节切成行，并带上每行行首的字节偏移。
 * UTF-16 走单独分支，理由见文件头注释。
 */
export function splitLines(buf: Uint8Array, encoding: Encoding): Line[] {
  const bom = bomLength(encoding, buf);

  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const text = new TextDecoder(encoding).decode(buf.subarray(bom));
    const lines: Line[] = [];
    let charIndex = 0;
    for (const raw of text.split('\n')) {
      lines.push({ text: raw, byteOffset: bom + charIndex * 2 });
      charIndex += raw.length + 1; // +1 是那个被 split 吃掉的 \n
    }
    return lines;
  }

  // **分块解码，不是逐行解码。**
  //
  // 原来每行调一次 `decoder.decode()`——52MB 的书有 92 万行，实测 **427ms**，
  // 是书内搜索和章节解析里最大的一块（对比：整本一次性解码只要 123ms，
  // 读 52MB 进内存只要 16ms）。每次 decode 的固定开销乘以 92 万，就是这个差距。
  //
  // 能这么改的前提：`\n`（0x0A）在 gb18030 / big5 / utf-8 里**都不会出现在
  // 多字节序列中间**（它们的后续字节都 ≥ 0x40）。所以「按字节数 \n」和
  // 「解码后按 \n 切」得到的行数一定相等，按序号对齐就行。
  // utf-16 不满足这条，所以它在上面单独处理。
  //
  // 仍然分块（1MB）而不是整本解码：整本解码会额外占一份和原文同量级的内存，
  // 而这个库里单本最大 52MB。分块把峰值压住，同时 decode 调用次数从 92 万降到几十。
  const CHUNK = 1 << 20;
  const decoder = new TextDecoder(encoding);
  const lines: Line[] = [];
  let lineStart = bom;
  let groupStart = bom;
  let pending: number[] = [];

  const flush = (endExclusive: number) => {
    if (pending.length === 0) return;
    const parts = decoder.decode(buf.subarray(groupStart, endExclusive)).split('\n');
    for (let k = 0; k < pending.length; k++) {
      lines.push({ text: parts[k] ?? '', byteOffset: pending[k] });
    }
    pending = [];
  };

  // 找 `\n` 用 `Buffer.indexOf` 而不是 JS 循环。前者是原生 memchr，
  // 实测扫 52MB **2ms**；后者在 JS 里逐字节比较 5200 万次，是几百毫秒。
  // `Buffer.from(view)` 这个写法是**零拷贝**的（共享同一段内存），别改成 `Buffer.from(buf)`
  const b = Buffer.isBuffer(buf)
    ? buf
    : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);

  for (let i = bom; i <= b.length; ) {
    const nl = i < b.length ? b.indexOf(0x0a, i) : -1;
    const at = nl < 0 ? b.length : nl;
    pending.push(lineStart);
    lineStart = at + 1;
    if (at === b.length) { flush(at); break; }
    if (at + 1 - groupStart >= CHUNK) {
      flush(at);
      groupStart = at + 1;
    }
    i = at + 1;
  }
  return lines;
}

/**
 * markdown 风格的标题前缀。**在 `matchLines` 里统一剥掉，不写进每条规则**——
 * 这是整个文件的写法（有的下载源直接导出成 md），跟具体是哪种章节格式无关。
 *
 * 全库普查 19 本这么写，而且都是大书：《那年华娱》19 MB 有 1603 处
 * `# 第一章 新生【修】`、《朕，都是为了大汉！》728 处、《华娱：重生了》727 处。
 * 不剥的话行首是 `#`，所有规则的 `^第` 一律匹配不上，整本掉进机械分段。
 * 剥掉之后 `#` 那几个字节仍然算在这一章里（byteOffset 用的是行首），只是不进标题
 *
 * ⚠️ **只此一份。** `suggest.ts` 原来自己抄了一条同名同值的私有常量——
 * 它猜规则时也要先剥掉这个前缀，剥法和这里不一样就等于「猜出来的规则
 * 套回正文匹配不上」。`dup-decls.mjs` 当时看不见它：core 内部那一档
 * 只比对 **exported** 的声明，两个私有 const 撞名它一声不吭。
 */
export const MD_HEADING = /^#{1,6}[ \t　]*/;

function matchLines(lines: Line[], rule: ParseRule): Line[] {
  const hits: Line[] = [];
  for (const line of lines) {
    const t = line.text.trim().replace(MD_HEADING, '');
    if (t.length === 0 || t.length > MAX_TITLE_LEN) continue;
    if (rule.pattern.test(t)) hits.push({ text: t, byteOffset: line.byteOffset });
  }
  return rule.refine ? rule.refine(hits) : hits;
}

/**
 * 一条规则的得分：命中数 × 均匀度。
 * 均匀度用间隔的变异系数（标准差 / 均值）折算——章节间隔越整齐，分数越高。
 * 这么算的用意是让「命中 400 次、间隔略有起伏」稳稳压过「命中 2 次、间隔完美」。
 */
export function scoreRule(hits: Line[], totalBytes: number): number {
  if (hits.length < 2) return 0;

  const gaps: number[] = [];
  for (let i = 1; i < hits.length; i++) gaps.push(hits[i].byteOffset - hits[i - 1].byteOffset);
  gaps.push(totalBytes - hits[hits.length - 1].byteOffset);

  // **第一处命中必须靠前。** buildChapters 是从第一处命中开始切的，
  // 它前面的内容不进任何章节——正常书那是标题和简介，几 KB，丢了无所谓；
  // 但如果规则只在书的后半段撞上几行，前面**整本书**就凭空消失了。
  //
  // 实测：《萌娘武侠世界》6.7MB，`num-sep` 只命中 4 行，全挤在 6.628M 处
  // （正文里的一个条件列表「一、朱元璋交出……」），间隔 72/48/54 字节加一个
  // 373KB 的尾巴——**平均 93KB 反而低于上限，光看平均值拦不住**。
  // 结果是前面 6.6MB 全部丢失，而界面上看起来是「识别出 4 章」。
  if (hits[0].byteOffset > totalBytes * 0.5) return 0;

  // **一章不能吞掉整本。** 正文里的句子会撞上规则——
  // 「第二节课下课后，项南去上卫生间。」被当成「第二节」、
  // 「第四卷是什么呢？」被当成卷标题、「第二章写得胸闷，就好像……」被当成章标题。
  // 撞上三五次，一本 25MB 的书就成了 4 章，其中一章 24.76MB（实测《蛊真人》）。
  // 读者点进去等于打开整本书：实测渲染 171 万字 / 4 万段要**卡死 20 秒**。
  //
  // 这条比「第一处命中要靠前」更通用：误命中出现得早时那条拦不住，
  // 而「最大的一章占了大半本」是这类失败共同的形状。
  // 两个条件都要满足才判作废，缺一不可：
  //   - 占了大半本：说明这条规则没把书分开
  //   - 而且这一「章」本身大得离谱：**只看占比会误伤小书**——
  //     一本两章的书，最后一章天然就是 50%，那是正常的
  const biggest = Math.max(...gaps);
  if (biggest > ABSURD_CHAPTER_BYTES && biggest > totalBytes * 0.5) return 0;

  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean < MIN_MEAN_CHAPTER_BYTES) return 0;

  /*
   * **中位数，不是平均数。**
   *
   * 上面那条下限拦不住「切成一地碎片」这一类：平均数会被少数几个真章拽上去。
   * 实测《路明非挑战FGO》——一本互动小说，正文里写着
   * 「【1、《JOJO的奇妙冒险》】」「【2、《龙族》】」这样的选项行，
   * 被 `bracket-num` 规则当成了标题。270 万字切出 **1949 章**，
   * 其中 **1489 章短于 200 字节**（31、71、25、59……），
   * 而平均每章 1389 字节，高高地越过了 `MIN_MEAN_CHAPTER_BYTES`。
   * 中位数是 50 上下。
   *
   * 这一类**现有判据一条都抓不到**：标题有可读文字（不是「※※※」那种）、
   * 第一处命中很靠前、没有哪一章吞掉大半本、平均值也正常。
   *
   * 阈值取 200 是量出来的，不是拍的：全库 8172 本里中位章长
   * < 100 字节的 6 本、< 200 的还是**同样那 6 本**、< 300 才多 1 本——
   * 也就是说这 6 本是深度切坏的，200 这个位置周围没有边界案例。
   */
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  if (median < MIN_MEDIAN_CHAPTER_BYTES) return 0;
  // 上限：平均「章」有几十万字节说明这条规则只是零星撞上几行，没找到结构。
  // 这时宁可走机械分段——4 个 1.7MB 的「章节」比 110 个规整的分段难用得多
  if (mean > MAX_MEAN_CHAPTER_BYTES) return 0;

  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / mean;
  return hits.length / (1 + cv);
}

/**
 * 第一处命中之前的正文，超过这个字节数就单独立一章「前言」。
 * 低于它多半是书名、作者、下载站信息那几行，不值得占一章。
 *
 * legado 用的是「600 字」（`TextFile.kt`，少于它就当作书籍简介、不建章）。
 * 我们没有「简介」这个字段，所以门槛放低到 1 KB——**宁可多一章前言，
 * 也不能让正文看不见**。
 */
const PREFACE_MIN_BYTES = 1024;

function buildChapters(hits: Line[], totalBytes: number, volumes: Line[], minBytes = 0): Chapter[] {
  // 命中之前的内容原来是**直接丢掉**的：buildChapters 从 hits[0] 起算，
  // 前面那段既不属于任何一章，也就永远读不到。scoreRule 只挡住了「第一处命中
  // 在半本之后」的极端情况，也就是说最多可以有半本书凭空消失。
  // legado 的做法是把它立成一章（`TextFile.kt` 里叫「前言」），这里照做
  if (hits.length > 0 && hits[0].byteOffset >= PREFACE_MIN_BYTES) {
    hits = [{ text: '前言', byteOffset: 0 }, ...hits];
  }

  /*
   * **太短的章并进上一章。**
   *
   * 做法是**把那一处标题从命中列表里去掉**——于是上一章的范围自然延伸过来，
   * 那行假标题变回正文的一部分，一个字节都不丢。
   *
   * ⚠️ **第一处命中永远保留**：去掉它等于把开头那一段整个丢出目录之外
   * （`buildChapters` 从 `hits[0]` 起算，前面那节「前言」讲的就是这个坑）。
   * 所以是从第二处开始筛，而且比的是「离**上一个留下来的**有多远」，
   * 不是「离前一处命中有多远」——不然连着五个碎片会一个都筛不掉。
   *
   * 最后一章可能仍然很短（它后面没有东西可以并），那是没办法的，也无害。
   */
  if (minBytes > 0 && hits.length > 1) {
    const kept: Line[] = [hits[0]];
    let 攒着的 = 0;
    for (let i = 1; i < hits.length; i++) {
      const 自己多长 = (i + 1 < hits.length ? hits[i + 1].byteOffset : totalBytes) - hits[i].byteOffset;
      /*
       * **判据看的是「这一章自己多长」，不是「离上一个标题多远」。**
       *
       * 前两版都栽在这上面：按「离上一个留下来的标题多远」算，一个 30 字节的碎片
       * 只要前面那章够长就会被留下来，然后**把它后面那个 750 字的正常章节
       * 整个吞进去**——测试当场抓到（`第四章 合` 从目录里消失了）。
       *
       * `攒着的` 管的是另一头：连着一串碎片时，并到 500 字就收口、
       * 让下一处标题重新开一章。用户的原话是「合并**直到达到** 500 字以上」，
       * 不是「全并成一块」——1489 个碎片并成一个 148 KB 的巨章，比切碎了还难读。
       */
      if (自己多长 >= minBytes) { kept.push(hits[i]); 攒着的 = 0; continue; }
      攒着的 += 自己多长;
      if (攒着的 >= minBytes) { kept.push(hits[i]); 攒着的 = 0; }
      // 否则这一处标题不算数：内容并进上一章，那行字变回正文的一部分
    }
    hits = kept;
  }

  return hits.map((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].byteOffset : totalBytes;
    // 当前章之前最近的一个卷标记就是它所属的卷
    let volume: string | undefined;
    for (const v of volumes) {
      if (v.byteOffset <= hit.byteOffset) volume = v.text;
      else break;
    }
    return { index: i, title: hit.text, offset: hit.byteOffset, length: end - hit.byteOffset, volume };
  });
}

/** 完全解析不出章节时按固定字符数机械分段（spec §2.2 兜底策略） */
function fallbackChunks(lines: Line[], totalBytes: number): Chapter[] {
  const chapters: Chapter[] = [];
  let chunkStart = 0;
  let chars = 0;
  for (const line of lines) {
    if (chars >= FALLBACK_CHUNK_CHARS) {
      chapters.push({
        index: chapters.length,
        title: `未识别章节 ${chapters.length + 1}`,
        offset: chunkStart,
        length: line.byteOffset - chunkStart,
      });
      chunkStart = line.byteOffset;
      chars = 0;
    }
    chars += line.text.length;
  }
  chapters.push({
    index: chapters.length,
    title: `未识别章节 ${chapters.length + 1}`,
    offset: chunkStart,
    length: totalBytes - chunkStart,
  });
  return chapters;
}

/**
 * 解析章节。`rules` 传自定义规则时完全取代内置规则（spec §2.2 的规则编辑器走这条路）。
 * 返回的 chapters 可以直接喂给规则编辑器做「将切出 N 章，前 20 章标题如下」的预览。
 */
export function parseChapters(
  buf: Uint8Array,
  encoding: Encoding,
  rules: ParseRule[] = BUILTIN_RULES,
): ParseResult {
  const lines = splitLines(buf, encoding);
  const totalBytes = buf.length;

  const volumeHits = VOLUME_RULES.map((r) => matchLines(lines, r)).sort((a, b) => b.length - a.length)[0] ?? [];

  let best: { rule: ParseRule; hits: Line[]; score: number } | null = null;
  for (const rule of rules) {
    const hits = dropRepeatedTitleLines(matchLines(lines, rule));
    const score = scoreRule(hits, totalBytes);
    if (score > 0 && (best === null || score > best.score)) best = { rule, hits, score };
  }

  if (best) {
    return {
      chapters: buildChapters(best.hits, totalBytes, volumeHits, MIN_CHAPTER_CHARS * bytesPerChar(encoding)),
      ruleName: best.rule.name,
      recognized: true,
    };
  }

  // 没有章节但有卷标记时，卷自己当章用，好过机械分段。
  //
  // **但要过同一套体检。** 这条路原来完全不打分，只要有两个卷标记就直接用——
  // 而卷规则一样会撞上正文（《蛊真人》34MB，「第四卷是什么呢？」这句话被当成卷标题，
  // 于是全书成了 4 章、其中一章 24.76MB）。读者点进去等于打开整本书，
  // 实测渲染 171 万字要卡死 20 秒。
  if (volumeHits.length >= 2 && scoreRule(volumeHits, totalBytes) > 0) {
    return {
      chapters: buildChapters(volumeHits, totalBytes, []),
      ruleName: 'volume-only',
      recognized: true,
    };
  }

  return { chapters: fallbackChunks(lines, totalBytes), ruleName: 'fallback-chunk', recognized: false };
}

export interface Progress {
  chapterIdx: number;
  charOffset: number;
  globalOffset: number;
}

export interface RestoredProgress extends Progress {
  /** 恢复方式，不准的时候要如实告诉用户（spec §2.3 第 3 档） */
  by: 'title' | 'index' | 'offset';
  accurate: boolean;
}

/**
 * 文件内容变了、重新解析之后恢复阅读进度（spec §2.3）。
 * 优先级：原章节**标题**在新列表里存在 → 原**序号** → 兜底保留全局字符偏移并标不准。
 *
 * 这个顺序不能反：追更覆盖写入时前面的章节通常没动，标题匹配最可靠；
 * 而序号会因为作者在中间插了一章就整体错位。
 */
export function restoreProgress(
  oldChapters: Chapter[],
  newChapters: Chapter[],
  progress: Progress,
): RestoredProgress {
  const oldTitle = oldChapters[progress.chapterIdx]?.title;

  if (oldTitle !== undefined) {
    const hit = newChapters.findIndex((c) => c.title === oldTitle);
    if (hit >= 0) {
      return { ...progress, chapterIdx: hit, by: 'title', accurate: true };
    }
  }

  if (progress.chapterIdx < newChapters.length) {
    return { ...progress, by: 'index', accurate: true };
  }

  return {
    chapterIdx: Math.max(0, newChapters.length - 1),
    charOffset: 0,
    globalOffset: progress.globalOffset,
    by: 'offset',
    accurate: false,
  };
}
