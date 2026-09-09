# 联网补全重构：找的是书的在线地址，不是封面

日期：2026-09-07
状态：已批准（设计）

## 背景与问题

现在的「封面抓取」名字和实际做的事都偏了：

- **批量队列搜的是封面**。`tryBook` 拿搜索页里的候选（书名/作者/封面图），精确匹配命中就落库。
  搜索候选里没有简介、没有分类标签——于是整库 8291 本书只有 **2 本有简介**。
- **单本路径已经是对的**。`fetchOne` 第一段是「有主在线地址就读那个详情页」（trustIdentity），
  详情页能给封面/简介/作者/分类/标签；但 `tick()` 直接调 `tryBook`，批量享受不到。
- **真实数据量出来的形状**：882 次命中里起点 729、豆瓣 100、书旗 53；
  784 本书有封面、885 本书有在线地址，**0 本书有封面但没地址**——封面和地址在数据上
  本来就是一回事，差的只是管线没去读详情页。
- 自定义书源（`cover-custom.ts`）更窄：连详情页 URL 都不抽，候选里没有 `url`。

用户的要求原话：「不是找封面，而是去找书的在线地址，并通过在线地址来补充封面、书籍信息。
书大部分只会在一个在线地址出现。源整体优化下。」以及「老配置用新流程重新补齐」——
已经收录过的书要能走一遍新流程把信息补上。

## 目标 / 非目标

目标：

1. 每本书的联网动作统一为一件事：**找到它的一个在线地址，读那个详情页，
   封面/简介/作者/分类/标签一次补全**（只补空缺，不覆盖用户填过的）。
2. 批量队列和单本「联网补全」走同一条链。
3. 已经收录的书（有旧 verdict、有链接但没简介）能走新流程补一轮。
4. 自定义源和内置源是同一种东西：输入书名、输出这本书的主页地址。

非目标：

- 不新增内置搜索源（番茄无公开搜索、纵横实测零边际收益，维持 coverSearch: false；
  它们的详情页解析已存在，用户粘链接或更新检查照常用）。
- 不做反爬绕过、不执行书源 JS（沿用现有安全边界）。
- 不改 rpc 方法名（`cover.*`）、表名（`cover_fetch`）、设置键前缀——
  内部名跨主进程/渲染/测试/HTTP 接口，改名零功能收益。界面文案照改。
- 不做「多地址聚合」：一本书在一处认成功就停，不去第二站比一比。

## 设计

### 1. 统一链 `enrichBook(book)`

`cover-fetcher.ts` 里 `fetchOne` 和 `tick()` 现在各走各的（一个两段、一个直接
`tryBook`）。合成一条链，两者都调它：

1. **这本书有主在线地址**（`online_link` 里 is_primary 优先的第一条）：
   - `fetchDetailCandidate(url)`（传输只认适配器 `needsBrowser`：起点详情页普通 HTTP
     是 202 空页，走隐藏窗口；其余普通 HTTP + `decodeWebPage`）。
   - 成功（候选非 null）→ `applyCandidate(trustIdentity: true)`，**然后停**。
     地址就是目标；那一页真没封面也不再换站搜——「书大部分只会在一个在线地址出现」，
     详情页比搜索页可信，不该拿搜索页的图盖过它（而且「只补空缺」本来也不盖）。
   - 抛错或候选 null（反爬/改版/超时/那一页认不出）→ 安静落入第 2 步。
2. **搜索书源链**（没地址、或地址页没认出来）：起点（窗口）→ 书旗（HTTP）→
   启用的自定义源 → 豆瓣兜底。顺序不变（实测命中 729 / 53 / 100 撑着这个顺序）。
   每个源：搜 → 提取候选 → `matchWithAliases`（书名+作者精确一致，同一套判据）。
   命中后：
   - 候选**带详情页 URL**（内置源的搜索候选本来就带；自定义源加了 urlRe 后也带）→
     抓那个详情页，把详情候选和搜索候选合并（见 `mergeCandidates`）→
     `applyCandidate`（仍过 isExactMatch；喂给它的书名换成本地书名，同现状
     `{ ...hit, title: book.title }`）。
   - 详情页抓失败/认不出 → 直接落搜索候选（今天的行为：封面/作者/地址照拿）。
   - 自定义源旧配置没有 urlRe → 候选没 URL，走这条老路，**旧配置不破坏**。
   - 一个源命中就 break，不往后问。
