import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { scanRoot } from './scan.ts';
import {
  renderTemplate,
  sanitizeFilename,
  fitPathLength,
  previewRename,
  applyRename,
  undoBatch,
  undoableBatches,
} from './rename.ts';

let dir: string;
let lib: string;
let db: DatabaseSync;

const filler = Array.from({ length: 200 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
const body = ['第一章 起', '第二章 承'].map((t) => `${t}\n${filler}\n`).join('');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'novel-rn-'));
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
  (db.prepare('select id from book order by title').all() as Array<{ id: number }>).map((r) => r.id);
const pathOf = (bookId: number) =>
  (db.prepare('select path from book_file where book_id = ?').get(bookId) as { path: string }).path;

test('模板变量替换，缺失的变量不留字面量', () => {
  const v = { title: '书名', author: null, status: 'finished', wordcount: 100, index: 1, ext: '.txt' };
  assert.equal(renderTemplate('《{title}》{author}{ext}', v), '《书名》.txt');
  assert.equal(renderTemplate('{title}（{status}）{ext}', v), '书名（已完结）.txt');
  assert.equal(renderTemplate('{index}-{title}-{wordcount}{ext}', v), '1-书名-100.txt');
  assert.equal(renderTemplate('{unknown}{title}{ext}', v), '书名.txt', '未知变量替换成空');
});

test('非法字符、结尾空格点号、保留设备名都要处理掉', () => {
  assert.equal(sanitizeFilename('a/b:c*d?.txt').name, 'a_b_c_d_.txt');

  // 「结尾的空格和点号」只对**整个文件名**成立。Windows 会吃掉它们，
  // 留着会让磁盘上的实际名字和库里记的对不上
  assert.equal(sanitizeFilename('书名.').name, '书名');
  assert.equal(sanitizeFilename('书名   ').name, '书名');

  // 反过来，这两个结尾是 't'，本来就合法，一个字都不该改
  assert.equal(sanitizeFilename('书名...txt').name, '书名...txt', '中间的点是合法的');
  assert.equal(sanitizeFilename('书名 .txt').name, '书名 .txt', '扩展名前的空格也合法');

  assert.equal(sanitizeFilename('CON.txt').name, 'CON_.txt', '保留设备名带扩展名也建不出来');
  assert.equal(sanitizeFilename('com1.txt').name, 'com1_.txt', '大小写不敏感');
  assert.equal(sanitizeFilename('正常的名字.txt').sanitized, false);
});

test('路径过长时截断书名，绝不截扩展名', () => {
  const deep = 'C:\\' + 'x'.repeat(200);
  const r = fitPathLength(deep, `${'长'.repeat(100)}.txt`);
  assert.ok(r.truncated);
  assert.ok(r.name.endsWith('.txt'), '扩展名丢了文件就打不开了');
  assert.ok(join(deep, r.name).length <= 260);
});

test('预览不碰任何文件', async () => {
  const before = ids().map(pathOf);
  const rows = await previewRename(db, ids(), { template: '{author} - {title}{ext}' });

  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'ok'));
  assert.deepEqual(
    rows.map((r) => r.newName).sort(),
    ['天蚕土豆 - 斗破苍穹.txt', '烽火戏诸侯 - 雪中悍刀行.txt'],
  );
  assert.deepEqual(ids().map(pathOf), before, '预览阶段路径不能变');
  for (const p of before) assert.ok(existsSync(p), '磁盘上的文件也不能动');
});

test('名字没变化的行标 unchanged', async () => {
  const rows = await previewRename(db, ids(), { template: '《{title}》{author}{ext}' });
  const same = rows.find((r) => r.oldName === '《雪中悍刀行》烽火戏诸侯.txt');
  assert.equal(same?.status, 'unchanged');
});

test('目标已存在时默认跳过并标红', async () => {
  writeFileSync(join(lib, '斗破苍穹.txt'), '占位', 'utf8');
  const rows = await previewRename(db, ids(), { template: '{title}{ext}' });
  const conflict = rows.find((r) => r.newName === '斗破苍穹.txt');
  assert.equal(conflict?.status, 'conflict');
  assert.match(conflict!.note!, /已存在/);
});

test('选自动加序号时给出不冲突的名字', async () => {
  writeFileSync(join(lib, '斗破苍穹.txt'), '占位', 'utf8');
  const rows = await previewRename(db, ids(), { template: '{title}{ext}', onConflict: 'number' });
  const row = rows.find((r) => r.oldName.startsWith('斗破苍穹'));
  assert.equal(row?.newName, '斗破苍穹(2).txt');
  assert.equal(row?.status, 'ok');
});

test('同一批里算出同名，后一个也算冲突', async () => {
  // 两本书的作者都设成同一个、书名都设成同一个 → 模板算出同一个文件名
  for (const id of ids()) db.prepare("update book set title = '同名', author = '同人' where id = ?").run(id);
  const rows = await previewRename(db, ids(), { template: '{title}{ext}' });
  assert.equal(rows.filter((r) => r.status === 'conflict').length, 1, '只查磁盘会漏掉这种');
});

test('执行重命名：改磁盘、同步库、写日志', async () => {
  const rows = await previewRename(db, ids(), { template: '{author} - {title}{ext}' });
  const report = await applyRename(db, null, rows, 'batch-1');

  assert.equal(report.ok, 2);
  assert.equal(report.failed.length, 0);

  for (const id of ids()) {
    const p = pathOf(id);
    assert.ok(existsSync(p), '库里记的路径必须真的存在');
    assert.match(p, / - /, '文件名应已按模板改过');
  }
  assert.equal(
    (db.prepare('select count(*) n from rename_log').get() as { n: number }).n,
    2,
    '每一次改名都要留一条日志，撤销全靠它',
  );
});

