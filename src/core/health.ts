// 章节切分体检（纯 SQL，**不读一个字节的正文**）。
//
// 起因：内置规则改好了，而库里的书还是当初扫描时算出来的旧结果——
// 重新解析要用户自己一本本去点，而他根本无从知道哪几本该点。
//
// **判据只用已经存进库的数据**（`chapter.length` 和 `chapter.title`），
// 所以不用读一个字节的正文；真正读文件只发生在用户挑中要重解析的那几本上。
//
// ⚠️ **必须分块、异步、块间让出事件循环。** 它原来就是下面两条查询各扫一遍
// 章节表（真实库 7537 候选 / 660 万章实测 4.4 秒），而且是**一条同步 RPC**——
// 主进程这 4–5 秒里不回任何别的请求：扫描完成通知刚弹出来，体检立刻开跑，
// 用户点「去处理」的那串切换 RPC 全部排队，界面像死机（2026-09-14 实测：
// 体检在飞时，毫秒级的 stats 请求实等 5.0 秒）。
// 拆成 100 本一块之后：**总耗时反而降到 1.9 秒**（IN 列表让规划器走
// book → idx_book_file_book → idx_chapter_file 的索引嵌套循环，不必全表扫），
// 单块最长 56ms，块间 `setImmediate`，前台 RPC 最多等一个块、无感。
// 同 `scan.ts` 那条「每本书之间有 await，事件循环有喘息」的取舍：不挪线程，
// 但绝不在一条同步调用里扫完整张章节表。

import type { DatabaseSync } from 'node:sqlite';
// **从 chapter.ts 引，不要在这里再写一个 200。** 这个体检全部的意义是
// 「解析器现在会拒绝的切法，库里还留着」——两边的阈值一旦分家，
// 它就会去唠叨解析器已经接受的书，或者漏掉它现在会拒绝的书，而且不报错。
import { MIN_MEDIAN_CHAPTER_BYTES } from './chapter.ts';

/** 一块查多少本：真实库实测单块 ≤56ms。块越小让路越勤、总往返越多 */
const SPLIT_CHECK_CHUNK = 100;


export interface SplitIssue {
  bookId: number;
  title: string;
  chapterCount: number;
  /** 这本书是哪一类问题 */
  kind: 'tiny' | 'repeated';
  /** 说给人听的一句话 */
  detail: string;
}

export interface SuspiciousOptions {
  /** 注入每块之后的让出动作（测试用它数让路次数）。默认 setImmediate */
  yield?: () => void | Promise<void>;
  /** 一块几本（测试用 1 强制跨块） */
  chunkSize?: number;
}

/**
 * 候选书：有 primary + ok + 未屏蔽文件的。体检的三档过滤全在这一层和 SQL 里：
 *   - `excluded`：用户明确说了不要收的书（库里 759 条）。报出来 = 让他去
 *     重解析一本书架上根本看不到的书。
 *   - `status = 'ok'`：文件已经不在了的书，重解析会把 `missing` 改写成
 *     `parse_failed`，而 `library.repair` 和「需要处理」那一档正是靠
 *     `missing` 认出它们的——**把唯一的信号擦掉了**。
 *   - 一本书理论上可能有两个 is_primary 的文件（几处「提升为主文件」的路径
 *     没有先清掉旧的），所以下面都 `group by b.id`，同一本不会报两遍。
 */
function eligibleBookIds(db: DatabaseSync): number[] {
  return (db
    .prepare(
      `select b.id as id
         from book b
         join book_file f on f.book_id = b.id
        where f.is_primary = 1 and f.status = 'ok' and ifnull(f.excluded, 0) = 0
        order by b.id`,
    )
    .all() as Array<{ id: number }>).map((r) => r.id);
}

/** 第 1 类：大半的章只有几十字节（正文里的选项列表被当成了标题） */
function scanTinyChunk(db: DatabaseSync, ids: number[]): Array<{
  bookId: number; title: string; chapterCount: number; small: number;
}> {
  const slots = ids.map(() => '?').join(',');
  return db
    .prepare(
      `select b.id as bookId, b.title, count(*) as chapterCount,
              sum(case when c.length < ? then 1 else 0 end) as small
         from chapter c
         join book_file f on f.id = c.file_id
         join book b on b.id = f.book_id
        where f.is_primary = 1 and f.status = 'ok' and ifnull(f.excluded, 0) = 0
          and b.id in (${slots})
        group by b.id
       having chapterCount >= 5 and small * 2 > chapterCount
        order by small desc`,
    )
    // 阈值参数在 IN 占位符**前面**（按 SQL 文本顺序绑定）
    .all(MIN_MEDIAN_CHAPTER_BYTES, ...ids) as Array<{
      bookId: number; title: string; chapterCount: number; small: number;
    }>;
}

