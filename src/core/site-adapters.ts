// 内置站点的「怎么认这个站」：搜索候选、连载状态、最新章。
//
// **纯函数，禁 import electron**——要浏览器渲染的站（起点、番茄）由调用方
// （cover-fetcher / checkUpdates）取好 HTML 再喂进来。这个文件 node:test 直接跑。
//
// 一份提取规则两处用：封面链找书、更新检查认最新章，不再各抄一份
// （「同一份判据抄第二份」是这个仓库咬过最多遍的坑）。
import type { DatabaseSync } from 'node:sqlite';
import { isExactMatch, normalizeForMatch, type Candidate } from './enrich.ts';
// 站点中文名的唯一一份在 labels.ts（渲染进程也要显示，够不到这个文件）
import { SITE_LABELS } from './labels.ts';

export type SerialState = 'ongoing' | 'finished';

export interface SiteAdapter {
  id: string;
  label: string;
  /** 搜索/取页要不要隐藏窗口渲染（起点、番茄 true，其余 false） */
  needsBrowser: boolean;
  /** 进封面抓取链（纵横/番茄实测补不到封面，false——见各适配器注释） */
  coverSearch: boolean;
  searchUrl?: (title: string) => string;
  parseCandidates?: (html: string) => Candidate[];
  /** 搜索结果页 HTML 已经在手里时顺手认连载状态；认不出返回 null */
  parseSerial?: (html: string, bookTitle: string) => SerialState | null;
  /** 取最新章该请求哪个 URL、要不要浏览器；不支持的站返回 null。
   *  纵横走搜索 JSON 接口（要拿书名当参数），所以入参是整本书而不只是 URL */
  latestRequest?: (book: { title: string; author: string | null; url: string }) =>
    { url: string; needsBrowser: boolean } | null;
  parseLatest?: (body: string, book: { title: string; author: string | null; url: string }) =>
    { latest: string; serial?: SerialState } | null;
  /**
   * **用户亲手粘的详情页**：从那一页提取这本书的封面/简介/作者/分类。
   * 身份由用户给的链接负责，所以**不走**书名+作者精确匹配（本地可能连作者都没有，
   * 那道门会把最需要它的情况挡在外面）；落库时「只补空缺」仍由 enrich 兜着。
   * 认不出（不是一本书的详情页、改版了）返回 null。
   */
  parseDetail?: (html: string, url: string) => Candidate | null;
}

// ── 候选提取 ────────────────────────────────────────────────────────
//
// 起点必须在浏览器上下文里拿 HTML（普通 HTTP 是 202 空响应，实测 209 字节），
// 但**提取本身是纯字符串操作**，放这儿好测。豆瓣普通 HTTP 就能拿到。

const stripTags = (s: string) => s.replace(/<[^>]+>/g, '').trim();
/** 起点的地址都是 `//xxx` 协议相对形式，落库前补上 https: */
const absUrl = (u: string) => (u.startsWith('//') ? `https:${u}` : u);

/** HTML 实体（含 &#128077; 这种数字引用）解回字符。详情页的简介里全是这些 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/**
 * 从 `<meta property|name="key" content="...">` 取 content。
 * content 和 property 谁在前都认（豆瓣/起点顺序不一样），值里的实体解掉。
 */
function metaContent(html: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = new RegExp(`<meta\\b[^>]*?(?:property|name)=["']${esc}["'][^>]*>`, 'i').exec(html)?.[0];
  if (!tag) return null;
  const c = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return c == null ? null : decodeEntities(c);
}

/** 剥标签 + 解实体 + 压空白，给详情页大段文本用 */
const cleanText = (s: string): string =>
  decodeEntities(stripTags(s)).replace(/\s+/g, ' ').trim();

function parseQidianCandidates(html: string): Candidate[] {
  const out: Candidate[] = [];
  for (const item of html.matchAll(/<li[^>]*data-bid="(\d+)"[\s\S]*?<\/li>/g)) {
    const block = item[0];
    const title = /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1];
    if (!title) continue;
    const author = /class="author"[\s\S]*?<a[^>]*class="name"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1];
    // ⚠️ 封面在 data-original，不是 src——src 是懒加载占位图 default_book.png。
    // 取错的话抓下来是 8000 张一模一样的占位图，而且界面上看起来一切正常
    const cover = /data-original="([^"]+)"/.exec(block)?.[1];
    out.push({
      title: stripTags(title),
      author: author ? stripTags(author) : null,
      url: `https://www.qidian.com/book/${item[1]}/`,
      coverUrl: cover ? absUrl(cover) : undefined,
      site: 'qidian',
    });
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 书旗的搜索页分两块：`matchbook` 是**精确匹配**那一本，`searchlist-main` 是相关结果。
 *
 * **只收 matchbook。** 相关结果那一列是模糊推荐（搜《人间冰器》给的是《人间有剑》），
 * 收进来只会让 `isExactMatch` 白跑一遍——而万一书名恰好撞上、作者也撞上，
 * 那就是配错封面。这个源的价值在精确块本身。
 */
