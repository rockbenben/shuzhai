# 联网补全重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「找封面」翻转为「找书的在线地址 → 读详情页 → 封面/简介/作者/分类/标签一次补全」，批量队列与单本补全收口同一条链，老库能回填一轮。

**Architecture:** `cover-fetcher.ts` 里 `fetchOne`（两段：读主地址 → 搜索）和 `tick → tryBook`（只搜索、只落封面）合并成一条 `enrichBook`：有主在线地址就读详情页（trustIdentity，成功即停）；否则搜书源链（起点→书旗→自定义→豆瓣，顺序不变），命中且候选带详情页 URL 时再读那一页，`mergeCandidates` 合并后落库。队列 SQL 从「没封面」改成「没补过」（没封面，或有链接但没简介），`start()` 里做一次性自终止回填。自定义源加可选 `urlRe`。界面文案改「联网补全」，rpc/表名不动。

**Tech Stack:** TypeScript（主进程 Node 原生剥类型，无构建步骤）、node:sqlite、node:test、React 18（渲染进程 Vite 构建）、Electron 隐藏 BrowserWindow。

**Spec:** `docs/superpowers/specs/2026-09-07-online-source-refactor-design.md`（计划随 spec 走，两个都读）

## Global Constraints

- **commit 不带任何 AI 署名**（无 Co-Authored-By / Claude-Session 等），message 只写变更内容。
- 不动 `package.json` 的 `name` 字段（它决定 `%APPDATA%\shuzhai` 数据目录）。
- 不加新依赖；不写迁移（本计划零 schema 变更）；不碰铁律数据（reading_state / bookmark / highlight / rename_log / `viewer.*` / `outline.*`）。
- 原书文件只读——本计划不碰任何磁盘文件操作逻辑。
- 测试用 `node:test`，`.ts` 直接 import（`node --test` 原生剥类型）；渲染进程 `.tsx` 测不了，逻辑放 core。
- 每个 commit 只 `git add` 该任务的文件；破坏实验还原用 `cp` 不用 `git checkout`。
- 改了 `src/core` / `src/main` 的代码后，正在跑的应用要**重启**才加载新代码。
- Windows 环境，shell 是 Git Bash；测试命令 `npm test`、`npm run typecheck`、`npm run lint:ui`、`npm run build`。

---

### Task 0: 把上一轮的适配器扩容工作单独提交

工作区里有一批已完成、已测试但未提交的改动（独阅读/晋江/飞卢适配器、`decodeWebPage`、labels、lessons），它们是上一个需求的产物。先落一笔干净提交，后续任务的 diff 才看得清。

**Files:**
- 提交：`docs/lessons.md`、`src/core/encoding.ts`、`src/core/encoding.test.ts`、`src/core/labels.ts`、`src/core/metadata.ts`、`src/core/metadata.test.ts`、`src/core/site-adapters.ts`、`src/core/site-adapters.test.ts`、`src/main/cover-fetcher.ts`、`src/renderer/BookEditor.tsx`

- [ ] **Step 1: 四道闸门全绿**

```bash
npm test && npm run typecheck && npm run lint:ui && npm run build
```

Expected: 全过。`lint:ui` 若报 stale-refs，先 `git stash` 跑一次基线确认是既有问题（指向 gitignored `tmpcheck/` 的 27 条），不是本批改动引入的。

- [ ] **Step 2: 提交**

```bash
git add docs/lessons.md src/core/encoding.ts src/core/encoding.test.ts src/core/labels.ts \
  src/core/metadata.ts src/core/metadata.test.ts src/core/site-adapters.ts \
  src/core/site-adapters.test.ts src/main/cover-fetcher.ts src/renderer/BookEditor.tsx
git commit -m "feat: 站点适配器扩容——独阅读/晋江/飞卢详情页解析，网页按声明解码（GBK）"
```

- [ ] **Step 3: 验证**

```bash
git log -1 --format="%h %s" && git status -sb
```

Expected: 提交在，工作区只剩 `?? docs/superpowers/`（spec/plan 文档，后续不进代码提交）。

---

### Task 1: `mergeCandidates` —— 详情页候选与搜索候选合并

纯函数，放 `src/core/enrich.ts`（core 才测得了）。规则：详情页字段优先，详情页没给的用搜索候选兜底（典型是封面缩略图）；`url` 用详情页自己的；tags 拼接去重。

**Files:**
- Modify: `src/core/enrich.ts`（Candidate 接口之后加函数）
- Test: `src/core/enrich.test.ts`

**Interfaces:**
- Produces: `mergeCandidates(detail: Candidate, search: Candidate): Candidate` —— Task 4 的链调用它。`Candidate` 字段：`title: string; author: string | null; url?: string; coverUrl?: string; category?: string; tags?: string[]; intro?: string; site?: string`。

- [ ] **Step 1: 写失败测试**

在 `src/core/enrich.test.ts` 的 import 里加上 `mergeCandidates`：

