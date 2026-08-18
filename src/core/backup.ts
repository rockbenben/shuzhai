// 备份与恢复（spec §10）。
//
// **这是不可再生数据的唯一保险。** 阅读进度、书签、**划线和上面的笔记**、
// **阅读会话**、评分短评、弃坑原因——重新扫描一样都恢复不了。
// （划线和阅读会话一度都不在这句话里，也不在备份里：那两张表是后来加的，
// 而这句列表没跟着更新——**少带一样，用户要到恢复完才发现**。
// **加一张存用户输入或历史的表时，这句话和下面的导出/恢复要一起改。**）
//
// **`highlight_tag`（笔记的标签，迁移 23）带。** 不单列一段，而是跟在每条划线的
// `tags` 里——**存的是名字不是 id**：恢复到另一个库上 `tag.id` 根本对不上，
// 而名字是用户自己打的字（书的标签在备份里本来就是名字，同一个形状）。
//
// ⚠️ **`rename_log` 有意不带**，虽然铁律 3 说它不可再生：它的每一行都带着
// `file_id` 和**绝对路径**，换一台机器（或者重扫之后 id 变了）那些行既没法撤销、
// 也指不到任何东西。**不可再生 ≠ 可移植**，这是两件事。
// 同理不带的还有 `library_root`（路径要用户自己重新指）、
// `cover_fetch`（重抓就有，只是慢）、`delete_log`（本机的操作流水）。
//
// 所以这个模块的判据只有一条：
// **宁可备份里多带点东西，也不能少带。**
//
// 反过来，能重新算出来的一律不带：章节索引（重解析就有）、全文索引（重建就有）、
// 文件大小和 mtime（stat 一下就有）。带上它们只会让备份文件变大、
// 并且在恢复时制造「以谁为准」的麻烦。
//
// 关联方式是 **hash 优先、路径次之**（spec §10）：用户很可能已经整理过文件夹，
// 路径变了但内容没变，hash 能认回来；反过来同名不同内容的文件不该被认成同一本。

import type { DatabaseSync } from 'node:sqlite';
import { bookKey } from './versions.ts';
import { normalizeTagNames, tagIdFor } from './library.ts';
import { COLORS, 解析矩形, tagsOfHighlights } from './highlight.ts';
import { READING_STATUS_IDS, asFinite, asText, asWhen } from './status.ts';
import { sqlTime } from './format.ts';
import { readOutline, writeOutline } from './outline.ts';

/**
 * 备份格式版本。
 *
 * **加一位的判据是「老程序读不了」，不是「结构变了」。**
 * 恢复时 `version > BACKUP_VERSION` 会整个拒收（`backup.test.ts` 有一条守着），
 * 所以每加一位，就等于让所有旧版本对新备份**一个字都不读**。
 *
 * - **纯新增字段不加位**：老程序看不懂那个字段，忽略掉就是了，其余照样恢复；
 *   新程序读老备份靠 `?? []` / `?? null` 兜住。划线（`highlights`）就是这么加的。
 * - **改了已有字段的含义或删字段才加位**——那时老程序读出来是错的，
 *   拒收比读错好。
 */
export const BACKUP_VERSION = 1;

export interface BackupFile {
  version: number;
  createdAt: string;
  books: BackupBook[];
  cleanRules: unknown[];
  categories: unknown[];
  shelves: unknown[];
  settings: Record<string, string>;
}

/** 备份里那一份阅读状态。抽成具名类型，`sanitizeReading` 要用 */
export interface BackupReading {
    status: string;
    chapterIdx: number;
    charOffset: number;
    percent: number;
    rating: number | null;
    comment: string | null;
    /**
     * 什么时候评的。**这个日期谁也补不回来**——重扫恢复不了，看文件时间也看不出来。
     * 少了它，「我的书评」那一档（按 `rated_at desc` 排，null 排最后）
     * 恢复完就没有先后了，而「我最近评过什么」正是那一档存在的理由。
     *
     * 旧备份没有这个字段，恢复时留 null：**不知道就说不知道**，
     * 编一个「现在」会让几年前的书评看起来像今天刚写的。
     */
    ratedAt: string | null;
    dropReason: string | null;
    rereadCount: number;
    lastReadAt: string | null;
    finishedAt: string | null;
}

