/*
 * 「读到哪儿了 / 读完了没有」。
 *
 * 这两条判断以前在 `Reader.tsx` 的两个 effect 里各写了一遍、一条测试都没有，
 * 而它们写的是铁律 3 的数据。下面每一条都对着一个**具体的坏结果**：
 * 落在别的段落上、或者书从「在读」里消失。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorOffset, atEndScrolling, atEndPaging, END_SLACK_PX, 点到哪边 } from './reading-pos.ts';

/** 四段正文，分别落在 0 / 100 / 200 / 300 像素处 */
const 段 = [
  { offset: 0, pos: 0 },
  { offset: 120, pos: 100 },
  { offset: 250, pos: 200 },
  { offset: 400, pos: 300 },
];

test('锚点取的是「还在视口顶上方（含）」的最后一段', () => {
  assert.equal(anchorOffset(段, 0), 0, '停在最上面就是第一段');
  assert.equal(anchorOffset(段, 150), 120, '150px 处：第二段还在上面，第三段已经在下面了');
  assert.equal(anchorOffset(段, 200), 250, '正好压在第三段上，算第三段');
  assert.equal(anchorOffset(段, 9999), 400, '滚到底就是最后一段');
});

/*
 * **一段都不符合时给 0。**
 *
 * 这不是「找不到」，是「视口停在第一段上面那片（章标题）」——从头算才对。
 * 给 -1 或者不返回的话，调用方要么把 null 写进库（`numOpt` 那轮的坑），
 * 要么这一次整段不存，两种都是悄悄丢进度。
 */
test('视口还在第一段上面时给 0，不是「没有」', () => {
  assert.equal(anchorOffset([{ offset: 500, pos: 80 }], 10), 0);
  assert.equal(anchorOffset([], 123), 0, '一段都没有（空章）也给 0');
});

/*
 * 翻页模式和滚动模式**共用这一条**。以前是两份，判据一模一样——
 * 抄第二份的那种东西迟早分叉（本仓库栽过八次）。
 */
test('翻页模式按「第几页」问同一个问题', () => {
  const 页 = [
    { offset: 0, pos: 0 },
    { offset: 300, pos: 0 },
    { offset: 700, pos: 1 },
    { offset: 900, pos: 2 },
  ];
  assert.equal(anchorOffset(页, 0), 300, '第 0 页上最后一段');
  assert.equal(anchorOffset(页, 1), 700);
  assert.equal(anchorOffset(页, 2), 900);
});

test('滚动到底：留 24px 余量，不然亚像素滚动永远差一点', () => {
  // 差 20px（在余量之内）算到底
  assert.equal(atEndScrolling(1000 - 20, 500, 1500), true);
  // 差 30px（超出余量）不算
  assert.equal(atEndScrolling(1000 - 30, 500, 1500), false);
  // 正好那条线上算到底
  assert.equal(atEndScrolling(1000 - END_SLACK_PX, 500, 1500), true);
  // 一屏装得下的短章：一打开就到底
  assert.equal(atEndScrolling(0, 800, 600), true);
});

/*
 * ⚠️ 这一条是这个模块里最要紧的：**误标一次，那本书就从「在读」里消失了**，
 * 而用户根本不知道发生了什么。
 */
test('翻页模式：刚打开（第 0 页）永远不算读完，哪怕这一章只有一页', () => {
  assert.equal(atEndPaging(0, 1), false, '最后一章只有一页时，一打开不能就判读完');
  assert.equal(atEndPaging(0, 5), false);
  // 真的翻到最后一页才算
  assert.equal(atEndPaging(4, 5), true);
  assert.equal(atEndPaging(3, 5), false);
  // 翻过页之后，一页的章节也算（进不来，但判据本身要说得通）
  assert.equal(atEndPaging(1, 1), true);
});

test('点到哪边：左右两条带子翻页，中间那条留给选中文字', () => {
  const w = 1000;
  assert.equal(点到哪边(0, w), -1);
  assert.equal(点到哪边(299, w), -1);
  assert.equal(点到哪边(300, w), 0, '边界归中间——宁可不翻，也别在想选字的时候翻页');
  assert.equal(点到哪边(500, w), 0);
  assert.equal(点到哪边(700, w), 0, '同上，右边这条也是开区间');
  assert.equal(点到哪边(701, w), 1);
  assert.equal(点到哪边(w, w), 1);
  // 宽度还没量出来时（iframe 刚挂上、盒子是 0）不许当成「点了左边」
  assert.equal(点到哪边(0, 0), 0);
});

