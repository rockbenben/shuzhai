// 在线地址管理与死链探活（spec §4）。
//
// **只管地址，不抓正文，不做在线阅读。** 这条边界是 spec §4 / §15 明确划的，
// 所以这里能做的只有两件事：确认地址还活着、看看对面更新到第几章了。
//
// 三条自我约束，都写进实现里而不是靠自觉：
//   1. **同域名串行 + 间隔 ≥ 2 秒**——并发轰一个小站是不礼貌的，也容易被封
//   2. **抓取失败不弹窗**，静默记进状态列（spec §4）。检测更新本来就是可选功能，
//      失败一次就打断用户是本末倒置
//   3. **只用正则提取**，不引 HTML 解析库。spec 写的是「CSS 选择器或正则」，
//      正则那半就够用，而 CSS 选择器要拖一个 DOM 解析器进来

import type { DatabaseSync } from 'node:sqlite';
import { adapterForUrl, applySerialIfUnknown } from './site-adapters.ts';

/** 同一域名两次请求之间至少隔这么久 */
export const DOMAIN_GAP_MS = 2000;

export interface LinkRow {
  id: number;
  book_id: number;
  url: string;
  site: string | null;
  is_primary: number;
  note: string | null;
  last_status: string | null;
  last_checked_at: string | null;
  latest_chapter_title: string | null;
  latest_checked_at: string | null;
  selector: string | null;
}

/** 从 URL 推断站点名（spec §4：自动从域名推断） */
export function siteFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * 从剪贴板粘来的一大段文本里挑出所有 URL（spec §4 的批量导入）。
 *
 * 先按空白宽松切，再**剥掉结尾的标点**——中文文本里网址后面紧跟着
 * 「，」「。」「）」是常态，把它们枚举进字符类里总会漏（漏过一次全角逗号）。
 * 反过来剥结尾更稳：真正的 URL 极少以标点收尾。
 */
const TRAILING_PUNCT = /[.,;:!?"')\]}]+$/;

/**
 * URL 里不可能出现的字符：空白、尖括号引号，以及**全角标点**。
 * 全角字符在 URL 里必须百分号编码，所以见到就是边界。
 *
 * 光靠「剥掉结尾标点」不够——`https://a.com/1，备用` 里的全角逗号在**中间**，
 * `\S+` 会一路吞到「备用」后面才停。这个坑是端到端测出来的，单元测试里
 * 逗号恰好在行尾所以蒙混过关了。
 */
const URL_STOP = '\\s<>"\'‘’“”，。；：！？、（）【】《》「」『』〈〉…—';

export function extractUrls(text: string): string[] {
  const re = new RegExp(`https?://[^${URL_STOP}]+`, 'g');
  const found = (text.match(re) ?? []).map((u) => u.replace(TRAILING_PUNCT, ''));
  return [...new Set(found.filter(Boolean))];
}

/**
 * 归一化 URL 用于去重：去碎片、host 转小写、去尾斜杠。
 * query 保留（有的站靠它区分页面）。解析不了就退回 trim 后的原文。
 */
function normalizeUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = '';
    x.hostname = x.hostname.toLowerCase();
    const s = x.toString();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch {
    return u.trim();
  }
}

export function addLink(
  db: DatabaseSync,
  bookId: number,
  url: string,
  opts: { note?: string; isPrimary?: boolean; selector?: string } = {},
): { id: number } {
  const trimmed = url.trim();
  try {
    new URL(trimmed);
  } catch {
    throw new Error(`不是合法的网址：${trimmed}`);
  }

  // 同书同归一化 URL → 幂等返回已有行，不插、不动主地址、也不补 note/selector
  // （悄悄改用户数据比重复一行更糟）
  const norm = normalizeUrl(trimmed);
  const existing = db
    .prepare('select id, url from online_link where book_id = ?')
    .all(bookId) as Array<{ id: number; url: string }>;
  for (const row of existing) {
    if (normalizeUrl(row.url) === norm) return { id: row.id };
  }

  const id = Number(
    db
      .prepare('insert into online_link(book_id, url, site, note, selector) values(?,?,?,?,?)')
      .run(bookId, trimmed, siteFromUrl(trimmed), opts.note ?? null, opts.selector ?? null)
      .lastInsertRowid,
  );
  // 第一条自动成为主地址，省得用户还要多点一下
  const count = (
    db.prepare('select count(*) n from online_link where book_id = ?').get(bookId) as { n: number }
  ).n;
  if (opts.isPrimary || count === 1) setPrimaryLink(db, id);
  return { id };
}