export interface BackupBook {
  title: string;
  author: string | null;
  aliases: string | null;
  intro: string | null;
  serialStatus: string;
  sourceSite: string | null;
  note: string | null;
  categoryName: string | null;
  tags: string[];
  /** 认回本地文件靠这两样：hash 优先，路径次之 */
  files: Array<{ path: string; contentHash: string | null; isPrimary: boolean; encoding: string | null }>;
  reading: BackupReading | null;
  /**
   * 划线和上面的笔记。**位置存「章号 + 章内偏移 + 长度」**，和 `highlight` 表一致。
   *
   * 恢复到重新解析过的库上时位置可能对不上——那和书签是同一个已知代价
   * （spec §10），但**不带比带错更糟**：笔记是用户写的字，重扫一个都补不回来。
   */
  highlights: Array<{
    chapterIdx: number;
    charOffset: number;
    length: number;
    excerpt: string;
    note: string | null;
    color: string;
    createdAt: string;
    /**
     * **PDF 的矩形摘录**（迁移 22 加的列）。同 `cfi` 那一条：
     * 有 `rect` 时 `charOffset` / `length` 是占位，不带就不是「位置不准」而是**整条废掉**。
     * 这张表上已经为这件事栓过两次（`bookmark.note`、`highlight.cfi`），
     * 所以加 `rect` 那一刻就把这里一起改了。
     */
    rect?: string | null;
    /**
     * **这条笔记自己的标签**（迁移 23）。名字而不是 id：
     * 恢复到另一个库上时 `tag.id` 根本对不上，而名字是用户自己打的字。
     * （书的标签在备份里本来就是名字，同一个形状。）
     */
    tags?: string[];
    /**
     * **EPUB 那套锚**（`epubcfi(...)`）。迁移 21 加的列，而这份备份**一直没跟上**。
     *
     * 不带的后果不是「位置不太准」，是**整条废掉**：EPUB 的划线有 `cfi` 时
     * `charOffset` / `length` 是占位（0 和选中的字数），
     * 恢复回来 `cfi` 是 null 就只剩那两个占位值——`resolve` 走偏移那条路，
     * 要么画到那一节的开头、要么直接判成漂了。
     *
     * 老备份里没有这个字段，`?? null` 兜住：那是「当时就没有」，不是丢了。
     */
    cfi: string | null;
  }>;
  /**
   * 阅读会话：什么时候读的、从百分之几读到百分之几。
   * `reading.last` / `reading.recent` 靠它，重扫恢复不了。
   * **完全可移植**（只有 book_id 和时间），这一点正是它和 `rename_log` 的分界。
   */
  sessions: Array<{
    startedAt: string;
    endedAt: string | null;
    fromPercent: number | null;
    toPercent: number | null;
  }>;
  bookmarks: Array<{
    chapterIdx: number;
    charOffset: number;
    excerpt: string | null;
    note: string | null;
    createdAt: string;
  }>;
  /** 这本书的自定义章节规则 */
  parseRule: string | null;
  /**
   * PDF / EPUB 读到哪儿了（PDF 是页码，EPUB 是章序号）。
   *
   * ⚠️ **必须挂在书上，不能进 `BACKUP_SETTINGS`。** 它在库里的键是
   * `viewer.<bookId>`，而恢复时 book id 会重新分配——照搬那个键会指到别的书上。
   * 跟着书走、用新 id 写回去，才是对的。同 `parseRule`。
   */
  viewerPos: string | null;
  /**
   * **用户自己加的目录**（`outline.<bookId>`，迁移 24）。
   *
   * 和 `viewerPos` 一个形状：按 id 命名的设置，恢复时 book id 会重新分配，
   * 所以**拿恢复之后的 id 写**，不能照搬那个键。
   * PDF 自带的 outline 不在这里——那东西在文件里，重新打开就有。
   */
  outline?: Array<{ page: number; title: string }>;
  onlineLinks: unknown[];
}

/** 备份里要带上的设置项。UI 偏好不带——那些丢了重设一下就行 */
/*
 * 备份带哪些设置。**这是白名单，加一个是个看得见的动作**——所以每加一条都要
 * 问一句：它是**用户自己打的字**吗？是的话就得带，重装一次就没了的东西
 * 不该靠他自己记着。
 *
 * 后面五条都是用户自己写/自己导的，而且**这个库是它们唯一的一份**：
 * 屏蔽规则和连载规则是他手打的 glob 和目录名；自定义封面源是四条正则；
 * 纸色是他导进来的整张纸、和调过色的那几张（一张纸调到顺眼要来回试很多次）；
 * **朗读引擎更要紧**——那 88 条原来硬编码在仓库里（相当于有第二份），
 * 搬进用户自己的库之后这里就是独一份了，见 AGENTS.md 那节。
 *
 * ⚠️ 剩下那些**故意不带**：`cover.gapMs` 是撞限流自己收敛出来的速率、
 * `search.indexed` 是「哪些书建过索引」、`migrate.clearedWant` 是一次性的迁移标记、
 * `library.splitCheck` 是体检结果——**都是这台机器上算出来的，换台机器重算就有**。
 *
 * `highlight.colorNames` 是后加的一条：**颜色代表什么，是用户自己打的字**
 * （黄＝好句、蓝＝待查）。划线本身在铁律 3 的不可再生名单里，
 * 划线恢复回来了、代表什么却丢了，等于只恢复了一半。
 */
const BACKUP_SETTINGS = [
  'rename.enabled',
  'scan.mode',
  'scan.intervalHours',
  'scan.dailyTime',
  'clean.disabledBuiltins',
  'scan.ignore',
  'library.serialRules',
  'cover.customSources',
  'tts.userEngines',
  'theme.imported',
  'highlight.colorNames',
];

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("select count(*) n from sqlite_master where type='table' and name = ?").get(name) as {
      n: number;
    }
  ).n > 0;
}

