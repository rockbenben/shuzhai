// 文件重命名（spec §3.3）。
//
// **这是整个程序里唯一会改用户磁盘文件的功能。** spec 给它配了一整套安全阀，
// 一条都不能省：预览、逐行可取消、冲突标红、超 50 个二次确认、写日志、可撤销。
// 判定和执行分成两步，中间隔着用户点的那一下——`preview` 不碰任何文件。
//
// Windows 的坑在这个功能上格外密，逐条都在下面的常量和注释里写明了出处。

import { rename, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FileCache } from './reader.ts';

/** Windows 文件名里不允许的字符 */
const ILLEGAL = /[\\/:*?"<>|]/g;

/**
 * Windows 保留设备名。带不带扩展名都不行（`CON.txt` 一样建不出来），
 * 大小写不敏感。
 */
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** 传统 MAX_PATH。超了要截断书名部分并提示（spec §3.3） */
const MAX_PATH = 260;

/** 可撤销的批次数上限（spec §3.3：至少保留最近 20 批） */
export const UNDO_BATCHES = 20;

/** 超过这个数量要二次确认（spec §3.3） */
export const CONFIRM_THRESHOLD = 50;

export const PRESETS = [
  { label: '《书名》作者', template: '《{title}》{author}{ext}' },
  { label: '作者 - 书名', template: '{author} - {title}{ext}' },
  { label: '书名（状态）', template: '{title}（{status}）{ext}' },
  { label: '书名', template: '{title}{ext}' },
];

const STATUS_CN: Record<string, string> = {
  ongoing: '连载中',
  finished: '已完结',
  abandoned: '太监',
  unknown: '未知',
};

export interface TemplateVars {
  title: string;
  author: string | null;
  status: string;
  wordcount: number | null;
  index: number;
  ext: string;
}

/** 套模板。缺失的变量替换成空串，不留下 `{author}` 这种字面量 */
export function renderTemplate(template: string, v: TemplateVars): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    switch (key) {
      case 'title': return v.title;
      case 'author': return v.author ?? '';
      case 'status': return STATUS_CN[v.status] ?? '';
      case 'wordcount': return v.wordcount === null ? '' : String(v.wordcount);
      case 'index': return String(v.index);
      case 'ext': return v.ext;
      default: return '';
    }
  });
}

export interface SanitizeResult {
  name: string;
  /** 有没有真的改动过。界面上要据此标「含非法字符」 */
  sanitized: boolean;
}

/**
 * 把一个文件名弄合法：
 *   - 非法字符换成占位符
 *   - **去掉整个文件名结尾的空格和点号**——Windows 会自己吃掉它们，
 *     于是「你以为改成了 `书名.`」和「磁盘上实际是 `书名`」对不上，
 *     下一次扫描就会判成又一次改名
 *   - 撞上保留设备名就加个下划线
 *
 * ⚠️ 那条「结尾」规则只对**整个文件名**成立，不是对主干名。
 * `书名...txt` 结尾是 `t`，完全合法，不该动它；一度按主干名去掉尾点，
 * 把它改成了 `书名.txt`——那是在改用户没让改的东西。
 */
export function sanitizeFilename(name: string, placeholder = '_'): SanitizeResult {
  let out = name.replace(ILLEGAL, placeholder).replace(/[ .]+$/, '');
  if (out === '') out = placeholder;

  const ext = extname(out);
  const stem = ext ? out.slice(0, -ext.length) : out;
  if (RESERVED.has(stem.toUpperCase())) out = `${stem}${placeholder}${ext}`;

  return { name: out, sanitized: out !== name };
}

/** 路径太长时截断**书名部分**而不是扩展名，扩展名丢了文件就打不开了 */
export function fitPathLength(dir: string, filename: string): { name: string; truncated: boolean } {
  const full = join(dir, filename);
  if (full.length <= MAX_PATH) return { name: filename, truncated: false };

  const ext = extname(filename);
  const room = MAX_PATH - dir.length - 1 - ext.length;
  if (room <= 0) return { name: filename, truncated: true }; // 目录本身就太深，救不了
  return { name: filename.slice(0, room) + ext, truncated: true };
}

export type RowStatus = 'ok' | 'unchanged' | 'conflict' | 'sanitized' | 'too-long' | 'missing';

export interface RenameRow {
  fileId: number;
  bookId: number;
  dir: string;
  oldName: string;
  newName: string;
  status: RowStatus;
  /** 给用户看的一句话，冲突和非法字符都要说清为什么 */
  note?: string;
}

