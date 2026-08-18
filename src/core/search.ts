// 全库搜索与书内搜索（spec §7 / §6）。
//
// **trigram 分词器要求查询至少 3 个字符**（实测：「客栈」搜不到，「客栈里」能搜到）。
// 所以短查询一律回落到 LIKE——不这么做的话，用户搜两个字得到的「无结果」是句假话，
// 而他没有任何办法知道真正的原因是「你的词太短了」。
//
// 元数据搜索（书名/作者/标签）不需要索引，任何时候都能用；正文搜索需要先建索引。

import type { DatabaseSync } from 'node:sqlite';
import { ratedSql, likeArg } from './library.ts';
import { makeSnippet } from './snippet.ts';
import { getSetting, setSetting } from './db.ts';
import { readChapter, openBook, type FileCache } from './reader.ts';
import { splitLines } from './chapter.ts';
import { loadCleanRules } from './clean.ts';
import type { Encoding } from './encoding.ts';

/** trigram 能用的最短查询长度 */
export const MIN_TRIGRAM = 3;

const INDEXED_KEY = 'search.indexed';

/**
 * 有没有任何书建过索引。
 *
 * **原来这是个全库开关**，`buildIndex` 一次性把整个库灌进去。在实测的库上
 * 那是不可行的：**653 万章**，每一章都要开文件、按偏移读、解码、清洗，
 * 是几小时的活，索引本身也有好几 GB。而且全库正文搜索本来就是低频需求——
 * 找书按书名作者（`searchMeta`，永远可用），找句子通常是在**正在读的这一本**里。
 *
 * 现在按书建。这个函数保留给「能不能搜正文」的总判断用。
 */
export function isIndexed(db: DatabaseSync): boolean {
  if (getSetting(db, INDEXED_KEY) === '1') return true;
  return (db.prepare('select count(*) n from chapter_fts').get() as { n: number }).n > 0;
}

/** 哪些书建了索引，各有多少章。侧栏和搜索面板拿它显示范围 */
export function indexedBooks(db: DatabaseSync): Array<{ bookId: number; title: string; chapters: number }> {
  return db
    .prepare(
      `select f.book_id as bookId, b.title, count(*) as chapters
         from chapter_fts f join book b on b.id = f.book_id
        group by f.book_id, b.title order by b.title`,
    )
    .all() as unknown as Array<{ bookId: number; title: string; chapters: number }>;
}

export interface SearchHit {
  bookId: number;
  bookTitle: string;
  chapterIdx: number;
  chapterTitle: string;
  /** 命中处的上下文片段，命中词用 【】 包起来 */
  snippet: string;
}

// `makeSnippet` 搬去 `snippet.ts` 了——渲染进程也要用它，而这个文件带着 node:sqlite

/**
 * 建全文索引：把每一章的正文读出来灌进 FTS。
 * 这是**唯一**会把正文写进数据库的地方，spec §7 明确允许，但要求可关闭。
 */
/**
 * 清掉索引：给了书号就只清这几本，没给才全清。
 *
 * ⚠️ **「只清这几本」是判据不是优化。** 原来 `buildIndex` 无脑
 * `delete from chapter_fts`——「给第二本书建索引」会把第一本的悄悄删掉。
 *
 * `buildIndex` 和 `dropIndex` 原来各抄一份，而那句判据只写在前一份上面；
 * 抄本一分叉，`dropIndex` 就会变回「全清」而没人看得出来。
 */
function clearIndex(db: DatabaseSync, bookIds?: number[]): void {
  if (bookIds?.length) {
    const del = db.prepare('delete from chapter_fts where book_id = ?');
    for (const id of bookIds) del.run(id);
  } else {
    db.exec('delete from chapter_fts');
  }
}

