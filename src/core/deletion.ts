// 删除重复文件（用户明确要求，**是 spec §0.1「移动和删除仍然不做」的例外**）。
//
// 既然破了那条例，安全阀要比重命名还严。设计上有一个决定性的选择：
//
//   **一律送进系统回收站，不做真删。**
//
// 这一条改变了整件事的风险等级——删错了还能从回收站拖回来，而真删没有第二次机会。
// 代价只是回收站占点空间，而这些本来就是重复文件。
//
// 除此之外的判据（都在 `canDelete` 里，删之前一定过一遍）：
//   1. **磁盘上必须还留着同一本书的另一个文件**，而且要真去 `stat` 一遍确认——
//      记录可能早就和现实脱节了。没有别的文件就不叫「重复」，是唯一的一份。
//      **分两档，界面必须如实标明是哪一档**（`DeleteCheck.identical`）：内容完全相同
//      （content_hash 一致，删了等于没删）／同名同作者的另一个版本（内容不一样，
//      删掉那份内容就没了）。判据一度只认第一档，结果在真实书库里一次都触发不了，
//      详见 `canDelete` 上面那段。
//   2. **删完这本书会变空时，它不能有阅读进度或书签**。那两样重扫恢复不了；
//      没有的话连空记录一起清掉，别在书架上留一条点开就报错的。
//   3. 删的是主版本时自动指一个新的，否则这本书读不了。
//
// 数据库记录在文件真的进了回收站**之后**才删。反过来的话，中途失败就会
// 「记录没了但文件还在」，下次扫描又把它当新书收进来。

