import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { setStatus } from './status.ts';
import {
  addCategory,
  listCategories,
  removeCategory,
  tagBooks,
  untagBooks,
  listTags,
  SORT_KEYS,
  listBooks,
  saveShelf,
  listShelves,
  repairLibrary,
  listDirs,
  applySerialByDir,
  shelfCounts,
  tagBooksByFilter,
  TAG_NAME_MAX,
  planTagByFilter,
  renameTag,
  deleteTag,
  titleKeywords,
  countBooks,
  type Filter,
  hasNotesSql,
  finishedYears,
} from './library.ts';
import { TOUCHED_STATUS } from './labels.ts';

let dir: string;
let db: DatabaseSync;
/** 夹具里的书都挂在这个目录下。**不挂目录的记录扫描永远碰不到**，
 *  那是 root.remove 之后的残留状态，不是正常的书该有的样子 */
let rootId: number;

/** 直接造数据，不走扫描——这个模块跟磁盘无关 */
function addBook(
  title: string,
  opts: { author?: string; words?: number; serial?: string; reading?: string } = {},
): number {
  const id = Number(
    db
      .prepare('insert into book(title, author, serial_status) values(?,?,?)')
      .run(title, opts.author ?? null, opts.serial ?? 'unknown').lastInsertRowid,
  );
  db.prepare('insert into reading_state(book_id, status) values(?, ?)').run(id, opts.reading ?? 'want');
  db.prepare(
    `insert into book_file(book_id, root_id, path, size, mtime, is_primary, word_count, status)
     values(?, ?, ?, 1, 1, 1, ?, 'ok')`,
  ).run(id, rootId, join(dir, `${title}.txt`), opts.words ?? 10000);
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-lib-'));
  db = openDb(join(dir, 'library.db'));
  rootId = Number(
    db.prepare('insert into library_root(path, enabled) values(?, 1)').run(dir).lastInsertRowid,
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const titles = (rows: unknown[]) => (rows as Array<{ title: string }>).map((r) => r.title).sort();

test('迁移 5 给 book 加上了 category_id 这一列', () => {
  // 往 create table 里补列对已有库是空操作，只能靠 alter table。这条测试守着它
  const cols = (db.prepare('pragma table_info(book)').all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes('category_id'), `book 表的列：${cols.join(', ')}`);
});

test('分类树：删父分类不会删书，只是回到未分类', () => {
  const parent = addCategory(db, '玄幻');
  const child = addCategory(db, '东方玄幻', parent.id);
  const bookId = addBook('斗破苍穹');
  db.prepare('update book set category_id = ? where id = ?').run(child.id, bookId);

  assert.equal(listCategories(db).length, 2);
  removeCategory(db, parent.id);

  assert.equal(listCategories(db).length, 0, '子分类跟着删');
  assert.equal(
    (db.prepare('select count(*) n from book').get() as { n: number }).n,
    1,
    '书一本都不能少',
  );
  assert.equal(
    (db.prepare('select category_id from book where id = ?').get(bookId) as { category_id: null })
      .category_id,
    null,
  );
});

test('打标签：重复打不会重复，标签自动创建', () => {
  const a = addBook('甲书');
  const b = addBook('乙书');
  tagBooks(db, [a, b], ['玄幻', '长篇']);
  tagBooks(db, [a], ['玄幻']); // 再打一次

  const tags = listTags(db);
  assert.deepEqual(tags.map((t) => t.name).sort(), ['玄幻', '长篇']);
  assert.equal(tags.find((t) => t.name === '玄幻')!.count, 2, '不能因为重复打就变成 3');

  untagBooks(db, [a], tags.find((t) => t.name === '玄幻')!.id);
  assert.equal(listTags(db).find((t) => t.name === '玄幻')!.count, 1);
});

test('按关键词筛选，书名作者别名都参与匹配', () => {
  addBook('斗破苍穹', { author: '天蚕土豆' });
  const id = addBook('雪中悍刀行', { author: '烽火戏诸侯' });
  db.prepare("update book set aliases = '雪中' where id = ?").run(id);

  assert.deepEqual(titles(listBooks(db, { keyword: '斗破' })), ['斗破苍穹']);
  assert.deepEqual(titles(listBooks(db, { keyword: '天蚕' })), ['斗破苍穹'], '作者也能搜到');
  assert.deepEqual(titles(listBooks(db, { keyword: '雪中' })), ['雪中悍刀行'], '别名也能搜到');
});

test('按字数区间和连载状态组合筛选', () => {
  addBook('短篇', { words: 5000, serial: 'finished' });
  addBook('中篇', { words: 50000, serial: 'ongoing' });
  addBook('长篇', { words: 500000, serial: 'finished' });

  assert.deepEqual(titles(listBooks(db, { minWords: 10000 })), ['中篇', '长篇']);
  assert.deepEqual(titles(listBooks(db, { minWords: 10000, maxWords: 100000 })), ['中篇']);
  assert.deepEqual(titles(listBooks(db, { serialStatus: ['finished'] })), ['短篇', '长篇']);
  assert.deepEqual(
    titles(listBooks(db, { serialStatus: ['finished'], minWords: 100000 })),
    ['长篇'],
    '多个条件是与关系',
  );
});

test('多个标签是交集，不是并集', () => {
  const a = addBook('甲书');
  const b = addBook('乙书');
  tagBooks(db, [a, b], ['玄幻']);
  tagBooks(db, [a], ['已完结']);

  const tags = listTags(db);
  const idOf = (n: string) => tags.find((t) => t.name === n)!.id;

  assert.deepEqual(titles(listBooks(db, { tagIds: [idOf('玄幻')] })), ['乙书', '甲书']);
  assert.deepEqual(
    titles(listBooks(db, { tagIds: [idOf('玄幻'), idOf('已完结')] })),
    ['甲书'],
    '「玄幻 + 已完结」问的是同时满足，不是任意一个',
  );
});

test('未分类可以单独筛出来', () => {
  const cat = addCategory(db, '玄幻');
  const a = addBook('有分类的');
  addBook('没分类的');
  db.prepare('update book set category_id = ? where id = ?').run(cat.id, a);

  assert.deepEqual(titles(listBooks(db, { categoryId: null })), ['没分类的']);
  assert.deepEqual(titles(listBooks(db, { categoryId: cat.id })), ['有分类的']);
});

test('智能书架存的是条件，不是当时的结果', () => {
  addBook('长篇', { words: 500000 });
  saveShelf(db, '大部头', { minWords: 100000 });

  const shelves = listShelves(db);
  assert.equal(shelves.length, 1);
  assert.deepEqual(shelves[0].filter, { minWords: 100000 });

  // 之后新增的书只要符合条件，也该出现在这个书架里
  addBook('另一本长篇', { words: 300000 });
  assert.equal(listBooks(db, shelves[0].filter).length, 2, '条件是活的，不是快照');
});
test('改一个分类是改它，不是又建一个；id 写错了要抛，不许静默新建', () => {
  const { id } = saveShelf(db, '四星以上', { minRating: 4 });
  saveShelf(db, '四星以上的仙侠', { minRating: 4, dir: '仙侠' }, id);

  const after = listShelves(db);
  assert.equal(after.length, 1, '改名改规则不该多出第二条');
  assert.equal(after[0].name, '四星以上的仙侠');
  assert.deepEqual(after[0].filter, { minRating: 4, dir: '仙侠' });

  /*
   * **id 写错了必须抛。** 无条件返回成功是 `tag.delete` 那次事故的形状
   * （参数写错 → 一行都没改 → 照样报成功），而这条 rpc 对外开放（§13），
   * 外部调用方最容易错的就是 id。
   * 最要紧的是后半句断言：**抛完之后库里不许多出一条**——
   * 只钉「抛了错」的话，把它写成「先 insert 再抛」也能骗过去。
   */
  assert.throws(() => saveShelf(db, '不存在的', { minRating: 1 }, 999999), /没有 id 为 999999 的分类/);
  assert.equal(listShelves(db).length, 1, '抛完之后不许多出一条');
});


test('列表里带上标签，界面不必再逐本查一次', () => {
  const a = addBook('甲书');
  tagBooks(db, [a], ['玄幻', '长篇']);
  const row = listBooks(db)[0] as { tags: string | null };
  assert.ok(row.tags?.includes('玄幻'));
  assert.ok(row.tags?.includes('长篇'));
});

/** 只建 book 和 reading_state，**不建文件**——用来造孤儿记录 */
/*
 * 一条**没有文件的**书记录。status 用 `none`，因为那才是扫描进来的默认值
 * （`scan.ts` 的 `insert or ignore … values(?, 'none')`）——
 * `want` 是用户自己表的态，第 17 条迁移特意把假的「想读」清成了 `none`，
 * 就是为了让这两者分得开。这个夹具原来写的是 `want`，
 * 于是它造出来的「空记录」其实带着一句用户的话。
 */
function addBookNoFile(title: string): number {
  const id = Number(db.prepare('insert into book(title) values(?)').run(title).lastInsertRowid);
  db.prepare("insert into reading_state(book_id, status) values(?, 'none')").run(id);
  return id;
}

test('修复：删掉空记录，但有进度或书签的一律留着', () => {
  const junk = addBookNoFile('空记录');
  const withProgress = addBookNoFile('有进度的空记录');
  const withMark = addBookNoFile('有书签的空记录');
  const normal = addBook('正常的书');
  db.prepare('update reading_state set chapter_idx = 5 where book_id = ?').run(withProgress);
  db.prepare('insert into bookmark(book_id, chapter_idx) values(?, 1)').run(withMark);

  const r = repairLibrary(db);
  assert.equal(r.orphanBooks, 1, '只删那条什么都没有的');

  const left = (db.prepare('select id from book order by id').all() as Array<{ id: number }>).map((x) => x.id);
  assert.ok(!left.includes(junk));
  assert.ok(left.includes(withProgress), '进度重扫恢复不了，宁可留一条打不开的记录');
  assert.ok(left.includes(withMark));
  assert.ok(left.includes(normal));
});

/*
 * **「没有文件」不等于「没人要」。** `manual.ts` 添的书只往 `book` 表写一行，
 * 一个 `book_file` 都没有——「整理数据库」原来把它们当孤儿删了。
 * 当场量的：四本手工添的书跑一次 repair，只有写过短评的那本活下来，
 * **弃坑原因、标签、「想读」三样全没了**，而按下去的按钮叫「整理数据库」。
 *
 * 这几样都重扫恢复不了（铁律 3 那一族），所以判据是「用户表过态就算数」。
 */
test('修复：手工添的书，弃坑原因 / 标签 / 想读都得留住', () => {
  const dropped = addBookNoFile('弃坑的那本');
  db.prepare("update reading_state set status = 'dropped', drop_reason = ? where book_id = ?")
    .run('第三卷开始注水，别看了', dropped);
  const tagged = addBookNoFile('只打了标签');
  tagBooks(db, [tagged], ['想找的书']);
  const want = addBookNoFile('只标了想读');
  db.prepare("update reading_state set status = 'want' where book_id = ?").run(want);
  /*
   * ⚠ 这一条是破坏实验逼出来的：拆掉 `drop_reason is not null` 那半，
   * 上面那本「弃坑的那本」照样活着——因为它的 `status` 也不是 `none`，
   * 另一半把它护住了。**一条谁都不靠的断言等于没有断言。**
   * 而这个状态真的存在：`BookEditor` 里弃坑原因是个独立的输入框
   * （`saveStatus({ dropReason })`），不改状态也能写进去。
   */
  const reasonOnly = addBookNoFile('只写了弃坑原因');
  db.prepare('update reading_state set drop_reason = ? where book_id = ?')
    .run('作者太监了', reasonOnly);
  /*
   * ⚠ PDF / EPUB 读到哪儿**不在 `reading_state` 里**，存的是 `app_setting` 的
   * `viewer.<bookId>`（查看器那边有意这么做的，见 `deletion.ts` 那段）。
   * 上面那一串 `not exists` 一个都看不见它——一本你读了一百页的 PDF，
   * 在这个判据眼里是「真的什么都没有」，一次「整理数据库」就没了，而页码重扫恢复不了。
   */
  const pdfOnly = addBookNoFile('只读过几页的 PDF');
  db.prepare('insert into app_setting(key, value) values(?, ?)').run(`viewer.${pdfOnly}`, '42');
  const junk = addBookNoFile('真的什么都没有');

  assert.equal(repairLibrary(db).orphanBooks, 1, '只该删那条什么都没有的');
  assert.ok(
    (db.prepare('select id from book').all() as Array<{ id: number }>).some((x) => x.id === reasonOnly),
    '弃坑原因是用户打的字，状态没跟着改也一样是他的话',
  );
  assert.ok(
    (db.prepare('select id from book').all() as Array<{ id: number }>).some((x) => x.id === pdfOnly),
    'PDF / EPUB 的阅读位置也是重扫恢复不了的东西，别当成「什么都没有」',
  );

  const left = (db.prepare('select id from book').all() as Array<{ id: number }>).map((x) => x.id);
  assert.ok(left.includes(dropped), '弃坑原因是最能拦住重复阅读的一句话');
  assert.ok(left.includes(tagged), '标签是用户手打的，book_tag 会跟着 cascade');
  assert.ok(left.includes(want), '「想读」是用户表的态，不是扫描的默认值');
  assert.ok(!left.includes(junk), '真的空记录还是要清掉，不然这一步就白做了');

  // 留下来不算数，**内容还在**才算
  const r = db.prepare('select drop_reason from reading_state where book_id = ?').get(dropped) as { drop_reason: string };
  assert.equal(r.drop_reason, '第三卷开始注水，别看了');
});

test('修复：有文件却没有主版本的，挑字数最多的那个', () => {
  const id = addBookNoFile('没有主版本');
  const ins = db.prepare(
    'insert into book_file(book_id, root_id, path, size, mtime, is_primary, word_count) values(?,?,?,1,1,0,?)',
  );
  ins.run(id, rootId, join(dir, 'a.txt'), 100);
  ins.run(id, rootId, join(dir, 'b.txt'), 999);

  assert.equal(repairLibrary(db).missingPrimary, 1);
  const primary = db.prepare('select path from book_file where book_id = ? and is_primary = 1').get(id) as { path: string };
  assert.ok(primary.path.endsWith('b.txt'), '字数最多的那个当主版本');
});

test('修复：内容还在别处的 missing 记录要清掉——那种扫描永远修不好', () => {
  // 用户先把文件复制到新目录（扫描按「完全重复」正确地收成两条），
  // 之后才在应用外删掉旧的那份。旧记录从此卡在 missing，重扫多少遍都没用
  const gone = addBookNoFile('搬走了的书');
  const alive = join(dir, '还在的.txt');
  writeFileSync(alive, '内容');
  const ins = db.prepare(
    `insert into book_file(book_id, root_id, path, size, mtime, content_hash, is_primary, status)
     values(?,?,?,1,1,?,1,?)`,
  );
  ins.run(gone, rootId, join(dir, '已经没有了.txt'), 'samehash', 'missing');
  const keep = addBookNoFile('还在的书');
  ins.run(keep, rootId, alive, 'samehash', 'ok');

  const r = repairLibrary(db);

  assert.equal(r.staleMissing, 1);
  assert.equal(
    (db.prepare("select count(*) n from book_file where status = 'missing'").get() as { n: number }).n,
    0,
  );
  assert.ok(existsSync(alive), '活着的那份一个字都不许动');
  assert.equal(r.orphanBooks, 1, '空掉的那条书记录顺带清掉');
});

test('修复：号称还在、但磁盘上其实也没了的，不算数——missing 记录留着', () => {
  const gone = addBookNoFile('搬走了的书');
  const other = addBookNoFile('号称还在的书');
  const ins = db.prepare(
    `insert into book_file(book_id, root_id, path, size, mtime, content_hash, is_primary, status)
     values(?,?,?,1,1,?,1,?)`,
  );
  ins.run(gone, rootId, join(dir, 'a.txt'), 'samehash', 'missing');
  ins.run(other, rootId, join(dir, '记录说还在其实没有.txt'), 'samehash', 'ok');

  assert.equal(repairLibrary(db).staleMissing, 0, '光信 status=ok 会把唯一的记录也删了');
  assert.equal(
    (db.prepare("select count(*) n from book_file where status = 'missing'").get() as { n: number }).n,
    1,
  );
});

test('修复：不属于任何目录、文件也没了的记录要删掉——扫描永远碰不到它', () => {
  // root.remove 只把 root_id 置空、不删记录（怕丢进度，这是对的），
  // 但没有目录管的记录扫描遍历不到，连「文件缺失」都标不上，
  // 于是它在书架上装作一切正常，点开才报 ENOENT
  const b = addBookNoFile('删过目录的书');
  db.prepare(
    `insert into book_file(book_id, root_id, path, size, mtime, is_primary, status)
     values(?, null, ?, 1, 1, 1, 'ok')`,
  ).run(b, join(dir, '早就没了.txt'));

  const r = repairLibrary(db);

  assert.equal(r.rootlessGone, 1);
  assert.equal(
    (db.prepare('select count(*) n from book_file').get() as { n: number }).n,
    0,
  );
});

test('修复：没有目录但文件还在的，留着——用户可能把目录再加回来', () => {
  const b = addBookNoFile('挪出目录的书');
  const alive = join(dir, '文件还在.txt');
  writeFileSync(alive, '内容');
  db.prepare(
    `insert into book_file(book_id, root_id, path, size, mtime, is_primary, status)
     values(?, null, ?, 1, 1, 1, 'ok')`,
  ).run(b, alive);

  assert.equal(repairLibrary(db).rootlessGone, 0);
  assert.equal((db.prepare('select count(*) n from book_file').get() as { n: number }).n, 1);
  assert.ok(existsSync(alive), '文件一个字都不许动');
});

// ── 按目录筛选（侧栏的目录树）────────────────────────────

/** 造一本挂在根目录下某个相对路径的书 */
function addBookAt(title: string, rel: string): number {
  const id = addBookNoFile(title);
  db.prepare(
    `insert into book_file(book_id, root_id, path, size, mtime, is_primary, word_count, status)
     values(?,?,?,1,1,1,10000,'ok')`,
  ).run(id, rootId, rel ? join(dir, ...rel.split('/'), `${title}.txt`) : join(dir, `${title}.txt`));
  return id;
}

test('按目录筛选：含子目录，但不含兄弟目录', () => {
  addBookAt('根下的', '');
  addBookAt('存档里的', 'Archive');
  addBookAt('存档子目录里的', 'Archive/2019');
  addBookAt('别处的', 'hot');

  assert.deepEqual(titles(listBooks(db, { dir: 'Archive' })), ['存档子目录里的', '存档里的']);
  assert.deepEqual(titles(listBooks(db, { dir: 'Archive/2019' })), ['存档子目录里的']);
  assert.deepEqual(titles(listBooks(db, { dir: 'hot' })), ['别处的']);
});

test('按目录筛选：dir 传空串是「根目录直属」，不是「全部」', () => {
  // 这两个差着 8000 本。写成 `if (f.dir)` 就会把空串当没传，
  // 于是「根目录直属」这一档点下去显示的是整个库
  addBookAt('根下的', '');
  addBookAt('子目录里的', 'Archive');

  assert.deepEqual(titles(listBooks(db, { dir: '' })), ['根下的']);
  assert.deepEqual(titles(listBooks(db, {})).length, 2, '不传 dir 才是全部');
});

test('按目录筛选：前缀相同的目录不会互相串', () => {
  // `Archive` 和 `ArchiveOld` 前缀一样。少了分隔符就会把后者也算进来
  addBookAt('甲', 'Archive');
  addBookAt('乙', 'ArchiveOld');

  assert.deepEqual(titles(listBooks(db, { dir: 'Archive' })), ['甲']);
  assert.deepEqual(titles(listBooks(db, { dir: 'ArchiveOld' })), ['乙']);
});

// 按目录设连载状态：用户的书库本来就按状态分目录放（未完 / 其余），
// 那个信息一直摆在磁盘上没被用起来
test('按目录设连载状态：命中规则的走规则，其余走默认', () => {
  const a = addBookAt('连载的', '未完');
  const b = addBookAt('完本的', 'Archive');
  const c = addBookAt('根下的', '');

  const r = applySerialByDir(db, [{ dir: '未完', status: 'ongoing' }], 'finished');
  assert.equal(r.changed, 3);
  const st = (id: number) => (db.prepare('select serial_status s from book where id=?').get(id) as { s: string }).s;
  assert.equal(st(a), 'ongoing');
  assert.equal(st(b), 'finished');
  assert.equal(st(c), 'finished', '根目录直属的也要吃到默认');
});

test('按目录设连载状态：规则作用于整棵子树，长的规则优先', () => {
  const deep = addBookAt('未完里的子目录', '未完/2024');
  const sub = addBookAt('实体书', 'Archive/实体书');
  applySerialByDir(
    db,
    [{ dir: '未完', status: 'ongoing' }, { dir: 'Archive', status: 'finished' }, { dir: 'Archive/实体书', status: 'abandoned' }],
    null,
  );
  const st = (id: number) => (db.prepare('select serial_status s from book where id=?').get(id) as { s: string }).s;
  assert.equal(st(deep), 'ongoing', '规则要盖住子目录');
  assert.equal(st(sub), 'abandoned', '更长的规则优先，不能被 Archive 抢走');
});

test('按目录设连载状态：fallback 传 null 就不动没命中的书', () => {
  const a = addBookAt('连载的', '未完');
  const b = addBookAt('别动我', 'Archive');
  applySerialByDir(db, [{ dir: '未完', status: 'ongoing' }], null);
  const st = (id: number) => (db.prepare('select serial_status s from book where id=?').get(id) as { s: string }).s;
  assert.equal(st(a), 'ongoing');
  assert.equal(st(b), 'unknown', '没规则又没默认，就该保持原样');
});

test('按目录设连载状态：onlyUnknown 不覆盖用户手动改过的', () => {
  // 扫描后自动补状态走的是这条路。手动标成「太监」的书不该在下次扫描时
  // 被规则重设回「已完结」——这个仓库在 setStatus 上踩过「改 A 顺带写 B」的坑
  const manual = addBookAt('我手动标过', 'Archive');
  db.prepare("update book set serial_status='abandoned' where id=?").run(manual);
  const fresh = addBookAt('新扫进来的', 'Archive');

  const r = applySerialByDir(db, [], 'finished', { onlyUnknown: true });
  assert.equal(r.changed, 1);
  const st = (id: number) => (db.prepare('select serial_status s from book where id=?').get(id) as { s: string }).s;
  assert.equal(st(manual), 'abandoned', '手动改过的不许动');
  assert.equal(st(fresh), 'finished');
});

test('按目录设连载状态：被屏蔽的书照样要设', () => {
  // 和 listDirs 的口径**故意不同**。屏蔽是「我平时不想看见」，
  // 不改变「这本书完没完结」这个事实。跟着那边滤掉的话，真实库里有 759 本
  // 会静静地停在 unknown，而界面上完全看不出漏了谁
  const hidden = addBookAt('被屏蔽的', 'Archive');
  db.prepare('update book_file set excluded = 1 where book_id = ?').run(hidden);

  applySerialByDir(db, [], 'finished');
  assert.equal(
    (db.prepare('select serial_status s from book where id=?').get(hidden) as { s: string }).s,
    'finished',
  );
});

test('按目录设连载状态：dryRun 只算不写', () => {
  const a = addBookAt('甲', '未完');
  const r = applySerialByDir(db, [{ dir: '未完', status: 'ongoing' }], 'finished', { dryRun: true });
  assert.equal(r.changed, 1);
  assert.deepEqual(r.byStatus, { ongoing: 1 });
  assert.equal(
    (db.prepare('select serial_status s from book where id=?').get(a) as { s: string }).s, 'unknown', '预览不许落库',
  );
});

test('目录树：中间目录自己不放书也要有节点，否则树是断的', () => {
  addBookAt('深处的', 'a/b/c');
  const dirs = listDirs(db);
  const names = dirs.map((d) => d.dir);
  assert.ok(names.includes('a'), `缺中间节点：${names.join(' | ')}`);
  assert.ok(names.includes('a/b'));
  assert.ok(names.includes('a/b/c'));
  assert.equal(dirs.find((d) => d.dir === 'a')!.own, 0, '它自己不直接放书');
  assert.equal(dirs.find((d) => d.dir === 'a')!.total, 1, '但子目录里有一本');
});

test('目录树：own 只数自己的，total 连子目录一起数', () => {
  addBookAt('甲', 'Archive');
  addBookAt('乙', 'Archive');
  addBookAt('丙', 'Archive/2019');

  const a = listDirs(db).find((d) => d.dir === 'Archive')!;
  assert.equal(a.own, 2);
  assert.equal(a.total, 3);
});

test('目录树：被屏蔽和文件缺失的不计入——侧栏数字要和书架对得上', () => {
  const shown = addBookAt('看得见的', 'Archive');
  const hidden = addBookAt('被屏蔽的', 'Archive');
  db.prepare('update book_file set excluded = 1 where book_id = ?').run(hidden);
  assert.ok(shown > 0);

  assert.equal(listDirs(db).find((d) => d.dir === 'Archive')!.total, 1);
});

test('侧栏计数跟着目录走——不然「全部 8172」旁边列着 153 本书', () => {
  addBookAt('甲', 'hot');
  addBookAt('乙', 'hot');
  addBookAt('丙', 'Archive');

  assert.equal(shelfCounts(db).all, 3, '不带范围就是全库');
  assert.equal(shelfCounts(db, { dir: 'hot' }).all, 2);
  assert.equal(shelfCounts(db, { dir: 'Archive' }).all, 1);
});

test('侧栏计数和书架列表必须同源——「需要处理」这一档曾经两套口径', () => {
  // 计数原来按 `f.status != 'ok'`（任意文件）数，书架按主文件的 fileStatus 筛。
  // 两边各自都说得通，数字对不上时谁也不知道哪个对
  const b = addBookAt('坏了的', 'hot');
  db.prepare("update book_file set status = 'parse_failed' where book_id = ?").run(b);
  addBookAt('好的', 'hot');

  const shelfFilter = { fileStatus: ['missing', 'parse_failed'] };
  assert.equal(shelfCounts(db).problem, listBooks(db, shelfFilter).length);
  assert.equal(shelfCounts(db, { dir: 'hot' }).problem, listBooks(db, { ...shelfFilter, dir: 'hot' }).length);
});

// ── 隐藏目录（长期偏好，不是导航）────────────────────────

test('隐藏目录：藏起来的连子目录一起藏', () => {
  addBookAt('根下的', '');
  addBookAt('存档里的', 'Archive');
  addBookAt('存档深处的', 'Archive/2019');
  addBookAt('别处的', 'hot');

  assert.deepEqual(titles(listBooks(db, { hideDirs: ['Archive'] })), ['别处的', '根下的']);
  assert.deepEqual(titles(listBooks(db, { hideDirs: ['Archive', 'hot'] })), ['根下的']);
});

test('隐藏目录：默认空数组 = 全都显示', () => {
  // 反过来做成「只显示选中的」，下次扫描新加的目录会默认不可见且毫无提示
  addBookAt('甲', 'hot');
  addBookAt('乙', 'Archive');
  assert.equal(listBooks(db, { hideDirs: [] }).length, 2);
  assert.equal(listBooks(db, {}).length, 2);
});

test('隐藏目录：藏「根目录下」不会把子目录里的也藏掉', () => {
  addBookAt('根下的', '');
  addBookAt('子目录里的', 'Archive');
  assert.deepEqual(titles(listBooks(db, { hideDirs: [''] })), ['子目录里的']);
});

test('隐藏目录：还没有文件的书不会被静默滤掉', () => {
  // `not (path like ...)` 遇到 null 求值是 null，不是 true——那本书会凭空消失
  addBookNoFile('没有文件的书');
  addBookAt('有文件的', 'hot');
  assert.deepEqual(titles(listBooks(db, { hideDirs: ['Archive'] })), ['有文件的', '没有文件的书']);
});

test('隐藏目录：前缀相同的不会误伤', () => {
  addBookAt('甲', 'Archive');
  addBookAt('乙', 'ArchiveOld');
  assert.deepEqual(titles(listBooks(db, { hideDirs: ['Archive'] })), ['乙']);
});

test('隐藏目录：侧栏计数也跟着少', () => {
  addBookAt('甲', 'hot');
  addBookAt('乙', 'Archive');
  addBookAt('丙', 'Archive/2019');
  assert.equal(shelfCounts(db, { hideDirs: ['Archive'] }).all, 1);
});

// ── 排序 ────────────────────────────────────────────────

/** 造一本带指定文件时间和字数的书 */
function addBookTimed(title: string, mtime: number, words = 1000): number {
  const id = addBookNoFile(title);
  db.prepare(
    `insert into book_file(book_id, root_id, path, size, mtime, is_primary, word_count, status)
     values(?,?,?,1,?,1,?,'ok')`,
  ).run(id, rootId, join(dir, `${title}.txt`), mtime, words);
  return id;
}

test('默认按文件时间排，不是 book.updated_at', () => {
  // updated_at 是数据库行的更新时间：一次全库扫描会把成千上万本写成同一个值
  // （实测用户库里 7459 本共用一个），排出来完全是随机的，还看着像排过了
  addBookTimed('旧的', 1_000);
  addBookTimed('新的', 9_000);
  addBookTimed('中间的', 5_000);
  // 故意让 updated_at 的顺序和文件时间相反
  db.exec("update book set updated_at = '2020-01-01' where title = '新的'");

  assert.deepEqual(
    (listBooks(db) as Array<{ title: string }>).map((b) => b.title),
    ['新的', '中间的', '旧的'],
  );
});

test('文件时间一样时次序稳定——否则翻页会重复或漏书', () => {
  // 同一批拷进来的文件 mtime 完全相同，没有次级排序键的话
  // 第二页可能又给出第一页已经有的书
  for (let i = 0; i < 6; i++) addBookTimed(`同批第${i}本`, 7_000);
  const page1 = (listBooks(db, {}, { limit: 3, offset: 0 }) as Array<{ id: number }>).map((b) => b.id);
  const page2 = (listBooks(db, {}, { limit: 3, offset: 3 }) as Array<{ id: number }>).map((b) => b.id);
  assert.equal(new Set([...page1, ...page2]).size, 6, `两页有重叠：${page1} / ${page2}`);
});

test('还能按书名和字数排', () => {
  addBookTimed('丙', 9_000, 100);
  addBookTimed('甲', 1_000, 900);
  addBookTimed('乙', 5_000, 500);

  const by = (sort: 'title' | 'words') =>
    (listBooks(db, {}, { sort }) as Array<{ title: string }>).map((b) => b.title);
  // **按书名排是码位序，不是拼音序**：丙 U+4E19 < 乙 U+4E59 < 甲 U+7532。
  // SQLite 没有中文拼音排序，而分页要求排序在 SQL 里做（8000 本不可能拉到前端排）。
  // 实际价值是把同前缀的系列排到一起（《斗破苍穹》《斗罗大陆》相邻），不是字典序
  assert.deepEqual(by('title'), ['丙', '乙', '甲']);
  assert.deepEqual(by('words'), ['甲', '乙', '丙']);
});

test('默认排序把读过的排在最前面——「继续阅读」那张卡片就是被这条取代的', () => {
  addBookTimed('很新但没读过', 9_000);
  const read = addBookTimed('读过的但文件很旧', 1_000);
  addBookTimed('中等新', 5_000);
  db.prepare("update reading_state set last_read_at = datetime('now') where book_id = ?").run(read);

  assert.deepEqual(
    (listBooks(db) as Array<{ title: string }>).map((b) => b.title),
    ['读过的但文件很旧', '很新但没读过', '中等新'],
  );
});

test('读过的之间按最后阅读时间排', () => {
  const a = addBookTimed('先读的', 1_000);
  const b = addBookTimed('后读的', 1_000);
  db.prepare("update reading_state set last_read_at = '2020-01-01' where book_id = ?").run(a);
  db.prepare("update reading_state set last_read_at = '2024-01-01' where book_id = ?").run(b);

  assert.deepEqual(
    (listBooks(db) as Array<{ title: string }>).map((t) => t.title),
    ['后读的', '先读的'],
  );
});

test('列表里带上进度——点书要接着上次读的地方开', () => {
  // 不带的话每张封面得单独问一次进度，8000 本就是 8000 次 IPC
  const id = addBookTimed('读到一半的', 1_000);
  db.prepare('update reading_state set chapter_idx = 42, char_offset = 900 where book_id = ?').run(id);
  const row = listBooks(db)[0] as { chapter_idx: number; char_offset: number };
  assert.equal(row.chapter_idx, 42);
  assert.equal(row.char_offset, 900);
});

// ── 个人评价体系 ──────────────────────────────────────────
// 设计见 docs/superpowers/specs/2026-08-14-personal-reviews-design.md

test('迁移 16 给 reading_state 加上了 rated_at', () => {
  const cols = (db.prepare('pragma table_info(reading_state)').all() as Array<{ name: string }>)
    .map((c) => c.name);
  assert.ok(cols.includes('rated_at'), `reading_state 的列：${cols.join(', ')}`);
});

test('给整个筛选结果打标签，只动筛选进去的那些', () => {
  const a = addBook('重生之都市修仙');
  const b = addBook('重生八零年代');
  const c = addBook('斗破苍穹');

  const r = tagBooksByFilter(db, { keyword: '重生' }, ['重生']);
  assert.equal(r.bookIds.length, 2);
  assert.deepEqual(r.bookIds.sort((x, y) => x - y), [a, b]);

  const tagged = listBooks(db, { tagIds: [r.tagIds[0]] }) as Array<{ id: number }>;
  assert.deepEqual(tagged.map((x) => x.id).sort((x, y) => x - y), [a, b]);
  assert.ok(!tagged.some((x) => x.id === c), '没匹配上的书不该被打');
});

test('重复打同一个标签时，返回的是**实际新增**的那些——撤销靠它', () => {
  addBook('重生之一');
  addBook('重生之二');
  const first = tagBooksByFilter(db, { keyword: '重生' }, ['重生']);
  assert.equal(first.bookIds.length, 2);

  // 再打一遍：一本都没新增，撤销时就不该摘掉任何东西
  const again = tagBooksByFilter(db, { keyword: '重生' }, ['重生']);
  assert.deepEqual(again.bookIds, [], '本来就有这个标签的不算新增');
  assert.equal(listTags(db).find((t) => t.name === '重生')!.count, 2, '关联数不该翻倍');
});

/*
 * 「圈中了几本」和「会变几本」不是一个数。
 *
 * 按钮上原来写的是 `book.matchCount`，而真正落库的是 `insert or ignore` 的新增数。
 * 同一个关键词点第二次、或者两个重叠的关键词（`重生` 和 `重生之`），
 * 按钮就会承诺一个做不到的数——同批量改状态那次是一个形状。
 */
test('预览说会变几本，就得真的变几本', () => {
  addBook('重生之一');
  addBook('重生之二');
  addBook('重生之三');

  const before = planTagByFilter(db, { keyword: '重生' }, ['重生']);
  assert.equal(before.total, 3, '标签还不存在，三本都会变');
  assert.equal(before.already, 0);

  const done = tagBooksByFilter(db, { keyword: '重生' }, ['重生']);
  assert.equal(done.bookIds.length, before.total, '预览的数就是执行的数');

  // 再来一遍：一本都不会变，按钮不许再承诺 3 本
  const after = planTagByFilter(db, { keyword: '重生' }, ['重生']);
  assert.equal(after.total, 0, '本来就有这个标签的不算会变');
  assert.equal(after.already, 3);
  assert.equal(tagBooksByFilter(db, { keyword: '重生' }, ['重生']).bookIds.length, 0);
});

test('一次打两个标签，只缺其中一个的书也算会变', () => {
  const a = addBook('重生之甲');
  addBook('重生之乙');
  tagBooks(db, [a], ['玄幻']);   // 甲已经有「玄幻」，还缺「重生」

  const plan = planTagByFilter(db, { keyword: '重生' }, ['玄幻', '重生']);
  assert.equal(plan.total, 2, '缺任意一个就算会变');
  assert.equal(plan.already, 0);

  tagBooksByFilter(db, { keyword: '重生' }, ['玄幻', '重生']);
  const done = planTagByFilter(db, { keyword: '重生' }, ['玄幻', '重生']);
  assert.equal(done.total, 0);
  assert.equal(done.already, 2);
});

test('改标签名撞上已有的名字就是合并，书数取并集不是和', () => {
  const a = addBook('甲');
  const b = addBook('乙');
  tagBooks(db, [a, b], ['玄幻']);   // 两本都有「玄幻」
  tagBooks(db, [b], ['玄幻小说']);  // 乙 还多一个「玄幻小说」

  const wrong = listTags(db).find((t) => t.name === '玄幻小说')!;
  const r = renameTag(db, wrong.id, '玄幻');

  const tags = listTags(db);
  assert.equal(tags.length, 1, '合并后只剩一个标签');
  assert.equal(tags[0].name, '玄幻');
  assert.equal(tags[0].id, r.mergedInto);
  // 乙 两个标签都有过，合并后只能算一次——并集是 2，不是 3
  assert.equal(tags[0].count, 2, '两边都打过的书不能重复计');
});

test('改成一个没人用过的名字就是单纯改名', () => {
  const a = addBook('甲');
  tagBooks(db, [a], ['玄幻']);
  const t = listTags(db)[0];
  const r = renameTag(db, t.id, '东方玄幻');
  assert.equal(r.mergedInto, t.id);
  assert.deepEqual(listTags(db).map((x) => x.name), ['东方玄幻']);
  assert.equal(listTags(db)[0].count, 1, '改名不该丢掉关联');
});

test('删标签会连带清掉它在书上的关联', () => {
  const a = addBook('甲');
  tagBooks(db, [a], ['烂尾']);
  const t = listTags(db)[0];
  deleteTag(db, t.id);
  assert.deepEqual(listTags(db), []);
  assert.equal(
    (db.prepare('select count(*) n from book_tag').get() as { n: number }).n,
    0,
    'book_tag 里不该留下孤儿行',
  );
});

test('按评分筛：minRating 和「评价过 / 没评价过」', () => {
  const a = addBook('五星');
  const b = addBook('两星');
  const c = addBook('只写了短评');
  addBook('没碰过');
  setStatus(db, a, { rating: 5 });
  setStatus(db, b, { rating: 2 });
  setStatus(db, c, { comment: '烂尾了别看' });

  assert.deepEqual(titles(listBooks(db, { minRating: 4 })), ['五星']);
  // **只写了短评没打分的也算「评价过」**——那句话恰恰是「避免重复阅读」最有用的信息
  assert.deepEqual(titles(listBooks(db, { rated: true })), ['两星', '五星', '只写了短评']);
  assert.deepEqual(titles(listBooks(db, { rated: false })), ['没碰过']);
});

test('评分筛选能和别的条件叠加——走的是 buildFilter 同一条路', () => {
  // shelfCounts 当年绕开 buildFilter 自己写 SQL，两边口径对不上，
  // 数字不一致时谁也不知道哪个对。这条钉着「不许再来一次」
  const a = addBook('好看的玄幻', { serial: 'finished' });
  addBook('好看的都市', { serial: 'ongoing' });
  setStatus(db, a, { rating: 5 });
  setStatus(db, addBook('难看的玄幻', { serial: 'finished' }), { rating: 1 });

  assert.deepEqual(titles(listBooks(db, { minRating: 4, serialStatus: ['finished'] })), ['好看的玄幻']);
});

test('rated_at 跟着评价走，两边都清空时要一起清掉', () => {
  const a = addBook('甲');
  const at = () => (db.prepare('select rated_at from reading_state where book_id=?').get(a) as
    { rated_at: string | null }).rated_at;

  assert.equal(at(), null, '没评价过就不该有评价时间');
  setStatus(db, a, { rating: 4 });
  assert.ok(at(), '打分之后要有');

  setStatus(db, a, { rating: null });
  assert.equal(at(), null, '**清空评分后要还原**——只写不还原的派生字段几个月后会以「这本没评价过，怎么排在最前面」的形式冒出来');

  setStatus(db, a, { comment: '烂尾' });
  assert.ok(at(), '只写短评也算评价过');
  setStatus(db, a, { comment: '' });
  assert.equal(at(), null);
});

test('清空评分但还留着短评时，评价时间不能一起清掉', () => {
  const a = addBook('甲');
  setStatus(db, a, { rating: 3, comment: '前期好看' });
  setStatus(db, a, { rating: null });
  const row = db.prepare('select rating, comment, rated_at from reading_state where book_id=?').get(a) as
    { rating: number | null; comment: string | null; rated_at: string | null };
  assert.equal(row.rating, null);
  assert.equal(row.comment, '前期好看');
  assert.ok(row.rated_at, '短评还在，这本书仍然算评价过');
});

test('从书名挖高频词：语法碎片要滤掉，「都市」不能误伤', () => {
  // 中文没有词边界，只能数 n-gram，于是「重生之都市修仙」会同时数出
  // 重生 / 生之 / 之都 / 都市……「生之」「我的」这类碎片在真实书名里频率极高
  // （实测「生之」140 次），排进前列会把真正的题材词挤下去
  for (let i = 0; i < 30; i++) {
    addBook(`重生之都市修仙${i}`);
    addBook(`我的superb人生${i}`);
  }
  const kw = titleKeywords(db, 5);
  const words = kw.map((k) => k.word);
  assert.ok(words.includes('重生'), `应该有「重生」，实际：${words.join(' ')}`);
  assert.ok(words.includes('都市'), '「都市」不能被当成碎片滤掉——它含「都」，是这个库第二大的题材词');
  for (const junk of ['生之', '之都', '我的']) {
    assert.ok(!words.includes(junk), `「${junk}」是语法碎片，不该出现`);
  }
});

test('挖词：更长的派生词不单列', () => {
  // 「重生军嫂」全都是「重生」的子集，两条都列出来只是噪音
  for (let i = 0; i < 20; i++) addBook(`重生军嫂${i}`);
  const words = titleKeywords(db, 5).map((k) => k.word);
  assert.ok(words.includes('重生'));
  assert.ok(!words.includes('重生军嫂'), `派生词不该单列：${words.join(' ')}`);
});

test('挖词：同一本书里重复出现只算一次', () => {
  for (let i = 0; i < 10; i++) addBook(`重生重生重生${i}`);
  const kw = titleKeywords(db, 5).find((k) => k.word === '重生');
  assert.equal(kw?.count, 10, '10 本书就是 10，不是 30');
});

test('整理数据库：被屏蔽却标成「缺失」的，文件还在就恢复成 ok', () => {
  // 扫描那头已经修了「不再新标」，但**已经标坏的不会自己好**——
  // 扫描根本不会再碰屏蔽的文件。实测真实库里有 759 条这样的记录，文件一个都没少
  const a = addBook('被屏蔽但文件还在');
  const path = join(dir, '被屏蔽但文件还在.txt');
  writeFileSync(path, 'x');
  db.prepare("update book_file set status='missing', excluded=1, path=? where book_id=?").run(path, a);

  const b = addBook('被屏蔽而且文件真没了');
  db.prepare("update book_file set status='missing', excluded=1, path=? where book_id=?")
    .run(join(dir, '不存在的.txt'), b);

  const r = repairLibrary(db);
  assert.equal(r.wronglyMissing, 1, '只恢复文件确实还在的那条');
  assert.equal(
    (db.prepare('select status from book_file where book_id=?').get(a) as { status: string }).status,
    'ok',
  );
  assert.equal(
    (db.prepare('select status from book_file where book_id=?').get(b) as { status: string }).status,
    'missing',
    '文件真没了的仍然是缺失',
  );
});

test('侧栏计数：每一档都要有数，漏掉的那档会整个消失', () => {
  // 侧栏按计数过滤显示，所以 shelfCounts 漏算一档 = 那一档在界面上不存在。
  // 实测漏过两个：excluded（759 本被屏蔽的书永远看不见，而它们「没被删、
  // 得找得回来」是写进 AGENTS.md 的承诺）和 rated（「我的书评」永远光秃秃一个名字）
  const a = addBook('评过的');
  addBook('没评过的');
  setStatus(db, a, { rating: 4 });
  const b = addBook('被屏蔽的');
  db.prepare('update book_file set excluded = 1 where book_id = ?').run(b);

  const c = shelfCounts(db, { excluded: 'all' });
  assert.equal(c.rated, 1, '「我的书评」那一档要有数');
  assert.equal(c.excluded, 1, '「已屏蔽」那一档也要有数');
  assert.ok(c.all >= 3);
});

/*
 * 星级那三档开关也要带书数（参考 Calibre 的 Tag Browser，它每一档评分都写着有几本）。
 *
 * 判据有三半，缺一半那排开关就会说假话：
 *   1. **是累计的**——★5 的书在三档里都算，★2 的一档都不算；
 *   2. **跟着横向筛选走**——同 `book.counts` 的 scope，否则筛完标签之后
 *      开关上的数和书架对不上（本文件那条「侧栏计数只跟着目录走」的老坑）；
 *   3. **一本都没有时是 0 不是 null**——`sum()` 在零行上给的是 null，
 *      直接摆出去界面上会写「★5 null」。
 */
test('星级开关的书数：累计、跟着筛选走、空的时候是 0', () => {
  const five = addBook('五星的');
  const four = addBook('四星的');
  const two = addBook('两星的');
  addBook('没评过的');
  setStatus(db, five, { rating: 5 });
  setStatus(db, four, { rating: 4 });
  setStatus(db, two, { rating: 2 });

  const c = shelfCounts(db);
  assert.equal(c.byRating[5], 1, '★5 那档：只有五星的');
  assert.equal(c.byRating[4], 2, '★4+ 那档：五星的也要算进来（累计）');
  assert.equal(c.byRating[3], 2, '★3+ 那档：两星的不算');

  // 跟着横向筛选走：搜一个只命中「五星的」的词，另外两本就不该再算进来
  const 筛过的 = shelfCounts(db, { keyword: '五星' });
  assert.equal(筛过的.byRating[4], 1, '筛完之后 ★4+ 只剩命中的那本');

  // 一本评过分的都没有时，三档都得是 0（不是 null，也不是 undefined）
  const 空的 = shelfCounts(db, { keyword: '压根搜不到的词' });
  assert.deepEqual(
    [空的.byRating[5], 空的.byRating[4], 空的.byRating[3]],
    [0, 0, 0],
    'sum() 在零行上给的是 null，得兜成 0',
  );
});

/*
 * 排序键要当场校验，别拼进 SQL。
 *
 * 起因是压测脚本传了个 `sort: 'recent'`（我自己写错的），拿回来的是
 * `no such column: undefined`——一句 SQLite 原文。rpc 表对外开放（§13），
 * 外部调用方最容易错的就是取值，而这种错该说人话。
 *
 * 第二条钉的是**原型链**：`ORDER['constructor']` 给的是
 * `function Object() { [native code] }`。拼进 SQL 只会得到语法错误
 * （拿不到任意字符串，所以不是注入），但 `api.test.ts` 早就为 rpc 白名单
 * 钉过同一条，这儿照做。
 */
test('不认识的排序方式当场报错，而不是抛一句 SQL 原文', () => {
  assert.throws(
    () => listBooks(db, {}, { sort: 'recent' as never }),
    (e: Error) => {
      assert.match(e.message, /排序方式/);
      assert.ok(!/no such column|SQLITE/i.test(e.message), `不该把 SQL 原文摆出来：${e.message}`);
      return true;
    },
  );
});

test('原型链上的名字不算排序方式', () => {
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => listBooks(db, {}, { sort: bad as never }), /排序方式/, bad);
  }
});

