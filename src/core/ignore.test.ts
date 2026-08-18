import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { listBooks, shelfCounts } from './library.ts';
import {
  DEFAULT_IGNORE,
  loadIgnore,
  saveIgnore,
  validateGlob,
  globForDir,
  isIgnored,
  previewIgnore,
  applyIgnoreToLibrary,
  hiddenByPatterns,
} from './ignore.ts';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-ig-'));
  db = openDb(join(dir, 'library.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('没设过就是默认规则', () => {
  assert.deepEqual(loadIgnore(db), DEFAULT_IGNORE);
});

test('存取往返，顺带去重去空', () => {
  saveIgnore(db, ['  a/** ', 'b/**', 'a/**', '', '   ']);
  assert.deepEqual(loadIgnore(db), ['a/**', 'b/**']);
});

test('设置存坏了回落到默认，不让扫描起不来', () => {
  db.prepare("insert into app_setting(key, value) values('scan.ignore', '这不是 JSON')").run();
  assert.deepEqual(loadIgnore(db), DEFAULT_IGNORE);
});

test('匹配判据和扫描里那套一致', () => {
  assert.ok(isIgnored('备份2024/某书.txt', ['**/*备份*/**']));
  assert.ok(!isIgnored('正常/某书.txt', ['**/*备份*/**']));
  // Windows 的反斜杠路径也要认
  assert.ok(isIgnored('备份2024\\某书.txt', ['**/*备份*/**']));

  // `**/.*` 匹配的是**目录本身**：scan.ts 的 walk 是逐层判的，
  // `.git` 这个目录整个被跳过，里面的文件根本轮不到被测。
  // 所以写屏蔽规则时要按「目录名」想，不是按「文件路径」想
  assert.ok(isIgnored('.git', ['**/.*']), '隐藏目录本身要被挡下');
  assert.ok(!isIgnored('.git/config', ['**/.*']), '这一层压根不会被走到，不是它的职责');
});

test('坏规则当作不匹配，不能因为它把所有文件都挡了', () => {
  assert.equal(isIgnored('某书.txt', ['[未闭合']), false);
  assert.ok(isIgnored('备份/某书.txt', ['[未闭合', '**/备份/**']), '别的规则照常生效');
});

test('从选中的目录生成规则', () => {
  assert.equal(globForDir('D:\\books', 'D:\\books\\临时'), '临时/**');
  assert.equal(globForDir('D:\\books', 'D:\\books\\a\\b'), 'a/b/**');
  assert.throws(() => globForDir('D:\\books', 'E:\\别处'), /不在任何书库文件夹/);
  assert.throws(() => globForDir('D:\\books', 'D:\\books'), /不在任何书库文件夹/);
});

test('空规则和坏 glob 要当场报错', () => {
  assert.throws(() => validateGlob('   '), /不能为空/);
  assert.doesNotThrow(() => validateGlob('**/备份/**'));
});

/** 造几本落在不同子目录的书 */
function seed() {
  const rootId = Number(
    db.prepare("insert into library_root(path) values('D:\\books')").run().lastInsertRowid,
  );
  const add = (rel: string, percent = 0) => {
    const bookId = Number(db.prepare('insert into book(title) values(?)').run(rel).lastInsertRowid);
    db.prepare('insert into reading_state(book_id, percent) values(?, ?)').run(bookId, percent);
    db.prepare(
      'insert into book_file(book_id, root_id, path, size, mtime, is_primary) values(?,?,?,1,1,1)',
    ).run(bookId, rootId, `D:\\books\\${rel}`);
  };
  add('正常\\甲.txt');
  add('正常\\乙.txt', 42);
  add('临时\\丙.txt');
  add('临时\\子目录\\丁.txt', 88);
  return rootId;
}

test('预览：这条规则会挡掉哪些已入库的书', () => {
  seed();
  const p = previewIgnore(db, ['临时/**']);

  assert.equal(p.affected, 2);
  assert.equal(p.withProgress, 1, '其中一本有进度，得提醒用户');
  assert.ok(p.samples.every((s) => s.includes('临时')));
});

test('少一个星号就从「挡一个子目录」变成「什么都没挡」——所以预览不能省', () => {
  seed();
  // 用户想挡 D:\books\临时，写成了 `**/临时/**`（多了前缀）在这个层级下也能中；
  // 但写成 `临时`（少了 /**）就一个都挡不住
  assert.equal(previewIgnore(db, ['临时/**']).affected, 2);
  assert.equal(previewIgnore(db, ['临时']).affected, 0, '写错了却没有任何报错，只能靠预览发现');
});

