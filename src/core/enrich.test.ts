import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import {
  normalizeForMatch,
  isExactMatch,
  applyCandidate,
  downloadCover,
  searchSource,
  validateCoverBytes,
  type Candidate,
} from './enrich.ts';
import { addLink, listLinks } from './links.ts';
import { listTags } from './library.ts';
import { coverDataUrl } from './cover.ts';

let dir: string;
let userData: string;
let db: DatabaseSync;
let bookId: number;

// 真 PNG 文件头 + 补齐到 2KB 以上——downloadCover 现在会校验字节大小，
// 原来那张 67 字节的 1x1 占位图过不了 validateCoverBytes 的下限
const PNG = Buffer.concat([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
  Buffer.alloc(2048),
]);

/** 假的 fetch：只认我们给的那几个地址 */
const fakeFetch = (routes: Record<string, { type?: string; body?: Buffer | string; status?: number }>) =>
  (async (url: string | URL | Request) => {
    const r = routes[String(url)];
    if (!r) return { ok: false, status: 404, headers: new Headers(), text: async () => '' } as Response;
    const headers = new Headers({ 'content-type': r.type ?? 'image/png' });
    const buf = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body ?? ''));
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers,
      text: async () => buf.toString('utf8'),
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    } as unknown as Response;
  }) as typeof globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-enrich-'));
  userData = join(dir, 'userData');
  mkdirSync(userData);
  db = openDb(join(dir, 'library.db'));
  bookId = Number(
    db.prepare("insert into book(title, author) values('斗破苍穹', '天蚕土豆')").run().lastInsertRowid,
  );
  db.prepare('insert into reading_state(book_id) values(?)').run(bookId);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── 匹配判据 ─────────────────────────────────────────────

test('归一化只做不改变身份的处理', () => {
  assert.equal(normalizeForMatch('《斗破苍穹》'), '斗破苍穹');
  assert.equal(normalizeForMatch(' 斗破 苍穹 '), '斗破苍穹');
  assert.equal(normalizeForMatch('ＡＢＣ'), 'abc', '全角转半角');
  assert.notEqual(normalizeForMatch('斗破苍穹'), normalizeForMatch('斗破苍穹之无上之境'));
});

test('书名和作者都一致才算匹配', () => {
  const local = { title: '斗破苍穹', author: '天蚕土豆' };
  assert.equal(isExactMatch(local, { title: '《斗破苍穹》', author: '天蚕土豆' }).matched, true);
  assert.equal(isExactMatch(local, { title: '斗破苍穹', author: '别人' }).matched, false);
  assert.equal(isExactMatch(local, { title: '斗破苍穹2', author: '天蚕土豆' }).matched, false);
});

test('本地没有作者时不算匹配——只靠书名认太容易张冠李戴', () => {
  const r = isExactMatch({ title: '斗破苍穹', author: null }, { title: '斗破苍穹', author: '天蚕土豆' });
  assert.equal(r.matched, false);
  assert.match(r.reason!, /只靠书名/);
});

test('不匹配时说清楚是哪儿对不上', () => {
  const r = isExactMatch({ title: '甲', author: '乙' }, { title: '丙', author: '乙' });
  assert.match(r.reason!, /书名不一致/);
  assert.match(r.reason!, /甲/);
  assert.match(r.reason!, /丙/);
});

// ── 应用候选 ─────────────────────────────────────────────

const good: Candidate = {
  title: '斗破苍穹',
  author: '天蚕土豆',
  url: 'https://example.com/book/1',
  coverUrl: 'https://example.com/cover.png',
  category: '玄幻',
  tags: ['热血', '升级流'],
  intro: '这是简介',
  site: '示例站',
};

const routes = { 'https://example.com/cover.png': { type: 'image/png', body: PNG } };

