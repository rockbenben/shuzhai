import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { scanRoot } from './scan.ts';
import { updateBook, batchUpdate, previewExtract, applyExtract, reparseBooks, bookDetail } from './metadata.ts';

let dir: string;
let db: DatabaseSync;
let lib: string;

const filler = Array.from({ length: 200 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
const body = ['第一章 起', '第二章 承', '第三章 转'].map((t) => `${t}\n${filler}\n`).join('');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'novel-meta-'));
  db = openDb(join(dir, 'library.db'));
  lib = join(dir, 'books');
  mkdirSync(lib);
  const rootId = Number(
    db.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid,
  );
  writeFileSync(join(lib, '《雪中悍刀行》烽火戏诸侯.txt'), body, 'utf8');
  writeFileSync(join(lib, '斗破苍穹-天蚕土豆.txt'), body, 'utf8');
  await scanRoot(db, { id: rootId, path: lib });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ids = () =>
  (db.prepare('select id from book order by id').all() as Array<{ id: number }>).map((r) => r.id);
const get = (id: number) =>
  db.prepare('select * from book where id = ?').get(id) as Record<string, unknown>;

test('只有白名单字段能改', () => {
  const id = ids()[0];
  updateBook(db, id, { title: '改过的书名', note: '我的备注' });
  assert.equal(get(id).title, '改过的书名');
  assert.equal(get(id).note, '我的备注');

  // 白名单外的字段一律抛错。**原来是「悄悄丢掉」**，只有一个能写的都没有时才报错——
  // 于是 `{ title: 'x', athor: 'y' }` 会默默只写 title 并返回成功，
  // 而调用方以为作者也改了（§13：外部调用方最容易错的就是参数名）
  assert.throws(() => updateBook(db, id, { id: 999 }), /不能改的字段/);
  assert.throws(
    () => updateBook(db, id, { title: '新名字', athor: '拼错的作者' }),
    /不能改的字段：athor/,
    '一个字段拼错就该整条拒掉，不能默默写一半',
  );
  assert.equal(get(id).title, '改过的书名', '被拒之后一个字段都不许落库');

  // 不存在的 id：改 0 行，返回 0（`batchUpdate` 的计数靠它，别退回「试了几次」）
  assert.equal(updateBook(db, 999999, { title: 'x' }), 0);
});

test('批量设连载状态', () => {
  const all = ids();
  assert.deepEqual(batchUpdate(db, all, { serial_status: 'finished' }), { updated: 2 });
  for (const id of all) assert.equal(get(id).serial_status, 'finished');
});

test('从文件名提取：先预览，不写库', () => {
  const id = ids()[0];
  updateBook(db, id, { title: '我手填的名字', author: null });

  const rows = previewExtract(db);
  const row = rows.find((r) => r.bookId === id)!;
  assert.equal(row.currentTitle, '我手填的名字');
  assert.equal(row.title, '雪中悍刀行', '预览里给出从文件名解析的结果');
  assert.equal(row.changed, true);
  assert.equal(get(id).title, '我手填的名字', '预览阶段库里一个字都不能变');

  // 另一本没被改过，提取结果和现状一致
  const same = rows.find((r) => r.bookId !== id)!;
  assert.equal(same.changed, false, '没变化的行要标出来，界面上默认不勾');
});

test('应用提取只改传进来的那几行', () => {
  const [a, b] = ids();
  updateBook(db, a, { title: 'A 原名' });
  updateBook(db, b, { title: 'B 原名' });

  const rows = previewExtract(db).filter((r) => r.bookId === a);
  applyExtract(db, rows.map((r) => ({ bookId: r.bookId, title: r.title, author: r.author })));

  assert.equal(get(a).title, '雪中悍刀行');
  assert.equal(get(b).title, 'B 原名', '没勾选的那本不能被动');
});

test('批量重新解析：一本坏了不影响另一本', async () => {
  const [a, b] = ids();
  // 把 a 的文件路径指向一个不存在的位置，模拟解析失败
  db.prepare("update book_file set path = ? where book_id = ?").run(join(lib, '不存在.txt'), a);

  const r = await reparseBooks(db, [a, b]);
  assert.equal(r.ok, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].bookId, a);
  assert.equal(
    (db.prepare('select status from book_file where book_id = ?').get(a) as { status: string }).status,
    'parse_failed',
    '失败的要标出来，界面上能一键跳过去处理',
  );
  assert.equal(
    (db.prepare('select status from book_file where book_id = ?').get(b) as { status: string }).status,
    'ok',
  );
});

