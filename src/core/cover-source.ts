// 封面抓取的纯函数部分（设计：docs/superpowers/specs/2026-08-13-covers-and-notes-design.md）。
//
// 这个文件**禁止 import electron**——提取、匹配、校验、队列都是纯函数，
// `node:test` 直接跑。唯一碰 Electron 的是 src/main/cover-fetcher.ts。

import type { DatabaseSync } from 'node:sqlite';

// ── 队列 ────────────────────────────────────────────────────────
//
// 队列就是一条 SQL，没有游标要维护：关掉应用再打开，这条查询自然接着上次的
// 位置。**没有「进度」这个状态要存，也就没有它和现实脱节的可能。**

export function nextPending(
  db: DatabaseSync,
): { id: number; title: string; author: string | null } | null {
  return (
    (db
      .prepare(
        `select b.id, b.title, b.author from book b
          left join cover_fetch cf on cf.book_id = b.id
         where b.cover_path is null and cf.book_id is null
         order by b.id limit 1`,
      )
      .get() as { id: number; title: string; author: string | null } | undefined) ?? null
  );
}

export function recordResult(
  db: DatabaseSync,
  bookId: number,
  status: 'ok' | 'nomatch' | 'failed',
  source?: string,
  error?: string,
): void {
  db.prepare(
    `insert into cover_fetch(book_id, status, source, error, tried_at)
     values(?,?,?,?,datetime('now'))
     on conflict(book_id) do update set
       status = excluded.status, source = excluded.source,
       error = excluded.error, tried_at = excluded.tried_at`,
  ).run(bookId, status, source ?? null, error ?? null);
}

export function fetchStats(db: DatabaseSync): {
  pending: number;
  done: number;
  nomatch: number;
  failed: number;
} {
  const row = db
    .prepare(
      `select
         (select count(*) from book b left join cover_fetch cf on cf.book_id = b.id
           where b.cover_path is null and cf.book_id is null) as pending,
         (select count(*) from cover_fetch where status = 'ok') as done,
         (select count(*) from cover_fetch where status = 'nomatch') as nomatch,
         (select count(*) from cover_fetch where status = 'failed') as failed`,
    )
    .get() as { pending: number; done: number; nomatch: number; failed: number };
  return { ...row };
}

/**
 * 「重试没匹配上的」：删掉 nomatch 行，队列 SQL 自然把它们重新纳入。ok 和 failed 不动。
 *
 * **不带上 failed，是因为这两个结论的可信度差着量级**（实测）：
 * `nomatch` 是问过了、站上真没有——随机抽 10 本重试，命中 **0/10**；
 * 其中《南宋第一卧底》直接开浏览器看过起点搜索页，返回的是「南宋第一密探」
 * 「南宋第一衙内」这类模糊相关，那本书根本不在起点。
 * 而 `failed` 是**没问出来**（限流、断网），下一轮就该重试。
 *
 * 捆在一起的代价是实打实的：这个库里点一次要发 167 次请求，其中 136 次注定白打——
 * 而正是这种白打的连发触发限流，制造出剩下那 31 条 failed。
 */
export function resetMisses(db: DatabaseSync): number {
  return Number(db.prepare("delete from cover_fetch where status = 'nomatch'").run().changes);
}

/**
 * failed 行清回队列。`start()` 每次叫一次——**「没问出来」不该是终态**。
 *
 * `nextPending` 只看「有没有 cover_fetch 行」，不看状态。所以限流那几分钟里
 * 被记成 failed 的书会永久停在队列外，而唯一的出路（上面那个按钮）还捆着
 * 一百多次注定白打的 nomatch 重试。
 *
 * 不会变成死循环：只在 `start()` 清，一次应用启动最多重试一轮；真的每次都抛错的书
 * 由 `MAX_CONSECUTIVE_FAILS` 那条自动暂停兜住。
 */
export function resetFailed(db: DatabaseSync): number {
  return Number(db.prepare("delete from cover_fetch where status = 'failed'").run().changes);
}

/**
 * 指定这几本回队列。探针判定「刚才那一串结论是限流下拿到的」时用——
 * 见 `HEALTH_PROBE`。空数组直接返回，不要拼出 `in ()` 那种 SQL。
 */
export function dropResults(db: DatabaseSync, bookIds: number[]): number {
  if (bookIds.length === 0) return 0;
  return Number(
    db
      .prepare(`delete from cover_fetch where book_id in (${bookIds.map(() => '?').join(',')})`)
      .run(...bookIds).changes,
  );
}

// ── 候选提取 ────────────────────────────────────────────────────────
//
// 起点必须在浏览器上下文里拿 HTML（普通 HTTP 是 202 空响应，实测 209 字节），
// 但**提取本身是纯字符串操作**，放这儿好测。豆瓣普通 HTTP 就能拿到。

import { isExactMatch, type Candidate } from './enrich.ts';

export const QIDIAN_SEARCH = 'https://www.qidian.com/so/{q}.html';
export const DOUBAN_SEARCH = 'https://search.douban.com/book/subject_search?search_text={q}';
/**
 * 书旗（阿里文学）。**普通 HTTP 就能拿到服务端渲染好的结果**，不用开隐藏窗口。
 *
 * 加它是量出来的：起点判为「没匹配上」的书里随机 40 本，书旗能精确补回 **19 本**。
 * 同一批上量过的另外三家全部出局，别再重新调研一遍：
 *   - **纵横** 补回 8 本，但**并集还是 19**——它有的书旗全都有，边际收益为 0。
 *     （它的 JSON 接口是 `search.zongheng.com/search/book?keyword=`，要用再挖出来）
 *   - **塔读** 0/30。解析器是好的（搜「盘龙」出 30 个候选），是它没有这批书。
 *   - **番茄** 抽查 0/3，连《斗破苍穹》都只有衍生作：它的库是自家原创，
 *     不含这批老网文；而且是 SPA，还得再开一个隐藏窗口。
 */
export const SHUQI_SEARCH = 'https://www.shuqi.com/search?keyword={q}';

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
  return parseQidianCandidates(html).some((c) => c.title.trim() === HEALTH_PROBE.title);
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
  { site: 'qidian', label: '起点', title: HEALTH_PROBE.title },
  { site: 'shuqi', label: '书旗', title: '斗破苍穹' },
  { site: 'douban', label: '豆瓣', title: '幽灵客栈' },
] as const;

const stripTags = (s: string) => s.replace(/<[^>]+>/g, '').trim();
/** 起点的地址都是 `//xxx` 协议相对形式，落库前补上 https: */
const absUrl = (u: string) => (u.startsWith('//') ? `https:${u}` : u);

export function parseQidianCandidates(html: string): Candidate[] {
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
export function parseShuqiCandidates(html: string): Candidate[] {
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

export function parseDoubanCandidates(html: string): Candidate[] {
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
