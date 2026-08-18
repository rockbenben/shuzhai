// 补全书籍元数据：官网地址、封面、分类、标签（用户需求，spec §3.1 / §4 的延伸）。
//
// **这个模块不负责「去哪儿找」，只负责「找到之后怎么落库」。** 原因是实测出来的：
// 起点返回 202 空响应、豆瓣搜索接口 403、番茄是前端渲染——主流站点都挡普通 HTTP
// 请求，而绕反爬不做（spec §14 本来也写着不做书源爬取聚合）。
//
// 所以数据来源是**可插拔**的，和 spec §4 的更新检测同一个路子：
//   1. 用户自己配一个能用的站点（搜索 URL + 提取正则）
//   2. 或者由 Claude 走 §13 的维护接口把结果写回来——它有浏览器，
//      能搜到人能搜到的东西，这正是那个接口存在的意义
//
// **匹配一律要求书名和作者都完全一致**（用户明确要求）。宁可漏也不能错：
// 张冠李戴地贴上封面和标签，用户很难发现，而发现时已经不知道哪些是错的。

import { writeFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { addLink } from './links.ts';
import { tagBooks } from './library.ts';
import { coverDir } from './cover.ts';

export interface Candidate {
  /** 对面站点上的书名，必须和本地完全一致才算匹配 */
  title: string;
  /** 对面站点上的作者，必须和本地完全一致才算匹配 */
  author: string | null;
  /** 书的官方页面 */
  url?: string;
  coverUrl?: string;
  category?: string;
  tags?: string[];
  intro?: string;
  /** 数据来自哪个站，记进 source_site */
  site?: string;
}

/**
 * 归一化后再比。
 *
 * 只做**不改变身份**的归一：去首尾空白、全角转半角、去掉书名号。
 * 不做繁简转换也不做模糊匹配——「斗破苍穹」和「斗破苍穹之无上之境」
 * 是两本书，放宽一点就会张冠李戴。
 */
export function normalizeForMatch(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/[《》〈〉「」『』【】]/g, '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

export interface MatchResult {
  matched: boolean;
  reason?: string;
}

/** 书名和作者都要完全一致。作者本地为空时**不算匹配**——那等于只靠书名认，太松 */
export function isExactMatch(
  local: { title: string; author: string | null },
  candidate: Candidate,
): MatchResult {
  if (normalizeForMatch(local.title) !== normalizeForMatch(candidate.title)) {
    return { matched: false, reason: `书名不一致：本地「${local.title}」对面「${candidate.title}」` };
  }
  if (!local.author) return { matched: false, reason: '本地没有作者，只靠书名认太容易张冠李戴' };
  if (normalizeForMatch(local.author) !== normalizeForMatch(candidate.author)) {
    return {
      matched: false,
      reason: `作者不一致：本地「${local.author}」对面「${candidate.author ?? '（无）'}」`,
    };
  }
  return { matched: true };
}

/**
 * 就是全局 `fetch` 本身，起个名字方便在参数上写。
 *
 * **`webdav.ts` 原来也导出了一个一模一样的 `FetchLike`**——同一个内置类型的两个别名，
 * 没有任何东西靠它们保持一致，但名字撞车会让人以为它们是同一个约定。
 * 那边现在直接写 `typeof globalThis.fetch`：给内置类型起的别名不值得跨模块共享。
 */
export type FetchLike = typeof globalThis.fetch;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

/**
 * 下载回来的字节到底是不是一张能用的封面。三条，都是兜底
 * （主防线是提取时取 data-original 而不是 src）：
 *   1. URL 不含已知占位图路径；2. 大小 2KB–5MB；3. 文件头是真图片格式。
 */
export function validateCoverBytes(
  buf: Uint8Array,
  url: string,
): { ok: true } | { ok: false; reason: string } {
  if (url.includes('default_book')) return { ok: false, reason: '这是站点的懒加载占位图' };
  if (buf.length < 2048) return { ok: false, reason: `只有 ${buf.length} 字节，不像封面` };
  if (buf.length > 5 * 1024 * 1024) return { ok: false, reason: '超过 5MB，不像封面' };
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isWebp =
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  const isGif = buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
  if (!isJpeg && !isPng && !isWebp && !isGif) {
    return { ok: false, reason: '文件头不是图片格式（多半拿回了一页 HTML）' };
  }
  return { ok: true };
}

/**
 * 把远端封面下下来存进 userData。
 * **按 Content-Type 定扩展名**，不信 URL 里的后缀——很多站点的封面地址没有后缀，
 * 或者后缀和真实格式对不上。
 */
export async function downloadCover(
  userDataDir: string,
  bookId: number,
  url: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<string> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const res = await f(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`封面下载失败：HTTP ${res.status}`);

  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new Error(`这个地址返回的不是图片（${type || '未知类型'}）`);

  const buf = Buffer.from(await res.arrayBuffer());
  // 校验在写盘之前：占位图、HTML 错误页、超大文件都在这儿拦住
  // （数值上限已包含在校验里，取代原来单独的 MAX_COVER_BYTES 判断）
  const v = validateCoverBytes(buf, url);
  if (!v.ok) throw new Error(`封面不可用：${v.reason}`);

  const ext = MIME_EXT[type] ?? extname(new URL(url).pathname) ?? '.jpg';
  const dir = coverDir(userDataDir);
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${bookId}-${Date.now()}${ext}`);
  await writeFile(target, buf);
  return target;
}

export interface EnrichResult {
  bookId: number;
  applied: string[];
  skipped: string[];
}

/**
 * 把一条候选应用到本地这本书上。
 *
 * **只补空缺，不覆盖用户填过的东西**：书名、作者、简介如果本地已经有内容，
 * 就不动它——用户手工改过的元数据比抓来的可信。分类和标签是追加。
 */
export async function applyCandidate(
  db: DatabaseSync,
  userDataDir: string,
  bookId: number,
  candidate: Candidate,
  opts: { fetchImpl?: FetchLike; overwriteCover?: boolean } = {},
): Promise<EnrichResult> {
  const local = db.prepare('select id, title, author, intro, cover_path, category_id from book where id = ?').get(bookId) as
    | { id: number; title: string; author: string | null; intro: string | null; cover_path: string | null; category_id: number | null }
    | undefined;
  if (!local) throw new Error(`没有这本书：${bookId}`);

  const m = isExactMatch(local, candidate);
  if (!m.matched) throw new Error(m.reason ?? '不匹配');

  const applied: string[] = [];
  const skipped: string[] = [];

  if (candidate.intro) {
    if (local.intro) skipped.push('简介（本地已有，不覆盖）');
    else {
      db.prepare('update book set intro = ? where id = ?').run(candidate.intro.slice(0, 4000), bookId);
      applied.push('简介');
    }
  }

  if (candidate.site) {
    db.prepare('update book set source_site = ? where id = ?').run(candidate.site, bookId);
    applied.push('来源站点');
  }

  if (candidate.url) {
    try {
      // 不强制 isPrimary：这本书已经有主地址的话（多半是用户自己填的），不该被
      // 一条候选悄悄覆盖——那是这本书的元数据，重扫恢复不了。addLink 自己会处理
      // 「这是这本书第一条地址」的情况并自动设为主，所以新书照样有主地址可用
      addLink(db, bookId, candidate.url, { note: '官方页面' });
      applied.push('官网地址');
    } catch (e) {
      skipped.push(`官网地址（${e instanceof Error ? e.message : String(e)}）`);
    }
  }

  if (candidate.category) {
    db.prepare('insert or ignore into category(name) values(?)').run(candidate.category);
    const cat = db.prepare('select id from category where name = ?').get(candidate.category) as
      | { id: number }
      | undefined;
    if (cat) {
      db.prepare('update book set category_id = ? where id = ?').run(cat.id, bookId);
      applied.push(`分类「${candidate.category}」`);
    }
  }

  if (candidate.tags?.length) {
    const clean = candidate.tags.map((t) => t.trim()).filter((t) => t && t.length <= 20).slice(0, 12);
    if (clean.length) {
      tagBooks(db, [bookId], clean);
      applied.push(`标签 ${clean.length} 个`);
    }
  }

  if (candidate.coverUrl) {
    if (local.cover_path && !opts.overwriteCover) {
      skipped.push('封面（本地已有）');
    } else {
      try {
        const path = await downloadCover(userDataDir, bookId, candidate.coverUrl, opts);
        db.prepare('update book set cover_path = ? where id = ?').run(path, bookId);
        applied.push('封面');
      } catch (e) {
        skipped.push(`封面（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
  }

  db.prepare("update book set updated_at = datetime('now') where id = ?").run(bookId);
  return { bookId, applied, skipped };
}

// ── 可插拔的抓取源 ──────────────────────────────────────────────────

export interface SourceConfig {
  name: string;
  /** 搜索地址，`{q}` 会被替换成 URL 编码后的书名 */
  searchUrl: string;
  /** 从搜索结果页提取候选。每条至少要能取到 title 和 author */
  itemPattern: string;
  titleGroup: number;
  authorGroup: number;
  urlGroup?: number;
  coverGroup?: number;
  /** 请求间隔，同域名串行 */
  gapMs?: number;
}

/**
 * 用一个配置好的站点搜候选。
 *
 * **不内置主流站点的配置**：起点需要隐藏 BrowserWindow 提取、豆瓣需要解析 `window.__DATA__`
 * ——各有各的拿法，这些专属逻辑走 `src/main/cover-fetcher.ts` 和 `src/core/cover-source.ts`
 * 的专门路径，不适合塞进通用的正则配置。
 * 这个函数的用途是让用户自配一个能访问的站点，或走 §13 接口让 Claude 用浏览器去查。
 */
export async function searchSource(
  cfg: SourceConfig,
  title: string,
  opts: { fetchImpl?: FetchLike; ua?: string } = {},
): Promise<Candidate[]> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const url = cfg.searchUrl.replace('{q}', encodeURIComponent(title));

  const res = await f(url, {
    headers: {
      'user-agent':
        opts.ua ??
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`搜索失败：HTTP ${res.status}`);

  const html = await res.text();
  let re: RegExp;
  try {
    re = new RegExp(cfg.itemPattern, 'gs');
  } catch (e) {
    throw new Error(`提取规则的正则无效：${e instanceof Error ? e.message : String(e)}`);
  }

  const out: Candidate[] = [];
  for (const m of html.matchAll(re)) {
    const title2 = m[cfg.titleGroup]?.trim();
    if (!title2) continue;
    out.push({
      title: title2,
      author: m[cfg.authorGroup]?.trim() ?? null,
      url: cfg.urlGroup ? m[cfg.urlGroup]?.trim() : undefined,
      coverUrl: cfg.coverGroup ? m[cfg.coverGroup]?.trim() : undefined,
      site: cfg.name,
    });
    if (out.length >= 20) break;
  }
  return out;
}