test('手动指定编码后，重新解析不再拿探测结果盖掉它', async () => {
  const [a] = ids();
  // 这个文件本来是 utf-8，硬指定成 gb18030：内容会变成乱码，但编码字段必须听用户的
  await reparseBooks(db, [a], 'gb18030');
  assert.equal(
    (db.prepare('select encoding from book_file where book_id = ?').get(a) as { encoding: string })
      .encoding,
    'gb18030',
  );
});

test('自定义章节规则在重新解析时会被沿用', async () => {
  const [a] = ids();
  db.prepare(
    "insert into parse_rule(name, pattern, scope, book_id) values('自定义', '^第一章', 'book', ?)",
  ).run(a);

  await reparseBooks(db, [a]);
  assert.equal(
    (db.prepare('select chapter_count c from book_file where book_id = ?').get(a) as { c: number }).c,
    1,
    '只匹配「第一章」，应该只切出 1 章',
  );
});

/*
 * **`updated` 要数真的改了几本。**
 * 原来是 `rows.length`——传一个不存在的 bookId 进来（外部工具最容易错的就是 id），
 * 它照样把那一行算进去。同一个形状的第三处，前两处是 `tagged` 和 `createdTags`，
 * 共同点都是返回值没人读。
 */
test('applyExtract 的 updated 是真改了几本，不是传进来几行', () => {
  const id = Number(db.prepare("insert into book(title) values('原名')").run().lastInsertRowid);
  const r = applyExtract(db, [
    { bookId: id, title: '新名', author: '某人' },
    { bookId: 999999, title: '这本书不存在', author: null },
  ]);
  assert.equal(r.updated, 1, `传了两行，只有一行是真的：${r.updated}`);
  assert.equal(
    (db.prepare('select title from book where id = ?').get(id) as { title: string }).title, '新名',
  );
});

/*
 * **`batchUpdate.updated` 数的是「真的改了几行」，不是「试了几次」。**
 * 原来无条件 `updated++`，传一堆不存在的 id 进来照样报「改了 N 本」——
 * 和 `applyExtract` 那次一模一样（AGENTS.md：写完一句 SQL 就 `++` 的地方，
 * 数的都是「试了几次」，真相是 `changes`）。这个数是给外部工具看的（§13），
 * 而**没人读的数，错了也不会有人知道**。
 */
test('批量改元数据：数的是真的改了几本，不存在的 id 不算', () => {
  const good = ids().slice(0, 2);
  const r = batchUpdate(db, [...good, 999998, 999999], { source_site: 'https://example.com' });
  assert.equal(r.updated, good.length, `两本真的书 + 两个不存在的 id，只该数 ${good.length}`);
});

/*
 * **用户打的字：前后空白去掉，只剩空白的当作没填。** 量出来的三样后果：
 *
 * 1. **书名能被清空**——卡片上于是有一张没名字的书，认不出是哪本，
 *    而 `bookKey('')` 还会和别的空书名撞成同一本。书名是必填，所以抛错。
 * 2. **书名前面留一个空格，它就排到了每一份按书名排序的列表最前面**，
 *    而屏幕上完全看不出为什么。
 * 3. 作者只剩空格时不是 null，「有作者」的判断成立而显示出来是空的。
 */
test('书名不能被清空，前后空白一律去掉', () => {
  const id = ids()[0];
  assert.throws(() => updateBook(db, id, { title: '' }), /书名不能为空/);
  assert.throws(() => updateBook(db, id, { title: '   ' }), /书名不能为空/);

  updateBook(db, id, { title: '  带空格的书名  ', author: '  ', note: ' \n ' });
  const b = get(id) as { title: string; author: string | null; note: string | null };
  assert.equal(b.title, '带空格的书名', '前后空格要去掉，否则它会排到按书名排序的最前面');
  assert.equal(b.author, null, '只剩空格的作者当作没填');
  assert.equal(b.note, null);

  // 连载状态那一列是 not null：转成 null 会撞出一句 sqlite 原文，这里要说人话
  assert.throws(() => updateBook(db, id, { serial_status: '' }), /不认识的连载状态/);
  assert.throws(() => updateBook(db, id, { serial_status: '连载中' }), /不认识的连载状态/);
});

