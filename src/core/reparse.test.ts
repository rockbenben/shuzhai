import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { scanRoot } from './scan.ts';
import { previewChapters, applyRule, bookRule, clearRule } from './reparse.ts';
import { addManualBook } from './manual.ts';

let dir: string;
let db: DatabaseSync;
let bookId: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'novel-rule-'));
  db = openDb(join(dir, 'library.db'));
  const lib = join(dir, 'books');
  mkdirSync(lib);
  const rootId = Number(
    db.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid,
  );

  // 用内置规则认不出来的写法：以 @@@ 开头（内置规则里没有任何一条会碰它——★☆◆ 这些符号现在被 star-title 收了）
  const filler = Array.from({ length: 200 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
  const text = ['@@@ 楔子', '@@@ 其一', '@@@ 其二', '@@@ 其三']
    .map((t) => `${t}\n${filler}\n`)
    .join('');
  writeFileSync(join(lib, '怪写法的书.txt'), text, 'utf8');

  await scanRoot(db, { id: rootId, path: lib });
  bookId = (db.prepare('select id from book').get() as { id: number }).id;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const chapterCount = () =>
  (db.prepare('select count(*) n from chapter').get() as { n: number }).n;

test('内置规则认不出这种写法，走了机械分段', async () => {
  const p = await previewChapters(db, bookId);
  assert.equal(p.recognized, false);
  assert.equal(p.ruleName, 'fallback-chunk');
});

test('预览不写库', async () => {
  const before = chapterCount();
  const p = await previewChapters(db, bookId, '^@@@');

  assert.equal(p.count, 4, '预览应该算出 4 章');
  assert.deepEqual(p.titles, ['@@@ 楔子', '@@@ 其一', '@@@ 其二', '@@@ 其三']);
  assert.equal(chapterCount(), before, '只是预览，库里章节数不能变');
  assert.equal(bookRule(db, bookId), null, '也不该留下规则');
});

test('确认后才落库，并记住这条规则', async () => {
  await applyRule(db, bookId, '^@@@');

  assert.equal(chapterCount(), 4);
  assert.equal(bookRule(db, bookId), '^@@@');
  const titles = (db.prepare('select title from chapter order by idx').all() as Array<{ title: string }>)
    .map((r) => r.title);
  assert.deepEqual(titles, ['@@@ 楔子', '@@@ 其一', '@@@ 其二', '@@@ 其三']);
  assert.equal(
    (db.prepare('select chapter_count c from book_file').get() as { c: number }).c,
    4,
    '文件表上的章节数也要跟着更新',
  );
});

test('改规则是覆盖，不是叠加', async () => {
  await applyRule(db, bookId, '^@@@');
  await applyRule(db, bookId, '^@@@ 其');

  // 4 = 前言 + 3 章。新规则把「@@@ 楔子」排除掉了，但它下面那段正文不能就此消失——
  // buildChapters 会把第一处命中之前的内容立成「前言」章（学 legado 的做法）。
  // 原来是直接丢掉的，用户既看不到也不会收到任何提示
  assert.equal(chapterCount(), 4, '前言 + 新规则切出的 3 章');
  assert.equal(
    (db.prepare('select title from chapter order by idx limit 1').get() as { title: string }).title,
    '前言',
  );
  assert.equal(bookRule(db, bookId), '^@@@ 其');
  assert.equal(
    (db.prepare("select count(*) n from parse_rule where book_id = ?").get(bookId) as { n: number }).n,
    1,
    '一本书只留一条规则',
  );
});

test('换规则之后阅读进度按标题跟过去', async () => {
  await applyRule(db, bookId, '^@@@');
  db.prepare('update reading_state set chapter_idx = 2, char_offset = 55 where book_id = ?').run(bookId);

  // 新规则把「@@@ 楔子」排除掉，但它那段正文变成了「前言」章占住第 0 位，
  // 所以「@@@ 其二」还在第 2 位。这条测试守的是**按标题跟过去**，不是某个固定下标——
  // 序号对不对得上不重要，读的还是不是同一章才重要
  await applyRule(db, bookId, '^@@@ 其');

  const s = db.prepare('select chapter_idx, char_offset from reading_state where book_id = ?').get(bookId) as {
    chapter_idx: number;
    char_offset: number;
  };
  const at = db.prepare('select title from chapter where idx = ?').get(s.chapter_idx) as { title: string };
  assert.equal(at.title, '@@@ 其二', '应按标题落回原来读的那一章');
  assert.equal(s.char_offset, 55);
});

test('清掉自定义规则会回到内置规则', async () => {
  await applyRule(db, bookId, '^@@@');
  assert.equal(chapterCount(), 4);

  const p = await clearRule(db, bookId);
  assert.equal(bookRule(db, bookId), null);
  assert.equal(p.recognized, false, '内置规则依然认不出，回到机械分段');
});

test('坏正则要报清楚，且不能留下半截状态', async () => {
  await assert.rejects(() => previewChapters(db, bookId, '('), /正则无效/);
  await assert.rejects(() => applyRule(db, bookId, '['), /正则无效/);
  assert.equal(bookRule(db, bookId), null, '失败的规则不该被存下来');
});

/*
 * **没有文件的书，报错要说人话。**
 *
 * 手工添的「只有记录」那类书压根没有 txt，而「章节怎么切」这条路走得到它：
 * 卡片上那个「章节」按钮原来照样显示（只有「导出」挡了 `b.path`），
 * 点下去用户看到的是「书 9 没有主文件」——数据库里的说法，带着一个数字 id。
 * 界面那头已经把按钮挡掉了，这条断言守的是**外部工具走 rpc 进来**的那条路（§13）。
 */
test('没有文件的书要说人话，不是「书 9 没有主文件」', async () => {
  const { id } = addManualBook(db, '活着', '余华');
  await assert.rejects(
    () => previewChapters(db, id),
    (e: Error) => {
      assert.ok(!/^书 \d+ /.test(e.message), `不该甩数据库里的说法：${e.message}`);
      assert.match(e.message, /活着/, '要说是哪本书');
      // **「说了怎么办」才是重点**——只把内部话换成中文等于没修
      assert.match(e.message, /扫描|放进书库文件夹/);
      return true;
    },
  );
});

