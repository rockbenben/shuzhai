/**
 * PDF 划线的**锚**：页内偏移 ↔ Range。
 *
 * ── 为什么是「页 + 页内偏移 + 长度」 ─────────────────────
 *
 * txt 的划线锚是「章号 + 章内字节偏移 + 长度」，EPUB 是 CFI。PDF 两样都没有：
 * 它既没有章节表，也没有 CFI。但它有**文字层**——pdf.js 把每页的文字按
 * `getTextContent()` 的顺序铺成一串 span，那一串拼起来就是「这一页的正文」，
 * 而「第几个字符起、多长」在这串里是稳定的：同一个 PDF、同一页，
 * `getTextContent()` 的顺序不随缩放、窗口大小、渲染次数变。
 *
 * 于是锚可以**直接复用 `highlight` 表现成的三列**：
 * `chapter_idx` 存页码、`char_offset` 存页内偏移、`length` 存长度。
 * 当时**一列都没加、一次迁移都没写**——那是选这套而不是另造一套的主要理由。
 *
 * ⚠️ **后来还是加了一列，而且理由站得住：`rect`（迁移 22）。**
 * 这一整套建在**文字层**上，而扫描页 / 插图 / 公式 / 表格根本没有文字层——
 * 那些页上一个字都选不中，一条笔记都做不了。参照 MarginNote（摘录有四种形态：
 * 空白 / 文字 / 矩形 / 套索）补了**矩形摘录**：`chapter_idx` 仍然是页码，
 * `rect` 装 "x,y,w,h" 四个 0–1 的归一化坐标，`char_offset` / `length` 退为占位。
 * 它们走另一份画法（`highlight-view.ts` 的 `画矩形`），**不经过这个模块**。
 *
 * ⚠️ **偏移是按「文字层里所有文本节点拼起来」算的**，不是按
 * `tc.items.map(i => i.str).join('')`。两者通常一样，但 marked content 和
 * `hasEOL` 会让 items 那份多出或少掉东西。**存和画都走这个模块**，
 * 两头用同一把尺，就不会出现「存下去的和画出来的差几个字」。
 */

/** 这一页文字层里的文本节点，按 DOM 顺序，附带各自在整页文本里的起点 */
function 节点表(层: HTMLElement): Array<{ n: Text; from: number }> {
  const 出: Array<{ n: Text; from: number }> = [];
  const 走 = 层.ownerDocument.createTreeWalker(层, NodeFilter.SHOW_TEXT);
  let 累 = 0;
  for (let x = 走.nextNode(); x; x = 走.nextNode()) {
    const t = x as Text;
    const len = t.nodeValue?.length ?? 0;
    if (len === 0) continue;
    出.push({ n: t, from: 累 });
    累 += len;
  }
  return 出;
}

/** 这一页的全部文字。空串＝扫描版，没有文字层 */
export function 页文本(层: HTMLElement): string {
  return 节点表(层).map((x) => x.n.nodeValue ?? '').join('');
}

/**
 * 某个 (节点, 节点内偏移) 在整页文本里是第几个字符。
 * 认不出来（不在这一页里）回 `null`——**不猜**。
 */
export function 页内偏移(层: HTMLElement, node: Node, offset: number): number | null {
  const 表 = 节点表(层);
  for (const x of 表) {
    if (x.n === node) return x.from + offset;
  }
  /*
   * 选区的端点可能落在**元素**上而不是文本节点上（整段选中时很常见）。
   * 那时候按「这个元素里第 offset 个子节点」折算成它前面所有文字的长度。
   */
  if (node.nodeType === Node.ELEMENT_NODE) {
    const 孩 = Array.from(node.childNodes).slice(0, offset);
    const 前 = 孩.reduce((n, c) => n + (c.textContent?.length ?? 0), 0);
    const 头 = 表.find((x) => node.contains(x.n));
    if (头) return 头.from + 前;
  }
  return null;
}

/**
 * 把「页内偏移 + 长度」还原成一个 Range。还原不出来回 `null`。
 *
 * ⚠️ **越界要回 null，不要夹**。夹回去会画出一条**位置不对的划线**，
 * 而那比「这条画不出来」更糟——界面照实说一句「有几条对不上」，
 * 判据同 EPUB 那边的 `漂了`。
 */
export function 造Range(层: HTMLElement, from: number, len: number): Range | null {
  if (len <= 0) return null;
  const 表 = 节点表(层);
  if (表.length === 0) return null;
  const 总 = 表[表.length - 1].from + (表[表.length - 1].n.nodeValue?.length ?? 0);
  if (from < 0 || from + len > 总) return null;
  const 找 = (位: number) => {
    for (const x of 表) {
      const 长 = x.n.nodeValue?.length ?? 0;
      if (位 >= x.from && 位 <= x.from + 长) return { n: x.n, off: 位 - x.from };
    }
    return null;
  };
  const a = 找(from);
  const b = 找(from + len);
  if (!a || !b) return null;
  const r = 层.ownerDocument.createRange();
  try {
    r.setStart(a.n, a.off);
    r.setEnd(b.n, b.off);
  } catch { return null; }
  return r;
}

/** 这一屏上所有页的文字层，键是页码（`.pdf-page` 的 `data-n`） */
export function 各页文字层(舞台: HTMLElement | null): Map<number, HTMLElement> {
  const 出 = new Map<number, HTMLElement>();
  if (!舞台) return 出;
  for (const 壳 of Array.from(舞台.querySelectorAll<HTMLElement>('.pdf-page'))) {
    const t = 壳.querySelector<HTMLElement>('.textLayer');
    const n = Number(壳.dataset.n ?? '');
    if (t) 出.set(Number.isFinite(n) && n > 0 ? n : 1, t);
  }
  return 出;
}
