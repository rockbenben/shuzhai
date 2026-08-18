// 手工添「读过但本地没有文件」的书（个人评价体系的第二半，
// 设计见 docs/superpowers/specs/2026-08-14-personal-reviews-design.md）。
//
// 用户对这个应用的模型是两部分：**书评是主体，本地文件是可选的**。
// 网上看的、纸质的、别的设备上读的书，也该能在这里留一条记录和一句评价。
//
// 地基上一轮就留好了，这个文件只补两条链路：
//   1. 建一条没有文件的 book 记录
//   2. 以后扫描到同名同作者的 txt 时**认领**它，而不是另建一本
//
// 为什么第 2 条不能省：不认领的话，用户把 txt 拷进来之后会看到两本一样的书，
// 而书评还留在旧那条上——「其中一本打过分」这种状态没人看得懂，
// 而且 `reading_state` 是铁律 3 的数据，合并起来很麻烦。

import type { DatabaseSync } from 'node:sqlite';

import { bookKey as key } from './versions.ts';
import { setStatus } from './status.ts';

export interface ManualBook {
  id: number;
  /** true 表示这个书名作者已经存在，返回的是已有的那本，没有新建 */
  existed: boolean;
  /**
   * 认领到的那本书的作者。**只在 `existed` 时有意义。**
   *
   * 用户没填作者、库里同名的只有一本时我们会认领它——那本可能是另一个人写的。
   * 界面要把作者摆出来（「已经有《三体》（刘慈欣）了」），
   * 否则用户不知道自己的评价落到了谁身上。
   */
  author?: string | null;
  /**
   * 认领到的那本书**原来就写着的评价**，只在没被覆盖时有值。
   *
   * 「添读过的书」认领到已有的一本时，用户以为自己在新建——他不知道那本书
   * 几个月前已经评过了。原来的做法是把新填的评分短评直接写上去，
   * **旧的那条一声不响地没了**，而提示只说「你写的评价已经记在那本上」。
   *
   * 判据抄 `mergeBooks`（合并重复的书那处）：**那本书自己有的不动，
   * 缺的才补上**。界面拿这个字段告诉用户「它原来写着什么、你这次填的哪一半没生效」。
   */
  kept?: { rating: number | null; comment: string | null };
}

/**
 * 手工添一本读过的书。**不建任何 book_file** —— 这条记录就是「我读过它」本身。
 *
 * 同名同作者已经存在时返回已有的那本（`existed: true`），不新建：
 * 用户想写的书评应该落到那本书上，而不是凭空多出一条重复记录。
 */
export function addManualBook(
  db: DatabaseSync,
  title: string,
  author?: string | null,
  review?: { rating?: number | null; comment?: string | null },
): ManualBook {
  const t = title.trim();
  if (!t) // 和 `metadata.ts` 那道校验一字不差：同一条规矩，不该因为在哪个弹窗里而说法不同
    throw new Error('书名不能为空——它是这本书在书架上唯一的名字');
  const a = author?.trim() || null;

  const k = key(t, a);
  const dup = (
    db.prepare('select id, title, author from book').all() as unknown as Array<{
      id: number;
      title: string;
      author: string | null;
    }>
  ).find((b) => key(b.title, b.author) === k);
  if (dup) return { ...applyReview(db, dup.id, review), existed: true, author: dup.author };

  /*
   * **不填作者时，同名只有一本就认领它。**
   *
   * `bookKey` 把 null 作者当成另一个键，所以「三体 / 刘慈欣」已经在库里、
   * 用户再打一个「三体」不填作者，原来会静默新建第二条——**而书评还留在旧那条上**。
   * 书架上两本《三体》，一本打过分一本空白，谁也看不懂。
   * 正是本文件顶上警告过的那个形状（「其中一本打过分」这种状态没人看得懂）。
   *
   * **同名有好几本（不同作者）时不猜**：猜错会把书评写到错的书上，
   * 而多一条记录用户至少看得见、改得掉。调用方拿到 `existed: true` 会说明
   * 「已经有了，评价记在那本上」，所以认领这件事不是静默的。
   */
  if (!a) {
    // 归一化交给 `bookKey`（trim + 转小写），别在这儿另抄一套判等
    const sameTitle = (
      db.prepare('select id, title, author from book').all() as unknown as Array<{
        id: number;
        title: string;
        author: string | null;
      }>
    ).filter((b) => key(b.title, null) === key(t, null));
    if (sameTitle.length === 1) {
      return {
        ...applyReview(db, sameTitle[0].id, review),
        existed: true,
        author: sameTitle[0].author,
      };
    }
  }

  const id = Number(
    db.prepare('insert into book(title, author) values(?, ?)').run(t, a).lastInsertRowid,
  );
  /*
   * reading_state 必须一起建：评分短评都挂在它上面，缺了 `setStatus` 会直接报错。
   *
   * **状态是「已读完」，不是「未标记」。** 这个弹窗叫「添一本读过的书」，
   * 说明写着「网上看的、纸质的、别的设备上读的」——用户是在**明确表态**。
   * 原来存的是 `none`，后果不止是「已读完」那一档少一本：
   * **「读过没评价」那个待办按定义看不见它**（那一档要 `TOUCHED_STATUS`），
   * 于是「我加了一本读过的书但没写评价」这件事**应用自己忘了提醒**，
   * 而那个待办正是为这件事存在的。当场量的：添两本、其中一本没写评价，
   * 侧栏是「已读完 0 / 未标记 2 / 读过没评价 0」。
   *
   * **只在新建时设。** 认领到已有的那本时一个字都不改——同 `applyReview`
   * 那条判据：那本书自己有的不动。用户可能正在读它、或者早就标了弃坑。
   */
  db.prepare("insert into reading_state(book_id, status) values(?, 'finished')").run(id);
  db.prepare("update reading_state set finished_at = datetime('now'), percent = 100 where book_id = ?")
    .run(id);
  return { ...applyReview(db, id, review), existed: false };
}

