import type { DatabaseSync } from 'node:sqlite';
import { formatOf } from './book-format.ts';

/*
 * **主文件坏了就换一份还好的。**
 *
 * 起因是用户真实库上的一本《乌纱》：两个文件（校对版 / 精校版），
 * 校对版在磁盘上被删掉了，扫描把那条记录标成 `missing`——
 * **而它恰好是主文件，没人把旗子挪到旁边那份好的上**。后果不只是卡片上
 * 挂着「文件不见了」：`book.list` 的 `path` 取的就是主文件，
 * **这本书因此打不开**，虽然精校版好好地在磁盘上。
 *
 * 判据以前有两份（`deletion.ts` 删掉主文件之后改指一个、`versions.ts` 合并之后
 * 给 keeper 指一个），都只处理「主文件记录没了」，没有一处处理
 * 「主文件还在、但它坏了」。收成这一处，三个调用方共用。
 */

/**
 * 挑一个能用的主文件。**只在当前这个不可用时才动手。**
 *
 * ⚠️ **用户显式设过的主版本不许被悄悄改掉**（`version.setPrimary` 是他自己点的）。
 * 所以主文件 `status = 'ok'` 时这里一个字都不改，哪怕另一份更大。
 *
 * 三种情形：
 *   - 压根没有主文件（删掉之后、合并过来之后）→ 挑一个，优先 `ok`，再按字数；
 *   - 主文件坏了、而旁边有好的 → 换过去；
 *   - 主文件坏了、旁边也没好的 → **不动**（换一个同样坏的没有意义，
 *     而且会把「这本书的主文件是哪个」这件事变得没头没尾）。
 *
 * @returns 换过了就是 true
 */
export function ensurePrimary(db: DatabaseSync, bookId: number): boolean {
  const rows = db
    .prepare('select id, status, is_primary, ifnull(word_count, 0) as wc from book_file where book_id = ? order by id')
    .all(bookId) as unknown as Array<{ id: number; status: string; is_primary: number; wc: number }>;
  if (rows.length === 0) return false;

  const cur = rows.find((r) => r.is_primary === 1);
  if (cur && cur.status === 'ok') return false;

  // 优先挑状态好的；都不好而且本来就没有主文件时，退而求其次挑个最大的
  const 好的 = rows.filter((r) => r.status === 'ok');
  const 候选 = 好的.length ? 好的 : cur ? [] : rows;
  if (候选.length === 0) return false;

  const best = [...候选].sort((a, b) => b.wc - a.wc || a.id - b.id)[0];
  if (cur && best.id === cur.id) return false;

  db.prepare('update book_file set is_primary = 0 where book_id = ?').run(bookId);
  db.prepare('update book_file set is_primary = 1 where id = ?').run(best.id);
  return true;
}

/**
 * **只编目的文件不该压着一份能读的 txt。**
 *
 * 只在**这本书的文件集刚变过**的那一刻用（现在只有 `mergeBooks` 一处）。
 *
 * 起因：把 `三体.txt` 和 `三体.epub` 合成一本之后，主文件是 **EPUB**——
 * keeper 按阅读进度挑（两本都没进度就取 id 最小的那本），
 * 而败方的文件一律带着 `is_primary = 0` 搬过来，**keeper 自己那面旗从没被重问过**。
 * 当场量的：合并后 `epub is_primary=1 chapter_count=0`、`txt is_primary=0 chapter_count=2`。
 * 后果不是「主文件选得不够好」，是**这本书点开进的是查看器**：
 * 章节、书内搜索、朗读、划线一样都用不了，而那份带 2 章的 txt 就在旁边。
 *
 * ⚠️ **为什么不写进 `ensurePrimary`**：那个函数**每次扫描都跑**
 * （`scan.ts` 每本都调），把这条塞进去就等于「用户在『重复的书』里
 * 特意把 PDF 设成主版本，下一次扫描又被改回 txt」——
 * 正是它自己开头那条「用户显式设过的主版本不许被悄悄改掉」。
 * 这条只在合并那一下发生一次，用户随后照样可以改回去（`version.setPrimary`，
 * 界面上「重复的书」那一列就是它）。
 *
 * 判据用 `formatOf`——全应用唯一那一份，不在这里自己判扩展名。
 *
 * @returns 换过了就是 true
 */
export function preferReadable(db: DatabaseSync, bookId: number): boolean {
  const rows = db
    .prepare('select id, path, status, is_primary from book_file where book_id = ? order by id')
    .all(bookId) as unknown as Array<{ id: number; path: string; status: string; is_primary: number }>;

  const cur = rows.find((r) => r.is_primary === 1);
  // 没有主文件、或者现在这个本来就能读 —— 都不是这条要管的事（交给 ensurePrimary）
  if (!cur || formatOf(cur.path) === 'text') return false;

  // 只换给「能读而且是好的」；一份坏掉的 txt 不比一本能翻的 EPUB 强
  const 能读的 = rows.filter((r) => formatOf(r.path) === 'text' && r.status === 'ok');
  if (能读的.length === 0) return false;

  const best = 能读的[0];
  db.prepare('update book_file set is_primary = 0 where book_id = ?').run(bookId);
  db.prepare('update book_file set is_primary = 1 where id = ?').run(best.id);
  return true;
}

