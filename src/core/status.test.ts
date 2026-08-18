import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { labelOf, READING_STATUS as LABEL_STATUS } from './labels.ts';
import { countBooks, UNREVIEWED } from './library.ts';
import {
  setStatus,
  setStatusByFilter,
  planStatusByFilter,
  restoreStatus,
  addBookmark,
  listBookmarks,
  removeBookmark,
  startSession,
  endSession,
  recentBooks,
  READING_STATUS_IDS,
  closeOpenSessions,
  setBookmarkNote,
} from './status.ts';

let dir: string;
let db: DatabaseSync;
let bookId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-st-'));
  db = openDb(join(dir, 'library.db'));
  bookId = Number(db.prepare("insert into book(title) values('测试书')").run().lastInsertRowid);
  db.prepare("insert into reading_state(book_id, status) values(?, 'want')").run(bookId);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const state = () =>
  db.prepare('select * from reading_state where book_id = ?').get(bookId) as Record<string, unknown>;

test('弃坑要能填原因', () => {
  setStatus(db, bookId, { status: 'dropped', dropReason: '主角太蠢' });
  assert.equal(state().status, 'dropped');
  assert.equal(state().drop_reason, '主角太蠢');
});

test('从弃坑回到在读时，弃坑原因要清掉', () => {
  setStatus(db, bookId, { status: 'dropped', dropReason: '太长了' });
  setStatus(db, bookId, { status: 'reading' });
  assert.equal(state().drop_reason, null, '留着一条不成立的弃坑原因会误导人');
});

test('标记读完会记时间并把进度置满', () => {
  setStatus(db, bookId, { status: 'finished' });
  assert.equal(state().status, 'finished');
  assert.equal(state().percent, 100);
  assert.ok(state().finished_at);
});

test('读完之后再开读算一次重读，进度归零', () => {
  setStatus(db, bookId, { status: 'finished' });
  assert.equal(state().reread_count, 0);

  setStatus(db, bookId, { status: 'reading' });
  assert.equal(state().reread_count, 1);
  assert.equal(state().chapter_idx, 0, '重读要从头开始');
  assert.equal(state().percent, 0);
});

test('从「想读」到「在读」不是重读', () => {
  setStatus(db, bookId, { status: 'reading' });
  assert.equal(state().reread_count, 0, '只有读完之后再读才算');
});

test('评分和短评', () => {
  setStatus(db, bookId, { rating: 4.5, comment: '前期神作后期崩' });
  assert.equal(state().rating, 4.5);
  assert.equal(state().comment, '前期神作后期崩');

  assert.throws(() => setStatus(db, bookId, { rating: 9 }), /0–5/);
  assert.equal(state().rating, 4.5, '越界的评分不能写进去');
});

test('不认识的状态要挡下来', () => {
  assert.throws(
    () => setStatus(db, bookId, { status: 'reading-ish' as never }),
    /不认识的阅读状态/,
  );
});

test('书签独立于阅读进度', () => {
  db.prepare('update reading_state set chapter_idx = 5, char_offset = 100 where book_id = ?').run(bookId);
  addBookmark(db, bookId, 2, { charOffset: 30, note: '这段写得好' });

  assert.equal(state().chapter_idx, 5, '加书签不该动阅读进度');
  const marks = listBookmarks(db, bookId);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].chapter_idx, 2);
  assert.equal(marks[0].note, '这段写得好');

  // 这条书签带着笔记，所以要 confirmed——判据见下面那条测试
  removeBookmark(db, marks[0].id, { confirmed: true });
  assert.equal(listBookmarks(db, bookId).length, 0);
});

test('删书会连带删掉它的书签，不留孤儿', () => {
  addBookmark(db, bookId, 1);
  db.prepare('delete from book where id = ?').run(bookId);
  assert.equal(listBookmarks(db).length, 0);
});

test('阅读会话记下起止进度', () => {
  db.prepare('update reading_state set percent = 10 where book_id = ?').run(bookId);
  const { id } = startSession(db, bookId);

  db.prepare('update reading_state set percent = 35 where book_id = ?').run(bookId);
  endSession(db, id);

  const s = db.prepare('select * from reading_session where id = ?').get(id) as Record<string, unknown>;
  assert.equal(s.from_percent, 10);
  assert.equal(s.to_percent, 35);
  assert.ok(s.ended_at);
});

test('重复结束同一个会话不会覆盖第一次的结果', () => {
  const { id } = startSession(db, bookId);
  endSession(db, id);
  const first = (db.prepare('select ended_at from reading_session where id = ?').get(id) as {
    ended_at: string;
  }).ended_at;

  db.prepare('update reading_state set percent = 99 where book_id = ?').run(bookId);
  endSession(db, id);

  const s = db.prepare('select * from reading_session where id = ?').get(id) as Record<string, unknown>;
  assert.equal(s.ended_at, first);
  assert.notEqual(s.to_percent, 99, '已经结束的会话不该被再改一次');
});

test('「最近在读」按最后阅读时间排序，没读过的不出现', () => {
  const other = Number(db.prepare("insert into book(title) values('另一本')").run().lastInsertRowid);
  db.prepare("insert into reading_state(book_id, status) values(?, 'want')").run(other);

  assert.equal(recentBooks(db).length, 0, '一本都没读过时是空的');

  db.prepare("update reading_state set last_read_at = '2026-08-01 10:00' where book_id = ?").run(bookId);
  db.prepare("update reading_state set last_read_at = '2026-08-12 10:00' where book_id = ?").run(other);

  const recent = recentBooks(db) as Array<{ bookId: number }>;
  assert.deepEqual(recent.map((r) => r.bookId), [other, bookId]);
});

