// 书架共用的排序与待办规则：纯数据，不加载文件或数据库模块。
import type { Filter } from './library.ts';
import { TOUCHED_STATUS } from './labels.ts';

export type SortBy = 'time' | 'lastread' | 'title' | 'words' | 'rated' | 'rating' | 'finished' | 'stale';

/**
 * 排序。**默认按「这本书最近一次有动静」**——最后阅读时间和文件 mtime 取较新的那个，
 * 不是 `book.updated_at`。
 *
 * `updated_at` 是数据库行的更新时间，一次全库扫描会把成千上万本书写成同一个值——
 * 实测用户库里 **7459 本共用一个时间戳**，所以「按更新时间排」在那批里完全是随机的，
 * 而且看起来像是排过了。文件的 mtime 才是「这本书什么时候到我这儿的」。
 *
 * 都要带 `b.id` 兜底：mtime 相同的文件不少（同一批拷进来的），
 * 没有稳定的次级键的话，翻到第二页可能出现重复或漏掉的书。
 */
const ORDER: Record<SortBy, string> = {
  // **最后阅读时间和入库时间取较新的那个**，一路倒序。
  // 旧规则是「读过的整组无条件压在没读过的前面」：三年前翻过一次的书也排在
  // 昨天刚入库的书前面，而「最新的在前」里新入库的书恰恰最该被看见——
  // 有阅读进度的也该拿时间出来比，不是盲目排前面。刚放下的那本 last_read_at
  // 就是此刻，照样排第一：原来那张「继续阅读」卡片的用途没丢（见 lessons.md
  // 「『继续阅读』那张卡片被排序取代了」）。
  // 时间格式不一样：last_read_at / created_at 是 UTC 文本（datetime('now')），
  // fl.mtime 是毫秒 epoch（Math.floor(mtimeMs)），strftime 折成毫秒再比。
  // **手工书（没文件）拿 created_at 当入库时间**：它没有 mtime，也永远不会有
  // last_read_at（纸质书 / 别的设备读的，见 manual.ts），不兜底就永远沉在所有
  // 文件书底下。⚠️ 只在文件缺失时兜 created_at——有文件的书不许用：首次全库
  // 扫描会把八千本的 created_at 写成同一天，带进 max 等于把 mtime 顺序整个抹掉
  // （同上面 `updated_at` 那个坑的同款形状）。
  time: `max(ifnull(strftime('%s', r.last_read_at) * 1000, 0),
         coalesce(fl.mtime, strftime('%s', b.created_at) * 1000, 0)) desc,
         b.id desc`,
  // **纯「上次读」序**：读过的整组在前按最后阅读时间倒序，没读过的沉底按入库时间。
  // 书评表格的「上次读」表头点一下要的就是它——那一列空白（没在应用里打开过）
  // 的行若按 `time`（阅读/入库取较新）排，会拿文件时间插进有日期的行中间，
  // 看起来就是坏的。`time` 答「这本书最近有动静吗」，这个答「我上次什么时候读的」。
  lastread: `case when r.last_read_at is null then 1 else 0 end,
             r.last_read_at desc,
             coalesce(fl.mtime, strftime('%s', b.created_at) * 1000, 0) desc, b.id desc`,
  // ⚠️ 中文是**码位序，不是拼音序**（丙 < 乙 < 甲）。SQLite 没有拼音排序，
  // 而分页要求排序在 SQL 里做——8000 本不可能拉到前端 localeCompare 一遍。
  // 实际价值是把同前缀的系列排到一起，不是给人按字典查
  title: 'b.title collate nocase, b.id',
  words: 'ifnull(fl.word_count, 0) desc, b.id desc',
  // 「我的书评」这一档默认按它：最近写的排前面。没评价过的沉到最后而不是混在中间——
  // 这一档本来就是给「翻翻我写过什么」用的
  //
  // ⚠️ **比的是归一化之后的时间。**这一列是**按字符串比**的，而库里两种写法都有：
  // `datetime('now')` 写的 `2026-10-25 08:00:00`，`toISOString()` 写的
  // `2026-10-25T08:00:00.000Z`——而 `'T' > ' '`，混进来的那一条会永远排在最前面，
  // 「我最近评过什么」的顺序是乱的（`format.ts` 的 `sqlTime` 记着同一个坑的另一半）。
  // 归一化：T 换成空格、去掉 Z、只留前 19 位（秒级）。
  rated: `case when r.rated_at is null then 1 else 0 end,
          substr(replace(replace(r.rated_at, 'T', ' '), 'Z', ''), 1, 19) desc, b.id desc`,
  rating: `ifnull(r.rating, -1) desc,
           substr(replace(replace(r.rated_at, 'T', ' '), 'Z', ''), 1, 19) desc, b.id desc`,
  // 「最近读完的在前」。没读完的沉到最后，不混在中间——同上面 `rated` 那条。
  // 表格视图那一列的表头点一下走的就是它；`finished_at` 在这之前
  // **界面上一处都没用过**（一直只在库里和备份里）
  finished: `case when r.finished_at is null then 1 else 0 end,
             r.finished_at desc, b.id desc`,
  // **「待更新」档的排法**：本地副本**上次内容变动**最久的在前——最该去看有没有新章的排第一。
  // 用 fl.mtime：追更覆盖写入会刷新 mtime，所以刚追更过的书重新计时、沉到后面（这是对的：
  // 刚到手新章的不该排「最该更新」第一）。升序，和 time/lastread 方向相反；
  // 时间折算同 `time` 那条；无文件的手工书 coalesce 到 0 沉底。
  stale: `coalesce(fl.mtime, strftime('%s', b.created_at) * 1000, 0) asc, b.id asc`,
};