function parseShuqiCandidates(html: string): Candidate[] {
  // 截到 searchlist-main 为止，免得正则跨过精确块吃到下面的相关结果
  const block = /class="matchbook"[\s\S]*?(?=class="searchlist-main"|$)/.exec(html)?.[0];
  if (!block) return [];
  const title = /class="bname"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1];
  if (!title) return [];
  const author = /class="bauthor">作者：([^<]*)</.exec(block)?.[1];
  const cover = /<img src="([^"]+)"/.exec(block)?.[1];
  const id = /href="\/book\/(\d+)\.html"/.exec(block)?.[1];
  return [{
    title: stripTags(title),
    author: author ? stripTags(author) : null,
    url: id ? `https://www.shuqi.com/book/${id}.html` : undefined,
    coverUrl: cover ? absUrl(cover) : undefined,
    site: 'shuqi',
  }];
}

/**
 * 豆瓣**答没答**这次搜索。真的没搜到时页面里照样有 `window.__DATA__`（items 是空的），
 * 所以没有它就说明拿到的根本不是搜索结果页——反爬页或者改版了。
 *
 * **「没问出来」和「问过了没有」必须分开**，这是踩出来的：反爬页是 HTTP **200**，
 * 原来直接当「没搜到」，于是一整段时间里所有走到豆瓣这步的书都被写成
 * 「没匹配上」并持久化。实测那一段里抽 8 本重试，**5 本立刻经豆瓣命中**
 * ——《幽灵客栈》蔡骏、《封神记》黄易这类出版书正是豆瓣的强项。
 *
 * 同一个文件里对 429/403 早就写着「必须抛出去，不能悄悄放过当没搜到」，
 * 而反爬页是同一件事**披了个 200 的皮**。
 */
export function doubanAnswered(html: string): boolean {
  return /window\.__DATA__\s*=/.test(html);
}

function parseDoubanCandidates(html: string): Candidate[] {
  // 找 window.__DATA__ = 后面的 JSON 对象。
  // 不能用懒惰匹配 (\{[\s\S]*?\})，因为 abstract 字段里可能含有 };，
  // 会导致正则在那里截断，整页候选全清零。
  // 改用括号计数，跳过字符串值内的花括号。
  const m = /window\.__DATA__\s*=\s*\{/.exec(html);
  // 拿不到就当没搜到——**调用方要先用 `doubanAnswered` 把「没问出来」拦下来**，
  // 这里是纯解析函数，不负责区分
  if (!m) return [];

  const start = m.index! + m[0].length - 1; // 第一个 { 的位置
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"' && !inString) {
      inString = true;
      continue;
    }

    if (ch === '"' && inString) {
      inString = false;
      continue;
    }

    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
  }

  if (end === -1) return []; // 没找到配对的 }

  const jsonStr = html.substring(start, end + 1);
  let data: { items?: Array<{ title?: string; abstract?: string; cover_url?: string; url?: string }> };
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return [];
  }

  return (data.items ?? [])
    .filter((x) => x.title)
    .slice(0, 20)
    .map((x) => ({
      title: String(x.title).trim(),
      author: x.abstract ? x.abstract.split('/')[0].trim() || null : null,
      url: x.url,
      coverUrl: x.cover_url || undefined,
      site: 'douban',
    }));
}

// ── 详情页提取（用户粘了这本书的链接，一键取封面/简介/作者）──────────
//
// 和上面「搜索页提取」是两件事：搜索是**按书名找书**，所以要书名+作者都对得上
// 才认（isExactMatch）；详情页是**用户已经把这本书的网址贴了过来**，身份由
// 链接负责，解析只管「这一页里写着什么」，落库时只补空缺、不覆盖用户填过的。

/**
 * 通用详情页提取：读 Open Graph / `og:novel:*` 元数据。
 *
 * 起点详情页整页的关键信息都是 `og:novel:*`（服务端直出，普通 fetch 是 202
 * 空页、隐藏窗口渲染后就在 `<head>` 里，实测）；番茄、纵横及大量小说站也带。
 * 书旗干脆没有 og 标签、豆瓣作者在 `#info`，那两家走各自的专属解析。
 */
export function parseOpenGraph(html: string, site: string): Candidate | null {
  const title = metaContent(html, 'og:novel:book_name') || metaContent(html, 'og:title');
  const author =
    metaContent(html, 'og:novel:author') || metaContent(html, 'book:author') || null;
  const coverRaw = metaContent(html, 'og:image');
  const intro = metaContent(html, 'og:description') || metaContent(html, 'description');
  const category = metaContent(html, 'og:novel:category');
  const tagRaw = metaContent(html, 'og:novel:tag') || metaContent(html, 'book:tag');
  const tags = tagRaw
    ? tagRaw.split(/[,，、/／|]/).map((t) => t.trim()).filter(Boolean).slice(0, 12)
    : undefined;
  const url = metaContent(html, 'og:url') || undefined;
  if (!title && !coverRaw && !intro) return null;
  return {
    title: (title ?? '').trim(),
    author: author?.trim() || null,
    url,
    coverUrl: coverRaw ? absUrl(coverRaw) : undefined,
    intro: intro?.trim() || undefined,
    category: category?.trim() || undefined,
    tags: tags?.length ? tags : undefined,
    site,
  };
}

/**
 * 书旗详情页（`/book/{id}.html`，服务端渲染、普通 HTTP 就够）。
 * 实测选择器：封面是 `<img src=... class="cover">`，作者是「作者：<a href="/author/…">」，
 * 简介在 `class="bookDesc"`，标签在 `class="tags clear"` 一串 `/label?label=` 链接。
 */
