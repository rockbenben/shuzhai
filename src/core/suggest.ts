// 从一本书**自己的正文**里猜候选章节规则（spec §2.2 的规则编辑器辅助）。
//
// 为什么需要这个：内置规则认不出的书，用户得自己写正则，而写之前得先知道
// 这本书的标题长什么样——那意味着拿文本编辑器翻一遍几十 MB 的 txt。
// 实测这个库里还有 53 本走机械分段，逐本人工看是不现实的。
//
// **不是 AI**（铁律 4）：纯统计。把行里的数字归一化成一个占位符，
// 数哪种「形状」的短行反复出现，再把形状还原成正则。同一套办法我在调试
// 章节规则时手写过一遍，这里只是把它固化进产品。

import { MAX_TITLE_LEN, MD_HEADING, scoreRule, splitLines, type Line } from './chapter.ts';
import type { Encoding } from './encoding.ts';
import { escapeRe, hasReadable } from './format.ts';

/** 和 chapter.ts 的 NUM 保持一致——两边不一致会让建议出来的正则匹配不到自己的样例 */
const NUM_CLASS = '[〇零一二三四五六七八九十百千万廿卅两\\d０-９\\u2160-\\u217f]';
const NUM_RUN = /[〇零一二三四五六七八九十百千万廿卅两\d０-９Ⅰ-ⅿ]+/g;
/**
 * 归一化时数字换成它。选一个正文里绝不会出现的字符。
 *
 * **写成转义 `\u0000`，不要在源码里放一个真的 NUL 字节。** 值是一样的，
 * 但真字节会让 `grep` / `rg` 把整个文件判成 binary——于是它从所有文本搜索里
 * 静默消失（`Binary file ... matches`，不给行号也不给内容）。这个文件曾经就是
 * 这样，全量审计 grep `NUM_MARK` 一行都搜不到，看起来像这个常量没人用。
 */
const NUM_MARK = '\u0000';

export interface Suggestion {
  /** 可以直接填进规则编辑器的正则 */
  pattern: string;
  /** 这条规则在全书命中多少行 */
  hits: number;
  /** 头几条命中的原文，给用户判断 */
  samples: string[];
}

/* 正则元字符的转义搬进了 format.ts 的 escapeRe——legado.ts 那处一模一样 */

/** 归一化形状 → 正则 */
function shapeToPattern(shape: string): string {
  return (
    '^' +
    shape
      .split(NUM_MARK)
      .map(escapeRe)
      .join(`${NUM_CLASS}{1,10}`)
  );
}

/**
 * 句末标点。行尾是这些的多半是正文句子，不是标题。
 * **收尾的引号也要算**——对白整行就是「“一定牢记在心。”」，以 `”` 结束
 */