```ts
import {
  normalizeForMatch,
  isExactMatch,
  applyCandidate,
  downloadCover,
  searchSource,
  validateCoverBytes,
  mergeCandidates,
  type Candidate,
} from './enrich.ts';
```

文件末尾追加：

```ts
test('mergeCandidates：详情页字段优先，封面用搜索候选兜底', () => {
  const detail: Candidate = {
    title: '斗破苍穹', author: '天蚕土豆', site: 'qidian',
    intro: '这里是简介', category: '玄幻', tags: ['热血', '升级'],
    url: 'https://www.qidian.com/book/123/',
  };
  const search: Candidate = {
    title: '斗破苍穹', author: '天蚕土豆', site: 'qidian',
    coverUrl: 'https://x.com/cover.jpg',
    url: 'https://www.qidian.com/book/123/',
  };
  const m = mergeCandidates(detail, search);
  assert.equal(m.intro, '这里是简介');
  assert.equal(m.category, '玄幻');
  assert.deepEqual(m.tags, ['热血', '升级']);
  assert.equal(m.coverUrl, 'https://x.com/cover.jpg', '详情页没给图 → 用搜索结果的缩略图');
  assert.equal(m.url, 'https://www.qidian.com/book/123/');
});

test('mergeCandidates：详情页自己有封面时不用搜索的', () => {
  const m = mergeCandidates(
    { title: '甲', author: null, coverUrl: 'https://a/detail.jpg' },
    { title: '甲', author: null, coverUrl: 'https://a/thumb.jpg' },
  );
  assert.equal(m.coverUrl, 'https://a/detail.jpg');
});

test('mergeCandidates：tags 两边都有时拼接去重，保详情页顺序', () => {
  const m = mergeCandidates(
    { title: '甲', author: null, tags: ['热血', '升级'] },
    { title: '甲', author: null, tags: ['升级', '爽文'] },
  );
  assert.deepEqual(m.tags, ['热血', '升级', '爽文']);
});

test('mergeCandidates：两边都没 tags 时不产出空数组', () => {
  const m = mergeCandidates({ title: '甲', author: null }, { title: '甲', author: null });
  assert.equal(m.tags, undefined);
  assert.equal(m.intro, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

<!-- stale-refs:off -->
```bash
node --test --import ./scripts/ts-loader.mjs src/core/enrich.test.ts
```
<!-- stale-refs:on -->

（若仓库测试入口是 `npm test` 全量跑，直接 `npm test` 也可——它会红在 `mergeCandidates is not a function`。）

Expected: FAIL，`mergeCandidates` 不是函数。

- [ ] **Step 3: 实现**

在 `src/core/enrich.ts` 的 `isExactMatch` 之后加：

```ts
/**
 * 合并详情页候选和搜索候选：**详情页字段优先**，详情页没给的用搜索候选兜底
 * （典型是封面——搜索结果页有缩略图，详情页的 og:image 偶尔缺或是占位图）。
 * url 用详情页自己的地址，没有才退回搜索候选的。tags 拼接去重、保详情页顺序。
 */