function parseShuqiDetail(html: string, url: string): Candidate | null {
  // 标题在 <title>：《斗破苍穹》最新章节免费阅读_天蚕土豆_…_书旗小说
  const title = /<title>[^《]*《([^》]+)》/.exec(html)?.[1]?.trim() ?? null;
  const author =
    /作者：?\s*<a[^>]*href="\/author\/[^"]*"[^>]*>([^<]+)</.exec(html)?.[1]
    ?? /作者：?\s*<a[^>]*>([^<]+)</.exec(html)?.[1]
    ?? null;
  // 封面 img 的 src 在 class 前面，所以先圈整颗 img 再取 src
  const cover =
    /<img[^>]*class="cover"[^>]*>/.exec(html)?.[0]?.match(/src=["']([^"']+)["']/)?.[1]
    ?? /(https?:\/\/img-tailor\.11222\.cn\/[^"'\s]+\.(?:jpg|jpeg|png|webp))/i.exec(html)?.[1]
    ?? null;
  const introRaw = /class="bookDesc"[^>]*>([\s\S]*?)<\/(?:p|div)>/.exec(html)?.[1];
  const intro = introRaw ? cleanText(introRaw) : null;
  const tagBlock = /class="tags[^"]*clear"[\s\S]*?<\/(?:ul|div|p)>/.exec(html)?.[0] ?? '';
  const tags = [...tagBlock.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => cleanText(m[1])).filter(Boolean).slice(0, 12);
  if (!title && !cover && !intro) return null;
  return {
    title: title ?? '',
    author: author?.trim() || null,
    coverUrl: cover ? absUrl(cover) : undefined,
    intro: intro || undefined,
    tags: tags.length ? tags : undefined,
    url,
    site: 'shuqi',
  };
}

/**
 * 豆瓣图书详情页（`book.douban.com/subject/{id}/`，出版书）。
 * 普通 HTTP 时通时不通（反爬），隐藏窗口更稳；解析本身是纯字符串。
 * 书名在 `v:itemreviewed`、封面有 og:image、作者在 `#info`、简介是第一个有正文的 `.intro`。
 */
function parseDoubanDetail(html: string, url: string): Candidate | null {
  const title =
    /property="v:itemreviewed"[^>]*>([^<]+)</.exec(html)?.[1]?.trim()
    ?? metaContent(html, 'og:title');
  const cover = metaContent(html, 'og:image');
  // #info 剥标签后形如「作者 : [法] 圣埃克苏佩里 译者 : 马振骋 出版社: …」。
  // 去 [国籍]，多个作者（/ 分隔）取第一个，截到下一个字段标签。
  const infoText = cleanText(/id="info"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '');
  let author: string | null = null;
  // 冒号前后都可能有空白（真实页是「作者</span>: 」，剥标签后冒号贴脸；留余量）
  const am = /作者\s*[：:]\s*([\s\S]*?)(?:\s+(?:译者|出版社|出版年|ISBN|页数|装帧|定价|原作名|副标题|丛书)\s*[：:]|$)/.exec(infoText);
  if (am) {
    author = am[1].replace(/\[[^\]]*\]/g, '').split(/[/／]/)[0].trim() || null;
  }
  // 页面里有好几个 .intro：书的简介、作者简介、还有空块——取第一个有正文的
  let intro: string | null = null;
  for (const m of html.matchAll(/class="intro"[^>]*>([\s\S]*?)<\/div>/g)) {
    const t = cleanText(m[1]);
    if (t.length >= 20) { intro = t; break; }
  }
  if (!title && !cover && !intro) return null;
  return {
    title: (title ?? '').trim(),
    author,
    coverUrl: cover ? absUrl(cover) : undefined,
    intro: intro || undefined,
    url,
    site: 'douban',
  };
}

/** 详情页 HTML 在手 → 这本书的候选信息。认识的站走专属解析，陌生站也试一把通用 og */
export function detailCandidateFromHtml(url: string, html: string): Candidate | null {
  const adapter = adapterForUrl(url);
  const site = adapter?.id ?? hostOf(url);
  const cand = adapter?.parseDetail?.(html, url) ?? parseOpenGraph(html, site);
  if (!cand) return null;
  // url 以用户粘的为准（那就是他指的这一页）；site 没认出来也落个域名
  return { ...cand, url, site: cand.site || site };
}

function hostOf(url: string): string {
  try {
    return new URL(url.startsWith('//') ? `https:${url}` : url).hostname.replace(/^www\./, '');
  } catch {
    return 'web';
  }
}

// ── 匹配 ────────────────────────────────────────────────────────

/**
 * 书名的变体：整串、括号外、括号内。
 * 库里 171 本是《国产英雄(我的邻居是女妖)》这种带别名的，整串跟谁都不相等。
 */
function titleVariants(title: string): string[] {
  const m = /^(.*?)[（(]([^）)]+)[）)]\s*$/.exec(title.trim());
  return m ? [title, m[1].trim(), m[2].trim()].filter(Boolean) : [title];
}

/**
 * 在候选里找**精确**匹配。首条几乎总是错书（实测：搜「官仙」首条是
 * 《重置世界》），所以这里遍历全部候选找严格相等的，而不是取第一条。
 * 判据沿用 isExactMatch：书名、作者都要一致，本地没作者直接不匹配。
 */
