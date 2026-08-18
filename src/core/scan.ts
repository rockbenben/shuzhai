// 目录扫描与增量同步（spec §1.2 / §1.3）。
//
// **这个模块唯一会写盘的对象是数据库，绝不碰用户的 txt。** 重命名是另一条路
// （spec §3.3，必须用户显式触发），扫描流程一个字节都不改文件。
//
// 增量判据分三档，越往下越贵：
//   1. size + mtime 都没变 → 跳过，**不读文件内容**
//   2. 变了 → 算指纹（大文件只取首尾各 64KB + size，不整本读）
//   3. 指纹一样但路径变了 → 判定为移动/改名，**保留全部元数据和阅读进度**
//
// 第 3 条是这个模块最要紧的一条：用户整理一次文件夹就把进度全丢，是不可接受的。

import { createHash } from 'node:crypto';
import { ensurePrimary } from './primary.ts';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, relative, sep } from 'node:path';
import { matchesGlob } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { detectEncoding, decodeText, type Encoding } from './encoding.ts';
// 无依赖模块，渲染进程也要用
import { isBookFile, formatOf, extOf } from './book-format.ts';
import { ruleForFile } from './book-rule.ts';
import {
  parseChapters,
  restoreProgress,
  type Chapter,
  type ParseRule,
  type Progress,
} from './chapter.ts';
import { parseFilename, countWords } from './filename.ts';
import { claimFileless, filelessIndex } from './manual.ts';
import { DEFAULT_IGNORE } from './ignore.ts';

/** 指纹取样大小。大文件只读首尾各这么多，不整本读（spec §1.3） */
const FINGERPRINT_EDGE = 64 * 1024;

export interface ScanOptions {
  /**
   * 只给测试用的缝：让「老路径还在吗」那一问能造出**不是 ENOENT** 的失败。
   *
   * 那种失败在真机上要靠文件被锁、权限不对、网络盘抖动才出得来，测试里造不稳；
   * 而路径里塞 NUL 那条路也走不通——**`node:sqlite` 会把字符串在 NUL 处截断**
   * （当场量的：存 10 个字符，取出来 4 个），于是落库的是个前缀，`stat` 给的还是 ENOENT。
   *
   * 同 `links.ts` 靠注入 `fetchImpl` 才测得了探活那条。
   */
  statImpl?: (p: string) => Promise<unknown>;

  /** 忽略规则，glob（spec §1.1）。用 Node 自带的 path.matchesGlob，不引 glob 库 */
  ignore?: string[];
  /** 小于这个字节数不收，默认 10 KB——滤掉空文件和说明文档（spec §1.1） */
  minBytes?: number;
  /** 大于这个字节数不收，默认不限 */
  maxBytes?: number;
  /** 每处理完一个文件回调一次，给状态栏显示进度用（spec §1.2） */
  onProgress?: (current: string, done: number) => void;
}

/**
 * **收录下限：小于这么多字节的文件不收。**
 *
 * 默认 10 KB，为的是滤掉小说目录里那些零碎（「说明.txt」「广告.txt」「目录.txt」）。
 * 但它**不是对所有书库都成立**：真实案例是一个装短文合集的目录，
 * 55 个 txt 里 27 个在 3–8 KB 之间，一扫全被挡在外面——而那 27 篇正是用户要的书。
 * 症状还特别不像回事：pdf 一个不少地进来了，txt 少了一半。
 *
 * 所以它现在是个设置。**键和默认值定义在这儿一处**：rpc 读它、设置界面显示它，
 * 两边不许各写一份（本仓库那条「同一份约定抄成几份必然分叉」）。
 */
export const MIN_BYTES_KEY = 'scan.minBytes';
export const MIN_BYTES_DEFAULT = 10 * 1024;

/**
 * 把存进 `app_setting` 的那个字符串解释成字节数。
 *
 * ⚠️ **坏值一律退回默认，不能当成 0。** `Number('')` 是 0、`Number(null)` 也是 0——
 * 照单全收的话，一个空设置就等于「下限取消」，用户会莫名其妙多出几千个说明文档。
 * `0` 只有用户**明确填 0** 时才成立（那时 raw 是 `'0'`）。
 */
export function parseMinBytes(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || String(raw).trim() === '') return MIN_BYTES_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : MIN_BYTES_DEFAULT;
}