/*
 * **逗号是 `book.list` 里 tags 那一列的分隔符**（`group_concat(t.name, ',')`），
 * 渲染进程拿到之后 `split(',')`。所以一个叫「科幻,悬疑」的标签会在卡片上
 * **变成两个根本不存在的标签**——tag 表里是一条，界面上是两个，
 * 而摘掉它们的按钮按名字去找，找不到。
 *
 * 这就是 `bookKey` 特意挑 `\u0000` 当分隔符要躲开的那个形状，
 * 只是这里的数据是用户自己打的，挑哪个字符都可能撞上。
 * 判据：**输入里的逗号当分隔符处理**——打「科幻,悬suspense」多半就是想要两个标签。
 */
test('标签名里的逗号当分隔符，不许混进一个假标签', () => {
  const a = addBook('测试书');
  tagBooks(db, [a], ['科幻,悬疑', ' 正常标签 ']);

  const names = listTags(db).map((t) => t.name).sort();
  assert.deepEqual(names, ['悬疑', '正常标签', '科幻'], `实际：${JSON.stringify(names)}`);

  // 卡片那一列拼出来之后再 split 回去，个数要对得上
  const row = listBooks(db, {})[0] as { tags: string | null };
  assert.equal(String(row.tags).split(',').length, 3);
});