export function matchWithAliases(
  local: { title: string; author: string | null },
  cands: Candidate[],
): Candidate | null {
  for (const t of titleVariants(local.title)) {
    for (const c of cands) {
      if (isExactMatch({ title: t, author: local.author }, c).matched) return c;
    }
  }
  return null;
}

// ── 健康探针与校验源 ──────────────────────────────────────────

/**
 * 站点健康探针：搜一本**已知一定在起点**的书，看返回里有没有它。
 *
 * 存在的理由是踩出来的：限流时起点不一定返回空搜索页，也可能返回**有候选但
 * 一本都不对**的页面。「连续 0 候选」那条守卫看不见这种形状，实测一口气把
 * **186 本**写成了假的「没匹配上」（同一批书事后重试 4/5 都能中）。
 *
 * 而这两次断崖我都是靠同一个手法分辨出来的：**拿几本已知能成功的书当对照组重跑**。
 * 对照组还成功 → 站点没坏，那些 nomatch 是真的；对照组也失败 → 是限流。
 * 这里就是把那个手法固化成产品逻辑，别再靠人半夜去看曲线。
 *
 * 选《武炼巅峰》：起点自家的头部作品，不会下架，`verify-cover-fetch.mjs`
 * 里也拿它当已知命中样本。
 */
export const HEALTH_PROBE = { title: '武炼巅峰', author: '莫默' };

/** 探针返回的页面里有没有那本书。**只认精确书名**，模糊相关不算站点是好的 */
export function probeSaysHealthy(html: string): boolean {
  return (qidianAdapter.parseCandidates?.(html) ?? []).some((c) => c.title.trim() === HEALTH_PROBE.title);
}

/**
 * 「校验源」用的样本：每个源一本**已知它一定有**的书。
 *
 * 这是照着 legado 的「校验书源」搬的——它拿一个固定关键词把每个源跑一遍，
 * 分「域名失效 / 搜索失效 / js 失效」打标签。**源必然会坏**（改版、限流、下架），
 * 而坏了在我们这儿的表现是「命中率悄悄往下掉」，不主动查根本发现不了。
 *
 * 每本都是实测选的：《武炼巅峰》起点自家头部作品；《斗破苍穹》书旗有；
 * 《幽灵客栈》蔡骏是出版书，正是豆瓣的强项（实测走豆瓣命中过）。
 */
export const SOURCE_PROBES = [
  { site: 'qidian', label: SITE_LABELS.qidian, title: HEALTH_PROBE.title, needsBrowser: true },
  { site: 'shuqi', label: SITE_LABELS.shuqi, title: '斗破苍穹', needsBrowser: false },
  { site: 'douban', label: SITE_LABELS.douban, title: '幽灵客栈', needsBrowser: false },
] as const;

// ── 适配器单例 ──────────────────────────────────────────────────────

// 提取起点 li 块里的连载状态；找不到返回 null
function qidianSerialFromBlock(block: string): SerialState | null {
  const m = /<p class="author"[\s\S]*?<span>\s*(连载|完结|完本)\s*<\/span>/.exec(block);
  if (!m) return null;
  return m[1] === '连载' ? 'ongoing' : 'finished';
}

// 在搜索结果 HTML 里找命中的 li 块；优先按 bid，bid 为空/没中再按书名（含别名）
function qidianFindBlock(html: string, bid: string | null, bookTitle: string): string | null {
  const blocks = [...html.matchAll(/<li[^>]*class="res-book-item[^"]*"[\s\S]*?<\/li>/g)].map((m) => m[0]);
  if (!blocks.length) return null;

  if (bid) {
    // bid 上游已由 \d+ 保证纯数字，直接字串匹配，别在循环里建正则
    const byBid = blocks.find((b) => b.includes(`data-bid="${bid}"`));
    if (byBid) return byBid;
  }

  // 别名口径同封面链 matchWithAliases：本地书名带括号别名时，括号内外都试
  // （parseSerial 入参只有 bookTitle 字符串，所以在这儿拆，不走 enrich 的 book 形状）
  const nameVariants = titleVariants(bookTitle).map(normalizeForMatch);

  for (const block of blocks) {
    // title 属性带「在线阅读」后缀，锚文本内是纯书名，两种都试
    const titleAttr = /<h3[^>]*>[\s\S]*?<a[^>]*title="([^"]*)"[\s\S]*?<\/a>/.exec(block)?.[1] ?? '';
    const innerText = stripTags(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '');
    const candidates = [
      innerText,
      titleAttr.replace(/在线阅读$/, ''),
    ].map(normalizeForMatch);
    if (candidates.some((c) => nameVariants.some((n) => n === c))) {
      return block;
    }
  }
  return null;
}

/** 起点：普通 HTTP 是 202 空响应，必须隐藏窗口（实测 209 字节）
 *
 *  更新检查也走搜索页、不碰详情页——搜索结果的 li 块里同时有「连载/完结」
 *  和「最新更新」两个信息，一次请求就够，详情页还要多一跳，没有额外收益。
 */
