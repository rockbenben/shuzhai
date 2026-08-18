import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { listBooks, UNREVIEWED } from './library.ts';
import { addManualBook, claimFileless } from './manual.ts';
import { setStatus } from './status.ts';
import { scanRoot } from './scan.ts';

let dir: string;
let db: DatabaseSync;
let root: { id: number; path: string };

/** 扫描的收录下限是 10240 字节，测试书必须够大——这个坑在本仓库踩过三次，
 *  每次症状都是「所有断言都说查不到这本书」，看起来像功能坏了 */
function writeBook(path: string, titles: string[]): void {
  const filler = Array.from({ length: 200 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
  writeFileSync(path, titles.map((t) => `${t}\n${filler}\n`).join(''), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-manual-'));
  db = openDb(join(dir, 'library.db'));
  const lib = join(dir, 'books');
  mkdirSync(lib, { recursive: true });
  root = {
    id: Number(db.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid),
    path: lib,
  };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('手工添的书没有任何文件，但能写评价', () => {
  const { id, existed } = addManualBook(db, '三体', '刘慈欣');
  assert.equal(existed, false);
  assert.equal(
    (db.prepare('select count(*) n from book_file where book_id = ?').get(id) as { n: number }).n,
    0,
    '这条记录就是「我读过它」本身，不该有文件',
  );
  // reading_state 必须一起建好，否则 setStatus 直接报错
  setStatus(db, id, { rating: 5, comment: '黑暗森林' });
  const r = db.prepare('select rating, comment, rated_at from reading_state where book_id = ?').get(id) as
    { rating: number; comment: string; rated_at: string };
  assert.equal(r.rating, 5);
  assert.equal(r.comment, '黑暗森林');
  assert.ok(r.rated_at);
});

test('同名同作者不新建，返回已有的那本——书评该落到那本书上', () => {
  const first = addManualBook(db, '三体', '刘慈欣');
  const again = addManualBook(db, ' 三体 ', '刘慈欣');
  assert.equal(again.existed, true);
  assert.equal(again.id, first.id);
  assert.equal((db.prepare('select count(*) n from book').get() as { n: number }).n, 1);
});

test('书名不能为空', () => {
  assert.throws(() => addManualBook(db, '   '), /书名不能为空/);
});

test('扫描到同名同作者的 txt 时认领那条记录，不另建一本', async () => {
  const { id } = addManualBook(db, '三体', '刘慈欣');
  setStatus(db, id, { rating: 5, comment: '黑暗森林' });

  writeBook(join(root.path, '《三体》作者：刘慈欣.txt'), ['第一章 科学边界', '第二章 台球']);
  const r = await scanRoot(db, root);
  assert.equal(r.added, 1);

  assert.equal(
    (db.prepare('select count(*) n from book').get() as { n: number }).n,
    1,
    '**不能多出一本**——否则用户看到两本一样的书，其中一本打过分',
  );
  const files = db.prepare('select book_id from book_file').all() as Array<{ book_id: number }>;
  assert.equal(files[0].book_id, id, '文件要挂到原来那条记录上');
  const s = db.prepare('select rating, comment from reading_state where book_id = ?').get(id) as
    { rating: number; comment: string };
  assert.equal(s.rating, 5, '书评不能丢');
  assert.equal(s.comment, '黑暗森林');
});

/*
 * 端到端走一遍上面那条判据：手工添的时候**没填作者**，
 * 后来扫进来的文件名里带作者——书评要跟过去，书不能多出一本。
 */
test('没填作者的那条记录，也要被带作者的 txt 认走（书评跟着走）', async () => {
  const { id } = addManualBook(db, '三体');
  setStatus(db, id, { rating: 5, comment: '黑暗森林' });

  writeBook(join(root.path, '《三体》作者：刘慈欣.txt'), ['第一章 科学边界', '第二章 台球']);
  await scanRoot(db, root);

  assert.equal(
    (db.prepare('select count(*) n from book').get() as { n: number }).n, 1,
    '不能多出一本——否则书架上两本《三体》，一本打过分一本空白',
  );
  const s2 = db.prepare('select rating, comment from reading_state where book_id = ?').get(id) as
    { rating: number; comment: string };
  assert.equal(s2.rating, 5, '书评要留在原来那条记录上');
  assert.equal(s2.comment, '黑暗森林');
  const files = db.prepare('select book_id from book_file').all() as Array<{ book_id: number }>;
  assert.equal(files[0].book_id, id, '文件要挂到原来那条记录上');
});

test('**只认领没有文件的书**——已经有文件的同名书是多版本，不能合并', async () => {
  writeBook(join(root.path, '《三体》作者：刘慈欣.txt'), ['第一章 起', '第二章 承']);
  await scanRoot(db, root);
  const before = (db.prepare('select count(*) n from book').get() as { n: number }).n;
  assert.equal(before, 1);

  // 同名同作者的第二个文件：这是「多版本」，该另算，不该被认领逻辑吃掉
  writeBook(join(root.path, '《三体》（校对版）作者：刘慈欣.txt'), ['第一章 起', '第二章 承', '第三章 转']);
  await scanRoot(db, root);
  assert.equal(
    claimFileless(db, '三体', '刘慈欣'),
    null,
    '已经有文件的书不该被当成「在等文件的记录」',
  );
});

/*
 * **手工添的时候没填作者，后来把 txt 拷进来，也要认得回去。**
 *
 * 这是上一条（`addManualBook` 不填作者）的镜像，同一个根因：`bookKey` 把
 * null 作者当成另一个键。用户在「添读过的书」里打「三体」、作者懒得填、
 * 写了句书评；后来 `《三体》作者：刘慈欣.txt` 扫进来，`parseFilename` 解出作者，
 * 键对不上 → **不认领 → 多出一本同名的书，而书评留在旧那条上**。
 * 那个输入框的占位符自己都写着「填了以后认领才认得准」——
 * 那句话是在替这个缺陷道歉，不是在解释一个设计。
 *
 * 判据和上一条一样：**同名的在等文件的记录只有一条就认领它**，
 * 有好几条（不同作者）时不猜。
 */
test('手工添时没填作者，扫到带作者的同名文件也要认领', async () => {
  const m = addManualBook(db, '三体');
  assert.equal(m.existed, false);

  const id = claimFileless(db, '三体', '刘慈欣');
  assert.equal(id, m.id, '在等文件的那条只有一本同名的，就该认到它头上');
});

test('在等文件的同名记录有好几条时不猜', () => {
  addManualBook(db, '重生', '甲');
  addManualBook(db, '重生', '乙');
  assert.equal(claimFileless(db, '重生', '丙'), null, '猜哪一条都可能把书评认到错的书上');
});

test('作者不同就不认领——同名不同作者是两本书', async () => {
  addManualBook(db, '三体', '刘慈欣');
  assert.equal(claimFileless(db, '三体', '别人'), null, '作者对不上就不该认领');
  assert.ok(claimFileless(db, '三体', '刘慈欣'), '作者一致才认领');
});

/*
 * **不填作者时，别在一本已经评过的同名书旁边再建一条。**
 *
 * 实测的场景：库里有「三体 / 刘慈欣」并且打了 5 分，用户再去「添读过的书」
 * 打上「三体」、作者懒得填 —— `bookKey` 认为 null 作者是另一个键，
 * 于是静默多出第二条，**而书评还留在旧那条上**。书架上两本《三体》，
 * 一本打过分一本空白，谁也看不懂。正是本文件顶上警告过的那个形状。
 *
 * 判据：同名的**只有一本**时认领它（调用方会说「已经有了，评价记在那本上」）；
 * 同名有好几本（不同作者）时不猜，照旧新建——猜错会把书评写到错的书上。
 */
test('不填作者时，同名只有一本就认领它，不再建第二条', () => {
  const first = addManualBook(db, '三体', '刘慈欣');
  assert.equal(first.existed, false);

  const again = addManualBook(db, '三体');
  assert.equal(again.existed, true, '不填作者也该落到已有那本上');
  assert.equal(again.id, first.id);

  const n = (db.prepare("select count(*) n from book where title = '三体'").get() as { n: number }).n;
  assert.equal(n, 1, '不该多出一条空白记录');
});

test('同名有好几本时不猜，照旧新建', () => {
  addManualBook(db, '重生', '甲');
  addManualBook(db, '重生', '乙');
  const r = addManualBook(db, '重生');
  assert.equal(r.existed, false, '两本同名不同作者，猜哪一本都可能把书评写错地方');
  const n = (db.prepare("select count(*) n from book where title = '重生'").get() as { n: number }).n;
  assert.equal(n, 3);
});

test('填了作者就按书名作者认，同名不同作者仍然是两本', () => {
  const a = addManualBook(db, '雪中', '烽火');
  const b = addManualBook(db, '雪中', '别人');
  assert.notEqual(a.id, b.id);
});

/*
 * **认领到已有的一本时，那本书自己写着的评价不许被覆盖。**
 *
 * 「添读过的书」认领到已有的一本时，用户以为自己在**新建**——他不知道那本书
 * 几个月前已经评过了。原来是把这次填的直接写上去，**旧的那条一声不响地没了**，
 * 而提示只说「你写的评价已经记在那本上」。评分短评重扫恢复不了。
 *
 * 判据抄 `mergeBooks`：**自己有的不动，缺的才补**。
 * 被挡下来的那一半要原样返回（`kept`），界面照实说出来。
 */
test('认领已有的书时，旧评价不被覆盖，缺的那一半才补上', () => {
  const first = addManualBook(db, '三体', '刘慈欣', { rating: 5, comment: '神作' });
  assert.equal(first.existed, false);

  // 几个月后忘了，又添一次，填了不一样的评分和短评
  const again = addManualBook(db, '三体', '刘慈欣', { rating: 3, comment: '还行' });
  assert.equal(again.existed, true);
  assert.equal(again.id, first.id, '认领的是同一本');
  assert.deepEqual(again.kept, { rating: 5, comment: '神作' }, '要把原来写着的原样报回去');

  const row = db.prepare('select rating, comment from reading_state where book_id = ?')
    .get(first.id) as { rating: number; comment: string };
  assert.equal(row.rating, 5, '旧评分不许被覆盖');
  assert.equal(row.comment, '神作', '旧短评不许被覆盖');
});

test('认领已有的书时，它缺的那一半要补上，而且不算「被挡下来」', () => {
  const first = addManualBook(db, '活着', '余华', { rating: 5 });   // 只打了分
  const again = addManualBook(db, '活着', '余华', { comment: '看完缓不过来' }); // 只写短评
  assert.equal(again.existed, true);
  assert.equal(again.kept, undefined, '没有冲突就不该报「被挡下来」');

  const row = db.prepare('select rating, comment from reading_state where book_id = ?')
    .get(first.id) as { rating: number; comment: string };
  assert.equal(row.rating, 5, '原来的分留着');
  assert.equal(row.comment, '看完缓不过来', '它缺的那一半补上了');
});

/*
 * **「添一本读过的书」加进来的是「已读完」，不是「未标记」。**
 *
 * 那个弹窗的说明写着「网上看的、纸质的、别的设备上读的」——用户在明确表态。
 * 原来存 `none`，后果不止是「已读完」那一档少一本：
 * **「读过没评价」那个待办按定义看不见它**（那一档要 `TOUCHED_STATUS`），
 * 于是「加了一本读过的书但没写评价」这件事**应用自己忘了提醒**，
 * 而那个待办正是为这件事存在的。
 */
test('手工添的书算「已读完」，没写评价的会进待办', () => {
  const id = addManualBook(db, '纸书读过的', '某人').id;
  const r = db.prepare('select status, finished_at, percent from reading_state where book_id = ?')
    .get(id) as { status: string; finished_at: string | null; percent: number };
  assert.equal(r.status, 'finished');
  assert.ok(r.finished_at, '既然是读完的，读完时间要有——不然「已读完」那一档的排序没依据');
  assert.equal(r.percent, 100);

  const todo = (listBooks(db, UNREVIEWED, { limit: 50 }) as Array<{ id: number }>).map((b) => b.id);
  assert.ok(todo.includes(id), '读过、还没写一句——这正是那个待办要抓的');

  // 写了评价之后就该从待办里消失
  setStatus(db, id, { comment: '还行' });
  const after = (listBooks(db, UNREVIEWED, { limit: 50 }) as Array<{ id: number }>).map((b) => b.id);
  assert.ok(!after.includes(id));
});

/*
 * **认领到已有的那本时，一个字都不改它的状态。**
 * 同 `applyReview` 那条判据：那本书自己有的不动——用户可能正在读它、
 * 或者早就标了弃坑，而这次他只是想补一条记录。
 */
test('认领已有的书时不改它的阅读状态', () => {
  const id = addManualBook(db, '正在读的', '某人').id;
  setStatus(db, id, { status: 'reading' });
  const again = addManualBook(db, '正在读的', '某人');
  assert.equal(again.existed, true);
  assert.equal(
    (db.prepare('select status from reading_state where book_id = ?').get(id) as { status: string }).status,
    'reading',
    '认领不该把「在读」改成「已读完」',
  );
});