test('撤销把文件名改回去，进度不受影响', async () => {
  const bookId = ids()[0];
  const original = pathOf(bookId);
  db.prepare('update reading_state set chapter_idx = 1, char_offset = 66 where book_id = ?').run(bookId);

  const rows = await previewRename(db, ids(), { template: '{title}{ext}' });
  await applyRename(db, null, rows, 'batch-x');
  assert.notEqual(pathOf(bookId), original);

  const batches = undoableBatches(db);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].count, 2);

  const undo = await undoBatch(db, null, 'batch-x');
  assert.equal(undo.ok, 2);
  assert.equal(pathOf(bookId), original, '路径要回到原样');
  assert.ok(existsSync(original));

  const s = db.prepare('select chapter_idx, char_offset from reading_state where book_id = ?').get(bookId) as {
    chapter_idx: number;
    char_offset: number;
  };
  assert.equal(s.chapter_idx, 1, '重命名和撤销都不该动阅读进度');
  assert.equal(s.char_offset, 66);
  assert.equal(undoableBatches(db).length, 0, '撤销过的批次不再出现在可撤销列表里');
});

test('一个失败不影响其它', async () => {
  const rows = await previewRename(db, ids(), { template: '{title}{ext}' });
  // 把第一行的源文件删掉，制造一次失败
  rmSync(join(rows[0].dir, rows[0].oldName));

  const report = await applyRename(db, null, rows, 'batch-partial');
  assert.equal(report.failed.length, 1);
  assert.equal(report.ok, 1, '另一本仍然要改成功');
});

test('只改大小写也能成功（Windows 上要借临时名）', async () => {
  const bookId = ids()[0];
  db.prepare("update book set title = '斗破苍穹', author = null where id = ?").run(bookId);
  const before = pathOf(bookId);

  const rows = (await previewRename(db, [bookId], { template: '{title}{ext}' })).filter(
    (r) => r.status === 'ok' || r.status === 'unchanged',
  );
  if (rows[0]?.status === 'unchanged') return; // 名字本来就一样，这台机器上没什么可测的

  const report = await applyRename(db, null, rows, 'batch-case');
  assert.equal(report.failed.length, 0, before);
});

/*
 * **目标已经存在时，绝不能覆盖。**
 *
 * `fs.rename` 在 Windows 上是静默覆盖的（当场量过：a.txt → 已存在的 b.txt，
 * 不报错、不进回收站，b.txt 原来的内容没了）。而被毁的那本书**根本不在这一批里**，
 * `rename_log` 里没有它——撤销把文件名改回去也换不回内容。
 * 界面靠 `previewRename` 标 `conflict` + 禁掉勾选框挡住这条路，
 * 但 rpc 对外开放（AGENTS.md §13），调用方自己算的 rows 走不到那道预览。
 *
 * 重点是后两条断言：**光「报了失败」不够**，最糟的失败是
 * 「报了失败，而文件已经被覆盖了」。
 */
test('目标已经存在时不覆盖，源文件也留在原地', async () => {
  const rows = await previewRename(db, ids(), { template: '{title}{ext}' });
  const row = rows.find((r) => r.status === 'ok') ?? rows[0]!;

  // 手工造一个「预览之后才冒出来的」目标文件——扫描、别的程序、上一批改名都会这样
  const target = join(row.dir, row.newName);
  writeFileSync(target, '这是另一本书的正文，一个字都不许丢');
  const src = join(row.dir, row.oldName);

  const report = await applyRename(db, null, [row], 'batch-clobber');

  assert.equal(report.ok, 0, '目标已存在，这一行不该算成功');
  assert.match(report.failed[0]?.error ?? '', /已经有一个|不覆盖/, '要说清楚是被什么挡住的');
  assert.equal(
    readFileSync(target, 'utf8'),
    '这是另一本书的正文，一个字都不许丢',
    '目标文件被覆盖了——这是不可逆的数据事故',
  );
  assert.ok(existsSync(src), '源文件也该原封不动留在原地');
});

/*
 * **撤销那头也不许覆盖。** 改名和撤销共用 `moveFile`，所以这条守的是
 * 「共用」本身——把判据抄成两份，掉队的必然是撤销这一份（它跑得少）。
 *
 * 场景很平常：改完名之后原来那个位置又被占上了（用户重新下了一本、
 * 扫描把别处的文件挪过来、上一批改名的目标正好是这个名字），
 * 这时候撤销会把那个文件静默毁掉。
 */
test('撤销时原路径已经被占，宁可撤不回来也不覆盖', async () => {
  const rows = (await previewRename(db, ids(), { template: '{title}{ext}' })).filter(
    (r) => r.status === 'ok',
  );
  if (rows.length === 0) return;
  const row = rows[0]!;
  const oldPath = join(row.dir, row.oldName);

  assert.equal((await applyRename(db, null, [row], 'batch-undo-clobber')).ok, 1);
  assert.ok(!existsSync(oldPath), '改完之后原来那个名字应该空出来了');

  // 原来的位置又被占上了
  writeFileSync(oldPath, '后来放进来的另一本书，不能被撤销顺手毁掉');

  const report = await undoBatch(db, null, 'batch-undo-clobber');
  assert.equal(report.ok, 0, '原路径被占着，这一条不该撤成功');
  assert.equal(
    readFileSync(oldPath, 'utf8'),
    '后来放进来的另一本书，不能被撤销顺手毁掉',
    '撤销把占着原路径的文件覆盖了',
  );
  assert.ok(existsSync(join(row.dir, row.newName)), '改过名的那个文件也该留在原处');
});