test('屏蔽不删书——只是不再扫，记录和进度都留着', () => {
  seed();
  const before = (db.prepare('select count(*) n from book').get() as { n: number }).n;
  saveIgnore(db, ['临时/**']);
  previewIgnore(db, loadIgnore(db));

  assert.equal(
    (db.prepare('select count(*) n from book').get() as { n: number }).n,
    before,
    '这个模块一本书都不该删',
  );
  assert.equal(
    (db.prepare("select percent from reading_state where percent > 0 limit 1").get() as { percent: number })
      .percent,
    42,
    '进度也不能动',
  );
});

test('屏蔽会落到 excluded 位上，且不删任何书', () => {
  seed();
  saveIgnore(db, ['临时/**']);
  const r = applyIgnoreToLibrary(db);

  assert.equal(r.excluded, 2);
  assert.equal((db.prepare('select count(*) n from book').get() as { n: number }).n, 4, '一本都不能删');
  assert.equal(
    (db.prepare('select count(*) n from book_file where excluded = 1').get() as { n: number }).n,
    2,
  );

  // 书架默认看不到它们，但「已屏蔽」那一档还找得回来
  assert.equal(listBooks(db).length, 2);
  assert.equal(listBooks(db, { excluded: 'only' }).length, 2);
  assert.equal(listBooks(db, { excluded: 'all' }).length, 4);
});

test('去掉规则后被屏蔽的书原样回来', () => {
  seed();
  saveIgnore(db, ['临时/**']);
  applyIgnoreToLibrary(db);
  assert.equal(listBooks(db).length, 2);

  saveIgnore(db, []);
  const back = applyIgnoreToLibrary(db);
  assert.equal(back.restored, 2);
  assert.equal(listBooks(db).length, 4, '书一直都在，只是之前不显示');
});

test('停用整个目录 = 它下面的书都不显示', () => {
  const rootId = seed();
  db.prepare('update library_root set enabled = 0 where id = ?').run(rootId);
  applyIgnoreToLibrary(db);

  assert.equal(listBooks(db).length, 0);
  assert.equal((db.prepare('select count(*) n from book').get() as { n: number }).n, 4, '仍然一本没删');
});

test('目录登记被移除时不算屏蔽——换个目录管理不该让书全消失', () => {
  seed();
  db.prepare('update book_file set root_id = null').run();
  applyIgnoreToLibrary(db);
  assert.equal(listBooks(db).length, 4);
});

test('侧栏计数把被屏蔽的排除掉，否则数字和列表对不上', () => {
  seed();
  saveIgnore(db, ['临时/**']);
  applyIgnoreToLibrary(db);

  const c = shelfCounts(db);
  assert.equal(c.all, 2, '「全部」写 4 但点进去只有 2，用户会以为列表坏了');
  assert.equal(c.excluded, 2, '被屏蔽的数量要单独告诉用户，让他知道书还在');
});

/*
 * **预览和生效必须问同一个函数。**
 *
 * 这两处原来各写了一遍判据，而且**已经分叉了一条**：生效那头有
 * `!isAbsolute(rel)`（`relative()` 跨盘时返回的是绝对路径，那种文件根本不在
 * 这个目录下），预览那头没有——于是它会被算进「会挡掉 N 本」，实际却不会被挡。
 *
 * 这条测试钉的是**两边给同一个答案**，而不是某一边的具体行为：
 * 哪天有人只改一处，它当场就红。
 */