3. 全链没命中 → nomatch。

返回值沿用 `{ status: 'ok' | 'nomatch'; source?; applied? }`。

限流机器（`emptyStreak` / `missRun` / `HEALTH_PROBE` 探针 / 退避 / 让路 /
自动暂停）**原样不动**，仍然挂在搜索阶段：

- `emptyStreak` 只在起点搜索 0 候选时累加（现在在 `tryBook` 里，留在搜索段）。
- 回填段（第 1 步）不搜索、不碰任何计数器——它失败只算这本书自己的结论。
- `fetchOne` 现在的「详情页补了信息但搜索没封面 → 整体 nomatch」的纠结消失：
  verdict 的语义变成「这本书补没补过」，详情页成功就是 ok。

### 2. 候选合并 `mergeCandidates(detail, search)`

纯函数，放 `src/core/enrich.ts`（core 才测得了）。规则：**详情页字段优先，
详情页没给的用搜索候选兜底**。逐字段：title/author/intro/category/tags/site 取详情页的
（详情页没有则用搜索的）；coverUrl 详情页优先、搜索候选兜底（详情页常见「图在
搜索结果页、详情页 og:image 缺/占位」）；url 用详情页自己的 URL（就是抓的那个）。
tags 两边都有时拼接去重（≤12 的截断仍在 applyCandidate）。

### 3. 队列：目标从「没封面」改成「没补过」

`cover-source.ts` 的 `nextPending` / `fetchStats.pending` 条件从

```sql
b.cover_path is null and cf.book_id is null
```

改成

```sql
cf.book_id is null
  and (b.cover_path is null
       or (b.intro is null and exists (select 1 from online_link l where l.book_id = b.id)))
```

即两种书入队：

- **没封面**（老条件，绝大部分）：走完整链（有地址读地址、没地址搜）。
- **没简介但有在线地址**：只读已知地址补信息，不搜索、不冒险、不产生新的错配可能。

`recordResult` / `resetMisses` / `resetFailed` / `dropResults` 不动。

**老库一次性回填**（「老配置用新流程重新补齐」）：`start()` 时若设置
`cover.infoBackfill` 不存在（设置表，不是迁移——一次性动作自终止，不需要版本号）：

1. 删除「有主在线地址且 `intro is null`」的书的 `cover_fetch` 行；
2. 落下 `cover.infoBackfill = '1'`。

被删行的书于是被新 `nextPending` 自然捞到、走链第 1 步。性质：

- **自终止**：处理完 verdict 行重新落库，不再满足入队条件；详情页真没简介的书
  也只试这一次（行落回来了），不会每次启动重打约 800 次请求。
- 中途关掉应用也安全：标记已落，不重复删；没轮到的书下次启动接着跑（它们仍满足
  入队条件）。
- 回填只删 verdict 行，不碰任何铁律数据。

### 4. 自定义源加「详情页地址」

`src/core/cover-custom.ts`：

- `CustomSource` 加可选字段 `urlRe?: string`：在结果块里抽详情页地址，第 1 捕获组；
  相对路径用 `new URL(href, searchUrl 的源)` 补全（补全在 `parseByRules` 里做，
  它拿得到 src.searchUrl）。
- `coverRe` 保留，语义降级为「详情页没给图时的兜底」；UI 上标注可选。
- `parseByRules` 产出的候选带 `url`（urlRe 配了且抽得到时）。
- `blankSource()` 加 urlRe 示例行。
- 「试一下」按钮（`testSource`）不变：它验的是搜索规则能不能抽出候选；
  候选里带不带 url 会自然显示在结果里。

