/*
 * 「读到哪儿了 / 读完了没有」。
 *
 * 这两条判断以前在 `Reader.tsx` 的两个 effect 里各写了一遍、一条测试都没有，
 * 而它们写的是铁律 3 的数据。下面每一条都对着一个**具体的坏结果**：
 * 落在别的段落上、或者书从「在读」里消失。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorOffset, atEndScrolling, atEndPaging, END_SLACK_PX, 点到哪边, 该卸几章 } from './reading-pos.ts';

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


/*
 * 「窗口满了从视野上方卸几章」。
 *
 * 这条原来只在 `Reader.tsx` 里，而它栓着一个真出过的坏结果：卸章**把正在读的
 * 那一章卸掉了**，`chapter` 当场变成 null，而写进度的那个滚动监听 effect 开头
 * 挡着 `!chapter`——监听整个不下来，从此进度不再记、下一章也再也不接，
 * 底栏显示「第 1 / … 章」。走查里复现出来是「滚了 11691px 而 chapterIdx 纹丝不动」。
 */
/** 五章，每章 1000 像素高，章首分别在 0 / 1000 / 2000 / 3000 / 4000 */
const 窗 = [0, 1, 2, 3, 4].map((i) => ({ idx: i, top: i * 1000, height: 1000 }));

test('卸章：只卸整章都在视野上方 400px 以外的', () => {
  // 视野顶在 5000：第 0~3 章的底（1000~4000）都在 4600 以上，第 4 章压着顶边
  assert.equal(该卸几章(窗, 5000, 3, 99), 3);
  assert.equal(该卸几章(窗, 1500, 3, 99), 1, '第 1 章还有下半截在视野里，不许动它');
  assert.equal(该卸几章(窗, 1000, 3, 99), 0, '一章都没离开视野');
  // 正好压在容差线上：1400 + 400 = 1800，第 0 章底 1000 早就越过了，第 1 章底 2000 没有
  assert.equal(该卸几章(窗, 1400, 3, 99), 1);
  assert.equal(该卸几章(窗, 1599, 3, 99), 1);
});

test('卸章：正在读的那一章永远不许被卸掉', () => {
  // 同样的几何，只是「正在读」换成了顶上那几章自己
  assert.equal(该卸几章(窗, 5000, 3, 0), 0, '要卸的第一章正是当前章——一章都不许卸');
  assert.equal(该卸几章(窗, 5000, 3, 1), 1, '只许卸到当前章之前');
  assert.equal(该卸几章(窗, 5000, 3, 2), 2);
  // 当前章在窗口里排得比要卸的还靠后 = 约束不生效，照原样卸
  assert.equal(该卸几章(窗, 5000, 3, 4), 3);
});

test('卸章：怎么卸都至少留一章在窗口里', () => {
  assert.equal(该卸几章(窗, 99000, 99, 99), 4);
  assert.equal(该卸几章(窗, 99000, 99, 0), 0, '而「留一章」不能让「保住当前章」失效');
  assert.equal(该卸几章(窗, 5000, 0, 99), 0, '没到上限就一章都不动');
  assert.equal(该卸几章([], 5000, 3, 99), 0, '空窗口');
});