import { stat, unlink, rename, copyFile, mkdir, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { ensurePrimary } from './primary.ts';
import type { DatabaseSync } from 'node:sqlite';
import { mergeBooks, setPrimary, bookKey } from './versions.ts';


/**
 * ## 暂存区：系统回收站用不了的时候，我们自己当那个回收站
 *
 * 起因是真实场景：**网络共享上没有回收站**（实测 `shell.trashItem` 抛
 * `Failed to perform delete operation`），而那儿的重复文件照样占着空间。
 *
 * ⚠️ **搬进暂存区不是「真删」，铁律 1 没有被破。** 文件还在磁盘上、还能拿回来，
 * 只是从书库目录挪到了应用自己的目录里——和送进回收站是同一件事的两种做法。
 * 所以这条路**不限于「内容完全相同」的重复**：移动不丢内容，
 * 那道只对 `identical` 放行的闸在这里没有存在的理由（真删才需要它）。
 *
 * 三条判据：
 *
 * 1. **入区时间写在文件名里**，不用 mtime——搬过来的文件保留的是**原来那本书**的
 *    mtime（常常是好几年前），拿它算年龄会当场把刚进来的文件判成过期。
 * 2. **名字解析不出时间的一律不动。** 清理是会真删的一步，
 *    「看不懂的东西」绝不能默认删掉——那是用户自己丢进来的东西也说不定。
 * 3. **跨盘要退回「复制 + 删原件」。** 网络盘搬到 `userData`（C 盘）
 *    必然跨卷，`rename` 会抛 `EXDEV`；只写 rename 的话这个功能在**唯一用得上它的
 *    场景里**恰好不工作。
 */
export const QUARANTINE_DIR = 'quarantine';

/** 多久没人动就清掉。用户定的：30 天 */
export const QUARANTINE_DAYS = 30;

/** `<入区时间毫秒>__<原文件名>`。分隔符用两个下划线，原名里出现它的概率比单个低 */
export function 暂存名(now: number, 原名: string): string {
  return `${now}__${原名}`;
}

/** 从暂存文件名里读回入区时间。**读不出来就返回 null，调用方必须当作「不要动它」** */
export function 解暂存时间(name: string): number | null {
  const i = name.indexOf('__');
  if (i <= 0) return null;
  const n = Number(name.slice(0, i));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 到期了吗。拆成纯函数是为了能测——「30 天」这种规则的边界最容易写错 */
export function 该清掉(name: string, now: number, days = QUARANTINE_DAYS): boolean {
  const t = 解暂存时间(name);
  if (t === null) return false;
  return now - t >= days * 24 * 3600_000;
}

/**
 * 在暂存区里挑一个没被占的名字。
 *
 * ⚠️ **光有时间戳不够。** `rename` 和 `copyFile` 在 Windows 上都是**静默覆盖**
 * （实测：第二个盖掉第一个，不报错不警告），而**重复文件常常同名**——
 * 「同一本书下到两个文件夹」正是重复的主要来源，也正是这个功能存在的理由。
 * 同一毫秒搬两个 `book.txt`，先进来的那份就被真删了，
 * 恰好是这个模块唯一不许发生的那件事。
 *
 * 撞上就在原名前加序号（`<时间>__2-book.txt`）。`__` 之前那段没动，
 * `解暂存时间` 照样读得出——清理那一步全靠它。
 *
 * ponytail: 探一下再搬，中间理论上有空隙；这个目录只有主进程一个写者、
 * 搬运又是顺序的，真出并发再换 O_EXCL 占位。
 */
export async function 暂存空位(暂存目录: string, now: number, 原名: string): Promise<string> {
  for (let i = 1; i <= 999; i++) {
    const 到 = join(暂存目录, 暂存名(now, i === 1 ? 原名 : `${i}-${原名}`));
    try {
      await stat(到);
    } catch {
      return 到;
    }
  }
  throw new Error(`暂存区里叫「${原名}」的太多了`);
}

/** 把文件搬进暂存区，回它的新位置。跨盘时退回「复制 + 删原件」 */
async function 搬进暂存区(暂存目录: string, path: string, now: number): Promise<string> {
  await mkdir(暂存目录, { recursive: true });
  const 到 = await 暂存空位(暂存目录, now, basename(path));
  try {
    await rename(path, 到);
  } catch {
    // 跨卷（网络盘 → userData）rename 会抛 EXDEV。**这正是这个功能唯一用得上的场景**，
    // 所以退路不是可选项。复制成功之后才删原件，中途失败最多留一份多余的副本
    await copyFile(path, 到, constants.COPYFILE_EXCL);
    await unlink(path);
  }
  return 到;
}

/**
 * 清掉暂存区里躺够 30 天的。**这一步是真删**，所以判据保守：
 * 名字里读不出入区时间的一律不动（见 `解暂存时间`）。
 */
export async function 清理暂存区(
  暂存目录: string,
  now = Date.now(),
  days = QUARANTINE_DAYS,
): Promise<{ 清掉: number; 留着: number }> {
  let 清掉 = 0;
  let 留着 = 0;
  let names: string[];
  try {
    names = await readdir(暂存目录);
  } catch {
    return { 清掉: 0, 留着: 0 };   // 目录还不存在 = 没用过这个功能
  }
  for (const n of names) {
    if (!该清掉(n, now, days)) { 留着++; continue; }
    try { await unlink(join(暂存目录, n)); 清掉++; } catch { 留着++; }
  }
  return { 清掉, 留着 };
}

/**
 * 回收站没收下这个文件——**说清是为什么，别把系统的原话直接摔给用户**。
 *
 * 实测撞到的第一句就是 `Failed to parse path`：那是 Windows 的
 * `SHCreateItemFromParsingName` 解析失败，而真相是**那个文件本来就不在了**。
 * 用户看到的是一句英文，和他刚做的事毫无关系。
 *
 * ⚠️ **判断放在这一层，不放在界面上。** 界面只知道「失败了」，
 * 而「路径长什么样、文件在不在」的知识在这儿。第一版我把它写在了
 * `VersionsDialog` 里、还一律归咎于网络盘——结果这次失败根本不是网络盘，
 * 那句话就成了误导。**不确定原因时宁可只说发生了什么，别猜为什么。**
 */
async function 说人话(path: string, e: unknown): Promise<string> {
  const 原话 = e instanceof Error ? e.message : String(e);
  try {
    await stat(path);
  } catch {
    return '这个文件已经不在磁盘上了，没什么可移的——它该走「需要处理」那一档，不是「重复的书」。';
  }
  // UNC 路径以两个反斜杠开头。**用码点判，不在源码里敲反斜杠**——
  // 这一行第一版就是被转义咬掉的（同 AGENTS.md「源码里别放裸控制字符」那条的近亲）
  if (path.slice(0, 2) === String.fromCharCode(92, 92)) {
    return `网络盘上没有回收站，而这个应用只送回收站、不真删，所以动不了它——只能到那台机器上自己处理。（系统原话：${原话}）`;
  }
  return 原话;
}

export interface DeleteCandidate {
  fileId: number;
  bookId: number;
  path: string;
  size: number;
  contentHash: string | null;
  isPrimary: boolean;
  bookTitle: string;
}

/*
 * ⚠️ **`identical` 和 `survivors` 没有被渲染进程读，这是对的，别去「修」。**
 *
 * `dead-fields.mjs` 会把它俩列出来，代码评审也据此报过一条「界面上没兑现分档」。
 * 实测过：界面**确实**在分档，只是数据来自另一处——「重复的书」是**一组一组**摆的，
 * 每一行的 `exactDuplicate` 由 `versions.ts` 的 `listGroups` 给出，
 * 确认框据此说「其中 N 个不是完全重复，是内容不一样的另一个版本——
 * 删掉之后那份内容在库里就没有了」。
 *
 * 而 `canDelete` 是**逐个文件**的安全阀，界面走的是 `version.keepOnly`
 * （它内部每删一个都会先过一遍这里）。让界面再逐个问一次 canDelete 只会
 * 拿到同一句话的第二个来源——本文件开头那条「同一份约定抄成几份必然分叉」。
 * 这两个字段是给外部工具和 `delete_log` 用的。
 */
export interface DeleteCheck {
  ok: boolean;
  reason?: string;
  /** 删掉它之后，磁盘上还留着的同一本书的文件 */
  survivors: string[];
  /**
   * 幸存的那些是不是**字节完全相同**的副本。
   *
   * `true` = 删了等于没删，内容一个字节都不会丢。
   * `false` = 幸存的是同名同作者的**另一个版本**，内容不一样，删掉就真的没了。
   * 界面必须把这两种说清楚——它们的风险差着量级。
   */
  identical: boolean;
}

/**
 * 能不能删。**不改任何东西**，纯判断。
 *
 * 判据一度只认「字节完全相同」。理论上最安全，实际上**在真实书库里一次都触发不了**：
 * 用户那 8000 本里内容相同的 hash 组是 **0**，六组「多版本」全是
 * 「校对版 vs 精校版」——同一本书，内容不一样。于是删除按钮全程点不动，
 * 而界面还不说明为什么。安全阀严到没人能用，就不是安全阀，是坏了。
 *
 * 现在分两档，都允许删，但界面要如实标明是哪一档：
 *   - **内容完全相同**：删了等于没删。
 *   - **同名同作者的另一个版本**：内容不一样，删掉就没了。归组口径和
 *     `versions.ts` 的 `listGroups` 一致（书名作者去空白转小写）。
 */
export async function canDelete(db: DatabaseSync, fileId: number): Promise<DeleteCheck> {
  const f = db
    .prepare(
      `select f.id, f.book_id, f.path, f.content_hash, f.is_primary, b.title, b.author
         from book_file f join book b on b.id = f.book_id where f.id = ?`,
    )
    .get(fileId) as
    | {
        id: number; book_id: number; path: string; content_hash: string | null;
        is_primary: number; title: string; author: string | null;
      }
    | undefined;

  if (!f) return { ok: false, reason: '没有这个文件记录', survivors: [], identical: false };

  // 记录说还在不算数——那些文件可能早就被别处删掉了，**逐个去磁盘上确认**
  const alive = async (rows: Array<{ path: string }>) => {
    const out: string[] = [];
    for (const r of rows) {
      if (await stat(r.path).then(() => true, () => false)) out.push(r.path);
    }
    return out;
  };

  const identical = f.content_hash
    ? await alive(
        db
          .prepare('select path from book_file where content_hash = ? and id != ?')
          .all(f.content_hash, fileId) as unknown as Array<{ path: string }>,
      )
    : [];

  if (identical.length > 0) {
    return await guardEmptyBook(db, f, identical, true);
  }

  /*
   * 没有完全相同的副本，退一步：同名同作者的另一个版本还在吗。
   *
   * ⚠️ **归组由 `bookKey` 说了算，SQL 只负责收窄候选。**
   * 原来这一句整个判据写在 SQL 里（`lower(trim(...)) = lower(trim(?))`），
   * 而「重复的书」那个列表用的是 `versions.ts` 的 `bookKey`（JS 的
   * `.trim().toLowerCase()`）——**同一件事两套口径，必然分叉**：
   *
   *   sqlite  lower('CAFÉ') = 'cafÉ'      JS = 'café'      （lower 只认 ASCII）
   *   sqlite  trim('　三体　') 原样不动     JS = '三体'      （trim 不吃全角空格）
   *
   * SQL 的归一化比 JS 弱，所以 SQL 判等是 JS 判等的**子集**：界面把两本归成
   * 一组、这里却找不到同伴，于是删除按钮点不动，理由还写着「磁盘上没有找到
   * 这本书的另一个文件」——一句事实上错误的话。正是本文件开头那条
   * 「严到没人能用的安全阀不是安全阀，是坏了」，换了个更隐蔽的形状。
   *
   * 现在 SQL 只做一次预筛（去掉半角和全角空格、ASCII 转小写），
   * 最终判等交给 `bookKey` —— 全应用唯一的那一份。
   *
   * ⚠️ **这个预筛并不是 `bookKey` 的完全超集**，别把它读成「宽松所以肯定够宽」：
   * sqlite 的 `lower()` 只折 ASCII，所以两本只在**非 ASCII 字母大小写**上不同的书
   * （`Ⅱ` U+2161 vs `ⅱ` U+2171、全角 `Ａ` vs `ａ`）会在这一步就被筛掉，
   * `bookKey` 根本没机会判。
   *
   * 没有为它加机械，是**量过之后**的决定：真实库 8172 本里书名带
   * 「非 ASCII 且有大小写」字符的只有 8 本（全是《诛仙Ⅱ》这类罗马数字续集），
   * 而 `bookKey` 归成一组、预筛却会漏掉同伴的组是 **0 组**——
   * 同一本书的两个文件，书名是从文件名里解析出来的同一串字符，
   * 不会一份大写一份小写。要改先重跑这个普查。
   */
  const norm = "replace(replace(lower(%s), ' ', ''), char(12288), '')";
  const versions = await alive(
    (db
      .prepare(
        `select f.path, b.title, b.author from book_file f join book b on b.id = f.book_id
          where ${norm.replace('%s', 'b.title')} = ${norm.replace('%s', '?')}
            and f.id != ?`,
      )
      .all(f.title, fileId) as unknown as Array<{ path: string; title: string; author: string | null }>)
      .filter((r) => bookKey(r.title, r.author) === bookKey(f.title, f.author)),
  );

  if (versions.length === 0) {
    return {
      ok: false,
      reason: '磁盘上没有找到这本书的另一个文件——删了这本书就彻底没有了',
      survivors: [],
      identical: false,
    };
  }

  return await guardEmptyBook(db, f, versions, false);
}

/** 删完这本书会不会变成空记录？空了没关系，但**不能连着阅读进度和书签一起没**了 */
async function guardEmptyBook(
  db: DatabaseSync,
  f: { book_id: number; title: string },
  survivors: string[],
  identical: boolean,
): Promise<DeleteCheck> {

  // 删完这本书会不会变成没有文件的空记录？
  //
  // ⚠️ 这一步的判据一度写错成「这本书下的文件数 ≤ 1 就不许删」。
  // 但**完全重复最典型的形态恰恰是「同一本书被扫成了两条记录」**——
  // 扫描时 hash 相同但旧路径还在，就各自建了一本书，于是两边的文件数都是 1，
  // 结果是「明明有副本却一个都删不掉」。实测就是这么翻车的。
  //
  // 正确的判据是：内容有副本就可以删；删完这本书空了的话，
  // **只有在它没有阅读进度也没有书签时**才连记录一起清掉。
  const siblings = (
    db.prepare('select count(*) n from book_file where book_id = ?').get(f.book_id) as { n: number }
  ).n;

  if (siblings <= 1) {
    /*
     * **拦下来的时候要说清是哪一样。**
     *
     * 原来这里只数一个总数，报错一律写「有阅读进度或书签」，而判据里还包含
     * 评分和短评——于是一本你打过分、从没读过的书被拦下来，用户看到的是
     * 「有阅读进度」（没有）加上一句「先把进度挪到另一份上」（没有进度可挪）。
     * 报错是用户唯一会照着做的那句话，指错了他就照着错的做。
     */
    const p = db
      .prepare(
        `select
           (select count(*) from bookmark where book_id = ?) as marks,
           (select count(*) from highlight where book_id = ?) as notes,
           (select count(*) from reading_state where book_id = ?
             and (chapter_idx > 0 or percent > 0 or last_read_at is not null)) as progress,
           (select count(*) from reading_state where book_id = ?
             and (rating is not null or comment is not null or drop_reason is not null)) as review,
           (select count(*) from book_tag where book_id = ?) as tags,
           -- ⚠️ 键在 JS 里拼好整串再传，**别写 'viewer.' || ?**：
           -- node:sqlite 把 JS 数字绑成 REAL，那条拼出来是 'viewer.7.0'，永远匹配不上，
           -- 而且不报错——这条判据会静默失效。（列拼串没这个问题，见 library.ts 那处。）
           (select count(*) from app_setting where key = ?) as viewerPos,
           -- **自建目录**（outline.<bookId>，迁移 24）。同上：也是一行按 id 命名的设置，
           -- 上面那几个 count 一个都看不见它
           (select count(*) from app_setting where key = ?) as outline`,
      )
      .get(f.book_id, f.book_id, f.book_id, f.book_id, f.book_id,
        `viewer.${f.book_id}`, `outline.${f.book_id}`) as
      { marks: number; notes: number; progress: number; review: number; tags: number;
        viewerPos: number; outline: number };

    /*
     * ⚠ **弃坑原因和标签原来不在这张清单里。**
     *
     * 下面 `left === 0` 那一支会**连书记录一起删掉**（注释写着「canDelete
     * 已经确认过它没有进度也没有书签」），于是一本只打过标签、
     * 或者只写了「烂尾了别看」的书，删掉它那个文件时**标签和那句话一起没了**，
     * `delete_log` 里只有文件，撤不回来。
     *
     * 这是同一份清单的第二处——`library.ts` 的 `repairLibrary` 那个孤儿判据
     * 漏的正是同样两样（那边是当场量出来的：四本手工添的书跑一次「整理数据库」，
     * 只有写过短评的活下来）。**「什么算用户自己的东西」这句话每抄一份就漏一样。**
     */
    const has: string[] = [];
    if (p.review) has.push('你写的评分、短评或弃坑原因');
    if (p.tags) has.push('你打的标签');
    if (p.progress) has.push('阅读进度');
    if (p.marks) has.push('书签');
    if (p.notes) has.push('划线');
    /*
     * ⚠ **PDF / EPUB 的阅读进度不在 `reading_state` 里。**
     *
     * 查看器把它存进 `app_setting` 的 `viewer.<bookId>`（PDF 是页码、EPUB 是章序号），
     * 那是有意的——`chapter_count` 对只编目的格式天生是 0，塞进 `reading_state`
     * 会让卡片显示「读到 12/0」、百分比还除零。
     * 代价是**上面那几个 count 一个都看不见它**：一本你读了一百页的 PDF，
     * 在这张清单眼里是「什么都没有」，于是删掉它最后一个文件时连书记录一起没，
     * 而那个页码重扫恢复不了。
     *
     * 这是同一份清单漏的**第三样**（前两样是弃坑原因和标签）。上面那句
     * 「每抄一份就漏一样」写下之后，果然又漏了一样——只不过这次漏的不是一列，
     * 是**一整个存储位置**。
     */
    if (p.viewerPos) has.push('PDF / EPUB 读到哪一页');
    if (p.outline) has.push('你自己加的目录');

    if (has.length) {
      return {
        ok: false,
        reason:
          `《${f.title}》只有这一个文件，而它带着${has.join('、')}——那些重扫恢复不了。`
          + (p.progress || p.marks || p.notes
            ? '先把这些挪到另一份上，或者留着这个文件。'
            : '要删的话先把这本书的评价和标签记到留下的那一份上。'),
        survivors,
        identical,
      };
    }
  }

  return { ok: true, survivors, identical };
}

export type TrashFn = (path: string) => Promise<void>;

export interface DeleteResult {
  deleted: Array<{ path: string; survivors: string[] }>;
  failed: Array<{ path: string; reason: string }>;
}

/**
 * 把重复文件送进回收站，并清掉对应的记录。
 *
 * `trash` 由 main.ts 传 Electron 的 `shell.trashItem`——**这个模块自己不 import
 * electron**，否则就没法在普通 Node 测试里跑，而这是全项目最需要测的一段代码。
 */
export async function deleteDuplicates(
  db: DatabaseSync,
  fileIds: number[],
  trash: TrashFn,
  /**
   * **回收站收不下时，把文件搬到这个目录里**（不给就照旧记成失败）。
   *
   * ⚠️ **这不是真删，铁律 1 没有被破**：文件还在磁盘上、还能拿回来，
   * 只是从书库目录挪进了应用自己的目录——和送进回收站是同一件事的两种做法。
   * 所以**不限于「内容完全相同」的重复**：移动不丢内容，
   * 那道只对 `identical` 放行的闸是给真删用的，这里没有存在的理由。
   *
   * 真实场景：网络共享上没有回收站（实测 `shell.trashItem` 抛
   * `Failed to perform delete operation`），而那儿的重复文件照样占着空间。
   */
  暂存目录?: string,
): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: [], failed: [] };

  for (const fileId of fileIds) {
    const row = db
      .prepare(
        `select f.path, f.size, f.content_hash, f.is_primary, f.book_id, b.title
           from book_file f join book b on b.id = f.book_id where f.id = ?`,
      )
      .get(fileId) as
      | { path: string; size: number; content_hash: string | null; is_primary: number; book_id: number; title: string }
      | undefined;
    if (!row) {
      result.failed.push({ path: `#${fileId}`, reason: '记录不存在' });
      continue;
    }

    const check = await canDelete(db, fileId);
    if (!check.ok) {
      result.failed.push({ path: row.path, reason: check.reason ?? '不允许删除' });
      continue;
    }

    /** 这一份搬进暂存区了吗（以及搬到哪儿）——`delete_log` 要如实记 */
    let 暂存到: string | null = null;
    try {
      // 先真的送进回收站，**成功之后**才动数据库。
      // 反过来的话中途失败会留下「记录没了但文件还在」，下次扫描又收一遍
      await trash(row.path);
    } catch (e) {
      /*
       * 回收站没收下（网络共享上就没有回收站）。
       *
       * **没给暂存区就照旧记成失败**——默认那条路一个字节都不动。
       * 给了才搬进去，而搬运**不限于「内容完全相同」的那些**：
       * 移动不丢内容，那道只对 `identical` 放行的闸是给真删用的，这里不成立。
       */
      if (!暂存目录) {
        result.failed.push({ path: row.path, reason: await 说人话(row.path, e) });
        continue;
      }
      try {
        暂存到 = await 搬进暂存区(暂存目录, row.path, Date.now());
      } catch (e2) {
        result.failed.push({ path: row.path, reason: await 说人话(row.path, e2) });
        continue;
      }
    }

    db.exec('begin');
    try {
      db.prepare(
        'insert into delete_log(path, size, content_hash, book_title, reason) values(?,?,?,?,?)',
      ).run(
        row.path, row.size, row.content_hash, row.title,
        // ⚠️ **搬进暂存区的要写清搬到哪儿了**：回收站里找不到它，别让人白找一趟
        暂存到
          ? `${check.identical ? '内容完全相同的重复文件' : '同名同作者的另一个版本'}；回收站用不了（多半在网络盘上），已移到暂存区：${暂存到}`
          : check.identical ? '内容完全相同的重复文件，已移入回收站' : '同名同作者的另一个版本，已移入回收站',
      );
      db.prepare('delete from book_file where id = ?').run(fileId);

      const left = (
        db.prepare('select count(*) n from book_file where book_id = ?').get(row.book_id) as {
          n: number;
        }
      ).n;

      if (left === 0) {
        // 这本书没文件了。canDelete 已经确认过它没有进度也没有书签，
        // 留着只会在书架上多一条点开就报错的空记录
        db.prepare('delete from book where id = ?').run(row.book_id);
      } else if (row.is_primary === 1) {
        // 删的是主版本，得指一个新的，否则这本书读不了。
        // 判据在 `primary.ts`——扫描和合并那两处用的是同一份
        ensurePrimary(db, row.book_id);
      }
      db.exec('commit');
    } catch (e) {
      db.exec('rollback');
      result.failed.push({ path: row.path, reason: `文件已进回收站，但记录没更新：${String(e)}` });
      continue;
    }

    result.deleted.push({ path: row.path, survivors: check.survivors });
  }

  return result;
}

