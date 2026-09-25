// 计时格。**每格跑 3 遍取中位数，第一遍冷缓存单列。**
//
// 格子名照 `docs/lessons.md`「真实量级压过的」那张表（2026-08-22），
// 但那份旧数**只当「这一格该存在」的清单，不当阈值**——那张表自己说过它曾整体
// 过期 2–20 倍，拿虚高的数去「优化」一个早就不慢的东西，正是它删掉
// 「下次别重新量」那句话的理由。要阈值看 report.mjs 的判据线。
//
// 大样本钉死具体的书：换一本就换一个数，那张表下次对不上。
// 这四本是 2026-09-25 对着 `D:\vault\TXT\Novals` 逐个 stat 出来的最大几本。
export const BIG = {
  极品全能高手: '极品全能高手', // 52.5 MB
  踏星: '踏星',                 // 51.0 MB
  从零开始: '从零开始',         // 38.7 MB
  剑来: '剑来',                 // 36.8 MB
};

/** 旧表（2026-08-22）的数，仅对照用 */
export const 旧 = {
  list: '21 ms', counts: '33 ms', meta: '4 ms / 272 本', matchCount: '7 ms',
  idsByFilter: '8 ms', chapters: '25 ms', inBook: '27 ms',
  exportCsv: '40 ms', exportJson: '55 ms', batchTag: '首次 56 ms',
  batchStatus: '首次 296 ms', tocSearch: '714 ms', scan: '首次约 117 秒',
  inBookZero: '920 ms（另一处量的）',
  buildIndex: '68 秒 / 12046 章', fullText: '5–34 ms',
  首屏: '324 ms（冷 332）', 开书: '64 ms（冷 168）', 目录: '401 ms（TOC_WINDOW=400）',
};

/** 每格开头都 reload，所以「复位」只欠两件事：从阅读器回书架、从别的档回「全部」。 */
const 退书架 = async ({ ev }) => {
  await ev("(() => { const b=[...document.querySelectorAll('.reader-rail button')]"
    + ".find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()");
};
/** 从书架进那本大样本。**每格开头都 reload 回书架**，所以「目录」那两格必须自己先把书打开。 */
const 进那本书 = async ({ ev, 等到 }) => {
  const { setInput } = await import('../ui-check/cdp.mjs');
  await ev(setInput("document.querySelector('.search-box')", '极品全能高手'));
  await 等到("document.querySelectorAll('.book').length >= 1", '搜到那本书');
  await ev("document.querySelector('.book .book-art').click()");
  await 等到("!!document.querySelector('.reader-text')", '进阅读器');
};

const 开目录 = async ({ ev, 等到 }) => {
  await ev("(() => { const b=[...document.querySelectorAll('.reader-rail button')]"
    + ".find(x=>x.textContent.includes('目录')); if(b) b.click(); return 1; })()");
  await 等到("!!document.querySelector('.toc-head input')", '目录浮层');
};

/*
 * 回「全部」**并把视图切回封面墙——两个都要**：视图是每一档各记一份的
 * （`shelf.views`，正本在 AGENTS.md 那条），只点回「全部」的话，上一格切成的
 * 表格视图会留在那儿，于是下一格 reload 完看到的是 120 个 `tr` 而 0 张
 * `.book` 卡片，前置条件永远不成立（实测 B 组四格全卡在这句上）。
 */
const 回全部 = async ({ ev }) => {
  await ev("(() => { const n=[...document.querySelectorAll('.nav-item')]"
    + ".find(x=>x.textContent.startsWith('全部')); if(n) n.click(); return 1; })()");
  await ev("(() => { const v=[...document.querySelectorAll('.viewpick .chip')]"
    + ".find(x=>x.textContent.trim()==='封面墙'); if(v) v.click(); return 1; })()");
};

