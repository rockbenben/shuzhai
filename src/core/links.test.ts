import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import {
  addLink,
  listLinks,
  removeLink,
  setPrimaryLink,
  setLinkSelector,
  siteFromUrl,
  extractUrls,
  extractLatest,
  statusLabel,
  checkLinks,
  updateHints,
  checkUpdates,
  type ProbeFetch,
  type UpdateDeps,
} from './links.ts';

let dir: string;
let db: DatabaseSync;
let bookId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-link-'));
  db = openDb(join(dir, 'library.db'));
  bookId = Number(db.prepare("insert into book(title) values('测试书')").run().lastInsertRowid);
  db.prepare("insert into reading_state(book_id, status) values(?, 'want')").run(bookId);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 造一个假 fetch，记录被请求的顺序和时间 */
function fakeFetch(
  responses: Record<string, { status: number; body?: string } | 'throw'>,
  log?: Array<{ url: string; at: number }>,
): ProbeFetch {
  return async (url) => {
    log?.push({ url, at: Date.now() });
    const r = responses[url];
    if (r === 'throw' || r === undefined) throw new Error('连接失败');
    return { ok: r.status < 400, status: r.status, text: async () => r.body ?? '' };
  };
}

test('从 URL 推断站点名', () => {
  assert.equal(siteFromUrl('https://www.example.com/book/1'), 'example.com');
  assert.equal(siteFromUrl('http://sub.site.cn/x'), 'sub.site.cn');
  assert.equal(siteFromUrl('不是网址'), '');
});

test('从粘贴的一段文本里挑出网址并去重', () => {
  const text = `看这个 https://a.com/1 还有 https://b.com/2，
    重复的 https://a.com/1 应该只出现一次（https://c.com/3）`;
  assert.deepEqual(extractUrls(text), ['https://a.com/1', 'https://b.com/2', 'https://c.com/3']);
});

test('全角标点在网址中间也要断开', () => {
  // 端到端测出来的：`\S+` 会从全角逗号一路吞到后面的中文，
  // 只靠「剥结尾标点」救不了——逗号在中间，结尾是汉字
  assert.deepEqual(extractUrls('来源：https://a.com/1，备用 https://b.cn/2。'), [
    'https://a.com/1',
    'https://b.cn/2',
  ]);
  assert.deepEqual(extractUrls('见https://a.com/x（第二个）'), ['https://a.com/x']);
  // 反过来：URL 里合法的字符不能被误伤
  assert.deepEqual(extractUrls('https://a.com/p?q=1&r=2#frag'), ['https://a.com/p?q=1&r=2#frag']);
});

test('第一条地址自动成为主地址', () => {
  addLink(db, bookId, 'https://a.com/1');
  const links = listLinks(db, bookId);
  assert.equal(links.length, 1);
  assert.equal(links[0].is_primary, 1);
  assert.equal(links[0].site, 'a.com');
});

test('切换主地址时旧的要取消', () => {
  const a = addLink(db, bookId, 'https://a.com/1');
  const b = addLink(db, bookId, 'https://b.com/2');
  setPrimaryLink(db, b.id);

  const links = listLinks(db, bookId);
  assert.equal(links.find((l) => l.id === a.id)!.is_primary, 0);
  assert.equal(links.find((l) => l.id === b.id)!.is_primary, 1);
});

test('不合法的网址要挡下来', () => {
  assert.throws(() => addLink(db, bookId, '随便一段字'), /不是合法的网址/);
  assert.equal(listLinks(db, bookId).length, 0);
});

test('删书会连带删掉它的地址', () => {
  addLink(db, bookId, 'https://a.com/1');
  db.prepare('delete from book where id = ?').run(bookId);
  assert.equal(listLinks(db).length, 0);
});