export function setPrimaryLink(db: DatabaseSync, id: number): void {
  const row = db.prepare('select book_id from online_link where id = ?').get(id) as
    | { book_id: number }
    | undefined;
  if (!row) throw new Error('没有这条地址');
  db.prepare('update online_link set is_primary = 0 where book_id = ?').run(row.book_id);
  db.prepare('update online_link set is_primary = 1 where id = ?').run(id);
}

/**
 * 改一条地址的「最新章提取正则」。
 * 空串/空白/null → 清除；坏正则当场抛——存的时候不挡，
 * `extractLatest` 会静默吞掉，用户就永远等不到结果。
 */
export function setLinkSelector(db: DatabaseSync, id: number, selector: string | null): void {
  const s = selector?.trim() || null;
  if (s) {
    try {
      new RegExp(s);
    } catch {
      throw new Error('提取正则无效：不是合法的正则表达式');
    }
  }
  db.prepare('update online_link set selector = ? where id = ?').run(s, id);
}

export function listLinks(db: DatabaseSync, bookId?: number): LinkRow[] {
  return (
    bookId === undefined
      ? db.prepare('select * from online_link order by book_id, is_primary desc, id').all()
      : db.prepare('select * from online_link where book_id = ? order by is_primary desc, id').all(bookId)
  ) as unknown as LinkRow[];
}

export function removeLink(db: DatabaseSync, id: number): void {
  db.prepare('delete from online_link where id = ?').run(id);
}

/** 探活/抓取用的最小 fetch 形状。测试注入假的，不打真网 */
/*
 * 探活用的**窄**接口：只要 ok / status / text 三样，方便测试塞假的。
 * **名字里带 Probe 是有意的**——`enrich.ts` 和 `webdav.ts` 里那个
 * `FetchLike` 是 `typeof globalThis.fetch`（整个 fetch），和这个不是一回事。
 * 一个名字两个所指，比两份同名的东西更容易读错（同 `Mark`／`BookmarkRow`）。
 */
