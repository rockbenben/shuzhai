// rpc 白名单（spec §13.1）。
//
// **这一张表同时喂给两个入口**：`contextBridge`（渲染进程）和 `/api/rpc`（AI 工具）。
// 界面能做的 Claude 都能做，走的是同一套校验和安全阀。加方法只在这里加一次。
//
// 命名用 `域.动作`。**凡是会写盘的方法，注释里必须写明写什么**——
// 这些注释就是接口文档，AGENTS.md 只指路到这个文件，不抄第二份。
//
// 这个文件**刻意不 import electron**：那样就没法在普通 Node 测试里跑了。
// 需要 electron 能力的方法（选目录之类）由 main.ts 拼在这张表上。

import { stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { collectStats } from '../server/api.ts';
import type { RpcMethods } from '../server/api.ts';
import { ENCODINGS } from '../core/encoding.ts';
import { getSetting, setSetting } from '../core/db.ts';
import {
  listCategories,
  addCategory,
  removeCategory,
  countBooks,
  bookIdsByFilter,
  titleKeywords,
  listTags,
  tagBooksByFilter,
  planTagByFilter,
  renameTag,
  deleteTag,
  tagBooks,
  untagBooks,
  listBooks,
  shelfCounts,
  repairLibrary,
  listDirs,
  applySerialByDir,
  type SerialDirRule,
  type SortBy,
  saveShelf,
  listShelves,
  removeShelf,
  type Filter,
  formatCounts,
  finishedYears,
} from '../core/library.ts';
import {
  CONFIRM_THRESHOLD,
  previewRename,
  applyRename,
  undoBatch,
  undoableBatches,
  type RenameRow,
} from '../core/rename.ts';
import { scanRoot, emptyReport, mergeReport, type ScanReport, parseMinBytes, MIN_BYTES_KEY } from '../core/scan.ts';
import { addManualBook } from '../core/manual.ts';
import { readChapter, chapterBody, saveProgress, lastRead, markOpened, markFinished, type FileCache } from '../core/reader.ts';
import { previewChapters, suggestForBook, applyRule, clearRule, bookRule } from '../core/reparse.ts';
import { listGroups, setPrimary, mergeBooks, exactDuplicates } from '../core/versions.ts';
import { canDelete, deleteDuplicates, deleteHistory, keepOnly, QUARANTINE_DIR, type TrashFn } from '../core/deletion.ts';
import { suspiciousSplits } from '../core/health.ts';
import { setCover, clearCover, coverDataUrl } from '../core/cover.ts';
import { listFonts, addFont, removeFont } from '../core/fonts.ts';
import {
  loadIgnore, saveIgnore, previewIgnore, validateGlob, globForDir,
  applyIgnoreToLibrary, DEFAULT_IGNORE, NotUnderRoot } from '../core/ignore.ts';
import {
  applyCandidate, isExactMatch, searchSource,
  type Candidate, type SourceConfig,
} from '../core/enrich.ts';
import { BUILTIN_TTS } from '../core/builtin-tts.ts';
import { renderRequest, validEngine } from '../core/tts.ts';
import { convertTheme, looksLikeTheme } from '../core/legado.ts';
import {
  TTS_ENGINES_KEY,
  engineFromDraft,
  importLegadoTts,
  parseEngines,
  serializeEngines,
} from '../core/tts-custom.ts';
import {
  addHighlight, listHighlights, updateNote, removeHighlight, resolveForChapter, notesOf,
  setColor as setHighlightColor,
  colorNames, setColorNames, notedChapters, reanchor,
  type HighlightColor, tagHighlights, untagHighlights } from '../core/highlight.ts';
import { exportEpub, exportTxt, exportNotes, exportAllNotes, exportCsv, exportJson, exportFilename, freeName, pngFromDataUrl } from '../core/export.ts';
import { convertText, bookConvertMode, setBookConvertMode, asMode } from '../core/convert.ts';
import { readOutline, writeOutline, type OutlineItem } from '../core/outline.ts';
// 「这本书能不能对账」要问它——判据只此一份（`book-format.ts`）
import { formatOf } from '../core/book-format.ts';
import { upload, download, type DavConfig } from '../core/webdav.ts';
import {
  addLink,
  listLinks,
  removeLink,
  setPrimaryLink,
  extractUrls,
  checkLinks,
  updateHints,
} from '../core/links.ts';
import { maybeBackup, runBackup, readConfig, lastBackupAt } from '../core/autobackup.ts';
import {
  exportBackup,
  importBackup,
  linkManually,
  type BackupFile,
  type BackupBook,
} from '../core/backup.ts';
import {
  setStatus,
  setStatusByFilter,
  planStatusByFilter,
  restoreStatus,
  type ReadingStatus,
  type StatusSnapshot,
  addBookmark,
  listBookmarks,
  removeBookmark,
  startSession,
  endSession,
  recentBooks,
  setBookmarkNote,
  type StatusPatch,
} from '../core/status.ts';
import {
  searchMeta,
  searchFullText,
  searchInBook,
  buildIndex,
  dropIndex,
  isIndexed,
  indexedBooks,
} from '../core/search.ts';
import {
  listCleanRules,
  addCleanRule,
  removeCleanRule,
  setCleanRuleEnabled,
  loadCleanRules,
  applyWholeRulesDetailed,
  cleanDiff,
  type CleanRule,
} from '../core/clean.ts';
import {
  updateBook,
  batchUpdate,
  previewExtract,
  applyExtract,
  reparseBooks,
  bookDetail,
} from '../core/metadata.ts';

interface RootRow {
  id: number;
  path: string;
  enabled: number;
  recursive: number;
  max_depth: number;
}

function asRecord(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
}

/**
 * 从参数里取一个数。**取不到就当场报错，不许把 NaN 往下传。**
 *
 * 原来一律写 `Number(asRecord(params).tagId)`，而参数名写错时
 * `Number(undefined)` 是 **NaN，不抛错**：`delete from tag where id = NaN`
 * 一行都不匹配，处理函数照样 `return { ok: true }`——**调用方得到「成功」，
 * 而什么都没发生**。这是真踩到的：`tag.delete` 传成 `id`（正确的是 `tagId`），
 * 连着两次「删除成功」，标签一个没少。
 *
 * 这张表对外部工具是开放的（AGENTS.md §13：「你能做的和界面能做的一样多」），
 * 而外部调用方最容易错的就是参数名。静默成功比报错难查得多。
 */
/**
 * 改磁盘文件那个总开关关着时说的话。**三处共用同一句，别各写各的。**
 *
 * 原来是两句：改名那处说「重命名功能已在设置中禁用」，删重复那两处说
 * 「改动磁盘文件的功能已在设置中禁用」——**而开关自己叫「允许改文件名、
 * 允许删除重复文件」**。同一个开关三个名字，用户拿着报错里的词去设置里根本搜不到。
 *
 * 而且「已在设置中禁用」只说了状态，没说去哪儿开。AGENTS.md 那条
 * 「功能名要出现在通往它的那句话里」对报错一样成立——报错是用户唯一
 * 会照着做的那句话。
 */
const DISK_OFF = '「允许改文件名、允许删除重复文件」这个开关关着——在「设置 → 书库」里打开它。';

function num(params: unknown, key: string): number {
  return toNum(asRecord(params)[key], key);
}

/**
 * 把一个参数变成**数字数组**，不是数组就抛一句人话。
 *
 * ⚠️ 这个 helper 是被打包验证逆推出来的：往 `highlight.tag` 发一个空
 * `params`，回来的是 **`Cannot read properties of undefined (reading 'map')`**——
 * 而旁边两个方法回的是「参数 bookId 缺失或者不是数字」。
 * 这个仓库明文反对让实现细节进用户可见的报错（`rpc.ts` 那边的 `humanize`），
 * 而 rpc 是对外开放的（§13）——外部工具少传一个字段就看到一句 JS 内部报错。
 *
 * 当时全库有 **9 处**同一形状的 `(x as number[]).map(Number)`，
 * 包括批量改书、批量重命名、合并——那几条都是**真会写盘的**。
 */
function nums(params: unknown, key: string): number[] {
  const raw = asRecord(params)[key];
  if (!Array.isArray(raw)) throw new Error(`参数 ${key} 缺失或者不是数组`);
  return raw.map((v, i) => toNum(v, `${key}[${i}]`));
}

/** 同上，字符串数组。空白项交给下游自己的规矩收拾（比如 `splitTagNames`） */
function strs(params: unknown, key: string): string[] {
  const raw = asRecord(params)[key];
  if (!Array.isArray(raw)) throw new Error(`参数 ${key} 缺失或者不是数组`);
  return raw.map(String);
}

/**
 * 把一个参数变成数字，**不是数字就抛**。
 *
 * ⚠️ **光判 `Number.isFinite` 不够**：`Number(null)`、`Number('')`、`Number([])`、
 * `Number(false)`、`Number('   ')` **全是 0**，而 0 是个有限数，所以它们全都能过。
 * 后果最重的一处是 `reading.save`——外部工具给一个没设的字段传 JSON `null`，
 * `chapter_idx` 就被写成 0，用户下次打开这本书回到第一章，
 * **而那是铁律 3 里重扫恢复不了的数据**。这正是 `numOpt` 那段注释说要防的事故，
 * 只是漏在了它旁边这个函数上（两个 helper 对同一个 null 的判断当时还不一致）。
 *
 * 判据改成先看**类型**：只收 number，或者去掉空白之后非空的字符串。
 */
function toNum(raw: unknown, key: string): number {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.trim() === '')) {
    throw new Error(`参数 ${key} 缺失或者不是数字`);
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`参数 ${key} 缺失或者不是数字`);
  return v;
}

/**
 * 可选的数字参数：**没传**用默认值，**传了但不是数字**照样报错。
 *
 * `num()` 挡住的是必填参数写错名字，而可选参数原来一律走裸 `Number(x ?? 0)`——
 * 同一个坑的另一半。`node:sqlite` 把 **NaN 静默绑成 NULL**（实测
 * `insert … values(1, NaN)` 存进去是 `null`，不报错、不警告），
 * 于是一个拼错的 `charOffset` 会把列写成 NULL，而读回来时 `?? 0` 又把它兜成 0。
 *
 * 最要紧的是 `reading.save`：它写的是**铁律 3 的数据**。外部工具把
 * `chapterIdx` 写成 `chapterIndex`（AGENTS.md §13 说外部调用方最容易错的就是参数名），
 * 结果是 `chapter_idx = NULL` + 一个成功响应，下次打开这本书回到第一章——
 * 和本文件顶上记的那个 snake_case 事故一模一样的形状，而重扫恢复不了。
 */
function numOpt(params: unknown, key: string, fallback: number): number {
  const raw = asRecord(params)[key];
  if (raw === undefined || raw === null) return fallback;
  return toNum(raw, key);
}

