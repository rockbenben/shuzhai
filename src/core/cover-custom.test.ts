import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseByRules, parseSources, serializeSources, blankSource } from './cover-custom.ts';

const SRC = {
  ...blankSource('demo'),
  blockRe: '<li class="book"[\\s\\S]*?</li>',
  titleRe: 'class="name"[^>]*>([\\s\\S]*?)<\\/a>',
  authorRe: 'class="author"[^>]*>([^<]+)<',
  coverRe: '<img[^>]+src="([^"]+)"',
};

const HTML = `
<div class="head"><a class="name">这是导航不是结果</a></div>
<ul>
<li class="book">
  <img src="https://x.com/a.jpg">
  <a class="name">斗破<em>苍穹</em></a>
  <span class="author">天蚕土豆</span>
</li>
<li class="book">
  <img src="https://x.com/b.jpg">
  <a class="name">武炼巅峰</a>
  <span class="author">莫默</span>
</li>
<li class="ad">广告位</li>
</ul>`;

test('按规则抽候选：书名剥内嵌标签，作者封面都取到', () => {
  const c = parseByRules(HTML, SRC);
  assert.equal(c.length, 2);
  assert.equal(c[0].title, '斗破苍穹', '关键词高亮的 <em> 要剥掉');
  assert.equal(c[0].author, '天蚕土豆');
  assert.equal(c[0].coverUrl, 'https://x.com/a.jpg');
  assert.equal(c[0].site, 'demo');
});

test('只在结果块里找——块外的同名元素不能混进来', () => {
  // 顶上那个 class="name" 是导航。不圈块直接全页找书名的话，
  // 第一条候选就是它，而且书名和作者会**对不上号**（各找各的）
  const c = parseByRules(HTML, SRC);
  assert.ok(!c.some((x) => x.title.includes('导航')));
});

test('块里没书名就跳过，不产出半条候选', () => {
  const c = parseByRules('<li class="book"><img src="x.jpg"></li>', SRC);
  assert.deepEqual(c, [], '没书名的块是布局，不是结果');
});

test('坏正则：结果块的报错要抛出来，字段的正则坏了只是这一项为空', () => {
  assert.throws(() => parseByRules(HTML, { ...SRC, blockRe: '([' }), /结果块的正则有问题/);
  // 字段规则坏了不该让整个源废掉——书名还在就仍然是一条可用候选
  const c = parseByRules(HTML, { ...SRC, authorRe: '([' });
  assert.equal(c.length, 2);
  assert.equal(c[0].author, null);
});

test('存坏了当没配，不让封面抓取整个瘫掉', () => {
  assert.deepEqual(parseSources('这不是 JSON'), []);
  assert.deepEqual(parseSources(null), []);
  assert.deepEqual(parseSources('{"not":"array"}'), []);
  // 缺 id 或 searchUrl 的条目直接丢掉——留着只会在抓取时抛
  assert.deepEqual(parseSources('[{"name":"没有id"}]'), []);
});

test('存取一轮不丢东西', () => {
  const list = [{ ...blankSource('a'), name: '甲' }];
  assert.deepEqual(parseSources(serializeSources(list)), list);
});

test('新建的源默认不启用', () => {
  // 和导入的清洗规则同一个规矩：没试过的东西不该直接参与真实抓取
  assert.equal(blankSource('x').enabled, false);
});