export const CELLS = [
  // ── A 组 · rpc 级 ────────────────────────────────────────────
  { g: 'A', plane: 'rpc', name: 'book.list 120 本', old: 旧.list,
    call: (rpc) => rpc('book.list', { filter: {}, limit: 120 }) },

  { g: 'A', plane: 'rpc', name: 'book.counts（侧栏计数）', old: 旧.counts,
    call: (rpc) => rpc('book.counts', {}) },

  { g: 'A', plane: 'rpc', name: 'search.meta「重生」', old: 旧.meta,
    call: (rpc) => rpc('search.meta', { query: '重生' }) },

  { g: 'A', plane: 'rpc', name: 'book.matchCount 全库', old: 旧.matchCount,
    call: (rpc) => rpc('book.matchCount', { filter: {} }) },

  { g: 'A', plane: 'rpc', name: 'book.idsByFilter 全库', old: 旧.idsByFilter,
    call: (rpc) => rpc('book.idsByFilter', { filter: {} }) },

  { g: 'A', plane: 'rpc', name: 'book.chapters 大样本那本', old: 旧.chapters,
    need: 'big', call: (rpc, big) => rpc('book.chapters', { bookId: big.极品全能高手 }) },

  /*
   * 书内搜索三格，**故意用三个不同的词**：命中在第一章、命中在最后一章、零命中。
   * 实测三者都是 ~270 ms（284 / 274 / 265），说明它对**任何不满 500 条命中的查询
   * 都扫完整本**——早停那条 `hits.length >= 500` 只对高频词生效。
   *
   * ⚠️ 这一组原来只有一格，用的词是「他抬起头」，而**那个词在这本书里根本不存在**
   * （当场查：命中 0），于是它和「零命中」那格量的是同一件事，
   * 我却拿它去和旧表的 27 ms 比、得出「每次都扫完整本」。结论碰巧对，证据是假的。
   * 验搜索这类东西要**拿索引/正文里真实存在的句子去搜**——本文件早记着这条，
   * 我在这儿又踩了一次。
   */
  { g: 'A', plane: 'rpc', name: 'search.inBook 命中在第一章', old: 旧.inBook,
    need: 'big',
    要真命中: true,
    call: (rpc, big) => rpc('search.inBook',
      { bookId: big.极品全能高手, query: '这就是夏天的第一感觉' }) },

  { g: 'A', plane: 'rpc', name: 'search.inBook 命中在最后一章', old: null,
    need: 'big',
    要真命中: true,
    call: (rpc, big) => rpc('search.inBook',
      { bookId: big.极品全能高手, query: '接下来我想休息两个月' }) },

  { g: 'A', plane: 'rpc', name: 'search.inBook 零命中（扫完整本）', old: 旧.inBookZero,
    need: 'big',
    call: (rpc, big) => rpc('search.inBook',
      { bookId: big.极品全能高手, query: 'zzqq这句话绝不会出现在书里' }) },

  // 只算首次：旧表记着「第二遍 13/10 ms 是空转，幂等操作的第二遍不是提速」。
  // 参数名对着 rpc.ts 核过：`tag.addByFilter` 收的是 **names**（:1231），不是 tagNames。
  { g: 'A', plane: 'rpc', name: '导出 CSV 全库', old: 旧.exportCsv,
    call: (rpc, big, dir) => rpc('export.meta', { dir, format: 'csv' }) },

  { g: 'A', plane: 'rpc', name: '导出 JSON 全库', old: 旧.exportJson,
    call: (rpc, big, dir) => rpc('export.meta', { dir, format: 'json' }) },

  { g: 'A', plane: 'rpc', name: '给那本大书建正文索引', old: 旧.buildIndex,
    need: 'big', repeat: 1, 改动: true,
    // 参数是 **bookIds（数组）**，rpc.ts:1695。写成 bookId 会得到一句
    // 「要指定给哪些书建索引」——报错报得清楚，比静默什么都不建好。
    call: (rpc, big) => rpc('search.buildIndex', { bookIds: [big.踏星] }) },

  // 排在上一格**之后**：旧表那格「trigram 5–34 ms」是在有索引的库上量的。
  // 能不能测**当场问 `search.indexed`**，不在表里写死——真实库那会儿是 0 行，
  // 而这一趟的上一格刚建完一本。
  { g: 'A', plane: 'rpc', name: '全文搜索 trigram', old: 旧.fullText, needsIndex: true,
    call: (rpc) => rpc('search.fullText', { query: '他抬起头' }) },

  /*
   * **标了「改动」的格子一律排在最后。** 「批量改状态」是把筛选结果（这里是全库八千本）
   * 整个改成在读——它要是跑在中间，后面每一格量的就是另一副库了，
   * 和 08-22 那张表根本不可比，而表上看不出区别（每个数都「正常」）。
   * 同「幂等操作的第二遍不是提速」是一类事：**量的对象要在量的时候才对得上。**
   */
  { g: 'A', plane: 'rpc', name: '整库批量打标签（首次）', old: 旧.batchTag, repeat: 1,
    改动: true, call: (rpc) => rpc('tag.addByFilter', { filter: {}, names: ['bench探针'] }) },

  { g: 'A', plane: 'rpc', name: '整库批量改状态（首次）', old: 旧.batchStatus, repeat: 1,
    改动: true,
    call: (rpc) => rpc('reading.setStatusByFilter', { filter: {}, status: 'reading' }) },

  /*
   * 这一格量的是**文件没变时重扫一遍**（快照之后没人动过那 8188 个文件）。
   * 旧表那格写的是「首次约 117 秒，第二次几秒（系统缓存）」——所以 1.8 秒
   * **不是 65 倍提速**，是同一句里「第二次」那一半。名字里不写清这一条，
   * 表就会骗人（本文件开头讲的那类事）。
   */
  { g: 'A', plane: 'rpc', name: '增量扫描全库（文件无变更）', old: 旧.scan, repeat: 1, 改动: true,
    call: (rpc) => rpc('library.scan', {}) },
  // ── A 组 · 界面级（选择器逐条抄自 scripts/ui-check/audit.mjs 的 SURFACES，
  //    那是这个仓库里唯一长期维护它们的地方；漂了格子会抛「等不到」而不是假通过）──
  { g: 'A', plane: 'ui', name: '首屏铺 120 张卡', old: 旧.首屏,
    // 从 reload 起表：这一格被测的就是「铺出首屏」这件事本身
    sinceReload: true,
    wait: "document.querySelectorAll('.book').length >= 120" },

  { g: 'A', plane: 'ui', name: '打开大样本那本（进阅读器）', old: 旧.开书,
    need: 'big',
    // 先按书名筛再点那一张：书架默认只铺 120 张，大样本不一定在里面。
    // 输入框是 React 受控的，必须走 setInput（拿元素自己原型上的 setter）。
    open: 进那本书,
    wait: "!!document.querySelector('.reader-text')",
    close: 退书架 },

  { g: 'A', plane: 'ui', name: '那本书的目录铺 400 条', old: 旧.目录,
    need: 'big',
    open: async (a) => { await 进那本书(a); await 开目录(a); },
    wait: "document.querySelectorAll('.toc-item').length >= 100",
    close: 退书架 },

  // 旧表这格 714 ms。**它是渲染进程里筛一个已有数组，一次 rpc 都不发**
  // （`book.chapters` 没有 query 参数），所以只能按界面级量。
  { g: 'A', plane: 'ui', name: '目录内搜章节（一万二千条里筛）', old: 旧.tocSearch,
    need: 'big',
    open: async (a) => {
      const { ev } = a;
      await 进那本书(a); await 开目录(a);
      const { setInput } = await import('../ui-check/cdp.mjs');
      await ev(setInput("document.querySelector('.toc-head input')", '第三'));
    },
    wait: "document.querySelectorAll('.toc-item').length >= 1",
    close: 退书架 },

  // ── B 组 · 08-22 之后长出来的，从来没有基线 ──────────────────
  { g: 'B', plane: 'ui', name: 'ReviewTable 八千行表格', old: null,
    note: '09-21',
    open: async ({ ev }) => {
      await ev("(() => { const n=[...document.querySelectorAll('.nav-item')]"
        + ".find(x=>x.textContent.startsWith('我的书评')); if(n) n.click(); return 1; })()");
      await ev("(() => { const v=[...document.querySelectorAll('.viewpick .chip')]"
        + ".find(x=>x.textContent.trim()==='表格'); if(v) v.click(); return 1; })()");
    },
    wait: "document.querySelectorAll('.booktable tbody tr').length > 100",
    close: 回全部 },

  { g: 'B', plane: 'ui', name: 'ReviewShelf 书评册按月归组', old: null,
    note: '09-21',
    open: async ({ ev }) => {
      await ev("(() => { const n=[...document.querySelectorAll('.nav-item')]"
        + ".find(x=>x.textContent.startsWith('我的书评')); if(n) n.click(); return 1; })()");
      await ev("(() => { const v=[...document.querySelectorAll('.viewpick .chip')]"
        + ".find(x=>x.textContent.trim()==='书评册'); if(v) v.click(); return 1; })()");
    },
    wait: "document.querySelectorAll('.rv').length > 20",
    close: 回全部 },

  { g: 'B', plane: 'rpc', name: 'highlight.notes 全库（合成夹具）', old: null,
    note: '真实库 0 条划线，这一格是第一次真量',
    call: (rpc) => rpc('highlight.notes', {}) },

  { g: 'B', plane: 'ui', name: '全库笔记那一档铺开 300 行', old: '0.7 秒（那次是造的数）',
    note: '窗口化判据：一次先铺 300 行',
    open: async ({ ev }) => {
      await ev("(() => { const b=[...document.querySelectorAll('.nav-tool')]"
        + ".find(x=>x.textContent.trim()==='我的笔记'); if(b) b.click(); return 1; })()");
    },
    wait: "document.querySelectorAll('.modal .card').length >= 300",
    close: async ({ ev }) => { await ev("document.querySelector('.modal .close, .modal button')?.click()"); } },

  { g: 'B', plane: 'rpc', name: 'BookEditor 开一次（forBook + tag.list）', old: null,
    note: '归类/标签那排 09-21 才接上界面入口',
    need: 'big',
    call: async (rpc, big) => {
      const a = await rpc('shelf.forBook', { bookId: big.极品全能高手 });
      const b = await rpc('tag.list', {});
      return { ms: a.ms + b.ms, r: [a.r, b.r] };
    } },

  { g: 'B', plane: 'ui', name: '封面墙 120 张占位封面生成', old: null,
    note: '九成的卡没有真封面，走 cover-art（当场数走 book.formatCounts）',
    open: async ({ ev }) => {
      await ev("(() => { const v=[...document.querySelectorAll('.viewpick .chip')]"
        + ".find(x=>x.textContent.trim()==='封面墙'); if(v) v.click(); return 1; })()");
    },
    /*
     * 判据是「铺出了占位封面」，**不是「120 张里 100 张是占位」**：默认排序下
     * 这一屏实际 94/120（其余带真封面），原先那个 `>= 100` 是拍出来的数，当场等不到。
     * 几本没封面由排序决定，那个数会变，所以不钉死。
     */
    wait: "document.querySelectorAll('.book .cover-ph').length >= 10" },

];
