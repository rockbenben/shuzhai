// 书籍元数据编辑与批量操作（spec §3.1 / §3.2）。
//
// 这里全是**只改数据库、不碰磁盘文件**的操作。改文件名是另一回事，走 rename.ts
// （spec §3.3），那条路要预览、要日志、要能撤销。
//
// 两条贯穿的规矩：
//   1. **可写字段是白名单**，不是「把传进来的对象展开」。否则一个手滑的 params
//      就能改掉 content_hash 或 path，让记录和磁盘对不上。
//   2. **批量操作一律先给预览、后执行**，尤其是从文件名提取元数据——那是猜测，
//      猜错了会把用户手填的书名冲掉。

import type { DatabaseSync } from 'node:sqlite';
import { basename } from 'node:path';
import type { Encoding } from './encoding.ts';
import { parseFilename } from './filename.ts';
import { parseAndStore } from './scan.ts';
// 连载状态的清单从 `labels.ts` 那份算——**这里原来抄了一份纯 id 的**，
// 而抄的那份迟早掉队（本仓库那条「同一份约定抄成几份必然分叉」）
import { SERIAL_STATUS } from './labels.ts';

/**
 * 能改的字段。**是白名单不是黑名单**：漏掉一个只是少一样能改的东西，
 * 而放行一个不该改的（`path` / `content_hash`）会让记录和磁盘对不上。
 */
const EDITABLE = new Set([
  'title', 'author', 'aliases', 'intro', 'note', 'source_site', 'serial_status', 'cover_path',
]);


/**
 * 改一本书的元数据。
 *
 * **不认识的字段一律抛，不是悄悄丢掉。** 原来是 `filter(k => EDITABLE.has(k))`，
 * 只有「一个能写的都没有」时才报错——于是 `{ title: 'x', athor: 'y' }`
 * 会默默只写 title 并返回成功，而调用方以为作者也改了。
 * §13 说外部调用方最容易错的就是参数名，这条 rpc 正是对外开放的那条。
 *
 * **返回真的改了几行**（`changes`），不是「试了几次」——`batchUpdate` 的计数靠它。
 */
export function updateBook(db: DatabaseSync, id: number, fields: Record<string, unknown>): number {
  const keys = Object.keys(fields);
  const 不认识 = keys.filter((k) => !EDITABLE.has(k));
  if (不认识.length > 0) {
    throw new Error(`不能改的字段：${不认识.join('、')}。能改的是 ${[...EDITABLE].join(' / ')}`);
  }
  if (keys.length === 0) throw new Error('没有可写的字段');

  /*
   * **用户打的字：前后空白去掉，只剩空白的当作没填。** 三样后果都是量出来的：
   * 书名能被清空（卡片上一本没名字的书，而 `bookKey('')` 还会和别的空书名撞成同一本）、
   * 书名前面留一个空格就排到了按书名排序的最前面、作者只剩空格时不是 null，
   * 「有作者」成立而显示出来是空的。
   */
  const 值 = new Map<string, string | number | null>();
  for (const k of keys) {
    const v = fields[k];
    if (typeof v === 'string') {
      const t = v.trim();
      if (k === 'title') {
        if (!t) throw new Error('书名不能为空——它是这本书在书架上唯一的名字');
        值.set(k, t);
      } else if (k === 'serial_status') {
        // 这一列是 not null，转成 null 会撞出一句 sqlite 原文。清单从 `labels.ts`
        // 那份算，别在这儿另抄一份（`SERIAL_STATUS` 加一档时漏改一处就静默失效）
        const ok = SERIAL_STATUS.map((s) => s.id);
        if (!ok.includes(t)) {
          throw new Error(`不认识的连载状态「${t}」。能用的是 ${ok.join(' / ')}`);
        }
        值.set(k, t);
      } else 值.set(k, t || null);
    } else 值.set(k, v === undefined ? null : (v as string | number | null));
  }

  const sets = [...值.keys()].map((k) => `${k} = ?`).join(', ');
  return db
    .prepare(`update book set ${sets}, updated_at = datetime('now') where id = ?`)
    .run(...值.values(), id).changes as number;
}