/*
 * **只有 4xx 才算「这个页面真的没了」**——那是对面明确告诉我们的。
 * 没答上来（断网、DNS、超时）和 5xx 都只能算「说不好」：
 * 判成死链的话，**离线时跑一次探活会把全部链接一口气标红**，而那个结论会落库。
 * 同 `webdav.ts` 的「404 才是真的没有」、封面抓取的「一个源没答，结论就不可信」。
 */
test('HTTP 状态分三档：4xx 才是死链，没答上来和 5xx 都只算「疑似」', () => {
  assert.equal(statusLabel(200), 'ok');
  assert.equal(statusLabel(301), 'ok');
  assert.equal(statusLabel(403), 'suspect', '可能只是反爬，书未必没了');
  assert.equal(statusLabel(429), 'suspect');
  assert.equal(statusLabel(404), 'dead', '对面明说这个页面没了');
  assert.equal(statusLabel(410), 'dead');
  assert.equal(statusLabel(null), 'suspect', '根本没答上来——不知道就别说它死了');
  assert.equal(statusLabel(503), 'suspect', '服务器那头的毛病，多半是暂时的');
});

test('探活结果写回数据库', async () => {
  addLink(db, bookId, 'https://alive.com/1');
  addLink(db, bookId, 'https://dead.com/2');

  const report = await checkLinks(db, listLinks(db, bookId), {
    gapMs: 0,
    fetchImpl: fakeFetch({ 'https://alive.com/1': { status: 200 }, 'https://dead.com/2': { status: 404 } }),
  });

  assert.equal(report.checked, 2);
  assert.equal(report.ok, 1);
  assert.equal(report.dead, 1);

  const links = listLinks(db, bookId);
  assert.equal(links.find((l) => l.url.includes('alive'))!.last_status, 'ok');
  assert.equal(links.find((l) => l.url.includes('dead'))!.last_status, 'dead');
  assert.ok(links[0].last_checked_at, '要记下检查时间');
});

/*
 * 这条测试原来叫「只记成死链」，钉的是**两件事**：连接失败不许把整轮检测打断，
 * 以及它被记了下来。前一半仍然成立、也仍然是重点；
 * **后一半的结论改了**——没答上来记成「疑似」，不记成死链（理由见上一条）。
 */
test('连接失败不抛出去，而且不冤枉它——记「疑似」不记死链', async () => {
  addLink(db, bookId, 'https://boom.com/1');
  addLink(db, bookId, 'https://gone.com/2');
  const report = await checkLinks(db, listLinks(db, bookId), {
    gapMs: 0,
    fetchImpl: fakeFetch({ 'https://boom.com/1': 'throw', 'https://gone.com/2': { status: 404 } }),
  });
  assert.equal(report.checked, 2, '一条炸了不该打断整轮');
  assert.equal(report.dead, 1, '只有那条 404 算死链');
  const links = listLinks(db, bookId);
  assert.equal(
    links.find((l) => l.url.includes('boom'))!.last_status, 'suspect',
    '连不上就判死链的话，离线跑一次探活会把全部链接标红',
  );
  assert.equal(links.find((l) => l.url.includes('gone'))!.last_status, 'dead');
});

test('同域名串行且有间隔，不同域名并行', async () => {
  // 并发轰一个小站不礼貌，也容易被封
  addLink(db, bookId, 'https://same.com/1');
  addLink(db, bookId, 'https://same.com/2');
  addLink(db, bookId, 'https://other.com/1');

  const log: Array<{ url: string; at: number }> = [];
  const start = Date.now();
  await checkLinks(db, listLinks(db, bookId), {
    gapMs: 60,
    fetchImpl: fakeFetch(
      {
        'https://same.com/1': { status: 200 },
        'https://same.com/2': { status: 200 },
        'https://other.com/1': { status: 200 },
      },
      log,
    ),
  });

  const same = log.filter((l) => l.url.includes('same.com')).map((l) => l.at);
  assert.equal(same.length, 2);
  assert.ok(same[1] - same[0] >= 55, `同域两次请求间隔应 ≥ 60ms，实际 ${same[1] - same[0]}ms`);

  const other = log.find((l) => l.url.includes('other.com'))!;
  assert.ok(other.at - start < 55, '别的域名不该被这个间隔拖住');
});