/**
 * 「只留这一份」——把一组同名同作者的文件收成一份，一步做完。
 *
 * **为什么要有这个函数**：界面上原来摊着三样东西，而它们对应的是同一个意图。
 * 「合并成一本」只并数据库记录，文件一个不动——点完之后组里**还是两个文件、
 * 还列在「重复的书」里**，唯一的变化是那个按钮自己消失了。从用户的位置看
 * 就是「点了没反应」，而这正是「合并成一本」这个名字承诺的事情没做到。
 * 再要真的只剩一份，还得自己去勾「主」、勾「删」、点按钮、确认。
 *
 * 三步的顺序不能换：
 *
 * 1. **先合并 book 记录。** 合完所有文件都挂在同一本书下，于是删掉其中一个
 *    不会把某本书清空——`canDelete` 第 2 条（会变空的书不能有进度）因此
 *    根本不会被触发。反过来先删就可能撞上它，而那是个假问题：
 *    这本书的另一份明明还在。
 * 2. **再设主版本**，尊重用户选的那一份。`deleteDuplicates` 自己也会在删掉
 *    主版本时另指一个，但那是兜底，不是用户的选择。
 * 3. **最后才动磁盘。** 一律走 `deleteDuplicates`——两档判据、
 *    `shell.trashItem`、`delete_log` 一条不少。这个函数不绕开任何安全阀，
 *    它只是把点击次数从五次收成一次。
 */