// 屏蔽规则搬去 ignore.ts 了（那边可持久化、可预览、能试算影响范围）。
// 这里 re-export 一份保持老调用方不变——注意 `export {} from` **不会**在本模块内
// 建立绑定，scanRoot 自己要用还得单独 import
export { DEFAULT_IGNORE } from './ignore.ts';

/**
 * 「看见了但没收」的五种理由。**五条 continue/return 各对应一条**——
 * 用户侧的症状完全一样（文件在硬盘上、库里没有），差别只在怎么办。
 */
export type SkipReason =
  /** 小于 minBytes（默认 10 KB，可在「设置 → 书库」里调）。多半是说明文档或空文件 */
  | 'tooSmall'
  /** 大于 maxBytes。默认不限，配了才可能命中 */
  | 'tooBig'
  /** 被屏蔽规则挡掉 */
  | 'ignored'
  /** 整个目录读不了（权限之类），**整棵子树都没进来** */
  | 'unreadableDir'
  /**
   * **扩展名不在 `BOOK_EXT` 里。**
   *
   * ⚠️ 这一条是第五个，而且是**最晚补上的那个**——前面四条各有一句
   * `onSkip`，唯独这一条在 `walk` 里是一句光秃秃的 `else if (isBookFile(...))`，
   * 不符合就直接落空。后果正是 `ScanReport.skipped` 顶上警告过的那件事：
   * 用户库里 16 个 `.doc`、4 个 `.chm` **从来没有被提起过一次**，
   * 而扫描报告说「一切正常」。
   *
   * 这一条的「怎么办」和另外四条都不一样：不是调门槛、不是改屏蔽规则，
   * 而是**决定要不要收这种格式**。所以光有一个计数不够，
   * 还要知道是哪些扩展名——见 `ScanReport.otherExts`。
   */
  | 'notBook';

export interface ScanReport {
  added: number;
  updated: number;
  moved: number;
  missing: number;
  failed: number;
  unchanged: number;
  /**
   * 各种「看见了但没收」的计数，键是理由。
   *
   * **静默跳过是这个仓库反复咬人的一条**：过滤都是一句 `continue`，
   * 扫描报告全 0，不会告诉你「有文件被跳过了」。测试里踩过三次，
   * 症状是「所有断言都说查不到这本书」；用户那边则是
   * 「选了文件夹，扫完还是空的，而且没有任何解释」。
   *
   * 做成一张表而不是一个 `tooSmall` 字段：一共有四条跳过路径，
   * 每加一条理由就要跨 scan / rpc / 界面四个文件扩一次字段的话，
   * 实际结果就是只有第一条会被数。现在加理由是一行。
   */
  skipped: Partial<Record<SkipReason, number>>;
  /**
   * `notBook` 那一档**按扩展名分开数**：`{ doc: 16, chm: 4, jpg: 19 }`。
   *
   * 只有一个总数是不够的——「20 个文件因为格式没收」会让人去满硬盘找，
   * 而「16 个 .doc」当场就能决定要不要收。这是这一档和另外四档的区别：
   * 另外四档的处置是调一个设置，这一档的处置是**选一种格式**。
   *
   * 没有扩展名的记成 `(无扩展名)`。
   */
  otherExts: Record<string, number>;
  /** 解析失败的明细，界面上要能一键跳到批量处理（spec §1.4） */
  failures: Array<{ path: string; error: string }>;
  /**
   * **进度是估出来的那些书**（spec §2.3 第 3 档要求「如实告诉用户」）。
   *
   * 重新解析之后章节少了，原来的章号超出新目录——只能退回最后一章。
   * `restoreProgress` 一直算着 `accurate: false`，而**调用方把它扔了**，
   * 用户那边是「打开书发现位置不对，一句解释都没有」，
   * 而阅读进度是铁律 3 里重扫恢复不了的数据，最容易让人以为丢了。
   *
   * 只记这一档：按标题、按序号那两种是**同一本书里挪了个位置**，不用惊动人。
   */
  progressGuessed: Array<{ title: string; from: number; to: number }>;
}

export function emptyReport(): ScanReport {
  return {
    added: 0, updated: 0, moved: 0, missing: 0, failed: 0, unchanged: 0,
    skipped: {}, otherExts: {}, failures: [], progressGuessed: [],
  };
}