test('用正则从页面提取最新章节', () => {
  const html = '<div class="last"><a href="/c/999">第一千章 大结局</a></div>';
  assert.equal(extractLatest(html, '<a href="/c/\\d+">([^<]+)</a>'), '第一千章 大结局');
  assert.equal(extractLatest(html, '找不到的模式'), null);
  assert.equal(extractLatest(html, '('), null, '坏正则不该让整轮检测炸掉');
});

test('远端最新章在本地找不到，才算有更新', () => {
  // 角标只对 ongoing 书亮
  db.prepare("update book set serial_status = 'ongoing' where id = ?").run(bookId);
  const fileId = Number(
    db
      .prepare(
        "insert into book_file(book_id, path, size, mtime, is_primary) values(?, 'C:\\a.txt', 1, 1, 1)",
      )
      .run(bookId).lastInsertRowid,
  );
  for (const [i, t] of ['第一章 起', '第二章 承'].entries()) {
    db.prepare('insert into chapter(file_id, idx, title, offset, length) values(?,?,?,0,1)').run(
      fileId,
      i,
      t,
    );
  }

  const { id } = addLink(db, bookId, 'https://a.com/1', { selector: 'x' });
  db.prepare("update online_link set latest_chapter_title = '第二章 承' where id = ?").run(id);
  assert.equal(updateHints(db)[0].hasUpdate, false, '本地已经有这一章，不该报更新');

  db.prepare("update online_link set latest_chapter_title = '第三章 转' where id = ?").run(id);
  const hint = updateHints(db)[0];
  assert.equal(hint.hasUpdate, true);
  assert.equal(hint.localLast, '第二章 承');
  assert.equal(hint.remoteLatest, '第三章 转');
});

test('updateHints：本地没有章节的书（PDF/EPUB、手工书）不判有更新', () => {
  // 有文件但 0 章——PDF/EPUB 在 chapter 表就是 0 行
  const pdf = 种书(db, { title: 'pdf书', serial: 'ongoing' });
  const l1 = addLink(db, pdf, 'https://a.com/pdf');
  db.prepare("update online_link set latest_chapter_title = '第999章' where id = ?").run(l1.id);
  // 连文件都没有——手工书（beforeEach 的默认书）
  db.prepare("update book set serial_status = 'ongoing' where id = ?").run(bookId);
  const l2 = addLink(db, bookId, 'https://a.com/manual');
  db.prepare("update online_link set latest_chapter_title = '第999章' where id = ?").run(l2.id);

  const hints = updateHints(db);
  assert.equal(hints.length, 2, 'ongoing + 有末章记录，条目在');
  for (const h of hints) {
    assert.equal(h.hasUpdate, false, '本地没有章节可比，「找不到」是必然，不许报更新');
    assert.equal(h.localLast, null);
  }
});

test('updateHints：只认连载中——完结/弃坑的书末章不亮角标', () => {
  // 完结书单本手查可能把推广文案当末章写进来，但角标不该亮
  const done = 种书(db, { title: '完本', serial: 'finished', chapters: ['第一章'] });
  const ld = addLink(db, done, 'https://a.com/done');
  db.prepare("update online_link set latest_chapter_title = '第三章 转' where id = ?").run(ld.id);
  const drop = 种书(db, { title: '弃坑', serial: 'abandoned', chapters: ['第一章'] });
  const la = addLink(db, drop, 'https://a.com/drop');
  db.prepare("update online_link set latest_chapter_title = '第三章 转' where id = ?").run(la.id);
  // 对照：ongoing 的同一条末章要亮
  const on = 种书(db, { title: '连载', serial: 'ongoing', chapters: ['第一章'] });
  const lo = addLink(db, on, 'https://a.com/on');
  db.prepare("update online_link set latest_chapter_title = '第三章 转' where id = ?").run(lo.id);

  const hints = updateHints(db);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].bookId, on);
  assert.equal(hints[0].hasUpdate, true);
});

