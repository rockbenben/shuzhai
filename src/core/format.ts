/**
 * 卡片上那几个数怎么写成人话，外加几个纯文本小工具。
 *
 * **这个文件一个 `import` 都没有**——这不是巧合，是它能当「共用的那一份」放这儿的
 * 全部理由：**core 和渲染进程两边都在引它**，带一个依赖进来就等于把那个依赖
 * 塞进渲染包（`search.ts` 拖 `node:sqlite` 那件事，`snippet.ts` 的注释里记着）。
 * 往这儿加东西前先问一句：**它需要 import 什么吗？需要就别放这儿。**
 */

/**
 * 这段字里有没有**一个能读的字符**（不是空白、标点、符号、控制符、分隔符）。
 *
 * 两处在用，判据完全一样：
 *   - `suggest.ts`：候选规则切出来的标题**纯符号的一律可疑**——`star-title` 那次
 *     把「※※※」「◇◇◇◇」这种场景分隔线当成了章节标题，《藏地密码》81→498 章，
 *     每一章都叫「※※※」（AGENTS.md「章节数变多不等于切对了」那节）。
 *   - `tts.ts`：整段只有标点的不必送去朗读。
 *
 * 原来两个文件各写一份**同名同值**的私有 `READABLE`。`dup-decls.mjs` 当时看不见——
 * core 内部那一档只比对 exported 的声明；现在它连私有的也比（同名又同值才报）。
 * 放这儿是因为 `format.ts` 一个 import 都没有，谁引都不会带出依赖。
 */
export const hasReadable = (s: string): boolean => /[^\s\p{P}\p{S}\p{C}\p{Z}]/u.test(s);

/**
 * 把一段纯文本转义成「只匹配它自己」的正则片段。
 *
 * 两处在用，原来各写一遍同一个字符类：`suggest.ts`（建议出来的 pattern 要能原样
 * 喂给 `new RegExp`）和 `legado.ts`（legado 的 `isRegex: false` 规则搬过来时
 * 转成正则，语义不变）。
 *
 * ⚠️ **别换成 Node 24 的 `RegExp.escape`。** 它连空格都会转成 `\x20` 这种十六进制，
 * 而这个结果是**存进 `clean_rule.pattern`、还要显示在规则编辑器里给人看的**——
 * 换过去等于让用户看到一串十六进制。判据原来写在 AGENTS.md 的「查过了决定不用」
 * 那张表里，只盯着 `legado.ts` 一处；合并之后它跟着实现走，两处一起管住。
 */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 字数。**数字和单位之间用不换行空格**（` `）——卡片只有 8 来个字宽，
 * 普通空格会让它在「2」和「万字」之间断行，读起来像两个数。
 */
export const wan = (n: number | null | undefined): string =>
  !n ? '' : n >= 10000 ? `${(n / 10000).toFixed(0)} 万字` : `${n} 字`;

const RTF = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

/**
 * 「上次读是多久以前」。
 *
 * **绝对时间戳在书架上没用**：「2026-03-04 22:11」要在脑子里减一次才知道
 * 是不是很久没碰了，而「3个月前」直接就是判断「这本是不是弃了」的那个量。
 *
 * 单位自己挑，中文措辞交给 `Intl.RelativeTimeFormat`——`numeric: 'auto'`
 * 会给出「昨天」「上个月」「去年」这些正常说法，自己拼永远差一口气。
 */
/**
 * 把库里的时间文本变成时间戳。
 *
 * **sqlite 的 `datetime('now')` 存的是 UTC**，而 JS 的
 * `new Date('2026-08-16 13:21:38')` 按**本地时区**解析——在东八区整整差 8 小时：
 * 刚读完的书会显示「8小时前」，不报错、不留痕，只是数字一直不对。
 * 补一个 `Z` 才是这个字符串本来的意思。
 */