export function exportBackup(db: DatabaseSync): BackupFile {
  const books = db
    .prepare(
      `select b.*, c.name as categoryName from book b
         left join category c on c.id = b.category_id order by b.id`,
    )
    .all() as unknown as Array<Record<string, unknown>>;

  const out: BackupBook[] = books.map((b) => {
    const id = b.id as number;
    const files = db
      .prepare(
        'select path, content_hash as contentHash, is_primary as isPrimary, encoding from book_file where book_id = ? order by id',
      )
      .all(id) as unknown as Array<{
      path: string;
      contentHash: string | null;
      isPrimary: number;
      encoding: string | null;
    }>;

    const r = db
      .prepare(
        `select status, chapter_idx as chapterIdx, char_offset as charOffset, percent, rating,
                comment, rated_at as ratedAt, drop_reason as dropReason,
                reread_count as rereadCount,
                last_read_at as lastReadAt, finished_at as finishedAt
           from reading_state where book_id = ?`,
      )
      .get(id) as unknown as BackupBook['reading'];

    return {
      title: b.title as string,
      author: (b.author as string | null) ?? null,
      aliases: (b.aliases as string | null) ?? null,
      intro: (b.intro as string | null) ?? null,
      serialStatus: (b.serial_status as string) ?? 'unknown',
      sourceSite: (b.source_site as string | null) ?? null,
      note: (b.note as string | null) ?? null,
      categoryName: (b.categoryName as string | null) ?? null,
      tags: (
        db
          .prepare('select t.name from book_tag bt join tag t on t.id = bt.tag_id where bt.book_id = ?')
          .all(id) as unknown as Array<{ name: string }>
      ).map((t) => t.name),
      files: files.map((f) => ({ ...f, isPrimary: f.isPrimary === 1 })),
      reading: r ?? null,
      bookmarks: db
        .prepare(
          'select chapter_idx as chapterIdx, char_offset as charOffset, excerpt, note, created_at as createdAt from bookmark where book_id = ? order by id',
        )
        .all(id) as unknown as BackupBook['bookmarks'],
      sessions: db
        .prepare(
          `select started_at as startedAt, ended_at as endedAt,
                  from_percent as fromPercent, to_percent as toPercent
             from reading_session where book_id = ? order by id`,
        )
        .all(id) as unknown as BackupBook['sessions'],
      highlights: (db
        .prepare(
          `select chapter_idx as chapterIdx, char_offset as charOffset, length, excerpt, note,
                  color, created_at as createdAt, cfi, rect, id
             from highlight where book_id = ? order by id`,
        )
        .all(id) as unknown as Array<BackupBook['highlights'][number] & { id: number }>)
        .map((h) => {
          // **标签跟着走**（迁移 23 新开的一处用户输入）。`id` 只用来查标签，不入备份
          const { id: hid, ...剩下 } = h;
          const t = tagsOfHighlights(db, [hid])[hid] ?? [];
          return t.length ? { ...剩下, tags: t } : 剩下;
        }),
      parseRule:
        (
          db
            .prepare("select pattern from parse_rule where book_id = ? and scope = 'book'")
            .get(id) as { pattern: string } | undefined
        )?.pattern ?? null,
      viewerPos:
        (
          db
            .prepare('select value from app_setting where key = ?')
            .get('viewer.' + String(id)) as { value: string } | undefined
        )?.value || null,
      // 自建目录。空的就不写进去，别让每本书都多一个空数组
      ...(readOutline(db, id).length ? { outline: readOutline(db, id) } : {}),
      onlineLinks: tableExists(db, 'online_link')
        ? db.prepare('select * from online_link where book_id = ?').all(id)
        : [],
    };
  });

  const settings: Record<string, string> = {};
  for (const key of BACKUP_SETTINGS) {
    const row = db.prepare('select value from app_setting where key = ?').get(key) as
      | { value: string }
      | undefined;
    if (row) settings[key] = row.value;
  }

  return {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    books: out,
    cleanRules: db.prepare('select name, pattern, replacement, enabled, scope from clean_rule').all(),
    categories: db.prepare('select name, sort_order from category order by id').all(),
    shelves: db.prepare('select name, filter_json from smart_shelf order by id').all(),
    settings,
  };
}

export interface RestoreReport {
  matched: number;
  /**
   * **备份里有多少个字段是不合法的、被收拾掉了。**
   *
   * 备份是个用户能用文本编辑器打开的 JSON，而恢复直接往 `reading_state` 里写。
   * 改坏一个字（或者从更早/更新的版本恢复）不该让整份备份作废——那是
   * 不可再生数据的**唯一保险**——但也不能一声不吭地把垃圾灌进去。
   * 所以：**收拾掉，然后照实报几处**。
   */
  fixed: number;
  /** 认不回来的书，列出来让用户手动指认（spec §10） */
  unmatched: Array<{ title: string; author: string | null; paths: string[] }>;
  createdCategories: number;
  createdTags: number;
  /**
   * **真正落回去了多少不可再生的数据。**
   *
   * 原来这份报告只说「认回 N 本」——那说的是**书**，不是**用户写的东西**。
   * 而恢复是备份**唯一被验证的时刻**：用户在这一刻想知道的是
   * 「我那几百条书评回来了吗」，不是「认出了几本书」。
   * 一本书认回来了、而它的书评因为某处 SQL 漏了没落库，
   * 旧报告一个字都不会说。
   */
  restored: {
    /** 写回了评分或短评的书 */
    reviews: number;
    bookmarks: number;
    highlights: number;
    sessions: number;
  };
  /**
   * **恢复把本地已有的评价换掉了几条。**
   *
   * 恢复是**无条件覆盖**的（`update reading_state set rating = ?, comment = ? …`），
   * 而这是对的：用户点「恢复」就是要拿备份里的那份为准，
   * 见到本地更新就跳过反而会让「我搞砸了，恢复一下」这条最正常的路失效。
   *
   * 错的是**一个字都不说**。拿一份三个月前的备份恢复一下，
   * 这期间写的书评全被换掉，报告上写的却是「恢复完成：认回 12 本，书评 8 条」——
   * 那句话只说了回来什么，没说**盖掉了什么**。而书评重扫恢复不了。
   *
   * 只数「本地本来有内容、而且和备份里的不一样」的那些：
   * 内容一模一样的覆盖等于没发生，本地是空的更不算。
   */
  overwrote: number;
  /**
   * **新建出来的书**：备份里没有文件的那些（手工添的「读过但本地没有文件」），
   * 本地又没有同名同作者的，只能重新建一条。有文件的书永远不建——
   * 那条路要认回真实文件，认不回来就该进 `unmatched` 让用户指认。
   */
  createdBooks: number;
}

