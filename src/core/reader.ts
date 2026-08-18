// 阅读器内核：按字节偏移定点读（spec §6 + §12）。
//
// **绝不 readFile 整本加载。** 几十 MB 的书要秒开，靠的就是 `fs.open` 拿到 fd 之后
// 按 `(offset, length)` 定点 `fs.read`——只把当前这一章读进内存。
//
// 文件句柄用 LRU 缓存（默认 3 个），两个理由：
//   1. 连续翻页不必每章重开一次文件
//   2. **句柄必须能主动释放**——重命名前要检查「文件被占用」（spec §3.3），
//      占用者最常见的就是本应用自己正开着这本书。所以 `release()` 不是可选项。

import { open, readFile, type FileHandle } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { decodeText, type Encoding } from './encoding.ts';
import { cleanText, loadCleanRules } from './clean.ts';
import { convertText, bookConvertMode } from './convert.ts';

/**
 * 打不开文件时说人话。
 *
 * 翻译放这儿一份，不在每个调用方各写一遍。
 *
 * ⚠️ **`FileCache` 并不是所有读正文路径的唯一入口**——这句话在这儿写错过一次，
 * 而它正是本仓库最常见的那类缺陷（注释指着一件不成立的事，不报错也测不出来）。
 * 书内搜索（`search.ts`）和重新解析 / 猜规则（`reparse.ts`）都自己开文件，
 * 走不到 `FileCache`。所以另给了 `openBook` / `readBook` 两个口子，
 * **绕开 FileCache 的地方走它们**，人话才补得齐。
 *
 * 只有 `scan.ts` 算指纹那处仍然裸 `open`：那是后台扫描，出错落在
 * `book_file.parse_error` 里，没有一个正等着看结果的人。
 *
 * 起因是实测：把一本书的 txt 删掉再点开它，用户看到的是一句
 * `ENOENT: no such file or directory, open '<一长条绝对路径>'`——
 * 英文 errno 加一条长路径，**而且没有一个字说该怎么办**。
 * 这正是 AGENTS.md 里 `root.remove` 那节警告过的形状（「点开才报 ENOENT」）：
 * 当时补的出路是 `library.repair`，但没人告诉用户它在界面上叫什么。
 *
 * 认不出的错码原样往外抛——**编不出人话的时候，原文比瞎猜的解释有用**。
 */
export function openHint(e: NodeJS.ErrnoException): string {
  switch (e.code) {
    case 'ENOENT':
      // **和卡片角标同一个说法**（`labels.ts` 的 FILE_STATUS：「文件不见了」）——
      // 用户先在书架上看到那个角标，再点进来看到这句，两句得是一回事
      return '这本书的文件不见了（被删了，或者移到别处了）。'
        + '扫描一次书库能把移过位置的认回来；真没了的，用「设置 → 书库 → 整理数据库」清掉记录。';
    case 'EACCES':
    case 'EPERM':
      return '没有权限读这个文件。它可能在一个受保护的文件夹里，或者被安全软件锁着。';
    case 'EBUSY':
      return '这个文件正被别的程序占着，先把那边关掉再试。';
    case 'EISDIR':
      return '这条记录指向的是一个文件夹，不是书。扫描一次书库应该能修好。';
    case 'EMFILE':
      return '同时打开的文件太多了。关掉一些程序再试。';
    default:
      return e.message;
  }
}

/** 给绕开 `FileCache` 的地方用：打不开也说人话（书内搜索走这条） */
export async function openBook(path: string): Promise<FileHandle> {
  return open(path, 'r').catch((e: NodeJS.ErrnoException) => { throw new Error(openHint(e)); });
}

/** 同上，整本读进来的那种（重新解析、猜章节规则走这条） */
export async function readBook(path: string): Promise<Buffer> {
  return readFile(path).catch((e: NodeJS.ErrnoException) => { throw new Error(openHint(e)); });
}

/** 同时开着的文件句柄上限。翻页只在相邻章之间跳，3 个够用 */
const DEFAULT_MAX_HANDLES = 3;

export class FileCache {
  #handles = new Map<string, FileHandle>();
  #max: number;

  constructor(max = DEFAULT_MAX_HANDLES) {
    this.#max = max;
  }

