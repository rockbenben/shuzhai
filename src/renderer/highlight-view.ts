import { useEffect, useState } from 'react';
import { COLOR_NAMES, 解析矩形, type Highlight, type HighlightColor } from '../core/highlight.ts';
import { rpc } from './rpc.ts';
/**
 * 划线**看起来什么样**：四种颜色，以及 EPUB 那边怎么把它们画上去。
 *
 * ⚠️ **颜色只此一份。** txt 那边用 `<mark>` 的背景色、EPUB 那边用
 * `::highlight()` 的背景色——同一套颜色两个地方，抄两份必然分叉
 * （这个仓库栽过三次）。
 */
/*
 * ⚠️ **键的类型是 core 的 `HighlightColor`，不是 `string`。**
 * 「哪几种颜色」的正本在 `core/highlight.ts` 的 `COLORS`（`addHighlight` 和
 * `setColor` 都拿它校验），这里管的是**每种长什么样**。
 * 写成 `Record<string, string>` 的话，core 那边加一种颜色，这里漏了也不报错——
 * 用户划出来的是一条**没有颜色**的划线。绑上类型，漏了当场编译不过。
 */
export const HL_COLORS: Record<HighlightColor, string> = {
  yellow: 'rgba(220, 180, 40, .35)',
  green: 'rgba(80, 180, 110, .32)',
  blue: 'rgba(90, 150, 220, .32)',
  pink: 'rgba(220, 110, 160, .32)',
};

/**
 * 按颜色名取底色。
 *
 * ⚠️ **库里那一列是 `string`**，什么都可能进来（老数据、外部工具经 rpc 写的）。
 * 所以取色这一步要能兜底——而**兜底只在「显示」这一头**：
 * 写库那一头（`addHighlight` / `setColor`）该校验的照旧校验。
 */
export const 底色 = (c: string): string => HL_COLORS[c as HighlightColor] ?? HL_COLORS.yellow;

/**
 * 每种颜色**代表什么**——三个阅读界面和笔记面板共用这一份。
 *
 * 名字的正本在 `core/highlight.ts`（默认名 + 用户改的那份存哪儿），
 * 这里只管「渲染进程怎么拿到它」。原来三处各硬编码了一份中文名，
 * 其中 `Reader` 那份连名字都没有——四个圆点的 title 都是同一句
 * 「用这个颜色划线」，等于四个没法称呼的按钮。
 *
 * ⚠️ **缓存是模块级的，改完必须 `刷新色名()`。** 一次会话里这份东西几乎不变，
 * 每个组件各发一次 rpc 是白费；但改完不广播的话，笔记面板改了名字、
 * 旁边阅读界面那排色块还是旧的——同一个名字当场分叉给用户看。
 */
let 色名缓存: Record<HighlightColor, string> | null = null;
const 色名订阅 = new Set<() => void>();

export async function 刷新色名(): Promise<Record<HighlightColor, string>> {
  色名缓存 = await rpc<Record<HighlightColor, string>>('highlight.colorNames');
  for (const f of 色名订阅) f();
  return 色名缓存;
}

export function use色名(): Record<HighlightColor, string> {
  const [名, set名] = useState<Record<HighlightColor, string>>(色名缓存 ?? COLOR_NAMES);
  useEffect(() => {
    const 醒 = () => set名(色名缓存 ?? COLOR_NAMES);
    色名订阅.add(醒);
    /*
     * ⚠️ **每次挂载都取一遍，别只在缓存空着时取。**
     *
     * 只在 `=== null` 时取的话，这份缓存**只有从界面上改名字才会失效**
     * （`刷新色名()` 只有规则编辑器那一处调）。而 `highlight.setColorNames`
     * 在 rpc 白名单里，AGENTS.md 明写着「整理」这类事可以走 `POST /api/rpc`——
     * 于是外部工具把蓝改成「待查」之后，跑着的界面上每一处**还写着「蓝」**，
     * 色块、按颜色归组的组头、这一行的悬停全都不更新，直到重启，而且一句错都不报。
     *
     * 调用点都是顶层组件（笔记面板、两个阅读界面、笔记卡），不是每行一个，
     * 所以「每次挂载一次 rpc」拢共也就几次，读的还是一行设置。
     * 订阅照旧留着——它管的是**另一件事**：一处改完，其它已经挂着的立刻跟上。
     */
    void 刷新色名();
    return () => { 色名订阅.delete(醒); };
  }, []);
  return 名;
}