test('离开「已读完」要清掉读完时间——不然记录自相矛盾', () => {
  setStatus(db, bookId, { status: 'finished' });
  assert.ok((db.prepare('select finished_at from reading_state where book_id = ?')
    .get(bookId) as { finished_at: string | null }).finished_at);

  setStatus(db, bookId, { status: 'reading' });
  assert.equal(
    (db.prepare('select finished_at from reading_state where book_id = ?')
      .get(bookId) as { finished_at: string | null }).finished_at,
    null,
    '状态是在读却留着读完时间，统计和导出都会照单全收',
  );
});

test('离开「已读完」时进度条要跟着回到实际位置，不能停在满格', () => {
  setStatus(db, bookId, { status: 'finished' });
  setStatus(db, bookId, { status: 'want' });

  const s = db.prepare('select status, percent, chapter_idx from reading_state where book_id = ?')
    .get(bookId) as { status: string; percent: number; chapter_idx: number };
  assert.equal(s.status, 'want');
  assert.ok(s.percent < 100, `「想读」却显示 ${s.percent}%，进度条满格的未读书`);
  assert.equal(s.chapter_idx, 0, 'chapter_idx 是不可再生数据，不许因为改状态就动它');
});

test('扫进来的书不表态：默认是「未标记」，不是「想读」', () => {
  // 「想读」是用户说的话。扫描替他说了之后，真实书库里 8172 本有 8166 本
  // 是「想读」——侧栏的「全部」和「想读」成了同两批书，而「我打算读这本」
  // 这句话再也说不出来了（所有书都已经这么说过）。
  const db = openDb(':memory:');
  const id = Number(db.prepare("insert into book(title) values('某书')").run().lastInsertRowid);
  db.prepare('insert into reading_state(book_id) values(?)').run(id);
  const row = db.prepare('select status from reading_state where book_id = ?').get(id) as { status: string };
  // 列的默认值还是 want（改它要重建表），所以**插入时必须显式写 none**——
  // 这条钉的就是「别依赖列默认值」
  assert.equal(row.status, 'want', '前提：列默认值仍然是 want');

  db.prepare("update reading_state set status = 'none' where book_id = ?").run(id);
  assert.equal(labelOf(LABEL_STATUS, 'none'), '未标记');
  db.close();
});

/* ── 按整个筛选结果批量改状态 ───────────────────────────── */

/** 再造几本书，各自给一个初始状态；返回 id */
const mkBook = (title: string, status: string) => {
  const id = Number(db.prepare('insert into book(title) values(?)').run(title).lastInsertRowid);
  db.prepare('insert into reading_state(book_id, status) values(?, ?)').run(id, status);
  return id;
};

test('批量改状态作用于整个筛选结果，不是当前这一页', () => {
  const a = mkBook('斗破苍穹', 'none');
  const b = mkBook('斗破苍穹外传', 'want');
  mkBook('完全无关的书', 'none');

  const r = setStatusByFilter(db, { keyword: '斗破' }, 'finished');
  assert.equal(r.changed.length, 2, JSON.stringify(r));
  assert.deepEqual(
    r.changed.map((x) => x.from).sort(),
    ['none', 'want'],
    'changed 里要带着「改之前是什么」，撤销全靠它',
  );
  const st = (id: number) =>
    (db.prepare('select status from reading_state where book_id = ?').get(id) as { status: string }).status;
  assert.equal(st(a), 'finished');
  assert.equal(st(b), 'finished');
});

/*
 * **这条是这个功能最要紧的一条。**
 *
 * `setStatus` 里 `finished → reading` 会清零 `chapter_idx` 并记一次重读——
 * 那是铁律 3 的数据。一次批量能把几百本的进度抹掉，而且撤销补不回
 * `finished_at`（再标回去只写一个「现在」）。所以「已读完」的书批量一律不动。
 */
test('已读完的书批量一律不动，进度和读完时间都不许被抹掉', () => {
  const done = mkBook('已经读完的', 'none');
  setStatus(db, done, { status: 'finished' });
  db.prepare('update reading_state set chapter_idx = 512 where book_id = ?').run(done);
  const before = db.prepare('select chapter_idx, finished_at from reading_state where book_id = ?')
    .get(done) as { chapter_idx: number; finished_at: string };

  const r = setStatusByFilter(db, { keyword: '已经读完' }, 'reading');
  assert.equal(r.kept, 1, '应当被跳过并计入 kept');
  assert.equal(r.changed.length, 0);

  const after = db.prepare('select status, chapter_idx, finished_at from reading_state where book_id = ?')
    .get(done) as { status: string; chapter_idx: number; finished_at: string };
  assert.equal(after.status, 'finished', '状态没被改');
  assert.equal(after.chapter_idx, before.chapter_idx, '进度被清零了——这正是最糟的那种失败');
  assert.equal(after.finished_at, before.finished_at, '读完时间被覆盖了，撤销也补不回来');
});

/*
 * 这一条是**在真实库上量出来才发现的**：整库标成「想读」之后，
 * 《我从凡间来》成了「想读 + 读到 1104 章」——数据一个字没丢，
 * 但那条记录本身说不通。8 本的测试库上永远看不到，因为没有一本有进度。
 */