export type ProbeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface CheckOptions {
  ua?: string;
  timeoutMs?: number;
  fetchImpl?: ProbeFetch;
  /** 测试里把它调成 0，不然一条链接就要等两秒 */
  gapMs?: number;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
 * HTTP 状态 → 给用户看的三档，界面按这个标色（spec §4）。
 *
 * **判据是「分得出来吗」，不是「顺不顺利」。**
 *
 * `status === null` 的意思是**根本没答上来**（断网、DNS 挂了、超时、证书错）。
 * 这里原来把它判成 `dead`——于是**离线时跑一次探活，全部链接一口气变成死链**，
 * 而那个结论会落库（`last_status`），界面上一片红。真实库里有 888 条在线地址。
 *
 * 同一个道理对 5xx 也成立：服务器那头出问题不代表这本书没了。
 * **只有 4xx 才是「这个页面真的没了」**——那是对面明确告诉我们的。
 *
 * 这条判据本仓库已经写过两遍：`webdav.ts` 的「404 才是真的没有，401/403 说是
 * 权限问题」、封面抓取那条「一个源没答，结论就不可信」。`suspect` 这一档
 * 本来就是给「说不好」用的（它原来的注释写着「可能只是反爬，不代表书没了」）。
 */
export function statusLabel(status: number | null): 'ok' | 'suspect' | 'dead' {
  if (status === null) return 'suspect'; // 没答上来：我们不知道，别替它下结论
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'ok';
  if (status === 403 || status === 429) return 'suspect'; // 可能只是反爬，不代表书没了
  if (status >= 500) return 'suspect'; // 服务器那头的毛病，多半是暂时的
  return 'dead';
}

export interface CheckReport {
  checked: number;
  ok: number;
  dead: number;
  updated: number;
}

/**
 * 批量探活 + 更新检测。
 * **同域名串行**并保证间隔；不同域名之间不互相等待。
 */
export async function checkLinks(
  db: DatabaseSync,
  links: LinkRow[],
  opts: CheckOptions = {},
): Promise<CheckReport> {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as ProbeFetch);
  const gap = opts.gapMs ?? DOMAIN_GAP_MS;
  const report: CheckReport = { checked: 0, ok: 0, dead: 0, updated: 0 };

  const byDomain = new Map<string, LinkRow[]>();
  for (const l of links) {
    const key = siteFromUrl(l.url) || 'unknown';
    const list = byDomain.get(key);
    if (list) list.push(l);
    else byDomain.set(key, [l]);
  }

  await Promise.all(
    [...byDomain.values()].map(async (group) => {
      for (const [i, link] of group.entries()) {
        if (i > 0 && gap > 0) await sleep(gap);

        let status: number | null = null;
        let body = '';

        try {
          // 有选择器就要读正文才能提取最新章节，否则 GET 也只是为了看状态码
          const res = await doFetch(link.url, {
            method: 'GET',
            headers: { 'user-agent': opts.ua ?? DEFAULT_UA },
            // `AbortSignal.timeout` 自带定时器，不用自己 new AbortController +
            // setTimeout + finally clearTimeout。仓库里另外四处（enrich / rpc /
            // cover-fetcher）本来就是这么写的，这儿是最后一处没跟上的
            signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
          });
          status = res.status;
          if (link.selector && res.ok) body = await res.text();
        } catch {
          // 静默：抓取失败不弹窗，只记进状态列（spec §4）
          status = null;
        }

        const label = statusLabel(status);
        report.checked++;
        if (label === 'ok') report.ok++;
        else if (label === 'dead') report.dead++;

        db.prepare(
          "update online_link set last_status = ?, last_checked_at = datetime('now') where id = ?",
        ).run(label, link.id);

        if (link.selector && body) {
          const title = extractLatest(body, link.selector);
          if (title) {
            db.prepare(
              "update online_link set latest_chapter_title = ?, latest_checked_at = datetime('now') where id = ?",
            ).run(title, link.id);
            report.updated++;
          }
        }
      }
    }),
  );

  return report;
}

/** 用正则从页面里提取最新章节标题。第一个捕获组就是标题；没有捕获组就取整个匹配 */
export function extractLatest(html: string, pattern: string): string | null {
  try {
    const m = new RegExp(pattern).exec(html);
    if (!m) return null;
    return (m[1] ?? m[0]).trim().slice(0, 120) || null;
  } catch {
    return null; // 用户写的正则可能是坏的，不该让整轮检测中断
  }
}

export interface UpdateHint {
  bookId: number;
  title: string;
  localLast: string | null;
  remoteLatest: string;
  /** 远端最新章标题在本地目录里找不到 → 大概率有更新 */
  hasUpdate: boolean;
}

/**
 * 「有更新」角标的判据（spec §4）：拿远端最新章标题去本地章节列表里找，
 * 找不到就认为有更新。
 *
 * **不比章节号**：网站的章节编号和本地文件的编号经常对不上（有的算楔子，
 * 有的不算），拿数字比会一直报假更新。标题匹配保守但不会骗人。
 *
 * 两个前提，缺一个都不判（否则角标假阳性）：
 *   1. **只对 ongoing 书**——完结/弃坑/未知没有「追更」语义；完结书单本手查
 *      也可能把对面的推广文案当末章写进来，那一概不亮角标（对话框里仍看得到原文）。
 *   2. **本地得有章节可比**——PDF/EPUB 在 chapter 表是 0 行、手工书连文件都没有，
 *      「本地目录里找不到」对它们永远成立，比了也是假的。
 */
