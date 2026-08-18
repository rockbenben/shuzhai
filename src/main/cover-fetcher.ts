// 封面抓取的 Electron 侧：隐藏窗口 + 后台循环。
// 设计：docs/superpowers/specs/2026-08-13-covers-and-notes-design.md
//
// **能放 core 的一行都不要写在这里**——这个文件测不了（BrowserWindow 起不来
// 于 node:test），提取/匹配/校验/队列全在 cover-source.ts，这里只做三件事：
// 开窗口拿 HTML、驱动循环、记结果。
//
// 安全（这是应用第一次在自己进程里运行远程页面的 JS，一条都不能省）：
//   - 独立 partition，不和应用共享任何存储
//   - nodeIntegration: false / contextIsolation: true / sandbox: true
//   - 拦掉所有弹窗；注入的脚本是写死的常量，不接受任何来自页面的代码
//   - 拿到 HTML 立即 webContents.stop()：起点是 SPA，不掐断的话页面自己的
//     脚本会一直跑到下次 loadURL（退避/暂停时可能是几十秒到无限期）
import { BrowserWindow } from 'electron';
import type { DatabaseSync } from 'node:sqlite';
import { applyCandidate } from '../core/enrich.ts';
import { getSetting, setSetting } from '../core/db.ts';
// 「人在看的时候要不要让路」的判据。放 core 是因为**这个文件 import electron，测不了**
import { uiYieldDecision } from '../core/pacing.ts';
import {
  nextPending, recordResult, fetchStats, resetMisses, resetFailed, dropResults,
  parseQidianCandidates, parseDoubanCandidates, doubanAnswered, parseShuqiCandidates, matchWithAliases,
  probeSaysHealthy, HEALTH_PROBE, SOURCE_PROBES, QIDIAN_SEARCH, DOUBAN_SEARCH, SHUQI_SEARCH,
} from '../core/cover-source.ts';
import {
  parseByRules, parseSources, type CustomSource, type SourceTest,
} from '../core/cover-custom.ts';

/**
 * 每本之间的间隔起步值。**这就是起点的实际请求速率**——每本书都要先搜一次起点，
 * 书旗和豆瓣只在它没命中时才问。
 *
 * 3 秒是拍的，而实测每跑 100–200 本就会被限流一次。所以它不是常量而是**存在库里、
 * 撞一次限流翻一倍**（`cover.gapMs`，上限 60 秒）：不知道对面的阈值就别猜，
 * 让它自己收敛到一个跑得下去的速率，而且跨重启保留——不然每次开应用都从 3 秒
 * 重新撞一遍，一晚上过去还是那几百本。
 *
 * 这条是照着 legado 的 `concurrentRate` 想的：它给**每个源**存一条限速
 * （"3/1000" = 1000 毫秒内 3 次）。我们三个源里只有起点会被限流，
 * 而它恰好是每本必问的那个，所以「每本的间隔」就是它的限速，不用再多一层。
 */
const GAP_START_MS = 3_000;
/** 退避序列。TTS 那次的教训：限流下的失败会被误读成「源不可用」，实际只是打太快 */
const BACKOFF_MS = [6_000, 12_000, 24_000];
const MAX_CONSECUTIVE_FAILS = 5;
/**
 * 起点连续这么多本一个候选都没有，就当作大概率被限流暂停——
 * 不能拿「0 候选」本身判限流：这个库里大量书本来就不在起点，
 * 单本 0 候选是常态，只有**连续一长串**都 0 候选才不正常。
 */
const EMPTY_SEARCH_LIMIT = 20;
/**
 * 连续这么多本 0 候选之后就认为是被限流了：结论不再落成 `nomatch`，
 * 而且开始放慢。比 EMPTY_SEARCH_LIMIT 小得多——**宁可慢，也别把
 * 「没匹配上」这个错结论写进库**，那是会持久化的。
 */
const EMPTY_SLOW_AT = 5;
/** 放慢的上限。再慢就等于停了，不如让 EMPTY_SEARCH_LIMIT 把它暂停掉 */
const MAX_GAP_MS = 60_000;
/**
 * 连续这么多本「没匹配上」就跑一次探针（见 `HEALTH_PROBE`）。
 *
 * 上面那两条守卫数的都是「0 候选」，而限流也可能返回**有候选但一本都不对**的页面。
 * 那种形状实测一口气写坏了 186 本，而**光看连击长度分不出真假**：队列按 id 走、
 * id 就是扫描时的字母序，同来源的书天然聚堆，真的连着几十本都不在起点也发生过。
 *
 * 12 是这么定的：真命中率约三到五成，连错 12 本的概率已经很低（≈1%），
 * 而代价只是每 12 本多发一次搜索（≈8%）。
 */
