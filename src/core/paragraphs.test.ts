import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitParagraphs, sliceByMarks, speakingParagraph, splitImages, type Mark } from './paragraphs.ts';

const mark = (o: number, len: number, extra: Partial<Mark> = {}): Mark => ({
  id: o,
  char_offset: o,
  length: len,
  color: 'yellow',
  note: null,
  intact: true,
  ...extra,
});

test('分段时记住每段在原文里的偏移', () => {
  const body = '第一段\n\n  第二段\n第三段';
  const ps = splitParagraphs(body);

  assert.deepEqual(ps.map((p) => p.text), ['第一段', '第二段', '第三段']);
  assert.equal(body.slice(ps[0].offset, ps[0].offset + 3), '第一段');
  assert.equal(body.slice(ps[1].offset, ps[1].offset + 3), '第二段', '缩进的空白要算进偏移');
  assert.equal(body.slice(ps[2].offset, ps[2].offset + 3), '第三段');
});

test('偏移必须按原文算，不能按渲染结果算', () => {
  // 空行和缩进被扔掉了。跟着渲染结果算的话，越往后偏得越多
  const body = '一\n\n\n二\n\n\n三';
  const ps = splitParagraphs(body);
  for (const p of ps) {
    assert.equal(body[p.offset], p.text, `第 ${p.offset} 位应该是「${p.text}」`);
  }
});

test('没有划线时整段是一片', () => {
  const p = { text: '少年提剑出门', offset: 0 };
  assert.deepEqual(sliceByMarks(p, []), [{ text: '少年提剑出门' }]);
});

test('划线落在段中间，切成三片', () => {
  const p = { text: '少年提剑出门', offset: 0 };
  const pieces = sliceByMarks(p, [mark(2, 2)]);

  assert.deepEqual(pieces.map((x) => x.text), ['少年', '提剑', '出门']);
  assert.equal(pieces[1].mark?.id, 2);
  assert.equal(pieces[0].mark, undefined);
});

test('划线从段首开始', () => {
  const p = { text: '少年提剑出门', offset: 0 };
  const pieces = sliceByMarks(p, [mark(0, 2)]);
  assert.deepEqual(pieces.map((x) => x.text), ['少年', '提剑出门']);
  assert.ok(pieces[0].mark);
});

test('划线跨段时，每段只显示落在自己身上的那部分', () => {
  // 原文：「少年提剑出门」占 0–5，\n 占 6，「风雪满衣」占 7–10
  const first = { text: '少年提剑出门', offset: 0 };
  const second = { text: '风雪满衣', offset: 7 };
  const m = mark(4, 5); // 覆盖 4–8：出、门、\n、风、雪

  assert.deepEqual(sliceByMarks(first, [m]).map((x) => x.text), ['少年提剑', '出门']);
  assert.deepEqual(sliceByMarks(second, [m]).map((x) => x.text), ['风雪', '满衣']);
});

test('完全落在别段的划线不影响这一段', () => {
  const p = { text: '少年提剑出门', offset: 0 };
  assert.deepEqual(sliceByMarks(p, [mark(100, 4)]), [{ text: '少年提剑出门' }]);
});

test('漂移的划线不画出来', () => {
  const p = { text: '少年提剑出门', offset: 0 };
  const pieces = sliceByMarks(p, [mark(2, 2, { intact: false })]);
  assert.deepEqual(pieces, [{ text: '少年提剑出门' }], '位置对不上就别画，画错比不画更糟');
});

test('重叠的部分归先开始的那条，后一条没被盖住的尾巴仍然是它自己的', () => {
  const p = { text: '少年提剑出门', offset: 0 };
  // 第一条盖 0–3「少年提剑」，第二条盖 2–5「提剑出门」，重叠的是「提剑」
  const pieces = sliceByMarks(p, [mark(0, 4), mark(2, 4)]);

  // 「提剑」判给先开始的那条：真去做区间合并的话它会同时属于两条，
  // 点它该弹哪条笔记就没有答案了。而「出门」没人跟第二条抢，仍然归它
  assert.deepEqual(pieces.map((x) => x.text), ['少年提剑', '出门']);
  assert.equal(pieces[0].mark?.id, 0);
  assert.equal(pieces[1].mark?.id, 2);
});