export function updateHints(db: DatabaseSync): UpdateHint[] {
  const links = db
    .prepare(
      `select l.book_id as bookId, b.title, l.latest_chapter_title as remoteLatest
         from online_link l join book b on b.id = l.book_id
        where l.latest_chapter_title is not null and l.is_primary = 1
          and b.serial_status = 'ongoing'`,
    )
    .all() as unknown as Array<{ bookId: number; title: string; remoteLatest: string }>;

  return links.map((l) => {
    const localLast =
      (
        db
          .prepare(
            `select c.title from chapter c join book_file f on f.id = c.file_id
              where f.book_id = ? and f.is_primary = 1 order by c.idx desc limit 1`,
          )
          .get(l.bookId) as { title: string } | undefined
      )?.title ?? null;

    const found = db
      .prepare(
        `select 1 from chapter c join book_file f on f.id = c.file_id
          where f.book_id = ? and f.is_primary = 1 and c.title = ? limit 1`,
      )
      .get(l.bookId, l.remoteLatest);

    return {
      bookId: l.bookId,
      title: l.title,
      localLast,
      remoteLatest: l.remoteLatest,
      // 本地没有章节（PDF/EPUB/手工书）时 localLast 为 null——没法比，不算有更新
      hasUpdate: localLast !== null && !found,
    };
  });
}

// ── checkUpdates：连载更新统一检查 ────────────────────────────────────
//
// **为什么只查 ongoing**：完结/未知的书没有「追更」需求，批量全查既浪费
// 站点资源也没意义；单本手动检查（传 bookId）不受这个限制——用户可能
// 想确认一本「不知道有没有续集」的书。
//
// **三档取法**：认得出适配器走 latestRequest/parseLatest（质量最稳），
// 认不出但有 selector 走正则提取（用户自配），都没有就只探活（至少知道
// 地址还活着）。
//
// **静默失败**：网络错误是常态——反爬、改版、临时抽风都可能。检测更新是
// 锦上添花，失败一次就打断用户本末倒置，所以 catch 掉、记 suspect 就行。

export interface UpdateDeps {
  /** 普通 HTTP。status 原样返回（404 才能判 dead）；网络错误抛异常 */
  fetchText: (url: string) => Promise<{ status: number; text: string }>;
  /** 隐藏窗口渲染取正文（起点/番茄）；没注入时需要浏览器的链接跳过 */
  browserText?: (url: string) => Promise<string>;
  /** 测试里调成 0 */
  gapMs?: number;
}

export interface UpdateReport {
  checked: number;
  ok: number;
  dead: number;
  /** 抓到对面最新章标题的条数 */
  updated: number;
  /** 本批书里「远端末章本地目录找不到」的本数 */
  withUpdates: number;
}

interface UpdateTask {
  linkId: number;
  bookId: number;
  title: string;
  author: string | null;
  url: string;
  selector: string | null;
  isPrimary: number;
}

