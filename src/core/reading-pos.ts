/*
 * 「读到哪儿了 / 读完了没有」——**两个纯判断**，滚动模式和翻页模式共用。
 *
 * 拆出来之前，这两件事在 `Reader.tsx` 的**两个 effect 里各写了一遍**，
 * 一条测试都没有。而它们写的是铁律 3 的数据（章内偏移、读完与否），
 * 判错的后果都看得见：
 *
 *   - 锚点算错 → 退出再进来落在别的段落上，看起来像进度丢了；
 *   - 「读完」误判 → 那本书**从「在读」里消失**，用户下次找不到它。
 *
 * 这个模块**一个 import 都不带**，所以渲染进程值导入它不会把任何 node 内置
 * 拖进包里（同 `open.ts` / `book-format.ts`）。
 */

/**
 * 滚动模式里「到底了」的余量（像素）。
 *
 * 不留余量的话，浏览器的亚像素滚动会让 `scrollTop + clientHeight` 永远差那么
 * 零点几，于是**读到最后一行也标不上「读完」**。
 */
export const END_SLACK_PX = 24;

/**
 * 判「这一段还在视口顶上方吗」时给的容差（像素）。
 *
 * 段落的 `offsetTop` 和容器的滚动位置都带亚像素，正好压在顶边上的那一段
 * 差零点几就会被判成「已经在下面了」——于是锚点往前跳一段，
 * 退出再进来落在**上一段**开头。
 */
export const ANCHOR_SLACK_PX = 4;

/**
 * 视口顶上那一段的字节偏移。
 *
 * `paras` 要按版面顺序给（DOM 顺序天然就是），`pos` 是这一段在**当前模式下的
 * 位置度量**：滚动模式是「距容器顶多少像素」，翻页模式是「它在第几页」。
 * 两种模式的判据其实是同一条——**取还在当前位置之前（含）的最后一段**——
 * 所以这里只有一份。
 *
 * ⚠️ **一段都不符合时给 0，不是给 -1 或者抛。** 那说明视口停在第一段上面
 * （章标题那一片），从头算是对的；而返回一个「没有」会让调用方
 * 要么写进库一个 null（`numOpt` 那轮的坑），要么整段不存。
 */
export function anchorOffset(paras: Array<{ offset: number; pos: number }>, cutoff: number): number {
  let offset = 0;
  for (const p of paras) {
    if (p.pos > cutoff) break;
    offset = p.offset;
  }
  return offset;
}

/** 滚动模式：这一章到底了吗 */
export function atEndScrolling(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollTop + clientHeight >= scrollHeight - END_SLACK_PX;
}

/**
 * 翻页模式：这一章到最后一页了吗。
 *
 * ⚠️ **`page > 0` 这个条件不能去掉。** 翻页那个 effect 在**刚打开章节时也会跑
 * 一次**（page = 0），要是最后一章正好只有一页，一打开就被判读完——
 * 正是滚动模式天然防住的那种误判（它只在真实 scroll 事件里判）。
 *
 * 代价是「最后一章只有一页」时不会自动标。**宁可漏标也不能误标**：
 * 误标一次那本书就从「在读」里消失了，而用户根本不知道发生了什么。
 */
export function atEndPaging(page: number, pages: number): boolean {
  return page > 0 && page >= pages - 1;
}

/**
 * 点在正文的哪一边：**左边一条带子上一页，右边一条下一页，中间不翻**。
 *
 * 中间那条留给「选中文字」——划线是先选后弹菜单，选完松手那一下如果顺手翻了页，
 * 划线等于没法用。调用方还要自己判「有没有选中」和「点没点在按钮/链接上」，
 * 那两条和坐标无关，判不了也不该判在这儿。
 *
 * 三处共用：txt 阅读器的翻页模式、PDF 查看器、EPUB 查看器（后两个的
 * 正文在 canvas / iframe 里，坐标要先换算成相对正文盒的）。
 * 0.3 / 0.7 这两个数原来只写在 `Reader.tsx` 一处，另外两处**根本没有这个功能**——
 * 补的时候要么再抄一遍这两个数，要么收到这儿来。
 *
 * @returns -1 上一页 / 0 不翻 / 1 下一页
 */
export function 点到哪边(x: number, w: number): -1 | 0 | 1 {
  if (w <= 0) return 0;
  if (x < w * 0.3) return -1;
  if (x > w * 0.7) return 1;
  return 0;
}

