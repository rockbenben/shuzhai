import { useCallback, useEffect, useRef, useState } from 'react';
import { ICO } from './icons.tsx';
import { rpc } from './rpc.ts';
import {
  loadKeys, actionFor, loadSettings, saveSettings, applySettings, applyFontFaces,
  type ReadSettings,
} from './settings.ts';
import { atEndPaging, 点到哪边 } from '../core/reading-pos.ts';
import { ReviewCard, useReview } from './ReviewCard.tsx';
import { ReadSettingsPanel } from './ReadSettings.tsx';
import { TtsLayer, useSleepTimer } from './TtsLayer.tsx';
// 「书签与划线」的回看面板，**和 txt 阅读器共用这一份**
import { HighlightsPanel } from './HighlightsPanel.tsx';
import { NoteCard } from './NoteCard.tsx';
import { useTts } from './useTts.ts';
import { NightToggle, TocHead, TtsEnginesModal } from './ReaderChrome.tsx';
import {
  画划线, 清划线, 命中, 闪一下, HL_COLORS, use色名, 画矩形, 命中矩形, 底色, RECT_CLASS,
  type 画布,
} from './highlight-view.ts';
// PDF 划线的锚：页内偏移 ↔ Range（整段判据在那个文件顶上）
import { 各页文字层, 造Range, 页内偏移 } from './pdf-text.ts';
import { COLORS, 解析矩形, type Highlight } from '../core/highlight.ts';
// 书签那一行也引 core 那一份，理由同上（`dup-decls.mjs` 盯着）
import type { Bookmark } from '../core/status.ts';
// 书内搜索的外壳共用 txt 那一份，只有「怎么搜」分岔
// ⚠️ 别叫 `命中`——那个名字已经是 `highlight-view.ts` 的「点在哪条划线上」
import { FindInBook, type Hit as 搜索命中 } from './FindInBook.tsx';
// 命中处的上下文片段。**引 core 那一份**：`【】` 是约定，抄第二份就会分叉
import { makeSnippet } from '../core/snippet.ts';

/**
 * 一次搜索最多列多少处。
 *
 * 一本几百页的 PDF 逐页解析文字要几秒，命中几百处也没人看得完。
 * ⚠️ **截断了要在界面上说出来**——这个仓库那条老规矩：
 * 悄悄截断，读起来就是「一共就这么多」。
 */
const 搜索上限 = 60;

/**
 * pdf.js 的文档，只声明用得着的那几个。
 * 不引 pdfjs 的类型：那是**动态 import** 的，在这里写个结构类型就够了。
 */