/**
 * 取一个必填的字符串参数。和 `num` 同一条规矩：**取不到就当场报错**。
 *
 * `String(undefined)` 是 **'undefined' 这个字符串**，不抛错——于是原来的
 * `join(String(dir), '书库元数据.csv')` 会拼出
 * `…\036\undefined\书库元数据.csv`，再报一句 ENOENT。调用方看到的是一条
 * 路径里带着 `undefined` 的文件系统错误，**根本猜不到真正的原因是漏传了 dir**。
 * 这是真踩到的：导出的三个方法都这样。
 */
function str(params: unknown, key: string): string {
  const v = asRecord(params)[key];
  if (typeof v !== 'string' || v === '') throw new Error(`参数 ${key} 缺失或者不是字符串`);
  return v;
}

/**
 * 「哪个目录里的书是什么连载状态」的规则，存在设置里，用户自己定。
 * 存坏了不该让扫描挂掉——读不出来就当没配。
 */
function readSerialRules(db: DatabaseSync): { rules: SerialDirRule[]; fallback: string | null } {
  try {
    const raw = getSetting(db, 'library.serialRules');
    const p = raw ? JSON.parse(raw) : {};
    return {
      rules: Array.isArray(p.rules) ? (p.rules as SerialDirRule[]) : [],
      fallback: typeof p.fallback === 'string' ? p.fallback : null,
    };
  } catch {
    return { rules: [], fallback: null };
  }
}

/**
 * **同一时刻只跑一次扫描。**
 *
 * 扫描有**三个互相不知道的入口**：用户点「扫描」、定时扫描（`schedule`）、
 * 文件监听（`watcher`）。而 `scanRoot` 是 async 的、一百多秒——两次撞上就会交错。
 *
 * 当场量的（6 个文件的库，并发跑两次）：
 *
 * | | 结果 |
 * |---|---|
 * | `book_file` | 6 行 ✔ |
 * | **`book`** | **12 行**——六条幻影书，界面上是「只有记录」的重复条目 |
 * | 两次的报告 | 一个说「新增 4 缺失 2」，一个说「新增 2 缺失 4」 |
 * | 而磁盘上 | 六个文件一个没少 |
 *
 * 「缺失」尤其糟：它是**说给用户的一句假话**，而且会把书标红。
 *
 * 判据：**同一片的第二次请求直接跟着那一次**（不重复干活），
 * 不同片的排队。三个入口谁都不用知道别人在跑。
 */
/**
 * 「同一片活同时只干一次」。**两处用它**：扫描、建全文索引。
 *
 * 判据：同一个 `key` 的第二次请求**直接跟着那一次**（不重复干活），
 * 不同 key 的排队。调用方谁也不用知道别人在跑。
 */
const 干活中 = new Map<string, Promise<unknown>>();

async function 只干一次<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const 已经在跑 = 干活中.get(key);
  if (已经在跑) return 已经在跑 as Promise<T>;
  // 别的 key 排在后面：一次只让一件长活动数据库
  const 别人 = [...干活中.values()];
  if (别人.length) await Promise.allSettled(别人);
  const p = fn();
  干活中.set(key, p);
  try {
    return await p;
  } finally {
    if (干活中.get(key) === p) 干活中.delete(key);
  }
}

async function runScan(
  db: DatabaseSync,
  rootId: number | undefined,
  onScanProgress?: (p: { file: string; done: number; root: string }) => void,
): Promise<ScanReport> {
  return 只干一次(`scan:${rootId ?? 'all'}`, () => doScan(db, rootId, onScanProgress));
}

async function doScan(
  db: DatabaseSync,
  rootId: number | undefined,
  onScanProgress?: (p: { file: string; done: number; root: string }) => void,
): Promise<ScanReport> {
  const roots = (
    rootId === undefined
      ? db.prepare('select * from library_root where enabled = 1 order by id').all()
      : [db.prepare('select * from library_root where id = ?').get(Number(rootId))]
  ).filter(Boolean) as unknown as RootRow[];

  const total = emptyReport();
  for (const root of roots) {
    const r = await scanRoot(
      db,
      { id: root.id, path: root.path, recursive: root.recursive !== 0, max_depth: root.max_depth },
      {
        // 用用户配置的屏蔽规则，不是写死的默认值
        ignore: loadIgnore(db),
        // 收录下限也走设置。**默认值不在这儿写**——它和键名一起定义在 `scan.ts`
        minBytes: parseMinBytes(getSetting(db, MIN_BYTES_KEY)),
        // 大库第一次扫要几分钟，没有进度的话界面上只有一个「正在扫描」，
        // 分不清是在干活还是卡死了
        ...(onScanProgress
          ? { onProgress: (file: string, done: number) => onScanProgress({ file, done, root: root.path }) }
          : {}),
      },
    );
    // 合并搬去 `scan.ts` 的 `mergeReport` 了——手写在这里漏过一个字段，
    // 整段理由在那个函数上面
    mergeReport(total, r);
  }
  // 新扫进来的文件默认没标屏蔽，按当前规则修正一遍
  applyIgnoreToLibrary(db);
  // 新书按目录规则补连载状态。**onlyUnknown：只补新书，不覆盖用户手动改过的**
  const serial = readSerialRules(db);
  if (serial.rules.length > 0 || serial.fallback) {
    applySerialByDir(db, serial.rules, serial.fallback, { onlyUnknown: true });
  }
  return total;
}