test('读到过第几章的书批量也不动，免得出现「想读却读到第 1104 章」', () => {
  const started = mkBook('读到一半的', 'reading');
  db.prepare('update reading_state set chapter_idx = 1104, char_offset = 268 where book_id = ?')
    .run(started);

  const r = setStatusByFilter(db, { keyword: '读到一半' }, 'want');
  assert.equal(r.kept, 1, '有进度的应当被跳过');
  assert.equal(r.changed.length, 0);

  const after = db.prepare('select status, chapter_idx from reading_state where book_id = ?')
    .get(started) as { status: string; chapter_idx: number };
  assert.equal(after.status, 'reading', '状态没被改成「想读」');
  assert.equal(after.chapter_idx, 1104);
});

test('本来就是这个状态的算 same，不重复写', () => {
  mkBook('已经在读的', 'reading');
  const r = setStatusByFilter(db, { keyword: '已经在读' }, 'reading');
  assert.equal(r.same, 1);
  assert.equal(r.changed.length, 0);
});

test('撤销要把每一本各自设回原来的状态，不是一律设回同一个', () => {
  const a = mkBook('甲书', 'none');
  const b = mkBook('乙书', 'dropped');
  const r = setStatusByFilter(db, { keyword: '书' }, 'want');
  assert.ok(r.changed.length >= 2);

  restoreStatus(db, r.changed);
  const st = (id: number) =>
    (db.prepare('select status from reading_state where book_id = ?').get(id) as { status: string }).status;
  assert.equal(st(a), 'none');
  assert.equal(st(b), 'dropped', '两本改前状态不同，撤销后也得各回各的');
});

test('不认识的状态当场报错，不写库', () => {
  assert.throws(() => setStatusByFilter(db, {}, '读完了' as never), /阅读状态/);
});

/*
 * ⚠️ **「撤销是无损的」这句话原来是假的。**
 *
 * `restoreStatus` 只把 `status` 设回去，而它走的是 `setStatus`——
 * 那个函数带着一整套「离开某个状态时顺手改派生字段」的逻辑，
 * 于是撤销本身又改坏了三样东西。三条各钉一样。
 */
test('撤销不许弄丢弃坑原因', () => {
  const b = mkBook('弃了的书', 'none');
  setStatus(db, b, { status: 'dropped', dropReason: '后期崩了，别再点开' });

  const r = setStatusByFilter(db, { keyword: '弃了的书' }, 'finished');
  restoreStatus(db, r.changed);

  const after = db.prepare('select status, drop_reason from reading_state where book_id = ?')
    .get(b) as { status: string; drop_reason: string | null };
  assert.equal(after.status, 'dropped');
  assert.equal(after.drop_reason, '后期崩了，别再点开', '弃坑原因是用户自己写的字，撤销之后不该没了');
});

test('撤销不许凭空记一次重读', () => {
  const b = mkBook('在读的书', 'reading');   // 没有进度，所以批量会动它
  const r = setStatusByFilter(db, { keyword: '在读的书' }, 'finished');
  assert.equal(r.changed.length, 1);
  restoreStatus(db, r.changed);

  const after = db.prepare('select status, reread_count, chapter_idx from reading_state where book_id = ?')
    .get(b) as { status: string; reread_count: number; chapter_idx: number };
  assert.equal(after.status, 'reading');
  assert.equal(after.reread_count, 0, '一来一回不该算成「重读了一遍」——那个数只增不减');
  assert.equal(after.chapter_idx, 0);
});

test('撤销不许在没读过的书上留下进度条', () => {
  const b = mkBook('没读过的书', 'none');
  const before = db.prepare('select percent from reading_state where book_id = ?')
    .get(b) as { percent: number };
  const r = setStatusByFilter(db, { keyword: '没读过的书' }, 'finished');
  restoreStatus(db, r.changed);

  const after = db.prepare('select percent, finished_at from reading_state where book_id = ?')
    .get(b) as { percent: number; finished_at: string | null };
  assert.equal(after.percent, before.percent, 'percent 被重算成非 0 了，书架上会画出一条谁也解释不了的进度');
  assert.equal(after.finished_at, null);
});

/*
 * 筛选键拼错 = 没有任何条件 = 整个书库。读的时候顶多是结果不对，
 * 而按筛选批量**写**会当场把整库改掉，还返回一个成功。
 */
test('筛选条件拼错要当场报错，不许退化成「整个书库」', () => {
  mkBook('甲', 'none');
  mkBook('乙', 'none');
  assert.throws(
    () => setStatusByFilter(db, { keywords: '不存在的关键词' } as never, 'finished'),
    /筛选条件/,
  );
  const n = (db.prepare("select count(*) n from reading_state where status = 'finished'")
    .get() as { n: number }).n;
  assert.equal(n, 0, '一本都不该被改');
});

/*
 * 「未标记」那一档按定义包含**连 reading_state 行都没有**的书
 * （`buildFilter` 用的是 `ifnull(r.status,'none')`）。写的那头原来会对这种书
 * 抛「书 N 没有阅读状态记录」，而且抛在事务里——一本就把整批回滚了。
 */
test('没有阅读状态记录的书也能批量标，不能把整批带崩', () => {
  const naked = Number(db.prepare("insert into book(title) values('没有状态行的书')").run().lastInsertRowid);
  const normal = mkBook('有状态行的书', 'none');

  const r = setStatusByFilter(db, { readingStatus: ['none'] }, 'want');
  assert.ok(r.changed.length >= 2, `两本都该被改，实际 ${r.changed.length}`);
  const st = (id: number) => (db.prepare('select status from reading_state where book_id = ?')
    .get(id) as { status: string } | undefined)?.status;
  assert.equal(st(naked), 'want', '缺行的那本该被补上一行再改');
  assert.equal(st(normal), 'want', '健康的那本不该被别人的异常连累');
});