export const qidianAdapter: SiteAdapter = {
  id: 'qidian', label: SITE_LABELS.qidian, needsBrowser: true, coverSearch: true,
  searchUrl: (t) => `https://www.qidian.com/so/${encodeURIComponent(t)}.html`,
  parseCandidates: parseQidianCandidates,
  // 详情页关键信息全在服务端直出的 og:novel:* 里（书名/作者/封面/简介/分类），
  // 隐藏窗口渲染后通用解析即可（url 用不上，detailCandidateFromHtml 会补上）
  parseDetail: (html) => parseOpenGraph(html, 'qidian'),
  parseSerial(html, bookTitle) {
    const block = qidianFindBlock(html, null, bookTitle);
    return block ? qidianSerialFromBlock(block) : null;
  },
  latestRequest(book) {
    return { url: qidianAdapter.searchUrl!(book.title), needsBrowser: true };
  },
  parseLatest(body, book) {
    // 优先按 data-bid 匹配（book.url 形如 https://www.qidian.com/book/{bid}/）
    const bid = /qidian\.com\/book\/(\d+)\//.exec(book.url)?.[1] ?? null;
    const block = qidianFindBlock(body, bid, book.title);
    if (!block) return null;

    const updateRaw = /<p class="update"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '';
    const updateText = stripTags(updateRaw);
    const latest = updateText.replace(/^最新更新\s*/, '').trim();
    if (!latest) return null;

    const serial = qidianSerialFromBlock(block) ?? undefined;
    return { latest: latest.slice(0, 120), ...(serial ? { serial } : {}) };
  },
};

