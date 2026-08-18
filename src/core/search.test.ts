import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { countBooks } from './library.ts';
import { scanRoot } from './scan.ts';
import { FileCache } from './reader.ts';
import {
  buildIndex, dropIndex, isIndexed, indexedBooks,
  searchFullText, searchMeta, searchInBook, MIN_TRIGRAM,
} from './search.ts';
import { tagBooks } from './library.ts';

let dir: string;
let db: DatabaseSync;
let cache: FileCache;

/**
 * 每章的填充正文。**必须让整本书明显超过 10KB 的收录下限**——
 * 200 行 × 25 字节 × 2 章 ≈ 10.1KB 刚好卡在线上，书会被静默滤掉，
 * 于是所有断言都变成「查不到这本书」，看起来像搜索坏了。这个坑本项目踩过三次。
 */
const filler = Array.from({ length: 500 }, () => '寻常的一行正文。').join('\n');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'novel-search-'));
  db = openDb(join(dir, 'library.db'));
  const lib = join(dir, 'books');
  mkdirSync(lib);
  const rootId = Number(
    db.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid,
  );

  writeFileSync(
    join(lib, '《雪中悍刀行》烽火戏诸侯.txt'),
    [
      `第一章 初入江湖\n少年提剑出门，风雪满衣。\n${filler}`,
      `第二章 客栈遇故人\n他在客栈里遇到了旧识。\n${filler}`,
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(lib, '斗破苍穹-天蚕土豆.txt'),
    [`第一章 楔子\n斗气大陆，唯有强者为尊。\n${filler}`, `第二章 起风了\n他握紧了拳头。\n${filler}`].join('\n'),
    'utf8',
  );

  await scanRoot(db, { id: rootId, path: lib });
  cache = new FileCache();
});

afterEach(async () => {
  await cache.releaseAll();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('元数据搜索不需要索引，随时能用', () => {
  assert.equal(isIndexed(db), false);
  const r = searchMeta(db, '烽火') as Array<{ title: string }>;
  assert.deepEqual(r.map((x) => x.title), ['雪中悍刀行']);
});

test('标签也能搜到', () => {
  const id = (db.prepare("select id from book where title='斗破苍穹'").get() as { id: number }).id;
  tagBooks(db, [id], ['热血']);
  const r = searchMeta(db, '热血') as Array<{ title: string }>;
  assert.deepEqual(r.map((x) => x.title), ['斗破苍穹']);
});

test('没建索引就搜正文要明确报错，不能假装没结果', () => {
  assert.throws(() => searchFullText(db, '客栈里'), /没有任何书建过正文索引/);
});

test('建索引后能搜到正文，并给出上下文片段', async () => {
  const r = await buildIndex(db, cache);
  assert.equal(r.chapters, 4);
  assert.equal(isIndexed(db), true);

  const hits = searchFullText(db, '客栈里');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].bookTitle, '雪中悍刀行');
  assert.equal(hits[0].chapterTitle, '第二章 客栈遇故人');
  assert.match(hits[0].snippet, /【客栈里】/, '命中词要标出来');
});

test('两个字的查询也必须搜得到（trigram 搜不了，得回落 LIKE）', async () => {
  await buildIndex(db, cache);
  // 这条是这个模块存在的理由：trigram 要求 ≥3 字，直接用它的话
  // 用户搜「客栈」会得到「无结果」，而那是句假话
  assert.ok('客栈'.length < MIN_TRIGRAM);
  const hits = searchFullText(db, '客栈');
  assert.ok(hits.length >= 1, '两个字也得有结果');
  assert.match(hits[0].snippet, /【客栈】/);
});

test('搜不到的词就是搜不到', async () => {
  await buildIndex(db, cache);
  assert.equal(searchFullText(db, '这个词整本书都没有').length, 0);
});

test('关掉索引会清空并禁用正文搜索', async () => {
  await buildIndex(db, cache);
  dropIndex(db);
  assert.equal(isIndexed(db), false);
  assert.equal((db.prepare('select count(*) n from chapter_fts').get() as { n: number }).n, 0);
  assert.throws(() => searchFullText(db, '客栈里'), /没有任何书建过正文索引/);
});