const MISS_PROBE_AT = 12;
/** 探针连着这么多次说站点不好就暂停。之前是每次都放慢重试，会一直慢慢磨 */
const MAX_BAD_PROBES = 5;
/**
 * 顺利跑了这么多本没撞限流，就把间隔减半试试。
 *
 * 有这一条是因为**只涨不落是错的**：一次偶发限流（对面在做活动、网络抖了一下）
 * 会把剩下几千本永久钉在 60 秒/本——7000 本就是 5 天。100 本是折中：
 * 60 秒/本时约 100 分钟试一次，够慢；3 秒/本时 5 分钟一次，而那时它已经在下限了。
 */
const SPEEDUP_AFTER = 100;
/** fetchOne 用完窗口后，闲置这么久没有下一次请求就把窗口拆掉，别让它白白活着 */
const IDLE_TEARDOWN_MS = 60_000;

/** stop() 打断了正在排队/飞行中的抓取——不是网络失败，调用方要能认出来别当失败记 */
class AbortedError extends Error {}

export class CoverFetcher {
  private win: BrowserWindow | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 是不是「为了让界面流畅才停的」。用户自己关的开关不能被失焦重新打开，见 setUiActive */
  private yielded = false;
  private fails = 0;
  /** 连续多少本起点搜索 0 候选，见 EMPTY_SEARCH_LIMIT */
  private emptyStreak = 0;
  /**
   * 连续「没匹配上」的那几本的 id，见 MISS_PROBE_AT。
   * **存 id 不是存计数**：探针判定这一串是限流下拿到的时候，要拿它们回队列。
   */
  private missRun: number[] = [];
  /** 探针说站点不好时挂起，下一跳先探针再取书——别拿书去试一个已知在限流的站 */
  private throttleHold = false;
  private badProbes = 0;
  /** 每本之间的间隔，见 GAP_START_MS。存库里，撞限流翻倍、顺利跑一段减半，跨重启保留 */
  private gapMs = GAP_START_MS;
  /** 连续多少本没撞限流，见 SPEEDUP_AFTER */
  private cleanRun = 0;
  private pausedReason: string | null = null;
  private db: DatabaseSync;
  private userDataDir: string;
  /** 闲置一段时间后拆窗口的定时器，见 IDLE_TEARDOWN_MS */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 隐藏窗口的访问队列。`fetchOne`（用户点「现在抓」）和后台 `tick()` 会同时
   * 想用同一个 `this.win`，不排队的话两次 `loadURL` 互相打断，先发的那次
   * `executeJavaScript` 读到的可能是后一个 URL 渲染出的页面。
   * 每次排队都挂在这条链后面，一次失败不卡住后面的任务。
   */
  private queue: Promise<void> = Promise.resolve();
  /** stop() 时自增。飞行中/排队中的任务回来发现代数变了就不碰窗口，直接放弃 */
  private generation = 0;

  // ⚠️ 不能用 TS 参数属性简写（`constructor(private db: ...)`）：
  // 主进程没有构建步骤，Node 的类型剥离是 strip-only 模式，这个语法糖不支持，
  // 会在启动时直接抛 SyntaxError（实测）。这里老老实实声明字段再赋值
  constructor(db: DatabaseSync, userDataDir: string) {
    this.db = db;
    this.userDataDir = userDataDir;
    const saved = Number(getSetting(db, 'cover.gapMs'));
    if (Number.isFinite(saved) && saved >= GAP_START_MS) this.gapMs = Math.min(saved, MAX_GAP_MS);
  }

  /**
   * 撞到限流：把间隔翻倍并落库。**不知道对面的阈值就别猜一个常量**，
   * 让它自己收敛；跨重启保留，否则每次开应用都从 3 秒重新撞一遍。
   */
  private slowDown(): void {
    this.gapMs = Math.min(this.gapMs * 2, MAX_GAP_MS);
    setSetting(this.db, 'cover.gapMs', String(this.gapMs));
  }

