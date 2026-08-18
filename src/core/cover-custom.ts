// 用户自定义的封面搜索源。
//
// **只管封面，不碰正文**——阅读走本地 txt，这里只是「去哪儿找一张图和书名作者」。
//
// **绝不执行配置里的 JS**（和 TTS 那条同一个理由，见 AGENTS.md）：
// legado 的书源规则里能写 `<js>`、`loginCheckJs`，那些文件是从别人那里拿来的。
// 这里只认「搜索地址模板 + 四条正则」，表达不了的源就别加——
// 多几个源换「跑陌生人的代码」，这笔账怎么算都不划算。
//
// 内置那三个（起点/书旗/豆瓣）仍然是代码：它们各有各的坑（起点要浏览器渲染、
// 豆瓣藏在 window.__DATA__ 的 JSON 里、书旗只收 matchbook 块），
// 硬要塞进同一套正则配置只会做出一个残缺的 DSL。

import type { Candidate } from './enrich.ts';

export interface CustomSource {
  id: string;
  name: string;
  enabled: boolean;
  /** 搜索地址，`{q}` 会被换成 URI 编码后的书名 */
  searchUrl: string;
  /**
   * 要不要用隐藏浏览器窗口加载。
   * 起点那种 SPA 必须要（普通 HTTP 拿到的是 202 空响应），
   * 服务端渲染的站点不要——开窗口慢一个数量级，还占着那个唯一的窗口。
   */
  needsBrowser: boolean;
  /** 结果块。**必须有**——没有它就只能在整页里瞎找，书名和作者对不上号 */
  blockRe: string;
  titleRe: string;
  authorRe: string;
  coverRe: string;
}

export interface SourceTest {
  ok: boolean;
  found: number;
  candidates: Candidate[];
  error?: string;
}

/** 正则里的第 1 个捕获组就是要的值。编译不过就当这条规则没有，别让整个源炸掉 */
function pick(block: string, pattern: string): string | undefined {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern).exec(block)?.[1]?.replace(/<[^>]+>/g, '').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按一条自定义源的规则从 HTML 里抽候选。
 *
 * **纯函数**，所以能在 `node:test` 里对着 fixture 跑，也能给界面的「试一下」用——
 * 那个按钮和真正抓取走同一条路，不然会出现「试的时候好使、真抓不出来」。
 */
export function parseByRules(html: string, src: CustomSource): Candidate[] {
  let blocks: string[];
  try {
    blocks = [...html.matchAll(new RegExp(src.blockRe, 'g'))].map((m) => m[0]);
  } catch (e) {
    throw new Error(`结果块的正则有问题：${e instanceof Error ? e.message : String(e)}`);
  }

  const out: Candidate[] = [];
  for (const b of blocks) {
    const title = pick(b, src.titleRe);
    if (!title) continue; // 没书名的块不是结果，是布局
    out.push({
      title,
      author: pick(b, src.authorRe) ?? null,
      coverUrl: pick(b, src.coverRe),
      site: src.id,
    });
    if (out.length >= 20) break; // 搜索页动辄几十条，取够就停
  }
  return out;
}

/** 存进设置表的那串 JSON。存坏了当没配——一条坏规则不该让封面抓取整个瘫掉 */
export function parseSources(raw: string | null): CustomSource[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as CustomSource[];
    return Array.isArray(list) ? list.filter((s) => s && s.id && s.searchUrl) : [];
  } catch {
    return [];
  }
}

export function serializeSources(list: CustomSource[]): string {
  return JSON.stringify(list);
}

/**
 * 新建一条时的起手式。**照书旗填**——它是三个内置源里最典型的服务端渲染 HTML，
 * 用户照着改比对着空框子写正则容易得多。
 */
export function blankSource(id: string): CustomSource {
  return {
    id,
    name: '新的搜索源',
    enabled: false, // 没试过的源默认不参与抓取，和导入的清洗规则同一个规矩
    searchUrl: 'https://example.com/search?q={q}',
    needsBrowser: false,
    blockRe: '<li[^>]*class="book"[\\s\\S]*?</li>',
    titleRe: 'class="name"[^>]*>([^<]+)<',
    authorRe: 'class="author"[^>]*>([^<]+)<',
    coverRe: '<img[^>]+src="([^"]+)"',
  };
}
