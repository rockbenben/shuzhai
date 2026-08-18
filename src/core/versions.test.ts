import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { listGroups, setPrimary, mergeBooks, exactDuplicates, bookKey } from './versions.ts';
import { tagBooks, listTags } from './library.ts';

let dir: string;
let db: DatabaseSync;

function addBook(title: string, author: string | null): number {
  const id = Number(
    db.prepare('insert into book(title, author) values(?,?)').run(title, author).lastInsertRowid,
  );
  db.prepare("insert into reading_state(book_id, status) values(?, 'want')").run(id);
  return id;
}

function addFile(
  bookId: number,
  path: string,
  o: { words?: number; chapters?: number; mtime?: number; hash?: string; primary?: boolean } = {},
): number {
  return Number(
    db
      .prepare(
        `insert into book_file(book_id, path, size, mtime, content_hash, word_count, chapter_count, is_primary)
         values(?,?,?,?,?,?,?,?)`,
      )
      .run(
        bookId,
        path,
        1000,
        o.mtime ?? 1,
        o.hash ?? null,
        o.words ?? 1000,
        o.chapters ?? 10,
        o.primary ? 1 : 0,
      ).lastInsertRowid,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-ver-'));
  db = openDb(join(dir, 'library.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('只有一个文件的书不进归组视图', () => {
  const id = addBook('独一份', '某人');
  addFile(id, 'C:\\a.txt', { primary: true });
  assert.equal(listGroups(db).length, 0, '每本单文件的书都列出来的话这个界面没法看');
});

test('同名同作者的多个文件归到一组，并标出字数最多和最新', () => {
  const a = addBook('斗破苍穹', '天蚕土豆');
  const b = addBook('斗破苍穹', '天蚕土豆');
  addFile(a, 'C:\\旧版.txt', { words: 100_000, mtime: 100, primary: true });
  addFile(b, 'C:\\新版.txt', { words: 500_000, mtime: 900, primary: true });

  const groups = listGroups(db);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].bookIds.sort(), [a, b].sort());

  const most = groups[0].versions.find((v) => v.mostWords)!;
  const newest = groups[0].versions.find((v) => v.newest)!;
  assert.match(most.path, /新版/);
  assert.match(newest.path, /新版/);
});

test('书名首尾空白和大小写不影响归组', () => {
  const a = addBook('斗破苍穹 ', '天蚕土豆');
  const b = addBook('斗破苍穹', '天蚕土豆 ');
  addFile(a, 'C:\\1.txt');
  addFile(b, 'C:\\2.txt');
  assert.equal(listGroups(db).length, 1);
});

test('内容完全相同的会被标出来', () => {
  const a = addBook('重复的书', '某人');
  const b = addBook('重复的书', '某人');
  addFile(a, 'C:\\一份.txt', { hash: 'same-hash' });
  addFile(b, 'C:\\另一份.txt', { hash: 'same-hash' });

  assert.ok(listGroups(db)[0].versions.every((v) => v.exactDuplicate));
  const dups = exactDuplicates(db);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].paths.length, 2);
});

test('设主版本不会动阅读进度', () => {
  const id = addBook('一本书', '某人');
  const f1 = addFile(id, 'C:\\v1.txt', { primary: true });
  const f2 = addFile(id, 'C:\\v2.txt');
  db.prepare('update reading_state set chapter_idx = 7, percent = 50 where book_id = ?').run(id);

  setPrimary(db, f2);

  // node:sqlite 返回 null 原型对象，deepEqual 会因此判不等，先摊平
  const primaries = (
    db.prepare('select id, is_primary from book_file where book_id = ? order by id').all(id) as Array<
      Record<string, unknown>
    >
  ).map((r) => ({ ...r }));
  assert.deepEqual(primaries, [
    { id: f1, is_primary: 0 },
    { id: f2, is_primary: 1 },
  ]);

  const s = db.prepare('select chapter_idx, percent from reading_state where book_id = ?').get(id) as {
    chapter_idx: number;
    percent: number;
  };
  assert.equal(s.chapter_idx, 7, '进度挂在 book 上，换文件不该丢');
  assert.equal(s.percent, 50);
});