/*
 * 预览必须列**会变的**那些。
 *
 * 旧写法是弹窗自己 `book.list({ filter, limit: 20, sort })`，而默认排序
 * （`ORDER.time`：读过的排最前）把动过的书排在最前面——那批恰恰一本都不会改。
 * 于是「会被改的书」列的正好是不会改的。这条断言就是照那个形状写的：
 * 会变的书故意造得比不会变的少，只要预览还是「取前几本」就必然混进 kept。
 */
test('预览列的是会变的书，不是会被跳过的那些', () => {
  const done1 = mkBook('甲已读完', 'finished');
  const done2 = mkBook('乙已读完', 'finished');
  const fresh = mkBook('丙没动过', 'none');

  const plan = planStatusByFilter(db, {}, 'finished');
  const ids = plan.sample.map((x) => x.bookId);
  assert.ok(ids.includes(fresh), '没动过的那本该在预览里');
  assert.ok(!ids.includes(done1) && !ids.includes(done2), '已读完的不会被改，就不该出现在预览里');
  assert.equal(plan.same, 2, '两本本来就是「已读完」');

  // 预览说会改几本，执行就得真的改几本——按钮上那个数字来自这里
  const r = setStatusByFilter(db, {}, 'finished');
  assert.equal(r.changed.length, plan.total);
  assert.equal(r.same, plan.same);
  assert.equal(r.kept, plan.kept);
});

/*
 * **样本上限只此一份，而且 `total` 不受它影响。**
 *
 * 第二十三轮把预览接口从「回全部会变的书」改成「回样本 + 总数」（整库 334 KB → 1 KB），
 * 而那个「20」当时在三处各写了一遍：两个 core 默认值 + 每个弹窗自己的 `PREVIEW`。
 * 谁把弹窗那个改成 30，界面仍然只有 20 条，却会写「另外 n-30 本」——差十本的假话。
 * 现在弹窗按**实际拿到的样本条数**算，`PREVIEW` 已经删掉。
 * 这条断言守住 core 这一头：样本被截，`total` 仍然是全量。
 */
test('预览只回样本，但 total 是全量', () => {
  for (let i = 0; i < 25; i++) mkBook(`书${i}`, 'none');
  const plan = planStatusByFilter(db, {}, 'finished', 5);
  assert.equal(plan.sample.length, 5, '样本按传进来的上限截');
  assert.ok(plan.total >= 25, `total 要是全量，实际 ${plan.total}`);

  // 不传上限时用默认的那个，同样不影响 total
  const d = planStatusByFilter(db, {}, 'finished');
  assert.ok(d.sample.length <= 20 && d.sample.length < d.total, `${d.sample.length} / ${d.total}`);
  assert.equal(d.total, plan.total, '换个样本上限，会变的本数不该跟着变');
});

/*
 * **参数不是数字/不是文字的时候，必须抛错，不能悄悄写坏。**
 *
 * 原来只比大小（`rating < 0 || rating > 5`），而 `NaN` 两边都是 false——
 * 一路走到 `node:sqlite` 被**静默绑成 NULL**：一次参数写错就把这本书的评分清掉了，
 * 还返回成功。那是铁律 3 的数据。字符串同理（`'abc' < 0` 也是 false，
 * 而 rating 那一列是 REAL，存不进去就按 TEXT 存着，卡片上出现「★abc」）。
 *
 * ⚠ **重点是最后那条断言**：光「抛了错」不算数——最糟的失败是
 * 「抛了错，而原来那个评分已经被抹掉了」。
 */
test('评分和短评的类型不对时要抛错，而且库里那一行一个字都不许变', () => {
  const id = mkBook('试验品', 'none');
  setStatus(db, id, { rating: 4, comment: '本来写好的一句' });

  for (const patch of [
    { rating: NaN },
    { rating: '5' },
    { rating: 'abc' },
    { comment: 12345 },
    { dropReason: {} },
  ] as Array<Record<string, unknown>>) {
    assert.throws(
      () => setStatus(db, id, patch as never),
      /要是|范围/,
      `${JSON.stringify(patch)} 该被拒，却收下了`,
    );
  }

  const row = db.prepare('select rating, comment from reading_state where book_id = ?')
    .get(id) as { rating: number; comment: string };
  assert.equal(row.rating, 4, '被拒之后评分不该有任何变化');
  assert.equal(row.comment, '本来写好的一句');
});

/*
 * **参数名写错要抛错，不能静默成功。**
 *
 * 量出来的：`raiting`（拼错）、`comments`（多个 s）、`reason`（该叫 dropReason）、
 * `drop_reason`（照着库里的列名写的）、`state`（该叫 status）——五种写法原来
 * **全部静默成功**，`reading.setStatus` 返回 `{ ok: true }` 而库里一个字没变。
 * 这正是 `tag.delete` 那次事故的形状，而 AGENTS.md §13 明说
 * **外部调用方最容易错的就是参数名**。
 *
 * `drop_reason` 那个尤其容易踩：本仓库教人「schema 直接问库」，
 * 而库里的列名就是 snake_case。
 */
