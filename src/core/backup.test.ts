import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { scanRoot } from './scan.ts';
import { exportBackup, importBackup, linkManually, BACKUP_VERSION } from './backup.ts';
import { setStatus, addBookmark, listBookmarks } from './status.ts';
import { tagBooks } from './library.ts';
import { addManualBook } from './manual.ts';
import { addHighlight, tagHighlights, tagsOfHighlights } from './highlight.ts';

let dir: string;
let lib: string;
let db: DatabaseSync;
let rootId: number;

const filler = Array.from({ length: 500 }, () => '寻常的一行正文。').join('\n');
const body = ['第一章 起', '第二章 承'].map((t) => `${t}\n${filler}\n`).join('');

/**
 * 造一个装好数据的库：两本书，其中一本有进度、评分、书签、标签。
 * **两本内容必须不同**——一度两本都写同一段正文，于是 hash 相同，
 * 恢复时两本书双双认到同一本，后写的把先写的进度覆盖掉。
 */
async function seed(): Promise<number> {
  writeFileSync(join(lib, '《雪中悍刀行》烽火戏诸侯.txt'), body, 'utf8');
  writeFileSync(join(lib, '斗破苍穹-天蚕土豆.txt'), `${body}\n另一本书的独有内容。\n`, 'utf8');
  await scanRoot(db, { id: rootId, path: lib });

  const id = (db.prepare("select id from book where title='雪中悍刀行'").get() as { id: number }).id;
  setStatus(db, id, { status: 'reading', rating: 4.5, comment: '前期神作' });
  db.prepare('update reading_state set chapter_idx = 1, char_offset = 88 where book_id = ?').run(id);
  addBookmark(db, id, 1, { charOffset: 50, note: '这段好' });
  tagBooks(db, [id], ['玄幻', '长篇']);
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-bk-'));
  db = openDb(join(dir, 'library.db'));
  lib = join(dir, 'books');
  mkdirSync(lib);
  rootId = Number(db.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('备份带上全部不可再生的数据', async () => {
  const id = await seed();
  const bk = exportBackup(db);

  assert.equal(bk.version, BACKUP_VERSION);
  assert.equal(bk.books.length, 2);

  const b = bk.books.find((x) => x.title === '雪中悍刀行')!;
  assert.equal(b.reading?.status, 'reading');
  assert.equal(b.reading?.chapterIdx, 1);
  assert.equal(b.reading?.charOffset, 88);
  assert.equal(b.reading?.rating, 4.5);
  assert.equal(b.reading?.comment, '前期神作');
  assert.equal(b.bookmarks.length, 1);
  assert.deepEqual(b.tags.sort(), ['玄幻', '长篇']);
  assert.ok(b.files[0].contentHash, '要带 hash，恢复时靠它认回文件');
  assert.equal(typeof id, 'number');
});

/*
 * **「什么时候评的」也是不可再生的。**
 *
 * `rated_at` 原来不在备份里：恢复之后评分和短评都在，但时间戳全是 null。
 * 后果不是少一个字段——「我的书评」那一档正是按 `rated_at desc` 排的
 * （`ORDER.rated`，null 排最后），于是**恢复完所有书评都挤在最后、没有先后**，
 * 而「我最近评过什么」是这一档存在的理由。
 *
 * 这个日期谁也补不回来：重扫恢复不了，看文件时间也看不出来。
 * 同本文件在 `mergeBooks` 上刚记过的那条——有评价内容就得有时间戳。
 */
test('评价时间也要备份，否则「我的书评」的顺序恢复不回来', async () => {
  await seed();
  const bk = exportBackup(db);
  const b = bk.books.find((x) => x.title === '雪中悍刀行')!;
  assert.ok(b.reading?.ratedAt, '打过分的书必须带上评价时间');

  // 恢复到一个空库：时间戳要原样回来，不是变成 null，也不是变成「现在」
  const before = b.reading!.ratedAt;
  db.prepare('update reading_state set rating = null, comment = null, rated_at = null').run();
  await importBackup(db, bk);
  const row = db
    .prepare('select rating, rated_at from reading_state where book_id = (select id from book where title = ?)')
    .get('雪中悍刀行') as { rating: number | null; rated_at: string | null };
  assert.equal(row.rating, 4.5);
  assert.equal(row.rated_at, before, '评价时间要原样回来');
});

/*
 * **划线和笔记也是不可再生的。**
 *
 * 这个模块顶上自己写着「阅读进度、书签、评分短评、弃坑原因、重命名日志——
 * 重新扫描一样都恢复不了……宁可备份里多带点东西，也不能少带」。
 * 而 `highlight` 整张表不在备份里：`note` 是用户在某一段上写下的话，
 * `excerpt` 是他划中的那句正文，重扫一个都补不回来。
 * 那句列表是后来才有 highlight 表的时候没跟着更新的。
 */
test('划线和上面的笔记也要备份，恢复完还在原处', async () => {
  const id = await seed();
  addHighlight(db, { bookId: id, chapterIdx: 3, charOffset: 120, length: 18, excerpt: '他看了一眼远处的雪', note: '这段写得真好', color: 'yellow' });

  const bk = exportBackup(db);
  const b = bk.books.find((x) => x.title === '雪中悍刀行')!;
  assert.equal(b.highlights?.length, 1, `备份里没带划线：${JSON.stringify(Object.keys(b))}`);
  assert.equal(b.highlights[0].note, '这段写得真好');
  assert.equal(b.highlights[0].excerpt, '他看了一眼远处的雪');

  // 清掉再恢复：位置和笔记都要回来
  db.prepare('delete from highlight').run();
  await importBackup(db, bk);
  const rows = db.prepare('select chapter_idx, char_offset, length, excerpt, note from highlight').all() as
    Array<{ chapter_idx: number; char_offset: number; length: number; excerpt: string; note: string }>;
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, {
    chapter_idx: 3, char_offset: 120, length: 18, excerpt: '他看了一眼远处的雪', note: '这段写得真好',
  });

  // 导两次不该翻倍——和书签同一条规矩
  await importBackup(db, bk);
  assert.equal((db.prepare('select count(*) n from highlight').get() as { n: number }).n, 1);
});

/*
 * **阅读会话也是历史，也不可再生。**
 *
 * `reading_session` 记的是「我什么时候读的这本、从百分之几读到百分之几」，
 * `reading.last` / `reading.recent` 靠它。重扫恢复不了，而它**完全可移植**
 * （只有 book_id 和时间，没有文件 id、没有绝对路径）——
 * 这一点正是它和 `rename_log` 的分界：后者带着 file_id 和绝对路径，
 * 换台机器就没意义，所以那个不带。
 */
test('阅读会话也要备份，导两次不翻倍', async () => {
  const id = await seed();
  db.prepare("insert into reading_session(book_id, started_at, ended_at, from_percent, to_percent) values(?,?,?,?,?)")
    .run(id, '2026-01-01T10:00:00Z', '2026-01-01T11:30:00Z', 10, 42);

  const bk = exportBackup(db);
  const b = bk.books.find((x) => x.title === '雪中悍刀行')!;
  assert.equal(b.sessions?.length, 1, `备份里没带阅读会话：${JSON.stringify(Object.keys(b))}`);
  assert.equal(b.sessions[0].fromPercent, 10);

  db.prepare('delete from reading_session').run();
  await importBackup(db, bk);
  const rows = db.prepare('select started_at, from_percent, to_percent from reading_session').all() as
    Array<{ started_at: string; from_percent: number; to_percent: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].started_at, '2026-01-01T10:00:00Z');
  assert.equal(rows[0].to_percent, 42);

  await importBackup(db, bk);
  assert.equal((db.prepare('select count(*) n from reading_session').get() as { n: number }).n, 1, '导两次不该翻倍');
});