test('改名改成带逗号的名字要被拒——那会当场造出两个假标签', () => {
  const a = addBook('测试书');
  tagBooks(db, [a], ['玄幻']);
  const t = listTags(db).find((x) => x.name === '玄幻')!;
  assert.throws(() => renameTag(db, t.id, '玄幻,仙侠'), /逗号/);
  assert.equal(listTags(db).find((x) => x.id === t.id)!.name, '玄幻', '拒了就不能改坏原来的名字');
});

test('预览和执行对「科幻,悬疑」的理解要一致', () => {
  const a = addBook('测试书');
  const plan = planTagByFilter(db, {}, ['科幻,悬疑']);
  assert.equal(plan.total, 1);

  tagBooksByFilter(db, {}, ['科幻,悬疑']);
  // 打完之后再看：两个标签都在了，预览该说「一本都不会变」
  const after = planTagByFilter(db, {}, ['科幻,悬疑']);
  assert.equal(after.total, 0, '预览和执行必须按同一套规则理名字');
  assert.equal(after.already, 1);
  assert.equal(typeof a, 'number');
});

/*
 * `SORT_KEYS` 是渲染进程校验 localStorage 里那个排序偏好用的
 * （用户能手改那个值，而一个不认识的键会让 `orderBy` 在开机时抛）。
 * 它必须**从 `ORDER` 自己算出来**，不能是另抄的一份清单——
 * 抄一份下来，加一档排序时必然漏掉其中一份。
 */
