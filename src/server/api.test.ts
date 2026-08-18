import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, openReadonly, migrate, SCHEMA_VERSION } from '../core/db.ts';
import { createApiServer, listen, runQuery, collectStats, MAX_ROWS } from './api.ts';
import { READING_STATUS } from '../core/labels.ts';
import { countBooks, shelfCounts, UNREVIEWED } from '../core/library.ts';
import { TOUCHED_STATUS } from '../core/labels.ts';

let dir: string;
let dbPath: string;
let server: ReturnType<typeof createApiServer>;
let base: string;

/**
 * Windows 上没关的 sqlite 句柄会锁住文件，`rmSync` 直接 EPERM。
 * 所有连接都从这里开，`after` 里统一关。
 */
const opened: DatabaseSync[] = [];
function ro(): DatabaseSync {
  const db = openReadonly(dbPath);
  opened.push(db);
  return db;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'novel-'));
  dbPath = join(dir, 'library.db');

  const db = openDb(dbPath);
  db.prepare("insert into book(id, title, author) values(1, '雪中悍刀行', '烽火戏诸侯')").run();
  db.prepare("insert into book(id, title, author) values(2, '诡秘之主', '爱潜水的乌贼')").run();
  db.prepare("insert into reading_state(book_id, status) values(1, 'reading')").run();
  db.prepare("insert into reading_state(book_id, status) values(2, 'dropped')").run();
  db.close();

  server = createApiServer({
    readonlyDb: ro(),
    rpc: { echo: (p) => p, boom: () => { throw new Error('故意失败'); } },
  });
  const port = await listen(server, 0); // 0 = 让系统挑个空闲端口，测试不占用 30036
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  for (const db of opened) {
    try { db.close(); } catch { /* 已经关过 */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-api': '1' }) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('迁移是幂等的，跑两遍版本号不变', () => {
  const p = join(dir, 'twice.db');
  const db = openDb(p);
  const v1 = (db.prepare('pragma user_version').get() as { user_version: number }).user_version;
  migrate(db);
  const v2 = (db.prepare('pragma user_version').get() as { user_version: number }).user_version;
  db.close();
  assert.equal(v1, SCHEMA_VERSION);
  assert.equal(v2, SCHEMA_VERSION);
});

test('只读连接必须真的写不进去', () => {
  // 这条钉的是 openReadonly 里那个大写 O：写成 readonly 会静默给出可写连接，
  // 实测能写进去。整个 /api/query 的只读保证就靠这一个字母。
  const ro = openReadonly(dbPath);
  assert.throws(
    () => ro.prepare("insert into book(title) values('偷写')").run(),
    /readonly/i,
  );
  ro.close();
});

test('拼错选项名（readonly 小写）确实是可写的——所以上面那条不能删', () => {
  const bad = new DatabaseSync(dbPath, { readonly: true } as never);
  bad.prepare("insert into book(title) values('证明可写')").run();
  bad.prepare("delete from book where title = '证明可写'").run();
  bad.close();
});

test('GET /api/stats 给出库概览', async () => {
  const r = await fetch(`${base}/api/stats`);
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.books, 2);
  // 主进程新旧的判据：外部工具拿 startedAt 对 src/**.ts 的 mtime，晚于它就是没重启；
  // pid 用来确认重启真的发生了。少了这两个字段，「改了 core 要重启」只能靠拿书试
  assert.ok(!Number.isNaN(Date.parse(s.startedAt)), 'startedAt 必须是可解析的时间');
  assert.ok(Number.isInteger(s.pid) && s.pid > 0);
  /*
   * **五个状态一个都不能少，没有就是 0。**
   * 原来这里是 `group by status`——一本都没有的状态**根本不返回行**，
   * 于是外部工具写 `byStatus.find(x => x.status === 'finished').n` 会当场炸，
   * 而它看起来只是「还没读完任何书」。这和界面上那条
   * 「一律显示数字，没有就是 0」是同一件事，只是这次的消费者是脚本。
   */
  const st = s.byStatus as Array<{ status: string; n: number }>;
  // **对着 `READING_STATUS` 断言，不在这儿抄一份状态清单**——
  // 那张表会长（现在就有一个界面上还没用的 `shelved`），抄下来的第二天就是错的
  assert.deepEqual(
    st.map((x) => x.status).sort(),
    READING_STATUS.map((x) => x.id).sort(),
    '每一档都要在，没有的那些 n = 0',
  );
  assert.equal(st.find((x) => x.status === 'reading')!.n, 1);
  assert.equal(st.find((x) => x.status === 'want')!.n, 0);

  /*
   * **概览里要有评价这一维。** 这个应用的正事是「下次不用再想这本我看过没」，
   * 而 `/api/stats` 原来只说书/文件/章节/根目录——一个不含评价的「库概览」
   * 恰好漏掉了它存在的理由。§13 说这是给外部工具的主通道，
   * 「我评过多少本了」不该逼人去写 SQL。
   */
  assert.equal(typeof s.rated, 'number', '打过分或写过短评的书数');
  assert.equal(typeof s.commented, 'number');
  assert.equal(typeof s.tags, 'number');
  assert.equal(typeof s.taggedBooks, 'number');
});