export async function buildIndex(
  db: DatabaseSync,
  cache: FileCache,
  onProgress?: (done: number, total: number) => void,
  bookIds?: number[],
): Promise<{ chapters: number }> {
  // **不传 bookIds 就是全库**，但界面上不该给这个入口——653 万章要跑几小时。
  // 留着是为了小库和测试
  const scope = bookIds?.length
    ? `and f.book_id in (${bookIds.map(() => '?').join(',')})`
    : '';
  const chapters = db
    .prepare(
      `select f.book_id as bookId, c.idx as idx
         from chapter c join book_file f on f.id = c.file_id
        where f.is_primary = 1 and f.status = 'ok' ${scope}
        order by f.book_id, c.idx`,
    )
    .all(...(bookIds ?? [])) as unknown as Array<{ bookId: number; idx: number }>;

  clearIndex(db, bookIds);
  const insert = db.prepare('insert into chapter_fts(content, book_id, chapter_idx) values(?,?,?)');

  let done = 0;
  for (const c of chapters) {
    try {
      // 索引的是**清洗后**的正文：搜出来的片段要和阅读器里看到的一致，
      // 否则用户点进去会找不到刚才搜到的那句话
      const ch = await readChapter(db, cache, c.bookId, c.idx);
      insert.run(ch.text, c.bookId, c.idx);
    } catch {
      // 单章读失败不该让整次建索引中断
    }
    // ⚠️ 计数必须单独一行。写成 `onProgress?.(++done, …)` 的话，
    // **没传回调时整个调用表达式被跳过，连 ++done 都不会求值**，
    // 返回的章节数永远是 0。可选调用不是「只跳过调用」，是连参数一起跳。
    done++;
    onProgress?.(done, chapters.length);
  }

  setSetting(db, INDEXED_KEY, '1');
  return { chapters: done };
}

/** 删索引，省空间（spec §7 要求的开关）。不传就是全清 */
export function dropIndex(db: DatabaseSync, bookIds?: number[]): void {
  clearIndex(db, bookIds);
  if (!(db.prepare('select count(*) n from chapter_fts').get() as { n: number }).n) {
    setSetting(db, INDEXED_KEY, '0');
  }
}

/**
 * 用户输入 → FTS5 的查询串。
 *
 * ⚠️ **原来是把用户打的字原样塞进 `match ?`**，而 FTS5 有自己一套语法：
 * `-` 是列过滤、`:` 是列限定、`AND/OR/NOT/NEAR` 是操作符、`"` 必须配对、`%` 非法。
 * 实测（真应用、走 `search.fullText`，不是最小复现）：
 *
 * | 用户输入 | 屏幕上出现的 |
 * |---|---|
 * | `a-b` | `no such column: b` |
 * | `x:y` | `no such column: x` |
 * | `AND` | `fts5: syntax error near "AND"` |
 * | `100%` | `fts5: syntax error near "%"` |
 * | `价格闯关"`（单边引号） | `unterminated string` |
 *
 * 这几句英文原样出现在搜索框下面——而本仓库早有一条成文判据反对这件事
 * （`rpc.ts` 的 `humanize`：不许让实现细节进用户可见的报错）。
 * 最后一个例子不是瞎编的：测试库正文里就有「“价格闯关”」，
 * 从正文里复制一段、多带或少带一个引号就撞上。
 *
 * 现在一律**当短语搜**：整串包一层双引号，内部的 `"` 翻倍。
 * 判据是「所见即所搜」——**不开放 FTS5 语法**。
 * 真要支持 `AND / OR / NEAR`（MarginNote 手册把它们当公开语法写），
 * 那是 spec §7 的一次需求变更，得连用户说明一起做，不能靠「碰巧没转义」漏出去。
 */
