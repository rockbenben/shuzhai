// 多版本归组与重复检测（spec §8）。
//
// **这个模块一个文件都不删、不移。** spec 说得很清楚：只提供「在资源管理器中显示」
// 让用户自己处理。这里能做的只有三件事：把同一本书的不同版本摆在一起、
// 指定哪个是主版本、把误判成两本书的记录合并成一本。

import type { DatabaseSync } from 'node:sqlite';
import { ensurePrimary, preferReadable } from './primary.ts';

export interface Version {
  fileId: number;
  bookId: number;
  path: string;
  size: number;
  mtime: number;
  wordCount: number | null;
  chapterCount: number | null;
  contentHash: string | null;
  status: string;
  isPrimary: boolean;
  /** 这一组里字数最多的那个 */
  mostWords: boolean;
  /** 这一组里最后修改时间最新的那个 */
  newest: boolean;
  /** 和组里别的文件内容完全相同（hash 一致） */
  exactDuplicate: boolean;
}

export interface VersionGroup {
  key: string;
  title: string;
  author: string | null;
  /** 这一组涉及的 book id。多于一个说明被当成了多本书，可以合并 */
  bookIds: number[];
  versions: Version[];
}

interface RawRow {
  fileId: number;
  bookId: number;
  title: string;
  author: string | null;
  path: string;
  size: number;
  mtime: number;
  wordCount: number | null;
  chapterCount: number | null;
  contentHash: string | null;
  status: string;
  isPrimary: number;
}

/**
 * 多版本归组的口径：书名 + 作者，去首尾空白转小写。
 * 「斗破苍穹 」和「斗破苍穹」是同一本。
 *
 * **分隔符是 NUL，不是空格**——用空格的话「三体 刘」+「慈欣」会和
 * 「三体」+「刘 慈欣」撞成同一个 key。NUL 不可能出现在书名或作者里。
 *
 * 导出是因为 `manual.ts` 的「扫描时认领手工添的书」必须用**同一个口径**：
 * 那边曾经手抄了一份，而且抄的时候把 NUL 写成了空格——两份声称「一致」的实现
 * 其实从第一天起就不一致。这类「注释说跟那边一样、代码没有任何东西保证」
 * 的耦合，迟早会以「两个界面对同一批书给出不同答案」的形式冒出来。
 */
export function bookKey(title: string, author: string | null | undefined): string {
  return `${title.trim().toLowerCase()}\u0000${(author ?? '').trim().toLowerCase()}`;
}

/**
 * 按「书名 + 作者」归组（spec §8）。只返回**真的有多个文件**的组——
 * 把每一本单文件的书都列出来，这个界面就没法用了。
 */
/*
 * ⚠️ **只看磁盘上真的还在的文件**（`where f.status = 'ok' and not excluded`，
 * 和 `health.ts` 那两条查询同一个口径）。
 *
 * 这里原来一个条件都不加，于是 `status = 'missing'` 的文件也会被当成「另一个版本」
 * 列出来，还带着「移入回收站」那个按钮。实测撞到的：《乌纱》一本在磁盘上、
 * 一本早就没了，界面照样算成一组重复；点确认之后 `shell.trashItem` 拿一个
 * 不存在的路径去解析，Windows 抛 **`Failed to parse path`**——一句用户完全看不懂的话，
 * 而真相是「那个文件本来就不在了，没什么可删的」。
 *
 * 文件不在了该走「需要处理」那一档（`library.repair`），不是「重复的书」——
 * **这两件事的动作正好相反**：一个是把多余的文件拿走，一个是把没了文件的记录收拾掉。
 *
 * ⚠️ **只滤 `missing`，不滤 `excluded`。** 第一版顺手照抄了 `health.ts` 的
 * `and ifnull(f.excluded, 0) = 0`，当场把《灵飞经》那一组（两个文件都在磁盘上、
 * 都被排除规则挡住）从界面上抹掉了。库里有 759 个 `excluded` 的文件——
 * **「不在书架上显示」不等于「这些文件我不在乎」**，它们照样占着磁盘，
 * 而这个界面问的正是「磁盘上要不要少一份」。
 * `health.ts` 那边滤它是对的（重解析一本看不见的书没有意义），
 * **同一个条件在两个界面上一个该滤一个不该滤**——照抄的时候要问一句「这个界面在问什么」。
 *
 * ⚠️ 注释写在模板字符串**外面**：里面的反引号会把那段 SQL 提前闭合
 * （第一版就是这么写的，`tsc` 报的是牛头不对马嘴的 `',' expected`）。
 */