test('完全匹配时把官网、封面、分类、标签都补上', async () => {
  const r = await applyCandidate(db, userData, bookId, good, { fetchImpl: fakeFetch(routes) });

  assert.ok(r.applied.includes('官网地址'));
  assert.ok(r.applied.includes('封面'));
  assert.ok(r.applied.some((x) => x.includes('玄幻')));
  assert.ok(r.applied.some((x) => x.includes('标签')));

  assert.equal(listLinks(db, bookId).length, 1);
  assert.equal(listLinks(db, bookId)[0].is_primary, 1);
  assert.deepEqual(listTags(db).map((t) => t.name).sort(), ['升级流', '热血']);
  assert.ok(await coverDataUrl(db, bookId));
  assert.equal(
    (db.prepare('select source_site from book where id = ?').get(bookId) as { source_site: string })
      .source_site,
    '示例站',
  );
});

test('已有主地址的书应用候选，不会被候选的官网悄悄顶替成主地址', async () => {
  // 用户自己填的地址（模拟手工设置）
  addLink(db, bookId, 'https://user.example/mine');
  assert.equal(listLinks(db, bookId).find((l) => l.url === 'https://user.example/mine')?.is_primary, 1);

  const r = await applyCandidate(db, userData, bookId, good, { fetchImpl: fakeFetch(routes) });
  assert.ok(r.applied.includes('官网地址'), '候选的官网地址照样要记下来');

  const links = listLinks(db, bookId);
  assert.equal(links.length, 2);
  assert.equal(
    links.find((l) => l.url === 'https://user.example/mine')?.is_primary,
    1,
    '用户自己设的主地址不该被抓来的候选覆盖',
  );
  assert.equal(links.find((l) => l.url === good.url)?.is_primary, 0);
});

test('不匹配的候选一律拒绝，一个字段都不写', async () => {
  await assert.rejects(
    () => applyCandidate(db, userData, bookId, { ...good, author: '张冠李戴' }, { fetchImpl: fakeFetch(routes) }),
    /作者不一致/,
  );
  assert.equal(listLinks(db, bookId).length, 0);
  assert.equal(listTags(db).length, 0);
  assert.equal(await coverDataUrl(db, bookId), null);
});

test('本地已有的简介和封面不被覆盖', async () => {
  db.prepare("update book set intro = '我自己写的简介' where id = ?").run(bookId);
  await applyCandidate(db, userData, bookId, good, { fetchImpl: fakeFetch(routes) });
  assert.equal(
    (db.prepare('select intro from book where id = ?').get(bookId) as { intro: string }).intro,
    '我自己写的简介',
  );

  // 再来一次，这次本地已经有封面了
  const before = readdirSync(join(userData, 'covers')).length;
  const r = await applyCandidate(db, userData, bookId, good, { fetchImpl: fakeFetch(routes) });
  assert.ok(r.skipped.some((s) => s.includes('封面')));
  assert.equal(readdirSync(join(userData, 'covers')).length, before, '不该又下一张');
});

test('封面下载按 Content-Type 定扩展名，不信 URL 后缀', async () => {
  const url = 'https://example.com/img?id=123'; // 没有后缀
  const path = await downloadCover(userData, bookId, url, {
    fetchImpl: fakeFetch({ [url]: { type: 'image/jpeg', body: PNG } }),
  });
  assert.ok(path.endsWith('.jpg'), path);
  assert.ok(existsSync(path));
});

test('返回的不是图片就拒绝，别把一个 HTML 错误页当封面存下来', async () => {
  const url = 'https://example.com/notfound';
  await assert.rejects(
    () => downloadCover(userData, bookId, url, {
      fetchImpl: fakeFetch({ [url]: { type: 'text/html', body: '<html>404</html>' } }),
    }),
    /不是图片/,
  );
});

test('封面下载失败不该让整条补全失败', async () => {
  const r = await applyCandidate(
    db,
    userData,
    bookId,
    { ...good, coverUrl: 'https://example.com/broken.png' },
    { fetchImpl: fakeFetch({}) },
  );
  assert.ok(r.applied.includes('官网地址'), '别的字段照常写进去');
  assert.ok(r.skipped.some((s) => s.includes('封面')));
});