test('POST 不带 X-Api 头一律 403', async () => {
  // 挡的是浏览器里的跨站请求：任何网页都能对 localhost 发简单 POST，
  // 而 rpc 里有真改磁盘文件的操作
  const r = await post('/api/query', { sql: 'select 1' }, {});
  assert.equal(r.status, 403);
});

test('响应不带任何 CORS 头', async () => {
  const r = await fetch(`${base}/api/stats`);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('POST /api/query 能查数据', async () => {
  const r = await post('/api/query', {
    sql: 'select title from book where author = ? order by title',
    params: ['烽火戏诸侯'],
  });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(body.rows, [{ title: '雪中悍刀行' }]);
});

test('写操作经 /api/query 被挡下', async () => {
  const r = await post('/api/query', { sql: "insert into book(title) values('从接口偷写')" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /readonly/i);
});

test('多语句被拦下，并给出清楚的报错', () => {
  // node:sqlite 的 prepare 本身会放行 `select 1; drop ...`，得自己拦
  const ro = openReadonly(dbPath);
  assert.throws(() => runQuery(ro, 'select 1; drop table book', []), /一次只能执行一条语句/);
  assert.doesNotThrow(() => runQuery(ro, 'select 1;', []), '结尾的分号是正常写法');
  ro.close();
});

test('rpc 只认白名单里的方法', async () => {
  const ok = await post('/api/rpc', { method: 'echo', params: { a: 1 } });
  assert.equal((await ok.json()).result.a, 1);

  const bad = await post('/api/rpc', { method: 'rename', params: {} });
  assert.equal(bad.status, 404);
  assert.deepEqual((await bad.json()).available, ['echo', 'boom']);
});

test('rpc 方法内部报错不该让服务崩掉', async () => {
  const r = await post('/api/rpc', { method: 'boom', params: {} });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /故意失败/);
  assert.equal((await fetch(`${base}/api/stats`)).status, 200, '服务应该还活着');
});

test('原型链上的名字不算白名单方法', async () => {
  const r = await post('/api/rpc', { method: 'constructor', params: {} });
  assert.equal(r.status, 404);
});

test('端口被占时返回 null，而不是抛出去', async () => {
  // 维护接口是附属品，起不来只能记日志，不能拖垮应用
  const a = createApiServer({ readonlyDb: ro(), rpc: {} });
  const port = await listen(a, 0);
  assert.ok(port);
  const b = createApiServer({ readonlyDb: ro(), rpc: {} });
  assert.equal(await listen(b, port!), null);
  a.close();
  b.close();
});

test('超过上限时边取边停，不是先全取回来再切', () => {
  // 原来是 `all()` 之后 `slice(0, MAX_ROWS)`——上限只挡住「发出去多少」，
  // 挡不住「取出来多少」。真实库上 `select * from chapter` 因此要 17 秒 / 4 GB RSS，
  // 而这是 Electron 主进程。
  //
  // 判据是 **rowCount 必须等于 MAX_ROWS 而不是 20 万**：那个数只有在
  // 「取满就不再往下走」的实现里才拿得到，退回 all().slice() 会立刻变成 200000。
  const db = ro();
  const sql =
    'with recursive n(i) as (select 1 union all select i + 1 from n where i < 200000) select i from n';
  const r = runQuery(db, sql, []) as { rows: unknown[]; rowCount: number; truncated: boolean };
  assert.equal(r.rows.length, MAX_ROWS);
  assert.equal(r.rowCount, MAX_ROWS, 'rowCount 是「返回了几行」，不是全表总数');
  assert.equal(r.truncated, true);

  // 没到上限时照常给全部，truncated 为假
  const small = runQuery(db, 'select id from book', []) as { rowCount: number; truncated: boolean };
  assert.equal(small.rowCount, 2);
  assert.equal(small.truncated, false);
});

test('两个连接都设了 busy_timeout，不是默认的 0', () => {
  // node:sqlite 默认 busy_timeout = 0：撞锁立刻报 database is locked，一次不重试。
  // 这个应用主进程在写、维护接口的只读连接在读，扫描期间调一次 /api/stats
  // 就可能让正在写的那个文件直接失败——用户的库里真的这么坏过 126 个文件。
  const w = openDb(join(dir, 'busy.db'));
  const r = ro();
  try {
    assert.ok(
      (w.prepare('pragma busy_timeout').get() as { timeout: number }).timeout > 0,
      '写连接必须设',
    );
    assert.ok(
      (r.prepare('pragma busy_timeout').get() as { timeout: number }).timeout > 0,
      '读连接也要设',
    );
  } finally {
    w.close();
  }
});

/*
 * **「评价过」的判据只此一份。**
 *
 * 书架「我的书评」那一档（`buildFilter` 的 `rated`）和 `/api/stats` 的 `rated`
 * 原来是两份长得一样的 SQL。改一处漏一处不会有任何报错——
 * 侧栏说 40 本、外部工具拿到 12 本，谁也说不清哪个对。
 *
 * 这条断言顺带回答一个真问题：**被屏蔽的书算不算评价过**。
 * 两边的口径本来就不一样（`buildFilter` 默认不显示屏蔽的书，
 * 而 stats 数的是整张 `reading_state` 表），所以只在「没有屏蔽」的库上对账。
 */
test('「评价过」的口径：书架那一档和 /api/stats 说的是同一个数', () => {
  // 另开一个干净的库：这个文件里那个共享的 db 已经有别的测试塞进去的书了
  const p2 = join(dir, 'rated.db');
  const db = openDb(p2);
  const mk = (title: string, patch: { rating?: number; comment?: string }) => {
    const id = Number(db.prepare('insert into book(title) values(?)').run(title).lastInsertRowid);
    db.prepare("insert into reading_state(book_id, status) values(?, 'none')").run(id);
    if (patch.rating !== undefined) db.prepare('update reading_state set rating = ? where book_id = ?').run(patch.rating, id);
    if (patch.comment !== undefined) db.prepare('update reading_state set comment = ? where book_id = ?').run(patch.comment, id);
    return id;
  };
  mk('只打了分', { rating: 4 });
  mk('只写了短评', { comment: '烂尾了别看' });
  mk('都有', { rating: 5, comment: '一口气看完' });
  mk('空短评不算', { comment: '' });
  mk('什么都没有', {});

  const shelf = countBooks(db, { rated: true });
  const stats = collectStats(db).rated as number;
  assert.equal(shelf, stats, `书架说 ${shelf}、stats 说 ${stats}`);
  assert.equal(shelf, 3, '有星级或有短评都算，空短评不算');
  db.close();
});

/*
 * **「读过没评价」的判据也只此一份。** 侧栏那一档、书架那一档和 `/api/stats`
 * 现在都引 `core/library.ts` 的 `UNREVIEWED`——这条断言直接拿三边的数对账，
 * 比「共用了同一个常量」硬：常量可以被绕开，数字对不上就是对不上。
 *
 * 顺带把口径本身钉住：**两半缺一不可**。光「没评价」是整个书库
 * （真实库 8171 本，那不是待办）；光「读过」会把已经写完的也算进去。
 */
test('「读过没评价」：侧栏、书架和 /api/stats 说的是同一个数', () => {
  const p3 = join(dir, 'todo.db');
  const db = openDb(p3);
  const mk = (title: string, status: string, comment?: string) => {
    const id = Number(db.prepare('insert into book(title) values(?)').run(title).lastInsertRowid);
    db.prepare('insert into reading_state(book_id, status) values(?, ?)').run(id, status);
    if (comment) db.prepare('update reading_state set comment = ? where book_id = ?').run(comment, id);
    return id;
  };
  mk('读完了还没写', 'finished');
  mk('弃了还没写', 'dropped');
  mk('读完也写了', 'finished', '烂尾了别看');
  mk('还没翻开过', 'none');
  mk('只是想读', 'want');

  const shelf = countBooks(db, UNREVIEWED);
  const side = shelfCounts(db).unreviewed;
  const stats = collectStats(db).unreviewed as number;
  // 这个库里没有被屏蔽的书，所以三边应该完全相等；
  // 屏蔽之后 stats 会比另外两个大，那是**有意的**——见下面那条测试
  assert.equal(shelf, 2, '只有「读过 + 没写」那两本算待办');
  assert.equal(side, shelf, `侧栏说 ${side}、书架说 ${shelf}`);
  assert.equal(stats, shelf, `stats 说 ${stats}、书架说 ${shelf}`);

  // 拆掉任意一半都会变大：这条保证上面那个 2 不是碰巧
  assert.ok(countBooks(db, { rated: false }) > shelf, '光「没评价」会把没翻开过的也算进来');
  assert.ok(countBooks(db, { readingStatus: TOUCHED_STATUS }) > shelf, '光「读过」会把写完的也算进来');
  db.close();
});

/*
 * **`/api/stats` 里的几个数，对「被屏蔽的书」要用同一个口径。**
 *
 * 那个对象里 `rated` / `commented` / `byStatus` 数的都是整张 `reading_state`
 * （屏蔽的也算），而 `countBooks` 默认把屏蔽的挡在外面。
 * `unreviewed` 第一版就是直接 `countBooks(UNREVIEWED)`——于是同一个 JSON 里
 * `rated` 含屏蔽、`unreviewed` 不含，**外部工具拿这两个数一比就是笔糊涂账**
 * （当场量到 2 对 1）。
 *
 * 侧栏和书架那两处**照旧不含屏蔽**：那是「屏蔽了就不该出现在书架上」，
 * 和这里不是一件事。所以这条测试钉的是「两套口径各自自洽」。
 */
test('/api/stats 的 unreviewed 和 rated 一样含被屏蔽的书；侧栏那份照旧不含', () => {
  const p4 = join(dir, 'excluded.db');
  const db = openDb(p4);
  const root = Number(db.prepare("insert into library_root(path) values('D:/x')").run().lastInsertRowid);
  const mk = (title: string, excluded: number, comment: string | null) => {
    const id = Number(db.prepare('insert into book(title) values(?)').run(title).lastInsertRowid);
    db.prepare("insert into reading_state(book_id, status, comment) values(?, 'finished', ?)")
      .run(id, comment);
    db.prepare(
      `insert into book_file(book_id, root_id, path, size, mtime, is_primary, excluded)
       values(?,?,?,1,1,1,?)`,
    ).run(id, root, `D:/x/${title}.txt`, excluded);
  };
  mk('没屏蔽·写过了', 0, '写过了');
  mk('没屏蔽·没写', 0, null);
  mk('屏蔽了·写过了', 1, '写过了');
  mk('屏蔽了·没写', 1, null);

  const s = collectStats(db);
  assert.equal(s.rated, 2, '前置：rated 本来就含被屏蔽的');
  assert.equal(s.unreviewed, 2, 'unreviewed 要和它同口径，不然两个数没法一起用');
  assert.equal(shelfCounts(db).unreviewed, 1, '侧栏那份照旧不含被屏蔽的');
  assert.equal(countBooks(db, UNREVIEWED), 1, '书架那一档同上');
  db.close();
});