  async #get(path: string): Promise<FileHandle> {
    const hit = this.#handles.get(path);
    if (hit) {
      // 重新插入一次，Map 保持插入顺序，最旧的自然排在最前
      this.#handles.delete(path);
      this.#handles.set(path, hit);
      return hit;
    }

    const fh = await open(path, 'r').catch((e: NodeJS.ErrnoException) => {
      throw new Error(openHint(e));
    });
    this.#handles.set(path, fh);

    while (this.#handles.size > this.#max) {
      const oldest = this.#handles.keys().next().value as string;
      const victim = this.#handles.get(oldest)!;
      this.#handles.delete(oldest);
      await victim.close();
    }
    return fh;
  }

  /** 定点读一段字节。不碰文件其余部分 */
  async read(path: string, offset: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    const fh = await this.#get(path);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  }

  /**
   * 释放某个文件的句柄。**重命名前必须调**，否则 Windows 上会因文件被占用而失败。
   * 文件没开着也不报错。
   */
  async release(path: string): Promise<void> {
    const fh = this.#handles.get(path);
    if (!fh) return;
    this.#handles.delete(path);
    await fh.close();
  }

  async releaseAll(): Promise<void> {
    const all = [...this.#handles.values()];
    this.#handles.clear();
    await Promise.all(all.map((fh) => fh.close()));
  }

  get openCount(): number {
    return this.#handles.size;
  }
}

export interface ChapterText {
  bookId: number;
  idx: number;
  title: string;
  volume: string | null;
  text: string;
  /** 全书共几章，界面上显示「本章 x/y」用 */
  total: number;
}

/**
 * 「这本书主文件切了几章」——`readChapter` 和 `saveProgress` 都要这个数，
 * 原来两处各抄一份同样的 SQL。抄本会分叉：`is_primary` 那个条件哪天变了
 * （一本书理论上可能有两个 is_primary 的文件，`health.ts` 那段注释记着），
 * 漏改一处的后果是**进度百分比按另一个分母算**，不报错、看不出来。
 */
function chapterCount(db: DatabaseSync, bookId: number): number {
  return (
    db
      .prepare(
        `select count(*) n from chapter c join book_file f on f.id = c.file_id
          where f.book_id = ? and f.is_primary = 1`,
      )
      .get(bookId) as { n: number }
  ).n;
}

interface ChapterRow {
  idx: number;
  title: string;
  volume: string | null;
  offset: number;
  length: number;
  path: string;
  encoding: string | null;
}

/**
 * 读一章的正文。走主版本文件（`is_primary = 1`）。
 * 章节表里存的是**字节**偏移，这里直接喂给 fs.read，不做任何字符换算。
 */
export async function readChapter(
  db: DatabaseSync,
  cache: FileCache,
  bookId: number,
  idx: number,
  /** 关掉清洗看原文（规则编辑器的 diff 预览要用左边那半） */
  raw = false,
): Promise<ChapterText> {
  const row = db
    .prepare(
      `select c.idx, c.title, c.volume, c.offset, c.length, f.path, f.encoding
         from chapter c
         join book_file f on f.id = c.file_id
        where f.book_id = ? and f.is_primary = 1 and c.idx = ?`,
    )
    .get(bookId, idx) as ChapterRow | undefined;

  if (!row) throw new Error(`书 ${bookId} 没有第 ${idx} 章`);

  const total = chapterCount(db, bookId);

  const buf = await cache.read(row.path, row.offset, row.length);
  const decoded = decodeText(buf, (row.encoding ?? 'utf-8') as Encoding);

  // 清洗和繁简转换都是**运行时**套的（spec §2.4 / §2.5）：
  // 原文件不动，库里也不存转换后的正文。顺序是先清洗再转换——
  // 清洗规则是按原文字形写的，先转换会让规则匹配不上。
  const text = raw
    ? decoded
    : convertText(cleanText(decoded, loadCleanRules(db, bookId)), bookConvertMode(db, bookId));

  /*
   * ⚠️ **标题也要跟着转，不能只转正文。**
   *
   * 这里原来是 `title: row.title`——库里那份原样。而 `text` 是转过的，
   * 于是切了繁简之后 `text.startsWith(title)` **不成立**，
   * 而「把标题从正文里剥掉」这件事三处都是这么判的（`highlight.resolve` 等）。
   * 剥不掉的后果是**整章的字符偏移集体挪了一个标题的长度**：
   * 实测切成繁体之后，那一章 718 → 726，每一条划线都被判成「对不上原文」。
   * 用户看到的是「切了个繁简，满屏笔记全没了」。
   *
   * 顺带修的还有一处看得见的：`<h2>` 那个章名原来不转，
   * 一本显示成繁体的书，章标题却是简体。
   */
  const 标题 = raw ? row.title : convertText(row.title ?? '', bookConvertMode(db, bookId));

  return { bookId, idx: row.idx, title: 标题, volume: row.volume, text, total };
}

/**
 * 把标题从这一章的正文里剥掉。
 *
 * ⚠️ **只此一份。** `rpc.ts` 里原来抄了三处一模一样的
 * `ch.text.startsWith(ch.title) ? ch.text.slice(ch.title.length) : ch.text`——
 * 而划线的字符偏移就是按剥完之后那段字算的，三处有一处不一样，
 * 那一路上的划线就整体偏一个标题的长度。
 */
export function chapterBody(ch: { text: string; title: string | null }): string {
  const t = ch.title ?? '';
  return t && ch.text.startsWith(t) ? ch.text.slice(t.length) : ch.text;
}

/**
 * 记录阅读进度。`percent` 由章号算出来，不让调用方自己传——
 * 两处各算一遍迟早会对不上（这个仓库在别处已经吃过「同一个东西被两处数」的亏）。
 */
/**
 * 记进度（spec §2.3）。
 *
 * `atEnd` = 阅读器报告「已经翻到最后一章的最底下」。**只有这时才自动标已读完**——
 * 光看 `chapterIdx === total - 1` 是不够的：从目录直接跳到最后一章看一眼，
 * 那本书就被判成读完了。而 `finished` 一旦标上，书从「在读」里消失，
 * 用户下次找不到它，还以为丢了。
 */
export function saveProgress(
  db: DatabaseSync,
  bookId: number,
  chapterIdx: number,
  charOffset: number,
  atEnd = false,
): { percent: number; finished: boolean } {
  const total = chapterCount(db, bookId);

  const percent = total === 0 ? 0 : Math.min(100, ((chapterIdx + 1) / total) * 100);
  const finished = atEnd && total > 0 && chapterIdx >= total - 1;

  /*
   * **已经标了「读完」的书，进度条不许再被写回去。**
   *
   * 这里原来无条件写 `percent`，而 `status` 只升不降（none/want/shelved → reading、
   * 到底 → finished，没有一条会离开 finished）。于是：读完一本书 → 回头翻到
   * 第 513/573 章查点东西 → **percent 被写成 89.7，状态还挂着「已读完」**。
   * 卡片上那根进度条只在 `0 < percent < 100` 时才画，所以用户看到的是
   * **一本顶着「读完」角标、底下还画着 90% 进度条的书**——正是本仓库反复记着的
   * 「派生字段脱节」那一族（「状态是想读、却有读完时间、进度条还满格」）。
   * 真实库上普查 8172 行，撞到 1 条。
   *
   * 判据抄 `scan.ts` 重新解析那处已有的一条：**`finished` 的 100% 是用户按的，不碰**。
   * `chapter_idx` / `char_offset` 照旧写——用户确实在读，回来还要接着看；
   * 只有「读到几分之几」这个**派生**的数跟着状态走。
   * 反方向由 `setStatus` 管：离开 finished 时按 chapter_idx 重算（那条早就在）。
   *
   * ⚠️ `case` 里的 `status` 取的是**这一行原来的值**（SQLite 的 UPDATE 里所有
   * 表达式都对着旧行求值），所以「这一次才刚标成 finished」不会被它挡住——
   * 那种情况下 chapterIdx 就是最后一章，算出来本来也是 100。
   */
  const keep = (
    db.prepare("select status = 'finished' as f from reading_state where book_id = ?").get(bookId) as
      | { f: number }
      | undefined
  )?.f === 1;

  db.prepare(
    `update reading_state
        set chapter_idx = ?, char_offset = ?,
            percent = case when status = 'finished' then 100 else ? end,
            status = case
              when ? = 1 then 'finished'
              when status in ('none', 'want', 'shelved') then 'reading'
              else status end,
            finished_at = case when ? = 1 and finished_at is null
                               then datetime('now') else finished_at end,
            last_read_at = datetime('now')
      where book_id = ?`,
  ).run(chapterIdx, charOffset, percent, finished ? 1 : 0, finished ? 1 : 0, bookId);

  // 返回的要和真的存进去的那个一致，不然调用方拿到一个库里没有的数
  return { percent: keep ? 100 : percent, finished };
}

/**
 * **只记「打开过」，一个字都不碰进度。** 给 PDF / EPUB 查看器用。
 *
 * 那两种格式的进度存在 `app_setting` 的 `viewer.<bookId>` 里，**不在这张表**——
 * 那是有意的：`chapter_count` 对只编目的格式天生是 0，写进 `reading_state`
 * 会让卡片显示「读到 12/0」、百分比还除零。
 *
 * 代价是这张表**完全不知道它被打开过**，而书架上好几样东西都从这张表取数：
 * 卡片那行「读到第几章 · 多久前」、默认排序的「读过的排最前」（`last_read_at desc`）、
 * 侧栏「在读」那一档、`reading.last` / `recent`。于是
 * **一本你昨天读了一百页的 PDF，在书架上和一本从没打开过的书一模一样。**
 *
 * 所以只补两样：`last_read_at`，以及和 `saveProgress` **同一条**的状态提升
 * （`none` / `want` / `shelved` → `reading`）。
 *
 * ⚠️ **`chapter_idx` / `char_offset` / `percent` / `finished_at` 一个都不许写。**
 * 写了就正好造出当初绕开这张表要躲的那个「读到 12/0」。
 * ⚠️ **已读完 / 弃坑的状态不动**——判据抄 `saveProgress`：那是用户自己表的态，
 * 重新翻一下不该把它推回「在读」。
 */
export function markOpened(db: DatabaseSync, bookId: number): void {
  db.prepare('insert or ignore into reading_state(book_id) values(?)').run(bookId);
  db.prepare(
    `update reading_state
        set status = case when status in ('none', 'want', 'shelved') then 'reading' else status end,
            last_read_at = datetime('now')
      where book_id = ?`,
  ).run(bookId);
}

/**
 * **翻到最后一页/最后一章 → 标「已读完」。** 也给 PDF / EPUB 查看器用。
 *
 * txt 那半早就有了（`saveProgress` 的 `finished` 分支），而这两种格式一直没有：
 * 一本从头翻到尾的 PDF 在书架上永远挂着「在读」、永远进不了「已读完」那一档。
 *
 * 和 `saveProgress` 一样只动**派生**字段（`percent` / `finished_at` / `last_read_at`），
 * ⚠️ **`chapter_idx` / `char_offset` 一个字都不写**——理由同 `markOpened`：
 * 那两列对只编目的格式永远是 0，写了就造出「读到 12/0」。
 *
 * ⚠️ **已读完 / 弃坑的不动**，判据抄 `markOpened`（「那是用户自己表的态」）。
 * 这里比 txt 那边更需要它，两个原因：
 *   - PDF 那个页码框**一下就能跳到最后一页**，误触比 txt「翻到最后一章再滚到底」便宜得多；
 *   - 走 `setStatus` 的话，离开「弃坑」会把弃坑原因折进短评（那条逻辑本身是对的），
 *     于是「好奇翻一下最后一页」会**改掉用户写的字**。所以这里不走 `setStatus`。
 * 反过来重复标也被它挡住了：坐在最后一页不动，`finished_at` 不会被一遍遍刷新。
 */
export function markFinished(db: DatabaseSync, bookId: number): void {
  db.prepare('insert or ignore into reading_state(book_id) values(?)').run(bookId);
  db.prepare(
    `update reading_state
        set status = 'finished', percent = 100,
            finished_at = coalesce(finished_at, datetime('now')),
            last_read_at = datetime('now')
      where book_id = ? and status not in ('finished', 'dropped')`,
  ).run(bookId);
}

/** 「继续阅读」入口用：最近读过的那本（spec §6） */
export function lastRead(db: DatabaseSync): unknown {
  return db
    .prepare(
      `select b.id as bookId, b.title, b.author,
              r.chapter_idx as chapterIdx, r.char_offset as charOffset, r.percent
         from reading_state r
         join book b on b.id = r.book_id
        where r.last_read_at is not null
        order by r.last_read_at desc
        limit 1`,
    )
    .get() ?? null;
}