/** 批量改同一批字段（批量设连载状态、批量改来源站点等） */
export function batchUpdate(
  db: DatabaseSync,
  ids: number[],
  fields: Record<string, unknown>,
): { updated: number } {
  let updated = 0;
  db.exec('begin');
  try {
    // **数的是「真的改了几行」，不是「试了几次」**——传一堆不存在的 id 进来，
    // 无条件 `++` 会报「改了 N 本」而库里一行没动（AGENTS：真相是 `changes`）
    for (const id of ids) updated += updateBook(db, id, fields);
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return { updated };
}

export interface ExtractRow {
  bookId: number;
  filename: string;
  currentTitle: string;
  currentAuthor: string | null;
  title: string;
  author: string | null;
  /** 和现在完全一样时为 false，界面上灰显、默认不勾 */
  changed: boolean;
}

/**
 * 从文件名批量提取书名作者的**预览**（spec §3.2）。只算不写。
 * 界面拿到这张表之后逐行可取消勾选，确认了才调 `applyExtracted`。
 */
export function previewExtract(db: DatabaseSync, ids?: number[]): ExtractRow[] {
  const rows = (
    ids && ids.length > 0
      ? db
          .prepare(
            `select b.id, b.title, b.author, f.path
               from book b join book_file f on f.book_id = b.id and f.is_primary = 1
              where b.id in (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids)
      : db
          .prepare(
            `select b.id, b.title, b.author, f.path
               from book b join book_file f on f.book_id = b.id and f.is_primary = 1
              order by b.id`,
          )
          .all()
  ) as Array<{ id: number; title: string; author: string | null; path: string }>;

  return rows.map((r) => {
    const filename = basename(r.path);
    const info = parseFilename(filename);
    const author = info.author ?? null;
    return {
      bookId: r.id,
      filename,
      currentTitle: r.title,
      currentAuthor: r.author,
      title: info.title,
      author,
      changed: info.title !== r.title || author !== r.author,
    };
  });
}

/** 应用提取结果。只写传进来的这些行——界面上取消勾选的不会出现在这里 */
export function applyExtract(
  db: DatabaseSync,
  rows: Array<{ bookId: number; title: string; author: string | null }>,
): { updated: number } {
  let updated = 0;
  db.exec('begin');
  try {
    for (const r of rows) {
      // **数的是「真的改了几行」，不是「传进来几行」。** 原来直接
      // `return { updated: rows.length }`——传一个不存在的 bookId 进来
      // （§13 说外部调用方最容易错的就是 id），UPDATE 影响 0 行而它照样计数，
      // 界面上写着「已经改好 40 本」而库里只动了 39 本
      updated += db
        .prepare("update book set title = ?, author = ?, updated_at = datetime('now') where id = ?")
        .run(r.title, r.author, r.bookId).changes as number;
    }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return { updated };
}

export interface ReparseResult {
  ok: number;
  failed: Array<{ bookId: number; error: string }>;
}

/**
 * 批量重新解析（spec §3.2）。传 `encoding` 就是「手动指定编码并重新解析」（spec §2.1）。
 * 逐本执行，一本失败不影响其它——批量操作最忌讳一颗老鼠屎让整锅都不动。
 */
export async function reparseBooks(
  db: DatabaseSync,
  ids: number[],
  /**
   * 指定编码重解。
   *
   * `'auto'` 是**解锁**：把「这个编码是用户选的」那条记号去掉，回到探测。
   * 没有它的话，挑错一次就再也回不去了——同规则编辑器那个「清除规则」，
   * **凡是能锁住的东西都得有一条解锁的路**。
   */
  encoding?: Encoding | 'auto',
): Promise<ReparseResult> {
  const result: ReparseResult = { ok: 0, failed: [] };

  for (const bookId of ids) {
    const file = db
      .prepare('select id, path from book_file where book_id = ? and is_primary = 1')
      .get(bookId) as { id: number; path: string } | undefined;
    if (!file) {
      result.failed.push({ bookId, error: '没有主文件' });
      continue;
    }

    try {
      // 「回到自动探测」：先把记号去掉，`parseAndStore` 那边就会重新探测
      if (encoding === 'auto') {
        db.prepare('update book_file set encoding_locked = 0 where id = ?').run(file.id);
      }
      /*
       * 这本书自己设的章节规则由 `parseAndStore` 去查——**这里原来抄了一份
       * 同样的 SQL**，而抄的那几份里扫描那条路一份都没有，规则就是在那儿丢的。
       * 现在唯一那份在 `book-rule.ts`。
       */
      const r = await parseAndStore(
        db,
        file.id,
        file.path,
        undefined,
        encoding === 'auto' ? undefined : encoding,
      );
      db.prepare(
        `update book_file set encoding = ?, chapter_count = ?, word_count = ?,
                status = 'ok', parse_error = null, failed_at = null,
                parsed_at = datetime('now') where id = ?`,
      ).run(r.encoding, r.chapters, r.words, file.id);
      result.ok++;
    } catch (e) {
      const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      result.failed.push({ bookId, error });
      db.prepare(
        `update book_file set status = 'parse_failed', parse_error = ?,
                failed_at = datetime('now') where id = ?`,
      ).run(error.slice(0, 500), file.id);
    }
  }

  return result;
}

/** 单本书的完整信息，编辑弹窗用 */
export function bookDetail(db: DatabaseSync, id: number): unknown {
  return db
    .prepare(
      `select b.*, f.path, f.encoding, f.encoding_locked, f.size, f.word_count, f.chapter_count,
              f.status as file_status, f.parsed_at,
              r.status as reading_status, r.percent, r.rating, r.comment, r.drop_reason
         from book b
         left join book_file f on f.book_id = b.id and f.is_primary = 1
         left join reading_state r on r.book_id = b.id
        where b.id = ?`,
    )
    .get(id);
}