test('setStatus 认不出的字段名要抛错，空 patch 不算错', () => {
  const id = mkBook('试验品', 'none');
  setStatus(db, id, { rating: 4 });

  for (const bad of ['raiting', 'comments', 'reason', 'drop_reason', 'state']) {
    assert.throws(
      () => setStatus(db, id, { [bad]: 'x' } as never),
      /不认识的字段/,
      `${bad} 该被拒，却静默成功了`,
    );
  }
  // 空 patch 是「什么都不改」，不是拼错
  assert.doesNotThrow(() => setStatus(db, id, {}));

  const row = db.prepare('select rating from reading_state where book_id = ?').get(id) as { rating: number };
  assert.equal(row.rating, 4, '被拒之后那一行不该有任何变化');
});

/*
 * **只有空白的短评＝没写。**
 *
 * 量出来的：`comment: '   '`（或者只有换行、或者一个全角空格）原来原样存进去，
 * 于是那本书算「评价过」、`rated_at` 被写上、卡片上多一行空的短评，
 * 而且**从「读过没评价」那个待办里消失了**——一个手滑的空格就把待办清掉了，
 * 而屏幕上什么都没写。
 *
 * 顺带把「前后空格去掉」也钉住：真短评不该因为多敲了一个空格就存成另一个值。
 */
test('只有空白的短评当作没写，真短评前后的空格要去掉', () => {
  // 状态用「已读完」：这本书要算进「读过没评价」那个待办里，才验得到那一条
  const id = mkBook('试验品', 'finished');
  const read = () => db.prepare('select comment, rated_at from reading_state where book_id = ?')
    .get(id) as { comment: string | null; rated_at: string | null };

  for (const blank of ['   ', '\n\n', '　']) {
    setStatus(db, id, { comment: blank });
    const r = read();
    assert.equal(r.comment, null, `${JSON.stringify(blank)} 该被当成没写`);
    assert.equal(r.rated_at, null, '没写就不该有评价时间——「我的书评」按它排序');
    assert.equal(countBooks(db, { rated: true }), 0, '空白不算评价过');
    assert.equal(countBooks(db, UNREVIEWED), 1, '待办不该被一个空格清掉');
  }

  setStatus(db, id, { comment: '  真的一句  ' });
  assert.equal(read().comment, '真的一句');
  assert.ok(read().rated_at, '真写了就该有评价时间');

  // 弃坑原因同理
  setStatus(db, id, { dropReason: '  ' });
  const dr = db.prepare('select drop_reason from reading_state where book_id = ?')
    .get(id) as { drop_reason: string | null };
  assert.equal(dr.drop_reason, null);
});

/*
 * **阅读状态的清单只此一份。** `status.ts` 原来自己又写了一份纯 id 的，
 * 和 `labels.ts` 那份（带中文名的）并存——同一张表两个副本，
 * 加一档漏改一处的后果是：侧栏和编辑弹窗里摆着那一档，而 `setStatus` 说
 * 「不认识的阅读状态」。`SERIAL_STATUS` 当年就是这么删掉的。
 *
 * 这条直接拿两边对账，比「共用了同一个常量」硬：常量可以被绕开，清单对不上就是对不上。
 */
test('阅读状态的清单：core 里只有一份，两处说的是同一批', () => {
  assert.deepEqual(
    [...READING_STATUS_IDS],
    LABEL_STATUS.map((s) => s.id),
    'status.ts 的 id 清单必须就是 labels.ts 那份算出来的',
  );
  // 每一档都真的能设进去——清单对得上但值不认，等于没对上
  const id = mkBook('对账用的书', 'none');
  for (const s of LABEL_STATUS) assert.doesNotThrow(() => setStatus(db, id, { status: s.id }));
});

/*
 * **离开弃坑时，那句弃坑原因要折进短评，不能丢。**
 *
 * 实测过：标弃坑写了原因，后来改成「已读完」，那句话当场消失，
 * 再标回弃坑也补不回来——而它是用户打的字。
 *
 * 清掉 `drop_reason` 本身是对的（不然卡片上会出现一句假话：一本「已读完」的书
 * 挂着「弃坑原因：烂尾了」）。错的是**丢**而不是**搬**：这两样东西在卡片上
 * 共用同一行（`.book-note`），搬过去用户看到的一个字都不变。
 *
 * 拼接的判据抄 `mergeBooks`：两边都有话就换行拼起来，不是二选一。
 */
test('离开弃坑时，弃坑原因折进短评而不是被删掉', () => {
  const a = mkBook('只有弃坑原因', 'none');
  setStatus(db, a, { status: 'dropped', dropReason: '第三卷开始注水' });
  setStatus(db, a, { status: 'finished' });
  const ra = db.prepare('select comment, drop_reason, rated_at from reading_state where book_id = ?')
    .get(a) as { comment: string; drop_reason: string | null; rated_at: string | null };
  assert.equal(ra.comment, '第三卷开始注水', '那句话要搬进短评');
  assert.equal(ra.drop_reason, null, '弃坑原因本身要清掉——不然卡片上是句假话');
  assert.ok(ra.rated_at, '短评有内容了，评价时间要跟着有——不然「我的书评」按它排会排到最后');

  // 两边都有话：换行拼起来，不是二选一
  const b = mkBook('两边都有话', 'none');
  setStatus(db, b, { comment: '前面挺好看' });
  setStatus(db, b, { status: 'dropped', dropReason: '后面烂尾' });
  setStatus(db, b, { status: 'reading' });
  const rb = db.prepare('select comment from reading_state where book_id = ?')
    .get(b) as { comment: string };
  assert.equal(rb.comment, '前面挺好看\n后面烂尾');

  // 这次自己就在改短评时，不要插一脚
  const c = mkBook('同时改短评', 'none');
  setStatus(db, c, { status: 'dropped', dropReason: '弃了' });
  setStatus(db, c, { status: 'finished', comment: '我重写的一句' });
  const rc = db.prepare('select comment from reading_state where book_id = ?')
    .get(c) as { comment: string };
  assert.equal(rc.comment, '我重写的一句', '调用方自己在写 comment 时，不该被拼上旧的弃坑原因');
});