/**
 * 把一本书**重扫恢复不了的那几样**写回去：阅读状态（含评分短评）、书签、划线、阅读会话。
 *
 * **恢复和「手动指认」共用这一处。** 原来 `linkManually` 自己抄了一份，而它抄的是
 * `highlight` 那张表还不存在时候的版本——于是手动指认回来的书**划线和笔记一条都没有**，
 * 书签还会因为没有去重而**导两次翻倍**。本文件顶上那句「加一张存用户输入的表时，
 * 这句话和 `backup.ts` 要一起改」说的就是这个形状，而它已经犯过一次了。
 *
 * 计数直接记进传进来的 report，两条路的口径因此一定一致。
 */
/**
 * 把备份里那一份阅读状态**收拾成合法的**，顺手数一数改了几处。
 *
 * **前门严、后门松是这个仓库反复咬人的形状。** `setStatus` 那边逐个字段校验过
 * （评分必须是 0–5 的有限数、短评必须是文字、状态必须认得），
 * 而恢复这条路原来一个字都不看——实测往备份里塞
 * `status: '乱写的状态'`、`rating: 99`、`percent: 500`、`comment: 12345`，
 * 全部原样落进 `reading_state`（那个 `comment` 还被 sqlite 存成了 `"12345.0"`，
 * 正是第 89 轮在前门修掉的那个坑）。后果不是显示难看：
 * **一本状态不认识的书从此不属于任何一档书架**。
 *
 * **收拾而不是拒收**：备份是不可再生数据的唯一保险，为一个坏字段让整份作废是本末倒置。
 * 但也不能一声不吭——改了几处进 `RestoreReport.fixed`，界面照实说。
 */
function sanitizeReading(r: BackupReading, count: (n: number) => void): BackupReading {
  let n = 0;
  /*
   * **字段判据从 `status.ts` 拿，不在这儿再写一份。**
   * 往 `reading_state` 写的门有三扇（前门 `setStatus`、恢复、撤销），
   * 三扇都要认同一套规矩——各写一份必然分叉，这个仓库为它栽过好几次。
   * 这里只负责「哪个字段用哪条规矩」和「数一数改了几处」。
   */
  const num = (v: unknown, lo: number, hi: number, fallback: number | null) => {
    const ok = asFinite(v, lo, hi);
    if (ok === null && v != null) n++;
    return ok ?? fallback;
  };
  const text = (v: unknown) => {
    const ok = asText(v);
    if (ok === null && v != null) n++;
    return ok;
  };
  const when = (v: unknown) => {
    const ok = asWhen(v);
    if (ok === null && v != null) n++;
    return ok;
  };

  const status = READING_STATUS_IDS.includes(r.status as never) ? r.status : (n++, 'none');
  const out: BackupReading = {
    ...r,
    status,
    chapterIdx: num(r.chapterIdx, 0, Number.MAX_SAFE_INTEGER, 0) ?? 0,
    charOffset: num(r.charOffset, 0, Number.MAX_SAFE_INTEGER, 0) ?? 0,
    percent: num(r.percent, 0, 100, 0) ?? 0,
    rereadCount: num(r.rereadCount, 0, Number.MAX_SAFE_INTEGER, 0) ?? 0,
    rating: num(r.rating, 0, 5, null),
    comment: text(r.comment),
    dropReason: text(r.dropReason),
    ratedAt: when(r.ratedAt),
    finishedAt: when(r.finishedAt),
    lastReadAt: when(r.lastReadAt),
  };
  count(n);
  return out;
}

/**
 * 把备份里一条书签/划线收拾成合法的。判据和 `sanitizeReading` 共用
 * （`status.ts` 的 `asFinite` / `asText` / `asWhen`）。
 *
 * **两件事，第二件更要紧：**
 *
 * 1. 值要合法。实测原样落库过 `char_offset: "abc"`（字符串进整数列）、
 *    `length: -3`、`chapter_idx: 1e9`、`note: "7.0"`。
 * 2. **一条坏行不许让整份备份作废。** `importBackup` 是包在事务里的（那是对的），
 *    于是 `excerpt` 或 `created_at` 为 null 撞上 NOT NULL 时**整份回滚**——
 *    而备份是不可再生数据的**唯一保险**。收拾成默认值再插，
 *    界面那句「有 N 处对不上，已经按默认值收拾掉了」说的就是这个。
 *
 * `createdAt` 认不出来就**不写这一列**，让 schema 的默认值兜住——
 * 编一个「三年前」比写「现在」更糟，而「现在」至少是这次恢复真实发生的时刻。
 */
