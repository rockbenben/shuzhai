import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate, SCHEMA_VERSION } from './db.ts';
import { setCover, clearCover, currentCover, coverDataUrl, coverDir } from './cover.ts';

let dir: string;
let userData: string;
let db: DatabaseSync;
let bookId: number;

/** 一个最小的合法 PNG（1×1 透明），够用来验证复制和 data URL */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-cover-'));
  userData = join(dir, 'userData');
  mkdirSync(userData);
  db = openDb(join(dir, 'library.db'));
  bookId = Number(db.prepare("insert into book(title) values('测试书')").run().lastInsertRowid);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeImage(name: string, data: Buffer = PNG): string {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}

test('封面会被复制进 userData，而不是引用原位置', async () => {
  const src = makeImage('下载来的封面.png');
  const { path } = await setCover(db, userData, bookId, src);

  assert.ok(path.startsWith(coverDir(userData)), '应该落在 userData/covers 下');
  assert.ok(existsSync(path));
  assert.equal(currentCover(db, bookId), path);

  // 原文件被删掉（模拟用户清理下载目录）之后，封面还得在
  rmSync(src);
  assert.ok(await coverDataUrl(db, bookId), '复制一份就是为了这个');
});

test('换封面会删掉旧文件，不攒垃圾', async () => {
  await setCover(db, userData, bookId, makeImage('一.png'));
  const first = currentCover(db, bookId)!;
  await setCover(db, userData, bookId, makeImage('二.png'));
  const second = currentCover(db, bookId)!;

  assert.notEqual(first, second);
  assert.ok(!existsSync(first), '旧封面已经没有任何引用了');
  assert.equal(readdirSync(coverDir(userData)).length, 1);
});

test('换封面时文件名会变，界面不会继续显示旧图', async () => {
  await setCover(db, userData, bookId, makeImage('一.png'));
  const a = currentCover(db, bookId);
  await new Promise((r) => setTimeout(r, 5));
  await setCover(db, userData, bookId, makeImage('二.png'));
  assert.notEqual(a, currentCover(db, bookId), '路径不变的话浏览器会拿缓存里的旧图');
});

test('不是图片的一律拒绝', async () => {
  await assert.rejects(() => setCover(db, userData, bookId, makeImage('木马.exe')), /不是认得的图片格式/);
  await assert.rejects(() => setCover(db, userData, bookId, makeImage('没扩展名')), /不是认得的图片格式/);
  assert.equal(currentCover(db, bookId), null, '失败时不能留下半截状态');
});

test('太大的图片拒绝', async () => {
  const big = makeImage('巨图.png', Buffer.alloc(9 * 1024 * 1024));
  await assert.rejects(() => setCover(db, userData, bookId, big), /图片太大/);
});

test('清封面会连文件一起删', async () => {
  await setCover(db, userData, bookId, makeImage('一.png'));
  const p = currentCover(db, bookId)!;
  await clearCover(db, bookId);

  assert.equal(currentCover(db, bookId), null);
  assert.ok(!existsSync(p));
  assert.equal(await coverDataUrl(db, bookId), null);
});

test('data URL 带正确的 mime', async () => {
  await setCover(db, userData, bookId, makeImage('封面.png'));
  const url = (await coverDataUrl(db, bookId))!;
  assert.ok(url.startsWith('data:image/png;base64,'), url.slice(0, 40));

  await setCover(db, userData, bookId, makeImage('封面.jpg'));
  assert.ok((await coverDataUrl(db, bookId))!.startsWith('data:image/jpeg;base64,'));
});

test('封面文件被外部删掉时，记录也一并清掉', async () => {
  await setCover(db, userData, bookId, makeImage('一.png'));
  rmSync(currentCover(db, bookId)!);

  assert.equal(await coverDataUrl(db, bookId), null);
  assert.equal(currentCover(db, bookId), null, '不清掉的话每次都要白读一次不存在的文件');
});

test('没有封面时返回 null，不报错', async () => {
  assert.equal(await coverDataUrl(db, bookId), null);
});

/*
 * 「占位色由书名决定，同一本书每次都一样」那条搬走了，不是删了：
 * 占位封面归渲染进程画（`renderer/cover-art.ts`），这个模块里那份实现
 * 只有这条测试在调，是死的。判据现在在 `renderer/cover-art.test.ts`。
 */

test('删书会连带删掉封面记录', async () => {
  await setCover(db, userData, bookId, makeImage('一.png'));
  db.prepare('delete from book where id = ?').run(bookId);
  assert.equal(currentCover(db, bookId), null);
});

const OLD_PATH = 'C:\\Users\\somebody\\AppData\\Roaming\\novel-manager\\covers\\12-1786812669012.jpg';
const NEW_PATH = 'C:\\Users\\somebody\\AppData\\Roaming\\shuzhai\\covers\\12-1786812669012.jpg';
const USER_DIR = 'D:\\novel-manager\\《剑来》作者：烽火戏诸侯.txt';