/** 书旗：服务端渲染，普通 HTTP 就够；起点判 nomatch 的书里它能补回近一半（实测 19/40） */
export const shuqiAdapter: SiteAdapter = {
  id: 'shuqi', label: SITE_LABELS.shuqi, needsBrowser: false, coverSearch: true,
  searchUrl: (t) => `https://www.shuqi.com/search?keyword=${encodeURIComponent(t)}`,
  parseCandidates: parseShuqiCandidates,
  // 书旗详情页没有 og 标签，用专属解析（封面 class="cover"、简介 bookDesc、作者 /author/ 链接）
  parseDetail: parseShuqiDetail,
  /** 状态字在 matchbook（精确匹配）块里；只截这块，免得吃到下面相关结果 */
  parseSerial(html) {
    const block = /class="matchbook"[\s\S]*?(?=class="searchlist-main"|$)/.exec(html)?.[0];
    if (!block) return null;
    if (/连载中/.test(block)) return 'ongoing';
    if (/完结|完本|已完结/.test(block)) return 'finished';
    return null;
  },
  /** 详情页 /book/{id}.html → 目录页 /chapter?bid={id} */
  latestRequest({ url }) {
    const id = /shuqi\.com\/book\/(\d+)\.html/.exec(url)?.[1];
    if (!id) return null;
    return { url: `https://www.shuqi.com/chapter?bid=${id}`, needsBrowser: false };
  },
  parseLatest(body) {
    // 目录页整页服务端渲染，最后一个 reader 链接就是最新章；
    // 锚文本后面可能挂着 <em class="vip">VIP</em>，整段去掉再剥标签。
    // ⚠️ href 里的 & 在真实 HTML 属性中是实体 `&amp;cid=`——裸 `&cid=` 只在
    // 宽容页面/测试 fixture 里出现，两种都要认（真站验证才抓到这条，fixture 照不出来）
    const links = [...body.matchAll(/<a[^>]*href="[^"]*\/reader\?bid=\d+(?:&amp;|&)cid=\d+"[^>]*>([\s\S]*?)<\/a>/g)];
    const last = links[links.length - 1]?.[1];
    // 章名后面挂着 VIP 标记——真实页面是 `<i class="vip-tag">VIP</i>`（还裹着换行），
    // 别硬编码标签形状：剥光标签后把尾部那个 VIP 记号去掉就行
    const title = last ? stripTags(last).replace(/\s*VIP\s*$/, '').trim() : '';
    return title ? { latest: title.slice(0, 120) } : null;
  },
};

const ZONGHENG_SEARCH = 'https://search.zongheng.com/search/book?keyword={q}';

/** 纵横：搜索是 JSON 接口、普通 HTTP 可用。**不进封面链**——实测它有的书书旗全有，
 *  补封面边际为 0；它的价值在更新检查（一个请求同时给连载状态和最新章）。
 *
 *  ⚠️ 搜索相关性是模糊的（实测搜《武炼巅峰》首条是简介里提到这四个字的另一本），
 *  必须书名+作者都精确相等才认；而且命中字段里裹着 `<font color="RED">…</font>`
 *  高亮标签，匹配前和存章名前都要剥。 */
export const zonghengAdapter: SiteAdapter = {
  id: 'zongheng', label: SITE_LABELS.zongheng, needsBrowser: false, coverSearch: false,
  // 详情页是服务端渲染、带 og 标签，通用解析即可
  parseDetail: (html) => parseOpenGraph(html, 'zongheng'),
  /** 详情页没有直接可用的最新章接口；搜索接口一个请求同时给状态和末章，所以直接搜 */
  latestRequest({ title }) {
    return { url: ZONGHENG_SEARCH.replace('{q}', encodeURIComponent(title)), needsBrowser: false };
  },
  parseLatest(body, book) {
    let data: { data?: { datas?: { list?: Array<Record<string, unknown>> } } };
    try {
      data = JSON.parse(body);
    } catch {
      return null;
    }
    const list = data.data?.datas?.list;
    if (!Array.isArray(list)) return null;
    if (!book.author) return null;
    // ⚠️ 书名/作者/章名里都可能裹着 <font color="RED">…</font> 高亮标签
    // （实测《剑来》命中书名就是 <font color="RED">剑来</font>），
    // 匹配前必须先剥，normalizeForMatch 只管全角/书名号/空白，不管 HTML 标签
    const hit = list.find((x) => {
      const name = stripTags(String(x.name ?? ''));
      const author = stripTags(String(x.authorName ?? ''));
      return normalizeForMatch(name) === normalizeForMatch(book.title)
        && normalizeForMatch(author) === normalizeForMatch(book.author!);
    });
    const rawChapter = String(hit?.chapterName ?? '');
    const chapterName = stripTags(rawChapter);
    if (!hit || !chapterName.trim()) return null;
    const serial: SerialState | undefined =
      hit.serialStatus === 0 ? 'ongoing' : hit.serialStatus === 1 ? 'finished' : undefined;
    return { latest: chapterName.trim().slice(0, 120), ...(serial ? { serial } : {}) };
  },
};

/** 番茄：目录接口普通 HTTP 直接通，不需要隐藏窗口。
 *
 *  注意两点：
 *  1. 解析前先 stripTags——隐藏窗口导航到 API URL 时 Chromium 会把 JSON
 *     包在 `<html><body><pre>...</pre></body></html>` 里，普通 fetch 是裸 JSON，
 *     stripTags 两种形态都能兼容。
 *  2. 该接口没有连载状态字段，不提供 parseSerial，也绝不从标题猜「完本」
 *     ——靠标题里有没有「大结局」来猜完本，翻车率极高。
 *  不进封面链（coverSearch: false）：番茄不提供搜索页，没法按书名找封面。
 */
export const fanqieAdapter: SiteAdapter = {
  id: 'fanqie', label: SITE_LABELS.fanqie, needsBrowser: false, coverSearch: false,
  // 详情页没有 og 标签：shell 是服务端直出，书目在 __INITIAL_STATE__ 和固定 class 里
  parseDetail: parseFanqieDetail,
  latestRequest({ url }) {
    // book.url 形如 https://fanqienovel.com/page/{bookId}
    const id = /fanqienovel\.com\/page\/(\d+)/.exec(url)?.[1];
    if (!id) return null;
    return {
      url: `https://fanqienovel.com/api/reader/directory/detail?bookId=${id}`,
      needsBrowser: false,
    };
  },
  parseLatest(body) {
    // 先剥 HTML 标签，兼容隐藏窗口导航时包的 <pre>（见上）
    const raw = stripTags(body);
    let data: { data?: { chapterListWithVolume?: unknown } };
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    const vols = data.data?.chapterListWithVolume;
    // 按卷分组的二维数组，末卷末项的 title 就是最新章
    if (!Array.isArray(vols) || !vols.length) return null;
    const lastVol = vols[vols.length - 1];
    if (!Array.isArray(lastVol) || !lastVol.length) return null;
    const last = lastVol[lastVol.length - 1];
    const title = (last as { title?: string })?.title;
    if (!title || typeof title !== 'string') return null;
    return { latest: title.slice(0, 120) };
  },
};

/** 豆瓣：出版书，没有章节/连载信息，只用于封面简介 */
export const doubanAdapter: SiteAdapter = {
  id: 'douban', label: SITE_LABELS.douban, needsBrowser: false, coverSearch: true,
  searchUrl: (t) => `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(t)}`,
  parseCandidates: parseDoubanCandidates,
  parseDetail: parseDoubanDetail,
};

/**
 * 番茄详情页（`fanqienovel.com/page/{bookId}`）：**没有 og 标签**——通用 og 兜底
 * 只能拿到 `<meta name=description>` 那段「番茄小说提供…精彩小说尽在番茄」SEO
 * 广告文案，书名作者封面全空。好在 shell 是服务端直出（普通 HTTP 200，近 200KB）：
 * 书目在 `__INITIAL_STATE__.page` JSON（`bookName`/`author`）和几个固定 class 里
 * （封面 `book-cover-img`、简介 `page-abstract-content`）。
 */
function parseFanqieDetail(html: string, url: string): Candidate | null {
  // 只在 "page":{…} 这一段里取，免得命中别处的同名字段
  const pageState = /"page":\{([\s\S]{0,8000}?)"(?:search|rank)":/.exec(html)?.[1] ?? '';
  const jsonField = (key: string): string | null => {
    const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(pageState)?.[1];
    if (m == null) return null;
    try { return JSON.parse(`"${m}"`); } catch { return m; }
  };
  const title =
    jsonField('bookName')
    ?? /<title>([^_<]+?)(?:完整版)?在线免费阅读/.exec(html)?.[1]?.trim()
    ?? '';
  const author =
    jsonField('author')
    ?? (stripTags(/class="author-name-text"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1] ?? '').trim()
      || null);
  const imgTag = /<img[^>]*class="book-cover-img[^"]*"[^>]*>/.exec(html)?.[0] ?? '';
  const cover = /src=["']([^"']+)["']/.exec(imgTag)?.[1] ?? null;
  const introRaw = /class="page-abstract-content"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1];
  const intro = introRaw ? cleanText(introRaw) : null;
  if (!title && !cover && !intro) return null;
  return {
    title: title.trim(),
    author,
    coverUrl: cover ? absUrl(cover) : undefined,
    intro: intro || undefined,
    url,
    site: 'fanqie',
  };
}