function sanitizeMark(
  m: { chapterIdx?: unknown; charOffset?: unknown; length?: unknown; excerpt?: unknown; note?: unknown; color?: unknown; createdAt?: unknown; cfi?: unknown; rect?: unknown },
  count: (n: number) => void,
) {
  let n = 0;
  const num = (v: unknown, lo: number, hi = Number.MAX_SAFE_INTEGER) => {
    const ok = asFinite(v, lo, hi);
    if (ok === null && v != null) n++;
    return ok ?? 0;
  };
  const txt = (v: unknown) => {
    const ok = asText(v);
    if (ok === null && v != null) n++;
    return ok;
  };
  const createdAt = asWhen(m.createdAt);
  if (createdAt === null && m.createdAt != null) n++;
  /*
   * **每个字段的下限跟前门一致**：`addHighlight` 要求 `length > 0`、
   * `charOffset >= 0`，颜色不在 `COLORS` 里就退回 `yellow`。
   * 后门认另一套的话，恢复出来的划线是前门永远造不出的形状。
   */
  const color = typeof m.color === 'string' && (COLORS as readonly string[]).includes(m.color)
    ? m.color
    : (m.color != null && n++, 'yellow');
  const out = {
    chapterIdx: num(m.chapterIdx, 0),
    charOffset: num(m.charOffset, 0),
    length: asFinite(m.length, 1, Number.MAX_SAFE_INTEGER) ?? (m.length != null && n++, 1),
    excerpt: txt(m.excerpt),
    note: txt(m.note),
    color,
    createdAt,
    // 书签也走这个函数，它没有 cfi——`undefined` 和「值不是字符串」都归成 null
    cfi: typeof m.cfi === 'string' && m.cfi.trim() ? m.cfi.trim() : null,
    /*
     * ⚠️ **这一行就是「加一列就要走一遍」里最容易漏的那一处。**
     * `sanitizeMark` **重建了一个对象**，不是改原来那个——漏写一列就是
     * 它在这里被**静默地丢掉**，select 和 insert 两头写对了也没用。
     * 校验走 `解析矩形`（与前门 `addHighlight` 同一份）：认不出来的当没有，
     * 而不是原样落库——一个坏的 rect 会在页上画出一个位置乱七八糟的框。
     */
    rect: typeof m.rect === 'string' && 解析矩形(m.rect) ? m.rect.trim() : (m.rect != null && n++, null),
  };
  count(n);
  return out;
}