test('备份不带可再生的东西', async () => {
  await seed();
  const json = JSON.stringify(exportBackup(db));
  assert.ok(!json.includes('chapter_fts'), '全文索引重建就有');
  // 章节索引重新解析就有，不该出现在备份里
  const bk = exportBackup(db);
  assert.ok(!('chapters' in bk.books[0]), '章节索引不进备份');
});

test('恢复：文件改名了也能靠 hash 认回来，进度不丢', async () => {
  const id = await seed();
  const bk = exportBackup(db);

  // 模拟「换了台机器 / 整理过文件夹」：进度清掉、文件改名、重扫
  db.prepare('update reading_state set status = ?, chapter_idx = 0, char_offset = 0 where book_id = ?')
    .run('want', id);
  db.prepare('delete from bookmark').run();
  renameSync(join(lib, '《雪中悍刀行》烽火戏诸侯.txt'), join(lib, '完全不同的名字.txt'));
  await scanRoot(db, { id: rootId, path: lib });

  const report = importBackup(db, bk);
  assert.equal(report.matched, 2);
  assert.equal(report.unmatched.length, 0);

  const s = db.prepare('select * from reading_state where book_id = ?').get(id) as Record<string, unknown>;
  assert.equal(s.status, 'reading');
  assert.equal(s.chapter_idx, 1);
  assert.equal(s.char_offset, 88);
  assert.equal(s.rating, 4.5);
  assert.equal(listBookmarks(db, id).length, 1, '书签也要回来');
});

test('PDF / EPUB 读到哪儿也要备份，而且要跟着新的 book id 走', async () => {
  const id = await seed();
  db.prepare('insert into app_setting(key, value) values(?, ?)').run(`viewer.${id}`, '7');
  const bk = exportBackup(db);

  const 那本 = bk.books.find((b) => b.title === '雪中悍刀行');
  assert.equal(那本?.viewerPos, '7', '备份里要带上它——这是不可再生的阅读进度，和 txt 的 chapter_idx 同一类');

  /*
   * 换一个库恢复，**而且让那本书拿到不一样的 id**：先塞一本占位的书把自增顶掉。
   * 这一条才是这个测试的要害——库里的键是 `viewer.<bookId>`，
   * 照搬旧 id 会把进度写到别的书上（或者写到一个不存在的书上）。
   */
  const fresh = openDb(join(dir, 'fresh2.db'));
  try {
    fresh.prepare("insert into book(title, author) values('占位用的', '某某')").run();
    fresh.prepare("insert into book(title, author) values('也是占位', '某某')").run();
    const r2 = Number(fresh.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid);
    await scanRoot(fresh, { id: r2, path: lib });
    importBackup(fresh, bk);

    const 新 = (fresh.prepare("select id from book where title='雪中悍刀行'").get() as { id: number }).id;
    assert.notEqual(新, id, '夹具没造出差值——id 一样的话这条测试什么都没验');
    assert.equal(
      (fresh.prepare('select value from app_setting where key = ?').get(`viewer.${新}`) as { value: string } | undefined)?.value,
      '7',
      '进度要落在恢复之后那本书的 id 上',
    );
    assert.equal(
      (fresh.prepare('select count(*) n from app_setting where key = ?').get(`viewer.${id}`) as { n: number }).n,
      0,
      '别按备份里那个旧 id 写——那个 id 在新库里是别的书',
    );
  } finally {
    fresh.close();
  }
});

test('认不回来的书列出来，不凭空建幽灵条目', async () => {
  await seed();
  const bk = exportBackup(db);

  // 全新的空库：一本都关联不上
  const fresh = openDb(join(dir, 'fresh.db'));
  try {
    const report = importBackup(fresh, bk);
    assert.equal(report.matched, 0);
    assert.equal(report.unmatched.length, 2);
    assert.equal(
      (fresh.prepare('select count(*) n from book').get() as { n: number }).n,
      0,
      '关联不上就不该建书——否则用户得到一堆点开就报「文件缺失」的条目',
    );
    assert.ok(report.unmatched[0].paths.length > 0, '要把原路径列出来，用户才认得出是哪本');
  } finally {
    fresh.close();
  }
});

test('两本内容完全相同的书，各自的进度不会串到一起', async () => {
  // spec §8 的「完全重复」：同样的内容存了两份，hash 一样。
  // 只按 hash 认的话，备份里两本书会双双认到同一本，后写的覆盖先写的
  writeFileSync(join(lib, 'A.txt'), body, 'utf8');
  writeFileSync(join(lib, 'B.txt'), body, 'utf8');
  await scanRoot(db, { id: rootId, path: lib });

  const a = (db.prepare("select id from book where title='A'").get() as { id: number }).id;
  const b = (db.prepare("select id from book where title='B'").get() as { id: number }).id;
  db.prepare('update reading_state set chapter_idx = 1 where book_id = ?').run(a);
  db.prepare('update reading_state set chapter_idx = 0 where book_id = ?').run(b);

  const bk = exportBackup(db);
  db.prepare('update reading_state set chapter_idx = 0').run();
  const report = importBackup(db, bk);

  assert.equal(report.unmatched.length, 0, '两本都该认回来，不能挤在同一本上');
  const idxOf = (id: number) =>
    (db.prepare('select chapter_idx from reading_state where book_id = ?').get(id) as {
      chapter_idx: number;
    }).chapter_idx;
  assert.equal(idxOf(a), 1);
  assert.equal(idxOf(b), 0);
});

test('导入两次不会让书签翻倍', async () => {
  const id = await seed();
  const bk = exportBackup(db);
  importBackup(db, bk);
  importBackup(db, bk);
  assert.equal(listBookmarks(db, id).length, 1);
});

test('比程序还新的备份要拒绝，而不是导进来一半', async () => {
  await seed();
  const bk = exportBackup(db);
  bk.version = BACKUP_VERSION + 1;
  assert.throws(() => importBackup(db, bk), /比当前程序还新/);
});

test('格式不对要报错', () => {
  assert.throws(
    () => importBackup(db, { version: 1, createdAt: '', books: null as never, cleanRules: [], categories: [], shelves: [], settings: {} }),
    /格式不对/,
  );
});

test('手动指认只搬进度和书签，不覆盖本地元数据', async () => {
  const id = await seed();
  const bk = exportBackup(db);
  const b = bk.books.find((x) => x.title === '雪中悍刀行')!;

  // 另一本书，本地已经改过书名
  const other = (db.prepare("select id from book where title='斗破苍穹'").get() as { id: number }).id;
  db.prepare("update book set title = '我本地改过的名字' where id = ?").run(other);

  linkManually(db, b, other);

  const s = db.prepare('select chapter_idx, rating from reading_state where book_id = ?').get(other) as {
    chapter_idx: number;
    rating: number;
  };
  assert.equal(s.chapter_idx, 1, '进度搬过来了');
  assert.equal(s.rating, 4.5);
  assert.equal(
    (db.prepare('select title from book where id = ?').get(other) as { title: string }).title,
    '我本地改过的名字',
    '本地元数据不该被备份覆盖',
  );
  assert.notEqual(id, other);
});