  /** 顺利跑了一长段就提回来一点。**只涨不落等于一次偶发限流把剩下几千本永久钉死** */
  private speedUp(): void {
    if (this.gapMs <= GAP_START_MS) return;
    this.gapMs = Math.max(Math.round(this.gapMs / 2), GAP_START_MS);
    setSetting(this.db, 'cover.gapMs', String(this.gapMs));
  }

  status() {
    return { running: this.running, pausedReason: this.pausedReason, gapMs: this.gapMs, ...fetchStats(this.db) };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fails = 0;
    this.emptyStreak = 0;
    this.missRun = [];
    this.throttleHold = false;
    this.badProbes = 0;
    this.pausedReason = null;
    // 上一轮限流留下的 failed 回队列——那不是「查过了没有」，是「没问出来」
    resetFailed(this.db);
    setSetting(this.db, 'cover.autofetch', '1');
    this.schedule(0);
  }

  stop(persist = true): void {
    this.running = false;
    if (persist) setSetting(this.db, 'cover.autofetch', '0');
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    this.teardownWindow();
  }

  retryMisses(): number {
    return resetMisses(this.db);
  }

  /**
   * 「用《斗破苍穹》试一下」：拿一条自定义源的规则真跑一次，把抽出来的候选返回。
   *
   * **和正式抓取走同一条路**（同一个 `parseByRules`、同一个加载方式）——
   * 不然会出现「试的时候好使、真抓不出来」，那是最难查的一种。
   * 写正则没有这个按钮等于盲调。
   */
  async testSource(src: CustomSource, title: string): Promise<SourceTest> {
    try {
      const html = src.needsBrowser
        ? await this.loadInHiddenWindow(src.searchUrl.replace('{q}', encodeURIComponent(title)))
        : await this.getText(src.searchUrl, title, src.name);
      const candidates = parseByRules(html, src);
      return {
        ok: candidates.length > 0,
        found: candidates.length,
        candidates: candidates.slice(0, 5),
        ...(candidates.length === 0
          ? { error: html.length < 500 ? '页面几乎是空的：这个站多半要浏览器渲染，把上面那个开关打开' : '页面拿到了，但「结果块」的正则一条都没匹配上' }
          : {}),
      };
    } catch (e) {
      return { ok: false, found: 0, candidates: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 校验三个源：各搜一本**已知它一定有**的书，报告能不能搜到。
   *
   * 照着 legado 的「校验书源」做的。**源必然会坏**（改版、限流、下架），
   * 而坏了在我们这儿只表现为「命中率悄悄往下掉」——不主动查发现不了，
   * 等发现时错误结论已经写进库几百条了（这个月踩了三次，三次形状都不一样）。
   *
   * 区分三种结果，因为它们的处理办法完全不同：
   *   - 提取不到任何候选 → 被限流，或者选择器该修了
   *   - 有候选但没有那本 → 站点在返回模糊相关，多半是限流
   *   - 抛错 → 网络或站点挂了
   */
  async checkSources(): Promise<Array<{ site: string; label: string; ok: boolean; found: number; note: string }>> {
    const out = [];
    for (const p of SOURCE_PROBES) {
      try {
        const cands = p.site === 'qidian'
          ? parseQidianCandidates(await this.loadInHiddenWindow(QIDIAN_SEARCH.replace('{q}', encodeURIComponent(p.title))))
          : p.site === 'shuqi'
            ? parseShuqiCandidates(await this.getText(SHUQI_SEARCH, p.title, p.label))
            : await (async () => {
              const html = await this.getText(DOUBAN_SEARCH, p.title, p.label);
              if (!doubanAnswered(html)) throw new Error('返回的不是搜索结果页（反爬或改版）');
              return parseDoubanCandidates(html);
            })();
        const ok = cands.some((c) => c.title.trim() === p.title);
        out.push({
          site: p.site,
          label: p.label,
          ok,
          found: cands.length,
          note: ok ? '' : cands.length === 0 ? '一个候选都提取不到：被限流，或者选择器该修了' : '有候选但没有那本：站点在返回模糊相关，多半是限流',
        });
      } catch (e) {
        out.push({ site: p.site, label: p.label, ok: false, found: 0, note: e instanceof Error ? e.message : String(e) });
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return out;
  }

  /** 应用启动时叫一次：开关开着就延迟半分钟再跑，别和启动扫描抢资源 */
  resumeIfEnabled(): void {
    if (getSetting(this.db, 'cover.autofetch') === '1') {
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null;
        if (!this.running) this.start();
      }, 30_000);
    }
  }

  /**
   * **你在用应用的时候，抓取让路。**
   *
   * 抓一张封面 = 在隐藏窗口里**真的渲染一遍起点的页面**（那个站要浏览器才出数据），
   * 和应用自己的渲染进程抢 GPU 和合成器。真实书库上实测：
   * 抓取开着时书架要 **40.8 秒**才铺出来，停掉是 **1.9 秒**，再刷一次 **0.65 秒**——
   * 慢二三十倍。而这个库还有 6778 本待抓，按 6 秒一本要跑十几个小时，
   * 也就是说这十几个小时里应用基本没法用。
   *
   * 后台回填本来就该在**没人看的时候**做。窗口一失焦就接着抓，
   * 回到窗口就停——**不动用户那个开关**（`stop(false)`），
   * 所以设置里显示的还是「开着」，事实也确实是开着，只是此刻让路。
   */
  setUiActive(active: boolean): void {
    // 判据本身在 core/pacing.ts，那里有测试守着（这个文件 import electron，测不了）
    const what = uiYieldDecision(active, this.running, this.yielded);
    if (active) {
      if (what === 'yield') {
        this.yielded = true;
        this.stop(false); // **false = 不动用户那个开关**，只是此刻让路
      }
      if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = null; }
      return;
    }
    if (what !== 'resume') return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (uiYieldDecision(false, this.running, this.yielded) === 'resume') {
        this.yielded = false;
        this.start();
      }
    }, 8_000); // 切出去 8 秒才算「真的走开了」，不然切个窗口就来回启停
  }

