import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import {
  nextPending, recordResult, fetchStats, resetMisses, resetFailed, dropResults,
} from './cover-source.ts';

let dir: string;
let db: DatabaseSync;

/** 直接造数据，不走扫描——队列只看 book 表和 cover_fetch 表 */
function addBook(title: string, author: string | null, coverPath: string | null = null): number {
  return Number(
    db.prepare('insert into book(title, author, cover_path) values(?,?,?)')
      .run(title, author, coverPath).lastInsertRowid,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-cover-'));
  db = openDb(join(dir, 'library.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('迁移 15 建出 cover_fetch 表', () => {
  const t = db.prepare("select name from sqlite_master where name = 'cover_fetch'").get();
  assert.ok(t, 'cover_fetch 表应该存在');
});

test('队列：没封面且没试过的才出队，按 id 顺序', () => {
  const a = addBook('甲', '某人');
  addBook('乙', '某人', 'C:/covers/has.jpg'); // 有封面，不该出队
  const c = addBook('丙', '某人');

  assert.equal(nextPending(db)!.id, a);
  recordResult(db, a, 'ok', 'qidian');
  assert.equal(nextPending(db)!.id, c, '记过结果的不再出队');
  recordResult(db, c, 'nomatch', 'qidian');
  assert.equal(nextPending(db), null, '全试过就空了');
});

test('队列 SQL 就是断点：记过结果的重启后天然跳过', () => {
  // 没有「进度」这个状态要存，也就没有它和现实脱节的可能
  const a = addBook('甲', '某人');
  const b = addBook('乙', '某人');
  recordResult(db, a, 'failed', 'qidian', '超时');
  assert.equal(nextPending(db)!.id, b);
});

test('统计四个数对得上', () => {
  const a = addBook('甲', '某人');
  const b = addBook('乙', '某人');
  addBook('丙', '某人');
  recordResult(db, a, 'ok', 'qidian');
  recordResult(db, b, 'nomatch', 'douban');
  assert.deepEqual(fetchStats(db), { pending: 1, done: 1, nomatch: 1, failed: 0 });
});

// 「重试没匹配上的」和「failed 回队列」是两码事，判据的可信度差着量级：
// nomatch 是问过了站上没有（实测重试 0/10），failed 是没问出来。捆在一起的话，
// 想把限流那几本捞回来就得连带发一百多次注定白打的请求——而那正是限流的成因
test('重试只删 nomatch，ok 和 failed 都不动', () => {
  const a = addBook('甲', '某人');
  const b = addBook('乙', '某人');
  const c = addBook('丙', '某人');
  recordResult(db, a, 'ok', 'qidian');
  recordResult(db, b, 'nomatch', 'qidian');
  recordResult(db, c, 'failed', 'qidian', '超时');

  assert.equal(resetMisses(db), 1);
  const left = db.prepare('select book_id from cover_fetch order by book_id').all().map((r) => ({ ...r }));
  assert.deepEqual(left, [{ book_id: a }, { book_id: c }], 'ok 和 failed 的行都要留着');
  assert.equal(nextPending(db)!.id, b, '删掉的重新进队列');
});

test('dropResults 只清指定的几本，空数组不拼出坏 SQL', () => {
  const a = addBook('甲', '某人');
  const b = addBook('乙', '某人');
  const c = addBook('丙', '某人');
  recordResult(db, a, 'nomatch', 'qidian');
  recordResult(db, b, 'nomatch', 'qidian');
  recordResult(db, c, 'ok', 'qidian');

  assert.equal(dropResults(db, []), 0, '空数组直接返回，别拼 in ()');
  assert.equal(dropResults(db, [a, b]), 2);
  const left = db.prepare('select book_id from cover_fetch').all().map((r) => ({ ...r }));
  assert.deepEqual(left, [{ book_id: c }], '没点名的不许动');
});

test('resetFailed 只删 failed——「没问出来」不该是终态', () => {
  const a = addBook('甲', '某人');
  const b = addBook('乙', '某人');
  const c = addBook('丙', '某人');
  recordResult(db, a, 'ok', 'qidian');
  recordResult(db, b, 'nomatch', 'qidian');
  recordResult(db, c, 'failed', 'qidian', '起点连续空结果，可能被限流');

  assert.equal(resetFailed(db), 1);
  // nextPending 只看「有没有行」不看状态，所以删掉就等于回队列
  assert.equal(nextPending(db)!.id, c, 'failed 的那本重新排到队里');
  assert.equal(fetchStats(db).nomatch, 1, 'nomatch 不受影响');
});

test('同一本书重复记结果是覆盖，不是报错', () => {
  const a = addBook('甲', '某人');
  recordResult(db, a, 'failed', 'qidian', '超时');
  recordResult(db, a, 'ok', 'qidian');
  assert.equal(fetchStats(db).done, 1);
  assert.equal(fetchStats(db).failed, 0);
});

// ────────────────────────────────────────────────────────────────────────
// 候选提取

import {
  parseQidianCandidates, parseDoubanCandidates, parseShuqiCandidates, probeSaysHealthy, doubanAnswered,
} from './cover-source.ts';

// 结构照 2026-08-13 实测的真实页面造：data-bid / h3>a 内嵌 cite / p.author>a.name /
// img 的 src 是占位图、真图在 data-original 且是协议相对地址
const QIDIAN_FIXTURE = `
<ul class="all-img-list">
<li class="res-book-item" data-bid="2494758" data-rid="1">
  <div class="book-img-box"><a href="//www.qidian.com/book/2494758/">
    <img class="lazy" src="//qdfepccdn.qidian.com/www.qidian.com/images/common/default_book.png"
         data-original="//bookcover.yuewen.com/qdbimg/349573/2494758/150" alt="武炼巅峰在线阅读">
  </a></div>
  <div class="book-mid-info">
    <h3 class="book-info-title"><a href="//www.qidian.com/book/2494758/">武炼<cite class="red-kw">巅峰</cite></a></h3>
    <p class="author"><img src="x.png"><a class="name" href="//my.qidian.com/author/1">莫默</a><em>|</em><a>玄幻</a></p>
  </div>
</li>
<li class="res-book-item" data-bid="1044574502" data-rid="2">
  <div class="book-img-box"><a href="//www.qidian.com/book/1044574502/">
    <img class="lazy" src="//qdfepccdn.qidian.com/www.qidian.com/images/common/default_book.png"
         data-original="//bookcover.yuewen.com/qdbimg/349573/1044574502/150">
  </a></div>
  <div class="book-mid-info">
    <h3 class="book-info-title"><a href="//www.qidian.com/book/1044574502/">年代1982</a></h3>
    <p class="author"><a class="name">炼心心心</a></p>
  </div>
</li>
</ul>`;

test('起点提取：剥内嵌标签、封面取 data-original 并补协议、书页由 data-bid 拼', () => {
  const c = parseQidianCandidates(QIDIAN_FIXTURE);
  assert.equal(c.length, 2);
  assert.equal(c[0].title, '武炼巅峰', '关键词高亮的 <cite> 必须剥掉');
  assert.equal(c[0].author, '莫默');
  assert.equal(c[0].coverUrl, 'https://bookcover.yuewen.com/qdbimg/349573/2494758/150');
  assert.equal(c[0].url, 'https://www.qidian.com/book/2494758/');
  assert.equal(c[0].site, 'qidian');
});

test('起点提取：绝不把 src 里的懒加载占位图当封面', () => {
  // src 取到的是 default_book.png——抓下来会是 8000 张一模一样的占位图，
  // 而且界面上看起来一切正常
  for (const c of parseQidianCandidates(QIDIAN_FIXTURE)) {
    assert.ok(!c.coverUrl?.includes('default_book'), `${c.title} 的封面是占位图`);
  }
});

// 结构照 2026-08-16 实测的真实页面造。两块：matchbook 是精确匹配那一本，
// searchlist-main 是模糊推荐的相关结果
const SHUQI_FIXTURE = `
<div class="matchbook"><div class="view page-width">
  <a class="cover" href="/book/53258.html"><img src="https://img-tailor.11222.cn/bcv/big/11590353258_sa.jpg"></a>
  <div class="bookTitle"><a class="bname" href="/book/53258.html">斗破<em>苍穹</em></a></div>
  <div class="bauthor">作者：天蚕土豆</div>
</div></div>
<div class="searchlist-main"><ul><li>
  <a class="book-cover" href="/book/9163025.html"><img src="https://img-tailor.11222.cn/bcv/big/9163025_sa.jpg"></a>
  <a class="bname" href="/book/9163025.html">斗破苍穹之无上之境</a>
  <div class="bauthor">作者：别人</div>
</li></ul></div>`;

test('书旗提取：书名剥高亮、作者去掉「作者：」、封面和书页都取到', () => {
  const c = parseShuqiCandidates(SHUQI_FIXTURE);
  assert.equal(c.length, 1);
  assert.equal(c[0].title, '斗破苍穹', '关键词高亮的 <em> 必须剥掉');
  assert.equal(c[0].author, '天蚕土豆');
  assert.equal(c[0].coverUrl, 'https://img-tailor.11222.cn/bcv/big/11590353258_sa.jpg');
  assert.equal(c[0].url, 'https://www.shuqi.com/book/53258.html');
  assert.equal(c[0].site, 'shuqi');
});

test('书旗提取：只收精确匹配块，下面的相关结果一个都不收', () => {
  // 相关结果是模糊推荐（搜《人间冰器》给的是《人间有剑》）。收进来最好的情况是
  // 白跑一遍 isExactMatch，最坏的情况是书名作者恰好都撞上 —— 那就配错封面了
  const c = parseShuqiCandidates(SHUQI_FIXTURE);
  assert.ok(!c.some((x) => x.title.includes('无上之境')), '相关结果不能混进来');
});

test('书旗提取：没有精确匹配块时返回空，不抛', () => {
  assert.deepEqual(parseShuqiCandidates('<html><div class="searchlist-main">只有相关结果</div></html>'), []);
  assert.deepEqual(parseShuqiCandidates(''), []);
});

test('豆瓣：反爬页和「真的没搜到」必须分得开', () => {
  // 真的没搜到时页面里照样有 __DATA__，items 是空的
  assert.equal(doubanAnswered('<script>window.__DATA__ = {"items":[]};</script>'), true);
  assert.deepEqual(parseDoubanCandidates('<script>window.__DATA__ = {"items":[]};</script>'), []);
  // 反爬页是 HTTP 200，光看状态码看不出来。当成「没搜到」的话，一整段时间里
  // 走到豆瓣这步的书全被写成「没匹配上」并持久化——实测那段抽 8 本重试，5 本立刻命中
  assert.equal(doubanAnswered('<html>请输入验证码</html>'), false);
  assert.equal(doubanAnswered(''), false);
});

test('探针：搜到那本已知一定在的书才算站点是好的', () => {
  assert.equal(probeSaysHealthy(QIDIAN_FIXTURE), true, 'fixture 第一条就是《武炼巅峰》');
  // 限流时返回的正是「有候选但一本都不对」的页面——这种形状「连续 0 候选」
  // 那条守卫完全看不见，实测一口气写坏了 186 本
  assert.equal(probeSaysHealthy(QIDIAN_FIXTURE.replaceAll('武炼', '别的书')), false);
  assert.equal(probeSaysHealthy('<html>空搜索页</html>'), false);
});

test('探针：模糊相关不算数，必须精确书名', () => {
  // 起点搜不到的时候会给一堆「相关作品」。《武炼巅峰之xxx》说明的恰恰是
  // 那本书没搜着，不能拿它证明站点是好的
  assert.equal(probeSaysHealthy(QIDIAN_FIXTURE.replace('武炼<cite class="red-kw">巅峰</cite>', '武炼巅峰之无上剑域')), false);
});

test('豆瓣提取：从 window.__DATA__ 的 JSON 里取', () => {
  const html = `<html><script>
    window.__DATA__ = {"items":[
      {"title":"从零开始","abstract":"雷云风暴 / 某出版社 / 2010","cover_url":"https://img.douban/x.jpg"},
      {"title":"[丛书] 从零开始学","abstract":"机械工业出版社","cover_url":""}
    ]};
  </script></html>`;
  const c = parseDoubanCandidates(html);
  assert.equal(c.length, 2);
  assert.equal(c[0].title, '从零开始');
  assert.equal(c[0].author, '雷云风暴', 'abstract 按 / 切的第一段是作者');
  assert.equal(c[0].site, 'douban');
});

test('豆瓣提取：页面里没有 __DATA__ 时返回空数组，不抛', () => {
  assert.deepEqual(parseDoubanCandidates('<html>验证码页面</html>'), []);
});

test('豆瓣提取：abstract 里含有 }; 字面量时仍能正确提取（不能被截断）', () => {
  // 这是实测的 bug：懒惰匹配 *? 会在 abstract 里的 }; 处截断，导致整页都空。
  // 如果某本书的摘要含有字面量 };（比如引用了代码片段或特殊格式），
  // 正则会在那里停止，整页候选全清零
  const html = `<html><script>
    window.__DATA__ = {"items":[
      {"title":"书A","abstract":"某作者 / 出版社；引用：};","cover_url":"https://x/a.jpg"},
      {"title":"书B","abstract":"某作者 / 出版社；代码};","cover_url":"https://x/b.jpg"},
      {"title":"书C","abstract":"某作者 / 出版社；花括},{","cover_url":"https://x/c.jpg"}
    ]};
  </script></html>`;
  const c = parseDoubanCandidates(html);
  assert.equal(c.length, 3, 'abstract 里有 }; 也要全部提取出来');
  assert.equal(c[0].title, '书A');
  assert.equal(c[1].title, '书B');
  assert.equal(c[2].title, '书C');
});

test('豆瓣提取：嵌套花括号的处理', () => {
  const html = `<html><script>
    window.__DATA__ = {"items":[
      {"title":"单花括","abstract":"作者 / {单}","cover_url":"https://x/1.jpg"},
      {"title":"嵌套花括","abstract":"作者 / {套{嵌}}","cover_url":"https://x/2.jpg"}
    ]};
  </script></html>`;
  const c = parseDoubanCandidates(html);
  assert.equal(c.length, 2, '嵌套花括号不应该截断');
  assert.equal(c[0].title, '单花括');
  assert.equal(c[1].title, '嵌套花括');
});

// ────────────────────────────────────────────────────────────────────────
// 带别名的严格匹配

import { matchWithAliases } from './cover-source.ts';
import type { Candidate } from './enrich.ts';

const cand = (title: string, author: string | null): Candidate =>
  ({ title, author, site: 'qidian' }) as Candidate;

test('别名匹配：《国产英雄(我的邻居是女妖)》括号内外都算数', () => {
  // 库里 171 本书名带括号别名，跟任何站点都不会整串相等——拆开试
  const local = { title: '国产英雄(我的邻居是女妖)', author: '某人' };
  assert.ok(matchWithAliases(local, [cand('国产英雄', '某人')]));
  assert.ok(matchWithAliases(local, [cand('我的邻居是女妖', '某人')]));
  assert.equal(matchWithAliases(local, [cand('国产英雄', '别人')]), null, '作者不同必须拒');
});

test('全角括号也认', () => {
  const local = { title: '酒神（阴阳冕）', author: '唐家三少' };
  assert.ok(matchWithAliases(local, [cand('酒神', '唐家三少')]));
});

test('没作者直接不匹配——只靠书名认太容易张冠李戴', () => {
  assert.equal(matchWithAliases({ title: '冬与狮', author: null }, [cand('冬与狮', '兰晓龙')]), null);
});

test('多个候选里挑出精确匹配的那个，不是首条', () => {
  // 实测：搜「官仙」首条是《重置世界：从女儿被夺舍开始》——首条几乎总是错书
  const local = { title: '武炼巅峰', author: '莫默' };
  const hit = matchWithAliases(local, [
    cand('武炼至尊', '冶山熊'),
    cand('武炼巅峰', '莫默'),
    cand('武炼苍天', '犯戒和尚'),
  ]);
  assert.equal(hit?.author, '莫默');
});
