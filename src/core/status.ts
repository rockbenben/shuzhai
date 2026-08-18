// 阅读状态、书签、阅读会话（spec §5）。
//
// 这里动的全是**不可再生**的数据：进度、评分、短评、书签。重新扫描恢复不了，
// 所以这个模块里没有任何「顺手清理一下」的逻辑——状态只在用户明确要求时改变。

import type { DatabaseSync } from 'node:sqlite';
import { READING_STATUS as STATUS_LABELS } from './labels.ts';
import { noteGuard } from './highlight.ts';
import { sqlTime } from './format.ts';
import { buildFilter, BOOK_JOIN, type Filter } from './library.ts';

/** spec §5.1。弃坑必须有，网文场景高频 */
/**
 * `none` = **还没标记过**，扫进来的默认值。
 * 「想读」是用户的表态，不该由扫描替他说——见 db.ts 的迁移 17。
 */
/*
 * 阅读状态的清单**只此一份**，在 `labels.ts`（那份带中文名，侧栏、导出、
 * 编辑弹窗、批量改状态都用它）。这里原来自己又写了一份纯 id 的——
 * 同一张表两个副本，加一档漏改一处就会：`labels` 那边多出来的档位
 * 在这儿**校验不过**，用户看到「不认识的阅读状态：shelved」。
 *
 * `SERIAL_STATUS` 当年就是这么删掉的（`metadata.ts` 里那份纯 id 副本），
 * 而阅读状态这一份一直留到现在——`scripts/dup-decls.mjs` 把范围从
 * 「渲染 vs core」放宽到「core 内部」之后才照出来。
 */
// 名字里带 IDS 是有意的：`labels.ts` 那份是 `{ id, name }`，这份是纯 id。
// 两处同名的话，import 的人分不出自己拿到的是哪一种（而类型对不上要到用的时候才炸）
export const READING_STATUS_IDS = STATUS_LABELS.map((s) => s.id);
export type ReadingStatus = (typeof STATUS_LABELS)[number]['id'];

export interface StatusPatch {
  status?: ReadingStatus;
  /** 1–5，允许半星（4.5）。spec §5.1 二选一，这里选 5 星制 */
  rating?: number | null;
  comment?: string | null;
  dropReason?: string | null;
  /*
   * **「已读完 → 在读」到底是哪个意思。**
   *
   * 那一支会清掉阅读位置、`reread_count + 1`——按 spec §5.1 那叫「重读」。
   * 可用户在下拉里选「在读」时有两种意图，应用分不出来：
   *
   *   1. 我要**重新读一遍** → 回到开头是对的；
   *   2. 我**标错了**，其实还没读完 → **读到第 N 章的位置当场没了**，
   *      而那是铁律 3 的数据，重扫恢复不了。
   *
   * 穷举过 36 种状态转换（`status.test.ts` 那条钉着），**只有这一种会动用户数据**。
   * 所以它不该由一个下拉菜单静默决定：界面上问一句，把答案带下来。
   * 传 `true` 就是第 2 种——位置和重读次数一个都不碰。
   */
  keepProgress?: boolean;
}

/**
 * `StatusPatch` 认得的字段。**从这里算，不另抄一份清单**——
 * 加字段时漏改一处，那个字段就会被下面那道校验当成拼错的名字拒掉。
 */
const PATCH_KEYS: Array<keyof StatusPatch> = ['status', 'rating', 'comment', 'dropReason', 'keepProgress'];

/**
 * 改阅读状态。
 *
 * **从「已读完」再次开读会算一次重读**（spec §5.1）：`reread_count` 自增、进度归零。
 * 这一条要显式判断，不能靠「状态变了就加一」——从「想读」到「在读」不是重读。
 */
