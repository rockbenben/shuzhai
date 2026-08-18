/*
 * 「主文件坏了就换一份还好的」。
 *
 * 起因是用户真实库上的一本《乌纱》：两个文件，磁盘上被删掉的那份**恰好是主文件**，
 * 于是卡片挂着「文件不见了」，而 `book.list` 的 `path` 取的就是主文件——
 * **这本书因此打不开**，虽然另一份好好地在磁盘上。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { ensurePrimary } from './primary.ts';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'primary-'));
  db = openDb(join(dir, 'l.db'));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const 书 = (): number =>
  Number(db.prepare("insert into book(title) values('某本书')").run().lastInsertRowid);

const 文件 = (bookId: number, o: { status?: string; words?: number; primary?: boolean }): number =>
  Number(
    db.prepare(
      `insert into book_file(book_id, path, size, mtime, status, word_count, is_primary)
       values(?, ?, 1000, 1, ?, ?, ?)`,
    ).run(bookId, `D:/x/${Math.random()}.txt`, o.status ?? 'ok', o.words ?? 1000, o.primary ? 1 : 0)
      .lastInsertRowid,
  );

const 主 = (bookId: number): number | null => {
  const r = db.prepare('select id from book_file where book_id = ? and is_primary = 1').get(bookId) as
    | { id: number } | undefined;
  return r ? r.id : null;
};

/*
 * ⚠️ 这一条是这个模块里最要紧的：**用户自己设过的主版本不许被悄悄改掉。**
 * `version.setPrimary` 是他点的，扫描不能因为另一份字数更多就换过去。
 */
test('主文件还好用时一个字都不改，哪怕旁边那份更大', () => {
  const b = 书();
  const 小 = 文件(b, { words: 100, primary: true });
  文件(b, { words: 999999 });
  assert.equal(ensurePrimary(db, b), false, '没换');
  assert.equal(主(b), 小, '用户选的那份还在');
});

test('主文件坏了、旁边有好的 → 换过去', () => {
  const b = 书();
  文件(b, { status: 'missing', primary: true });
  const 好的 = 文件(b, { status: 'ok' });
  assert.equal(ensurePrimary(db, b), true);
  assert.equal(主(b), 好的);
});

/*
 * 都坏了就**不动**：换一个同样坏的没有意义，
 * 而且会让「这本书的主文件是哪个」变得没头没尾。
 */
test('主文件坏了、旁边也没好的 → 不动', () => {
  const b = 书();
  const 坏的 = 文件(b, { status: 'missing', primary: true });
  文件(b, { status: 'parse_failed' });
  assert.equal(ensurePrimary(db, b), false);
  assert.equal(主(b), 坏的, '仍然指着原来那个，不会变成没有主文件');
});

test('压根没有主文件（删掉之后、合并过来之后）→ 挑一个，优先状态好的', () => {
  const b = 书();
  文件(b, { status: 'missing', words: 999999 });   // 更大，但坏的
  const 好的 = 文件(b, { status: 'ok', words: 10 });
  assert.equal(ensurePrimary(db, b), true);
  assert.equal(主(b), 好的, '宁可要小的好文件，也不要大的坏文件');
});

test('都坏了而且没有主文件 → 仍然要挑一个出来，不能让这本书没有主文件', () => {
  const b = 书();
  文件(b, { status: 'missing', words: 10 });
  const 大的 = 文件(b, { status: 'missing', words: 999 });
  assert.equal(ensurePrimary(db, b), true);
  assert.equal(主(b), 大的);
});

test('一个文件都没有时什么都不做', () => {
  assert.equal(ensurePrimary(db, 书()), false);
});
