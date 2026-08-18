// 命中处的上下文片段：命中词用 【】 包起来。
//
// ⚠️ **单独一个文件，而且一个依赖都不 import**——理由和 `book-format.ts` 顶上
// 那段一样：**渲染进程也要用它**（查看器的书内搜索在渲染进程里跑，
// 因为 PDF/EPUB 的正文只有 pdf.js / epub.js 拿得到）。
// 留在 `search.ts` 里的话，`FileViewer.tsx` 一 import，Vite 就把
// `node:sqlite` 连同整个全文索引拖进渲染包。
//
// 抄一份到渲染进程更糟：`【】` 是**约定**，两边分叉之后，
// 同一个搜索结果在 txt 里高亮、在 PDF 里显示成一对光秃秃的括号。

/**
 * 从 `text` 里截出 `query` 命中处的上下文。
 *
 * **格式和 FTS5 的 `snippet()` 对齐**（`…前文【命中】后文…`），
 * 于是界面上那段渲染代码认一种格式就够。
 *
 * @param radius 命中词两侧各留几个字
 * @param at 命中处在 `text` 里的位置。**调用方已经知道就传进来**——
 *   不传的话这儿只会找**第一处**，而一节里同一个词出现十次时，
 *   第十处的摘要会显示成第一处的上下文（看起来像十条一模一样的结果）。
 *   查看器那边逐页/逐节扫，位置本来就在手上。
 */
export function makeSnippet(text: string, query: string, radius = 12, at = text.indexOf(query)): string {
  if (at < 0) return text.slice(0, radius * 2);
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + query.length + radius);
  return (
    (from > 0 ? '…' : '') +
    text.slice(from, at) +
    `【${text.slice(at, at + query.length)}】` +
    text.slice(at + query.length, to) +
    (to < text.length ? '…' : '')
  );
}