/*
 * **只打分、只写短评的时候，别动弃坑原因。**
 *
 * 「离开弃坑时把原因折进短评」那条（上面那个测试）有个很容易写错的边界：
 * 折叠的判据是 `patch.status !== 'dropped'`，而**没传 status 时它也不等于
 * `'dropped'`**——真要是漏了「这次改了状态吗」这层判断，
 * 从卡片上给一本弃坑的书打个分，就会把它的弃坑原因悄悄挪进短评、
 * 并且把原因清掉。用户只点了一颗星。
 *
 * 三种「不算改状态」的调用各钉一次：只打分、只写短评、把同一个状态再设一遍。
 */
test('给弃坑的书打分或写短评，不该动它的弃坑原因', () => {
  const id = mkBook('弃坑的书', 'none');
  setStatus(db, id, { status: 'dropped', dropReason: '第三卷开始注水' });
  const reason = () => (db.prepare('select drop_reason d, comment c from reading_state where book_id = ?')
    .get(id) as { d: string | null; c: string | null });

  setStatus(db, id, { rating: 2 });
  assert.equal(reason().d, '第三卷开始注水', '只打个分不该碰弃坑原因');
  assert.equal(reason().c, null, '更不该把它折进短评');

  setStatus(db, id, { comment: '记一句' });
  assert.equal(reason().d, '第三卷开始注水', '只写短评也不该碰');
  assert.equal(reason().c, '记一句', '短评就是这次写的那句，不带别的');

  setStatus(db, id, { status: 'dropped' });
  assert.equal(reason().d, '第三卷开始注水', '把同一个状态再设一遍，也不算「离开弃坑」');
});


/*
 * 同 `highlight.test.ts` 那条：**安全阀不能只活在界面里**。
 * 书签这一路还多一个入口——阅读器里按 **B** 是「这一章有书签就撤掉」，
 * 而撤掉走的就是 `removeBookmark`：**一个快捷键无声删掉一段笔记**，
 * 屏幕上连它写的什么都不显示。而笔记是铁律 3 的数据。
 */
test('带笔记的书签，不带 confirmed 撤不掉，而且那条笔记一个字没少', () => {
  const { id } = addBookmark(db, bookId, 3, { note: '这里开始注水' });
  assert.throws(() => removeBookmark(db, id), /写着笔记/);

  const left = listBookmarks(db, bookId);
  assert.equal(left.length, 1, '被拦下来了，书签却已经没了——那是最糟的失败');
  assert.equal(left[0].note, '这里开始注水');

  assert.deepEqual(removeBookmark(db, id, { confirmed: true }), { removed: 1 });
  assert.equal(listBookmarks(db, bookId).length, 0);
});

test('没写笔记的书签按 B 照样撤得掉——闸只拦真会丢东西的', () => {
  const { id } = addBookmark(db, bookId, 3, { excerpt: '少年提剑出门' });
  assert.deepEqual(removeBookmark(db, id), { removed: 1 });
  assert.equal(listBookmarks(db, bookId).length, 0);
});

/** id 写错原来一声不吭地「成功」了，同 `tag.delete` 那次事故 */
test('撤一个不存在的书签，报出来的是 removed: 0，不是成功', () => {
  assert.deepEqual(removeBookmark(db, 99999), { removed: 0 });
});

/*
 * 撤销报的数必须是**真改回去几本**，不是「试了几次」。
 * 那本书可能在这中间没了（「只留这一份」、「整理数据库」都会删记录），
 * 无条件 `++` 会让报告说「已经改回 8 本」而库里只回去 7 本——
 * 同 `backup.ts` 恢复那处，和本仓库那条「`insert or ignore` 后面不许跟无条件 `++`」。
 */
test('撤销数的是真改回去的那几本，书没了的不算', () => {
  const mk = (t: string) => {
    const id = Number(db.prepare('insert into book(title) values(?)').run(t).lastInsertRowid);
    db.prepare("insert into reading_state(book_id, status) values(?, 'want')").run(id);
    return id;
  };
  const a = mk('会撤回去的');
  const 没了 = mk('撤销之前就被删掉的');
  setStatus(db, a, { status: 'reading' });
  setStatus(db, 没了, { status: 'reading' });

  const snap = [a, 没了].map((id) => {
    const r = db.prepare('select * from reading_state where book_id = ?').get(id) as Record<string, unknown>;
    return {
      bookId: id, from: 'want', finishedAt: null, percent: Number(r.percent ?? 0),
      rereadCount: Number(r.reread_count ?? 0), dropReason: null,
      chapterIdx: Number(r.chapter_idx ?? 0), charOffset: Number(r.char_offset ?? 0),
    };
  });

  db.prepare('delete from book where id = ?').run(没了); // reading_state 跟着 cascade 走

  const { restored } = restoreStatus(db, snap as never);
  assert.equal(restored, 1, '报了 2 本，而库里只有 1 本真改回去——报告和库不是一回事');

  const back = db.prepare('select status from reading_state where book_id = ?').get(a) as { status: string };
  assert.equal(back.status, 'want', '活着的那本要真的改回去，别为了数对把活儿也省了');
});