/**
 * 把一个根目录的扫描结果并进总报告。
 *
 * ⚠️ **这个函数存在的唯一理由是「别再漏字段」。**
 *
 * 原来这段合并是手写在 `rpc.ts` 的 `doScan` 里的一串 for 循环，
 * 而它**漏了 `progressGuessed`**：`scanRoot` 一直在往里填、`App.tsx` 一直在
 * 渲染它，中间那一层把它扔了——于是「有 N 本书重新切章之后进度只能估」
 * 那条提示**永远不出现**，而进度是铁律 3 里重扫恢复不了的数据。
 * 加 `otherExts` 的时候差一点第二次踩同一个坑。
 *
 * 搬到这里、挨着类型定义，是让「加字段」和「合并字段」在同一屏里；
 * 再配一条测试逐个字段核对（`scan.test.ts` 搜「每个字段都要参与合并」），
 * 忘了就红。**光靠记性的那种约定，这个仓库已经证明过三次不管用。**
 */
export function mergeReport(总: ScanReport, 一份: ScanReport): void {
  for (const k of ['added', 'updated', 'moved', 'missing', 'failed', 'unchanged'] as const) {
    总[k] += 一份[k];
  }
  // 跳过的理由表按键相加——加一种理由不用改这里
  for (const [reason, n] of Object.entries(一份.skipped)) {
    const k = reason as SkipReason;
    总.skipped[k] = (总.skipped[k] ?? 0) + n;
  }
  for (const [ext, n] of Object.entries(一份.otherExts)) {
    总.otherExts[ext] = (总.otherExts[ext] ?? 0) + n;
  }
  总.failures.push(...一份.failures);
  总.progressGuessed.push(...一份.progressGuessed);
}

/**
 * 文件指纹。小文件整个哈希；大文件用「首 64KB + 尾 64KB + size」的快速指纹，
 * 避免为了判断有没有变动去读几十 MB（spec §1.3）。
 *
 * ponytail: 快速指纹理论上会把「只改了中段、且首尾和大小都不变」的文件判成没变。
 * 追更是往尾部追加，必然改 size，撞不上；真需要严格判据再上全文件哈希。
 */
export async function fingerprint(path: string, size: number): Promise<string> {
  const hash = createHash('sha256').update(`${size}:`);

  if (size <= FINGERPRINT_EDGE * 2) {
    hash.update(await readFile(path));
    return hash.digest('hex');
  }

  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(FINGERPRINT_EDGE);
    await fh.read(buf, 0, FINGERPRINT_EDGE, 0);
    hash.update(buf);
    await fh.read(buf, 0, FINGERPRINT_EDGE, size - FINGERPRINT_EDGE);
    hash.update(buf);
  } finally {
    await fh.close();
  }
  return hash.digest('hex');
}

/**
 * 递归列出候选书。深度和忽略规则都在这里判，不把不该看的文件带给后面。
 *
 * `onSkip` 是必须的一环，不是可选的调试钩子：**跳过必须能报出来**，
 * 见 `ScanReport.skipped`。
 */
export async function* walk(
  root: string,
  opts: {
    recursive: boolean;
    maxDepth: number;
    ignore: string[];
    onSkip?: (r: SkipReason) => void;
    /** 见过但格式不收的文件，按扩展名报一笔（`ScanReport.otherExts`） */
    onOther?: (ext: string) => void;
  },
  dir = root,
  depth = 0,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // 权限不足之类，跳过整个目录而不是让整次扫描失败。
    // **但要数一笔**：整棵子树凭空消失是最需要说出来的一种跳过
    opts.onSkip?.('unreadableDir');
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    // matchesGlob 认正斜杠，Windows 上要先转
    const rel = relative(root, full).split(sep).join('/');
    if (opts.ignore.some((g) => matchesGlob(rel, g))) {
      // 只数文件，不数目录——数目录的话「屏蔽一个有 500 本书的目录」会报成 1
      if (!entry.isDirectory() && isBookFile(entry.name)) opts.onSkip?.('ignored');
      continue;
    }

    if (entry.isDirectory()) {
      if (opts.recursive && depth < opts.maxDepth) yield* walk(root, opts, full, depth + 1);
    } else if (entry.isFile()) {
      if (isBookFile(entry.name)) yield full;
      /*
       * ⚠️ **不收也要数一笔。** 这里原来是 `else if (isFile && isBookFile)`——
       * 不是书就直接落空，一个字都不留。于是「这个格式我们不收」这件事
       * 对用户是完全不可见的：扫描报告只说收了多少，从不说漏了什么。
       *
       * 数的是扩展名不是文件名：要回答的是「要不要收这种格式」。
       */
      else opts.onOther?.(extOf(entry.name) || '(无扩展名)');
    }
  }
}