test('合并时保留有进度的那一本', () => {
  const a = addBook('斗破苍穹', '天蚕土豆');
  const b = addBook('斗破苍穹', '天蚕土豆');
  addFile(a, 'C:\\a.txt', { primary: true });
  addFile(b, 'C:\\b.txt', { primary: true });
  // b 有进度，a 没有 —— 进度是不可再生的，必须保住 b
  db.prepare('update reading_state set chapter_idx = 12, percent = 60 where book_id = ?').run(b);

  const { keptBookId } = mergeBooks(db, [a, b]);
  assert.equal(keptBookId, b);

  assert.equal((db.prepare('select count(*) n from book').get() as { n: number }).n, 1);
  assert.equal(
    (db.prepare('select count(*) n from book_file where book_id = ?').get(b) as { n: number }).n,
    2,
    '两个文件都要挂到保留的那本下面',
  );
  const s = db.prepare('select chapter_idx from reading_state where book_id = ?').get(b) as {
    chapter_idx: number;
  };
  assert.equal(s.chapter_idx, 12);
});

/*
 * **PDF / EPUB 读到哪儿也得跟着合并走。**
 *
 * 它不是一张表——存在 `app_setting` 的 `viewer.<bookId>` 里，所以这个文件那条
 * 「每张 references book(id) 的表都要表个态」的守卫**按定义看不见它**。
 * 不管的话：败方读到第几页没了（重扫恢复不了），还留下一行指向已删除书的孤儿设置。
 *
 * 两种情形分别钉住，判据抄 `mergeBooks` 自己那条「keeper 自己有的不动，缺的才补」。
 */
/*
 * **按 id 命名的设置现在有两种**，第二种是自建目录（迁移 24）。
 * `MOVED_TABLES` 那条守卫按定义就看不见它们（那条查的是表），
 * 所以两种各钉一条——只钉头一种的话，第二种加进来时漏了也不会红。
 */
test('合并：自建目录也要跟过去', () => {
  const a = addBook('自建目录的 PDF', '某人');
  const b = addBook('自建目录的 PDF', '某人');
  addFile(a, 'C:/oa.pdf', { primary: true });
  addFile(b, 'C:/ob.pdf', { primary: true });
  db.prepare('update reading_state set chapter_idx = 3 where book_id = ?').run(b); // 让 b 当 keeper
  const 目录 = JSON.stringify([{ page: 7, title: '第七页' }]);
  db.prepare('insert into app_setting(key, value) values(?, ?)').run(`outline.${a}`, 目录);

  const { keptBookId } = mergeBooks(db, [a, b]);
  assert.equal(keptBookId, b);
  assert.equal(
    (db.prepare('select value from app_setting where key = ?').get(`outline.${b}`) as { value: string } | undefined)?.value,
    目录,
    '败方自己加的目录要搬到 keeper 上——那是重扫恢复不了的',
  );
  assert.equal(
    (db.prepare('select count(*) n from app_setting where key = ?').get(`outline.${a}`) as { n: number }).n,
    0,
    '别留下一行指向已经删掉的那本书',
  );
});

test('合并：PDF / EPUB 读到哪儿要跟过去，keeper 已经有的不许被盖', () => {
  // ① keeper 没有、败方有 —— 搬过去
  {
    const a = addBook('某本 PDF', '某人');
    const b = addBook('某本 PDF', '某人');
    addFile(a, 'C:\a.pdf', { primary: true });
    addFile(b, 'C:\b.pdf', { primary: true });
    db.prepare('update reading_state set chapter_idx = 3 where book_id = ?').run(b); // 让 b 当 keeper
    db.prepare('insert into app_setting(key, value) values(?, ?)').run(`viewer.${a}`, '100');

    const { keptBookId } = mergeBooks(db, [a, b]);
    assert.equal(keptBookId, b);
    assert.equal(
      (db.prepare('select value from app_setting where key = ?').get(`viewer.${b}`) as { value: string } | undefined)?.value,
      '100',
      '败方读到第几页要搬到 keeper 上——那是重扫恢复不了的',
    );
    assert.equal(
      (db.prepare('select count(*) n from app_setting where key = ?').get(`viewer.${a}`) as { n: number }).n,
      0,
      '别留下一行指向已经删掉的那本书',
    );
  }
  // ② 两边都有 —— keeper 的不许被盖，败方那行清掉
  {
    const c = addBook('另一本 PDF', '某人');
    const d = addBook('另一本 PDF', '某人');
    addFile(c, 'C:\c.pdf', { primary: true });
    addFile(d, 'C:\d.pdf', { primary: true });
    db.prepare('update reading_state set chapter_idx = 3 where book_id = ?').run(d);
    db.prepare('insert into app_setting(key, value) values(?, ?)').run(`viewer.${c}`, '11');
    db.prepare('insert into app_setting(key, value) values(?, ?)').run(`viewer.${d}`, '22');

    const { keptBookId } = mergeBooks(db, [c, d]);
    assert.equal(keptBookId, d);
    assert.equal(
      (db.prepare('select value from app_setting where key = ?').get(`viewer.${d}`) as { value: string }).value,
      '22',
      'keeper 自己有的不动',
    );
    assert.equal(
      (db.prepare('select count(*) n from app_setting where key = ?').get(`viewer.${c}`) as { n: number }).n,
      0,
      '败方那行是死的，清掉',
    );
  }
});

