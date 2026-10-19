import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileViewer } from './FileViewer.tsx';
import { loadShowRating } from './settings.ts';
import type { Root } from './LibraryDirs.tsx';
import { rpc } from './rpc.ts';
import { Reader } from './Reader.tsx';
import { RuleEditor } from './RuleEditor.tsx';
import { BookEditor, type Detail } from './BookEditor.tsx';
import { 拆标签 } from './TagPicker.tsx';
import { ExtractDialog } from './ExtractDialog.tsx';
import CategoryDialog, { 筛选提示 } from './CategoryDialog.tsx';
import { RenameDialog } from './RenameDialog.tsx';
import { CleanRules } from './CleanRules.tsx';
import { SearchPanel } from './SearchPanel.tsx';
import { HighlightsPanel } from './HighlightsPanel.tsx';
import { Settings } from './Settings.tsx';
import { LinksDialog } from './LinksDialog.tsx';
import { VersionsDialog } from './VersionsDialog.tsx';
import { BackupDialog } from './BackupDialog.tsx';
import { Cover } from './Cover.tsx';
import { LibraryDirs } from './LibraryDirs.tsx';
import { RatePopover } from './RatePopover.tsx';
import { ReviewShelf } from './ReviewShelf.tsx';
import { ReviewTable } from './ReviewTable.tsx';
import { Toast } from './Toast.tsx';
import { BatchTagDialog } from './BatchTagDialog.tsx';
import { BatchStatusDialog } from './BatchStatusDialog.tsx';
import { installModalA11y } from './modal-a11y.ts';
import { TagManager } from './TagManager.tsx';
import { KeywordTags } from './KeywordTags.tsx';
import { AddBookDialog } from './AddBookDialog.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import type { Filter, ShelfCounts, SmartShelf, SortBy, Tag } from '../core/library.ts';
import { planOpen } from '../core/open.ts';
import { UNREVIEWED } from '../core/library.ts';
import type { DirNode } from '../core/library.ts';
import type { SplitIssue as BadSplit } from '../core/health.ts';
import { formatOf, extOf, BOOK_EXT, TEXT_EXT } from '../core/book-format.ts';
import { wan, relTime, sqlTime, whenAgo, activeFilterWords, displayChapters } from '../core/format.ts';
// 类型是 import type，会被完全擦除——不会像值导入那样把扫描器拖进渲染包。
// 手抄一份 interface 的代价是加一个字段要改三处，而漏抄不报错
import type { ScanReport } from '../core/scan.ts';
import type { UpdateHint } from '../core/links.ts';
import {
  loadSort, saveSort, loadView, saveView, type ViewKind,
  hydrateUserThemes, applySettings, loadSettings,
} from './settings.ts';
import { PROBLEM_FILE_STATUS, FILE_STATUS, READING_STATUS, SERIAL_STATUS, labelOf } from '../core/labels.ts';

/**
 * 书架上一本书的形状——**`book.list` 回来的行就长这样**。
 *
 * ⚠️ **导出它，不许第二个地方再抄一份。** `dup-decls.mjs` 那条守卫盯的就是这个：
 * 同一个 rpc 在两处声明成两种返回类型，加一个字段就会漏改一处，而且不报错。
 * （分类弹窗的实时预览就撞在这上面，当场被抓。）
 */
export interface Book {
  id: number;
  title: string;
  author: string | null;
  chapter_count: number | null;
  /**
   * 手填本地章数（`book.chapter_count_override`）。NULL = 用自动识别的
   * `chapter_count`；非 NULL 时**只盖过显示**（状态标/悬停/卡底三处），
   * 体检状态标和更新判断仍用真实 chapter_count。
   */
  chapter_count_override: number | null;
  word_count: number | null;
  file_status: string | null;
  reading_status: string | null;
  percent: number | null;
  chapter_idx: number | null;
  char_offset: number | null;
  /** sqlite 的 `datetime('now')`，**UTC 文本**。解析必须走 `sqlTime` */
  last_read_at: string | null;
  /** 上次读到那一章叫什么。卡片放不下，收在 title 里 */
  chapter_title: string | null;
  tags: string | null;
  /** 主文件路径。**为空 = 手工添的「读过但本地没有文件」的记录**，不是坏数据 */
  path: string | null;
  rating: number | null;
  /** 短评。卡片上悬停 ★N 就能看见——「烂尾了别看」必须在点进去之前出现 */
  comment: string | null;
  /**
   * 什么时候写的这条评价。**`listBooks` 一直在查它，只是这份类型没跟上**——
   * 于是「我的书评」那一档排得出「最近评价的在前」，却在界面上说不出
   * 每条是什么时候写的。是 UTC 文本，印之前必须走 `format.ts` 的 `whenAgo`。
   */
  rated_at: string | null;
  /**
   * 什么时候读完的。表格视图那一列，也是这个字段**第一次在界面上露面**——
   * 它一直在写（标成已读完时、翻到最后一页时、手工添读过的书时）、也一直进备份。
   * 是 UTC 文本，印之前必须走 `format.ts`。
   */
  finished_at: string | null;
  /**
   * 重读了几次。**`core/status.ts` 自增（读完之后再开读才算）、备份和导出一直带着它**，
   * 而这一份类型没跟上，于是界面上说不出「这本我又翻了一遍」。
   */
  reread_count?: number;
  /** 划线 + 书签一共几条。信息行上那个 ✎ 标记靠它（判据见 `core/library.ts` 的 `hasNotesSql`） */
  note_count?: number;
  /** 弃坑原因。和短评同一条道理，而且更该看见 */
  drop_reason: string | null;
  /** 书自己的连载状态。卡片状态标展示「连载中」和「太监」，理由见渲染那一段 */
  serial_status: string | null;
  /** 主文件的 mtime（毫秒 epoch）。没有文件的手工书是 null */
  mtime?: number | null;
  has_cover?: number;
}

/**
 * 侧栏的分档。**按阅读状态分，不按数据库字段分**——
 * 找书的人想的是「我在读什么」，不是「serial_status 等于什么」。
 */
/**
 * 这份扫描报告**有没有下一步可做**。
 *
 * 判据是用户定的：「不需要操作的时候不该出现『知道了』——多余。」
 * 这个函数决定**出不出那排按钮**：有待办（失败/缺失）才出「去处理」。
 *
 * ⚠️ 它**不再决定通知走不走**——旧规是「有动作的赖着等人点」，2026-09
 * 用户改了：所有通知到点自己走（有动作的留 `ACTIONABLE_TOAST_MS`、
 * 悬停暂停），因为待办在侧栏「需要处理」档里是持久的，通知只是引子。
 *
 * 「有下一步」＝ 有失败或缺失——那时侧栏「需要处理」那一档才有东西，
 * 报告上那个「去处理」也才有地方可去。
 * ⚠️ **跳过和「不收的格式」不算下一步**：它们是**通报**（「为什么收了 0 本」），
 * 读一眼就完事，不需要用户做任何事。所以那种报告自己走——
 * 但留得久（12 秒）而且鼠标停上去暂停，「跳过必须报出来」照旧成立。
 */
function 报告要等人处理(r: ScanReport): boolean {
  return r.failed > 0 || r.missing > 0;
}

/**
 * 带动作的通知（扫描报告上有「去处理」）停留多久再自己走。
 *
 * 用户定的：「扫描完成或类似的通知在多久没处理，应该在 N 秒后自动消失。」
 * 取 **25 秒**——Windows 通知横幅的默认时长，macOS 横幅更短（约 5 秒）、
 * Android Snackbar 最长 10 秒，桌面端这边信息更密（一行六个数 + 跳过统计），
 * 用足桌面惯例。鼠标停上去 / 键盘焦点在里面时暂停计时（`Toast` 里）。
 *
 * ⚠️ **能自动消失的前提：待办有持久的去处。** 「去处理」去的侧栏「需要处理」
 * 档带着计数，通知只是引子、不是待办本身——它走了，待办一点不少。
 * 哪天加一个「动作只活在通知里」的通知（关掉就再也找不着），那条不许自动消失。
 */
const ACTIONABLE_TOAST_MS = 25_000;

/**
 * 这一档该用哪种视图。**回落链只此一份**——三处要用它（开机、切档、还有
 * 判断视图键该不该亮），抄三份必然分叉，而分叉的症状是「从『更多』点进
 * 『我的书评』拿到的视图，和开机直接停在那一档拿到的不一样」。
 *
 * 顺序是：**用户在这一档自己选过的 → 这一档的默认（`SHELVES` 的 `view`）→ 封面墙**。
 * 「我的书评」默认表格，其余默认封面墙，就是这条链的结果。
 */
function 视图默认(shelfId: string): ViewKind {
  return loadView(shelfId) ?? SHELVES.find((s) => s.id === shelfId)?.view ?? 'wall';
}

/**
 * 这一档该按什么排。**回落链和 `视图默认` 一模一样，也只此一份**：
 * **用户在这一档自己选过的 → 这一档的默认（`SHELVES` 的 `sort`）→ 最新的在前**。
 *
 * ⚠️ 排序原来是**一个全局键**，而这个应用有两处能改它：顶栏那个下拉，和
 * **表格视图的表头**。于是「在『我的书评』的表格里点一下『评分』表头」
 * ＝「把『全部』的默认排序也改了」——用户根本不觉得自己动过什么全局设置。
 * 真实症状：刚点开读过的书在「全部」里不排第一了（它没评分，沉到八千本后面）。
 * 判据同 `SHELVES` 的 `sort` 那条：**一档有它自己的问题要答，
 * 就别让全局偏好替它回答。**
 */
function 排序默认(shelfId: string): SortBy {
  return (loadSort(shelfId) ?? SHELVES.find((s) => s.id === shelfId)?.sort ?? 'time') as SortBy;
}


/**
 * `sort` 是**这一档天然该按什么排**，切过去时自动应用。
 *
 * 起因：`ORDER.rated` 的注释上写着「「我的书评」这一档默认按它」——
 * 而 App 从来没这么做过，点开那一档拿到的仍然是「最新的在前」。
 * 于是这一档存在的理由（「我最近评过什么」）默认答不上来，
 * 得用户自己发现下拉框里那个「最近评价的在前」。
 * 上一轮刚给 `rated_at` 补了备份和导出，而它在界面上默认根本没被用到。
 *
 * 切档会覆盖当前排序，这是有意的：换一档就是换一件事。
 *
 * ⚠️ **这里原来写着「切走再回来才回到默认」——那是假的。** `排序默认()` 的回落链是
 * 「这一档存过的 → 这一档的 `sort` → 最新的在前」，**存过的排在最前**：
 * 在一档里挑过一次，以后每次回来都是它，不会自己变回默认。
 * 要回到默认只有一条路——在下拉里再挑一次（比如「我的书评」挑回「最近评价的在前」，
 * 那也是书评册那道月栏重新出现的条件，`byRatedTime` 认的就是这个值）。
 * 这是有意的：`shelf.sorts` 这个键存在的全部意义就是记住用户挑过什么。
 */
/** 「章节多半没切对」体检报出来的一条。**同一个 rpc 只能有一种返回类型**，所以抽成一个名字 */
// 形状从 core 引：手抄一份迟早掉队（这个仓库栽过八次），而这一份已经少了 `kind`

/**
 * ⚠️ `secondary` 的那几档**收进侧栏底部的「更多」**，不占主栏。
 *
 * 用户的原话：「未标记、我的书评、读过没评价、已屏蔽 这类低频率标签都该隐藏，
 * 低频率的不该出现左侧主栏」。主栏留的是**天天要点的那几个**（全部 / 在读 /
 * 想读 / 已读完 / 弃坑…），其余按计数过滤照旧。
 *
 * **是收起不是删掉。** 「已屏蔽」那一档本来就是为「屏蔽掉的书没被删、得有地方
 * 看得见」存在的；「我的书评」不固定住的话用户想找「我评过的书在哪」会看到
 * 一个不存在的入口。两条理由都还成立，只是它们不该天天占着最显眼的位置。
 */
const SHELVES: Array<{
  id: string; name: string; filter: Filter; sort?: SortBy; secondary?: true;
  /**
   * 这一档**天然该用哪种视图**，切过去时自动应用。判据和上面 `sort` 一模一样：
   * 一档有它自己的问题要答，就别让全局偏好替它回答。
   * 只有「我的书评」有——那一档的正事是读我写的那句话，不是看封面。
   */
  view?: ViewKind;
}> = [
  { id: 'all', name: '全部', filter: { excludeReadingStatus: ['dropped'] } },
  /*
   * **「在读」也有它天然的排法**：最近读的在最前——这一档存在的理由就是
   * 「接着读哪本」。默认排序（`ORDER.time`）对这一档恰好等价于「最后阅读时间倒序」，
   * 所以平时看不出问题；**而用户一旦把全局排序改成「按书名」，
   * 该接着读的那本就被埋进字母序里了**（实测：23:42:19 的排在 23:42:20 前面）。
   * 和「我的书评」拿到 `sort: 'rated'` 是同一条判据：
   * 一档有它自己的问题要答，就别让全局偏好替它回答。
   */
  { id: 'reading', name: '在读', filter: { readingStatus: ['reading'] }, sort: 'time' },
  /*
   * **「未标记」**：扫进来还没表过态的那些（迁移 17 之后的默认值）。
   *
   * 它现在和「全部」几乎重合（真实库 8172 本里 8165 本没标过——当场数的，
   * 这个数会随着你分类而变，别当常量看），
   * 看起来像那种「永远点不出新东西」的死档——**但它是会缩的那个**。
   * 批量改状态的工作流是「搜一批 → 标掉 → 再搜下一批」，
   * 而这一档就是它唯一的进度条：还剩多少没分。没有它，用户永远对着
   * 「全部 8172」干活，看不出自己前进了多少。
   * 侧栏本来就按计数过滤，全分完之后它会自己消失。
   */
  { id: 'none', name: '未标记', filter: { readingStatus: ['none'] }, secondary: true },
  { id: 'want', name: '想读', filter: { readingStatus: ['want'] } },
  // 「读完应该收起」（用户原话）：读完的书是查阅用的，不是天天点的——同上面那几档
  { id: 'finished', name: '已读完', filter: { readingStatus: ['finished'] }, secondary: true },
  { id: 'dropped', name: '弃坑', filter: { readingStatus: ['dropped'] } },
  /*
   * **「搁置」**。`READING_STATUS` 里一直有这一档（编辑弹窗和批量改状态都摆着
   * 这个选项），而侧栏**没有对应的书架**——于是标成搁置的书除了「全部」以外
   * 哪儿都不出现：不在「在读」，不在「未标记」，也不在「想读」。
   * 后端一直是好的（`book.counts` 数得到、按 `readingStatus` 也筛得出来），
   * 缺的只是这一行。**能存不能筛**，和 `minRating` 那条是同一族。
   *
   * 侧栏本来就按计数过滤，所以没人用这一档时它不占位置。
   */
  { id: 'shelved', name: '搁置', filter: { readingStatus: ['shelved'] } },
  // 「评价过」= 有星级**或**有短评。只写了句「烂尾了别看」没打分的也算——
  // 那句话恰恰是「避免重复阅读」最有用的信息
  /*
   * **这一档默认摆表格**（用户定的）。书评册仍然在，顶栏切一下就是——
   * 两种视图答的是两个问题：表格是「我这一批书的账目」（评分、状态、
   * 读到哪、什么时候读完的，一屏对比），书评册是「我当时那句话说了什么」（一次一本）。
   * 而这一档常干的事是回头清点，所以默认给账目那个。
   */
  { id: 'rated', name: '我的书评', filter: { rated: true }, sort: 'rated', view: 'table', secondary: true },
  /*
   * **「记过笔记」这一档，是让笔记在书架上存在。**
   *
   * 划线和书签原来在书架上完全看不见——认真读过、划了几十条的书，
   * 和从没打开过的书长得一模一样。**记完就找不着了**，
   * 而这个应用刚刚才把「回看」「搜索」「导出」都做齐。
   * 判据走 `hasNotesSql`（有划线**或**有书签），和卡片上那个数是同一份。
   */
  { id: 'noted', name: '记过笔记', filter: { hasNotes: true }, secondary: true },
  /*
   * **「待更新」**：连载中的书，按「本地副本到手最久」排（`stale`）——
   * 最该去看有没有新章的排第一。档内按钮「检查网上更新」逐本问主链接
   * （rpc `link.checkUpdates`，同域名间隔 2 秒、起点要开隐藏窗口，慢是有意的礼貌）。
   * 计数 0 时侧栏自动隐藏（secondary 档的现有行为）。
   */
  { id: 'updates', name: '待更新', filter: { serialStatus: ['ongoing'] }, sort: 'stale', secondary: true },
  /*
   * **「读过没评价」是这个应用唯一的待办清单。**
   *
   * 那几本书的结论此刻只在用户脑子里，而这个应用存在的理由
   * （「下次不用再想这本我看过没」）全靠它落到库里。
   * 真实库上量的：动过的 7 本，其中 6 本还没写——短得可以一次做完。
   *
   * 「读过」的口径从 `TOUCHED_STATUS` 算（整张阅读状态表去掉「未标记」和「想读」），
   * 不在这儿另抄一份。排序按最近读的在前：刚放下的那本记忆最新，最好写。
   */
  {
    id: 'unreviewed',
    name: '读过没评价',
    // 判据引 core 那一份（`UNREVIEWED`），侧栏计数和 `/api/stats` 用的是同一个——
    // 这里再抄一遍的话，「侧栏说 6 本、点进去 12 本」迟早发生
    filter: UNREVIEWED,
    sort: 'time',
    secondary: true,
  },
  { id: 'problem', name: '需要处理', filter: { fileStatus: PROBLEM_FILE_STATUS } },
  // 屏蔽掉的书**没有被删**，得有个地方能看见它们，否则用户会以为丢了
  { id: 'excluded', name: '已屏蔽', filter: { excluded: 'only' }, secondary: true },
];