const SENTENCE_END = /[。！？…；，,!?”」』"]$/;

/**
 * 候选前缀最少要命中多少行。太低会让正文里偶然重复的短句混进来，
 * 太高会漏掉章节本来就少的书（历史类常见十几章）
 */
const MIN_HITS = 5;
/** 形状取前几个字符。「第#章」「〔#〕」「☆、」都在 4 个字符以内 */
const MAX_SHAPE_LEN = 6;

/**
 * 平均章节字节数的下限。**比自动选规则那套严得多**（那边是 3000 左右）：
 * 建议是给人看的，宁可少给几条也别让人在一堆垃圾里挑。
 * 网文一章通常三五千字，1.2 KB 已经是很宽松的下限了
 */
const MIN_MEAN_BYTES = 1200;

/**
 * 只有带「结构标记」的前缀才配当建议。
 *
 * 不加这条的话排在最前面的永远是 `^“` `^这` `^他` `^方`——对白和正文里
 * 最常见的开头字，在 34MB 的《蛊真人》上一口气命中三四万行，
 * 间隔还特别均匀，`scoreRule` 给的分比真章节还高。
 *
 * 「结构标记」= 形状里有序号占位符，或者以一个正文绝不会用来起句的符号开头。
 * **引号和圆括号故意不在这个集合里**——`“` 开头的是对白，`（` 开头的是插注。
 */
const MARKER_HEAD = /^[【〔〖〈☆★✦✧◆◇※¥§#＃●○■□◎▲△▼▽]/;

function isStructural(shape: string): boolean {
  // 形状光是一个序号（`^#`）也不算：「一时间」「两人」这类正文开头全会中招
  if (shape.includes(NUM_MARK) && shape.split(NUM_MARK).join('').trim().length > 0) return true;
  return MARKER_HEAD.test(shape);
}

/**
 * 猜这本书可能的章节规则，按可信度排序。
 *
 * 判据和自动选规则那套是同一套（`scoreRule` 的间隔均匀度 + 平均章节大小），
 * 外加标题质量：**标题基本都不一样，而且得有能读的字**——
 * 全叫「※※※」的一堆分隔线在数量上很好看，实际毫无用处（这个坑真踩过）。
 */
export function suggestRules(buf: Uint8Array, encoding: Encoding, limit = 5): Suggestion[] {
  const lines = splitLines(buf, encoding);
  const totalBytes = buf.length;

  // 只看「像标题」的短行。和 matchLines 用同一套预处理，否则建议出来的正则
  // 在真正解析时会命中不同的行
  const cands: Array<{ text: string; shape: string; byteOffset: number }> = [];
  for (const line of lines) {
    const text = line.text.trim().replace(MD_HEADING, '');
    if (text.length < 2 || text.length > MAX_TITLE_LEN) continue;
    const shape = text.replace(NUM_RUN, NUM_MARK);
    cands.push({ text, shape, byteOffset: line.byteOffset });
  }

  // 按形状前缀归组。`第#章` 和 `第#` 和 `第` 会各成一组，让打分去分高下
  const groups = new Map<string, Line[]>();
  for (const c of cands) {
    const upto = Math.min(c.shape.length, MAX_SHAPE_LEN);
    for (let k = 1; k <= upto; k++) {
      const key = c.shape.slice(0, k);
      // 前缀落在纯空白上没有意义
      if (!key.trim()) continue;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push({ text: c.text, byteOffset: c.byteOffset });
    }
  }

  const scored: Array<Suggestion & { score: number; shapeLen: number; offsets: Set<number> }> = [];
  for (const [shape, hits] of groups) {
    if (hits.length < MIN_HITS) continue;
    if (!isStructural(shape)) continue;
    if (totalBytes / hits.length < MIN_MEAN_BYTES) continue;

    const titles = hits.map((h) => h.text);
    const distinct = new Set(titles).size;
    // 标题基本都一样 = 按分隔线乱切，数量再好看也没用
    if (distinct < titles.length * 0.5) continue;
    // 标题里得有能读的字
    if (titles.filter((t) => hasReadable(t)).length < titles.length * 0.7) continue;
    // **正文句子以句末标点收尾，章节标题不会。** 这一条把剩下的噪音扫得很干净：
    // 「这一刻，他的双眸清冽无比。」「第一书记是满意的…希望。」「两人手牵手离开了教室。」
    // 全出局，而「===第一节：纵身亡魔心仍不悔===」「第一萌、穿到武侠世界」不受影响
    if (titles.filter((t) => SENTENCE_END.test(t)).length > titles.length * 0.5) continue;

    const score = scoreRule(hits, totalBytes);
    if (score <= 0) continue;

    scored.push({
      pattern: shapeToPattern(shape),
      hits: hits.length,
      samples: titles.slice(0, 4),
      score,
      shapeLen: shape.length,
      offsets: new Set(hits.map((h) => h.byteOffset)),
    });
  }

  // **去重和排序要分开做。**
  //
  // 去重时「长形状优先」是对的：`第#章` 和 `第#` 命中的往往是同一批行，
  // 但前者不会顺手把「第一卷」和正文里的「第二天」收进来。
  // 可要是**按长度排完就直接取前 5**，名额会被正文里那些又长又碎的形状占满——
  // 实测《萌娘武侠世界》的正解 `第#萌、`（1062 处）被 `李岩抹了#把`（63 处）
  // 和 `众人#起大汗`（18 处）挤了出去。
  //
  // 所以：先按分数圈一个池子 → 池子内按长度去重 → 幸存者再按分数排。
  scored.sort((a, b) => b.score - a.score);
  const pool = scored.slice(0, 150);
  pool.sort((a, b) => b.shapeLen - a.shapeLen || b.score - a.score);

  const kept: typeof pool = [];
  const taken: Array<Set<number>> = [];
  for (const s of pool) {
    // 用 Jaccard 而不是「占较小那个的 8 成」：后者会让一个只命中 100 行的
    // 长形状把命中 500 行的正解顶掉——100 行全在那 500 行里，占比 100%
    const dup = taken.some((t) => {
      let shared = 0;
      for (const o of s.offsets) if (t.has(o)) shared++;
      return shared / (s.offsets.size + t.size - shared) >= 0.8;
    });
    if (dup) continue;
    taken.push(s.offsets);
    kept.push(s);
  }

  // 最后再滤一次子集：`第#萌、我`（78 处）整个包在 `第#萌、`（1062 处）里面，
  // 是同一条规则的一个碎片，列出来只会让人以为有两种格式。
  // 放在**排完序之后**做——这样留下的是分高的那个（也就是完整的那条）
  const ranked = kept.sort((a, b) => b.score - a.score);
  const final: typeof ranked = [];
  for (const s of ranked) {
    const covered = final.some((f) => {
      let shared = 0;
      for (const o of s.offsets) if (f.offsets.has(o)) shared++;
      return shared >= s.offsets.size * 0.9;
    });
    if (!covered) final.push(s);
    if (final.length >= limit) break;
  }
  return final.map((s) => ({ pattern: s.pattern, hits: s.hits, samples: s.samples }));
}