/** 第 2 类：标题行在文件里写了两遍，前一章是几十字节的空壳 */
function scanRepeatedChunk(db: DatabaseSync, ids: number[]): Array<{
  bookId: number; title: string; chapterCount: number; dups: number;
}> {
  const slots = ids.map(() => '?').join(',');
  return db
    .prepare(
      `select b.id as bookId, b.title, f.chapter_count as chapterCount, count(*) as dups
         from chapter c
         join chapter p on p.file_id = c.file_id and p.idx = c.idx - 1
         join book_file f on f.id = c.file_id
         join book b on b.id = f.book_id
        where f.is_primary = 1 and f.status = 'ok' and ifnull(f.excluded, 0) = 0
          and c.title = p.title and p.length < ?
          and b.id in (${slots})
        group by b.id
       having dups >= 3 and dups * 10 > f.chapter_count
        order by dups desc`,
    )
    .all(MIN_MEDIAN_CHAPTER_BYTES, ...ids) as Array<{
      bookId: number; title: string; chapterCount: number; dups: number;
    }>;
}

/**
 * 切得可疑的书。两类，都是在真实库上撞见之后才写进来的：
 *
 * 1. **`tiny`——大半的章只有几十字节。** 正文里的选项列表、条目清单被当成了
 *    标题。《路明非挑战FGO》270 万字切出 1949 章，其中 1489 章短于 200 字节。
 * 2. **`repeated`——标题行写了两遍。** 目录里每个标题出现两次，
 *    点开前一个是二三十字节的空壳。《火红年代》597 章里 291 处这样。
 * 两条都**只看库里的数据**，不读正文。
 *
 * 这是**异步**的：按 `chunkSize` 分批，每批之后让出事件循环（默认
 * `setImmediate`），所以它在主进程上跑着的时候，前台 IPC 最长只等一个块
 * （真实库 ≤56ms）。判据的 SQL 一条都没变，只是执行方式从「一条全表查询」
 * 改成「按候选书 id 分批」——见文件头的实测数。
 */
export async function suspiciousSplits(
  db: DatabaseSync,
  opts: SuspiciousOptions = {},
): Promise<SplitIssue[]> {
  const wait = opts.yield ?? (() => new Promise<void>((r) => setImmediate(r)));
  const chunkSize = opts.chunkSize ?? SPLIT_CHECK_CHUNK;
  const ids = eligibleBookIds(db);

  type TinyRow = { bookId: number; title: string; chapterCount: number; small: number };
  type RepRow = { bookId: number; title: string; chapterCount: number; dups: number };
  const tinyHits: TinyRow[] = [];
  const repRaw: RepRow[] = [];

  for (let i = 0; i < ids.length; i += chunkSize) {
    const part = ids.slice(i, i + chunkSize);
    tinyHits.push(...scanTinyChunk(db, part));
    repRaw.push(...scanRepeatedChunk(db, part));
    // 最后一块之后不用再让：调用方马上就要拿结果
    if (i + chunkSize < ids.length) await wait();
  }

  // 同一本书两类都中时只报前一类：**报两条只会让人以为有两个问题**，
  // 重新解析一次就都处理了。必须用**全部分块**收齐后的 tiny 集合去重——
  // 按块边收边去的话，后一块才中 tiny 的书会带着前一块收到的 repeated 漏过来
  const tinyIds = new Set(tinyHits.map((r) => r.bookId));
  const repHits = repRaw.filter((r) => !tinyIds.has(r.bookId));

  // 界面只展开前 4 本，**最严重的排前面**（原一条查询里的 order by）：
  // 分块只切执行方式，不切呈现顺序
  tinyHits.sort((a, b) => b.small - a.small);
  repHits.sort((a, b) => b.dups - a.dups);

  const out: SplitIssue[] = [
    ...tinyHits.map((r) => ({
      bookId: r.bookId,
      title: r.title,
      chapterCount: r.chapterCount,
      kind: 'tiny' as const,
      detail: `${r.chapterCount} 章里有 ${r.small} 章不到 200 字节——多半是把正文里的列表当成了标题`,
    })),
    ...repHits.map((r) => ({
      bookId: r.bookId,
      title: r.title,
      chapterCount: r.chapterCount,
      kind: 'repeated' as const,
      detail: `有 ${r.dups} 处标题重复了一遍——目录里同一个标题出现两次，点开前一个是空的`,
    })),
  ];

  /*
   * 门槛除了绝对条数还要看**占比**（在 SQL 的 having 里）：一本 5000 章的书里
   * 3 处同名短章（番外、「（一）（二）」这种碎片、三部曲合成一个文件）是正常的，
   * 和《火红年代》597 章里 291 处不是一回事。10% 是照着那个形状定的。
   */
  return out;
}