test('合并后必须仍有且只有一个主版本', () => {
  const a = addBook('同名书', null);
  const b = addBook('同名书', null);
  addFile(a, 'C:\\a.txt', { primary: true, words: 100 });
  addFile(b, 'C:\\b.txt', { primary: true, words: 999 });

  const { keptBookId } = mergeBooks(db, [a, b]);
  const n = (
    db.prepare('select count(*) n from book_file where book_id = ? and is_primary = 1').get(keptBookId) as {
      n: number;
    }
  ).n;
  assert.equal(n, 1);
});

test('合并会把标签并过来', () => {
  const a = addBook('同名书', null);
  const b = addBook('同名书', null);
  addFile(a, 'C:\\a.txt');
  addFile(b, 'C:\\b.txt');
  tagBooks(db, [a], ['玄幻']);
  tagBooks(db, [b], ['已完结']);

  const { keptBookId } = mergeBooks(db, [a, b]);
  const tags = listTags(db).filter((t) => t.count > 0).map((t) => t.name).sort();
  assert.deepEqual(tags, ['已完结', '玄幻']);
  assert.equal(
    (db.prepare('select count(*) n from book_tag where book_id = ?').get(keptBookId) as { n: number }).n,
    2,
  );
});

/*
 * **合并不能把书评吃掉。**
 *
 * keeper 是按**阅读进度**挑的，跟「哪本写过书评」无关。真实场景：
 * 《诛仙》在库里有校对版和精校版两个文件，你在其中一本上读到 500 章、
 * 在另一本上打了分写了「结局烂尾了别看」——合并之后 keeper 是有进度的那本，
 * 另一本连同 `reading_state` 一起被 `on delete cascade` 删掉，那句话就没了。
 *
 * 标签早就并过来了（下面那条测试守着），评分和短评却没有——同一次合并里
 * 两种用户数据两套待遇。而书评和进度一样**重扫恢复不了**，
 * 这个应用的正事（「下次不用再想这本我看过没」）全靠它。
 */
test('合并不能把评分和短评吃掉', () => {
  const a = addBook('诛仙', '萧鼎');
  const b = addBook('诛仙', '萧鼎');
  addFile(a, 'C:\jiaodui.txt', { primary: true });
  addFile(b, 'C:\jingjiao.txt', { primary: true });
  // b 有进度所以会当 keeper；书评写在 a 上
  db.prepare('update reading_state set chapter_idx = 500, percent = 80 where book_id = ?').run(b);
  db.prepare("update reading_state set rating = 5, comment = '结局烂尾了别看', rated_at = '2026-01-01' where book_id = ?").run(a);

  const { keptBookId } = mergeBooks(db, [a, b]);
  assert.equal(keptBookId, b, '有进度的那本仍然是 keeper');

  const r = db.prepare('select rating, comment, rated_at from reading_state where book_id = ?').get(b) as
    { rating: number | null; comment: string | null; rated_at: string | null };
  assert.equal(r.rating, 5, '评分要跟过来');
  assert.equal(r.comment, '结局烂尾了别看', '短评要跟过来');
  assert.ok(r.rated_at, 'rated_at 也要跟过来，否则「我的书评」排序里它就消失了');
});