function restoreUserData(
  db: DatabaseSync,
  bookId: number,
  bb: BackupBook,
  report: RestoreReport,
): void {
  // 建标签取 id 只有 `library.ts` 的 `tagIdFor` 那一份，别在这儿再写两句 SQL
  const idOf = tagIdFor(db);
  if (bb.reading) {
    const r = sanitizeReading(bb.reading, (n) => { report.fixed += n; });
    // 「回来了几条书评」按**有内容**算：一本没打分也没写短评的书，
    // 恢复它的阅读进度不该被数成一条书评
    if (r.rating != null || (r.comment ?? '') !== '') report.restored.reviews++;
    /*
     * **先保证这一行在。** 这里原来只有 UPDATE：那本书没有 `reading_state` 行时
     * 一个字都写不进去，**而上面那句 `report.restored.reviews++` 已经把它数上了**
     * ——报告说书评回来了，库里什么都没有。最糟的组合。
     *
     * 「没有这一行的书」是真实存在的，不是假想：`buildFilter` 用
     * `ifnull(r.status,'none')` 筛「未标记」，那一档按定义就包含它们，
     * `setStatus` 当初也为此补过同样的一句（`mergeBooks` 里还有第三处）。
     */
    db.prepare('insert or ignore into reading_state(book_id) values(?)').run(bookId);
    // 覆盖之前先看看本地原来写着什么——理由见上面 `RestoreReport.overwrote`
    const local = db
      .prepare('select rating, comment from reading_state where book_id = ?')
      .get(bookId) as { rating: number | null; comment: string | null } | undefined;
    if (
      local
      && (local.rating != null || (local.comment ?? '') !== '')
      && (local.rating !== r.rating || (local.comment ?? '') !== (r.comment ?? ''))
    ) report.overwrote++;
    db.prepare(
      `update reading_state set status = ?, chapter_idx = ?, char_offset = ?, percent = ?,
              rating = ?, comment = ?, rated_at = ?, drop_reason = ?, reread_count = ?,
              last_read_at = ?, finished_at = ? where book_id = ?`,
    ).run(
      r.status, r.chapterIdx, r.charOffset, r.percent, r.rating, r.comment,
      // 旧备份没有这个字段 → null。**不知道就说不知道**，别编一个「现在」
      r.ratedAt ?? null, r.dropReason, r.rereadCount, r.lastReadAt, r.finishedAt, bookId,
    );
  }

  // 书签按「章 + 偏移」去重，导两次不会翻倍
  for (const raw of bb.bookmarks ?? []) {
    const m = sanitizeMark(raw, (n) => { report.fixed += n; });
    const dup = db
      .prepare('select id from bookmark where book_id = ? and chapter_idx = ? and char_offset = ?')
      .get(bookId, m.chapterIdx, m.charOffset);
    if (!dup) {
      // `created_at` 认不出来就不写这一列，让 schema 默认值兜住
      if (m.createdAt) {
        db.prepare(
          'insert into bookmark(book_id, chapter_idx, char_offset, excerpt, note, created_at) values(?,?,?,?,?,?)',
        ).run(bookId, m.chapterIdx, m.charOffset, m.excerpt, m.note, m.createdAt);
      } else {
        db.prepare(
          'insert into bookmark(book_id, chapter_idx, char_offset, excerpt, note) values(?,?,?,?,?)',
        ).run(bookId, m.chapterIdx, m.charOffset, m.excerpt, m.note);
      }
      report.restored.bookmarks++;
    }
  }

  /*
   * 划线去重的判据比书签多一个 `length`：同一个起点上可以有长短不同的两条划线
   * （划一句、又划整段）。**导两次不该翻倍**，和书签同一条规矩。
   */
  for (const rawH of bb.highlights ?? []) {
    const h = sanitizeMark(rawH, (n) => { report.fixed += n; });
    /*
     * ⚠️ **有 `cfi` 的按 `cfi` 认重复。**
     * EPUB 的划线 `char_offset` 恒为 0、`length` 是选中的字数——
     * 同一节里划两句一样长的话，按「章 + 偏移 + 长度」它们长得一模一样，
     * 恢复时后一条会被当成重复**丢掉**。
     */
    /*
     * ⚠️ **矩形摘录按 `rect` 认重复**，理由和 `cfi` 一模一样：
     * 它的 `char_offset` / `length` 是占位（0 和 1），同一页上框两块的话
     * 按「章 + 偏移 + 长度」它们长得一模一样，后一条会被当成重复**丢掉**。
     */
    const dup = h.rect
      ? db.prepare('select id from highlight where book_id = ? and chapter_idx = ? and rect = ?')
        .get(bookId, h.chapterIdx, h.rect)
      : h.cfi
      ? db.prepare('select id from highlight where book_id = ? and cfi = ?').get(bookId, h.cfi)
      : db
        .prepare('select id from highlight where book_id = ? and chapter_idx = ? and char_offset = ? and length = ? and cfi is null')
        .get(bookId, h.chapterIdx, h.charOffset, h.length);
    if (!dup) {
      /*
       * `excerpt` 在 schema 上是 `not null`——**为 null 时整份备份会回滚**，
       * 那是这一段最要紧的一条（见 `sanitizeMark` 上面）。收拾成空串，
       * 对账那头 `resolve` 会把它标成「对不上原文」，不会假装它是对的。
       */
      if (h.createdAt) {
        db.prepare(
          `insert into highlight(book_id, chapter_idx, char_offset, length, excerpt, note, color, cfi, rect, created_at)
           values(?,?,?,?,?,?,?,?,?,?)`,
        ).run(bookId, h.chapterIdx, h.charOffset, h.length, h.excerpt ?? '', h.note,
          h.color ?? 'yellow', h.cfi, h.rect ?? null, h.createdAt);
      } else {
        db.prepare(
          `insert into highlight(book_id, chapter_idx, char_offset, length, excerpt, note, color, cfi, rect)
           values(?,?,?,?,?,?,?,?,?)`,
        ).run(bookId, h.chapterIdx, h.charOffset, h.length, h.excerpt ?? '', h.note,
          h.color ?? 'yellow', h.cfi, h.rect ?? null);
      }
      /*
       * ⚠️ **标签要跟着恢复**，而且得拿刚插进去那一条的 id。
       * 漏了的话划线回来了、分类没了——同「颜色代表什么」那一条，都是只恢复一半。
       */
      if (rawH && Array.isArray((rawH as { tags?: unknown }).tags)) {
        const 新 = db.prepare('select last_insert_rowid() as id').get() as { id: number };
        /*
         * ⚠️ **不能调 `tagHighlights`——它自己 `begin`，而这里已经在事务里了。**
         * sqlite 不允许嵌套事务，于是那一句抛错、被 try 吃掉，
         * 结果是**划线回来了、标签没回来**，而报告里还算它成功。
         * 名字走 `normalizeTagNames`（备份那一版：太长的截断而不是抛），
         * 同书的标签那一段——**一条坏行不许让整份备份作废**。
         */
        const 整 = normalizeTagNames(
          ((rawH as { tags: unknown[] }).tags).filter((x) => typeof x === 'string') as string[],
        );
        report.fixed += 整.fixed;
        const 名们 = 整.names;
        for (const name of 名们) {
          db.prepare('insert or ignore into highlight_tag(highlight_id, tag_id) values(?, ?)')
            .run(新.id, idOf(name).id);
        }
      }
      report.restored.highlights++;
    }
  }

  // 会话按「开始时间」去重：同一本书同一秒开两次会话不可能
  for (const ss of bb.sessions ?? []) {
    const dup = db
      .prepare('select id from reading_session where book_id = ? and started_at = ?')
      .get(bookId, ss.startedAt);
    if (!dup) {
      db.prepare(
        `insert into reading_session(book_id, started_at, ended_at, from_percent, to_percent)
         values(?,?,?,?,?)`,
      ).run(bookId, ss.startedAt, ss.endedAt, ss.fromPercent, ss.toPercent);
      report.restored.sessions++;
    }
  }
}