export function sqlTime(s: string | null | undefined): number | null {
  if (!s) return null;
  // 只有日期没有时分的（迁移和测试里有）本来就按 UTC 解析，不用补
  const iso = s.includes('T') || !s.includes(' ') ? s : `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * 库里的时间文本 → 给人看的一句话。
 *
 * **必须走这里，别把那个字符串直接印出去。** 它是 sqlite 的 UTC 文本
 * （`2026-08-23 13:12:38`），原样显示就是把 UTC 当本地时间摆给用户看——
 * 东八区差 8 小时，而且**不报错、不留痕**：书签面板上一条刚加的书签
 * 写着八小时前的时刻，看起来就像时钟坏了。
 *
 * 说法跟卡片一致（「3个月前」），准确到秒的本地时间放进 `title`——
 * 想知道具体哪一天的人鼠标停一下就有。
 */
export function whenAgo(s: string | null | undefined, now = Date.now()):
{ text: string; title: string } | null {
  const t = sqlTime(s);
  if (t == null) return null;
  return { text: relTime(t, now), title: new Date(t).toLocaleString('zh-CN') };
}

export function relTime(then: number, now = Date.now()): string {
  const s = Math.max(0, (now - then) / 1000);
  const [n, unit]: [number, Intl.RelativeTimeFormatUnit] =
    s < 3600 ? [s / 60, 'minute']
    : s < 86400 ? [s / 3600, 'hour']
    : s < 2592000 ? [s / 86400, 'day']
    : s < 31536000 ? [s / 2592000, 'month']
    : [s / 31536000, 'year'];
  return RTF.format(-Math.floor(n), unit);
}

/**
 * 此刻生效的筛选条件，写成人话，一条一句。
 *
 * **给「这一屏为什么空」用的，而它的要点是不撒谎。** 原来那段是从上往下
 * 第一个命中就返回，关键词排在最前——于是搜「连载」（真有 1 本）再点一个
 * 那本书没有的标签，屏幕上说的是「没有带「连载」的书」，**那是假话**，
 * 用户会以为搜索坏了或者书没了。同 `canDelete` 那条：拦下来的理由
 * 说的不是真正那一样。
 *
 * 所以先数一遍：**超过一条就一条都不归因**，把它们列出来让用户自己去掉一个；
 * 只剩一条时调用方再讲那句具体的话。
 */
export function activeFilterWords(f: {
  keyword?: string;
  tagNames?: string[];
  /** 书架档位的中文名。「全部」那一档不算条件，传 null */
  shelfName?: string | null;
  /** 「几星以上」那个开关。null / undefined = 没开 */
  minRating?: number | null;
  /**
   * 正在生效的**分类**名。分类是「文件夹＋评分＋标签」这类规则的组合，
   * 拆开逐条报出来只会让人更糊涂（「不在这个文件夹里、评分不够四星……」），
   * 报名字就够——用户知道自己点的是哪一个。
   */
  categoryName?: string | null;
  /**
   * 下面这几样是**临时筛选**（「就这么筛，不存」那条路）用的。
   *
   * 存成分类的规则只报名字（上面 `categoryName` 那段解释了为什么：
   * 拆开逐条报只会更糊涂，而用户知道自己点的是哪一个）；
   * 而临时筛选**没有名字**，不摊开来说，屏幕上就只剩「没有书」三个字，
   * 用户看不出是自己刚设的哪一条把结果筛空了。
   */
  finishedYear?: number | null;
  /** 扩展名本身（`pdf` / `txt` …）外加 `manual`＝只有记录。说法走 `book-format.ts` */
  formatNames?: string[];
  /** 连载状态的中文说法，调用方从 `labels.ts` 取好再传 */
  serialNames?: string[];
  /** 阅读状态的中文说法，同上 */
  statusNames?: string[];
  /** 只看某个目录。空串＝根目录直属 */
  dir?: string | null;
}): string[] {
  const tags = f.tagNames ?? [];
  /** 「A」「A 或 B」——多选一律是「任意一个」，别写成顿号让人以为是「同时」 */
  const 任意 = (xs: string[] | undefined, 后缀: string): string | null =>
    xs?.length ? `${xs.map((n) => `「${n}」`).join('或')}${后缀}` : null;
  return [
    f.keyword ? `书名、作者或别名里带「${f.keyword}」` : null,
    tags.length === 1 ? `带「${tags[0]}」标签`
      : tags.length ? `同时带上${tags.map((n) => `「${n}」`).join('')}` : null,
    f.shelfName ? `属于「${f.shelfName}」` : null,
    f.categoryName ? `符合分类「${f.categoryName}」的规则` : null,
    f.minRating != null
      ? `评分 ${f.minRating} 星${f.minRating >= 5 ? '' : '以上'}`
      : null,
    f.finishedYear != null ? `${f.finishedYear} 年读完的` : null,
    任意(f.statusNames, ''),
    任意(f.serialNames, ''),
    任意(f.formatNames, '格式'),
    // 空串是**根目录直属的文件**，不是「没选目录」——那两件事差得远
    f.dir != null ? (f.dir === '' ? '在根目录下' : `在「${f.dir}」这个文件夹下`) : null,
  ].filter((x): x is string => x !== null);
}