test('书内搜索不依赖索引', async () => {
  const bookId = (db.prepare("select id from book where title='雪中悍刀行'").get() as { id: number }).id;
  assert.equal(isIndexed(db), false, '故意不建索引');

  const hits = await searchInBook(db, cache, bookId, '客栈');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].chapterIdx, 1);
  assert.match(hits[0].snippet, /【客栈】/);
});

test('书内搜索只在这一本里找', async () => {
  const bookId = (db.prepare("select id from book where title='斗破苍穹'").get() as { id: number }).id;
  assert.equal((await searchInBook(db, cache, bookId, '客栈')).length, 0, '那是另一本书里的词');
  assert.ok((await searchInBook(db, cache, bookId, '斗气')).length >= 1);
});

test('索引存的是清洗后的正文，搜到的片段和阅读器里看到的一致', async () => {
  // 往正文里塞一条会被内置规则删掉的广告行
  const lib = join(dir, 'books');
  writeFileSync(
    join(lib, '带广告的书.txt'),
    `第一章 起\n正文第一句。\n手机站阅读 m.example.com\n${filler}\n第二章 承\n正文第二句。\n${filler}`,
    'utf8',
  );
  const rootId = (db.prepare('select id from library_root').get() as { id: number }).id;
  await scanRoot(db, { id: rootId, path: lib });
  await buildIndex(db, cache);

  assert.equal(searchFullText(db, '手机站阅读').length, 0, '被清洗掉的内容不该出现在搜索结果里');
  assert.ok(searchFullText(db, '正文第一句').length >= 1);
});

/** 两本书的 id。扫描后按书名取，不硬编码——扫描顺序不保证 */
const idOf = (title: string): number =>
  (db.prepare('select id from book where title = ?').get(title) as { id: number }).id;

test('按书建索引：只灌这一本，别的书不受影响', async () => {
  // 原来 buildIndex 无脑 `delete from chapter_fts`——给第二本建索引
  // 会把第一本的悄悄删掉，用户完全看不出来
  const b1 = idOf('雪中悍刀行');
  const b2 = idOf('斗破苍穹');

  await buildIndex(db, cache, undefined, [b1]);
  const after1 = indexedBooks(db);
  assert.deepEqual(after1.map((x) => x.bookId), [b1]);

  await buildIndex(db, cache, undefined, [b2]);
  const after2 = indexedBooks(db).map((x) => x.bookId).sort();
  assert.deepEqual(after2, [b1, b2].sort(), '第一本的索引不能被第二本冲掉');
});

test('删索引也能按书删', async () => {
  const b1 = idOf('雪中悍刀行');
  const b2 = idOf('斗破苍穹');
  await buildIndex(db, cache, undefined, [b1, b2]);
  assert.equal(indexedBooks(db).length, 2);

  dropIndex(db, [b1]);
  assert.deepEqual(indexedBooks(db).map((x) => x.bookId), [b2]);
  assert.equal(isIndexed(db), true, '还有一本建着，正文搜索仍然可用');

  dropIndex(db, [b2]);
  assert.equal(isIndexed(db), false, '一本都没有了才算没索引');
});

test('重复给同一本建索引不会翻倍', async () => {
  const b1 = idOf('雪中悍刀行');
  await buildIndex(db, cache, undefined, [b1]);
  const n1 = indexedBooks(db)[0].chapters;
  await buildIndex(db, cache, undefined, [b1]);
  assert.equal(indexedBooks(db)[0].chapters, n1, '重建要先清掉旧的，不然章节条目会翻倍');
});