export function ftsQuery(raw: string): string {
  return '"' + raw.trim().replace(/"/g, '""') + '"';
}

/** 书名 / 作者 / 别名 / 标签。不需要索引，永远可用 */
export function searchMeta(db: DatabaseSync, query: string): unknown[] {
  const like = likeArg(query);
  return db
    .prepare(
      `select b.id as bookId, b.title, b.author,
              -- **评分和短评要跟着结果走。** 这个应用的正事是「下次不用再想这本
              -- 我看过没」，而用户最常走的就是在这儿搜书名——卡片上兑现了那句
              -- 「烂尾了别看」，搜索结果里却看不到，等于在最该回答的地方不答。
              r.rating, r.comment,
              (select group_concat(t.name, ',') from book_tag bt
                 join tag t on t.id = bt.tag_id where bt.book_id = b.id) as tags,
              -- **这本有没有可搜的正文。** 搜索面板拿它决定能不能给这本书建索引：
              -- PDF / EPUB 是只编目的（章节表天生是空的），而一本没解析成功的 txt
              -- 同样建不出东西。判据写成「有没有章节」而不是「是不是 PDF」——
              -- 后者只盖住格式那一半，前者两半都盖住。
              (select ifnull(f.chapter_count, 0) from book_file f
                where f.book_id = b.id and f.is_primary = 1) as chapters
         from book b
         left join reading_state r on r.book_id = b.id
        where b.title like ? escape '\\' or ifnull(b.author,'') like ? escape '\\' or ifnull(b.aliases,'') like ? escape '\\'
           -- **自己写的那句话也要能搜到。** 这个应用存下来的最有用的东西就是
           -- 「烂尾了别看」这种话，而原来搜不到它：结果表里**显示**短评（上一轮加的），
           -- 却不按它匹配——「我记得给哪本书写过『烂尾』」这个问题答不上来。
           or ifnull(r.comment,'') like ? escape '\\' or ifnull(r.drop_reason,'') like ? escape '\\'
           or exists (select 1 from book_tag bt join tag t on t.id = bt.tag_id
                       where bt.book_id = b.id and t.name like ? escape '\\')
        -- **有话说的排前面。** 这个应用的正事是「下次不用再想这本我看过没」，
        -- 而搜出来 272 本《重生…》按书名排，我评过的那三本可能在第 180 位。
        -- 真实库量过：搜一个常用字回来一千行上下（「的」1022、「之」975），
        -- 那是一堵墙，而墙里恰好埋着唯一能回答那个问题的几行。
        -- 判据分两档：评价过的（口径和「我的书评」那一档一致，走 ratedSql）最前，
        -- 其次是打开过的，最后按书名——书名那一档是码位序，只保证同前缀的挨在一起
        order by ${ratedSql('r')} desc, (r.last_read_at is not null) desc, b.title`,
    )
    .all(like, like, like, like, like, like);
}

/**
 * 正文全文搜索。查询 ≥3 字走 FTS5，短于 3 字回落到 LIKE 扫索引表——
 * 慢一些，但**有结果**，而不是骗人说没有。
 */
export function searchFullText(db: DatabaseSync, query: string, limit = 200): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  if (!isIndexed(db)) {
    throw new Error('还没有任何书建过正文索引。切到「正文全文」那一档，挑一本书建');
  }

  const titleOf = db.prepare(
    `select b.title as bookTitle, c.title as chapterTitle
       from book b join book_file f on f.book_id = b.id and f.is_primary = 1
       join chapter c on c.file_id = f.id and c.idx = ?
      where b.id = ?`,
  );

  const rows =
    [...q].length >= MIN_TRIGRAM
      ? (db
          .prepare(
            `select book_id as bookId, chapter_idx as chapterIdx,
                    snippet(chapter_fts, 0, '【', '】', '…', 10) as snippet
               from chapter_fts where chapter_fts match ? limit ?`,
          )
          .all(ftsQuery(q), limit) as unknown as Array<{ bookId: number; chapterIdx: number; snippet: string }>)
      : (db
          .prepare(
            `select book_id as bookId, chapter_idx as chapterIdx, content
               from chapter_fts where content like ? escape '\\' limit ?`,
          )
          .all(likeArg(q), limit) as unknown as Array<{
          bookId: number;
          chapterIdx: number;
          content: string;
        }>).map((r) => ({
          bookId: r.bookId,
          chapterIdx: r.chapterIdx,
          snippet: makeSnippet(r.content, q),
        }));

  return rows.map((r) => {
    const t = titleOf.get(r.chapterIdx, r.bookId) as
      | { bookTitle: string; chapterTitle: string }
      | undefined;
    return {
      bookId: r.bookId,
      chapterIdx: r.chapterIdx,
      bookTitle: t?.bookTitle ?? '（未知）',
      chapterTitle: t?.chapterTitle ?? `第 ${r.chapterIdx + 1} 章`,
      snippet: r.snippet,
    };
  });
}

/**
 * 书内搜索（spec §6）。**不依赖全文索引**——只有一本书，直接逐章读就够快，
 * 而且没建索引的人也能用。
 */