test('删掉地址后就不再检测它', () => {
  const { id } = addLink(db, bookId, 'https://a.com/1');
  removeLink(db, id);
  assert.equal(listLinks(db, bookId).length, 0);
});

test('addLink 去重：同书同归一化 URL 不插第二行', () => {
  const a = addLink(db, bookId, 'https://www.shuqi.com/book/53258.html');
  const b = addLink(db, bookId, 'https://www.shuqi.com/book/53258.html/'); // 尾斜杠
  const c = addLink(db, bookId, 'https://www.shuqi.com/book/53258.html#frag'); // 碎片
  const d = addLink(db, bookId, 'HTTPS://WWW.SHUQI.COM/book/53258.html'); // host 大写
  assert.equal(a.id, b.id, '尾斜杠应视为同一地址');
  assert.equal(a.id, c.id, 'hash 碎片应视为同一地址');
  assert.equal(a.id, d.id, 'host 大小写应视为同一地址');
  assert.equal(listLinks(db, bookId).length, 1);
  // 第一行仍是主地址
  assert.equal(listLinks(db, bookId)[0].is_primary, 1);

  // 不同书、相同 URL 正常插
  const otherId = Number(db.prepare("insert into book(title) values('另一本书')").run().lastInsertRowid);
  db.prepare("insert into reading_state(book_id, status) values(?, 'want')").run(otherId);
  const e = addLink(db, otherId, 'https://www.shuqi.com/book/53258.html');
  assert.notEqual(e.id, a.id, '不同书的同 URL 应该是两行');
  assert.equal(listLinks(db, bookId).length + listLinks(db, otherId).length, 2);

  // 不同 URL 正常插
  const f = addLink(db, bookId, 'https://www.shuqi.com/book/99999.html');
  assert.notEqual(f.id, a.id);
  assert.equal(listLinks(db, bookId).length, 2);
});

test('setLinkSelector：空串清除，坏正则报错', () => {
  const { id } = addLink(db, bookId, 'https://example.com/x');
  setLinkSelector(db, id, '最新章节[^<]*<[^>]*>([^<]+)');
  assert.equal(listLinks(db, bookId)[0].selector, '最新章节[^<]*<[^>]*>([^<]+)');
  // 空串/空白＝清除
  setLinkSelector(db, id, '   ');
  assert.equal(listLinks(db, bookId)[0].selector, null);
  // 坏正则当场抛，消息以「提取正则无效」开头
  assert.throws(() => setLinkSelector(db, id, '('), /提取正则无效/);
  // 抛错后原值不变（仍是 null）
  assert.equal(listLinks(db, bookId)[0].selector, null);
});

// ── checkUpdates ────────────────────────────────────────────────

// 造一本书：book（给定 serial_status）+ book_file（is_primary=1）+ chapter 行
function 种书(
  db: DatabaseSync,
  opts: { title: string; author?: string; serial?: string; chapters?: string[] },
): number {
  const bookId = Number(
    db
      .prepare('insert into book(title, author, serial_status) values(?, ?, ?)')
      .run(opts.title, opts.author ?? null, opts.serial ?? 'unknown')
      .lastInsertRowid,
  );
  db.prepare("insert into reading_state(book_id, status) values(?, 'want')").run(bookId);
  const fileId = Number(
    db
      .prepare(
        "insert into book_file(book_id, path, size, mtime, is_primary) values(?, ?, 1, 1, 1)",
      )
      .run(bookId, `C:\\fake\\${bookId}.txt`)
      .lastInsertRowid,
  );
  for (const [i, t] of (opts.chapters ?? []).entries()) {
    db.prepare('insert into chapter(file_id, idx, title, offset, length) values(?,?,?,0,1)').run(
      fileId,
      i,
      t,
    );
  }
  return bookId;
}

