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
  siteFromUrl,
  extractUrls,
  extractLatest,
  statusLabel,
  checkLinks,
  updateHints,
  type ProbeFetch,
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

test('删掉地址后就不再检测它', () => {
  const { id } = addLink(db, bookId, 'https://a.com/1');
  removeLink(db, id);
  assert.equal(listLinks(db, bookId).length, 0);
});