  /** 单本抓取。界面的「给这本抓封面」和 e2e 验证都走这条。结果和 tick() 一样落表——
   * 不落的话这次尝试对队列「隐身」，nomatch 的书下次后台队列还会再打一次几乎必败的请求 */
  async fetchOne(bookId: number): Promise<{ status: 'ok' | 'nomatch'; source?: string; applied?: string[] }> {
    const book = this.db
      .prepare('select id, title, author from book where id = ?')
      .get(bookId) as { id: number; title: string; author: string | null } | undefined;
    if (!book) throw new Error(`没有这本书：${bookId}`);
    try {
      const r = await this.tryBook(book);
      recordResult(this.db, book.id, r.status, r.source);
      return r;
    } catch (e) {
      if (e instanceof AbortedError) throw e; // 被 stop() 打断，不算一次真尝试，不落表
      const msg = e instanceof Error ? e.message : String(e);
      recordResult(this.db, book.id, 'failed', undefined, msg.slice(0, 200));
      throw e;
    }
  }

  // ── 内部 ──────────────────────────────────────────

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    // 上一跳的探针说起点在限流：先探，好了再继续取书。
    // **不能边等边抓**——那几本拿到的「没匹配上」是假的，而这个结论会持久化
    if (this.throttleHold) {
      const holdGen = this.generation;
      const healthy = await this.probeHealthy();
      if (holdGen !== this.generation) return;
      if (!healthy) {
        this.badProbes++;
        if (this.badProbes >= MAX_BAD_PROBES) {
          this.pausedReason = `起点连着 ${this.badProbes} 次搜不到已知一定在的书，多半在限流，已自动暂停`;
          this.stop(false); // 不改开关：用户重启应用后 resumeIfEnabled 会再试
          return;
        }
        this.schedule(MAX_GAP_MS);
        return;
      }
      this.throttleHold = false;
      this.badProbes = 0;
      this.emptyStreak = 0;
    }

