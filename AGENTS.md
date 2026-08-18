# AGENTS.md — 书斋（本地书籍管理与个人书评）

## ⚠️ 数据目录搬过一次（带迁移）。**别再搬第二次**

`package.json` 的 `name` 是 `shuzhai`，库在 **`%APPDATA%\shuzhai\library.db`**。
旁边那个 `novel-manager\` 目录**已经不是库了**，只剩 Chromium 的缓存——
照着它去开库拿到的是 `unable to open database file`（真踩到过）。

`app.getPath('userData')` 取的就是 `name` 字段，动它等于换目录：应用会在一个
**空目录**里重新开张，书没了、封面没了、**阅读进度和书签也没了**（铁律 3，重扫恢复
不了）。用户看到的是「书库消失」，而应用自己一句错都不报——它只是开了个新库。

上次能改是因为**先写了迁移**（`src/main/migrate-userdata.ts`，commit 94d3297）。
那里面有条踩出来的：**搬家要先 `wal_checkpoint(TRUNCATE)` 再只搬主库**，三个文件
一起 rename 丢过尾部两条已提交的事务（「三个一起拷」说的是拷贝快照，不是搬家）。

再改一次的收益仍然是零：**那个目录名用户根本看不见。用户看得见的名字（窗口标题、
侧栏、快捷方式）全在别处**：`electron-builder.yml` 的 `productName` /
`shortcutName`、`src/main/main.ts` 的窗口标题、`src/renderer/index.html` 的
`<title>`、`App.tsx` 的 `nav-brand`。

⚠️ **安装包的文件名不在那几处里，它走 `${name}`——而那正是这一节说碰都不能碰的字段。**
这条原来把「安装包」和上面那些并列，写着「改名改这几处就够」，**现在是假的**：
产物名从 `${productName}` 换成了 `${name}`（中文文件名一进下载地址就是
`%E4%B9%A6%E6%96%8B-…`，而 README 首屏那个「⬇ 下载」是最该点得下去的一个链接）。
所以照着上面改完名字，**产物名不会跟着变**——而「顺理成章」的下一步正是去动
`package.json` 的 `name`，那就是这一节开头讲的那场数据事故。
要让产物名跟着走，改 `electron-builder.yml` 的 `artifactName` 模板；
`src/core/artifact-name.test.ts` 守着它别退回 `${productName}`。


任何 AI 编码工具（Claude Code、Codex CLI、Gemini CLI、Cursor 等）从本文件进入。
**本文件是协作约定的唯一权威来源。要加规则只改这里。**
`AGENTS.md` 是跨工具的通用约定，不给每个工具单开一份——同一份约定抄成几份必然分叉
（这个仓库已经被「抄第二份」咬过三次：`shelfCounts` 绕开 `buildFilter`、渲染进程
自己抄了一份 `Filter`、CLAUDE.md 复述库路径）。根目录的 `CLAUDE.md` 只是一句指路，
留着是**必须的**：实测（带对照组）Claude Code 不会自动加载 `AGENTS.md`——只放
`AGENTS.md` 的仓库里它一句约定都读不到，而 `CLAUDE.md` 里一行 `@AGENTS.md` 就能内联进来。
Codex 那边 `AGENTS.md` 才是默认名。所以正本在这里，`CLAUDE.md` 只有那一行引用。

**案例史的正本是 `docs/lessons.md`**——这个仓库每一次踩的坑、每一轮量出来的数，
以及一批「查过了、是好的」的负结果。**它不随会话内联**：本文件曾经把它一起装着，
涨到 **8584 行 / 546 KB**，`CLAUDE.md` 那行 `@AGENTS.md` 每次开场把它整份铺开，
十几万 token，而其中绝大部分和当下这次改动无关。

拆开的是**种类不是内容**——一条事实仍然只有一份，不是抄了两份：
本文件写**下一次改动前必须知道的**，那份写**出事之后拿来查的**。
**新的踩坑记录加进那份，别加回这里**；反过来，一条判据如果每次改动前都要知道，
它属于这里。

怎么查（**动代码之前查一次，比事后查便宜得多**）：

```bash
grep -n '^## ' docs/lessons.md        # 全部标题，那就是目录
grep -n '关键词' docs/lessons.md       # 按词找
sed -n '1234,1300p' docs/lessons.md   # 读那一段
```

**这几处一定要先查**：`chapter.ts` 的章节规则、备份与恢复、扫描、封面抓取、
`scripts/ui-check/` 那几个走查、以及任何「预览 + 执行」成对的功能——
每一处都有好几轮踩出来的判据，凭感觉改必然重踩。

**需求的正本是 `novel-manager-spec.md`**，本文件不复述需求。要改「做什么」，改那份。

## 开场不要做自检

**你在这个仓库里不是常驻角色**，是用户偶尔叫来整理数据的外部操作员。别每次开场先统计
一遍书库、也别主动汇报库状态——用户问什么答什么。

（同系列的 `029-ai-job-search-cn` 和 `031-zhengyin` 都有开场自检，那是因为 AI 在那两个
项目里是流水线的一环：一个是运行时本身，一个要读「交接单」接着上次的进度往下做。
这里应用自己完整闭环，没有需要你接手的状态。）

## 当前状态：spec 的 M1–M4 都已落地

`npm test` **全绿**（条数以当场输出为准，别在这儿记一个会过期的数），
`npm run typecheck` 干净，`npm run lint:ui` 干净，
`npm run dist` 能出安装包。**CI 跑的是前三条加 `npm run build`**
（`.github/workflows/ci.yml`，windows-latest × node 24）——**`npm run dist` 不在里面**，
那个 workflow 里专门有一节写着为什么不跑它。**别把「CI 绿了」当成「包打得出来」。**
而且**那个 workflow 至今没有真的跑过**，仓库还没有远程。

> ⚠️ **下表里的条数是快照，只有一个有东西守着。** 历次全量审计每一轮都能量到
> 好几处数飘了（测试条数、迁移、纸色、rpc 方法、走查界面、渲染包……），
> 它们**不报错、不影响测试**，只是悄悄变成假的。
>
> **这条警告本身也飘过一次**：它原来在这里列了「456→539、121→131、20→25」
> 这样一串具体数字，而那串数字到下一轮就全过期了——
> **一句「这些数会过期」的提醒，自己带着一串会过期的数**。
> 所以现在这里不记数，只记「去哪儿量」（见下面那段）。
>
> 真被钉住的只有**纸色那 10 个 id**（`builtin-themes.test.ts` 逐个 deepEqual，
> 因为改 id 会让所有用户的主题静默失效——那是 bug，所以值得钉）。
> 其余（迁移条数、朗读引擎、章节规则、rpc 方法）**故意不钉**：多一条迁移、
> 多一个引擎都是正常演进，钉住只会让每次正常改动都红一次，那种测试很快会被人删掉。
>
> 所以**要准数就当场跑**：`node scripts/counts.mjs` 一次把它们全打出来
> （迁移、表、章节规则、卷规则、内置净化规则、朗读引擎、纸色、rpc 方法）。
>
> 那个脚本**不是守卫**，永远退出 0、什么都不断言——上面那句「故意不钉」仍然算数。
> 它解决的是**摩擦**：这些名字一个比一个难猜（`allBuiltins` 根本没导出、
> 纸色那个数组叫 `BUNDLED_THEMES`），写这个脚本之前我为了数这几个数试错了四次 import。
> rpc 那一项按**单引号包起来的完整方法名**数，不按子串
> （`search.indexed` 会被 `search.indexedBooks` 冒领，`docs/lessons.md`「第四轮死 rpc 清点」那节记着）。

| 在哪 | 是什么 | spec |
|---|---|---|
| `src/core/encoding.ts` | 编码探测与解码 | §2.1 |
| `src/core/chapter.ts` | 章节解析 + 进度恢复（spec 说这是最核心的模块） | §2.2 §2.3 |
| `src/core/reparse.ts` | 章节规则编辑器的后端：先预览、确认才落库 | §2.2 |
| `src/core/book-rule.ts` | 「这本书用哪条章节规则」**唯一的一份查表**。原来 `reparse` / `metadata` / `backup` 各抄一份，而**扫描那份漏了**——追更覆盖写入就把用户手工设的规则静默丢掉 | §2.2 |
| `src/core/suggest.ts` | **从书自己的正文里猜候选章节规则**（纯统计，不是 AI） | §2.2 |
| `src/renderer/RatePopover.tsx` `BatchTagDialog.tsx` `TagManager.tsx` `KeywordTags.tsx` | **个人评价体系**：评分、短评、标签、按书名归类 | §3.1 §5.1 |
| `src/renderer/settings.ts` 的 `loadSort` / `saveSort` | **书架按什么排，每一档各记各的**（`shelf.sorts`）。回落链只此一份，在 `App.tsx` 的 `排序默认()`：**这一档选过的 → `SHELVES` 的 `sort` → 最新的在前**。⚠️ **别退回全局一个键**：能改排序的有两处（顶栏下拉 + **表格表头**），全局的话「在『我的书评』的表格里点一下『评分』表头」＝「把『全部』的默认排序也改了」，而用户只觉得自己在排这张表。真实症状是用户报的：**刚点开读过的书在「全部」里不排第一了**（它没评分，沉到八千本后面）。⚠️ 和视图**共用** `每档记一份()` / `记下()` 一份实现，别抄第二份；⚠️ 写的时候按原样合并、不拿「认得的」过滤，否则将来从 `ORDER` 去掉一个键会顺手抹掉别档的记录 | — |
| `src/renderer/settings.ts` 的 `loadView` / `saveView` | **书架用哪种视图看，每一档各记各的**（`shelf.views` 存一张 `档位 → 视图` 的表）。回落链只此一份，在 `App.tsx` 的 `视图默认()` 里：**用户在这一档自己选过的 → 这一档的默认（`SHELVES` 的 `view`）→ 封面墙**。所以「我的书评」默认表格、其余默认封面墙。⚠️ **别退回全局一个键**：那样两个方向都串味——在「全部」里切成表格会让「在读」「弃坑」全跟着变，反过来在「我的书评」里切一下封面墙又会盖到别的档上。而这件事**类型检查兜不住、界面上也不报错**，只是视图静默变成了另一个（`settings.test.ts` 两条钉着，破坏一次验过） | — |
| `src/renderer/ReviewTable.tsx` | **表格视图**（「我的书评」那一档的默认）：一行一本，评分/评价/状态/**读到**/**上次读**/**读完**/题材/字数并排。⚠️ **没有「读了多久」，那是查过之后决定不加的**：`reading_session` 记的是**阅读器开着多久**（进阅读器开、离开关，退出时按当下时间收尾，挂机照记）——真实库上单次最长 216496 秒 ≈ 60 小时、某本累计 66 小时，摆出来是个看着正常的假数；而且 `status.ts` 顶上写着 spec §14 明确不做阅读时长统计。⚠️ **读完的书「上次读」留空**：读完是翻到最后一页才读完的，两列会印出一模一样的时间（同封面墙「不说两次同一件事」）。⚠️ **加一列就回来调 `min-width`**，否则表格宁可被挤扁也不横滚，而挤扁不报任何警告。存在的理由是另外两种视图都答不上「我这一批书的账目」（封面墙一屏八本、每本两行小字；书评册一次只讲一本）。⚠️ **只读**——点评价那一格开的是 `RatePopover`，评分/短评/标签的写入只有那一条路，表格里再做一套就地编辑就是「同一份判据抄第二份」。两个点击目标按格子分工：书名＝打开这本书，评价格＝改评价（**空的时候也要能点**，「读过没评价」那一档整列都是空的，而那正是这一屏最有用的场合）。⚠️ 表头只有**真有排序实现**的那几列可点（`ORDER` 里有什么就是什么），而且**单向**——那几条是写死方向的字符串。⚠️ **`min-width` 不能省**（具体几 rem 看 `shell.css` 的 `.booktable`，**别在这儿抄**：原来写的「54rem」在加列那一轮就过期了，而代码里是另一个数）：光有 `width:100%` 的话表格窄到装不下时**宁可压缩也不溢出**，560 宽下作者列被压成一个字一行、状态列「已」「读」「完」竖着排，而这**不会报任何溢出警告** | §5.1 |
| `src/renderer/ReviewShelf.tsx` | **「我的书评」那一档长什么样——它不是封面墙**。那一档要答的是「我评过什么、我当时怎么说」，而封面墙把那句话压成封面底下两行 0.72rem 的小字（量过：22–26 个字，再长就是省略号）：这个应用唯一不可再生、也唯一算得上「我的」的内容，在专门为它开的那一档里占的地方比作者名还小。于是换了形状——**我写的那句话是正文（楷体，中文书里给引文和批注排的就是它），书是落款**，评分做成盖在左边的一枚朱印（`--seal`，`app-palette.test.ts` 钉着「白字读得清」和「印在纸上看得见」两条）。⚠️ **月栏只在按评价时间排时才画**：月份是排序键本身，换成「评分高的在前」还画着年月就是句假话。⚠️ **书名在这里是可点的键**——这一档没有封面，不然一个打开书的入口都没有；和封面墙那句「不做在书名上」不矛盾，那说的是卡片上 18px 高的那一行。走查有一屏盯着它（`audit.mjs` 的「我的书评」，⚠️ 那一屏的 `close` 必须切回「全部」，否则后面每一屏都在一个没有 `.book` 卡片的页面上量） | §5.1 |
| `src/renderer/Cover.tsx` `cover-art.ts` | **占位封面**——没有真封面时顶上来的那张。**九成的书架就是它**（真实库 8287 本里只有 773 本有真封面），所以它不是一个兜底样式，它是这一屏的底色。形状取自线装书：**素色书衣 + 一张竖排题签**，题签上**只写书名、不写作者**（作者就印在卡片下面那行，同「不说两次同一件事」；而书名留着是有判据的——没有真封面的书，书名是唯一能认出它的东西）。⚠️ **别退回「按书名算一个 0–360 的色相」**：三百六十个色相铺在 `--bg` 那张米纸上就是一把彩虹糖。现在收成**六匹书衣**，而「同一本书永远同一色」那条原判据没丢。⚠️ **字体栈钉死宋体，别把思源宋体排到栈首**——竖排下一个汉字占多长是**按脸算的**：当场量到宋体和系统 serif 都是 1em，**思源宋体 1.44em**（vhea 带着行间距），而 `题签字号` 那个式子是按 1em 解的，换张脸就把五个字的书名截成三个，屏幕上只看得见一个省略号。⚠️ **字号上限 16cqw 是题签和右上角那列角标不打架的唯一保证**，`audit.mjs` 的「封面上的字被角标压住」守着它。⚠️ 两条判据放在 `cover-art.ts` 而不是 `.tsx` 里，是因为 **JSX 测不到**（`node --test` 的原生剥类型不认 `.tsx`）——同 `core/pacing.ts` 那个理由 | §3.1 |
| `src/renderer/BatchStatusDialog.tsx` | **批量改阅读状态**，作用于整个筛选结果。判据在 `core/status.ts` 的 `setStatusByFilter`：动过的书（读完了、或读到过第几章）一律不碰 | §5.1 |
| `src/renderer/Reader.tsx` `FileViewer.tsx` 的 `只开一个` | **阅读界面同一时刻只留一个浮层**，Esc 是「收最上面那一层」、一层都没有才退出，开着浮层点正文是「收起来」不翻页。**两个界面各一份、判据必须一样**——查看器原来只抄了一半，三种组合能叠两层 | — |
| `src/renderer/NoteCard.tsx` | 点在一条划线上开的那张卡**里面长什么样**——看笔记 / 写笔记 / 换颜色 / 删，**两个阅读界面共用这一份**。抽出来之前是两份而且已经分叉（查看器那边没笔记也开卡，txt 那边**一点就删**，而查看器的注释还写着「判据和 txt 一样」）。⚠️ **只管卡片里面**：往哪儿贴、贴不下怎么翻上去，两边算法不同（查看器要处理 iframe），那部分不共用 | §5.1 |
| `src/renderer/ReaderChrome.tsx` | 两个阅读界面共用的那几块**壳**：一键白天/夜间、朗读引擎弹窗、目录浮层的头（书名 + 收起 + 搜索框）。**同 `NoteCard.tsx` 是一个理由**——去重扫描报出这三处在 `Reader.tsx` 和 `FileViewer.tsx` 里逐字节相同。⚠️ **只收「两边判据必须一样」的**：往哪儿贴、PDF 那一页是 canvas 所以纸色作用不到，那些两边算法不同，不共用；查看器目录头上那块「把这一页加进目录」走 `children` 塞进去。⚠️ **「现在是不是夜间」走 `settings.ts` 的 `isNightTheme`**：两边原来各手写一份 `theme.endsWith('-night')`，而导进来的 legado 主题 id 是 `imported-<名字>`——深色的导入主题 `night` 是 true 而 id 不以 `-night` 结尾，于是外观已经是暗的、那个键还写着「切到夜间」 | — |
| `src/renderer/HighlightsPanel.tsx` | **笔记的回看**：划线 / 书签 / 全库笔记三档。全库那一档能**归组**（按书 / 按颜色 / 按标签 / 最近，组头写着条数）和**批量**（选这一屏 → 改颜色 / 打标签 / 删）。⚠️ **归组不是排序**：排序只能让同类挨着，归组才回答得了「蓝的那堆一共几条」——而颜色在这个应用里是用户自己定的用途。⚠️ 按颜色 / 按标签归组**必须自己再排一遍**（SQL 那边是按书排的），不排的话「组名变了就插一行表头」会插得满屏都是。⚠️ 那个键叫**「选这一屏」不叫「全选」**：这一档是先铺 300 行、翻到底再铺一截，叫全选而只选中一截是在骗人，而这次骗的后果是批量删少删了东西。搜、按颜色筛（**本书和全库两档都能筛**——「全库还剩哪些待查」正是颜色用途这套东西的用处）、改颜色、跳过去闪一下、给颜色起名。⚠️ **挂在三处**——阅读器、查看器，以及**书架侧栏的「我的笔记」**（`bookId` 不传就是全库模式）。第三处是后补的：在它之前想看自己记过什么**得先随便打开一本书**，而笔记是铁律 3 里重扫恢复不了的数据。⚠️ 「全库笔记」那一档走 `notesOf`，**划线和书签上的笔记都要算**——两张表的 `id` 会重号，所以每条带着 `kind`：界面的 key 是 `kind:id`，**改笔记 / 删也按 `kind` 分发到两个 rpc**（发错表就是动了别人那条，不报错）。那一档能就地改、就地删，不用先打开那本书，**一次先铺 300 行、翻到底再铺一截**（量出来的：八千多条时全铺开开一次 0.7 秒、换个排序又 0.7 秒，而目录正是量到 543ms 才开的窗口），还能**按书 / 按时间**两种排法（「我最近记了些什么」原来在应用里根本问不出来）。⚠️ 按时间排**必须走 `format.ts` 的 `sqlTime`**，别拿字符串比：`asWhen` 只要求「解析得出来」就原样留着，库里可以同时有 `2026-08-27 06:00:00` 和 `2026-08-27T05:00:00Z`，而 `'T'` > `' '` | §5.1 |
| `src/renderer/anchor.ts` | 浮层贴着哪个键开（`useAnchored`）+ **浮层的焦点规矩**（`use浮层焦点`：开了焦点进去、关了还给那个键；**不做焦点圈套**——正文还在读，Tab 出去是正常操作）。目录那一层不走 `useAnchored`，焦点要单独接 | — |
| `src/renderer/modal-a11y.ts` | 弹窗的键盘可达性：焦点进得去、跑不出来、关掉回原处，**外加把 `aria-labelledby` 接到它自己那个看得见的标题上**——只有 `role="dialog"` 的话，屏幕阅读器念出来是一句光秃秃的「对话框」，不说是哪一个。⚠️ 接名字**必须能补第二次**：有些弹窗内容是异步到的（「编辑一本书」就是），遮罩出现那一刻里面还没有标题——焦点那条早有 `pending` 兜着，接名字那条一开始没跟上，是 `keyboard.mjs` 新加的那句断言当场抓出来的。**一处管全部弹窗**，那二十来个渲染 `.modal-backdrop` 的文件一个字都不用改（**别在这儿记个数**：原来写「十八个」，数到现在是 21 个，而这个数只会继续长） | — |
| `src/core/clean.ts` | 正文清洗规则 + diff 预览 | §2.4 |
| `src/core/builtin-rules.ts` | **净化规则**（我们自己的一套，对着真实书库量出来的） | §2.4 |
| `src/renderer/builtin-themes.ts` | **10 张内置纸色**（day/night/eye/paper 四张原来只活在 CSS 里，另外 6 张是发布前从 legado 主题转好的配色） | §6 |
| `src/core/tts.ts` `builtin-tts.ts` `tts-custom.ts` | 朗读：切段、URL 模板；**在线引擎一个都不预置**，用户自己导、存他自己的库里 | §6 |
| `src/renderer/useTts.ts` | 朗读播放机：队列、连续朗读、失败退回系统语音。⚠️ **队列跟着当前章走**——换章时「正念着」就念新的这一章、「暂停着」就把队列扔掉，两个阅读界面各有一条 effect 守着（`docs/lessons.md` 搜「自动定位到本章」） | §6 |
| `src/renderer/FileViewer.tsx` | **PDF / EPUB 的内置查看器**（pdf.js / epub.js，都是动态 import）。纸色和排版要**显式送进 iframe**，`--read-*` 到不了；**阅读方式三档和 txt 共用一个 `settings.mode`**：EPUB 靠 epub.js 的 `flow`/`manager`，PDF 的「下滑」是一叠 canvas + `IntersectionObserver`（**页码要按几何算，不能问观察器**，`docs/lessons.md` 搜「共用的边界画错了」）。进度存 `app_setting` 的 `viewer.<bookId>`，不进 `reading_state`（那边 `chapter_count` 是 0，会显示「读到 12/0」）。⚠️ **窗口不可见时 rAF 一帧都不跑**，这两个库的渲染都挂在 rAF 上——走查连的是后台窗口，所以 `cdp.mjs` 里那句 `setFocusEmulationEnabled` 不能删（`docs/lessons.md` 搜 `rAF`）。⚠️ **右轨是有的**（`.reader-tools`）：加书签 / 书签划线 / 搜索 / 评价 / 缩放 / 自动滚 / 朗读 / 夜间，另加**框选**（只给 PDF）——文件里那句「右轨没有」是早年的，已经改掉了。**框选开着时文字层 `pointer-events: none`**：在页上拖一下本来就是「选字」，两件事抢同一个手势。**目录键就算一条 outline 都没有也要摆**（PDF）——自建目录的入口在里面，见 `src/core/outline.ts` | §1.1 |
| `src/renderer/ReviewCard.tsx` | 评分 + 一句短评，**阅读器和查看器共用这一份**。评价是「右轨对 PDF/EPUB 一条都不成立」那条判据的唯一例外：它按 `book_id` 记，和格式无关 | §5.1 |
| `src/renderer/CategoryDialog.tsx` | **分类**＝一个名字 + 一条规则（存的是规则不是结果）。和标签是两件事：分类单选问「现在看哪一堆」，标签多选问「再筛一道」。⚠️ **一个编辑器两种用法**：挑完条件可以「就这么筛」（临时的，`App.tsx` 的 `adhoc`，不留下东西），也可以起名「存成分类」。**别另做一条常驻筛选条**——「按评分」「按文件夹」那两排开关是**被有意撤掉的**（当规则可以，当分类太粗；用户要的是几条规则的组合），再摆回去就是同一件事两处表达。⚠️ 新建/临时筛选时 `editing` 是 null（调用方传的是 `editCat.id ? editCat : null`），初值走 `seed`，拿 `editing` 兼这个差会开出一张空表而屏幕上那条筛选还在生效 | §7 |
| `src/core/convert.ts` | 繁简转换（opencc-js，运行时转）。**三个阅读界面都认**：txt 在 `chapter.read` 里转，EPUB 是渲染进程走 `convert.preview` 把 iframe 里的文字节点就地换掉（原文存 `WeakMap`，切模式从原文重转），PDF 只转朗读念的文字（那一页是图）。**别把 opencc 搬进渲染包**（`reanchor` 要转换是**把函数注进去**的，因为 `highlight.ts` 渲染进程也在引）。⚠️ **章名和卷名也跟着转**（`readChapter` 的 `title`、`book.chapters` 的两列）——不转的话：① 目录整列是简体而正文是繁体，目录搜索框得输简体；② 更要命的是 `text.startsWith(title)` 不成立，「把标题从正文里剥掉」失败，**整章偏移挪一个标题的长度、满屏划线判成漂了**。剥的那一步只此一份：`reader.ts` 的 `chapterBody`（rpc 里原来抄了三处） | §2.5 |
| `src/core/filename.ts` | 从文件名猜书名作者、字数统计 | §3.1 |
| `src/core/scan.ts` | 目录扫描与增量同步。⚠️ **跳过必须报出来**：`skipped` 五档 + `otherExts`（不收的格式按扩展名数）。多根合并走 `mergeReport()`，**新加字段必须在那里合并**，`scan.test.ts` 有一条守着 | §1.2 §1.3 |
| `src/core/book-format.ts` | 「这个文件是什么书」——`isBookFile` / `formatOf` / `TEXT_EXT`，**一个依赖都不 import**，渲染进程也在用。⚠️ **加格式的判据写在 `BOOK_EXT` 上面**：收「只可能是一本书」的扩展名，不收通用文档格式（doc/docx/rtf/html/chm 是查过之后**决定不收**的）。`md` 走「能完整阅读」那一档——它是纯文本，章节规则实测直接成立 | §1.1 |
| `src/core/ignore.ts` | 目录屏蔽规则（glob），带「这条规则会挡掉哪些已入库的书」预览 | §1.1 |
| `src/core/watcher.ts` | 实时文件监听（`fs.watch`，默认关） | §1.2 |
| `src/core/schedule.ts` | 定期扫描的排程计算（纯函数，可测） | §1.2 |
| `src/core/health.ts` | 章节切分体检（纯 SQL，不读一个字节正文）：哪几本该重新解析 | §2.2 |
| `src/core/metadata.ts` | 元数据编辑与批量操作 | §3.1 §3.2 |
| `src/core/manual.ts` | **手工添「读过但本地没有文件」的书**——书评是主体，文件是可选的 | §3.1 |
| `src/core/cover.ts` | 封面落库：拷进 userData，不引用用户原来的位置 | §3.1 |
| `src/core/enrich.ts` | 补全元数据：**只管「找到之后怎么落库」**，去哪儿找是 cover-fetcher 的事 | §3.1 §4 |
| 书架上那几样**通知**（`App.tsx` 的 `.toasts`） | 报错 / 扫描报告 / 迁移提示**浮在右下角**，不占版面（它们原来内联，一扫描完就把封面墙往下顶一大截）。⚠️ **章节体检名单不在浮层里**，它是「长期名单 + 一个动作」＝待办不是通知。⚠️ 有 `max-height` 就会内滚，所以动作行 `position: sticky` 钉在卡片底沿——否则「知道了」跟着内容滚出视野（`audit.mjs` 有一条判据专量「出口要不要滚才够得到」）。⚠️ 容器 `pointer-events: none`、卡片 `auto`，否则它会挡住底下书架的点击，而那块地方看不见。⚠️ **`z-index` 要压过弹窗遮罩（10），别躲在它底下**——躲着就是「弹窗开着时报错等于没发生」，而通知最需要被看见的正是这种时刻。⚠️ **「有没有按钮」和「要不要自己走」是同一个判断**（`报告要等人处理()`，一处决定两件事）：有下一步可做的留着等人点、不自动走（自动走＝替用户把待办划掉了）；没有下一步的自己走、一个按钮都不出——一个只用来把盒子藏起来的「知道了」是多余的。⚠️ 自己走的那种**留 12 秒且鼠标停上去暂停**（`Toast.tsx`）：跳过统计是要读的，「读到一半它自己跑了」比多一个按钮糟得多。⚠️ `Toast` 的 `onClose` 走 ref 不进 effect 依赖——调用方是 JSX 里的箭头函数，每次渲染都是新的，进了依赖就永远不走。⚠️ **「设了 `error` 就算报了」不成立**：App 在阅读器/查看器里会整个 return 掉书架，浮层根本不在树里，所以要先退出阅读界面再报（`打开别的书` 里那两句 `setReading(null)` 的位置是判据，不是随手写的） | — |
| `src/core/deletion.ts` | **删除重复文件**（spec §0.1 的例外）：默认 `shell.trashItem`；回收站用不了（网络盘上就没有）时，用户再点一次可以挪进 `userData/quarantine`，30 天后清。**两条路都不是真删**，改前先读文件顶部 | §8 |
| `src/core/highlight.ts` `src/renderer/pdf-text.ts` | 划线与笔记（含改颜色 `setColor`：**认不出的颜色报错，不像新建那样退回黄的**）：**四种位置，共用 `chapter_idx` 那一列**——txt 是「章号 + 章内偏移 + 长度」，EPUB 是 `cfi`（偏移字段占位），**PDF 的文字划线是「页码 + 页内偏移 + 长度」**（靠 pdf.js 的文字层，`cfi` 留空），**PDF 的框选是「页码 + 矩形」**（`rect` 存 `"x,y,w,h"` 四个 0–1 的归一化坐标，迁移 22；**扫描页 / 插图 / 公式根本没有文字层**，上面三种对它一条都不成立——参照 MarginNote 的四种摘录形态；画法另一份，走 `highlight-view.ts` 的 `画矩形`，**不经过 `pdf-text.ts`**）。⚠️ **存坐标不存截图**（铁律 2），图每次从原 PDF 现画；**不做 OCR**（MarginNote 做，GoodNotes 明确不做，这里跟后者，铁律 4）。框选那一块能**导成 PNG**（`highlight.exportImage`）——库里仍然只存坐标，图是用的时候重新 render 那一页再裁（拄 GoodNotes 的 Take a screenshot of the selected area）。⚠️ 那段画页代码要跟 `FileViewer` 自己那份一致：**`canvas` 和 `canvasContext` 两个都传**，而且 **`render(...).promise` 会一直不 resolve**，得拿超时兜住（两条漏一条都是卡死不报错）。另有 **`highlight_tag`（迁移 23）：给笔记打标签**——颜色只有四个，用途一多就不够分；**复用 `tag` 表**，标签管理器的改名 / 合并 / 删除直接就管得着它们。画法只有一份：`highlight-view.ts` 的 `画布` 接口，分岔只在「怎么还原成 Range」。都不存正文。⚠️ **漂了不是死路**：`reanchor` 拿 `excerpt` 在新正文里找回来（阅读界面那句提示上有按钮）——**只在「不多不少正好一处」时才改**，出现两次的一律不动，猜错了是把笔记贴到另一句话上，比画不出来难看得多而且看不出来。⚠️ **带笔记的划线是「原色 + 下划线」，不是换一种颜色**——那份画法原来写的是 `h.note ? 'note' : h.color`，写了笔记就变黄的，用户挑的颜色当场没了（`highlight-view.test.ts` 钉着）。⚠️ **「这个颜色代表什么」是用户自己打的字**（`COLOR_NAMES` / `colorNames`）：默认名只是兜底，改过的存 `app_setting` 的 `highlight.colorNames`、**进备份**（划线在铁律 3 里，划线回来了、代表什么丢了等于只恢复一半）。渲染进程统一走 `highlight-view.ts` 的 `use色名`，**别再各自硬编码**——三个阅读界面原来抄了三份。另有 `notedChapters`：**目录里标出哪一章有笔记**（反向导航，两个阅读界面共用），⚠️ 必须分组计数、只回有笔记的那几章——目录是这个应用最容易卡的地方 | §5.1 |
| `src/core/outline.ts` | **用户自己加的目录**（`app_setting` 的 `outline.<bookId>`）。很多 PDF 根本没有 outline，有的也常常是乱的——那时候一本几百页的书**在应用里没有任何导航**。⚠️ 这是**第二个「按 id 命名的设置」**（第一个是 `viewer.<bookId>`，铁律 3 在它身上栓过一次）：没有外键、`on delete cascade` 管不着，所以删书靠触发器兑底、备份得带、恢复要拿**新的** book id 写 | §6 |
| `src/core/paragraphs.ts` | 正文分段 + 把划线套回段落（偏移算错会把高亮画到别的句子上） | §5.1 |
| `src/core/labels.ts` | 状态的中文说法，**全应用唯一的一份**（原来在渲染进程里抄了两遍） | — |
| `src/core/format.ts` | 卡片上那几个数怎么写成人话（纯函数） | — |
| `src/core/pacing.ts` | **只在大库上才暴露的两条判据**：进度事件限流、封面抓取给界面让路 | — |
| `src/core/rename.ts` | **文件重命名**：模板、预览、冲突、撤销 | §3.3 |
| `src/core/links.ts` | 在线地址与死链探活 | §4 |
| `src/core/status.ts` | 阅读状态、书签、阅读会话 | §5 |
| `src/core/reader.ts` | 按字节偏移定点读 + 句柄 LRU | §6 §12 |
| `src/core/reading-pos.ts` | 「读到哪儿了 / 读完了没有」的**纯判断**（锚点、到底没到底）。滚动和翻页两种模式共用一份，抄两份必分叉 | §6 |
| `src/core/primary.ts` | 「这本书拿哪个文件读」——主文件坏了自动换一个（`ensurePrimary`，四处调它：删除 / 合并 / 整理 / 扫描）；**合并之后另有一条 `preferReadable`**：只编目的 PDF/EPUB 不该压着一份能读的 txt，否则那本书点开进的是查看器。**判据只此一份** | §8 |
| `src/core/open.ts` | 点开一本书**该发生什么**的纯判断（进阅读器 / 开评价 / 交给系统程序 / 报错）。**那四条判断的顺序是判据的一部分**，四条测试各钉一对相邻的 | §6 |
| `src/core/library.ts` | 分类、标签、筛选、智能书架。⚠️ **`ShelfCounts` 的 `all` 和 `total` 是两回事**：`all` 带着当前筛选（侧栏的数要跟着变），`total` 是整个书库、不受 `scope` 影响。**判断「这个用户到底有没有书」只能用 `total`**——界面上有三处（搜索框、顶栏那排控件、分类那一排）靠它决定自己显不显示，用 `all` 的话「筛出 0 本」会被当成「库是空的」，把取消筛选的入口连同自己一起藏掉，用户只能重启应用（真出过，`library.test.ts` 一条钉着，破坏验过）。`total` 要绕开 `shelfCounts` 里那个 `count()` 闭包，它会把 `scope` 拌进去 | §3.1 §7 |
| `src/core/search.ts` | FTS5 全文索引 + 书内搜索（**只管纯文本书**：靠章节表和字节偏移） | §7 |
| `src/core/snippet.ts` | 命中处的上下文片段（`…前文【命中】后文…`）。**一个依赖都不 import**——查看器的书内搜索在渲染进程里跑（PDF/EPUB 的正文只有 pdf.js / epub.js 拿得到），而 `search.ts` 带着 `node:sqlite`，一 import 就把整个数据库拖进渲染包 | §7 |
| `src/core/versions.ts` | 多版本归组与重复检测 | §8 |
| `src/core/export.ts` `zip.ts` | EPUB / txt / CSV / JSON 导出，外加 **`exportNotes`：把划线笔记书签导成 markdown**（书斋自己能读 `.md`，导出来的放回书库就是一本书），以及 **`exportAllNotes`：全库的笔记导成一份**（入口在「我的笔记」面板里）。⚠️ 后者**不重写一遍**，是把 `exportNotes` 的产物整段收进来、标题降一级——颜色用途、位置怎么称呼、摘录怎么进引用块，那三条判据只有那一份实现；「哪些书算记过笔记」走 `library.ts` 的 `hasNotesSql`，不另写 SQL。⚠️ 位置怎么称呼走 `book-format.ts` 的 `位置名`，别另写一份 | §9 |
| `src/core/backup.ts` | 备份与恢复 | §10 |
| `src/core/autobackup.ts` | 自动备份：何时该备、留几份 | §10 |
| `src/core/webdav.ts` | WebDAV 同步备份文件。⚠️ **只有 rpc，界面上一个入口都没有——而这是量过之后决定不补的**：备份要防的是「盘坏了，备份和书库一起没」，而把备份目录指到 OneDrive / 坚果云的同步目录就解决了，不需要应用自己会说 WebDAV（判据写在 `BackupDialog.tsx` 那段注释上）。整个模块**只被 `rpc.ts` 引**，别看它没人调就当成死代码删掉 | §10 |
| `src/core/db.ts` | schema + 迁移（有几条就是 `SCHEMA_VERSION`，当场跑 `counts.mjs` 看）+ 只读连接 | §11 |
| `src/core/cover-source.ts` | 封面抓取的纯函数：提取/匹配/校验/断点队列 | §3.1 |
| `src/core/cover-custom.ts` | **自定义封面源**：搜索地址 + 四条正则，不跑 JS | §3.1 |
| `src/core/fonts.ts` | 正文字体：装 ttf/otf、随应用发布的那份 | §6 |
| `src/main/cover-fetcher.ts` | 封面抓取的 Electron 侧：隐藏窗口 + 后台循环 | §3.1 |
| `src/server/api.ts` | AI 维护接口的三个端点 | §13.1 |
| `src/main/rpc.ts` | **rpc 白名单**，IPC 和 HTTP 共用这一张表 | §13.1 |
| `src/main/main.ts` `preload.cjs` | 主进程、contextBridge | §12 |
| `src/renderer/` | React 界面：侧栏 + 封面墙 + 阅读器 | §6 等 |

**端到端验过的**（不是只跑单元测试，是对着真实运行的应用走 HTTP 接口）。
⚠️ **走 HTTP 接口验过只证明后端是好的，不证明界面上够得到**——下面这份清单里的
「重命名撤销」就曾经是 rpc 好使、界面上根本没有入口，见 `docs/lessons.md`「定期清点：哪些 rpc 界面上根本调不到」那节：
扫描入库（UTF-8 + GBK 两本，卷和章节切对，备份目录和过小文件被滤掉）、
增量扫描、**改名后判为 moved 且进度不丢**、按字节偏移读 GBK 正文、
清洗生效、繁简转换来回切、标签筛选、重读计数、书签、
全文搜索（三字走 FTS5、两字回落 LIKE）、导出 EPUB/txt/CSV、
备份恢复、以及**重命名的预览→执行→撤销→总开关**全套安全阀。

**打包实测过**：`npm run dist` 出 NSIS 安装包 + 便携版 zip，
并且**真的启动了打包后的 exe** 验证过——接口就绪、迁移跑到最新版、
rpc 方法全部可用、opencc 繁简转换正常。

**这里不记 rpc 有几个**——原来写的是「当时 121 个可用（这个数一直在长，别照抄）」，
**一句「别照抄」自己带着一个会过期的数**，而它当场就过期了（同本文件开头
那段警告自己栓过的那一次）。要准数就 `node scripts/counts.mjs`：
它按 `rpc.ts` 和 `main.ts` 两张表去重数（`font.list` 在两边都有、以后者为准）。

## 依赖：runtime 只有一个，而且不是原生模块

**`opencc-js` 是唯一的运行时依赖**——繁简转换，词组级，单字映射表做不到
「头发→頭髮 / 发现→發現」这种区分，而主进程真的要 require 它。

`react` / `react-dom` 刻意放在 **devDependencies**：它们只在渲染进程用，
已经被 Vite 编进 `dist/`，放 dependencies 只会让安装包白白变大。
其余开发依赖是 `electron` / `vite` / `typescript` / `electron-builder` / `@types/*`。

**其余全部用 Node 自带的**，每一条都是实测后的选择，别"顺手"换成第三方库：

| 本来会用的库 | 实际用的 | 为什么 |
|---|---|---|
| `iconv-lite` | `TextDecoder` | 自带 ICU 已覆盖 gbk/gb18030/big5/utf-16 |
| `better-sqlite3` | `node:sqlite` | 没有原生模块要重编译 |
| `glob` / `minimatch` | `path.matchesGlob` | spec §1.1 的忽略规则都能表达 |
| `chokidar` | `fs.watch({recursive:true})` | Windows 上实测可用 |
| `jszip` / `archiver` | `src/core/zip.ts` + `node:zlib` | EPUB 只需要**写**，六十行搞定 |
| `axios` / `node-fetch` | 全局 `fetch` | 探活和 WebDAV 只用到 GET/PUT |
| `vitest` / `jest` | `node:test` | 零配置，`.ts` 由 Node 直接跑 |

## 常用命令

| 命令 | 干什么 |
|---|---|
| `npm start` | 跑应用（要先 `npm run build`，否则窗口白屏） |
| `npm run dev` | 只起 Vite 开发服务器。主进程要另开一个终端，带上 `VITE_DEV_SERVER_URL` 环境变量再 `npm start` |
| `npm run build` | 构建渲染进程到 `dist/` |
| `npm test` | 跑测试（Node 自带的 `node:test`） |
| `npm run typecheck` | `tsc --noEmit`，只查类型不产出文件 |
| `npm run lint:ui` | 一组静态走查（**当场看 `package.json` 的 `lint:ui`，别在这儿记个数**——原来写「三个」，加了 `dup-decls.mjs` 之后它就成了假的）：`dead-fields.mjs`（算出来了没人读的字段）+ `dead-mounts.mjs`（挂不上的组件）+ `stale-refs.mjs`（注释里指向的文件/函数还在不在）+ `dup-decls.mjs`（同名的第二份声明）。**「漏进界面的 markdown 星号」不在这里**，它判据硬、结果二值，所以进了 `npm test`（`src/renderer/no-literal-markdown.test.ts`）。也**不含 `scripts/ui-check/` 那几个**——它们要一个跑着的应用，见后面「走查工具已经有了」那节 |
| `npm run dist` | 出 NSIS 安装包 + 便携版 zip，产物在 `release/`。⚠️ **`npm ci` 之后第一次打包会失败**，见下 |
| `npm run dist:dir` | 只打包不做安装器，用来快速验证打包后能不能跑 |

⚠️ **`npm ci` 之后直接 `npm run dist` 会失败**，报的是
`The specified electronDist does not exist: node_modules/electron/dist`。

**这不是坏了，是现在的 Electron 就这么设计的。** `electron` 那个包本体只有几百 KB，
真正的 Chromium 要单独下——而**从 Electron 42 起，它不再有 `postinstall`**，
改成暴露一个显式的 bin：

```
"bin": { "electron": "cli.js", "install-electron": "install.js" }
```

（41 只有 `electron` 一个 bin，42/43/44 都有 `install-electron`。装好的
`node_modules/electron/package.json` 里**一个 `scripts` 字段都没有**，
所以 `npm ci`、`npm install`、`npm rebuild electron` 谁都不会去下它。）

所以装完依赖要自己补一步，本机有缓存时是秒级：

```powershell
npx install-electron            # 或 node node_modules/electron/install.js
```

判断有没有到位：`node_modules/electron/path.txt` 是空的、或者没有
`node_modules/electron/dist/`，就是还没下。

这条在两种场合一定会撞上：**干净机器上第一次打包**，以及**任何一次重装依赖之后**
（这一轮撞了三次：`npm ci` 一次、升 43.5.1 一次、升 44 一次，每次同一个症状）。
`npm test` / `typecheck` / `build` 都不碰那个二进制，所以四道闸门全绿也说明不了包打得出来
——同这份文档里那句「别把『CI 绿了』当成『包打得出来』」，只是这次断在更前面一步。

⚠️ **两条猜错过的，别再查一遍**：不是环境里设了 `ELECTRON_SKIP_BINARY_DOWNLOAD`
（没设），也不是 `~/.npmrc` 指向 npmmirror 的锅——**换回官方 registry 重装，
结果一模一样**（官方源的 `electron@44.1.1` 同样没有 `scripts`）。

**CI 不受影响**：那边显式设了 `ELECTRON_SKIP_BINARY_DOWNLOAD: 1`，本来就不下二进制，
而 CI 也不跑 `npm run dist`（同一个 workflow 里专门有一节写为什么）。

**Node 下限是 24**，不是随便写的：这个仓库靠两件只有 24 才默认开启的能力——
`.ts` 原生剥类型（23.6+ 才不用加 flag）和 `node:sqlite`。Electron **44** 自带
Node 24.19.0（42/43 也都是 24.19.0，这条线很稳），跟开发机同一个大版本，
所以主进程**没有任何构建步骤**，
`.ts` 直接跑（实测过）。只有渲染进程那半需要 Vite。

数据库真实路径（Windows）：`%APPDATA%\shuzhai\library.db`，
展开是 `C:\Users\<你>\AppData\Roaming\shuzhai\library.db`，
旁边还有 `-wal` / `-shm` 两个侧车文件。**要拷贝或备份就三个一起**，
只拿主文件会让 sqlite 拿到对不上的 WAL。

## 三处跟 spec §12 建议不同的实现选择

都是实测出来的，**别"修"回去**：

1. **不用 `iconv-lite`。** Node 自带 ICU 的 `TextDecoder` 已经能解 gbk / gb18030 /
   big5 / utf-16，四种都实测过。少一个依赖，打包也少一份事。
2. **只留 `gb18030`，不分 `gbk`。** gb18030 是 gbk 的超集，用它解 gbk 内容结果完全
   一致，分两档只是多一个永远选不中的分支。
3. **不用 `better-sqlite3`，用 Node 自带的 `node:sqlite`。** Electron 40+ 直接自带
   Node 24（43 稳定版是 24.18.1），38/39 是 22.22，都 ≥ 22.5，这个模块全都有
   （查的是 `releases.electronjs.org/releases.json`）。于是原生模块、
   `@electron/rebuild`、`asarUnpack` 整条链都不需要。代价是它会打一行
   ExperimentalWarning。

## ⚠️ 只读连接的选项名是 `readOnly`，大写 O

写成 `readonly` **不报错、不警告，直接给你一个可写的连接**——实测真的写进去了。
`/api/query` 的只读保证全靠这一个字母。`api.test.ts` 里有两条测试守着它：一条断言
正确写法真的写不进去，另一条**故意用错误写法证明它可写**，免得哪天有人觉得第一条
是多余的把它删了。

同一处还有一条：`node:sqlite` 的 `prepare` 会**放行** `select 1; drop table x`
这样的多语句，得自己拦。真正的只读保证来自连接本身，不要退回"用关键字黑名单过滤
SQL"——那种做法总能被绕过。

顺带记两条实测结论，省得下次重新踩：

- **UTF-8 校验通过不等于就是 UTF-8。** 一段短 GBK 中文可能整段都是合法的 UTF-8
  字节（「小说」= `D0 A1 CB B5`，四个字节全是合法双字节序列）。所以 UTF-8 也要参加
  常用字打分，不能校验一过就定案。
- **别给 UTF-16 单开「数 0x00 字节」的启发式。** 那只对 ASCII 为主的文本成立；
  中文 UTF-16 里汉字两个字节都非零（第 = U+7B2C → `2C 7B`），一个 0x00 都数不到，
  而中文小说正是主要场景。所有编码走同一场打分竞赛就够了。

## 版本与「有没有更新的 API 可用」——查过了，结论是基本没有

**跟到 Electron 44（当前 44.1.1）。**

⚠️ **别在这儿记版本号**：这一节先后写过「停在 43.4.1，44 只有 beta」和
「停在 43.x 是有意的」，两句都在几天内变成假的。要看当下的数就当场查：

```powershell
npm view electron dist-tags
curl -s https://releases.electronjs.org/releases.json   # 每个大版本自带的 Node / Chromium
```

**升大版本之前先确认新版带的 Node 还是 24 线**——这个仓库的两条架构前提
（`.ts` 原生剥类型、`node:sqlite`）都押在它上面。2026-09-03 查的：42 / 43 / 44
**自带的都是 Node 24.19.0**，所以 44 在这一轴上没有障碍。

**升 44 之前逐条对过。** 44 的 8 条 breaking change 一条都打不到这个应用
（Unity/macOS 12/32 位那几条不适用；`clipboard` 移出渲染进程——我们渲染进程本来就没用它；
`net.request` 的 `Sec-Fetch-Dest` 收紧——我们用的是全局 `fetch`）。
**44 的新东西只用上了一样**（逐条对着 release notes 和装着的 `electron.d.ts` 过的）：
`Notification.remove*` 和 `MenuItem.badge` 是 macOS、`setOpacity`/`setBadgeCount`/WCO 圆角
是 Linux、`process.getSystemMemoryInfo()` 的 `available` 也是 Linux、`net.WebSocket` 和
`webFrameMain.printToPDF()` 我们没有对应功能、`webContents.setZoomMode` 用不上
（PDF/EPUB 的缩放是 pdf.js / epub.js 在页内做的，全仓 `setZoomFactor` / `zoomLevel` 0 处）、
`webContents.caretBrowsingEnabled` 是另一个功能决定、不是迁移。

**用上的那一样是 `windowStatePersistence`**（`main.ts`，记住上次拖成多大摆在哪儿）。
⚠️ **它要配一个 `name` 才生效，而漏了 `name` 不报错也不警告，就是什么都不发生**——
对照实验：带 `name` 重开是 `1010x650 @ (140,90)`（记住了），去掉 `name` 重开是
`1200x800 @ (680,296)`（回默认）。同 `readOnly` 大小写那条，**拼错不报错，只是保证没了**。
⚠️ typings 里它标着 `_Experimental_`，**退路是自己写那四十行**
（`getBounds()` + `isMaximized()` 存 `app_setting`，启动时拿 `screen` 兜显示器没了的情况），
不是回到「每次都 1200×800 居中」。
⚠️ **别给抓封面那个隐藏窗口起 `name`**：`name` 全局唯一、销毁前不许复用，重名直接抛，
而那扇窗是反复建反复销的（`cover-fetcher.ts` 那儿写了一句）。

**升上去之后按这个顺序验**（缺一条都不算数）：四道闸门 → **全量界面体检**
（Chromium 跳了大版本，排版和度量都可能变，而单元测试一条都盖不到）→
`keyboard` / `notes` / `review` 三条端到端 → 重打包并启动。
43 → 44 那次这么走完的结果：830/830、**五个分辨率 × 全部界面 0 条**、三条端到端全过、
包里 `version` 写着 44.1.1，而 `libEGL.dll` / `libGLESv2.dll` 确实不见了
（44 把 ANGLE 静态链接进主二进制，这条 breaking change 在产物上能验到）。

**小版本更要跟**——43.4.1 → 43.5.1 修的几条正好在这个应用的主路径上：`contextBridge` 传对象时
属性 getter 抛的异常**被吞掉**（整条 IPC 都走它）、数组带抛异常的 getter 会让渲染进程崩、
**CDP 的 device metrics override 在调试端断开后永久残留**（`audit.mjs` 干的就是这件事）、
以及 Windows 关机时 V8 延迟任务导致的崩溃（退出时要跑 `closeOpenSessions('quit')`）。

主进程只 import 了 `app / BrowserWindow / dialog / globalShortcut / ipcMain / Menu / protocol / shell`，
**一个废弃 API 都没有**：没有 `@electron/remote`、没有 `enableRemoteModule`，
两个 `BrowserWindow` 都是 `contextIsolation: true` + `nodeIntegration: false`，
抓封面那个隐藏窗口还额外上了 `sandbox: true` + `setWindowOpenHandler` 拒绝 +
`setPermissionRequestHandler` 拒绝。删文件走的是 `shell.trashItem`（现代写法，
不是早年的 `shell.moveItemToTrash`）。

逐个查过、**决定不用**的新东西，省得下次重新调研：

| 新 API | 为什么不用 |
|---|---|
| `RegExp.escape`（Node 24 有） | `legado.ts` 那处手写转义**不能换**：它连空格都会转成 `\xNN` 这种十六进制。而那个字符串是**存进 `clean_rule.pattern`、还要显示在规则编辑器里给人看的**，换过去等于让用户看到一串十六进制 |
| `node:sqlite` 的 `backup()` | 我们的备份是**逻辑导出**（读行写 JSON，见 `backup.ts` 顶部），不是复制库文件，用不上。真正复制文件的只有搬家那次，它需要的是 `wal_checkpoint(TRUNCATE)` 再搬主库，不是 backup |
| `node:sqlite` 的 `setAuthorizer()` | 只读保证已经由 `readOnly: true` 的连接给了，再加一层是给一个已经成立的结论加机械。而且它离「关键字黑名单」很近，本文件明确反对那条路 |
| Electron 的 `net.fetch` | 比全局 `fetch` 多的是走 Chromium 的网络栈（系统代理、证书）。现在探活和抓封面用的是全局 `fetch`，而且 `links.ts` 靠注入 `fetchImpl` 才测得了。真有人在代理后面用不了再换，那时是个需求，现在是个改动 |

**唯一真换了的一处**：`links.ts` 探活原来手写 `new AbortController()` +
`setTimeout` + `finally clearTimeout`，改成 `AbortSignal.timeout(...)`。
不是为了新而新——仓库里另外四处（`enrich.ts` 两处、`rpc.ts`、`cover-fetcher.ts`）
早就是这么写的，**它是最后一处没跟上的**，留着就是同一件事两种写法。

## ⚠️ 源码里别放裸控制字符——文件会从所有 grep 里静默消失

`suggest.ts` 的 `NUM_MARK` 和 `versions.ts` 的 `bookKey` 都拿 NUL 当分隔符
（「选一个正文里绝不会出现的字符」，这个选择本身没问题），但它们**在源码里写的是
一个真的 0x00 字节**，不是转义。后果不是运行时的，是工具链的：

`grep` / `rg` 见到 NUL 就把整个文件判成二进制，输出变成一句
`Binary file src/core/suggest.ts matches`——**不给行号、不给内容**。
于是这两个文件从所有文本搜索里消失了。全量审计时 `grep -rn NUM_MARK src/` 一行都搜不到，
看起来像这个常量根本没人用；`git diff` 也会把它当二进制。

改成 `\u0000` 这种转义就行，**值一模一样**（`bookKey` 拼出来的那个分隔符仍然是
码位 0，测试一条都没动）。仓库里现在零个裸控制字符。

**写这一条的时候又踩了一次**：往 AGENTS.md 里补这段说明的补丁脚本自己带了个真 NUL，
Python 直接报 `source code cannot contain null bytes`。**要在文里提这个字符，
就得把转义拼出来（`chr(92) + 'u0000'`），别直接敲。**

**同一类的还有别的**：本文件「`asar list` 给的是反斜杠路径」那条、
那个路径分隔符写反的 scratchpad 扫描器——共同点都是
**工具静默地什么都没找到，而「没找到」看起来和「没问题」一模一样**。

## 四条铁律

从 spec §0 抽出来。违反任何一条都是数据事故，不是风格问题。

1. **原文件内容只读。** 清洗、章节切分、繁简转换都是运行时套规则，结果不落回原 txt。
   写磁盘只有两个例外，都必须用户显式触发、带预览、可撤销，**后台流程一律不许碰**：
   - **重命名**（spec §9）。
   - **删除重复文件**（用户后加的要求，破了 spec §0.1 原本的「删除永远不做」）。
     破例之后安全阀比重命名还严，改这块前先读 `src/core/deletion.ts` 顶部那段：
     **默认一律 `shell.trashItem` 送系统回收站，绝不真删**——这一条才是让整件事风险可控的
     根本原因，删错了还能拖回来。⚠️ **有一条退路，而它也不是真删**：网络共享上根本
     没有回收站（实测 `shell.trashItem` 抛 `Failed to perform delete operation`），
     失败之后界面上会多出一个键，用户再点一次才会把文件**挪进应用自己的暂存区**
     （`userData/quarantine`，30 天没人动才清掉）。字节还在磁盘上、还拿得回来，
     所以这条铁律是**多了一个「送去哪儿」，不是被破了**。
     **默认那条路一个字节都不动**：不给暂存目录就照旧记成失败。另外只删「磁盘上确实还留着同一本书的另一个文件」的
     那些——判据分两档（内容完全相同 / 同名同作者的另一个版本），一律 `stat` 逐个确认
     副本真在。⚠️ **界面上那个分档不是 `DeleteCheck.identical` 给的**（这里原来这么写，是错的）：
     `deletion.ts` 顶上明写着 `identical` 和 `survivors` **没有被渲染进程读，这是对的，别去「修」**——
     界面确实在分档，数据来自 `versions.ts` 的 `listGroups` 给的 `exactDuplicate`，
     因为「重复的书」是一组一组摆的。详见 `docs/lessons.md`「删除的判据一度严到
     一次都触发不了」那节；文件进了回收站**之后**才动数据库记录（反过来会留下
     「记录没了文件还在」，下次扫描又收一遍）。两者共用 `rename.enabled` 这一个总开关，
     关掉后外部接口调用也一并拒绝。
   移动仍然不做——**除了上面那个暂存区**，而它搬的是「用户已经点头要删的那一份」，
   不是背着用户整理书库。
2. **不存正文。** 数据库只存元数据和 `(offset, length)` 章节索引，正文永远按偏移量从原
   txt 读。任何「顺手把正文缓存一份」的想法，先回去改 spec 再说。
3. **这几样数据不可再生**：`reading_state`（阅读进度、评分短评）、`bookmark`、
   **`highlight`（划线和上面的笔记）**、`rename_log`，
   以及 **`app_setting` 里那两行按 id 命名的设置**：`viewer.<bookId>`（PDF / EPUB
   读到第几页）和 `outline.<bookId>`（用户自己给没有目录的 PDF 加的那份目录）。
   重新扫描能恢复书和章节，**恢复不了这几样**。动它们的 schema 必须写迁移，别指望重扫兜底。

   ⚠️ **这句话已经栽过四次，一次比一次隐蔽。** 第一次是 `highlight`——后来加的表，
   这句没跟上，于是它整张表都不在备份里。当时补的教训是「加一张**表**就要一起改」，
   而第二次栽的恰恰是**不是表的那个**：`viewer.<bookId>` 是一行按 id 命名的设置，
   没有外键、`on delete cascade` 管不着，于是**五处**同时对它一无所知——
   备份不带、`canDelete` 当它「什么都没有」、孤儿判据把它清掉、合并时丢掉，
   而书架那一整套显示（卡片的「多久前」、默认排序、「在读」）也看不见它。
   更糟的是 `book.id` **会被复用**，漏清一行就会悄悄贴到另一本书上。

   第三次和第四次是**同一张表上新加的列**，比前两次还难看见：
   `bookmark.note`（书签上的笔记，写得进去，可「全库笔记」那一档只查 `highlight`，
   于是书架挂着「记过笔记」`✎ 3`、点开一条都没有）；
   `highlight.cfi`（迁移 21 加的 **EPUB 划线锚**，而 `backup.ts` 的
   select / insert 都没跟上——**整条 EPUB 划线恢复回来就是废的**：
   有 `cfi` 时 `char_offset` / `length` 是占位，`cfi` 一丢就只剩那两个占位值）。

   ⚠️ **第五次就在写下这句话的同一个下午。** 自建目录（`outline.<bookId>`，迁移 24）
   是**第二个「按 id 命名的设置」**，形状和 `viewer.<bookId>` 一模一样。
   当时做了触发器和备份、自以为走完了——**还是漏了三处**：`deletion.ts` 的
   「删了会丢什么」清单、`library.ts` 的孤儿判据、`versions.ts` 合并时的搬运。
   那三处正是 `viewer.<bookId>` 当年栓的同三处，而 `deletion.ts` 里那句
   「**每抄一份就漏一样**」就写在旁边。现在三处都补了、**各钉了一条守卫**
   （破坏实验验过会红）。下一种按 id 命名的设置加进来时，`versions.ts` 那个
   `for (const 前缀 of ['viewer', 'outline'])` 循环是唯一要改的地方。

   所以判据改成：**新开一处存用户输入的地方（表、列、或者别的什么），
   要问的不是「它进没进那张表的清单」，而是「谁在靠原来那个位置取数」**——
   逐个走一遍 `backup.ts` / `deletion.ts` / `library.ts` / `versions.ts` / `export.ts`，
   再问一句「没有外键护着的话，谁来兜底」。
   **加列和加表一样危险**：`alter table add column` 不会让任何一处报错。
   （整个过程记在 `docs/lessons.md`，搜 `viewer.` 和 `cfi`。）
4. **应用本体不接 AI。** 摘要、前情回顾、人物关系、自动打标签一律不实现。
   §13 的维护接口不算——那是把数据暴露给外部工具，应用自己不调用任何模型。

## 你（AI 工具）怎么连到数据

### 用户在这里会让你做的三类事

1. **分析** —— 「哪些书加进来就没读过」「弃坑的都是什么类型」「字数最多的十本」。
   走 `POST /api/query`，或应用没开时直接只读查库。
2. **整理** —— 批量打标签、归类、补元数据。纯数据字段，两条路都行。
   ⚠️ **「归类」有两套，别弄混**：界面上那个「分类」走的是 `shelf.*`（智能书架＝一个名字 + 一条筛选规则，**存规则不存结果**）；而 `category.*` 那几个方法和 `category` 表是**另一套**——把书归到一个分类名下，**界面上一处都不显示**（只有 `enrich` 在写、备份带着它、导出的 CSV 里有一列）。拿 `category.assign` 归完类，用户在应用里什么都看不到。要让用户看见就建智能书架。
3. **批量文件操作** —— 按模板重命名。**必须**应用开着走 rpc。

**第 3 类要特别克制**：那是真的在改用户磁盘上的文件。spec §3.3 的安全阀（预览表格、
冲突标红、超 50 个二次确认、可撤销）一条都不能省，**即使用户说「直接改吧不用看了」**
——`rename_log` 只保留最近 20 批可撤销，改错了超出这个窗口就找不回来。执行前把预览
表格摆出来让用户过目，是这个功能的一部分，不是客套。

### 走哪条路

spec §13 是完整定义，这里只给操作要点。

| 你要做的事 | 走哪条路 | 应用要开着吗 |
|---|---|---|
| 看统计、查数据、做分析 | 直接只读打开 sqlite 库，或 `GET /api/stats`、`POST /api/query` | 不用 |
| 改纯数据（标签、分类、备注、连载状态、评分短评） | 直接写库，或 `POST /api/rpc` | 看走哪条 |
| **任何碰磁盘文件的操作**（重命名、扫描、重新解析、导出） | **只能** `POST /api/rpc` | **要** |

- 端口 **30036**，只绑 `127.0.0.1`。**POST 必须带 `X-Api: 1`**，缺了直接 403
  （挡浏览器跨站，理由见 spec §13.1）；GET 不强制。
- 库开 WAL，所以应用运行中外部只读连接也安全，不用先关应用。
- **绝不直接写这几处**：`book_file.path`、`content_hash`、`chapter` 表、FTS 索引。
  前两个写了会让记录和磁盘对不上，后两个是派生数据、下次解析就被覆盖。
- rpc 的方法表**就是**渲染进程的 IPC 白名单，同一张表。你能做的和界面能做的一样多，
  安全阀（预览、`rename_log`、二次确认）也照样跑——别为图快绕过去。

### 具体敲法（这是台 Windows 机器）

`&&` 在 PowerShell 5.1 里不通，示例一律给 PowerShell 写法：

```powershell
# 库概览（GET 不用带头）
Invoke-RestMethod http://127.0.0.1:30036/api/stats

# 只读 SQL —— 分析数据的主通道。
# schema 直接问库，别照 spec §11 抄：那是设计稿（标题就写着「建议」），
# 实测多出好几张表（app_setting / smart_shelf / highlight / highlight_tag /
# delete_log / cover_fetch）和好几个列（book_file 的 parse_error / failed_at / excluded、
# reading_state 的 rated_at、clean_rule 的 sort_order / flags / whole、
# highlight 的 cfi / rect）。**这里不记几张几个**：原来写的「5 张表7 个列」
# 到下一次迁移就是假的（当场数表走 `node scripts/counts.mjs`）。库自己永远是对的：
#   select name, sql from sqlite_master where type = 'table'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:30036/api/query `
  -Headers @{ 'X-Api' = '1' } -ContentType 'application/json' `
  -Body '{"sql":"select status, count(*) as n from reading_state group by status"}'
```

**应用没启动时**（POST 会直接连接失败，报「目标计算机积极拒绝」）：分析类需求改成
直接只读打开库文件即可（路径见上面「常用命令」那节），不必让用户先去开应用；
碰文件的操作则如实说明「要先启动应用」，不要试图绕过接口自己去改文件名。

### 两条只有踩过才知道的操作坑

**不要在用户的真实书库上驱动阅读器界面。** 用 CDP 点封面、点「下一章」、点目录项，
应用会忠实地把阅读进度存进 `reading_state`——那是铁律 3 里重扫恢复不了的数据。
实测把一本书的进度从第 572 章点回了第 485 章，`reading_session` 里也留下一串
测试会话。要验界面就先把要动的那几行记下来，或者另开一个测试库。
（`docs/lessons.md`「对着用户自己那台 legado web 量过一轮」那节引的就是这一条。）

**改了 `src/core` 的代码，必须重启应用才生效。** 主进程没有构建步骤、`.ts` 直接跑，
但那是**启动时加载一次**。改完 `chapter.ts` 直接调 `book.reparse`，用的是主进程里
那份旧规则——脚本这边 import 的是新代码、算出「这 83 本要重解析」，发过去却按旧规则
重跑了一遍，结果一本没变。**发 rpc 前先对一下时间**：`GET /api/stats` 的 `startedAt` 早于你刚改的那个 `.ts` 的 mtime，就是还在跑旧代码；让用户重启后 `pid` 变了才算真的重启了。（改代码之外的场景不用管这两个字段。）

## 技术栈与进程划分

spec §12 定的，这里只列会咬人的几条：

- Electron + React + TypeScript + Vite；存储用 Node 自带的 `node:sqlite`（见上一节，
  **不是** better-sqlite3，所以没有原生模块要重编译）。
- **所有文件 I/O、SQLite、扫描、重命名一律在主进程**，渲染进程只经 `contextBridge`
  白名单 IPC 调用。`contextIsolation: true`、`nodeIntegration: false`。
- **扫描/hash/章节解析目前就跑在主进程里，没有 `utilityProcess` 也没有 worker_threads。**
  spec §12 建议隔出去，我们没做，这是个有意的取舍：章节解析虽然是同步的，但每本书之间
  都有 `await`，事件循环有喘息，实测量级是几十毫秒。判据写在 `main.ts` 那条 `ponytail:`
  注释上——**真觉得卡了再挪，接口不用改**。别把这条当成「已经隔离好了」。
- **大文件绝不 `readFile` 整本加载**：`fs.open` 拿 fd，按 `(offset, length)` 定点
  `fs.read`，句柄用 LRU 缓存（≤3 个）。这条和重命名的「文件被占用」检查直接相关。

## 库里的列是 snake_case，代码里的类型是 camelCase

`node:sqlite` 返回的行**就是数据库里的列名**，不会替你转驼峰。把 `reading_state`
直接 `as Progress` 用，`state.chapterIdx` 全是 `undefined`，再被 `?? 0` 兜成 0——
**阅读进度悄悄跳回第一章，不报错、不留痕**。这个 bug 真写出来过，被
`scan.test.ts` 的「追更」那条抓到。

做法：在 SQL 里就用 `as` 改好列名（`select chapter_idx as chapterIdx ...`），
别在 TS 那头硬套类型。顺带一条：返回的行是 **null 原型对象**，
`assert.deepEqual` 会因此判不等，测试里要先 `{...row}` 摊平。

## 章节规则来自 legado，但有两处不能照抄

`chapter.ts` 的 `BUILTIN_RULES` 大量参考 legado（阅读）的 `txtTocRule.json`——
那是本地 txt 切章的事实标准，**它那份**的 26 条是拿海量真实 txt 磨出来的。
（**我们自己的 `BUILTIN_RULES` 是 16 条**，另有 3 条 `VOLUME_RULES`——数目对不上是正常的，
它一条规则里塞的东西我们拆开了，反过来也有几条我们没收，别照着 26 去凑。）
**`gedoor/legado` 已经被掏空**（`main` 分支只剩 README），活着的镜像是
`LegadoTeam/legado`，文件在 `app/src/main/assets/defaultData/txtTocRule.json`。

两处故意不一样：

1. **卷/集/部/篇不进章节量词 `UNIT`。** legado 把它们和「章」并在一起收，
   因为它没有独立的卷概念；我们有 `VOLUME_RULES` 和两级目录，照抄会让
   「第一卷 少年游」被切成一章，两级目录当场塌成一级。
2. **legado 让用户手选规则，我们靠 `scoreRule` 自动选。** 它那些宽松规则搬过来
   会在真实书库上撞出假标题，所以三条各配了一个 `refine` 判据：
   `title-num` → `sameStem`（书名部分必须一致，否则《琥珀之剑》11.3 MB 被切成
   34 个「水元素1」「风元素3」——那是正文里的属性面板）；
   `num-sep` → `ascendingRun`（序号必须递增，否则《华娱》切出「2.85亿海外开幕」）；
   `standard` → `needsNumbered`（光有序章/番外/后记不算章节结构，
   《魅生》2.1 MB 只匹配到 13 条「番外：」就把整本切歪了）。

另外两条也是从 legado 的 `TextFile.kt` 搬来的，都在防「正文看不见」：

- **第一处命中之前的内容立成「前言」章。** 原来 `buildChapters` 从 `hits[0]` 起算，
  前面那段既不属于任何一章、也就永远读不到；安全阀只挡住「第一处命中在半本之后」，
  也就是说最多可以有半本书凭空消失。legado 的做法是把它建成一章，这里照做
  （门槛 1 KB；legado 是 600 字，少于它当书籍简介，我们没有那个字段所以放低）。
- legado 还会把**超过 100 KB 的章节机械切成 `原标题(1)(2)(3)`**（`maxLengthWithToc`）。
  这条**没有搬**：我们已经有分批渲染扛住大章，而切分会改变 `chapter_idx`，
  那是铁律 3 里重扫恢复不了的数据。要做得先想清楚进度怎么迁。

**改这个模块必须做对照实验。** 干跑用只读 sqlite 连接读 `book_file`，逐本
`parseChapters` 比对，不写库。判据分两组：可疑组（章节数少 / 有未识别章 / 有超大章）
要变好，控制组（本来就切得好的）**一本都不许变**。

### ⚠ 「章节数变多」不等于「切对了」

这条是踩出来的，而且踩得很深：`star-title` 规则原来只要求符号后面有 1–30 个字符，
于是「※※※」「◇◇◇◇」这类**场景分隔线**被当成了章节标题。干跑报告里
《光年》15→125、《藏地密码》81→498、《天机》47→191、《闻香榭》34→414 一路飘红，
**全被归进了「改善」并且真的入了库**——实际是把好好的书按分隔线剁碎，
每一章都叫「※※※」。

对照实验只比章节数会漏掉这一整类错误。**判据要看标题本身像不像一份目录**：

1. **标题多样性**——`distinct(titles) / count(titles)`。全叫「※※※」的不是目录。
   （注意：真实的书也有合理的重复，比如《红尘三部曲》三部合一个文件、每部都从
   「第一章」重新开始，305 章只有 50 种标题。所以这是**告警**不是硬判据。）
2. **标题里有可读文字**——纯符号的一律可疑。这条是硬的，全库应该恒为 0 本。

在干跑脚本里跑一遍即可，比对照组更早暴露问题。**这类干跑脚本是一次性的**——
写在 scratchpad 里、跑完就扔，仓库的 `scripts/` 下没有、也不该有它们
（它们要连用户的真实书库，进不了 CI，留在仓库里只会烂掉）。

上一轮的完整结果，包括那 2 本变坏的为什么可以接受：

| | 结果 |
|---|---|
| 全库 8172 本 | 8043 本不变 |
| 从「未识别」修好 | 32 本 |
| 章节数明显增加 | 94 本 |
| 变坏 | **2 本**：《天意》（本来那 2 章就不对）、《魔装》（见下） |

**「第N回合」的取舍是量出来的。** 全库 514 本行首出现「第N回合」，其中 513 本是正文
（体育、卡牌、打斗小说：「第二回合比赛。」），只有《魔装》拿它当章节单位。
所以 `回(?![合来事去])` 保 513 本、牺牲 1 本，那 1 本可以用章节规则编辑器单独设规则。
**别凭感觉把这个断言去掉**，要改先重跑那个普查。

**序章/番外那一支要带前瞻。** legado 原规则靠 `.{0,30}$` 限长，拦不住
「**前言**不搭后语的一句话，这是祝觉故意这么发的。」（《不可名状的赛博朋克》）
和「**扉页**上写的是歪歪斜斜的两个字，雪阳。」（《九龙拉棺》）——都才二十来字。
判据是**后面跟什么**：真标题跟行尾、空白、标点或序号（「楔子」「番外：」
「终章 无限的旅路」「尾声（一）兄弟」「番外一」），正文跟的是普通汉字。

## ⚠️ 走查工具已经有了：`scripts/ui-check/`。先跑它，别再造一遍

**这一条是拿一整轮返工换来的。** 有人（我）做了五轮界面走查——自己写 CDP 驱动、
自己造测试书库、自己截图挨个看——做完才发现 `scripts/ui-check/` 早就在那儿，
而且量的东西比眼睛准得多：**每个分辨率 × 每个界面**，量
**横向溢出 / 元素跑出视口 / 弹窗超高 / 主按钮要不要滚才够得到 /
出口（那个走人的键）要不要滚才够得到 / 点击目标 /
对比度 / 文字被硬切 / 最后一行只剩一个字**，外加 Tab 焦点走查
（含**弹窗里焦点跑不跑得出去**）和端到端 walk，全都带自检和退出码。

**分辨率和界面各有几个，看 `audit.mjs` 的 `RES` 和 `SURFACES`，别在这儿记数**——
这两张表一直在长（分辨率补过窗口下限那一档，界面补过导出、批量改状态……），
记在文档里的第二天就是错的。

跑法见 `scripts/ui-check/README.md`。它当场揪出一条我五轮都没看出来的：
「章节怎么切」的主按钮在 1280×720 下要往下滚 37px 才够得到。

**动界面之前，先把下面这些跑一遍**（`lint:ui` 是一条命令，`ui-check/` 那几个各起一次）：

```
npm run lint:ui                      # = 下面这几个静态走查，CI 里也跑
node scripts/dead-fields.mjs         # 算出来了没人读的字段
node scripts/dead-mounts.mjs         # 挂不上的组件
node scripts/stale-refs.mjs          # 注释/文档指向的文件和函数还在不在
node scripts/dup-decls.mjs           # 同名的第二份声明（渲染进程 vs core、core 内部、rpc 返回类型）

# 只读，不需要应用跑着，但**要一个真实的库**——它查的是已经躺在库里的坏行，
# 那是单元测试永远拦不住的一类（走查那个十来本的假库撞不到）。每一条查询就是一句不变式，
# 查出东西就是退出码 1。⚠️ **库可能比代码旧**（它不跑迁移）：表或列不在时它印
# 「– 没查」而不是 0——看到这一行就开一次应用让它跑完迁移再量一遍。
node scripts/integrity.mjs            # 真实库上找自相矛盾的记录（只读，默认 %APPDATA%/shuzhai）

# 封面抓取对着真实站点验一遍。**要应用开着**，而且真的出网，所以也进不了 CI。
# ⚠️ **必须逐个源看**：整条链是 起点 → 书旗 → 豆瓣 的 fallback，
# 只看整条链的话「起点坏了会被书旗接住，一路绿灯，而命中率已经悄悄掉了一截」。
node scripts/verify-cover-fetch.mjs

# 下面这几个要先起一个带 --remote-debugging-port 的实例，所以**不在 lint:ui 里**，
# 也进不了 CI（见 scripts/ui-check/README.md 的「三步跑起来」）
node scripts/ui-check/audit.mjs      # 分辨率 × 界面的客观体检
node scripts/ui-check/keyboard.mjs   # Tab 焦点
node scripts/ui-check/walk.mjs <库>  # 端到端：第一次打开 → 读完一本 → 回来找到它
node scripts/ui-check/review.mjs     # 端到端：把一批书归置好（评价体系那一批）
node scripts/ui-check/notes.mjs      # 端到端：做笔记那条线（划线→写→筛→跨书回看→漂了修回来→导出），
                                     # **txt / PDF 文字划线 / PDF 框选** 各走一遍。
                                     # ⚠️ txt 和框选那两段用的是**真鼠标**（`cdp.mjs` 的 `拖选` /
                                     # `Input.dispatchMouseEvent`），不是合成 `mouseup`：真鼠标松手后浏览器
                                     # **必然再补一个 `click`**，而那一下曾把刚弹出来的划线卡当成浮层收掉。
                                     # 合成事件不带 click，所以走查一路绿而**手一碰就是坏的**
```

顺带一条 walk 的坑：**跑第二遍会在「读完时问了要不要记一句」那步失败**，
那不是回归——「已经评过的不问」是设计，而档案目录里上一遍已经评过了。
换一个全新 `--user-data-dir` 再跑。（同 README 里「探针会骗人」那条。）

## 打包基线：只记「结构对不对」，不记体积

**产物体积一律不写进文档**——渲染包、exe、安装包、`release/` 那几个数每改一轮就变，
记下来的第二天就是错的，而且没有哪个决定是靠它们做的。要看当下的数就跑一次
`npm run build`（它自己会打印渲染包大小）或 `npm run dist:dir`。

值得记的是**打出来的包长什么样**，那才是会被改坏的：

| 量什么 | 判据 |
|---|---|
| asar 里 | **`.ts` 源码和磁盘上逐个对得上**——`src/main` + `src/core` + `src/server` 去掉 `.test.ts`，两边差集都该是空。**别在这儿记一个数**：原来写的是「48 个」，加了五个 core 模块之后它就成了假的，而「和磁盘对得上」永远不会过期。加上 `preload.cjs`。**src 下 0 个 .js**——没有编译产物，Node 原生剥类型依然生效 |
| 打包干净度 | `scripts/`（走查脚本）0 个、`.test.ts` 0 个，都没被打进去 |
| 启动 | 打包后的 exe 起得来，**接口就绪在一秒多**（`GET /api/stats` 通了就算） |

打包后走 HTTP 接口验过还能干活：扫描收 7 本、按字节偏移读一章、
**opencc 词组级繁简**（`头发和发现 → 頭髮和發現`，这是留着那个唯一运行时依赖的理由）。
（**朗读引擎那一项不用再验**：现在默认一个都不带，见 `docs/lessons.md`「朗读引擎那 88 条是用户自己的收藏」那节。）

**`asar list` 给的是反斜杠路径**，判断文件在不在之前要先归一化——
（⚠️ 反过来，`extractFile` 要的键**也得是反斜杠、而且不带前导那一个**：`listPackage` 回来的每一条都以反斜杠开头、里面也全是反斜杠，**去掉开头那一个**才取得到；归一化成正斜杠反而找不到。四种写法试一遍最省事。）
这一轮里同一个坑咬过两次（那次死 rpc 清点用的 scratchpad 扫描器也是路径分隔符写反，
结果三段全空、看起来像「一个问题都没有」）。

## ⚠️ 别拿 `git checkout <文件>` 当破坏实验的还原键

这一轮我用它还原一个故意写坏的文件——**它退的是到 HEAD，不是到我写坏之前**。
这个仓库有一百多个文件没提交，于是那一下把第六轮给 `backup.ts` 加的
`ratedAt`（备份 / 恢复 / 手动指认三处）**整个抹掉了**。

发现它的是第六轮留下的那条守卫（「评价时间也要备份」当场变红）——
**如果那一轮只改代码没留断言，这次就静默丢了**。

规矩：破坏实验一律 `cp` 一份到 scratchpad 再改，还原也用 `cp`。
`git checkout` 在工作区就是唯一副本的时候是个删除命令。

## 还没做的

**两条，都不是「功能」**：

1. **两个 workflow 都从来没有真的跑过。** `.github/workflows/` 下现在有两个：
   `ci.yml`（push 到 main / PR 时跑四道闸门）和 `release.yml`（打 `v*` 的 tag 时打包、
   给产物签一份来源证明、传成**草稿** release）。仓库还没有远程，所以两个都是零次运行——
   **一个从没跑过的 workflow 不算数**，同「一条永远绿的断言等于没有断言」。
   第一次 push 之后那次红是预期内的，照日志改就行。

   `release.yml` 留了两道口子专门对付「第一次」：**`workflow_dispatch` 能不打 tag
   手跑一遍**（验的是构建那一半，没有 tag 时上传步骤自己跳过，不会误发），
   而出来的 release 是**草稿**——**先把那个 exe 下下来真跑一次再点 Publish**。
   本地打包那条路每次都真的启动过 exe，换成 CI 就把这一步丢了，得自己补回来。

   ⚠️ 写它的时候当场撞了三个坑，都记在那两个文件的注释里，别再踩一遍：
   PowerShell 的 here-string 要顶格而 YAML 块标量要缩进（两者互斥，整个文件会被
   判成无效 workflow）、`Get-ChildItem release -Include` 不带 `\*` 返回 0 个、
   通配符不给外部命令展开。

2. **仓库元数据四项还没设，因为仓库还不存在。** 读者从链接到用上工具要过三道门，
   README 只是其中之一——另外三样（`description` / `homepage` / `topics` / 社交预览图）
   全在 GitHub 的仓库设置里，本地一个字都写不了。

   **文案和图的正本在 `build/brand/README.md`**：标语、副文、description 定稿、
   topics 建议、图标和社交卡的重新生成命令都在那儿，**这里不复述**
   （抄第二份必分叉，这个仓库栽过的次数够多了）。社交卡的成品是
   `build/brand/social-card.png`。要动名字、标语或那张卡，改那份。

   ⚠️ **`topics` 留哪几个只能等 push 之后**：`repo-facade` 那个 skill 带着一个排名脚本，
   数的是「这个 topic 里 star 比你多的仓库有几个」——排到 30 名开外基本等于没有，
   而它**要仓库真的在 GitHub 上**才跑得动（脚本不在这个仓库里，别去 `scripts/` 找）。

   ⚠️ **仓库名是 `shuzhai`，不带序号**，理由在 `build/brand/README.md` 的「仓库名」那节。
   改名要连 README 首屏那个「⬇ 下载」一起改。

（原来第 2 条是「打包链得在改名换图标之后重跑一次」：2026-08-21 重跑过一次，
2026-09-01 换了新图标又打了一次 1.0.0。两次的实测都在 `docs/lessons.md`，搜「打包实测」。
⚠️ **这里原来写的是「见下」，而这一段就是本文件的最后一行——底下什么都没有。**
`stale-refs.mjs` 查的是文件名和函数名，「见下」「见上」这种指路它查不了。）