/**
 * 恢复备份。**按 hash 优先、路径次之**关联本地文件。
 *
 * 关联不上的**不会凭空建一本书**——那样用户会得到一堆点开就报「文件缺失」的幽灵条目。
 * 列出来让他自己指认，是 spec §10 明确要求的做法。
 */
export function importBackup(db: DatabaseSync, backup: BackupFile): RestoreReport {
  if (backup.version > BACKUP_VERSION) {
    throw new Error(`备份文件版本 ${backup.version} 比当前程序还新，无法导入`);
  }
  if (!Array.isArray(backup.books)) throw new Error('备份文件格式不对：缺少 books');

  // 同 `restoreUserData`：建标签取 id 只有 `library.ts` 的 `tagIdFor` 那一份
  const idOf = tagIdFor(db);

  const report: RestoreReport = {
    matched: 0, unmatched: [], createdCategories: 0, createdTags: 0,
    fixed: 0,
    restored: { reviews: 0, bookmarks: 0, highlights: 0, sessions: 0 },
    overwrote: 0,
    createdBooks: 0,
  };

  const byHashAndPath = db.prepare(
    'select book_id from book_file where content_hash = ? and path = ? limit 1',
  );
  const byHash = db.prepare('select book_id from book_file where content_hash = ? limit 1');
  const byPath = db.prepare('select book_id from book_file where path = ? limit 1');

  // 一本本地书只能被认领一次。**内容完全相同的两个文件 hash 也相同**
  // （spec §8 的「完全重复」），只按 hash 认的话备份里两本书会双双认到同一本，
  // 后写的那本把先写的进度覆盖掉——测试里真发生过。
  const claimed = new Set<number>();
  const take = (id: number | undefined): number | null =>
    id !== undefined && !claimed.has(id) ? id : null;

  db.exec('begin');
  try {
    for (const bb of backup.books) {
      let bookId: number | null = null;

      // 1. hash 和路径同时命中，最可靠
      for (const f of bb.files) {
        if (!f.contentHash) continue;
        bookId = take((byHashAndPath.get(f.contentHash, f.path) as { book_id: number } | undefined)?.book_id);
        if (bookId !== null) break;
      }
      // 2. 只有 hash 命中：文件被改过名，但内容没变
      if (bookId === null) {
        for (const f of bb.files) {
          if (!f.contentHash) continue;
          bookId = take((byHash.get(f.contentHash) as { book_id: number } | undefined)?.book_id);
          if (bookId !== null) break;
        }
      }
      // 3. 只有路径命中：内容被追更改过了，但还在原处
      if (bookId === null) {
        for (const f of bb.files) {
          bookId = take((byPath.get(f.path) as { book_id: number } | undefined)?.book_id);
          if (bookId !== null) break;
        }
      }
      /*
       * 4. **手工添的书没有任何文件**——上面三条全靠 `book_file` 认，
       *    所以它们**一本都认不回来**。当场量的（备份里一本手工添的书，
       *    带评分和短评）：恢复到空库 `matched 0 / unmatched 1 / reviews 0`，
       *    **书没建出来，那条书评就没了**；恢复到它自己那个库上也一样，
       *    尽管那本书就在旁边、书名作者一模一样。
       *
       *    而 `manual.ts` 的整个前提是「读过但本地没有文件的书——**书评是主体，
       *    文件是可选的**」，本文件顶上又写着「这是不可再生数据的唯一保险」：
       *    保险偏偏漏掉了那些**只剩不可再生数据**的书。
       *
       *    `unmatched` 那条出路也接不住它们：界面让用户去**指认一个文件**，
       *    而这类书根本没有文件。
       *
       *    判据和 `addManualBook` / `claimFileless` 是同一条：按 `bookKey`
       *    （书名 + 作者，trim + 转小写）认。认不到就**建一本**——
       *    那正是用户当初在「添读过的书」里做的事。
       */
      if (bookId === null && bb.files.length === 0) {
        const k = bookKey(bb.title, bb.author);
        const hit = (db.prepare('select id, title, author from book').all() as unknown as Array<{
          id: number; title: string; author: string | null;
        }>).find((x) => bookKey(x.title, x.author) === k && !claimed.has(x.id));
        if (hit) {
          bookId = hit.id;
        } else {
          bookId = Number(
            db.prepare('insert into book(title, author) values(?,?)').run(bb.title, bb.author).lastInsertRowid,
          );
          db.prepare("insert into reading_state(book_id, status) values(?, 'none')").run(bookId);
          report.createdBooks++;
        }
      }
      if (bookId !== null) claimed.add(bookId);

      if (bookId === null) {
        report.unmatched.push({ title: bb.title, author: bb.author, paths: bb.files.map((f) => f.path) });
        continue;
      }

      db.prepare(
        `update book set title = ?, author = ?, aliases = ?, intro = ?, serial_status = ?,
                source_site = ?, note = ?, updated_at = datetime('now') where id = ?`,
      ).run(bb.title, bb.author, bb.aliases, bb.intro, bb.serialStatus, bb.sourceSite, bb.note, bookId);

      if (bb.categoryName) {
        db.prepare('insert or ignore into category(name) values(?)').run(bb.categoryName);
        const cat = db.prepare('select id from category where name = ? limit 1').get(bb.categoryName) as
          | { id: number }
          | undefined;
        if (cat) db.prepare('update book set category_id = ? where id = ?').run(cat.id, bookId);
      }

      /*
       * **标签名要过和前门同一套规矩。** 备份里原样落库过四样前门专门防住的东西：
       * 空标签、60 个字的名字、`科幻,悬疑`（卡片按逗号拆，会变出两个点不掉的假标签）、
       * 前后带空格的。判据在 `library.ts` 的 `normalizeTagNames`——
       * 和 `splitTagNames` 共用同一段拆分逻辑，只是**太长的截断而不是抛**
       * （抛一次就是整份备份作废）。
       */
      const 收拾好的 = normalizeTagNames(bb.tags);
      report.fixed += 收拾好的.fixed;
      for (const name of 收拾好的.names) {
        /*
         * ⚠️ **只数真的新建出来的。**
         * 这里原来是无条件 `report.createdTags++`——数的其实是「处理了几条标签关联」，
         * 恢复 100 本各带 5 个标签就报 500，而真正新建的可能只有 5 个。
         * 那个数一直没人显示（`dead-fields.mjs` 早报过它「没被读过」），
         * 所以谁也没发现它在说假话。`insert or ignore` 的 `changes` 才是真相。
         */
        const t = idOf(name);
        if (t.made) report.createdTags++;
        db.prepare('insert or ignore into book_tag(book_id, tag_id) values(?,?)').run(bookId, t.id);
      }

      restoreUserData(db, bookId, bb, report);

      if (bb.parseRule) {
        db.prepare("delete from parse_rule where book_id = ? and scope = 'book'").run(bookId);
        db.prepare(
          "insert into parse_rule(name, pattern, scope, book_id) values('自定义', ?, 'book', ?)",
        ).run(bb.parseRule, bookId);
      }

      /*
       * PDF / EPUB 读到哪儿。**用恢复之后的 `bookId` 写，不是备份里那个。**
       * 老备份没有这个字段，`?? null` 兜住——那时候就是没有，不是丢了。
       */
      if (bb.viewerPos) {
        db.prepare(
          'insert into app_setting(key, value) values(?, ?) on conflict(key) do update set value = excluded.value',
        ).run('viewer.' + String(bookId), String(bb.viewerPos));
      }

      /*
       * **自建目录**（迁移 24）。同上：拿恢复之后的 `bookId` 写。
       * ⚠️ 走 `writeOutline` 而不是直接写 JSON：它带着校验（页码、名字长度、条数）。
       * 一条坏数据不许让整份备份作废（同 `sanitizeMark` 那段），所以包 try。
       */
      if (Array.isArray(bb.outline) && bb.outline.length) {
        try { writeOutline(db, bookId, bb.outline); } catch { report.fixed++; }
      }

      report.matched++;
    }

    for (const c of (backup.categories ?? []) as Array<{ name: string }>) {
      const before = db.prepare('select count(*) n from category').get() as { n: number };
      db.prepare('insert or ignore into category(name) values(?)').run(c.name);
      const after = db.prepare('select count(*) n from category').get() as { n: number };
      if (after.n > before.n) report.createdCategories++;
    }

    for (const r of (backup.cleanRules ?? []) as Array<{
      name: string;
      pattern: string;
      replacement: string;
      enabled: number;
      scope: string;
    }>) {
      const dup = db.prepare('select id from clean_rule where name = ? and pattern = ?').get(r.name, r.pattern);
      if (!dup) {
        db.prepare(
          'insert into clean_rule(name, pattern, replacement, enabled, scope) values(?,?,?,?,?)',
        ).run(r.name, r.pattern, r.replacement, r.enabled, r.scope);
      }
    }

    for (const s of (backup.shelves ?? []) as Array<{ name: string; filter_json: string }>) {
      const dup = db.prepare('select id from smart_shelf where name = ?').get(s.name);
      if (!dup) {
        db.prepare('insert into smart_shelf(name, filter_json) values(?, ?)').run(s.name, s.filter_json);
      }
    }

    for (const [k, v] of Object.entries(backup.settings ?? {})) {
      db.prepare(
        'insert into app_setting(key, value) values(?,?) on conflict(key) do update set value = excluded.value',
      ).run(k, v);
    }

    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }

  return report;
}

/**
 * 把关联不上的那本手动指认到某本已有的书上（spec §10 的「手动指认」）。
 * 只搬阅读状态和书签——元数据用户可能已经在本地改过，不该被备份覆盖。
 */
/** 「手动指认」回来了什么。和恢复那头共用 `restoreUserData`，口径一定一致 */
export type LinkResult = Pick<RestoreReport, 'restored' | 'overwrote'>;

export function linkManually(db: DatabaseSync, backupBook: BackupBook, bookId: number): LinkResult {
  const report: RestoreReport = {
    matched: 0, unmatched: [], createdCategories: 0, createdTags: 0,
    fixed: 0,
    restored: { reviews: 0, bookmarks: 0, highlights: 0, sessions: 0 },
    overwrote: 0, createdBooks: 0,
  };
  restoreUserData(db, bookId, backupBook, report);
  return { restored: report.restored, overwrote: report.overwrote };
}