export async function keepOnly(
  db: DatabaseSync,
  keepFileId: number,
  dropFileIds: number[],
  trash: TrashFn,
  /** 见 `deleteDuplicates` 那个同名参数：回收站收不下时搬到这儿 */
  暂存目录?: string,
): Promise<DeleteResult & { keptBookId: number }> {
  if (!dropFileIds.length) throw new Error('没有要删的文件');
  if (dropFileIds.includes(keepFileId)) throw new Error('要留的那份不能同时在删除名单里');

  const ids = [keepFileId, ...dropFileIds];
  const rows = db
    .prepare(`select id, book_id as bookId from book_file where id in (${ids.map(() => '?').join(',')})`)
    .all(...ids) as unknown as Array<{ id: number; bookId: number }>;
  if (rows.length !== ids.length) throw new Error('有文件记录不存在');

  const bookIds = [...new Set(rows.map((r) => r.bookId))];
  const keptBookId = bookIds.length > 1 ? mergeBooks(db, bookIds).keptBookId : bookIds[0];
  setPrimary(db, keepFileId);
  const result = await deleteDuplicates(db, dropFileIds, trash, 暂存目录);
  return { ...result, keptBookId };
}

/**
 * `delete_log` 的一行。**形状定在这儿，渲染进程从 core 引**——
 * 手抄一份的话加一列就会漏改一处，而且不报错（`dup-decls.mjs` 盯的就是这个）。
 */
export interface DeleteLogRow {
  id: number;
  path: string;
  size: number | null;
  content_hash: string | null;
  book_title: string | null;
  /** sqlite 的 UTC 文本。印之前必须走 `format.ts` 的 `whenAgo` */
  deleted_at: string;
  /**
   * 为什么删的，**以及去哪儿了**。
   * core 在这句里已经把去处写全了（「已移入回收站」／「已移到暂存区：<完整路径>」）——
   * 界面原样摆出来，别另编一句：暂存区那个路径带时间戳，猜不出来，
   * 而它是用户找回文件的唯一线索。
   */
  reason: string | null;
}

/** 回收站里有哪些是这个程序送进去的。界面上如实告诉用户「去回收站找」 */
export function deleteHistory(db: DatabaseSync, limit = 100): DeleteLogRow[] {
  // `node:sqlite` 回的是 null 原型对象、列名就是库里的 snake_case——
  // `DeleteLogRow` 就是按库里那几列写的，所以这里只需要断言，不做转换
  return db
    .prepare('select * from delete_log order by id desc limit ?')
    .all(limit) as unknown as DeleteLogRow[];
}