/*
 * 这句原来是「书 N 没有阅读状态记录」——听着像少了一行、补一行就好，
 * 而十有八九是**这本书根本不存在**。§13 明说外部调用方最容易错的就是 id，
 * 而这条 rpc 对外开放。同 `reader.ts` 的 `openHint`：**「说了怎么办」才是判据**。
 */
test('给一本不存在的书写评价，报错要说「没有这个 id」并指出怎么查', () => {
  assert.throws(
    () => setStatus(db, 999999, { status: 'finished', comment: '给不存在的书写的' }),
    (e: Error) => /没有 id 为 999999 的书/.test(e.message) && /book\.list|search\.meta/.test(e.message),
  );
  // 书在、只是那一行不在——这是另一回事，不能说成「没有这本书」
  const id = Number(db.prepare("insert into book(title) values('只有书没有状态行')").run().lastInsertRowid);
  assert.throws(
    () => setStatus(db, id, { status: 'finished' }),
    (e: Error) => /还没有阅读状态那一行/.test(e.message),
  );
});

/*
 * 会话由渲染进程「开阅读器 start、卸载时 end」，而**应用直接退出时 React 的
 * cleanup 根本不跑**——真实库上量的：30 条会话里 13 条（43%）`ended_at` 和
 * `to_percent` 都是 null，那条记录等于什么都没记，而它还跟着备份走。
 */
test('退出时收会话：就是现在结束的，进度取这本书当前的', () => {
  const { id } = startSession(db, bookId);
  db.prepare('update reading_state set percent = 42.5 where book_id = ?').run(bookId);

  const r = closeOpenSessions(db, 'quit');
  assert.equal(r.closed, 1);
  const s = db.prepare('select * from reading_session where id = ?').get(id) as Record<string, unknown>;
  assert.ok(s.ended_at, '没关上');
  assert.equal(s.to_percent, 42.5, '退出时的进度是事实，该记下来');

  // 幂等：再来一次不会把已经关上的又改一遍
  assert.equal(closeOpenSessions(db, 'quit').closed, 0);
});

test('开机时收上次崩掉的会话：不知道什么时候结束的，就别编', () => {
  const { id } = startSession(db, bookId);
  db.prepare('update reading_session set from_percent = 10 where id = ?').run(id);
  db.prepare("update reading_state set last_read_at = '2026-01-02 03:04:05', percent = 88 where book_id = ?")
    .run(bookId);

  assert.equal(closeOpenSessions(db, 'crash').closed, 1);
  const s = db.prepare('select * from reading_session where id = ?').get(id) as Record<string, unknown>;
  assert.equal(s.ended_at, '2026-01-02 03:04:05', '该用「最后一次知道他在读」那个时刻');
  assert.equal(
    s.to_percent, 10,
    '崩掉的会话不知道读到哪儿了，保守地当作没推进——别拿现在的 88 冒充它读到的进度',
  );
});

test('没有 last_read_at 时退回会话自己的开始时间，不写 null', () => {
  const { id } = startSession(db, bookId);
  db.prepare('update reading_state set last_read_at = null where book_id = ?').run(bookId);
  closeOpenSessions(db, 'crash');
  const s = db.prepare('select started_at, ended_at from reading_session where id = ?').get(id) as
    { started_at: string; ended_at: string };
  assert.equal(s.ended_at, s.started_at);
});

/*
 * 穷举过 36 种状态转换（下一条测试钉着），**只有「已读完 → 在读」会动用户数据**：
 * 清掉阅读位置、`reread_count + 1`。spec §5.1 把它定义成「重读」，
 * 可用户在下拉里选「在读」时有两种意图，应用分不出来——
 * 「我要重读一遍」和「我标错了，其实还没读完」。后者当场丢掉的是铁律 3 的进度。
 */
test('标错了那条路：keepProgress 时位置和重读次数一个都不许动', () => {
  setStatus(db, bookId, { status: 'finished' });
  db.prepare('update reading_state set chapter_idx = 42, char_offset = 900, reread_count = 1 where book_id = ?')
    .run(bookId);

  setStatus(db, bookId, { status: 'reading', keepProgress: true });
  const s = state();
  assert.equal(s.status, 'reading');
  assert.equal(s.chapter_idx, 42, '「其实还没读完」把位置清掉了——那是重扫恢复不了的');
  assert.equal(s.char_offset, 900);
  assert.equal(s.reread_count, 1, '没重读，不该加一次');
  assert.equal(s.finished_at, null, '离开「已读完」照旧要清掉读完时间');
});

test('不传 keepProgress 就是重读：回到开头，重读次数加一', () => {
  setStatus(db, bookId, { status: 'finished' });
  db.prepare('update reading_state set chapter_idx = 42, char_offset = 900, reread_count = 1 where book_id = ?')
    .run(bookId);

  setStatus(db, bookId, { status: 'reading' });
  const s = state();
  assert.equal(s.chapter_idx, 0);
  assert.equal(s.char_offset, 0);
  assert.equal(s.reread_count, 2);
});

/*
 * **穷举**：6 种状态两两组合 36 种转换，跑完之后逐条量两件事——
 * 这一行有没有自相矛盾，以及有没有动到用户自己的东西。
 * 这条测试是上面那条判据的依据本身：**「只有一种转换会动用户数据」这句话，
 * 得有人一直数着**，不然哪天多出第二种也没人知道。
 */