interface FileRow {
  id: number;
  book_id: number;
  path: string;
  size: number;
  mtime: number;
  content_hash: string | null;
  /** 什么时候解析过。**null 表示从来没有**——那条记录不能走「没变就跳过」那一档 */
  parsed_at: string | null;
}

/**
 * 解析一个 txt，把章节写进库。返回统计信息。
 * `rules` 传自定义规则时取代内置规则（规则编辑器走这条，见 reparse.ts）。
 */
export async function parseAndStore(
  db: DatabaseSync,
  fileId: number,
  path: string,
  /** 调用方显式指定的规则。**不传就去查这本书自己设的那条**（见下） */
  explicit?: ParseRule[],
  forceEncoding?: Encoding,
): Promise<{
  encoding: string;
  chapters: number;
  words: number;
  /**
   * 进度是**估出来的**时（重解析之后章节变少、原来的章号超出新目录），
   * 把「从第几章挪到第几章」报上去。调用方补上书名塞进 `ScanReport.progressGuessed`。
   * 这个函数手里没有报告，所以只能返回——**但绝不能像原来那样直接扔掉**。
   */
  progressGuessed?: { from: number; to: number };
}> {
  /** 进度估出来时记一笔，函数末尾返回给调用方（它才有那份报告） */
  let guessed: { from: number; to: number } | undefined;

  /**
   * **只编目的格式（PDF / EPUB…）到这里就返回。**
   *
   * 不能往下走：`detectEncoding` 会对着 PDF 的二进制打分、`parseChapters`
   * 会在里面找「第一章」——两个都不会报错，只会安静地产出一堆垃圾章节，
   * 而用户点开看到的是乱码。**不解析比解析错好**。
   *
   * 字数留 0：PDF 的字数得先抽文本，那正是我们不做的事。摆一个瞎猜的数字
   * 比空着更糟——它会进排序、进统计、进导出。
   */
  if (formatOf(path) !== 'text') {
    db.prepare('delete from chapter where file_id = ?').run(fileId);
    return { encoding: 'binary', chapters: 0, words: 0 };
  }

  // ponytail: 解析要整本过一遍，这里直接 readFile。几十 MB 的书峰值内存就是文件大小，
  // 一次只处理一本，可接受；真嫌大再改成流式切行。
  const buf = await readFile(path);
  /*
   * **用户手工指定过编码就听他的**（spec §2.1），别再拿探测结果去盖掉。
   *
   * ⚠️ 这句话原来只对**这一次调用**成立：`forceEncoding` 是调用方当场传进来的，
   * 用完就没了，而库里存的是**结果**——分不出「探测出来的」还是「他选的」。
   * 于是这本书一追更、文件被覆盖写入，`scanRoot` 重新探测一遍，
   * **他挑的那个被静默盖掉，又变回乱码**。`encoding_locked` 就是那半句话的凭据。
   */
  const 记着的 = db
    .prepare('select encoding, encoding_locked as locked from book_file where id = ?')
    .get(fileId) as { encoding: string | null; locked: number } | undefined;
  const encoding = forceEncoding
    ?? (记着的?.locked && 记着的.encoding ? (记着的.encoding as Encoding) : undefined)
    ?? detectEncoding(buf).encoding;
  // 这一次是用户当场指定的：记下来，往后别再探测
  if (forceEncoding) db.prepare('update book_file set encoding_locked = 1 where id = ?').run(fileId);
  /*
   * **用户手工设过章节规则就听他的**——和上面那行编码是同一条判断，
   * 只是规则这一半原来没跟上：`rules` 是个可选参数，而**扫描这条路一次都没传**。
   * 后果是「追更覆盖写入 → 重新解析 → 回到自动选」，手配的规则被静默丢掉。
   *
   * 查表放在这里、不放在调用方，理由同 `buildFilter`：**挡一次全护住**。
   * 调用方显式传了就以它为准（规则编辑器点「应用」时传的正是刚选中的那条，
   * 那时候库里还是旧的）。
   */
  const rules = explicit ?? ruleForFile(db, fileId);
  const { chapters } = parseChapters(buf, encoding, rules);
  const text = decodeText(buf, encoding);

  const old = db
    .prepare('select idx, title, offset, length from chapter where file_id = ? order by idx')
    .all(fileId) as Array<{ idx: number; title: string; offset: number; length: number }>;

  // ⚠️ **必须包在一个事务里。** 不包的话每条 insert 都是一个隐式事务，
  // 实测 1000 章要 404 ms，包起来只要 1 ms——**400 倍**。
  // 一个 51 万章的库，光这一项就是三分半的纯等待。
  db.exec('begin');
  try {
    db.prepare('delete from chapter where file_id = ?').run(fileId);
    const insert = db.prepare(
      'insert into chapter(file_id, idx, volume, title, offset, length) values(?,?,?,?,?,?)',
    );
    for (const c of chapters) {
      insert.run(fileId, c.index, c.volume ?? null, c.title, c.offset, c.length);
    }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }

  // 内容变了要保住阅读进度（spec §2.3）
  if (old.length > 0) {
    const bookId = (
      db.prepare('select book_id from book_file where id = ?').get(fileId) as { book_id: number }
    ).book_id;
    // 列名必须在 SQL 里就改成驼峰：库里是 snake_case，Progress 是 camelCase，
    // 直接当对象用会全取到 undefined，再被 `?? 0` 兜成 0——进度悄悄跳回第一章，
    // 不报错、不留痕。这个 bug 真发生过，scan.test.ts 的「追更」那条钉着它。
    const state = db
      .prepare(
        `select chapter_idx as chapterIdx, char_offset as charOffset,
                global_offset as globalOffset, status
           from reading_state where book_id = ?`,
      )
      .get(bookId) as (Progress & { status?: string }) | undefined;

    // **没读过的书没有进度可恢复，一个字都别动。**
    // `reading.save` 会把「想读」推成「在读」（status.test.ts 钉着这条），
    // 所以 status 还是 want 就等于从来没打开过。
    // 不加这条判断的话：重新解析给书前面加了一章「前言」，restoreProgress
    // 会尽职地把「原来在第 0 章」按标题跟到新的第 1 章——逻辑上没错，
    // 但对没读过的书这是无中生有的进度。实测一次重解析给 1891 本没读过的书
    // 写上了 0.1%～0.2% 的进度条
    const untouched = (state?.status === 'none' || state?.status === 'want') && !state.charOffset;

    if (state && !untouched) {
      const oldChapters: Chapter[] = old.map((c) => ({
        index: c.idx,
        title: c.title,
        offset: c.offset,
        length: c.length,
      }));
      const r = restoreProgress(oldChapters, chapters, {
        chapterIdx: state.chapterIdx ?? 0,
        charOffset: state.charOffset ?? 0,
        globalOffset: state.globalOffset ?? 0,
      });
      // percent 是从「第几章 / 共几章」派生的。重新解析会把章节数整个换掉
      // （实测有从 4 章变 1034 章的），不跟着重算就会留下「读到第 3 章、进度 100%」
      // 这种自相矛盾的记录。`finished` 的 100% 是用户按的，不碰。
      const pct =
        state.status === 'finished'
          ? null
          : chapters.length > 0
            ? Math.min(100, ((r.chapterIdx + 1) * 100) / chapters.length)
            : 0;
      db.prepare(
        `update reading_state set chapter_idx = ?, char_offset = ?,
                percent = coalesce(?, percent) where book_id = ?`,
      ).run(r.chapterIdx, r.charOffset, pct, bookId);
      // **估出来的要报上去。** `restoreProgress` 早就算了 `accurate`，
      // 而这里原来把它连同 `by` 一起扔了——见 `ScanReport.progressGuessed`
      if (!r.accurate) guessed = { from: state.chapterIdx ?? 0, to: r.chapterIdx };
    }

    /*
     * **书签和划线也要跟着搬。**
     *
     * 原来只搬 `reading_state`，而 `bookmark` 和 `highlight` 存的是**裸的**
     * `chapter_idx`（见 `db.ts` 的表定义，那里的注释也承认「重新解析后位置
     * 可能对不上」）。重解析把 1949 章变成 546 章之后，每一条书签都指向
     * 一个毫不相干的章节——而这两样和阅读进度一样在铁律 3 里，**重扫恢复不了**。
     *
     * 按**标题**搬，和 `restoreProgress` 同一个口径：标题在新目录里还在就跟过去，
     * 找不到就退回按序号、再夹到合法范围内。划线的 `char_offset` 是章内偏移，
     * 章换了它多半也对不上——那由 `highlight.resolve` 的 `intact` 如实标出来
     * （阅读器会说「这一章有 N 条划线对不上原文了」），这里只负责别让它指向错的章。
     *
     * `old.length === 0` 时不动：那是第一次解析，本来就没有旧序号可言。
     */
    if (old.length > 0) {
      const byTitle = new Map<string, number>();
      chapters.forEach((c, i) => { if (!byTitle.has(c.title)) byTitle.set(c.title, i); });
      const last = Math.max(0, chapters.length - 1);
      const moveTo = (oldIdx: number): number => {
        const t = old[oldIdx]?.title;
        const hit = t === undefined ? undefined : byTitle.get(t);
        return Math.min(hit ?? oldIdx, last);
      };
      for (const table of ['bookmark', 'highlight'] as const) {
        const rows = db.prepare(`select id, chapter_idx as idx from ${table} where book_id = ?`)
          .all(bookId) as unknown as Array<{ id: number; idx: number }>;
        for (const row of rows) {
          const next = moveTo(row.idx);
          if (next !== row.idx) {
            db.prepare(`update ${table} set chapter_idx = ? where id = ?`).run(next, row.id);
          }
        }
      }
    }
  }

  return { encoding, chapters: chapters.length, words: countWords(text), progressGuessed: guessed };
}