/**
 * 晋江文学城详情页（`www.jjwxc.net/onebook.php?novelid=…`）。
 * ⚠️ **GBK 编码**：响应头不带 charset，meta 里写 `charset=gb18030`——抓取层
 * decodeWebPage 按声明解码，这里拿到的已经是 UTF-8。简介 `<div id="novelintro">`
 * 是**明文**：防盗字体只针对收费正文，书目信息不受影响。
 * 目录就在详情页：章节行是微数据 `<tr itemprop="chapter">`，最新章那行额外带
 * `newestChapter`；VIP 章标题也在锚文本里（`[VIP]` 标记是后面另一个锚）。
 */
function parseJjwxcDetail(html: string, url: string): Candidate | null {
  // <title>《海岛求生…》绯夷_晋江文学城_【原创小说|纯爱小说】
  const title = /<title>《([^》]+)》/.exec(html)?.[1]?.trim() ?? null;
  const author = /<title>《[^》]+》\s*([^_<]+?)_晋江/.exec(html)?.[1]?.trim() ?? null;
  const cover =
    /<img[^>]*itemprop="image"[^>]*src="([^"]+)"/.exec(html)?.[1]
    ?? /<img[^>]*src="([^"]+)"[^>]*itemprop="image"/.exec(html)?.[1]
    ?? null;
  const introRaw = /<div[^>]*id="novelintro"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
  const intro = introRaw ? cleanText(introRaw) : null;
  if (!title && !cover && !intro) return null;
  return {
    title: title ?? '',
    author,
    coverUrl: cover ? absUrl(cover) : undefined,
    intro: intro || undefined,
    url,
    site: 'jjwxc',
  };
}

export const jjwxcAdapter: SiteAdapter = {
  id: 'jjwxc', label: SITE_LABELS.jjwxc, needsBrowser: false, coverSearch: false,
  parseDetail: parseJjwxcDetail,
  /** 详情页本身就是目录页（章节行服务端直出）；onebook 之外的 URL 不处理 */
  latestRequest({ url }) {
    if (!/jjwxc\.net\/onebook\.php\?[^\s"']*novelid=\d+/.test(url)) return null;
    return { url, needsBrowser: false };
  },
  parseLatest(body) {
    // 最新章那行 <tr> 带 newestChapter；退一步取最后一个 chapter 行
    const newestRow =
      /itemprop="chapter newestChapter"[\s\S]*?<\/tr>/.exec(body)?.[0]
      ?? [...body.matchAll(/itemprop="chapter"[\s\S]*?<\/tr>/g)].pop()?.[0]
      ?? null;
    if (!newestRow) return null;
    // 第一个锚文本就是章名（VIP 章后面另挂一个 [VIP] 锚，别取它）
    const anchor = /<a itemprop="url"[^>]*>([\s\S]*?)<\/a>/.exec(newestRow)?.[1];
    const title = anchor ? stripTags(anchor).replace(/\s+/g, ' ').trim() : '';
    if (!title) return null;
    const status = /itemprop="updataStatus"[^>]*>([^<]+)</.exec(body)?.[1]?.trim();
    const serial: SerialState | undefined =
      status?.includes('连载') ? 'ongoing' : status?.includes('完结') ? 'finished' : undefined;
    return { latest: title.slice(0, 120), ...(serial ? { serial } : {}) };
  },
};

/**
 * 飞卢（b.faloo.com）：GBK（响应头带 charset=gb2312），但详情页有**全套
 * og:novel:*** 标签（book_name/author/category/image/description）——
 * 抓取层解码后通用 og 解析即可，不需要专属解析。
 */
export const falooAdapter: SiteAdapter = {
  id: 'faloo', label: SITE_LABELS.faloo, needsBrowser: false, coverSearch: false,
  parseDetail: (html) => parseOpenGraph(html, 'faloo'),
};

/**
 * 独阅读（nkwwlkj.cn）：详情页服务端直出、普通 HTTP 就够，而且**整本目录就在
 * 详情页这一页里**（实测 698 章），所以检查更新不用再跳目录页——详情页本身就是
 * 目录页，`latestRequest` 直接返回链接本身。
 *
 * 这站没有 og 标签，走专属解析；封面是懒加载（`src` 是 default.jpg 占位图，
 * 真图在 `data-original`，同起点的坑）。不进封面链（coverSearch: false）：
 * 搜索接口只收 POST，没有「按书名找书」的 GET 页，而用户粘详情页链接这条路
 * 照常能用（fetchFromUrl / fetchOne 都按适配器分发）。
 *
 * 连载状态只认页面上明写的 `tag-lianzai`（连载）；完结书的标签 class 没采到
 * 样本，不猜——`applySerialIfUnknown` 只补 unknown，保守一侧是安全的。
 */
function parseDuyueduDetail(html: string, url: string): Candidate | null {
  // 书名在 <div class="book-title"><span>…</span></div>
  const title = stripTags(
    /class="book-title"[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1] ?? '',
  ).trim();
  // 作者在 <title>：《书名》最新章节(作者),书名无弹窗全文阅读-独阅读。
  // 锚住「最新章节」再取括号，免得书名自己带括号时截错
  const author =
    /<title>[\s\S]*?最新章节\s*[（(]([^）)]+)[）)]/.exec(html)?.[1]?.trim() || null;
  // 封面 img：class="book-img lazyload"，src 是占位图、真图在 data-original
  const imgTag = /<img[^>]*class="book-img[^"]*"[^>]*>/.exec(html)?.[0] ?? '';
  const cover = /data-original="([^"]+)"/.exec(imgTag)?.[1] ?? null;
  // 简介在 <div class="book-brief"> 里的 <p class="desc">（真实页是单引号 class='desc'）
  const brief = /class="book-brief"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
  const introRaw = /class=["']desc["'][^>]*>([\s\S]*?)<\/p>/.exec(brief)?.[1];
  const intro = introRaw ? cleanText(introRaw) : null;
  if (!title && !cover && !intro) return null;
  return {
    title,
    author,
    coverUrl: cover ? absUrl(cover) : undefined,
    intro: intro || undefined,
    url,
    site: 'duyuedu',
  };
}

