import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  adapterForUrl, qidianAdapter, shuqiAdapter, doubanAdapter, zonghengAdapter, fanqieAdapter,
  duyueduAdapter, jjwxcAdapter, falooAdapter,
  adapterById, matchWithAliases, probeSaysHealthy, doubanAnswered, HEALTH_PROBE,
  applySerialIfUnknown, backfillSerial, parseOpenGraph, detailCandidateFromHtml,
} from './site-adapters.ts';
import type { Candidate } from './enrich.ts';

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // 最小 schema：只建 book 表（serial_status 默认 'unknown'）
  db.exec(`
    create table book (
      id integer primary key autoincrement,
      title text not null default '',
      serial_status text not null default 'unknown'
    );
  `);
  return db;
}

test('adapterForUrl 按域名认适配器', () => {
  assert.equal(adapterForUrl('https://www.qidian.com/book/1013232012/')?.id, 'qidian');
  assert.equal(adapterForUrl('https://m.qidian.com/foo')?.id, 'qidian'); // 子域名也算
  assert.equal(adapterForUrl('//www.shuqi.com/book/53258.html')?.id, 'shuqi'); // 协议相对
  assert.equal(adapterForUrl('https://search.douban.com/book/')?.id, 'douban');
  assert.equal(adapterForUrl('https://example.com/x'), null); // 未知站
  assert.equal(adapterForUrl('不是网址'), null);
});

test('adapterById 返回正确适配器，未知站抛错', () => {
  assert.equal(adapterById('qidian').id, 'qidian');
  assert.equal(adapterById('shuqi').id, 'shuqi');
  assert.equal(adapterById('zongheng').id, 'zongheng');
  assert.equal(adapterById('fanqie').id, 'fanqie');
  assert.equal(adapterById('douban').id, 'douban');
  assert.throws(() => adapterById('unknown'), /不认识的站点/);
});

// ────────────────────────────────────────────────────────────────────────
// 候选提取

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
  const parse = qidianAdapter.parseCandidates!;
  const c = parse(QIDIAN_FIXTURE);
  assert.equal(c.length, 2);
  assert.equal(c[0].title, '武炼巅峰', '关键词高亮的 <cite> 必须剥掉');
  assert.equal(c[0].author, '莫默');
  assert.equal(c[0].coverUrl, 'https://bookcover.yuewen.com/qdbimg/349573/2494758/150');
  assert.equal(c[0].url, 'https://www.qidian.com/book/2494758/');
  assert.equal(c[0].site, 'qidian');
});

