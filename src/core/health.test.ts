import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { suspiciousSplits } from './health.ts';

/** 直接往库里塞章节记录——这个体检**只看库里的数据**，不读正文，所以不用造文件 */
function seed(db: ReturnType<typeof openDb>, title: string, chapters: Array<[string, number]>) {
  const bookId = Number(db.prepare('insert into book(title) values(?)').run(title).lastInsertRowid);
  const fileId = Number(
    db.prepare(`insert into book_file(book_id, path, size, mtime, is_primary, chapter_count, status)
                values(?,?,?,1,1,?, 'ok')`)
      .run(bookId, `C:/x/${title}.txt`, 999, chapters.length).lastInsertRowid,
  );
  chapters.forEach(([t, len], i) => {
    db.prepare('insert into chapter(file_id, idx, title, offset, length) values(?,?,?,?,?)')
      .run(fileId, i, t, i * 1000, len);
  });
  return bookId;
}

test('大半的章只有几十字节 → 报「切碎了」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const db = openDb(join(dir, 'l.db'));
  // 8 章里 6 章是碎的：正文里的选项行被当成了标题
  seed(db, '被切碎的', [
    ['【1、选项】', 30], ['【2、选项】', 28], ['【3、选项】', 33], ['【4、选项】', 25],
    ['【5、选项】', 31], ['【6、选项】', 29], ['第一章 真的', 8000], ['第二章 也真', 9000],
  ]);
  // 控制组：正常的书一本都不该被报出来
  seed(db, '正常的', Array.from({ length: 20 }, (_, i) => [`第${i + 1}章`, 6000] as [string, number]));

  const bad = suspiciousSplits(db);
  assert.equal(bad.length, 1, '正常的书不该被报出来');
  assert.equal(bad[0].title, '被切碎的');
  assert.equal(bad[0].kind, 'tiny');
  assert.match(bad[0].detail, /6 章不到 200 字节/);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('标题行写了两遍 → 报「重复」，而且不和「切碎」重复报', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const db = openDb(join(dir, 'l.db'));
  try {
    // 只重复、不算碎：10 章里 5 章是空壳，`small * 2 > count` 是 10 > 10 = false
    const rows: Array<[string, number]> = [];
    for (let i = 1; i <= 5; i++) { rows.push([`第${i}章`, 40]); rows.push([`第${i}章`, 7000]); }
    seed(db, '标题两遍的', rows);
    const bad = suspiciousSplits(db);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].kind, 'repeated');
    assert.match(bad[0].detail, /5 处标题重复/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('两类都中的书只报一条——重新解析一次就都处理了', () => {
  // **上一版这条测试是假的**：夹具只中了「重复」那一类，`tiny` 是空的、
  // `seen` 也是空的，于是把去重那一行整个删掉测试照样绿。
  // 要真走到去重，夹具必须**两条判据都中**。
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const db = openDb(join(dir, 'l.db'));
  try {
    const rows: Array<[string, number]> = [];
    // 6 组「空壳 + 空壳」：12 章全部短于 200（中 tiny），且 6 处同名紧邻（中 repeated）
    for (let i = 1; i <= 6; i++) { rows.push([`第${i}章`, 40]); rows.push([`第${i}章`, 60]); }
    seed(db, '两类都中的', rows);
    const bad = suspiciousSplits(db);
    assert.equal(bad.length, 1, '同一本书不该报两条——那会让人以为有两个问题');
    assert.equal(bad[0].kind, 'tiny', '两类都中时报更严重的那一类');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('同名但隔着一整章正文的不算重复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const db = openDb(join(dir, 'l.db'));
  try {
    seed(db, '真有同名章', [['楔子', 5000], ['楔子', 5000], ['楔子', 5000], ['楔子', 5000]]);
    assert.deepEqual(suspiciousSplits(db), [], '前一章有五千字节，不是空壳');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('屏蔽掉的、文件已经不在的，都不报', () => {
  // 屏蔽的书在书架上根本看不到，报出来等于让人去修一本不存在的书；
  // 文件缺失的书重解析会把 `missing` 改写成 `parse_failed`，
  // 而「需要处理」那一档和 `library.repair` 正是靠 missing 认出它们的
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const db = openDb(join(dir, 'l.db'));
  try {
    const tiny: Array<[string, number]> = Array.from({ length: 10 }, (_, i) => [`第${i}章`, 30]);
    const a = seed(db, '被屏蔽的', tiny);
    const b = seed(db, '文件没了的', tiny);
    db.prepare('update book_file set excluded = 1 where book_id = ?').run(a);
    db.prepare("update book_file set status = 'missing' where book_id = ?").run(b);
    assert.deepEqual(suspiciousSplits(db), []);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('章数用真实行数算，不信 chapter_count 那一列', () => {
  // 那一列是去规范化的，两边对不上时这个比例会悄悄失效——
  // 实测把它写成 100 而实际 10 章，整本书从报告里消失
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const db = openDb(join(dir, 'l.db'));
  try {
    const id = seed(db, '列写歪了的', Array.from({ length: 10 }, (_, i) => [`第${i}章`, 30] as [string, number]));
    db.prepare('update book_file set chapter_count = 100 where book_id = ?').run(id);
    assert.equal(suspiciousSplits(db).length, 1, 'chapter_count 不可信，要按真实行数算');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