export const duyueduAdapter: SiteAdapter = {
  id: 'duyuedu', label: SITE_LABELS.duyuedu, needsBrowser: false, coverSearch: false,
  parseDetail: parseDuyueduDetail,
  /** 详情页本身就是目录页（整本目录服务端直出）；存的若是章节页则没有目录可解析 */
  latestRequest({ url }) {
    if (!/nkwwlkj\.cn\/book\/book_detail\/\d+/.test(url)) return null;
    return { url, needsBrowser: false };
  },
  parseLatest(body) {
    // 最后一个 book_chapter_detail 链接就是最新章；VIP 锁定章标题照样可见，
    // 只是前面多挂一枚 <i class="lock">，锚文本不受影响。
    // 「开始阅读」按钮是 window.open(...) 不是 href，不会被算进来
    const links = [
      ...body.matchAll(/<a[^>]*href="[^"]*\/chapter\/book_chapter_detail\/\d+"[^>]*>([\s\S]*?)<\/a>/g),
    ];
    const last = links[links.length - 1]?.[1];
    const title = last ? stripTags(last).replace(/\s+/g, ' ').trim() : '';
    if (!title) return null;
    const serial: SerialState | undefined = /class="tag tag-lianzai"/.test(body) ? 'ongoing' : undefined;
    return { latest: title.slice(0, 120), ...(serial ? { serial } : {}) };
  },
};

const ADAPTERS: Record<string, SiteAdapter> = {
  qidian: qidianAdapter, shuqi: shuqiAdapter, zongheng: zonghengAdapter,
  fanqie: fanqieAdapter, douban: doubanAdapter, duyuedu: duyueduAdapter,
  jjwxc: jjwxcAdapter, faloo: falooAdapter,
};

export function adapterById(id: string): SiteAdapter {
  const a = ADAPTERS[id];
  if (!a) throw new Error(`不认识的站点：${id}`);
  return a;
}

/** 按域名后缀认适配器，认不出返回 null（未知站走探活 + 用户自配正则） */
const HOST_SUFFIX: Array<[string, string]> = [
  ['qidian.com', 'qidian'],
  ['shuqi.com', 'shuqi'],
  ['zongheng.com', 'zongheng'],
  ['fanqienovel.com', 'fanqie'],
  ['douban.com', 'douban'],
  ['nkwwlkj.cn', 'duyuedu'],
  ['jjwxc.net', 'jjwxc'],
  ['faloo.com', 'faloo'],
];

export function adapterForUrl(url: string): SiteAdapter | null {
  let host: string;
  try {
    // 协议相对地址（//example.com/）没有 base 时 new URL 会抛，随便补一个 https:
    const toParse = url.startsWith('//') ? `https:${url}` : url;
    host = new URL(toParse).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  for (const [suffix, id] of HOST_SUFFIX) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return ADAPTERS[id] ?? null;
  }
  return null;
}

/**
 * 把连载状态从 `unknown` 补成页面上明写的状态。
 * **只补 unknown**：ongoing/finished/abandoned 都是用户（或之前一轮）标过的，
 * 覆盖它等于毁用户数据——同 `applyCandidate`「只补空缺」一条判据。
 */
export function applySerialIfUnknown(db: DatabaseSync, bookId: number, serial: SerialState): boolean {
  const row = db.prepare('select serial_status from book where id = ?').get(bookId) as
    | { serial_status: string }
    | undefined;
  if (!row || row.serial_status !== 'unknown') return false;
  db.prepare('update book set serial_status = ? where id = ?').run(serial, bookId);
  return true;
}

/** 搜索页 HTML 已经在手里（封面链抓的），顺手补一次连载状态，零额外请求 */
export function backfillSerial(
  db: DatabaseSync,
  bookId: number,
  adapter: SiteAdapter,
  html: string,
): SerialState | null {
  if (!adapter.parseSerial) return null;
  const row = db.prepare('select title from book where id = ?').get(bookId) as
    | { title: string }
    | undefined;
  if (!row) return null;
  const serial = adapter.parseSerial(html, row.title);
  if (!serial) return null;
  return applySerialIfUnknown(db, bookId, serial) ? serial : null;
}