/*
 * **手填本地章数**（`book.chapter_count_override`）：自动识别的章数切错了，
 * 用户手填一个数盖过它。只收正整数；留空/null 回到自动；重新解析不碰这列。
 */
test('本地章数手填：正整数生效，0/负数/小数拒掉，null 回到自动', () => {
  const id = ids()[0];
  assert.equal(get(id).chapter_count_override, null, '新列默认 NULL = 用自动值');

  updateBook(db, id, { chapter_count_override: 1234 });
  assert.equal(get(id).chapter_count_override, 1234);

  // 数字字符串也认（rpc/界面可能传字符串过来）
  updateBook(db, id, { chapter_count_override: '800' });
  assert.equal(get(id).chapter_count_override, 800);

  // 胡说八道的值当场抛，别让 sqlite 亲和性悄悄存下半个数
  assert.throws(() => updateBook(db, id, { chapter_count_override: 0 }), /正整数/);
  assert.throws(() => updateBook(db, id, { chapter_count_override: -5 }), /正整数/);
  assert.throws(() => updateBook(db, id, { chapter_count_override: 1.5 }), /正整数/);
  assert.throws(() => updateBook(db, id, { chapter_count_override: 'abc' }), /正整数/);
  assert.equal(get(id).chapter_count_override, 800, '被拒之后旧值不许动');

  // 留空 = 回到自动识别
  updateBook(db, id, { chapter_count_override: null });
  assert.equal(get(id).chapter_count_override, null);
  updateBook(db, id, { chapter_count_override: 500 });
  updateBook(db, id, { chapter_count_override: '' });
  assert.equal(get(id).chapter_count_override, null, '空串也算清空');
});

test('本地章数手填后重新解析不碰它', async () => {
  const [a] = ids();
  updateBook(db, a, { chapter_count_override: 999 });
  await reparseBooks(db, [a]);
  assert.equal(
    get(a).chapter_count_override, 999,
    'override 是 book 表上独立的一列，重解析只刷新 book_file.chapter_count',
  );
  // bookDetail 两个数都要带得出来（界面要同时显示手填值和自动值）
  const d = bookDetail(db, a) as { chapter_count_override: number; chapter_count: number };
  assert.equal(d.chapter_count_override, 999);
  assert.equal(d.chapter_count, 3, '自动识别那本就是 3 章');
});

test('bookDetail 带出主在线地址：「来源站点」显示的就是它', () => {
  const [a, b] = ids();
  // 没地址：两个字段都是 null，界面显示「未记录」
  const empty = bookDetail(db, a) as { primary_url: string | null; primary_site: string | null };
  assert.equal(empty.primary_url, null);
  assert.equal(empty.primary_site, null);

  // 两条地址：主地址（is_primary）胜出，认得出的站给中文名而不是域名
  db.prepare("insert into online_link(book_id, url, site, is_primary) values(?,?,?,0)")
    .run(b, 'https://example.com/book/1', 'example.com');
  db.prepare("insert into online_link(book_id, url, site, is_primary) values(?,?,?,1)")
    .run(b, 'https://www.qidian.com/book/1049314010/', 'qidian.com');
  const withLink = bookDetail(db, b) as { primary_url: string | null; primary_site: string | null };
  assert.equal(withLink.primary_url, 'https://www.qidian.com/book/1049314010/');
  assert.equal(withLink.primary_site, '起点', '认得出适配器给中文名');

  // 主地址是陌生站：站名退回域名，不为 null
  db.prepare('update online_link set is_primary = 0 where book_id = ?').run(b);
  db.prepare("update online_link set is_primary = 1 where url = 'https://example.com/book/1'").run();
  const unknown = bookDetail(db, b) as { primary_site: string | null };
  assert.equal(unknown.primary_site, 'example.com');
});