/*
 * 数据目录从 `novel-manager` 换成 `shuzhai` 那次（`src/main/migrate-userdata.ts`）
 * **把 covers 目录 rename 过去了，却没改写指向它的 `book.cover_path`**——那一列存的
 * 是绝对路径。真实库上量的：774 本有封面，**771 本的图片就躺在新目录里、
 * 只是那一列还写着旧目录**，真丢的 0 个。而它不报错：读不到就当没有封面，
 * 卡片照常画占位图，所以从搬家那天起一直静默地成立着。
 *
 * 迁移 18 收拾这个现场。测试放在这儿而不是新开一个 db 的测试文件——
 * 这条迁移讲的就是封面路径，而且 AGENTS.md 里有一段历史专门以
 * 「这个仓库里没有那个文件」举例，新开一个会让那段话变成错的。
 */
test('迁移 18：搬家之后，旧目录里的封面路径要改写到新目录', () => {
  const b = Number(db.prepare("insert into book(title) values('搬家前抓的封面')").run().lastInsertRowid);
  const 用户自己的目录 = Number(
    db.prepare("insert into book(title) values('书库文件夹里带这个词的书')").run().lastInsertRowid,
  );
  db.prepare('update book set cover_path = ? where id = ?').run(OLD_PATH, b);
  // **判据里必须带上 covers 那一段**：用户自己的书库文件夹也可能叫这个名字，
  // 那种路径一个字都不许动
  db.prepare('update book set cover_path = ? where id = ?').run(USER_DIR, 用户自己的目录);

  db.prepare('pragma user_version = 17').run();
  migrate(db);

  const got = (id: number) =>
    (db.prepare('select cover_path as p from book where id = ?').get(id) as { p: string }).p;
  assert.equal(got(b), NEW_PATH, '封面路径没跟着搬过去，那 771 张图就白抓了');
  assert.equal(got(用户自己的目录), USER_DIR, '误伤了用户自己的书库路径——那是铁律 1 的东西');
  assert.equal(
    (db.prepare('pragma user_version').get() as { user_version: number }).user_version,
    SCHEMA_VERSION,
  );
});

/*
 * **读不到 ≠ 文件没了。**
 *
 * `coverDataUrl` 读失败时会把 `cover_path` 清成 null（免得每次白读一次），
 * 而它原来是 `.catch(() => null)` 吞掉一切——被杀毒软件锁着、权限不对、
 * 路径成了目录，一律当成「文件没了」。**那些是暂时的，而清掉是永久的**：
 * 封面文件还躺在 covers 目录里，库里却再也不知道它属于哪本书。
 *
 * 第 108 轮量过这条的分量：真实库里 771 本指着搬家前的旧目录，
 * 只要被滚到屏幕上就会被这里清掉（迁移 18 赶在渲染之前跑，才救下来）。
 */
test('封面文件真被删了 → 记录跟着清掉', async () => {
  await setCover(db, userData, bookId, makeImage('会被删掉的.png'));
  const path = currentCover(db, bookId)!;
  assert.ok(path, '没落库');

  rmSync(path);
  assert.equal(await coverDataUrl(db, bookId), null);
  assert.equal(currentCover(db, bookId), null, '文件真没了，记录该清掉');
});

test('读不到但文件还在（比如成了目录）→ 记录一个字都不许动', async () => {
  await setCover(db, userData, bookId, makeImage('会变成目录的.png'));
  const path = currentCover(db, bookId)!;

  // 把那个文件换成同名目录：读它会得到 EISDIR/EPERM 之类，**不是 ENOENT**
  rmSync(path);
  mkdirSync(path);

  assert.equal(await coverDataUrl(db, bookId), null, '读不到就该返回 null');
  assert.equal(
    currentCover(db, bookId), path,
    '读失败的原因不是「没了」，记录不该被清——清掉是永久的，而这种失败是暂时的',
  );
});

/*
 * **报错要说得出「怎么办」。** 这两条是用户能从界面直接撞上的：挑了一个不是图片的
 * 文件、或者开了自动备份却没选文件夹。原来它们只说「不认得」「还没选」——
 * 而用户此刻要知道的是「那认得哪些」「去哪儿选」。
 * 同 `fonts.ts` 那条（它早就把支持的格式列出来了）和 `reader.ts` 的 `openHint`。
 */
test('挑了不是图片的文件：把认得的格式列出来', async () => {
  await assert.rejects(
    () => setCover(db, userData, bookId, join(dir, '不是图片.txt')),
    (e: Error) => /不是认得的图片格式/.test(e.message) && /\.png/.test(e.message) && /\.webp/.test(e.message),
  );
});