test('书内搜索：跨窗口边界的匹配不会丢', async () => {
  // 顺序扫是按 4MB 窗口切的，窗口对齐到行边界。不对齐的话，
  // 正好落在断点上的那一行会被劈成两半，匹配就消失了——
  // 而且**只在大文件上复现**，小文件测试全绿
  const cache2 = new FileCache();
  const lib = join(dir, 'books');
  const many = Array.from(
    { length: 4000 },
    (_, i) => `第${i + 1}章 标题\n这一行里有独特词组${i}，用来定位。\n${filler}`,
  ).join('\n');
  writeFileSync(join(lib, '《大书》作者：某人.txt'), many, 'utf8');
  const rootId = (db.prepare('select id from library_root limit 1').get() as { id: number }).id;
  await scanRoot(db, { id: rootId, path: lib });

  const id = (db.prepare("select id from book where title = '大书'").get() as { id: number }).id;
  // 挑几个分布在全书各处的词，覆盖多个窗口
  for (const n of [0, 1500, 2999, 3999]) {
    const r = await searchInBook(db, cache2, id, `独特词组${n}，`);
    assert.equal(r.length, 1, `独特词组${n} 应该正好命中一次，实际 ${r.length}`);
  }
  await cache2.releaseAll();
});

test('书内搜索：命中要落在正确的章里', async () => {
  const cache2 = new FileCache();
  const id = (db.prepare("select id from book where title = '雪中悍刀行'").get() as { id: number }).id;
  const r = await searchInBook(db, cache2, id, '客栈里遇到了旧识');
  assert.equal(r.length, 1);
  assert.equal(r[0].chapterIdx, 1, '这句在第二章');
  assert.match(r[0].chapterTitle, /客栈/);
  assert.match(r[0].snippet, /【客栈里遇到了旧识】/);
  await cache2.releaseAll();
});

test('书内搜索不需要索引', async () => {
  // 全文索引是按书建的、多数书没建。书内搜索必须任何时候都能用
  assert.equal(isIndexed(db), false);
  const cache2 = new FileCache();
  const id = (db.prepare("select id from book where title = '斗破苍穹'").get() as { id: number }).id;
  const r = await searchInBook(db, cache2, id, '唯有强者为尊');
  assert.equal(r.length, 1);
  await cache2.releaseAll();
});

/*
 * **搜出来的结果要带着评价。**
 * 「下次不用再想这本我看过没」是这个应用的正事，而用户最常走的路就是
 * 在全库搜索里打书名——卡片上兑现了那句「烂尾了别看」，
 * 搜索结果里原来只有书名/作者/标签，恰好在最该回答的地方不答。
 */
test('搜书名的结果里带着评分和短评', () => {
  const id = (db.prepare("select id from book where title='雪中悍刀行'").get() as { id: number }).id;
  db.prepare("update reading_state set rating = 2, comment = '烂尾了别看' where book_id = ?").run(id);

  const r = searchMeta(db, '雪中') as Array<Record<string, unknown>>;
  assert.equal(r.length, 1);
  assert.equal(r[0].rating, 2, `没带评分：${JSON.stringify(r[0])}`);
  assert.equal(r[0].comment, '烂尾了别看');
});

/*
 * **搜出来一堆的时候，有话说的那几本要排在最前面。**
 *
 * 这个应用的正事是「下次不用再想这本我看过没」，而真实库里搜一个常用字
 * 回来一千行上下（当场量的：「的」1022、「之」975、「天」984），按书名排的话
 * 我评过的那几本可能在第 180 位——那堵墙里恰好埋着唯一能回答那个问题的几行。
 *
 * 判据分两档：评价过的（口径走 `ratedSql`，和「我的书评」那一档一致）最前，
 * 其次是打开过的。**书名那一档不动**：它是码位序，只保证同前缀的挨在一起。
 */
test('搜索结果里，评价过的排最前，其次是读过的', () => {
  const mk = (title: string) => Number(
    db.prepare('insert into book(title) values(?)').run(title).lastInsertRowid,
  );
  // 书名故意让码位序和期望顺序相反：丙 < 乙 < 甲（U+4E19 < U+4E59 < U+7532）
  const rated = mk('甲测试书');
  const read = mk('乙测试书');
  const cold = mk('丙测试书');
  for (const id of [rated, read, cold]) {
    db.prepare("insert into reading_state(book_id, status) values(?, 'none')").run(id);
  }
  db.prepare("update reading_state set comment = '烂尾了别看' where book_id = ?").run(rated);
  db.prepare("update reading_state set last_read_at = datetime('now') where book_id = ?").run(read);

  const got = (searchMeta(db, '测试书') as Array<{ title: string }>).map((x) => x.title);
  assert.deepEqual(got, ['甲测试书', '乙测试书', '丙测试书'],
    `按书名排的话应该是 丙乙甲，拿到的是 ${got.join('/')}`);
});

