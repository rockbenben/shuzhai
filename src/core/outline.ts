/**
 * **自己加的目录**（spec §6 的补充）。
 *
 * ── 为什么要有它 ────────────────────────────────────
 *
 * PDF 的目录来自文件自带的 outline，而**很多 PDF 根本没有**，
 * 有的那些也常常是乱的（页码错位、只有一级、名字是「Chapter 1」）。
 * 那时候一本几百页的书**在应用里没有任何导航**——只能拖滑块。
 *
 * GoodNotes 把这件事做成了正经功能（`docs/reference/goodnotes/` 的
 * 「Create an outline」那一篇）：可以自己加、改名、删，导入的 PDF 目录烂了
 * 也能自己重建。这里做的是那一套里最小的一份：**加当前这一页、改名、删**。
 *
 * ── 存哪儿 ─────────────────────────────────────────
 *
 * `app_setting` 的 `outline.<bookId>`，值是一段 JSON。
 *
 * ⚠️ **这是「按 id 命名的设置」，铁律 3 在这个形状上栽过一次**
 * （`viewer.<bookId>`：备份不带、`canDelete` 当它不存在、孤儿判据把它清掉、
 * 合并时丢掉，**五处同时一无所知**）。所以这一份从第一天就跟着走：
 * 删书有触发器兜底、备份带、恢复时按新的 book id 重写。
 *
 * ⚠️ **和 `viewer.<bookId>` 一样，`book.id` 会被复用**——漏清一行就会
 * 悄悄贴到另一本书上，而且不报错。兜底那条触发器在 `db.ts` 的迁移里。
 */
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, setSetting } from './db.ts';

/** 目录里的一条：第几页 + 叫什么。**页码从 1 起**，和 PDF 那半一致 */
export interface OutlineItem {
  page: number;
  title: string;
}

export const OUTLINE_KEY = (bookId: number): string => `outline.${bookId}`;

/** 一本书最多自己加多少条。目录是用来一眼扫过去的，不是第二份笔记 */
export const OUTLINE_MAX = 500;
/** 一条目录名最多多长。同样的理由 */
export const TITLE_MAX = 60;

/**
 * 读回来。**认不出来的一律当没有**——存的是 JSON，
 * 外部工具经 §13 写进来的什么都可能有，而一条坏记录不该让整个目录打不开。
 */
export function readOutline(db: DatabaseSync, bookId: number): OutlineItem[] {
  const raw = getSetting(db, OUTLINE_KEY(bookId));
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => {
        const o = x as { page?: unknown; title?: unknown };
        const page = Number(o.page);
        const title = typeof o.title === 'string' ? o.title.trim() : '';
        return Number.isInteger(page) && page > 0 && title ? { page, title: title.slice(0, TITLE_MAX) } : null;
      })
      .filter((x): x is OutlineItem => x !== null)
      .sort((a, b) => a.page - b.page || a.title.localeCompare(b.title, 'zh'));
  } catch {
    return [];
  }
}

/**
 * 写回去。**校验在这一头**，读那头只兜底——
 * 判据同 `setBookConvertMode`：写进去的时候拦住，比读回来时悄悄显示成空好。
 */
export function writeOutline(db: DatabaseSync, bookId: number, items: OutlineItem[]): OutlineItem[] {
  if (items.length > OUTLINE_MAX) {
    throw new Error(`目录最多 ${OUTLINE_MAX} 条，现在有 ${items.length} 条`);
  }
  const 净: OutlineItem[] = [];
  for (const it of items) {
    const page = Number(it?.page);
    const title = String(it?.title ?? '').trim();
    if (!Number.isInteger(page) || page <= 0) throw new Error(`页码不对：${String(it?.page)}`);
    if (!title) throw new Error('目录条目得有个名字');
    if ([...title].length > TITLE_MAX) {
      throw new Error(`名字太长了（${[...title].length} 个字，最多 ${TITLE_MAX} 个）`);
    }
    // **同一页可以有好几条**（GoodNotes 明说支持：同一页按不同标准归类），
    // 但同页同名的重复没有意义
    if (!净.some((x) => x.page === page && x.title === title)) 净.push({ page, title });
  }
  净.sort((a, b) => a.page - b.page || a.title.localeCompare(b.title, 'zh'));
  setSetting(db, OUTLINE_KEY(bookId), JSON.stringify(净));
  return 净;
}