test('两本都写过短评时，一句都不许丢', () => {
  const a = addBook('同名书', null);
  const b = addBook('同名书', null);
  addFile(a, 'C:\a.txt', { primary: true });
  addFile(b, 'C:\b.txt', { primary: true });
  db.prepare('update reading_state set percent = 50 where book_id = ?').run(b);
  db.prepare("update reading_state set rating = 4, comment = '前半好看' where book_id = ?").run(a);
  db.prepare("update reading_state set rating = 2, comment = '后半崩了' where book_id = ?").run(b);

  const { keptBookId } = mergeBooks(db, [a, b]);
  const r = db.prepare('select rating, comment from reading_state where book_id = ?').get(keptBookId) as
    { rating: number; comment: string };
  assert.equal(r.rating, 2, 'keeper 自己有评分就用它的，不许被覆盖');
  assert.match(r.comment, /后半崩了/);
  assert.match(r.comment, /前半好看/, '另一本那句话也得留着——用户写的字不能悄悄没了');
});

test('合并少于两本要报错', () => {
  const a = addBook('书', null);
  assert.throws(() => mergeBooks(db, [a]), /至少要两本/);
});

test('这个模块不碰磁盘：合并和设主版本都只改数据库', () => {
  // 反向确认——模块里没有任何 fs 调用。这条测试守着 spec §8「不自动删除或移动任何文件」
  const src = readFileSync(new URL('./versions.ts', import.meta.url), 'utf8');
  assert.ok(!/from 'node:fs/.test(src), 'versions.ts 不该 import fs');
  assert.ok(!/unlink|rename\(|rmSync|copyFile/.test(src), '不该出现任何改动文件的调用');
});

test('bookKey 的分隔符不能是空格——否则书名和作者会串味', () => {
  // 「三体 刘」+「慈欣」和「三体」+「刘 慈欣」是两本不同的书，
  // 拿空格拼 key 的话它们会撞成同一个，于是「重复的书」把两本无关的书归成一组，
  // 而删除那条路是**按组**走的——归错组就等于把删除按钮指向了错的文件。
  //
  // 所以用一个正文里不可能出现的字符当分隔符。这条断言在这儿是因为
  // **把分隔符换成空格，全套测试里除了它一条都不会红**（实测过），
  // 也就是说这个不变式此前完全没人守。
  // （条数以当场跑出来的为准，别在这儿记一个会过期的数——AGENTS.md 那条规矩。）
  assert.notEqual(bookKey('三体 刘', '慈欣'), bookKey('三体', '刘 慈欣'));

  // 顺带钉住归一化：去首尾空白 + 转小写，两边都做
  assert.equal(bookKey('  三体 ', '刘慈欣'), bookKey('三体', '  刘慈欣  '));
  assert.equal(bookKey('Dune', 'Herbert'), bookKey('dune', 'herbert'));

  // 作者为空和作者是空串必须同解——manual.ts 的认领逻辑依赖这一点
  assert.equal(bookKey('三体', null), bookKey('三体', ''));
});

/*
 * 合并的败方是被 `delete from book` 删掉的，而挂在 `book` 上的表全是
 * `on delete cascade`——书签和划线原来就这么**一声不吭地**跟着没了。
 * 铁律 3 明写着这两样重扫恢复不了，而同一次合并里标签和书评都是搬过来的：
 * **同一次合并里两种用户数据两套待遇**，`mergeBooks` 自己的注释就在讲这句话。
 */
test('合并时书签、划线、阅读会话跟着搬到留下的那本上', () => {
  const keep = addBook('诛仙', '萧鼎'); // 有进度，会被选成 keeper
  const gone = addBook('诛仙', '萧鼎');
  addFile(keep, join(dir, 'zx-a.txt'), { primary: true });
  addFile(gone, join(dir, 'zx-b.txt'), { primary: true });
  db.prepare('update reading_state set chapter_idx = 500, percent = 80 where book_id = ?').run(keep);

  db.prepare("insert into bookmark(book_id, chapter_idx, char_offset, excerpt) values(?, 12, 340, '田不易皱了皱眉')").run(gone);
  db.prepare(
    "insert into highlight(book_id, chapter_idx, char_offset, length, excerpt, note) values(?, 12, 340, 7, '田不易皱了皱眉', '这段写得好')",
  ).run(gone);
  db.prepare("insert into reading_session(book_id, started_at, ended_at) values(?, '2026-08-01T10:00:00Z', '2026-08-01T11:00:00Z')").run(gone);

  const { keptBookId } = mergeBooks(db, [keep, gone]);
  assert.equal(keptBookId, keep);

  const bm = db.prepare('select * from bookmark where book_id = ?').all(keep) as unknown as Array<{ excerpt: string }>;
  assert.equal(bm.length, 1, '书签被 cascade 吃掉了');
  assert.equal(bm[0].excerpt, '田不易皱了皱眉');

  const hl = db.prepare('select * from highlight where book_id = ?').all(keep) as unknown as Array<{ note: string }>;
  assert.equal(hl.length, 1, '划线被 cascade 吃掉了');
  assert.equal(hl[0].note, '这段写得好', '划线上的笔记是用户自己写的字，重扫恢复不了');

  const ses = db.prepare('select count(*) n from reading_session where book_id = ?').get(keep) as { n: number };
  assert.equal(ses.n, 1, '阅读会话被 cascade 吃掉了');
});

/*
 * keeper 是按**阅读进度**挑的，跟「哪本填过封面简介」没关系。
 * 真实库里 774 本有封面，抓一本要 6 秒——keeper 空着而败方有的话，
 * 那张图跟着一起没了，而重抓要排到几千本之后。
 */
test('留下的那本缺的字段从别人那儿补，自己有的不动', () => {
  const keep = addBook('斗破苍穹', '天蚕土豆');
  const gone = addBook('斗破苍穹', '天蚕土豆');
  addFile(keep, join(dir, 'dp-a.txt'), { primary: true });
  addFile(gone, join(dir, 'dp-b.txt'), { primary: true });
  db.prepare('update reading_state set chapter_idx = 30 where book_id = ?').run(keep);
  db.prepare("update book set note = '我自己的备注' where id = ?").run(keep);
  db.prepare("update book set cover_path = 'covers/abc.jpg', intro = '三十年河东', note = '别人的备注' where id = ?").run(gone);

  mergeBooks(db, [keep, gone]);

  const b = db.prepare('select cover_path as coverPath, intro, note from book where id = ?').get(keep) as unknown as {
    coverPath: string | null; intro: string | null; note: string | null;
  };
  assert.equal(b.coverPath, 'covers/abc.jpg', '封面没补过来');
  assert.equal(b.intro, '三十年河东', '简介没补过来');
  assert.equal(b.note, '我自己的备注', 'keeper 自己写的备注被覆盖了');
});

/*
 * **加一张挂在 `book` 上的表，就得在 `mergeBooks` 里表个态**——搬过去，
 * 或者写明为什么可以跟着败方一起没。不表态的后果不是少一个功能，
 * 是那张表的数据在合并时静默消失（书签和划线就是这么丢的）。
 * 同 `backup.test.ts` 那条「每张表都得在 backup.ts 里出现过」。
 */
/*
 * **上面那条守卫有个按定义存在的盲区：不是表的、按 book id 命名的东西。**
 *
 * `app_setting` 里 `viewer.<bookId>` 存的是 PDF / EPUB 读到第几页——它挂在书上，
 * 却不是一张 `references book(id)` 的表，所以上面那条永远看不见它。
 * 结果是同一样东西在**四处**一起被漏掉（都是当场量出来的）：
 *   `backup.ts` 不备份、`deletion.ts` 当它「什么都没有」、
 *   `library.ts` 的孤儿判据把它清掉、`versions.ts` 合并时丢掉。
 *
 * 这条守卫盯的就是这个盲区：**一种按 book id 命名的设置，四处都得提到它**。
 * 判据和上面那条一样粗、一样硬——逼的是「想一下」，不是「必须搬」。
 * 以后再加一种（比如按书存的字号），把前缀加进下面这张表。
 */
test('按 book id 命名的设置，四处管书的地方都得表个态', () => {
  /** 前缀 → 它是什么。加一种就往这儿加一行 */
  const 按书存的设置 = [['viewer.', 'PDF / EPUB 读到第几页']];
  const 四处 = ['backup.ts', 'deletion.ts', 'library.ts', 'versions.ts'];

  for (const [前缀, 是什么] of 按书存的设置) {
    for (const f of 四处) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      assert.ok(
        src.includes(前缀),
        `${f} 里一个字都没提 ${前缀}（${是什么}）——它挂在书上，`
          + '但不是一张表，「每张表都要表个态」那条守卫看不见它',
      );
    }
  }

  // 自检：判据本身还认得出「没提到」——喂一个谁都不会提的前缀
  const 假的 = 'zzz-这个前缀谁都不会提.';
  const 有人提了 = 四处.some((f) =>
    readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').includes(假的));
  assert.equal(有人提了, false, '自检：诱饵不该被任何一处提到，否则这条判据是空转的');
});

test('挂在 book 上的每一张表，名字都得在 versions.ts 里出现过', () => {
  const schema = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  const src = readFileSync(new URL('./versions.ts', import.meta.url), 'utf8');

  const tables: string[] = [];
  let cur = '';
  for (const line of schema.split('\n')) {
    const m = /create table (?:if not exists )?(\w+)\s*\(/.exec(line);
    if (m) cur = m[1];
    if (/references book\(id\)/.test(line) && cur && !tables.includes(cur)) tables.push(cur);
  }
  assert.ok(tables.length >= 8, `只解析出 ${tables.length} 张挂在 book 上的表——这条判据多半已经失效了`);

  const missing = tables.filter((t) => !src.includes(t));
  assert.deepEqual(missing, [], `这些表挂在 book 上，合并时会被 cascade 删掉，而 versions.ts 里一个字都没提：${missing.join(' ')}`);
});

test('合并 txt + epub：主文件必须落在能读的那一份上', () => {
  // 顺序照真实扫描：目录里 .epub 排在 .txt 前面，于是它 id 更小、也就是 keeper
  const a = addBook('三体', '刘慈欣');
  addFile(a, 'C:\books\三体 刘慈欣.epub', { primary: true, words: 0, chapters: 0 });
  const b = addBook('三体', '刘慈欣');
  addFile(b, 'C:\books\三体 刘慈欣.txt', { primary: true, words: 7210, chapters: 2 });

  const { keptBookId } = mergeBooks(db, [a, b]);
  const 主 = db
    .prepare('select path, chapter_count as ch from book_file where book_id = ? and is_primary = 1')
    .get(keptBookId) as { path: string; ch: number };

  /*
   * 两本都没有阅读进度 → keeper 取 id 最小的那本（EPUB 那本），
   * 而败方的文件一律带着 is_primary = 0 搬进来。**keeper 自己那面旗
   * 原来从没被重问过**，于是主文件是一个 chapter_count = 0 的 EPUB——
   * 这本书点开进的是查看器，章节 / 书内搜索 / 朗读 / 划线一样都用不了，
   * 而那份带 2 章的 txt 就在旁边躺着。
   */
  assert.ok(主.path.endsWith('.txt'), `主文件该是 txt，实际是 ${主.path}`);
  assert.equal(主.ch, 2);
  // 换旗要先清干净：两行同时挂着 is_primary = 1 的话，`book.list` 取哪份看运气
  assert.equal(
    (db.prepare('select count(*) as n from book_file where book_id = ? and is_primary = 1')
      .get(keptBookId) as { n: number }).n,
    1,
  );
});

test('只编目的那一份坏不掉用户的选择：没有能读的 txt 时不动', () => {
  const a = addBook('画册', '某人');
  addFile(a, 'C:\books\画册.pdf', { primary: true, words: 0, chapters: 0 });
  const b = addBook('画册', '某人');
  // 另一份也是只编目的 → 没得换，主文件不许被改成别的
  addFile(b, 'C:\books\画册.epub', { primary: true, words: 0, chapters: 0 });

  const { keptBookId } = mergeBooks(db, [a, b]);
  const 主 = db
    .prepare('select path from book_file where book_id = ? and is_primary = 1')
    .get(keptBookId) as { path: string };
  assert.ok(主.path.endsWith('.pdf'), '没有能读的那一档时，主文件应当留在 keeper 原来那份上');
});

