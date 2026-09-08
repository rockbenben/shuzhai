import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import {
  nextPending, recordResult, fetchStats, resetMisses, resetFailed, dropResults,
  resetForInfoBackfill,
} from './cover-source.ts';
import { addLink } from './links.ts';

let dir: string;
let db: DatabaseSync;

/** 直接造数据，不走扫描——队列只看 book 表和 cover_fetch 表 */
function addBook(title: string, author: string | null, coverPath: string | null = null): number {
  return Number(
    db.prepare('insert into book(title, author, cover_path) values(?,?,?)')
      .run(title, author, coverPath).lastInsertRowid,
  );
}

function setIntro(id: number, intro: string | null): void {
  db.prepare('update book set intro = ? where id = ?').run(intro, id);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-cover-'));
  db = openDb(join(dir, 'library.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('迁移 15 建出 cover_fetch 表', () => {
  const t = db.prepare("select name from sqlite_master where name = 'cover_fetch'").get();
  assert.ok(t, 'cover_fetch 表应该存在');
});

test('队列：没封面且没试过的才出队，按 id 顺序', () => {
  const a = addBook('甲', '某人');
  addBook('乙', '某人', 'C:/covers/has.jpg'); // 有封面，不该出队
  const c = addBook('丙', '某人');

  assert.equal(nextPending(db)!.id, a);
  recordResult(db, a, 'ok', 'qidian');
  assert.equal(nextPending(db)!.id, c, '记过结果的不再出队');
  recordResult(db, c, 'nomatch', 'qidian');
  assert.equal(nextPending(db), null, '全试过就空了');
});

test('队列 SQL 就是断点：记过结果的重启后天然跳过', () => {
  // 没有「进度」这个状态要存，也就没有它和现实脱节的可能
  const a = addBook('甲', '某人');
  const b = addBook('乙', '某人');
  recordResult(db, a, 'failed', 'qidian', '超时');
  assert.equal(nextPending(db)!.id, b);
});

test('统计四个数对得上', () => {
  const a = addBook('甲', '某人');
  const b = addBook('乙', '某人');
  addBook('丙', '某人');
  recordResult(db, a, 'ok', 'qidian');
  recordResult(db, b, 'nomatch', 'douban');
  assert.deepEqual(fetchStats(db), { pending: 1, done: 1, nomatch: 1, failed: 0 });
});

// 「重试没匹配上的」和「failed 回队列」是两码事，判据的可信度差着量级：
// nomatch 是问过了站上没有（实测重试 0/10），failed 是没问出来。捆在一起的话，
// 想把限流那几本捞回来就得连带发一百多次注定白打的请求——而那正是限流的成因
test('重试只删 nomatch，ok 和 failed 都不动', () => {
  const a = addBook('甲', '某人');
  const b = addBook('乙', '某人');
  const c = addBook('丙', '某人');
  recordResult(db, a, 'ok', 'qidian');
  recordResult(db, b, 'nomatch', 'qidian');
  recordResult(db, c, 'failed', 'qidian', '超时');

  assert.equal(resetMisses(db), 1);
  const left = db.prepare('select book_id from cover_fetch order by book_id').all().map((r) => ({ ...r }));
  assert.deepEqual(left, [{ book_id: a }, { book_id: c }], 'ok 和 failed 的行都要留着');
  assert.equal(nextPending(db)!.id, b, '删掉的重新进队列');
});

test('dropResults 只清指定的几本，空数组不拼出坏 SQL', () => {
  const a = addBook('甲', '某人');
  const b = addBook('乙', '某人');
  const c = addBook('丙', '某人');
  recordResult(db, a, 'nomatch', 'qidian');
  recordResult(db, b, 'nomatch', 'qidian');
  recordResult(db, c, 'ok', 'qidian');

  assert.equal(dropResults(db, []), 0, '空数组直接返回，别拼 in ()');
  assert.equal(dropResults(db, [a, b]), 2);
  const left = db.prepare('select book_id from cover_fetch').all().map((r) => ({ ...r }));
  assert.deepEqual(left, [{ book_id: c }], '没点名的不许动');
});

test('resetFailed 只删 failed——「没问出来」不该是终态', () => {
  const a = addBook('甲', '某人');
  const b = addBook('乙', '某人');
  const c = addBook('丙', '某人');
  recordResult(db, a, 'ok', 'qidian');
  recordResult(db, b, 'nomatch', 'qidian');
  recordResult(db, c, 'failed', 'qidian', '起点连续空结果，可能被限流');

  assert.equal(resetFailed(db), 1);
  // nextPending 只看「有没有行」不看状态，所以删掉就等于回队列
  assert.equal(nextPending(db)!.id, c, 'failed 的那本重新排到队里');
  assert.equal(fetchStats(db).nomatch, 1, 'nomatch 不受影响');
});

test('同一本书重复记结果是覆盖，不是报错', () => {
  const a = addBook('甲', '某人');
  recordResult(db, a, 'failed', 'qidian', '超时');
  recordResult(db, a, 'ok', 'qidian');
  assert.equal(fetchStats(db).done, 1);
  assert.equal(fetchStats(db).failed, 0);
});

test('队列：有封面但没简介、且有在线地址的书也出队（读地址补信息）', () => {
  const a = addBook('甲', '某人', 'C:/covers/a.jpg');
  addLink(db, a, 'https://www.qidian.com/book/1/');
  assert.equal(nextPending(db)!.id, a, '有链接没简介 → 该去读详情页');
});

test('队列：有封面没简介但没链接的不出队（搜不到地址就没法补）', () => {
  addBook('甲', '某人', 'C:/covers/a.jpg');
  assert.equal(nextPending(db), null);
});

test('队列：有封面有简介有链接的不出队', () => {
  const a = addBook('甲', '某人', 'C:/covers/a.jpg');
  addLink(db, a, 'https://www.qidian.com/book/1/');
  setIntro(a, '已有简介');
  assert.equal(nextPending(db), null);
});

test('队列：信息回填档的书记过 verdict 后不再出队', () => {
  const a = addBook('甲', '某人', 'C:/covers/a.jpg');
  addLink(db, a, 'https://www.qidian.com/book/1/');
  recordResult(db, a, 'ok', 'qidian');
  assert.equal(nextPending(db), null, '那一页真没简介也只试这一次');
});

test('统计的 pending 认新条件', () => {
  const a = addBook('甲', '某人', 'C:/covers/a.jpg');
  addLink(db, a, 'https://www.qidian.com/book/1/');
  addBook('乙', '某人', 'C:/covers/b.jpg'); // 有封面没链接
  assert.equal(fetchStats(db).pending, 1);
});

test('resetForInfoBackfill：只删「有链接没简介」的 verdict 行', () => {
  const a = addBook('甲', '某人', 'C:/covers/a.jpg');
  addLink(db, a, 'https://www.qidian.com/book/1/');
  recordResult(db, a, 'ok', 'qidian'); // 旧链跑的：有封面没简介

  const b = addBook('乙', '某人');
  recordResult(db, b, 'nomatch', 'qidian'); // 没链接，不该动

  const c = addBook('丙', '某人', 'C:/covers/c.jpg');
  addLink(db, c, 'https://www.qidian.com/book/3/');
  setIntro(c, '早就有简介');
  recordResult(db, c, 'ok', 'qidian'); // 有简介，不该动

  assert.equal(resetForInfoBackfill(db), 1);
  const left = db.prepare('select book_id from cover_fetch order by book_id').all().map((r) => ({ ...r }));
  assert.deepEqual(left, [{ book_id: b }, { book_id: c }]);
  assert.equal(nextPending(db)!.id, a, '删掉的书被队列捞回来走详情页那条路');
});