export async function searchInBook(
  db: DatabaseSync,
  cache: FileCache,
  bookId: number,
  query: string,
): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];

  const file = db
    .prepare(
      `select id, path, encoding, size from book_file
        where book_id = ? and is_primary = 1 and ifnull(status,'ok') = 'ok'`,
    )
    .get(bookId) as { id: number; path: string; encoding: string; size: number } | undefined;
  if (!file) return [];

  const chapters = db
    .prepare('select idx, title, offset from chapter where file_id = ? order by offset')
    .all(file.id) as unknown as Array<{ idx: number; title: string; offset: number }>;

  const bookTitle =
    (db.prepare('select title from book where id = ?').get(bookId) as { title: string } | undefined)
      ?.title ?? '';

  // 正则**只编译一次**。放在循环里 `new RegExp` 是五十万次编译
  const compiled = loadCleanRules(db, bookId)
    .filter((r) => r.enabled && !r.whole)
    .flatMap((r) => {
      try {
        return [{ re: new RegExp(r.pattern, r.flags ?? 'gu'), replacement: r.replacement }];
      } catch {
        return []; // 坏规则跳过，不该让搜索起不来
      }
    });

  /** 字节偏移 → 是第几章。章节按 offset 有序，二分找 */
  const chapterAt = (byteOffset: number): { idx: number; title: string } => {
    let lo = 0;
    let hi = chapters.length - 1;
    let found = chapters[0] ?? { idx: 0, title: '' };
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (chapters[mid].offset <= byteOffset) {
        found = chapters[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };

  const hits: SearchHit[] = [];
  const fh = await openBook(file.path);
  try {
    // 顺序扫一遍，窗口对齐到行边界。
    //
    // **原来是逐章 readChapter**：12058 章的书上要 12 秒——12058 次 fs.read
    // 加 12058 次解码。用户正在读书想找一句话，界面卡十几秒是不可用的。
    // 现在顺序读一遍文件（一次 4MB），行的字节偏移直接由 splitLines 给出，
    // 再二分映射回章节。
    const WINDOW = 4 << 20;
    let base = 0;
    let carry = new Uint8Array(0); // 上个窗口没读完的最后半行

    while (base + carry.length < file.size) {
      const buf = Buffer.alloc(Math.min(WINDOW, file.size - base - carry.length));
      const { bytesRead } = await fh.read(buf, 0, buf.length, base + carry.length);
      if (bytesRead === 0) break;

      const chunk = new Uint8Array(carry.length + bytesRead);
      chunk.set(carry, 0);
      chunk.set(buf.subarray(0, bytesRead), carry.length);

      // 切到最后一个换行为止，剩下的半行留给下个窗口——
      // 不这么做的话，跨窗口的那一行会被从中间劈开，正好落在断点上的匹配就丢了
      const isLast = base + chunk.length >= file.size;
      let cut = chunk.length;
      if (!isLast) {
        for (let i = chunk.length - 1; i >= 0; i--) {
          if (chunk[i] === 0x0a) { cut = i + 1; break; }
        }
        if (cut === chunk.length) cut = chunk.length; // 整窗没有换行，只能硬切
      }

      for (const line of splitLines(chunk.subarray(0, cut), file.encoding as Encoding)) {
        // **先在原始行上找，命中了才清洗。**
        //
        // 反过来（每行都先清洗再找）要在五十万行上跑八条正则 ≈ 四百万次匹配，
        // 实测占掉大半时间。而清洗只影响含垃圾的那些行，先筛一遍能把清洗的
        // 调用次数从五十万降到几十。
        //
        // 代价：清洗**拼接**出来的匹配会漏（比如「他说<br/>道」清洗后变成
        // 「他说道」）。这种情况罕见，换回三四倍的速度值得。
        if (line.text.indexOf(q) < 0) continue;

        let text = line.text;
        for (const r of compiled) {
          try {
            text = text.replace(r.re, r.replacement);
          } catch {
            /* 坏规则不该让搜索崩掉 */
          }
        }
        let from = 0;
        for (;;) {
          const at = text.indexOf(q, from);
          if (at < 0) break;
          const c = chapterAt(base + line.byteOffset);
          hits.push({
            bookId,
            bookTitle,
            chapterIdx: c.idx,
            chapterTitle: c.title,
            snippet: makeSnippet(text.slice(Math.max(0, at - 20), at + q.length + 20), q),
          });
          from = at + q.length;
          if (hits.length >= 500) return hits;
        }
      }

      carry = chunk.subarray(cut);
      base += cut;
      if (isLast) break;
    }
  } finally {
    await fh.close();
  }
  return hits;
}