/*
 * **自己写的那句话也要能搜到。**
 *
 * 这个应用存下来的最有用的东西就是「烂尾了别看」这种话，而全库搜索原来搜不到它：
 * 结果表里**显示**短评（那一轮的理由是「用户最常走的就是在这儿搜书名」），
 * 却不按它匹配——「我记得给哪本书写过『烂尾』」这个问题答不上来。
 *
 * ⚠️ **只加在 `searchMeta`，不加进 `buildFilter`。** 书架那个搜索框喂给
 * 「批量打标签」「批量改状态」的正是它的筛选条件——往里塞一个新的匹配面，
 * 等于**悄悄加宽了那两个批量操作的作用范围**。同 AGENTS.md 里
 * 「把标签并进书架那个框会顺带加宽批量的范围」那条，判据一样。
 */
test('全库搜索能按短评和弃坑原因找到书', () => {
  const a = Number(db.prepare("insert into book(title) values('书名里没有那个词')").run().lastInsertRowid);
  const b = Number(db.prepare("insert into book(title) values('另一本')").run().lastInsertRowid);
  for (const id of [a, b]) {
    db.prepare("insert into reading_state(book_id, status) values(?, 'none')").run(id);
  }
  db.prepare("update reading_state set comment = '前面神作，后面烂尾了别看' where book_id = ?").run(a);
  db.prepare("update reading_state set status = 'dropped', drop_reason = '主角太蠢' where book_id = ?").run(b);

  const byComment = (searchMeta(db, '烂尾') as Array<{ title: string }>).map((x) => x.title);
  assert.deepEqual(byComment, ['书名里没有那个词'], '按短评找不到——那句话正是最该找到的东西');

  const byReason = (searchMeta(db, '主角太蠢') as Array<{ title: string }>).map((x) => x.title);
  assert.deepEqual(byReason, ['另一本'], '弃坑原因同理');

  // 顺带确认没有把书架那个框也改宽：批量操作靠的是它
  assert.equal(countBooks(db, { keyword: '烂尾' }), 0, 'buildFilter 不该按短评匹配');
});

/*
 * 下面两条钉的是「用户输进搜索框的字，一律是要找的字，不是语法」。
 * 这两个洞活到今天正是因为没人写过断言：19 条测试没有一条喂过特殊字符。
 */

test('FTS5 的操作符不许漏到用户面前——整串当短语搜', async () => {
  await buildIndex(db, cache);
  // 原来这五个查询每一个都把 fts5 的英文报错原样甩到搜索框下面
  for (const q of ['少年 AND 提剑', '斗气-大陆', 'x:y', '100%', '价格闯关"']) {
    assert.doesNotThrow(() => searchFullText(db, q), `搜「${q}」抛了`);
  }
  // 「所见即所搜」：AND 是要找的三个字母，不是操作符
  assert.equal(searchFullText(db, '少年提剑').length, 1);
  assert.equal(searchFullText(db, '少年 AND 提剑').length, 0);
});

test('% 和 _ 是字面量，不是通配符——三处 like 都要转义', async () => {
  // 书架顶上那个框（buildFilter）：搜一个 % 原来等于「全部」
  assert.equal(countBooks(db), 2);
  assert.equal(countBooks(db, { keyword: '%' }), 0);
  assert.equal(countBooks(db, { keyword: '_' }), 0);
  // 全库搜索的书名档
  assert.equal((searchMeta(db, '%') as unknown[]).length, 0);
  // 正文短查询的回落路径（短于 3 字走 like 扫索引表）
  await buildIndex(db, cache);
  assert.equal(searchFullText(db, '%').length, 0);
  assert.equal(searchFullText(db, '_').length, 0);
});