test('SORT_KEYS 和真正能用的排序方式一一对应', () => {
  assert.ok(SORT_KEYS.length >= 4, `太少了，多半没算出来：${JSON.stringify(SORT_KEYS)}`);
  const a = addBook('甲');
  // 每一个键都得真的排得动；反过来，不在表里的一律抛
  for (const k of SORT_KEYS) {
    assert.doesNotThrow(() => listBooks(db, {}, { sort: k }), `${k} 排不动`);
  }
  assert.throws(() => listBooks(db, {}, { sort: '乱写的' as never }), /排序方式/);
  assert.equal(typeof a, 'number');
});

/*
 * **计数要说真话：`tagged` 是「真打上去几条」，不是「试了几次」。**
 * 和 `backup.ts` 的 `createdTags` 同一个形状——两处都没人读，
 * 所以两处都悄悄说了很久的假话。
 */
test('重复打同一个标签，tagged 是 0 而不是书数', () => {
  const a = addBook('甲');
  const b = addBook('乙');
  assert.equal(tagBooks(db, [a, b], ['玄幻']).tagged, 2, '第一次是真打上去两条');
  assert.equal(tagBooks(db, [a, b], ['玄幻']).tagged, 0, '第二次一条都没新增');
  assert.equal(tagBooks(db, [a, b], ['玄幻', '仙侠']).tagged, 2, '只有新的那个标签算数');
});