/**
 * 改之前那一行长什么样。**撤销按这个原样写回，不是「再设一次状态」。**
 *
 * ⚠️ 原来只存 `status`，撤销走 `setStatus(bookId, { status: from })`——
 * 而那个函数带着一整套「离开某个状态时顺手改派生字段」的逻辑，于是
 * **撤销本身又改坏了三样**（三条测试各钉一样）：
 *   - 弃坑原因：`setStatus` 离开 `dropped` 时会清掉它，撤销回去也补不回来——
 *     那是用户自己写的字。
 *   - 重读次数：`finished → reading` 会 `reread_count + 1`，而一来一回
 *     正好走这一支。那个数只增不减。
 *   - 进度百分比：离开 `finished` 会按 `chapter_idx` 重算，没读过的书
 *     从 0 变成 0.2，书架上多一条谁也解释不了的进度。
 *
 * 「撤销」的语义本来就是**把这一行放回去**，不是「再做一次状态转换」，
 * 所以它该直接写这些列，而不是借道那个管转换的函数。
 */
export interface StatusSnapshot {
  bookId: number;
  from: ReadingStatus;
  finishedAt: string | null;
  percent: number;
  rereadCount: number;
  dropReason: string | null;
  chapterIdx: number;
  charOffset: number;
}

export interface BulkStatusResult {
  /** 真的改动过的，带上改之前那一行的快照——撤销全靠它 */
  changed: StatusSnapshot[];
  /** 本来就是这个状态，没动 */
  same: number;
  /** 动过的（读完了、读到过第几章、或者写过弃坑原因），批量一律不动（理由见下） */
  kept: number;
}

/**
 * 按**整个筛选结果**改阅读状态。
 *
 * 为什么要有它：真实书库 8172 本，而打过分的 1 本、写过短评的 0 本、
 * 打过标签的 0 本。这个应用的正事是「下次不用再想这本我看过没」，
 * 而现在要说「这本读过」只有逐本点开、逐本编辑、逐本手工添三条路——
 * 对八千本的库等于没有入口。批量打标签早就走「整个筛选结果」了
 * （`tagBooksByFilter`），这里照它的路子来，不另起一套。
 *
 * ⚠️ **「已读完」的书批量一律不动**，就算目标状态不是它。两个理由，都硬：
 *
 *   1. `finished → reading` 在 `setStatus` 里会**清零 `chapter_idx` 并记一次重读**——
 *      那是铁律 3 的数据，重扫恢复不了。一次批量能把几百本的进度抹掉。
 *   2. 离开「已读完」会把 `finished_at` 清成 null，而**撤销补不回那个日期**
 *      （再标回去只会写一个「现在」）。只写不还原的派生字段，本文件别处已经栽过。
 *   3. **读到过第几章的书，改了标签就自相矛盾。** 这一条是在真实库上量出来的：
 *      整库标成「想读」之后，《我从凡间来》成了「想读 + 读到 1104 章」。
 *      数据一个字没丢（进度、偏移、重读次数都在），但那条记录本身说不通了——
 *      正是本文件别处记着的那个形状（「状态是想读、却有读完时间、进度条还满格」）。
 *      代价接近零：真实库 8172 本里有进度的只有 4 本。
 *
 * 撤销存的是**改之前整行的快照**（`StatusSnapshot`），不是只记一个 `from`：
 * 走 `setStatus` 撤销会顺手改掉 `finished_at` / `percent` / `reread_count`，
 * 那不叫撤销，叫再改一次。还原直接写列，见 `restoreStatus`。
 *
 * 逐本走 `setStatus`，**不自己拼 UPDATE**：那些派生字段的还原规则只此一份，
 * 抄第二遍必然分叉（本仓库开头就写着这条，`shelfCounts` 绕开 `buildFilter` 是前科）。
 */