export function listGroups(db: DatabaseSync): VersionGroup[] {
  const rows = db
    .prepare(
      `select f.id as fileId, b.id as bookId, b.title, b.author, f.path, f.size, f.mtime,
              f.word_count as wordCount, f.chapter_count as chapterCount,
              f.content_hash as contentHash, f.status, f.is_primary as isPrimary
         from book_file f join book b on b.id = f.book_id
        where f.status = 'ok'
        order by b.title, f.id`,
    )
    .all() as unknown as RawRow[];

  const groups = new Map<string, RawRow[]>();
  for (const r of rows) {
    const key = bookKey(r.title, r.author);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const out: VersionGroup[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;

    const maxWords = Math.max(...list.map((r) => r.wordCount ?? 0));
    const maxMtime = Math.max(...list.map((r) => r.mtime));
    const hashCount = new Map<string, number>();
    for (const r of list) {
      if (r.contentHash) hashCount.set(r.contentHash, (hashCount.get(r.contentHash) ?? 0) + 1);
    }

    out.push({
      key,
      title: list[0].title,
      author: list[0].author,
      bookIds: [...new Set(list.map((r) => r.bookId))],
      versions: list.map((r) => ({
        fileId: r.fileId,
        bookId: r.bookId,
        path: r.path,
        size: r.size,
        mtime: r.mtime,
        wordCount: r.wordCount,
        chapterCount: r.chapterCount,
        contentHash: r.contentHash,
        status: r.status,
        isPrimary: r.isPrimary === 1,
        mostWords: (r.wordCount ?? 0) === maxWords && maxWords > 0,
        newest: r.mtime === maxMtime,
        exactDuplicate: r.contentHash ? (hashCount.get(r.contentHash) ?? 0) > 1 : false,
      })),
    });
  }

  return out;
}

/**
 * 指定主版本（spec §8：阅读进度跟随主版本）。
 * 阅读状态挂在 book 上不挂在 file 上，所以**换主版本不会动进度**——
 * 这正是 spec §11 末尾那条设计的用处。
 */
export function setPrimary(db: DatabaseSync, fileId: number): void {
  const row = db.prepare('select book_id from book_file where id = ?').get(fileId) as
    | { book_id: number }
    | undefined;
  if (!row) throw new Error(`没有这个文件记录：${fileId}`);

  db.exec('begin');
  try {
    db.prepare('update book_file set is_primary = 0 where book_id = ?').run(row.book_id);
    db.prepare('update book_file set is_primary = 1 where id = ?').run(fileId);
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
}

/**
 * 把几本被当成不同书的记录合并成一本（同名同作者的不同文件）。
 *
 * **保留哪一本不是随便挑的**：优先保留有阅读进度的那本，
 * 因为进度是不可再生的；都没进度就保留 id 最小的（最早加进来的）。
 * 文件记录全部挂到保留的那本下面，其余 book 行删掉。
 *
 * 磁盘上一个文件都不动。
 */
/*
 * 挂在 `book` 上的表全是 `on delete cascade`，所以合并时**对每一张都得表个态**：
 * 搬到 keeper 上，或者在下面写明为什么可以跟着败方一起没。
 * （同 `backup.ts` 那条「db.ts 里建的每张表，名字都得在这儿出现过」。
 * `versions.test.ts` 有一条守着，加新表时会红。）
 *
 * **搬**：`bookmark` / `highlight` / `reading_session` —— 铁律 3 的不可再生数据。
 * 位置漂了不要紧，`bookmark.resolve` / `highlight.resolve` 本来就拿 excerpt
 * 跟当前正文对账、对不上标 `intact: false`，那条路已经在了。
 *
 * **不搬，跟着没**：
 * - `book_file`、`book_tag`、`reading_state` —— 上面单独处理了（搬文件、并标签、并书评）。
 * - `parse_rule` / `clean_rule` —— 那是「这本书按什么规则切章/净化」。keeper 有自己的
 *   一份，两份规则叠在同一本书上只会互相打架，而重新设一次是几秒钟的事。
 * - `online_link` / `cover_fetch` —— 抓取顺手记的源页和抓取状态，重抓就有。
 *   （真实库里 online_link 888 条，全是封面抓取记的。）
 */
const MOVED_TABLES = ['bookmark', 'highlight', 'reading_session'] as const;

/*
 * 书自己的这几列：**keeper 空着、败方有值就补过来**。
 * 封面重抓一本要 6 秒（队列还剩几千本），简介/别名/备注/来源站点是用户自己打的字——
 * keeper 是按**阅读进度**挑的，跟「哪本填过这些」没关系，同 `review` 那段的理由。
 * 表名列进 SQL 是安全的：这张表是模块内的字面量，不接受调用方传进来的东西。
 */
const FOLD_COLS = ['cover_path', 'intro', 'aliases', 'source_site', 'note'] as const;

export function mergeBooks(db: DatabaseSync, bookIds: number[]): { keptBookId: number } {
  if (bookIds.length < 2) throw new Error('至少要两本才谈得上合并');

  const states = db
    .prepare(
      `select b.id, ifnull(r.chapter_idx, 0) as chapterIdx, ifnull(r.percent, 0) as percent,
              r.rating, r.comment, r.rated_at as ratedAt,
              ${FOLD_COLS.map((c) => 'b.' + c).join(', ')}
         from book b left join reading_state r on r.book_id = b.id
        where b.id in (${bookIds.map(() => '?').join(',')})
        order by b.id`,
    )
    .all(...bookIds) as unknown as Array<{
      id: number; chapterIdx: number; percent: number;
      rating: number | null; comment: string | null; ratedAt: string | null;
    } & Record<string, unknown>>;

  if (states.length !== bookIds.length) throw new Error('有 book id 不存在');

  // 有进度的优先；进度相同就取最早的那本
  const keeper =
    [...states].sort((a, b) => b.percent - a.percent || b.chapterIdx - a.chapterIdx || a.id - b.id)[0];
  const others = bookIds.filter((id) => id !== keeper.id);

  /*
   * **书评要跟着合并过来，不能只并标签。**
   *
   * keeper 是按**阅读进度**挑的，跟「哪本写过书评」无关：《诛仙》在库里有
   * 校对版和精校版两个文件，你在其中一本上读到 500 章、在另一本上写了
   * 「结局烂尾了别看」——合并之后另一本连同 `reading_state` 被
   * `on delete cascade` 删掉，那句话就没了。而书评和进度一样**重扫恢复不了**，
   * 这个应用的正事全靠它。标签早就并过来了，评分短评没有，同一次合并里
   * 两种用户数据两套待遇。
   *
   * 规则：**keeper 自己有的不动**（它才是留下来的那本），缺的从别人那儿补，
   * 多个候选取 `rated_at` 最近的。
   *
   * ⚠️ **短评两边都有就拼起来，不是二选一。** 那是用户自己写的字，
   * 丢一句比留一句长的糟。分隔用换行加书名号里的来源没必要——两句都是
   * 同一本书的评价，直接换行接上，用户一眼看得出是两段。
   */
  const review = (() => {
    const mine = states.find((x) => x.id === keeper.id)!;
    const rest = states
      .filter((x) => x.id !== keeper.id)
      .sort((a, b) => (b.ratedAt ?? '').localeCompare(a.ratedAt ?? ''));

    const rating = mine.rating ?? rest.find((x) => x.rating != null)?.rating ?? null;
    const comments: string[] = [];
    for (const x of [mine, ...rest]) {
      const c = (x.comment ?? '').trim();
      if (c && !comments.includes(c)) comments.push(c);
    }
    const comment = comments.length ? comments.join('\n') : null;
    // 有任何评价内容就得有时间戳，否则「我的书评」那一档按 rated_at 排，它会消失
    const ratedAt = rating != null || comment
      ? (mine.ratedAt ?? rest.find((x) => x.ratedAt)?.ratedAt ?? new Date().toISOString())
      : null;
    return { rating, comment, ratedAt };
  })();

  db.exec('begin');
  try {
    for (const id of others) {
      db.prepare('update book_file set book_id = ?, is_primary = 0 where book_id = ?').run(keeper.id, id);
      // 标签并过来，重复的靠主键挡掉
      db.prepare('insert or ignore into book_tag(book_id, tag_id) select ?, tag_id from book_tag where book_id = ?').run(
        keeper.id,
        id,
      );
      for (const t of MOVED_TABLES) db.prepare(`update ${t} set book_id = ? where book_id = ?`).run(keeper.id, id);
      /*
       * ⚠️ **PDF / EPUB 读到哪儿不是一张表，`MOVED_TABLES` 那条守卫看不见它。**
       *
       * 它存在 `app_setting` 的 `viewer.<bookId>` 里（PDF 是页码、EPUB 是章序号，
       * 见 `deletion.ts` 里那段解释为什么不进 `reading_state`）。
       * 这个文件的守卫是「每一张 `references book(id)` 的表都得在这儿出现过」——
       * **按定义就管不到一行按 id 命名的设置**。不管它的后果有两条：
       * 败方读到第几页**没了**（重扫恢复不了），而且留下一行指向已删除书的孤儿设置。
       *
       * 判据抄这个函数自己的那条：**keeper 自己有的不动，缺的才补**。
       * 补不上的（keeper 已经有了）就把败方那行删掉——它指的书下一句就没了。
       *
       * ⚠️ 键在 JS 里拼好整串，别写 `'viewer.' || ?`：`node:sqlite` 把 JS 数字绑成 REAL，
       * 那条拼出来是 `viewer.7.0`，永远匹配不上而且不报错（`deletion.ts` 那节记着）。
       */
      const 有 = (k: string) =>
        (db.prepare('select count(*) n from app_setting where key = ?').get(k) as { n: number }).n > 0;
      /*
       * ⚠️ **按 id 命名的设置现在有两种了**：读到哪儿（`viewer.`）和
       * **自建目录**（`outline.`，迁移 24）。两者搬法一模一样，所以走同一个循环——
       * 写成两段的话，下一种加进来时又会漏一份（这个仓库那条
       * 「同一件事抄两份必分叉」，在这张清单上已经应验了四次）。
       */
      for (const 前缀 of ['viewer', 'outline'] as const) {
        const 败方位置 = `${前缀}.${id}`;
        const 赢家位置 = `${前缀}.${keeper.id}`;
        if (!有(败方位置)) continue;
        if (!有(赢家位置)) {
          db.prepare('update app_setting set key = ? where key = ?').run(赢家位置, 败方位置);
        } else {
          db.prepare('delete from app_setting where key = ?').run(败方位置);
        }
      }
      db.prepare('delete from book where id = ?').run(id);
    }
    // 书评补到 keeper 上。**放在删掉别人之后**——`on delete cascade` 已经把
    // 那些 reading_state 行带走了，这里写的是从内存里那份快照算出来的结果
    db.prepare('insert or ignore into reading_state(book_id) values(?)').run(keeper.id);
    db.prepare('update reading_state set rating = ?, comment = ?, rated_at = ? where book_id = ?')
      .run(review.rating, review.comment, review.ratedAt, keeper.id);

    // keeper 缺的那几个字段从别人那儿补（谁先有算谁的，keeper 自己有的不动）
    const mineRow = states.find((x) => x.id === keeper.id)!;
    for (const col of FOLD_COLS) {
      if (String(mineRow[col] ?? '').trim()) continue;
      const donor = states.find((x) => x.id !== keeper.id && String(x[col] ?? '').trim());
      if (donor) db.prepare(`update book set ${col} = ? where id = ?`).run(donor[col] as string, keeper.id);
    }

    /*
     * 合并后保证仍有一个**能用的**主版本。
     *
     * 判据在 `primary.ts`——扫描和删除那两处用的是同一份。原来这儿只管
     * 「有没有主版本」，不管那个主版本是不是 `missing`：搬过来的那堆文件里
     * 混着一条坏的、而它正好是主文件时，合并完这本书就打不开了。
     */
    ensurePrimary(db, keeper.id);
    /*
     * ⚠️ **再问一句「主文件能不能读」。** `ensurePrimary` 管的是「主文件坏没坏」，
     * 而这里刚发生的事情是**文件集变了**：败方那份 txt 带着 `is_primary = 0` 搬进来，
     * keeper 自己那面旗从没被重问过。合并 `三体.epub` + `三体.txt` 的实测结果是
     * 主文件仍是 EPUB，于是这本书点开进的是查看器——整段理由写在 `preferReadable` 上面。
     */
    preferReadable(db, keeper.id);
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }

  return { keptBookId: keeper.id };
}

/** 内容完全相同的文件（hash 一致），跨书也算（spec §8「完全重复」） */
export function exactDuplicates(db: DatabaseSync): Array<{ hash: string; paths: string[] }> {
  const rows = db
    .prepare(
      `select content_hash as hash, group_concat(path, char(10)) as paths
         from book_file where content_hash is not null
        group by content_hash having count(*) > 1`,
    )
    .all() as unknown as Array<{ hash: string; paths: string }>;
  return rows.map((r) => ({ hash: r.hash, paths: r.paths.split('\n') }));
}