/**
 * 扫描一个书库目录，把变化同步进库。
 * 不删除任何用户文件，也不改文件名；记录里消失的文件只标 `missing`，不删记录（spec §1.3）。
 */
export async function scanRoot(
  db: DatabaseSync,
  root: { id: number; path: string; recursive?: boolean; max_depth?: number },
  opts: ScanOptions = {},
): Promise<ScanReport> {
  const report = emptyReport();
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  const minBytes = opts.minBytes ?? MIN_BYTES_DEFAULT;
  const maxBytes = opts.maxBytes ?? Number.MAX_SAFE_INTEGER;

  const seen = new Set<number>();
  /** 「在等文件」的记录，**建一次**。逐个文件现查是 O(n²)，见 manual.ts */
  const fileless = filelessIndex(db);
  let done = 0;

  /** 记一笔「看见了但没收」。加一条理由就是加一次调用，不用扩字段 */
  const skip = (r: SkipReason) => { report.skipped[r] = (report.skipped[r] ?? 0) + 1; };

  for await (const path of walk(root.path, {
    recursive: root.recursive !== false,
    maxDepth: root.max_depth ?? 8,
    ignore,
    onSkip: skip,
    onOther: (ext) => {
      skip('notBook');
      report.otherExts[ext] = (report.otherExts[ext] ?? 0) + 1;
    },
  })) {
    opts.onProgress?.(path, done++);

    try {
      const st = await stat(path);
      // 静默跳过是这个仓库里反复咬人的一条，见 ScanReport.skipped
      if (st.size < minBytes) { skip('tooSmall'); continue; }
      if (st.size > maxBytes) { skip('tooBig'); continue; }
      const mtime = Math.floor(st.mtimeMs);

      const byPath = db.prepare('select * from book_file where path = ?').get(path) as
        | FileRow
        | undefined;

      /*
       * 第 1 档：size + mtime 都没变，连文件都不打开。
       *
       * ⚠️ **「没变过」不等于「解析过」。** 一条从没解析过的记录
       * （`parsed_at is null`）会被这一档**永远跳下去**——而它的 `status`
       * 还是 `'ok'`，于是「需要处理」那一档也看不见它。
       *
       * 真实库里就有一本这样的：7.1 MB 的《超维入侵》，`chapter_count` /
       * `parsed_at` / `encoding` 全是 null，而当场试解析 **204 毫秒切出 1624 章**
       * ——文件一点问题都没有，只是那条记录从来没被喂给解析器，
       * 而每次扫描都因为「没变」跳过它。用户点开看到的是一本没有章节的书。
       */
      if (byPath && byPath.parsed_at && byPath.size === st.size && byPath.mtime === mtime) {
        seen.add(byPath.id);
        report.unchanged++;
        continue;
      }

      const hash = await fingerprint(path, st.size);

      if (byPath) {
        seen.add(byPath.id);
        if (byPath.content_hash === hash && byPath.parsed_at) {
          // 只是时间戳被碰了一下，内容没变（**解析过的才算「没变」**，理由见上面那段）
          db.prepare('update book_file set mtime = ?, size = ? where id = ?').run(
            mtime,
            st.size,
            byPath.id,
          );
          report.unchanged++;
        } else {
          // 第 3 档：内容更新（追更覆盖写入），重新解析并尽量保住进度
          const r = await parseAndStore(db, byPath.id, path);
          db.prepare(
            `update book_file set size = ?, mtime = ?, content_hash = ?, encoding = ?,
                    word_count = ?, chapter_count = ?, status = 'ok',
                    parse_error = null, failed_at = null,
                    parsed_at = datetime('now') where id = ?`,
          ).run(st.size, mtime, hash, r.encoding, r.words, r.chapters, byPath.id);
          if (r.progressGuessed) {
            const t = db.prepare('select b.title from book b join book_file f on f.book_id = b.id where f.id = ?')
              .get(byPath.id) as { title: string } | undefined;
            report.progressGuessed.push({ title: t?.title ?? path, ...r.progressGuessed });
          }
          report.updated++;
        }
        continue;
      }

      // 路径上没记录：先看是不是同一份内容换了位置
      const byHash = db.prepare('select * from book_file where content_hash = ?').get(hash) as
        | FileRow
        | undefined;

      if (byHash) {
        /*
         * ⚠️ **`stat` 抛了不等于那个文件没了。**
         *
         * 这里判的是「同一份内容换了位置吗」：老路径不在了 → 判为移动，
         * **把记录的路径改指到新文件上**。而 `stat` 还会因为别的原因抛——
         * 文件被杀毒软件/看图软件锁着（EBUSY）、权限不对（EACCES/EPERM）、
         * 网络盘抖了一下。那些时候**老文件其实还在**，而记录已经被搬走了：
         * 阅读进度跟着新文件走，老文件下次扫描被当成一本新书重新收进来。
         *
         * 判据和本仓库另外三处一样（`webdav.ts` 的「404 才是真的没有」、
         * 封面的「读不到 ≠ 文件没了」、扫描那条「一整片没看到不等于那些书没了」）：
         * **只有 ENOENT / ENOTDIR 才是「真的没了」**，别的错一律不下结论——
         * 不下结论的代价只是多一条「完全重复」的记录，那是看得见、改得掉的；
         * 而搬错记录是看不见的。
         */
        let gone = false;
        try {
          await (opts.statImpl ?? stat)(byHash.path);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          gone = code === 'ENOENT' || code === 'ENOTDIR';
        }
        if (gone) {
          // 移动/改名：只改路径，元数据和阅读进度原样保留
          db.prepare("update book_file set path = ?, root_id = ?, status = 'ok' where id = ?").run(
            path,
            root.id,
            byHash.id,
          );
          seen.add(byHash.id);
          report.moved++;
          continue;
        }
        // 老路径还在 → 这是内容完全相同的另一个文件（spec §8 的「完全重复」），照新文件收
      }

      // 新书。**先看有没有一条「读过但当时没有文件」的记录在等它**——
      // 用户可以手工添一本读过的书写书评（`addManualBook`），那条记录没有任何文件。
      // 后来把 txt 拷进来时如果不认领，就会多出一本同名的书，而书评还留在旧那条上，
      // 用户看到的是「两本一样的书，其中一本打过分」。认领的口径和 versions.ts
      // 的多版本归组一致：书名作者去空白转小写
      const info = parseFilename(basename(path));
      const bookId = claimFileless(db, info.title, info.author, fileless) ?? Number(
        db
          .prepare('insert into book(title, author) values(?, ?)')
          .run(info.title, info.author ?? null).lastInsertRowid,
      );
      // **不替用户表态。** 扫进来只是「这个文件在库里」，不是「我想读它」
      db.prepare("insert or ignore into reading_state(book_id, status) values(?, 'none')").run(bookId);

      const fileId = Number(
        db
          .prepare(
            `insert into book_file(book_id, root_id, path, size, mtime, content_hash, is_primary)
             values(?,?,?,?,?,?,1)`,
          )
          .run(bookId, root.id, path, st.size, mtime, hash).lastInsertRowid,
      );

      const r = await parseAndStore(db, fileId, path);
      db.prepare(
        `update book_file set encoding = ?, word_count = ?, chapter_count = ?,
                parsed_at = datetime('now') where id = ?`,
      ).run(r.encoding, r.words, r.chapters, fileId);

      seen.add(fileId);
      report.added++;
    } catch (e) {
      // **原因要和状态存在一起。** 只标 parse_failed 不记原因的话，
      // 用户看到「一堆解析失败」却无从下手，回头连我们自己也查不了
      const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      report.failed++;
      report.failures.push({ path, error });
      db.prepare(
        `update book_file set status = 'parse_failed', parse_error = ?,
                failed_at = datetime('now') where path = ?`,
      ).run(error.slice(0, 500), path);
    }
  }

  // 这一轮没见到的记录 → 文件缺失。**只标记，不删**（spec §1.3）
  //
  // **被屏蔽的记录要排除在外。** 扫描会跳过屏蔽掉的文件，于是它们这一轮当然
  // 「没见到」——但文件好端端在磁盘上。不排除的话每次扫描都报一串假的「文件缺失」：
  // 实测这个库 759 个屏蔽记录全被标成 missing，而 759 个文件一个都没少。
  // 用户一旦取消屏蔽，那些书就会顶着「文件缺失」的红字出现，直到下次扫描才恢复。
  /*
   * ⚠️ **有目录读不到的时候，一本都不许标「文件不见了」。**
   *
   * 「没见到」是靠遍历得出来的，而 `walk` 遇到 `readdir` 失败会**静默跳过整棵子树**
   * （只记一笔 `unreadableDir`）。于是**书库根目录本身读不到时**——移动硬盘没插、
   * 网络盘断了、权限被改了——`seen` 是空的，这个循环会把**整个书库**
   * （真实库 8172 本）一口气标成「文件不见了」，书架上一片红字。
   *
   * 数据没丢（插回去再扫一次就恢复），但那是一句**大规模的假话**，
   * 而且用户根本不会把它和「我忘了插硬盘」联系起来。
   *
   * 判据和本仓库另外三处是同一条：**「没答上来」不等于「答了没有」**
   * （`webdav.ts` 的「404 才是真的没有」、封面抓取的「一个源没答，结论就不可信」、
   * `coverDataUrl` 的「读不到 ≠ 文件没了」）。
   * 这里分不出「这个文件没了」和「那一整片我压根没看到」，所以**不下结论**，
   * 只把「有几个目录读不到」照实报出来（`report.skipped.unreadableDir`）。
   */
  if (report.skipped.unreadableDir) {
    return report;
  }

  const known = db
    .prepare(
      `select id, book_id from book_file
        where root_id = ? and status != 'missing' and ifnull(excluded, 0) = 0`,
    )
    .all(root.id) as Array<{ id: number; book_id: number }>;
  for (const { id, book_id } of known) {
    if (!seen.has(id)) {
      db.prepare("update book_file set status = 'missing' where id = ?").run(id);
      report.missing++;
      /*
       * **标完就得看一眼这本书的主文件还能不能用。**
       *
       * 真实库上撞见过：一本书两个文件，磁盘上被删掉的那份**恰好是主文件**，
       * 于是卡片挂着「文件不见了」，而 `book.list` 的 `path` 取的就是主文件——
       * **这本书打不开了**，虽然另一份好好地在磁盘上。
       *
       * `ensurePrimary` 只在主文件真的不可用时才换，用户自己设过的主版本不受影响。
       */
      ensurePrimary(db, book_id);
    }
  }

  return report;
}