/*
 * **`insert or ignore` 后面不许跟无条件的 `++`。**
 *
 * 那条语句的全部意义就是「可能什么都不做」，紧跟一个无条件计数，
 * 数的就是「试了几次」而不是「真做成几件」。这个形状咬过三次，
 * 而且三次都是**返回值没人读**所以没人发现：
 *
 *   - `tagBooks().tagged`——给 10 本已经有这个标签的书再打一遍，返回 10
 *   - `backup.ts` 的 `createdTags`——恢复 100 本各带 5 个标签，报 500
 *   - `applyExtract().updated`——传进来几行就报几行（那处是裸 update）
 *
 * 判据收窄到 `insert or ignore` 才做成硬规则：`update ... where id = ?`
 * 那种前面通常已经确认过那一行存在（repair 的几个计数、rename 数的是文件真改名了），
 * 一并管进来会太吵。真相是 `changes`。
 */
test('insert or ignore 后面没有无条件的计数', () => {
  /*
   * **判据写成纯字符串操作，不用正则。**
   * 第一版是个正则，而它经手写模板生成时反斜杠被吃掉了——
   * 结果是一个永远匹配不上的字面量，**代码带着坏模式它照样绿**。
   * 破坏实验当场照出来了；自检那句只验了「扫到了 insert or ignore」，
   * 没验「检测器还认得出坏模式」——**验错了一半**。
   */
  const bareIncrement = (t: string) =>
    t.endsWith('++;') && /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(t.slice(0, -3));

  // 诱饵：检测器必须认得出这一行，否则这条断言是静默通过的
  assert.ok(bareIncrement('tagged++;'), '检测器坏了：认不出最典型的那一行');
  assert.ok(bareIncrement('report.restored.bookmarks++;'), '带点的也要认');
  assert.ok(!bareIncrement('if (r.changes > 0) tagged++;'), '带条件的不该算');

  const dir2 = new URL('.', import.meta.url);
  const files = readdirSync(dir2).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  let sawIgnore = 0;
  const bad: string[] = [];

  for (const f of files) {
    const lines = readFileSync(new URL(f, dir2), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/insert or ignore/i.test(lines[i])) continue;
      sawIgnore++;
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const t = lines[j].trim();
        if (bareIncrement(t)) { bad.push(`${f}:${j + 1} ${t}`); break; }
        if (t.startsWith('if ') || t === '}') break;
      }
    }
  }

  // 自检：一条 insert or ignore 都没扫到的话，这条断言是静默通过的
  assert.ok(sawIgnore >= 5, `只扫到 ${sawIgnore} 条 insert or ignore，多半是写法变了`);
  assert.deepEqual(bad, [],
    `这些计数数的是「试了几次」，不是「真做成几件」——判据是 run(...).changes：${bad.join('、')}`);
});