interface PDF文档 {
  getPage: (n: number) => Promise<{
    getViewport: (o: { scale: number }) => { width: number; height: number };
    render: (o: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
  }>;
}

/** epub.js 的 `Contents`——划线要它算 CFI、也要它把 CFI 还原成 Range */
interface 内容 {
  document: Document;
  cfiFromRange: (r: Range) => string;
  range: (cfi: string) => Range | null | undefined;
}
import { useAnchored, use浮层焦点 } from './anchor.ts';
// ⚠️ 引同一份类型，别在这儿另写一个 `{ name, file }`——`dup-decls.mjs` 会报
// 「同一个 rpc 两种返回类型」，而它盯的正是这个：加一个字段就会漏改一处
import type { FontFile } from './Settings.tsx';

/*
 * PDF / EPUB 的**内置查看器**。
 *
 * ⚠️ **它不是 `Reader.tsx` 的扩展，是另一个东西。** 那边整套（按字节偏移定点读、
 * `(offset, length)` 章节索引、编码探测、正文净化、繁简、划线、书签、朗读）
 * 全建立在 txt 上，对 PDF / EPUB **一条都不成立**。所以这里只有最基本的三件事：
 * 翻页、缩放、记住读到哪儿。
 *
 * 两条不能破的：
 *
 * 1. **文件走 `book://f/<bookId>`**（主进程那个协议处理器）。渲染进程
 *    `contextIsolation: true` / `nodeIntegration: false`，碰不到磁盘——
 *    spec §12 那条不因为多了个查看器就松。
 * 2. **pdf.js / epub.js 都是动态 import**。它们加起来一兆多，而绝大多数人的库
 *    是 txt：静态 import 会让**每个人**的首屏都背上这一兆。
 *    动态之后 Vite 切成单独的 chunk，只有真打开 PDF 的那一下才下载。
 *
 * 进度存在 `app_setting` 的 `viewer.<bookId>` 里，**不写 `reading_state`**：
 * 那张表的 `chapter_idx` / `percent` 是按「章」算的，而 PDF 没有章、
 * `chapter_count` 天生是 0（本文件那条「PDF 字数留 0」同理）——
 * 塞进去会让卡片显示「读到 12/0」，还会把百分比算成除零。
 */

interface Props {
  bookId: number;
  bookTitle: string;
  /** 磁盘上的路径。**只用来给「用系统程序打开」那条出路**，不在这儿读文件 */
  path: string;
  viewer: 'pdf' | 'epub';
  /**
   * 从哪儿开（PDF 是页码、EPUB 是节序号）。**不给就读上次存的位置**。
   * 「全库笔记」点一条跳过来时用得上——那时候要的是那一处，不是上次读到哪儿。
   */
  startAt?: number;
  /** 从「全库笔记」点一条：打开那本书、落到那一处 */
  onOpenBook?: (bookId: number, at?: number) => void;
  onExit: () => void;
}

/**
 * 存读到哪儿。PDF 存页码；EPUB 存 **`节:页/总页`**（比如 `2:17/21`）。
 *
 * ⚠️ **不存 CFI，也不只存节号**，两条都是量出来的：
 *
 * - **CFI 会往回滑，而且累积**：在第 2 节第 17/21 页存下 `currentLocation().start.cfi`，
 *   `display(cfi)` 回来落在**第 10 页**；从那个落点再存再回，又退到第 9 页。
 *   （CFI 指的是元素，而版面是按列分页的——一个跨页的段落会被带回它开始的那一页。）
 * - **只存节号**就是「每次都从这一章开头重看」。这本测试书第 2 节有 21 页，
 *   真实的 EPUB 一节几十页很常见。
 *
 * 用的是 `display(节)` 再 `next()` 走到那一页——**精确**，而且快：
 * 实测 21 页 419ms（每页约 20ms）。这条路以前不能走，因为
 * 「`next()` 根本不动」——那条结论是在 rAF 不跑的窗口下量的，已经作废。
 *
 * 总页数也一起存：换了字号/窗口大小之后同一节的页数会变，那时按比例折算。
 * 老格式（纯数字＝节号）照旧认，不用迁移。
 */
const posKey = (bookId: number) => `viewer.${bookId}`;

/**
 * 找出这一屏**真正在滚的那个元素**。
 *
 * 两种查看器滚的不是同一个东西：PDF 那一叠 canvas 滚的是 `.reader-body`
 * （stage 的爹，和 txt 阅读器同一个容器），而 EPUB 的滚动式滚的是
 * **epub.js 自己建的那个容器**，藏在 stage 里面、类名归它管。
 *
 * ⚠️ **与其记住它叫什么，不如当场量**——第三方库的内部类名是会变的，
 * 而「谁的内容比自己高、而且 overflow 是能滚的」这条判据不会变。
 * 记类名的那种写法出问题时是**静默的**：找不着就什么都不滚，
 * 而「没滚」和「这本书本来就一屏放得下」长得一模一样。
 */
function 找滚的(stage: HTMLElement | null): HTMLElement | null {
  if (!stage) return null;
  const 爹 = stage.parentElement;
  if (爹 && 爹.scrollHeight > 爹.clientHeight + 4) return 爹;
  for (const c of Array.from(stage.querySelectorAll<HTMLElement>('*'))) {
    if (c.scrollHeight <= c.clientHeight + 4) continue;
    const o = getComputedStyle(c).overflowY;
    if (o === 'auto' || o === 'scroll') return c;
  }
  return 爹;
}

export function FileViewer({ bookId, bookTitle, path, viewer, startAt, onOpenBook, onExit }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  /** busy 拖过 6 秒——只用来把「用系统程序打开」提前摆出来，不影响打开流程 */
  const [慢了, set慢了] = useState(false);
  /** PDF：第几页 / 共几页。EPUB 用不到页码，显示百分比 */
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [pct, setPct] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  /** 自动滚开着没有。翻页模式下这个键是灰的——那一档滚不动 */
  const [滚着, set滚着] = useState(false);
  /** 翻页要用到的东西，存在 ref 里——它们不参与渲染 */
  const api = useRef<{ goto?: (n: number) => void; prev?: () => void; next?: () => void }>({});
  const { reviewing, setReviewing, askReview, openReview, closeReview } = useReview(bookId);
  /**
   * **EPUB 的目录。** PDF 没有，永远是空数组——右轨那个键也就不出现。
   *
   * 原来这个查看器一个目录都没有：一本一百节的 EPUB，唯一的走法是
   * 「下一页」点一百下。而 txt 阅读器有目录、legado 也有——
   * **同一个人换个格式，书就从「翻得动」变成「只能一路往下按」**。
   */
  const [toc, setToc] = useState<Array<{ label: string; index: number }>>([]);
  const [tocOpen, setTocOpen] = useState(false);
  /** 「书签与划线」那一层。**和 txt 阅读器同一个组件**，不在这儿抄一份 */
  const [看笔记面板, set看笔记面板] = useState(false);
  /** 书内搜索那一层。同样是 txt 那个组件，只有「怎么搜」不一样 */
  const [搜索开, set搜索开] = useState(false);
  /* 同 `Reader.tsx`：目录不走 `useAnchored`，焦点那条规矩单独接 */
  const 目录键 = useRef<HTMLButtonElement>(null);
  const 目录层 = useRef<HTMLElement>(null);
  use浮层焦点(tocOpen, 目录键, 目录层);
  const [tocFilter, setTocFilter] = useState('');
  /**
   * **用户自己加的目录**（只给 PDF）。
   *
   * 很多 PDF 根本没有 outline，有的那些也常常是乱的——那时候一本几百页的书
   * **在应用里没有任何导航**，只能拖滑块。GoodNotes 把这件事做成了正经功能
   * （「Create an outline」：自己加、改名、删，导入的 PDF 目录烂了也能重建）。
   */
  const [自建目录, set自建目录] = useState<Array<{ page: number; title: string }>>([]);
  /** 正在改哪一条自建目录（按 `页:名` 认）。`null` 就是没在改 */
  const [改目录, set改目录] = useState<{ key: string; draft: string } | null>(null);
  /** 现在在第几节（0 起）。PDF 那边看 `page`，这个只有 EPUB 用 */
  const [sec, setSec] = useState(0);
  /**
   * 阅读设置。**只为了那个白天/夜间键**——不是把整个设置浮层搬过来。
   *
   * 缺它的后果是：EPUB 的纸色只在**打开那一刻**读一次，
   * 而这个界面上没有任何改它的入口。天黑了想切夜间，得退出查看器、
   * 随便找一本 txt 打开、在那儿切、再退出来重新开这本 EPUB——
   * 而「天黑了」按 `Reader.tsx` 自己的说法是**最高频的一次点击**，
   * 它在那边单独占着一个轨位。
   */
  const [settings, setSettings] = useState<ReadSettings>(loadSettings);
  /** 改一项设置。**和 `Reader.tsx` 那份同名同形**——两边现在共用同一个面板 */
  const set = <K extends keyof ReadSettings>(k: K, v: ReadSettings[K]) =>
    setSettings((p) => ({ ...p, [k]: v }));
  const [panel, setPanel] = useState(false);
  const [ttsOpen, setTtsOpen] = useState(false);
  const [管引擎, set管引擎] = useState(false);

  /*
   * **朗读。** 用户的原话：「阅读界面上很多按钮怎么都没在非 txt 文件上出现，
   * 比如朗读」——而 EPUB 的正文**就在那个 iframe 里**（当场量的，一节 6981 个字），
   * PDF 也能问 pdf.js 要文字层。也就是说这件事从来不是做不了，是没做。
   *
   * 界面和 txt 阅读器**共用 `TtsLayer`**，两边唯一的差别是「念的是什么」：
   * 那边给整章正文，这边给当前这一节 / 这一页的文字。
   */
  const [正文, set正文] = useState('');

  /*
   * **划线。** 用户的原话：「划线也能做吧，我看其他项目也有的」——能做，
   * 只是要另一套锚：EPUB 用 CFI range，整段判据在 `highlight-view.ts` 上面。
   * PDF 暂时没有：它要文字层的矩形，而扫描版连文字层都没有。
   */
  const [划线们, set划线们] = useState<Highlight[]>([]);
  /** 这一屏有几条划线还原不出来。**不是 0 就要说一句**（见 `重画划线`） */
  const [漂了, set漂了] = useState(0);
  /** 刚选中、还没落库的那一段 */
  /**
   * 刚选中、还没落库的那一段。**锚按格式分两种**：
   * EPUB 是一条 CFI；PDF 是「第几页 + 页内第几个字 + 多长」。
   * 存的时候按有没有 `cfi` 分岔——那也正是库里那一行的分岔。
   */
  const [待划, set待划] = useState<
    {
      text: string;
      cfi?: string;
      /** **PDF 框选出来的那一块**：`"x,y,w,h"`。有它的时候偏移和长都是占位 */
      rect?: string;
      锚: { 位置: number; 偏移: number; 长: number };
      at: { top: number; 锚顶: number; left: number };
    } | null
  >(null);
  const [笔记草稿, set笔记草稿] = useState<string | null>(null);
  /**
   * **框选模式（只对 PDF）。**
   *
   * 扫描页、插图、公式、表格——这些页**没有文字层**，
   * 一个字都选不中，于是一条笔记都做不了。参照 MarginNote：
   * 它的摘录有四种形态（空白 / 文字 / 矩形 / 套索），矩形那种不靠文字层。
   *
   * ⚠️ **得是个模式，不能一直开着**：在页上拖一下本来就是「选字」，
   * 两件事抢同一个手势。开着的时候把文字层的 `pointer-events` 关掉，
   * 选字和框选就不打架了。
   */
  const [框选中, set框选中] = useState(false);
  /** 「存成图片」那一下的状态：null 是没在存，字串是给人看的一句话 */
  const [存图, set存图] = useState<string | null>(null);
  /** pdf.js 的文档句柄。只用来重画某一页好裁出框选那一块 */
  const pdf文档 = useRef<PDF文档 | null>(null);
  /** 点开的那条带笔记的划线 */
  const [看笔记, set看笔记] = useState<
    { h: Highlight; text: string; at: { top: number; 锚顶: number; left: number } } | null
  >(null);
  /** epub.js 的 Contents，选区和还原都要它 */
  /**
   * 拿当前这一节的 `Contents`。
   *
   * ⚠️ **必须用的时候现问 `rendition.getContents()`，不能在 `hooks.content` 里存下来。**
   *
   * 那个钩子跑得太早——那一刻 `Contents.cfiBase` 还没装上，
   * 于是 `cfiFromRange` 算出来的是 `epubcfi(/!/4/4,/1:3,/1:15)`：
   * **少了 spine 那一段**（本该是 `/6/6!`）。存下来一看没毛病，
   * 而它**还原不回任何 Range**，于是划线一条都画不出来，屏幕上什么都不说。
   * 当场就是这么栽的：库里存了一条、`CSS.highlights` 是空的。
   */
  const 渲染器 = useRef<{ getContents: () => unknown } | null>(null);
  const 当前内容 = useCallback((): 内容 | null => {
    const cs = 渲染器.current?.getContents?.() as 内容 | 内容[] | undefined;
    const c = Array.isArray(cs) ? cs[0] : cs;
    // 只判 document：`cfiFromRange` / `range` 在类型上必然存在，判了也白判
    return c?.document ? c : null;
  }, []);
  const 划线们Ref = useRef<Highlight[]>([]);
  划线们Ref.current = 划线们;
  /**
   * `取画布` 隔一个 ref 才给那个大 effect 用。
   * 理由和 `Reader.tsx` 的 `收浮层` 一样：**effect 的闭包只建一次**，
   * 而 `取画布` 在它后面几百行才定义，写进依赖数组会在渲染时命中 TDZ。
   */
  const 取画布Ref = useRef<() => 画布 | null>(() => null);
  const secRef = useRef(0);
  /** 取当前这一屏的文字。两个分支各自装上，`画` / `翻到` 落地之后调 */
  const 取正文 = useRef<() => Promise<string>>(async () => '');
  /** 还有没有下一屏——「一章念完接着念下一章」要问它 */
  const 还有下一屏 = useRef<() => boolean>(() => false);
  /**
   * 书内搜索：**怎么搜由这个 ref 给**（PDF 逐页问文字层、EPUB 逐节加载）。
   * 放 ref 里的理由和 `取正文` 一样：实现活在那个只跑一次的大 effect 里。
   */
  const 搜正文 = useRef<(q: string) => Promise<搜索命中[]>>(async () => []);
  /** 目录里第 i 条叫什么（搜索结果要显示章名）。目录是异步取回来的，所以走 ref */
  const 目录名 = useRef<(i: number) => string | null>(() => null);
  const 计时 = useSleepTimer();
  const { 睡到, set睡到, 睡到Ref } = 计时;

  /**
   * 一节 / 一页念完了：**翻过去，接着念**。
   *
   * 判据抄 `Reader.tsx` 那份：「这一章念完就停」那一档在这儿认，
   * 按分钟定的那档由下面那个 effect 管。返回 `true` 表示「翻过去了，接着念」。
   */
  const onChapterEnd = useCallback(() => {
    if (睡到Ref.current === 'chapter') { set睡到(null); return false; }
    if (!还有下一屏.current()) return false;
    // 翻过去就行——念新的这一屏由「正文变了」那条 effect 接手
    api.current.next?.();
    return true;
  }, [睡到Ref, set睡到]);

  const tts = useTts(settings, onChapterEnd);

  /*
   * 两条轨、三个浮层，**和 txt 阅读器一套定位**（整段判据在 `anchor.ts` 上面）：
   * 左上那条开「设置」，右下那条开「评价」。
   */
  const mainRef = useRef<HTMLDivElement>(null);
  const 左轨 = useRef<HTMLElement>(null);
  const 右轨 = useRef<HTMLDivElement>(null);
  const 设置键 = useRef<HTMLButtonElement>(null);
  const 评价键 = useRef<HTMLButtonElement>(null);
  const 设置层 = useRef<HTMLDivElement>(null);
  const 评价层 = useRef<HTMLDivElement>(null);

  /*
   * ⚠️ **字体要在挂载时就注入，不能等设置面板被打开。**
   * 判据抄 `Reader.tsx`：不注入的话「装好字体 → 直接开书」这条最正常的路上
   * 字体不生效，而面板里还选得到，看起来像装坏了。
   */
  useEffect(() => {
    void rpc<FontFile[]>('font.list').then(applyFontFaces).catch(() => {});
  }, []);


  /*
   * ── 繁简 ────────────────────────────────────────────
   *
   * 用户的原话：「只要是文字都该支持简繁」。两半的做法不一样：
   *
   * | | 转的是什么 | 怎么转 |
   * |---|---|---|
   * | EPUB | **iframe 里真正的文字节点** | 就地换掉 `nodeValue`，屏幕上立刻变 |
   * | PDF | **只有朗读念的那段文字** | 那一页是 canvas 上的图，字形改不了 |
   *
   * ⚠️ **不把 opencc 打进渲染包。** 它是主进程的依赖（唯一一个运行时依赖），
   * 搬进渲染进程会让安装包白白变大一截。`convert.preview` 这个 rpc
   * 本来就是「转一段文字」——名字是给规则预览起的，做的事正是这个，直接用。
   */
  const [繁简, set繁简] = useState('off');
  const 繁简Ref = useRef('off');
  繁简Ref.current = 繁简;
  /** 转完一轮把它 +1，逼「取正文」重取一遍（朗读念的是那一份） */
  const [文本版, set文本版] = useState(0);
  useEffect(() => {
    void rpc<string>('convert.get', { bookId }).then((m) => set繁简(m || 'off')).catch(() => {});
  }, [bookId]);

  /** 现在挂着的所有 `Contents`。**无限下滑那档同时有好几节** */
  const 所有内容 = useCallback((): 内容[] => {
    const cs = 渲染器.current?.getContents?.() as 内容 | 内容[] | undefined;
    const 组 = Array.isArray(cs) ? cs : cs ? [cs] : [];
    return 组.filter((c) => !!c?.document);
  }, []);

  /**
   * 每个文本节点的**原文**。
   *
   * ⚠️ **切模式必须从原文重转，不能在转过的结果上再转。** 简→繁→简 两趟下来
   * 不保证回得到原样（一简对多繁那些字），而用户以为「切回原文」就是原文。
   * `WeakMap` 挂在节点上：那一节被 epub.js 卸掉，这份记录跟着走。
   */
  const 原文 = useRef(new WeakMap<Text, string>());

  /** 把一篇文档里的文字节点按 `mode` 换掉。`off` 是**还原成原文** */
  const 转一篇 = useCallback(async (d: Document | undefined, mode: string) => {
    if (!d?.body) return;
    const 走 = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    const 节点: Text[] = [];
    for (let n = 走.nextNode(); n; n = 走.nextNode()) {
      const t = n as Text;
      if ((t.nodeValue ?? '').trim()) 节点.push(t);
    }
    if (!节点.length) return;
    for (const t of 节点) if (!原文.current.has(t)) 原文.current.set(t, t.nodeValue ?? '');
    if (mode !== 'to-simplified' && mode !== 'to-traditional') {
      for (const t of 节点) {
        const o = 原文.current.get(t);
        if (o != null && t.nodeValue !== o) t.nodeValue = o;
      }
      return;
    }
    /*
     * **一次 rpc 转一整节**，不是一个节点一次：一节有几百个文字节点，
     * 那就是几百次往返。拿一个正文里绝不会出现的字符拼起来再拆开——
     * 实测 opencc 原样放行它（`convert.preview` 送 5 段回来 5 段）。
     * ⚠️ 源码里写 `\u0000` 这个转义，**不能敲一个真的 NUL 字节**：
     * 那会让整个文件从 grep / git diff 里消失（AGENTS.md 有一整节讲这个）。
     */
    const 分 = '\u0000';
    const 原 = 节点.map((t) => 原文.current.get(t) ?? '');
    try {
      const 出 = (await rpc<string>('convert.preview', { text: 原.join(分), mode })).split(分);
      // 对不上就一个字都不动——宁可不转，也别整篇错位
      if (出.length !== 节点.length) return;
      节点.forEach((t, i) => { if (t.nodeValue !== 出[i]) t.nodeValue = 出[i]; });
    } catch { /* 转不了就维持原文，别连累读书 */ }
  }, []);

  /** 把 `mode` 套到现在挂着的每一节上 */
  const 套繁简 = useCallback(async (mode: string) => {
    await Promise.all(所有内容().map((c) => 转一篇(c.document, mode)));
  }, [所有内容, 转一篇]);

  /** 一段纯文字过一道繁简。PDF 的文字层走这条（它没有 DOM 可换） */
  const 转文字 = useCallback(async (t: string) => {
    const m = 繁简Ref.current;
    if (!t || (m !== 'to-simplified' && m !== 'to-traditional')) return t;
    try { return await rpc<string>('convert.preview', { text: t, mode: m }); } catch { return t; }
  }, []);

  /*
   * 换了繁简：整篇重转 → **划线重画** → 逼朗读那份正文重取。
   *
   * ⚠️ **顺序不能反。** 换 `nodeValue` 会把已经画上的 Range 作废
   * （原生高亮认的是节点和偏移），不重画一遍屏幕上的划线就没了。
   */
  useEffect(() => {
    void 套繁简(繁简).then(() => {
      重画划线.current();
      set文本版((v) => v + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [繁简]);

  const 存位置 = useCallback((v: string) => {
    void rpc('setting.set', { key: posKey(bookId), value: v }).catch(() => {});
  }, [bookId]);

  useEffect(() => {
    let 死了 = false;
    let 收尾: (() => void) | undefined;
    /*
     * **这一趟按哪种阅读方式画。** 取一次存进局部量，底下几处都读它——
     * 不直接读 `settings.mode` 是因为这个 effect 的闭包只建一次，
     * 而依赖里已经有它了（换档会整个重跑）。
     */
    const 模式 = settings.mode;
    const 分页 = 模式 === 'page';

    void (async () => {
      try {
        /*
         * ⚠️ **告诉库一声「这本被打开过」。**
         * PDF / EPUB 的进度存在 `app_setting` 里、不在 `reading_state`，
         * 而书架上的「多久前」、默认排序「读过的排最前」、侧栏「在读」
         * 全从那张表取数——不说这一句，一本读了一百页的 PDF
         * 在书架上和从没打开过的书一模一样。
         * `markOpened` 只写 `last_read_at` 和状态提升，进度一个字都不碰。
         */
        void rpc('reading.markOpened', { bookId }).catch(() => {});
        /*
         * ⚠️ **`startAt` 压过存下来的位置，但不写回去。**
         * 从「全库笔记」点一条跳过来时，要的是**那一处**，不是上次读到哪儿。
         * 写回去是等翻页时 `存位置` 自己做的事——那和「我确实去了那儿」一致。
         */
        const 存的 = startAt !== undefined
          ? String(startAt)
          : await rpc<string>('setting.get', { key: posKey(bookId) }).catch(() => '');
        if (死了) return;
        const el = box.current;
        if (!el) return;
        const url = `book://f/${bookId}`;

        if (viewer === 'pdf') {
          const pdfjs = await import('pdfjs-dist');
          // worker 也得走打包出来的地址，不然它会去 CDN 拿
          const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
          pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
          // ⚠️ `destroy()` 在 **loadingTask** 上，不在 document 上（v6 的类型说得很清楚）
          const task = pdfjs.getDocument({ url });
          const doc = await task.promise;
          if (死了) { void task.destroy(); return; }
          // 把句柄留下来：「把框选那一块存成图片」要拿它重新画一遍那一页
          pdf文档.current = doc as unknown as PDF文档;
          setPages(doc.numPages);
          收尾 = () => void task.destroy();

          /*
           * **每一页是「画布 + 文字层」两层叠在一起**，不是光一张 canvas。
           *
           * 文字层是 pdf.js 自带的那套（`TextLayer`）：一堆绝对定位、
           * 颜色透明的 span 压在画布上，位置和画上去的字**逐字对齐**。
           * 它带来三件本来做不到的事：**能选中、能复制、能划线**——
           * 也就是「PDF 只能看不能做笔记」那条限制的根。
           *
           * ⚠️ **扫描版 PDF 没有文字层**（`getTextContent` 回来是空的），
           * 那时候这一层是个空 div，选不中也划不了——界面上照实说，
           * 不摆一个点了没反应的键（同朗读那边「这一页没有可念的文字」）。
           */
          const 造页 = () => {
            const 壳 = document.createElement('div');
            壳.className = 'pdf-page';
            const c = document.createElement('canvas');
            c.className = 'viewer-page';
            const t = document.createElement('div');
            // ⚠️ 类名必须是 `textLayer`：那套 CSS 是从
            // `node_modules/pdfjs-dist/web/pdf_viewer.css` 原样搬过来的
            // （见 `styles.css`），选择器写死了这个名字。
            // **写全路径不写文件名**：`stale-refs.mjs` 才查得到它——
            // 升级 pdf.js 时那个文件挪了位，这句话就该跟着改
            t.className = 'textLayer';
            壳.append(c, t);
            return { 壳, 画布: c, 文字层: t };
          };

          /** 把这一页的文字层铺上。**画布画完再铺**，两者用同一个 viewport 才对得齐 */
          const 铺字 = async (t: HTMLElement, pg: unknown, vp: unknown, 壳: HTMLElement) => {
            try {
              t.replaceChildren();
              // pdf.js 的文字层靠这个变量算字号，不设的话所有字挤成一坨
              壳.style.setProperty('--total-scale-factor', String((vp as { scale: number }).scale));
              const tc = await (pg as { getTextContent: () => Promise<unknown> }).getTextContent();
              const TL = (pdfjs as unknown as { TextLayer?: new (o: unknown) => { render: () => Promise<void> } }).TextLayer;
              if (!TL) return;
              await new TL({ textContentSource: tc, container: t, viewport: vp }).render();
            } catch { /* 没有文字层就是选不中，不该连累这一页画出来 */ }
          };

          const 单页 = 造页();
          const canvas = 单页.画布;
          // 连着滚那一档不用这一张（它自己摆一叠），所以只有翻页模式才挂上去
          if (分页) el.replaceChildren(单页.壳);

          let 当前 = Math.min(Math.max(1, Number(存的) || 1), doc.numPages);
          let 画到第几页 = 0;
          /*
           * ⚠️ **上一次的渲染任务要留个把手，下一次开画之前先 `cancel()`。**
           *
           * 没有它的时候这个查看器**根本翻不了页**——右轨、底部那对键、键盘、
           * 底部滑块，四条路一条都不动，而且**一句话都没有**。当场抓到的是这个：
           *
           *     DBG render 开始 1        ← 第一页开始画
           *     （从来没有「完成 1」）
           *     DBG render 开始 2
           *     reject: Cannot use the same canvas during multiple render() operations.
           *
           * 也就是说：第一页那个 `render().promise` 挂住不 resolve（下面那段
           * 15 秒兜底记的就是同一个挂法），而**超时只放掉了 `busy`，没放掉那个
           * 渲染任务**——它还占着 canvas。往后每一次 `画` 都被 pdf.js 当场拒掉，
           * 而调用处是 `void 画(...)`，这个 reject 被整个吞掉。
           *
           * 症状于是是「一页渲染完好的 PDF，页码永远停在 1」——
           * **看起来比坏掉还正常**，正是这个仓库反复记的那类
           * 「工具静默地什么都没做，而『没做』和『没问题』长得一模一样」。
           *
           * pdf.js 那句报错自己给了两条出路（cancelled 或 completed），
           * 这里取前一条：`cancel()` 之后旧任务会 reject 一个
           * `RenderingCancelledException`，那是**正常路径不是错**，所以下面
           * 那个 catch 什么都不做（真出错的话上面 `这次 !== 画到第几页` 会拦住它）。
           */
          let 画着: { cancel: () => void; promise: Promise<unknown> } | null = null;
          const 画 = async (n: number, z: number) => {
            当前 = Math.min(Math.max(1, n), doc.numPages);
            const 这次 = ++画到第几页;
            const p = await doc.getPage(当前);
            if (死了 || 这次 !== 画到第几页) return;
            // 按容器宽度铺满，再乘用户的缩放
            const 原 = p.getViewport({ scale: 1 });
            const scale = ((el.clientWidth - 24) / 原.width) * z;
            const vp = p.getViewport({ scale: Math.max(0.1, scale) });
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            canvas.width = Math.floor(vp.width);
            canvas.height = Math.floor(vp.height);
            画着?.cancel();
            const 这一次 = p.render({ canvas, canvasContext: ctx, viewport: vp });
            画着 = 这一次;
            // cancel 掉的那次会 reject，那是正常路径；真的画失败也不该让页码卡住不动
            await 这一次.promise.catch(() => {});
            if (死了 || 这次 !== 画到第几页) return;
            单页.壳.dataset.n = String(当前);
            await 铺字(单页.文字层, p, vp, 单页.壳);
            if (死了 || 这次 !== 画到第几页) return;
            // 文字层刚换过，这一页的划线要重画（判据同 EPUB 换节那一处）
            setTimeout(() => 重画划线.current(), 30);
            setPage(当前);
            存位置(String(当前));
            到底了.current(当前 - 1, doc.numPages); // 页码 1 起，判据要 0 起
          };
          /*
           * **PDF 自己的书签（outline）就是它的目录。**
           *
           * 技术书、扫描书的 PDF 几乎都带；带了却不给入口，等于让人在一本
           * 三百页的书里靠底部那根滑块找章节。EPUB 那边刚补上目录，
           * 这边是对称的那一半——**用的是同一个 `toc` state、同一套 `.toc` 界面**。
           *
           * ⚠️ **页号必须问 `getPageIndex(ref)` 要**，不能按书签的顺序数：
           * 一页上可以挂好几条书签（小节），也有书签指向的页不在书签表里。
           * 判据和 EPUB 那边「序号必须问 `spine.get(href)` 要」是同一条。
           *
           * `dest` 有两种形态：字符串（命名目标，要再查一次）和数组（直接指页对象）。
           * 两种都认——真实的 PDF 两种都有。取不到页号的条目直接丢掉，
           * 不摆一个点了不动的按钮。
           */
          void (async () => {
            try {
              const d = doc as unknown as {
                getOutline?: () => Promise<Array<{ title?: string; dest?: unknown; items?: unknown[] }> | null>;
                getDestination?: (name: string) => Promise<unknown[] | null>;
                getPageIndex?: (ref: unknown) => Promise<number>;
              };
              const 树 = await d.getOutline?.();
              if (!树 || 死了) return;
              const 平: Array<{ label: string; index: number }> = [];
              const 走 = async (items: Array<{ title?: string; dest?: unknown; items?: unknown[] }>, 深: number) => {
                for (const it of items ?? []) {
                  const 名 = (it.title ?? '').trim();
                  let 页: number | undefined;
                  try {
                    const dest = typeof it.dest === 'string' ? await d.getDestination?.(it.dest) : it.dest;
                    const ref = Array.isArray(dest) ? dest[0] : undefined;
                    if (ref !== undefined && ref !== null) 页 = (await d.getPageIndex?.(ref)) ?? undefined;
                  } catch { /* 这一条指不到页就丢掉它，别连累整棵树 */ }
                  if (名 && typeof 页 === 'number') 平.push({ label: '　'.repeat(深) + 名, index: 页 + 1 });
                  if (Array.isArray(it.items)) await 走(it.items as typeof items, 深 + 1);
                }
              };
              await 走(树, 0);
              if (!死了) setToc(平);
            } catch { /* 没书签就没目录，右轨那个键自己不出现 */ }
          })();

          /*
           * PDF 的文字层。**扫描版取不到**——那是一张图，`items` 会是空的，
           * 界面上因此会说「这一页没有可念的文字」而不是摆一个点了没反应的键。
           */
          取正文.current = async () => {
            try {
              const pg = await doc.getPage(当前);
              const tc = await (pg as unknown as {
                getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
              }).getTextContent();
              // 朗读念的是这一份，所以繁简要在这儿套上——那一页的**图**改不了，
              // 但念出来的字是真文字（用户：「只要是文字都该支持简繁」）
              return await 转文字(tc.items.map((i) => i.str ?? '').join(''));
            } catch { return ''; }
          };
          还有下一屏.current = () => 当前 < doc.numPages;

          /*
           * **书内搜索：逐页问文字层要字。**
           *
           * ⚠️ **不能只搜已经画出来的那几页**——「连着往下滚」那一档只画看得见的，
           * 搜索要覆盖整本。所以走 `doc.getPage(n).getTextContent()`，
           * 那是不渲染也拿得到的（`取正文` 已经在用同一条路）。
           *
           * ⚠️ **要有上限，而且要说出来。** 一本几百页的书逐页解析要几秒，
           * 命中几百处也没人会看完。封顶 60 处并在界面上写明「只列前 60 处」——
           * 这个仓库那条老规矩：**悄悄截断，读起来就是「一共就这么多」**。
           */
          搜正文.current = async (q) => {
            const 词 = q.trim();
            if (!词) return [];
            const 出: 搜索命中[] = [];
            for (let n = 1; n <= doc.numPages && 出.length < 搜索上限; n++) {
              if (死了) break;
              let 文 = '';
              try {
                const pg = await doc.getPage(n);
                const tc = await (pg as unknown as {
                  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
                }).getTextContent();
                文 = tc.items.map((i) => i.str ?? '').join('');
              } catch { continue; }
              // 一页里可能有好几处，逐个往后找
              let at = 文.indexOf(词);
              while (at >= 0 && 出.length < 搜索上限) {
                出.push({ chapterIdx: n, chapterTitle: `第 ${n} 页`, snippet: makeSnippet(文, 词, 12, at) });
                at = 文.indexOf(词, at + 词.length);
              }
            }
            return 出;
          };

          if (分页) {
            /* **一次一页：一张 canvas 反复重画。**下面 else 那档是一叠 canvas */
            api.current = {
              goto: (n) => void 画(n, zoomRef.current),
              prev: () => void 画(当前 - 1, zoomRef.current),
              next: () => void 画(当前 + 1, zoomRef.current),
            };
            重画.current = () => void 画(当前, zoomRef.current);
            /*
             * ⚠️ **首次渲染要有超时兜底——EPUB 那边早有，PDF 这边一直没有。**
             *
             * `p.render(...).promise` **会一直不 resolve**。当场量的：
             * canvas 三秒就画出来了、页面上那一页清清楚楚能读，
             * 而 `存位置` 从没跑过（`viewer.<id>` 一行都没有）、`busy` 永远是 true，
             * 于是屏幕上是**一页渲染完好的 PDF 压着一句「正在打开…」**，而且再也不消失。
             *
             * ✅ **根因和 EPUB 那段是同一个**：窗口不可见 → rAF 0 帧 →
             * pdf.js 的分块渲染卡在第二块（第一块是同步画的，所以看得见）。
             * 详见下面 EPUB 那段和 `docs/lessons.md`。
             *
             * 15 秒和 EPUB 那两段是同一个数。超时之后照样把 `busy` 放掉：
             * 那一页多半已经画在 canvas 上了，让人读比让人对着转圈强；
             * 真没画出来的话，剩下的是空白页加两条轨——**也仍然比永远转圈诚实**。
             */
            await Promise.race([
              画(当前, 1),
              new Promise<void>((r) => setTimeout(r, 15000)),
            ]);
          } else {
            /*
             * **连着往下滚：一页一个 canvas 竖着排，滚到哪画哪。**
             *
             * ⚠️ **不能一次全画出来。** 五百页的 PDF 那是五百张位图——
             * 一张 A4 按容器宽度画出来就是好几兆显存，全画等于当场把标签页撑爆。
             * 所以先摆五百个**空 canvas 占位**（高度按第一页的比例估），
             * 用 `IntersectionObserver` 滚到谁画谁，前后各多画一张当缓冲。
             *
             * 滚的是 `.reader-body`（`el.parentElement`）——**和 txt 阅读器
             * 同一个滚动容器**，纸色、上边距、两条轨的定位全都照旧成立，
             * 这儿一个字都不用新写。
             *
             * ponytail: 占位高度用第一页的比例。混排页宽的 PDF（扫描件里
             * 偶尔有横过来的插页）会在画到那一页的时候抖一下——真碰到了
             * 再逐页问 `getPage` 要尺寸，那是 500 次异步解析换一个不抖。
             */
            const 纸 = document.createElement('div');
            纸.className = 'viewer-stack';
            const 首视 = (await doc.getPage(1)).getViewport({ scale: 1 });
            const 格: HTMLCanvasElement[] = [];
            /** 每一页的文字层，和 `格` 一一对应（下标就是页号减一） */
            const 字层: HTMLElement[] = [];
            for (let i = 1; i <= doc.numPages; i++) {
              const { 壳, 画布, 文字层 } = 造页();
              画布.dataset.n = String(i);
              // 尺寸挂在**壳**上：文字层是 `inset: 0` 铺满壳的，画布跟着壳走
              壳.dataset.n = String(i);
              壳.style.width = `${100 * zoomRef.current}%`;
              壳.style.aspectRatio = `${Math.round(首视.width)} / ${Math.round(首视.height)}`;
              格.push(画布);
              字层.push(文字层);
              纸.appendChild(壳);
            }
            el.replaceChildren(纸);

            const 画好了 = new Set<number>();
            const 看得见 = new Set<number>();
            const 画一页 = async (n: number, 重来 = false) => {
              if (n < 1 || n > doc.numPages || 死了) return;
              if (画好了.has(n) && !重来) return;
              画好了.add(n);
              const c = 格[n - 1];
              const p = await doc.getPage(n);
              if (死了) return;
              const 原 = p.getViewport({ scale: 1 });
              // 按它显示出来多宽画，屏幕上就是一比一清晰；`clientWidth` 是 0 时
              // （还没排版）退回容器宽度
              const 宽 = (c.parentElement as HTMLElement | null)?.clientWidth
                || c.clientWidth || Math.max(1, el.clientWidth - 24);
              const vp = p.getViewport({ scale: Math.max(0.1, 宽 / 原.width) });
              const ctx = c.getContext('2d');
              if (!ctx) return;
              c.width = Math.floor(vp.width);
              c.height = Math.floor(vp.height);
              const 壳 = c.parentElement as HTMLElement;
              壳.style.aspectRatio = `${Math.round(vp.width)} / ${Math.round(vp.height)}`;
              // 画失败不该连累别的页；被 cancel 掉也走这条
              await p.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise.catch(() => {});
              if (死了) return;
              await 铺字(字层[n - 1], p, vp, 壳);
              if (死了) return;
              // 滚到哪画到哪，划线也跟着补上——不补的话滚过去那几页是空的
              setTimeout(() => 重画划线.current(), 30);
            };

            const 滚 = el.parentElement;
            /*
             * **观察器只管「该画哪几页」，不管「现在读到第几页」。**
             *
             * ⚠️ 这两件事一度合在一起，当场栽了：`rootMargin` 是 300px，
             * 于是**刚滚过去的那一页仍然算 intersecting**，取 `min(看得见)`
             * 取到的是上一页。表现是**切到「下滑」之后页脚从 2/3 退回 1/3**，
             * 而且顺手把 `viewer.<id>` 覆盖成了 1——
             * 又一次「进度悄悄倒退，一句话都不说」。
             *
             * 页码改成按几何算（`算当前`）：**第一张下沿还在视口顶下面的**
             * 就是正在读的那一页。rootMargin 怎么设都不影响它。
             */
            const io = new IntersectionObserver((条目) => {
              for (const e of 条目) {
                const n = Number((e.target as HTMLElement).dataset.n);
                if (!Number.isFinite(n)) continue;
                if (e.isIntersecting) {
                  看得见.add(n);
                  void 画一页(n);
                  void 画一页(n + 1);
                  void 画一页(n - 1);
                } else {
                  看得见.delete(n);
                }
              }
            }, { root: 滚, rootMargin: '300px 0px' });
            for (const c of 格) io.observe(c);

            const 算当前 = () => {
              if (!滚 || 死了) return;
              const 视口顶 = 滚.getBoundingClientRect().top;
              let n = doc.numPages;
              for (let i = 0; i < 格.length; i++) {
                if (格[i].getBoundingClientRect().bottom > 视口顶 + 8) { n = i + 1; break; }
              }
              if (n !== 当前) {
                当前 = n;
                setPage(当前);
                存位置(String(当前));
              }
              /*
               * **滚到整本的底 = 读完了。** 翻页模式那条判据（`页 >= 总`）
               * 在这儿不成立——所有 canvas 一直都在，没有「翻到最后一页」
               * 这个动作，只有「滚到底」。
               */
              if (滚.scrollTop + 滚.clientHeight >= 滚.scrollHeight - 4) {
                到底了.current(doc.numPages - 1, doc.numPages);
              }
            };
            滚?.addEventListener('scroll', 算当前, { passive: true });
            const 前一个收尾 = 收尾;
            收尾 = () => { io.disconnect(); 滚?.removeEventListener('scroll', 算当前); 前一个收尾?.(); };

            /** 滚到某一页的页首。目录点一条、底部跳页都走这里 */
            const 滚到 = (n: number) => {
              const c = 格[Math.min(Math.max(1, n), doc.numPages) - 1];
              c?.scrollIntoView({ block: 'start' });
            };
            api.current = {
              goto: (n) => 滚到(n),
              prev: () => 滚到(当前 - 1),
              next: () => 滚到(当前 + 1),
            };
            /*
             * 缩放：改的是每个 canvas 显示多宽，画布本身跟着重画一遍——
             * 只重画**看得见的那几页**，其余的等滚过去自然会画。
             */
            重画.current = () => {
              const z = zoomRef.current;
              for (const c of 格) ((c.parentElement as HTMLElement).style.width = `${100 * z}%`);
              for (const n of 看得见) void 画一页(n, true);
            };

            // 先把要看的那一页画出来再滚过去——滚到一张空 canvas 上会闪一下白
            await Promise.race([
              画一页(当前).then(() => 滚到(当前)),
              new Promise<void>((r) => setTimeout(r, 15000)),
            ]);
            /*
             * ⚠️ **首次那一下必须直接 `setPage`，不能只叫 `算当前`。**
             * `算当前` 里那句「变了才写」是防滚动时的 rpc 刷屏的，
             * 而开书这一刻 `当前` 本来就等于存的那一页——于是它什么都不做，
             * 而 React 那个 `page` 还停在初值 1。表现是**滚动条明明停在第 3 页，
             * 页脚却写着 1/3**（实测），又一个「看起来像没读过」。
             */
            setPage(当前);
            // 再对一次几何：`scroll` 事件只有人真的滚了才响
            setTimeout(算当前, 200);
          }
        } else {
          /*
           * ⚠️ epub.js 的类型把默认导出标成了命名空间，直接调会被 tsc 拦下来，
           * 而**运行时它就是个函数**。所以取到手再断言一次。
           */
          const mod = await import('epubjs');
          const ePub = ((mod as unknown as { default?: unknown }).default ?? mod) as
            (u: string | ArrayBuffer, o?: Record<string, unknown>) => {
              ready: Promise<unknown>;
              renderTo: (el: HTMLElement, o: Record<string, unknown>) => {
                display: (t?: string | number) => Promise<unknown>;
                on: (
                  ev: string,
                  fn: (loc: {
                    start?: {
                      cfi?: string; index?: number; percentage?: number;
                      /** 节内第几页 / 共几页。**进度就是靠它才精确到页的**，见 `posKey` */
                      displayed?: { page?: number; total?: number };
                    };
                  }) => void,
                ) => void;
                prev: () => Promise<unknown>;
                next: () => Promise<unknown>;
                resize: (w: number, h: number) => void;
                themes: { override: (name: string, value: string, priority?: boolean) => void };
              };
              destroy: () => void;
            };
          /*
           * ⚠️ **喂字节，别喂 URL。** epub.js 是**按扩展名猜文件类型**的，
           * 而 `book://f/<id>` 没有 `.epub` 后缀——它会把这个地址当成
           * 「解压开的目录」去找 `META-INF/container.xml`，然后**一声不吭地
           * 什么都不画**（容器是空的、控制台一条错都没有，实测踩到过）。
           * 直接给 ArrayBuffer 就没有猜的余地。EPUB 通常只有几兆，整本读进来没问题。
           */
          const buf = await (await fetch(url)).arrayBuffer();
          if (死了) return;
          /*
           * ⚠️ **`openAs: 'binary'` 不能省。** 不给的话 epub.js 会去
           * `determineType()` 猜——而它是按**字符串地址**的扩展名猜的，
           * 手里是个 ArrayBuffer 时那条路走不通，结果是它**一声不吭地卡住**：
           * 容器空着、`display()` 的 promise 永远不 resolve、控制台一条错都没有
           * （实测：界面一直停在「正在打开…」）。
           */
          const bk = ePub(buf, { openAs: 'binary' });
          /*
           *  —— 整章渲染成一篇可滚的文档，「下一页」就是下一章。
           * 默认那套分页管理器在这儿**不翻页**（实测点了两下，relocated 只触发一次），
           * 而且滚动式**正好和 txt 阅读器的默认模式一致**。
           */
          /*
           * ⚠️ **传实测像素，别传 '100%'。** 量出来的（stage 1094x634）：
           * 传 '100%' 时 iframe 是 **1094x0** —— 宽对、**高是 0**，
           * 而 iframe 里面正文是好好的（body 高 169px）。也就是**书画出来了、框子没高度**，
           * 屏幕上一片空白。epub.js 的分页布局要拿这个值算数，百分号它算不出来。
           */
          /*
           * ⚠️ **量一次就用，别在这儿插 `await`。** 试过「容器还没尺寸就等几帧再量」，
           * 结果是 `renderTo` 被推到一个 await 之后，那期间组件已经卸了、`死了` 为真，
           * 直接 return —— **一个 iframe 都不建，永远停在「正在打开…」**。
           * 这一段必须一路同步走到 `renderTo`。
           */
          const 盒 = el.getBoundingClientRect();
          /*
           * **阅读方式在这儿落地。** 三档对到 epub.js 的两个旋钮上：
           *
           * | 阅读方式 | flow | manager |
           * |---|---|---|
           * | 左右翻 | （默认 paginated） | 默认 |
           * | 按章 | `scrolled-doc` | 默认——**一节一篇可滚的文档** |
           * | 无限下滑 | `scrolled` | `continuous`——**跨节一路往下** |
           *
           * ⚠️ **换档是重建整个渲染器，不是调一个属性。** `rendition.flow()`
           * 只能在同一个 manager 内部换，而「无限下滑」要的是另一个 manager。
           * 所以 `settings.mode` 进了这个 effect 的依赖：换一档，整本重开，
           * 位置从 `viewer.<id>` 恢复（每翻一页都存过，恢复到的就是刚才那一页）。
           * 重开一本 EPUB 是几百毫秒的事，而换阅读方式是低频动作。
           */
          const rend = bk.renderTo(el, {
            width: Math.round(盒.width) || '100%',
            height: Math.round(盒.height) || '100%',
            spread: 'none',
            ...(分页 ? {} : {
              flow: 模式 === 'flow' ? 'scrolled' : 'scrolled-doc',
              ...(模式 === 'flow' ? { manager: 'continuous' } : {}),
            }),
          });
          /*
           * ⚠️ **纸色和暗色必须显式送进 iframe——CSS 变量进不去。**
           *
           * 这个文件上面写着「纸色、暗色主题……全都直接生效，一行样式都不用新写」，
           * 那句话对**壳**成立、对**书**不成立：EPUB 正文活在 epub.js 建的 iframe 里，
           * 那是另一个文档，`--read-*` 一个都到不了。
           *
           * 后果不是「白底有点刺眼」，是**整本书看不见**：当场量的（暗色 + 夜间纸色）
           * iframe 里 `body` 背景是透明、字色是 `rgb(0,0,0)` —— **黑字压在深色壳上**，
           * 屏幕上只剩两条轨和页脚，看起来就像这本书没加载出来。
           * （这也是「EPUB 画不出来」那团公案里的一个混淆源：在暗色下量「画出来没有」，
           * 一本渲染得好好的书看着就是空的。）
           *
           * `themes.override` 是 epub.js 给的那个口子，legado 那边也是这么给 EPUB 上主题的。
           * **背景要 `!important`**：书自己的样式表常常给 body 写死白底，不压不过它。
           */

          /* 抽成函数是为了**改了设置能再上一次色**（挂在 `重上色` 上，见上面那段）。
             `themes.override` 是幂等的：同一个属性再压一次就是换个值。 */
          const 上色 = () => {
            const cs = getComputedStyle(document.documentElement);
            const 纸 = cs.getPropertyValue('--read-paper').trim();
            const 墨 = cs.getPropertyValue('--read-ink').trim();
            if (纸 && 墨) {
              rend.themes.override('background', 纸, true);
              rend.themes.override('color', 墨, true);
            }
            /*
             * ⚠️ **排版设置同样进不去，要一起送。** 量出来的（用户设的是 21px / 1.8）：
             * txt 阅读器里正文是 21px / 37.8px，而 EPUB 里是 **16px / normal** ——
             * 同一个人、同一套设置，换个格式字就小一圈。
             *
             * 只压在 `body` 上、不逐个元素压：书自己给某个元素写死的字体/字号
             * （诗集、特殊符号那种）比 body 更具体，照样赢得过去 —— 这是对的，
             * 我们要统一的是**默认值**，不是把人家的排版铲平。
             */
            const 字号 = cs.getPropertyValue('--read-size').trim();
            const 行距 = cs.getPropertyValue('--read-line').trim();
            const 字体 = cs.getPropertyValue('--read-font').trim();
            if (字号) rend.themes.override('font-size', 字号, true);
            if (行距) rend.themes.override('line-height', 行距, true);
            if (字体 && 字体 !== 'inherit') rend.themes.override('font-family', 字体, true);
            /*
             * **缩进和段距也送进去。**
             *
             * 原来只送字号 / 行距 / 字体，于是「字」那一组里有两项在 EPUB 上是哑的——
             * 而设置面板现在两边共用，摆出来点了没反应正是本仓库最反对的那种。
             * ⚠️ 这两项压在 `p` 上不是 `body` 上：`text-indent` 会被继承，
             * 压在 body 上会让标题、图注也跟着缩进一格。
             */
            const 缩进 = cs.getPropertyValue('--read-indent').trim();
            const 段距 = cs.getPropertyValue('--read-para').trim();
            const 段样式: Record<string, string> = {};
            if (缩进) 段样式['text-indent'] = 缩进;
            if (段距) 段样式['margin-bottom'] = 段距;
            if (Object.keys(段样式).length) {
              try {
                (rend as unknown as { themes?: { default?: (r: Record<string, unknown>) => void } })
                  .themes?.default?.({ p: 段样式 });
              } catch { /* 这两项送不进去不该连累纸色 */ }
            }
          };
          上色();
          重上色.current = 上色;
          渲染器.current = rend as unknown as { getContents: () => unknown };

          /*
           * EPUB 的正文**就在那个 iframe 里**。当场量的：一节 6981 个字。
           * 不用绕道 `section.load()` 再解析一遍 HTML——屏幕上那份已经是解析好的，
           * 而且和用户看到的完全一致（`innerText` 认换行、不含标记）。
           */
          取正文.current = async () => {
            try {
              const f = el.querySelector('iframe');
              return (f?.contentDocument?.body?.innerText ?? '').trim();
            } catch { return ''; }
          };

          /*
           * ⚠️ **键盘和点击都要挂进 iframe 里那个 document。**
           *
           * EPUB 正文活在 epub.js 建的 iframe 里，而**点一下正文焦点就进了 iframe**
           * （量过：`document.activeElement` 变成 `IFRAME`）。从那一刻起
           * 我们挂在 `window` 上的 keydown **一次都收不到**——
           * 也就是说「随手点一下正文」之后 ← → 彻底哑掉，而屏幕上什么都没说。
           * 当场量的：没点正文按 → 从 33% 走到 67%；点一下正文再按 →，纹丝不动。
           *
           * `hooks.content` 是 epub.js 给的正规口子，**每换一节都会再跑一次**
           * （每一节是一个新 document），所以不能只在第一节挂。
           * 整段包在 try 里：这是锦上添花，挂不上不该让书打不开。
           */
          try {
            const 挂 = (doc: Document) => {
              doc.addEventListener('keydown', (e) => 按键.current(e));
              doc.addEventListener('click', (e) => {
                const w = doc.documentElement?.clientWidth || doc.body?.clientWidth || 0;
                const 选 = doc.getSelection?.();
                /*
                 * ⚠️ **先看是不是点在一条划线上。**
                 *
                 * 原生高亮不产生任何元素，所以没有 `event.target` 可用——
                 * 只能拿坐标去和每条 Range 的矩形比（`命中`）。
                 * 命中了就把笔记摆出来、**不翻页**：在划过的字上点一下是想看当时写了什么，
                 * 而不是翻篇。
                 */
                const cc = 取画布Ref.current();
                if (cc && (!选 || 选.isCollapsed)) {
                  const h = 命中(cc, e.clientX, e.clientY, 划线们Ref.current);
                  if (h) {
                    let r: Range | null = null;
                    try { r = cc.还原(h); } catch { r = null; }
                    const at = 贴着(e.clientX, e.clientY, doc);
                    if (at) { set待划(null); set看笔记({ h, text: r?.toString() ?? '', at }); return; }
                  }
                }
                点正文.current(e.clientX, w, e.target as Element | null, !!选 && !选.isCollapsed);
              });
            };
            const h = (rend as unknown as {
              hooks?: {
                content?: {
                  register?: (f: (c: {
                    document?: Document;
                    cfiFromRange?: (r: Range) => string;
                    range?: (cfi: string) => Range | null | undefined;
                  }) => void) => void;
                };
              };
            }).hooks;
            h?.content?.register?.((c) => {
              if (!c?.document) return;
              挂(c.document);
              /*
               * ⚠️ **不在这儿把 `Contents` 存下来**（整段理由在 `当前内容` 上面）：
               * 这个钩子跑得太早，`cfiBase` 还没装上，算出来的 CFI 少了 spine 那一段。
               * 换节之后重画一次就行，`Contents` 用的时候现问。
               */
              // ⚠️ **先转繁简再重画划线**，顺序反了划线会被换掉的文字节点作废
              setTimeout(() => {
                void 转一篇(c.document, 繁简Ref.current).then(() => 重画划线.current());
              }, 60);
              // 选中一段文字：把「划线 / 划线并写笔记」那张卡贴到它下面
              c.document.addEventListener('mouseup', (e) => {
                const sel = c.document?.getSelection?.();
                if (!sel || sel.isCollapsed || sel.rangeCount === 0) { set待划(null); return; }
                const text = sel.toString().trim();
                if (!text) { set待划(null); return; }
                try {
                  const rg = sel.getRangeAt(0);
                  const cfi = 当前内容()?.cfiFromRange(rg);
                  const at = 贴着(e.clientX, e.clientY, c.document);
                  if (cfi && at) {
                    set看笔记(null);
                    // 偏移那两个是占位，EPUB 的真锚是 cfi（见 `存划线`）
                    set待划({ text, cfi, 锚: { 位置: secRef.current, 偏移: 0, 长: text.length }, at });
                  }
                } catch { /* 算不出 CFI 就当没选中——不摆一张存不下去的卡 */ }
              });
            });
          } catch { /* 挂不上就只剩右轨和底部那两对键，仍然能翻 */ }
          /*
           * ⚠️ **不调 `bk.destroy()`。** 调它会更早坏：epub.js 的 destroy 会拆掉一些
           * 它自己下次还要用的东西，而这里每次都是新建的 Book 实例，交给 GC 就行。
           * 代价：那一份 ArrayBuffer 要等 GC。EPUB 通常几兆，可以接受。
           *
           * ⚠️ **原来这句话写着「去掉这一句之后可以反复开」，而那是假的**；
           * 但反过来「开到第三本就必死」也是假的。2026-08-26 拿四种循环各跑一轮：
           *
           *   开→回书架→开（不 reload）x6        全好
           *   空 reload x6 再开                   好
           *   开→reload x6（查看器开着就导航）    全好
           *   同一个脚本，机器忙的时候            3 好 2 坏；机器闲下来再跑 5/5 全好
           *
           * 所以它**不是「开了几次」的资源上限，是时序/负载敏感的偶发**——
           * 那一轮失败发生在刚跑完 audit + review + walk + 打包之后。
           * 已经量掉的，别重查：
           *   - **不是取字节**：卡住那一刻自己 fetch('book://f/<id>')，ok / 15078 字节 / 7 毫秒；
           *   - **不是存的位置**：那时 viewer.<id> 已被清成空串，走的是不带参的 display()；
           *   - **不是累积**：不 reload 连开 6 次，iframe 恒为 1、createObjectURL 净增 0；
           *   - **重载页面救不回来，重启应用可以**（同源 reload 复用同一个渲染进程）。
           *
           * **正因为它是偶发的，下面那条「诚实的失败」才是对的设计**：
           * 不能指望第三方渲染器每次都成，但可以保证用户不对着一个永远的转圈。
                      */
          收尾 = () => { el.replaceChildren(); };
          /*
           * ⚠️ **存下来的位置用不了时要能从头开，而不是卡在那儿。**
           *
           * `display(cfi)` 在这种情况下**既不 resolve 也不 reject**——界面就永远
           * 停在「正在打开…」。触发条件很常见：文件换过一版、epub.js 升过级，
           * 或者那个 CFI 本来就解析不出来。
           *
           * 这个 bug 是**版面走查抓到的**：它把每一屏在五个分辨率上各开一次，
           * 而第一次开（还没存位置）是好的、第二次起才坏——单跑一次永远看不见。
           */
          // 先等它把书解开、目录读完；直接 display(n) 的话 epub.js 解析不出那个位置
          await (bk as unknown as { ready: Promise<unknown> }).ready.catch(() => {});
          if (死了) return;
          /*
           * 第 0 节传 `undefined`（`display()` 不传参就是从头开，两者同义）。
           *
           * ⚠️ 这儿原来写着「`display(0)` 实测会挂住不返回」——**那条已经作废**：
           * 重新量是 **12ms resolve**。当初那次是在 rAF 一帧不跑的窗口下量的，
           * 和「epub.js 开到第三本就画不出来」同一个根（见 `docs/lessons.md`）。
           * 留着传 `undefined` 只是因为它更直白，不是因为 `display(0)` 有问题。
           */
          /* `节:页/总页`，或者老格式的纯节号。两种都认，坏的当成从头开 */
          const m = /^([0-9]+)(?::([0-9]+)\/([0-9]+))?$/.exec(存的 ?? '');
          const n = m ? Number(m[1]) : 0;
          const 存的页 = m && m[2] ? Number(m[2]) : 1;
          const 存的总 = m && m[3] ? Number(m[3]) : 0;
          const 从哪开 = n > 0 ? n : undefined;
          const 到位 = await Promise.race([
            rend.display(从哪开).then(() => true, () => false),
            new Promise<boolean>((r) => setTimeout(() => r(false), 15000)),
          ]);
          if (!到位) {
            // 那个位置用不了，从头开，并且把它清掉——留着下次还会卡一次
            void rpc('setting.set', { key: posKey(bookId), value: '' }).catch(() => {});
            /*
             * ⚠️ **本来就是从头开的话，别再原样重试一遍。**
             *
             * 这个兜底的意思是「存下来那个位置用不了，那就从头开」——
             * 而 `从哪开` 是 `undefined` 时**第一次调的就已经是从头开了**，
             * 再调一次是**同一个调用配同一个参数**，等的是同一个不会 resolve 的
             * promise。逐秒量过一次失败的开书：两段 15 秒都走满，
             * **整整 30 秒**才落到那句「没能打开」，而后 15 秒是纯粹的空等。
             *
             * 只有真的换了参数（存的位置 → 从头）才值得再试一次。
             */
            const 再来 = 从哪开 === undefined
              ? false
              : await Promise.race([
                rend.display().then(() => true, () => false),
                new Promise<boolean>((r) => setTimeout(() => r(false), 15000)),
              ]);
            /*
             * ⚠️ **打不开就明说，别让它永远转圈。**
             *
             * `display()` 会**既不 resolve 也不 reject**，控制台一条错都没有。
             *
             * ✅ **根因查到了，而且不在 epub.js 里**：窗口不可见时
             * （`document.visibilityState === 'hidden'`，比如最小化、或者
             * 走查用的后台窗口）Chromium 把 `requestAnimationFrame` 掐到 **0 帧**，
             * 而 epub.js 的排版就挂在 rAF 上。`setTimeout` 照走，所以看起来
             * 「页面是活的」。这条被当成「epub.js 不稳、开到第三本就画不出来」
             * 查了十几轮——完整经过见 `docs/lessons.md`。
             *
             * 所以这段兜底**留着**：真实用户也会开着书切走（窗口被遮住、最小化），
             * 那时候 `display()` 就是不回来。**用户不该对着一个永远的
             * 「正在打开…」**——给他一句实话和一条出路。回到前台之后 rAF 恢复，
             * 那次渲染会自己接上。
             */
            if (!再来 && !死了) {
              setBusy(false);
              setErr('这本 EPUB 在应用里没能打开。可以先用系统的阅读器看，或者退出应用再进来试一次。');
              return;
            }
          }
          if (死了) return;

          /*
           * **翻页走 `rend.next()` / `prev()`，翻章（目录）走 `display(n)`。**
           *
           * ⚠️ 这儿原来写着「那两个**根本不动**，只用 `display(n)`」——**已经作废**。
           * 重新量：`next()` 0→1→2 正常、到末节自动停，而且**在一节内部是一页一页走的**
           * （测试书第 2 节 21 页，`next()` 走到 3/21、9/21、17/21）。
           * 当初那次是在 rAF 一帧不跑的窗口下量的（见 `docs/lessons.md`）。
           *
           * 这不只是「换个写法」：原来「下一页」按一下**跳掉整整一节**——
           * 一节二十来页的书，等于按一下漏掉十九页。名字叫「下一页」而它翻的是一章。
           */
          const 章数 = (() => {
            const b = bk as unknown as { spine?: { length?: number; items?: unknown[] } };
            return b.spine?.length ?? b.spine?.items?.length ?? 0;
          })();
          const 慢 = <T,>(p: Promise<T>) => Promise.race([
            p.then(() => true, () => false),
            new Promise<boolean>((r) => setTimeout(() => r(false), 15000)),
          ]);
          let 当前章 = n;
          /** 翻到某一节的开头。目录点一条走这里 */
          const 翻到 = async (到: number) => {
            if (到 < 0 || (章数 > 0 && 到 >= 章数)) return;
            await 慢(rend.display(到 > 0 ? 到 : undefined));
          };

          api.current = {
            // ⚠️ 一页一页翻，不是一节一节跳。位置、百分比、「读完了」
            // 三件事全交给下面那个 `relocated`——它每翻一页都会响，一条都不会漏
            prev: () => void 慢(rend.prev()),
            next: () => void 慢(rend.next()),
            goto: (n) => void 翻到(n),
          };
          还有下一屏.current = () => 章数 > 0 && 当前章 < 章数 - 1;

          /*
           * **书内搜索：逐节把正文取出来搜。**
           *
           * epub.js 的 `spine.get(i).load(book.load.bind(book))` 能**不渲染**
           * 就把一节解析成 document——搜索不该把整本书画一遍。
           * 用完 `unload()`，否则一本几百节的书会把解析结果全留在内存里。
           *
           * 上限和 PDF 那边同一个数、同一条规矩：**截断了要说出来**。
           */
          搜正文.current = async (q) => {
            const 词 = q.trim();
            if (!词) return [];
            const b = bk as unknown as {
              spine?: {
                length?: number;
                get?: (i: number) => {
                  load?: (f: unknown) => Promise<unknown>;
                  unload?: () => void;
                } | undefined;
              };
              load?: (u: string) => unknown;
            };
            const 共 = b.spine?.length ?? 0;
            const 出: 搜索命中[] = [];
            for (let i = 0; i < 共 && 出.length < 搜索上限; i++) {
              if (死了) break;
              const 节 = b.spine?.get?.(i);
              if (!节?.load) continue;
              let 文 = '';
              try {
                /*
                 * ⚠️ **`Section.load` 解析出来的是 body 那个元素，不是 document。**
                 * 按 `d.body.textContent` 读会拿到 `undefined` → 空串 → **一处都搜不到**，
                 * 而且不报错：界面上就是一句「没有找到」，看起来像这本书里真没有。
                 * 当场量到过（那本 EPUB 里明明有「峰回路转」）。
                 * 两种形状都认——epub.js 各版本这里回过不同的东西。
                 */
                const 得 = (await 节.load(b.load?.bind(b))) as unknown as
                  { body?: { textContent?: string | null }; textContent?: string | null } | null;
                文 = (得?.body?.textContent ?? 得?.textContent ?? '').replace(/\s+/g, ' ').trim();
              } catch { continue; } finally { try { 节.unload?.(); } catch { /* 卸不掉不影响搜 */ } }
              let at = 文.indexOf(词);
              while (at >= 0 && 出.length < 搜索上限) {
                出.push({
                  chapterIdx: i,
                  chapterTitle: 目录名.current(i) ?? `第 ${i + 1} 节`,
                  snippet: makeSnippet(文, 词, 12, at),
                });
                at = 文.indexOf(词, at + 词.length);
              }
            }
            return 出;
          };
          setSec(当前章);
          if (章数 > 0) setPct(Math.round(((当前章 + 1) / 章数) * 100));

          /*
           * **回到上次读到的那一页**：`display(节)` 落在节首，再 `next()` 走过去。
           *
           * 为什么不是 `display(cfi)`：那条会**往回滑而且累积**（第 17/21 页存下来，
           * 回来落在第 10 页；再存再回退到第 9 页）。整段判据写在 `posKey` 上面。
           *
           * 换过字号或者窗口大小的话同一节的页数会变，那时按比例折算。
           * ⚠️ **有截止时间**：一节几百页的书按页走要几秒，宁可少走几页也不让人干等
           * （实测每页约 20ms，2.5 秒够走一百多页）。
           */
          if (分页 && 存的页 > 1) {
            const 现总 = (rend as unknown as { currentLocation?: () => { start?: { displayed?: { total?: number } } } })
              .currentLocation?.()?.start?.displayed?.total ?? 0;
            const 目标 = 存的总 > 0 && 现总 > 0 && 现总 !== 存的总
              ? Math.max(1, Math.round((存的页 / 存的总) * 现总))
              : 存的页;
            const 截止 = Date.now() + 2500;
            for (let i = 1; i < 目标 && !死了 && Date.now() < 截止; i++) await 慢(rend.next());
          }

          /*
           * **目录：把 nav 里那棵树摊平，每一条配一个 spine 序号。**
           *
           * ⚠️ 序号必须问 `spine.get(href)` 要，**不能按目录里的顺序数**：
           * 目录条目和 spine 条目不是一一对应的（封面、版权页通常在 spine 里
           * 而不在目录里；一条目录也可能指到某一节的中间，带 `#锚点`）。
           * 按顺序数出来的号会整体错位，点「第五章」跳到第三章。
           *
           * 取不到序号的条目**直接丢掉**，不摆一个点了不动的按钮
           * （本仓库那条：摆一排点了必然出错的按钮，比没有更糟）。
           * 整段包在 try 里：目录没了不该让整本书打不开。
           */
          void (async () => {
            try {
              const b = bk as unknown as {
                loaded?: { navigation?: Promise<unknown> };
                spine?: { get?: (h: string) => { index?: number } | undefined };
              };
              const nav = (await b.loaded?.navigation) as
                { toc?: Array<{ label?: string; href?: string; subitems?: unknown[] }> } | undefined;
              const 平: Array<{ label: string; index: number }> = [];
              const 走 = (items: Array<{ label?: string; href?: string; subitems?: unknown[] }>, 深: number) => {
                for (const it of items ?? []) {
                  const 名 = (it.label ?? '').trim();
                  const i = it.href ? b.spine?.get?.(it.href)?.index : undefined;
                  // 二级目录缩进两个全角空格——和 txt 那边的「卷」是两回事，
                  // 这里没有独立的卷概念，只有 nav 自己的层级
                  if (名 && typeof i === 'number') 平.push({ label: '　'.repeat(深) + 名, index: i });
                  if (Array.isArray(it.subitems)) 走(it.subitems as typeof items, 深 + 1);
                }
              };
              走(nav?.toc ?? [], 0);
              if (!死了) setToc(平);
            } catch { /* 没目录就没目录，右轨那个键自己不出现 */ }
          })();

          rend.on('relocated', (loc: {
            start?: { index?: number; percentage?: number; displayed?: { page?: number; total?: number } };
          }) => {
            /*
             * **每翻一页都会响**，所以位置、百分比、「读完了」三件事都收在这儿，
             * 不散在 `next` / `prev` / `goto` 各写一遍（那三处必然分叉）。
             *
             * 存的是 `节:页/总页`，判据整段写在 `posKey` 上面。
             */
            const 节 = loc.start?.index;
            const 页 = loc.start?.displayed?.page ?? 1;
            const 总 = loc.start?.displayed?.total ?? 0;
            if (typeof 节 === 'number') {
              当前章 = 节;
              // ⚠️ 滚动那两档没有「第几页」这回事，只存节号。
              // 存成 `节:1/1` 的话下面那段按页回放会照着走，白等一轮
              存位置(分页 && 总 > 0 ? `${节}:${页}/${总}` : String(节));
              setSec(节);
              // ⚠️ **读完 = 最后一节的最后一页**，不是「翻到最后一节」。
              // 一节二十来页，进了这一节就标读完等于提前二十页宣布看完了
              // ⚠️ **只有翻页模式认这条。** 滚动式里 `总` 常年是 1，
              // 这条会在**刚进最后一节**的时候就宣布读完——那时候一个字还没读。
              // 滚动式的判据在下面那个 scroll 监听里：滚到底才算
              if (分页 && 总 > 0 && 页 >= 总) 到底了.current(节, 章数);
            }
            /*
             * ⚠️ **只有真算得出来的百分比才认，0 一律不认。**
             *
             * epub.js 的 `percentage` 要先 `book.locations.generate()` 才有值——
             * 没生成时 `locationFromCfi` 回 null，`percentage` 就一直是 **0**。
             * 而上面已经按「第几章 / 共几章」算过一个数了，这里无条件 `setPct`
             * 等于**用一个假的 0 把真的覆盖掉**——页脚于是永远显示 0%
             * （量出来就是这样：两章的书、开在第一章，本该 50%）。
             *
             * 不去 generate locations：那要把整本解析一遍，而这个应用的进度
             * 本来就是按章记的（txt 存 `chapter_idx`、PDF 存页码），粒度一致就够。
             */
            if (typeof loc.start?.percentage === 'number' && loc.start.percentage > 0) {
              setPct(Math.round(loc.start.percentage * 100));
            } else if (typeof 节 === 'number' && 章数 > 0) {
              /*
               * 退回按节算，但**把节内读到第几页也算进去**：`(节 + 页/总) / 节数`。
               * 原来是 `(节+1)/节数`——一节二十来页的书，读了半节页脚一动不动，
               * 翻过那一节才跳一大格。
               *
               * ⚠️ 分子是 `页/总` 不是 `(页-1)/总`：后者在**最后一页显示 99%**
               * （实测：第 2/3 节第 28/28 页 → 99%），而那一下正是要显示 100% 的时候。
               * 按「读完了几页」算，两头都对：第 1/1 页 → 整节读完 → `(节+1)/节数`。
               */
              setPct(Math.min(100, Math.round(((节 + (总 > 0 ? 页 / 总 : 1)) / 章数) * 100)));
            }
          });
          /*
           * **滚动式的「读完了」：滚到最后一节的底。**
           *
           * 翻页那条判据（`页 >= 总`）在这儿不成立，而「读完那一刻是唯一
           * 有话想说的时候」——不补这一条，用滚动式读完一本 EPUB 的人
           * 永远等不到那句「读完了，趁现在记一句」。
           *
           * 容器要等第一节画完才有，所以推到下一拍再找（`找滚的` 是按
           * 「谁的内容比自己高」量出来的，空容器量不出来）。
           */
          if (!分页) {
            setTimeout(() => {
              const 滚 = 找滚的(el);
              if (!滚 || 死了) return;
              const 看一眼 = () => {
                if (滚.scrollTop + 滚.clientHeight < 滚.scrollHeight - 4) return;
                到底了.current(当前章, 章数);
              };
              滚.addEventListener('scroll', 看一眼, { passive: true });
              const 前一个收尾 = 收尾;
              收尾 = () => { 滚.removeEventListener('scroll', 看一眼); 前一个收尾?.(); };
            }, 300);
          }
          // api.current 上面已经设过了——用序号翻，不用 rend.prev/next
          /*
           * **跟着窗口重排。**
           *
           * ⚠️ 这儿原来写着「试过两版 ResizeObserver，两版都把 epub.js 建视图打断
           * （一个 iframe 都不建，永远停在「正在打开…」）」——那个症状正是
           * **rAF 一帧不跑**的症状，和「开到第三本就画不出来」同一个根
           * （见 `docs/lessons.md`）。查清之后重试，两条判据都过了：
           * 连开 5 次全好、五个分辨率的走查全绿。
           *
           * 不跟的代价是量得出来的：stage 从 1254 缩到 848 时 iframe 恒为 **1181**——
           * **正文横向被裁掉 333px**；放大到 1734x914 则右边和下面各空一条。
           * 而「最大化 / 还原窗口」是每天都会做好几次的动作。
           *
           * 两条防身的（当初那两版栽的就是这里）：
           *   - **`observe()` 会立刻回调一次**，带着当前尺寸。那一次必须跳过——
           *     在建视图的过程中调 `resize()` 正是把它打断的那一下。
           *   - **拖窗口边会连发几十次**，不防抖就是几十次重排。250ms 合并一次。
           * 重排之后 `relocated` 会自己响，位置和百分比跟着更新，这里不用管。
           */
          {
            let 上次 = `${Math.round(盒.width)}x${Math.round(盒.height)}`;
            let 计时: ReturnType<typeof setTimeout> | undefined;
            const ro = new ResizeObserver((es) => {
              const r = es[0]?.contentRect;
              if (!r || r.width < 1 || r.height < 1) return;
              const 现在 = `${Math.round(r.width)}x${Math.round(r.height)}`;
              if (现在 === 上次) return;
              上次 = 现在;
              clearTimeout(计时);
              计时 = setTimeout(() => {
                if (死了) return;
                try { rend.resize(Math.round(r.width), Math.round(r.height)); } catch { /* 重排失败就维持原样，别把书弄没 */ }
              }, 250);
            });
            ro.observe(el);
            const 前一个收尾 = 收尾;
            收尾 = () => { ro.disconnect(); clearTimeout(计时); 前一个收尾?.(); };
          }
          重画.current = () => { /* 尺寸由上面那个 ResizeObserver 跟，这里不用再画一次 */ };
        }
        if (!死了) setBusy(false);
      } catch (e) {
        if (!死了) {
          setBusy(false);
          /*
           * ⚠️ **先分清楚是这本书坏了，还是应用自己的资源没加载出来。**
           *
           * pdf.js / epub.js 都是**动态 import**（为了不把它们塞进主包），
           * 而那两个分块的文件名带内容哈希。所以会出现这种局面：
           * 页面是旧构建加载的，而磁盘上的 `dist/` 已经换了一批——
           * 点开 PDF 那一刻才去取，取到的是一个**已经不存在的文件名**。
           * 开发时边跑边 `npm run build` 就是这个；装好的包被更新或损坏也一样。
           *
           * 原来这一支一律说「它可能已经损坏」——**把我们自己的毛病说成了用户书的毛病**，
           * 而用户照着那句话去拿系统阅读器一试，书好好的，于是更迷糊。
           * 判据同这个仓库那条老规矩：**说清下一步做什么**（`reader.ts` 的 openHint）。
           */
          const 话 = (e as Error).message ?? '';
          const 是分块没了 = /dynamically imported module|Importing a module script failed/i.test(话);
          setErr(
            是分块没了
              ? `应用自己的资源没加载出来（${话}）。`
                + '不是这本书的问题——查看器是用到才加载的，而它要的那个文件已经不在了。'
                + '重启一下应用就好（常见于：应用运行中重新构建过，或者安装包被更新 / 损坏）。'
              : `打不开这个文件：${话}。`
                + '它可能已经损坏，或者用了这个查看器不认的格式——可以先用系统的阅读器打开看看。',
          );
        }
      }
    })();

    return () => { 死了 = true; 收尾?.(); };
  }, [bookId, viewer, 存位置, settings.mode]);

  /** 缩放要能被上面那个 effect 里的闭包读到，而它只跑一次 */
  const zoomRef = useRef(1);
  const 重画 = useRef<() => void>(() => {});
  useEffect(() => { zoomRef.current = zoom; 重画.current(); }, [zoom]);

  /**
   * 改了设置：写回 localStorage、刷 CSS 变量，**再把新纸色推进 iframe 一次**。
   *
   * 最后那一步是这里独有的：`applySettings` 改的是 `document.documentElement`
   * 上的 CSS 变量，而 EPUB 正文活在另一个文档里——**变量到不了**
   * （整段理由写在下面 `themes.override` 那儿）。
   *
   * 没有这一步会怎样，破坏实验量过：**壳换了纸色，书还留在上一张纸上**。
   * 那一次是从夜间切回白天，壳变成 `#f7f2e8` 而 iframe 还是 `rgb(27,27,27)`——
   * 白壳里嵌一块黑板。反方向（切去夜间）更糟：黑壳白纸，比不切还刺眼。
   *
   * PDF 那边 `重上色` 是空的：那一页是 canvas 上的图，纸色本来就作用不到它，
   * 变的只有周围的壳。
   */
  const 重上色 = useRef<() => void>(() => {});
  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
    重上色.current();
  }, [settings]);

  /*
   * **翻到最后一页/最后一章：标「已读完」，再问一句要不要记评价。**
   *
   * txt 那半一直都有（`reading.save` 返回 `finished` → `askReview`），
   * 这两种格式一个都没有——一本从头翻到尾的 PDF 既进不了「已读完」那一档，
   * 也永远等不到那句「读完了，趁现在记一句」。而**读完那一刻是唯一有话想说的时候**。
   *
   * 判据直接用 `atEndPaging`（`reading-pos.ts` 那份，翻页模式共用的纯函数），
   * 不自己写一条：里面那句 `page > 0` 正是为「最后一章只有一页、一打开就被判读完」
   * 设的，PDF 只有一页时同样成立。**PDF 的页码是 1 起的，所以传 `page - 1`。**
   *
   * 放在 ref 里：`画` / `翻到` 都活在那个大 effect 的闭包里，
   * 换成会变身份的 callback 就得把整个 effect 重跑一遍（同 `zoomRef`）。
   */
  /*
   * 位置一变就重取一次正文（翻页、跳目录、换书都算）。
   * `sec` 管 EPUB、`page` 管 PDF，两个都放依赖里——**少一个就是「翻了页还在念上一页」**。
   */
  useEffect(() => {
    let alive = true;
    void 取正文.current().then((t) => { if (alive) set正文(t); }).catch(() => alive && set正文(''));
    return () => { alive = false; };
  }, [sec, page, busy, 文本版]);

  /*
   * 换一节就重取这一节的划线。**按节序号存**（`chapter_idx`）——
   * 和 txt 那边一样，「书签划线」那个面板才归得了组。
   */
  const 重取划线 = useCallback(() => {
    /*
     * ⚠️ **PDF 要整本一起取，EPUB 只取这一节。**
     * 「连着往下滚」那一档屏幕上同时摆着好几页，各自都可能有划线；
     * 按页取的话滚过去那些就画不出来。整本的划线是几十条量级，一次取回来不贵。
     */
    void rpc<Highlight[]>('highlight.list', {
      bookId,
      ...(viewer === 'epub' ? { chapterIdx: secRef.current } : {}),
    })
      .then(set划线们)
      .catch(() => set划线们([]));
  }, [bookId, viewer]);
  useEffect(() => { secRef.current = sec; 重取划线(); }, [sec, 重取划线]);
  /** 划线变了就重画一遍 */
  useEffect(() => { 重画划线.current(); }, [划线们]);

  /*
   * **这一屏换了，朗读就跟着换到这一屏。**（判据和 `Reader.tsx` 那条是同一句话，
   * 用户的原话：「朗读不是什么继续，而是自动定位到本章进行读」。）
   *
   * 依赖是 `正文` 而不是 `sec` / `page`：新的一屏是**异步取回来的**，
   * 按 `sec` 触发会拿着上一屏的文字去念。
   *   - **正念着** → 念新的这一屏（朗读自动翻页也走这条，`接着念` 计数器因此删掉了）；
   *   - **暂停着** → 把队列扔掉，主键回到「从这里开始念」。
   *
   * ⚠️ **`tts.speaking` 这个判据不能省**：没有它的话，停掉朗读之后随便翻一页
   * 都会自己念起来，在线引擎还会把正文发给第三方服务器。
   */
  useEffect(() => {
    if (tts.speaking && 正文.trim()) tts.speak(正文);
    else if (tts.paused) tts.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [正文]);

  /** 到点停。**只管按分钟定的那种**——「这一节念完」那档在 `onChapterEnd` 里认 */
  const ttsStop = tts.stop;
  useEffect(() => {
    if (typeof 睡到 !== 'number') return;
    const t = setTimeout(() => { ttsStop(); set睡到(null); }, Math.max(0, 睡到 - Date.now()));
    return () => clearTimeout(t);
  }, [睡到, ttsStop, set睡到]);

  /**
   * 把卡片贴到 iframe 里刚才那一下的位置上。
   *
   * ⚠️ **收的是鼠标事件的坐标，不是 Range 的矩形**——事件坐标按定义落在
   * 看得见的那一页上。代价是卡片挂在光标下面而不是那一行下面，差几像素，而且对。
   *
   * ⚠️ **原点是「事件那个 iframe 自己」，不是 `.viewer-stage`。**
   *
   * 这里改过两次，两次都是被量出来的：
   *
   * 1. 第一版拿 `range` 的矩形加 iframe 的矩形，卡片一律贴在屏幕最左边
   *    （当时量到 iframe 的 `left` 是 −3669）。于是改成事件坐标 + stage 原点。
   * 2. **加了滚动式阅读之后 stage 原点又错了**：滚动档里 iframe 是整篇那么高
   *    （量到 1000×14561），**iframe 内部的 `clientY` 是整篇文档里的 Y**，
   *    而在滚的是外面那个容器。拿 stage 当原点就差一个 `scrollTop`——
   *    当场量的：「按章」差 50px、「无限下滑」差 **791px**（那一下卡片跑到屏幕外面）。
   *
   * 现在重量了一遍：**翻页档下 iframe 的矩形和 stage 是同一个**（都是 93,32），
   * 所以「取事件那个 iframe 的矩形」三档都成立，不用按档位分岔。
   * 无限下滑那档屏幕上同时有好几个 iframe，所以要问**事件自己那个文档**
   * 的 `frameElement`，不能 `querySelector('iframe')` 抓第一个。
   */
  const 贴着 = useCallback((x: number, y: number, 从?: Document | null) => {
    const main = mainRef.current;
    if (!main) return null;
    const M = main.getBoundingClientRect();
    /*
     * ⚠️ **没有 iframe 的时候，坐标已经是主文档的了，一点都不用加。**
     *
     * EPUB 的正文在 epub.js 建的 iframe 里，`clientX/Y` 是那个文档里的坐标，
     * 所以要加上 iframe 自己的矩形。**PDF 的文字层就在主文档上**——
     * 那一下的 `clientX/Y` 本来就是屏幕坐标，再加一次 stage 的偏移就是**重复计算**。
     * 当场量的：点在 427，卡片开在 **524**，正好差一个 stage 到 main 的距离（97px）。
     */
    const 框 = (从?.defaultView?.frameElement as HTMLElement | null) ?? null;
    const S = 框 ? 框.getBoundingClientRect() : M;
    const 上 = S.top - M.top + y;
    const 左0 = S.left - M.left + x;
    const 宽 = Math.min(24 * 16, M.width * 0.6);
    const 左 = Math.max(8, Math.min(左0, M.width - 宽 - 8));
    // 光标底下留一行的量，别正好压在指针上
    return { top: 上 + 20, 锚顶: 上 - 6, left: 左 };
  }, []);

  /**
   * 每种颜色代表什么。**用户可以把它改成自己的用途**（黄＝好句、蓝＝待查），
   * 所以这儿不能再硬编码——正本在 `core/highlight.ts`，共用的取法在 `highlight-view.ts`
   */
  const 颜色名 = use色名();

  /**
   * 底下放不下就翻到上面去——判据和 `Reader.tsx` 的 `贴住` 一样：
   * 坐标是选中那一刻算的，**那时候卡片还没渲染、量不到它多高**。
   */
  const 贴住 = useCallback((el2: HTMLDivElement | null) => {
    const main = mainRef.current;
    if (!el2 || !main) return;
    const M = main.getBoundingClientRect();
    const R = el2.getBoundingClientRect();
    if (R.bottom <= M.bottom - 8) return;
    const 锚顶 = Number(el2.dataset.anchorTop ?? 0);
    el2.style.top = Math.max(8, 锚顶 - R.height - 6) + 'px';
  }, []);

  /**
   * **把框选那一块存成图片。**
   *
   * 库里只有四个归一化坐标（铁律 2：不存正文，截图也不存），
   * 所以那块图是**用的时候现画**：重新 render 那一页，再按坐标裁一块。
   * GoodNotes 那边同一件事叫 Take a screenshot of the selected area。
   *
   * ⚠️ **scale 拿 2，不拿屏幕上那个。** 屏幕上那一页可能只有一百多像素宽
   * （窗口小、或者缩小了），按它裁出来的图存下来是糊的——
   * 而用户要的正是那块图本身。
   *
   * ⚠️ “不是框选” **两头各拦一道**：这颗键只对框选摆出来，
   * 而 rpc 那头也自己判一次——同这个仓库那条「安全阀不能只活在界面里」。
   */
  const 存成图片 = useCallback(async (h: Highlight) => {
    const r = 解析矩形(h.rect);
    const doc = pdf文档.current;
    if (!r || !doc) { set存图('这一页还没准备好，稍等一下再试'); return; }
    set存图('正在取那一页…');
    try {
      const page = await doc.getPage(h.chapter_idx);
      set存图('正在画…');
      const vp = page.getViewport({ scale: 2 });
      const 整页 = document.createElement('canvas');
      整页.width = Math.round(vp.width);
      整页.height = Math.round(vp.height);
      const ctx = 整页.getContext('2d');
      if (!ctx) throw new Error('拿不到画布');
      /*
       * ⚠️ **两件事都得照上面那份画页的代码抄，少一件都卡死：**
       *
       * 1. `canvas` 和 `canvasContext` **两个都要传**（pdf.js v6）。
       * 2. **`render(...).promise` 会一直不 resolve**——这一条仓库里早记着
       *    （上面首次渲染那段：窗口不可见 → rAF 0 帧 → 分块渲染卡在第二块，
       *    而第一块是同步画的，所以**画面早就在那儿了**）。
       *    我照搬时只拿了 `await ....promise`，于是卡在「正在画…」不动——
       *    而 canvas 上那一页已经画好了。超时之后照样去裁，同那段的判据：
       *    “那一页多半已经画在 canvas 上了”。
       */
      await Promise.race([
        page.render({ canvas: 整页, canvasContext: ctx, viewport: vp }).promise.catch(() => {}),
        new Promise<void>((r) => setTimeout(r, 15000)),
      ]);

      set存图('正在裁…');
      const 块 = document.createElement('canvas');
      块.width = Math.max(1, Math.round(r.w * 整页.width));
      块.height = Math.max(1, Math.round(r.h * 整页.height));
      const c2 = 块.getContext('2d');
      if (!c2) throw new Error('拿不到画布');
      c2.drawImage(
        整页,
        Math.round(r.x * 整页.width), Math.round(r.y * 整页.height), 块.width, 块.height,
        0, 0, 块.width, 块.height,
      );

      set存图('选个文件夹…');
      const dir = await rpc<string | null>('ui.pickFolder');
      if (!dir) { set存图(null); return; }
      const out = await rpc<{ path: string }>('highlight.exportImage', {
        id: h.id, dir, dataUrl: 块.toDataURL('image/png'),
      });
      set存图('存好了：' + out.path);
    } catch (e) {
      set存图('存不下：' + (e as Error).message);
    }
  }, []);


  /** 把刚选中的那一段存成一条划线。**锚是 CFI**，不是字节偏移 */
  const 存划线 = useCallback(async (color: string, note?: string) => {
    if (!待划) return;
    try {
      /*
       * ⚠️ **两种锚共用库里那三列**，区别只在 `cfi` 有没有值：
       *   - EPUB：`cfi` 是真锚，`char_offset` / `length` 是**占位**
       *     （那半没有字节流，而 `length > 0` 那条校验还得过）；
       *   - PDF：`chapter_idx` 是页码、`char_offset` 是页内偏移、`length` 是长度，
       *     `cfi` 不写（判据在 `pdf-text.ts` 顶上）；
       *   - **PDF 的框选**：`chapter_idx` 仍然是页码，真正的位置是 `rect`（迁移 22），
       *     `char_offset` / `length` 退为占位——扫描页没有文字层，上面那套对它不成立。
       */
      await rpc('highlight.add', {
        bookId,
        chapterIdx: 待划.锚.位置,
        charOffset: 待划.锚.偏移,
        length: 待划.锚.长,
        excerpt: 待划.text,
        color,
        ...(待划.cfi ? { cfi: 待划.cfi } : {}),
        ...(待划.rect ? { rect: 待划.rect } : {}),
        ...(note?.trim() ? { note: note.trim() } : {}),
      });
      当前内容()?.document.getSelection?.()?.removeAllRanges();
      window.getSelection()?.removeAllRanges();
      set待划(null);
      set笔记草稿(null);
      重取划线();
    } catch { set待划(null); set笔记草稿(null); }
  }, [待划, bookId, 重取划线]);

  /**
   * 查看器里**同一时刻只留一个浮层**。
   *
   * 判据和 `Reader.tsx` 的 `只开一个` 是同一条（用户的原话：「阅读界面的 modal
   * 应该都是互斥，同时只有一个。」）——**那边早就收成一个函数了，这边没抄到**：
   * 原来是四个按钮各关各的一部分，谁也不知道谁。当场量出来的三种叠法：
   *
   * | 先点 | 再点 | 结果 |
   * |---|---|---|
   * | 朗读 | 目录 | 2 层 |
   * | 朗读 | 设置 | **2 个 `.reader-panel` 同时在** |
   * | 设置 | 目录 | 2 层 |
   *
   * 这正是本仓库那条「同一份约定抄成几份必然分叉」——抄的时候只抄了一半。
   *
   * ⚠️ **关评价要走 `closeReview`**，不是 `setReviewing(null)`：那句短评是用户
   * 打的字，直接扔掉就是丢数据（铁律 3 里重扫恢复不了的那几样之一）。
   */
  type 浮层 = '目录' | '设置' | '朗读' | '评价' | '书签划线' | '搜索';
  const 只开一个 = useCallback((which: 浮层 | null) => {
    if (which !== '目录') setTocOpen(false);
    if (which !== '设置') setPanel(false);
    if (which !== '朗读') setTtsOpen(false);
    if (which !== '评价') closeReview();
    if (which !== '书签划线') set看笔记面板(false);
    if (which !== '搜索') set搜索开(false);
    // 划过的那一段和点开的那条笔记也是浮在正文上的东西，一并收掉
    set待划(null);
    set笔记草稿(null);
    set看笔记(null);
    if (which === '目录') setTocOpen(true);
    if (which === '设置') setPanel(true);
    if (which === '朗读') setTtsOpen(true);
    if (which === '评价') openReview();
    if (which === '书签划线') set看笔记面板(true);
    if (which === '搜索') set搜索开(true);
  }, [closeReview, openReview]);

  /** 现在开着的是哪个。右轨那几个键靠它做「再点一次关掉」 */
  const 开着的: 浮层 | null =
    tocOpen ? '目录' : panel ? '设置' : ttsOpen ? '朗读'
      : reviewing ? '评价' : 看笔记面板 ? '书签划线' : 搜索开 ? '搜索' : null;
  /** 屏幕上有没有浮着的东西——Esc 和「点正文」都要问这一句 */
  const 有浮层 = 开着的 !== null || !!待划 || !!看笔记;
  const 切换 = useCallback(
    (w: 浮层) => 只开一个(开着的 === w ? null : w),
    [只开一个, 开着的],
  );

  const 设置位 = useAnchored(panel, 设置键, 设置层, 左轨, 'left-top');
  const 朗读键 = useRef<HTMLButtonElement>(null);
  const 朗读层 = useRef<HTMLDivElement>(null);
  const 朗读位 = useAnchored(ttsOpen, 朗读键, 朗读层, 右轨, 'right-bottom');
  const 评价位 = useAnchored(!!reviewing, 评价键, 评价层, 右轨, 'right-bottom');

  /**
   * **现在该往哪儿画划线、怎么把一条还原成 Range。**
   *
   * 两种格式的锚完全不同，画法完全相同——所以分岔只在这一个函数里，
   * `画划线` / `命中` / `清划线` 三个一个字都不用分（整段判据在
   * `highlight-view.ts` 的 `画布` 上面）。
   *
   * | | 往哪个文档画 | 怎么还原 |
   * |---|---|---|
   * | EPUB | epub.js 那个 iframe | `contents.range(cfi)` |
   * | PDF | **主文档**（文字层就在页面上） | 页内偏移 → `造Range` |
   */
  const 取画布 = useCallback((): 画布 | null => {
    if (viewer === 'epub') {
      const c = 当前内容();
      if (!c) return null;
      return {
        document: c.document,
        还原: (h) => {
          if (!h.cfi) return null;
          try { return c.range(h.cfi) ?? null; } catch { return null; }
        },
        // EPUB 的划线是**按节取**的（`重取划线`），手上这些本来就该在这一节里
        管得着: () => true,
      };
    }
    const 层们 = 各页文字层(box.current);
    if (层们.size === 0) return null;
    return {
      document,
      // 一叠里所有已经铺好文字层的页一起画——`CSS.highlights` 是整个窗口一份的
      还原: (h) => {
        const t = 层们.get(h.chapter_idx);
        return t ? 造Range(t, h.char_offset, h.length) : null;
      },
      // **只有铺好文字层的那几页才算数**：没滚到的页还没铺，那不是「对不上」
      管得着: (h) => 层们.has(h.chapter_idx),
    };
  }, [viewer, 当前内容]);

  取画布Ref.current = 取画布;


  /*
   * ── PDF 上的选中与点击 ────────────────────────────────
   *
   * EPUB 那半挂在 epub.js 建的 iframe 里（`hooks.content`），而 **PDF 的文字层
   * 就在主文档上**，所以这两个监听挂在舞台自己身上。做的事一模一样：
   * 松手有选中 → 摆「划线」那张卡；点在一条划线上 → 摆笔记，且**不翻页**。
   *
   * ⚠️ **只认落在 `.textLayer` 里的选区。** 点在页边空白、工具轨上拖出来的
   * 「选区」不是正文，摆一张卡出来是噪音。
   */
  useEffect(() => {
    if (viewer !== 'pdf') return;
    const 台 = box.current;
    if (!台) return;

    const 找页 = (n: Node | null): { 页: number; 层: HTMLElement } | null => {
      const el = (n instanceof Element ? n : n?.parentElement) ?? null;
      const 层 = el?.closest?.('.textLayer') as HTMLElement | null;
      const 壳 = 层?.closest?.('.pdf-page') as HTMLElement | null;
      if (!层 || !壳) return null;
      const 页 = Number(壳.dataset.n ?? '');
      return { 页: Number.isFinite(页) && 页 > 0 ? 页 : 1, 层 };
    };

    const 松手 = (e: MouseEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { set待划(null); return; }
      const text = sel.toString().trim();
      if (!text) { set待划(null); return; }
      const r = sel.getRangeAt(0);
      const 头 = 找页(r.startContainer);
      const 尾 = 找页(r.endContainer);
      /*
       * 跨页选中：这套锚（页 + 页内偏移 + 长度）表达不了，**宁可少划也别划错**。
       *
       * ⚠️ **但不能一声不吭。** 原来这儿直接 `set待划(null)` 就返回，
       * 用户跨着两页拉了一大段，松手之后**什么都没发生**——
       * 分不清是「划不了」还是「点错了没选中」，而这个仓库那条老规矩是
       * 「工具静默地什么都没做，和没问题长得一模一样」。
       * 现在摆一张说明白的卡：跨页划不了，一页一页划。
       */
      if (!头 || !尾) { set待划(null); return; }
      if (头.页 !== 尾.页) {
        const at = 贴着(e.clientX, e.clientY, undefined);
        set看笔记(null);
        set待划(at ? { text, 锚: { 位置: 头.页, 偏移: -1, 长: 0 }, at } : null);
        return;
      }
      const a = 页内偏移(头.层, r.startContainer, r.startOffset);
      const b = 页内偏移(头.层, r.endContainer, r.endOffset);
      if (a === null || b === null || b <= a) { set待划(null); return; }
      const at = 贴着(e.clientX, e.clientY, undefined);
      if (!at) return;
      set看笔记(null);
      set待划({ text, 锚: { 位置: 头.页, 偏移: a, 长: b - a }, at });
    };

    const 点了 = (e: MouseEvent) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return; // 选完松手那一下不算「点」
      /*
       * ⚠️ **先看是不是点在一块框选上。** 框选是真的有元素（一个绝对定位的 div），
       * 所以拿 `closest()` 就行，不用像文字划线那样拿坐标和每条 Range 的矩形硬比。
       * 排在文字划线前面：框选盖在文字层上，点到的就该是它。
       */
      const 框 = 命中矩形(e.target as Element | null, 划线们Ref.current);
      if (框) {
        const at2 = 贴着(e.clientX, e.clientY, undefined);
        if (at2) { set待划(null); set看笔记({ h: 框, text: 框.excerpt, at: at2 }); return; }
      }
      const c = 取画布Ref.current();
      if (!c) return;
      const h = 命中(c, e.clientX, e.clientY, 划线们Ref.current);
      if (!h) return;
      let r: Range | null = null;
      try { r = c.还原(h); } catch { r = null; }
      const at = 贴着(e.clientX, e.clientY, undefined);
      if (!at) return;
      set待划(null);
      set看笔记({ h, text: r?.toString() ?? '', at });
    };

    台.addEventListener('mouseup', 松手);
    台.addEventListener('click', 点了);
    return () => { 台.removeEventListener('mouseup', 松手); 台.removeEventListener('click', 点了); };
  }, [viewer, 贴着]);

  /**
   * **框选：在一页上拖出一个矩形。**
   *
   * 坐标**归一化到那一页**（`.pdf-page` 的矩形）再存，于是缩放、换窗口大小、
   * 重新渲染都不影响它——存像素的话每一次都得重算，漏一次就是个贴错地方的框。
   *
   * ⚠️ **太小的一律不算**：手一抖拖出个几像素的框，存下去是一个看不见、
   * 又删不掉（点不中）的东西。门槛取页宽高的 1.5%。
   */
  useEffect(() => {
    if (viewer !== 'pdf' || !框选中) return;
    const 台 = box.current;
    if (!台) return;
    let 壳: HTMLElement | null = null;
    let 起: { x: number; y: number } | null = null;
    let 盒: HTMLDivElement | null = null;

    const 归一 = (e: MouseEvent, p: HTMLElement) => {
      const r = p.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    const 按下 = (e: MouseEvent) => {
      const p = (e.target as Element | null)?.closest?.('.pdf-page') as HTMLElement | null;
      if (!p || e.button !== 0) return;
      e.preventDefault();
      壳 = p; 起 = 归一(e, p);
      盒 = p.ownerDocument.createElement('div');
      盒.className = 'hl-rect-拖';
      盒.style.cssText = `position:absolute;background:${底色('yellow')};outline:1px dashed currentColor;pointer-events:none`;
      p.appendChild(盒);
    };
    const 拖 = (e: MouseEvent) => {
      if (!壳 || !起 || !盒) return;
      const q = 归一(e, 壳);
      const x = Math.max(0, Math.min(起.x, q.x)), y = Math.max(0, Math.min(起.y, q.y));
      const w = Math.min(1, Math.max(起.x, q.x)) - x, h = Math.min(1, Math.max(起.y, q.y)) - y;
      盒.style.left = `${x * 100}%`; 盒.style.top = `${y * 100}%`;
      盒.style.width = `${Math.max(0, w) * 100}%`; 盒.style.height = `${Math.max(0, h) * 100}%`;
    };
    const 放开 = (e: MouseEvent) => {
      if (!壳 || !起) return;
      const p = 壳, s0 = 起;
      盒?.remove(); 壳 = null; 起 = null; 盒 = null;
      const q = 归一(e, p);
      const x = Math.max(0, Math.min(s0.x, q.x)), y = Math.max(0, Math.min(s0.y, q.y));
      const w = Math.min(1, Math.max(s0.x, q.x)) - x, h = Math.min(1, Math.max(s0.y, q.y)) - y;
      if (w < 0.015 || h < 0.015) return;   // 手抖那一下不算
      const n = Number(p.dataset.n ?? '');
      const 页 = Number.isFinite(n) && n > 0 ? n : 1;
      const at = 贴着(e.clientX, e.clientY, undefined);
      if (!at) return;
      set看笔记(null);
      /*
       * `excerpt` 存的是**一句说明不是原文**——那一块可能压根儿没有字。
       * 铁律 2：**截图也不存**，库里只有四个归一化坐标，图每次从原 PDF 现画。
       */
      set待划({
        text: `第 ${页} 页框选`,
        rect: [x, y, w, h].map((v) => v.toFixed(4)).join(','),
        锚: { 位置: 页, 偏移: 0, 长: 1 },
        at,
      });
    };
    台.addEventListener('mousedown', 按下);
    台.addEventListener('mousemove', 拖);
    台.addEventListener('mouseup', 放开);
    return () => {
      台.removeEventListener('mousedown', 按下);
      台.removeEventListener('mousemove', 拖);
      台.removeEventListener('mouseup', 放开);
      盒?.remove();
    };
  }, [viewer, 框选中, 贴着]);

  /**
   * **跳过去之后落到那一条划线上**（滚过去 + 闪一下，见 `闪一下`）。
   *
   * ⚠️ **要重试。** 点「跳转」的那一刻新的一节 / 新的一页**还没画出来**，
   * 文字层和 iframe 都还不在，Range 当然还原不出来。所以隔一小会儿再试一次，
   * 试够二十次（约 3 秒）就放弃——**放弃也不吭声**：跳转本身已经成了，
   * 差的只是「精确落到那一行」，为这个弹一句报错是噪音。
   */
  const 定位到 = useRef<(id: number) => void>(() => {});
  定位到.current = (id) => {
    let 试 = 0;
    const 走 = () => {
      const c = 取画布();
      const h = 划线们Ref.current.find((x) => x.id === id);
      if (c && h) {
        let r: Range | null = null;
        try { r = c.还原(h); } catch { r = null; }
        if (r) { 闪一下(c, r); return; }
      }
      if (试++ < 20) setTimeout(走, 150);
    };
    setTimeout(走, 200);
  };

  /** 把现在这一屏的划线重画一遍。换节 / 换页 / 改字号 / 缩放之后都要调 */
  const 重画划线 = useRef<() => void>(() => {});
  重画划线.current = () => {
    const c = 取画布();
    if (!c) return;
    /*
     * ⚠️ **返回值不能丢。** `画划线` 回的是「哪几条还原不出来」，
     * 而这儿原来是 `try { 画划线(...) } catch {}`——**整个扔掉**。
     * 后果是还原不出来的划线**无声消失**：屏幕上没有、也没有一句话，
     * 用户只会以为自己的笔记丢了。txt 那边一直有「划线漂了要说一声」，
     * 查看器这半没跟上。
     */
    try { set漂了(画划线(c, 划线们Ref.current).length); } catch { /* 画不上不该连累读书 */ }
    /*
     * **框选那种另画一遍。** 它们没有 Range（扫描页上一个文本节点都没有），
     * 进不了 `CSS.highlights` 那套。也正因为如此，**它们永远不算「漂了」**：
     * 页码加坐标是硬的，不依赖文字层铺没铺。
     */
    if (viewer === 'pdf') {
      try { 画矩形(box.current, 划线们Ref.current); } catch { /* 同上 */ }
    }
  };

  /*
   * **自动滚。判据抄 `Reader.tsx` 那一份**（滚到底自动接下一屏，接不上才停），
   * 只有一处不一样：**滚的是谁得当场找**——见 `找滚的`。
   *
   * `settings.mode === 'page'` 时直接不跑：那一档整屏是不动的，
   * 加 scrollTop 什么都不会发生（键也是灰的，两头都拦一道）。
   */
  useEffect(() => {
    if (!滚着 || settings.mode === 'page') return;
    const 滚 = 找滚的(box.current);
    if (!滚) return;
    let raf = 0;
    let last = performance.now();
    const 走 = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      滚.scrollTop += settings.autoScroll * dt;
      if (滚.scrollTop + 滚.clientHeight >= 滚.scrollHeight - 2) {
        // 后面还有就接上去接着滚——不然还要手动接一下，等于没解放双手
        if (还有下一屏.current()) {
          api.current.next?.();
          raf = requestAnimationFrame(走);
          return;
        }
        set滚着(false);
        return;
      }
      raf = requestAnimationFrame(走);
    };
    raf = requestAnimationFrame(走);
    return () => cancelAnimationFrame(raf);
  }, [滚着, settings.autoScroll, settings.mode]);

  const 到底了 = useRef<(当前0起: number, 共几: number) => void>(() => {});
  到底了.current = (cur, total) => {
    if (!atEndPaging(cur, total)) return;
    void rpc('reading.markFinished', { bookId }).catch(() => {});
    askReview();
  };

  useEffect(() => {
    if (!busy) { set慢了(false); return; }
    const t = setTimeout(() => set慢了(true), 6000);
    return () => clearTimeout(t);
  }, [busy]);

  /*
   * 键盘。这里原来写死 `ArrowLeft/PageUp` 和 `ArrowRight/PageDown`，
   * 而上面那句注释说「和 txt 阅读器那套手势一致」——**那句话是假的**：
   * txt 那边走的是用户可改的键表（设置 → 阅读 → 快捷键），
   * 把「下一页」改绑成别的键之后，**在 txt 里生效、在 PDF / EPUB 里不生效**。
   * 同一个人、同一套设置，换个格式就不认。
   *
   * 现在两边共用 `loadKeys()` + `actionFor()` 那一份。
   * ⚠️ **`Escape` 仍然单独认，不走 `actionFor`**——判据抄 `Reader.tsx`：
   * 退出键可以被改绑成一个普通字母，那时候 Esc 还得管用。
   */
  /**
   * 一次按键该干什么。**放 ref 里是因为有三个文档要用同一份**：
   * 应用自己的 `window`、以及 EPUB 那个 iframe 里的 document
   * （见下面 `挂进正文` 那段）。
   */
  const 键表 = useRef(loadKeys());
  const 按键 = useRef<(e: KeyboardEvent) => void>(() => {});
  按键.current = (e) => {
    // Esc 先关最上面那一层。判据抄 `Reader.tsx`：**Esc 是「关掉」不是「不要了」**，
    // 所以走 closeReview（把没存的那句话存了），不是 setReviewing(null)
    if (e.key === 'Escape') {
      // **有浮层就先关浮层**，一层都没有才是「退出阅读器」。
      // 原来这儿只认目录和评价——**设置、朗读、划线卡开着的时候按 Esc
      // 直接退回书架**（实测：开着设置按一下 Esc，`.reader` 就没了）。
      // 而这段注释当时已经写着「Esc 先关最上面那一层」，代码没做到，
      // 于是它自己就是那个假的判据。
      if (有浮层) 只开一个(null);
      else onExit();
      return;
    }
    const act = actionFor(键表.current, e.key);
    if (act === 'prev') { e.preventDefault(); api.current.prev?.(); }
    if (act === 'next') { e.preventDefault(); api.current.next?.(); }
    // 空格开关自动滚（默认键位）。翻页模式下这一档不成立，按了也不理
    if (act === 'autoScroll' && settings.mode !== 'page') { e.preventDefault(); set滚着((v) => !v); }
  };

  /**
   * 点正文左右两条带子翻页（legado 那套，txt 阅读器的翻页模式一直有）。
   *
   * `x` / `w` 都相对**正文那个盒子**：PDF 传的是 `.viewer-stage` 的坐标，
   * EPUB 传的是 iframe 里 document 自己的坐标（那两个文档不共享坐标系）。
   * 那两条带子多宽由 `点到哪边` 说了算——和 txt 阅读器同一份。
   *
   * 两条不翻的情况和 txt 那边一样：**有选中就不翻**（选完松手那一下顺手翻页，
   * 复制和划线就没法用了）、**点在链接/按钮上不翻**（EPUB 正文里真的有链接）。
   */
  const 点正文 = useRef<(x: number, w: number, 目标: Element | null, 有选中: boolean) => void>(() => {});
  点正文.current = (x, w, 目标, 有选中) => {
    /*
     * **开着浮层的时候，点正文是「收起浮层」，不翻页。**
     * 判据和 `Reader.tsx` 的 `onBodyClick` 是同一条：面板还开着、书却往前
     * 跳了一页，是最糟的一种反应。**排在模式判断前面**——「点空白处收面板」
     * 三档里都该成立，而下面那句 return 会把滚动档的点击整个吃掉。
     */
    /*
     * ⚠️ **有选区就直接走，这一条必须排在最前面。**
     *
     * 真鼠标松手之后浏览器**必然再补一个 `click`**。划线是
     * 「选完 → mouseup 弹卡」，而那张卡自己就算一层浮层——于是紧跟着的
     * 那一下 `click` 走到下面那句「有浮层就收起来」，**把刚开的卡在同一轮
     * 事件里又关了**。屏幕上的效果是：划了一段，**什么提示都没有**。
     *
     * 这个 bug 在两个阅读界面里各活了一份，而走查一直是绿的：
     * 它原来派的是合成 `mouseup`，**合成的不会带出 `click`**。
     * 现在 `cdp.mjs` 的 `拖选` 用的是真鼠标（`Input.dispatchMouseEvent`），
     * `notes.mjs` 两边各走一遍守着它。
     */
    if (有选中) return;
    /*
     * ⚠️ **框选模式下，点页面永远不算「点正文」。**
     *
     * 和上面那条是同一个 bug 的两个面：拖完松手后浏览器补的那个 `click`，
     * 会把刚弹出来的卡当成浮层收掉。文字划线靠「有选区」拦得住，
     * **而框选根本没有选区**——于是同样的症状又来一遍：框了一块，什么都没发生。
     */
    if (框选中) return;
    if (有浮层) { 只开一个(null); return; }
    /*
     * ⚠️ **只有翻页档才点两侧翻页**（判据抄 `Reader.tsx` 的 `onBodyClick`）。
     * 滚动档下这一下翻的是**整整一节**——正在滚着读的人随手点一下正文，
     * 书就跳走了一章。txt 那边一直有这道闸，查看器这边是补上的。
     */
    if (settings.mode !== 'page') return;
    if (目标?.closest?.('a, button, input, textarea, select')) return;
    const 边 = 点到哪边(x, w);
    if (边 === -1) api.current.prev?.();
    else if (边 === 1) api.current.next?.();
  };

  // 只注册一次：两个处理器都在 ref 里，不用跟着浮层状态重新挂
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => 按键.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** 搜过的目录。EPUB 的 nav 通常几十条，直接过一遍就行 */
  // 换本书当然要清：上一本的搜索词在这一本多半一条都不匹配，
  // 目录就成了「没有匹配的章节」——看起来像这本书没有目录（判据同 `Reader.tsx`）
  useEffect(() => { setTocFilter(''); }, [bookId]);
  useEffect(() => {
    let 死了 = false;
    void rpc<Array<{ page: number; title: string }>>('outline.get', { bookId })
      .then((r) => { if (!死了) set自建目录(r ?? []); })
      .catch(() => { if (!死了) set自建目录([]); });
    return () => { 死了 = true; };
  }, [bookId]);

  /**
   * 写回去并重取。**返回值就是库里那份**（`writeOutline` 排好序、去重、校验过），
   * 直接拿它当新状态——自己在前端再排一遍就是同一条判据拄两份。
   */
  const 存目录 = useCallback(async (items: Array<{ page: number; title: string }>) => {
    try {
      set自建目录(await rpc<Array<{ page: number; title: string }>>('outline.set', { bookId, items }));
    } catch (e) { setErr((e as Error).message); }
  }, [bookId]);

  /**
   * 目录 = **PDF 自带的 outline + 用户自己加的**，按页码排在一起。
   *
   * ⚠️ **两者得看得出区别**：只有自己加的那几条能改名、能删（自带的在文件里）。
   * 摆一个删不掉的删按钮比不摆更糟（本仓库那条老规矩）。
   */
  const 全部目录 = viewer === 'pdf'
    ? [
      ...toc.map((c) => ({ ...c, 自建: false as const, key: 'pdf:' + String(c.index) + ':' + c.label })),
      ...自建目录.map((o) => ({
        label: o.title, index: o.page, 自建: true as const, key: String(o.page) + ':' + o.title,
      })),
    ].sort((a, b) => a.index - b.index)
    : toc.map((c) => ({ ...c, 自建: false as const, key: 'x:' + String(c.index) + ':' + c.label }));

  /**
   * 目录那个键摆不摆。
   *
   * ⚠️ **PDF 就算一条 outline 都没有也要摆**——自建目录的入口就在里面，
   * 不摆的话「没目录的书自己建一个」这件事在界面上根本到不了。
   * EPUB 照旧：没有 nav 就不摆（那半没有自建目录，摆出来是个空抽屉）。
   */
  const 有目录入口 = toc.length > 0 || viewer === 'pdf';

  const 显示的目录 = tocFilter.trim()
    ? 全部目录.filter((c) => c.label.toLowerCase().includes(tocFilter.trim().toLowerCase()))
    : 全部目录;
  /**
   * 目录里「现在在哪一条」的那个序号。
   *
   * ⚠️ **两种格式的序号是两个东西**：EPUB 是 spine 第几节（`sec`，0 起），
   * PDF 是第几页（`page`，1 起）。目录项存的也分别是这两种，
   * 所以比较之前要挑对——用错了高亮会一直停在第一条。
   */
  const 当前位置 = viewer === 'pdf' ? page : sec;

  /*
   * **目录里标出哪一节/哪一页有笔记**——判据整段在 `Reader.tsx` 同一处。
   * 四种位置共用 `chapter_idx` 这一列（PDF 的文字划线和框选都装页码、EPUB 装 spine 序号），
   * 所以这儿和 txt 那边查的是同一张表、同一个函数，不用分岔。
   */
  const [有笔记的节, set有笔记的节] = useState<Record<number, { h: number; b: number }>>({});
  useEffect(() => {
    if (!tocOpen) return;
    let 作废 = false;
    void rpc<Record<number, { h: number; b: number }>>('notes.chapters', { bookId })
      .then((r) => { if (!作废) set有笔记的节(r); })
      .catch(() => { if (!作废) set有笔记的节({}); });
    return () => { 作废 = true; };
  }, [tocOpen, bookId]);

  const 记号 = useCallback((i: number) => {
    const 有 = 有笔记的节[i];
    if (!有) return '';
    return [有.h ? '划线 ' + String(有.h) : '', 有.b ? '书签' : ''].filter(Boolean).join(' · ');
  }, [有笔记的节]);

  /*
   * ── 书签 ────────────────────────────────────────────
   *
   * `bookmark` 那张表本来就是格式无关的（`book_id` + `chapter_idx` + 偏移），
   * **缺的一直只是界面**。位置用的和目录、划线同一套序号：
   * EPUB 是 spine 序号、PDF 是页码——也就是 `api.goto()` 收的那个数。
   *
   * ⚠️ **摘录要存**：面板上一条只写着「第 12 页」的书签，等于没记。
   * 存当前这一屏正文的头一句（`正文` 已经取好了，PDF 的文字层也在里面）。
   * 扫描版 PDF 取不到字，那就存空——**没有摘录好过存一句假的**。
   */
  const [书签们, set书签们] = useState<Bookmark[]>([]);
  const 重取书签 = useCallback(() => {
    void rpc<Bookmark[]>('bookmark.list', { bookId })
      .then(set书签们)
      .catch(() => set书签们([]));
  }, [bookId]);
  useEffect(() => { 重取书签(); }, [重取书签]);

  /** 这一屏加过书签没有。右轨那个键靠它显示开着 */
  const 这屏的书签 = 书签们.find((m) => m.chapter_idx === 当前位置) ?? null;
  const 切书签 = useCallback(async () => {
    try {
      if (这屏的书签) {
        // 没写笔记的书签直接删，判据同 txt 那边（带笔记的才要 confirmed）
        await rpc('bookmark.remove', { id: 这屏的书签.id });
      } else {
        await rpc('bookmark.add', {
          bookId,
          chapterIdx: 当前位置,
          excerpt: 正文.trim().slice(0, 60) || undefined,
        });
      }
      重取书签();
    } catch { /* 加不上不该连累读书 */ }
  }, [这屏的书签, bookId, 当前位置, 正文, 重取书签]);
  /**
   * 现在停在目录的哪一条：**序号不超过当前位置的最后一条**。
   *
   * ⚠️ 高亮和底栏那个章名**共用这一条**，不是各判各的。
   * 各判各的时候高亮写的是 `c.index === 当前位置`，而好几条书签可以指同一页
   * （一页上有几个小节，很常见）——实测「Bookmark p1」和它底下的「Sub of p1」
   * **同时被标成 aria-current**。`aria-current` 按定义只该有一个。
   */
  /**
   * **目录跟着当前这一节走。**判据整段抄 `Reader.tsx` 的 `curTocRef`
   * （那边是为「12058 章的书读到第 500 章」写的）——**查看器一直没抄到**。
   * 当场量的：45 节的书跳到第 39 节再开目录，列表停在 `0/1038`，
   * 当前那条**在屏幕外**，得自己滚一千像素去找「我在哪」。
   *
   * PDF 那边同样成立：技术书的 outline 几百条是常事。
   *
   * **是回调 ref 不是 effect**：目录关着时整个面板不渲染，
   * 「按钮一挂上就调」两种时机（开面板、面板开着时换节）都盖得到。
   * `block: 'center'` 而不是 `nearest`——当前那条落在中间，前后还有多少一眼看得到。
   * **identity 必须稳定**（`useCallback` 空依赖），否则每渲染一次就解绑重绑、滚一次。
   */
  const 当前节Ref = useCallback((el: HTMLButtonElement | null) => {
    el?.scrollIntoView({ block: 'center' });
  }, []);

  // 搜索结果要显示章名，而目录是异步取回来的——走 ref，别把大 effect 拖进依赖
  目录名.current = (i) => toc.find((c) => c.index === i)?.label.trim() ?? null;

  const 当前条 = (() => {
    let 谁: { label: string; index: number } | null = null;
    for (const c of toc) { if (c.index > 当前位置) break; 谁 = c; }
    return 谁;
  })();
  const 当前章名 = 当前条?.label.trim() ?? null;

  return (
    /*
     * **外壳和 txt 阅读器完全一样**（用户：「pdf/epub 的阅读界面应该和 txt 一致的」）：
     * 同一个 `.reader` 根、同一条左轨、同一片正文栏、同一条底部状态条，
     * 于是两条轨贴着正文栏那套定位、以及壳的配色全都直接生效。⚠️ 但**书本身不在壳里**——EPUB 的正文在 iframe 里、PDF 在 canvas 上，`--read-*` 到不了，纸色要单独送进去（见下面 themes.override 那段）。
     *
     * ⚠️ **这里原来写着「右轨没有」，而那句话早就不成立了。**
     * 它列的那七个键（加书签 / 搜索 / 书签划线 / 自动滚 / 朗读）**现在一个不少地在右轨上**
     * （`.reader-tools`，就在这个文件下面），另外还多了评价、缩放和**框选**。
     * 当初那句话错在把「实现方式不同」当成了「功能不成立」：书签、划线、搜索
     * 对 PDF / EPUB 都成立，只是位置不一样（页码 / CFI / 矩形，见 `pdf-text.ts` 顶上）。
     * **真不成立的只有一样**：按字节偏移那一套（全库正文索引），
     * 而它本来就不在右轨上。
     */
    <div className="reader">
      {/* **和 txt 阅读器同一套 class**（`.toc` / `.toc-item` …），样式、窄屏那套
          浮层规则、纸色全都直接生效，一行 CSS 都不用加。
          里面的逻辑比那边简单得多：EPUB 的 nav 通常几十条，
          用不着那边为一万章写的分窗加载（`TOC_WINDOW`）——**只搬样式不搬机械**。 */}
      {tocOpen && 有目录入口 && (
        <aside className="toc" ref={目录层}>
          {/* 书名 + 收起 + 搜索框和 txt 阅读器共用一份（`ReaderChrome.tsx`）。
              下面塞进去的那块只有 PDF 有，不属于共用判据 */}
          <TocHead
            bookTitle={bookTitle}
            filter={tocFilter}
            setFilter={setTocFilter}
            onClose={() => setTocOpen(false)}
          >
            {/* **把这一页加进目录。** 名字先给一个能用的默认（「第 N 页」），
                加完直接进改名——让人先想好名字再能加，多一步而且容易放弃 */}
            {viewer === 'pdf' && (
              <button
                className="mini"
                style={{ marginTop: '.4rem' }}
                onClick={() => {
                  const 页 = Math.max(1, page || 1);
                  const 名 = `第 ${页} 页`;
                  void 存目录([...自建目录, { page: 页, title: 名 }]);
                  set改目录({ key: String(页) + ':' + 名, draft: 名 });
                }}
              >
                把这一页加进目录
              </button>
            )}
          </TocHead>
          <div className="toc-list">
            {显示的目录.map((c) => (
              <div key={c.key} style={c.自建 ? { display: 'flex', alignItems: 'center', gap: '.2rem' } : undefined}>
              {c.自建 && 改目录?.key === c.key ? (
                <input
                  autoFocus
                  value={改目录.draft}
                  aria-label="给这一条目录改名"
                  onChange={(e) => set改目录({ key: c.key, draft: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { set改目录(null); return; }
                    if (e.key !== 'Enter') return;
                    const t = 改目录.draft.trim();
                    set改目录(null);
                    if (!t) return;
                    void 存目录(自建目录.map((o) => (
                      String(o.page) + ':' + o.title === c.key ? { page: o.page, title: t } : o)));
                  }}
                  onBlur={() => set改目录(null)}
                  style={{ flex: 1, minWidth: 0, margin: '.1rem .3rem' }}
                />
              ) : (
              <button
                key={`${c.index}-${c.label}`}
                ref={c === 当前条 ? 当前节Ref : null}
                className={`toc-item${c.index < 当前位置 ? ' read' : ''}`}
                aria-current={c === 当前条}
                /*
                 * ⚠️ **跳过去之后把搜索词清掉。**判据整段在 `Reader.tsx` 同一处，
                 * 这边一直没跟上。当场量的：搜「第7章」跳过去、再打开目录——
                 * **45 条的目录只剩一条**，而「我在哪一节」连个影子都没有。
                 *
                 * **只有「跳过去」这个动作清，Esc 和「收起」不清**：
                 * Esc 从不扔掉你做过的事，做完了的动作才顺手收拾。
                 * 没找到就按 Esc 走开的人，回来还想接着搜那个词。
                 */
                onClick={() => { api.current.goto?.(c.index); setTocOpen(false); setTocFilter(''); }}
                title={记号(c.index) ? c.label.trim() + '（' + 记号(c.index) + '）' : c.label.trim()}
              >
                {/* ⚠️ **标题必须包在 `.toc-t` 里。** `.toc-item` 已经改成 flex
                    （右边要挂笔记记号），截字的活儿归 `.toc-t`——
                    不包的话长节名不再省略号，直接把侧栏撑破 */}
                <span className="toc-t">{c.自建 ? '✦ ' : ''}{c.label}</span>
                {记号(c.index) && <span className="toc-mark">{记号(c.index)}</span>}
              </button>
              )}
              {/* **只有自己加的那几条摆改名和删**——PDF 自带的那些在文件里，
                  摆一个删不掉的删按钮比不摆更糟 */}
              {c.自建 && 改目录?.key !== c.key && (
                <>
                  <button
                    className="mini"
                    aria-label={'给「' + c.label + '」改名'}
                    onClick={() => set改目录({ key: c.key, draft: c.label })}
                  >
                    改名
                  </button>
                  <button
                    className="mini"
                    aria-label={'从目录里删掉「' + c.label + '」'}
                    onClick={() => void 存目录(
                      自建目录.filter((o) => String(o.page) + ':' + o.title !== c.key))}
                  >
                    删
                  </button>
                </>
              )}
              </div>
            ))}
            {显示的目录.length === 0 && (
              <p className="muted" style={{ padding: '.5rem .8rem' }}>没有匹配的章节</p>
            )}
          </div>
        </aside>
      )}

      <div className="reader-main" ref={mainRef}>
        {/* **和 txt 阅读器一样分两条轨**（用户：「非 txt 的阅读界面也应该和 txt 一致的，
            不该分开」）。判据抄 `styles.css` 那条：**左轨在左上放常驻动作，
            右轨在右下放读的时候临时用一下的**。原来这些键全挤在左边一条上，
            于是「评价」「夜间」和「上一页」并排——一个是随手标一下，一个是每分钟按几十次。 */}
        <nav className="reader-rail" aria-label="查看器功能" ref={左轨}>
          <button onClick={onExit} title="回书架（Esc）">{ICO.back}<span>书架</span></button>
          {/* **只有真取到目录才摆这个键**：PDF 没有 nav，摆一个点开是空的抽屉
              比不摆更糟（本仓库那条老规矩） */}
          {/* ⚠️ **`.on` 在左轨上什么都不做**——那条 CSS 只写给右轨
              （`.reader-tools button.on`）。左轨认的是 `aria-current`。
              当场量的：这个键开着关着字色都是 `rgb(38,38,38)`，一个像素不差。 */}
          {有目录入口 && (
            <button
              ref={目录键}
              aria-current={tocOpen}
              onClick={() => 切换('目录')}
              title="目录"
            >
              {ICO.toc}<span>目录</span>
            </button>
          )}
          <button onClick={() => api.current.prev?.()} title="上一页（←）">{ICO.prev}<span>上一页</span></button>
          <button onClick={() => api.current.next?.()} title="下一页（→）">{ICO.next}<span>下一页</span></button>
          {/* 设置：纸色、字号、行距、正文字体。**和 txt 阅读器同一个面板**
              （`ReadSettings.tsx`），不是这儿抄一份。
              ⚠️ PDF 那一页是 canvas 上的一张图，「字」那一组作用不到它——
              `能改正文` 因此只对 EPUB 成立，那时候整组不摆出来。 */}
          <button
            ref={设置键}
            aria-current={panel}
            onClick={() => 切换('设置')}
            title="纸色、字号、行距、正文字体"
          >
            {ICO.gear}<span>设置</span>
          </button>
        </nav>

        {/* 右轨：读的时候临时用一下的那几样。和 txt 阅读器同一个位置、同一套样式 */}
        <div className="reader-tools" ref={右轨}>
          {/* **评价是那条「右轨对 PDF/EPUB 一条都不成立」规矩的唯一例外**：
              评分和短评存在 `reading_state` 里、按 book_id 记，和格式一个字的关系都没有。
              理由整段写在 `ReviewCard.tsx` 上面 */}
          {/*
            * **加书签 / 书签划线**——这两个键原来只有 txt 阅读器有，
            * 而这个文件顶上那句「右轨那七个键对 PDF / EPUB 一条都不成立」
            * 说的是**当时**：它们建立在 txt 的字节偏移和章节表上。
            * 现在不成立了：`bookmark` 和 `highlight` 两张表只认
            * `book_id + chapter_idx + 偏移`，而查看器早就有一套同样的序号
            * （EPUB 的 spine 序号 / PDF 的页码，也就是 `api.goto()` 收的那个数）。
            *
            * ⚠️ **回看那一层尤其不能少。** EPUB 上个版本就能划线了，
            * 可划完之后**没有任何地方能把它找出来**——
            * 「加得进去、看不见」，这个功能在 txt 那边就栽过一次。
            */}
          <button
            className={这屏的书签 ? 'on' : ''}
            aria-current={!!这屏的书签}
            onClick={() => void 切书签()}
            title={这屏的书签 ? '取消这一屏的书签' : '给这一屏加个书签'}
          >
            {ICO.mark}<span>加书签</span>
          </button>
          <button
            className={看笔记面板 ? 'on' : ''}
            aria-current={看笔记面板}
            onClick={() => 切换('书签划线')}
            title="回看这本书的书签、划线和笔记"
          >
            {ICO.pen}<span>书签划线</span>
          </button>
          {/* **框选只给 PDF 摆。** EPUB 是重排的文本，没有「页上那一块」这回事；
              摆一个按下去不知道会发生什么的键，比不摆更糟（本仓库那条老规矩）。 */}
          {viewer === 'pdf' && (
            <button
              className={框选中 ? 'on' : ''}
              aria-current={框选中}
              onClick={() => set框选中((v) => !v)}
              title="框选：在页上拖一块。扫描页、插图、公式那些选不中字的地方靠它做笔记"
            >
              {ICO.crop}<span>{框选中 ? '退出框选' : '框选'}</span>
            </button>
          )}
          {/* **书内搜索。** 「找到那一段」是回去做笔记的前一步——
              这个键原来只有 txt 阅读器有，因为那条路走的是章节表和 FTS。
              查看器这边正文只有渲染进程拿得到（pdf.js 的文字层 / epub.js 的一节），
              所以搜法另写，而界面是同一个组件 */}
          <button
            className={搜索开 ? 'on' : ''}
            aria-current={搜索开}
            onClick={() => 切换('搜索')}
            title="在这本书里找一段话"
          >
            {ICO.search}<span>搜索</span>
          </button>
          <button
            ref={评价键}
            className={reviewing ? 'on' : ''}
            // `.on` 给眼睛、`aria-current` 给读屏，判据同 `Reader.tsx` 那一处
            aria-current={!!reviewing}
            onClick={() => 切换('评价')}
            title="给这本书打分、写一句短评。读不下去了也记一句，下次在书架上就能看见"
          >
            {ICO.star}<span>评价</span>
          </button>
          {viewer === 'pdf' && (
            <>
              <button onClick={() => setZoom((z) => Math.min(4, Number((z + 0.2).toFixed(1))))}
                title="放大">{ICO.up}<span>放大</span></button>
              <button onClick={() => setZoom((z) => Math.max(0.4, Number((z - 0.2).toFixed(1))))}
                title="缩小">{ICO.down}<span>缩小</span></button>
            </>
          )}
          {/* 自动滚。**和 txt 阅读器同一个键、同一句说明**。
              翻页那一档它是灰的——那一屏根本不滚，摆一个点了没反应的键比没有更糟 */}
          <button
            className={滚着 ? 'on' : ''}
            disabled={settings.mode === 'page'}
            onClick={() => set滚着((v) => !v)}
            title="自动往下滚，读到底自动接下一屏（空格）。左右翻页模式下用不上"
          >
            {ICO.auto}<span>自动滚</span>
          </button>
          {/* 朗读。**和 txt 阅读器同一个键、同一层界面**（`TtsLayer`）。
              正在念的时候这个键亮着（`.on`），一眼看得出开着 */}
          <button
            ref={朗读键}
            className={tts.speaking ? 'on' : ''}
            aria-current={ttsOpen}
            onClick={() => 切换('朗读')}
            title={
              settings.ttsEngine === 'system'
                ? '朗读：选音色、试听、语速、定时。现在用的是系统语音（离线）'
                : '朗读：选引擎、试听、语速、定时。在线引擎会把正文发到第三方服务器'
            }
          >
            {ICO.tts}<span>朗读</span>
          </button>
          {/* 一键白天/夜间。**和 txt 阅读器共用同一份**（`ReaderChrome.tsx`）。
              ⚠️ PDF 这一档变的只有壳：那一页是 canvas 上的图，纸色作用不到它。 */}
          <NightToggle theme={settings.theme} setTheme={(v) => set('theme', v)} />
        </div>

        {/* 选中一段文字：**贴着它开**，和 txt 阅读器一套（`.note-pop`）。
            四个色块前面要有个动词——光四个圆点看不出点下去会发生什么 */}
        {待划 && (
          <div
            className="note-pop card"
            ref={贴住}
            data-anchor-top={待划.at.锚顶}
            style={{
              top: 待划.at.top, left: 待划.at.left,
              flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: '.4rem',
            }}
          >
            <span className="muted" style={{ fontSize: '.8rem', maxWidth: '13rem', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
              「{待划.text}」
            </span>
            {待划.锚.偏移 < 0 ? (
              /* **跨页选中：说清为什么划不了，以及该怎么办。**
                 静默丢弃的话，用户分不清是「划不了」还是「压根没选中」 */
              <>
                <span className="danger" style={{ fontSize: '.8rem' }}>
                  这一段跨了两页，划不了——一页一页划。
                </span>
                <button className="quiet" onClick={() => set待划(null)}>知道了</button>
              </>
            ) : 笔记草稿 === null ? (
              <>
                <span style={{ fontSize: '.82rem' }}>划线</span>
                {COLORS.map((c) => (
                  <button
                    key={c}
                    className="hl-dot"
                    aria-label={'用「' + 颜色名[c] + '」划线'}
                    title={颜色名[c]}
                    style={{ background: HL_COLORS[c] }}
                    onClick={() => void 存划线(c)}
                  />
                ))}
                <button className="mini" onClick={() => set笔记草稿('')}>划线并写笔记</button>
                <button className="quiet" onClick={() => set待划(null)}>取消</button>
              </>
            ) : (
              <>
                <input
                  autoFocus
                  style={{ flex: 1, minWidth: '10rem' }}
                  value={笔记草稿}
                  placeholder="记一句：为什么划这里"
                  onChange={(e) => set笔记草稿(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && 笔记草稿.trim()) void 存划线('yellow', 笔记草稿); }}
                />
                <button className="primary" disabled={!笔记草稿.trim()} onClick={() => void 存划线('yellow', 笔记草稿)}>
                  记下来
                </button>
                <button className="quiet" onClick={() => set笔记草稿(null)}>不写笔记</button>
              </>
            )}
          </div>
        )}

        {/* 点了一条划线：**笔记就开在它底下**。删是这里一个写明白的按钮——
            判据和 txt 阅读器那张卡一样：在划过的字上点一下是想看当时写了什么，
            不该一点就没 */}
        {看笔记 && (
          <div
            className="note-pop card"
            ref={贴住}
            data-anchor-top={看笔记.at.锚顶}
            style={{ top: 看笔记.at.top, left: 看笔记.at.left }}
          >
            {/* 卡片里面**和 txt 阅读器共用一份**（`NoteCard`）——
                这两张卡原来各写各的，而且真的分叉了（那边没笔记的一点就删）。
                贴在哪儿仍然是这边自己的事：查看器要处理 iframe，算法不一样 */}
            <NoteCard
              笔记={看笔记.h.note}
              颜色={看笔记.h.color}
              存笔记={async (note) => {
                await rpc('highlight.setNote', { id: 看笔记.h.id, note: note || null });
                set看笔记((v) => (v ? { ...v, h: { ...v.h, note: note || null } } : v));
                重取划线();
              }}
              改颜色={async (c) => {
                await rpc('highlight.setColor', { id: 看笔记.h.id, color: c });
                set看笔记((v) => (v ? { ...v, h: { ...v.h, color: c } } : v));
                重取划线();
              }}
              删掉={async () => {
                await rpc('highlight.remove', { id: 看笔记.h.id, confirmed: true });
                set看笔记(null);
                重取划线();
              }}
              关闭={() => { set看笔记(null); set存图(null); }}
              /* **只有框选才摆这颗键**——文字划线没有「那一块」 */
              额外={看笔记.h.rect ? (
                <>
                  <button className="mini" onClick={() => void 存成图片(看笔记.h)}>存成图片…</button>
                  {存图 && (
                    <span className="muted" style={{ fontSize: '0.75rem', marginLeft: '.3rem' }}>{存图}</span>
                  )}
                </>
              ) : null}
            />
          </div>
        )}

        {ttsOpen && (
          <div className="reader-panel" ref={朗读层} style={朗读位}>
            <TtsLayer
              tts={tts}
              settings={settings}
              set={set}
              正文={正文}
              onManage={() => set管引擎(true)}
              计时={计时}
            />
          </div>
        )}

        {panel && (
          <div className="reader-panel" ref={设置层} style={设置位}>
            <ReadSettingsPanel
              settings={settings}
              set={set}
              能改正文={viewer === 'epub'}
              /*
               * ⚠️ **PDF 只有两档，而且第一档的名字不一样。**
               * 一本 PDF 没有章（`outline` 是书签不是切分），「按章」对它不成立；
               * 而「按章」和「无限下滑」落到 PDF 上会变成同一件事——
               * 摆两个点了一模一样的按钮，比少一个更糟。
               */
              模式={viewer === 'epub' ? ['scroll', 'flow', 'page'] : ['scroll', 'page']}
              繁简={{
                值: 繁简,
                改: (m) => {
                  set繁简(m);
                  void rpc('convert.set', { bookId, mode: m }).catch(() => {});
                },
                // 短一句就够——「那一页是整张图」下面「字」那条说明已经讲过一遍了，
                // 同一个面板里把同一句话说两遍，读起来像出了 bug
                说明: viewer === 'pdf' ? '只作用于朗读念的文字（那一页是图，字形改不了）。' : undefined,
              }}
            />
            {viewer === 'pdf' && (
              /* **说清为什么这儿没有「字」那一组。** 少一整组的设置面板，
                 不说的话看起来像坏了 */
              <p className="muted" style={{ fontSize: '.75rem', margin: '.2rem 0 0' }}>
                PDF 那一页是整张图，字号、行距、字体都作用不到它，所以没有「字」那一组。
              </p>
            )}
          </div>
        )}

        {搜索开 && (
          <FindInBook
            搜={(q) => 搜正文.current(q)}
            上限={搜索上限}
            onJump={(i) => { api.current.goto?.(i); 只开一个(null); }}
            onClose={() => 只开一个(null)}
          />
        )}

        {看笔记面板 && (
          /*
            * **和 txt 阅读器同一个组件**（`HighlightsPanel`），不是这儿抄一份。
            * 两处差别只有两样：目录的形状（这边是 `{label, index}`）
            * 和**位置怎么称呼**——PDF 的位置是页不是章，一本 PDF 的书签
            * 写着「第 5 章」是错的，而 PDF 十有八九没有 outline、走的正是兜底。
            */
          <HighlightsPanel
            bookId={bookId}
            跳到别的书={onOpenBook}
            chapters={toc.map((c) => ({ idx: c.index, title: c.label.trim() }))}
            兜底位置名={(i) => (viewer === 'pdf' ? `第 ${i} 页` : `第 ${i + 1} 节`)}
            onJump={(idx, _off, 划线id) => {
              api.current.goto?.(idx);
              只开一个(null);
              if (划线id !== undefined) 定位到.current(划线id);
            }}
            onClose={() => 只开一个(null)}
          />
        )}

        {reviewing && (
          <ReviewCard
            bookId={bookId}
            bookTitle={bookTitle}
            value={reviewing}
            onChange={setReviewing}
            onDone={() => setReviewing(null)}
            boxRef={评价层}
            style={评价位}
          />
        )}

        <div className="reader-body viewer-body">
          {err && (
            <p className="danger">
              {err}
              <button
                className="mini"
                style={{ marginLeft: '.5rem' }}
                onClick={() => void rpc('ui.openFile', { path }).catch(() => {})}
              >
                用系统程序打开
              </button>
            </p>
          )}
          {/*
            * ⚠️ **等太久就把出路提前摆出来，别让人干等到失败。**
            *
            * 这个应用自己的原则是「用户不该对着一个永远的转圈」，而原来的实现是：
            * 两段 15 秒的超时都走完（**整整 30 秒**）才给出「用系统程序打开」。
            * 逐秒盯过一次失败的开书：0–30 秒屏幕上只有「正在打开…」四个字。
            *
            * 现在超过 6 秒就承认「慢了」并把那条出路摆出来，**而后台还在继续试**——
            * 成了就正常显示，用户什么都不用做；不成他早就有得点了。
            * 6 秒是拍的：正常开出来是一两秒的事，等到六秒基本就是在走那条挂住的路了。
            */}
          {busy && !err && (
            <p className="muted">
              正在打开…
              {慢了 && (
                <>
                  {' '}这本书打开得有点慢，还在试。
                  <button
                    className="mini"
                    style={{ marginLeft: '.5rem' }}
                    onClick={() => void rpc('ui.openFile', { path }).catch(() => {})}
                  >
                    用系统程序打开
                  </button>
                </>
              )}
            </p>
          )}
          {/*
            * ⚠️ **pdf.js / epub.js 要一块 React 不碰的地方。**
            * 原来它们直接往这个 `.viewer-body` 里塞节点，而 React 也在这儿渲染
            * 「正在打开…」和报错——**下一次重渲染就把它们的 DOM 抹掉了**
            * （症状：容器里只剩那个 `<p>`，一个 iframe 都没有，而且不报错）。
            * 单开一个空 div 交给它们，React 永远不动它的孩子。
            */}
          {/* 点正文翻页。**挂在这一层而不是 `.viewer-body`**：那一层还包着
              「正在打开…」和报错，点它们不该翻页。
              ⚠️ React 只管这个 div 自己的 props，**不碰它的孩子**——
              pdf.js / epub.js 塞进去的节点照旧不受影响（见上面那段）。
              EPUB 的点击落在 iframe 里、到不了这儿，另走 `hooks.content`。 */}
          <div
            ref={box}
            className={'viewer-stage' + (框选中 ? ' 框选中' : '')}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const 选 = window.getSelection();
              点正文.current(e.clientX - r.left, r.width, e.target as Element, !!选 && !选.isCollapsed);
            }}
          />
        </div>

        <div className="reader-foot">
          {/* **底下这一行要说「现在读到哪一章」**，光一个书名等于没说——
              txt 阅读器那边这一格写的就是章节名。EPUB 取目录里
              **序号不超过当前节的最后一条**（一节里可能有好几条目录，
              也可能一条都没有，那就退回书名） */}
          <span className="foot-at" title={当前章名 ?? bookTitle}>{当前章名 ?? bookTitle}</span>
          {/*
            * **划线漂了要说一声**（判据抄 `Reader.tsx` 那一处）。
            *
            * 还原不出来的划线在屏幕上就是**不存在**——而摘录和笔记还好端端在库里。
            * 不说的话，用户看到的是「我的笔记没了」。
            * 说清三件事：几条、为什么、还能去哪儿看（点它就开「书签划线」）。
            *
            * ⚠️ **只在真有的时候才占这一格**：底栏在 760 宽下本来就挤。
            */}
          {漂了 > 0 && (
            <button
              className="mini danger"
              onClick={() => 切换('书签划线')}
              title="正文变过（换了版本、重新解析过），这几条划线按存下来的位置找不回原文了。摘录和笔记还在，点开就能看"
            >
              {漂了} 条划线画不出来
            </button>
          )}
          <span className="pager">
            <button className="mini" onClick={() => api.current.prev?.()} title="上一页（←）">‹ 上一页</button>
            <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {viewer === 'pdf' ? `${page} / ${pages || '…'} 页` : pct == null ? '…' : `${pct}%`}
            </span>
            <button className="mini" onClick={() => api.current.next?.()} title="下一页（→）">下一页 ›</button>
          </span>
          {/* PDF 才有整本的页码，拖得动；EPUB 那边 epub.js 要先生成 locations 才谈得上按比例跳 */}
          {viewer === 'pdf' && pages > 1 && (
            <input
              className="foot-range"
              type="range"
              min={1}
              max={pages}
              value={page}
              aria-label="跳到第几页"
              onChange={(e) => api.current.goto?.(Number(e.target.value))}
            />
          )}
          <span className="foot-pct">
            {viewer === 'pdf' ? `${Math.round(zoom * 100)}%` : ''}
          </span>
        </div>
      </div>

      {/* 引擎管理。**和「设置 · 阅读」、txt 阅读器里是同一个组件**，不另抄一份 */}
      {管引擎 && (
        <TtsEnginesModal settings={settings} setSettings={setSettings} onClose={() => set管引擎(false)} />
      )}
    </div>
  );
}