/**
 * EPUB 的划线：**用原生的 CSS Custom Highlight API 画**。
 *
 * ── 为什么不是 epub.js 那套 ────────────────────────────
 *
 * epub.js 有 `rendition.annotations.highlight`，但**这个构建里画不出来**：
 * 当场量的——`annotations.add` 之后标注表里确实多了一条，而 iframe 的 body
 * 一个字节都没变、`svg` 还是 0 个；`Contents.highlight` 压根 `undefined`
 * （它依赖 `marks-pane`，那个包没打进来）。
 *
 * ── 为什么原生那套更合适 ──────────────────────────────
 *
 * Electron 44 = Chrome 152，`CSS.highlights` 是有的（在 iframe 里也量过；
 * 43 = Chrome 150 时量的，升到 152 之后 `notes.mjs` 那条端到端又跑过一遍）。
 * 它**不往文档里插任何节点**：不改 DOM 就不会碰坏 epub.js 的分页，
 * 重排、翻页、改字号之后也不用重算坐标——而 marks-pane 那套画的是绝对定位的方块，
 * 每次重排都要重画一遍。
 *
 * 锚点是 **CFI range**（`epubcfi(/6/6!/4/4,/1:2,/1:12)`），epub.js 自带：
 * `contents.cfiFromRange(range)` 算出来，`contents.range(cfi)` 还原回去——
 * 量过一次，还原出来的文字和选中的**一字不差**。
 */
/*
 * ⚠️ **行的形状引 core 那一份，不在这儿另写。**
 * `dup-decls.mjs` 盯着「同一个 rpc 两种返回类型」——`HighlightsPanel` 当年
 * 手抄了一个 `Row`，而它已经**掉了 `cfi` 这一列**（抄的时候还没有）。
 * 加一个字段就会漏改一处，而且不报错。
 */

/**
 * **画划线要的两样东西**：往哪个文档里画，以及怎么把一条划线还原成 Range。
 *
 * ⚠️ **收成这个形状是为了让 EPUB 和 PDF 共用一份画法。** 两者的**锚**完全不同
 * （EPUB 是 CFI，PDF 是「页 + 页内偏移 + 长度」），但**画法一模一样**：
 * 按颜色分组塞进 `CSS.highlights`。原来这三个函数直接收 epub.js 的 `Contents`，
 * PDF 想用就只能抄一份——这个仓库被「抄第二份」咬过三次。
 *
 * 于是把「怎么还原」抽成一个回调，剩下的（注样式、按色分组、清干净再画、
 * 拿矩形做命中）三种界面一个字都不分叉。
 */
export interface 画布 {
  document: Document;
  /** 把一条划线还原成 Range。还原不出来回 null（**别猜，也别夹**） */
  还原: (h: Highlight) => Range | null;
  /**
   * 这一条**归不归现在这一屏管**。不给就是「都归」。
   *
   * ⚠️ **这个判断不能省，否则「漂了」会满口胡说。** PDF 那半的划线是整本一起取的
   * （一叠里同时露着好几页），而**没滚到的页还没铺文字层**——那些划线当然还原不出来，
   * 但它们**没坏**，只是还没轮到。不分开的话，一本书刚打开就报
   * 「有 37 条划线对不上」，而实际上一条都没坏。
   *
   * 「没坏但报成坏了」比不报更糟：它会让人真的以为笔记丢了。
   */
  管得着?: (h: Highlight) => boolean;
}

/** 画高亮用的名字。**一个 `Highlight` 装一种样子**，所以按「颜色 + 有没有笔记」分组 */
const 名 = (key: string) => 'shuzhai-' + key;

/**
 * 一条划线画成什么样，由**两件事**决定：哪种颜色、带不带笔记。
 * 所以键是 `蓝` 和 `蓝-note` 两个，不是「颜色」和「note」两套。
 *
 * ⚠️ **这里曾经是 `h.note ? 'note' : h.color`**——带笔记的一律画成黄的，
 * 用户挑的颜色当场丢掉。txt 那边从来不是这样（`background: 底色(color)` 加一条
 * `borderBottom`，颜色照留），**是这一份抄歪了**。
 * 「颜色代表什么」做完之后这个 bug 更贵：用户把蓝定成「待查」、
 * 在上面写了笔记，结果它显示成黄的——**恰恰是最要紧的那几条丢了分类**。
 *
 * ⚠️ **清屏的循环也从这儿取键。** 原来那两处各手写着
 * `['yellow','green','blue','pink','note']`——`COLORS` 加一种颜色，
 * 这两行漏了就是「删掉的划线还留在屏幕上」，而且不报错。
 */
const 画的键 = Object.keys(HL_COLORS).flatMap((c) => [c, c + '-note']);

/**
 * 注进 iframe 的那段 CSS。**单独抽出来是为了能测**——
 * 「带笔记的还是不是原来那个颜色」这条判据，靠肉眼看 iframe 是看不住的。
 */
