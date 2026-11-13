// 划线的共享形状、颜色和矩形校验；持久化仍由 highlight.ts 负责。
export const COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
export type HighlightColor = (typeof COLORS)[number];

/**
 * 颜色**默认**叫什么。
 *
 * ⚠️ **这几个名字原来在渲染进程里抄了三份**——`HighlightsPanel` 的 `色名`、
 * `FileViewer` 的 `颜色名`，而 `Reader` 那份连名字都没有（四个圆点的 title
 * 都是同一句「用这个颜色划线」）。同 `labels.ts` 顶上说的那个病，正本只在这儿。
 *
 * 而且这几个名字**是给用户改的**：GoodNotes 和 MarginNote 都把「这个颜色代表什么」
 * 交给用户自己定（黄＝好句、蓝＝待查、绿＝人物关系）。颜色不写明用途，
 * 那套分类等于只写给自己看——隔一个月回来，自己也不记得蓝色当初是什么意思。
 * 改过的名字存在 `app_setting` 的 `highlight.colorNames`，见 `highlight.ts` 的 `colorNames`。
 */
export const COLOR_NAMES: Record<HighlightColor, string> = {
  yellow: '黄', green: '绿', blue: '蓝', pink: '粉',
};

/** 用户改过的颜色用途存在这个键下 */
export const COLOR_NAMES_KEY = 'highlight.colorNames';

export interface Highlight {
  id: number;
  book_id: number;
  chapter_idx: number;
  char_offset: number;
  /** EPUB 的锚点：一条 CFI range。txt 的划线这一列是 null，走偏移那条路 */
  cfi?: string | null;
  /**
   * **PDF 的矩形摘录**：`"x,y,w,h"`，四个 0–1 的数，相对于 `chapter_idx` 那一页。
   * 只有框选出来的那种有它；文字划线这一列是 null。
   */
  rect?: string | null;
  length: number;
  excerpt: string;
  note: string | null;
  color: string;
  created_at: string;
}

/**
 * 把 `rect` 那一列解成四个数。**认不出来回 `null`——不猜。**
 *
 * 存的是归一化坐标（相对那一页，0–1），所以四个数都得在 [0,1] 里、
 * 宽高还得大于 0。超出去的一律当认不出来：**夹回去会画出一个位置不对的框**，
 * 而那比「这条画不出来」更糟（判据同 `pdf-text.ts` 的 `造Range`）。
 *
 * **这一份只此一份**：写库前校验、画的时候转百分比、导出时写位置，都走它。
 */
export function 解析矩形(s: string | null | undefined): { x: number; y: number; w: number; h: number } | null {
  const n = (s ?? '').split(',').map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return null;
  const [x, y, w, h] = n;
  if (w <= 0 || h <= 0) return null;
  if (x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  return { x, y, w, h };
}
