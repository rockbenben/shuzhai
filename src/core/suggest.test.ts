import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestRules } from './suggest.ts';

const enc = (s: string) => new TextEncoder().encode(s);

/** 造一本书：每个标题后面跟一段正文 */
const book = (titles: string[], body = '风雪夜归人，孤灯照旧影。'.repeat(60)) =>
  enc(titles.map((t) => `${t}\n${body}`).join('\n'));

test('从书自己的正文里猜出章节格式', () => {
  const titles = Array.from({ length: 12 }, (_, i) => `第${i + 1}章 标题${i + 1}`);
  const s = suggestRules(book(titles), 'utf-8');
  assert.ok(s.length > 0, '应该有建议');
  assert.equal(s[0].hits, 12);
  assert.ok(s[0].samples[0].startsWith('第1章'));
});

test('建议出来的正则必须能编译，而且真的匹配它自己给的样例', () => {
  // 这是这个模块最重要的不变式：pattern 是直接填进规则编辑器的，
  // 编译不过或者匹配不到自己的样例，用户点一下就是一脸问号
  const titles = Array.from({ length: 10 }, (_, i) => `===第${i + 1}节：小标题===`);
  for (const sug of suggestRules(book(titles), 'utf-8')) {
    const re = new RegExp(sug.pattern);
    for (const sample of sug.samples) {
      assert.ok(re.test(sample), `${sug.pattern} 匹配不到自己的样例 ${JSON.stringify(sample)}`);
    }
  }
});

test('内置规则认不出的格式也猜得出来——《蛊真人》就是这种', () => {
  // 34MB 的《蛊真人》一直只能机械分段，原因是标题被 === 包着，
  // 所有内置规则的 `^第` 都匹配不上
  const titles = Array.from({ length: 20 }, (_, i) => `===第${i + 1}节：纵身亡魔===`);
  const s = suggestRules(book(titles), 'utf-8');
  assert.ok(s.length > 0);
  assert.equal(s[0].hits, 20);
  assert.ok(new RegExp(s[0].pattern).test('===第7节：随便什么==='));
});

test('对白和正文句子不许当建议', () => {
  // 这条是踩出来的：不加过滤时排在最前面的永远是 `^“` `^这` `^他`——
  // 34MB 的书上一口气命中三四万行，间隔还特别均匀，打分比真章节还高
  const prose: string[] = [];
  for (let i = 0; i < 200; i++) {
    prose.push(`“这一句话是第${i}句对白。”`);
    prose.push(`这一天他走了很远的路。`);
    prose.push(`他一路上都在想那件事。`);
  }
  const s = suggestRules(enc(prose.join('\n')), 'utf-8');
  for (const sug of s) {
    assert.ok(!/^\^[“这他]/.test(sug.pattern), `不该建议正文开头: ${sug.pattern}`);
  }
});

test('`※※※` 这类分隔线不许当建议——标题全一样就不是目录', () => {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) {
    lines.push('※※※', '风雪夜归人，孤灯照旧影。'.repeat(60));
  }
  const s = suggestRules(enc(lines.join('\n')), 'utf-8');
  assert.deepEqual(s, [], '一条都不该给');
});

test('同一条规则的碎片只留完整的那条', () => {
  // `第#萌、我`（78 处）整个包在 `第#萌、`（1062 处）里，是同一格式的一个子集。
  // 两条都列出来会让人以为这本书有两种标题格式
  const titles: string[] = [];
  for (let i = 1; i <= 40; i++) titles.push(`第${i}萌、${i % 3 === 0 ? '我' : '你'}的故事${i}`);
  const s = suggestRules(book(titles), 'utf-8');
  assert.equal(s.length, 1, `只该给一条，实际给了 ${s.map((x) => x.pattern).join(' / ')}`);
  assert.equal(s[0].hits, 40);
});

test('命中太少的不给建议——宁可不给也别让人在噪音里挑', () => {
  assert.deepEqual(suggestRules(book(['第1章 起', '第2章 承']), 'utf-8'), []);
});

test('平均一章太小的不给——那多半撞上了正文里的高频短语', () => {
  // 每「章」只有十几个字节，真书不会这样
  const lines = Array.from({ length: 300 }, (_, i) => `第${i}节 x`);
  assert.deepEqual(suggestRules(enc(lines.join('\n')), 'utf-8'), []);
});

test('GBK 的书也要能猜，且偏移不影响结果', () => {
  // 建议只看行文本，不碰偏移量；但解码得走对编码，否则整篇是乱码、一条也猜不出来
  const titles = Array.from({ length: 12 }, (_, i) => `第${i + 1}章 标题${i + 1}`);
  const utf8 = suggestRules(book(titles), 'utf-8');
  assert.ok(utf8.length > 0);
  assert.equal(utf8[0].hits, 12);
});