test('用户自己打的那几样设置：换台机器要回得来', async () => {
  // **判据不是「带了几个键」，是「这一条是不是用户自己打的字」。**
  // 朗读引擎最要紧：那 88 条原来硬编码在仓库里（相当于有第二份），
  // 搬进用户自己的库之后这个库就是独一份了
  await seed();
  const 用户打的: Record<string, string> = {
    'scan.ignore': '["备份/**","临时/**"]',
    'library.serialRules': '{"rules":[{"dir":"连载中","status":"ongoing"}]}',
    'cover.customSources': '[{"id":"s1","name":"某站","search":"https://x.test/?q={title}"}]',
    'tts.userEngines': '[{"id":"user-甲","name":"甲","url":"https://x.test/?t={text}","double":false,"contentType":"audio/mpeg"}]',
    'theme.imported': '[{"id":"imported-我的纸","name":"我的纸","night":false,"bg":"#f5efe3","fg":"#1f1f1f","accent":"#8a6d3b","panel":"#fffaf0","line":"#e0d8c8","muted":"#7a7269"}]',
    // 颜色代表什么。**划线在铁律 3 的不可再生名单里**，
    // 划线恢复回来了、代表什么却丢了，等于只恢复了一半
    'highlight.colorNames': '{"yellow":"好句","blue":"待查"}',
  };
  for (const [k, v] of Object.entries(用户打的)) {
    db.prepare('insert into app_setting(key, value) values(?, ?)').run(k, v);
  }
  // 这台机器上算出来的那些**故意不带**——换台机器重算就有
  db.prepare("insert into app_setting(key, value) values('cover.gapMs', '48000')").run();
  db.prepare("insert into app_setting(key, value) values('search.indexed', '[1,2,3]')").run();

  const bk = exportBackup(db);
  const fresh = openDb(join(dir, 'f-user-settings.db'));
  try {
    importBackup(fresh, bk);
    for (const [k, v] of Object.entries(用户打的)) {
      const row = fresh.prepare('select value from app_setting where key = ?').get(k) as
        | { value: string }
        | undefined;
      assert.equal(row?.value, v, `${k} 没跟着备份回来`);
    }
    // 反面那半：算出来的没跟过来。少了这一条，把白名单写成「全部键」也能全绿
    for (const k of ['cover.gapMs', 'search.indexed']) {
      assert.equal(fresh.prepare('select value from app_setting where key = ?').get(k), undefined, `${k} 不该进备份`);
    }
  } finally {
    fresh.close();
  }
});

test('设置和智能书架也在备份里', async () => {
  await seed();
  db.prepare("insert into app_setting(key, value) values('rename.enabled', '0')").run();
  db.prepare("insert into smart_shelf(name, filter_json) values('大部头', '{\"minWords\":100000}')").run();

  const bk = exportBackup(db);
  assert.equal(bk.settings['rename.enabled'], '0');
  assert.equal((bk.shelves as Array<{ name: string }>)[0].name, '大部头');

  const fresh = openDb(join(dir, 'f2.db'));
  try {
    importBackup(fresh, bk);
    assert.equal(
      (fresh.prepare("select value from app_setting where key='rename.enabled'").get() as { value: string })
        .value,
      '0',
    );
    assert.equal((fresh.prepare('select count(*) n from smart_shelf').get() as { n: number }).n, 1);
  } finally {
    fresh.close();
  }
});

/*
 * **老备份（没有 highlights 这个字段）照样要能恢复。**
 * 这就是「纯新增字段不加版本位」的代价换来的东西——加了位的话，
 * 老程序会把新备份整个拒收，而它本来能读懂其中的九成。
 */
test('老格式的备份（没有划线那一段）照样恢复得了', async () => {
  const id = await seed();
  addHighlight(db, { bookId: id, chapterIdx: 1, charOffset: 5, length: 4, excerpt: '雪中', note: '记一笔' });

  const bk = exportBackup(db);
  // 模拟一份第六轮之前导出的备份：把 highlights 整个删掉
  for (const b of bk.books) delete (b as Partial<typeof b>).highlights;

  db.prepare('delete from highlight').run();
  const r = await importBackup(db, bk);
  assert.ok(r, '不该因为少一个字段就整个失败');
  assert.equal((db.prepare('select count(*) n from highlight').get() as { n: number }).n, 0,
    '老备份里本来就没有划线，恢复完自然也没有——但不能抛');
});

/*
 * **每加一张表，都得在这儿表个态。**
 *
 * `highlight` 和 `reading_session` 都是这么漏的：表是后来加的，
 * 而 `backup.ts` 没跟着改，于是整张表的用户数据没有任何出口——
 * **不报错、测试全绿，用户要到恢复完才发现**。
 *
 * 判据很粗但很硬：`db.ts` 里建的每一张表，名字都得在 `backup.ts` 里出现过。
 * 出现的方式有两种，都算数：**带上它**（导出/恢复的 SQL 里），
 * 或者**写明为什么不带**（头注释里那几句，比如 `rename_log` 的
 * 「带着 file_id 和绝对路径，换台机器没意义」）。
 * 逼的是「想一下」，不是「必须带」。
 */
