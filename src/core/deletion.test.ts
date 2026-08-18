import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { canDelete, deleteDuplicates, deleteHistory, keepOnly, 暂存名, 暂存空位, 该清掉, 清理暂存区 } from './deletion.ts';
import { bookKey } from './versions.ts';

let dir: string;
let db: DatabaseSync;

/** 假的回收站：记录下被送进去的东西，并把文件真的挪走 */
function fakeTrash() {
  const trashed: string[] = [];
  const fn = async (path: string) => {
    if (!existsSync(path)) throw new Error('文件不存在');
    rmSync(path);
    trashed.push(path);
  };
  return { fn, trashed };
}

function addBookWithAuthor(title: string, author: string): number {
  const id = Number(
    db.prepare('insert into book(title, author) values(?,?)').run(title, author).lastInsertRowid,
  );
  db.prepare("insert into reading_state(book_id, status) values(?, 'want')").run(id);
  return id;
}

function addBook(title: string): number {
  const id = Number(db.prepare('insert into book(title) values(?)').run(title).lastInsertRowid);
  db.prepare("insert into reading_state(book_id, status) values(?, 'want')").run(id);
  return id;
}

function addFile(bookId: number, name: string, hash: string | null, primary = false): number {
  const path = join(dir, name);
  writeFileSync(path, '内容', 'utf8');
  return Number(
    db
      .prepare(
        `insert into book_file(book_id, path, size, mtime, content_hash, is_primary, word_count)
         values(?,?,?,1,?,?,100)`,
      )
      .run(bookId, path, 4, hash, primary ? 1 : 0).lastInsertRowid,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-del-'));
  db = openDb(join(dir, 'library.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('这本书只有这一个文件时不许删——删了就彻底没了', async () => {
  const b = addBook('孤本');
  const f = addFile(b, '孤本.txt', 'h1', true);

  const check = await canDelete(db, f);
  assert.equal(check.ok, false);
  assert.match(check.reason!, /没有找到这本书的另一个文件/);
});

test('内容不同、但同名同作者的另一个版本还在，允许删——但要标明不是完全相同', async () => {
  // 真实书库里「重复」的典型形态就是这个：校对版 vs 精校版，同一本书内容不一样。
  // 只认字节完全相同的话，用户 8000 本书里一个都删不掉（实测 hash 相同的组是 0），
  // 删除按钮全程点不动。严到没人能用的安全阀不是安全阀，是坏了
  const b1 = addBookWithAuthor('乌纱', '西风紧');
  const b2 = addBookWithAuthor('乌纱', '西风紧');
  const f1 = addFile(b1, '《乌纱》（校对版全本）.txt', 'hashA', true);
  addFile(b2, '《乌纱》（精校版全本）.txt', 'hashB', true);

  const check = await canDelete(db, f1);
  assert.equal(check.ok, true, check.reason ?? '');
  assert.equal(check.identical, false, '内容不一样，界面得把这一点说清楚');
  assert.equal(check.survivors.length, 1);
});

/*
 * 归组口径必须和「重复的书」那个列表**一模一样**，而那个列表用的是
 * `versions.ts` 的 `bookKey`（JS 的 trim + toLowerCase）。
 *
 * 这条守的是「别在 SQL 里再写一遍同样的意思」：sqlite 的 `trim()` 不吃全角空格、
 * `lower()` 只认 ASCII，比 JS 弱一档。弱的那一档判等是强的那一档的**子集**，
 * 所以症状是**界面把两本归成一组、删除按钮却点不动**，理由还写着
 * 「磁盘上没有找到这本书的另一个文件」——一句事实上错误的话。
 */
test('书名只差一个全角空格也算同一本——归组口径不许和 bookKey 分叉', async () => {
  const b1 = addBookWithAuthor('　乌纱　', '西风紧');
  const b2 = addBookWithAuthor('乌纱', '西风紧');
  const f1 = addFile(b1, '《乌纱》（校对版）.txt', 'hashA', true);
  addFile(b2, '《乌纱》（精校版）.txt', 'hashB', true);

  const check = await canDelete(db, f1);
  assert.equal(check.ok, true, check.reason ?? '全角空格不该让它变成「只剩这一份」');
  assert.equal(check.survivors.length, 1);
  assert.equal(bookKey('　乌纱　', '西风紧'), bookKey('乌纱', '西风紧'), 'bookKey 才是唯一裁判');
});

test('书名相同但作者不同的，不算同一本书——不许拿它当幸存副本', async () => {
  const b1 = addBookWithAuthor('重生', '甲作者');
  const b2 = addBookWithAuthor('重生', '乙作者');
  const f1 = addFile(b1, '甲.txt', 'hashA', true);
  addFile(b2, '乙.txt', 'hashB', true);

  const check = await canDelete(db, f1);
  assert.equal(check.ok, false, '同名不同作者是两本不同的书');
});

test('完全相同的副本优先——identical 要为 true', async () => {
  const b1 = addBookWithAuthor('某书', '某人');
  const b2 = addBookWithAuthor('某书', '某人');
  const f1 = addFile(b1, 'a.txt', 'same', true);
  addFile(b2, 'b.txt', 'same', true);

  const check = await canDelete(db, f1);
  assert.equal(check.ok, true);
  assert.equal(check.identical, true, '字节完全相同，删了等于没删');
});

/*
 * **只打过标签、或者只写了弃坑原因的书，也不许把它最后一个文件删掉。**
 *
 * `deleteDuplicates` 在这本书没文件之后会**连书记录一起删**，
 * 而 `delete_log` 里只有文件——标签和那句「烂尾了别看」撤不回来。
 * 这两样原来都不在 `canDelete` 的清单里（清单只认评分/短评/进度/书签/划线）。
 *
 * 两条断言，第二条才是重点：**拦下来的理由要说的是真正那一样**
 * （同本文件上面那节：报错是用户唯一会照着做的那句话）。
 */
/*
 * **PDF / EPUB 读了一半的，也不许把它最后一个文件删掉。**
 *
 * 它的进度**不在 `reading_state` 里**——查看器存的是 `app_setting` 的
 * `viewer.<bookId>`（`chapter_count` 对只编目的格式天生是 0，塞进 `reading_state`
 * 会让卡片显示「读到 12/0」）。于是 `canDelete` 那几个 count 一个都看不见它：
 * 一本读了一百页的 PDF，在那张清单眼里是「什么都没有」。
 *
 * 这是同一份清单漏的第三样，前两样是弃坑原因和标签。第二条断言仍然是重点：
 * **拦下来的理由要说的是真正那一样。**
 */
test('最后一个文件是读了一半的 PDF 时，不许删', async () => {
  const b1 = addBookWithAuthor('读了一半的 PDF', '某人');
  const b2 = addBookWithAuthor('读了一半的 PDF', '某人');
  const f1 = addFile(b1, '读了一半的 PDF.pdf', 'p1', true);
  addFile(b2, '读了一半的 PDF 副本.pdf', 'p1', true);
  db.prepare('insert into app_setting(key, value) values(?, ?)').run(`viewer.${b1}`, '100');

  const check = await canDelete(db, f1);
  assert.equal(check.ok, false, '读到第几页是重扫恢复不了的，不能当成「什么都没有」');
  assert.match(
    check.reason!,
    /读到哪一页/,
    '理由要说的是真正那一样——用户照着「有阅读进度」去 reading_state 里找是找不到的',
  );
});

/*
 * 同一份清单漏的**第四样**：自建目录（`outline.<bookId>`，迁移 24）。
 *
 * 形状和 `viewer.<bookId>` 一模一样——一行按 id 命名的设置，没有外键，
 * `canDelete` 那几个 count 一个都看不见。上面那句「每抄一份就漏一样」
 * 写下之后，**果然又漏了一样**。
 */
test('最后一个文件带着自建目录时，不许删', async () => {
  const b1 = addBookWithAuthor('自建了目录的 PDF', '某人');
  const b2 = addBookWithAuthor('自建了目录的 PDF', '某人');
  const f1 = addFile(b1, '自建了目录的 PDF.pdf', 'q1', true);
  addFile(b2, '自建了目录的 PDF 副本.pdf', 'q1', true);
  db.prepare('insert into app_setting(key, value) values(?, ?)')
    .run(`outline.${b1}`, JSON.stringify([{ page: 3, title: '第一章' }]));

  const check = await canDelete(db, f1);
  assert.equal(check.ok, false, '自己敲的目录重扫恢复不了，不能当成「什么都没有」');
  assert.match(check.reason!, /自己加的目录/, '理由要说的是真正那一样');
});

test('最后一个文件带着标签或弃坑原因时，不许删', async () => {
  for (const [what, write] of [
    ['标签', (id: number) => {
      const t = Number(db.prepare("insert into tag(name) values('玄幻')").run().lastInsertRowid);
      db.prepare('insert into book_tag(book_id, tag_id) values(?,?)').run(id, t);
    }],
    ['弃坑原因', (id: number) => {
      db.prepare('update reading_state set drop_reason = ? where book_id = ?')
        .run('烂尾了别看', id);
    }],
  ] as Array<[string, (id: number) => void]>) {
    const b1 = addBookWithAuthor(`带${what}的书`, '某人');
    const b2 = addBookWithAuthor(`带${what}的书`, '某人');
    const f1 = addFile(b1, `${what}-a.txt`, 'same', true);
    addFile(b2, `${what}-b.txt`, 'same', true);
    write(b1);

    const check = await canDelete(db, f1);
    assert.equal(check.ok, false, `${what}也是用户自己的东西，删了这个文件它就没了`);
    assert.match(check.reason ?? '', new RegExp(what), `理由里要说是${what}，不能含糊成别的`);
  }
});

test('没算过指纹也能删——只要同一本书的另一个文件还在', async () => {
  // 指纹只决定「是不是完全相同」这一档，不再是能不能删的前提
  const b = addBook('某书');
  const f1 = addFile(b, 'a.txt', null, true);
  addFile(b, 'b.txt', 'h1');

  const check = await canDelete(db, f1);
  assert.equal(check.ok, true);
  assert.equal(check.identical, false);
});

test('记录里有副本、但副本在磁盘上已经没了，也不许删', async () => {
  const b = addBook('某书');
  const f1 = addFile(b, 'a.txt', 'same', true);
  const f2 = addFile(b, 'b.txt', 'same');
  // 副本被外部删掉了，只剩记录
  rmSync(join(dir, 'b.txt'));

  const check = await canDelete(db, f1);
  assert.equal(check.ok, false, '光看记录会以为还有副本，必须真去磁盘上确认');
  assert.match(check.reason!, /没有找到这本书的另一个文件/);
  assert.ok(f2 > 0);
});

test('内容相同且副本确实在，才允许删', async () => {
  const b = addBook('某书');
  const f1 = addFile(b, 'a.txt', 'same', true);
  addFile(b, 'b.txt', 'same');

  const check = await canDelete(db, f1);
  assert.equal(check.ok, true);
  assert.equal(check.survivors.length, 1);
  assert.ok(check.survivors[0].endsWith('b.txt'));
});

test('删除走回收站，并记账', async () => {
  const b = addBook('某书');
  const f1 = addFile(b, 'a.txt', 'same', true);
  addFile(b, 'b.txt', 'same');
  const trash = fakeTrash();

  const r = await deleteDuplicates(db, [f1], trash.fn);

  assert.equal(r.deleted.length, 1);
  assert.equal(r.failed.length, 0);
  assert.equal(trash.trashed.length, 1, '文件是被送进回收站的，不是真删');
  assert.equal(!existsSync(join(dir, 'a.txt')), true);
  assert.ok(existsSync(join(dir, 'b.txt')), '副本必须还在');

  const log = deleteHistory(db) as Array<{ path: string; book_title: string }>;
  assert.equal(log.length, 1);
  assert.equal(log[0].book_title, '某书');
});

test('删掉主版本后会自动指一个新的，否则这本书读不了', async () => {
  const b = addBook('某书');
  const f1 = addFile(b, 'a.txt', 'same', true);
  const f2 = addFile(b, 'b.txt', 'same');

  await deleteDuplicates(db, [f1], fakeTrash().fn);

  const primary = db
    .prepare('select id, is_primary from book_file where book_id = ?')
    .get(b) as { id: number; is_primary: number };
  assert.equal(primary.id, f2);
  assert.equal(primary.is_primary, 1);
});

test('回收站那一步失败时，数据库记录一个字都不动', async () => {
  const b = addBook('某书');
  const f1 = addFile(b, 'a.txt', 'same', true);
  addFile(b, 'b.txt', 'same');

  const r = await deleteDuplicates(db, [f1], async () => {
    throw new Error('回收站不可用');
  });

  assert.equal(r.deleted.length, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /回收站不可用/);
  assert.equal(
    (db.prepare('select count(*) n from book_file where book_id = ?').get(b) as { n: number }).n,
    2,
    '记录先删了文件却没删，下次扫描又会把它当新书收进来',
  );
  assert.ok(existsSync(join(dir, 'a.txt')), '文件也该还在');
});

test('一个删不掉不影响其它', async () => {
  const b1 = addBook('有副本的');
  const ok1 = addFile(b1, 'a.txt', 'same', true);
  addFile(b1, 'b.txt', 'same');
  const b2 = addBook('孤本');
  const bad = addFile(b2, 'c.txt', 'lonely', true);

  const r = await deleteDuplicates(db, [bad, ok1], fakeTrash().fn);
  assert.equal(r.deleted.length, 1);
  assert.equal(r.failed.length, 1);
  assert.ok(existsSync(join(dir, 'c.txt')), '孤本必须还在');
});

test('阅读进度不受影响——它挂在书上，不挂在文件上', async () => {
  const b = addBook('某书');
  const f1 = addFile(b, 'a.txt', 'same', true);
  addFile(b, 'b.txt', 'same');
  db.prepare('update reading_state set chapter_idx = 42, percent = 60 where book_id = ?').run(b);

  await deleteDuplicates(db, [f1], fakeTrash().fn);

  const s = db.prepare('select chapter_idx, percent from reading_state where book_id = ?').get(b) as {
    chapter_idx: number;
    percent: number;
  };
  assert.equal(s.chapter_idx, 42);
  assert.equal(s.percent, 60);
});

/*
 * ⚠️ **这条守的不变式变过一次，改的原因值得记住。**
 *
 * 原来是「这个模块不做真删——源码里不该出现 unlink/rm」（grep 源码文本）。
 * 加暂存区之后源码里必然出现 `unlink`（清理到期文件、跨盘搬运的收尾），
 * 所以那条 grep 判据失效了。
 *
 * 但**真正要守的东西一点没变，只是说法更准了**：
 *
 *     删掉之后，那些字节永远拿得回来——要么在回收站里，要么在暂存区里。
 *
 * 这比 grep 强：grep 只知道源码里有没有那个词，判不出它可不可达；
 * 下面判的是**行为**，而且是那条铁律真正在乎的那件事。
 */
test('回收站收不下时：不给暂存区就照旧失败，给了就搬进去——文件永远拿得回来', async () => {
  const 坏回收站 = async () => { throw new Error('Failed to perform delete operation'); };
  const 暂存 = join(dir, 'quarantine');

  // ① 不给暂存区：回收站失败就是失败，文件必须原样还在
  const b1 = addBook('甲书');
  const a1 = addFile(b1, 'a1.txt', 'same1', true);
  addFile(b1, 'b1.txt', 'same1');
  const r1 = await deleteDuplicates(db, [a1], 坏回收站);
  assert.equal(r1.deleted.length, 0);
  assert.equal(r1.failed.length, 1);
  assert.ok(existsSync(join(dir, 'a1.txt')), '没给暂存区就不许动它');

  // ② 给了暂存区：从书库里消失，但**在暂存区里原样躺着**
  const r2 = await deleteDuplicates(db, [a1], 坏回收站, 暂存);
  assert.equal(r2.deleted.length, 1);
  assert.ok(!existsSync(join(dir, 'a1.txt')), '从原位置挪走了');
  const 躺着 = readdirSync(暂存);
  assert.equal(躺着.length, 1);
  assert.match(躺着[0], /__a1\.txt$/, '名字是「入区时间__原名」');
  assert.equal(readFileSync(join(暂存, 躺着[0]), 'utf8'), '内容', '**字节一个都没少**');

  // ③ **不限于「内容完全相同」**——这是搬运和真删最要紧的区别。
  //    另一个版本删掉内容就没了，所以真删不许碰它；而搬进暂存区不丢内容，没有理由拦
  const b3 = addBook('丙书');
  const a3 = addFile(b3, 'a3.txt', 'hash-a', true);
  addFile(b3, 'b3.txt', 'hash-b');
  const r3 = await deleteDuplicates(db, [a3], 坏回收站, 暂存);
  assert.equal(r3.deleted.length, 1, '另一个版本也搬得进去——它没丢，只是挪了地方');
  assert.equal(readdirSync(暂存).length, 2);

  // ④ 日志要写清搬到哪儿了，否则用户会去回收站白找一趟
  const log = deleteHistory(db) as Array<{ reason: string }>;
  assert.match(String(log[0].reason), /暂存区/);
});

test('暂存区 30 天后才清，而且名字看不懂的一律不动', async () => {
  const 天 = 24 * 3600_000;
  const now = Date.UTC(2026, 8, 1);

  assert.equal(该清掉(暂存名(now - 31 * 天, 'a.txt'), now), true, '31 天该清');
  assert.equal(该清掉(暂存名(now - 29 * 天, 'a.txt'), now), false, '29 天不该清');
  assert.equal(该清掉(暂存名(now - 30 * 天, 'a.txt'), now), true, '整 30 天算到期');
  // ⚠️ 清理是**真删**，所以看不懂的一律不动——那可能是用户自己丢进来的东西
  assert.equal(该清掉('随便一个名字.txt', now), false, '解析不出时间就别碰');
  assert.equal(该清掉('__a.txt', now), false, '前缀是空的也不算');
  assert.equal(该清掉('abc__a.txt', now), false, '前缀不是数字也不算');

  const q = join(dir, 'q2');
  mkdirSync(q, { recursive: true });
  writeFileSync(join(q, 暂存名(now - 40 * 天, '老的.txt')), 'x');
  writeFileSync(join(q, 暂存名(now - 10 * 天, '新的.txt')), 'x');
  writeFileSync(join(q, '不认识的.txt'), 'x');
  const r = await 清理暂存区(q, now);
  assert.deepEqual(r, { 清掉: 1, 留着: 2 });
  assert.ok(!existsSync(join(q, 暂存名(now - 40 * 天, '老的.txt'))));
  assert.ok(existsSync(join(q, '不认识的.txt')), '看不懂的还在');
});

test('同一本书被扫成两条记录时，也能删掉重复的那份', async () => {
  // 这是「完全重复」最典型的形态：扫描时 hash 相同但旧路径还在，
  // 于是各自建了一本书，两边的文件数都是 1。
  // 判据一度写成「文件数 ≤ 1 就不许删」，结果是明明有副本却一个都删不掉
  const b1 = addBook('重复书');
  const b2 = addBook('重复书');
  const f1 = addFile(b1, '甲.txt', 'same', true);
  addFile(b2, '乙.txt', 'same', true);

  const check = await canDelete(db, f1);
  assert.equal(check.ok, true, check.reason ?? '');

  const r = await deleteDuplicates(db, [f1], fakeTrash().fn);
  assert.equal(r.deleted.length, 1);
  assert.ok(existsSync(join(dir, '乙.txt')), '副本必须还在');
  // 空掉的那条书记录要一并清掉，不然书架上多一条点开就报错的
  assert.equal(
    (db.prepare('select count(*) n from book where id = ?').get(b1) as { n: number }).n,
    0,
  );
});

test('但如果那本书有阅读进度，就不许删——进度重扫恢复不了', async () => {
  const b1 = addBook('重复书');
  const b2 = addBook('重复书');
  const f1 = addFile(b1, '甲.txt', 'same', true);
  addFile(b2, '乙.txt', 'same', true);
  db.prepare('update reading_state set chapter_idx = 20 where book_id = ?').run(b1);

  const check = await canDelete(db, f1);
  assert.equal(check.ok, false);
  assert.match(check.reason!, /阅读进度/);
  assert.ok(existsSync(join(dir, '甲.txt')));
});

/*
 * **拦下来的理由要说的是真正那一样。**
 *
 * 判据里一直包含评分和短评（书评重扫也恢复不了），但报错一律写
 * 「有阅读进度或书签」——一本你打过分、从没读过的书被拦下来，
 * 用户看到的是一个不存在的原因，外加一句「先把进度挪到另一份上」，
 * 而根本没有进度可挪。报错是用户唯一会照着做的那句话。
 */
test('拦下来的理由要说清是书评，不能报成「有阅读进度」', async () => {
  const b1 = addBook('重复书');
  const b2 = addBook('重复书');
  const f1 = addFile(b1, '甲.txt', 'same', true);
  addFile(b2, '乙.txt', 'same', true);
  // 只打了分，一章都没读过
  db.prepare("update reading_state set rating = 5, comment = '烂尾了' where book_id = ?").run(b1);

  const check = await canDelete(db, f1);
  assert.equal(check.ok, false);
  assert.match(check.reason!, /评分|短评/, `说的得是真正的原因：${check.reason}`);
  assert.doesNotMatch(check.reason!, /阅读进度|书签/, '没有的东西不能写进理由里');
  assert.doesNotMatch(check.reason!, /挪/, '没有进度可挪，别让用户去做一件做不到的事');
});

// ── keepOnly：「只留这一份」一步做完 ────────────────────────────────────

test('只留这一份：合并记录 + 设主版本 + 其余进回收站', async () => {
  const b1 = addBook('重复书');
  const b2 = addBook('重复书');
  const keep = addFile(b1, '甲.txt', 'same', true);
  const drop = addFile(b2, '乙.txt', 'same', true);
  const t = fakeTrash();

  const r = await keepOnly(db, keep, [drop], t.fn);

  assert.equal(r.deleted.length, 1);
  assert.equal(t.trashed.length, 1, '一律走回收站，不做真删');
  assert.ok(existsSync(join(dir, '甲.txt')), '留下的那份必须还在');
  assert.ok(!existsSync(join(dir, '乙.txt')));
  // 两条书记录并成了一条，剩下的那个文件就是主版本
  assert.equal((db.prepare('select count(*) n from book').get() as { n: number }).n, 1);
  const left = db.prepare('select id, is_primary from book_file').all() as unknown as
    Array<{ id: number; is_primary: number }>;
  assert.equal(left.length, 1);
  assert.equal(left[0].id, keep);
  assert.equal(left[0].is_primary, 1, '用户选的那一份要成为主版本');
});

test('留的是没进度的那一份时，进度也不能丢——先合并才删得掉', async () => {
  // **这一条正是旧流程办不到的**：b1 只有一个文件而它有进度，
  // canDelete 会拒绝（那条判据本身没错）。keepOnly 先把记录合了，
  // 于是留下的那份和进度落在同一本书下，判据自然不再成立。
  const b1 = addBook('重复书');
  const b2 = addBook('重复书');
  const drop = addFile(b1, '甲.txt', 'same', true);
  const keep = addFile(b2, '乙.txt', 'same', true);
  db.prepare('update reading_state set chapter_idx = 20 where book_id = ?').run(b1);

  assert.equal((await canDelete(db, drop)).ok, false, '前提：单独删是会被拒的');

  const r = await keepOnly(db, keep, [drop], fakeTrash().fn);
  assert.equal(r.deleted.length, 1, r.failed[0]?.reason ?? '');
  assert.ok(existsSync(join(dir, '乙.txt')));

  const state = db.prepare('select chapter_idx as i from reading_state where book_id = ?')
    .get(r.keptBookId) as { i: number };
  assert.equal(state.i, 20, '阅读进度是重扫恢复不了的，合并后必须还在');
  const files = db.prepare('select id from book_file where book_id = ?').all(r.keptBookId) as
    unknown as Array<{ id: number }>;
  assert.deepEqual(files.map((f) => f.id), [keep]);
});

test('要留的那份不能同时在删除名单里', async () => {
  const b = addBook('重复书');
  const f1 = addFile(b, '甲.txt', 'same', true);
  const f2 = addFile(b, '乙.txt', 'same');
  await assert.rejects(() => keepOnly(db, f1, [f1, f2], fakeTrash().fn), /不能同时/);
  await assert.rejects(() => keepOnly(db, f1, [], fakeTrash().fn), /没有要删/);
  assert.ok(existsSync(join(dir, '甲.txt')), '参数不对时一个文件都不许动');
  assert.ok(existsSync(join(dir, '乙.txt')));
});

/*
 * ⚠️ **重复文件常常同名**——「同一本书下到两个文件夹」正是重复的主要来源，
 * 而这个功能存在的全部理由就是收拾这种重复。
 *
 * `rename` 和 `copyFile` 在 Windows 上都是**静默覆盖**（实测：第二个盖掉第一个，
 * 不报错、不警告）。名字里只有毫秒的话，同一毫秒搬两个 `book.txt`
 * 就会把先搬进去的那份**真删掉**——恰好是上一条守卫说绝不会发生的事。
 */
test('同名的两份搬进暂存区：两份都在，谁也不许盖掉谁', async () => {
  const 坏回收站 = async () => { throw new Error('Failed to perform delete operation'); };
  const 暂存 = join(dir, 'q3');
  const b = addBook('同名书');
  const ids: number[] = [];
  // 三份同名：留一份，删两份。**两份才够得着这个坑**——只删一份不会撞名，
  // 而「同一本书躺在三个文件夹里」在真实书库里再普通不过
  for (const [子目录, 内容] of [['A', '甲文件夹那份'], ['B', '乙文件夹那份'], ['C', '留着那份']]) {
    mkdirSync(join(dir, 子目录), { recursive: true });
    const p = join(dir, 子目录, 'book.txt');
    writeFileSync(p, 内容, 'utf8');
    ids.push(Number(
      db.prepare(
        `insert into book_file(book_id, path, size, mtime, content_hash, is_primary, word_count)
         values(?,?,?,1,?,0,100)`,
      ).run(b, p, 12, 'same-hash').lastInsertRowid,
    ));
  }
  const r = await deleteDuplicates(db, ids.slice(0, 2), 坏回收站, 暂存);
  assert.equal(r.deleted.length, 2);
  const 躺着 = readdirSync(暂存).sort();
  assert.equal(躺着.length, 2, '两份都要在暂存区里，一份都不许被盖掉');
  const 内容们 = 躺着.map((f) => readFileSync(join(暂存, f), 'utf8')).sort();
  assert.deepEqual(内容们, ['乙文件夹那份', '甲文件夹那份'], '**两份字节各自完好**');
  // 名字仍要解析得出入区时间，否则清理那一步会当它「看不懂」永远不清
  for (const f of 躺着) assert.equal(该清掉(f, Date.now() + 40 * 24 * 3600_000), true);
});

/*
 * 上面那条端到端的**在坏代码上也会绿**——两次搬运恰好落在不同毫秒就撞不上，
 * 而「永远绿的断言等于没有断言」。所以真正钉住的是这一条：**把时钟固定死**，
 * 同一毫秒、同一个原名，必须给出两个不同的位置。
 */
test('暂存区取名：同一毫秒同名也不许撞——撞了就是把先搬进去的那份真删了', async () => {
  const q = join(dir, 'q4');
  mkdirSync(q, { recursive: true });
  const now = Date.UTC(2026, 8, 1);

  const 甲 = await 暂存空位(q, now, 'book.txt');
  writeFileSync(甲, '甲');
  const 乙 = await 暂存空位(q, now, 'book.txt');
  assert.notEqual(乙, 甲, '同一毫秒的第二份必须换个位置，否则 rename 会静默盖掉第一份');
  writeFileSync(乙, '乙');
  const 丙 = await 暂存空位(q, now, 'book.txt');
  assert.ok(丙 !== 甲 && 丙 !== 乙, '第三份也一样');

  // 换了名字也得让清理那一步认得出入区时间，不然它会被当成「看不懂的」永远留着
  for (const p of [甲, 乙, 丙]) {
    assert.equal(该清掉(basename(p), now + 40 * 24 * 3600_000), true, `${basename(p)} 该认得出时间`);
  }
});