function mkDeps(
  pages: Record<string, { status?: number; text?: string }>,
  browser: Record<string, string> = {},
): UpdateDeps {
  return {
    gapMs: 0,
    fetchText: async (url) => {
      const p = pages[url];
      if (!p) throw new Error('没配这个 URL：' + url);
      return { status: p.status ?? 200, text: p.text ?? '' };
    },
    browserText: async (url) => {
      const t = browser[url];
      if (t === undefined) throw new Error('浏览器没配这个 URL：' + url);
      return t;
    },
  };
}

test('checkUpdates：书旗适配器取最新章并落库', async () => {
  const bid = 种书(db, {
    title: '斗破苍穹', author: '天蚕土豆', serial: 'ongoing',
    chapters: ['第一章 陨落的天才', '第二章 斗气大陆'],
  });
  addLink(db, bid, 'https://www.shuqi.com/book/53258.html', { isPrimary: true });
  const deps = mkDeps({
    'https://www.shuqi.com/chapter?bid=53258': {
      text: '<a href="/reader?bid=53258&cid=1">第一章 陨落的天才</a><a href="/reader?bid=53258&cid=99">第九十九章 新章</a>',
    },
  });
  const r = await checkUpdates(db, deps);
  assert.equal(r.checked, 1);
  assert.equal(r.updated, 1);
  assert.equal(r.withUpdates, 1);
  const link = listLinks(db, bid)[0];
  assert.equal(link.latest_chapter_title, '第九十九章 新章');
  assert.equal(link.last_status, 'ok');
});

test('checkUpdates：未知站走 selector；都没有只探活；失败静默', async () => {
  const b1 = 种书(db, { title: '甲', author: '作者甲', serial: 'ongoing', chapters: ['第一章'] });
  addLink(db, b1, 'https://example.com/book/1', { isPrimary: true, selector: '最新：([^<]+)' });
  const b2 = 种书(db, { title: '乙', author: '作者乙', serial: 'ongoing', chapters: ['第一章'] });
  addLink(db, b2, 'https://example.org/plain', { isPrimary: true });
  const b3 = 种书(db, { title: '丙', author: '作者丙', serial: 'ongoing', chapters: ['第一章'] });
  addLink(db, b3, 'https://dead.example.net/x', { isPrimary: true });

  const r = await checkUpdates(db, mkDeps({
    'https://example.com/book/1': { text: '<div>最新：第十二章 新的</div>' },
    'https://example.org/plain': { text: '<html>活着</html>' },
    // dead.example.net 不在 pages 里 → fetchText 抛错
  }));
  assert.equal(r.checked, 3);
  assert.equal(listLinks(db, b1)[0].latest_chapter_title, '第十二章 新的');
  assert.equal(listLinks(db, b2)[0].latest_chapter_title, null);
  assert.equal(listLinks(db, b2)[0].last_status, 'ok');
  assert.equal(listLinks(db, b3)[0].last_status, 'suspect');
});

test('checkUpdates：完结/未知的书不查（除非点名 bookId）', async () => {
  const done = 种书(db, { title: '完本', author: 'x', serial: 'finished', chapters: ['第一章'] });
  addLink(db, done, 'https://www.shuqi.com/book/1.html', { isPrimary: true });
  const r1 = await checkUpdates(db, mkDeps({}));
  assert.equal(r1.checked, 0);
  // 点名就查
  const r2 = await checkUpdates(db, mkDeps({
    'https://www.shuqi.com/chapter?bid=1': { text: '<a href="/reader?bid=1&cid=2">第二章</a>' },
  }), { bookId: done });
  assert.equal(r2.checked, 1);
});