test('预览和生效用同一个判据：跨盘的路径两边都不算', () => {
  const 同盘 = hiddenByPatterns('D:/书库', 'D:/书库/备份/旧版.txt', ['备份/**']);
  assert.equal(同盘, true, '就在这个目录下、又匹配规则，该挡');

  /*
   * `relative('D:/书库', 'C:/别处/…')` 在 Windows 上返回的是**绝对路径**。
   *
   * ⚠️ **规则要挑一个「跨盘那条路径也匹配得上」的**，否则这条诱饵测的不是
   * `isAbsolute` 那一句：`备份/**` 锚在开头，`C:/别处/备份/…` 本来就匹配不上，
   * 去不去掉那句话结果都是 false——第一版就是这么写的，破坏实验一声不吭。
   * 用 `**` 开头的规则才逼得出真判据。
   */
  const 跨盘 = hiddenByPatterns('D:/书库', 'C:/别处/备份/旧版.txt', ['**/旧版.txt']);
  assert.equal(跨盘, false, '压根不在这个书库文件夹下，不该算它被这条规则挡住');
  // 反向对照：同一条规则、同一个盘上的文件，必须挡得住（否则上一句只是碰巧为 false）
  assert.equal(hiddenByPatterns('D:/书库', 'D:/书库/备份/旧版.txt', ['**/旧版.txt']), true);

  const 不匹配 = hiddenByPatterns('D:/书库', 'D:/书库/正常的书.txt', ['备份/**']);
  assert.equal(不匹配, false);
});

test('预览说会挡几本，保存之后就真挡几本', () => {
  const lib = join(dir, 'lib2');
  mkdirSync(lib);
  mkdirSync(join(lib, '备份'));
  const rootId = Number(db.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid);
  const add = (rel: string) => {
    const p = join(lib, rel);
    writeFileSync(p, 'x');
    const b = Number(db.prepare('insert into book(title) values(?)').run(rel).lastInsertRowid);
    db.prepare('insert into book_file(book_id, root_id, path, size, mtime, content_hash, is_primary) values(?,?,?,1,1,?,1)')
      .run(b, rootId, p, rel);
  };
  add('正常的书.txt');
  add(join('备份', '旧版.txt'));
  add(join('备份', '再旧一版.txt'));

  const pats = ['备份/**'];
  const pv = previewIgnore(db, pats);
  saveIgnore(db, pats);
  const ap = applyIgnoreToLibrary(db);
  assert.equal(pv.affected, 2);
  assert.equal(ap.excluded, pv.affected, '预览说的数和真挡掉的数必须一样');
});

/*
 * **中文书库的目录名常常带方括号**（`[完结]`、`[精校]`、`[TXT]`），
 * 而屏蔽规则是 glob——`[` 是字符类的开头。
 *
 * 改之前点「屏蔽这个文件夹」，生成的是 `[完结]/**`：**一本都挡不住，也不报错**。
 * 用户加了一条规则，什么都没发生。
 *
 * `*` `?` 是反过来的毛病：目录真叫 `第*卷` 时，`第*卷/**` 会把
 * **`第一卷`、`第二卷` 全挡掉**——挡的是用户没点的那些。
 */
test('从带元字符的文件夹名生成规则：挡得住自己，而且不误伤别人', () => {
  const 量 = (name: string, 别的: string) => {
    const g = globForDir('D:/书库', `D:/书库/${name}`);
    return { g, 自己: isIgnored(`${name}/书.txt`, [g]), 误伤: isIgnored(`${别的}/书.txt`, [g]) };
  };

  const 方括号 = 量('[完结]', '完结');
  assert.equal(方括号.自己, true, `方括号目录挡不住自己：${方括号.g}`);
  assert.equal(方括号.误伤, false);

  const 星号 = 量('第*卷', '第一卷');
  assert.equal(星号.自己, true);
  assert.equal(星号.误伤, false, '会把「第一卷」「第二卷」一起挡掉——那是用户没点的');

  const 问号 = 量('a?b', 'axb');
  assert.equal(问号.自己, true);
  assert.equal(问号.误伤, false);

  // 普通名字一个字都不该变
  assert.equal(globForDir('D:/书库', 'D:/书库/备份'), '备份/**');
});

/*
 * `{…,…}` 是唯一没救的一种：花括号展开发生在匹配之前，
 * `[{]`、反斜杠转义都试过，一律匹配不上；而原样写会挡住**展开出来的那些名字**
 * （`{完结,精校}/**` 挡的是 `完结/`）。**生成一条会挡错东西的规则比不生成更糟。**
 */
test('文件夹名里有「{…,…}」时明说表达不了，并指出怎么办', () => {
  assert.throws(
    () => globForDir('D:/书库', 'D:/书库/{完结,精校}'),
    (e: Error) => /表达不了/.test(e.message) && /手写|预览/.test(e.message),
  );
  // 没有逗号的花括号是能表达的，别误拒
  assert.doesNotThrow(() => globForDir('D:/书库', 'D:/书库/{完结}'));
});