test('起点提取：绝不把 src 里的懒加载占位图当封面', () => {
  const parse = qidianAdapter.parseCandidates!;
  // src 取到的是 default_book.png——抓下来会是 8000 张一模一样的占位图，
  // 而且界面上看起来一切正常
  for (const c of parse(QIDIAN_FIXTURE)) {
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
  const parse = shuqiAdapter.parseCandidates!;
  const c = parse(SHUQI_FIXTURE);
  assert.equal(c.length, 1);
  assert.equal(c[0].title, '斗破苍穹', '关键词高亮的 <em> 必须剥掉');
  assert.equal(c[0].author, '天蚕土豆');
  assert.equal(c[0].coverUrl, 'https://img-tailor.11222.cn/bcv/big/11590353258_sa.jpg');
  assert.equal(c[0].url, 'https://www.shuqi.com/book/53258.html');
  assert.equal(c[0].site, 'shuqi');
});

test('书旗提取：只收精确匹配块，下面的相关结果一个都不收', () => {
  const parse = shuqiAdapter.parseCandidates!;
  // 相关结果是模糊推荐（搜《人间冰器》给的是《人间有剑》）。收进来最好的情况是
  // 白跑一遍 isExactMatch，最坏的情况是书名作者恰好都撞上 —— 那就配错封面了
  const c = parse(SHUQI_FIXTURE);
  assert.ok(!c.some((x) => x.title.includes('无上之境')), '相关结果不能混进来');
});

test('书旗提取：没有精确匹配块时返回空，不抛', () => {
  const parse = shuqiAdapter.parseCandidates!;
  assert.deepEqual(parse('<html><div class="searchlist-main">只有相关结果</div></html>'), []);
  assert.deepEqual(parse(''), []);
});

test('豆瓣：反爬页和「真的没搜到」必须分得开', () => {
  const parse = doubanAdapter.parseCandidates!;
  // 真的没搜到时页面里照样有 __DATA__，items 是空的
  assert.equal(doubanAnswered('<script>window.__DATA__ = {"items":[]};</script>'), true);
  assert.deepEqual(parse('<script>window.__DATA__ = {"items":[]};</script>'), []);
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
  const parse = doubanAdapter.parseCandidates!;
  const html = `<html><script>
    window.__DATA__ = {"items":[
      {"title":"从零开始","abstract":"雷云风暴 / 某出版社 / 2010","cover_url":"https://img.douban/x.jpg"},
      {"title":"[丛书] 从零开始学","abstract":"机械工业出版社","cover_url":""}
    ]};
  </script></html>`;
  const c = parse(html);
  assert.equal(c.length, 2);
  assert.equal(c[0].title, '从零开始');
  assert.equal(c[0].author, '雷云风暴', 'abstract 按 / 切的第一段是作者');
  assert.equal(c[0].site, 'douban');
});

test('豆瓣提取：页面里没有 __DATA__ 时返回空数组，不抛', () => {
  const parse = doubanAdapter.parseCandidates!;
  assert.deepEqual(parse('<html>验证码页面</html>'), []);
});

test('豆瓣提取：abstract 里含有 }; 字面量时仍能正确提取（不能被截断）', () => {
  const parse = doubanAdapter.parseCandidates!;
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
  const c = parse(html);
  assert.equal(c.length, 3, 'abstract 里有 }; 也要全部提取出来');
  assert.equal(c[0].title, '书A');
  assert.equal(c[1].title, '书B');
  assert.equal(c[2].title, '书C');
});

test('豆瓣提取：嵌套花括号的处理', () => {
  const parse = doubanAdapter.parseCandidates!;
  const html = `<html><script>
    window.__DATA__ = {"items":[
      {"title":"单花括","abstract":"作者 / {单}","cover_url":"https://x/1.jpg"},
      {"title":"嵌套花括","abstract":"作者 / {套{嵌}}","cover_url":"https://x/2.jpg"}
    ]};
  </script></html>`;
  const c = parse(html);
  assert.equal(c.length, 2, '嵌套花括号不应该截断');
  assert.equal(c[0].title, '单花括');
  assert.equal(c[1].title, '嵌套花括');
});

// ────────────────────────────────────────────────────────────────────────
// 带别名的严格匹配

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

test('纵横适配器 coverSearch 为 false——不进封面链', () => {
  assert.equal(zonghengAdapter.coverSearch, false);
  assert.equal(zonghengAdapter.needsBrowser, false);
  assert.equal(zonghengAdapter.parseCandidates, undefined);
});

test('HEALTH_PROBE 仍指向《武炼巅峰》', () => {
  assert.equal(HEALTH_PROBE.title, '武炼巅峰');
  assert.equal(HEALTH_PROBE.author, '莫默');
});

// ────────────────────────────────────────────────────────────────────────
// 连载状态 + 最新章

test('书旗：matchbook 块里认连载状态', () => {
  const ongoing = '<div class="matchbook"><a class="bname" href="/book/123.html">某书</a>'
    + '<span class="bauthor">作者：张三</span><li>异界大陆</li><li>连载中</li></div>'
    + '<div class="searchlist-main">相关结果<div>完结</div></div>';
  assert.equal(shuqiAdapter.parseSerial!(ongoing, '某书'), 'ongoing');
  const finished = ongoing.replace('连载中', '完结');
  assert.equal(shuqiAdapter.parseSerial!(finished, '某书'), 'finished');
  // 没有精确匹配块（只有相关结果）→ null，不许吃到 searchlist-main 里的字
  assert.equal(shuqiAdapter.parseSerial!('<div class="searchlist-main">完结</div>', '某书'), null);
});

test('书旗：目录页最后一个 reader 链接是最新章', () => {
  const req = shuqiAdapter.latestRequest!({ title: '斗破苍穹', author: '天蚕土豆', url: 'https://www.shuqi.com/book/53258.html' });
  assert.deepEqual(req, { url: 'https://www.shuqi.com/chapter?bid=53258', needsBrowser: false });
  assert.equal(shuqiAdapter.latestRequest!({ title: 'x', author: null, url: 'https://example.com/x' }), null);

  // 真实页面：href 里 & 是实体 `&amp;cid=`，VIP 标记是 `<i class="vip-tag">VIP</i>` 还裹着换行
  const catalog = '<a target="_blank" href="/reader?bid=53258&amp;cid=2163513">1.第一章</a>'
    + '<a target="_blank" href="/reader?bid=53258&amp;cid=2166597" data-clog="x">1655.《斗破苍穹：斗帝之路》手游·角色传记（下）\n              \n                <i class="vip-tag">VIP</i>\n                \n              </a>';
  const r = shuqiAdapter.parseLatest!(catalog, { title: '斗破苍穹', author: '天蚕土豆', url: '' });
  assert.equal(r?.latest, '1655.《斗破苍穹：斗帝之路》手游·角色传记（下）');
  // 裸 & 和老形状的 em.vip 也不许坏
  const raw = '<a href="/reader?bid=1&cid=2">末章<em class="vip">VIP</em></a>';
  assert.equal(shuqiAdapter.parseLatest!(raw, { title: 'x', author: null, url: '' })?.latest, '末章');
  assert.equal(shuqiAdapter.parseLatest!('<html>没有章节链接</html>', { title: 'x', author: null, url: '' }), null);
});

// ── 纵横 ────────────────────────────────────────────────────────────────

test('纵横：搜索 JSON 里精确匹配后取状态和最新章，模糊相关不算', () => {
  const req = zonghengAdapter.latestRequest!({ title: '武炼巅峰', author: '莫默', url: 'https://www.zongheng.com/book/123.html' });
  assert.equal(req?.needsBrowser, false);
  assert.match(req!.url, /search\.zongheng\.com\/search\/book\?keyword=/);

  // 首条是模糊相关（书名不等），第二条才是真的
  const body = JSON.stringify({ code: 0, data: { datas: { list: [
    { bookId: 1, name: '边军小卒：杀敌爆气血', authorName: '爱小咪锋', serialStatus: 0, chapterName: '第76章 哄好俏娘子' },
    { bookId: 2, name: '武炼巅峰', authorName: '莫默', serialStatus: 1, chapterName: '第6019章 终章' },
  ] } } });
  const r = zonghengAdapter.parseLatest!(body, { title: '武炼巅峰', author: '莫默', url: 'https://www.zongheng.com/book/123.html' });
  assert.equal(r?.latest, '第6019章 终章');
  assert.equal(r?.serial, 'finished'); // serialStatus 1 = 完结

  const ongoing = body.replace('"serialStatus":1', '"serialStatus":0');
  assert.equal(zonghengAdapter.parseLatest!(ongoing, { title: '武炼巅峰', author: '莫默', url: 'https://www.zongheng.com/book/123.html' })?.serial, 'ongoing');

  // 只有模糊相关、没有精确匹配 → null（不许取首条）
  const fuzzy = body.replace(',"name":"武炼巅峰"', ',"name":"别的书"');
  assert.equal(zonghengAdapter.parseLatest!(fuzzy, { title: '武炼巅峰', author: '莫默', url: '' }), null);
  // 本地没作者 → 不认（同 isExactMatch）
  assert.equal(zonghengAdapter.parseLatest!(body, { title: '武炼巅峰', author: null, url: '' }), null);
  // 坏 JSON / 没有 list → null，不抛
  assert.equal(zonghengAdapter.parseLatest!('not json', { title: 'x', author: 'y', url: '' }), null);
  assert.equal(zonghengAdapter.parseLatest!(JSON.stringify({ code: 500 }), { title: 'x', author: 'y', url: '' }), null);
});

// ── 起点 连载状态 + 最新章 ─────────────────────────────────────────────
//
// fixture 从真页面裁最小片段（tmpcheck/probe-out-qidian-search.html / ongoing.html）
// 完结书：武炼巅峰 bid=2494758；连载书：奥特曼：继承遗愿，融合万界光芒 bid=1048358950

const QIDIAN_FINISHED_LI = `<li class="res-book-item jsAutoReport" data-bid="2494758" data-rid="1">
  <div class="book-mid-info">
    <h3 class="book-info-title"><a title="武炼巅峰在线阅读" href="//www.qidian.com/book/2494758/"> <cite class="red-kw">武炼巅峰</cite> </a></h3>
    <p class="author"><a class="name">莫默</a> <em>|</em><a>玄幻</a><em>|</em><span>完结</span></p>
    <p class="update"><a href="//www.qidian.com/chapter/2494758/898300423/">最新更新 真人短剧，4月10日上线</a><em>·</em><span>2026-04-09</span></p>
  </div></li>`;

const QIDIAN_ONGOING_LI = `<li class="res-book-item jsAutoReport" data-bid="1048358950" data-rid="1">
  <div class="book-mid-info">
    <h3 class="book-info-title"><a title="奥特曼：继承遗愿，融合万界光芒在线阅读" href="//www.qidian.com/book/1048358950/"> 奥特曼：继承遗愿，融合万界光芒 </a></h3>
    <p class="author"><a class="name">海中幻月</a> <em>|</em><a>诸天无限</a><em>|</em><span>连载</span></p>
    <p class="update"><a href="//www.qidian.com/chapter/1048358950/927358040/">最新更新 第345章 越说越来劲</a><em>·</em><span>23小时前</span></p>
  </div></li>`;

const QIDIAN_OTHER_LI = `<li class="res-book-item jsAutoReport" data-bid="1044574502" data-rid="2">
  <div class="book-mid-info">
    <h3 class="book-info-title"><a title="年代1982：每天一条赚钱情报在线阅读"> 年代1982：每天一条赚钱情报 </a></h3>
    <p class="author"><a class="name">炼心心心</a> <em>|</em><a>都市</a><em>|</em><span>连载</span></p>
    <p class="update"><a>最新更新 请假条</a></p>
  </div></li>`;

const QIDIAN_SEARCH_FIXTURE = `<ul>${QIDIAN_FINISHED_LI}${QIDIAN_OTHER_LI}</ul>`;
const QIDIAN_ONGOING_FIXTURE = `<ul>${QIDIAN_ONGOING_LI}${QIDIAN_OTHER_LI}</ul>`;

test('起点 parseSerial：完结书 → finished', () => {
  assert.equal(qidianAdapter.parseSerial!(QIDIAN_SEARCH_FIXTURE, '武炼巅峰'), 'finished');
});

test('起点 parseSerial：连载书 → ongoing', () => {
  assert.equal(qidianAdapter.parseSerial!(QIDIAN_ONGOING_FIXTURE, '奥特曼：继承遗愿，融合万界光芒'), 'ongoing');
});

test('起点 parseSerial：页面里没有这本书 → null', () => {
  assert.equal(qidianAdapter.parseSerial!(QIDIAN_SEARCH_FIXTURE, '不存在的书'), null);
  assert.equal(qidianAdapter.parseSerial!('<html>坏页面</html>', '武炼巅峰'), null);
  assert.equal(qidianAdapter.parseSerial!('', '武炼巅峰'), null);
});

test('起点 parseLatest：完结书 data-bid 优先匹配，末章 + serial finished', () => {
  const book = { title: '武炼巅峰', author: '莫默', url: 'https://www.qidian.com/book/2494758/' };
  const r = qidianAdapter.parseLatest!(QIDIAN_SEARCH_FIXTURE, book);
  assert.equal(r?.latest, '真人短剧，4月10日上线');
  assert.equal(r?.serial, 'finished');
});

test('起点 parseLatest：连载书最新章「第345章 越说越来劲」+ serial ongoing', () => {
  const book = { title: '奥特曼：继承遗愿，融合万界光芒', author: '海中幻月', url: 'https://www.qidian.com/book/1048358950/' };
  const r = qidianAdapter.parseLatest!(QIDIAN_ONGOING_FIXTURE, book);
  assert.equal(r?.latest, '第345章 越说越来劲');
  assert.equal(r?.serial, 'ongoing');
});

test('起点 parseLatest：data-bid 匹配 vs 书名匹配——bid 优先', () => {
  // bid 指向第二本（年代1982），书名是第一本（武炼巅峰）
  const book = { title: '武炼巅峰', author: '莫默', url: 'https://www.qidian.com/book/1044574502/' };
  const r = qidianAdapter.parseLatest!(QIDIAN_SEARCH_FIXTURE, book);
  // bid 命中那本，章名是「请假条」不是「真人短剧…」
  assert.equal(r?.latest, '请假条');
});

test('起点 parseLatest：bid 取不出时退回书名匹配', () => {
  // URL 不是起点标准格式，bid 取不出 → 靠书名
  const book = { title: '武炼巅峰', author: '莫默', url: 'https://example.com/x' };
  const r = qidianAdapter.parseLatest!(QIDIAN_SEARCH_FIXTURE, book);
  assert.equal(r?.latest, '真人短剧，4月10日上线');
  assert.equal(r?.serial, 'finished');
});

test('起点 parseLatest：没有这本书 / 坏 HTML → null，不抛', () => {
  const book = { title: '不存在的书', author: null, url: 'https://www.qidian.com/book/999999999/' };
  assert.equal(qidianAdapter.parseLatest!(QIDIAN_SEARCH_FIXTURE, book), null);
  assert.equal(qidianAdapter.parseLatest!('garbage', book), null);
  assert.equal(qidianAdapter.parseLatest!('', book), null);
});

test('起点 latestRequest：返回搜索页 URL，needsBrowser true', () => {
  const req = qidianAdapter.latestRequest!({ title: '武炼巅峰', author: '莫默', url: 'https://www.qidian.com/book/2494758/' });
  assert.equal(req?.needsBrowser, true);
  assert.match(req!.url, /qidian\.com\/so\//);
  assert.equal(decodeURIComponent(req!.url).includes('武炼巅峰'), true);
});

test('起点 title 带「在线阅读」后缀也能匹配上（title 属性 vs 锚文本两种形态）', () => {
  // 搜索结果里 title 属性是「武炼巅峰在线阅读」，锚文本剥标签后是「武炼巅峰」
  // parseSerial / parseLatest 两种都得认
  assert.equal(qidianAdapter.parseSerial!(QIDIAN_SEARCH_FIXTURE, '武炼巅峰'), 'finished');
  // 书名号/空格变体也要认（normalizeForMatch 已经处理）
  assert.equal(qidianAdapter.parseSerial!(QIDIAN_SEARCH_FIXTURE, '《武炼巅峰》'), 'finished');
});

// ── 番茄 ──────────────────────────────────────────────────────────────
//
// fixture 从 tmpcheck/probe-out-fanqie-api.html 裁最小片段，保留 <pre> 包裹形态
// 真 bookId=7069948840148732967，末章「第351章 不可思议的神罗大帝！姜玄的计划！」

const FANQIE_PRE_FIXTURE = `<html><head><meta charset="utf-8"></head><body><pre>{"data":{"chapterListWithVolume":[
  [{"itemId":"1","title":"第1章 部族生死战","volume_name":"第一卷：默认"},
   {"itemId":"2","title":"第2章 开局就送金手指","volume_name":"第一卷：默认"}],
  [{"itemId":"350","title":"第350章 大帝之威","volume_name":"第二卷：神路"},
   {"itemId":"351","title":"第351章 不可思议的神罗大帝！姜玄的计划！","volume_name":"第二卷：神路"}]
]},"code":0,"message":"success"}</pre></body></html>`;

const FANQIE_BARE_FIXTURE = `{"data":{"chapterListWithVolume":[
  [{"itemId":"1","title":"第1章 开天"},{"itemId":"2","title":"第2章 辟地"}],
  [{"itemId":"99","title":"第99章 最终章"}]
]},"code":0}`;

test('番茄：<pre> 包裹的目录接口响应，取末卷末章标题', () => {
  const r = fanqieAdapter.parseLatest!(FANQIE_PRE_FIXTURE, { title: 'x', author: null, url: '' });
  assert.equal(r?.latest, '第351章 不可思议的神罗大帝！姜玄的计划！');
  assert.equal(r?.serial, undefined, '番茄接口没有连载状态字段，不返回 serial');
});

test('番茄：裸 JSON 形态也能解析（stripTags 对纯 JSON 是恒等）', () => {
  const r = fanqieAdapter.parseLatest!(FANQIE_BARE_FIXTURE, { title: 'x', author: null, url: '' });
  assert.equal(r?.latest, '第99章 最终章');
});

test('番茄：坏 JSON / 没有 chapterListWithVolume → null，不抛', () => {
  assert.equal(fanqieAdapter.parseLatest!('not json', { title: 'x', author: null, url: '' }), null);
  assert.equal(fanqieAdapter.parseLatest!('{"code":500}', { title: 'x', author: null, url: '' }), null);
  assert.equal(fanqieAdapter.parseLatest!('<pre>{broken json</pre>', { title: 'x', author: null, url: '' }), null);
  assert.equal(fanqieAdapter.parseLatest!('', { title: 'x', author: null, url: '' }), null);
});

test('番茄：latestRequest 从 /page/{id} 取 id 拼 API URL，needsBrowser false', () => {
  const req = fanqieAdapter.latestRequest!({
    title: '某书', author: null,
    url: 'https://fanqienovel.com/page/7069948840148732967',
  });
  assert.equal(req?.needsBrowser, false);
  assert.match(req!.url, /fanqienovel\.com\/api\/reader\/directory\/detail\?bookId=7069948840148732967/);
});

test('番茄：非 /page/ 链接 latestRequest 返回 null', () => {
  assert.equal(fanqieAdapter.latestRequest!({
    title: 'x', author: null, url: 'https://fanqienovel.com/other/123',
  }), null);
  assert.equal(fanqieAdapter.latestRequest!({
    title: 'x', author: null, url: 'https://example.com/page/123',
  }), null);
});

test('番茄：coverSearch false / needsBrowser false / 没有 searchUrl 和 parseCandidates（不进封面链）', () => {
  assert.equal(fanqieAdapter.coverSearch, false);
  assert.equal(fanqieAdapter.needsBrowser, false);
  assert.equal(fanqieAdapter.searchUrl, undefined);
  assert.equal(fanqieAdapter.parseCandidates, undefined);
  assert.equal(fanqieAdapter.parseSerial, undefined, '番茄没有连载状态接口，不提供 parseSerial');
});

test('adapterForUrl：fanqienovel.com 认出 fanqie 适配器', () => {
  assert.equal(
    adapterForUrl('https://fanqienovel.com/page/7069948840148732967')?.id,
    'fanqie',
  );
});

// ────────────────────────────────────────────────────────────────────────
// 连载状态回填

test('applySerialIfUnknown：只补 unknown，用户标过的一律不碰', () => {
  const db = openDb();
  const id = Number(db.prepare("insert into book(title, serial_status) values('某书','unknown')").run().lastInsertRowid);
  assert.equal(applySerialIfUnknown(db, id, 'ongoing'), true);
  assert.equal((db.prepare('select serial_status from book where id=?').get(id) as {serial_status:string}).serial_status, 'ongoing');
  // 已经是 ongoing 的不覆盖
  assert.equal(applySerialIfUnknown(db, id, 'finished'), false);
  const abandoned = Number(db.prepare("insert into book(title, serial_status) values('太监书','abandoned')").run().lastInsertRowid);
  assert.equal(applySerialIfUnknown(db, abandoned, 'ongoing'), false);
  const finished = Number(db.prepare("insert into book(title, serial_status) values('完结书','finished')").run().lastInsertRowid);
  assert.equal(applySerialIfUnknown(db, finished, 'ongoing'), false);
});

test('backfillSerial：适配器认得出才补，豆瓣恒不补', () => {
  const db = openDb();
  const id = Number(db.prepare("insert into book(title) values('某书')").run().lastInsertRowid);
  const html = '<div class="matchbook"><a class="bname">某书</a><li>连载中</li></div>';
  assert.equal(backfillSerial(db, id, shuqiAdapter, html), 'ongoing');
  assert.equal((db.prepare('select serial_status from book where id=?').get(id) as {serial_status:string}).serial_status, 'ongoing');

  const id2 = Number(db.prepare("insert into book(title) values('豆瓣书')").run().lastInsertRowid);
  assert.equal(backfillSerial(db, id2, doubanAdapter, '<html>whatever</html>'), null);
  assert.equal((db.prepare('select serial_status from book where id=?').get(id2) as {serial_status:string}).serial_status, 'unknown');
});

test('backfillSerial：已经是 finished 的不覆盖', () => {
  const db = openDb();
  const id = Number(db.prepare("insert into book(title, serial_status) values('某书','finished')").run().lastInsertRowid);
  const html = '<div class="matchbook"><a class="bname">某书</a><li>连载中</li></div>';
  assert.equal(backfillSerial(db, id, shuqiAdapter, html), null);
  assert.equal((db.prepare('select serial_status from book where id=?').get(id) as {serial_status:string}).serial_status, 'finished');
});

// ────────────────────────────────────────────────────────────────────────
// 起点：别名书名匹配（parseSerial / parseLatest 两条路径都要认）

test('起点 parseSerial：带括号别名的书名也能命中', () => {
  // 页面上是《武炼巅峰》，本地是《武炼巅峰（正传）》——别名要对上
  assert.equal(qidianAdapter.parseSerial!(QIDIAN_SEARCH_FIXTURE, '武炼巅峰（正传）'), 'finished');
  assert.equal(qidianAdapter.parseSerial!(QIDIAN_SEARCH_FIXTURE, '武炼巅峰(正传)'), 'finished');
  // 反过来：本地产《武炼巅峰》，页面上只有别名 → 不会命中（因为 match 是 local→candidate 单向的）
  // 这条是预期行为：titleVariants 拆的是本地书名的括号，不是候选的
});

test('起点 parseLatest：书名兜底匹配也认别名', () => {
  // bid 取不出时退回书名匹配；本地书名带别名
  const book = { title: '武炼巅峰（正传）', author: '莫默', url: 'https://example.com/x' };
  const r = qidianAdapter.parseLatest!(QIDIAN_SEARCH_FIXTURE, book);
  assert.equal(r?.latest, '真人短剧，4月10日上线');
  assert.equal(r?.serial, 'finished');
});

test('纵横：书名/作者/章名里的 font 高亮标签必须剥掉再匹配和存库', () => {
  // 实测《剑来》的命中书名就是 <font color="RED">剑来</font>
  // ——匹配前和取章名前都要剥标签（探针实测结论 纵横节）
  const body = JSON.stringify({ code: 0, data: { datas: { list: [
    {
      bookId: 100,
      name: '<font color="RED">剑来</font>',
      authorName: '烽火戏诸侯',
      serialStatus: 1,
      chapterName: '第12章 <font color="RED">剑</font>气长城',
    },
  ] } } });
  const r = zonghengAdapter.parseLatest!(body, { title: '剑来', author: '烽火戏诸侯', url: '' });
  assert.equal(r?.latest, '第12章 剑气长城', '章名里的 font 标签必须剥掉');
  assert.equal(r?.serial, 'finished', '书名带 font 标签也必须能匹配上');

  // 作者也带标签
  const body2 = JSON.stringify({ code: 0, data: { datas: { list: [
    {
      bookId: 101,
      name: '剑来',
      authorName: '<font color="RED">烽火戏诸侯</font>',
      serialStatus: 0,
      chapterName: '第一章',
    },
  ] } } });
  assert.equal(
    zonghengAdapter.parseLatest!(body2, { title: '剑来', author: '烽火戏诸侯', url: '' })?.serial,
    'ongoing',
    '作者带 font 标签也必须能匹配上',
  );
});

// ────────────────────────────────────────────────────────────────────────
// 详情页提取（用户粘了链接，一键取封面/简介/作者）——结构照实测真实页面造

// 起点详情页：关键信息全在服务端直出的 og:novel:* 里（隐藏窗口渲染后）
const QIDIAN_DETAIL = `
<head>
<meta property="og:title" content="斗破苍穹">
<meta property="og:image" content="//bookcover.yuewen.com/qdbimg/349573/1209977/180.webp">
<meta property="og:description" content="这里是属于斗气的世界，没有花俏艳丽的魔法。">
<meta property="og:novel:book_name" content="斗破苍穹">
<meta property="og:novel:author" content="天蚕土豆">
<meta property="og:novel:category" content="异世大陆">
<meta property="og:novel:status" content="完本">
<meta property="og:novel:tag" content="玄幻/热血/升级">
<meta property="og:url" content="https://www.qidian.com/book/1209977/">
</head>`;

test('parseOpenGraph 读 og:novel:*，协议相对封面补 https:，标签按斜杠拆', () => {
  const c = parseOpenGraph(QIDIAN_DETAIL, 'qidian');
  assert.ok(c);
  assert.equal(c!.title, '斗破苍穹');
  assert.equal(c!.author, '天蚕土豆');
  assert.equal(c!.category, '异世大陆');
  assert.deepEqual(c!.tags, ['玄幻', '热血', '升级']);
  assert.equal(c!.intro, '这里是属于斗气的世界，没有花俏艳丽的魔法。');
  assert.equal(c!.coverUrl, 'https://bookcover.yuewen.com/qdbimg/349573/1209977/180.webp');
  assert.equal(c!.site, 'qidian');
});

test('起点适配器的 parseDetail 走通用 og 解析', () => {
  const c = qidianAdapter.parseDetail!(QIDIAN_DETAIL, 'https://www.qidian.com/book/1209977/');
  assert.equal(c?.title, '斗破苍穹');
  assert.equal(c?.author, '天蚕土豆');
});

// 书旗详情页：没有 og 标签，走专属选择器（实测）
const SHUQI_DETAIL = `
<title>《斗破苍穹》最新章节免费阅读_天蚕土豆_玄幻小说_书旗小说</title>
<img src="https://img-tailor.11222.cn/bcv/720p/11590353258_sa.jpg" class="cover" />
作者： <a href="/author/天蚕土豆?aid=14371">天蚕土豆</a>
<p class="bookDesc">这里是属于斗气的世界，没有花俏艳丽的魔法，有的只是斗气繁衍到巅峰的斗气。</p>
<div class="tags clear"><a href="/label?label=武魂">武魂</a><a href="/label?label=修炼">修炼</a></div>`;

test('书旗详情页：title 标签取书名、作者链接、cover 图、bookDesc 简介、tags', () => {
  const c = shuqiAdapter.parseDetail!(SHUQI_DETAIL, 'https://www.shuqi.com/book/53258.html');
  assert.ok(c);
  assert.equal(c!.title, '斗破苍穹');
  assert.equal(c!.author, '天蚕土豆');
  assert.equal(c!.coverUrl, 'https://img-tailor.11222.cn/bcv/720p/11590353258_sa.jpg');
  assert.ok(c!.intro!.startsWith('这里是属于斗气的世界'));
  assert.deepEqual(c!.tags, ['武魂', '修炼']);
  assert.equal(c!.site, 'shuqi');
  assert.equal(c!.url, 'https://www.shuqi.com/book/53258.html');
});

// 豆瓣图书详情页：v:itemreviewed 书名、og:image 封面、#info 作者、第一个有正文的 .intro
const DOUBAN_DETAIL = `
<meta property="og:image" content="https://img1.doubanio.com/view/subject/l/public/s1237549.jpg" />
<span property="v:itemreviewed">小王子</span>
<div id="info"><span class="pl">作者</span>: <a>[法] 安东尼·德·圣-埃克苏佩里</a><br>
<span class="pl">译者</span>: <a>马振骋</a><br><span class="pl">出版社:</span> 人民文学出版社</div>
<div class="intro"></div>
<div class="intro"><p>小王子是一个超凡脱俗的仙童，他住在一颗只比他大一丁点儿的小行星上，陪伴他的是一朵他非常喜爱的小玫瑰花。</p></div>`;

test('豆瓣详情页：去 [国籍]、多作者取第一个、空 intro 块跳过取下一个', () => {
  const c = doubanAdapter.parseDetail!(DOUBAN_DETAIL, 'https://book.douban.com/subject/1084336/');
  assert.ok(c);
  assert.equal(c!.title, '小王子');
  assert.equal(c!.author, '安东尼·德·圣-埃克苏佩里');
  assert.equal(c!.coverUrl, 'https://img1.doubanio.com/view/subject/l/public/s1237549.jpg');
  assert.ok(c!.intro!.includes('小王子是一个超凡脱俗的仙童'), '空的 .intro 必须跳过');
  assert.equal(c!.site, 'douban');
});

test('detailCandidateFromHtml 未知站回落到通用 og，site 落域名，url 以粘贴的为准', () => {
  const url = 'https://www.example.com/novel/42';
  const c = detailCandidateFromHtml(url, '<meta property="og:title" content="某书"><meta property="og:image" content="https://img.example.com/c.jpg">');
  assert.ok(c);
  assert.equal(c!.title, '某书');
  assert.equal(c!.site, 'example.com');
  assert.equal(c!.url, url, '即便 og:url 不同也以用户粘的地址为准');
});

test('detailCandidateFromHtml 一页里什么书信息都没有 → null', () => {
  assert.equal(detailCandidateFromHtml('https://example.com/', '<html><body>关于我们 联系我们</body></html>'), null);
});

test('detailCandidateFromHtml 只有 SEO description（无 title/封面）→ null，不把广告文案当简介', () => {
  // 陌生站的首页/列表页/反爬页几乎都带一段 <meta name="description">，但那不是一本书。
  // 放它过的话，读主地址那一跳（trustIdentity）会把文案写进 intro、记 ok 永久出队。
  const html = '<html><head><meta name="description" content="番茄小说提供海量精彩小说，在线阅读尽在番茄。">'
    + '<title>小说排行榜_免费阅读</title></head><body>热门推荐 登录 注册</body></html>';
  assert.equal(detailCandidateFromHtml('https://example.com/book/1', html), null);
  // 有 og:title（书的硬证据）时 description 照样当简介用
  const ok = detailCandidateFromHtml('https://example.com/book/2', html.replace('<title>', '<meta property="og:title" content="某书"><title>'));
  assert.ok(ok, '有 title 就该认');
  assert.equal(ok!.title, '某书');
});

// 独阅读详情页：无 og 标签；封面 src 是占位图、真图在 data-original（和 alt 之间
// 连空格都没有，照搬真实 HTML）；目录整页直出，末章带 VIP 锁图标
const DUYUEDU_DETAIL = `
<html><head>
<title>孙君，你过分了！最新章节(大白菜 的苦逼),孙君，你过分了！无弹窗全文阅读-独阅读</title>
</head><body>
<div class="row book-info-box">
  <img class="book-img lazyload"  src="https://www.nkwwlkj.cn/default.jpg" alt="孙君，你过分了！"data-original="https://dede.cddaoyue.cn/du_novel/cover.jpg" />
  <div class="book-info">
    <div class="book-title">
      <span>孙君，你过分了！</span>
    </div>
    <div class="row">
      <div class="tag tag-lianzai">连载</div>
      <div class="tag tag-qianyue">签约</div>
    </div>
    <div class="row book-operation">
      <button onclick="window.open('https://www.nkwwlkj.cn/chapter/book_chapter_detail/100480011')" class="btn btn-primary">开始阅读</button>
    </div>
  </div>
</div>
简介
<div class="book-brief">
  <p class='desc'>一个后世来客，穿越战争遗孤二代，搞风搞雨的故事</p>
</div>
<div id="chapter_list" class="box chapter-list">
  <span class="chapter_item">
    <a href="https://www.nkwwlkj.cn/chapter/book_chapter_detail/100480011" target="_blank">第一章 尴尬的身份</a>
  </span>
  <span class="chapter_item">
    <i class="lock"><img src="https://www.nkwwlkj.cn/resources/images/lock.png"></i>
    <a href="https://www.nkwwlkj.cn/chapter/book_chapter_detail/100654147" target="_blank">
                第729章 来自霸总的连续羞辱                </a>
  </span>
</div>
</body></html>`;

test('独阅读：域名识别（含 www）', () => {
  assert.equal(adapterForUrl('https://www.nkwwlkj.cn/book/book_detail/100187510')?.id, 'duyuedu');
  assert.equal(adapterForUrl('https://nkwwlkj.cn/book/book_detail/1')?.id, 'duyuedu');
});

test('独阅读详情页：book-title 取书名、title 括号取作者、封面取 data-original 不取占位图', () => {
  const c = duyueduAdapter.parseDetail!(DUYUEDU_DETAIL, 'https://www.nkwwlkj.cn/book/book_detail/100187510');
  assert.ok(c);
  assert.equal(c!.title, '孙君，你过分了！');
  assert.equal(c!.author, '大白菜 的苦逼');
  assert.equal(c!.coverUrl, 'https://dede.cddaoyue.cn/du_novel/cover.jpg');
  assert.ok(!c!.coverUrl!.includes('default.jpg'), 'src 是懒加载占位图，真封面在 data-original');
  assert.equal(c!.intro, '一个后世来客，穿越战争遗孤二代，搞风搞雨的故事');
  assert.equal(c!.site, 'duyuedu');
});

test('独阅读详情页：下架/错误页（只有站点标题）认 null，不硬凑', () => {
  assert.equal(duyueduAdapter.parseDetail!('<html><head><title>独阅读</title></head></html>', 'https://www.nkwwlkj.cn/x'), null);
});

test('独阅读 latestRequest：详情页返回它本身（目录就在这页），章节页返回 null', () => {
  const detail = 'https://www.nkwwlkj.cn/book/book_detail/100187510';
  assert.deepEqual(duyueduAdapter.latestRequest!({ title: 'x', author: null, url: detail }), {
    url: detail, needsBrowser: false,
  });
  assert.equal(
    duyueduAdapter.latestRequest!({ title: 'x', author: null, url: 'https://www.nkwwlkj.cn/chapter/book_chapter_detail/100480011' }),
    null,
  );
});

test('独阅读 parseLatest：最后一个章节链接是最新章，VIP 锁定章标题照取，连载状态一并认出', () => {
  const r = duyueduAdapter.parseLatest!(DUYUEDU_DETAIL, {
    title: '孙君，你过分了！', author: null, url: 'https://www.nkwwlkj.cn/book/book_detail/100187510',
  });
  assert.ok(r);
  assert.equal(r!.latest, '第729章 来自霸总的连续羞辱');
  assert.equal(r!.serial, 'ongoing');
});

test('独阅读 parseLatest：一页章节链接都没有 → null；没有连载标签就不猜状态', () => {
  assert.equal(duyueduAdapter.parseLatest!('<html>无目录</html>', { title: 'x', author: null, url: '' }), null);
  const r = duyueduAdapter.parseLatest!(
    '<a href="https://www.nkwwlkj.cn/chapter/book_chapter_detail/9">完本感言</a>',
    { title: 'x', author: null, url: '' },
  );
  assert.equal(r!.latest, '完本感言');
  assert.equal(r!.serial, undefined, '没有 tag-lianzai 就不返回状态，绝不从标题猜完本');
});

// 番茄详情页：没有 og 标签，书目在 shell 的 __INITIAL_STATE__ 和 SSR class 里
const FANQIE_DETAIL = `
<script>__INITIAL_STATE__={"common":{"name":""},"page":{"hasFetch":true,"author":"丧狐","authorId":"465830664494807","bookId":"7069948840148732967","bookName":"部族荣光","status":1},"search":{"searchBookList":null}}</script>
<title>部族荣光完整版在线免费阅读_部族荣光小说_番茄小说官网</title>
<img class="book-cover-img " src="//p1-tt.byteimg.com/origin/novel-static/5cb03bd354145bc7815a5e09d4b15cfc" alt="部族荣光"/>
<span class="author-name-text">丧狐</span>
<div class="page-abstract-content"><p>盛产美女的“姜氏部族”与“申屠部族”已开战三年。</p></div>`;

test('番茄详情页：state JSON 取书名作者、book-cover-img 取封面（补 https:）、abstract 取简介', () => {
  const c = fanqieAdapter.parseDetail!(FANQIE_DETAIL, 'https://fanqienovel.com/page/7069948840148732967');
  assert.ok(c);
  assert.equal(c!.title, '部族荣光');
  assert.equal(c!.author, '丧狐');
  assert.equal(c!.coverUrl, 'https://p1-tt.byteimg.com/origin/novel-static/5cb03bd354145bc7815a5e09d4b15cfc');
  assert.equal(c!.intro, '盛产美女的“姜氏部族”与“申屠部族”已开战三年。');
  assert.equal(c!.site, 'fanqie');
});

test('番茄详情页：state 缺失时回落 title 标签和作者 class', () => {
  const html = `<title>某书完整版在线免费阅读_某书小说_番茄小说官网</title>
  <span class="author-name-text">某作者</span>
  <img class="book-cover-img" src="https://example.com/c.jpg"><div class="page-abstract-content"><p>简介</p></div>`;
  const c = fanqieAdapter.parseDetail!(html, 'https://fanqienovel.com/page/1');
  assert.equal(c!.title, '某书');
  assert.equal(c!.author, '某作者');
  assert.equal(c!.coverUrl, 'https://example.com/c.jpg');
});

test('番茄详情页：什么都没有 → null（绝不再把 description 的 SEO 广告文案当简介）', () => {
  assert.equal(fanqieAdapter.parseDetail!('<html>错误页</html>', 'https://fanqienovel.com/x'), null);
});

// 晋江详情页（GBK，喂进来的已经是解码后的 UTF-8）：
// <title>《书名》作者_晋江文学城、封面 itemprop="image"、简介 #novelintro、状态 updataStatus
const JJWXC_DETAIL = `
<html><head><title>《海岛求生：生活玩家种田囤货》绯夷_晋江文学城_【原创小说|纯爱小说】</title></head><body>
<img class="noveldefaultimage" itemprop="image" src="https://i9-static.jjwxc.net/novelimage.php?novelid=10035712&coverid=156">
<div id="novelintro" itemprop="description">南流景一觉醒来。<br>他赶海，种地，养史莱姆。</div>
<li><span>文章进度：</span><span style="color:#000;float:none" itemprop="updataStatus">连载</span></li>
<table>
<tr itemprop="chapter"><td>1</td><td><span itemprop="headline"><a itemprop="url" href="http://www.jjwxc.net/onebook.php?novelid=10035712&chapterid=1">求生第一步</a></span></td></tr>
<tr itemprop="chapter newestChapter"><td>415</td><td><span itemprop="headline">
  <a itemprop="url" style="cursor:pointer" onclick="vip_buy('vip_415')" rel="http://my.jjwxc.net/onebook_vip.php?novelid=10035712&chapterid=415">出发去寻宝吧！</a><a onclick="payclick()"><font color="red">[VIP]</font></a>
</span></td></tr>
</table></body></html>`;

test('晋江：域名识别（my. 子域也算）', () => {
  assert.equal(adapterForUrl('http://www.jjwxc.net/onebook.php?novelid=10035712')?.id, 'jjwxc');
  assert.equal(adapterForUrl('https://b.faloo.com/1484744.html')?.id, 'faloo');
});

test('晋江详情页：title 取书名作者、itemprop 封面、#novelintro 简介（<br> 转空格）', () => {
  const c = jjwxcAdapter.parseDetail!(JJWXC_DETAIL, 'http://www.jjwxc.net/onebook.php?novelid=10035712');
  assert.ok(c);
  assert.equal(c!.title, '海岛求生：生活玩家种田囤货');
  assert.equal(c!.author, '绯夷');
  assert.equal(c!.coverUrl, 'https://i9-static.jjwxc.net/novelimage.php?novelid=10035712&coverid=156');
  assert.equal(c!.intro, '南流景一觉醒来。他赶海，种地，养史莱姆。');
  assert.equal(c!.site, 'jjwxc');
});

test('晋江 latestRequest：onebook 详情页返回它本身（目录就在这页），别的页返回 null', () => {
  const url = 'http://www.jjwxc.net/onebook.php?novelid=10035712';
  assert.deepEqual(jjwxcAdapter.latestRequest!({ title: 'x', author: null, url }), { url, needsBrowser: false });
  assert.equal(jjwxcAdapter.latestRequest!({ title: 'x', author: null, url: 'http://my.jjwxc.net/onebook_vip.php?novelid=1&chapterid=5' }), null);
});

test('晋江 parseLatest：newestChapter 行取章名（不被 [VIP] 锚污染），状态认出连载', () => {
  const r = jjwxcAdapter.parseLatest!(JJWXC_DETAIL, { title: 'x', author: null, url: '' });
  assert.ok(r);
  assert.equal(r!.latest, '出发去寻宝吧！');
  assert.equal(r!.serial, 'ongoing');
});

test('晋江 parseLatest：完结 → finished；没有章行 → null', () => {
  const done = JJWXC_DETAIL.replace('itemprop="updataStatus">连载', 'itemprop="updataStatus">完结');
  assert.equal(jjwxcAdapter.parseLatest!(done, { title: 'x', author: null, url: '' })?.serial, 'finished');
  assert.equal(jjwxcAdapter.parseLatest!('<html>无目录</html>', { title: 'x', author: null, url: '' }), null);
});

// 飞卢：GBK 但详情页带全套 og:novel 标签，解码后走通用 og 解析
const FALOO_DETAIL = `
<meta property="og:type" content="novel"/>
<meta property="og:title" content="盘点万界战力等级，论外吓尿诸天"/>
<meta property="og:novel:book_name" content="盘点万界战力等级，论外吓尿诸天"/>
<meta property="og:novel:author" content="幽兰翰墨"/>
<meta property="og:novel:category" content="同人小说"/>
<meta property="og:image" content="http://img.faloo.com/Novel/498x705/1/1595/001595957.jpg"/>
<meta property="og:description" content="天幕降临诸天，开局盘点万界战力量级。"/>`;

test('飞卢详情页：og 通用解析取齐书名/作者/分类/封面/简介', () => {
  const c = falooAdapter.parseDetail!(FALOO_DETAIL, 'https://b.faloo.com/1484744.html');
  assert.ok(c);
  assert.equal(c!.title, '盘点万界战力等级，论外吓尿诸天');
  assert.equal(c!.author, '幽兰翰墨');
  assert.equal(c!.category, '同人小说');
  assert.equal(c!.coverUrl, 'http://img.faloo.com/Novel/498x705/1/1595/001595957.jpg');
  assert.equal(c!.intro, '天幕降临诸天，开局盘点万界战力量级。');
  assert.equal(c!.site, 'faloo');
});