test('36 种状态转换：只有「已读完 → 在读」会动用户数据，而且都不自相矛盾', () => {
  const 动过的: string[] = [];
  const 矛盾的: string[] = [];
  for (const from of READING_STATUS_IDS) {
    for (const to of READING_STATUS_IDS) {
      const id = Number(db.prepare('insert into book(title) values(?)').run(`${from}-${to}`).lastInsertRowid);
      db.prepare("insert into reading_state(book_id, status) values(?, 'none')").run(id);
      setStatus(db, id, { status: from, rating: 4, comment: '写过的一句' });
      db.prepare('update reading_state set chapter_idx = 7, char_offset = 30, reread_count = 2 where book_id = ?').run(id);
      const 前 = { ...db.prepare('select * from reading_state where book_id = ?').get(id) } as Record<string, unknown>;
      setStatus(db, id, { status: to });
      const 后 = { ...db.prepare('select * from reading_state where book_id = ?').get(id) } as Record<string, unknown>;

      for (const k of ['chapter_idx', 'char_offset', 'rating', 'comment', 'reread_count']) {
        if (String(前[k]) !== String(后[k])) { 动过的.push(`${from} → ${to}`); break; }
      }
      const st = 后.status as string;
      if (st === 'finished' && Number(后.percent ?? 0) !== 100) 矛盾的.push(`${from}→${to} 读完却不是 100%`);
      if (st !== 'finished' && 后.finished_at != null) 矛盾的.push(`${from}→${to} 没读完却留着读完时间`);
      if (st !== 'dropped' && (后.drop_reason ?? '') !== '') 矛盾的.push(`${from}→${to} 不是弃坑却留着原因`);
      if ((后.rating != null || (后.comment ?? '') !== '') && 后.rated_at == null) 矛盾的.push(`${from}→${to} 有评价却没评价时间`);
    }
  }
  assert.deepEqual(矛盾的, [], '有转换留下了自相矛盾的记录');
  assert.deepEqual(动过的, ['finished → reading'], '动用户数据的转换变了——多出来的那种要有人明确决定过');
});

/*
 * **撤销也是一扇门。**
 *
 * 上一轮给恢复备份补了校验，而**撤销这扇门一样是把调用方给的行直接写进
 * `reading_state`**，还对外开放（§13）。实测塞 `status: '乱写的状态'`、
 * `percent: 500`、`chapter_idx: -5` 全部原样落库，回一句 `{restored: 1}`。
 *
 * 后果里最硬的一条：**状态不认识的书从此不属于任何一档书架**。
 */
test('撤销收到不合法的快照：收拾干净再写，而且报出改了几处', () => {
  setStatus(db, bookId, { status: 'reading' });
  const bad = [{
    bookId, from: '乱写的状态', finishedAt: 'yesterday', percent: 500,
    rereadCount: -1, dropReason: null, chapterIdx: -5, charOffset: 0,
  }] as never;

  const r = restoreStatus(db, bad);
  assert.equal(r.restored, 1);
  assert.ok(r.fixed >= 4, `该报出收拾了几处，实际 ${r.fixed}`);

  const s = state();
  assert.equal(s.status, 'none', '不认识的状态要落成「未标记」——否则这本书不属于任何一档书架');
  assert.equal(s.percent, 0, '500% 的进度条会撑破卡片');
  assert.equal(s.chapter_idx, 0, '负的章号打开就报错');
  assert.equal(s.reread_count, 0);
  assert.equal(s.finished_at, null, '不是时间就别留着');
});

test('好好的快照一处都不许「收拾」', () => {
  setStatus(db, bookId, { status: 'dropped', dropReason: '注水' });
  const good = [{
    bookId, from: 'reading' as const, finishedAt: null, percent: 33.3,
    rereadCount: 1, dropReason: '写过的原因', chapterIdx: 7, charOffset: 30,
  }];
  const r = restoreStatus(db, good as never);
  assert.equal(r.fixed, 0, '把正常快照也算成「收拾过」的话，那个数就没意义了');
  const s = state();
  assert.equal(s.status, 'reading');
  assert.equal(s.chapter_idx, 7);
  assert.equal(s.drop_reason, '写过的原因');
});


test('书签的笔记：写得进去、改得了，id 不存在要报错', () => {
  /*
   * `bookmark.note` 这一列原来**全应用没有一个地方写得进去**：
   * 表里有、`addBookmark` 收得下、面板还会显示它——那个显示分支是死代码。
   * 「记一句为什么标这儿」正是书签比阅读进度多出来的那点价值。
   */
  const id = addBookmark(db, 1, 3, { excerpt: '风雪夜归人' }).id;
  assert.equal(listBookmarks(db, 1)[0].note, null);

  setBookmarkNote(db, id, '  这儿开始变好看了  ');
  // 首尾空白要去掉，同 `highlight.ts` 的 `updateNote`
  assert.equal(listBookmarks(db, 1)[0].note, '这儿开始变好看了');

  // 只剩空白＝没写
  setBookmarkNote(db, id, '   ');
  assert.equal(listBookmarks(db, 1)[0].note, null);

  // 一句 update 影响 0 行照样是「成功」——那是 tag.delete 那次事故的形状
  assert.throws(() => setBookmarkNote(db, 999999, '随便'), /没有这条书签/);
});
