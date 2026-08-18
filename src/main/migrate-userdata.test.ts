// 这个函数是「改名不丢库」唯一的一道保险（铁律 3：阅读进度和书签重扫恢复不了）。
// 它一辈子只在一台机器上跑一次，所以**永远不会有人报它坏了**——真出事的样子是
// 应用在一个空目录里重新开张，一句错都不报。守卫只能写在这儿。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateUserData, leftovers } from './migrate-userdata.ts';

let root: string;
let 旧: string;
let 新: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shuzhai-migrate-'));
  旧 = join(root, 'novel-manager');
  新 = join(root, 'shuzhai');
  mkdirSync(旧, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * 造一个**尾部事务还压在 -wal 里**的库——迁移要防的就是这一种。
 *
 * ⚠️ 不能写完直接 `close()`：最后一个连接关掉时 sqlite 自己会 checkpoint 并删掉
 * -wal，造出来的是个已经落盘的库，**那条判据就空转了**。
 * 所以在暂存目录里留第二个连接吊着 WAL，把三个文件原样拷到旧目录，再把连接关掉。
 */
function 造旧库(dir: string, 书名: string[]): void {
  const stage = mkdtempSync(join(root, 'stage-'));
  const p = join(stage, 'library.db');
  const 写 = new DatabaseSync(p);
  写.exec('pragma journal_mode = WAL');
  写.exec('create table book(id integer primary key, title text)');
  for (const t of 书名) 写.prepare('insert into book(title) values(?)').run(t);

  const 吊着 = new DatabaseSync(p); // 只要它还开着，关掉「写」就不会 checkpoint
  吊着.prepare('select count(*) as n from book').get();
  写.close();

  for (const 后缀 of ['', '-wal', '-shm']) {
    if (existsSync(p + 后缀)) copyFileSync(p + 后缀, join(dir, 'library.db' + 后缀));
  }
  吊着.close();
  rmSync(stage, { recursive: true, force: true });
}

const 读书名 = (dir: string): string[] => {
  const db = new DatabaseSync(join(dir, 'library.db'), { readOnly: true });
  try {
    return (db.prepare('select title from book order by id').all() as { title: string }[]).map((r) => r.title);
  } finally {
    db.close();
  }
};

test('没有旧库就什么都不做', () => {
  assert.equal(migrateUserData(旧, 新), null);
  assert.equal(existsSync(join(新, 'library.db')), false);
});

test('新旧同一个目录，直接不管', () => {
  造旧库(旧, ['甲']);
  assert.equal(migrateUserData(旧, 旧), null);
  assert.deepEqual(读书名(旧), ['甲']);
});

test('新库已经在了，绝不覆盖——旧的原封不动留着', () => {
  造旧库(旧, ['旧的']);
  mkdirSync(新, { recursive: true });
  造旧库(新, ['新的']);

  assert.equal(migrateUserData(旧, 新), null);
  assert.deepEqual(读书名(新), ['新的'], '新库不许被旧库盖掉');
  assert.deepEqual(读书名(旧), ['旧的'], '旧库也不许被搬走');
});

test('搬家：库、封面、备份都到位，而且**尾部已提交的事务一条都不能少**', () => {
  // 踩过的那一次：三个文件一起 rename，-shm 是陈旧的派生数据，
  // sqlite 据它认定 WAL 只到某个位置，尾部两条已提交的事务被无声丢掉
  造旧库(旧, ['第一本', '第二本', '最后写进去的那本']);
  assert.ok(existsSync(join(旧, 'library.db-wal')), '前提：这个库的 WAL 还没落盘');

  mkdirSync(join(旧, 'covers'), { recursive: true });
  writeFileSync(join(旧, 'covers', 'a.jpg'), 'JPG');
  mkdirSync(join(旧, 'backups'), { recursive: true });
  writeFileSync(join(旧, 'backups', 'b.json'), '{}');

  const r = migrateUserData(旧, 新);
  assert.deepEqual(r?.moved, ['covers', 'backups', 'library.db']);
  assert.deepEqual(读书名(新), ['第一本', '第二本', '最后写进去的那本']);
  assert.equal(readFileSync(join(新, 'covers', 'a.jpg'), 'utf8'), 'JPG');
  assert.equal(readFileSync(join(新, 'backups', 'b.json'), 'utf8'), '{}');

  // -wal / -shm 是派生数据，checkpoint 之后不搬也不留
  assert.equal(existsSync(join(旧, 'library.db-wal')), false);
  assert.equal(existsSync(join(旧, 'library.db-shm')), false);
  assert.equal(existsSync(join(旧, 'library.db')), false);
});

test('中途挂了能接着来：封面已经过去了，再跑一次把库补齐', () => {
  造旧库(旧, ['甲', '乙']);
  mkdirSync(join(旧, 'covers'), { recursive: true });
  writeFileSync(join(旧, 'covers', 'a.jpg'), 'JPG');

  // 模拟上一次只搬到一半就断电：covers 过去了，library.db 还在旧目录
  mkdirSync(新, { recursive: true });
  mkdirSync(join(新, 'covers'), { recursive: true });
  writeFileSync(join(新, 'covers', 'a.jpg'), 'JPG');

  const r = migrateUserData(旧, 新);
  assert.deepEqual(r?.moved, ['library.db'], '已经在新目录的那些不重搬，也不报错');
  assert.deepEqual(读书名(新), ['甲', '乙']);
});

test('搬完之后旧目录里还剩什么，说得出来（用来问用户能不能删）', () => {
  造旧库(旧, ['甲']);
  mkdirSync(join(旧, 'Cache'), { recursive: true });
  migrateUserData(旧, 新);
  assert.deepEqual(leftovers(旧), ['Cache'], 'Chromium 的缓存不搬，留在那儿');
  assert.deepEqual(leftovers(join(root, '根本没有这个目录')), []);
});