export function mergeCandidates(detail: Candidate, search: Candidate): Candidate {
  const tags = [...(detail.tags ?? []), ...(search.tags ?? [])].filter(
    (t, i, arr) => arr.indexOf(t) === i,
  );
  return {
    title: detail.title || search.title,
    author: detail.author ?? search.author,
    intro: detail.intro ?? search.intro,
    category: detail.category ?? search.category,
    tags: tags.length ? tags : undefined,
    site: detail.site ?? search.site,
    coverUrl: detail.coverUrl ?? search.coverUrl,
    url: detail.url ?? search.url,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test
```

Expected: PASS（含新 4 条）。

- [ ] **Step 5: 提交**

```bash
git add src/core/enrich.ts src/core/enrich.test.ts
git commit -m "refactor(enrich): 详情页候选与搜索候选合并——详情页优先、搜索兜底封面"
```

---

### Task 2: 自定义书源加「详情页地址」正则（urlRe）

`CustomSource` 加可选 `urlRe`；`parseByRules` 抽到地址时用搜索地址的源把相对路径补全。没有 urlRe 的旧配置行为不变。

**Files:**
- Modify: `src/core/cover-custom.ts`
- Test: `src/core/cover-custom.test.ts`

**Interfaces:**
- Produces: `CustomSource.urlRe?: string`（第 1 捕获组是详情页地址）；`parseByRules` 产出的 `Candidate.url` 在配了 urlRe 且抽得到时为绝对地址字符串，否则 `undefined`。
- Consumes: `Candidate`（`src/core/enrich.ts`，已有 `url?` 字段）。

- [ ] **Step 1: 写失败测试**

`src/core/cover-custom.test.ts` 顶部 `SRC` 常量不动（它没有 urlRe，正好当旧配置回归）。文件末尾追加：

```ts
test('urlRe：抽到详情页地址，相对路径按搜索地址补全', () => {
  const html = `
<ul>
<li class="book">
  <a class="name" href="/book/123">斗破<em>苍穹</em></a>
  <span class="author">天蚕土豆</span>
</li>
</ul>`;
  const src = {
    ...SRC,
    searchUrl: 'https://example.com/search?q={q}',
    urlRe: '<a class="name"[^>]*href="([^"]+)"',
  };
  const c = parseByRules(html, src);
  assert.equal(c[0].url, 'https://example.com/book/123');
});

test('urlRe：绝对地址原样保留', () => {
  const html = `
<li class="book">
  <a class="name" href="https://other-site.com/b/9">武炼巅峰</a>
  <span class="author">莫默</span>
</li>`;
  const src = { ...SRC, urlRe: '<a class="name"[^>]*href="([^"]+)"' };
  const c = parseByRules(html, src);
  assert.equal(c[0].url, 'https://other-site.com/b/9');
});

test('旧配置没有 urlRe：候选不带 url，其余照常（不破坏老配置）', () => {
  const c = parseByRules(HTML, SRC);
  assert.equal(c.length, 2);
  assert.equal(c[0].url, undefined);
  assert.equal(c[0].coverUrl, 'https://x.com/a.jpg');
});

test('urlRe 正则坏了：这一项为空，不抛错、不影响别的字段', () => {
  const html = `<li class="book"><a class="name" href="/b/1">甲</a></li>`;
  const c = parseByRules(html, { ...SRC, urlRe: '([' });
  assert.equal(c.length, 1);
  assert.equal(c[0].url, undefined);
  assert.equal(c[0].title, '甲');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test
```

Expected: FAIL，`c[0].url` 是 `undefined`（前两条红）。

- [ ] **Step 3: 实现**

`src/core/cover-custom.ts`：

(a) 文件头注释更新（第 1-12 行那段），把「只管封面」的说法换成新定位：

```ts
// 用户自定义的书源：输入书名、输出这本书的主页地址。
//
// 命中后会再读那个详情页——封面、简介、作者、分类都从详情页出
// （搜索结果页只有书名作者和一张缩略图）。阅读不受影响，走本地 txt。
//
// **绝不执行配置里的 JS**（和 TTS 那条同一个理由，见 AGENTS.md）：
// legado 的书源规则里能写 `<js>`、`loginCheckJs`，那些文件是从别人那里拿来的。
// 这里只认「搜索地址模板 + 几条正则」，表达不了的源就别加——
// 多几个源换「跑陌生人的代码」，这笔账怎么算都不划算。
//
// 内置那三个（起点/书旗/豆瓣）仍然是代码：它们各有各的坑（起点要浏览器渲染、
// 豆瓣藏在 window.__DATA__ 的 JSON 里、书旗只收 matchbook 块），
// 硬要塞进同一套正则配置只会做出一个残缺的 DSL。
```

(b) `CustomSource` 接口里，`coverRe` 之后加 `urlRe`，并给 `coverRe` 改注释：

```ts
  titleRe: string;
  authorRe: string;
  /** 封面图地址。**可选兜底**——配了 urlRe 时简介分类都从详情页出，
   *  只有详情页没给图才用这里抽到的缩略图 */
  coverRe: string;
  /**
   * 详情页地址，第 1 个捕获组。配了它，命中后会再读这个详情页，
   * 简介/分类/标签只有详情页给得了；相对路径（/book/123）自动补成绝对地址。
   * 不配就走老路子：只拿搜索结果里的封面/作者。
   */
  urlRe?: string;
```

(c) `pick` 函数后面加补全助手：

```ts
/** 详情页地址常写成相对路径（/book/123），拿搜索地址的源补全；补不了就当没有 */
function resolveUrl(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}
```

(d) `parseByRules` 里 push 候选那段改成：

```ts
    const rawUrl = pick(b, src.urlRe ?? '');
    out.push({
      title,
      author: pick(b, src.authorRe) ?? null,
      coverUrl: pick(b, src.coverRe),
      url: rawUrl ? resolveUrl(rawUrl, src.searchUrl) : undefined,
      site: src.id,
    });
```

(e) `blankSource` 里加一行示例（`coverRe` 之后）：

```ts
    coverRe: '<img[^>]+src="([^"]+)"',
    urlRe: '<a class="name"[^>]*href="([^"]+)"',
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test
```

Expected: PASS（新 4 条 + 原有 7 条全绿）。

- [ ] **Step 5: typecheck**

```bash
npm run typecheck
```

Expected: 干净。

- [ ] **Step 6: 提交**

```bash
git add src/core/cover-custom.ts src/core/cover-custom.test.ts
git commit -m "feat(cover-custom): 自定义书源可抽详情页地址，命中后读页补全简介分类"
```

---

### Task 3: 队列改键「没补过」+ 老库一次性回填 SQL

`nextPending` / `fetchStats.pending` 的条件从「没封面」改成「没 verdict 行，且（没封面　或　没简介但有在线地址）」。新增纯 SQL 的 `resetForInfoBackfill`。

**Files:**
- Modify: `src/core/cover-source.ts`
- Test: `src/core/cover-source.test.ts`

**Interfaces:**
- Produces: `resetForInfoBackfill(db: DatabaseSync): number`（删除「有 online_link 且 intro is null」的书的 cover_fetch 行，返回删除条数）——Task 4 的 `start()` 调用。
- `nextPending` / `fetchStats` 签名不变，SQL 语义变。

- [ ] **Step 1: 写失败测试**

`src/core/cover-source.test.ts`：

(a) import 加 `addLink` 和新函数：

```ts
import {
  nextPending, recordResult, fetchStats, resetMisses, resetFailed, dropResults,
  resetForInfoBackfill,
} from './cover-source.ts';
import { addLink } from './links.ts';
```

(b) `addBook` 助手后面加一个设简介的助手：

```ts
function setIntro(id: number, intro: string | null): void {
  db.prepare('update book set intro = ? where id = ?').run(intro, id);
}
```

(c) 文件末尾追加：

```ts
test('队列：有封面但没简介、且有在线地址的书也出队（读地址补信息）', () => {
  const a = addBook('甲', '某人', 'C:/covers/a.jpg');
  addLink(db, a, 'https://www.qidian.com/book/1/');
  assert.equal(nextPending(db)!.id, a, '有链接没简介 → 该去读详情页');
});

test('队列：有封面没简介但没链接的不出队（搜不到地址就没法补）', () => {
  addBook('甲', '某人', 'C:/covers/a.jpg');
  assert.equal(nextPending(db), null);
});

test('队列：有封面有简介有链接的不出队', () => {
  const a = addBook('甲', '某人', 'C:/covers/a.jpg');
  addLink(db, a, 'https://www.qidian.com/book/1/');
  setIntro(a, '已有简介');
  assert.equal(nextPending(db), null);
});

test('队列：信息回填档的书记过 verdict 后不再出队', () => {
  const a = addBook('甲', '某人', 'C:/covers/a.jpg');
  addLink(db, a, 'https://www.qidian.com/book/1/');
  recordResult(db, a, 'ok', 'qidian');
  assert.equal(nextPending(db), null, '那一页真没简介也只试这一次');
});

test('统计的 pending 认新条件', () => {
  const a = addBook('甲', '某人', 'C:/covers/a.jpg');
  addLink(db, a, 'https://www.qidian.com/book/1/');
  addBook('乙', '某人', 'C:/covers/b.jpg'); // 有封面没链接
  assert.equal(fetchStats(db).pending, 1);
});

test('resetForInfoBackfill：只删「有链接没简介」的 verdict 行', () => {
  const a = addBook('甲', '某人', 'C:/covers/a.jpg');
  addLink(db, a, 'https://www.qidian.com/book/1/');
  recordResult(db, a, 'ok', 'qidian'); // 旧链跑的：有封面没简介

  const b = addBook('乙', '某人');
  recordResult(db, b, 'nomatch', 'qidian'); // 没链接，不该动

  const c = addBook('丙', '某人', 'C:/covers/c.jpg');
  addLink(db, c, 'https://www.qidian.com/book/3/');
  setIntro(c, '早就有简介');
  recordResult(db, c, 'ok', 'qidian'); // 有简介，不该动

  assert.equal(resetForInfoBackfill(db), 1);
  const left = db.prepare('select book_id from cover_fetch order by book_id').all().map((r) => ({ ...r }));
  assert.deepEqual(left, [{ book_id: b }, { book_id: c }]);
  assert.equal(nextPending(db)!.id, a, '删掉的书被队列捞回来走详情页那条路');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test
```

Expected: 新 6 条红（`resetForInfoBackfill is not a function`；有封面的书出不了队）。

- [ ] **Step 3: 实现**

`src/core/cover-source.ts`：

(a) `nextPending` 的 SQL 换成：

```ts
        `select b.id, b.title, b.author from book b
          left join cover_fetch cf on cf.book_id = b.id
         where cf.book_id is null
           and (b.cover_path is null
                or (b.intro is null
                    and exists (select 1 from online_link l where l.book_id = b.id)))
         order by b.id limit 1`,
```

(b) `fetchStats` 里 pending 子查询的条件同步换（原来是 `where b.cover_path is null and cf.book_id is null`）：

```ts
         (select count(*) from book b left join cover_fetch cf on cf.book_id = b.id
           where cf.book_id is null
             and (b.cover_path is null
                  or (b.intro is null
                      and exists (select 1 from online_link l where l.book_id = b.id)))) as pending,
```

(c) 文件末尾加：

```ts
/**
 * 老库一次性回填（「老配置用新流程重新补齐」）：删掉「有在线地址但没简介」的书的
 * verdict 行，让 `nextPending` 重新捞到它们、走「读已知地址补信息」那条路
 * （不搜索、不冒险，只发一次请求到已经记下的地址）。
 *
 * 只删 verdict 行，不碰任何铁律数据。**幂等由调用方的设置标记保证**
 * （`cover.infoBackfill`，在 cover-fetcher 的 start() 里）：处理完 verdict 行会
 * 重新落库、书就不再满足入队条件，所以这东西一生只跑一次，不会每次启动重打
 * 几百次请求。
 */
export function resetForInfoBackfill(db: DatabaseSync): number {
  return Number(
    db
      .prepare(
        `delete from cover_fetch where book_id in (
            select b.id from book b
             where b.intro is null
               and exists (select 1 from online_link l where l.book_id = b.id))`,
      )
      .run().changes,
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test
```

Expected: 全绿。注意原有「队列：没封面且没试过的才出队」「统计四个数对得上」等旧测试仍须绿——它们的书都没链接，新条件对它们等价于老条件。

- [ ] **Step 5: 提交**

```bash
git add src/core/cover-source.ts src/core/cover-source.test.ts
git commit -m "refactor(cover-queue): 队列从「没封面」改成「没补过」，加老库信息回填 SQL"
```

---

### Task 4: 统一链 `enrichBook` + `start()` 回填钩子

`fetchOne` 和 `tick → tryBook` 收口：新 `enrichBook`（有地址读地址、成功即停；否则搜索，命中带 URL 就读详情页、合并落库）。`tryBook` 改名 `searchAndEnrich` 并在命中后加详情页一跳。`start()` 里调一次 `resetForInfoBackfill`。

这个文件 import electron，node:test 跑不了——正确性靠它组合的各单元（Task 1-3 已测）+ typecheck + 闸门后的真机验证（Task 7）。

**Files:**
- Modify: `src/main/cover-fetcher.ts`

**Interfaces:**
- Consumes: `mergeCandidates`（Task 1，`../core/enrich.ts`）；`resetForInfoBackfill`（Task 3，`../core/cover-source.ts`）；`getSetting`/`setSetting`（已 import `../core/db.ts`）；`fetchDetailCandidate`（本文件已有 private 方法）；`applyCandidate`、`Candidate`（已 import）。
- Produces: 无新导出——类的公开方法 `fetchOne` / `start()` 签名不变。

- [ ] **Step 1: 改 import**

`src/main/cover-fetcher.ts` 顶部：

```ts
import { applyCandidate, mergeCandidates, normalizeForMatch, type Candidate } from '../core/enrich.ts';
```

（原来是 `applyCandidate, normalizeForMatch, type Candidate`——加 `mergeCandidates`。）

```ts
import {
  nextPending, recordResult, fetchStats, resetMisses, resetFailed, dropResults,
  resetForInfoBackfill,
} from '../core/cover-source.ts';
```

（加 `resetForInfoBackfill`。）

- [ ] **Step 2: `start()` 里加回填钩子**

`start()` 方法中，`resetFailed(this.db);` 那一行**之前**插入：

```ts
    // 老库一次性回填：有在线地址但没简介的书，旧 verdict 清掉让新链读一遍详情页。
    // 标记落库就不再来——处理完行会重新落回，见 resetForInfoBackfill 的注释
    if (getSetting(this.db, 'cover.infoBackfill') !== '1') {
      resetForInfoBackfill(this.db);
      setSetting(this.db, 'cover.infoBackfill', '1');
    }
    // 上一轮限流留下的 failed 回队列——那不是「查过了没有」，是「没问出来」
    resetFailed(this.db);
```

- [ ] **Step 3: 用 `enrichBook` 替换 `fetchOne` 的两段式**

把现在的 `fetchOne`（从 `async fetchOne(bookId` 到它结束的 `}`）整个替换成：

```ts
  /**
   * 单本联网补全。界面的「联网补全」和 e2e 验证都走这条；结果和 tick() 一样落表——
   * 不落的话这次尝试对队列「隐身」，没找到的书下次后台队列还会再打一次几乎必败的请求。
   * 链本身在 `enrichBook`，和后台 tick() 走的是同一条。
   */
  async fetchOne(bookId: number): Promise<{ status: 'ok' | 'nomatch'; source?: string; applied?: string[] }> {
    const book = this.db
      .prepare('select id, title, author from book where id = ?')
      .get(bookId) as { id: number; title: string; author: string | null } | undefined;
    if (!book) throw new Error(`没有这本书：${bookId}`);
    try {
      const r = await this.enrichBook(book);
      recordResult(this.db, bookId, r.status, r.source);
      return r;
    } catch (e) {
      if (e instanceof AbortedError) throw e; // 被 stop() 打断，不算一次真尝试，不落表
      const msg = e instanceof Error ? e.message : String(e);
      recordResult(this.db, bookId, 'failed', undefined, msg.slice(0, 200));
      throw e;
    }
  }
```

然后在 `fetchOne` 之后（`checkUpdates` 之前）加 `enrichBook`：

```ts
  /**
   * 一本书的联网补全，**tick() 和单本「联网补全」走的同一条链**：
   *
   *   ① 这本书有主在线地址 → 读那个详情页（trustIdentity：身份由用户存的链接
   *      负责），封面/简介/作者/分类/标签「只补空缺」。**页读成功了就停**——
   *      地址就是目标，书大部分只在一个地址出现，详情页比搜索页可信，
   *      那一页真没图也不换站搜。
   *   ② 没地址、或那页彻底没认出来（抛错/认不出）→ 搜书源链（`searchAndEnrich`）：
   *      起点→书旗→自定义→豆瓣，命中后读命中的详情页再补。
   *
   * 限流计数（emptyStreak / missRun）只挂在②的搜索段：①不搜索，不碰计数器。
   */
  private async enrichBook(book: {
    id: number; title: string; author: string | null;
  }): Promise<{ status: 'ok' | 'nomatch'; source?: string; applied?: string[] }> {
    const primary = this.db
      .prepare('select url from online_link where book_id = ? order by is_primary desc, id limit 1')
      .get(book.id) as { url: string } | undefined;
    if (primary?.url) {
      try {
        const cand = await this.fetchDetailCandidate(primary.url);
        if (cand) {
          const res = await applyCandidate(this.db, this.userDataDir, book.id, cand, { trustIdentity: true });
          return { status: 'ok', source: cand.site || undefined, applied: res.applied };
        }
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        // 反爬/改版/超时：这条路不通，安静回落书名搜索
      }
    }

    // 详情页这跳可能刚把作者补进来，而搜索匹配要求书名作者都对得上——重读这本书
    const fresh = this.db
      .prepare('select id, title, author from book where id = ?')
      .get(book.id) as { id: number; title: string; author: string | null };
    return this.searchAndEnrich(fresh);
  }
```

- [ ] **Step 4: `tick()` 调 `enrichBook`**

`tick()` 里这一行：

```ts
      const r = await this.tryBook(book);
```

改成：

```ts
      const r = await this.enrichBook(book);
```

- [ ] **Step 5: `tryBook` 改名 `searchAndEnrich` 并加详情页一跳**

把 `private async tryBook(book: {` 的方法名改成 `private async searchAndEnrich(book: {`，并替换它的方法头注释和结尾。

方法头注释（现在是「内置封面源：起点（窗口）→ 书旗（HTTP）…」那段）换成：

```ts
    // 书源链：起点（窗口）→ 书旗（HTTP）。豆瓣兜底在自定义源之后，顺序不变。
    // ⚠️ 这个数组是有意硬编码的——链顺序固定就是起点→书旗，zongheng/fanqie
    // 故意不进链（实测补不到封面）。遍历 ADAPTERS 或按 coverSearch 过滤都会让
    // 「链顺序」和「适配器表」隐式耦合，加内置源不等于自动进链。
```

自定义源那段的注释（「**只管封面**——阅读走本地 txt，这里只是「去哪儿找一张图」。」）换成：

```ts
    /**
     * 用户自定义的源，排在内置之后。输入书名、输出书的主页地址；
     * 配了 urlRe 就和内置源一样再读详情页（下面那段统一处理）。
     * 绝不执行配置里的 JS（`cover-custom.ts` 顶上写了为什么）。一条源出错只跳过它。
     */
```

方法结尾，从 `if (!hit) return { status: 'nomatch' };` 到方法结束，替换成：

```ts
    if (!hit) return { status: 'nomatch' };

    // 命中的候选带详情页地址就再读一页：简介/分类/标签只有详情页给得了，
    // 封面也优先用详情页的、搜索缩略图兜底（mergeCandidates）。
    // 读不了或认不出就直接落搜索候选——封面/作者/地址照拿，那是这条链的老行为。
    // 老自定义配置没有 urlRe → hit.url 为空，自然走这条老路，不破坏旧配置。
    let candidate: Candidate = { ...hit, title: book.title };
    if (hit.url) {
      try {
        const detail = await this.fetchDetailCandidate(hit.url);
        if (detail) candidate = { ...mergeCandidates(detail, candidate), title: book.title };
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        // 详情页这跳失败不连累搜索已拿到的东西
      }
    }

    // applyCandidate 内部会再跑一次 isExactMatch（对整串书名），别名命中的要把
    // 候选书名换成本地书名喂进去才过得了——这不是绕过校验：matchWithAliases
    // 已经做过更宽的同一套严格判定
    const r = await applyCandidate(this.db, this.userDataDir, book.id, candidate);
    return { status: 'ok', source, applied: r.applied };
```

（删掉原来的 `const r = await applyCandidate(this.db, this.userDataDir, book.id, { ...hit, title: book.title });` 那两行——被上面取代。）

- [ ] **Step 6: 确认没有残留的 `tryBook` 引用**

```bash
grep -rn "tryBook" src/ || echo "无残留"
```

Expected: 「无残留」。

- [ ] **Step 7: typecheck + 全量测试**

```bash
npm run typecheck && npm test
```

Expected: 干净、全绿。

- [ ] **Step 8: 提交**

```bash
git add src/main/cover-fetcher.ts
git commit -m "refactor(cover-fetcher): 批量与单本收口同一条链——有地址读地址、搜到读详情页"
```

---

### Task 5: 界面文案与书源对话框

只改界面文案和注释；rpc 方法名（`cover.*`）、表名、设置键一律不动。

**Files:**
- Modify: `src/renderer/Settings.tsx`（约 664-705 行的「封面」节）
- Modify: `src/renderer/BookEditor.tsx`（93、344-369、409、428 行附近）
- Modify: `src/renderer/CoverSources.tsx`

- [ ] **Step 1: Settings.tsx 文案**

- `<h3>封面</h3>` → `<h3>联网补全</h3>`
- 开关文案 `<span>批量给整库找封面（可选，默认不开）</span>` →
  `<span>批量联网找书：在线地址、封面、简介、分类一起补（可选，默认不开）</span>`
- 紧接的注释和 `warn-line`（673-687 行）换成：

```tsx
            {/* 隐私这句必须留全文：抓取会把书名和作者发出去。
                默认走「点一本补一本」（书籍编辑器里的「联网补全」），
                这里是给不想一本本点的人准备的批量任务 */}
            <p className="warn-line">
              平时用<strong>书籍编辑器里的「联网补全」</strong>，点一本补一本。
              这个开关是批量：打开后把没补过的书都跑一遍——已经记下在线地址的
              直接读那一页，没地址的按书名搜，搜到就读它的详情页，
              会把<strong>书名和作者</strong>发到搜索源去，除此之外不发任何数据。
              搜索来的东西只有书名、作者都精确一致才会用——宁可没有，不能配错。
              <br />
              {/* 这条不是客套：抓一本要在隐藏窗口里真的渲染一遍对面的页面，
                  实测能让书架从 1.9 秒变成 40 秒。让路是自动的，但得让人知道，
                  否则「开着开关却看到剩余数不动」会被当成坏了 */}
              <strong>你在用应用的时候它会自动停下来让路</strong>，切到别的窗口
              几秒后接着跑——不这样的话，补全期间整个界面会明显变慢。
            </p>
```

- 统计行 `已抓 {cover.done} · 剩余 {cover.pending} · 没匹配上 {cover.nomatch}` →
  `已补全 {cover.done} · 剩余 {cover.pending} · 没找到 {cover.nomatch}`
- 按钮文案 `重试没匹配上的 {cover.nomatch} 本` → `重试没找到的 {cover.nomatch} 本`
- 「检查三个源」按钮不变（探针确实还是起点/书旗/豆瓣三个）。
- 文件上方 67-90 行附近那段「封面抓取的状态」注释里，`封面抓取` 字样改为 `联网补全`（类型注释和 `封面操作` 注释各一处，函数名 `封面操作` 是局部标识符，可留可改——留着不动，少 diff）。

- [ ] **Step 2: BookEditor.tsx 文案**

- 按钮（368 行）：`{fetching ? '正在找…' : '联网找封面'}` → `{fetching ? '正在补全…' : '联网补全'}`
- 按钮上方注释（344-345 行）：`联网找封面是**点一下抓一本**` → `联网补全是**点一下补一本**`；`书名作者会发到搜索源去` 句意保留。
- 93 行注释 `「联网找封面」是点一下抓一本。抓一次要开隐藏窗口搜三个源` → `「联网补全」是点一下补一本。跑一遍书源链要开隐藏窗口`。
- 409 行注释 `没地址时「联网找封面」命中也会自动带上` → `没地址时「联网补全」命中也会自动带上`。
- 428 行 `或点「联网找封面」命中后自动带上` → `或点「联网补全」命中后自动带上`。
- 失败文案（359 行）`几个源上都没有书名作者都对得上的，可以自己选一张` 不变（下面紧接手动选图按钮，这句话仍然成立）。

- [ ] **Step 3: CoverSources.tsx 文案 + 地址字段**

- 顶部文档注释（10-19 行）换成：

```tsx
/**
 * 自定义书源。
 *
 * 输入书名、输出这本书的主页地址：命中后会再读那个详情页，
 * 封面、简介、作者、分类一起补。阅读走本地 txt，不受影响。
 * 内置那三个（起点/书旗/豆瓣）仍然是代码：它们各有各的坑（起点要浏览器渲染、
 * 豆瓣藏在 JSON 里、书旗只收精确匹配块），硬塞进同一套正则配置只会做出个残缺的 DSL。
 *
 * **绝不执行配置的 JS**（和朗读引擎同一条铁律）。只认「搜索地址 + 几条正则」，
 * 表达不了的源就别加——多几个源换「跑陌生人的代码」，这笔账怎么算都不划算。
 */
```

- `<h3>自定义封面搜索源</h3>` → `<h3>自定义书源</h3>`
- 说明段（54-60 行）换成：

```tsx
        内置的起点、书旗、豆瓣不在这里——它们各自有专门的解析逻辑。这里加的源
        <strong>排在它们之后</strong>，前面都没找到才会问。
        <br />
        搜到书之后会再读它的详情页，<strong>封面、简介、分类一起补</strong>，不影响阅读。规则里
        <strong>不支持 JS</strong>：这些配置常常是从别处拿来的，跑陌生人的代码换几个源不划算。
```

- 表单字段那段（112-115 行附近），在「作者」和「封面」之间插一行，并改封面提示：

```tsx
              {field(s, 'blockRe', '结果块', '每条搜索结果的整块。不圈块的话书名和作者会各找各的，对不上号')}
              {field(s, 'titleRe', '书名', '第 1 个捕获组是书名')}
              {field(s, 'authorRe', '作者', '第 1 个捕获组是作者。没有作者的候选一律不会被采用')}
              {field(s, 'urlRe', '详情页地址', '第 1 个捕获组是这本书的主页地址，相对路径自动补全；配了它才补得了简介和分类')}
              {field(s, 'coverRe', '封面（可选）', '第 1 个捕获组是图片地址。详情页没给图时才用它兜底')}
```

- [ ] **Step 4: 闸门**

```bash
npm run typecheck && npm run lint:ui && npm run build && npm test
```

Expected: 全绿。`npm run build` 必须过——文案全在渲染进程，build 是唯一能逮到 JSX 笔误的闸门。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/Settings.tsx src/renderer/BookEditor.tsx src/renderer/CoverSources.tsx
git commit -m "ui: 「找封面」文案改「联网补全」，自定义书源加详情页地址字段"
```

---

### Task 6: 真机验证 + lessons 记录

单元测试盖不到隐藏窗口、真站反爬和界面布局，这一任务补这三样。

**Files:**
- Modify: `docs/lessons.md`（追加本轮记录）

- [ ] **Step 1: 构建并启动应用**

```bash
npm run build
```

然后让用户启动应用（或 `npm start`），确认接口起来：

```bash
curl -s http://127.0.0.1:30036/api/stats
```

Expected: 返回 JSON（`startedAt` 等）。注意 src/main 改动要**重启应用**才生效。

- [ ] **Step 2: 真站链路验证**

应用开着、能出网时跑：

```bash
node scripts/verify-cover-fetch.mjs
```

Expected:
- 逐源校验：起点/书旗/豆瓣三条 ✓（任何一条 ✗ 先按脚本提示排除限流）。
- 整链那几本：`✓ … ok via qidian`，而且 `顺带补上:` 那行里应当出现 **简介 / 分类 / 官网地址** 之类——不再只有封面。若只有封面，说明详情页一跳没生效，回 Task 4 查 `hit.url` 和 `fetchDetailCandidate`。

- [ ] **Step 3: 回填钩子验证（测试库，不碰真库）**

用一个临时 userData 目录起应用（走查脚本那套 `--user-data-dir`），或直接在应用的「在线地址」里给一本书粘个起点链接、把它的 cover_fetch 行手动置 ok、intro 置 NULL，然后开批量开关。预期：开关打开后那本被重新捞到、读详情页、补上简介；跑稳后再开关一次不会重复处理它（`cover.infoBackfill` 标记在 `app_setting` 里）。

查标记：

```bash
# 走 /api/query（X-Api 头），或只读开库
select key, value from app_setting where key = 'cover.infoBackfill';
```

Expected: 值为 1。

- [ ] **Step 4: 界面走查**

设置页打开「联网补全」节、自定义书源对话框「编辑规则」展开（现在多一个字段）：

```bash
node scripts/ui-check/audit.mjs
```

（需要带 `--remote-debugging-port` 的实例，见 `scripts/ui-check/README.md`。）

Expected: 0 条——重点盯书源对话框**超高**和「加一个源」按钮**要不要滚才够得到**（多了一行字段）。

- [ ] **Step 5: 追加 lessons 记录**

`docs/lessons.md` 末尾追加一节（日期 2026-09-07），记：

1. **「找封面」翻转成「找在线地址」**：批量链原来只落搜索候选（封面/作者），简介永远拿不到（全库 8291 本只有 2 本有简介）；翻转后搜索命中必读详情页。量出来的支点：0 本书有封面但没在线地址——封面和地址本来就是一回事。
2. **队列键从 `cover_path is null` 改成「没补过」**（没封面，或有链接没简介）；老库回填是一次性自终止的 verdict 行删除 + `cover.infoBackfill` 标记，不写迁移——一次性动作不需要版本号。
3. **详情页一跳的代价**：起点详情页普通 HTTP 是 202 空页，每本命中多开一次隐藏窗口，批量耗时约翻倍——用户拍板要简介分类，值得。
4. 任何 Step 2-4 里实际踩到的坑（真站改版、对话框超高数字等），有数字记数字。

- [ ] **Step 6: 提交**

```bash
git add docs/lessons.md
git commit -m "docs: 联网补全重构记录——地址优先、队列改键、回填自终止"
```

- [ ] **Step 7: 最终确认**

```bash
git log --oneline -8 && git status -sb
npm test && npm run typecheck && npm run lint:ui && npm run build
```

Expected: 一串本计划的提交；工作区干净（或只剩用户自己的未跟踪文件）；四道闸门全绿。
