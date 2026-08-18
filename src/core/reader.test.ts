import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { scanRoot } from './scan.ts';
import { FileCache, readChapter, saveProgress, lastRead, openHint, openBook, readBook, markOpened, markFinished } from './reader.ts';

let dir: string;
let db: DatabaseSync;
let cache: FileCache;
let bookId: number;

const CHAPTERS = ['第一章 初入江湖', '第二章 客栈遇故人', '第三章 雪夜刀光'];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'novel-read-'));
  db = openDb(join(dir, 'library.db'));
  const lib = join(dir, 'books');
  mkdirSync(lib);
  const rootId = Number(
    db.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid,
  );

  // 每章正文里塞一句能认出来的标记，读回来时好核对
  const filler = Array.from({ length: 200 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
  const text = CHAPTERS.map((t, i) => `${t}\n【这是第${i}章的正文】\n${filler}\n`).join('');
  writeFileSync(join(lib, '《测试书》某作者.txt'), text, 'utf8');

  await scanRoot(db, { id: rootId, path: lib });
  bookId = (db.prepare('select id from book').get() as { id: number }).id;
  cache = new FileCache();
});

afterEach(async () => {
  await cache.releaseAll();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('按字节偏移读回来的正是那一章', async () => {
  for (let i = 0; i < CHAPTERS.length; i++) {
    const ch = await readChapter(db, cache, bookId, i);
    assert.equal(ch.title, CHAPTERS[i]);
    assert.equal(ch.total, 3);
    assert.ok(ch.text.startsWith(CHAPTERS[i]), '正文应从标题行开始');
    assert.ok(ch.text.includes(`【这是第${i}章的正文】`), '不能串章');
    // 不该把下一章的内容也读进来
    const next = CHAPTERS[i + 1];
    if (next) assert.ok(!ch.text.includes(next), `第 ${i} 章不该含有下一章的标题`);
  }
});

test('句柄缓存不超过上限，且能主动释放', async () => {
  const small = new FileCache(2);
  const lib = join(dir, 'books');
  const filler = Array.from({ length: 200 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
  for (const name of ['甲.txt', '乙.txt', '丙.txt']) {
    writeFileSync(join(lib, name), `第一章 起\n${filler}\n第二章 承\n${filler}\n`, 'utf8');
    await small.read(join(lib, name), 0, 10);
  }
  assert.equal(small.openCount, 2, '超出上限的最旧句柄应被关掉');

  await small.release(join(lib, '丙.txt'));
  assert.equal(small.openCount, 1);
  await small.releaseAll();
  assert.equal(small.openCount, 0);
});

test('释放句柄之后文件才能改名（重命名功能依赖这条）', async () => {
  const lib = join(dir, 'books');
  const path = join(lib, '《测试书》某作者.txt');
  await readChapter(db, cache, bookId, 0); // 现在句柄开着

  const target = join(lib, '改过名.txt');
  await cache.release(path);
  renameSync(path, target); // 释放之后才允许改名
  assert.ok(true, '改名成功');
  renameSync(target, path);
});

test('读到最后一章之外要报错，不能返回空内容', async () => {
  await assert.rejects(() => readChapter(db, cache, bookId, 99), /没有第 99 章/);
});

test('保存进度会算出百分比，并把还没表过态的书推进到「在读」', () => {
  // 扫进来的默认是 `none`（未标记），不是「想读」——「想读」是用户的表态，
  // 不该由扫描替他说（db.ts 迁移 17）
  const before = db.prepare('select status from reading_state where book_id = ?').get(bookId) as {
    status: string;
  };
  assert.equal(before.status, 'none');

  const { percent } = saveProgress(db, bookId, 1, 42);
  assert.equal(Math.round(percent), 67, '第 2/3 章读完约 67%');

  const after = db.prepare('select * from reading_state where book_id = ?').get(bookId) as Record<
    string,
    unknown
  >;
  assert.equal(after.status, 'reading');
  assert.equal(after.chapter_idx, 1);
  assert.equal(after.char_offset, 42);
  assert.ok(after.last_read_at, '要记下最后阅读时间，「继续阅读」靠它排序');
});

test('已读完的书不会被翻回「在读」', () => {
  db.prepare("update reading_state set status = 'finished' where book_id = ?").run(bookId);
  saveProgress(db, bookId, 0, 0);
  const s = db.prepare('select status from reading_state where book_id = ?').get(bookId) as {
    status: string;
  };
  assert.equal(s.status, 'finished', '重读不该把状态改回在读');
});

test('「继续阅读」给出最近读的那本', () => {
  assert.equal(lastRead(db), null, '一次都没读过时是 null');
  saveProgress(db, bookId, 2, 7);
  const last = lastRead(db) as { bookId: number; chapterIdx: number; charOffset: number };
  assert.equal(last.bookId, bookId);
  assert.equal(last.chapterIdx, 2);
  assert.equal(last.charOffset, 7);
});

test('读到最后一章的最底下 → 自动标已读完', () => {
  // 「已读完」这一档原来永远是空的：只有编辑框里手动改才会变。
  // 一个阅读器不该要求用户自己去打勾
  const r = saveProgress(db, bookId, 2, 0, true);
  assert.equal(r.finished, true);

  const s = db.prepare('select status, finished_at, percent from reading_state where book_id = ?')
    .get(bookId) as { status: string; finished_at: string | null; percent: number };
  assert.equal(s.status, 'finished');
  assert.ok(s.finished_at, '要记下读完的时间');
  assert.equal(Math.round(s.percent), 100);
});

test('只是跳到最后一章、没读到底，不算读完', () => {
  // 从目录点最后一章看一眼就被判读完的话，那本书会从「在读」里消失，
  // 用户下次找不到它，还以为丢了
  const r = saveProgress(db, bookId, 2, 0, false);
  assert.equal(r.finished, false);
  const s = db.prepare('select status from reading_state where book_id = ?').get(bookId) as {
    status: string;
  };
  assert.equal(s.status, 'reading');
});

test('读到中间某章的底部也不算读完', () => {
  const r = saveProgress(db, bookId, 0, 500, true);
  assert.equal(r.finished, false, '第 1/3 章读到底只是这一章看完了');
  const s = db.prepare('select status from reading_state where book_id = ?').get(bookId) as {
    status: string;
  };
  assert.equal(s.status, 'reading');
});

test('已读完的时间只记第一次——重读不该覆盖它', () => {
  saveProgress(db, bookId, 2, 0, true);
  const first = (db.prepare('select finished_at from reading_state where book_id = ?')
    .get(bookId) as { finished_at: string }).finished_at;
  saveProgress(db, bookId, 2, 0, true);
  const again = (db.prepare('select finished_at from reading_state where book_id = ?')
    .get(bookId) as { finished_at: string }).finished_at;
  assert.equal(again, first);
});

/*
 * 文件没了的时候用户看到什么。
 *
 * 实测过一次：删掉一本书的 txt 再点开它，报错条上是
 * `ENOENT: no such file or directory, open '<一长条绝对路径>'`——
 * 英文 errno，而且没有一个字说该怎么办。
 *
 * ⚠️ **`FileCache` 并不是唯一入口**——注释里一度这么写，是错的：
 * 书内搜索和重新解析都自己开文件。所以下面第二条断言把另外那条路也钉住。
 */
test('文件不见了要说人话，而且要说该怎么办', async () => {
  const gone = join(dir, 'books', '这本书不存在.txt');
  await assert.rejects(
    () => cache.read(gone, 0, 10),
    (e: Error) => {
      assert.ok(!/ENOENT|no such file/.test(e.message), `不该把 errno 原样摆出来：${e.message}`);
      assert.match(e.message, /文件不见了/);   // 和卡片角标 FILE_STATUS.missing 同一个说法
      // **「说了怎么办」才是这条断言的重点**——只把英文换成中文等于没修
      assert.match(e.message, /扫描|整理数据库/);
      return true;
    },
  );
});

test('认不出的错码原样往外抛——编不出人话时原文比瞎猜有用', () => {
  const weird = Object.assign(new Error('EWHATEVER: 天知道'), { code: 'EWHATEVER' });
  assert.equal(openHint(weird), 'EWHATEVER: 天知道');
});

/*
 * 绕开 `FileCache` 的那两条路（书内搜索 `search.ts`、重新解析 `reparse.ts`）
 * 也得说人话。原来它们是裸 `open` / `readFile`，用户看到的还是那句英文 errno，
 * 而注释却写着「FileCache 是唯一入口」——那句话正是这条断言要防的。
 */
test('绕开 FileCache 的两条路也要说人话', async () => {
  const gone = join(dir, 'books', '这本书不存在.txt');
  const 人话 = (e: Error) => {
    assert.ok(!/ENOENT|no such file/.test(e.message), `不该把 errno 原样摆出来：${e.message}`);
    assert.match(e.message, /文件不见了/);
    assert.match(e.message, /扫描|整理数据库/);
    return true;
  };
  await assert.rejects(() => openBook(gone), 人话);
  await assert.rejects(() => readBook(gone), 人话);
});


/*
 * **「派生字段脱节」那一族，在这条路上还活着。**
 *
 * `saveProgress` 原来无条件写 `percent`，而 `status` 只升不降——于是
 * 读完一本书、回头翻到第 513/573 章查点东西，percent 就被写成 89.7，
 * 状态还挂着「已读完」。卡片上那根进度条只在 `0 < percent < 100` 时才画，
 * 所以屏幕上是**一本顶着「读完」角标、底下还画着 90% 进度条的书**。
 *
 * 真实库上普查 8172 行，撞到 1 条（顶着「已读完」而 percent 是 89.7 的那本）。
 * 判据抄 `scan.ts` 重新解析那处：**`finished` 的 100% 是用户按的，不碰**。
 */
test('已读完的书回头翻，进度条不许被写回去', () => {
  const r0 = saveProgress(db, bookId, 2, 0, true);
  assert.equal(r0.finished, true);

  // 回头翻到第 1 章（3 章的书，本来会算出 33%）
  const r = saveProgress(db, bookId, 0, 12);
  const s = db.prepare('select status, percent, chapter_idx, char_offset from reading_state where book_id = ?')
    .get(bookId) as { status: string; percent: number; chapter_idx: number; char_offset: number };

  assert.equal(s.status, 'finished');
  assert.equal(s.percent, 100, '读完的书被翻回了 33%，卡片上就会顶着「读完」画一根进度条');
  assert.equal(r.percent, 100, '返回的数要和真的存进去的一致，不然调用方拿到一个库里没有的数');

  // **位置照旧要记**：用户确实在读，回来还得接着看
  assert.equal(s.chapter_idx, 0);
  assert.equal(s.char_offset, 12);
});

test('没标读完的书，进度条照常跟着章号走——闸只挡 finished 那一档', () => {
  const r = saveProgress(db, bookId, 0, 0);
  const s = db.prepare('select status, percent from reading_state where book_id = ?')
    .get(bookId) as { status: string; percent: number };
  assert.equal(s.status, 'reading');
  assert.equal(Math.round(s.percent), 33, '3 章的书读到第 1 章是 33%');
  assert.equal(Math.round(r.percent), 33);
});

/*
 * PDF / EPUB 的进度不在 `reading_state` 里（存 `app_setting` 的 `viewer.<bookId>`），
 * 所以查看器要单独说一句「这本被打开过」——否则书架上它和一本从没打开过的书一样：
 * 卡片不显示「多久前」、默认排序不往前排、「在读」那一档里没有它。
 *
 * 三条断言，**后两条才是要害**：进度那几列一个都不许被写（写了就正好造出
 * 当初绕开这张表要躲的「读到 12/0」），已表过态的状态不许被推回「在读」。
 */
test('markOpened 只记「打开过」：不碰进度，也不把已读完推回在读', () => {
  const 取 = () =>
    db.prepare('select status, chapter_idx, char_offset, percent, finished_at, last_read_at from reading_state where book_id = ?')
      .get(bookId) as {
        status: string; chapter_idx: number; char_offset: number;
        percent: number; finished_at: string | null; last_read_at: string | null;
      };

  // ① 没表过态的：提成「在读」，并记下时间
  assert.equal(取().last_read_at, null, '夹具前提：还没读过');
  markOpened(db, bookId);
  const a = 取();
  assert.equal(a.status, 'reading');
  assert.ok(a.last_read_at, '要记下「什么时候打开的」——书架好几处都从这一列取数');
  assert.deepEqual(
    [a.chapter_idx, a.char_offset, a.percent, a.finished_at],
    [0, 0, 0, null],
    '进度那几列一个都不许写——写了卡片上就是「读到 12/0」，百分比还除零',
  );

  // ② 已读完的：重新翻一下不该把它推回「在读」（判据抄 saveProgress）
  db.prepare("update reading_state set status = 'finished', percent = 100, chapter_idx = 7 where book_id = ?")
    .run(bookId);
  markOpened(db, bookId);
  const b = 取();
  assert.equal(b.status, 'finished', '已读完是用户自己表的态，翻一下不该改它');
  assert.equal(b.percent, 100, '别把进度也一起动了');
  assert.equal(b.chapter_idx, 7);
});

test('markFinished：翻到最后一页标读完，但不碰进度、也不覆盖用户表过的态', () => {
  const 取 = () =>
    db.prepare('select status, chapter_idx, char_offset, percent, finished_at, drop_reason from reading_state where book_id = ?')
      .get(bookId) as {
        status: string; chapter_idx: number; char_offset: number;
        percent: number; finished_at: string | null; drop_reason: string | null;
      };

  // ① 在读的 PDF 翻到最后一页
  markOpened(db, bookId);
  markFinished(db, bookId);
  const a = 取();
  assert.equal(a.status, 'finished', '不标的话它永远进不了「已读完」那一档');
  assert.equal(a.percent, 100);
  assert.ok(a.finished_at, '「什么时候读完的」是导出和统计都要的');
  assert.deepEqual(
    [a.chapter_idx, a.char_offset],
    [0, 0],
    'chapter_idx / char_offset 一个字都不许写——那两列对只编目的格式永远是 0',
  );

  // ② 坐在最后一页不动：finished_at 不该被一遍遍刷新
  const 先 = a.finished_at;
  db.prepare("update reading_state set finished_at = '2000-01-01 00:00:00' where book_id = ?").run(bookId);
  markFinished(db, bookId);
  assert.equal(取().finished_at, '2000-01-01 00:00:00', '已读完的不再动，读完时间是那一次的');
  assert.ok(先);

  // ③ ⚠️ 弃坑的不动。**这一条才是这个函数不走 setStatus 的理由**：
  //    走 setStatus 的话，离开「弃坑」会把弃坑原因折进短评——
  //    于是「好奇翻一下最后一页」会改掉用户写的字
  db.prepare("update reading_state set status = 'dropped', drop_reason = '写崩了', finished_at = null where book_id = ?")
    .run(bookId);
  markFinished(db, bookId);
  const c = 取();
  assert.equal(c.status, 'dropped', '弃坑是用户自己表的态，翻到最后一页不该改它');
  assert.equal(c.drop_reason, '写崩了', '那句话一个字都不能少');
  assert.equal(c.finished_at, null);
});