/*
 * **一个 5000 字的标签名当场就把界面毁了。** 量过：`tagBooks` 原来照收，
 * 而那个名字会出现在书架上方那排开关里、卡片的标签行里、标签管理的列表里，
 * 每一处都按「一个词」排版；想删掉它，还得先在那些地方点中它。
 * 最可能的来源是粘贴事故——从别处复制一段话，落进那个输入框。
 *
 * 打标签和改名共用一条上限（`TAG_NAME_MAX`），别各写一份。
 */
test('标签名太长要拒掉，打标签和改名共用同一条上限', () => {
  const id = Number(db.prepare("insert into book(title) values('随便一本')").run().lastInsertRowid);
  const 长 = '啊'.repeat(TAG_NAME_MAX + 1);

  assert.throws(() => tagBooks(db, [id], [长]), /太长/);
  assert.equal((db.prepare('select count(*) n from tag').get() as { n: number }).n, 0,
    '被拒了就一个标签都不该建出来');

  // 正好卡在上限上的要收
  tagBooks(db, [id], ['啊'.repeat(TAG_NAME_MAX)]);
  const t = db.prepare('select id from tag').get() as { id: number };
  assert.ok(t, `${TAG_NAME_MAX} 个字应该是允许的`);

  assert.throws(() => renameTag(db, t.id, 长), /太长/, '改名那头也要挡');
});