test('相邻不重叠的两条划线各自成片', () => {
  const p = { text: '少年提剑出门', offset: 0 };
  const pieces = sliceByMarks(p, [mark(0, 2), mark(4, 2)]);
  assert.deepEqual(pieces.map((x) => x.text), ['少年', '提剑', '出门']);
  assert.equal(pieces[0].mark?.id, 0);
  assert.equal(pieces[1].mark, undefined);
  assert.equal(pieces[2].mark?.id, 4);
});

test('切出来的片段拼回去必须等于原段', () => {
  // 这条是总保险：任何切法都不能吞字或多字
  const p = { text: '少年提剑出门，风雪满衣。', offset: 10 };
  for (const marks of [
    [mark(10, 2)],
    [mark(12, 4)],
    [mark(10, 24)],
    [mark(11, 3), mark(16, 4)],
    [mark(10, 5), mark(12, 5)],
  ]) {
    const joined = sliceByMarks(p, marks).map((x) => x.text).join('');
    assert.equal(joined, p.text, `划线 ${JSON.stringify(marks.map((m) => [m.char_offset, m.length]))}`);
  }
});

test('跟读高亮：整章原文的偏移要换算回正文段落', () => {
  const title = '第13章 峰回路转';
  const body = '\n第一段的话。\n第二段的话，长一些。\n第三段。';
  const full = title + body;
  const paras = splitParagraphs(body);
  assert.deepEqual(paras.map((p) => p.offset), [1, 8, 19]);

  // 念标题的时候正文里没有对应段落，**不能乱高亮一段**
  assert.equal(speakingParagraph(paras, 0, full, title), null);
  assert.equal(speakingParagraph(paras, title.length - 1, full, title), null);

  // 正文：整章偏移 - 标题长度 = 正文偏移
  assert.equal(speakingParagraph(paras, title.length + 1, full, title), 1);
  assert.equal(speakingParagraph(paras, title.length + 5, full, title), 1, '段中间也算这一段');
  assert.equal(speakingParagraph(paras, title.length + 8, full, title), 8);
  assert.equal(speakingParagraph(paras, title.length + 25, full, title), 19);

  // **不减那一截会整体偏后一段**——而那种错很安静，看起来一直在动，只是慢一段。
  // 这一条钉的就是「别把 shift 去掉」
  assert.notEqual(speakingParagraph(paras, title.length + 1, full, title), 19);

  // 正文不以标题开头时（清洗规则可能把标题行去掉了）不减
  const noTitle = splitParagraphs(body);
  assert.equal(speakingParagraph(noTitle, 1, body, title), 1);
});

test('正文里的图：地址摘得出来，javascript: 一律当没有', () => {
  const 图 = '<img src="https://aigcc.yuewen.com/imgChapter/28846206809924501/31881956004506208/10484061/31f682a20d8bb7939f2f7707647af3fflxcNx04i3Vb993R_hd.webp">';
  const a = splitImages(图);
  assert.equal(a.images.length, 1);
  assert.ok(a.images[0].endsWith('_hd.webp'), '地址要完整——这条 URL 有 146 个字符，正是当初那个长度上限没截住的东西');
  assert.equal(a.text.trim(), '', '整段就是一张图时，不该再剩下文字');

  // 图和字混在一段里：图摘走，字留下
  const b = splitImages('他抬头看了看' + 图 + '然后走了');
  assert.equal(b.images.length, 1);
  assert.equal(b.text, '他抬头看了看然后走了');

  // **这条是安全阀，不是洁癖**：txt 是从别处拿来的，而渲染进程是 file:// 加载的
  for (const 坏 of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'vbscript:x', '']) {
    const r = splitImages(`<img src="${坏}">`);
    assert.deepEqual(r.images, [], `${坏} 不该被当成图片地址`);
    assert.equal(r.text.trim(), '', '不认的地址，那个标签也不能留在正文里');
  }

  // 单引号、没引号、大写标签名都要认
  assert.equal(splitImages("<IMG SRC='https://a/b.png' alt=x>").images[0], 'https://a/b.png');
  assert.equal(splitImages('<img src=https://a/c.jpg >').images[0], 'https://a/c.jpg');
});