绝不执行配置里的 JS 那条边界照旧。

### 5. 界面文案（只改文案和注释）

- 设置页「封面」节 → 「联网补全」；批量开关
  「批量给整库找封面（可选，默认不开）」→
  「批量联网找书：在线地址、封面、简介、分类一起补（可选，默认不开）」。
  统计行（已抓/剩余/没匹配上/失败/间隔）的「已抓」→「已补全」之类，随文改正。
- 书籍编辑器里「联网找封面」按钮 → 「联网补全」。
- 自定义源对话框（`CoverSources.tsx`）标题/说明从「封面搜索源 / 只用来找封面」
  改成「书源 / 搜书名，找到书的主页后连封面带简介一起补」；表单加「详情页地址」
  字段，「封面」字段标「可选，详情页没图时兜底」。
- rpc 方法名、`cover_fetch` 表、`cover.*` 设置键一律不动。

### 6. 错误处理与安全

- 链上任何一跳抛错：详情页段安静回落搜索段（现状已有）；单个自定义源出错跳过该源
  （现状已有）；整链抛错记 `failed`（现状已有）。
- 429/403 继续抛出、连败暂停继续生效；`AbortedError`（stop 打断）不落表。
- 隐藏窗口的安全边界（独立 partition、sandbox、拒弹窗、拒权限、注入脚本写死）
  一行不动——详情页复用同一个 `loadInHiddenWindow`。
- 「只补空缺」「搜索路径必须书名+作者精确一致」两条数据安全判据不动。

## 测试

单元（`node:test`）：

- `cover-custom.test.ts`：urlRe 抽地址、相对路径补全、无 urlRe 的旧配置产出不变
  （回归）、coverRe 仍作兜底字段存在。
- `enrich.test.ts`（或 site-adapters 侧，视 mergeCandidates 落点）：
  `mergeCandidates`——详情页字段优先、封面用搜索兜底、url 用详情页的、tags 去重拼接。
- `cover-source.test.ts`：新 pending 条件（没封面入队、有封面有简介不出队、
  有链接没简介入队、有 verdict 行不出队）；回填删除只动「有链接没简介」的行、
  幂等（标记在就不再删）。
- 现有 `site-adapters.test.ts` / `cover.test.ts` 全绿（链形状变了，适配器解析没动）。

验收：

1. 四道闸门：`npm test`、`npm run typecheck`、`npm run lint:ui`、`npm run build`。
2. `node scripts/verify-cover-fetch.mjs`（应用开着、真出网）：逐源校验照旧；
   整链那几本的输出里 `applied` 应当看得到「简介」「分类」之类，不再只有封面。
3. 手动验回填：在测试库上放一本「有在线地址、没简介、有 ok verdict」的书，
   开批量 → verdict 被清、书被捞到、详情页读后补上简介、跑第二遍不再重复处理。
4. `node scripts/ui-check/audit.mjs` 设置页 + 书源对话框过一遍（对话框加了字段，
   盯超高/出口够不够得到）。

## 改动文件

- `src/core/cover-custom.ts`：urlRe 字段、parseByRules 抽地址 + 补全、blankSource。
- `src/core/enrich.ts`：`mergeCandidates`。
- `src/core/cover-source.ts`：nextPending / fetchStats 新条件；回填删除函数
  （纯 SQL，core 里，fetcher 调用）。
- `src/main/cover-fetcher.ts`：`enrichBook` 统一链（fetchOne/tick 收口）、
  start() 里调一次回填。
- `src/renderer/CoverSources.tsx`：书源文案 + 地址字段。
- `src/renderer/Settings.tsx`：节名/开关/统计文案。
- `src/renderer/BookEditor.tsx`：按钮文案。
- 对应测试：`cover-custom.test.ts`、`enrich` 侧测试、`cover-source.test.ts`。

零迁移、零新依赖、不碰铁律数据（reading_state / bookmark / highlight /
rename_log / viewer.* / outline.* 一概不涉及）。