test('checkUpdates：needsBrowser 但没注入浏览器时跳过，不写状态、不计 checked', async () => {
  // 起点必须浏览器渲染；没注入 browserText 就应该静默跳过，
  // 不抛错、不写 last_status（免得污染）、不计入 checked 计数
  const bid = 种书(db, {
    title: '武炼巅峰', author: '莫默', serial: 'ongoing',
    chapters: ['第一章'],
  });
  const { id } = addLink(db, bid, 'https://www.qidian.com/book/1234/', { isPrimary: true });
  // 上一轮检查留下的末章记录：本地只有「第一章」，这本该 hint hasUpdate=true——
  // 但本轮跳过了没查，withUpdates 不能把它算进去（「查了 0 本、1 本有更新」自相矛盾）
  db.prepare("update online_link set latest_chapter_title = '第三章 转' where id = ?").run(id);
  // 故意不传 browserText（deps 里只有 fetchText）
  const deps: UpdateDeps = {
    gapMs: 0,
    fetchText: async () => ({ status: 200, text: '' }),
  };
  const r = await checkUpdates(db, deps);
  assert.equal(r.checked, 0, '没浏览器就跳过，不该计入 checked');
  assert.equal(r.withUpdates, 0, '跳过的书不算「本轮查到有更新」');
  const link = listLinks(db, bid)[0];
  assert.equal(link.last_status, null, '跳过的不该写 last_status，免得污染');
  assert.equal(link.last_checked_at, null, '跳过的不该写 last_checked_at');
});

test('checkUpdates：单本检查时非主链接也探活；批量时非主链接不查', async () => {
  const bid = 种书(db, { title: '某书', author: '某作者', serial: 'ongoing', chapters: ['第一章'] });
  addLink(db, bid, 'https://www.qidian.com/book/1234/'); // 第一条＝主链接，要浏览器
  addLink(db, bid, 'https://example.com/backup');         // 非主链接，普通站
  // 不提供 browserText：主链接会跳过；非主链接只探活、只许请求它自己
  const deps: UpdateDeps = {
    gapMs: 0,
    fetchText: async (url) => {
      if (url === 'https://example.com/backup') return { status: 200, text: '' };
      throw new Error('不该请求这个 URL：' + url);
    },
  };

  const r = await checkUpdates(db, deps, { bookId: bid });
  const links = listLinks(db, bid);
  const primary = links.find((l) => l.is_primary === 1)!;
  const backup = links.find((l) => l.is_primary === 0)!;
  assert.equal(primary.last_status, null, '主链接缺浏览器跳过，不写状态');
  assert.equal(backup.last_status, 'ok', '非主链接单本检查时要探活');
  assert.equal(backup.latest_chapter_title, null, '非主链接不取最新章');
  assert.equal(r.checked, 1);
  assert.equal(r.withUpdates, 0);

  // 批量模式：非主链接不在范围内（只查 ongoing 书的主链接；主链接缺浏览器照样跳过）
  const r2 = await checkUpdates(db, deps);
  assert.equal(r2.checked, 0);
  assert.equal(
    listLinks(db, bid).find((l) => l.is_primary === 0)!.last_status,
    'ok',
    '批量不该动非主链接的状态',
  );
});

test('checkUpdates：parseLatest 带 serial 时只补 unknown', async () => {
  const b = 种书(db, { title: '武炼巅峰', author: '莫默', serial: 'unknown', chapters: ['第一章'] });
  addLink(db, b, 'https://www.zongheng.com/book/2.html', { isPrimary: true });
  const body = JSON.stringify({ data: { datas: { list: [
    { name: '武炼巅峰', authorName: '莫默', serialStatus: 1, chapterName: '终章' },
  ] } } });
  const url = 'https://search.zongheng.com/search/book?keyword=' + encodeURIComponent('武炼巅峰');
  const pages: Record<string, { text: string }> = {};
  pages[url] = { text: body };
  await checkUpdates(db, mkDeps(pages), { bookId: b });
  assert.equal(
    (db.prepare('select serial_status from book where id=?').get(b) as { serial_status: string })
      .serial_status,
    'finished',
  );
});
