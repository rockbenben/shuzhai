import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { parseAndStore, scanRoot, emptyReport, parseMinBytes, MIN_BYTES_DEFAULT } from './scan.ts';
import { isBookFile, formatOf } from './book-format.ts';
import { parseChapters } from './chapter.ts';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shuzhai-fmt-'));
  db = openDb(join(dir, 'library.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('收电子书格式，不收通用文档格式', () => {
  // 判据整段写在 `book-format.ts` 的 `BOOK_EXT` 上面：
  // **收「这个扩展名基本只可能是一本书」的，不收「什么都可能是」的**
  for (const n of [
    'book.txt', 'BOOK.TXT', '小说.md', 'a.markdown',
    'a.pdf', 'b.epub', 'c.mobi', 'd.azw3', 'e.azw', 'f.fb2', 'g.umd', 'h.cbz', 'i.djvu',
  ]) {
    assert.ok(isBookFile(n), n + ' 应该收');
  }
  /*
   * ⚠️ **这几个是「查过了、决定不收」的，不是漏了。**
   * 通用文档格式在一个递归扫描的书库里会把简历、笔记、报表一起拖进来；
   * calibre 全都收，但它是转换器不是扫描器（喂给它的是单个文件）。
   * 有人想加的话先读 `BOOK_EXT` 上面那段。
   */
  for (const n of ['简历.doc', '报告.docx', '说明.rtf', '笔记.odt', '存的网页.html', '帮助.chm']) {
    assert.ok(!isBookFile(n), n + ' 不该收');
  }
  for (const n of ['封面.jpg', 'a.txt.bak', 'noext']) {
    assert.ok(!isBookFile(n), n);
  }
});

test('纯文本（txt / md）算「能读正文」，其余一律只编目', () => {
  assert.equal(formatOf('D:/x/a.txt'), 'text');
  assert.equal(formatOf('D:/x/a.TXT'), 'text');
  // md 是纯文本，整套正文机制（编码探测 / 章节切分 / 字节偏移）直接成立
  assert.equal(formatOf('D:/x/a.md'), 'text');
  assert.equal(formatOf('D:/x/a.MARKDOWN'), 'text');
  assert.equal(formatOf('D:/x/a.pdf'), 'catalog');
  assert.equal(formatOf('D:/x/a.epub'), 'catalog');
  assert.equal(formatOf('D:/x/a.fb2'), 'catalog');
});