export interface PreviewOptions {
  template: string;
  placeholder?: string;
  /** 目标已存在时怎么办。默认跳过并标红（spec §3.3） */
  onConflict?: 'skip' | 'number';
}

interface BookFileRow {
  file_id: number;
  book_id: number;
  path: string;
  title: string;
  author: string | null;
  serial_status: string;
  word_count: number | null;
  file_status: string;
}

/**
 * 试算重命名结果。**只读磁盘做冲突检查，不改任何文件。**
 * 返回的每一行都带状态，界面按状态标色、逐行可取消勾选。
 */
export async function previewRename(
  db: DatabaseSync,
  bookIds: number[],
  opts: PreviewOptions,
): Promise<RenameRow[]> {
  if (bookIds.length === 0) return [];

  const rows = db
    .prepare(
      `select f.id as file_id, b.id as book_id, f.path, b.title, b.author,
              b.serial_status, f.word_count, f.status as file_status
         from book b join book_file f on f.book_id = b.id and f.is_primary = 1
        where b.id in (${bookIds.map(() => '?').join(',')})
        order by b.title`,
    )
    .all(...bookIds) as unknown as BookFileRow[];

  const out: RenameRow[] = [];
  // 同一批里两本书算出同一个名字，也是冲突——只查磁盘会漏掉这种
  const claimed = new Set<string>();

  for (const [i, r] of rows.entries()) {
    const dir = dirname(r.path);
    const oldName = basename(r.path);
    const ext = extname(oldName);

    const raw = renderTemplate(opts.template, {
      title: r.title,
      author: r.author,
      status: r.serial_status,
      wordcount: r.word_count,
      index: i + 1,
      ext,
    });

    const clean = sanitizeFilename(raw, opts.placeholder);
    const fitted = fitPathLength(dir, clean.name);
    let newName = fitted.name;

    const row: RenameRow = {
      fileId: r.file_id,
      bookId: r.book_id,
      dir,
      oldName,
      newName,
      status: 'ok',
    };

    if (r.file_status === 'missing') {
      row.status = 'missing';
      row.note = '文件已不在原位置';
    } else if (newName === oldName) {
      row.status = 'unchanged';
    } else {
      const key = join(dir, newName).toLowerCase(); // Windows 大小写不敏感
      const selfKey = join(dir, oldName).toLowerCase();
      let taken = claimed.has(key);

      if (!taken && key !== selfKey) {
        taken = await stat(join(dir, newName)).then(
          () => true,
          () => false,
        );
      }

      if (taken) {
        if (opts.onConflict === 'number') {
          const stem = newName.slice(0, newName.length - ext.length);
          let n = 2;
          let candidate = `${stem}(${n})${ext}`;
          while (
            claimed.has(join(dir, candidate).toLowerCase()) ||
            (await stat(join(dir, candidate)).then(() => true, () => false))
          ) {
            candidate = `${stem}(${++n})${ext}`;
          }
          newName = candidate;
          row.newName = candidate;
          row.note = `目标已存在，自动加序号 (${n})`;
        } else {
          row.status = 'conflict';
          row.note = '目标文件名已存在';
        }
      }

      if (row.status === 'ok') {
        if (fitted.truncated) {
          row.status = 'too-long';
          row.note = `完整路径超过 ${MAX_PATH} 字符，书名已截断`;
        } else if (clean.sanitized) {
          row.status = 'sanitized';
          row.note = '含非法字符或结尾空格/点号，已替换';
        }
        claimed.add(join(dir, row.newName).toLowerCase());
      }
    }

    out.push(row);
  }

  return out;
}

export interface RenameReport {
  batchId: string;
  ok: number;
  failed: Array<{ oldName: string; error: string }>;
}

/**
 * 执行重命名。**逐个执行，一个失败不影响其它**（spec §3.3 的「原子性」那一条
 * 指的就是这个，不是全体回滚——半路回滚需要再改一次文件名，风险更大）。
 *
 * 每成功一个立刻做两件事：更新 `book_file.path`、写一条 `rename_log`。
 * 不等整批结束——中途崩了的话，已改的那些必须在库里对得上。
 */
/** 只改大小写：Windows 认为源和目标是同一个文件 */
const caseOnly = (from: string, to: string): boolean => from.toLowerCase() === to.toLowerCase();