/**
 * 把这次填的评分短评写到某本书上——**它自己已经有的那一半不覆盖**。
 *
 * 「添读过的书」认领到已有的一本时，用户以为自己在新建：他不知道那本书
 * 几个月前已经评过了。原来是直接写上去，**旧的那条一声不响地没了**，
 * 而提示只说「你写的评价已经记在那本上」。评分短评重扫恢复不了。
 *
 * 判据抄 `mergeBooks`（合并重复的书那处）：**自己有的不动，缺的才补**。
 * 被挡下来的那一半原样返回（`kept`），界面要如实说出来——
 * 「说了怎么办」那条对这里一样成立。
 */
function applyReview(
  db: DatabaseSync,
  id: number,
  review?: { rating?: number | null; comment?: string | null },
): { id: number; kept?: ManualBook['kept'] } {
  if (!review) return { id };
  const cur = db
    .prepare('select rating, comment from reading_state where book_id = ?')
    .get(id) as { rating: number | null; comment: string | null } | undefined;

  const patch: { rating?: number; comment?: string } = {};
  if (review.rating != null && cur?.rating == null) patch.rating = review.rating;
  if (review.comment?.trim() && !cur?.comment?.trim()) patch.comment = review.comment.trim();
  if (Object.keys(patch).length > 0) setStatus(db, id, patch);

  // 这次填了、而那本书原来就有的，才算「被挡下来」
  const blocked =
    (review.rating != null && cur?.rating != null)
    || (!!review.comment?.trim() && !!cur?.comment?.trim());
  return blocked
    ? { id, kept: { rating: cur?.rating ?? null, comment: cur?.comment ?? null } }
    : { id };
}

/**
 * 「在等文件」的记录索引：书名作者 → book id。
 *
 * **必须在扫描循环外面建一次。** 原来是每遇到一个新文件就全表扫一遍 `book`
 * 找没有文件的记录——首次导入时书数一路涨到八千，那是 O(n²)。
 * 这个仓库在 `parseAndStore` 上踩过同一类坑（`db.prepare` 要提到循环外面，
 * 实测 1000 章 404ms → 1ms），别再来一次。
 *
 * 手工添的书通常只有几条，索引本身很小。
 */
export interface FilelessIndex {
  /** 书名+作者 → id。精确认领走这张 */
  byKey: Map<string, number>;
  /**
   * 书名 → id 列表，**只收作者为空的那些记录**。
   *
   * 用户在「添读过的书」里常常懒得填作者（那个输入框的占位符自己都写着
   * 「填了以后认领才认得准」）。后来 `《三体》作者：刘慈欣.txt` 扫进来，
   * `parseFilename` 解出了作者，精确键就对不上——不兜住的话
   * **多出一本同名的书，而书评留在旧那条上**。
   *
   * 只收作者为空的：记录里明确写了作者的，作者对不上就是两本书（那条测试钉着）。
   */
  byTitle: Map<string, number[]>;
}

export function filelessIndex(db: DatabaseSync): FilelessIndex {
  const rows = db
    .prepare(
      `select b.id, b.title, b.author from book b
        where not exists (select 1 from book_file f where f.book_id = b.id)`,
    )
    .all() as unknown as Array<{ id: number; title: string; author: string | null }>;
  const byKey = new Map<string, number>();
  const byTitle = new Map<string, number[]>();
  for (const b of rows) {
    byKey.set(key(b.title, b.author), b.id);
    if (!b.author?.trim()) {
      const tk = key(b.title, null);
      byTitle.set(tk, [...(byTitle.get(tk) ?? []), b.id]);
    }
  }
  return { byKey, byTitle };
}

/**
 * 扫描到一个新文件时，看有没有一条「没有任何文件」的记录在等它。
 *
 * **只认领没有文件的书。** 已经有文件的同名书是「多版本」，那是 `versions.ts`
 * 的事，在这里合并会把两个不同的 txt 塞进同一本书。
 *
 * 传 `index` 就走索引（扫描循环里必须这么用，见 `filelessIndex`）；
 * 不传就现查一次，给单次调用和测试用。
 *
 * **认领成功会把它从索引里划掉**：一本没有文件的记录只能被认领一次，
 * 否则同名的第二个文件会挂到同一本书上，那就成了「多版本」——不是这里的事。
 */
export function claimFileless(
  db: DatabaseSync,
  title: string,
  author?: string | null,
  index?: FilelessIndex,
): number | null {
  const idx = index ?? filelessIndex(db);
  const k = key(title, author);
  const id = idx.byKey.get(k);
  if (id !== undefined) {
    idx.byKey.delete(k);
    idx.byTitle.delete(key(title, null));
    return id;
  }

  /*
   * 精确键对不上时，再看「作者没填」的那些记录：**同名只有一条就认它**。
   * 同名有好几条（各自的作者也是空的）时**不猜**——猜错会把书评认到错的书上，
   * 而多一条记录用户至少看得见、改得掉。和 `addManualBook` 那半是同一条判据。
   */
  const tk = key(title, null);
  const cands = idx.byTitle.get(tk);
  if (cands?.length === 1) {
    idx.byKey.delete(tk);
    idx.byTitle.delete(tk);
    return cands[0];
  }
  return null;
}