/*
 * **「读过没评价」是这个应用唯一的待办清单。**
 * 那几本书的结论此刻只在用户脑子里，而「下次不用再想这本我看过没」
 * 全靠它落到库里。
 *
 * 三档一起钉住（每一档都要有，否则拆掉判据的哪一半都可能不响）：
 *   读过 + 写过     → 不算（已经做完了）
 *   读过 + 没写     → 算
 *   没读过 + 没写   → 不算（8000 本没翻开过的书不是待办）
 */
test('侧栏的「读过没评价」只数读过、而且还没写一句的那些', () => {
  const mk = (title: string, status: string) => {
    const id = Number(db.prepare('insert into book(title) values(?)').run(title).lastInsertRowid);
    db.prepare('insert into reading_state(book_id, status) values(?, ?)').run(id, status);
    return id;
  };
  const done = mk('读过也写了', 'finished');
  db.prepare("update reading_state set comment = '烂尾了别看' where book_id = ?").run(done);
  const todo1 = mk('读完了还没写', 'finished');
  const todo2 = mk('弃了还没写原因', 'dropped');
  mk('还没翻开过', 'none');
  mk('想读而已', 'want');

  const c = shelfCounts(db);
  assert.equal(c.unreviewed, 2, '只有「读过 + 没写」那两本算待办');

  const got = (listBooks(db, { rated: false, readingStatus: TOUCHED_STATUS }, { limit: 50 }) as Array<{ id: number }>)
    .map((b) => b.id).sort();
  assert.deepEqual(got, [todo1, todo2].sort(), '书架筛出来的和侧栏那个数必须是同一批');
});

/*
 * **删掉一本书，它的 `viewer.<id>`（PDF / EPUB 读到第几页）要跟着没。**
 *
 * 那个键不是一张表，没有外键、`on delete cascade` 管不着它。前几轮把管书的四处
 * 逐个教会了认它，但那是靠人记得改；这条触发器让它变成结构性的。
 *
 * ⚠️ 第二半才是真正的要害：`book.id` 是**不带 `autoincrement`** 的
 * `integer primary key`——删掉最大那个 id 之后，**下一本新书会拿到同一个 id**。
 * 漏一行没清的位置，后果不是「留了点垃圾」，是**它会悄悄贴到另一本书上**：
 * 用户打开一本刚扫进来的书，直接跳到第 100 页，而没有任何地方说得出为什么。
 */
test('删书时清掉它的阅读位置——尤其因为 book.id 会被复用', () => {
  const 加 = (t: string) =>
    Number(db.prepare('insert into book(title, author) values(?, ?)').run(t, '某人').lastInsertRowid);
  const a = 加('一本 PDF');
  db.prepare('insert into app_setting(key, value) values(?, ?)').run(`viewer.${a}`, '100');

  db.prepare('delete from book where id = ?').run(a);
  assert.equal(
    (db.prepare('select count(*) n from app_setting where key = ?').get(`viewer.${a}`) as { n: number }).n,
    0,
    '书没了，它读到第几页也该没——那个键没有外键护着，只能靠触发器',
  );

  // id 真的会被复用：新书拿到同一个 id，而且不该继承上一本的位置
  const b = 加('刚扫进来的另一本');
  assert.equal(b, a, '夹具前提：这个库的 id 确实会复用，不然下面那条断言测不到东西');
  assert.equal(
    (db.prepare('select count(*) n from app_setting where key = ?').get(`viewer.${b}`) as { n: number }).n,
    0,
    '新书不该继承上一本的阅读位置',
  );
});

