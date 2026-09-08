// 封面抓取的队列部分（设计：docs/superpowers/specs/2026-08-13-covers-and-notes-design.md）。
//
// 站点解析（候选提取、匹配、探针、校验源）已经搬到 `site-adapters.ts`——
// 封面链和更新检查共用同一份规则，不再各抄一份。
//
// 这个文件**禁止 import electron**——队列 SQL 是纯函数，`node:test` 直接跑。
// 唯一碰 Electron 的是 src/main/cover-fetcher.ts。

import type { DatabaseSync } from 'node:sqlite';

// 队列就是一条 SQL，没有游标要维护：关掉应用再打开，这条查询自然接着上次的
// 位置。**没有「进度」这个状态要存，也就没有它和现实脱节的可能。**

/**
 * 入队条件：没有 verdict 行（cover_fetch）且满足下面之一——
 *   - 还没封面；
 *   - 有在线地址但没简介（只读那一页补信息，不搜索）。
 *
 * nextPending（取下一本）和 fetchStats.pending（「剩余 N 本」）**共用这一份**：
 * 抄两份的话改条件时漏一处，界面上的剩余数就和实际会抓的对不上（这条件本轮刚
 * 从「没封面」改成现在这版，两处都得动）。
 */
const PENDING_FROM_WHERE = `
  from book b
  left join cover_fetch cf on cf.book_id = b.id
 where cf.book_id is null
   and (b.cover_path is null
        or (b.intro is null
            and exists (select 1 from online_link l where l.book_id = b.id)))`;

export function nextPending(
  db: DatabaseSync,
): { id: number; title: string; author: string | null } | null {
  return (
    (db
      .prepare(
        `select b.id, b.title, b.author ${PENDING_FROM_WHERE} order by b.id limit 1`,
      )
      .get() as { id: number; title: string; author: string | null } | undefined) ?? null
  );
}

export function recordResult(
  db: DatabaseSync,
  bookId: number,
  status: 'ok' | 'nomatch' | 'failed',
  source?: string,
  error?: string,
): void {
  db.prepare(
    `insert into cover_fetch(book_id, status, source, error, tried_at)
     values(?,?,?,?,datetime('now'))
     on conflict(book_id) do update set
       status = excluded.status, source = excluded.source,
       error = excluded.error, tried_at = excluded.tried_at`,
  ).run(bookId, status, source ?? null, error ?? null);
}

/**
 * 单本联网补全（rpc `cover.fetchOne`）的返回。**类型放 core 给渲染进程
 * `import type`**：两个调用方（BookEditor 的「联网补全」、LinksDialog 详情页
 * 失败后按书名搜源那段）各手写一份就会分叉（一个写 `status: string`、一个写
 * 字面量联合、applied 字段还会漏掉一个），dup-decls.mjs 守着这件事。
 */
export interface FetchOneResult {
  status: 'ok' | 'nomatch';
  source?: string;
  applied?: string[];
  /** status=nomatch 时可能带着的实话：探针发现不是「没有这本书」而是站点限流 */
  note?: string;
}

export function fetchStats(db: DatabaseSync): {
  pending: number;
  done: number;
  nomatch: number;
  failed: number;
} {
  const row = db
    .prepare(
      `select
         (select count(*) ${PENDING_FROM_WHERE}) as pending,
         (select count(*) from cover_fetch where status = 'ok') as done,
         (select count(*) from cover_fetch where status = 'nomatch') as nomatch,
         (select count(*) from cover_fetch where status = 'failed') as failed`,
    )
    .get() as { pending: number; done: number; nomatch: number; failed: number };
  return { ...row };
}

/**
 * 「重试没匹配上的」：删掉 nomatch 行，队列 SQL 自然把它们重新纳入。ok 和 failed 不动。
 *
 * **不带上 failed，是因为这两个结论的可信度差着量级**（实测）：
 * `nomatch` 是问过了、站上真没有——随机抽 10 本重试，命中 **0/10**；
 * 其中《南宋第一卧底》直接开浏览器看过起点搜索页，返回的是「南宋第一密探」
 * 「南宋第一衙内」这类模糊相关，那本书根本不在起点。
 * 而 `failed` 是**没问出来**（限流、断网），下一轮就该重试。
 *
 * 捆在一起的代价是实打实的：这个库里点一次要发 167 次请求，其中 136 次注定白打——
 * 而正是这种白打的连发触发限流，制造出剩下那 31 条 failed。
 */
export function resetMisses(db: DatabaseSync): number {
  return Number(db.prepare("delete from cover_fetch where status = 'nomatch'").run().changes);
}

/**
 * failed 行清回队列。`start()` 每次叫一次——**「没问出来」不该是终态**。
 *
 * `nextPending` 只看「有没有 cover_fetch 行」，不看状态。所以限流那几分钟里
 * 被记成 failed 的书会永久停在队列外，而唯一的出路（上面那个按钮）还捆着
 * 一百多次注定白打的 nomatch 重试。
 *
 * 不会变成死循环：只在 `start()` 清，一次应用启动最多重试一轮；真的每次都抛错的书
 * 由 `MAX_CONSECUTIVE_FAILS` 那条自动暂停兜住。
 */
export function resetFailed(db: DatabaseSync): number {
  return Number(db.prepare("delete from cover_fetch where status = 'failed'").run().changes);
}

/**
 * 指定这几本回队列。探针判定「刚才那一串结论是限流下拿到的」时用——
 * 见 `HEALTH_PROBE`。空数组直接返回，不要拼出 `in ()` 那种 SQL。
 */
export function dropResults(db: DatabaseSync, bookIds: number[]): number {
  if (bookIds.length === 0) return 0;
  return Number(
    db
      .prepare(`delete from cover_fetch where book_id in (${bookIds.map(() => '?').join(',')})`)
      .run(...bookIds).changes,
  );
}

/**
 * 老库一次性回填（「老配置用新流程重新补齐」）：删掉「有在线地址但没简介」的书的
 * verdict 行，让 `nextPending` 重新捞到它们、走「读已知地址补信息」那条路
 * （不搜索、不冒险，只发一次请求到已经记下的地址）。
 *
 * 只删 verdict 行，不碰任何铁律数据。**幂等由调用方的设置标记保证**
 * （`cover.infoBackfill`，在 cover-fetcher 的 start() 里）：处理完 verdict 行会
 * 重新落库、书就不再满足入队条件，所以这东西一生只跑一次，不会每次启动重打
 * 几百次请求。
 */
export function resetForInfoBackfill(db: DatabaseSync): number {
  return Number(
    db
      .prepare(
        `delete from cover_fetch where book_id in (
            select b.id from book b
             where b.intro is null
               and exists (select 1 from online_link l where l.book_id = b.id))`,
      )
      .run().changes,
  );
}