/**
 * 把文件挪到新名字上。**改名和撤销都从这儿走**——两边要的是同一件事，
 * 而下面那两条判据抄成两份必然分叉（本仓库栽过好几次）。
 *
 * **目标已经被别的文件占着就不动。** `fs.rename` 在 Windows 上是静默覆盖的
 * （当场量过：a.txt 改成已存在的 b.txt，不报错、不进回收站，b.txt 原来的内容没了）。
 * 而被毁的那个**根本不在这一批里**：`rename_log` 里没有它，撤销把文件名改回去
 * 也换不回内容。删除那条路为了同一件事一律走 `shell.trashItem`
 * （见 `deletion.ts` 顶部：删错了还能拖回来，那才是让破例可控的根本原因），
 * 覆盖比它更狠。
 *
 * `previewRename` 早就标了 `conflict`、界面也把那些行的勾选框禁掉了——但那是**界面**。
 * rpc 对外开放（AGENTS.md §13），调用方自己算出来的 rows 走不到那道预览；
 * 而且预览和执行之间隔着一次用户点击，那期间目标位置可能刚被占上
 * （扫描、别的程序、上一批改名）。**撤销那头更要查**：把文件放回原路径时，
 * 原路径已经被重新占用是很平常的事。
 *
 * ponytail: 「同一个文件」用小写比较（Windows 语义）。大小写敏感的文件系统上
 * 要改成比 ino/dev，而这个应用只发 Windows。
 */
async function moveFile(from: string, to: string): Promise<void> {
  const same = caseOnly(from, to);
  if (!same && (await stat(to).then(() => true, () => false))) {
    throw new Error(`目标已经有一个 ${basename(to)} 了——不覆盖，这一个跳过了`);
  }
  // 只改大小写时 Windows 会认为源和目标是同一个文件，必须借道临时名
  if (same) {
    const tmp = `${to}.renaming-${Date.now()}`;
    await rename(from, tmp);
    await rename(tmp, to);
  } else {
    await rename(from, to);
  }
}

export async function applyRename(
  db: DatabaseSync,
  cache: FileCache | null,
  rows: RenameRow[],
  batchId: string,
): Promise<RenameReport> {
  const report: RenameReport = { batchId, ok: 0, failed: [] };

  for (const row of rows) {
    const from = join(row.dir, row.oldName);
    const to = join(row.dir, row.newName);
    if (from === to) continue;

    try {
      // 阅读器可能正开着这本书。Windows 上不先放开句柄，rename 会直接失败
      await cache?.release(from);
      await moveFile(from, to);

      db.prepare('update book_file set path = ? where id = ?').run(to, row.fileId);
      db.prepare(
        'insert into rename_log(batch_id, file_id, old_path, new_path) values(?,?,?,?)',
      ).run(batchId, row.fileId, from, to);
      report.ok++;
    } catch (e) {
      report.failed.push({
        oldName: row.oldName,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  pruneLog(db);
  return report;
}

/** 只留最近 UNDO_BATCHES 批，更早的删掉——日志无限长没有意义 */
function pruneLog(db: DatabaseSync): void {
  db.prepare(
    `delete from rename_log where batch_id not in (
       select batch_id from rename_log group by batch_id
        order by max(id) desc limit ?
     )`,
  ).run(UNDO_BATCHES);
}

export interface BatchInfo {
  batchId: string;
  count: number;
  renamedAt: string;
}

/** 可撤销的批次，最近的在前 */
export function undoableBatches(db: DatabaseSync): BatchInfo[] {
  return db
    .prepare(
      `select batch_id as batchId, count(*) as count, max(renamed_at) as renamedAt
         from rename_log where undone = 0
        group by batch_id order by max(id) desc limit ?`,
    )
    .all(UNDO_BATCHES) as unknown as BatchInfo[];
}

/**
 * 撤销一批重命名：按日志**逆序**把文件名改回去。
 * 逆序很重要——正序撤销时，前面那个改回去的名字可能正是后面那个当前占着的名字。
 */
export async function undoBatch(
  db: DatabaseSync,
  cache: FileCache | null,
  batchId: string,
): Promise<RenameReport> {
  const entries = db
    .prepare('select id, file_id, old_path, new_path from rename_log where batch_id = ? and undone = 0 order by id desc')
    .all(batchId) as Array<{ id: number; file_id: number; old_path: string; new_path: string }>;

  const report: RenameReport = { batchId, ok: 0, failed: [] };

  for (const e of entries) {
    try {
      await cache?.release(e.new_path);
      await moveFile(e.new_path, e.old_path);
      db.prepare('update book_file set path = ? where id = ?').run(e.old_path, e.file_id);
      db.prepare('update rename_log set undone = 1 where id = ?').run(e.id);
      report.ok++;
    } catch (err) {
      report.failed.push({
        oldName: basename(e.new_path),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}
