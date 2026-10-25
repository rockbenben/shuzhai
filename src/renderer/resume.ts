/**
 * 「继续阅读」浮钮要的三件纯判断：位置怎么说、进度弧画多少、选哪一本。
 *
 * **放在 `.ts` 而不是 `App.tsx` 里，是因为 `node --test` 不认 `.tsx`**
 * （同 `cover-art.ts` / `toast-clock.ts` 的理由）。浮钮的取数已经出过一次
 * 「PDF 报第 1 章」的假话，而那条判据只有一行的距离——不钉住，
 * 下一次改文案就会再长回来。
 */
import { formatOf, viewerOf } from '../core/book-format.ts';
import { whenAgo } from '../core/format.ts';

/** 「继续阅读」入口要的那几样（`reading.recent` 返回的形状） */
export interface ResumeRow {
  bookId: number;
  title: string;
  author: string | null;
  status: string;
  percent: number | null;
  chapterIdx: number | null;
  lastReadAt: string;
  /**
   * 主文件路径。**PDF / EPUB 不能报章号**：它们的位置存在 `viewer.<bookId>`，
   * `reading_state.chapter_idx` 永远是 0（同书架卡片那一行，见 `位置名` 那套判据）。
   */
  path: string | null;
}

/**
 * 「继续阅读」浮钮上那句位置说明。
 *
 * **PDF / EPUB 不报章号。** 它们的位置存在 `viewer.<bookId>`，
 * `reading_state.chapter_idx` 永远是 0——照直渲染的话，一本翻到第 100 页的
 * PDF 会在浮钮上写着「第 1 章」（同书架卡片那一行）。
 */
export function 续读位置(r: ResumeRow): string {
  const viewer = viewerOf(r.path);
  if (viewer) return `${viewer.toUpperCase()} · 上次读到的位置`;
  if (formatOf(r.path) === 'text' && r.chapterIdx != null) {
    return `第 ${r.chapterIdx + 1} 章`
      + (r.percent != null && r.percent > 0 && r.percent < 100
        ? ` · ${Math.round(r.percent)}%`
        : '');
  }
  return '上次打开的那本';
}

/**
 * 浮钮上那圈进度弧画多少（0–100）。**没有真实百分比就返回 null，不画。**
 *
 * - 只有 txt 的 `reading_state.percent` 是按章算出来的真数；
 * - PDF / EPUB 的位置在 `viewer.<bookId>`（PDF 只有页码、没有总页数），
 *   拿它算比例只能凭空造一个分母——`reading_state.percent` 对它们恒为 0；
 * - 手工书没有文件，也谈不上读到几成。
 *
 * 返回 null 时**不画弧**（连轨道都不画），而不是画一个 0% 的假进度。
 */
export function 续读进度(r: ResumeRow): number | null {
  if (formatOf(r.path) !== 'text') return null;
  const p = r.percent;
  if (typeof p !== 'number' || !Number.isFinite(p)) return null;
  return Math.min(100, Math.max(0, p));
}

/**
 * 悬停提示的正文：位置 + 上次读多久前。时间走 `whenAgo`（份内已经处理了
 * 库里那串是 UTC），`now` 只为测试固定时钟。
 */
export function 续读提示(r: ResumeRow, now = Date.now()): string {
  const pos = 续读位置(r);
  const ago = whenAgo(r.lastReadAt, now)?.text;
  return ago ? `${pos} · ${ago}` : pos;
}

/**
 * 从 `reading.recent` 里挑浮钮要指的那一本。
 *
 * **输入顺序就是优先级**：`reading.recent` 已按最后阅读时间排好
 * （`status.ts` 用 `strftime('%s')` 比时刻，不拿字符串比），这里只取第一条。
 *
 * **必须是在读、而且真有文件的。**
 * - 读完/弃坑的书 `last_read_at` 也可能是最新的，但它不该出现在「继续阅读」里；
 * - 手工添的「只有记录」没有 `path`，点开是评价浮层而不是接着读，
 *   浮钮上写「继续阅读」会骗人——跳过它，继续找下一本。
 */
export function 选续读(rows: ResumeRow[]): ResumeRow | null {
  return rows.find((r) => r.status === 'reading' && !!r.path) ?? null;
}