/**
 * 这几档永远显示。前两个：一个是主入口，一个是这个应用的日常用途。
 *
 * **「我的书评」也必须永远显示**，虽然它一开始是 0 本——侧栏按计数过滤，
 * 而这一档恰恰要写了第一条评价才有数。不固定住的话，用户想找「我评过的书在哪」
 * 时看到的是一个不存在的入口，等于这个功能没有门。
 */
const ALWAYS = new Set(['all', 'reading', 'rated']);


/** 一次重新切分最多几本。每本都要整份读进来再解析，而那是在主进程上 */
const SPLIT_BATCH = 20;

/** 体检结果存在这儿。**存结果不存「要不要重算」**——那句查询在真实库上要 9–14 秒 */
const SPLIT_CHECK_KEY = 'library.splitCheck';

/**
 * 跳过理由的说法。**用户认得的词，不是字段名**——
 * 「太小」告诉他多半是说明文档，「目录读不了」告诉他整棵子树都没进来。
 */
const SKIP_LABEL: Record<string, string> = {
  tooSmall: '太小的文件',
  tooBig: '超过大小上限的',
  ignored: '被屏蔽规则挡掉的',
  unreadableDir: '读不了的文件夹',
  notBook: '格式不收的',
};

export function App() {
  const [shelf, setShelf] = useState('all');
  const [dirs, setDirs] = useState<DirNode[]>([]);
  /**
   * 藏起来的目录。**这是长期偏好，不是导航**——用户说「一般很少调整」，
   * 所以做成一排能一眼看全的开关，而不是要点开点回去的树。
   * 存 localStorage：和排版一样是可再生偏好，丢了重设一次就行，不值得写迁移
   */
  /**
   * 用户自己定的**分类**。一个分类 = 一个名字 + 一条规则（`smart_shelf`）。
   *
   * 「按文件夹」和「按评分」原来各占书架上面一排开关，而它们**太粗**：
   * 一个文件夹里什么都有，三星以上横跨所有题材。现在它们退回到分类编辑器里
   * 当字段，界面上只摆分类——用户要的是「某某文件夹里四星以上的那些」，
   * 那是几条规则的组合，不是任何一条单独拿出来。
   */
  const [cats, setCats] = useState<SmartShelf[]>([]);
  const [pickedCat, setPickedCat] = useState<number | null>(null);
  const [editCat, setEditCat] = useState<SmartShelf | null>(null);
  /**
   * 默认按文件时间——`book.updated_at` 在全库扫描后成千上万本是同一个值，排了等于没排。
   *
   * **跨重启记住**（`loadSort`）：这是长期偏好，判据和那排目录开关同一条。
   * 标签和星级开关故意**不**记：那是「此刻想看什么」的导航动作，不是偏好。
   */
  const [sort, setSort] = useState<SortBy>(() => 排序默认('all'));
  /**
   * 这一堆书**怎么看**。和档位是两个轴，说明在 `settings.ts` 的 `loadView` 上。
   *
   * ⚠️ **每一档各记各的**，所以开机也要按当前那一档取（初始档是 `all`）。
   * 取不到就回落到这一档自己的默认——那条链只此一份，写在 `视图默认` 里。
   */
  const [view, setView] = useState<ViewKind>(() => 视图默认('all'));
  /**
   * **临时筛选**：分类弹窗里那套条件，「就这么筛」但不存成分类。
   *
   * 和分类**互斥**，不是叠加：两者答的是同一个问题（「现在看哪一堆」），
   * 而它们键相同（都可能有 `minRating`），叠起来说不清谁盖谁。
   * 所以设一个就清掉另一个，屏幕上永远只有一条规则在生效。
   */
  const [adhoc, setAdhoc] = useState<Filter | null>(null);
  const [keyword, setKeyword] = useState('');
  const [typed, setTyped] = useState('');
  const [books, setBooks] = useState<Book[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [rootCount, setRootCount] = useState(0);
  // 大库上一次铺几千张封面会卡死，按页加载
  const PAGE = 120;
  /** 已经铺出来多少本。滚到底是**追加**下一页，不是把 limit 调大重取一遍——
   *  后者在 8000 本的库上要来回传 92.8 MB（实测），追加只要 2.5 MB。
   *  用 ref 不用 state：refresh 要读它但不该因它重新创建 */
  const shownRef = useRef(PAGE);
  const [atEnd, setAtEnd] = useState(false);
  const loadingMore = useRef(false);
  /** 每换一次筛选条件就 +1。在途的「加载下一页」回来时对不上号就丢掉，
   *  否则会把上一档筛选的书追加到新列表后面 */
  const gen = useRef(0);
  /** 滚到底的哨兵节点 + 它的 observer。用 IntersectionObserver 而不是监听 scroll
   *  事件——后者每滚一像素都要算一次，而这里只关心「它进没进视口」 */
  const sentinelEl = useRef<HTMLDivElement | null>(null);
  const sentinelIo = useRef<IntersectionObserver | null>(null);
  /** loadMore 走 ref：哨兵的回调 ref 身份必须稳定（只在节点装卸时触发），
   *  不能跟着 loadMore 的 useCallback 身份变而被 React 反复解绑重绑 */
  const loadMoreRef = useRef<(() => void) | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ file: string; done: number } | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);
  /**
   * 切得可疑的书。**扫描完顺手体检一遍**——内置的章节规则会随版本改好，
   * 而库里的书还是当初扫描时算出来的结果；重新解析这个动作一直有，
   * 缺的是「知道该对哪几本用」。判据是纯 SQL、不读正文，真实书库
   * （658 万章）实测 **5.6 秒**（数字以 `core/health.ts` 里那份为准，
   * 同一个测量不要在两处各记一个数）。摆在扫描报告里而不是另开一个入口：
   * 用户刚扫完库，正在「整理」的心境上。
   */
  const [badSplits, setBadSplits] = useState<BadSplit[]>([]);
  /** 上次体检是什么时候。**只显示，不据此重算**——那句查询要 9–14 秒 */
  const [splitCheckedAt, setSplitCheckedAt] = useState<string | null>(null);
  const [splitMsg, setSplitMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 连载更新提示：hints / updateIds 本任务先建好，Task 13 角标直接消费
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  // 「需要处理」档里批量清理失效文件的两段式确认（同改名超 50 个那一下，不走原生 confirm）
  const [cleanupArmed, setCleanupArmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [hints, setHints] = useState<UpdateHint[]>([]);
  const loadHints = useCallback(async () => {
    try { setHints(await rpc<UpdateHint[]>('link.updates')); } catch { /* 角标是锦上添花，失败静默 */ }
  }, []);
  useEffect(() => { void loadHints(); }, [loadHints]);
  const updateIds = useMemo(() => new Set(hints.filter((h) => h.hasUpdate).map((h) => h.bookId)), [hints]);

  const [reading, setReading] = useState<{ id: number; title: string; at: number; off?: number } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [ruleFor, setRuleFor] = useState<{ id: number; title: string } | null>(null);
  const [linksFor, setLinksFor] = useState<{ id: number; title: string } | null>(null);
  const [renaming, setRenaming] = useState<number[] | null>(null);
  /** 正在评价哪一本。浮层贴着卡片，不是全屏对话框 */
  const [rating, setRating] = useState<Book | null>(null);
  /** 当前筛选命中多少本（不是已加载多少本） */
  const [matched, setMatched] = useState<number | null>(null);
  /** 从「按书名打标签」点进来时预填的标签名 */
  const [tagNames, setTagNames] = useState<string[]>([]);
  /** 正在导出哪一本。不传就是导全库元数据 */
  const [exporting, setExporting] = useState<{ id: number; title: string } | null>(null);
  /**
   * 标签筛选。**单选、默认收起**（`tagBarOpen`）：标签有几十个，不按标签浏览时
   * 一枚入口都嫌占地方。
   *
   * 开关（「标签 ▾/▴」）是**钉在分类排右缘的独立按钮**（`.shelf-bar` 里
   * `.shelf-tabs` 的兄弟，不在横滚的页签条里面）：展开、收起、选中标签、选了
   * 分类冒出「改规则」——它的位置一律不变（用户反馈：按钮不该跳来跳去）。
   * 展开后的标签列表在分类页签**下面另起一块**（`.tag-row`），**换行多行**、
   * 限高内滚。
   *
   * 点标签是**换选**（和分类一个手势：点亮着的取消、点没亮的只看它一个）。
   * ⚠️ **生效中的筛选必须看得见**——但看得见的位置是开关自己：折叠后有标签
   * 生效时，开关呈选中填充态（aria-pressed），悬停还挂着标签名；不是强制摊开
   * 那整块（多行面板占着竖向空间，筛上之后用户要把地方还给书架）。
   *
   * 补这个是因为：整套标签功能做完了，却没有按标签浏览的入口——
   * 归完类找不到，等于白归。
   *
   * 状态仍是 id 数组：后端筛选和「存成分类」都收 tagIds（规则里照样可以有
   * 多个标签取交集），单选只是书架这排开关的手势。
   */
  const [allTags, setAllTags] = useState<Array<{ id: number; name: string; count: number }>>([]);
  const [pickedTags, setPickedTags] = useState<number[]>([]);
  /** 标签那块摊开没有。默认收起；有生效标签时折叠是允许的（开关自己显示选中态） */
  const [tagBarOpen, setTagBarOpen] = useState(false);
  /**
   * 「几星以上」。null = 不限。
   *
   * `Filter.minRating` 在 core 里一直实现着、校验着、也有测试，
   * **而界面上没有任何入口**——和当年 `tag.add` 那个「能筛不能建」的死循环
   * 是同一个形状，只是反过来：能存不能筛。
   * 按评分排序（`ORDER.rating`）不能替代它：排序只是把高分放前面，
   * 挡不住「玄幻 + 4 星以上」这种问法。
   */
  // `minRating` 不再是一个独立开关——它是分类规则里的一个字段（见 `cats`）
  const [dialog, setDialog] = useState<
    'settings' | 'clean' | 'search' | 'notes' | 'versions' | 'backup' | 'extract' | 'dirs' | 'batchTag' | 'batchStatus' | 'tags' | 'keywords' | 'addBook' | 'exportMeta' | null
  >(null);

  /**
   * **Esc 关掉最上面那一层浮层。**
   *
   * 原来一个弹窗都不认 Esc，只能点「关闭」或者点背景。实测能叠出
   * 「标签管理压在《剑起苍茫》编辑框上面」这种两层，而按 Esc 一层都退不掉——
   * 阅读器里 Esc 是「回书架」，用户到了书架这边自然也会按它。
   *
   * **一处收口，不是每个弹窗各挂一个监听**：关掉的顺序按「后开的先关」，
   * 所以这张表从下往上看就是叠放次序。`reading`（阅读器）不在表里——
   * 那不是浮层，它自己有 Esc 回书架。
   */
  /*
   * 弹窗的键盘可达性：焦点进得去、跑不出来、关掉能回原处。
   *
   * **挂一次管全部 18 个弹窗**——它们共用同一套 `.modal-backdrop` > `.modal` 标记，
   * 所以不用去改那十八个文件（那就是抄十八份）。实现和为什么见 `modal-a11y.ts`。
   */
  useEffect(() => installModalA11y(), []);

  /*
   * 用户自己的纸色（导进来的 + 调过色的）**存在库里**，见 `settings.ts` 那段。
   * 库是正本、进程里是缓存，开机灌一次；灌完把纸色重新贴一遍——
   * **不贴的话开机头几帧用的是缓存空着时的那份**，用户会看到纸色闪一下。
   */
  useEffect(() => {
    void hydrateUserThemes(
      (key) => rpc<string>('setting.get', { key }),
      (key, value) => rpc('setting.set', { key, value }),
    ).then(() => applySettings(loadSettings()));
  }, []);

  useEffect(() => {
    const layers: Array<[unknown, () => void]> = [
      [rating, () => setRating(null)],
      [exporting, () => setExporting(null)],
      [linksFor, () => setLinksFor(null)],
      [ruleFor, () => setRuleFor(null)],
      [renaming, () => setRenaming(null)],
      [editing, () => setEditing(null)],
      [editCat, () => setEditCat(null)],
      [dialog, () => setDialog(null)],
    ];
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      /*
       * **弹窗里面自己处理掉的 Esc，这里不许再抢一次。**
       *
       * 标签管理的行内改名、设置里的快捷键录制，都拿 Esc 当「取消这一步」，
       * 而事件会接着冒泡上来——不挡的话按一次 Esc 既取消了改名、又把整个弹窗
       * 关掉了。用 DOM 自带的 `defaultPrevented` 当握手协议，不另造一个：
       * 谁处理了谁 `preventDefault()`。
       */
      if (e.defaultPrevented) return;
      const closeTop = layers.find(([open]) => open !== null)?.[1];
      if (!closeTop) return;
      e.preventDefault();
      closeTop();
      /*
       * **Esc 也要刷新书架。** 每个弹窗的 `onClose(changed)` 都带着「改没改过」
       * 回来，App 据此决定要不要 refresh；而这里只调裸 setter，那条信息就丢了——
       * 加完书库目录按 Esc、改完标签按 Esc，事情做了，书架还是旧的。
       * App 看不到组件内部那个 changed 标记，所以一律刷一次（约 200ms）。
       */
      void refresh();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rating, exporting, linksFor, ruleFor, renaming, editing, editCat, dialog]);

  // 搜索框边打边筛，但等手停下来——大库上每敲一个字查一次太浪费
  useEffect(() => {
    const t = setTimeout(() => setKeyword(typed.trim()), 280);
    return () => clearTimeout(t);
  }, [typed]);

  /**
   * 这一屏为什么空。**优先级 = 从上往下第一个命中的**，不靠缩进维持。
   *
   * 筛选条件排在书架档位前面：一个评过 40 本书的人点开「我的书评」再点个标签，
   * 看到的不该是「还没有写过书评，去点评价」——那既在教他做已经做过的事，
   * 又把真正的原因（标签把结果筛空了）藏了起来。
   */
  const emptyHint = () => {
    /*
     * ⚠️ **条件不止一个时，不能把空结果归给其中某一个。**
     *
     * 原来第一句是「没有书名、作者或别名里带「X」的书」，而它排在最前面——
     * 于是搜「连载」（真有 1 本）再点一个那本书没有的标签，屏幕上说的是
     * **「没有带「连载」的书」，那是假话**。用户会以为搜索坏了，或者书没了。
     * 这和本文件记的 `canDelete` 那条是同一个形状：拦下来的理由说的不是真正那一样。
     *
     * 所以先数一遍此刻生效的条件；**超过一个就一条都不归因**，
     * 把它们列出来，让用户自己去掉一个。只剩一个条件时才讲那句具体的话。
     */
    const conds = [
      ...activeFilterWords({
        keyword,
        tagNames: allTags.filter((t) => pickedTags.includes(t.id)).map((t) => t.name),
        shelfName: shelf === 'all' ? null : SHELVES.find((x) => x.id === shelf)?.name ?? null,
        categoryName: cats.find((c) => c.id === pickedCat)?.name ?? null,
      }),
      // 临时筛选那几条也算条件——**漏掉的话空结果会赖到别的条件头上**，
      // 而那正是这段代码存在的理由（第九轮那条「不许归错因」）
      ...活着的筛选条件,
    ];

    if (conds.length > 1) {
      return (
        <>
          没有<strong>同时</strong>满足这几个条件的书：{conds.join('、')}。
          <br />
          去掉一个条件再看看——多半是其中某一条把结果筛空了。
        </>
      );
    }

    if (keyword) return <>没有书名、作者或别名里带「{keyword}」的书。</>;
    // 书架这排标签开关是单选（pickedTags 至多一个）；多个标签取交集只可能来自
    // 分类/临时筛选规则，那几条在上面 conds 里已经按名字列出来了
    if (pickedTags.length === 1) return <>这一类里没有带这个标签的书。</>;
    /*
     * **分类圈不中书**——用户报的就是这一条。
     *
     * 走到这儿说明「分类」是此刻唯一生效的条件（多于一个在上面就列出来了），
     * 而它原来一路落到最后那句兜底的「**这一档还没有书**」——
     * 那是**归错了因**：档位是「全部」，一本没少，是这条分类的规则圈不中。
     * 用户看到的是一句和他刚做的事对不上的话。
     *
     * 最常见的成因是**这条规则指着的书库目录被移掉了**（规则里存着 `dir`），
     * 所以那句话要说出来——否则他只知道「没书」，不知道为什么。
     */
    if (pickedCat !== null) {
      const 这个分类 = cats.find((c) => c.id === pickedCat);
      /*
       * ⚠️ **只有规则里真带着目录时才提那句「文件夹不在了」。**
       * 那是这类空结果最常见的成因（`root.remove` 只把 `root_id` 置空、
       * 书都还在，于是按 `dir` 筛的规则一本也匹配不上），**但不是唯一的**——
       * 一条「五星 + 玄幻」的规则圈不中书跟文件夹毫无关系。
       * 对着一个没有 `dir` 的规则说这句，就是本文件反复警告的**归错因**。
       */
      const 带目录 = 这个分类?.filter.dir !== undefined;
      return (
        <>
          没有符合分类「{这个分类?.name}」的书。
          {带目录 && <>常见的原因是它规则里指的那个文件夹已经不在书库里了。</>}
          <br />
          点上面那排的「全部」回到整个书库，或者双击「{这个分类?.name}」改它的规则。
        </>
      );
    }
    // 临时筛选同理：只有一个条件时也得说清是哪一条，以及怎么撤掉
    if (adhoc) {
      return (
        <>
          没有符合这条筛选的书：{活着的筛选条件.join('、')}。
          <br />
          点上面的「不筛了」回到整个书库。
        </>
      );
    }
    if (shelf === 'excluded') return (
      <>书架上没有藏起来的书。设一条屏蔽规则、或者在「书库文件夹」里停掉、移除一个文件夹，那些书会到这里。</>
    );
    if (shelf === 'updates') return (
      <>
        还没有标「连载中」的书。在书的信息里能改连载状态，或到「设置」里按目录名批量标记；抓封面时也会自动认出一部分。
      </>
    );
    // 「我的书评」是这个应用的立身之本，空的时候要说清怎么写第一条
    // 现在有两条路能写：读完时会主动问，平时也能自己去评。**先说不用费力的那条**
    if (shelf === 'rated') {
      return (
        <>
          还没有写过书评。一本书读到最后一页时，这里会主动问你一句；
          <br />
          平时想写，把鼠标移到封面上点「评价」也行。
        </>
      );
    }
    /*
     * **待办清空的那一刻**。这一档平时按计数隐藏，所以「空着」只有一种走法：
     * 用户站在里面、把最后一本写完了。那时候通用的「这一档还没有书」
     * 是句怪话——他刚做完，不是「还没有」。
     */
    if (shelf === 'unreviewed') return <>读过的书都写过一句了。</>;
    return <>这里还没有书。</>;
  };

  /*
   * 标签面板**换行多行、限高内滚，全部列出来**（`.tag-row`）。
   *
   * 这一处的形状变过两次，每次都是用户拍的：
   * ① 最早是换行 chip 块 +「+N」展开器——标签多了占行，改成单行横滚；
   * ② 单行横滚和分类页签混在一排分不清 → 另起一排但仍单行横滚；
   * ③ 现在回到多行（用户反馈标签就该多行才看得全），两个老问题的答案
   *    不再是「横滚」而是：**默认收起**（不看标签时整块高度为 0）+
   *    **限高约 6 行**（真实库 83 个标签全铺约 7 行，超出在面板内部纵滚，
   *    不把书架顶没）。
   *
   * 开关不在这一块里——它钉在分类排右缘（`.tag-toggle`，见下面 JSX），
   * 所以选中/取消时这一块里一枚 chip 都不增删，药丸位置不跳
   * （「不按标签筛」追加在末尾，至多影响最后一行的折行）。
   * 和分类同一个手势——点没亮的换选它、点亮着的取消。
   * 「玄幻 + 已完结」那种多标签交集在分类编辑器里照样组得出来。
   */
  const tagChips = allTags;

  /*
   * 「用评分」这个显示开关。**每次渲染读一遍**：设置弹窗一关 App 就重渲染，
   * 于是改完当场生效，不用另铺一套事件。
   *
   * ⚠️ 这上面原来还挂着一句「摆哪几档星级开关」——**那排开关连同它的 memo
   * 早就删掉了**（按评分筛降级成了分类里的一个字段），只剩注释在指着一个
   * 不存在的东西。撤掉界面上一样东西时，要顺手搜一遍还有谁在提它。
   */
  const showRating = loadShowRating();

  /** 收在「更多」里的那几档（照旧按计数过滤，`ALWAYS` 里的不看计数） */
  const 次要档 = useMemo(
    () => SHELVES.filter((s) => s.secondary && (ALWAYS.has(s.id) || (counts[s.id] ?? 0) > 0)),
    [counts],
  );

  /**
   * **横向筛选**：和「在哪一档」无关的那些条件——搜索词、标签开关、星级开关、
   * 收起来的文件夹。
   *
   * 抽出来是因为**侧栏计数要用同一份**。`book.counts` 的 `scope` 原来只带
   * `hideDirs`：那是当年为目录开关补的（「否则『全部 8172』旁边列着 153 本书」），
   * 而后来加的标签、星级、以及一直就有的搜索词都没跟上——
   * 实测点亮「★3+」之后侧栏还写着「全部 9」，书架上只有 3 本。
   * **同一个错位，同一条理由，只是新条件没人回头看那句话。**
   */
  /**
   * ⚠️ **拿规则的 JSON 当依赖，不能直接依赖 `cats`。**
   *
   * `loadCounts` 会 `setCats(list)`，那是**每次都换一个新数组**；
   * 而 `crossFilter` 一变 `loadCounts` 就跟着变、`refresh` 又依赖它——
   * 于是「取一次计数」自己触发下一次取，整个应用陷进不停刷新的循环。
   * 症状不是卡死：是**评价浮层刚打开就被冲掉**（走查那一步当场报
   * 「浮层还在=false」），而没有一个字提到刷新。
   * JSON 串对同一条规则是稳定的，循环当场断掉。
   */
  const catRule = useMemo(
    () => JSON.stringify(cats.find((c) => c.id === pickedCat)?.filter ?? {}),
    [cats, pickedCat],
  );

  const crossFilter = useMemo<Filter>(() => {
    // 分类和临时筛选**互斥**（见 `adhoc` 那段），所以这里只可能有一个是非空的
    const rule = adhoc ?? (JSON.parse(catRule) as Filter);
    return {
      ...rule,
      ...(keyword ? { keyword } : {}),
      // **标签开关和分类规则里的标签取交集**，不是覆盖：站在一个分类里再点一个标签，
      // 问的是「这个分类里带这个标签的」——覆盖掉的话点一下标签就跳出了分类，
      // 而屏幕上那个分类还亮着
      ...(pickedTags.length || rule.tagIds?.length
        ? { tagIds: [...new Set([...(rule.tagIds ?? []), ...pickedTags])] }
        : {}),
    };
  }, [keyword, pickedTags, catRule, adhoc]);

  const filter = useMemo<Filter>(() => ({
    ...(SHELVES.find((s) => s.id === shelf)?.filter ?? {}),
    ...crossFilter,
  }), [shelf, crossFilter]);

  /**
   * 侧栏计数和标签表。**只有这一份**——`refresh()` 和「改了一本书的评价」
   * 两条路都调它。
   *
   * 曾经是两份复制（连注释一起），而复制的正是「加档位就得加计数」这段警告本身：
   * 改一处漏一处，就又回到「那一档在侧栏整个消失」的老 bug。
   *
   * **每一档都要给数**：漏掉的那档会被侧栏的计数过滤吃掉。
   * `excluded` 漏了，759 本被屏蔽的书就永远看不见（而 AGENTS.md 明确要求
   * 它们找得回来）；`rated` 漏了，「我的书评」永远是光秃秃一个名字。
   */
  const loadCounts = useCallback(async () => {
    // 两趟互不依赖，并行发。串起来就是白等一个往返
    const [c, tags, list] = await Promise.all([
      // 形状从 core 引，别在这儿手抄一份——那是这个仓库栽过七次的形状
      rpc<ShelfCounts>('book.counts', { scope: crossFilter }),
      // 标签表跟着一起取：打完标签那一排开关要立刻能用，不然得重开应用才看得见
      rpc<Tag[]>('tag.list'),
      rpc<SmartShelf[]>('shelf.list'),
    ]);
    setCats(list);
    /*
     * **分类没了，按它筛的那一条也得跟着撤掉**——和下面标签那条是同一条规矩：
     * 界面必须显示正在生效的状态，做不到就别让那个状态继续生效。
     */
    setPickedCat((p) => (p != null && !list.some((x) => x.id === p) ? null : p));
    setCounts({
      // ⚠️ `all` 跟着当前筛选走（侧栏的数要是真的），`total` 是整个库——
      // **判断「这个用户有没有书」只能用后者**，理由写在 `ShelfCounts` 上
      all: c.all, total: c.total, ...c.byReading, problem: c.problem, excluded: c.excluded,
      rated: c.rated, unreviewed: c.unreviewed, noted: c.noted,
      // 星级那三档摊进同一张表（`rating5` / `rating4` / `rating3`）：
      // 侧栏的数字和开关上的数字都从这一张里取，不另开一处
      rating5: c.byRating[5], rating4: c.byRating[4], rating3: c.byRating[3],
    });
    setAllTags(tags);
    /*
     * **标签没了，按它筛的那一条也得跟着撤掉。**
     *
     * 点亮「玄幻」再去标签管理里把它删掉（或者改名撞上别的名字＝合并），
     * 那个 id 就不存在了，而 `pickedTags` 还留着它。实测（删一个正在生效的标签）：
     * 书架**从 9 本变成 0 本**，而那个开关**已经从筛选栏里消失了**——
     * 屏幕上没有任何东西说明为什么空，空状态那句话说的还是
     * 「这一档里没有带这个标签的书」，指着一个不存在的标签。
     *
     * 同第 44 轮那条（标签开关收起时要把选中的带回来）：
     * **界面必须显示正在生效的状态**，做不到就别让那个状态继续生效。
     */
    setPickedTags((p) => {
      const alive = new Set(tags.map((t) => t.id));
      return p.every((id) => alive.has(id)) ? p : p.filter((id) => alive.has(id));
    });
    // 依赖是**整份横向筛选**，不只是 hidden——标签、星级、搜索词变了，
    // 侧栏那几个数也得跟着重算，否则「全部 9」旁边列着 3 本书
  }, [crossFilter]);

  const refresh = useCallback(async () => {
    const g = ++gen.current;
    // 刷新要把已经铺开的那些书原样取回来，不能缩回第一页——
    // 滚到第 3000 本时编辑一本书，列表不该跳回顶部
    const want = Math.max(PAGE, shownRef.current);
    /**
     * **五件事互不依赖，一起发。** 原来是五个 await 排成一串，
     * 等于白等四个往返；而 `library.dirs` 还要在主进程里把八千条路径拆成目录树。
     * 「加一个目录」这种动作会连着走完整条链，串行的代价是直接摆在用户眼前的。
     */
    const [rows, matchCount, roots, dirTree] = await Promise.all([
      rpc<Book[]>('book.list', { filter, limit: want, sort }),
      // 头部要显示**筛出来多少本**，不是已加载多少本——分页之后后者永远是 120，
      // 而批量打标签作用于整个筛选结果，那个数字必须是真的
      rpc<{ n: number }>('book.matchCount', { filter }),
      rpc<Root[]>('root.list'),
      rpc<DirNode[]>('library.dirs'),
      loadCounts(),
    ]);
    if (gen.current !== g) return;
    setBooks(rows);
    shownRef.current = rows.length;
    setAtEnd(rows.length < want);
    setMatched(matchCount.n);
    setRootCount(roots.length);
    setDirs(dirTree);
  }, [filter, sort, loadCounts]);

  /** 滚到底：只取新增的那一页追加上去 */
  const loadMore = useCallback(async () => {
    if (loadingMore.current || atEnd) return;
    loadingMore.current = true;
    const g = gen.current;
    try {
      const next = await rpc<Book[]>('book.list', {
        filter,
        limit: PAGE,
        offset: shownRef.current,
        sort,
      });
      if (gen.current !== g) return;
      if (next.length === 0) {
        setAtEnd(true);
        return;
      }
      shownRef.current += next.length;
      setBooks((prev) => [...prev, ...next]);
      if (next.length < PAGE) setAtEnd(true);
    } finally {
      loadingMore.current = false;
    }
  }, [filter, sort, atEnd]);
  // 每次渲染都同步最新的 loadMore，供稳定身份的哨兵回调 ref 调用
  loadMoreRef.current = loadMore;

  /** 只有一级目录上开关。子目录跟着父目录走——列全 15 个就又「不好选」了 */
  const tops = useMemo(() => dirs.filter((d) => d.depth <= 1), [dirs]);

  /**
   * 临时筛选正在管哪几条，写成人话。
   *
   * ⚠️ **id 要在这儿翻成名字**：`activeFilterWords` 收的是中文说法，不是 id
   * ——它是纯函数，够不着标签表和 `labels.ts`。翻错的后果是屏幕上写着
   * 「「finished」」而不是「已读完」。
   */
  const 活着的筛选条件 = useMemo(() => {
    if (!adhoc) return [];
    return activeFilterWords({
      minRating: adhoc.minRating,
      finishedYear: adhoc.finishedYear,
      tagNames: allTags.filter((t) => adhoc.tagIds?.includes(t.id)).map((t) => t.name),
      statusNames: (adhoc.readingStatus ?? []).map((s) => labelOf(READING_STATUS, s)),
      serialNames: (adhoc.serialStatus ?? []).map((s) => labelOf(SERIAL_STATUS, s)),
      formatNames: (adhoc.format ?? []).map((f) => (f === 'manual' ? '只有记录' : f.toUpperCase())),
      dir: adhoc.dir ?? null,
    });
  }, [adhoc, allTags]);


  // 换书架或改关键词时回到第一页，不然会停在上一档翻到的位置。
  // 必须排在下面那个 refresh 的 effect **前面**：refresh 会读 shownRef
  useEffect(() => {
    shownRef.current = PAGE;
    setAtEnd(false);
    setCleanupArmed(false);
  }, [shelf, keyword, sort, pickedTags, pickedCat]);

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  /**
   * 把无限滚动 observer 挂到哨兵节点上（重挂前先 disconnect 旧的）。
   *
   * **root 必须是真正的滚动容器 `.main-scroll`，不能用视口（null）。** 这个应用
   * body 不滚动：`.app` 是 height:100vh + overflow:hidden，`.main` 是「固定头 +
   * `.main-scroll`（overflow-y:auto）」的 flex 列，哨兵在 `.main-scroll` 里滚。
   * 拿视口当 root 时相交要靠浏览器跨 `.app`/`.main`/`.main-scroll`
   * 好几层 overflow clip 去推，
   * 实测滚到底哨兵已进可视区却一个回调都不发，分页永远停在 120。直接拿滚动容器
   * 当 root，三视图（封面墙/表格/书评）走同一条。⚠️ `.main` 自己已经不滚了，
   * 选择器写成 `.main` 会拿到一个 overflow:hidden 的非滚动祖先（caf6c60 那个坑
   * 会原样重现）。
   *
   * 它是**回调 ref**（`ref={attachSentinel}`），身份稳定、空依赖：React 在哨兵节点
   * 出现/消失时直接调用它。这一点至关重要——进阅读器/查看器时 `App` 提前 return
   * `<Reader>`，书架整块**卸载**，回来时是一个全新的哨兵节点；而 App 组件本身没卸载，
   * 若只靠 effect（依赖 [books.length, view]），回来时这些依赖全没变、effect 不重跑，
   * observer 就一直盯着已被销毁的旧节点，「从阅读界面回到书架」后无限滚动永久失灵。
   * 回调 ref 随节点卸载时拿到 null（disconnect）、重新挂载时拿到新节点（重连）。
   */
  const attachSentinel = useCallback((node: HTMLDivElement | null) => {
    sentinelIo.current?.disconnect();
    sentinelIo.current = null;
    sentinelEl.current = node;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMoreRef.current?.();
      },
      // 提前一屏开始加载，滚到底时下一批通常已经就位
      { root: node.closest('.main-scroll'), rootMargin: '600px' },
    );
    io.observe(node);
    sentinelIo.current = io;
  }, []);

  // 回调 ref 管节点「装卸」；这里在追加一页/切视图后重挂一次：IntersectionObserver
  // 只在相交**变化**时回调，追加后哨兵若仍在 rootMargin 内（窗口极高、一页填不满）
  // 就不会再有下一次回调，重挂让它立刻按当前状态再判一次。
  useEffect(() => {
    attachSentinel(sentinelEl.current);
  }, [attachSentinel, books.length, view]);

  // 扫描进度。大库第一次扫要好几分钟，只显示「正在扫描」的话
  // 分不清是在干活还是卡死了
  useEffect(
    () => window.novel.onScanProgress((p) => setProgress({ file: p.file, done: p.done })),
    [],
  );

  useEffect(
    () =>
      window.novel.onScanDone(({ report: r }) => {
        setReport({ ...(r as ScanReport), failures: [] });
        setProgress(null);
        void refresh();
        // **定期扫描和文件监听也走这条路。** 不体检的话，这里会拿一份新报告
        // 配上一轮留下的旧名单，列出几本早就修好的书
        void checkSplits();
        // 新章收进来后「网上有更新」角标该消掉
        void loadHints();
      }),
    [refresh],
  );

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  /**
   * 加目录**顺手就扫**。
   *
   * 原来是两步：选完目录，界面提示「再点左下角『扫描书库』」——
   * 而选目录这个动作本身就表达了「把这里的书收进来」，
   * 让人再去左下角找一个按钮是把实现细节摆给用户看。
   * 第二个目录之后也一样：新加的目录不扫，加了等于没加。
   */
  const addRoot = () =>
    run('正在选择文件夹…', async () => {
      const path = await rpc<string | null>('ui.pickFolder');
      if (!path) return; // 用户取消了，不是错误
      // `root.add` 自己会扫这个新目录并把报告带回来——「加了目录但没扫等于没加」
      // 这条策略住在 rpc 层，界面上两个入口和外部工具共用同一份
      setBusy('正在读这个文件夹里的书…');
      const { report } = await rpc<{ report: ScanReport }>('root.add', { path });
      setReport(report);
      await refresh();
      // 第一次加目录**恰恰是最容易切坏的时候**（整库刚解析完），不能漏；
      // 但只在后台跑、不挡在 busy 里——体检是分块异步的（约 2 秒、块间让路），
      // 名单算完自己刷进版面。await 在这儿的话，通知已经弹出而状态栏还转着，
      // 点「去处理」的 RPC 会排在体检后面（旧实现整表查询时这一堵就是 5 秒）
      void checkSplits();
      // 新章收进来后「网上有更新」角标该消掉
      void loadHints();
    });

  /**
   * 章节切分体检。**三条「扫描完成」的路都要走它**——手动扫描、加目录、
   * 以及定期扫描/文件监听那条 IPC。漏掉后两条的后果不只是「没体检」：
   * `badSplits` 是留着的，于是新报告会配上一份**过期的名单**。
   * 失败就清空，宁可不提示也不要报一份对不上的。
   */
  /*
   * **体检结果要留下来，不能跟着扫描报告一起消失。**
   *
   * 那份名单原来只活在 `report` 那一块里：扫完看得见，一刷新就没了。
   * 体检是扫 660 万章的纯 SQL，**开机跑不起**（第 94 轮那个 830ms 的
   * 自动备份就是这么卡住首屏的），所以也不能「用户想看就现算一次」。
   *
   * 于是：算完存进 `app_setting`，之后随时读得到。用户不常扫描，
   * 而切错的书是**真的读不了**——名单不该只在那一刻出现。
   *
   * ⚠️ **跑的时候不能挡前台**：旧实现是一条同步大查询（真实库实测 5 秒），
   * 扫描通知刚弹出它就开跑，点「去处理」像死机。现在 `health.ts` 分块异步、
   * 块间让路（约 2 秒、单块 ≤56ms），三条扫描完成的路全都**不 await** 它，
   * 名单算完自己刷进版面。
   */
  /*
   * 开机读一次上次的体检结果。**只读不算**：那句查询要 9–14 秒，
   * 开机跑会把首屏卡住（同第 94 轮那个 830ms 的自动备份）。
   */
  /*
   * 迁移 17 会把「扫描留下的默认『想读』」清成「未标记」——真实库上那是 8165 本，
   * **整整一档书架当场清空**。迁移在窗口出来之前跑，不说一句的话，用户看到的只是
   * 「『想读』昨天还有七千多，今天没了」。**只提一次，看过就划掉。**
   */
  const [clearedWant, setClearedWant] = useState<number>(0);
  /** 体检名单默认折着——它是长期名单，不是每次开机都要读一遍的东西 */
  const [splitOpen, setSplitOpen] = useState(false);
  /** 侧栏底部那个「更多」展开了没有 */
  const [moreOpen, setMoreOpen] = useState(false);
  /** 侧栏底部那几个低频工具展开了没有。**别在这儿记个数**——名单会变（「书库文件夹」就提到主栏去了） */
  const [toolsOpen, setToolsOpen] = useState(false);
  /** 正在用内置查看器看的 PDF / EPUB。和 `reading`（txt 阅读器）是两条路 */
  const [viewing, setViewing] = useState<
    { id: number; title: string; viewer: 'pdf' | 'epub'; path: string; at?: number } | null
  >(null);
  useEffect(() => {
    void (async () => {
      const n = Number(await rpc<string>('setting.get', { key: 'migrate.clearedWant' }).catch(() => ''));
      if (Number.isFinite(n) && n > 0) setClearedWant(n);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const raw = await rpc<string>('setting.get', { key: SPLIT_CHECK_KEY }).catch(() => '');
      if (!raw) return;
      try {
        const saved = JSON.parse(raw) as { at: string; list: typeof badSplits };
        setBadSplits(saved.list ?? []);
        setSplitCheckedAt(saved.at ?? null);
      } catch { /* 存坏了就当没有，下次扫描会重写 */ }
    })();
  }, []);

  const checkSplits = useCallback(async () => {
    setSplitMsg(null);
    const list = await rpc<BadSplit[]>('library.badSplits')
      .catch(() => []);
    setBadSplits(list);
    // 存的是结果本身加一个时间戳——下次开机直接读，不重算
    await rpc('setting.set', {
      key: SPLIT_CHECK_KEY,
      value: JSON.stringify({ at: new Date().toISOString(), list }),
    }).catch(() => {});
  }, []);

  const scan = () =>
    run('正在扫描书库…', async () => {
      setReport(await rpc<ScanReport>('library.scan'));
      await refresh();
      // 后台算、不 await：通知弹出＝扫描这件事结束了，状态栏该立刻收起来。
      // 体检本身已分块异步（真实库约 2 秒、每块 ≤56ms 让路），不会再堵住
      // 用户点「去处理」的切换请求——旧实现一条整表查询堵主进程 5 秒
      void checkSplits();
      // 新章收进来后「网上有更新」角标该消掉
      void loadHints();
    });

  /**
   * 打开一本书。**默认接着上次读到的地方**，不是从第一章开始——
   * 「继续阅读」那张卡片去掉之后，这里就是唯一的续读入口了
   */
  /**
   * 点一本书。**「该发生什么」是纯判断，拆在 `core/open.ts`**——
   * 那四条判断的顺序是判据的一部分（PDF 要排在「没有章节」之前，等等），
   * 写在这儿就只有注释守着，现在 `open.test.ts` 逐条钉着。
   *
   * 这儿只剩「怎么做」：报错、开评价浮层、交给系统程序、进阅读器。
   */
  /**
   * **从「全库笔记」点一条：打开那本书、落到那一处。**
   *
   * ⚠️ **书要现查，不能在 `books` 里找。** `books` 是**当前书架筛选**的结果——
   * 笔记和全库搜索都是跨全库的，那本书十有八九不在这一页里。
   *
   * ⚠️ **两个状态都要先清掉。** 从一本 txt 跳到一本 PDF 时，`reading` 不清的话
   * 退出查看器会掉回**上一本书的阅读器**——而用户以为自己回的是书架。
   */
  const 打开别的书 = (bookId: number, at?: number) => {
    void (async () => {
      /*
       * ⚠️ **类型要和别处一致**（`dup-decls.mjs` 盯着「同一个 rpc 两种返回类型」）：
       * `book.detail` 在 `BookEditor` / `ReviewCard` 里都是 `Detail`，这儿也是。
       */
      // ⚠️ 泛型写 `Detail`，不是 `Detail | undefined`——**那也算两种返回类型**，
      // 守卫按泛型比。「查不到」由下面那句 `!d` 兜（`.get()` 查不到就是 undefined）
      const d = await rpc<Detail>('book.detail', { bookId }).catch(() => null);
      /*
       * ⚠️ **先退出阅读界面，再报错——顺序反了那句话就没人看得见。**
       *
       * 这两句原来排在 `if (!d)` 后面。而 App 在 `reading` / `viewing` 非空时
       * **整个 return 掉阅读界面**，书架连同通知浮层一个都不渲染——
       * 于是「这本书找不到了」被 `setError` 塞进一个当时根本不在树里的地方。
       * 用户点了一条笔记，**什么都没发生**，而这正是最像「应用坏了」的形状。
       *
       * 退回书架再报，比留在原地一声不吭好：他本来就是要离开这本书的，
       * 而落地时有一句话说清为什么没跳成。
       * （`planOpen` 那几条报错本来就是好的——它们排在这两句后面。）
       */
      setReading(null);
      setViewing(null);
      if (!d) { setError('这本书找不到了——可能已经从书库里移走。'); return; }
      /*
       * `Detail` 比书架上那个 `Book` 少几样（阅读进度、标签、字数……），
       * 而 `planOpen` 只认六个字段（见 `core/open.ts` 的 `OpenBook`）。
       * 缺的那几样在这条路上都用不到：`at` 是**显式传进来的**（笔记记着位置），
       * 而「只有记录没有文件」那一档根本不会有笔记。补成 null，不硬转类型。
       */
      const b: Book = {
        id: d.id, title: d.title, author: d.author, path: d.path,
        file_status: d.file_status ?? null, chapter_count: d.chapter_count ?? null,
        chapter_count_override: d.chapter_count_override ?? null,
        serial_status: d.serial_status ?? null, comment: d.comment ?? null,
        rating: d.rating ?? null, reading_status: d.reading_status ?? null,
        chapter_idx: null, char_offset: null, word_count: null, percent: null,
        last_read_at: null, chapter_title: null, tags: null, drop_reason: null,
        // 这条路只喂 `planOpen`（它只认六个字段），补 null 不硬转类型
        rated_at: null, finished_at: null,
      };
      // 走同一条 `open`：那四条判断（报错 / 评价 / 系统程序 / 阅读器）只此一份
      open(b, at);
    })();
  };

  /**
   * 评价浮层改了什么，**就地更新那一条，不整表重取**（代价见下面卡片那段注释）。
   *
   * 抽成一处是因为它现在有两个调用方：封面墙的卡片，和「我的书评」那一档的
   * 书评册（`ReviewShelf`）。抄第二份的话，下次改这里必然漏一处——
   * 而漏掉的症状是「在其中一个界面上打完星，侧栏的数不动」。
   */
  /**
   * 切到某一档。**只此一份**——侧栏主栏和「更多」里那两处按钮本来就在抄同一段
   * （`setShelf` + 应用这一档自己的排序），再加上视图就是第三份，
   * 而漏改一处的症状是「从『更多』里点进『我的书评』，排序/视图不跟着变」。
   *
   * 这一档没有自己的排序/视图时，回到**用户自己存下来的那个**，不是写死的默认值。
   */
  const 切到档 = (s: { id: string; sort?: SortBy; view?: ViewKind }) => {
    setShelf(s.id);
    // 排序**每一档各记各的**，回落链在 `排序默认` 里，别在这儿再写一遍
    setSort(排序默认(s.id));
    // 视图**每一档各记各的**，回落链在 `视图默认` 里，别在这儿再写一遍
    setView(视图默认(s.id));
  };

  const 评价改了 = (bookId: number, patch: Partial<Book>) => {
    setBooks((bs) => bs.map((x) => (x.id === bookId ? { ...x, ...patch } : x)));
    setRating((r) => (r && r.id === bookId ? { ...r, ...patch } : r));
    // 侧栏「我的书评」的数字和标签那一排还是要跟着变——
    // 这两个便宜（26ms + 1ms），而且不跟着变就会「看着像坏了」
    void loadCounts();
  };

  const open = (b: Book, at?: number, off?: number) => {
    const plan = planOpen(b, at, off);
    switch (plan.kind) {
      case 'error':
        setError(plan.message);
        return;
      case 'review':
        setRating(b);
        return;
      case 'view':
        // PDF / EPUB 走内置查看器（`FileViewer`）——它和 txt 阅读器是两个东西，
        // 理由写在那个文件顶上。`at` 是「从哪儿开」（页码 / 节序号），
        // 从「全库笔记」点过来时用得上；平时不传，查看器自己读上次的位置
        setViewing({ id: b.id, title: b.title, viewer: plan.viewer, path: plan.path, at });
        return;
      case 'external':
        // mobi / azw3 / djvu：没有能进渲染包的现成库，交给系统默认程序
        void rpc('ui.openFile', { path: plan.path }).catch((e: Error) => setError(e.message));
        return;
      case 'reader':
        setReading({ id: b.id, title: b.title, at: plan.at, off: plan.off });
        return;
    }
  };

  /*
   * **「管这一本书」的那几个弹窗（编辑 / 在线地址 / 章节怎么切 / 改名 / 导出这一本）
   * 在三个界面是同一层**：书架、txt 阅读器、PDF/EPUB 查看器都开得了。阅读器里点
   * 「编辑」是**就地盖一层弹窗、不退出阅读**（位置边读边存，关了弹窗还在书里）——
   * 所以抽成一份，三个 return 都摆它。这几个弹窗抄成两份的话，阅读器那一份迟早漏一个
   * （这个仓库已经被「同一份判据抄第二份」咬过多次）。
   * `bookModalOpen` 告诉阅读/查看界面「有一层弹窗压在你上面」：键盘全让给弹窗，
   * 别在背后翻页/退出（Esc 由上面那条 window 监听关弹窗）。
   */
  const bookModalOpen = editing !== null || !!ruleFor || !!linksFor || !!renaming || !!exporting;
  const bookModals = (
    <>
      {editing !== null && (
        <BookEditor
          bookId={editing}
          onClose={(c) => { setEditing(null); if (c) void refresh(); }}
          // 先关编辑弹窗再开子弹窗，两个 .modal 叠着焦点陷阱会认错最上面那一层
          onLinks={(title) => { const id = editing; setEditing(null); setLinksFor({ id, title }); }}
          onChapters={(title) => { setEditing(null); setRuleFor({ id: editing, title }); }}
          onRename={() => { const id = editing; setEditing(null); setRenaming([id]); }}
          onExport={(title) => { setEditing(null); setExporting({ id: editing, title }); }}
          /*
           * 在编辑弹窗里就地新建了分类：**侧栏那排分类页签和计数得跟着刷新**。
           * 不刷的话，用户此刻正站在「我刚建的那个分类」旁边，而侧栏里没有它——
           * 他会以为没建成，然后再建一个。
           */
          onCatsChanged={() => { void loadCounts().catch(() => {}); }}
        />
      )}
      {ruleFor && (
        <RuleEditor
          bookId={ruleFor.id}
          bookTitle={ruleFor.title}
          onClose={(c) => { setRuleFor(null); if (c) void refresh(); }}
        />
      )}
      {linksFor && (
        <LinksDialog
          bookId={linksFor.id}
          bookTitle={linksFor.title}
          onClose={(c) => { setLinksFor(null); if (c) void refresh(); }}
        />
      )}
      {renaming && (
        <RenameDialog bookIds={renaming} onClose={(c) => { setRenaming(null); if (c) void refresh(); }} />
      )}
      {exporting && <ExportDialog book={exporting} onClose={() => setExporting(null)} />}
    </>
  );

  if (viewing) {
    return (
      <>
      <FileViewer
        bookId={viewing.id}
        bookTitle={viewing.title}
        viewer={viewing.viewer}
        path={viewing.path}
        startAt={viewing.at}
        onOpenBook={打开别的书}
        // 就地盖编辑弹窗，不退出查看器（PDF/EPUB 页码存在 app_setting，关了弹窗还在原处）
        onEdit={() => setEditing(viewing.id)}
        onExit={() => { setViewing(null); void refresh(); }}
        modalOpen={bookModalOpen}
      />
      {bookModals}
      </>
    );
  }

  if (reading) {
    return (
      <>
      <Reader
        bookId={reading.id}
        bookTitle={reading.title}
        startAt={reading.at}
        startOffset={reading.off}
        onOpenBook={打开别的书}
        // 就地盖编辑弹窗，不退出阅读器（位置边读边存，关了弹窗还在这本书里）
        onEdit={() => setEditing(reading.id)}
        onExit={() => {
          setReading(null);
          void refresh();
        }}
        modalOpen={bookModalOpen}
      />
      {bookModals}
      </>
    );
  }

  return (
    <div className="app">
      {bookModals}
      {/* 分类编辑器。**建和改是同一个弹窗**——两份表单必然分叉，
          而这个仓库已经被「抄第二份」咬过八次 */}
      {editCat && (
        <CategoryDialog
          editing={editCat.id ? editCat : null}
          // id 0 ＝ 还不是一个分类，那时 `editing` 是 null，规则得从这儿喂进去
          seed={editCat.id ? undefined : editCat.filter}
          dirs={tops}
          tags={allTags}
          onClose={(changed) => {
            setEditCat(null);
            if (changed) void loadCounts().catch(() => {});
          }}
          onApply={(f) => {
            // 临时筛选和分类**互斥**（见 `adhoc` 那段）：设一个就清掉另一个，
            // 屏幕上永远只有一条规则在生效
            setAdhoc(Object.keys(f).length ? f : null);
            setPickedCat(null);
            setEditCat(null);
          }}
        />
      )}

      {dialog === 'batchTag' && (
        <BatchTagDialog
          filter={filter}
          initialNames={tagNames}
          onClose={(c) => { setDialog(null); setTagNames([]); if (c) void refresh(); }}
        />
      )}
      {dialog === 'batchStatus' && (
        <BatchStatusDialog
          filter={filter}
          onClose={(c) => { setDialog(null); if (c) void refresh(); }}
        />
      )}
      {/* 导出**这一本**的弹窗在 bookModals 里（阅读器/查看器里也开得了）；
          下面这个是「导出表格」（CSV/JSON 元数据），只在书架上用 */}
      {dialog === 'exportMeta' && <ExportDialog onClose={() => setDialog(null)} />}
      {dialog === 'addBook' && (
        <AddBookDialog
          onAdded={(_id, title) => {
            setDialog(null);
            // 搜出来让用户看见——不然「添加了」只是一句话，那本书在八千本里根本找不到
            setTyped(title);
            setKeyword(title);
            void refresh();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'keywords' && (
        <KeywordTags
          onPick={(word) => {
            // **typed 和 keyword 都要设**：keyword 平时由 typed 防抖出来（280ms），
            // 只设 typed 的话紧接着打开的对话框拿到的还是空筛选，会显示全库 8172 本
            setTyped(word);
            setKeyword(word);
            setTagNames([word]);
            setDialog('batchTag');
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'tags' && (
        <TagManager onClose={(c) => { setDialog(null); if (c) void refresh(); }} />
      )}
      {dialog === 'settings' && <Settings onClose={() => setDialog(null)} />}
      {dialog === 'dirs' && (
        <LibraryDirs onClose={(c) => { setDialog(null); if (c) void refresh(); }} />
      )}
      {/* 拿**有章节的**第一本当样本。`books[0]` 可能是 PDF 这类只编目的书，
          它章节数天生是 0，预览去读「第 0 章」会抛错，界面上就剩一句英文报错
          加一个永远转的「正在试算…」——而这个弹窗的全部意义就是那张预览表 */}
      {dialog === 'clean' && (
        <CleanRules sampleBookId={books.find((b) => b.chapter_count)?.id} onClose={() => setDialog(null)} />
      )}
      {dialog === 'versions' && (
        <VersionsDialog onClose={(c) => { setDialog(null); if (c) void refresh(); }} />
      )}
      {dialog === 'backup' && (
        <BackupDialog onClose={(c) => { setDialog(null); if (c) void refresh(); }} />
      )}
      {dialog === 'extract' && (
        <ExtractDialog onClose={(c) => { setDialog(null); if (c) void refresh(); }} />
      )}
      {/*
        * **「我的笔记」：从书架直接看全库的划线和笔记。**
        *
        * 这个面板原来只在阅读器和查看器里挂得起来——也就是说
        * **想看自己记过什么，得先随便打开一本书**，而且开的还得是「某一本」，
        * 全库那一档藏在它的第三个页签里。笔记是铁律 3 里重扫恢复不了的数据，
        * 却是全应用唯一没有顶层入口的东西。
        *
        * 点一条走 `打开别的书`：那条路已经为「全库笔记」写好了
        * （书现查不在 `books` 里找、两个状态都先清），这儿直接复用。
        */}
      {dialog === 'notes' && (
        <HighlightsPanel
          onClose={() => setDialog(null)}
          跳到别的书={(bookId, chapterIdx) => { setDialog(null); 打开别的书(bookId, chapterIdx); }}
        />
      )}
      {dialog === 'search' && (
        <SearchPanel
          onClose={() => setDialog(null)}
          onOpen={(bookId, chapterIdx) => {
            setDialog(null);
            打开别的书(bookId, chapterIdx);
          }}
        />
      )}

      <nav className="nav">
        <div className="nav-brand">
          书斋
          {/* 项目入口。开链接走主进程的 shell.openExternal（rpc 白名单里只放 http(s)），
              不在渲染进程里自己开窗——点了就交给系统浏览器。 */}
          <button
            className="nav-github"
            title="在 GitHub 上看这个项目"
            aria-label="在 GitHub 上打开项目主页"
            onClick={() => { void rpc('ui.openExternal', { url: 'https://github.com/rockbenben/shuzhai' }).catch((e: Error) => setError(e.message)); }}
          >
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
              <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </button>
        </div>

        {/* **搜索摆在侧栏最上面**（照 legado）。它原来挤在书架标题那一行里，
            和排序、三个批量按钮抢地方——而「找一本书」是这个应用里最常做的动作，
            该有一个固定的、一眼就看得见的位置。
            `type="search"` 是为了那个**原生的清除按钮**：输入框里有字时
            Chromium 自己画一个 ×，搜完一轮想看回全部书架不用全选删掉。
            **一本书都没有时整个不出现**：空库里它做不成事，
            而「第一次打开」那一刻屏幕上应该只剩「选一个文件夹」。 */}
        {(counts.total ?? 0) > 0 && (
          <input
            className="search-box"
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="搜书名 / 作者 / 别名"
          />
        )}

        {/* 品牌、搜索框在这层外面（固定）；档位多到放不下时只滚这一段，
            底部工具（`.nav-foot`）也在外面、始终够得到。判据在 shell.css 的 `.nav` */}
        <div className="nav-scroll">
        {/* **空档不显示。** 一个刚建好的库里「在读/已读完/弃坑/需要处理/已屏蔽」
            全是 0，五个永远点不出东西的档占满了侧栏最显眼的位置。
            「全部」和「在读」永远留着——前者是主入口，后者是这个应用的日常用途 */}
        <div className="nav-group">
          {SHELVES.filter((s) => !s.secondary && (ALWAYS.has(s.id) || (counts[s.id] ?? 0) > 0)).map((s) => (
            <button
              key={s.id}
              className="nav-item"
              aria-current={shelf === s.id}
              // 这一档没有自己的排序时，回到**用户存下来的那个**，不是写死的 time
              onClick={() => 切到档(s)}
            >
              {s.name}
              {/* **一律显示数字，没有就是 0。** 原来是「有值才显示」，而
                  `book.counts` 的 group by 对「一本都没有的状态」根本不返回行——
                  于是新库里「全部 0」「我的书评 0」有数字，「在读」后面空着，
                  看起来像还没算完。空着和 0 是两个意思，这里只可能是后者 */}
              <span className="count">{counts[s.id] ?? 0}</span>
            </button>
          ))}

          {/*
            * 低频那几档收在这儿。**不是删掉**——「已屏蔽」要能找得回来，
            * 「我的书评」不固定住的话用户想找「我评过的书在哪」会扑空。
            *
            * ⚠️ **正在生效的那一档就算折着也要露出来**：站在「已屏蔽」里
            * 把「更多」收起来，书架上是一堆屏蔽的书而侧栏没有任何一档亮着，
            * 看不出自己在哪儿——同「删掉一个正在生效的标签」那条。
            */}
          {次要档.length > 0 && (
            <>
              {(moreOpen || 次要档.some((s) => s.id === shelf)) ? (
                <>
                  {次要档.map((s) => (
                    <button
                      key={s.id}
                      className="nav-item"
                      aria-current={shelf === s.id}
                      onClick={() => 切到档(s)}
                    >
                      {s.name}
                      <span className="count">{counts[s.id] ?? 0}</span>
                    </button>
                  ))}
                  <button className="nav-item nav-more" onClick={() => setMoreOpen(false)}>收起</button>
                </>
              ) : (
                <button className="nav-item nav-more" onClick={() => setMoreOpen(true)}>
                  {/* 这一行的数字**不是几本**，是里面有几档——同一列其它行都是本数，
                      光一个数字会被读成「还有 1 本藏起来了」（空库里它显示 1）。
                      所以把单位写出来。 */}
                  更多<span className="count">{次要档.length} 档</span>
                </button>
              )}
            </>
          )}
        </div>

        <div className="nav-spacer" />
        </div>

        {/*
          * 管理功能沉到底部：一天用不到一次的东西，不该占着最显眼的一横排。
          *
          * **排成两列。** 竖着排是 12 行、四百多像素，而上面的书架只有 4 行——
          * 一个「找书看」的应用，半个侧栏是管理入口。两列之后高度对折，
          * 书架那几档重新成为侧栏的主体。
          *
          * 代价是名字要短。**只缩了真的放不下的两个**（「添一本读过的书」
          * 「导出书库表格」），全称放 title 里；其余五个字以内的原样保留——
          * 为了整齐把「正文净化」也缩成两个字，那是拿看得懂换看起来齐。
          */}
        {/*
          * **常驻这几个，其余收进「更多工具」。**
          *
          * 判据是「多久用一次」：
          *   - 全库搜索：天天；
          *   - 我的笔记：天天（**而且在它之前笔记根本没有顶层入口**——
          *     要看自己记过什么，得先随便打开一本书）；
          *   - 书库文件夹：见下；
          *   - 扫描书库：加了新书就用；
          *   - 设置：偶尔，但它是所有设置的门。
          * 收起来的那些是「设一次就不动」（正文净化）或者**一次性**
          * （提取书名作者、按书名打标签、导出表格）——它们不该天天占着侧栏。
          *
          * 和上面书架那个「更多」是同一个手势，理由也一样：**收起不是删掉**。
          */}
        <div className="nav-foot nav-grid">
          <button className="nav-tool" onClick={() => setDialog('search')}>全库搜索</button>
          {/* **第四个常驻。** 上面那条判据是「多久用一次」，而这一个和「全库搜索」
              是同一类东西——都是「按内容进书库」的门，一个找书里写的、一个找自己写的。
              更要紧的是：**在它之前，笔记压根没有顶层入口**，
              想看自己记过什么得先随便打开一本书。那不是「收进更多工具」，是没有门。 */}
          <button className="nav-tool" onClick={() => setDialog('notes')}>我的笔记</button>
          {/*
            * **书从哪儿来，是这个应用最根本的一件事，不该埋在折叠里。**（用户提的）
            *
            * 它原来归在「设一次就不动」那一档收起来了，而那条判据只对
            * **一个**书库目录的人成立：库空的时候首屏有「选一个文件夹」，
            * 一旦有书，首屏那句话就没了——想加第二个目录，得先想到去左下角
            * 展开「更多工具」，再认出「书库文件夹」这个名字里包含「添加」。
            * 这和本文件里反复出现的那类问题是同一个形状：
            * **功能在，入口够不着**。
            *
            * 摆在「扫描书库」前面：先有目录才谈得上扫。
            */}
          <button
            className="nav-tool"
            title="书库收哪些文件夹，哪些不要收——加目录也在这儿"
            onClick={() => setDialog('dirs')}
          >
            书库文件夹
          </button>
          {/* 侧栏这排里**只有它是个动作**，其余都是「打开某个界面」。
              用户在按之前想知道的就一件事：它会不会动我的文件 */}
          <button
            className="nav-tool"
            title="去书库文件夹里找新书和挪过位置的书，只写库，不动磁盘上的文件"
            onClick={scan}
            disabled={busy !== null || rootCount === 0}
          >
            扫描书库
          </button>
          <button className="nav-tool" onClick={() => setDialog('settings')}>设置</button>

          {toolsOpen && (<>
          {/* 「书库文件夹」提到上面常驻那排去了，理由写在那儿。
              （侧栏原来还有个「添加目录」，早就并进「书库文件夹」了——
              那个弹窗里现在真的有添加按钮，两个入口做同一件事只是占地方。） */}
          {/* **不能叫「整理书名」**——旁边就有个「批量改名」，对普通人那是同一句话，
              而一个只写数据库、一个真改磁盘上的文件（改错了超出 20 批就找不回来）。
              按钮就叫弹窗自己的名字：它做的确实是「从文件名提取书名作者」 */}
          <button className="nav-tool" title="从文件名猜出书名和作者，写进书库记录；不动磁盘上的文件" onClick={() => setDialog('extract')}>提取书名作者</button>
          <button
            className="nav-tool"
            title="添一本读过、但本地没有 txt 文件的书"
            onClick={() => setDialog('addBook')}
          >
            添读过的书
          </button>
          <button className="nav-tool" title="从书名里挑高频词，一次给一批书打上同一个标签" onClick={() => setDialog('keywords')}>按书名打标签</button>
          <button className="nav-tool" onClick={() => setDialog('tags')}>标签管理</button>
          <button className="nav-tool" title="同一本书在库里有好几个文件" onClick={() => setDialog('versions')}>重复的书</button>
          <button className="nav-tool" title="去掉正文里不属于作者的东西：制作组页脚、推广行" onClick={() => setDialog('clean')}>正文净化</button>
          <button
            className="nav-tool"
            title="把整个书库导成表格（CSV / JSON）"
            onClick={() => setDialog('exportMeta')}
          >
            导出表格
          </button>
          <button className="nav-tool" onClick={() => setDialog('backup')}>备份</button>
          </>)}

          <button
            className="nav-tool nav-more"
            style={{ gridColumn: '1 / -1' }}
            onClick={() => setToolsOpen((v) => !v)}
          >
            {/* ⚠️ **收起来也要带上「工具」两个字。**
                侧栏上有两个折叠键：上面那个「更多 N」展开的是阅读状态那几档，
                这个展开的是工具。展开时两者靠「工具」二字分得开，
                **而收起来原来都叫「收起」**——同一屏上同一个词两件事。
                （走查探针就被它绊过：那批弹窗全报「打不开」，因为它们在另一个「更多」后面。）

                ⚠️ **不带数字了。** 原来写死的是「更多工具 9」，而把「书库文件夹」
                提到常驻那排之后它当场变成假的——这类写死的数在这个仓库里
                已经飘过好几轮（AGENTS.md 开头那段警告自己就带着一串过期的数）。
                这里的数**不能像上面书架那个「更多 N」一样算出来**：那几档是
                `SHELVES` 一个数组，而这几个工具是手写的按钮，没有可数的东西。
                与其记一个会过期的数，不如不记——「还有更多」这件事，
                「更多工具」四个字已经说完了。走查认的是 `startsWith('更多工具')`，
                不受影响。 */}
            {toolsOpen ? '收起工具' : '更多工具'}
          </button>
        </div>
      </nav>

      <main className="main">
        <div className="main-head">
          <h1>{SHELVES.find((s) => s.id === shelf)?.name}</h1>
          <span className="sub">{matched ?? books.length} 本</span>
          {/*
            * **一本书都没有的时候，这一排控件全部不出现。**
            *
            * 搜索框、排序、批量打标签、批量改名——空库里它们一个都做不成事，
            * 而「第一次打开」恰恰是最需要指路的一刻：屏幕上应该只剩「选一个文件夹」
            * 那一句话和那一个按钮。摆一排点不动的灰按钮，用户要么以为自己漏了一步，
            * 要么去点一个什么都不会发生的键（预览表「一本都不变就连表头一起收掉」
            * 是同一条规矩）。
            *
            * 判据是**整个库**空（`counts.total`），不是当前筛选为空——搜不到结果时
            * 搜索框必须留着，否则改不了搜索词，那才是真的困住。
            *
            * ⚠️ **这句话曾经有两年是假的。** 判据原来写的是 `counts.all`，
            * 而 `all` 是**带着当前筛选**算出来的（`book.counts` 收 `scope`）——
            * 于是「筛出 0 本」和「库是空的」被当成了同一件事：
            * 搜一个不存在的词，搜索框自己消失，刚打的字改都改不掉；
            * 点中一个圈不中书的分类，这排控件连同下面那排分类一起消失，
            * **除了重启应用没有别的出路**。用户报的就是后面这一种。
            * 补了个不受 `scope` 影响的 `total`，`library.test.ts` 一条钉着。
            */}
          {(counts.total ?? 0) > 0 && (<>
          {/*
            * **视图切换。** 和档位是两个轴：档位＝看哪一堆，视图＝怎么看这一堆。
            * 摆在计数后面、排序前面，因为它比排序常用。
            *
            * 只有用户自己点这三个键才算偏好（`saveView`）——切档也会改视图
            * （「我的书评」天然是表格——那一档常干的事是回头清点账目），
            * 那是那一档的规矩，不该被记成偏好。
            * 和排序那个下拉一字不差的判据。
            */}
          <div className="viewpick" role="group" aria-label="视图">
            {([
              ['table', '表格', '评分、评价、状态、读完年份一屏看全'],
              ['reviews', '书评册', '我写的那句话是正文，书是落款'],
              ['wall', '封面墙', '看封面找书'],
            ] as const).map(([id, name, why]) => (
              <button
                key={id}
                className="chip"
                aria-pressed={view === id}
                title={why}
                // **存在这一档名下**，不是存成全局偏好——在「全部」里切成表格
                // 不该让「在读」「弃坑」跟着变（`settings.ts` 那段记着症状）
                onClick={() => { setView(id); saveView(shelf, id); }}
              >
                {name}
              </button>
            ))}
          </div>
          <select
            value={sort}
            onChange={(e) => {
              // **只有用户自己动这个下拉才算偏好。** 切书架也会改排序——
              // 那是 `排序默认()` 在回落（「我的书评」**没存过时**按评价时间），
              // 是那一档的规矩，不该被记成偏好
              // ⚠️ 原来这儿写的是「强制按评价时间」，而它只是回落链的最后一环，
              // 用户挑过一次之后就轮不到它了
              const v = e.target.value as typeof sort;
              setSort(v);
              // **存在这一档名下**，不是全局——在「我的书评」里挑的排序
              // 不该让「全部」跟着变（`settings.ts` 的 `loadSort` 记着症状）
              saveSort(shelf, v);
            }}
            style={{ fontSize: '0.82rem' }}
            /*
             * ⚠️ **这里原来把一句写给开发者的话塞进了 `title`**：
             * 「……SQLite 没有中文拼音排序，而八千本不可能拉到前端排」。
             * `title` 有两个身份——鼠标悬停的提示，**和这个控件的可及名称**。
             * 拿 CDP 量过：屏幕阅读器念出的就是那整句话（43 个字），
             * 而用户根本不需要知道 SQLite 是什么。
             *
             * 现在 `aria-label` 给名字，`title` 只留**用户真会撞上的那件事**：
             * 按书名排出来「丙」在「甲」前面，不说一句会以为坏了。
             * 实现上的理由是注释该干的活，不是提示该干的活。
             */
            aria-label="排序"
            title="「按书名」排的是字符顺序，不是拼音"
          >
            <option value="time">最新的在前</option>
            {/* 书评表格的「上次读」表头点一下也是这个键：表头能点出的排序必须
                在下拉里有对应项，否则 select 会显示成第一个选项（假值） */}
            <option value="lastread">最近读过的在前</option>
            <option value="title">按书名</option>
            <option value="words">字数多的在前</option>
            <option value="rated">最近评价的在前</option>
            <option value="rating">评分高的在前</option>
            {/* `finished_at` 一直在写、一直进备份，而在这之前**界面上一处都用不到它** */}
            <option value="finished">最近读完的在前</option>
            {/* 「待更新」档的默认排序；下拉里也得有，否则切到这档 select 显示成假值（lastread 那次同一个坑） */}
            <option value="stale">最久没更新的在前</option>
          </select>
          {/*
            * **「筛选」开的就是分类那个编辑器**，只是多一条「就这么筛，不存」的出路。
            *
            * 不另做一条常驻筛选条：那等于把「按评分」「按文件夹」两排开关原样搬回来
            * ——它们是**被有意撤掉的**（见下面分类那一排上面那段：当规则可以，
            * 当分类太粗，用户要的是几条规则的组合）。一个编辑器两种用法，
            * 规则的表达只有那一份，不会分叉。
            */}
          <button
            className="chip"
            aria-pressed={adhoc !== null}
            onClick={() => setEditCat({ id: 0, name: '', filter: adhoc ?? {} })}
            title={筛选提示}
          >
            筛选
          </button>
          {shelf === 'updates' && (
            <button
              className="chip"
              disabled={checkingUpdates}
              title="一本一本去访问每本书的主页，看对面更到第几章。书多的时候要几分钟，慢是有意的——不去敲人家的服务器"
              onClick={() => void (async () => {
                setCheckingUpdates(true);
                try {
                  const r = await rpc<{ checked: number; ok: number; dead: number; updated: number; withUpdates: number }>('link.checkUpdates', {});
                  setNotice(`查了 ${r.checked} 本，${r.withUpdates} 本网上有更新${r.updated ? `（取到 ${r.updated} 条最新章）` : ''}`);
                  await loadHints();
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setCheckingUpdates(false);
                }
              })()}
            >
              {checkingUpdates ? '正在检查…' : '检查网上更新'}
            </button>
          )}
          {/*
           * **批量清理「文件不见了」。** 这一档里 parse_failed 有「重新解析」可救，
           * missing 里**自己在应用外删掉的唯一一份**却谁都清不掉：扫描只标不删、
           * 整理数据库只认「内容还在别处」的残留，于是它挂一辈子红点。
           * 作用于当前筛选结果（和其它批量键一样），`cleanupMissing` 只动 missing：
           * 文件其实还在的恢复、真没了的去指针，空书整条移走、写过评价进度的留成「只有记录」。
           */}
          {shelf === 'problem' && (
            cleanupArmed ? (
              <>
                <button className="chip" style={{ fontSize: '0.82rem' }} onClick={() => setCleanupArmed(false)}>
                  取消
                </button>
                <button
                  className="chip"
                  style={{ fontSize: '0.82rem', color: 'var(--danger)' }}
                  title="不删你的任何评价、进度、标签：写过的书留成「只有记录」，只有一样数据都没有的空书才整条移走"
                  onClick={() => void (async () => {
                    try {
                      const ids = await rpc<number[]>('book.idsByFilter', { filter });
                      const r = await rpc<{ files: number; restored: number; recordOnly: number; removedBooks: number }>(
                        'library.cleanupMissing', { bookIds: ids });
                      setCleanupArmed(false);
                      const bits = [
                        r.restored ? `文件其实还在，恢复 ${r.restored} 条` : '',
                        r.files ? `清掉对不上号的记录 ${r.files} 条` : '',
                        r.recordOnly ? `${r.recordOnly} 本留成「只有记录」（评价进度都在）` : '',
                        r.removedBooks ? `${r.removedBooks} 本空书整条移走` : '',
                      ].filter(Boolean);
                      setNotice(bits.length ? bits.join('；') : '没有要清理的失效文件');
                      await refresh();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  })()}
                >
                  确认清理
                </button>
              </>
            ) : (
              <button
                className="chip"
                disabled={!matched}
                style={{ fontSize: '0.82rem' }}
                title="文件是你在应用外删掉的那种，扫描和「整理数据库」都清不掉。一次清掉：写过评价/进度的留成「只有记录」，空书整条移走"
                onClick={() => setCleanupArmed(true)}
              >
                批量清理失效文件
              </button>
            )
          )}
          {/* 批量打标签作用于**整个筛选结果**。八千本平铺在一个目录下、没有子目录，
              书名关键词搜索是唯一还剩的批量抓手（重生 / 穿越 / 华娱 / 大明……） */}
          <button
            onClick={() => setDialog('batchTag')}
            disabled={!matched}
            title="给当前筛选出的全部书打标签，不只是屏幕上这一页"
            style={{ fontSize: '0.82rem' }}
          >
            批量打标签
          </button>
          {/*
            * **批量改阅读状态。** 和批量打标签同一条规矩（整个筛选结果），
            * 但它才是这个应用的正事：真实书库 8172 本里打过分的 1 本、
            * 写过短评的 0 本——「下次不用再想这本我看过没」这句话，
            * 在有办法一次说清「这批我读过」之前根本无从谈起。
            * 逐本点开、逐本编辑、逐本手工添，对八千本的库等于没有入口。
            */}
          <button
            onClick={() => setDialog('batchStatus')}
            disabled={!matched}
            title="把当前筛选出的全部书标成读过 / 弃坑 / 想读，不只是屏幕上这一页"
            style={{ fontSize: '0.82rem' }}
          >
            批量改状态
          </button>
          {/*
            * **批量改名一直进不去。**
            *
            * `RenameDialog` 从头到尾是按「一批」设计的：文件名模板、冲突判定、
            * 超 50 个二次确认、按批撤销——而在补上下面这个按钮之前，`setRenaming`
            * 全仓库只有卡片上那一处调用，永远只传**一本**。于是模板的全部意义
            * （把八千个文件名规整成一套格式）在界面上做不到，
            * `CONFIRM_THRESHOLD = 50` 更是永远触发不了。
            * 这和 AGENTS.md 里记的「rpc 好使、界面上够不到」是同一类。
            *
            * 作用于**整个筛选结果**，和批量打标签同一条规矩：屏幕上只有 120 本，
            * 而用户想改的是「搜出来的这 268 本」。
            */}
          <button
            onClick={() => void (async () => {
              // **只要 id，别走 `book.list`。** 那个一行选 19 个列，
              // 8172 本时是把整个书库序列化过一趟 IPC 只为拿一串数字。
              // 另外两个批量压根不回传书；改名要出预览，所以退一步：回传的缩到只剩 id
              setRenaming(await rpc<number[]>('book.idsByFilter', { filter }));
            })()}
            disabled={!matched}
            title="按模板改这些书的文件名（不是书名）。会先摆预览、标出冲突，改完还能撤"
            style={{ fontSize: '0.82rem' }}
          >
            批量改名
          </button>
          </>)}
        </div>

        {/*
          * **正在生效的临时筛选，摊开来说。**
          *
          * 存成分类的规则只报名字就够（用户知道自己点的是哪一个）；临时筛选**没有名字**，
          * 不摊开的话屏幕上只剩「没有书」三个字，用户看不出是自己刚设的哪一条筛空的。
          * 这个仓库栽过一次：点亮一个收起后看不见的标签，筛选在生效而屏幕上
          * 看不出为什么，也没法取消——**界面必须显示正在生效的状态**。
          *
          * 说法走 `activeFilterWords`，和空屏那句话是同一份实现。
          * 单个条件去不掉（它们来自同一条规则），所以给的是「改」和「不筛了」——
          * 「改」回到那个编辑器，里面每个条件都点得掉。
          */}
        {adhoc && (
          <div className="adhoc">
            <span className="adhoc-label">筛选</span>
            {活着的筛选条件.map((w) => (
              <span key={w} className="chip sm">{w}</span>
            ))}
            <button className="chip" onClick={() => setEditCat({ id: 0, name: '', filter: adhoc })}>
              改
            </button>
            <button className="chip chip-clear" onClick={() => setAdhoc(null)}>
              不筛了
            </button>
          </div>
        )}

        {/*
          * **分类排 + 标签开关**。分类（照 legado：标题下面一排文字页签，横滚，
          * 选中的带下划线）；标签开关是页签条右缘的兄弟药丸（`.tag-toggle`），
          * 不随展开/选中挪位置。
          *
          * 这一排替掉了原来的**两排开关**——「按文件夹」和「按评分」。
          * 那两样当规则可以，当分类太粗：一个文件夹里什么都有，
          * 三星以上横跨所有题材。用户要的是「某某文件夹里四星以上的那些」，
          * 那是几条规则的**组合**，所以它们退回到分类编辑器里当字段。
          *
          * 标签开关为什么在页签条**外面**：在里面它就是横滚内容的一部分，
          * 选中分类冒出「改规则」键、页签横滚都会让它挪位置；在外面它一枚
          * 药丸钉死右缘，收起态一枚药丸之外不占任何地方。
          *
          * **单选**：分类回答的是「现在看哪一堆」；标签也是单选（用户拍的），
          * 手势一样；多标签取交集降级到分类编辑器里组。
          * 区别看两样：分类这头永远有个「全部」，标签每个后面挂着书数。
          */}
        {(counts.total ?? 0) > 0 && (
          <div className="shelf-bar">
            <div className="dir-chips shelf-tabs">
            <button
              className="chip"
              aria-pressed={pickedCat === null}
              onClick={() => setPickedCat(null)}
            >
              全部
            </button>
            {cats.map((c) => (
              <button
                key={c.id}
                className="chip"
                aria-pressed={pickedCat === c.id}
                // 分类和临时筛选互斥：点一个分类就把临时那条撤掉，反过来也一样
                onClick={() => { setPickedCat((p) => (p === c.id ? null : c.id)); setAdhoc(null); }}
                // 双击改规则。**入口要说出来**，不然没人知道改得了——
                // 同本文件那条「功能名要出现在通往它的那句话里」
                onDoubleClick={() => setEditCat(c)}
                title={`只看「${c.name}」这一类（双击改它的规则）`}
              >
                {c.name}
              </button>
            ))}
            <button
              className="chip"
              onClick={() => setEditCat({ id: 0, name: '', filter: {} })}
              title={筛选提示}
            >
              ＋ 新建分类
            </button>
            {pickedCat !== null && (
              <button className="chip" onClick={() => setEditCat(cats.find((c) => c.id === pickedCat) ?? null)}>
                改「{cats.find((c) => c.id === pickedCat)?.name}」的规则
              </button>
            )}
            </div>

            {/* 标签开关：位置恒定的一枚药丸，不在会横滚的页签条里。
                aria-expanded 说面板摊开没有；aria-pressed 说有没有标签正在生效
                （折叠时生效状态就挂在这枚按钮自己身上） */}
            {allTags.length > 0 && (
              <button
                className="chip tag-toggle"
                aria-expanded={tagBarOpen}
                aria-pressed={pickedTags.length > 0}
                onClick={() => setTagBarOpen((o) => !o)}
                title={
                  tagBarOpen
                    ? '收起标签列表'
                    : pickedTags.length > 0
                      ? `正在按「${allTags.find((t) => t.id === pickedTags[0])?.name ?? ''}」筛，点开展开`
                      : '按标签筛一道'
                }
              >
                标签 {tagBarOpen ? '▴' : '▾'}
              </button>
            )}
          </div>
        )}

        {/*
          * **标签面板——开关下面另起一块，换行多行、限高内滚。**
          *
          * 只在开关摊开时存在（`tagBarOpen`）；有标签生效时允许折叠——
          * 生效状态看得见的位置是开关自己（aria-pressed 填充 + title 挂标签名），
          * 不必占着整块面板。
          *
          * 药丸样式（分类是纯文字页签，标签是边框药丸），形状分开才不会混。
          * 展开的标签全列、不做 slice(0, N)：截掉的正是「系统」「诸天」这类
          * 真题材词（`tag.list` 按书数排，尾巴任意），打了标签却筛不了等于
          * 浏览这半没做；多到装不下时限高内滚，不截断名单。
          *
          * **单选**（和分类一个手势：点没亮的换选它、点亮着的取消），
          * 一个标签都没有时连开关都不显示。
          */}
        {(counts.total ?? 0) > 0 && tagBarOpen && allTags.length > 0 && (
          <div className="tag-row" role="group" aria-label="按标签筛">
            {tagChips.map((t) => (
              <button
                key={t.id}
                className="chip"
                aria-pressed={pickedTags.includes(t.id)}
                onClick={() =>
                  setPickedTags((p) => (p.includes(t.id) ? [] : [t.id]))
                }
                title={pickedTags.includes(t.id) ? `不再按「${t.name}」筛` : `只看「${t.name}」`}
              >
                {/* 名字单独一层：长标签在这一层省略，书数和全名（title）都不受影响 */}
                <span className="chip-t">{t.name}</span>
                <span className="chip-n">{t.count}</span>
              </button>
            ))}
            {pickedTags.length > 0 && (
              <button className="chip chip-clear" onClick={() => setPickedTags([])}>
                不按标签筛
              </button>
            )}
          </div>
        )}

        {/*
          * 以下全部在 `.main-scroll` 里滚：上面 `.main-head` / `.adhoc` /
          * `.shelf-bar`（页签 + 标签开关）/ `.tag-row` 是固定头
          * （`.main` 是 flex 列、overflow:hidden）。
          * 无限滚动哨兵的 observer root 也是这一层（见 attachSentinel）。
          */}
        <div className="main-scroll">
        {shelf === 'excluded' && books.length > 0 && (
          <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
            这些书<strong>没有被删除</strong>，只是不在书架上显示、扫描时也跳过。来由有两种：被屏蔽规则挡到，或者它所在的书库文件夹被移除了。去掉那条规则、或者把文件夹加回来重新扫描，它们连着阅读进度会原样回来。
          </p>
        )}

        {/*
          * ── 通知浮层 ────────────────────────────────────────────
          *
          * 报错、扫描报告、迁移提示三样**从版面里拿出来**，浮在右下角。
          * 它们原来是内联的，一扫描完就把整个书架往下顶一大截——用户的原话
          * 是「扫描通知应该做成浮层」。
          *
          * **给不给按钮**看 `报告要等人处理()`（失败/缺失才给「去处理」）；
          * **所有通知到点都自己走**——2026-09 用户改了旧规「有动作的永久停留」：
          *
          *   有下一步可做（失败/缺失，旁边就有「去处理」）
          *     → 留 `ACTIONABLE_TOAST_MS`（25 秒，对齐 Windows 通知横幅），
          *       悬停/焦点暂停；到点自己走**不等于替用户把待办划掉**——
          *       待办在侧栏「需要处理」档里带着计数，是持久的，通知只是引子
          *   没有下一步（扫描干净、只是通报跳过多少、一句报错）
          *     → 12 秒/8 秒自己走，**一个按钮都不出**：只用来把盒子藏起来的
          *       「知道了」是多余的
          *
          * ⚠️ 所有自己走的都**鼠标停上去 / 焦点进来就暂停**（`Toast.tsx`）：
          * 报告里那五档跳过和「不收的格式」是**要读的**，而 AGENTS.md 明写着
          * 「跳过必须报出来」——几秒就闪没等于把那条判据毁掉
          * （「没找到」和「没问题」长得一模一样，这个仓库栽过好几次）。
          * 浮层解决的是**别占版面**，暂停计时解决的是**别拿信息换整洁**。
          *
          * ⚠️ **章节体检名单不在这里，它留在版面里。** 那是「长期名单 + 一个动作」
          * ——是待办不是通知（`badSplits` 那段注释写着它为什么必须留得住）。
          * 底部那条扫描进度状态条同理，它本来就不占版面。
          *
          * `aria-live="polite"` 让屏幕阅读器念出来：这些东西是**动作的结果**，
          * 而浮层在阅读顺序上离动作很远，不念的话等于没发生。
          * 报错单独 `role="alert"`（要打断）。
          */}
        <div
          className={`toasts${busy ?? progress ? ' toasts-lift' : ''}`}
          aria-live="polite"
        >
        {/*
          * 报错：**没有下一步可做，所以不给按钮，自己走。**
          * 它原来连关都关不掉（只能等下一个动作 `run()` 开头把它清掉），
          * 而那时候屏幕上就一直挂着一条已经过去的话。
          * `key` 用消息本身：连着两次不同的错，第二条要重新计时。
          */}
        {error && (
          <Toast key={error} auto={8000} danger onClose={() => setError(null)}>
            {error}
          </Toast>
        )}

        {notice && (
          <Toast key={notice} auto={12000} onClose={() => setNotice(null)}>
            {notice}
          </Toast>
        )}

        {report && (
          /*
           * 扫描报告。**所有报告到点都自己走**：有失败/缺失的留 25 秒
           * （待办在侧栏「需要处理」档里，跑不掉），干净的留 12 秒。
           *
           * ⚠️ 不是三两秒——里面那几行跳过统计（「跳过 1342 个：屏蔽规则
           * 1251…」）是要读的，而「跳过必须报出来」是硬判据：全 0 的报告
           * 最常见的原因就在那几行里。鼠标停上去暂停计时（`Toast` 里），
           * 读到一半跑掉这件事不会发生。
           */
          <Toast
            // 换一份报告就是换一条通知，要重新计时。`ScanReport` 没有 id，
            // 拿几个计数拼一个够用：数一样、内容也就一样，接着旧计时无所谓
            key={`${report.added}:${report.updated}:${report.unchanged}:${report.failed}`}
            auto={报告要等人处理(report) ? ACTIONABLE_TOAST_MS : 12000}
            onClose={() => setReport(null)}
          >
            扫描完成：新增 {report.added} · 更新 {report.updated} · 移动 {report.moved} · 缺失{' '}
            {report.missing} · 未变 {report.unchanged} · 失败 {report.failed}
            {/* **跳过的必须说出来。** 这是全 0 报告最常见的原因：
                用户选了个文件夹、扫完还是空的，而界面上没有任何解释。
                只在真跳过时才显示——平时是空表，说了反而是噪音 */}
            {Object.keys(report.skipped).length > 0 && (
              <span className="muted">
                {' '}· 跳过 {Object.entries(report.skipped).map(([k, n]) => `${SKIP_LABEL[k] ?? k} ${n}`).join('、')}
              </span>
            )}
            {/*
              * **有目录读不到时，要说清这次「什么都没标」以及为什么。**
              *
              * 那种情况下扫描**故意**不标任何「文件不见了」——`seen` 是不全的，
              * 分不出「这个文件没了」和「那一整片我压根没看到」（判据在 `core/scan.ts`）。
              * 只说「跳过 读不了的文件夹 1」的话，用户看到的是一次什么都没发生的扫描，
              * 而真正该做的事（把硬盘插回去）没人告诉他。
              */}
            {report.skipped.unreadableDir ? (
              <div className="muted" style={{ fontSize: '0.82rem' }}>
                有文件夹读不到，所以这次一本都没标成「文件不见了」——多半是移动硬盘没插、网络盘断了，或者权限被改了。接回去再扫一次就行。
              </div>
            ) : null}
            {/*
              * **进度估出来的要说一声。**
              * 重新解析之后章节变少，原来的章号超出新目录——只能退回最后一章。
              * `restoreProgress` 一直算着 `accurate: false`，而调用方原来把它扔了，
              * 用户那边是「打开书发现位置不对，一句解释都没有」。
              * 阅读进度是铁律 3 里重扫恢复不了的数据，最容易让人以为丢了。
              * 只列书名，不给按钮：这不是个待办，是一句交代。
              */}
            {report.progressGuessed?.length > 0 && (
              <div className="muted" style={{ fontSize: '0.82rem', marginTop: '.2rem' }}>
                有 {report.progressGuessed.length} 本书重新切过章之后章节变少了，阅读进度只能估个位置（
                {report.progressGuessed.slice(0, 3).map((g) => `《${g.title}》第 ${g.from + 1} 章 → 第 ${g.to + 1} 章`).join('、')}
                {report.progressGuessed.length > 3 && ` 等 ${report.progressGuessed.length} 本`}
                ）。书签和划线也可能对不上，打开时会说。
              </div>
            )}
            {/*
              * **追更多了多少章要说一声。**
              * 反过来看 progressGuessed 只说「变少了」，变多的那一半没交代——
              * 用户盯着「更新了 3 本」那行字，不知道是哪三本、各多了几章。
              * slice(0,3) 是同一处的惯例，多了就「等 N 本」。
              */}
            {report.grew?.length > 0 && (
              <div className="muted" style={{ fontSize: '0.82rem', marginTop: '.2rem' }}>
                {report.grew.slice(0, 3).map((g) => `《${g.title}》多了 ${g.to - g.from} 章`).join('、')}
                {report.grew.length > 3 && ` 等 ${report.grew.length} 本`}
              </div>
            )}
            {/*
              * **「这个格式我们不收」也要说出来。**
              *
              * 这是第五条跳过路径，也是最晚补上的一条：`walk` 里原来是一句
              * `else if (isBookFile(...))`，不符合就直接落空，一个数都不留。
              * 结果是用户库里 16 个 `.doc`、4 个 `.chm` **从来没被提起过一次**，
              * 而扫描报告显示一切正常——「没找到」和「没问题」长得一模一样。
              *
              * ⚠️ **必须报到扩展名，不能只报个数。** 另外四档的处置是调一个设置
              * （门槛、屏蔽规则、权限），而这一档的处置是**决定要不要收这种格式**——
              * 「20 个文件因为格式没收」会让人满硬盘找，「16 个 .doc」当场就能定。
              *
              * 只列前几种、按数量排：一个下载目录里几十种扩展名是常事，
              * 而有意义的永远是最多的那两三种。
              */}
            {Object.keys(report.otherExts ?? {}).length > 0 && (
              <div className="muted" style={{ fontSize: '0.82rem', marginTop: '.2rem' }}>
                另有{' '}
                {Object.entries(report.otherExts)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 5)
                  .map(([e, n]) => (e ? `${n} 个 .${e}` : `${n} 个没有扩展名`))
                  .join('、')}
                {Object.keys(report.otherExts).length > 5 && ' 等'}
                {' '}没有收——这些格式不在收录名单里。真要把某一种收进来，说一声就行。
              </div>
            )}
            {/* **「缺失」也要给这个按钮**，原来只看 `failed`。
                而「需要处理」那一档收的正是 `missing` 和 `parse_failed` 两种——
                实测删掉一个文件重扫，报告写着「缺失 1」、侧栏悄悄多出一档
                「需要处理 1」，报告条上却没有任何去处的指引：那一行六个数字里
                唯一有后果的就是它，而它不可点。 */}
            {/*
              * ⚠️ **这两个键钉在卡片底沿（`toast-actions` 是 sticky）。**
              *
              * 报告进浮层之后有了 `max-height`，内容一多就自己滚——而**出口
              * 跟着滚出了视野**：760 那一档实测「知道了」被卡在滚动区下沿，
              * 得先在卡片里往下滚才点得到。`audit.mjs` 里专门有一条判据量的就是
              * 「出口要不要滚才够得到」，这次是我自己把它做出来的。
              */}
            {/*
              * ⚠️ **只有真有下一步可做时才出这一排。**
              * 判据是用户定的：不需要操作就不该有「知道了」——那个键什么活都没干，
              * 却要人点一下才肯走。没有失败/缺失的那种报告自己走（`auto`），
              * 一个按钮都不出。
              *
              * 有下一步的时候「这次先不管」不是多余的：它和「去处理」并排，
              * 是立刻收起通知那条路。通知到点（`ACTIONABLE_TOAST_MS`）也会自己走，
              * 但**待办不丢**——「去处理」去的侧栏「需要处理」档带着计数，一直在。
              */}
            {报告要等人处理(report) && (
              <div className="toast-actions">
                <button
                  style={{ fontSize: '0.75rem', padding: '.05em .45em' }}
                  onClick={() => { setShelf('problem'); setReport(null); }}
                >
                  去处理
                </button>
                <button
                  style={{ fontSize: '0.75rem', padding: '.05em .45em' }}
                  // 只收起这次的扫描报告。**体检名单不清**——它现在是长期的，
                  // 收起来的话那几本切错的书又没人提了
                  onClick={() => setReport(null)}
                >
                  这次先不管
                </button>
              </div>
            )}
          </Toast>
        )}

        {/*
        * 章节切分体检的名单。**摆在扫描报告外面**：它原来只活在那份报告里，
        * 扫完看得见、一刷新就没了；而这个体检在真实库上要 **9–14 秒**（659 万章），
        * 开机跑不起（第 94 轮那个 830ms 的自动备份就是这么卡住首屏的），
        * 所以也不能「想看就现算」。现在算完存进 `app_setting`，开机读一次。
        *
        * **用户不常扫描，而那几本切错的书是真的读不了**——名单不该只在那一刻出现。
        *
        * 只在真有问题时出现：没问题时多一行「一切正常」是噪音。
        */}
        {/* **一行说完。** 原来是一张卡片：标题 + 两行解释 + 一个按钮，
            开机就杵在书架上方——用户的原话是「干扰」。这条只出现一次，
            细节收进 title，鼠标停上去看得全 */}
        {clearedWant > 0 && (
          <div className="card toast muted" style={{ fontSize: '0.8rem' }}>
            <span title="扫描时自动填的默认值，不是你标的。留着的话「想读」等于装着整个书库——你标过的、打开过的书一本都没动。">
              整理了 {clearedWant} 条「想读」（扫描留下的默认值，你标过的没动）
            </span>
            <button
              style={{ marginLeft: '.4rem', fontSize: '0.78rem', padding: '.1em .5em' }}
              onClick={() => void (async () => {
                setClearedWant(0);
                await rpc('setting.set', { key: 'migrate.clearedWant', value: '' }).catch(() => {});
              })()}
            >
              知道了
            </button>
          </div>
        )}
        </div>
        {/* ── 通知浮层到此为止。下面这些留在版面里 ───────────────── */}

        {/*
          * **默认折起来，一行。** 这份名单是长期的（不修就一直在），
          * 而它原来开机就把 4 个书名、一段说明和一个按钮全铺在书架上方——
          * 用户的原话是「干扰」。它不紧急：章节切错了书照样打得开。
          *
          * 但**不能藏掉**（同本仓库那条「静默跳过是反复咬人的一条」），
          * 所以留一行，点「看看」再展开。
          */}
        {badSplits.length > 0 && !splitOpen && (
          <div className="muted" style={{ fontSize: '0.8rem', marginTop: '.4rem' }}>
            有 {badSplits.length} 本的章节可能切错了
            {splitCheckedAt && whenAgo(splitCheckedAt) && (
              <span title={whenAgo(splitCheckedAt)!.title}>（{whenAgo(splitCheckedAt)!.text}查的）</span>
            )}
            <button
              style={{ marginLeft: '.4rem', fontSize: '0.78rem', padding: '.1em .5em' }}
              onClick={() => setSplitOpen(true)}
            >
              看看
            </button>
          </div>
        )}

        {badSplits.length > 0 && splitOpen && (
            <div style={{ marginTop: '.5rem', borderTop: '1px solid var(--line)', paddingTop: '0.5rem' }}>
              <strong>有 {badSplits.length} 本的章节可能切错了</strong>
              <button
                style={{ marginLeft: '.4rem', fontSize: '0.78rem', padding: '.1em .5em' }}
                onClick={() => setSplitOpen(false)}
              >
                收起
              </button>
              {/* **说清这份名单是什么时候的**：它不是实时的（那句查询在真实库上要 9–14 秒），
                  不说的话用户会以为刚修好的书还挂在名单里。
                  ⚠️ 原来写的是「N 小时前**扫描时**查的」——而这条记录**不一定来自扫描**
                  （维护接口也能写它，我就从外面补写过一次），那时候那句话是假的。
                  只说什么时候查的，别替它声称是怎么来的。 */}
              {splitCheckedAt && whenAgo(splitCheckedAt) && (
                <span className="muted" style={{ fontSize: '0.78rem', marginLeft: '.4rem' }} title={whenAgo(splitCheckedAt)!.title}>
                  （{whenAgo(splitCheckedAt)!.text}查的）
                </span>
              )}
              <div className="muted" style={{ fontSize: '0.8rem', margin: '0.2rem 0 0.4rem' }}>
                {badSplits.slice(0, 4).map((b) => (
                  <div key={b.bookId}>《{b.title}》{b.detail}</div>
                ))}
                {badSplits.length > 4 && <div>……还有 {badSplits.length - 4} 本</div>}
              </div>
              <button
                // `run` 已经在维护 busy 了，别再另存一份——两份状态迟早对不上
                disabled={busy !== null}
                onClick={() => void run(`正在重新切分 ${Math.min(badSplits.length, SPLIT_BATCH)} 本…`, async () => {
                  // **一次最多切这么多。** 每本都要整份读进来再解析，全在主进程上；
                  // 名单没有上限，几百本一次点下去就是主进程卡死几分钟——
                  // 而界面上只列出了 4 本，用户是看着 4 个书名点的这一下
                  const batch = badSplits.slice(0, SPLIT_BATCH);
                  const r = await rpc<{ ok: number; failed: Array<{ error: string }> }>(
                    'book.reparse', { bookIds: batch.map((b) => b.bookId) },
                  );
                  const left = await rpc<BadSplit[]>('library.badSplits').catch(() => []);
                  // 结果要说出来。**只把名单刷新一遍是不够的**：有的书重解析之后
                  // 切法不变（用户自己设过规则的会照旧），名单纹丝不动，
                  // 而用户不知道到底跑了没有
                  setSplitMsg(
                    `重新切分了 ${r.ok} 本`
                    + (r.failed.length ? `，${r.failed.length} 本失败：${r.failed[0].error}` : '')
                    + (left.length ? `；还剩 ${left.length} 本可疑` : '；都处理完了'),
                  );
                  setBadSplits(left);
                  await refresh();
                })}
              >
                按现在的规则重新切分{badSplits.length > SPLIT_BATCH ? `前 ${SPLIT_BATCH}` : `这 ${badSplits.length}`} 本
              </button>
              {splitMsg && <span style={{ color: 'var(--accent)', fontSize: '0.8rem', marginLeft: '.5rem' }}>{splitMsg}</span>}
              <div className="muted" style={{ fontSize: '0.78rem', marginTop: '.3rem' }}>
                只重算章节、不动磁盘上的文件。阅读进度、书签、划线都会按标题跟着搬；
                <strong>标题在新目录里找不到时只能按序号落位，可能对不上</strong>——划线还会在阅读器里如实标出来。
              </div>
            </div>
        )}

        {books.length === 0 ? (
          <div className="empty">
            {/* 空屏是**邀请动手的地方**，不是报告状态的地方。
                原来写「还没有书库目录」+「选好之后点左下角『扫描书库』」——
                一句在说系统内部的概念，一句在派活。现在一句话说清能得到什么，
                按钮点下去直接就有书 */}
            {rootCount === 0 ? (
              <>
                选一个放书的文件夹，这里就会摆出你的书。<br />
                <button className="primary" onClick={addRoot} disabled={busy !== null}>
                  选一个文件夹
                </button>
                <br />
                <span className="muted" style={{ fontSize: '0.85rem' }}>
                  {/* ⚠️ **三档都从常量推出来，别手写。** 这句话原来写着
                      「txt 能在书斋里读，其余的交给系统程序打开」——两处都过期了：
                      md 也能读，而 PDF / EPUB 有内置查看器、不交给系统程序。
                      一句关于能力的文案，只要是手写的就一定会飘。
                      但**首屏不该摊 16 个扩展名**（那是收录名单，不是介绍）：
                      主体说「能不能读」，完整清单收进折叠，仍然从同一个常量推。 */}
                  {`${TEXT_EXT.join(' / ')} 这类文本在书斋里完整阅读，pdf / epub 有内置查看器，其余的交给系统打开。`}
                  <br />
                  <details style={{ margin: '.25rem 0 0' }}>
                    <summary style={{ cursor: 'pointer' }}>支持哪些文件格式</summary>
                    {BOOK_EXT.join('、')}
                  </details>
                  <br />
                  <strong>原文件一个字节都不会改。</strong>
                </span>
              </>
            ) : (
              emptyHint()
            )}
          </div>
        ) : view === 'table' ? (
          <ReviewTable
            books={books}
            sort={sort}
            // 点表头改的是**当前排序**，和那个下拉是同一个状态——
            // 两处显示同一件事，不许各存各的。存偏好同下拉那条判据
            onSort={(s) => { setSort(s); saveSort(shelf, s); }}
            onOpen={(b) => open(b)}
            editing={rating}
            onEdit={setRating}
            onChanged={评价改了}
          />
        ) : view === 'reviews' ? (
          /*
           * 书评册。**它是个视图，任何一档都切得出来**，不是谁的专属。
           *
           * ⚠️ 「我的书评」那一档的默认**是表格**（`SHELVES` 的 `view` 字段），
           * 不是这个——那一档常干的事是回头清点账目，一屏对比比一次一本快。
           * 书评册答的是另一个问题：「我当时那句话到底说了什么」。
           *
           * 为什么那一档不该用封面墙：它要答的是「我评过什么、我当时怎么说」，
           * 而封面墙把那句话压成封面底下两行 0.72rem 的小字（量过：22–26 个字，
           * 再长就是省略号）。这个应用唯一不可再生、也唯一算得上「我的」的内容，
           * 在专门为它开的那一档里占的地方比作者名还小。
           * 判据和整份形状写在 `ReviewShelf.tsx` 顶上。
           */
          <ReviewShelf
            books={books}
            byRatedTime={sort === 'rated'}
            onOpen={(b) => open(b)}
            editing={rating}
            onEdit={setRating}
            onChanged={评价改了}
          />
        ) : (
          <div className="wall">
            {books.map((b) => {
              // 一张卡算一次。**不是省这几次函数调用**：扫描时每处理一个文件就
              // 推一次进度，整个 books.map 会跟着重渲染几千次
              const kind = formatOf(b.path);
              // 库里存的是 UTC 文本，直接 new Date 会差一个时区，见 core/format.ts
              const readAt = sqlTime(b.last_read_at);
              // 给人看的章数（手填值盖过自动识别，判据在 format.ts 的 displayChapters）。
              // 算一次，标记/悬停/卡底共用；体检那条仍用真实 b.chapter_count
              const 章数 = displayChapters(b.chapter_count_override, b.chapter_count);
              // 这本书的各种状态。**不再浮在封面上**（会压住书名、把长书名挤小），
              // 全部并到封面下方那行信息里：一枚「点+颜色」的状态标 ＋ 几枚中性事实小签。
              const 角标 = {
                文件坏了: PROBLEM_FILE_STATUS.includes(b.file_status ?? ''),
                // 存扩展名本身而不是 true：**判据和标记上印的字同源**，
                // 而且省掉一个 `b.path!`（布尔化会把类型收窄弄丢）
                格式: kind === 'catalog' && b.path ? extOf(b.path).toUpperCase() : '',
                // ⚠️ 体检用**真实** chapter_count：手填值是给人看的修正，
                // 不能把「根本没解析出来」盖成绿的
                未解析: b.file_status === 'ok' && !b.chapter_count && kind === 'text',
                只有记录: kind === 'manual',
                笔记: (b.note_count ?? 0) > 0,
                读完: b.reading_status === 'finished',
                重读: (b.reread_count ?? 0) > 0,
                弃坑: b.reading_status === 'dropped',
                连载中: b.serial_status === 'ongoing',
                网上有更新: updateIds.has(b.id),
                太监: b.serial_status === 'abandoned',
              };
              // 状态标：互斥，按**要紧程度**取最要紧那一枚——点进书之前最该知道的在前。
              // 「网上有更新」本身就意味着它在连载，所以它出现时不再另出「连载中」。
              const 状态标 = 角标.网上有更新 ? {
                  text: '网上有更新', tone: 'danger',
                  title: `网上更到：${hints.find((h) => h.bookId === b.id)?.remoteLatest ?? '还没查到'}`,
                }
                : 角标.文件坏了 ? { text: labelOf(FILE_STATUS, b.file_status), tone: 'danger' }
                : 角标.未解析 ? { text: '未解析', tone: 'danger' }
                : 角标.太监 ? { text: '太监', tone: 'warn' }
                : 角标.弃坑 ? { text: labelOf(READING_STATUS, 'dropped'), tone: 'muted' }
                : 角标.连载中 ? { text: '连载中', tone: 'accent' }
                : 角标.读完 ? { text: labelOf(READING_STATUS, 'finished'), tone: 'muted' }
                : null;
              // 事实小签：中性色，说「这是什么」而不是「它怎么了」
              const 事实标: Array<{ text: string; title?: string }> = [];
              if (角标.格式) 事实标.push({ text: 角标.格式 });
              if (角标.笔记) 事实标.push({ text: `✎ ${b.note_count}`, title: `划线和书签一共 ${b.note_count} 条` });
              if (角标.只有记录) 事实标.push({ text: '只有记录' });
              /*
               * **重读过就摆一枚。**「别再翻开它」这一屏最要紧的那句话，
               * 遇到「我其实翻回来过」正好是反证——不说出来，那一档的账就是错的。
               * ⚠️ 数的是**重读的次数**（`status.ts` 里读完之后再开读才自增），
               * 不是「一共读了几遍」，所以 1 的意思是「读完又翻回来过一次」。
               * 说法里的「一次算一遍」由悬停那句话交代，不占卡面。
               */
              if (角标.重读) 事实标.push({
                text: `重读 ${b.reread_count} 次`,
                title: '读完之后又翻开过。重新开读会把进度归零，所以「读到第几章」是从头算的',
              });
              return (
              /*
               * `data-book-id` 是给走查用的：书库里**同名的书是常态**
               * （同一本书的 txt 和 epub 各是一条记录，测试库里就有一对），
               * 而走查原来按 `textContent.includes(书名)` 找卡片——两张一模一样的卡，
               * 它拿到的是**第一张**。症状是「按 Esc 那句短评没存住」：
               * 话确实存住了，只是存到了另一本同名的书上，而断言查的是自己挑的那本。
               */
              <div key={b.id} data-book-id={b.id} className="book">
                {/*
                  * **封面这块最大的悬停区，要用来放短评。**
                  *
                  * 原来它挂的是 `title={书名}`——而书名就写在封面正下方，
                  * 那个 tooltip 一个字的新信息都没有。短评则被塞在右下角
                  * 那个 30 像素的 ★N 小角标里，要**正好**悬停在它上面才看得见。
                  * 而这个应用的目标就是让「烂尾了别看」在点开之前出现，
                  * 最大的那块区域理应说最要紧的那句话。
                  */}
                <div
                  className="book-art"
                  title={
                    (() => {
                      const 到手 = b.mtime ? new Date(b.mtime).toLocaleDateString('zh-CN') : null;
                      const 进度交代 = b.serial_status === 'ongoing' && 章数
                        ? `本地到第${章数}章${到手 ? ` · ${到手} 到手` : ''}`
                        : null;
                      const 评价交代 = (b.comment || b.drop_reason)
                        ? `${b.rating != null ? `★${b.rating}　` : ''}${b.comment || b.drop_reason}`
                        : null;
                      return [进度交代, 评价交代].filter(Boolean).join('\n') || undefined;
                    })()
                  }
                  onClick={() => open(b)}
                >
                  {/*
                    * **封面是「打开这本书」的按钮，不是一张图。**
                    *
                    * 改之前 `.book-art` 是 `role: generic`、`tabIndex: -1` 的 div，
                    * 拿 CDP 按 Tab 走一圈**一次都不落在封面上**——而点封面是打开一本书的
                    * 唯一路径（卡片那排工具里没有「打开」）。也就是**键盘用户一本书都打不开**，
                    * 屏幕阅读器在书架上也读不出任何东西。
                    *
                    * ⚠️ **按钮只包 `<Cover/>`，不能包整个 `.book-art`**：那排
                    * 「编辑 / 章节 / 改名 / 评价 / 导出」就装在 `.book-art` 里，
                    * 按钮套按钮是非法的、点击也会坏（试过一次，当场把 JSX 改塌了）。
                    *
                    * 也**不做在书名上**：那行只有 18px 高，`audit.mjs` 当场报
                    * 「点击目标偏小且挨得近」——那条判据是对的，一行字不该当按钮。
                    * 封面两百多像素高，天然满足。
                    *
                    * `stopPropagation` 是必需的：外层 `.book-art` 自己也有 onClick
                    * （鼠标点角标那一圈也能开书），不拦就会开两次。
                    */}
                  <button
                    type="button"
                    className="book-open"
                    aria-label={`打开《${b.title}》${b.author ? `，${b.author}` : ''}`}
                    onClick={(e) => { e.stopPropagation(); open(b); }}
                  >
                    <Cover bookId={b.id} title={b.title} hasCover={!!b.has_cover} />
                  </button>
                  {/* 封面上**不再挂任何状态**：连载 / 读完 / 弃坑 / 格式 / 笔记那些标记
                      会压住书名、把长书名挤小，全部挪到了封面下方那行信息里。
                      封面上只剩：进度条（这一条）和悬停才出现的评分 / 工具条。 */}
                  {!!b.percent && b.percent > 0 && b.percent < 100 && (
                    <div className="book-progress"><i style={{ width: `${b.percent}%` }} /></div>
                  )}
                  {/* 封面下沿的两层：评分在上，悬停才出现的工具条在下。
                      装在一个容器里堆着，工具条一出现评分自己往上让 */}
                  <div className="book-foot">
                  {/* 评分角标。用数字不用五个星形——卡片那么小，一排星形在封面图上
                      糊成一团；悬停显示短评，那句话必须在点进去之前出现 */}
                  {showRating && b.rating != null && (
                    <span
                      className="book-rating"
                      title={b.comment ? `${b.rating} 星 · ${b.comment}` : `${b.rating} 星`}
                    >
                      ★{b.rating}
                    </span>
                  )}
                  <div className="book-tools">
                    {/* **这排按钮都要有 title。** 卡片上只放得下两个字，而两个字说不清
                        是什么——「章节」点开是「章节怎么切」，「导出」和侧栏那个
                        「导出表格」压根是两件事（这本书 vs 整个库）。侧栏那排本来就
                        条条有说明，这排没有，是同一个应用里的两套标准 */}
                    <button
                      title="改书名、作者、封面、简介这些，只写库，不动磁盘上的文件"
                      onClick={(e) => { e.stopPropagation(); setEditing(b.id); }}
                    >编辑</button>
                    {/*
                      * **这排只剩两个。** 原来是五个（编辑 / 章节 / 改名 / 评价 / 导出），
                      * 而它是**乘以每张卡**的——一屏八张就是 40 个按钮。
                      *
                      * 章节 / 改名 / 导出 都是「一本书一辈子点一次」的操作，
                      * 收进「编辑」那个弹窗了（它本来就是这个应用唯一的详情页）。
                      * 留下的两个：**评价**是这个应用的正事，**编辑**是通往其余一切的门。
                      */}
                    <button
                      title="打分、写一句话、贴标签——下次就不用再想这本我看过没"
                      onClick={(e) => { e.stopPropagation(); setRating(b); }}
                    >
                      评价
                    </button>
                  </div>
                  </div>
                </div>
                {/* 浮层挂在 .book 上而不是 .book-art 里——后者是 overflow:hidden
                    （为了封面圆角裁切），浮层放进去会被整个裁掉 */}
                {rating?.id === b.id && (
                  <RatePopover
                    bookId={b.id}
                    bookTitle={b.title}
                    rating={b.rating}
                    comment={b.comment}
                    tags={b.tags}
                    onChanged={(patch) => {
                      // **只改这一张卡，不整表重取。** 之前是回调一声就 refresh()，
                      // 而 refresh 会把已加载的书全部重取（滚到 3000 本时就是
                      // 64ms + 1.3MB + 三千张卡重渲染）。新值浮层手上就有。
                      评价改了(b.id, patch);
                      /*
                       * ⚠️ **代价：在筛过的档位里，这张卡会暂时和筛选条件对不上。**
                       *
                       * 站在「读过没评价」里给一本书打个星：侧栏当场变成少一本，
                       * 而卡片还在原地（只是多了个 ★）。看起来像「侧栏说 1、书架列 2」
                       * 那类老 bug——**但这里是有意的，别去「修」成打完星就抽走**：
                       *
                       * 抽走卡片 = 卸载这张卡 = **连着把浮层一起卸掉**，
                       * 而用户十有八九正要接着在里面写那句短评
                       * （本文件记过「浮层被重挂就丢值」那次事故）。
                       * 打星和写短评是一个动作的两半，中间不能把纸抽走。
                       *
                       * 那张卡上已经有 ★ 了，「这本做完了」看得见；
                       * 离开这一档再回来它自然就不在了。
                       */
                    }}
                    onClose={() => setRating(null)}
                  />
                )}
                <div className="book-title" title={b.title}>{b.title}</div>
                {/*
                  * 状态信息行。**状态标记从封面上挪到了这儿**（见 `角标` 那段）：
                  * 一枚带色点的状态（网上有更新 / 太监 / 弃坑 / 连载中 / 已读完…）
                  * ＋ 几枚中性事实小签（PDF / ✎N / 只有记录），都和作者、章数、字数
                  * 排在同一行——点进书之前该知道的事在这一行说全，封面只留装帧。
                  * 说法从 `labels.ts` 取（labelOf），和报错、导出的表格念同一份。
                  */}
                <div className="book-sub">
                  {状态标 && (
                    <span className={`book-mark ${状态标.tone}`} title={状态标.title}>{状态标.text}</span>
                  )}
                  {事实标.map((t) => (
                    <span key={t.text} className="book-tag" title={t.title}>{t.text}</span>
                  ))}
                  {b.author ?? '佚名'}
                  {章数 ? ` · ${章数} 章` : ''}
                  {wan(b.word_count) && ` · ${wan(b.word_count)}`}
                </div>
                {/*
                  * 读过的书多一行「读到哪 · 多久没碰了」。
                  *
                  * 原来这些只有封面上一个「读到 505 章」角标。**两样里更有用的是
                  * 后一样**：「读到 505/608」是「今晚能不能看完」，「3个月前」是
                  * 「这本其实已经弃了」——而这个应用的目标正是别再重复翻开它。
                  * 章节标题放 title 里：卡片只有 8 来个字宽，摆不下又不能截半句。
                  */}
                {b.last_read_at != null && (
                  <div
                    className="book-read"
                    title={b.chapter_title ? `读到「${b.chapter_title}」` : undefined}
                  >
                    {/* 读完的书不再报「读到 12/12」——信息行那个「已读完」状态标
                        已经说过一遍了，同一张卡上不说两次同一件事。
                        这一行剩下的信息是**什么时候读完的**。
                        ⚠️ **没读完的那行也去掉了「读到」和总章数**：总章数就在上一行
                        （`… · 45 章 · 2 万字`），写成「读到 3/45」等于同一张卡上
                        把 45 说两遍；而「读到」是个动词，摆在一行事实里是多余的。
                        legado 那边写的是「已读：第173章 <标题>」——去掉标签就是这个形状，
                        标题我们放在悬停里（卡片只有八来个字宽，摆不下又不能截半句）。 */}
                    {/*
                      * ⚠️ **只编目的书（PDF / EPUB）不报章号——它们根本不按章记进度。**
                      *
                      * 那两种格式的位置存在 `app_setting` 的 `viewer.<bookId>` 里
                      * （PDF 是页码、EPUB 是章序号），`reading_state.chapter_idx` 永远是 0。
                      * 无条件渲染的话，一本翻到第 100 页的 PDF 在卡片上写着「第 1 章」——
                      * **一个凭空捏出来的数**。
                      *
                      * 这一行原来根本不出现（`last_read_at` 是 null），是「开查看器也记一笔
                      * 打开过」那次改动把它带出来的：**修好一处显示，顺手造出另一处假话**。
                      * 剩下的「多久前」是真的，也正是这一行最有用的那一半，留着。
                      */}
                    {(() => {
                      const 章 = b.reading_status === 'finished'
                        ? '读完'
                        : formatOf(b.path) === 'catalog' ? null : `第 ${(b.chapter_idx ?? 0) + 1} 章`;
                      const 时 = readAt !== null ? relTime(readAt) : null;
                      return <>{章}{时 !== null && (章 ? ` · ${时}` : 时)}</>;
                    })()}
                  </div>
                )}
                {/*
                  * 短评直接印在卡片上，**不是只藏在 tooltip 里**。
                  *
                  * 这个应用的立身之本是「别再重复翻开一本烂尾的书」，而悬停是个
                  * 要先知道才会做的动作——不知道的人永远看不到自己写过的那句话。
                  * 只有写过短评的书才多这一行（和上面「读到哪」「标签」同一条规矩：
                  * 不占没内容的位置）。一行截断，全文在封面的 title 里。
                  */}
                {/*
                  * 弃坑原因排在短评前面：**「我当初为什么弃了它」比评分更能拦住
                  * 重复翻开**。原来它只存进库、只在编辑弹窗里看得见——写了
                  「写崩了，主角人设一直在变」，回到书架只剩一个「弃坑」状态标，
                  * 那句话等于没写。
                  */}
                {(b.comment || b.drop_reason) && (
                  <div
                    className="book-note"
                    title={b.comment || b.drop_reason || undefined}
                  >
                    {/* **不加「弃坑：」前缀**——状态标已经说过一遍了，
                        而这一行是全卡片唯一被截断压着的：实测 1280 下只印得下
                        11 个字，前缀要吃掉 3 个（真正的原因少 37%）。
                        两样都写过的话完整版在封面的 title 里，分了标签 */}
                    {b.comment || b.drop_reason}
                  </div>
                )}
                {/*
                  * 标签行**只在有标签时才占位**，否则八千张卡片凭空长高一截。
                  * 这一行是给人扫一眼的，不是给人读全的，多的收成 +N。
                  *
                  * ⚠️ **只摆两个，不是三个。** 这一行只有 133px，而
                  * `.book-tags .chip.sm` 是允许被压缩的（为的是保住「+N」，见 styles.css）——
                  * 而压缩**按比例摊给每一个**：实测三个标签时「玄幻」要 32px 只拿到 25、
                  * 「玄幻小说」要 54 拿到 40，于是屏幕上写着「玄幻小」和半个「都市」，
                  * **每个标签名都缺了尾巴，而那不是任何一个标签的名字**。
                  * 两个正好落回不用压缩的区间。完整那份在这一行的 title 里
                  *（表格那一列也是两个，书评册那边宽，摆六个）。
                  */}
                {/* split 只做一次，而且走 `拆标签` 那一份（表格、书评册、编辑弹窗
                    也是它）。书架不做虚拟滚动，滚到三千本时这一段每次重渲染都要跑
                    一遍——在这儿现场 `.split(',')` 三回纯属浪费 */}
                {b.tags && ((tags) => (
                  <div className="book-tags" title={tags.join('、')}>
                    {tags.slice(0, 2).map((t) => (
                      <span key={t} className="chip sm">{t}</span>
                    ))}
                    {tags.length > 2 && <span className="muted">+{tags.length - 2}</span>}
                  </div>
                ))(拆标签(b.tags))}
              </div>
              );
            })}
          </div>
        )}

        {/* 滚到这儿就自动加载下一页，不用点 */}
        {!atEnd && books.length > 0 && (
          <div ref={attachSentinel} className="muted" style={{ textAlign: 'center', padding: '1.6rem 0', fontSize: '0.85rem' }}>
            正在加载更多…（已显示 {books.length} 本）
          </div>
        )}
        </div>
      </main>

      {(busy ?? progress) && (
        <div className="statusbar">
          <span>{busy ?? '正在扫描…'}</span>
          {progress && (
            <>
              <span>已处理 {progress.done} 个文件</span>
              {/* **按两种分隔符切**，和 `VersionsDialog` 那处一致。
                  只切反斜杠的话，路径里是正斜杠时（书库目录可以填成
                  `D:/书/…`）状态栏会把整条绝对路径摊出来 */}
              <span className="path">{progress.file.split(/[\\/]/).pop()}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