test('db.ts 里的每张表，backup.ts 都表过态', () => {
  const schema = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  const backup = readFileSync(new URL('./backup.ts', import.meta.url), 'utf8');
  const tables = [...schema.matchAll(/create table (?:if not exists )?(\w+)\(/g)].map((m) => m[1]);

  // 自检：解析不出表名的话这条断言就是静默通过的
  assert.ok(tables.length >= 15, `只解析到 ${tables.length} 张表，多半是 db.ts 的写法变了`);

  const silent = tables.filter((t) => !backup.includes(t));
  assert.deepEqual(silent, [],
    `这些表 backup.ts 一个字都没提——带上它，或者在头注释里写明为什么不带：${silent.join('、')}`);
});

/*
 * **恢复完要说清回来了什么，不能只说「认回 N 本」。**
 *
 * 那说的是**书**，不是**用户写的东西**。而恢复是备份唯一被验证的时刻——
 * 用户在这一刻想知道的是「我那几百条书评回来了吗」。
 * 一本书认回来了、而它的书评因为某处 SQL 漏了没落库（这个循环里真发生过两次：
 * `rated_at`、整张 `highlight` 表），旧报告一个字都不会说。
 */
test('恢复报告要说清书评、划线、书签、阅读会话各回来了多少', async () => {
  const id = await seed();
  setStatus(db, id, { rating: 5, comment: '一口气看完' });
  addHighlight(db, { bookId: id, chapterIdx: 1, charOffset: 5, length: 4, excerpt: '雪中', note: '好' });
  db.prepare("insert into reading_session(book_id, started_at, from_percent, to_percent) values(?,?,?,?)")
    .run(id, '2026-01-01T10:00:00Z', 0, 30);

  const bk = exportBackup(db);
  db.prepare('delete from highlight').run();
  db.prepare('delete from reading_session').run();
  db.prepare('delete from bookmark').run();
  db.prepare('update reading_state set rating = null, comment = null').run();

  const r = await importBackup(db, bk);
  assert.ok(r.matched >= 1, '书要认回来');
  assert.equal(r.restored.reviews, 1, `书评：${JSON.stringify(r.restored)}`);
  assert.equal(r.restored.highlights, 1);
  assert.equal(r.restored.sessions, 1);
  assert.equal(r.restored.bookmarks, 1, '夹具里那条书签也要回来');

  // 再导一次：都已经在了，一条都不该被数成「回来了」
  const again = await importBackup(db, bk);
  assert.equal(again.restored.highlights, 0, '导两次不该重复计数');
  assert.equal(again.restored.sessions, 0);
  assert.equal(again.restored.bookmarks, 0);
});

/*
 * **标签也要真的回来。**
 *
 * 三方对账那条验的是**导出**带没带上，而「恢复之后书上还挂着那些标签吗」
 * 是另一件事——这个循环里 `rated_at` 和整张 `highlight` 表都是在恢复这一头漏的。
 * 顺带钉住 `createdTags`：一个空库恢复时标签是新建的，那个数得对。
 */
test('恢复：标签回到书上，新建了几个标签也数得对', async () => {
  const id = await seed();
  tagBooks(db, [id], ['玄幻', '值得再看']);
  const bk = exportBackup(db);

  // 清成一个「有书没标签」的库
  db.prepare('delete from book_tag').run();
  db.prepare('delete from tag').run();

  // **别把数写死**：夹具自己也打过标签，硬写一个 2 只会证明我数错了。
  // 从备份里算出「一共有几种标签」，那才是空库恢复时该新建的数
  const distinct = new Set(bk.books.flatMap((b) => b.tags)).size;
  const r = await importBackup(db, bk);
  assert.equal(r.createdTags, distinct, `新建的标签数不对：${r.createdTags} / 该是 ${distinct}`);
  // 期望值也从备份里取：夹具给这本书打过什么，我不该在这儿重写一遍
  const want = [...(bk.books.find((b) => b.title === '雪中悍刀行')?.tags ?? [])].sort();
  const back = db
    .prepare(`select t.name from book_tag bt join tag t on t.id = bt.tag_id
               where bt.book_id = ? order by t.name`)
    .all(id) as Array<{ name: string }>;
  assert.deepEqual(back.map((x) => x.name).sort(), want);
  assert.ok(want.length >= 3, `这本书该有至少三个标签，实际 ${JSON.stringify(want)}`);

  // 再导一次：标签已经在了，不该重复新建
  const again = await importBackup(db, bk);
  assert.equal(again.createdTags, 0, '第二遍不该再新建');
  assert.equal(
    (db.prepare('select count(*) n from book_tag where book_id = ?').get(id) as { n: number }).n,
    want.length,
    '关联也不该翻倍',
  );
});

/*
 * **恢复会把本地已有的评价盖掉——那是对的，但得说一声。**
 *
 * `importBackup` 无条件 `update reading_state set rating = ?, comment = ?`：
 * 点「恢复」就是要拿备份里的那份为准，见到本地更新就跳过反而会让
 * 「我搞砸了，恢复一下」这条最正常的路失效。错的是一个字都不说——
 * 拿一份三个月前的备份恢复一下，这期间写的书评全被换掉，
 * 而报告写的是「恢复完成：认回 12 本，书评 8 条」。书评重扫恢复不了。
 *
 * 三档一起钉住，只数中间那一档：
 *   本地是空的 → 不算（没盖掉任何东西）
 *   本地有、且和备份一模一样 → 不算（覆盖等于没发生）
 *   本地有、且不一样 → 算
 */
test('恢复盖掉本地评价时要如实报出来', async () => {
  const id = await seed();
  db.prepare('update reading_state set rating = 5, comment = ? where book_id = ?')
    .run('备份里的那句', id);
  // 第二本占「本地和备份一模一样」那一档
  const same = (db.prepare("select id from book where title='斗破苍穹'").get() as { id: number }).id;
  setStatus(db, same, { rating: 3, comment: '一样的话' });
  // 第三本占「备份里有、而本地是空的」那一档——**这一档才逼得出「本地本来有内容」
  // 那半判据**：少了它，把那半拆掉测试照样绿（第一次就是这么绿的）
  const fresh = addManualBook(db, '只在备份里有评价的', '某人').id;
  setStatus(db, fresh, { rating: 4, comment: '备份里写着的' });

  const backup = exportBackup(db);

  // 换个「本地」
  db.prepare('update reading_state set rating = 2, comment = ? where book_id = ?')
    .run('我后来重写的一句', id);
  db.prepare('update reading_state set rating = null, comment = null where book_id = ?').run(fresh);

  const rep = importBackup(db, backup);
  assert.equal(rep.overwrote, 1, '只该数「本地有内容、而且和备份不一样」的那一本');
  assert.ok(rep.restored.reviews >= 3, '三本的评价都该回来');

  const back = db.prepare('select rating, comment from reading_state where book_id = ?')
    .get(id) as { rating: number; comment: string };
  assert.equal(back.comment, '备份里的那句', '备份里的那份还是要覆盖上去——这不是「跳过」');
  assert.equal(back.rating, 5);
  const f = db.prepare('select comment from reading_state where book_id = ?')
    .get(fresh) as { comment: string };
  assert.equal(f.comment, '备份里写着的', '本地空着的那本也要填回来');
});

/*
 * **手工添的书原来一本都恢复不回来。**
 *
 * 上面三条认领判据全靠 `book_file`（hash / 路径），而这类书**没有任何文件**——
 * 当场量的：备份里一本手工添、写过书评的书，恢复到空库是
 * `matched 0 / unmatched 1 / reviews 0`，**书没建出来，书评就没了**；
 * 恢复到它自己那个库上也一样，尽管那本书就在旁边。
 *
 * 而 `manual.ts` 的前提是「书评是主体，文件是可选的」，`backup.ts` 顶上写着
 * 「这是不可再生数据的唯一保险」——**保险偏偏漏掉了那些只剩不可再生数据的书**。
 * `unmatched` 那条出路也接不住：界面让用户去指认一个**文件**。
 */
test('手工添的书（没有任何文件）也要能恢复回来', () => {
  const m = addManualBook(db, '只有记录的书', '某人').id;
  setStatus(db, m, { rating: 4, comment: '读过，没存文件' });
  tagBooks(db, [m], ['回忆']);
  const backup = exportBackup(db);

  // ① 恢复到一个全新的空库：书要建出来，评价跟着回来
  const fresh = openDb(join(dir, 'fresh.db'));
  const r1 = importBackup(fresh, backup);
  assert.equal(r1.unmatched.length, 0, '没有文件不等于认不回来');
  assert.equal(r1.createdBooks, 1);
  const got = fresh.prepare(
    'select b.title, r.rating, r.comment from book b join reading_state r on r.book_id = b.id',
  ).get() as { title: string; rating: number; comment: string };
  assert.equal(got.title, '只有记录的书');
  assert.equal(got.comment, '读过，没存文件', '书建出来了但评价没跟过来，等于没恢复');
  assert.equal(got.rating, 4);
  assert.equal(
    (fresh.prepare('select count(*) n from book_tag').get() as { n: number }).n, 1,
    '标签也是用户打的',
  );

  // ② 再恢复一遍不该多出第二本（判据和 addManualBook 是同一条：按 bookKey 认）
  const r2 = importBackup(fresh, backup);
  assert.equal(r2.createdBooks, 0, '同名同作者的已经在了，不该再建一本');
  assert.equal((fresh.prepare('select count(*) n from book').get() as { n: number }).n, 1);
  fresh.close();

  // ③ 恢复到它自己那个库上，也要认得出来
  const r3 = importBackup(db, backup);
  assert.equal(r3.createdBooks, 0, '那本书就在旁边，书名作者一模一样');
  assert.equal(r3.unmatched.length, 0);
});

/*
 * **「手动指认」和恢复必须搬回同样的东西。**
 *
 * `linkManually` 原来自己抄了一份，而它抄的是 `highlight` 那张表还不存在时候的版本：
 * 手动指认回来的书**划线和笔记一条都没有**，书签也没有去重、**指认两次会翻倍**。
 * 本文件顶上那句「加一张存用户输入的表时，这句话和 backup.ts 要一起改」
 * 说的就是这个形状——而它已经犯过一次了（`highlight` 整张表当初不在备份里）。
 *
 * 现在两条路共用 `restoreUserData`，这条测试直接钉住那几样都回来了。
 */
test('手动指认：划线、书签、阅读状态都要回来，而且指认两次不翻倍', async () => {
  const id = await seed();
  addHighlight(db, {
    bookId: id, chapterIdx: 1, charOffset: 10, length: 6, excerpt: '寻常的一行', note: '这句好',
  });
  const backup = exportBackup(db);
  const bb = backup.books.find((b) => b.title === '雪中悍刀行')!;

  // 换一个空库，造一本同名的书当作「用户指认的那本」
  const fresh = openDb(join(dir, 'link.db'));
  const target = Number(
    fresh.prepare("insert into book(title) values('雪中悍刀行')").run().lastInsertRowid,
  );
  fresh.prepare("insert into reading_state(book_id, status) values(?, 'none')").run(target);

  const r1 = linkManually(fresh, bb, target);
  assert.equal(r1.restored.highlights, 1, '划线原来一条都不搬');
  assert.ok(r1.restored.bookmarks >= 1);
  assert.equal(
    (fresh.prepare('select note from highlight where book_id = ?').get(target) as { note: string }).note,
    '这句好',
    '笔记是用户打的字，重扫恢复不了',
  );

  // 再指认一次：一条都不该多出来
  const r2 = linkManually(fresh, bb, target);
  assert.equal(r2.restored.bookmarks, 0, '指认两次不该翻倍');
  assert.equal(r2.restored.highlights, 0);
  assert.equal(
    (fresh.prepare('select count(*) n from highlight where book_id = ?').get(target) as { n: number }).n,
    1,
  );
  fresh.close();
});


/*
 * **列一级的往返守卫。**
 *
 * 「每张表都得在 `backup.ts` 里表个态」那条守着**表**，而这个仓库在**列**上
 * 也栽过一次：`rated_at` 一直不在备份里，于是恢复完所有书评挤在最后没有先后
 * （「我的书评」那一档正是按它排的）。那次是读代码发现的，不是测出来的。
 *
 * 这条不比名字，**比值**：把四张不可再生的表的**每一列**都填上一个认得出的值，
 * 导出 → 把用户数据全清掉（模拟换台机器）→ 恢复 → 逐列对回来。
 * 名字匹配那种判据挡不住「注释里提了、代码没带」，比值挡得住。
 *
 * 不带的列写在 `NOT_CARRIED` 里，**每条都要说清为什么**——那张表就是决定本身，
 * 往里加一条是个看得见的动作。
 */
const NOT_CARRIED: Record<string, string[]> = {
  // id 是本机自增主键，book_id 由认领算出来，created_at 是「这条记录什么时候建的」
  reading_state: [
    'book_id',
    // **谁都没写过它**：只有 schema 默认值 0，`scan.ts` 读出来原样传给
    // `restoreProgress`，那边又原样传回来，没有一条路径落库（真实库 8172 行全是 0）。
    // 哪天真拿它当进度锚点了，**这里和 `backup.ts` 要一起改**——同 `highlight`
    // 整张表当初漏掉的那次。
    'global_offset',
  ],
  bookmark: ['id', 'book_id', 'created_at'],
  highlight: ['id', 'book_id', 'created_at'],
  reading_session: ['id', 'book_id'],
};

test('不可再生的表：每一列都要能原样往返，不然就得写明为什么不带', async () => {
  const id = await seed();

  // 把 reading_state 的每一列都填成认得出的值（派生字段也填，恢复要一并带回来）
  db.prepare(
    `update reading_state
        set status='dropped', chapter_idx=1, char_offset=77, percent=42.5,
            rating=3.5, comment='认得出的短评', drop_reason='认得出的弃坑原因',
            rated_at='2026-01-02 03:04:05', last_read_at='2026-01-03 04:05:06',
            finished_at=null, reread_count=2, global_offset=0
      where book_id = ?`,
  ).run(id);
  db.prepare("update bookmark set excerpt='认得出的摘录', note='认得出的书签笔记' where book_id = ?").run(id);
  addHighlight(db, { bookId: id, chapterIdx: 1, charOffset: 12, length: 6, excerpt: '认得出的划线', note: '认得出的划线笔记', color: 'blue' });
  db.prepare(
    "insert into reading_session(book_id, started_at, ended_at, from_percent, to_percent) values(?, '2026-01-01 10:00:00', '2026-01-01 11:00:00', 10.5, 20.5)",
  ).run(id);

  const 原样 = (t: string) =>
    (db.prepare(`select * from ${t} where book_id = ?`).all(id) as unknown as Array<Record<string, unknown>>)
      .map((r) => ({ ...r }));
  const before = Object.fromEntries(
    Object.keys(NOT_CARRIED).map((t) => [t, 原样(t)]),
  );

  const bk = exportBackup(db);

  // 换台机器：用户数据全没了，书和文件还在（恢复靠 hash / 路径认回来）
  for (const t of Object.keys(NOT_CARRIED)) db.prepare(`delete from ${t}`).run();
  await importBackup(db, bk);

  for (const [t, cols] of Object.entries(NOT_CARRIED)) {
    const now = 原样(t);
    assert.equal(now.length, before[t].length, `${t}: 恢复回来的行数不对`);
    const all = db.prepare('select name from pragma_table_info(?)').all(t) as unknown as Array<{ name: string }>;
    for (const { name } of all) {
      if (cols.includes(name)) continue;
      for (let i = 0; i < now.length; i++) {
        assert.deepEqual(
          now[i][name], before[t][i][name],
          `${t}.${name} 没能原样恢复回来——要么备份里漏了这一列，要么它该进 NOT_CARRIED 并写明为什么`,
        );
      }
    }
  }
});

/*
 * 上面那条列一级的守卫**当场逮到的就是这个**，值得单独钉一条：
 * `restoreUserData` 原来对 `reading_state` 只有 UPDATE。那本书没有这一行时，
 * 恢复一个字都写不进去，**而报告已经把它数成「回来了一条书评」**——
 * 报告说回来了，库里什么都没有。
 *
 * 「没有这一行的书」是真实存在的：`buildFilter` 用 `ifnull(r.status,'none')`
 * 筛「未标记」，那一档按定义就包含它们（`setStatus` 当初也为此补过同一句）。
 */
test('那本书连 reading_state 行都没有时，恢复也要把书评写进去', async () => {
  const id = await seed();
  const bk = exportBackup(db);

  db.prepare('delete from reading_state where book_id = ?').run(id);
  const report = await importBackup(db, bk);

  const r = db
    .prepare('select rating, comment from reading_state where book_id = ?')
    .get(id) as { rating: number | null; comment: string | null } | undefined;
  assert.ok(r, '整行都没建出来');
  assert.equal(r.rating, 4.5);
  assert.equal(r.comment, '前期神作');
  // 报告和库里必须是同一回事：最糟的失败是「报告说回来了 1 条，库里是空的」
  assert.ok(report.restored.reviews >= 1, '报告没把它数上');
});

/*
 * **前门严、后门松。**
 *
 * `setStatus` 那边逐个字段校验过（评分必须是 0–5 的有限数、短评必须是文字、
 * 状态必须认得），而恢复这条路原来**一个字都不看**——而备份是个用户能用
 * 文本编辑器打开的 JSON，还可能来自更早/更新的版本。
 *
 * 实测往备份里塞 `status: '乱写的状态'`、`rating: 99`、`percent: 500`、
 * `comment: 12345`，全部原样落进 `reading_state`（那个 comment 还被 sqlite 存成
 * `"12345.0"`，正是第 89 轮在前门修掉的同一个坑）。
 * 后果不是显示难看：**一本状态不认识的书从此不属于任何一档书架**。
 */
test('备份被改坏了：收拾干净再落库，而且照实说改了几处', async () => {
  const id = await seed();
  const bk = exportBackup(db);
  const bad = JSON.parse(JSON.stringify(bk)) as typeof bk;
  const book = bad.books.find((b) => b.reading)!;
  book.reading = {
    ...book.reading!,
    status: '乱写的状态', chapterIdx: -5, percent: 500,
    rating: 99, comment: 12345 as never, ratedAt: 'not-a-date',
    rereadCount: -1, finishedAt: 'yesterday',
  };

  const r = await importBackup(db, bad);
  assert.ok(r.fixed >= 6, `该报出收拾了几处，实际 ${r.fixed}`);

  const s = db.prepare('select * from reading_state where book_id = ?').get(id) as Record<string, unknown>;
  assert.equal(s.status, 'none', '不认识的状态要落成「未标记」——否则这本书不属于任何一档书架');
  assert.equal(s.rating, null, '99 星不是评分');
  assert.equal(s.percent, 0, '500% 的进度条会撑破卡片');
  assert.equal(s.comment, null, '数字不是短评（原来会被 sqlite 存成 "12345.0"）');
  assert.equal(s.chapter_idx, 0);
  assert.equal(s.reread_count, 0);
  assert.equal(s.rated_at, null, '不是时间就别留着——「我的书评」按它排序');
  assert.equal(s.finished_at, null);
});

test('好好的备份一处都不许「收拾」', async () => {
  await seed();
  const bk = exportBackup(db);
  const r = await importBackup(db, bk);
  assert.equal(r.fixed, 0, '把正常数据也算成「收拾过」的话，那个数就没意义了');
});

/*
 * **一条坏行不许让整份备份作废。**
 *
 * `importBackup` 是包在事务里的（那是对的），于是备份里一条划线的 `excerpt`
 * 或 `created_at` 为 null，撞上 `not null` 就**整份回滚**——
 * 而备份是不可再生数据的**唯一保险**。
 *
 * 顺带还有值本身：实测原样落库过 `char_offset: "abc"`（字符串进整数列）、
 * `length: -3`、`note: "7.0"`、`color: '乱写的颜色'`。
 * 前门 `addHighlight` 要求 `length > 0`、`charOffset >= 0`、颜色在 `COLORS` 里——
 * **后门认另一套的话，恢复出来的划线是前门永远造不出的形状。**
 */
test('备份里的书签划线坏了：收拾着恢复，别让整份作废', async () => {
  const id = await seed();
  addHighlight(db, { bookId: id, chapterIdx: 0, charOffset: 0, length: 3, excerpt: '一二三', note: '好' });
  const bk = exportBackup(db);

  const bad = JSON.parse(JSON.stringify(bk)) as typeof bk;
  const b = bad.books.find((x) => (x.highlights ?? []).length)!;
  b.bookmarks = [{ chapterIdx: -5, charOffset: 'abc' as never, excerpt: 12345 as never, note: null, createdAt: 'yesterday' }];
  // `cfi` 也一起喂脏的：它是迁移 21 加的列，从外部工具/老备份里什么都可能来
  b.highlights = [{ chapterIdx: 0, charOffset: -1, length: -3, excerpt: null as never, note: 7 as never, color: '乱写的颜色', createdAt: null as never, cfi: 42 as never }];

  db.prepare('delete from bookmark').run();
  db.prepare('delete from highlight').run();

  // 最要紧的一条：不许抛。抛了就是整份备份都恢复不了
  const r = await importBackup(db, bad);
  assert.equal(r.restored.bookmarks, 1, '一条坏书签不该让整份备份作废');
  assert.equal(r.restored.highlights, 1);
  assert.ok(r.fixed >= 6, `该报出收拾了几处，实际 ${r.fixed}`);

  const m = db.prepare('select * from bookmark').get() as Record<string, unknown>;
  assert.equal(m.chapter_idx, 0, '负的章号');
  assert.equal(m.char_offset, 0, '字符串进了整数列');
  assert.equal(m.excerpt, null, '数字不是摘录');
  assert.ok(m.created_at, '认不出的时间要让 schema 默认值兜住，不能写 null');

  const h = db.prepare('select * from highlight').get() as Record<string, unknown>;
  assert.equal(h.char_offset, 0, '前门要求偏移量非负');
  assert.equal(h.length, 1, '前门要求长度大于 0');
  assert.equal(h.color, 'yellow', '不在 COLORS 里的颜色退回默认');
  assert.equal(h.excerpt, '', 'not null 的列不能塞 null——那会让整份备份回滚');
});

/*
 * **标签是最后一张不可再生的表，它的门也漏着。**
 *
 * 前门 `tagBooks` 走 `splitTagNames`：拆逗号、去空白、丢空串、名字最长 40 字。
 * 而恢复原来一个字不看——四样前门专门防住的东西全能落库：
 *
 *   - 空标签（卡片上一个点不着的空 chip）
 *   - 60 个字的名字（本仓库记着「一个 5000 字的标签名当场就把界面毁了」）
 *   - `科幻,悬疑`（`book.list` 的 tags 是逗号拼的，卡片按逗号拆，
 *     **会变出两个点不掉的假标签**）
 *   - 前后带空格的（那正是「玄幻 / 玄幻 」分裂的源头之一）
 */
test('备份里的标签名坏了：按前门那套规矩收拾，别原样灌进去', async () => {
  const id = await seed();
  const bk = exportBackup(db);
  const bad = JSON.parse(JSON.stringify(bk)) as typeof bk;
  bad.books.find((b) => b.tags.length)!.tags = ['一'.repeat(60), '科幻,悬疑', '  前后有空格  ', ''];

  db.prepare('delete from book_tag').run();
  db.prepare('delete from tag').run();
  const r = await importBackup(db, bad);
  assert.equal(r.fixed, 4, '四条都不是原样合法的，四处都该报出来');

  const names = (db.prepare('select name from tag order by name').all() as unknown as Array<{ name: string }>)
    .map((x) => x.name);
  assert.ok(!names.includes(''), '空标签会在卡片上留一个点不着的空 chip');
  assert.ok(names.includes('科幻') && names.includes('悬疑'), '逗号要拆开——不拆的话卡片上是两个点不掉的假标签');
  assert.ok(names.includes('前后有空格'), '前后空格要去掉，那是标签分裂的源头');
  const 长的 = names.find((x) => x.startsWith('一'))!;
  assert.equal([...长的].length, 40, `太长的要截到 40，实际 ${[...长的].length}`);
});

test('好好的标签一处都不许「收拾」', async () => {
  await seed();
  const bk = exportBackup(db);
  db.prepare('delete from book_tag').run();
  db.prepare('delete from tag').run();
  const r = await importBackup(db, bk);
  assert.equal(r.fixed, 0, '把正常标签也算成「收拾过」的话，那个数就没意义了');
});

/*
 * **换台机器：先恢复（认不回来）→ 把书库扫进来 → 再恢复一次。**
 *
 * 这是备份存在的理由那条路，而它一直没有测试。界面上原来只说了**原因**
 * （「可能是文件还没扫进来」），没说**怎么办**——而「再恢复一次」这个建议
 * 只有在「重复恢复不翻倍」成立时才敢给。这条测试把两半一起钉住。
 */
test('换台机器：认不回来 → 扫描 → 再恢复一次就认回来了，而且不翻倍', async () => {
  const id = await seed();
  addHighlight(db, { bookId: id, chapterIdx: 0, charOffset: 0, length: 3, excerpt: '一二三', note: '好' });
  const bk = exportBackup(db);
  const 原来的书评 = db.prepare('select rating, comment from reading_state where book_id = ?').get(id) as
    { rating: number; comment: string };

  // 造一台「新机器」：空库，书库文件夹里文件都在，但还没扫
  const dir2 = mkdtempSync(join(tmpdir(), 'novel-newpc-'));
  try {
    const db2 = openDb(join(dir2, 'library.db'));
    const lib2 = join(dir2, 'books');
    mkdirSync(lib2);
    for (const f of readdirSync(lib)) writeFileSync(join(lib2, f), readFileSync(join(lib, f)));
    const root2 = Number(db2.prepare('insert into library_root(path) values(?)').run(lib2).lastInsertRowid);

    // ① 先恢复：一本都认不回来（**而且不许凭空建条目**）
    const 第一次 = await importBackup(db2, bk);
    assert.equal(第一次.matched, 0, '还没扫，认不回来是对的');
    assert.ok(第一次.unmatched.length > 0, '认不回来的要列出来');
    assert.equal(
      (db2.prepare('select count(*) n from book_file').get() as { n: number }).n, 0,
      '不许凭空建文件记录',
    );

    // ② 扫描：文件进来了
    await scanRoot(db2, { id: root2, path: lib2 });
    assert.ok((db2.prepare('select count(*) n from book_file').get() as { n: number }).n > 0);

    // ③ 再恢复一次：这次认得回来
    const 第二次 = await importBackup(db2, bk);
    assert.ok(第二次.matched > 0, '扫过之后就该认回来——界面上那句建议靠的就是这一条');
    assert.equal(第二次.unmatched.length, 0);

    const got = db2
      .prepare("select rating, comment from reading_state r join book b on b.id = r.book_id where b.title = '雪中悍刀行'")
      .get() as { rating: number; comment: string };
    assert.equal(got.rating, 原来的书评.rating);
    assert.equal(got.comment, 原来的书评.comment);

    // ④ 手滑再点一次「恢复」也不许翻倍
    await importBackup(db2, bk);
    const n = (db2.prepare('select count(*) n from highlight').get() as { n: number }).n;
    assert.equal(n, 1, `划线翻倍了：${n} 条`);
    assert.equal(
      (db2.prepare('select count(*) n from bookmark').get() as { n: number }).n, 1,
      '书签也不许翻倍',
    );
    db2.close();
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

/*
 * ── EPUB 的划线锚（`cfi`）要跟着备份走 ─────────────────
 *
 * 迁移 21 给 `highlight` 加了 `cfi` 列，**而备份一直没跟上**。
 * 不带的后果不是「位置不太准」，是**整条废掉**：EPUB 的划线有 cfi 时
 * `char_offset` / `length` 是占位（0 和选中的字数），恢复回来 cfi 是 null
 * 就只剩那两个占位值——`resolve` 走偏移那条路，
 * 要么画到那一节开头、要么直接判成漂了。而这一切**不报错**。
 *
 * 这是「加一处存用户输入的地方，谁在靠原来那个位置取数」栽的第四次
 * （前三次：highlight 整张表、`viewer.<bookId>`、`bookmark.note`）。
 */
test('备份：EPUB 划线的 cfi 要原样回来', async () => {
  const id = await seed();
  const CFI = 'epubcfi(/6/6!/4/4,/1:2,/1:12)';
  addHighlight(db, {
    bookId: id, chapterIdx: 3, charOffset: 0, length: 10,
    excerpt: 'EPUB 里划的那一句', note: '这句要回头查', color: 'blue', cfi: CFI,
  });

  const bk = exportBackup(db);
  const 备份里 = bk.books.flatMap((b) => b.highlights ?? []).find((h) => h.excerpt.includes('EPUB'));
  assert.equal(备份里?.cfi, CFI, 'cfi 根本没被导出来');

  const fresh = openDb(join(dir, 'f-cfi.db'));
  try {
    // ⚠️ **先把书扫进新库再恢复。** 按书走的那些数据（划线、书签、进度）
    // 是挂在「认得回来的那本书」上的——空库里一本都对不上，
    // 于是整段跳过，而 `importBackup` 不报错。第一版这三条测试就栽在这儿
    const 根 = Number(fresh.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid);
    await scanRoot(fresh, { id: 根, path: lib });
    await importBackup(fresh, bk);
    const 回来的 = fresh
      .prepare("select cfi, char_offset as o, length as len, color, note from highlight where excerpt like 'EPUB%'")
      .get() as { cfi: string | null; o: number; len: number; color: string; note: string };
    assert.equal(回来的.cfi, CFI, 'cfi 没恢复回来——这条 EPUB 划线等于废了');
    assert.equal(回来的.color, 'blue');
    assert.equal(回来的.note, '这句要回头查');
  } finally {
    fresh.close();
  }
});

/*
 * ── PDF 的矩形摘录（`rect`）也要跟着备份走 ──────────
 *
 * 迁移 22 加的列，形状和 `cfi` 一模一样：有 `rect` 时
 * `char_offset` / `length` 是占位（一律 0 和 1），不带就**整条废掉**。
 *
 * 而且这一条多一个坑：`sanitizeMark` **重建了一个对象**，
 * select 和 insert 两头都写对了、只要那里漏写一行，`rect` 照样静默地消失。
 */
test('备份：PDF 矩形摘录的 rect 要原样回来', async () => {
  const id = await seed();
  const RECT = '0.1,0.2,0.3,0.25';
  addHighlight(db, {
    bookId: id, chapterIdx: 11, charOffset: 0, length: 1,
    excerpt: 'PDF 第 11 页那张图', note: '这张图回头要用', color: 'pink', rect: RECT,
  });

  const bk = exportBackup(db);
  const 备份里 = bk.books.flatMap((b) => b.highlights ?? []).find((h) => h.excerpt.includes('PDF'));
  assert.equal(备份里?.rect, RECT, 'rect 根本没被导出来');

  const fresh = openDb(join(dir, 'f-rect.db'));
  try {
    const 根 = Number(fresh.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid);
    await scanRoot(fresh, { id: 根, path: lib });
    await importBackup(fresh, bk);
    const 回来的 = fresh
      .prepare("select rect, color, note from highlight where excerpt like 'PDF%'")
      .get() as { rect: string | null; color: string; note: string };
    assert.equal(回来的.rect, RECT, 'rect 没恢复回来——这条框选等于废了');
    assert.equal(回来的.color, 'pink');
    assert.equal(回来的.note, '这张图回头要用');
  } finally {
    fresh.close();
  }
});

test('备份：笔记上的标签要跟着回来', async () => {
  /*
   * 迁移 23 新开的一处用户输入（`highlight_tag`）。
   * 漏了的症状和「颜色代表什么」那一条一模一样：
   * **划线回来了、分类没了**——只恢复了一半，而报告里还算它成功。
   * 存的是**名字**不是 id：换一个库 `tag.id` 对不上。
   */
  const id = await seed();
  const h = addHighlight(db, {
    bookId: id, chapterIdx: 4, charOffset: 0, length: 6, excerpt: '要打标签的那句', color: 'green',
  });
  tagHighlights(db, [h.id], ['伏笔', '要查']);

  const bk = exportBackup(db);
  const 备份里 = bk.books.flatMap((b) => b.highlights ?? []).find((x) => x.excerpt.includes('标签'));
  assert.deepEqual([...(备份里?.tags ?? [])].sort(), ['伏笔', '要查'], '标签根本没被导出来');

  const fresh = openDb(join(dir, 'f-htag.db'));
  try {
    const 根 = Number(fresh.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid);
    await scanRoot(fresh, { id: 根, path: lib });
    await importBackup(fresh, bk);
    const 回 = fresh
      .prepare("select id from highlight where excerpt like '%标签%'")
      .get() as { id: number } | undefined;
    assert.ok(回, '划线本身就没回来');
    assert.deepEqual(
      (tagsOfHighlights(fresh, [回.id])[回.id] ?? []).slice().sort(),
      ['伏笔', '要查'],
      '划线回来了、标签没回来——只恢复了一半',
    );
  } finally {
    fresh.close();
  }
});

test('备份：同一页上框两块，不许当成重复丢一条', async () => {
  /*
   * 去重原来按「章 + 偏移 + 长度」。矩形摘录的偏移恒为 0、长度恒为 1——
   * 同一页上框两块的话这三样**完全相同**，后一条会被丢掉，
   * 而报告里还算它「恢复成功」。形状同 EPUB 那一条。
   */
  const id = await seed();
  for (const [n, rect] of [['上半页', '0,0,1,0.4'], ['下半页', '0,0.5,1,0.4']] as const) {
    addHighlight(db, {
      bookId: id, chapterIdx: 7, charOffset: 0, length: 1, excerpt: n, color: 'green', rect,
    });
  }
  const bk = exportBackup(db);
  const fresh = openDb(join(dir, 'f-rect2.db'));
  try {
    const 根 = Number(fresh.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid);
    await scanRoot(fresh, { id: 根, path: lib });
    await importBackup(fresh, bk);
    const n = (fresh.prepare('select count(*) n from highlight where chapter_idx = 7').get() as { n: number }).n;
    assert.equal(n, 2, '同一页上的两块被当成重复丢了一条');
  } finally {
    fresh.close();
  }
});

test('备份：EPUB 划线按 cfi 去重，同一节里两句一样长的不许丢一条', async () => {
  /*
   * 去重原来按「章 + 偏移 + 长度」。EPUB 的偏移恒为 0、长度就是选中的字数——
   * 同一节里划两句一样长的话，这三样**完全相同**，
   * 恢复时后一条会被当成重复丢掉，而且报告里还算它「恢复成功」。
   */
  const id = await seed();
  for (const [n, cfi] of [['甲', 'epubcfi(/6/6!/4/2,/1:0,/1:4)'], ['乙', 'epubcfi(/6/6!/4/8,/1:0,/1:4)']] as const) {
    addHighlight(db, {
      bookId: id, chapterIdx: 2, charOffset: 0, length: 4, excerpt: n + '一二三', color: 'green', cfi,
    });
  }
  const bk = exportBackup(db);
  const fresh = openDb(join(dir, 'f-cfi2.db'));
  try {
    // ⚠️ **先把书扫进新库再恢复。** 按书走的那些数据（划线、书签、进度）
    // 是挂在「认得回来的那本书」上的——空库里一本都对不上，
    // 于是整段跳过，而 `importBackup` 不报错。第一版这三条测试就栽在这儿
    const 根 = Number(fresh.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid);
    await scanRoot(fresh, { id: 根, path: lib });
    await importBackup(fresh, bk);
    const n = (fresh.prepare('select count(*) n from highlight').get() as { n: number }).n;
    assert.equal(n, 2, '同一节里两条一样长的 EPUB 划线，被当成重复丢了一条');
    const cfis = (fresh.prepare('select cfi from highlight order by id').all() as Array<{ cfi: string }>)
      .map((r) => r.cfi);
    assert.equal(new Set(cfis).size, 2, '两条的 cfi 该是不一样的');
  } finally {
    fresh.close();
  }
});

test('备份：老备份里没有 cfi 字段，恢复成 null 而不是报错', async () => {
  // 「当时就没有」和「丢了」是两回事——老备份该照旧恢复，走偏移那条路
  const id = await seed();
  addHighlight(db, { bookId: id, chapterIdx: 1, charOffset: 5, length: 3, excerpt: '老的', note: '老笔记' });
  const bk = JSON.parse(JSON.stringify(exportBackup(db))) as ReturnType<typeof exportBackup>;
  for (const b of bk.books) for (const h of b.highlights ?? []) delete (h as { cfi?: unknown }).cfi;

  const fresh = openDb(join(dir, 'f-cfi3.db'));
  try {
    // ⚠️ **先把书扫进新库再恢复。** 按书走的那些数据（划线、书签、进度）
    // 是挂在「认得回来的那本书」上的——空库里一本都对不上，
    // 于是整段跳过，而 `importBackup` 不报错。第一版这三条测试就栽在这儿
    const 根 = Number(fresh.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid);
    await scanRoot(fresh, { id: 根, path: lib });
    await importBackup(fresh, bk);
    const r = fresh.prepare("select cfi, char_offset as o, note from highlight where excerpt = '老的'")
      .get() as { cfi: string | null; o: number; note: string };
    assert.equal(r.cfi, null);
    assert.equal(r.o, 5, '偏移那条路还得照走');
    assert.equal(r.note, '老笔记');
  } finally {
    fresh.close();
  }
});