    const book = nextPending(this.db);
    if (!book) {
      // 全跑完了。开关保持开着：下次扫进新书会接着抓
      this.running = false;
      this.teardownWindow();
      return;
    }
    // stop() 可能恰好在下面的 await 期间发生（豆瓣/下载封面都有十几秒的网络等待）。
    // 那种情况下 doLoad 内部的代数检查不一定来得及拦——它只守窗口操作，不守
    // 豆瓣 fetch/downloadCover 这些跟窗口无关的 await。这里记一份代数快照，
    // 回来发现变了就当这条链已经过期，不再记录/重排，避免 stop()+start() 撞在
    // 一起时跑出两条并行的 tick 链
    const gen = this.generation;
    try {
      const r = await this.tryBook(book);
      if (gen !== this.generation) return;

      /**
       * **起点连着好几本 0 候选时，「没匹配上」这个结论不可信。**
       *
       * 被限流时起点返回的是一个正常但空的搜索页，不是 HTTP 错误——所以走的是
       * 「没匹配上」这条路，而不是下面那个 catch。结果是在触发暂停之前，
       * 最多有 EMPTY_SEARCH_LIMIT 本书被**错误地持久化成 nomatch**。
       *
       * 实测：8172 本跑到 700 命中 / 1051 没匹配上时，命中率从早期的 82% 一路
       * 掉到 40% 并触发暂停——那是限流的曲线，不是「后面的书恰好都没有」。
       *
       * 落成 `failed` 而不是不落表：不落表的话 `nextPending` 会一直返回同一本，
       * 死循环。`failed` 的语义也更准——这不是「查过了没有」，是「没问出来」，
       * 而且「重试没匹配上的」那个按钮会连它一起清掉重来。
       */
      const throttled = r.status === 'nomatch' && this.emptyStreak >= EMPTY_SLOW_AT;

      /**
       * 上面那条只数「0 候选」，**拦不住「有候选但一本都不对」的限流**——
       * 实测那种形状一口气把 186 本写成了假的「没匹配上」（同一批事后重试 4/5 能中）。
       *
       * 连击长度本身分不出真假：队列按 id 走、id 就是扫描时的字母序，同来源的书
       * 天然聚堆，真的连着几十本都不在起点也发生过。**能分辨的只有对照组**——
       * 拿一本已知一定在的书去搜，搜不到就是站点的问题不是这些书的问题。
       */
      if (r.status === 'ok') this.missRun = [];
      else this.missRun.push(book.id);

      if (!throttled && this.missRun.length >= MISS_PROBE_AT) {
        const healthy = await this.probeHealthy();
        if (gen !== this.generation) return;
        if (healthy) {
          this.missRun = []; // 站点是好的，这一串「没匹配上」是真的，留着
        } else {
          // 这一串结论是限流下拿到的，全部回队列。当前这本落 failed 而不是不落表：
          // 不落表的话 nextPending 会一直返回同一本，死循环
          dropResults(this.db, this.missRun);
          this.missRun = [];
          this.throttleHold = true;
          this.badProbes = 1;
          this.slowDown();
          recordResult(this.db, book.id, 'failed', undefined, '起点疑似限流（探针搜不到已知一定在的书）');
          this.fails = 0;
          this.schedule(MAX_GAP_MS);
          return;
        }
      }

      if (throttled) {
        recordResult(this.db, book.id, 'failed', undefined, '起点连续空结果，可能被限流');
      } else {
        recordResult(this.db, book.id, r.status, r.source);
      }
      this.fails = 0;
      if (this.emptyStreak >= EMPTY_SEARCH_LIMIT) {
        // 起点连续一长串 0 候选：大概率是被限流而不是这些书真的都不存在，
        // 别用「没匹配上」这个假结论把剩下几千本也刷完
        this.slowDown();
        this.pausedReason = `起点连续 ${this.emptyStreak} 次没有任何候选，可能被限流，已自动暂停（下次每本间隔 ${this.gapMs / 1000} 秒）`;
        this.stop(false); // 不改开关：用户重启应用后 resumeIfEnabled 会再试
        return;
      }
      // 空结果连成串时**放慢**，给限流缓过来的机会。原来一直按 3 秒硬撞，
      // 20 本之后直接暂停——而慢下来往往能把这一轮救回来，不用等用户重开应用
      /**
       * **一段限流只翻一倍，不是每本翻一倍。**
       *
       * `throttled` 在整段限流里每本都为真（`emptyStreak` 一直 ≥ 阈值），
       * 无脑调 `slowDown()` 会在一段里翻十几次，一次就顶到 60 秒上限——
       * 那不是「收敛到跑得下去的速率」，是直接跳到最慢。所以只在**跨过阈值那一下**
       * 翻一倍。
       */
      if (throttled) {
        if (this.emptyStreak === EMPTY_SLOW_AT) this.slowDown();
        this.cleanRun = 0;
      } else if (++this.cleanRun >= SPEEDUP_AFTER) {
        // 顺利跑了这么多本，说明现在的速率是够慢的，试着提回来一点。
        // **只涨不落的话，一次偶发限流就把剩下几千本永久钉在 60 秒/本**
        this.cleanRun = 0;
        this.speedUp();
      }
      this.schedule(throttled ? MAX_GAP_MS : this.gapMs);
    } catch (e) {
      if (e instanceof AbortedError) return; // 被 stop() 打断，不算失败，不落表，不重排
      if (gen !== this.generation) return; // 过期链的失败也不该算进新链的 fails/退避
      const msg = e instanceof Error ? e.message : String(e);
      recordResult(this.db, book.id, 'failed', undefined, msg.slice(0, 200));
      this.fails++;
      if (this.fails >= MAX_CONSECUTIVE_FAILS) {
        // 连败大概率是断网或被限流——**别默默地一直撞墙**，停下来把原因摆出来
        this.pausedReason = `连续 ${this.fails} 次失败（最后一次：${msg.slice(0, 80)}），已自动暂停`;
        this.stop(false); // 不改开关：用户重启应用后 resumeIfEnabled 会再试
        return;
      }
      this.schedule(BACKOFF_MS[Math.min(this.fails - 1, BACKOFF_MS.length - 1)]);
    }
  }

  private async tryBook(book: {
    id: number; title: string; author: string | null;
  }): Promise<{ status: 'ok' | 'nomatch'; source?: string; applied?: string[] }> {
    // 起点：必须浏览器（普通 HTTP 是 202 空响应）
    const qidianHtml = await this.loadInHiddenWindow(
      QIDIAN_SEARCH.replace('{q}', encodeURIComponent(book.title)),
    );
    const qidianCandidates = parseQidianCandidates(qidianHtml);
    // 连续多少本 0 候选，交给 tick() 判断要不要暂停——见 EMPTY_SEARCH_LIMIT
    this.emptyStreak = qidianCandidates.length === 0 ? this.emptyStreak + 1 : 0;
    let hit = matchWithAliases(book, qidianCandidates);
    let source = 'qidian';

    if (!hit) {
      // 书旗：普通 HTTP 就够，起点没有的书它补得最多（实测 40 本补回 19 本）。
      // 排在豆瓣前面是因为命中率高一个量级——豆瓣只对有实体出版的书有用
      hit = matchWithAliases(
        book,
        parseShuqiCandidates(await this.getText(SHUQI_SEARCH, book.title, '书旗')),
      );
      source = 'shuqi';
    }

    /**
     * 用户自定义的源，排在内置三个之后。
     *
     * **只管封面**——阅读走本地 txt，这里只是「去哪儿找一张图」。
     * 绝不执行配置里的 JS（`cover-custom.ts` 顶上写了为什么），
     * 只认「搜索地址 + 四条正则」。一条源出错只跳过它，不影响别的源。
     */
    if (!hit) {
      for (const src of parseSources(getSetting(this.db, 'cover.customSources'))) {
        if (!src.enabled) continue;
        try {
          const html = src.needsBrowser
            ? await this.loadInHiddenWindow(src.searchUrl.replace('{q}', encodeURIComponent(book.title)))
            : await this.getText(src.searchUrl, book.title, src.name);
          hit = matchWithAliases(book, parseByRules(html, src));
          if (hit) { source = src.id; break; }
        } catch (e) {
          if (e instanceof AbortedError) throw e;
          // 自定义源是用户自己配的，坏了不该拖垮整条链——跳过它继续下一个
        }
      }
    }

    if (!hit) {
      // 豆瓣兜底：只对有实体出版的书有用（实测 10 本补 1 本）
      const html = await this.getText(DOUBAN_SEARCH, book.title, '豆瓣');
      // 反爬页是 HTTP 200，光看状态码看不出来。**没答就是没答**，不能当「没搜到」
      // ——那会把结论写进库，见 `doubanAnswered` 上面那段实测
      if (!doubanAnswered(html)) throw new Error('豆瓣返回的不是搜索结果页（反爬或改版）');
      hit = matchWithAliases(book, parseDoubanCandidates(html));
      source = 'douban';
    }

    if (!hit) return { status: 'nomatch' };
    // applyCandidate 内部会再跑一次 isExactMatch（对整串书名），别名命中的要把
    // 候选书名换成本地书名喂进去才过得了——这不是绕过校验：matchWithAliases
    // 已经做过更宽的同一套严格判定
    const r = await applyCandidate(this.db, this.userDataDir, book.id, {
      ...hit, title: book.title,
    });
    return { status: 'ok', source, applied: r.applied };
  }

  /**
   * 探针：搜一本已知一定在起点的书，搜得到才说明站点是好的。见 `HEALTH_PROBE`。
   * 加载本身出错也算不好——那同样意味着现在拿不到可信的结论。
   */
  private async probeHealthy(): Promise<boolean> {
    try {
      return probeSaysHealthy(
        await this.loadInHiddenWindow(QIDIAN_SEARCH.replace('{q}', encodeURIComponent(HEALTH_PROBE.title))),
      );
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      return false;
    }
  }

  /**
   * 普通 HTTP 拿搜索页（书旗、豆瓣都够用，不用开窗口）。
   *
   * **429/403 必须抛出去，不能悄悄当「没搜到」**——放过的话「连败自动暂停」
   * 永远不会被触发，限流会被误记成一整库的 nomatch，而那个结论是会持久化的。
   */
  private async getText(tpl: string, query: string, site: string): Promise<string> {
    const res = await fetch(tpl.replace('{q}', encodeURIComponent(query)), {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${site} HTTP ${res.status}`);
    return res.text();
  }

  /**
   * 排队去隐藏窗口加载搜索页，返回渲染后的 HTML。
   * 真正的窗口操作在 `doLoad` 里，这里只负责让同一时刻只有一个在跑。
   */
  private loadInHiddenWindow(url: string): Promise<string> {
    const gen = this.generation;
    const task = this.queue.then(() => this.doLoad(url, gen));
    // 排队链本身不能因为某一次失败就卡死——用 then(ok, ok) 把结果吸收掉，
    // 拒绝仍然通过 task 传给真正的调用方
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** 开（或复用）隐藏窗口，加载搜索页，返回渲染后的 HTML。注入的脚本是写死常量 */
  private async doLoad(url: string, gen: number): Promise<string> {
    // 排队排到一半 stop() 了：代数变了，窗口可能已经销毁，直接放弃，别去碰它
    if (gen !== this.generation) throw new AbortedError('封面抓取已停止');
    // 要复用这个窗口了：取消上一次排的闲置拆除，不然可能刚复用完就被拆掉
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }

    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        // ⚠️ **这个窗口绝不能有 `name`。** `name` 要求全局唯一、销毁之前不许复用，
        // 重名会直接抛——而这扇窗是反复建反复销的。主窗口那边靠 `name` 开
        // `windowStatePersistence`，别顺手也给它加一个（`main.ts` 有对应的一句）。
        show: false,
        webPreferences: {
          partition: 'cover-fetch', // 独立存储，不和应用共享
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
      this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      // 隔离清单漏的一条：不拦的话 Electron 默认**批准**远程内容的权限请求
      // （摄像头/麦克风/通知……），而这是个不可见窗口，用户完全看不到、也没法拒绝
      this.win.webContents.session.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    }
    // 之后一律用这个局部变量，不再读 this.win——stop() 可能在下面的 await
    // 期间把 this.win 置空，读 this.win.webContents 会直接 TypeError
    const win = this.win;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        win.loadURL(url),
        new Promise((_, rej) => {
          timeoutId = setTimeout(() => rej(new Error('搜索页加载超时（20 秒）')), 20_000);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    if (gen !== this.generation || win.isDestroyed()) throw new AbortedError('封面抓取已停止');
    // 第二个参数是 userGesture，这里不需要——传 true 等于白送页面一次用户激活
    // （下载、全屏这类操作平时靠它把关，不该被一次隐藏窗口的抓取动作绕过去）
    const html = (await win.webContents.executeJavaScript(
      'document.documentElement.outerHTML',
    )) as string;
    // 拿到手就掐断：起点是 SPA，不停的话页面自己的脚本会一直跑到下次 loadURL
    if (!win.isDestroyed()) win.webContents.stop();
    // tick() 抽干队列时会自己调 teardownWindow，这里单独兜 fetchOne 的情况：
    // 用户手动点一次「现在抓」，后台循环没开的话这个窗口不会被任何人拆掉，
    // 闲一段时间自动收掉，别让它变成永远也拆不掉的那个
    this.idleTimer = setTimeout(() => this.teardownWindow(), IDLE_TEARDOWN_MS);
    return html;
  }

  private teardownWindow(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.generation++; // 让排队中/飞行中的任务发现自己过期了，不要再碰窗口
    this.win?.destroy();
    this.win = null;
  }
}
