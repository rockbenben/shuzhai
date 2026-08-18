// 章节切分体检（纯 SQL，**不读一个字节的正文**）。
//
// 起因：内置规则改好了，而库里的书还是当初扫描时算出来的旧结果——
// 重新解析要用户自己一本本去点，而他根本无从知道哪几本该点。
//
// **判据只用已经存进库的数据**（`chapter.length` 和 `chapter.title`），
// 所以不用读一个字节的正文；真正读文件只发生在用户挑中要重解析的那几本上。
//
// 拿真实书库（8172 本 / 658 万章）量过：两条查询加起来 **5.6 秒**。
// 这是主进程上的同步活，会卡住那几秒——之所以可以接受，是因为它只在
// 「扫描完成」之后跑一次，而那次扫描本身要一两分钟。**别把它挪到别处**
// （比如 `buildFilter`）：侧栏每个档位的计数都走那儿，5.6 秒会乘上八档。

import type { DatabaseSync } from 'node:sqlite';
// **从 chapter.ts 引，不要在这里再写一个 200。** 这个体检全部的意义是
// 「解析器现在会拒绝的切法，库里还留着」——两边的阈值一旦分家，
// 它就会去唠叨解析器已经接受的书，或者漏掉它现在会拒绝的书，而且不报错。
import { MIN_MEDIAN_CHAPTER_BYTES } from './chapter.ts';


export interface SplitIssue {
  bookId: number;
  title: string;
  chapterCount: number;
  /** 这本书是哪一类问题 */
  kind: 'tiny' | 'repeated';
  /** 说给人听的一句话 */
  detail: string;
}

/**
 * 切得可疑的书。两类，都是在真实书库上撞见之后才写进来的：
 *
 * 1. **`tiny`——大半的章只有几十字节。** 正文里的选项列表、条目清单被当成了
 *    标题。《路明非挑战FGO》270 万字切出 1949 章，其中 1489 章短于 200 字节。
 * 2. **`repeated`——标题行在文件里写了两遍。** 目录里每个标题出现两次，
 *    点开前一个是二三十字节的空壳。《火红年代》597 章里 291 处这样。
 * 两条都**只看库里的数据**，不读正文。
 */
export function suspiciousSplits(db: DatabaseSync): SplitIssue[] {
  const tiny = db
    .prepare(
      /*
       * 三处判据之外的过滤，每一条都是别处已经在做的：
       *   - `excluded`：用户明确说了不要收的书（库里 759 条）。报出来 = 让他去
       *     重解析一本书架上根本看不到的书。`scan.ts` 和 `library.ts` 都滤这个。
       *   - `status = 'ok'`：文件已经不在了的书，重解析会把 `missing` 改写成
       *     `parse_failed`，而 `library.repair` 和「需要处理」那一档正是靠
       *     `missing` 认出它们的——**把唯一的信号擦掉了**。
       *   - 章数用 `count(*)` 而不是 `f.chapter_count`：那一列是去规范化的，
       *     两边对不上时这个比例就悄悄失效（实测把它写成 100 而实际 10 章，
       *     整本书从报告里消失），而且它可空，`null >= 5` 是 null。
       *     反正这条查询已经在扫这本书的每一行章节了，`count(*)` 不要钱。
       *   - `group by b.id`：一本书理论上可能有两个 is_primary 的文件
       *     （几处「提升为主文件」的路径没有先清掉旧的），那样会报两遍、
       *     也会把同一个 id 送去重解析两次。
       */
      `select b.id as bookId, b.title, count(*) as chapterCount,
              sum(case when c.length < ? then 1 else 0 end) as small
         from chapter c
         join book_file f on f.id = c.file_id
         join book b on b.id = f.book_id
        where f.is_primary = 1 and f.status = 'ok' and ifnull(f.excluded, 0) = 0
        group by b.id
       having chapterCount >= 5 and small * 2 > chapterCount
        order by small desc`,
    )
    .all(MIN_MEDIAN_CHAPTER_BYTES) as unknown as Array<{
      bookId: number; title: string; chapterCount: number; small: number;
    }>;

  const repeated = db
    .prepare(
      /* 门槛除了绝对条数还要看**占比**：一本 5000 章的书里 3 处同名短章
         （番外、「（一）（二）」这种碎片、三部曲合成一个文件）是正常的，
         和《火红年代》597 章里 291 处不是一回事。10% 是照着那个形状定的。 */
      `select b.id as bookId, b.title, f.chapter_count as chapterCount, count(*) as dups
         from chapter c
         join chapter p on p.file_id = c.file_id and p.idx = c.idx - 1
         join book_file f on f.id = c.file_id
         join book b on b.id = f.book_id
        where f.is_primary = 1 and f.status = 'ok' and ifnull(f.excluded, 0) = 0
          and c.title = p.title and p.length < ?
        group by b.id
       having dups >= 3 and dups * 10 > f.chapter_count
        order by dups desc`,
    )
    .all(MIN_MEDIAN_CHAPTER_BYTES) as unknown as Array<{
      bookId: number; title: string; chapterCount: number; dups: number;
    }>;

  const out: SplitIssue[] = tiny.map((r) => ({
    bookId: r.bookId,
    title: r.title,
    chapterCount: r.chapterCount,
    kind: 'tiny' as const,
    detail: `${r.chapterCount} 章里有 ${r.small} 章不到 200 字节——多半是把正文里的列表当成了标题`,
  }));

  // 同一本书两类都中时只报前一类：**报两条只会让人以为有两个问题**，
  // 而重新解析一次就都处理了
  const seen = new Set(out.map((x) => x.bookId));
  for (const r of repeated) {
    if (seen.has(r.bookId)) continue;
    out.push({
      bookId: r.bookId,
      title: r.title,
      chapterCount: r.chapterCount,
      kind: 'repeated',
      detail: `有 ${r.dups} 处标题重复了一遍——目录里同一个标题出现两次，点开前一个是空的`,
    });
  }
  return out;
}