export function 划线样式(): string {
  return [
    ...Object.entries(HL_COLORS).flatMap(([k, v]) => [
      '::highlight(' + 名(k) + '){background:' + v + '}',
      /*
       * 带笔记的：**底色一模一样**，多一条下划线。
       * 和 txt 那边 `borderBottom: 2px solid var(--accent)` 同一个意思——
       * 粗细对齐到 2px；颜色用 currentColor 而不是 `--accent`，
       * 因为那个变量到不了 iframe（纸色都得显式送进去，见 `FileViewer`）。
       */
      '::highlight(' + 名(k + '-note') + '){background:' + v
        + ';text-decoration:underline;text-decoration-thickness:2px}',
    ]),
    // 「刚跳过来的就是这一条」——比划线本身重，而且只亮一下下（见 `闪一下`）
    '::highlight(' + 名('flash') + '){background:rgba(200,120,40,.55)}',
  ].join('');
}

/**
 * 把这一节的划线画上去。
 *
 * @returns 哪几条**还原不出来**（书换过一版、CFI 解析不了）——由界面照实说一句，
 *          判据抄 txt 那边「划线漂了要说一声」那条：**不猜也不删**。
 */
export function 画划线(c: 画布, 全部: Highlight[]): number[] {
  const d = c.document;
  const win = d.defaultView as (Window & typeof globalThis) | null;
  if (!win?.CSS?.highlights) return [];

  // 这一节自己的 style 只注入一次
  if (!d.getElementById('shuzhai-hl-style')) {
    const st = d.createElement('style');
    st.id = 'shuzhai-hl-style';
    /*
     * ⚠️ **`::highlight()` 里能用的属性有限**：背景、前景、下划线可以，
     * 圆角、盒阴影一律无效。所以就是一块底色——和 txt 那边的 `<mark>` 一个样。
     * 颜色写死不走 `--read-*`：这些是**划线的颜色**（用户挑的那四种），
     * 不是纸色，换纸不该换划线。
     */
    st.textContent = 划线样式();
    d.head.appendChild(st);
  }

  const 按色 = new Map<string, Range[]>();
  const 漂了: number[] = [];
  for (const h of 全部) {
    const 归这屏管 = c.管得着?.(h) ?? true;
    let r: Range | null;
    try { r = c.还原(h); } catch { r = null; }
    // 不归这一屏管的还原不出来是正常的（还没滚到那一页），不算「漂了」
    if (!r) { if (归这屏管) 漂了.push(h.id); continue; }
    // 认不出的颜色退回黄的（库里那一列是 string，老数据和外部工具都可能写进来），
    // 但**带不带笔记这一位照留**——否则写过笔记的那条又变回「没笔记的样子」
    const 色 = h.color && h.color in HL_COLORS ? h.color : 'yellow';
    const k = 色 + (h.note ? '-note' : '');
    const 组 = 按色.get(k) ?? [];
    组.push(r);
    按色.set(k, 组);
  }
  // **先清干净再画**：不清的话删掉一条之后它还留在屏幕上
  for (const k of 画的键) win.CSS.highlights.delete(名(k));
  for (const [k, rs] of 按色) {
    const H = (win as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    win.CSS.highlights.set(名(k), new H(...rs) as never);
  }
  return 漂了;
}

/** 离开这一节时清掉——不清的话下一节会顶着上一节的高亮 */
export function 清划线(c: 画布): void {
  const win = c.document.defaultView as (Window & typeof globalThis) | null;
  if (!win?.CSS?.highlights) return;
  for (const k of 画的键) win.CSS.highlights.delete(名(k));
}

/**
 * 点在哪条划线上。
 *
 * ⚠️ **原生高亮不产生任何元素**，所以没有 `event.target` 可用——
 * 只能拿点的坐标去和每条 Range 的矩形比。这是这套画法唯一比
 * 「往文档里插 `<mark>`」麻烦的地方，而它换来的是不碰 DOM。
 *
 * 从后往前找：后画的压在上面，重叠时该命中最上面那条。
 */
export function 命中(c: 画布, x: number, y: number, 全部: Highlight[]): Highlight | null {
  for (let i = 全部.length - 1; i >= 0; i--) {
    const h = 全部[i];
    let r: Range | null;
    try { r = c.还原(h); } catch { r = null; }
    if (!r) continue;
    for (const box of Array.from(r.getClientRects())) {
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return h;
    }
  }
  return null;
}


/**
 * **跳过去之后，让人看见落在哪一条上。**
 *
 * ── 为什么要有这一下 ─────────────────────────────────
 *
 * 从笔记面板点「跳转」，原来只跳到那一**节**的开头。txt 那边一直是精确的
 * （`pendingScroll` 按段落偏移定位），而查看器**把 `charOffset` 整个丢了**——
 * 一节在滚动档下量到过 14000px 高，那条划线可能在几千像素之外，
 * 屏幕上是一段陌生的正文，而用户以为自己点错了。
 *
 * 两件事：**滚过去**（`block: 'center'`，前后文都看得到，判据同目录那条）、
 * **闪一下**（一屏上可能有好几条划线，不闪的话「哪条是我点的」还是没答案）。
 *
 * ⚠️ **闪的是另起一个 highlight 组，不是改那条划线的颜色**——
 * 改颜色会写库，而这只是一次「看这儿」。1.4 秒后自己撤掉。
 */
export function 闪一下(c: 画布, r: Range): void {
  const win = c.document.defaultView as (Window & typeof globalThis) | null;
  const 目标 = (r.startContainer.nodeType === Node.ELEMENT_NODE
    ? (r.startContainer as Element)
    : r.startContainer.parentElement) ?? null;
  目标?.scrollIntoView?.({ block: 'center' });
  if (!win?.CSS?.highlights) return;
  try {
    const H = (win as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    win.CSS.highlights.set(名('flash'), new H(r) as never);
    /*
     * ⚠️ **定时器排在顶层窗口，不能排在 iframe 里。**
     *
     * 当场量的：在 EPUB 那个 iframe 里 `w.setTimeout(..., 300)`，
     * 一秒半之后回调**一次都没跑**；而从顶层调 `w.CSS.highlights.delete`
     * 立刻生效。也就是说**子框架的定时器被冻住了**，
     * 而 `CSS.highlights` 那个注册表本身好好的。
     *
     * 这是「窗口不可见时 rAF 一帧都不跑」的同族（`docs/lessons.md` 搜 `rAF`）——
     * 后果一样阴：闪一下**闪上去就撤不掉**，那条划线从此顶着一片深橙色，
     * 看起来像划线的颜色坏了。
     */
    setTimeout(() => { try { win.CSS.highlights.delete(名('flash')); } catch { /* 页面换了就算了 */ } }, 1400);
  } catch { /* 闪不出来不该连累跳转本身 */ }
}

/** 框选出来那块的类名。画、清、命中三处共用这一个字符串 */
export const RECT_CLASS = 'hl-rect';

/**
 * **PDF 的矩形摘录怎么画。**
 *
 * 文字划线那套（`画划线`）用的是原生 `CSS.highlights`，而它需要一个 `Range`——
 * **框选根本没有 Range**（扫描页上一个文本节点都没有），所以这一种只能
 * 往页壳里插一个绝对定位的 div。
 *
 * ⚠️ **位置用百分比，不用像素。** 库里存的就是归一化坐标，直接变成 `%` 之后
 * **缩放、改窗口大小、重新渲染都不用重算**——而像素坐标每一次都得重算，
 * 漏算一次就是一个贴在别处的框。（`.pdf-page` 本来就是 `position: relative`。）
 *
 * ⚠️ **先清干净再画**，同 `画划线`：不清的话删掉一条之后它还留在屏幕上。
 * 而且 pdf.js 是滑到哪铺到哪，同一页会重铺好几次。
 */
export function 画矩形(舞台: HTMLElement | null, 全部: Highlight[]): void {
  if (!舞台) return;
  for (const 壳 of Array.from(舞台.querySelectorAll<HTMLElement>('.pdf-page'))) {
    for (const 旧 of Array.from(壳.querySelectorAll('.' + RECT_CLASS))) 旧.remove();
    const n = Number(壳.dataset.n ?? '');
    const 页 = Number.isFinite(n) && n > 0 ? n : 1;
    for (const h of 全部) {
      if (h.chapter_idx !== 页) continue;
      const r = 解析矩形(h.rect);
      if (!r) continue;
      const d = 壳.ownerDocument.createElement('div');
      d.className = RECT_CLASS;
      d.dataset.hl = String(h.id);
      /*
       * **带笔记的多一条边，不换颜色**——判据和文字划线那边一字不差
       * （`划线样式()` 里那条下划线）。换成黄的就把用户挑的颜色弄丢了。
       */
      d.style.cssText = [
        'position:absolute',
        `left:${(r.x * 100).toFixed(4)}%`,
        `top:${(r.y * 100).toFixed(4)}%`,
        `width:${(r.w * 100).toFixed(4)}%`,
        `height:${(r.h * 100).toFixed(4)}%`,
        `background:${底色(h.color)}`,
        'border-radius:2px',
        h.note ? 'outline:2px solid currentColor;outline-offset:-2px' : '',
      ].filter(Boolean).join(';');
      壳.appendChild(d);
    }
  }
}

/** 点在哪块框选上。框选是真的有元素，所以不用像文字划线那样拿坐标硬比 */
export function 命中矩形(目标: Element | null, 全部: Highlight[]): Highlight | null {
  const el = 目标?.closest?.('.' + RECT_CLASS) as HTMLElement | null;
  if (!el) return null;
  const id = Number(el.dataset.hl ?? '');
  return 全部.find((h) => h.id === id) ?? null;
}