test('markdown 的标题就是章节标题——一条规则都不用新写', () => {
  /*
   * 这条钉的是「加 md 到底值不值」的那个前提。实测：`## 第一章 初见`
   * 和不带 `#` 的纯文本切出来**完全一样**，连标题里的 `##` 都不留。
   * 哪天章节规则改动让它不成立了，这条会红——那时候要么改规则，
   * 要么把 md 从 `TEXT_EXT` 里拿掉，别让它悄悄退化成「切不出章的书」。
   */
  const 段 = '风雪夜归人孤灯照旧影。'.repeat(80);
  // 换行用 fromCharCode 拼：这个仓库的补丁脚本反复把字面量里的反斜杠 n 吃成真换行
  const 换 = String.fromCharCode(10);
  const md = ['# 我的小说', '', '简介。', '', '## 第一章 初见', '', 段, '', '## 第二章 再会', '', 段].join(换);
  const 纯 = md.split(换).map((l) => l.replace(/^#+[ ]*/, '')).join(换);
  const a = parseChapters(Buffer.from(md, 'utf8'), 'utf-8');
  const b = parseChapters(Buffer.from(纯, 'utf8'), 'utf-8');
  assert.deepEqual(a.chapters.map((c) => c.title), ['第一章 初见', '第二章 再会']);
  assert.deepEqual(a.chapters.map((c) => c.title), b.chapters.map((c) => c.title));
});

test('PDF 不去解析正文——解析出来的是垃圾章节，而且不报错', () => {
  // 这条是这个改动的要害：`detectEncoding` 会对着 PDF 的二进制打分、
  // `parseChapters` 会在里面找「第一章」。两个都**不会抛**，只会安静地
  // 产出一堆垃圾章节，用户点开看到乱码。不解析比解析错好
  const pdf = join(dir, '书.pdf');
  writeFileSync(pdf, Buffer.from('%PDF-1.7\n1 0 obj\n第一章 这是二进制里的字\n', 'utf8'));

  const bookId = Number(db.prepare("insert into book(title) values('书')").run().lastInsertRowid);
  const rootId = Number(db.prepare('insert into library_root(path, enabled) values(?,1)').run(dir).lastInsertRowid);
  const fileId = Number(
    db.prepare(`insert into book_file(book_id, root_id, path, size, mtime, is_primary)
                values(?,?,?,1,1,1)`).run(bookId, rootId, pdf).lastInsertRowid,
  );

  return parseAndStore(db, fileId, pdf).then((r) => {
    assert.equal(r.chapters, 0, 'PDF 不该切出章节');
    assert.equal(r.encoding, 'binary');
    // 字数留 0：抽 PDF 文本正是我们不做的事，摆一个瞎猜的数字比空着更糟——
    // 它会进排序、进统计、进导出
    assert.equal(r.words, 0);
    assert.equal(
      (db.prepare('select count(*) n from chapter where file_id = ?').get(fileId) as { n: number }).n,
      0,
    );
  });
});

// ── 静默跳过必须报出来 ───────────────────────────────────────────────
// 这个仓库在「10 KB 静默过滤」上踩过三次，症状都是「所有断言都说查不到这本书」。
// 四条跳过路径的用户侧症状完全一样（文件在硬盘上、库里没有），差别只在怎么办

test('四种跳过都要计数，不是只数太小的那一种', async () => {
  const root = join(dir, 'lib');
  mkdirSync(join(root, '临时'), { recursive: true });
  writeFileSync(join(root, '太小.txt'), '短'.repeat(10));
  writeFileSync(join(root, '正常.txt'), '正'.repeat(20000));
  // 中文一个字 UTF-8 占 3 字节：20000 字 ≈ 60 KB（收），50000 字 ≈ 150 KB（超上限）
  writeFileSync(join(root, '太大.txt'), '大'.repeat(50000));
  writeFileSync(join(root, '临时', '被屏蔽.txt'), '屏'.repeat(20000));

  const rootId = Number(
    db.prepare('insert into library_root(path, enabled) values(?,1)').run(root).lastInsertRowid,
  );
  const r = await scanRoot(db, { id: rootId, path: root }, {
    ignore: ['临时/**'],
    maxBytes: 100_000,
  });

  assert.equal(r.added, 1, '只有「正常.txt」该被收进来');
  assert.equal(r.skipped.tooSmall, 1);
  assert.equal(r.skipped.tooBig, 1);
  assert.equal(r.skipped.ignored, 1, '被屏蔽规则挡掉的也要数');
});

test('跳过表是空的时候就是空对象，界面据此决定说不说', () => {
  // 平时没有跳过，报告里不该冒出一堆 0——那是噪音
  assert.deepEqual(emptyReport().skipped, {});
});

test('收录下限是可以调的，而且坏值一律退回默认', async (t) => {
  /*
   * 起因是真实书库上的一次「扫描没新文件出来」：一个装短文合集的目录，
   * 55 个 txt 里 **27 个在 3–8 KB 之间**，全被 10 KB 那条线挡在外面；
   * 而同目录的 59 个 pdf 一个不少地进来了——症状完全不像「有条大小限制」。
   */
  const dir = mkdtempSync(join(tmpdir(), 'novel-min-'));
  const db = openDb(join(dir, 'library.db'));
  // ⚠️ **一个 after 里先关库再删目录。** 拆成两个 `t.after` 的话它们按注册顺序跑，
  // 删目录时库文件还开着——Windows 上直接 EPERM，而断言其实全过了，
  // 报出来只有一句「这条测试失败」，看着像功能坏了
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const lib = join(dir, 'books');
  mkdirSync(lib);
  const rootId = Number(db.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid);
  // 一篇 4 KB 的短文：默认那条线收不了它
  writeFileSync(join(lib, '短文.txt'), '风雪夜归人，孤灯照旧影。'.repeat(150), 'utf8');

  const 默认 = await scanRoot(db, { id: rootId, path: lib });
  assert.equal(默认.added, 0, '默认 10 KB 下这篇 4 KB 的短文收不进来');
  assert.equal(默认.skipped.tooSmall, 1, '而且要如实报成「太小」，不能悄悄没了');

  const 放宽 = await scanRoot(db, { id: rootId, path: lib }, { minBytes: 1024 });
  assert.equal(放宽.added, 1, '把下限调到 1 KB 就该收进来');

  // ⚠️ 坏值不能当成 0：`Number('')` 和 `Number(null)` 都是 0，
  // 照单全收的话一个空设置就等于「下限取消」，会莫名多出几千个说明文档
  assert.equal(parseMinBytes(null), MIN_BYTES_DEFAULT);
  assert.equal(parseMinBytes(''), MIN_BYTES_DEFAULT);
  assert.equal(parseMinBytes('   '), MIN_BYTES_DEFAULT);
  assert.equal(parseMinBytes('不是数'), MIN_BYTES_DEFAULT);
  assert.equal(parseMinBytes('-5'), MIN_BYTES_DEFAULT);
  // 只有明确填 0 才是「全都收」
  assert.equal(parseMinBytes('0'), 0);
  assert.equal(parseMinBytes('1024'), 1024);
});