export function createRpc(
  db: DatabaseSync,
  cache: FileCache,
  userDataDir: string,
  /** 扫描进度回调。HTTP 那头传不了事件，所以是可选的 */
  onScanProgress?: (p: { file: string; done: number; root: string }) => void,
  /** 把文件送进系统回收站。由 main.ts 传 Electron 的 shell.trashItem——
   *  这个文件不 import electron，否则测不了 */
  trash?: TrashFn,
  /**
   * 建全文索引的进度。和扫描那条一样是可选的（HTTP 那头没有事件通道）。
   * **给一本 12046 章的书建索引要 68 秒**，中间一句话不说的话，
   * 用户只能盯着一个不动的「正在建索引…」猜是不是死了。
   */
  onIndexProgress?: (p: { done: number; total: number }) => void,
): RpcMethods {
  /**
   * 这台机器上有哪些在线朗读引擎。
   *
   * `BUILTIN_TTS` 拼在前面是为了**留一个口子**（哪天真有一个我们自己有权
   * 分发的引擎，放那儿就行），它现在是空的；用的那些全在用户自己的库里。
   * 两头都过一遍 `validEngine`——那是「绝不执行配置里的 JS」那条铁律的关口。
   */
  const ttsEngines = () => [
    ...BUILTIN_TTS.filter(validEngine),
    ...parseEngines(getSetting(db, TTS_ENGINES_KEY)),
  ];

  return {
    /** 只读。库概览，和 GET /api/stats 同一份数据 */
    'library.stats': () => collectStats(db),

    /**
     * 只读。读一章正文——按字节偏移定点读，不加载整本书。
     * 返回的 text 是解码后的文本，原文件一个字节都没改。
     */
    'chapter.read': (params) => {
      return readChapter(db, cache, num(params, 'bookId'), num(params, 'idx'));
    },

    /** **写库**：记录阅读进度。百分比由服务端算，调用方不传 */
    'reading.save': (params) => {
      const { atEnd } = asRecord(params);
      return saveProgress(
        db, num(params, 'bookId'), num(params, 'chapterIdx'),
        numOpt(params, 'charOffset', 0), atEnd === true,
      );
    },

    /** 只读。「继续阅读」入口：最近读过的那本 */
    /*
     * PDF / EPUB 查看器专用：只记「这本被打开过」。
     * 它们的进度存在 `app_setting` 的 `viewer.<bookId>` 里，不在 `reading_state`，
     * 于是那张表完全不知道它被打开过——而卡片的「多久前」、默认排序、
     * 侧栏「在读」全从那张表取数。判据和不许碰的那几列写在 `markOpened` 上面。
     */
    'reading.markOpened': (params) => {
      markOpened(db, num(params, 'bookId'));
      return { ok: true };
    },

    /** **写库**：查看器翻到最后一页了。判据和不许碰的那几列写在 `markFinished` 上面 */
    'reading.markFinished': (params) => {
      markFinished(db, num(params, 'bookId'));
      return { ok: true };
    },
    'reading.last': () => lastRead(db),

    /**
     * 只读。试算某条章节规则会切出什么（spec §2.2 的规则编辑器）。
     * **一个字都不写库**——用户拿不准时可以随便试。pattern 省略则用内置规则。
     */
    'chapter.preview': (params) => {
      const { pattern } = asRecord(params);
      return previewChapters(db, num(params, 'bookId'), pattern ? String(pattern) : undefined);
    },

    /**
     * 只读。从这本书自己的正文里猜候选规则，给规则编辑器当起手式。
     *
     * **不是 AI**（铁律 4）：纯统计——把行里的数字归一化成占位符，
     * 数哪种「形状」的短行反复出现，再把形状还原成正则。
     * 详见 `core/suggest.ts`。一个字都不写库
     */
    'chapter.suggest': (params) => suggestForBook(db, num(params, 'bookId')),

    /** **写库**：确认应用某条规则，重新切章并记住这条规则。进度按 spec §2.3 恢复 */
    'chapter.applyRule': (params) => {
      const { pattern } = asRecord(params);
      if (typeof pattern !== 'string' || pattern === '') throw new Error('缺少 pattern');
      return applyRule(db, num(params, 'bookId'), pattern);
    },

    /** **写库**：清掉自定义规则，回到内置规则重新解析 */
    'chapter.clearRule': (params) => clearRule(db, num(params, 'bookId')),

    /** 只读。这本书当前生效的自定义规则 */
    'chapter.rule': (params) => bookRule(db, num(params, 'bookId')),

    // ── 正文字体（用户自己装 ttf/otf，应用不下载任何字体）──────────────

    /** 只读。装了哪些字体。渲染进程据此生成 @font-face 并填进字体下拉 */
    'font.list': () => listFonts(userDataDir),

    /** **写盘**：把字体文件复制进 userData/fonts。同名覆盖 */
    'font.add': (params) => {
      const path = String(asRecord(params).path ?? '');
      if (!path) throw new Error('缺少 path');
      return addFont(userDataDir, path);
    },

    /** **删文件**：卸掉一个字体。只删 fonts 目录里的，见 fonts.ts */
    'font.remove': (params) => removeFont(userDataDir, String(asRecord(params).name ?? '')),

    /** 只读。封面图，返回 data URL。没有封面就是 null */
    'cover.get': (params) => coverDataUrl(db, num(params, 'bookId')),

    /**
     * **写盘（复制到 userData）+ 写库**：设封面。
     * 图片会被复制进 userData/covers——用户多半是从下载目录拖进来的，
     * 那些文件说没就没，只存路径的话封面迟早变空白。
     */
    'cover.set': (params) => {
      const { path } = asRecord(params);
      if (typeof path !== 'string' || !path) throw new Error('缺少 path');
      return setCover(db, userDataDir, num(params, 'bookId'), path);
    },

    /** **写库 + 删文件**：清掉封面。那个文件只被这一处引用 */
    'cover.clear': async (params) => {
      await clearCover(db, num(params, 'bookId'));
      return { ok: true };
    },

    // ── 元数据补全（官网 / 封面 / 分类 / 标签）────────────────────────

    /**
     * 只读。**试算**某条候选能不能对上这本书，不写任何东西。
     * 书名和作者都完全一致才算匹配——张冠李戴地贴上封面和标签，
     * 用户很难发现，发现时已经不知道哪些是错的。
     */
    'enrich.check': (params) => {
      const { bookId, candidate } = asRecord(params);
      const local = db.prepare('select title, author from book where id = ?').get(Number(bookId)) as
        | { title: string; author: string | null }
        | undefined;
      if (!local) throw new Error(`没有这本书：${String(bookId)}`);
      return isExactMatch(local, candidate as Candidate);
    },

    /**
     * **联网 + 写盘 + 写库**：把一条候选应用到这本书上（下封面、加官网地址、
     * 设分类、打标签）。不匹配直接拒绝；本地已有的简介和封面不覆盖。
     */
    'enrich.apply': (params) => {
      const { bookId, candidate, overwriteCover } = asRecord(params);
      return applyCandidate(db, userDataDir, Number(bookId), candidate as Candidate, {
        overwriteCover: Boolean(overwriteCover),
      });
    },

    /**
     * **联网**：用一个配置好的站点搜候选，只搜不写。
     * 不内置主流站点的配置——起点/豆瓣各需专属解析逻辑（见 `cover-fetcher.ts` 和 `cover-source.ts`），
     * 不适合塞进通用的正则配置。这个接口供用户自配站点或与外部工具集成用。
     */
    'enrich.search': (params) => {
      const { source, title } = asRecord(params);
      return searchSource(source as SourceConfig, String(title));
    },


    /** 只读。单本书的完整信息，编辑弹窗用 */
    'book.detail': (params) => bookDetail(db, num(params, 'bookId')),

    /** **写库**：改单本书的元数据。可写字段是白名单，不在表里的一律忽略 */
    'book.update': (params) => {
      const { fields } = asRecord(params);
      updateBook(db, num(params, 'bookId'), asRecord(fields));
      return { ok: true };
    },

    /**
     * 只读。**切得可疑的书**——纯 SQL，不读一个字节的正文。
     *
     * 内置的章节规则会随着版本改好，而库里的书还是当初扫描时算出来的结果。
     * 重新解析这个动作一直有（`book.reparse`），缺的是**知道该对哪几本用**。
     */
    'library.badSplits': () => suspiciousSplits(db),

    /** **写库**：批量改同一批字段（批量设连载状态等） */
    'book.batchUpdate': (params) => {
      const { fields } = asRecord(params);
      return batchUpdate(db, nums(params, 'bookIds'), asRecord(fields));
    },

    /** 只读。从文件名批量提取书名作者的**预览**（spec §3.2），不写库 */
    'book.previewExtract': (params) => {
      const { bookIds } = asRecord(params);
      return previewExtract(db, Array.isArray(bookIds) ? bookIds.map(Number) : undefined);
    },

    /** **写库**：应用提取结果。只写传进来的行，界面上取消勾选的不会到这里 */
    'book.applyExtract': (params) => {
      const { rows } = asRecord(params);
      return applyExtract(db, rows as Array<{ bookId: number; title: string; author: string | null }>);
    },

    /**
     * **读磁盘 + 写库**：批量重新解析。带 encoding 就是「手动指定编码重新解析」
     * （spec §2.1）。不改原文件。
     */
    /**
     * **写库**：重新切章。
     *
     * `encoding` 传一个具体编码 = 用户指定，往后扫描不再探测（记进
     * `book_file.encoding_locked`）；传 `'auto'` = **解锁**，回到自动探测；
     * 不传 = 保持现状。
     */
    'book.reparse': (params) => {
      const { bookIds, encoding } = asRecord(params);
      const enc = encoding === undefined || encoding === null ? undefined : String(encoding);
      /*
       * **认不出来的编码当场拒。** §13 说外部调用方最容易错的就是参数取值，
       * 而这个值会被原样存进 `book_file.encoding` 并且此后被当成「用户指定的」用——
       * 一个拼错的值会**把这本书锁在一个不存在的编码上**。
       */
      if (enc !== undefined && enc !== 'auto' && !(ENCODINGS as readonly string[]).includes(enc)) {
        throw new Error(`不认识的编码「${enc}」。能用的是 ${ENCODINGS.join(' / ')}，或者 auto（回到自动探测）`);
      }
      return reparseBooks(
        db,
        nums(params, 'bookIds'),
        enc as Parameters<typeof reparseBooks>[2],
      );
    },

    /**
     * 只读。书列表，可带筛选条件（spec §7）。
     * 筛选的翻译只有 `library.ts` 的 `buildFilter` 一处——列表、智能书架都走它，
     * 抄成两份就会出现「书架说 12 本、智能书架说 9 本」而两边各自都说得通。
     */
    'book.list': (params) => {
      const { filter, limit, offset, sort } = asRecord(params);
      return listBooks(db, (filter as Filter) ?? {}, {
        limit: limit === undefined ? undefined : Number(limit),
        offset: offset === undefined ? undefined : Number(offset),
        sort: sort as SortBy | undefined,
      });
    },

    /**
     * **写库**：修一致性问题——删掉没有任何文件的空记录、给没有主版本的书指一个。
     * **只删没有进度也没有书签的**：那两样重扫恢复不了。
     */
    'library.repair': () => repairLibrary(db),

    /** 只读。书库的目录树，侧栏拿它做「只看某个目录」 */
    'library.dirs': () => listDirs(db),

    /**
     * 按目录批量设连载状态（规则存在 `library.serialRules`，用户自己定）。
     * 传 `dryRun` 只算不写——8000 本的改动，界面上先摆出来给人看一眼。
     */
    'library.applySerial': (params) => {
      const p = asRecord(params);
      return applySerialByDir(
        db,
        (p.rules as SerialDirRule[]) ?? [],
        (p.fallback as string | null) ?? null,
        { dryRun: Boolean(p.dryRun), onlyUnknown: Boolean(p.onlyUnknown) },
      );
    },

    /** 只读。侧栏计数。一条 group by，不要把全部书拉回前端再数 */
    'book.counts': (params) => {
      // 带上当前的横向筛选（目录），否则选了目录之后侧栏数字和列表对不上
      const { scope } = asRecord(params ?? {});
      return shelfCounts(db, (scope as Filter | undefined) ?? {});
    },

    /** 只读。当前筛选条件命中多少本。**不是已加载的数量**——书架分页之后
     *  那个数字永远是 120，而批量打标签作用于整个筛选结果 */
    /**
     * **写库**：手工添一本「读过但本地没有文件」的书。
     *
     * 用户对这个应用的模型是两部分——书评是主体、本地文件是可选的。
     * 这条记录**不建任何 book_file**，它本身就是「我读过它」。
     * 以后扫描到同名同作者的 txt 会自动认领它（见 core/manual.ts）。
     * 同名同作者已存在时返回已有的那本，不新建
     */
    /*
     * **写库**：手工添一本读过的书。
     *
     * 评分短评一起传进来，由 core 决定怎么落——认领到已有的一本时
     * **它自己有的那一半不覆盖**（见 `manual.ts` 的 `applyReview`）。
     * 原来是界面先 addManual 再 setStatus 两句：那样旧评价会被直接盖掉，
     * 而判据落在渲染进程里，走 rpc 进来的人绕得过去。
     */
    'book.addManual': (params) => {
      const { title, author, rating, comment } = asRecord(params);
      return addManualBook(
        db,
        String(title ?? ''),
        author == null ? null : String(author),
        { rating: rating as number | null | undefined, comment: comment as string | null | undefined },
      );
    },

    /** 只读。库里每种格式各有多少本——分类那个「格式」筛选只列真的存在的那几种 */
    'book.formatCounts': () => formatCounts(db),

    /**
     * 只读。库里出现过哪几个「读完年份」，各多少本。同上一条：只列真的有的那几年。
     * 年份口径走 `library.ts` 的 `YEAR_SQL`（带 `localtime`，别另写 strftime）
     */
    'book.finishedYears': () => finishedYears(db),

    'book.matchCount': (params) => ({
      n: countBooks(db, (asRecord(params ?? {}).filter as Filter | undefined) ?? {}),
    }),

    /**
     * 只读。筛选结果的 id 列表，**一列都不多取**。
     *
     * 批量改名要先出预览（spec §3.3），所以它必须把 id 拿回渲染进程——
     * 但只需要 id。原来走 `book.list` 是把 19 个列 × 整个结果集都传回去，
     * 8172 本时约 1.3 MB JSON，拿完扔掉其余全部。
     */
    'book.idsByFilter': (params) => bookIdsByFilter(
      db, (asRecord(params ?? {}).filter as Filter | undefined) ?? {},
    ),

    /** 只读。某本书的章节目录 */
    'book.chapters': (params) => {
      const { bookId } = asRecord(params);
      const rows = db
        .prepare(
          `select c.idx, c.volume, c.title, c.offset, c.length
             from chapter c
             join book_file f on f.id = c.file_id
            where f.book_id = ? and f.is_primary = 1
            order by c.idx`,
        )
        .all(Number(bookId)) as unknown as Array<{ title: string | null; volume: string | null }>;
      /*
       * **章名和卷名也要跟着繁简走。**
       *
       * 正文是运行时转的，而这张表里存的是原文那一版。不转的话：
       * 一本显示成繁体的书，**目录整列还是简体**，而正文和章标题是繁体——
       * 目录那个搜索框更别扭：看着繁体的书，得输简体才搜得到。
       *
       * ⚠️ 转的是**给人看的那两列**，`idx` / `offset` / `length` 一个都不动：
       * 那三样是定位用的，跟着字形变就全乱了（划线的偏移正是按它们算的）。
       */
      const 模式 = bookConvertMode(db, Number(bookId));
      if (模式 === 'off') return rows;
      return rows.map((r) => ({
        ...r,
        title: r.title == null ? r.title : convertText(r.title, 模式),
        volume: r.volume == null ? r.volume : convertText(r.volume, 模式),
      }));
    },

    // ── 朗读（spec §6）────────────────────────────────────────────

    /**
     * 只读。可用的在线朗读引擎。系统语音不在这个表里——它在渲染进程直接调。
     *
     * **发布出去的应用这一列是空的**（`BUILTIN_TTS` 现在没有条目，理由写在
     * `tts-custom.ts` 顶上）：在线引擎会把正文发到第三方服务器，那是用户自己
     * 的选择，不该由我们替他预置一份陌生人的服务器名单。
     */
    'tts.engines': () => ttsEngines(),

    /**
     * 从「阅读」（legado）的 `httpTTS.json` 导一批引擎进来，**存进这台机器
     * 自己的库**。返回「导进来几个 / 拒了几个」——静默丢掉的话，用户会以为
     * 导进来了，然后在某个引擎上听到一片安静。
     */
    'tts.importFile': async (params) => {
      const path = String(asRecord(params).path ?? '');
      if (!path) throw new Error('没给文件路径。先用 ui.pickTtsFile 让用户选一个');
      const { engines, skipped, dropped } = importLegadoTts(await readFile(path, 'utf-8'));
      const 原有 = ttsEngines();
      const 有了 = new Set(原有.map((e) => e.id));
      const 新的 = engines.filter((e) => !有了.has(e.id));
      setSetting(db, TTS_ENGINES_KEY, serializeEngines([...原有, ...新的]));
      return { added: 新的.length, existed: engines.length - 新的.length, skipped, dropped };
    },

    /**
     * 手填一个引擎。**导入是成批的，这条是一条一条填的**——
     * 用户手上只有一个地址、没有 legado 的配置文件时走这儿。
     *
     * 校验在核心（`engineDraftError`），报错是**给人看的一句话**：
     * 哪一格、错在哪儿、该改成什么。rpc 对外开放（§13），
     * 闸放这儿走接口的人也一样拦得住。
     */
    'tts.addEngine': (params) => {
      const p = asRecord(params);
      const draft = {
        name: String(p.name ?? ''),
        url: String(p.url ?? ''),
        double: !!p.double,
        contentType: p.contentType === undefined ? undefined : String(p.contentType),
      };
      const r = engineFromDraft(draft);
      if ('error' in r) throw new Error(r.error);

      const { engine: e, dropped } = r;
      const 原有 = ttsEngines();
      if (原有.some((x) => x.id === e.id)) {
        throw new Error(`已经有一个叫「${e.name}」的了。换个名字，或者先把那个删掉`);
      }
      setSetting(db, TTS_ENGINES_KEY, serializeEngines([...原有, e]));
      // 丢了哪几格要报出去——同导入那条，不说的话用户以为语速滑块坏了
      return { id: e.id, name: e.name, dropped };
    },

    /** 删掉一个自己加的引擎。用户加的，用户能删 */
    'tts.removeEngine': (params) => {
      const id = String(asRecord(params).id ?? '');
      const 原有 = ttsEngines();
      const 剩下 = 原有.filter((e) => e.id !== id);
      setSetting(db, TTS_ENGINES_KEY, serializeEngines(剩下));
      return { removed: 原有.length - 剩下.length, left: 剩下.length };
    },

    /**
     * **发网络请求**：取一段音频回来。
     *
     * 为什么走主进程而不是渲染进程直接 fetch：跨域会被 CORS 挡（这些第三方
     * 服务不会给我们发 CORS 头），而且 AGENTS.md 规定网络 I/O 在主进程。
     *
     * ⚠️ 这一步**会把正文发到第三方服务器**。调用方（界面）必须已经告知用户。
     * **只认这台机器上已经存着的那几个引擎**——不接受调用方传进来的任意 URL，
     * 否则这个端点就成了「让任何人拿应用当代理」的洞（rpc 也对 HTTP 开放）。
     */
    'tts.fetch': async (params) => {
      const { engineId, text } = asRecord(params);
      const engine = ttsEngines().find((e) => e.id === String(engineId));
      if (!engine || !validEngine(engine)) throw new Error(`没有这个朗读引擎：${String(engineId)}`);

      const body = String(text ?? '').trim();
      if (!body) throw new Error('没有要朗读的文字');
      if (body.length > 500) throw new Error('这一段太长，念不了——正常走界面不会出现，朗读会先把长段切开');

      // **必须退避重试。** 念一章要发几十次请求，实测连着打同一台服务器会撞限流
      // （429）和超时——第一次做可用性测试时就是这么把 88 个能用的引擎误判成 52 个的。
      // 不重试的话，用户听到的是「念着念着突然换成系统语音」
      const { url, init } = renderRequest(engine, body);
      let r: Response | undefined;
      let last = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((ok) => setTimeout(ok, 600 * 2 ** attempt));
        try {
          r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
          if (r.ok) break;
          // 429 要说人话。写「朗读服务返回 429」用户根本不知道那是什么，
          // 而这是最容易碰上的一种失败——连着念几十段就会撞上
          last = r.status === 429 ? '这个朗读服务限流了，歇一会儿再试' : `朗读服务返回 ${r.status}`;
          if (r.status !== 429 && r.status < 500) break; // 4xx（除限流）重试也没用
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
        }
      }
      if (!r?.ok) throw new Error(last || '朗读服务连不上');

      const ct = r.headers.get('content-type') ?? engine.contentType;
      if (!/audio/i.test(ct)) throw new Error(`朗读服务没返回音频（${ct}），多半是这个服务挂了`);

      const buf = Buffer.from(await r.arrayBuffer());
      // 一百来字节的多半是错误页而不是音频，放出来是一声爆响
      if (buf.length < 2000) throw new Error('朗读服务返回的内容太短，不是音频');
      // 回渲染进程只能走可结构化克隆的数据，直接给 data URL 最省事
      return { dataUrl: `data:${ct.split(';')[0]};base64,${buf.toString('base64')}` };
    },

    /**
     * 从「阅读」（legado）导出的主题文件里转一张纸色出来。
     *
     * **只转不存**：存在哪儿是渲染进程的事（`settings.ts` 的
     * `saveImportedThemes`）——那一族本来就归它管，而且 `colorThemes()`
     * 要同步读。这里只做「读文件 + 认得出的转过去」。
     *
     * 转换放主进程是为了**别把 `legado.ts` 打进渲染包**：那个文件带着一整套
     * Java 正则翻译，渲染进程一个字都用不上。
     */
    'theme.importFile': async (params) => {
      const path = String(asRecord(params).path ?? '');
      if (!path) throw new Error('没给文件路径。先用 ui.pickThemeFile 让用户选一个');
      let data: unknown;
      try {
        data = JSON.parse(await readFile(path, 'utf-8'));
      } catch {
        throw new Error('这不是一份 JSON。「阅读」里导出的主题是一个 .json 文件');
      }
      const list = Array.isArray(data) ? data : [data];
      const themes = list.filter(looksLikeTheme).map(convertTheme);
      // **认不出的要数出来**：静默丢掉的话，用户以为导进来了、然后在下拉里找不着
      return { themes, skipped: list.length - themes.length };
    },

    // ── 目录屏蔽（spec §1.1）──────────────────────────────────────

    /** 只读。当前的屏蔽规则，外加默认值供「恢复默认」用 */
    'ignore.get': () => ({ patterns: loadIgnore(db), defaults: DEFAULT_IGNORE }),

    /**
     * 只读。**试算**这批规则会挡掉哪些已入库的书。
     * 不能省：glob 少一个星号就可能从「挡一个子目录」变成「什么都没挡」，
     * 而扫描报告里看不出区别——被挡掉的书只是不再更新，不会报错。
     */
    'ignore.preview': (params) => {
      const { patterns } = asRecord(params);
      return previewIgnore(db, (patterns as string[]) ?? loadIgnore(db));
    },

    /** **写库**：保存屏蔽规则。**只影响以后的扫描，一本书都不删** */
    'ignore.set': (params) => {
      const list = (asRecord(params).patterns as string[]) ?? [];
      for (const p of list) validateGlob(p);
      saveIgnore(db, list);
      // 立刻把新规则落到每个文件的 excluded 位上，书架马上就变
      const applied = applyIgnoreToLibrary(db);
      return { ok: true, patterns: loadIgnore(db), ...applied };
    },

    /** 只读。把用户选中的子目录转成一条规则 */
    'ignore.globForDir': (params) => {
      const { dir } = asRecord(params);
      const roots = db.prepare('select path from library_root').all() as unknown as Array<{ path: string }>;
      for (const r of roots) {
        try {
          return { pattern: globForDir(r.path, String(dir)), root: r.path };
        } catch (e) {
          // **只吞「不在这个根下面」**，试下一个根。别的错（比如文件夹名里的
          // `{…,…}` 表达不了）必须原样抛出去——吞掉的话用户看到的是一句
          // 说的不是真正那一样的话
          if (!(e instanceof NotUnderRoot)) throw e;
        }
      }
      throw new Error('这个文件夹不在任何书库文件夹下面');
    },

    /** **写库**：启用/停用一个书库目录。停用只是不再扫，**书和进度都留着** */
    'root.setEnabled': (params) => {
      const { enabled } = asRecord(params);
      db.prepare('update library_root set enabled = ? where id = ?').run(enabled ? 1 : 0, num(params, 'id'));
      // 停用一个目录 = 它下面的书从书架上消失（但一本都没删）
      return { ok: true, ...applyIgnoreToLibrary(db) };
    },

    /** 只读。书库目录列表 */
    'root.list': () => db.prepare('select * from library_root order by id').all(),

    /**
     * **写库**（不碰磁盘文件）：登记一个书库目录。
     * 路径必须已存在且是目录——记一个不存在的路径只会让后面每次扫描都白跑。
     */
    /**
     * **登记一个书库目录，顺手把这个目录里的书收进来。**
     *
     * 扫描放在这一层而不是界面上：**「加了目录但没扫」等于没加**，而这条流程
     * 界面上有两个入口（空书架的引导、「书库文件夹」里的按钮），外部工具走 HTTP
     * 还有第三个。放在界面里就得写三份，而少写一份的症状是「从这里加的目录会扫、
     * 从那里加的不扫」——不报错，typecheck 也过。
     *
     * **只扫新加的这个 root**：全库重扫在 8172 本的库上要几分钟，
     * 而这次只是想收几个新文件。
     */
    'root.add': async (params) => {
      const { path } = asRecord(params);
      if (typeof path !== 'string' || path === '') throw new Error('缺少 path');
      const st = await stat(path).catch(() => null);
      // 两种情况分开说：路径根本不在，和「在，但那是个文件不是文件夹」。
      // 一句「不存在」对后者是假的——用户看着那个文件明明在那儿，会以为程序坏了
      if (!st) throw new Error(`这个文件夹不存在：${path}`);
      if (!st.isDirectory()) throw new Error(`这是个文件，不是文件夹：${path}`);

      db.prepare('insert or ignore into library_root(path) values(?)').run(path);
      const root = db.prepare('select * from library_root where path = ?').get(path) as unknown as RootRow;
      const report = await runScan(db, root.id, onScanProgress);
      return { ...root, report };
    },

    /**
     * **写库**（不碰磁盘文件）：移除书库目录的登记。
     * 只删 `library_root` 这一行，**书和阅读进度都留着**——用户可能只是想换个目录管理，
     * 而进度是重扫恢复不了的东西。
     */
    /**
     * **写库**：把一个书库文件夹的登记移掉。书和阅读进度都留着（`root_id` 置空）。
     *
     * **但那些记录从此谁也管不到**：扫描遍历不到它们，连「文件缺失」都标不上，
     * 于是它们在书架上装作一切正常，点开才报 ENOENT
     * （本文件「`root.remove` 会留下谁也管不到的孤儿记录」那节记的就是这个）。
     * 这个库里那个文件夹装着 8172 本——一次误点就是整个书库进入这种状态。
     *
     * 所以：**这个文件夹底下还有书的时候，必须显式确认过**。
     * 空文件夹（刚加错了路径想撤掉）不用问。
     * 同 `tag.delete` / `tag.rename` 那两道闸。
     */
    'root.remove': (params) => {
      const { confirmed } = asRecord(params);
      const id = num(params, 'id');
      const n = (db.prepare('select count(*) n from book_file where root_id = ?').get(id) as { n: number }).n;
      if (n > 0 && confirmed !== true) {
        throw new Error(
          `这个文件夹底下有 ${n} 个文件。移掉登记之后它们谁也管不到——`
          + '扫描遍历不到，文件没了也标不上，点开才报错。'
          + '（书和阅读进度都还在，把文件夹加回来重新扫描就能认领回去。）'
          + '确认要移的话，带上 confirmed: true 再发一次。',
        );
      }
      db.prepare('update book_file set root_id = null where root_id = ?').run(id);
      db.prepare('delete from library_root where id = ?').run(id);
      return { ok: true, orphaned: n };
    },

    /**
     * **读磁盘 + 写库**：扫描全部启用的目录。不修改任何 txt。
     * 返回各目录的报告合并结果（spec §1.4）。
     */
    'library.scan': (params) => runScan(db, ((p) => (p === undefined ? undefined : Number(p)))(asRecord(params).rootId), onScanProgress),

    // ── 重命名（spec §3.3）：唯一会改用户磁盘文件的一组方法 ──────────────

    /** 只读。试算重命名结果，**不碰任何文件**。界面据此标色、逐行可取消勾选 */
    'rename.preview': (params) => {
      const { bookIds, template, placeholder, onConflict } = asRecord(params);
      if (typeof template !== 'string' || template === '') throw new Error('缺少 template');
      return previewRename(db, nums(params, 'bookIds'), {
        template,
        placeholder: placeholder ? String(placeholder) : undefined,
        onConflict: onConflict === 'number' ? 'number' : 'skip',
      });
    },

    /**
     * **真改磁盘文件**。只接受 preview 产出的行，逐个执行，一个失败不影响其它；
     * 每成功一个立刻更新 book_file.path 并写 rename_log。
     *
     * 总开关在这里挡，不在界面里挡——只挡界面的话这条 rpc 就是后门。
     */
    'rename.apply': (params) => {
      if (getSetting(db, 'rename.enabled') !== '1') {
        throw new Error(DISK_OFF);
      }
      const { rows, batchId, confirmed } = asRecord(params);
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('没有要改名的行——先用 rename.preview 算一遍，把要改的那几行传进来。');
      /*
       * **超过阈值要显式确认过——这条原来只活在界面里。**
       *
       * spec §3.3 把「超 50 个二次确认」列为安全阀，而 `CONFIRM_THRESHOLD`
       * 在 core 里**只有一个声明，从来没被用过**：真正拦人的是
       * `RenameDialog` 自己抄的第二份。于是走 rpc 进来（§13 明说这条路对外开放）
       * 改五百个文件，一道确认都没有。
       *
       * 本文件别处写着「rpc……安全阀（预览、`rename_log`、二次确认）也照样跑」——
       * **那句话对二次确认当时是假的**。现在让它成真：超阈值必须带
       * `confirmed: true`，而那个标记的意思是「我已经把预览摆给人看过了」。
       * 报错里要说清怎么办，别只说「被拒了」。
       */
      if (rows.length > CONFIRM_THRESHOLD && confirmed !== true) {
        throw new Error(
          `这一批有 ${rows.length} 个文件，超过 ${CONFIRM_THRESHOLD} 个要先确认。`
          + '先用 rename.preview 把改名结果摆出来核对，确认无误再带上 confirmed: true 重发。'
          + '（改错了只有最近 20 批能撤销，超出这个窗口就找不回来了）',
        );
      }
      const id = typeof batchId === 'string' && batchId ? batchId : `batch-${Date.now()}`;
      return applyRename(db, cache, rows as RenameRow[], id);
    },

    /** 只读。可撤销的批次，最近的在前（最多 20 批） */
    'rename.undoable': () => undoableBatches(db),

    /** **真改磁盘文件**：按日志逆序把一批改名撤回去 */
    'rename.undo': (params) => {
      /*
       * ⚠️ **撤销也是真的在改磁盘文件**（`undoBatch` → `fs.rename`），
       * 所以它一样要过总开关。原来这里没有：`rename.apply` /
       * `version.deleteFiles` / `version.keepOnly` 三处都挡了，只有它漏了——
       * 关掉「允许改文件名」之后，`POST /api/rpc {"method":"rename.undo"}`
       * 照样能把文件改回去。`rename.apply` 上面那句注释说的
       * 「只挡界面的话这条 rpc 就是后门」，这里就是那个后门。
       */
      if (getSetting(db, 'rename.enabled') !== '1') {
        throw new Error(DISK_OFF);
      }
      const { batchId } = asRecord(params);
      if (typeof batchId !== 'string') throw new Error('缺少 batchId');
      return undoBatch(db, cache, batchId);
    },

    // ── 分类 / 标签 / 智能书架（spec §3.1 / §7）────────────────────────

    'category.list': () => listCategories(db),

    /** **写库**：新建分类 */
    'category.add': (params) => {
      const { name, parentId } = asRecord(params);
      return addCategory(db, String(name), parentId === undefined ? null : Number(parentId));
    },

    /** **写库**：删分类。子分类跟着删，**书一本都不会删**，只是回到未分类 */
    'category.remove': (params) => {
      removeCategory(db, num(params, 'id'));
      return { ok: true };
    },

    /** **写库**：给一批书设分类 */
    'category.assign': (params) => {
      const { bookIds, categoryId } = asRecord(params);
      const ids = nums(params, 'bookIds');
      for (const id of ids) {
        db.prepare("update book set category_id = ?, updated_at = datetime('now') where id = ?").run(
          categoryId === null || categoryId === undefined ? null : Number(categoryId),
          id,
        );
      }
      return { updated: ids.length };
    },

    /** 只读。从书名里挖出的高频词，给「批量打标签」当起手式。
     *  **不是 AI**——数 n-gram 而已，见 core/library.ts 的 titleKeywords */
    'library.titleKeywords': () => titleKeywords(db),

    'tag.list': () => listTags(db),

    /** **写库**：批量打标签。标签不存在会自动建 */
    'tag.add': (params) => {
      const { bookIds, names } = asRecord(params);
      return tagBooks(db, nums(params, 'bookIds'), strs(params, 'names'));
    },

    /**
     * **写库**：给**整个筛选结果**打标签（个人评价体系，
     * 见 specs/2026-08-14-personal-reviews-design.md）。
     *
     * 圈书在主进程做，前端只给筛选条件——书架是分页的（一次 120 本），
     * 前端手上根本没有第 121 本以后的 id。
     * 返回的 `bookIds` 是**实际新增关联**的那些，界面拿它做「撤销」。
     */
    /**
     * 只读：打标签之前先看会给哪几本**新增**关联。
     *
     * **别拿 `book.matchCount` 当这个数**——圈中 268 本、其中 200 本已经有这个
     * 标签时，真正会变的只有 68 本。预览和执行要共用同一份判定。
     */
    'tag.planByFilter': (params) => {
      const { filter, names } = asRecord(params);
      return planTagByFilter(db, (filter ?? {}) as Filter, (names ?? []) as string[]);
    },

    'tag.addByFilter': (params) => {
      const { filter, names } = asRecord(params);
      if (!Array.isArray(names) || names.length === 0) throw new Error('缺少 names');
      return tagBooksByFilter(db, (filter ?? {}) as Filter, names as string[]);
    },

    /**
     * **写库**：改标签名。目标名已存在时就是合并。
     *
     * **合并要显式确认过**——它不可撤销（两个标签变成一个，`book_tag` 的行
     * 并过去就回不来了，和删除同一档）。界面上有一道确认，
     * 而**安全阀只活在界面里就等于没有**：rpc 对外开放（§13），
     * 外部工具一句 `tag.rename` 就能悄悄并掉两个标签。
     * 同 `rename.apply` 那条二次确认（第 46 轮记着，形状一模一样）。
     *
     * 只是改个不存在的名字不用确认——那只是改名，改回去就是了。
     */
    'tag.rename': (params) => {
      const { name, confirmMerge } = asRecord(params);
      const tagId = num(params, 'tagId');
      const want = String(name).trim();
      const hit = db.prepare('select id, name from tag where name = ?').get(want) as
        | { id: number; name: string }
        | undefined;
      if (hit && hit.id !== tagId && confirmMerge !== true) {
        const n = (db.prepare('select count(*) n from book_tag where tag_id = ?').get(hit.id) as { n: number }).n;
        throw new Error(
          `「${want}」已经有了（${n} 本书），改成它就是把两个标签合并——而合并不能撤销。`
          + '确认要合并的话，带上 confirmMerge: true 再发一次。',
        );
      }
      return renameTag(db, tagId, String(name));
    },

    /** **写库**：删标签，连同它在书上的关联 */
    /**
     * **写库**：删标签，连同它在书上的关联。
     *
     * **打在书上的标签删掉就没了**：`book_tag` 的行没有日志、没有撤销
     * （删除文件那条路好歹进回收站，这条连回收站都没有）。
     * 界面上有两段式确认，而**安全阀只活在界面里就等于没有**——
     * §13 那句「rpc 的方法表就是渲染进程的白名单，安全阀也照样跑」
     * 对它原来是假的：外部工具传错一个 tagId，几百本书上的标签就没了。
     *
     * 同 `rename.apply` 的二次确认、`tag.rename` 的合并闸，这是第三处。
     * **空标签不用确认**：删掉一个没打在任何书上的标签，什么都不会丢。
     */
    'tag.delete': (params) => {
      const { confirmed } = asRecord(params);
      const tagId = num(params, 'tagId');
      const n = (db.prepare('select count(*) n from book_tag where tag_id = ?').get(tagId) as { n: number }).n;
      if (n > 0 && confirmed !== true) {
        const t = db.prepare('select name from tag where id = ?').get(tagId) as { name: string } | undefined;
        throw new Error(
          `「${t?.name ?? tagId}」还打在 ${n} 本书上，删掉就从这些书上一起摘了，而且没有撤销。`
          + '确认要删的话，带上 confirmed: true 再发一次。',
        );
      }
      deleteTag(db, tagId);
      return { ok: true };
    },

    /** **写库**：批量取消某个标签 */
    'tag.remove': (params) => {
      untagBooks(db, nums(params, 'bookIds'), num(params, 'tagId'));
      return { ok: true };
    },

    // ── 正文清洗（spec §2.4）：运行时套用，原文件不动 ──────────────────

    /** 只读。规则列表。内置规则带 builtin 标记，只能启停不能删 */
    'clean.list': () => listCleanRules(db),

    /**
     * 只读。某一章的清洗 diff 预览（spec §2.4 要求「左右对比清洗前后的某一章」）。
     * 只返回**有变化**的行——整章都列出来的话用户根本找不到改了哪儿。
     */
    /**
     * 净化预览。
     *
     * **整章规则原来在预览里完全不体现**：`cleanDiff` 走的是 `cleanLines`，
     * 而那个函数第一行就把 `r.whole` 的规则滤掉了。于是唯一一条会大段删除的
     * 规则（「作者的话（删到章尾）」）打开之后，预览显示「没有变化」——
     * 看起来像规则没生效，而真实阅读里它删掉的是整整一截。
     * 现在先跑整章规则再做行 diff，**和 `cleanText` 同一个顺序**。
     *
     * `rejected` 是 40% 缩水保护跳过的规则名。它一直算得好好的，
     * 而唯一的消费者 `applyWholeRules` 直接 `.text` 把它扔了——
     * 用户写了条规则、它被安全阀挡下、然后什么都没说。
     */
    'clean.preview': async (params) => {
      const { bookId, idx, rules } = asRecord(params);
      const chapter = await readChapter(db, cache, Number(bookId), Number(idx ?? 0), true);
      const effective = (rules as CleanRule[]) ?? loadCleanRules(db, Number(bookId));
      const whole = applyWholeRulesDetailed(chapter.text, effective);
      return {
        title: chapter.title,
        diff: cleanDiff(whole.text, effective),
        rejected: whole.rejected,
        wholeRemoved: chapter.text.length - whole.text.length,
      };
    },

    /** **写库**：新增一条自定义清洗规则 */
    'clean.add': (params) => {
      const { name, pattern, replacement, scope, bookId } = asRecord(params);
      return addCleanRule(db, {
        name: String(name),
        pattern: String(pattern),
        replacement: replacement === undefined ? '' : String(replacement),
        scope: scope === 'book' ? 'book' : 'global',
        bookId: bookId === undefined ? undefined : Number(bookId),
      });
    },

    /** **写库**：删一条自定义规则。内置的删不掉，只能停用 */
    'clean.remove': (params) => {
      removeCleanRule(db, num(params, 'id'));
      return { ok: true };
    },

    /** **写库**：启停一条规则（内置和自定义都走这条） */
    'clean.setEnabled': (params) => {
      const { enabled } = asRecord(params);
      setCleanRuleEnabled(db, num(params, 'id'), Boolean(enabled));
      return { ok: true };
    },

    'shelf.list': () => listShelves(db),

    /** **写库**：把一条筛选规则存成分类。存的是**规则不是结果**——
     *  库里新收一本符合规则的书，它自己就进这个分类，不用再归一次 */
    'shelf.save': (params) => {
      const { name, filter, id } = asRecord(params);
      return saveShelf(db, String(name), (filter as Filter) ?? {}, id == null ? undefined : num(params, 'id'));
    },

    'shelf.remove': (params) => {
      removeShelf(db, num(params, 'id'));
      return { ok: true };
    },

    // ── 阅读状态 / 书签 / 会话（spec §5）───────────────────────────

    /** **写库**：改阅读状态、评分、短评、弃坑原因。读完后再开读会自动记一次重读 */
    'reading.setStatus': (params) => {
      const { bookId: _drop, ...patch } = asRecord(params);
      setStatus(db, num(params, 'bookId'), patch as StatusPatch);
      return { ok: true };
    },

    /**
     * **写库**：按整个筛选结果改阅读状态（不是当前加载的那 120 本）。
     *
     * 和 `tag.addByFilter` 同一个形状。返回里带着「改之前是什么」，
     * 撤销走 `reading.restoreStatus`。「已读完」的书一律不动，理由见 `status.ts`。
     */
    'reading.setStatusByFilter': (params) => {
      const { filter, status } = asRecord(params);
      return setStatusByFilter(db, (filter ?? {}) as Filter, status as ReadingStatus);
    },

    /**
     * 只读：批量改状态之前先看会改哪几本。
     *
     * **预览必须走这条，别拿 `book.list` 凑**——那个按当前排序取前 N 本，
     * 而默认排序把「动过的书」排最前，那批恰恰一本都不会改。
     */
    'reading.planStatusByFilter': (params) => {
      const { filter, status } = asRecord(params);
      return planStatusByFilter(db, (filter ?? {}) as Filter, status as ReadingStatus);
    },

    /** **写库**：撤销上一次批量改状态。收 `setStatusByFilter` 原样返回的 changed */
    'reading.restoreStatus': (params) => {
      const { rows } = asRecord(params);
      if (!Array.isArray(rows)) throw new Error('缺少 rows');
      return restoreStatus(db, rows as StatusSnapshot[]);
    },

    /** **写库**：加书签。书签独立于阅读进度，不会改「读到哪儿了」 */
    'bookmark.add': (params) => {
      const { charOffset, excerpt, note } = asRecord(params);
      return addBookmark(db, num(params, 'bookId'), num(params, 'chapterIdx'), {
        charOffset: numOpt(params, 'charOffset', 0),
        excerpt: excerpt === undefined ? undefined : String(excerpt),
        note: note === undefined ? undefined : String(note),
      });
    },

    'bookmark.list': (params) => {
      const { bookId } = asRecord(params);
      return listBookmarks(db, bookId === undefined ? undefined : Number(bookId));
    },

    /** **写库**：给一条书签写/改笔记。这一列原来全应用没地方写得进去 */
    'bookmark.setNote': (params) => {
      const { note } = asRecord(params);
      setBookmarkNote(db, num(params, 'id'), note === undefined || note === null ? null : String(note));
      return { ok: true };
    },

    /** 带笔记的要 `confirmed: true`，理由和 `tag.delete` 一样，判据在 `status.ts` */
    'bookmark.remove': (params) => {
      const { confirmed } = asRecord(params);
      return removeBookmark(db, num(params, 'id'), { confirmed: confirmed === true });
    },

    // ── 划线与笔记（spec §5.1）：只存位置和一小段摘录，不存正文 ──────

    /** **写库**：加一条划线。可以同时带笔记 */
    'highlight.add': (params) => {
      const { bookId, chapterIdx, charOffset, length, excerpt, note, color, cfi, rect } = asRecord(params);
      return addHighlight(db, {
        bookId: num(params, 'bookId'),
        chapterIdx: num(params, 'chapterIdx'),
        charOffset: num(params, 'charOffset'),
        length: num(params, 'length'),
        excerpt: String(excerpt ?? ''),
        note: note === undefined ? undefined : String(note),
        color: color === undefined ? undefined : (String(color) as HighlightColor),
        // EPUB 的锚点。txt 那条路不传它，走 `charOffset` + `length`
        cfi: cfi === undefined ? undefined : String(cfi),
        // **PDF 的矩形摘录**（扫描页 / 插图那种）。归一化坐标，校验在 `addHighlight` 里
        rect: rect === undefined ? undefined : String(rect),
      });
    },

    'highlight.list': (params) => {
      const { bookId, chapterIdx } = asRecord(params);
      return listHighlights(
        db,
        bookId === undefined ? undefined : Number(bookId),
        chapterIdx === undefined ? undefined : Number(chapterIdx),
      );
    },

    /**
     * 只读。**书签也要对账**——和划线同一条判据。
     *
     * 书签存的也是「章号 + 章内偏移」加一段 `excerpt`，正文变过（换章节规则、
     * 开关净化、切繁简）之后那个偏移就指到别的句子上了。而面板原来只管照原样
     * 显示 `excerpt`、跳转按旧偏移走——**跳过去落在哪儿谁也不知道，一句话都没有**。
     * 更糟的是它旁边印着按**现在**的切分算出来的章名：一个自信但错误的标签。
     *
     * 判据抄划线那份：**不猜也不删，只标 `intact`**，由界面照实说明。
     *
     * 代价是每个「有书签的章」读一次正文（同一章只读一次）。
     * 这个面板是点开才加载的，而一本书的书签通常只有几条——
     * 真有几百条时那是几百次定点读，`FileCache` 的句柄是复用的，实测见 AGENTS.md。
     */
    'bookmark.resolve': async (params) => {
      const bookId = num(params, 'bookId');
      const marks = listBookmarks(db, bookId);
      /*
       * ⚠️ **PDF / EPUB 这一档根本对不了账，一律当作对得上。**
       *
       * 对账是拿存下来的摘录去和「那个位置的正文」比，而正文靠 `readChapter`——
       * 那一整套（章节表、字节偏移）只有纯文本书有。查看器那两种格式走到这儿
       * 必然 `catch` 到空串，于是**每一条书签都被判成「对不上」**，
       * 面板上一片橙色警告，而书签其实好好的。
       *
       * 处置照抄下面那一行早就写着的原则：**别把「不知道」说成「错了」**。
       */
      const 主文件 = db
        .prepare('select path from book_file where book_id = ? and is_primary = 1')
        .get(bookId) as { path?: string } | undefined;
      const 能对账 = formatOf(主文件?.path ?? null) === 'text';
      const byChapter = new Map<number, string>();
      const out = [];
      for (const m of marks) {
        if (!能对账) { out.push({ ...m, intact: true }); continue; }
        if (!byChapter.has(m.chapter_idx)) {
          try {
            const ch = await readChapter(db, cache, bookId, m.chapter_idx);
            const body = chapterBody(ch);
            byChapter.set(m.chapter_idx, body);
          } catch {
            // 章节读不出来（文件没了、章号越界）——那也是「对不上」，不是崩
            byChapter.set(m.chapter_idx, '');
          }
        }
        const body = byChapter.get(m.chapter_idx) ?? '';
        const ex = m.excerpt ?? '';
        out.push({
          ...m,
          // 没存摘录的老书签无从对账，当作「对得上」——**别把「不知道」说成「错了」**
          intact: !ex || body.slice(m.char_offset, m.char_offset + ex.length) === ex,
        });
      }
      return out;
    },

    /**
     * 只读。把某章的划线对到当前正文上，并核对有没有漂移。
     * 漂了只标 `intact: false`——**不猜也不删**，认错位置比不认更糟。
     */
    'highlight.resolve': async (params) => {
      const { bookId, chapterIdx } = asRecord(params);
      const ch = await readChapter(db, cache, Number(bookId), Number(chapterIdx));
      const body = chapterBody(ch);
      return resolveForChapter(db, Number(bookId), Number(chapterIdx), body);
    },

    /**
     * **写库**：把这一章里漂了的划线重新对上（在新正文里找回那段字）。
     * 只改「不多不少正好一处」的那些，判据在 `highlight.ts` 的 `reanchor` 上
     */
    'highlight.reanchor': async (params) => {
      const { bookId, chapterIdx } = asRecord(params);
      // 取正文这一路和 `highlight.resolve` 一模一样——两边算的必须是同一段字，
      // 差一个标题就整体偏掉，那时候「修好了」比「没修」还糟
      const ch = await readChapter(db, cache, Number(bookId), Number(chapterIdx));
      const body = chapterBody(ch);
      // 转换那一路在这儿注进去：`highlight.ts` 是渲染进程也引的文件，
      // 不能让它 import `convert.ts`（那会把 opencc 拖进渲染包）
      const 模式 = bookConvertMode(db, Number(bookId));
      return reanchor(db, Number(bookId), Number(chapterIdx), body, (t) => convertText(t, 模式));
    },

    /** **写库**：改一条划线的笔记 */
    'highlight.setNote': (params) => {
      const { id, note } = asRecord(params);
      updateNote(db, num(params, 'id'), note === null || note === undefined ? null : String(note));
      return { ok: true };
    },

    /** 同上，判据在 `highlight.ts` */
    /** **写库**：改一条划线的颜色。认不出的颜色会报错，不会悄悄换成黄的 */
    'highlight.setColor': (params) => {
      setHighlightColor(db, num(params, 'id'), str(params, 'color'));
      return { ok: true };
    },

    /**
     * 只读：每种颜色现在代表什么。三个阅读界面和笔记面板都从这儿取，
     * 别再各自硬编码一份（原来抄了三份，判据写在 `highlight.ts` 的 `COLOR_NAMES` 上）
     */
    /**
     * **给笔记打标签**（迁移 23）。颜色只有四个，用途一多就不够分。
     * 标签词表和书的那套**共用 `tag` 表**，改名 / 合并 / 删除走同一个标签管理器。
     */
    'highlight.tag': (params) => {
      return tagHighlights(db, nums(params, 'ids'), strs(params, 'names'));
    },
    'highlight.untag': (params) => {
      untagHighlights(db, nums(params, 'ids'), num(params, 'tagId'));
      return { ok: true };
    },
    /**
     * **自建目录**（迁移 24）。很多 PDF 根本没有 outline，
     * 那时候一本几百页的书在应用里没有任何导航。
     * 校验在 `writeOutline` 里（页码、名字长度、条数）。
     */
    'outline.get': (params) => readOutline(db, num(params, 'bookId')),
    'outline.set': (params) => {
      const { items } = asRecord(params);
      return writeOutline(db, num(params, 'bookId'), (items ?? []) as OutlineItem[]);
    },

    'highlight.colorNames': () => colorNames(db),

    /** **写库**：改颜色的用途。传整份，没提到的颜色退回默认名 */
    'highlight.setColorNames': (params) => {
      setColorNames(db, asRecord(params));
      return colorNames(db);
    },

    /**
     * 只读：这本书哪几章有笔记、各几条（划线 + 书签）。目录靠它标记号。
     * 回来的是**只含有笔记那几章**的一张表，不是全章节——判据在 `notedChapters` 上
     */
    'notes.chapters': (params) => notedChapters(db, num(params, 'bookId')),

    'highlight.remove': (params) => {
      const { confirmed } = asRecord(params);
      return removeHighlight(db, num(params, 'id'), { confirmed: confirmed === true });
    },

    /** 只读。笔记面板：只列写了笔记的那些 */
    'highlight.notes': (params) => {
      const { bookId } = asRecord(params);
      return notesOf(db, bookId === undefined ? undefined : Number(bookId));
    },

    /** **写库**：开始/结束一次阅读会话（spec §5.2，供「最近在读」用） */
    'session.start': (params) => startSession(db, num(params, 'bookId')),
    'session.end': (params) => {
      endSession(db, num(params, 'id'));
      return { ok: true };
    },

    /** 只读。最近在读 */
    'reading.recent': (params) => recentBooks(db, Number(asRecord(params).limit ?? 10)),

    // ── 搜索（spec §7 / §6）─────────────────────────────────────────

    /** 只读。书名/作者/别名/标签。不需要索引，随时能用 */
    'search.meta': (params) => searchMeta(db, String(asRecord(params).query ?? '')),

    /** 只读。正文全文。没建索引会明确报错，而不是假装没结果 */
    'search.fullText': (params) => searchFullText(db, String(asRecord(params).query ?? '')),

    /** 只读。书内搜索，**不依赖全文索引**（spec §6） */
    'search.inBook': (params) => {
      const { bookId, query } = asRecord(params);
      return searchInBook(db, cache, Number(bookId), String(query ?? ''));
    },

    /** 只读。索引开着没有 */
    'search.indexed': () => isIndexed(db),

    /** 只读。哪些书建了正文索引 */
    'search.indexedBooks': () => indexedBooks(db),

    /**
     * **写库**：给指定的书建正文索引。这是唯一会把正文写进数据库的地方
     * （spec §7 允许，且可删）。**原 txt 只读打开，一个字节都不改。**
     *
     * ⚠️ **必须传 bookIds。** 不传就是全库，而实测这个库有 653 万章——
     * 要跑几小时、索引好几 GB，界面上按一下就再也回不来了。
     * 全库那条路只留给小库和测试，不从界面暴露。
     */
    'search.buildIndex': async (params) => {
      const { bookIds } = asRecord(params);
      const ids = Array.isArray(bookIds) ? bookIds.map(Number).filter(Number.isFinite) : [];
      if (ids.length === 0) throw new Error('要指定给哪些书建索引');
      // 进度接上去。**`search.ts` 里那个 onProgress 一直是传 undefined 的**——
      // 钩子写好了没人接，和 `fellBack`、`finished` 是同一个形状
      /*
       * **并发建同一本书会让 FTS 行数翻倍**（当场量的：2 章的书，
       * 并发建两次之后 chapter_fts 有 4 行，于是那本书里每次搜索都出双份）。
       * 「重复建不翻倍」那条判据只在**顺序**建时成立——它是「先删这本书的旧条目
       * 再插」，两次交错时两边都先删了、再各插一遍。
       * 界面上那是个按钮，双击就并发了。
       */
      return 只干一次(
        `index:${ids.join(',')}`,
        () => buildIndex(db, cache, onIndexProgress && ((done, total) => onIndexProgress({ done, total })), ids),
      );
    },

    /** **写库**：删索引，省空间。不传 bookIds 就全清 */
    'search.dropIndex': (params) => {
      const { bookIds } = asRecord(params ?? {});
      const ids = Array.isArray(bookIds) ? bookIds.map(Number).filter(Number.isFinite) : undefined;
      dropIndex(db, ids);
      return { ok: true };
    },

    // ── 多版本归组（spec §8）：只归组、不删不移任何文件 ────────────────

    'version.groups': () => listGroups(db),
    'version.duplicates': () => exactDuplicates(db),

    /** 只读。这个文件能不能删，以及删了之后哪些副本还在。**不改任何东西** */
    'version.canDelete': (params) => canDelete(db, num(params, 'fileId')),

    /**
     * **把文件移入系统回收站**并清掉记录。
     *
     * 这是 spec §0.1「移动和删除仍然不做」的例外，由用户明确要求。所以安全阀最严：
     * 一律走回收站（不是真删）、必须有内容相同的副本还在磁盘上、
     * 不能删一本书的最后一个文件、回收站那步失败就一个字都不动数据库。
     * 总开关沿用「允许重命名磁盘文件」那一个——都是改用户文件的能力。
     */
    'version.deleteFiles': (params) => {
      if (getSetting(db, 'rename.enabled') !== '1') {
        throw new Error(DISK_OFF);
      }
      if (!trash) throw new Error('这个环境下拿不到回收站，拒绝删除');
      const ids = (asRecord(params).fileIds as number[]) ?? [];
      // 说法和 core 那道校验保持一字不差——同一件事两种说法，用户看到哪句取决于走了哪条路
      if (!ids.length) throw new Error('没有要删的文件');
      // 同 `version.keepOnly`：默认不给暂存区，回收站收不下就照旧记成失败
      return deleteDuplicates(
        db, ids.map(Number), trash,
        asRecord(params).quarantineIfNoTrash === true ? join(userDataDir, QUARANTINE_DIR) : undefined,
      );
    },

    /**
     * **写盘（回收站）+ 写库**：一组重复里只留一份。
     *
     * 合并记录 + 设主版本 + 其余移入回收站，一步做完。界面上原来要点五下
     * （合并 / 选主 / 逐个勾删 / 按钮 / 确认），而且「合并成一本」点完看不出
     * 任何变化——组里还是两个文件。安全阀一条没绕：还是 `deleteDuplicates`。
     */
    'version.keepOnly': (params) => {
      if (getSetting(db, 'rename.enabled') !== '1') {
        throw new Error(DISK_OFF);
      }
      if (!trash) throw new Error('这个环境下拿不到回收站，拒绝删除');
      const drop = (asRecord(params).dropFileIds as number[]) ?? [];
      /*
       * ⚠️ **暂存区只能由界面上的第二次点击带过来，默认不给。**
       *
       * 铁律 1 的「一律送回收站」仍然是默认路径。这一档是给**回收站根本不存在**的
       * 地方留的（网络共享上实测 `shell.trashItem` 抛 `Failed to perform delete operation`）。
       * **搬进暂存区不是真删**：文件还在磁盘上、还能拿回来，30 天没人动才清。
       */
      const 暂存 = asRecord(params).quarantineIfNoTrash === true
        ? join(userDataDir, QUARANTINE_DIR) : undefined;
      return keepOnly(db, num(params, 'keepFileId'), drop.map(Number), trash, 暂存);
    },

    /** 只读。被送进回收站的历史。找回要去回收站，这边只负责记账 */
    'version.deleteHistory': () => deleteHistory(db),

    /** **写库**：指定主版本。阅读进度挂在 book 上，换主版本不会丢 */
    'version.setPrimary': (params) => {
      setPrimary(db, num(params, 'fileId'));
      return { ok: true };
    },

    /** **写库**：把被当成多本的同名书合并成一本。优先保留有进度的那本 */
    'version.merge': (params) =>
      mergeBooks(db, nums(params, 'bookIds')),

    // ── 在线地址（spec §4）：只管地址，不抓正文，不做在线阅读 ────────────

    'link.list': (params) => {
      const { bookId } = asRecord(params);
      return listLinks(db, bookId === undefined ? undefined : Number(bookId));
    },

    /** **写库**：加一条在线地址。站点名从域名自动推断 */
    'link.add': (params) => {
      const { bookId, url, note, selector, isPrimary } = asRecord(params);
      return addLink(db, num(params, 'bookId'), String(url), {
        note: note === undefined ? undefined : String(note),
        selector: selector === undefined ? undefined : String(selector),
        isPrimary: Boolean(isPrimary),
      });
    },

    /** **写库**：从一段粘贴的文本里批量导入网址 */
    'link.addBatch': (params) => {
      const { bookId, text } = asRecord(params);
      const urls = extractUrls(String(text ?? ''));
      for (const url of urls) addLink(db, num(params, 'bookId'), url);
      return { added: urls.length, urls };
    },

    'link.remove': (params) => {
      removeLink(db, num(params, 'id'));
      return { ok: true };
    },

    'link.setPrimary': (params) => {
      setPrimaryLink(db, num(params, 'id'));
      return { ok: true };
    },

    /**
     * **联网 + 写库**：探活并（配了正则的）抓最新章节标题。
     * 同域名串行、间隔 ≥2 秒；失败静默记录，不弹窗（spec §4）。
     */
    'link.check': (params) => {
      const { bookId, ua, timeoutMs } = asRecord(params);
      const links = listLinks(db, bookId === undefined ? undefined : Number(bookId));
      return checkLinks(db, links, {
        ua: ua === undefined ? undefined : String(ua),
        timeoutMs: timeoutMs === undefined ? undefined : Number(timeoutMs),
      });
    },

    /** 只读。哪些书有更新（远端最新章在本地目录里找不到） */
    'link.updates': () => updateHints(db),

    // ── 导出（spec §9）：**只往导出目录写新文件，绝不碰原 txt** ──────────

    /**
     * **写盘（新文件）**：导出 EPUB 到 `dir`。用已解析的章节结构生成，
     * 默认套用清洗规则——导出的内容该和读到的一致。
     */
    'export.epub': async (params) => {
      const { bookId, dir, template, fromIdx, toIdx, clean } = asRecord(params);
      const meta = db.prepare('select title, author from book where id = ?').get(Number(bookId)) as
        | { title: string; author: string | null }
        | undefined;
      if (!meta) throw new Error(`没有这本书：${String(bookId)}`);

      const buf = await exportEpub(db, cache, Number(bookId), {
        fromIdx: fromIdx === undefined ? undefined : Number(fromIdx),
        toIdx: toIdx === undefined ? undefined : Number(toIdx),
        clean: clean !== false,
      });
      const name = exportFilename(String(template ?? '{author} - {title}'), meta, '.epub');
      // **绝不覆盖**：判据和理由在 `core/export.ts` 的 `freeName`
      const target = freeName(str(params, 'dir'), name);
      await writeFile(target, buf);
      return { path: target };
    },

    /**
     * **写盘（新文件）**：把这本书的划线、笔记、书签导成 markdown。
     *
     * 和另外两个「写盘」一样走 `freeName`——**绝不覆盖**（判据在 `core/export.ts`）。
     * 导出来的 `.md` 放回书库目录再扫一次就是一本能读的书（`TEXT_EXT` 里有 md）。
     */
    /**
     * **写盘（新文件）**：把 PDF 上框选的那一块存成 PNG。
     *
     * 图是**渲染进程画好送过来的**（pdf.js 只在那边，理由写在
     * `core/export.ts` 的 `pngFromDataUrl` 上），这里只负责校验和落盘。
     *
     * ⚠️ **库里仍然只存四个坐标**（铁律 2）——这是用户显式要的导出，
     * 和 `export.notes` 同一类动作；同样走 `freeName`，**绝不覆盖**。
     */
    'highlight.exportImage': async (params) => {
      const { dataUrl, template } = asRecord(params);
      const h = db
        .prepare('select h.chapter_idx as page, h.rect, b.title, b.author from highlight h join book b on b.id = h.book_id where h.id = ?')
        .get(num(params, 'id')) as { page: number; rect: string | null; title: string; author: string | null } | undefined;
      if (!h) throw new Error('没有这条划线');
      if (!h.rect) throw new Error('这条不是框选——文字划线没有“那一块”可导');
      const buf = pngFromDataUrl(String(dataUrl ?? ''));
      const name = exportFilename(
        String(template ?? '{title}（第' + String(h.page) + '页）'),
        { title: h.title, author: h.author },
        '.png',
      );
      const target = freeName(str(params, 'dir'), name);
      await writeFile(target, buf);
      return { path: target };
    },

    'export.notes': async (params) => {
      const bookId = num(params, 'bookId');
      const meta = db.prepare('select title, author from book where id = ?').get(bookId) as
        | { title: string; author: string | null }
        | undefined;
      if (!meta) throw new Error(`没有这本书：${String(bookId)}`);
      const 文 = exportNotes(db, bookId);
      /*
       * ⚠️ **模板不能长得像「书名 - 作者」。** 原来是 `{title} - 笔记`，
       * 而这份 md 放回书库再扫一次就是一本书——`parseFilename` 按 ` - ` 切，
       * **作者当场变成「笔记」**（实测扫出来的那本作者写着「笔记 (2)」，
       * 括号里那个 2 还是 `freeName` 防覆盖加的）。
       * 换成括号：整串都留在书名里，扫出来是「某某书（笔记）」，自己说清自己是什么。
       */
      const name = exportFilename(String(asRecord(params).template ?? '{title}（笔记）'), meta, '.md');
      const target = freeName(str(params, 'dir'), name);
      await writeFile(target, 文, 'utf8');
      return { path: target };
    },

    /**
     * **写盘（新文件）**：把**全库**的笔记导成一份 markdown。
     *
     * 文件名不带书名作者那种形状（同 `export.notes` 上面那条判据）：
     * 这份 md 放回书库再扫一次就是一本书，叫「我的笔记」正合适。
     */
    'export.allNotes': async (params) => {
      const target = freeName(str(params, 'dir'), '我的笔记.md');
      await writeFile(target, exportAllNotes(db), 'utf8');
      return { path: target };
    },

    /** **写盘（新文件）**：按章节区间导出 txt */
    'export.txt': async (params) => {
      const { bookId, dir, template, fromIdx, toIdx, clean } = asRecord(params);
      const meta = db.prepare('select title, author from book where id = ?').get(Number(bookId)) as
        | { title: string; author: string | null }
        | undefined;
      if (!meta) throw new Error(`没有这本书：${String(bookId)}`);

      const text = await exportTxt(db, cache, Number(bookId), {
        fromIdx: fromIdx === undefined ? undefined : Number(fromIdx),
        toIdx: toIdx === undefined ? undefined : Number(toIdx),
        clean: clean !== false,
      });
      const name = exportFilename(String(template ?? '{author} - {title}'), meta, '.txt');
      const target = freeName(str(params, 'dir'), name);
      await writeFile(target, text, 'utf8');
      return { path: target };
    },

    /** **写盘（新文件）**：元数据导出 CSV / JSON */
    'export.meta': async (params) => {
      const { dir, format } = asRecord(params);
      const csv = format !== 'json';
      const target = freeName(str(params, 'dir'), csv ? '书库元数据.csv' : '书库元数据.json');
      await writeFile(target, csv ? exportCsv(db) : exportJson(db), 'utf8');
      return { path: target };
    },

    // ── 备份与恢复（spec §10）：不可再生数据的唯一保险 ─────────────────

    /** 只读。导出备份对象，由调用方决定写到哪个文件 */
    'backup.export': () => exportBackup(db),

    /**
     * **写库**：导入备份。按 hash 优先、路径次之关联本地文件；
     * 关联不上的**不会凭空建书**，而是列出来让用户手动指认。
     */
    'backup.import': (params) => importBackup(db, asRecord(params).backup as BackupFile),

    /** 只读。自动备份的配置和上次备份时间 */
    'backup.autoConfig': () => ({ ...readConfig(db), lastAt: lastBackupAt(db) }),

    /** **写盘（新文件）**：立刻备份一次到配置的目录，并按保留份数清理旧的 */
    'backup.runAuto': () => runBackup(db, readConfig(db), new Date()),

    /** **写库**：从磁盘上的备份文件恢复。读文件这一步在这里做，界面只传路径 */
    'backup.importFile': async (params) => {
      const { path } = asRecord(params);
      if (typeof path !== 'string' || !path) throw new Error('缺少 path');
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, 'utf8'));
      } catch (e) {
        throw new Error(`读不了这个备份文件：${e instanceof Error ? e.message : String(e)}`);
      }
      return importBackup(db, parsed as BackupFile);
    },

    /** **写库**：把某本关联不上的备份记录手动指认到一本已有的书上 */
    /*
     * **写库**：把备份里认不回来的那一本手工指到某本书上。
     *
     * 这条路**没有界面入口**（`unmatched` 在恢复报告里只是告知），是给外部工具的（§13）——
     * 所以返回值要说清搬回了什么，别只回一句 `{ ok: true }`：
     * 调用方看不见界面，那个报告就是它唯一的反馈。
     */
    'backup.link': (params) => {
      const { backupBook } = asRecord(params);
      return linkManually(db, backupBook as BackupBook, num(params, 'bookId'));
    },

    // ── M4 可选项（spec §2.5 / §10）────────────────────────────────

    /** 只读。这本书的繁简显示模式。默认「原文」 */
    'convert.get': (params) => bookConvertMode(db, num(params, 'bookId')),

    /** **写库**：设置某本书显示为原文/简体/繁体。运行时转换，不改原文件 */
    'convert.set': (params) => {
      // bookId 走 num()，**不要写 Number(bookId)**：取不到时 Number(undefined) 是 NaN，
      // 于是写出一个 convert.book.NaN 的键还返回 ok:true——模式写错会报错、id 写错
      // 却静默成功，正是 num() 自己那段注释里记着的那个事故形状
      setBookConvertMode(db, num(params, 'bookId'), asMode(asRecord(params).mode));
      return { ok: true };
    },

    /**
     * 只读。试转一段文本，给设置界面做预览。
     *
     * ⚠️ **模式走 `asMode` 当场验**：不验的话拼错一个模式名会**原样退回原文**，
     * 和「这段本来就不用转」长得一模一样（`convert.ts` 的 `asMode` 上记着这次）。
     * 界面那两处调用都裹着 try/catch、转不了就维持原文，报错不连累读书。
     */
    'convert.preview': (params) => {
      const { text, mode } = asRecord(params);
      return convertText(String(text ?? ''), asMode(mode));
    },

    /**
     * **联网 + 写盘**：把备份上传到 WebDAV。远端比本地底稿新时会先存一份冲突副本
     * 再覆盖（spec §10：最后写入优先 + 保留冲突副本）。
     */
    'webdav.upload': async (params) => {
      const { url, username, password, device, remoteNewerThan } = asRecord(params);
      const json = JSON.stringify(exportBackup(db));
      return upload({ url: String(url), username: String(username), password: String(password) } as DavConfig, json, {
        device: device === undefined ? undefined : String(device),
        remoteNewerThan: remoteNewerThan === undefined ? undefined : String(remoteNewerThan),
      });
    },

    /** **联网**：把远端备份取回来。**只下载不导入**——导入要用户确认 */
    'webdav.download': async (params) => {
      const { url, username, password } = asRecord(params);
      return download({ url: String(url), username: String(username), password: String(password) } as DavConfig);
    },

    /** 只读。读一项设置 */
    'setting.get': (params) => getSetting(db, String(asRecord(params).key)),

    /** **写库**：改一项设置 */
    'setting.set': (params) => {
      const { key, value } = asRecord(params);
      setSetting(db, String(key), String(value));
      return { ok: true };
    },
  };
}