export function setStatusByFilter(
  db: DatabaseSync,
  filter: Filter,
  status: ReadingStatus,
): BulkStatusResult {
  const rows = pick(db, filter, status);
  const changed: StatusSnapshot[] = [];

  db.exec('begin');
  try {
    for (const r of rows.change) {
      /*
       * **读的那头容得下「没有 reading_state 行」的书，写的这头也得容得下。**
       *
       * `BOOK_JOIN` 是 left join，筛选用的是 `ifnull(r.status,'none')`——
       * 所以「未标记」那一档**按定义就包含没有那一行的书**。而 `setStatus`
       * 对这种书直接抛「书 N 没有阅读状态记录」，抛在事务里，
       * **一本这样的书就把整批回滚了**，用户拿到一句带着数字 id 的内部话。
       * 补一行就是了——它本来就该有。
       */
      db.prepare("insert or ignore into reading_state(book_id, status) values(?, 'none')").run(r.id);
      setStatus(db, r.id, { status });
      changed.push({
        bookId: r.id, from: r.cur,
        finishedAt: r.finishedAt, percent: r.percent,
        rereadCount: r.rereadCount, dropReason: r.dropReason,
        chapterIdx: r.chapterIdx, charOffset: r.charOffset,
      });
    }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return { changed, same: rows.same, kept: rows.kept };
}

/**
 * 执行之前先看会改哪些。**和执行走同一份判定**（`pick`），所以预览里
 * 列出来的就是待会真的会变的那些书。
 *
 * ⚠️ 原来不是这样：弹窗自己去 `book.list({ filter, limit: 20 })` 拿前 20 本当预览。
 * 而默认排序（`ORDER.time`，读过的排最前）把**动过的书排在最前面**——
 * 那批恰恰是 `kept`，一本都不会变。于是「会被改的书」列出来的正好是**不会**改的，
 * 按钮上还写着「（153 本）」，点完结果卡说「已把 0 本标成…」。
 * 预览是这个弹窗唯一的安全阀，展示操作的补集比没有预览更糟
 * （同 AGENTS.md「预览表只列会变的那些」）。
 */
export function planStatusByFilter(
  db: DatabaseSync,
  filter: Filter,
  status: ReadingStatus,
  /**
   * 回几本书名当样本。**`total` 照旧是真实的全量**——界面只列前 20 本，
   * 而整库 8172 本时回传全部书名是 334 KB，界面转手扔掉 99.7%（实测）。
   */
  sampleSize = 20,
): {
  sample: Array<{ bookId: number; title: string; from: ReadingStatus }>;
  total: number; same: number; kept: number;
} {
  const r = pick(db, filter, status);
  return {
    sample: r.change.slice(0, sampleSize).map((x) => ({ bookId: x.id, title: x.title, from: x.cur })),
    total: r.change.length,
    same: r.same,
    kept: r.kept,
  };
}

interface PickRow {
  id: number; title: string; cur: ReadingStatus; chapterIdx: number; charOffset: number;
  finishedAt: string | null; percent: number; rereadCount: number; dropReason: string | null;
}

/** 筛出来的书分三档：会改的、本来就是的、动过所以不碰的 */
function pick(db: DatabaseSync, filter: Filter, status: ReadingStatus):
{ change: PickRow[]; same: number; kept: number } {
  if (!READING_STATUS_IDS.includes(status)) throw new Error(`不认识的阅读状态：${status}`);
  const { sql, params } = buildFilter(filter);
  // `BOOK_JOIN` 里**已经**left join 了 reading_state（别名 `r`），别再 join 一次
  const rows = db
    .prepare(`select b.id, b.title, ifnull(r.status, 'none') as cur,
                     ifnull(r.chapter_idx, 0) as chapterIdx, ifnull(r.char_offset, 0) as charOffset,
                     r.finished_at as finishedAt, ifnull(r.percent, 0) as percent,
                     ifnull(r.reread_count, 0) as rereadCount, r.drop_reason as dropReason
                ${BOOK_JOIN} where ${sql} order by b.title collate nocase, b.id`)
    .all(...params) as unknown as PickRow[];

  const change: PickRow[] = [];
  let same = 0;
  let kept = 0;
  for (const r of rows) {
    if (r.cur === status) { same++; continue; }
    // **写过弃坑原因的也算「动过」**：那是用户自己写的字，而 `setStatus`
    // 离开 `dropped` 时会把它清掉——批量扫过去等于把那句话删了
    if (r.cur === 'finished' || r.chapterIdx > 0 || r.charOffset > 0 || r.dropReason) { kept++; continue; }
    change.push(r);
  }
  return { change, same, kept };
}

/**
 * 撤销一次批量改状态：**按快照把那几行原样写回**。
 *
 * 不走 `setStatus`——它管的是「向前做一次状态转换」，带着一堆派生字段的副作用
 * （清弃坑原因、记一次重读、重算百分比），而撤销要的恰恰是「当作没发生过」。
 * 借道它的结果是撤销自己又改坏三样东西，见 `StatusSnapshot` 上面那段。
 *
 * 这里直接写列是**对的**，不算「绕开唯一那份逻辑」：那份逻辑描述的是转换，
 * 而这是回滚。语句提到循环外面——八千本时 `prepare` 一次和八千次差着量级。
 */
/*
 * ── 阅读状态的字段判据，**三处共用一份** ──────────────
 *
 * 往 `reading_state` 写的门不止一扇：前门 `setStatus`（逐字段校验过）、
 * 恢复备份、还有**撤销**。后两扇原来都是把调用方给的值直接写进去——
 * 实测 `reading.restoreStatus` 收下了 `status: '乱写的状态'`、`percent: 500`、
 * `chapter_idx: -5`，还回一句 `{restored: 1}`。而这两扇门都对外开放（§13）。
 *
 * 判据抽在这里给三处用，不各抄一份——本仓库那条「同一份约定抄成几份必然分叉」
 * 已经被咬过好几次，而这三处**恰好都写同一张表的同一批列**。
 */
export const asFinite = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

export const asText = (v: unknown): string | null =>
  (typeof v === 'string' ? v.trim() || null : null);

/** 认得出的时间文本才留着。**不是时间就别留**——「我的书评」按 `rated_at` 排序 */
export const asWhen = (v: unknown): string | null =>
  (typeof v === 'string' && sqlTime(v) != null ? v : null);

/**
 * 把一条撤销快照收拾成合法的，顺带数一数改了几处。
 *
 * **撤销的语义是「把这一行放回去」**，所以它直接写列、不走 `setStatus`
 * （那个函数带着一整套向前转换的逻辑，理由写在 `StatusSnapshot` 上面）。
 * 代价就是**校验也得自己做一遍**——这一步原来漏了。
 */
export function sanitizeSnapshot(r: StatusSnapshot): { row: StatusSnapshot; fixed: number } {
  let n = 0;
  const keep = <T>(ok: T | null, raw: unknown, fallback: T): T => {
    if (ok === null && raw != null) n++;
    return ok ?? fallback;
  };
  const status = READING_STATUS_IDS.includes(r.from as never) ? r.from : (n++, 'none');
  /*
   * ⚠️ **先把 `row` 算出来，再读 `n`。** 第一版写成
   * `return { fixed: n, row: { … } }`——对象字面量**从上往下求值**，
   * `fixed: n` 那一刻只发生过 status 那一次自增，后面几处全丢了（实测报 1，该是 5）。
   * 测试当场抓住的：那条断言钉的正是「报出改了几处」。
   */
  const row: StatusSnapshot = {
    ...r,
    from: status as StatusSnapshot['from'],
    finishedAt: r.finishedAt == null ? null : (asWhen(r.finishedAt) ?? (n++, null)),
    percent: keep(asFinite(r.percent, 0, 100), r.percent, 0),
    rereadCount: keep(asFinite(r.rereadCount, 0, Number.MAX_SAFE_INTEGER), r.rereadCount, 0),
    dropReason: r.dropReason == null ? null : asText(r.dropReason) ?? (n++, null),
    chapterIdx: keep(asFinite(r.chapterIdx, 0, Number.MAX_SAFE_INTEGER), r.chapterIdx, 0),
    charOffset: keep(asFinite(r.charOffset, 0, Number.MAX_SAFE_INTEGER), r.charOffset, 0),
  };
  return { row, fixed: n };
}

export function restoreStatus(db: DatabaseSync, rows: StatusSnapshot[]): { restored: number; fixed: number } {
  let restored = 0;
  let fixed = 0;
  db.exec('begin');
  try {
    const up = db.prepare(
      `update reading_state
          set status = ?, finished_at = ?, percent = ?, reread_count = ?,
              drop_reason = ?, chapter_idx = ?, char_offset = ?
        where book_id = ?`,
    );
    for (const raw of rows) {
      const { row: r, fixed: f } = sanitizeSnapshot(raw);
      fixed += f;
      /*
       * **数 `changes`，不是数「试了几次」。** 那本书可能在这中间没了
       * （「重复的书」的「只留这一份」、「整理数据库」都会删记录），
       * 那时这句 UPDATE 一行都不改，而无条件 `++` 会让撤销报告说
       * 「已经改回 8 本」——**报告和库不是一回事，是最糟的那种失败**。
       * 同 `backup.ts` 恢复那处（那次是先 `++` 再 UPDATE），
       * 以及本仓库那条「`insert or ignore` 后面不许跟无条件 `++`」。
       */
      restored += up.run(r.from, r.finishedAt, r.percent, r.rereadCount,
        r.dropReason, r.chapterIdx, r.charOffset, r.bookId).changes as number;
    }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return { restored, fixed };
}

export function setStatus(db: DatabaseSync, bookId: number, patch: StatusPatch): void {
  const cur = db
    .prepare('select status, reread_count, rating, comment, drop_reason from reading_state where book_id = ?')
    .get(bookId) as
    | {
      status: string; reread_count: number; rating: number | null;
      comment: string | null; drop_reason: string | null;
    }
    | undefined;
  if (!cur) {
    /*
     * **说的要是真正那一样。** 这句原来只写「没有阅读状态记录」——听着像少了一行、
     * 补一行就好，而十有八九是**这本书根本不存在**（§13 明说外部调用方最容易错的
     * 就是 id）。`setStatusByFilter` 那头已经为「书在、行不在」补过
     * `insert or ignore`，所以走到这里基本只剩「书不在」这一种。
     * 同 `reader.ts` 的 `openHint`：**「说了怎么办」才是判据**。
     */
    const 有这本书 = db.prepare('select 1 from book where id = ?').get(bookId) !== undefined;
    throw new Error(
      有这本书
        ? `书 ${bookId} 还没有阅读状态那一行。先调一次 reading.setStatus 之外的写入，或者重新扫描一次让它补上。`
        : `没有 id 为 ${bookId} 的书。先用 book.list 或 search.meta 查一下真正的 id。`,
    );
  }

  /*
   * **认不出的字段名一律抛错。**
   *
   * 量出来的：`raiting`（拼错）、`comments`（多个 s）、`reason`（应该叫 dropReason）、
   * `drop_reason`（照着库里的列名写的）、`state`（应该叫 status）——
   * 五种写法**全部静默成功**，`reading.setStatus` 返回 `{ ok: true }`，
   * 而库里一个字都没变。这正是 `tag.delete` 那次事故的形状
   * （参数名写错 → 一行都没改 → 照样报成功），而 §13 明说
   * **外部调用方最容易错的就是参数名**。
   *
   * `drop_reason` 那个尤其容易踩：本文件教人「schema 直接问库」，
   * 而库里的列名就是 snake_case。
   *
   * 判据抄 `buildFilter` 那条（不认识的键当场抛），连报错都同一个形状：
   * 把认得的名字列出来。**空 patch 不算错**——那是「什么都不改」，不是拼错。
   */
  for (const key of Object.keys(patch)) {
    if (!(PATCH_KEYS as string[]).includes(key)) {
      throw new Error(`不认识的字段：${key}。能改的是 ${PATCH_KEYS.join(' / ')}`);
    }
  }

  if (patch.status !== undefined && !READING_STATUS_IDS.includes(patch.status)) {
    throw new Error(`不认识的阅读状态：${patch.status}`);
  }
  /*
   * **范围对了不等于是个数。** 原来只比大小，而 `NaN < 0` 和 `NaN > 5` 都是 false——
   * 于是 `rating: NaN` 一路走到 `node:sqlite`，被**静默绑成 NULL**
   * （本文件别处记着这条：insert … values(NaN) 存进去是 null，不报错不警告）。
   * 也就是说一次参数写错**把这本书的评分清掉了**，还返回成功。
   * 那是铁律 3 的数据，重扫恢复不了。同 `rpc.ts` 的 `numOpt` 那条，只是这次
   * 漏在核心这一层——rpc 的 `reading.setStatus` 是把整个 patch 原样传下来的。
   *
   * 字符串同理：`'abc' < 0` 也是 false，而 rating 那一列是 REAL，
   * 存不进去就按 TEXT 存着，卡片上于是出现「★abc」。
   */
  if (
    patch.rating != null
    && (typeof patch.rating !== 'number' || !Number.isFinite(patch.rating)
        || patch.rating < 0 || patch.rating > 5)
  ) {
    throw new Error(`评分要是 0–5 之间的数字，收到的是 ${JSON.stringify(patch.rating)}`);
  }
  /*
   * 短评和弃坑原因必须是字符串。`comment: 12345` 原来会存成 `"12345.0"`
   * （TEXT 那一列拿到一个 double，自己转了一道），显示出来就是这么一行怪东西。
   * 清空用 `null`，那条路照旧。
   */
  for (const key of ['comment', 'dropReason'] as const) {
    const v = patch[key];
    if (v != null && typeof v !== 'string') {
      throw new Error(`${key} 要是一段文字或者 null，收到的是 ${JSON.stringify(v)}`);
    }
  }

  /*
   * **前后空白去掉，只剩空白的当作没写。**
   *
   * 量出来的：`comment: '   '`（或者只有换行、或者一个全角空格）原来会原样存进去，
   * 于是那本书**算「评价过」、`rated_at` 被写上、卡片上多一行空的短评**，
   * 而且从「读过没评价」那个待办里消失了——**一个手滑的空格就把待办清掉了，
   * 而屏幕上什么都没写**。
   *
   * `String.trim()` 认全角空格（U+3000）和换行，不用自己写字符类。
   * 放在这里而不是界面里：rpc 对外开放（§13），而所有写路径都从这儿过。
   */
  const patch2: StatusPatch = { ...patch };
  for (const key of ['comment', 'dropReason'] as const) {
    const v = patch2[key];
    if (typeof v === 'string') patch2[key] = v.trim() || null;
  }
  patch = patch2;

  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  /** 折进短评的那句弃坑原因（没折就是 undefined）。`rated_at` 要认它 */
  let folded: string | undefined;

  if (patch.status !== undefined) {
    sets.push('status = ?');
    args.push(patch.status);

    if (patch.status === 'finished') {
      sets.push("finished_at = datetime('now')", 'percent = 100');
    } else if (cur.status === 'finished') {
      // 离开「已读完」要把那两个被强行写死的派生字段还原，否则记录自相矛盾：
      // 「状态是想读、却有读完时间、进度条还满格」。统计和导出都会照单全收。
      // **chapter_idx 一个字都不动**——那是铁律 3 里重扫恢复不了的数据，
      // 只有明确的「重读」才允许清零（见下面那条分支）
      sets.push('finished_at = null');
      sets.push(
        `percent = case when (select count(*) from chapter c join book_file f on f.id = c.file_id
                              where f.book_id = reading_state.book_id and f.is_primary = 1) > 0
                   then min(100.0, (chapter_idx + 1) * 100.0 /
                        (select count(*) from chapter c join book_file f on f.id = c.file_id
                          where f.book_id = reading_state.book_id and f.is_primary = 1))
                   else 0 end`,
      );
    }
    // 读完之后又从头开始 → 记一次重读。**`keepProgress` 是「我只是标错了」那条路**，
    // 理由写在 `StatusPatch.keepProgress` 上
    if (cur.status === 'finished' && patch.status === 'reading' && !patch.keepProgress) {
      sets.push('reread_count = ?', 'chapter_idx = 0', 'char_offset = 0', 'percent = 0');
      args.push(cur.reread_count + 1);
    }
    /*
     * 弃坑之外的状态不该留着弃坑原因（卡片上那一行会变成一句假话：
     * 一本「已读完」的书挂着「弃坑原因：烂尾了」）。
     *
     * **但那句话是用户打的字，不能就这么没了。** 实测过：标弃坑写了原因，
     * 后来改成「已读完」，那句话当场消失，再标回弃坑也补不回来。
     * 而它和短评本来就是同一类东西——**卡片上它们共用同一行**
     * （`.book-note`，弃坑原因还排在短评前面）。
     *
     * 所以离开弃坑时把它折进短评，而不是丢掉：
     *   - 短评是空的 → 直接搬过去；
     *   - 短评已经有话 → 换行拼上（判据抄 `mergeBooks`：
     *     「短评两边都有就换行拼起来，不是二选一——那是用户自己写的字」）。
     */
    if (patch.status !== 'dropped' && patch.dropReason === undefined) {
      sets.push('drop_reason = null');
      const reason = (cur.drop_reason ?? '').trim();
      if (reason && patch.comment === undefined) {
        const kept = (cur.comment ?? '').trim();
        sets.push('comment = ?');
        folded = kept ? `${kept}
${reason}` : reason;
        args.push(folded);
      }
    }
  }
  if (patch.rating !== undefined) {
    sets.push('rating = ?');
    args.push(patch.rating);
  }
  if (patch.comment !== undefined) {
    sets.push('comment = ?');
    args.push(patch.comment);
  }
  // 评价时间跟着星级和短评走，「我的书评」按它排序。
  //
  // **两边都清空时要一起清掉**：只写不还原的派生字段会在几个月后以
  // 「这本没评价过，怎么排在最近评价的最前面」的形式冒出来——`setStatus` 在
  // finished_at 上踩过完全一样的坑，注释就在上面几行
  if (patch.rating !== undefined || patch.comment !== undefined || folded !== undefined) {
    const nextRating = patch.rating !== undefined ? patch.rating : cur.rating;
    // 折进来的那句话也算「短评有内容」——不然它会被判成空，
    // `rated_at` 当场清成 null，而「我的书评」正是按它排序的
    const nextComment = patch.comment !== undefined ? patch.comment : (folded ?? cur.comment);
    const empty = nextRating == null && !nextComment;
    sets.push(empty ? 'rated_at = null' : "rated_at = datetime('now')");
  }
  if (patch.dropReason !== undefined) {
    sets.push('drop_reason = ?');
    args.push(patch.dropReason);
  }

  if (sets.length === 0) return;
  db.prepare(`update reading_state set ${sets.join(', ')} where book_id = ?`).run(...args, bookId);
}

export interface Bookmark {
  id: number;
  book_id: number;
  chapter_idx: number;
  char_offset: number;
  excerpt: string | null;
  note: string | null;
  created_at: string;
}

/** 书签独立于阅读进度（spec §5.1）：加书签不会改变「读到哪儿了」 */
/**
 * 给一条书签写/改笔记。
 *
 * ⚠️ **这一列原来写不进去。** `bookmark` 有 `note`、`bookmark.add` 收得下、
 * 面板也**会显示**它——可全应用没有一个地方写得进去，那个显示分支是死代码。
 * 「记一句为什么标这儿」正是书签比进度多出来的那点价值。
 *
 * ⚠️ **id 不存在要报错**：一句 `update` 影响 0 行照样是「成功」，
 * 判据同 `highlight.ts` 的 `setColor`（都是 `tag.delete` 那次事故的形状）。
 */
export function setBookmarkNote(db: DatabaseSync, id: number, note: string | null): void {
  // 只有空白的当作没写，同 `highlight.ts` 的 `updateNote`——都是用户打的字
  const r = db.prepare('update bookmark set note = ? where id = ?').run(note?.trim() || null, id);
  if (Number(r.changes) === 0) throw new Error(`没有这条书签：${id}`);
}

export function addBookmark(
  db: DatabaseSync,
  bookId: number,
  chapterIdx: number,
  opts: { charOffset?: number; excerpt?: string; note?: string } = {},
): { id: number } {
  const id = Number(
    db
      .prepare(
        'insert into bookmark(book_id, chapter_idx, char_offset, excerpt, note) values(?,?,?,?,?)',
      )
      // 笔记只有空白的当作没写，同 `highlight.ts` 的 `updateNote`——都是用户打的字
      .run(bookId, chapterIdx, opts.charOffset ?? 0, opts.excerpt ?? null, opts.note?.trim() || null)
      .lastInsertRowid,
  );
  return { id };
}

export function listBookmarks(db: DatabaseSync, bookId?: number): Bookmark[] {
  return (
    bookId === undefined
      ? db.prepare('select * from bookmark order by book_id, chapter_idx, char_offset').all()
      : db
          .prepare('select * from bookmark where book_id = ? order by chapter_idx, char_offset')
          .all(bookId)
  ) as unknown as Bookmark[];
}

/*
 * 同 `highlight.ts` 的 `removeHighlight`：**带笔记的书签删之前要确认一次**，
 * 判据、理由、那句话都共用一份（`noteGuard`）。
 *
 * 这里还多一条界面上的路：阅读器里按 **B** 是「这一章有书签就撤掉」，
 * 而撤掉走的就是这个函数——**一个快捷键无声删掉一段笔记**，
 * 屏幕上连它写的什么都不显示。现在按 B 撤不掉带笔记的，改为照实说去哪儿删。
 */
export function removeBookmark(
  db: DatabaseSync,
  id: number,
  opts: { confirmed?: boolean } = {},
): { removed: number } {
  const row = db.prepare('select note from bookmark where id = ?').get(id) as
    | { note: string | null }
    | undefined;
  if (!row) return { removed: 0 };
  const note = (row.note ?? '').trim();
  if (note && !opts.confirmed) throw new Error(noteGuard('书签', note));
  return { removed: db.prepare('delete from bookmark where id = ?').run(id).changes as number };
}

/**
 * 开始一次阅读会话（spec §5.2）。返回会话 id，结束时用它回填。
 * 只记「书、起止时间、起止进度」——spec §14 明确不做阅读时长统计报告，
 * 这些数据是给「最近在读」用的，不是给年度总结用的。
 */
export function startSession(db: DatabaseSync, bookId: number): { id: number } {
  const percent =
    (db.prepare('select percent from reading_state where book_id = ?').get(bookId) as
      | { percent: number }
      | undefined)?.percent ?? 0;

  const id = Number(
    db
      .prepare(
        "insert into reading_session(book_id, started_at, from_percent) values(?, datetime('now'), ?)",
      )
      .run(bookId, percent).lastInsertRowid,
  );
  return { id };
}

/*
 * **把没关上的会话收掉。**
 *
 * 会话是「开阅读器 `session.start`、卸载时 `session.end`」——而**应用直接退出时
 * React 的 cleanup 根本不跑**。真实库上量的：30 条会话里 **13 条（43%）**
 * `ended_at` 和 `to_percent` 都是 null，那条记录等于什么都没记，
 * 而它还跟着备份走。
 *
 * 两种情形分开，因为**我们知道的东西不一样**：
 *
 * - `quit`：主进程的 `before-quit`，**就是现在结束的**。进度取这本书当前的
 *   `percent`——那是 `saveProgress` 一路写着的，是事实。
 * - `crash`：开机时发现还有没关的，说明上次是被杀掉/崩了。**不知道什么时候结束的**，
 *   就用「最后一次知道他在读」那个时刻（`last_read_at`），进度保守地当作没推进。
 *   **宁可少记，别编一个数**——同本文件那条「旧备份没有这个字段就留 null，
 *   不知道就说不知道」。
 *
 * `where ended_at is null` 让它天然幂等：渲染进程那头的 `session.end` 先跑也不冲突。
 */
export function closeOpenSessions(db: DatabaseSync, when: 'quit' | 'crash'): { closed: number } {
  const sql = when === 'quit'
    ? `update reading_session
          set ended_at = datetime('now'),
              to_percent = (select percent from reading_state where book_id = reading_session.book_id)
        where ended_at is null`
    : `update reading_session
          set ended_at = coalesce(
                (select last_read_at from reading_state where book_id = reading_session.book_id),
                started_at),
              to_percent = from_percent
        where ended_at is null`;
  return { closed: db.prepare(sql).run().changes as number };
}

export function endSession(db: DatabaseSync, sessionId: number): void {
  const s = db.prepare('select book_id from reading_session where id = ?').get(sessionId) as
    | { book_id: number }
    | undefined;
  if (!s) return;

  const percent =
    (db.prepare('select percent from reading_state where book_id = ?').get(s.book_id) as
      | { percent: number }
      | undefined)?.percent ?? 0;

  db.prepare(
    "update reading_session set ended_at = datetime('now'), to_percent = ? where id = ? and ended_at is null",
  ).run(percent, sessionId);
}

/** 「最近在读」列表（spec §5.2） */
export function recentBooks(db: DatabaseSync, limit = 10): unknown[] {
  return db
    .prepare(
      `select b.id as bookId, b.title, b.author, r.status, r.percent,
              r.chapter_idx as chapterIdx, r.last_read_at as lastReadAt
         from reading_state r join book b on b.id = r.book_id
        where r.last_read_at is not null
        order by r.last_read_at desc limit ?`,
    )
    .all(limit);
}