/**
 * 排序键 → order by 子句。**不认识的当场报错，不许拼进 SQL。**
 *
 * 原来是直接 `ORDER[page.sort ?? 'time']`，两个毛病：
 *
 *  1. **拼错了只会得到一句 SQLite 原文。** 外部工具传 `sort: 'recent'`，
 *     `undefined` 被拼进去，用户看到的是 `no such column: undefined`——
 *     和 `convert.set` 那次一模一样的形状（rpc 表对外开放，见 AGENTS.md §13，
 *     而外部调用方最容易错的就是参数名和取值）。
 *  2. **对象取值会命中原型链。** `ORDER['constructor']` 给的是
 *     `function Object() { [native code] }`，`ORDER['toString']` 同理——
 *     拼进 SQL 只会得到语法错误（**不是注入**，因为拿不到任意字符串），
 *     但 `api.test.ts` 早就为 rpc 白名单钉过「原型链上的名字不算」这一条，
 *     同一个道理在这儿也成立。
 *
 * 用 `Object.hasOwn` 判，两个毛病一起没。
 */
/**
 * 认得的排序键。**从 `ORDER` 自己算出来，不另写一份清单**——
 * 渲染进程要用它校验 localStorage 里存的偏好（用户能手改那个值），
 * 而抄一份下来，加一档排序时必然漏掉其中一份。
 */
export const SORT_KEYS: SortBy[] = Object.keys(ORDER) as SortBy[];

export function orderBy(sort: SortBy | undefined): string {
  const key = sort ?? 'time';
  if (!Object.hasOwn(ORDER, key)) {
    throw new Error(`不认识的排序方式：${String(key)}。可选：${Object.keys(ORDER).join(' / ')}`);
  }
  return ORDER[key];
}

/**
 * 「读过、可是还没写一句」——这个应用唯一的待办清单。
 *
 * **判据只此一份**：侧栏那一档（`shelfCounts`）、书架那一档（`App.tsx` 的 `SHELVES`）
 * 和 `/api/stats` 都引它。两份 SQL 说同一件事，改一处漏一处不会有任何报错——
 * 侧栏说 6 本、外部工具拿到 12 本，而谁也说不清哪个对（同 `ratedSql` 那条）。
 *
 * 两半缺一不可：光 `rated: false` 是整个书库（真实库 8171 本），
 * 那不是待办；「读过」的口径从 `TOUCHED_STATUS` 算，不在这儿另写一份。
 */
export const UNREVIEWED: Filter = { rated: false, readingStatus: TOUCHED_STATUS };