export async function checkUpdates(
  db: DatabaseSync,
  deps: UpdateDeps,
  opts: { bookId?: number } = {},
): Promise<UpdateReport> {
  const gap = deps.gapMs ?? DOMAIN_GAP_MS;
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.bookId === undefined) {
    // 批量（书架按钮/后台）：只查 ongoing 书的主链接——礼貌，也只有这些有「追更」语义
    where.push('l.is_primary = 1', "b.serial_status = 'ongoing'");
  } else {
    // 单本（对话框「检查」）：这本书的**所有**链接都查——主链接取末章+探活，
    // 其余链接纯探活。死链探测收编在这里：改造前界面走 link.check 探活所有链接，
    // 按钮换成 checkUpdates 后非主链接一度没人探（link.check 界面零调用方）
    where.push('l.book_id = ?');
    params.push(opts.bookId);
  }
  const tasks = db
    .prepare(
      `select l.id as linkId, l.book_id as bookId, b.title, b.author, l.url, l.selector,
              l.is_primary as isPrimary
         from online_link l join book b on b.id = l.book_id
        where ${where.join(' and ')}`,
    )
    .all(...params) as unknown as UpdateTask[];

  // 同域名串行 + 间隔；不同域名互不等待（同 checkLinks 的结构）
  const byDomain = new Map<string, UpdateTask[]>();
  for (const t of tasks) {
    const key = siteFromUrl(t.url) || 'unknown';
    const list = byDomain.get(key);
    if (list) list.push(t);
    else byDomain.set(key, [t]);
  }

  const report: UpdateReport = { checked: 0, ok: 0, dead: 0, updated: 0, withUpdates: 0 };
  const touched = new Set<number>();

  await Promise.all(
    [...byDomain.values()].map(async (group) => {
      for (let i = 0; i < group.length; i++) {
        if (i > 0 && gap > 0) await sleep(gap);
        const t = group[i];

        let status: number | null = null;
        let latest: string | null = null;
        let serial: 'ongoing' | 'finished' | null = null;
        try {
          const adapter = adapterForUrl(t.url);
          // 只有主链接取最新章；非主链接（单本检查时带上的备用地址）只探活
          const req = t.isPrimary
            ? adapter?.latestRequest?.({ title: t.title, author: t.author, url: t.url })
            : null;
          let body = '';
          if (req) {
            if (req.needsBrowser) {
              // 起点这类站普通 HTTP 拿不到正文；没注入浏览器就跳过——不判 ok/dead、
              // 不写状态（免得污染 last_status），也不进 touched：本轮没真查它，
              // 算进 withUpdates 会报出「查了 0 本、N 本有更新」这种自相矛盾的数
              if (!deps.browserText) continue;
              body = await deps.browserText(req.url);
              status = 200;
            } else {
              const res = await deps.fetchText(req.url);
              status = res.status;
              if (res.status >= 200 && res.status < 300) body = res.text;
            }
            if (body) {
              const r = adapter?.parseLatest?.(body, { title: t.title, author: t.author, url: t.url });
              if (r) { latest = r.latest; serial = r.serial ?? null; }
            }
          } else if (t.selector && t.isPrimary) {
            const res = await deps.fetchText(t.url);
            status = res.status;
            if (res.status >= 200 && res.status < 300) latest = extractLatest(res.text, t.selector);
          } else {
            // 只探活：认不出适配器的站，或单本检查时这本书的非主链接
            const res = await deps.fetchText(t.url);
            status = res.status;
          }
        } catch {
          status = null; // 静默：后台检测失败不弹窗（spec §4）
        }

        // 走到这儿才算本轮真正查过（缺工具 continue 的不算）；withUpdates 只数主链接代表的书
        if (t.isPrimary) touched.add(t.bookId);

        const label = statusLabel(status);
        report.checked++;
        if (label === 'ok') report.ok++;
        else if (label === 'dead') report.dead++;

        db.prepare(
          "update online_link set last_status = ?, last_checked_at = datetime('now') where id = ?",
        ).run(label, t.linkId);
        if (latest) {
          db.prepare(
            "update online_link set latest_chapter_title = ?, latest_checked_at = datetime('now') where id = ?",
          ).run(latest, t.linkId);
          report.updated++;
        }
        // 回填连载状态只认主链接的结果
        if (serial && t.isPrimary) applySerialIfUnknown(db, t.bookId, serial);
      }
    }),
  );

  report.withUpdates = updateHints(db).filter((h) => touched.has(h.bookId) && h.hasUpdate).length;
  return report;
}