test('按格式筛：多选是「任意一种」，认不出的值当场报错', () => {
  /*
   * 起因是真实库上的一次需求：那个库里 txt 和 pdf 混着放，
   * 而分类原来只能按文件夹 / 评分 / 状态 / 标签筛——**筛不出「只看 PDF」**。
   */
  addBook('纯文本的书');                       // 夹具的 addBook 造的就是 .txt
  const b = addBook('一本PDF');
  // ⚠️ 大写扩展名也要认得——真实文件名里 `.PDF` 很常见
  db.prepare("update book_file set path = ? where book_id = ?")
    .run(join(dir, '一本PDF.PDF'), b);
  const c = addBook('只有记录的书');
  db.prepare('delete from book_file where book_id = ?').run(c);  // 手工添的，没有文件

  const 数 = (f: Filter) => countBooks(db, f);
  assert.equal(数({}), 3);
  assert.equal(数({ format: ['txt'] }), 1);
  assert.equal(数({ format: ['pdf'] }), 1, '扩展名比对要不分大小写');
  /*
   * **任意一种**，不是「同时是」——一本书只有一个主文件，
   * 照标签那条「同时具备」写就是一条永远筛不出东西的规则。
   */
  assert.equal(数({ format: ['txt', 'pdf'] }), 2);
  assert.equal(数({ format: ['manual'] }), 1, 'manual = 压根没有文件的那些');
  assert.equal(数({ format: ['txt', 'manual'] }), 2);

  /*
   * 认不出的值要当场报错。`like '%.xyz'` 匹配不到东西 = 一个永远空的分类，
   * 而界面上只会说「圈中 0 本」——判据同 `FILTER_KEYS` 那条：
   * **默默忽略比报错危险**。
   */
  assert.throws(() => 数({ format: ['doc'] }), /认不出这种格式/);
  assert.throws(() => 数({ format: ['txt', '拼错了'] }), /认不出这种格式/);
});


test('记过笔记：划线或书签任意一样都算，卡片上那个数是两者相加', () => {
  /*
   * 笔记原来在书架上**完全看不见**：`highlight` / `bookmark` 两张表只在孤儿检测
   * 那条 SQL 里露过一次面。认真读过、划了几十条的书，和从没打开过的长得一模一样。
   *
   * 这条钉三件事：**只有划线也算**、**只有书签也算**、**那个数是两者相加**。
   * 三份 SQL（卡片上的数、侧栏那一档、筛选）说的必须是同一件事。
   */
  const 甲 = Number(db.prepare("insert into book(title) values('只划过线')").run().lastInsertRowid);
  const 乙 = Number(db.prepare("insert into book(title) values('只加过书签')").run().lastInsertRowid);
  const 丙 = Number(db.prepare("insert into book(title) values('什么都没记')").run().lastInsertRowid);
  db.prepare(`insert into highlight(book_id, chapter_idx, char_offset, length, excerpt)
              values(?,0,0,2,'风雪')`).run(甲);
  db.prepare(`insert into highlight(book_id, chapter_idx, char_offset, length, excerpt)
              values(?,1,0,2,'夜归')`).run(甲);
  db.prepare("insert into bookmark(book_id, chapter_idx, char_offset) values(?,2,0)").run(乙);

  const 有 = listBooks(db, { hasNotes: true }) as Array<{ id: number; title: string; note_count: number }>;
  // JS 的 sort 按 UTF-16 码位排：划 U+5212 在 加 U+52A0 前面
  assert.deepEqual(有.map((x) => x.title).sort(), ['只划过线', '只加过书签']);
  assert.equal(有.find((x) => x.id === 甲)!.note_count, 2);
  assert.equal(有.find((x) => x.id === 乙)!.note_count, 1);

  // 反过来也要对：**「没记过」不能把记过的漏进来**
  const 没有 = listBooks(db, { hasNotes: false }) as Array<{ id: number; note_count: number }>;
  assert.ok(没有.some((x) => x.id === 丙), '什么都没记的那本该在「没记过」里');
  assert.ok(!没有.some((x) => x.id === 甲 || x.id === 乙), '记过的不该出现在「没记过」里');
  assert.equal(没有.find((x) => x.id === 丙)!.note_count, 0);

  // 判据只此一份：那句 SQL 两边都认得出这两张表
  assert.match(hasNotesSql(), /highlight/);
  assert.match(hasNotesSql(), /bookmark/);
});

/*
 * **「读完年份」下拉里的数，和按它筛出来的数，必须是同一个算法。**
 *
 * 这是 `YEAR_SQL` 只留一份的理由：两份 `strftime` 的话，下拉上写着「2025（3）」、
 * 点进去 0 本，而谁也说不清哪个对——同 `ratedSql` 那条
 * （侧栏说 40 本、`/api/stats` 说 12 本）。
 *
 * ⚠️ **这条断言不写死年份。** `YEAR_SQL` 带 `localtime`，跨年那几个小时算出来的
 * 年份跟着机器时区走——写死 `2025` 的话这个测试换个时区就红，而红的是测试不是代码。
 * 钉的是**两边一致**，那在任何时区都成立。
 */
test('读完年份：下拉里的数和按它筛出来的数对得上', () => {
  const a = addBook('前年读完的');
  const b = addBook('去年读完的甲');
  const c = addBook('跨年那一刻读完的');
  addBook('还没读完的');
  const 记读完 = (id: number, 时间: string) =>
    db.prepare("update reading_state set status='finished', finished_at=? where book_id=?")
      .run(时间, id);
  记读完(a, '2024-06-01 03:00:00');
  记读完(b, '2025-06-01 03:00:00');
  // **这一条是重点**：UTC 记的是 12 月 31 日，而东八区的用户看到的是元旦
  记读完(c, '2025-12-31 16:30:00');

  const years = finishedYears(db);
  assert.ok(years.length >= 2, `至少该有两个年份，拿到 ${JSON.stringify(years)}`);
  for (const { year, n } of years) {
    assert.equal(
      countBooks(db, { finishedYear: Number(year) }),
      n,
      `${year} 年：下拉说 ${n} 本，按它筛出来的却不是这个数`,
    );
  }

  // 没读完的那本不许被算进任何一年
  assert.equal(
    years.reduce((s, y) => s + y.n, 0),
    3,
    '只有三本有 finished_at，第四本不该出现在任何一年里',
  );
});

test('读完年份能和别的条件叠加——走的是 buildFilter 同一条路，不另写 SQL', () => {
  const a = addBook('甲');
  const b = addBook('乙');
  db.prepare(
    "update reading_state set status='finished', finished_at='2025-06-01 03:00:00' where book_id in (?,?)",
  ).run(a, b);
  tagBooks(db, [a], ['玄幻']);

  const y = Number(finishedYears(db)[0].year);
  assert.equal(countBooks(db, { finishedYear: y }), 2);
  const 玄幻 = listTags(db).find((t) => t.name === '玄幻')!.id;
  assert.equal(countBooks(db, { finishedYear: y, tagIds: [玄幻] }), 1, '年份 + 标签是交集');
});

/*
 * **`total` 不跟着筛选走，`all` 跟。**
 *
 * 这两个数长得一模一样，而它们答的是两个问题：
 *   - `all`：当前筛选范围内几本 → 侧栏「全部」那一档显示它
 *   - `total`：整个库几本 → 界面拿它判断「这个用户到底有没有书」
 *
 * 混用的后果是真出过的事故：搜索框、顶栏那排控件、分类那一排原来都用 `all`，
 * 于是**筛出 0 本时它们一起消失，用户没有任何办法取消那个筛选**——
 * 搜一个不存在的词，搜索框自己就没了；点中一个圈不中书的分类，
 * 那排分类连同「全部」一起消失，只能重启应用。
 */
test('shelfCounts：total 是整个库，all 跟着筛选走', () => {
  addBook('甲');
  addBook('乙');
  addBook('丙');

  const 全部 = shelfCounts(db);
  assert.equal(全部.total, 3);
  assert.equal(全部.all, 3, '没有筛选时两个数当然一样');

  // 一个圈不中任何书的筛选
  const 空 = shelfCounts(db, { keyword: '绝不可能命中的词' });
  assert.equal(空.all, 0, 'all 要跟着筛选走——侧栏的数得是真的');
  assert.equal(空.total, 3, '**而 total 不许被筛选影响**：库里还有三本书');

  // 真空库才是 0
  db.prepare('delete from book').run();
  assert.equal(shelfCounts(db).total, 0);
});

test('「最近读完的在前」：没读完的沉到最后，不混在中间', () => {
  const 早 = addBook('早读完的');
  const 晚 = addBook('晚读完的');
  const 没读完 = addBook('没读完的');
  db.prepare("update reading_state set finished_at='2024-01-01 00:00:00' where book_id=?").run(早);
  db.prepare("update reading_state set finished_at='2026-01-01 00:00:00' where book_id=?").run(晚);

  const 顺序 = (listBooks(db, {}, { sort: 'finished' }) as Array<{ id: number }>).map((r) => r.id);
  assert.deepEqual(顺序, [晚, 早, 没读完], '晚 → 早 → 没读完');
});