test('标签会被清洗：去空、限长、限量', async () => {
  await applyCandidate(
    db,
    userData,
    bookId,
    { ...good, tags: ['  正常  ', '', '   ', '这个标签特别特别特别特别特别特别长超过二十个字了', ...Array.from({ length: 20 }, (_, i) => `标签${i}`)] },
    { fetchImpl: fakeFetch(routes) },
  );
  const tags = listTags(db).map((t) => t.name);
  assert.ok(tags.includes('正常'), '首尾空白要去掉');
  assert.ok(!tags.some((t) => t.length > 20), '过长的不要');
  assert.ok(tags.length <= 12, `最多 12 个，实际 ${tags.length}`);
});

// ── 可插拔的抓取源 ───────────────────────────────────────

test('按配置的正则从搜索页提取候选', async () => {
  const html = `
    <li><a href="/b/1">斗破苍穹</a><span>天蚕土豆</span></li>
    <li><a href="/b/2">雪中悍刀行</a><span>烽火戏诸侯</span></li>`;
  const url = 'https://site.test/search?q=%E6%96%97%E7%A0%B4%E8%8B%8D%E7%A9%B9';

  const list = await searchSource(
    {
      name: '测试站',
      searchUrl: 'https://site.test/search?q={q}',
      itemPattern: '<a href="([^"]+)">([^<]+)</a><span>([^<]+)</span>',
      urlGroup: 1,
      titleGroup: 2,
      authorGroup: 3,
    },
    '斗破苍穹',
    { fetchImpl: fakeFetch({ [url]: { type: 'text/html', body: html } }) },
  );

  assert.equal(list.length, 2);
  assert.equal(list[0].title, '斗破苍穹');
  assert.equal(list[0].author, '天蚕土豆');
  assert.equal(list[0].site, '测试站');
});

test('提取规则的正则坏了要说清楚', async () => {
  await assert.rejects(
    () =>
      searchSource(
        { name: 'x', searchUrl: 'https://site.test/s?q={q}', itemPattern: '(未闭合', titleGroup: 1, authorGroup: 2 },
        '书',
        { fetchImpl: fakeFetch({ 'https://site.test/s?q=%E4%B9%A6': { type: 'text/html', body: 'x' } }) },
      ),
    /正则无效/,
  );
});

// ── 封面字节校验 ──────────────────────────

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(4000).fill(0)]);

test('校验：真 JPEG 过，占位图 URL 拒', () => {
  assert.equal(validateCoverBytes(JPEG, 'https://bookcover.yuewen.com/x/150').ok, true);
  const r = validateCoverBytes(JPEG, 'https://x/images/common/default_book.png');
  assert.equal(r.ok, false, '占位图必须被拒，哪怕字节看起来像图');
});

test('校验：不是图片的字节拒（看文件头，不是看扩展名）', () => {
  const html = new TextEncoder().encode('<html>404 not found</html>'.repeat(200));
  assert.equal(validateCoverBytes(html, 'https://x/cover.jpg').ok, false);
});

test('校验：太小和太大都拒', () => {
  assert.equal(validateCoverBytes(JPEG.slice(0, 500), 'https://x/c').ok, false, '500 字节不是封面');
  const huge = new Uint8Array(6 * 1024 * 1024);
  huge.set([0xff, 0xd8, 0xff]);
  assert.equal(validateCoverBytes(huge, 'https://x/c').ok, false);
});

test('校验：PNG 和 WEBP 也认', () => {
  const png = new Uint8Array(3000); png.set([0x89, 0x50, 0x4e, 0x47]);
  assert.equal(validateCoverBytes(png, 'https://x/c').ok, true);
  const webp = new Uint8Array(3000);
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(validateCoverBytes(webp, 'https://x/c').ok, true);
});
