import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ICO } from './icons.tsx';
import { ReviewCard, useReview } from './ReviewCard.tsx';
import { useAnchored, use浮层焦点 } from './anchor.ts';
import { ReadSettingsPanel } from './ReadSettings.tsx';
import { TtsLayer, useSleepTimer } from './TtsLayer.tsx';
import { 底色, use色名 } from './highlight-view.ts';
import { NoteCard } from './NoteCard.tsx';
import { COLORS } from '../core/highlight.ts';
/* ⚠️ **引 core 那一份，别手抄。** 这儿原来是个只有两列的 `Bookmark`，
   而 `bookmark.list` 返回的是整行——`dup-decls.mjs` 当场报
   「同一个 rpc 两种返回类型」（查看器那半也要用它，两份必然分叉） */
import type { Bookmark } from '../core/status.ts';
import { anchorOffset, atEndScrolling, atEndPaging, 点到哪边, ANCHOR_SLACK_PX } from '../core/reading-pos.ts';
import type { Detail } from './BookEditor.tsx';
import type { FontFile } from './Settings.tsx';
import { rpc } from './rpc.ts';
// 从 core 引：渲染进程原来抄了一份，而且已经掉了 `bookId` 那个字段
import type { ChapterText } from '../core/reader.ts';
import {
  applySettings, applyFontFaces, loadSettings, saveSettings, loadKeys, actionFor, keyLabel,
  type ReadSettings, type Action, 滚动方式 } from './settings.ts';
import { FindInBook, type Hit } from './FindInBook.tsx';
import { TtsPanel } from './TtsPanel.tsx';
import { NightToggle, TocHead, TtsEnginesModal } from './ReaderChrome.tsx';
import { HighlightsPanel } from './HighlightsPanel.tsx';
import { splitParagraphs, sliceByMarks, speakingParagraph, splitImages, type Mark } from '../core/paragraphs.ts';
import { useTts } from './useTts.ts';

interface TocEntry {
  idx: number;
  volume: string | null;
  title: string;
}


interface Props {
  bookId: number;
  bookTitle: string;
  startAt: number;
  /** 上次读到这一章的第几个字符。断点续读要精确到段落，不是到章 */
  startOffset?: number;
  /** 从「全库笔记」点一条：打开那本书、落到那一处。不给的话那一档是只读的 */
  onOpenBook?: (bookId: number, at?: number) => void;
  onExit: () => void;
}

/**
 * 标题行由 readChapter 一并返回，这里从正文里去掉避免重复显示。
 * **划线的偏移量是相对这个 body 算的**，和主进程 highlight.resolve 用的是同一个口径。
 */
function bodyOf(text: string, title: string): string {
  return text.startsWith(title) ? text.slice(title.length) : text;
}

/** 一批铺多少段。够铺满几屏，又不至于卡顿——实测这个量级建节点在 20ms 内 */
/**
 * 无限下滑同时挂几章。**这是个滑动窗口，不是上限**：接满了就从视野上方卸掉几章
 * （见 `该卸几章`），所以往下读多远都行。
 *
 * 12 是按真实量级挑的：全库 658 万章，每章中位数 **6378 字节**，
 * 21px / 每行 53 字下大约 3 屏——12 章≈36 屏，往回滚的余量够到看不出边界，
 * 而 DOM 里同时也就一千来个 `<p>`（还都带 `content-visibility: auto`）。
 */
const MAX_WINDOW = 12;

const PARA_BATCH = 600;

// 划线那四种颜色只此一份，见 `highlight-view.ts`


/**
 * 正文里的一张图。
 *
 * **加载不出来要说话。** 直接让浏览器画那个碎图标、或者干脆 `display:none`，
 * 用户看到的都是「这儿本来有东西，现在没了」——而这正是我们要修的那个毛病
 * （原来「HTML 残留」那条规则把 `<img>` 连标签带地址一起删掉）。
 *
 * `referrerPolicy="no-referrer"`：这些地址是别人网站的，**读到第几章不必告诉人家**。
 * `loading="lazy"`：一章几十张图时别一次全发出去。
 */
function BodyImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="muted" style={{ fontSize: '.8rem' }} title={src}>
        〔这张图没能加载〕
      </span>
    );
  }
  return (
    <img
      className="body-img"
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export function Reader({ bookId, bookTitle, startAt, startOffset, onOpenBook, onExit }: Props) {
  /** 每种颜色代表什么，用户自己定。见 `highlight-view.ts` 的 `use色名` */
  const 色名 = use色名();
  /** 「试着重新对上」跑着没有 / 跑完说了什么。**结果要照实说三个数**，见那个按钮 */
  const [正在对, set正在对] = useState(false);
  const [对完, set对完] = useState<string | null>(null);
  const [settings, setSettings] = useState<ReadSettings>(loadSettings);
  const [toc, setToc] = useState<TocEntry[]>([]);
  /**
   * 屏幕上挂着的那几章，**连续、按 idx 升序**。
   *
   * 「按章」和「左右翻」永远只有一章，和以前一模一样；
   * 「无限下滑」滚到底就往后接一章——**接上来不是换一章**，
   * 上面那几章仍然在 DOM 里，所以往回滚也是无缝的。
   */
  const [chapters, setChapters] = useState<ChapterText[]>([]);
  const [idx, setIdx] = useState(startAt);
  /** 正在读的那一章：底栏、进度、划线、朗读、书签全跟着它 */
  const chapter = useMemo(() => chapters.find((c) => c.idx === idx) ?? null, [chapters, idx]);
  /** 后面还有没有章可以接上来——哨兵和自动滚都要问它 */
  const tail = chapters[chapters.length - 1];
  const hasNext = !!tail && tail.idx + 1 < tail.total;
  const [tocFilter, setTocFilter] = useState('');
  /**
   * 这本书的书签。**要拿来判断「当前这章加过没有」**，所以整本都要，不是只记一个 flag。
   * **别叫 marks**——那个名字这个文件里已经被划线占着了（`core/paragraphs.ts` 的 `Mark`）。
   */
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [convert, setConvert] = useState('off');
  const [finding, setFinding] = useState(false);
  const [showHl, setShowHl] = useState(false);
  /** 设置浮层：排版类的东西设一次就不动，不该常驻在视野里占位置 */
  const [panel, setPanel] = useState(false);
  /** 设置浮层分两页：排版 / 朗读。理由写在那个浮层的注释里 */
  /** 朗读那一组常用选项。**点「朗读」弹的就是它**，见那个按钮上的注释 */
  const [ttsOpen, setTtsOpen] = useState(false);
  /** 引擎管理（导入/手填/试听/删）。它自己带一份 useTts，开之前要把这边停掉 */
  const [管引擎, set管引擎] = useState(false);
  /** 定时关闭。状态在这儿、界面在 `TtsLayer`——判据写在 `useSleepTimer` 上面 */
  const 计时 = useSleepTimer();
  const { 睡到, set睡到, 睡到Ref } = 计时;
  /**
   * **目录跟着当前章节走。**
   *
   * 不做这件事的后果在长书上很难受：这个库里最多的一本 12058 章，读到第 500 章
   * 打开目录，看到的还是第 1 章那一片——**「我在哪」这个最基本的问题，目录答不上来**。
   *
   * **是回调 ref 不是 effect**，这条踩过：跳章跳出当前窗口时（拖进度条从 399
   * 跳到 3000），effect 跑的那一刻当前章那颗按钮**还没挂上**——`tocSlice` 要等
   * 窗口挪过去的**下一次**渲染才含它，而那次渲染没有任何 effect 依赖发生变化，
   * 于是一次都不滚。回调 ref 是「按钮一挂上就调」，同窗口内跳章和窗口挪过来
   * 两种时机都盖得到。目录关着时整个面板不渲染，所以不用再判 `tocOpen`。
   *
   * `block: 'center'` 而不是 `nearest`：当前章落在中间，上下文都看得到，
   * 才知道前后还有多少。**identity 必须稳定**（`useCallback` 空依赖），
   * 否则每渲染一次都解绑重绑，等于每渲染一次滚一次。
   */
  const curTocRef = useCallback((el: HTMLButtonElement | null) => {
    el?.scrollIntoView({ block: 'center' });
  }, []);
  /** 底部拖动条拖到哪了。**拖动中只改这个数字，松手才真的跳章** */
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  /** 目录往前那一端的哨兵，见下面的 IntersectionObserver */
  const tocBack = useRef<HTMLButtonElement>(null);
  /*
   * **窄窗口默认收起目录。**
   *
   * 目录侧栏是固定 271px 的，而窗口能拖到 760（`main.ts` 的 minWidth）。
   * 实测每行字数：760 宽开着目录只有 **18 字**，关掉 31；900 是 24 / 37。
   * 这个应用自己的默认版口是 53 字——18 字一行读起来是在不停换行。
   *
   * 阈值复用 `styles.css` 里已有的那条 `@media (max-width: 900px)`：
   * 同一个宽度上两条轨也正好从竖排改横排，是同一件事的两面。
   * 只影响**打开这本书时**的初值，之后按 T 或点「目录」照旧随时开关。
   */
  /*
   * 目录**默认收起**。它现在是覆盖阅读区的浮层（见 styles.css 里 `.toc` 那段），
   * 常驻会挡住正文；参考的 legado 也是叫出来才有。
   *
   * 原来是 `window.innerWidth > 900`——那条是「挤占式侧栏」时代的补丁
   * （窄窗口下它只留 18 字一行）。改成浮层之后宽窄都不用分了。
   */
  const [tocOpen, setTocOpen] = useState(false);
  /* 目录是钉在正文栏上的抽屉、不贴着按钮开，所以它不走 `useAnchored`——
     但「开了焦点进去、关了还给那个键」这条对它一样成立，单独接一下 */
  const 目录键 = useRef<HTMLButtonElement>(null);
  const 目录层 = useRef<HTMLElement>(null);
  use浮层焦点(tocOpen, 目录键, 目录层);
  /**
   * 「屏幕上有浮层吗？有就收掉」。**返回值是「收了没有」。**
   *
   * ⚠️ 放 ref 里是有原因的：键盘那条 effect 在这个组件的**前面**，
   * 而 `只开一个` / `有浮层` 在后面几百行——写进那条 effect 的依赖数组
   * 会在**渲染时**读到还没初始化的 const，当场 TDZ 报错。
   * ref 在事件发生时才读，那时候早就赋好了。
   */
  const 收浮层 = useRef<() => boolean>(() => false);
  const [scrolling, setScrolling] = useState(false);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  /** 划线按章存。**无限下滑时屏幕上不止一章**，一个数组装不下——
   *  而滚过去的那几章上的划线不该凭空消失 */
  const [marks, setMarks] = useState<Record<number, Mark[]>>({});
  /** 进这本书时要恢复到的章内位置。**只用一次**，之后自己翻章都从头看 */
  const restoreTo = useRef<number | null>(startOffset ?? null);
  /** 翻页模式下「上一页」翻出了章首：新章要落在**最后一页**。页数得量完才知道，
   *  所以这个意图用 ref 带到下面量页数那个 effect 里去兑现 */
  const toLastPage = useRef(false);
  const [pendingScroll, setPendingScroll] = useState<number | null>(null);
  /**
   * 这一章已经铺出去多少段。
   *
   * **不能一次性全铺。** 解析再准也总有个别章特别大（这个库里 78 章超过 1MB，
   * 最大的一章 215 万字 / 4.6 万段），一次性建四万多个 React 元素和 DOM 节点
   * 实测**卡死 8 秒以上**——不是慢，是整个界面冻住。
   * 先试过 CSS 的 `content-visibility`（让浏览器跳过屏幕外的排版绘制），
   * 8.3s 只降到 7.6s，说明瓶颈根本不在排版，就在「建这么多节点」本身。
   */
  const [shownParas, setShownParas] = useState(PARA_BATCH);
  const moreRef = useRef<HTMLDivElement>(null);

  // 念完一章要不要接着念下一章——只有阅读器知道有没有下一章，所以由它来判
  const chapterRef = useRef<ChapterText | null>(null);
  chapterRef.current = chapter;
  const idxRef = useRef(idx);
  idxRef.current = idx;

  const onChapterEnd = useCallback(() => {
    // 「这一章念完就停」：**不往下翻**，并且把定时收掉（它已经生效过了）
    if (睡到Ref.current === 'chapter') { set睡到(null); return false; }
    const c = chapterRef.current;
    if (!c || idxRef.current >= c.total - 1) return false;
    // 翻过去就行——念新的这一章由「章变了」那条 effect 接手
    setIdx(idxRef.current + 1);
    return true;
  }, []);

  const tts = useTts(settings, onChapterEnd);


  const ttsStop = tts.stop;
  useEffect(() => {
    if (typeof 睡到 !== 'number') return;
    const t = setTimeout(() => { ttsStop(); set睡到(null); }, Math.max(0, 睡到 - Date.now()));
    return () => clearTimeout(t);
  }, [睡到, ttsStop]);

  /*
   * **换了一章，朗读就跟着换到这一章。**
   *
   * 用户的原话：「朗读不是什么继续，而是自动定位到本章进行读」。
   * 原来这条 effect 只认「朗读自己翻的章」（`autoNext` 计数器），
   * 手动翻章**队列一个字都不动**。当场量到的两种坏法：
   *
   * | 换章之前 | 换章之后 |
   * |---|---|
   * | 正念着第 44 章 | 屏幕到了第 43 章，**嘴里还在念第 44 章** |
   * | 暂停在第 45 章 | 主键还写着「继续」，一点就接着念第 45 章 |
   *
   * 现在两种都归到「章变了」这一件事上：
   *   - **正念着** → 念新的这一章（朗读自动翻章也走这条，`autoNext` 因此删掉了）；
   *   - **暂停着** → 把队列扔掉，主键回到「从这里开始念」——按下去念的是**眼前这一章**。
   *
   * ⚠️ **`tts.speaking` 这个判据不能省**（这条是上一版留下的，仍然成立）：
   * 没有它的话，停掉朗读之后随手拖一下进度条，应用会自己开口念起来，
   * 在线引擎还会把这一章发给第三方服务器。
   * `speakOne` 在「队列空了且 `onChapterEnd()` 返回 true」时是直接 return 的、
   * 不置 `speaking = false`，所以朗读自动翻章那条路上它一直是 true。
   */
  useEffect(() => {
    if (!chapter) return;
    if (tts.speaking) tts.speak(chapter.text);
    else if (tts.paused) tts.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter?.idx]);
  /** `chapterIdx` 不能省：无限下滑时选中的那段可能在下面**还没读到**的那一章里，
   *  按 `idx` 记会把划线记到上一章去 */
  const [pending, setPending] = useState<
    { chapterIdx: number; offset: number; length: number; text: string;
      /** 这张卡该开在哪儿（相对 `.reader-main`）。判据同下面那个 `贴着` */
      at: { top: number; 锚顶: number; left: number } } | null
  >(null);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  /**
   * 正在查看的那条带笔记的划线，**连同它该开在哪儿**。
   *
   * 原来这张卡是 `position: sticky; top: 0`，钉在正文栏**顶端**——
   * 一条写在某一段上的笔记，弹在半屏之外的地方。更糟的是它在文档流里：
   * 弹出来会把正文整体往下推，**你点的是屏幕下方的一处划线，正在读的那一段却动了**。
   *
   * 笔记是写在这句话旁边的批注，就该出现在这句话旁边。
   * `at` 是相对 `.reader-main` 的坐标，点的时候算一次。
   */
  const [openMark, setOpenMark] = useState<
    { mark: Mark; at: { top: number; 锚顶: number; left: number } } | null
  >(null);
  const mainRef = useRef<HTMLDivElement>(null);
  /**
   * 读完这本书时问一句要不要写评价。
   *
   * **读完那一刻是唯一有话想说的时候。** 原来 `reading.save` 返回的 `finished`
   * 被直接扔掉了——书悄悄标成「已读完」，然后什么都没发生。而这个应用的目标
   * 正是「别再重复翻开一本烂尾的书」，那句话只有此刻写得出来；等回到书架，
   * 想写的人得自己找到那本书、悬停、点「评价」。
   *
   * 三条不打扰的规矩：已经评过的不问、一本书一次会话只问一次、随手能关掉。
   */
  const { reviewing, setReviewing, askReview, openReview, closeReview } = useReview(bookId);

  /*
   * **三个浮层各贴各的键。** 左轨的「设置」从左边拉出来，右轨的「朗读」「评价」
   * 从右边拉出来——整段判据在 `anchor.ts` 上面。
   */
  const 左轨 = useRef<HTMLElement>(null);
  const 右轨 = useRef<HTMLDivElement>(null);
  const 设置键 = useRef<HTMLButtonElement>(null);
  const 朗读键 = useRef<HTMLButtonElement>(null);
  const 评价键 = useRef<HTMLButtonElement>(null);
  const 设置层 = useRef<HTMLDivElement>(null);
  const 朗读层 = useRef<HTMLDivElement>(null);
  const 评价层 = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * **和 `error` 不是一回事，所以不共用。** 那一格渲染时写死了「读取失败：」前缀
   * （它服务的是读正文失败那三条路），而这里要说的是「这个动作没做，原因是…」——
   * 塞进去就成了一句假话。同本文件那条「拦下来的理由要说的是真正那一样」。
   */
  const [notice, setNotice] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applySettings(settings);
    saveSettings(settings);
  }, [settings]);

  /**
   * 用户自己装的字体要挂 `@font-face` 才生效。**挂在阅读器这里而不是设置弹窗里**：
   * 原来只在设置挂载时注入，于是「装好字体 → 关掉设置 → 重开应用 → 直接读书」
   * 这条最正常的路上字体是不生效的，而且下拉里还选得到，看起来像装坏了。
   */
  useEffect(() => {
    void rpc<FontFile[]>('font.list')
      .then(applyFontFaces)
      .catch(() => {}); // 字体挂不上不该让书打不开
  }, []);

  useEffect(() => {
    rpc<TocEntry[]>('book.chapters', { bookId }).then(setToc).catch((e: Error) => setError(e.message));
  }, [bookId]);

  useEffect(() => {
    void rpc<string>('convert.get', { bookId }).then(setConvert);
  }, [bookId]);

  // 进书时把这本书的书签取回来——右轨那个图标要靠它判断「这一章加过没有」
  useEffect(() => {
    void rpc<Bookmark[]>('bookmark.list', { bookId }).then(setBookmarks).catch(() => setBookmarks([]));
  }, [bookId]);

  // 离开阅读器时把朗读停掉——不然退回书架它还在念
  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  // 阅读会话（spec §5.2）：进来开一次、离开结束一次，供「最近在读」用
  useEffect(() => {
    let sid: number | null = null;
    void rpc<{ id: number }>('session.start', { bookId }).then((s) => { sid = s.id; });
    return () => {
      if (sid !== null) void rpc('session.end', { id: sid });
    };
  }, [bookId]);

  useEffect(() => {
    // **已经铺在屏幕上的那一章不重取。** 无限下滑滚进下一章时 `idx` 会跟着变，
    // 走到这里重取一遍的话 `pendingScroll` 会把容器拉回顶部——
    // 那等于把「无缝往下读」这件事本身取消掉。
    //
    // ⚠️ 依赖里**故意没有 `chapters`**：它一变这个 effect 就重跑，而这个 effect
    // 自己在改它。要的是「idx 变的那一次渲染里，窗口是什么样」，闭包给的正是它。
    if (chapters.some((c) => c.idx === idx)) return;

    let alive = true;
    rpc<ChapterText>('chapter.read', { bookId, idx })
      .then((c) => {
        if (!alive) return;
        setChapters([c]);
        setMarks({});
        setError(null);
        setNotice(null);
        // 只有「刚进这本书」才回到上次读到的位置；之后自己翻章一律从头看。
        // 用完就清掉，否则翻回这一章又会跳到那个位置。
        //
        // **`?? 0` 不能省，而且这句话原来是空头支票**：`.reader-body` 是同一个
        // 被 React 复用的滚动容器，换章不重置 `scrollTop`。传 null 进去下面那个
        // effect 开头就 return，于是「滚到章尾按 →」是在新章的同一个像素深度上
        // 打开的——正文从中间开始，而且紧接着被滚动监听当成真实进度写进
        // `char_offset`（铁律 3 的数据）。翻页模式也靠这一下把页码归位。
        const at = restoreTo.current;
        restoreTo.current = null;
        setPendingScroll(at ?? 0);
        // 翻到哪就记到哪——断点续读靠这条。章内位置由下面的滚动监听补
        void rpc('reading.save', { bookId, chapterIdx: idx, charOffset: at ?? 0 });
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [bookId, idx]);

  // 换书、跳章、接上新的一章，都从头铺起。
  // **不变式：窗口里只有最后一章是分批铺的**，上面那几章你已经滚过去了，一定铺全了
  useEffect(() => setShownParas(PARA_BATCH), [bookId, chapters.length, chapters[0]?.idx]);

  /** 切段是纯字符串操作，marks 变了不该重切——那是每次划线都要在 215 万字上重跑一遍 */
  const flow = useMemo(
    () => chapters.map((c) => ({
      idx: c.idx, title: c.title, paras: splitParagraphs(bodyOf(c.text, c.title)),
    })),
    [chapters],
  );
  /** 正在读的那一章的段落。下面跟读高亮、恢复位置、划线全是按它算的 */
  const paragraphs = useMemo(
    () => flow.find((f) => f.idx === idx)?.paras ?? [],
    [flow, idx],
  );

  /**
   * **跟读高亮**：正在念的那一段标出来，滚出视野就带回来。
   *
   * `useTts` 的 `at` 一直算得好好的，注释就写着「用来做跟读高亮」——
   * 而在补上下面这段之前，渲染进程**一次都没读过它**。这是这个仓库最常见的一类缺陷
   * （状态算好了、界面上没人读），前面已经抓到过 `fellBack`、`finished`、
   * `bookmark.list`、建索引的 `onProgress`，这是第五个。没有它，朗读一开口用户就
   * 不知道念到哪了，手一滚更是彻底失去位置——而每个成熟阅读器都跟读高亮。
   *
   * **坐标系要换算**：`tts.speak()` 喂的是整章原文（含标题，所以标题也会被念到），
   * 而段落的 `data-offset` 是相对**去掉标题的正文**算的。差的就是被 `bodyOf`
   * 摘掉的那一截，不减掉的话高亮会整体偏后一段。
   */
  const speakingOffset = useMemo(
    () => (tts.at && chapter
      ? speakingParagraph(paragraphs, tts.at.from, chapter.text, chapter.title)
      : null),
    [tts.at, chapter, paragraphs],
  );

  useEffect(() => {
    if (speakingOffset === null) return;
    const box = bodyRef.current;
    if (!box) return;
    // 长章是分批铺的，念过了当前这批就先补一批，否则那个 <p> 根本不存在
    const i = paragraphs.findIndex((p) => p.offset === speakingOffset);
    if (i >= shownParas) {
      setShownParas(Math.min(paragraphs.length, i + PARA_BATCH));
      return;
    }
    // 翻页模式是 transform 横向位移，scrollIntoView 在它上面不成立——
    // 那边只高亮不跟随。高亮本身两种模式都在
    if (settings.mode === 'page') return;
    const el = box.querySelector<HTMLElement>(`p[data-offset="${speakingOffset}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    // **只在它跑出视野时才滚**。每段都滚的话，用户想往前翻看一眼都会被拽回来
    if (r.top < b.top + 8 || r.bottom > b.bottom - 8) {
      el.scrollIntoView({ block: 'center', behavior: 滚动方式() });
    }
  }, [speakingOffset, shownParas, paragraphs, settings.mode]);

  /**
   * 滚到底就多铺一批。哨兵进视口即触发，和书架的无限滚动同一套。
   *
   * 翻页模式下 IntersectionObserver 不可靠（内容是被 transform 横向移走的，
   * 哨兵可能一直"在视口里"或一直不在），所以那边改看页码：翻到倒数第二页就续。
   */
  /** 窗口里最后那一章有多少段——哨兵盯的是它，不是「正在读的那一章」 */
  const tailParas = flow[flow.length - 1]?.paras.length ?? 0;

  /**
   * 无限下滑：把下一章接到窗口末尾。
   *
   * **`appending` 那个闸不能省**：IntersectionObserver 在一次滚动里会连着触发好几次，
   * 不挡的话一口气发出去十几个 `chapter.read`，接回来的顺序还不保证。
   */
  /**
   * 窗口满了要从**视野上方很远的地方**卸掉几章，不是停下来不接了。
   *
   * 真实库量的：每章中位数 **6378 字节**，21px / 每行 53 字下大约 **3 屏**。
   * 所以「最多挂 N 章」就是「读到第 N 章之后再也接不下去」——屏幕上还挂着
   * 「下一章…」而它永远不会来。那是个死胡同，不是省事。
   *
   * **只卸整章都在视野上方 400px 以外的**：卸到视野里等于当场把正文抽走。
   */
  const 该卸几章 = (box: HTMLElement, want: number) => {
    if (want <= 0) return 0;
    const arts = [...box.querySelectorAll<HTMLElement>('article[data-chapter]')];
    let drop = 0;
    while (drop < want && drop < arts.length - 1) {
      const a = arts[drop];
      if (a.offsetTop - box.offsetTop + a.offsetHeight > box.scrollTop - 400) break;
      drop++;
    }
    return drop;
  };

  /**
   * 卸完之后把正文放回原处。
   *
   * **记的是「顶上那一章 + 离视野顶多远」，不是「卸掉了多少像素」。**
   * 后者第一版就写错了：一次滚动里连着卸两回，两笔高度对不上，
   * 正文当场往回蹿了半屏（走查报的是「卸前 第10章/深27 → 卸后 第9章/深607」）。
   * 按锚点写是**幂等**的——多应用一次也还是同一个位置。
   *
   * ⚠️ **必须在 `useLayoutEffect` 里做，不能用 `requestAnimationFrame`**：
   * 窗口不在前台时 Chromium 不产帧，rAF 压根不跑（和 IO、scroll 哑掉同一个原因），
   * 那时候正文会当场蹿掉一段，而且**只在后台窗口里蹿**，是最难查的那种。
   */
  const anchorRef = useRef<{ idx: number; delta: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) return;
    anchorRef.current = null;
    const box = bodyRef.current;
    const el = box?.querySelector<HTMLElement>(`article[data-chapter="${a.idx}"]`);
    if (box && el) box.scrollTop = el.offsetTop - box.offsetTop + a.delta;
  }, [chapters]);

  /** 顶上露出来的那一章 + 已经读进去多深。卸章前记下它，卸完照着放回去 */
  const 当前锚点 = (box: HTMLElement) => {
    const arts = [...box.querySelectorAll<HTMLElement>('article[data-chapter]')];
    const top = box.scrollTop + ANCHOR_SLACK_PX;
    const a = arts.findLast((x) => x.offsetTop - box.offsetTop <= top) ?? arts[0];
    return a ? { idx: Number(a.dataset.chapter), delta: box.scrollTop - (a.offsetTop - box.offsetTop) } : null;
  };

  const appending = useRef(false);
  const appendNext = useCallback(async () => {
    if (appending.current) return;
    const last = chapters[chapters.length - 1];
    if (!last || last.idx + 1 >= last.total) return;
    appending.current = true;
    try {
      const c = await rpc<ChapterText>('chapter.read', { bookId, idx: last.idx + 1 });
      const box = bodyRef.current;
      const drop = box ? 该卸几章(box, chapters.length + 1 - MAX_WINDOW) : 0;
      if (drop > 0 && box) anchorRef.current = 当前锚点(box);
      // 期间窗口要是被重置过（跳章、换书），这一章就不属于这儿了
      setChapters((cs) => (cs[cs.length - 1]?.idx === last.idx ? [...cs.slice(drop), c] : cs));
    } catch {
      // 取不到就算了，下次滚到底再试。这里报错只会在正文中间插一句吓人的话
    } finally {
      appending.current = false;
    }
  }, [bookId, chapters]);

  /**
   * 无限下滑接下一章有**两条**触发路径，缺一条都读不下去：
   *
   * 1. **快滚到底了** —— 在下面那个滚动监听里，正常读下去走的就是这条；
   * 2. **这一章填不满一屏**（这个 effect）—— 那时候容器根本没得滚，
   *    一个 scroll 事件都不会有，只靠第 1 条的话短章节会**卡死在「下一章…」上**。
   *    真实书库里这种章节成片地有（章节体检报的「1489 章不到 200 字节」就是它们）。
   *
   * ⚠️ **不能只挂 `IntersectionObserver`**（第一版就是）：它要浏览器在产帧，
   * 而窗口不在前台时 Chromium 会把这件事整个停掉——实测挂一个同样 root、
   * 同样 rootMargin 的对照观察器，1.5 秒里**触发 0 次**。
   * 那条路在真机上好使、在走查里永远不响，等于这个功能没有守卫。
   *
   * `MAX_WINDOW` 是个安全绳而不是策略：真按到它，说明这本书被切碎成了
   * 几十个填不满一屏的片段，那是章节规则的毛病，该去「章节怎么切」里修，
   * 不该由阅读器一路把整本书拉进 DOM。
   */
  useEffect(() => {
    if (settings.mode !== 'flow' || !hasNext) return;
    if (shownParas < tailParas) return;               // 这一章还没铺完，先铺完
    const box = bodyRef.current;
    if (!box || box.scrollHeight > box.clientHeight + 40) return;  // 有得滚，交给滚动那条
    void appendNext();
  }, [settings.mode, hasNext, shownParas, tailParas, chapters, appendNext]);

  useEffect(() => {
    if (settings.mode === 'page') return;
    const el = moreRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => { if (es[0]?.isIntersecting && shownParas < tailParas) setShownParas((n) => n + PARA_BATCH); },
      { root: bodyRef.current, rootMargin: '800px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shownParas, tailParas, settings.mode, chapters]);

  useEffect(() => {
    if (settings.mode !== 'page') return;
    if (shownParas < paragraphs.length && page >= pages - 2) setShownParas((n) => n + PARA_BATCH);
  }, [page, pages, shownParas, paragraphs.length, settings.mode]);

  /**
   * 恢复到上次读到的段落。
   *
   * **进度只精确到章是不够的**：这个库里最长的「一章」有 2596 万字节
   * （那本书章节没切开，整本算一章），回到章首等于进度全丢。
   * 段落上带着 `data-offset`，直接按它定位。
   */
  useEffect(() => {
    if (pendingScroll === null || !chapter) return;
    const box = bodyRef.current;
    if (!box) return;
    // **0 = 回到章首，不是「回到第一段」。** 第一段上面还有 `<h2>` 章节标题
    // （70px），按段落定位会把它顶出视野——**翻开一章看不见自己在读第几章**，
    // 而正文区是唯一写着章节名的地方（底栏只有序号、目录还未必开着）。
    // 实测：新开一本书 scrollTop 停在 605，正文从第 6 段开始。
    if (pendingScroll === 0) {
      if (settings.mode === 'page') setPage(0); else box.scrollTo({ top: 0 });
      setPendingScroll(null);
      return;
    }
    // 划线的 offset 是「段起点 + 段内字符数」，不是段落对齐的——选中的句子只要
    // 不是从段首开始，精确匹配（下面这行原来的写法）必然落空，退化到「第一个
    // offset ≥ 它」的段落就是跳到下一段去了，正好落在划线句子后面。
    // 改成找「最后一个 offset ≤ 它」的段落：精确命中时就是它自己，命中不了时落回
    // 划线所在的那一段（章节重切对不上时宁可落前一段也别跳过正文）
    // **只在这一章里面找。** 无限下滑时屏幕上不止一章，而 `data-offset` 是
    // **章内**偏移——不圈住范围的话，几章的偏移混在一起，`findLast` 会挑到
    // 后面某一章里一个数值碰巧更大的段落，正文当场跳到别处去
    const art = box.querySelector<HTMLElement>(`article[data-chapter="${idx}"]`) ?? box;
    const target = [...art.querySelectorAll<HTMLElement>('p[data-offset]')].findLast(
      (el) => Number(el.dataset.offset) <= pendingScroll,
    ) ?? art.querySelector<HTMLElement>('p[data-offset]');

    if (settings.mode === 'page') {
      // 翻页模式是 CSS 多列，「位置」是第几列。offsetLeft 除以列宽就是页码
      const textEl = textRef.current;
      setPage(target && textEl ? Math.floor(target.offsetLeft / pageStride(textEl)) : 0);
    } else {
      box.scrollTo({ top: target ? target.offsetTop - box.offsetTop - 8 : 0 });
    }
    setPendingScroll(null);
  }, [pendingScroll, chapter, idx, settings.mode]);

  /**
   * 记住章内位置。**节流到停下来才存**——滚动事件每帧都来，
   * 每帧写一次库在 8000 本的库上是实打实的负担。
   *
   * 顺带判「读到最后一章的最底下」= 读完了。只看章号不行：
   * 从目录跳到最后一章看一眼就被判读完，那本书会从「在读」里消失。
   */
  useEffect(() => {
    const box = bodyRef.current;
    if (!box || !chapter || settings.mode === 'page') return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      // **接下一章不等那 700ms 的节流**：那个节流是给写库用的，
      // 而这一下要赶在用户真滚到底之前，不然章节交界处会顿一下
      if (settings.mode === 'flow'
        && box.scrollHeight - box.scrollTop - box.clientHeight < 1200) void appendRef.current();
      clearTimeout(timer);
      timer = setTimeout(() => {
        // 「顶上是哪一段」和「到底了吗」两条判据都在 `core/reading-pos.ts`，
        // 和翻页模式共用同一份——这两件事以前在两个 effect 里各写了一遍
        const top = box.scrollTop + ANCHOR_SLACK_PX;
        // **「现在读到哪一章」得先认出来。** 无限下滑时屏幕上挂着好几章，
        // `idx` 不再等于「屏幕上那一章」——顶上露出来的那一章才是。
        // 认不出来的话，滚进下一章之后进度还记在上一章上，
        // 下次打开退回去一整章（铁律 3 的数据）。
        const arts = [...box.querySelectorAll<HTMLElement>('article[data-chapter]')];
        const art = arts.findLast((a) => a.offsetTop - box.offsetTop <= top) ?? arts[0];
        if (!art) return;
        const ci = Number(art.dataset.chapter);
        const offset = anchorOffset(
          [...art.querySelectorAll<HTMLElement>('p[data-offset]')].map((el) => ({
            offset: Number(el.dataset.offset),
            pos: el.offsetTop - box.offsetTop,
          })),
          top,
        );
        // 滚进下一章就把它记成「正在读的那一章」。**这一下不会重新取章**：
        // 取章那个 effect 开头就挡住了已经在窗口里的
        if (ci !== idx) setIdx(ci);
        const atEnd = atEndScrolling(box.scrollTop, box.clientHeight, box.scrollHeight);
        void rpc<{ finished: boolean }>('reading.save', { bookId, chapterIdx: ci, charOffset: offset, atEnd })
          .then((r) => r.finished && askReview());
      }, 700);
    };

    box.addEventListener('scroll', onScroll, { passive: true });
    return () => { box.removeEventListener('scroll', onScroll); clearTimeout(timer); };
  }, [bookId, idx, chapter, settings.mode]);

  /**
   * ⚠️ **接下一章走 ref，不走依赖。**
   *
   * 第一版把 `appendNext` 和 `chapters` 写进了上面那个 effect 的依赖，于是
   * **每接一章就把滚动监听重建一次**——而它的清理里有 `clearTimeout(timer)`，
   * 把那 700ms 还没落地的进度连着掐掉了。症状是一路滚下去底栏一直写「第 1 章」、
   * 库里的 `chapter_idx` 纹丝不动，**看起来像章号认不出来，其实是根本没写成**。
   * 而那是铁律 3 的数据。
   */
  const appendRef = useRef(appendNext);
  useEffect(() => { appendRef.current = appendNext; }, [appendNext]);

  /**
   * 翻页模式的进度记录。
   *
   * 上面那个监听 scroll 的 effect 在翻页模式下直接 return——翻页靠 transform 位移，
   * 根本不触发 scroll 事件。**结果是翻页模式下章内位置从来不存、
   * 「读完」也永远不会自动标**，两个功能在这个模式下等于不存在。
   */
  useEffect(() => {
    const box = bodyRef.current;
    if (!box || !chapter || settings.mode !== 'page') return;

    const t = setTimeout(() => {
      const textEl = textRef.current;
      if (!textEl) return;
      const stride = pageStride(textEl);
      // 当前这一页第一个露出来的段落。判据和滚动模式是同一条——
      // 只是「位置」在这里是「第几页」而不是「多少像素」
      const offset = anchorOffset(
        [...box.querySelectorAll<HTMLElement>('p[data-offset]')].map((el) => ({
          offset: Number(el.dataset.offset),
          pos: Math.floor(el.offsetLeft / stride),
        })),
        page,
      );
      // ⚠️ **这个 effect 在刚打开章节时也会跑一次**（page = 0）——
      // `atEndPaging` 里那条 `page > 0` 就是为它设的，理由写在那个函数上面，
      // `reading-pos.test.ts` 钉着
      void rpc<{ finished: boolean }>('reading.save', {
        bookId, chapterIdx: idx, charOffset: offset, atEnd: atEndPaging(page, pages),
      }).then((r) => r.finished && askReview());
    }, 400);
    return () => clearTimeout(t);
  }, [bookId, idx, page, pages, chapter, settings.mode]);

  /** 把某一章滚进视野（无限下滑时它可能已经铺在屏幕上了） */
  const scrollToChapter = useCallback((n: number) => {
    const box = bodyRef.current;
    const el = box?.querySelector<HTMLElement>(`article[data-chapter="${n}"]`);
    if (box && el) box.scrollTo({ top: el.offsetTop - box.offsetTop });
  }, []);

  const go = useCallback(
    (to: number) => {
      if (chapter && (to < 0 || to >= chapter.total)) return;
      // 无限下滑：要去的那一章已经铺好了，滚过去就是了。
      // 重新取一遍会把窗口砍成一章，下面已经铺好的全丢掉
      if (chapters.some((c) => c.idx === to)) scrollToChapter(to);
      setIdx(to);
    },
    [chapter, chapters, scrollToChapter],
  );

  // 快捷键（spec §6，绑定可自定义）。输入框里打字时不拦截，
  // 否则在目录搜索框里按空格会触发自动滚动
  useEffect(() => {
    const keys = loadKeys();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      /*
       * **Esc 关掉最上面那一层浮层；一层都没有的时候才是「退出阅读器」。**
       *
       * ⚠️ 原来这儿只特判了**评价卡片和目录**两处，别的浮层——设置、朗读、
       * 书内搜索、书签划线、划过那一段的卡片——开着的时候按 Esc 会一路落到
       * `actionFor` 的 `exit`，**直接退回书架**。实测：开着设置按一下 Esc，
       * `.reader` 就没了。而上面那段注释当时已经写着「Esc 先关最上面那一层」——
       * **注释是对的，代码没做到**，于是它自己成了一条假判据。
       *
       * 收哪些、怎么收，全交给 `只开一个`（它知道关评价要走 `closeReview`：
       * 那句短评是用户打的字，直接扔掉就是丢数据）。
       *
       * 放在下面那个「输入框里不拦」之前是有意的：**正在输入框里打字
       * 恰恰是最可能按 Esc 的时刻**（目录带搜索框、评价卡是个文本域），
       * 被那句 return 挡掉的话 Esc 什么都不做。
       * 只认 `Escape` 本身，不走 `actionFor`——退出键可以改绑成普通字母，
       * 那时候在短评框里打那个字母不该把卡片关掉。
       */
      if (e.key === 'Escape' && 收浮层.current()) {
        e.preventDefault();
        return;
      }
      if (
        t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
        t.tagName === 'TEXTAREA' || t.isContentEditable
      ) return;

      switch (actionFor(keys, e.key)) {
        case 'prev': e.preventDefault(); turn(-1); break;
        case 'next': e.preventDefault(); turn(1); break;
        case 'exit': onExit(); break;
        case 'toc': 切换('目录'); break;
        case 'search': e.preventDefault(); 切换('搜索'); break;
        case 'bookmark': void toggleBookmark(); break;
        case 'autoScroll': e.preventDefault(); setScrolling((v) => !v); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** 加书签。快捷键和按钮共用这一处 */
  /**
   * 把笔记摆到这条划线**底下**。
   *
   * ⚠️ **挂在 `.reader-main` 上，不在 `.reader-body` 里面。**
   * 翻页模式下 `.reader-body` 带着 `clip-path`，会连着裁掉所有后代——
   * 书内搜索当年就栽在这上面（本文件那条）。所以坐标算成相对 `.reader-main` 的，
   * 卡片也渲染在那一层。
   *
   * ⚠️ 代价是它**不跟着滚**（`.reader-main` 不是滚动容器）。所以正文一滚就把它收掉，
   * 见下面那个 effect——**一张停在原地的批注比没有更糟**：它会指着另一句话。
   */
  const 贴着 = useCallback((R: DOMRect) => {
    const main = mainRef.current;
    if (!main) return null;
    const M = main.getBoundingClientRect();
    /*
     * ⚠️ **左边要夹一下。** 划线落在正文右侧时，一张 24rem 的卡从那儿往右摆
     * 会直接跑出窗口——那正是 `audit.mjs` 会报的「元素跑出视口」。
     * 宽度和 `.note-pop` 的 `max-width` 对齐；夹不下就顶着右边沿。
     */
    const 宽 = Math.min(24 * 16, M.width * 0.6);
    const 左 = Math.max(8, Math.min(R.left - M.left, M.width - 宽 - 8));
    // `锚顶` 留给下面那个 `贴住`：底下放不下时要翻到划线/选区**上面**去
    return { top: R.bottom - M.top + 6, 锚顶: R.top - M.top, left: 左 };
  }, []);

  /**
   * **底下放不下就翻到上面去。**
   *
   * 坐标是点的那一刻算的，而**那时候卡片还没渲染、量不到它多高**。
   * 所以夹取放在挂载之后：ref 回调里量一次，超出容器下沿就翻上去。
   * 不做的话 760×520 上选中屏幕下半部分的句子，卡片直接掉出屏幕
   * （当场量到 `跑出下边: true`）——那正是 `audit.mjs` 会报的「元素跑出视口」。
   */
  const 贴住 = useCallback((el: HTMLDivElement | null) => {
    const main = mainRef.current;
    if (!el || !main) return;
    const M = main.getBoundingClientRect();
    const R = el.getBoundingClientRect();
    if (R.bottom <= M.bottom - 8) return;
    const 锚顶 = Number(el.dataset.anchorTop ?? 0);
    el.style.top = `${Math.max(8, 锚顶 - R.height - 6)}px`;
  }, []);
  const 摆笔记 = useCallback((mark: Mark, el: HTMLElement) => {
    const at = 贴着(el.getBoundingClientRect());
    if (at) setOpenMark({ mark, at });
  }, [贴着]);

  const reloadMarks = useCallback(async (n?: number) => {
    const ci = n ?? idx;
    const list = await rpc<Mark[]>('highlight.resolve', { bookId, chapterIdx: ci });
    setMarks((m) => ({ ...m, [ci]: list }));
  }, [bookId, idx]);

  /**
   * 划线 + 一句笔记，一起存下来。**回车和「记下来」那个键走的是这一份**——
   * 原来只有回车那条路，逻辑整个内联在 `onKeyDown` 里，加个键就得抄一遍。
   */
  const 记下来 = useCallback(async () => {
    if (!pending || !noteDraft?.trim()) return;
    await rpc('highlight.add', {
      bookId, chapterIdx: pending.chapterIdx,
      charOffset: pending.offset, length: pending.length,
      excerpt: pending.text, note: noteDraft,
    });
    setNoteDraft(null);
    setPending(null);
    window.getSelection()?.removeAllRanges();
    await reloadMarks(pending.chapterIdx);
  }, [pending, noteDraft, bookId, reloadMarks]);

  /**
   * 窗口里每一章都要把划线核对一遍（`highlight.resolve` 会说它漂没漂）。
   *
   * ⚠️ 依赖里**故意没有 `marks`**：它一变这个 effect 就重跑，而这个 effect 自己在改它。
   * 窗口重置时 `marks` 会被清空（取章那处），所以重新解析过的书也会重新核对。
   */
  useEffect(() => {
    for (const c of chapters) {
      if (marks[c.idx]) continue;
      void rpc<Mark[]>('highlight.resolve', { bookId, chapterIdx: c.idx })
        .then((list) => setMarks((m) => ({ ...m, [c.idx]: list })))
        .catch(() => setMarks((m) => ({ ...m, [c.idx]: [] })));
    }
  }, [chapters, bookId]);

  /**
   * 把 DOM 选区换算成章内字符偏移。
   * 每个 <p> 上挂了 data-offset，就是它在 body 里的起点——
   * 渲染时扔掉了空行和缩进，光靠 DOM 顺序累加会越算越偏。
   */
  const captureSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setPending(null); return; }

    const text = sel.toString();
    if (!text.trim()) { setPending(null); return; }

    const anchor = sel.anchorNode;
    const el = (anchor?.nodeType === 3 ? anchor.parentElement : (anchor as HTMLElement | null))
      ?.closest('[data-offset]') as HTMLElement | null;
    if (!el) { setPending(null); return; }

    const art = el.closest('article[data-chapter]') as HTMLElement | null;
    if (!art) { setPending(null); return; }

    const paraStart = Number(el.dataset.offset);
    // 选区起点在这一段里的位置：拿这一段的全部文字去找
    const within = (el.textContent ?? '').indexOf(text);
    if (within < 0) { setPending(null); return; }

    /*
     * ⚠️ **这张卡也要贴着刚选中的那句话开。**
     *
     * 它原来和笔记卡一样是 `position: sticky; top: 0`：你在半屏以下选了一句话，
     * 「划线 / 划线并写笔记」却弹在正文栏**顶端**；而且它在文档流里，
     * 弹出来还把正文整体往下推——**刚选中的那句话自己动了**。
     * 选区的矩形直接问 `Range` 要（跨行选区给的是并集，够用）。
     */
    const at = 贴着(sel.getRangeAt(0).getBoundingClientRect());
    if (!at) { setPending(null); return; }
    setPending({ chapterIdx: Number(art.dataset.chapter), offset: paraStart + within, length: text.length, text, at });
  }, [贴着]);

  /**
   * 加/撤书签。**这是一个开关，不是一个「再加一个」的按钮。**
   *
   * 原来点一下就 `bookmark.add`，图标亮 1.5 秒又灭——那个亮只是「刚才点过」，
   * 不是「这一章有书签」。于是两件事同时成立：
   *   - 看不出当前章有没有加过，
   *   - 不确定就再点一下，于是**同一章存进两条一模一样的书签**。
   * 而书签是铁律 3 的不可再生数据，重扫恢复不了，只能靠用户自己去删。
   *
   * 现在按章去重：这一章已经有书签就撤掉，没有就加。图标反映的是真实状态。
   */
  const toggleBookmark = useCallback(async () => {
    const here = bookmarks.find((m) => m.chapter_idx === idx);
    if (here) {
      /*
       * **不带 `confirmed`**：这一路是个快捷键，屏幕上一个字都不显示，
       * 而书签的笔记是铁律 3 的数据。带笔记的会被 `removeBookmark` 拦下来，
       * 那句话说清了去哪儿删——比无声删掉好。
       */
      try {
        setNotice(null);
        await rpc('bookmark.remove', { id: here.id });
      } catch (e) {
        setNotice((e as Error).message);
        return;
      }
    } else {
      await rpc('bookmark.add', {
        bookId,
        chapterIdx: idx,
        excerpt: chapter?.text.slice(chapter.title.length).trim().slice(0, 40),
      });
    }
    setBookmarks(await rpc<Bookmark[]>('bookmark.list', { bookId }));
  }, [bookId, idx, chapter, bookmarks]);

  /** 一「页」的位移量 = 容器宽 + 列间距（styles.css 里的 4rem） */
  /**
   * 一页到下一页的位移 = **一列的宽度 + 列间隙**。
   *
   * 原来写的是 `box.clientWidth + 64`，两处都错：
   *   - `clientWidth` **包含 padding**，而左右翻页模式的 padding 正是用来把内容盒
   *     收成一列宽的，所以它比一列宽出两倍 padding（实测 914 vs 684）；
   *   - 间隙硬编码 64，改了 `column-gap` 就对不上。
   * 位移比列距大 230px 的后果是每翻一页都多走一截：越翻越错位，还会跳过内容。
   *
   * 现在直接量文本元素（它就是一列宽）和它自己的 column-gap。
   */
  const pageStride = (el: HTMLElement) => {
    const gap = Number.parseFloat(getComputedStyle(el).columnGap);
    return el.offsetWidth + (Number.isFinite(gap) ? gap : 64);
  };

  // 左右翻页：一页就是 CSS 多列里的一列，靠位移换页。
  // 不自己按行高算分页——字号行距一变就得重算，而多列由浏览器负责
  useEffect(() => {
    if (settings.mode !== 'page' || !chapter) return;
    const el = textRef.current;
    const box = bodyRef.current;
    if (!el || !box) return;
    el.style.transform = 'translateX(0)';
    const n = Math.max(1, Math.round(el.scrollWidth / pageStride(el)));
    setPages(n);
    // **原来这里无条件 `setPage(0)`，把上面「恢复位置」那个 effect 刚算好的页码
    // 又抹回第一页**——它跑在这之前，同一次提交里后写的赢。于是翻页模式下
    // 「回到上次读到的地方」和「上一页翻回上一章的最后一页」两件事都不生效。
    // 现在页码归零由那个 effect 负责（换章时 pendingScroll 一定会被设成 0），
    // 这里只管两件它管不了的：翻到章首往回翻，和字号变了页数缩水要夹住。
    if (toLastPage.current) { toLastPage.current = false; setPage(n - 1); }
    else setPage((p) => Math.min(p, n - 1));
  }, [settings.mode, settings.size, settings.line, chapter]);

  useEffect(() => {
    if (settings.mode !== 'page') return;
    const el = textRef.current;
    const box = bodyRef.current;
    if (el && box) el.style.transform = `translateX(-${page * pageStride(el)}px)`;
  }, [page, settings.mode]);

  /**
   * 翻页：滚动模式下直接换章；翻页模式下先在章内翻，翻到头再换章。
   * 这样同一个按键在两种模式下的行为都符合直觉。
   */
  const turn = useCallback(
    (dir: 1 | -1) => {
      if (settings.mode === 'page') {
        const next = page + dir;
        if (next >= 0 && next < pages) {
          setPage(next);
          return;
        }
        // **往前翻出章首要落在上一章的最后一页。** 原来这里直接 `go(idx - 1)`，
        // 而换章会把页码归零——用户要的是「章首前面那一页」，拿到的是上一章的
        // 第一页，**中间整章被跳过**。于是翻页模式下根本没法往回读。
        if (dir === -1 && idx > 0) toLastPage.current = true;
      }
      go(idx + dir);
    },
    [settings.mode, page, pages, go, idx],
  );

  /**
   * 翻页模式下用滚轮翻页。
   *
   * 这个模式的容器是 `overflow: hidden`（内容靠 transform 横向位移），
   * 所以**滚轮原来什么都不发生**——用户下意识滚一下、页面纹丝不动，
   * 会以为程序卡了。主流阅读器里滚轮就是翻页。
   * 滚动模式不接管：那边滚轮本来就该滚，抢过来反而坏了。
   */
  const wheelAt = useRef(0);
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (settings.mode !== 'page' || e.deltaY === 0) return;
      // 触控板一次手势会连发几十个 wheel 事件，不节流会一口气翻十几页
      const now = e.timeStamp;
      if (now - wheelAt.current < 220) return;
      wheelAt.current = now;
      turn(e.deltaY > 0 ? 1 : -1);
    },
    [settings.mode, turn],
  );

  /**
   * 点正文左右两侧翻页（翻页模式）。中间那条竖带不翻，留给选中文字。
   *
   * **有选中就不翻**：划线是先选后弹菜单，选完松手那一下如果顺手翻了页，
   * 划线功能等于没法用。
   */
  const onBodyClick = useCallback(
    (e: React.MouseEvent) => {
      /*
       * **开着浮层的时候，点正文是「收起浮层」，不翻页。**
       *
       * 浮层挂在 `.reader-main` 上、不在 `.reader-body` 里，所以点在浮层自己
       * 身上不会走到这儿——这一下点的是正文，意思是「不看那个面板了」。
       * 顺手翻一页是最糟的一种反应：面板还开着，书却往前跳了一页。
       *
       * **排在模式判断前面**：滚动那两档下面那句 return 会直接吃掉这次点击，
       * 而「点一下空白处把面板收起来」在三档里都该成立。
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
      if (!window.getSelection()?.isCollapsed) return;
      if (收浮层.current()) return;
      if (settings.mode !== 'page') return;
      // 点在按钮、卡片这些交互元素上时不翻页
      if ((e.target as HTMLElement).closest('button, input, a, .card')) return;
      const box = bodyRef.current;
      if (!box) return;
      // 那两条带子多宽由 `点到哪边` 说了算——查看器那两处也用同一份
      const 边 = 点到哪边(e.clientX - box.getBoundingClientRect().left, box.clientWidth);
      if (边 !== 0) turn(边);
    },
    [settings.mode, turn],
  );

  // 自动滚动（spec §6）。只在滚动模式下有意义
  useEffect(() => {
    if (!scrolling || settings.mode === 'page') return;
    const box = bodyRef.current;
    if (!box) return;

    let raf = 0;
    let last = performance.now();
    const step = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      box.scrollTop += settings.autoScroll * dt;
      // 滚到底自动进下一章——不然还要手动接一下，等于没解放双手
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) {
        // 无限下滑：下一章还在路上，等它接上来接着滚。
        // 这里要是照旧 `setScrolling(false)`，自动滚会在每个章节交界处停一次——
        // 而「无限下滑 + 自动滚」正是最该一路到底的那个组合
        if (settings.mode === 'flow' && hasNext) {
          raf = requestAnimationFrame(step);
          return;
        }
        setScrolling(false);
        go(idx + 1);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [scrolling, settings.autoScroll, settings.mode, go, idx, hasNext]);

  useEffect(() => setPage(0), [idx]);

  /*
   * **正文一动就把笔记收掉。**
   *
   * 那张卡贴着划线的坐标开，而它挂在不滚动的那一层上——不收的话，
   * 滚两行它就**指着另一句话**了，而它看起来仍然像是那句话的批注。
   * 换章同理（`idx` 变了，那条划线已经不在屏幕上）。
   */
  useEffect(() => {
    const 要收笔记 = !!openMark;
    /*
     * ⚠️ **正在写笔记的时候不收。** 那张卡里有个打了一半的输入框，
     * 滚一下就把它连同字一起收掉，是这个仓库最忌讳的那种「悄悄丢用户打的字」。
     * 还没开始写（`noteDraft === null`）才跟着滚收掉。
     */
    const 要收选区 = !!pending && noteDraft === null;
    if (!要收笔记 && !要收选区) return;
    const box = bodyRef.current;
    if (!box) return;
    const 收 = () => {
      if (要收笔记) setOpenMark(null);
      if (要收选区) setPending(null);
    };
    box.addEventListener('scroll', 收, { passive: true });
    return () => box.removeEventListener('scroll', 收);
  }, [openMark, pending, noteDraft]);
  useEffect(() => setOpenMark(null), [idx]);

  const shown = useMemo(
    () => (tocFilter ? toc.filter((c) => c.title.includes(tocFilter)) : toc),
    [toc, tocFilter],
  );

  /** 目录只铺当前位置附近的一段。全铺开在 12058 章的书上要 543 ms——
   *  其中 61 ms 建节点、482 ms 给一万两千个盒子排版（实测）。
   *  `content-visibility` 只能砍到 301 ms，不够，所以开窗口。
   *  往上是按钮、往下是哨兵，跟正文分批铺开用的是同一套做法 */
  /*
   * **目录里标出哪一章有笔记。**
   *
   * 笔记面板能从笔记找到章，反过来一直不行——翻着目录看不出自己在哪儿留过东西。
   * GoodNotes 的侧栏把有批注的页标出来就是这件事。
   *
   * ⚠️ **每次打开目录都重取，不缓存到换书为止。** 划线、书签、删笔记
   * 都会改它，而这几件事在阅读器里随时发生；缓存住的话，你刚划完线打开目录，
   * 那一章还是没记号——**看起来像功能坏了**。一次分组查询而已，
   * 回来的只有「有笔记的那几章」（判据在 `core/highlight.ts` 的 `notedChapters`）。
   */
  const [有笔记的章, set有笔记的章] = useState<Record<number, { h: number; b: number }>>({});
  useEffect(() => {
    if (!tocOpen) return;
    let 作废 = false;
    void rpc<Record<number, { h: number; b: number }>>('notes.chapters', { bookId })
      .then((r) => { if (!作废) set有笔记的章(r); })
      .catch(() => { if (!作废) set有笔记的章({}); });
    return () => { 作废 = true; };
  }, [tocOpen, bookId]);

  const TOC_WINDOW = 400;
  const [tocFrom, setTocFrom] = useState(0);
  const [tocTo, setTocTo] = useState(TOC_WINDOW);
  const tocMore = useRef<HTMLButtonElement>(null);

  /** 目录上那个记号：划线几条、有没有书签。没有就返回空串 */
  const 记号 = useCallback((i: number) => {
    const 有 = 有笔记的章[i];
    if (!有) return '';
    // 书签是「有/没有」，划线才数条数——一章里夹两个书签是常事，
    // 而「2 个书签」对找回一句话没有帮助
    return [有.h ? '划线 ' + String(有.h) : '', 有.b ? '书签' : ''].filter(Boolean).join(' · ');
  }, [有笔记的章]);

  // 换书、跳章、改筛选都把窗口挪回当前章附近
  const anchor = useMemo(() => {
    if (tocFilter) return 0;
    const at = shown.findIndex((c) => c.idx === idx);
    return at < 0 ? 0 : at;
  }, [shown, idx, tocFilter]);

  useEffect(() => {
    setTocFrom(Math.max(0, anchor - 100));
    setTocTo(Math.max(TOC_WINDOW, anchor + 300));
  }, [anchor, bookId]);

  /*
   * 换本书就把目录的搜索词清掉。
   *
   * ⚠️ **`Reader` 不会因为换书而重新挂载**（`App.tsx` 那处没给 `key`，
   * 只是换了 `bookId`），所以这类组件内的状态会**跟着串到下一本书上**。
   * 上一本书里搜的「第7章」留在框里，新书的目录一打开可能一条都不匹配——
   * 屏幕上是「没有匹配的章节」，看起来像这本书没解析出章节。
   */
  useEffect(() => { setTocFilter(''); }, [bookId]);

  /**
   * 目录**两端都自动加载**，不用人点。
   *
   * 原来往下是自动的（哨兵），**往前却是一个按钮**——「↑ 往前 400 章」。
   * 读到中间打开目录想往回翻，就得一次次点那个按钮，而滚动这个动作本身
   * 已经表达了「我要往那边看」的意思，再要一次点击是多余的。
   *
   * 往前加载会**把内容插到滚动位置上面**，正常会导致视口跳走；
   * Chromium 的滚动锚定（overflow-anchor，默认开）会补偿掉，实测不跳。
   */
  useEffect(() => {
    const box = tocMore.current?.closest('.toc-list') ?? document.querySelector('.toc-list');
    if (!box) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (e.target === tocMore.current) setTocTo((n) => Math.min(shown.length, n + TOC_WINDOW));
          if (e.target === tocBack.current) setTocFrom((n) => Math.max(0, n - TOC_WINDOW));
        }
      },
      { root: box, rootMargin: '300px' },
    );
    if (tocMore.current) io.observe(tocMore.current);
    if (tocBack.current) io.observe(tocBack.current);
    return () => io.disconnect();
  }, [tocTo, tocFrom, shown.length, tocOpen]);

  const tocSlice = useMemo(() => shown.slice(tocFrom, tocTo), [shown, tocFrom, tocTo]);

  const set = <K extends keyof ReadSettings>(k: K, v: ReadSettings[K]) =>
    setSettings((s) => ({ ...s, [k]: v }));

  /**
   * 浮层里的一行「标签 当前值 [−][＋]」。
   *
   * 排版这六项原来全在「设置 → 阅读」那一页，而**那个弹窗是从书架打开的——
   * 改版口宽的时候正文根本不在屏幕上**。这和纸色搬进阅读器是同一条判据：
   * 调完要立刻看到结果的设置，摆在能看到结果的那个界面里。
   * 字号和行距当时还在两处各有一份，改哪份都对、而其中一份看不见效果。
   *
   * 步进按钮而不是数字输入框：这是个 15rem 的浮层，而且这几项是「点一下看一眼」
   * 的调法，不是「我知道我要 47」。浮点数要 toFixed 收一下，0.1 累加会飘出 2.7000000000000002
   */
  const step = (
    label: string,
    k: 'size' | 'line' | 'width' | 'indent' | 'para' | 'pad',
    min: number, max: number, d: number, unit: string,
    /** 存的值和显示的值不一样时用它（页边距存 rem、显示 px） */
    show: (n: number) => string = String,
    /** 跟在后面的一句小字（正文栏那条要顺带说清它到底有多宽） */
    hint?: (n: number) => string,
    /**
     * 加减键上写什么。
     *
     * ⚠️ 试过给字号那一格用 `A−` / `A＋`（参考图里就是那样），**当场把标签挤没了**：
     * 两列排下来每格约 130px，两个双字符的键一占，「字号 28px」被截成「字号 28p」。
     * 而参考图里那个控件**没有文字标签**，A 是它唯一能说明「什么变大」的办法；
     * 我们旁边就写着「字号」，A 不多给一点信息，只多占一份宽度。
     * 留着这个参数是因为**这条判断值得留在代码里**，不是留着以后用。
     */
    键 = ['−', '＋'],
  ) => {
    const v = settings[k];
    const to = (n: number) => set(k, Number(Math.min(max, Math.max(min, n)).toFixed(1)));
    return (
      /*
       * ⚠️ **`nowrap` + 提示另起一行。**
       *
       * 这一排每行都是「标签　[−][＋]」，唯独「每行 53 字」后面还挂着
       * 「约 1113px」——标签一长，整行就折了，那两个键**掉到下一行**、
       * 还从右对齐变成了左对齐。一排七行里只有它是双高的，节奏当场断掉。
       * 现在提示自己占一行（它本来就是补充说明），加减键永远在右上角。
       */
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        {/* ⚠️ **`nowrap`**：两列排下来每格只有约 130px，「行距 1.8 倍」会在
            数字和单位之间折成两行——一行里只要有一格折了，整行就是双高，
            两列省下的高度当场还回去 */}
        <span className="muted" style={{ fontSize: '.8rem', minWidth: 0, whiteSpace: 'nowrap' }}>
          {label} {show(v)}{unit}
          {hint && <span style={{ opacity: 0.75, display: 'block' }}>{hint(v)}</span>}
        </span>
        <span className="row" style={{ gap: '.3rem', flex: 'none' }}>
          <button disabled={v <= min} aria-label={`${label}减小`} onClick={() => to(v - d)}>{键[0]}</button>
          <button disabled={v >= max} aria-label={`${label}增大`} onClick={() => to(v + d)}>{键[1]}</button>
        </span>
      </div>
    );
  };


  /**
   * 工具轨那几个提示里的按键，从**用户实际绑的那个**取。
   *
   * 原来是写死的「（T）」「（←）」「（B）」——恰好等于默认绑定，
   * 所以平时看不出问题；**一改绑，那句提示就在说假话**。
   * 而这几个提示是「怎么用键盘」的唯一出处（设置里那张表在另一个弹窗里）。
   * 读一次就够：改绑在设置弹窗里做，那时候阅读器不在屏幕上。
   */
  const boundKeys = useMemo(loadKeys, []);
  const 键 = (a: Action) => keyLabel(boundKeys[a][0]);

  /**
   * 阅读器里**同一时刻只留一个浮层**。
   *
   * 用户的原话：「阅读界面的 modal 应该都是互斥，同时只有一个。」
   * 原来五个各有各的 state、互不知道：目录开着还能再开设置、再开搜索，
   * 三层叠在正文上，而每一个都要自己去关。
   *
   * ⚠️ **关评价要走 `closeReview`**，不是 `setReviewing(null)`——那句话是用户
   * 打的字，直接扔掉就是丢数据（本文件那条「用户在改的东西，关掉的时候要留住」）。
   */
  const 只开一个 = useCallback((which: '目录' | '设置' | '搜索' | '书签划线' | '评价' | '朗读' | null) => {
    if (which !== '目录') setTocOpen(false);
    if (which !== '设置') setPanel(false);
    if (which !== '搜索') setFinding(false);
    if (which !== '书签划线') setShowHl(false);
    if (which !== '评价') closeReview();
    if (which !== '朗读') setTtsOpen(false);
    // 划过的那一段和点开的那条笔记也是浮在正文上的东西，一并收掉
    setPending(null);
    setNoteDraft(null);
    setOpenMark(null);
    if (which === '目录') setTocOpen(true);
    if (which === '设置') setPanel(true);
    if (which === '搜索') setFinding(true);
    if (which === '书签划线') setShowHl(true);
    if (which === '评价') openReview();
    if (which === '朗读') setTtsOpen(true);
  }, [closeReview, openReview]);

  /** 现在开着的是哪个（右轨那几个键要按它做「再点一次关掉」） */
  const 开着的 = tocOpen ? '目录' : panel ? '设置' : finding ? '搜索'
    : showHl ? '书签划线' : reviewing ? '评价' : ttsOpen ? '朗读' : null;
  const 切换 = useCallback(
    (w: '目录' | '设置' | '搜索' | '书签划线' | '评价' | '朗读') => 只开一个(开着的 === w ? null : w),
    [只开一个, 开着的],
  );
  /** 屏幕上浮着的东西：六个浮层，外加划过那一段的卡片和点开的那条书签/笔记 */
  const 有浮层 = 开着的 !== null || !!pending || !!openMark;
  收浮层.current = () => {
    if (!有浮层) return false;
    只开一个(null);
    return true;
  };

  /** 当前这一章加过书签没有。图标亮不亮、点下去是加还是撤，都看它 */
  const markedHere = bookmarks.some((m) => m.chapter_idx === idx);

  /** 右轨那个一键切换要知道现在是不是夜间。内置和自带主题的 id 都以 night 结尾 */
  /**
   * 底部那行显示的是哪一章。**拖动条正在拖的时候要显示拖到了哪**——
   * 这条设计（拖动只预览、松手才真的跳章）全部的意义就在这个预览上，
   * 而原来 `dragIdx` 只喂给了滑块自己的 `value`：手柄在动，旁边的
   * 「第 399 / 12046 章」和百分比纹丝不动。一本 12046 章的书拖一下，
   * **你根本不知道会落到哪**——那就退化成了「拖完再看，不对再拖一次」。
   */
  const footIdx = dragIdx ?? idx;
  /** 右下角的进度。章节序号算的，和书架上那个百分比同一口径 */
  /** 这一章念到哪儿了（0–100）。`tts.at.from` 是当前这一段在整章里的字符位置 */
  const 声线百分比 = chapter && tts.at && chapter.text.length > 0
    ? Math.min(100, Math.round((tts.at.from / chapter.text.length) * 100))
    : 0;
  /** 正在念的那一句，截一下——这一行只是个提示，不是正文 */
  const 正在念的那一句 = chapter && tts.at
    ? chapter.text.slice(tts.at.from, tts.at.to).trim().slice(0, 40)
    : '';

  const 设置位 = useAnchored(panel, 设置键, 设置层, 左轨, 'left-top');
  const 朗读位 = useAnchored(ttsOpen, 朗读键, 朗读层, 右轨, 'right-bottom');
  const 评价位 = useAnchored(!!reviewing, 评价键, 评价层, 右轨, 'right-bottom');

  const pct = chapter && chapter.total > 0
    ? Math.min(100, Math.round(((footIdx + 1) * 100) / chapter.total))
    : 0;

  return (
    <div className="reader">
      {tocOpen && (
      <aside className="toc" ref={目录层}>
        <TocHead
          bookTitle={bookTitle}
          filter={tocFilter}
          setFilter={setTocFilter}
          onClose={() => setTocOpen(false)}
        />
        <div className="toc-list">
          {/* 往前的哨兵。滚到这儿自动补上一段——**滚动本身就表达了「往那边看」，
              再要一次点击是多余的**。它同时也能点，理由和下面那个一样：
              窗口不可见时 Chromium 根本不算相交，IntersectionObserver 有单点失效 */}
          {tocFrom > 0 && (
            <button
              ref={tocBack}
              className="toc-more"
              onClick={() => setTocFrom((f) => Math.max(0, f - TOC_WINDOW))}
            >
              前面还有 {tocFrom} 章…
            </button>
          )}
          {tocSlice.map((c, i) => {
            const prev = i > 0 ? tocSlice[i - 1] : null;
            return (
              <div key={c.idx}>
                {c.volume && c.volume !== prev?.volume && <div className="toc-vol">{c.volume}</div>}
                <button
                  ref={c.idx === idx ? curTocRef : null}
                  className={`toc-item${c.idx < idx ? ' read' : ''}`}
                  aria-current={c.idx === idx}
                  /*
                   * ⚠️ **跳过去之后把搜索词清掉。**
                   *
                   * 不清的话它会一直留到退出阅读器。当场量的：搜「第7章」跳过去、
                   * 往后读到第 9 章，再打开目录——**45 章的目录只剩一条「第7章」**，
                   * 而「我在哪一章」连个影子都没有。原因在 `anchor` 那儿：
                   * `tocFilter` 非空时它被强制成 0，于是既不定位当前章也不滚过去。
                   * 换本书更难看：那个词一条都不匹配，目录就是「没有匹配的章节」——
                   * 看起来像这本书没有章节。
                   *
                   * **只有「跳过去」这个动作清，Esc 和「收起」不清。**
                   * 判据和这个应用已有的那条一样（评价卡片：Esc 是关掉、
                   * 「不用了」才是放弃）——**Esc 从不扔掉你做过的事，
                   * 做完了的动作才顺手收拾。** 没找到就按 Esc 走开的人，
                   * 回来还想接着搜那个词。
                   */
                  onClick={() => { go(c.idx); setTocOpen(false); setTocFilter(''); }}
                  title={记号(c.idx) ? c.title + '（' + 记号(c.idx) + '）' : c.title}
                >
                  <span className="toc-t">{c.title}</span>
                  {/* **记号要进无障碍名字，不能只是个图标。** 一个 ✎ 对读屏
                      要么被读成一串符号、要么直接没有；这一行的意思是
                      「这一章我留过东西」，那句话本身才是名字的一部分 */}
                  {记号(c.idx) && <span className="toc-mark">{记号(c.idx)}</span>}
                </button>
              </div>
            );
          })}
          {tocTo < shown.length && (
            // 既是滚到底自动加载的哨兵，也能直接点。
            // 不做成纯哨兵是因为 IntersectionObserver 有单点失效的情况——
            // 窗口不可见时 Chromium 根本不算相交，回调一次都不来
            <button
              ref={tocMore}
              className="toc-more"
              onClick={() => setTocTo((n) => n + TOC_WINDOW)}
            >
              ↓ 还有 {shown.length - tocTo} 章…
            </button>
          )}
          {shown.length === 0 && <p className="muted" style={{ padding: '.5rem .8rem' }}>没有匹配的章节</p>}
        </div>
      </aside>
      )}

      <div className="reader-main" ref={mainRef}>
        {/*
          * 左轨：图标 + 标签，竖排。原来是**一条横排里挤 15 个控件**
          * （书架/目录/上下章/书签/搜索/模式/自动/繁简/朗读/划线/主题/A±/行距），
          * 工具条比正文还显眼，而且十几个同样大小的文字按钮里找一个要扫一遍。
          *
          * 现在按「多久用一次」分三处：常驻动作在左轨，读的时候临时用一下的在右轨，
          * 排版类的收进设置浮层——那些是**设一次就不动**的。
          */}
        <nav className="reader-rail" aria-label="阅读器功能" ref={左轨}>
          <button onClick={onExit} title={`回书架（${键('exit')}）`}>{ICO.back}<span>书架</span></button>
          {/* ⚠️ **开着要看得出来，而左轨认的是 `aria-current` 不是 `.on`**
              （`.reader-rail button[aria-current="true"] { color: accent }`，
              左轨没有 `.on` 这条规则）。原来这个键两种状态**一个像素都不差**——
              当场量的：开着关着字色都是 `rgb(38,38,38)`。
              目录是最常开的浮层之一，看不出开没开就只能靠再点一次去试。 */}
          <button
            ref={目录键}
            aria-current={tocOpen}
            onClick={() => 切换('目录')}
            title={`开关目录侧栏（${键('toc')}）`}
          >{ICO.toc}<span>目录</span></button>
          <button onClick={() => go(idx - 1)} disabled={idx <= 0} title={`上一章（${键('prev')}）`}>
            {ICO.prev}<span>上一章</span>
          </button>
          <button
            onClick={() => go(idx + 1)}
            disabled={!chapter || idx >= chapter.total - 1}
            title={`下一章（${键('next')}）`}
          >
            {ICO.next}<span>下一章</span>
          </button>
          <button ref={设置键} aria-current={panel} onClick={() => 切换('设置')} title="字号、行距、主题、繁简">
            {ICO.gear}<span>设置</span>
          </button>
          <button
            onClick={() => bodyRef.current?.scrollTo({ top: 0, behavior: 滚动方式() })}
            title="回到本章开头"
          >
            {ICO.up}<span>顶部</span>
          </button>
          <button
            onClick={() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 滚动方式() })}
            title="到本章末尾"
          >
            {ICO.down}<span>底部</span>
          </button>
        </nav>

        {/* 右轨：读的时候会临时用一下的几样。**每格都写名字**，和左轨同一套——
            纯图标那版实测得挨个悬停一秒才知道是什么，而「书签划线」按钮的名字
            必须和它开出来的弹窗（「书签与划线」）对得上。
            开着的用 .on 标出来——自动滚和朗读是有状态的，看不出开没开就只能靠试 */}
        <div className="reader-tools" ref={右轨}>
          {/* 亮 = 这一章有书签。**再点一下是撤掉，不是再加一个** */}
          <button
            className={markedHere ? 'on' : ''}
            onClick={() => void toggleBookmark()}
            title={
              markedHere
                ? `这一章已加书签，点一下撤掉（${键('bookmark')}）。加过的书签在旁边「书签与划线」里看`
                : `给这一章加书签（${键('bookmark')}）。书签独立于阅读进度，在旁边「书签与划线」里看`
            }
          >
            {ICO.mark}<span>{markedHere ? '撤书签' : '加书签'}</span>
          </button>
          <button onClick={() => 切换('搜索')} title={`在这本书里搜（${键('search')}）`}>{ICO.search}<span>搜索</span></button>
          {/* 评价随时能记，不用读完。**说明里要写「读不下去」**——
              那是这个入口存在的理由，而它在按钮名字里看不出来 */}
          <button
            ref={评价键}
            className={reviewing ? 'on' : ''}
            // `.on` 是给眼睛的（右轨那条 CSS），`aria-current` 是给读屏的——
            // 右轨其余有状态的键（朗读）两样都有，这里原来只有前一样
            aria-current={!!reviewing}
            onClick={() => 切换('评价')}
            title="给这本书打分、写一句短评。读不下去了也记一句，下次在书架上就能看见"
          >
            {ICO.star}<span>评价</span>
          </button>
          {/* 说明里必须带上「书签」：书签**加**在左边那个按钮、**看**在这里，
              而原来这句只说划线——按 B 加完的人根本找不到它们去哪了 */}
          <button
            onClick={() => 切换('书签划线')}
            title="书签、划线和笔记（这本书的，以及全库带笔记的划线）"
          >
            {ICO.pen}<span>书签划线</span>
          </button>
          <button
            className={scrolling ? 'on' : ''}
            disabled={settings.mode === 'page'}
            onClick={() => setScrolling((v) => !v)}
            title="自动往下滚，读到底自动进下一章（空格）。左右翻页模式下用不上"
          >
            {ICO.auto}<span>自动滚</span>
          </button>
          {/* **点它是弹一层常用选项，不是直接开念。**
              用户的原话：「点击 tts 后应该会弹出语音选择、试听按钮、tts 编辑、
              语速、定时等常用选项」。开念的那个键在那一层里，摆在最上面。
              正在念的时候这个键仍然亮着（`.on`），一眼看得出开着 */}
          <button
            ref={朗读键}
            className={tts.speaking ? 'on' : ''}
            aria-current={开着的 === '朗读'}
            onClick={() => 切换('朗读')}
            title={
              settings.ttsEngine === 'system'
                ? '朗读：选音色、试听、语速、定时。现在用的是系统语音（离线）'
                : '朗读：选引擎、试听、语速、定时。在线引擎会把正文发到第三方服务器'
            }
          >
            {ICO.tts}<span>朗读</span>
          </button>
          {/* 一键白天/夜间。**和查看器共用一份**（`ReaderChrome.tsx`）——
              两边原来逐字节相同地各写一份，而各自的 `isNight` 都在手写 id 的拼法 */}
          <NightToggle theme={settings.theme} setTheme={(v) => set('theme', v)} />
        </div>

        {ttsOpen && (
          <div className="reader-panel" ref={朗读层} style={朗读位}>
            {/* 朗读那一整层（播放器 + 声音/节奏 + 定时）**和查看器共用一份**，
                整段判据在 `TtsLayer.tsx` 上面 */}
            <TtsLayer
              tts={tts}
              settings={settings}
              set={set}
              正文={chapter?.text ?? ''}
              onManage={() => set管引擎(true)}
              计时={计时}
            />
          </div>
        )}

        {panel && (
          <div className="reader-panel" ref={设置层} style={设置位}>
            {/*
              * 这个浮层现在只管**排版**：纸色、字号、行距、每行字数、留白、正文字体、
              * 自动滚速度。
              *
              * **朗读那一组搬出去了**，点右轨的「朗读」直接弹它自己那一层——
              * 用户的原话是「点击 tts 后应该会弹出语音选择、试听按钮、tts 编辑、
              * 语速、定时等常用选项」。塞在这个浮层的第二个页签里，等于把最常用的
              * 一组东西藏在一次额外的点击后面。
              *
              * 判据还是那条老的：**调完要立刻看到结果的设置，摆在能看到结果的
              * 那个界面里**（纸色和调色当初就是这么搬进阅读器的）。留在「设置」
              * 弹窗里的是看不到即时结果的那些：应用外观、装/卸字体、快捷键。
              */}
            {/* **纸色占满一行，而且排在最前。** 这一层里它是改得最勤的一项，
                而原来它和「顶部留白」一样是个右对齐的小下拉。
                十张纸的名字有长有短（「书斋 - 白天」「legado - 淡青」），
                挤在右半边会被截掉——占满一行既是权重也是实用 */}
            <ReadSettingsPanel
              settings={settings}
              set={set}
              能改正文
              模式={['scroll', 'flow', 'page']}
              繁简={{
                值: convert,
                改: async (m) => {
                  setConvert(m);
                  await rpc('convert.set', { bookId, mode: m });
                  // **这是第二处 setChapter，而且故意不设 pendingScroll。**
                  // 量页数那个 effect 靠「换章时 pendingScroll 一定是 0」把页码交给
                  // 恢复位置那个 effect；这条路不是换章，是同一章换个字体转换，
                  // 落到 `setPage(p => Math.min(p, n-1))` 保住当前页正是想要的。
                  // 再加 setChapter 的地方要想清楚落哪一页，别默认照抄这一处。
                  setChapters([await rpc<ChapterText>('chapter.read', { bookId, idx })]);
                },
              }}
            />
          </div>
        )}

        {/* **书内搜索挂在 `.reader-main` 上，不在 `.reader-body` 里面。**
            翻页模式下 `.reader-body` 带着 `clip-path`（裁掉左右两条给工具轨让出来
            的白边，见 styles.css），而 clip 会连着裁**所有后代**——`.find-panel`
            正是绝对定位在右边那条带子上，右侧 83px 连边框带阴影一起没了。
            其余浮层（`.reader-panel` / `.reader-rail`）本来就挂在这一层，
            把它挪上来是归位，不是绕开。 */}
        {/* **评价卡片落在正文栏右下角**，和点开它的那个键（右轨的「评价」）在一起。
            原来是 sticky 在正文**顶上**、而且是 `.reader-body` 的直接子元素——
            那一层是整个窗口宽，于是卡片从左边缘铺到右边缘，比它压着的那张纸还宽。
            挪到 `.reader-main` 这一层还有第二个理由：翻页模式下 `.reader-body`
            带着 `clip-path`，会连着裁掉所有后代（书内搜索当年就栽在这上面）。 */}
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
        {pending && (
          /* **贴着刚选中的那句话开**，不是钉在正文栏顶端——整段理由在 `贴着` 上面。
             和笔记卡同一层（`.reader-main`）：`.reader-body` 在翻页模式下带着
             `clip-path`，会连着裁掉所有后代。 */
          <div
            className="note-pop card"
            ref={贴住}
            data-anchor-top={pending.at.锚顶}
            style={{
              top: pending.at.top,
              left: pending.at.left,
              /* ⚠️ `.note-pop` 那条 CSS 是 `flex-direction: column`（笔记卡竖排），
                 这张卡要横排，得显式写回来——不写的话四个色块会竖着叠成一列 */
              flexDirection: 'row',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '.4rem',
            }}
          >
            <span className="muted" style={{ fontSize: '.8rem', maxWidth: '18rem', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
              「{pending.text}」
            </span>
            {/* **四个色块前面要有个动词。** 光四个圆点谁也看不出点下去会发生什么——
                颜色是次要的选择，「划线」才是这一行在干的事 */}
            <span style={{ fontSize: '.82rem' }}>划线</span>
            {/* **每个色块要说出它代表什么。** 原来四个 title 都是同一句
                「用这个颜色划线」——那四个圆点对读屏就是四个一模一样的按钮，
                而颜色恰恰是划线唯一的分类轴。名字用户自己定，见 `use色名` */}
            {COLORS.map((c) => (
              <button
                key={c}
                aria-label={'用「' + 色名[c] + '」划线'}
                title={色名[c]}
                onClick={() => void (async () => {
                  await rpc('highlight.add', {
                    bookId, chapterIdx: pending.chapterIdx,
                    charOffset: pending.offset, length: pending.length,
                    excerpt: pending.text, color: c,
                  });
                  setPending(null);
                  window.getSelection()?.removeAllRanges();
                  await reloadMarks(pending.chapterIdx);
                })()}
                style={{ background: 底色(c), width: '1.6rem', height: '1.6rem', padding: 0 }}
              />
            ))}
            {noteDraft === null ? (
              <button onClick={() => setNoteDraft('')}>划线并写笔记</button>
            ) : (
              <>
                <input
                  autoFocus
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="记一句：为什么划这里"
                  style={{ width: '14rem' }}
                  onKeyDown={(e) => {
                    // Escape 清空笔记草稿，退出输入
                    if (e.key === 'Escape') {
                      setNoteDraft(null);
                      return;
                    }
                    // 中文输入法选词的回车是确认候选词，不是提交
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                    // 空笔记不存
                    if (!noteDraft.trim()) return;
                    void 记下来();
                  }}
                />
                {/*
                  * ⚠️ **这个键原来没有，只能靠回车。** 那时这一排上两个键都是「不要」
                  * （不写笔记 / 取消），唯一能保存的动作没有任何可见的入口——
                  * 而**查看器那边一直有**（`FileViewer.tsx` 的「记下来」）。
                  * 两个阅读界面在同一件事上分叉，这个仓库抓到过三次。
                  */}
                <button className="primary" disabled={!noteDraft.trim()} onClick={() => void 记下来()}>
                  记下来
                </button>
                {/* **写的是它干什么，不是「算了」**：旁边那个「取消」是连划线一起不要，
                    两个都叫「算了」式的词、作用范围却不同，挨在一起最容易点错 */}
                <button onClick={() => setNoteDraft(null)}>不写笔记</button>
              </>
            )}
            <button onClick={() => { setNoteDraft(null); setPending(null); window.getSelection()?.removeAllRanges(); }}>
              取消
            </button>
          </div>
        )}

        {/*
          * 点了带笔记的划线：**笔记就开在这条划线底下**，不在正文栏顶端。
          * 删是这里一个写明白的按钮——原来点一下就把划线和笔记一起删了，
          * 而在划过的字上点一下（想看看当时写了什么）是再自然不过的动作，
          * 代价却是笔记直接消失、没有撤销。
          *
          * 卡片里**不重复那句原文**：它就在卡片上面一行，划着线。
          */}
        {openMark && (
          <div
            className="note-pop card"
            ref={贴住}
            data-anchor-top={openMark.at.锚顶}
            style={{ top: openMark.at.top, left: openMark.at.left }}
          >
            {/* 卡片里面**两个阅读界面共用一份**（`NoteCard`）：看笔记、写笔记、
                换颜色、删。往哪儿贴是这边自己的事（`贴住`），那部分不共用 */}
            <NoteCard
              笔记={openMark.mark.note}
              颜色={openMark.mark.color}
              存笔记={async (note) => {
                await rpc('highlight.setNote', { id: openMark.mark.id, note: note || null });
                setOpenMark((m) => (m ? { ...m, mark: { ...m.mark, note: note || null } } : m));
                await reloadMarks();
              }}
              改颜色={async (c) => {
                await rpc('highlight.setColor', { id: openMark.mark.id, color: c });
                setOpenMark((m) => (m ? { ...m, mark: { ...m.mark, color: c } } : m));
                await reloadMarks();
              }}
              删掉={async () => {
                await rpc('highlight.remove', { id: openMark.mark.id, confirmed: true });
                setOpenMark(null);
                await reloadMarks();
              }}
              关闭={() => setOpenMark(null)}
            />
          </div>
        )}
        {finding && (
          <FindInBook
          搜={(query) => rpc<Hit[]>('search.inBook', { bookId, query })} onJump={(c) => go(c)} onClose={() => setFinding(false)} />
        )}

        <div
          className={`reader-body${settings.mode === 'page' ? ' page-mode' : settings.mode === 'flow' ? ' flow-mode' : ''}`}
          ref={bodyRef}
          style={{ position: 'relative' }}
          onWheel={onWheel}
          onClick={onBodyClick}
        >


          {/* 读完了，问一句。**不是弹窗**——弹窗会挡住刚读完的最后一段，
              而人读完最后一句话时往往还想再看一眼 */}
          {error && <p className="danger" style={{ textAlign: 'center' }}>读取失败：{error}</p>}
          {notice && <p className="danger" style={{ textAlign: 'center' }}>{notice}</p>}
          {!chapter && !error && <p className="muted" style={{ textAlign: 'center' }}>正在读取…</p>}
          {/* 一章一张纸。「按章」和「左右翻」永远只有一张，DOM 和以前一样；
              「无限下滑」滚到底就在后面再接一张 */}
          {flow.map((f, fi) => {
            const mine = marks[f.idx] ?? [];
            // **只有最后一张是分批铺的**，上面那几张你已经滚过去了，一定铺全了
            const shown = fi === flow.length - 1 ? f.paras.slice(0, shownParas) : f.paras;
            return (
            <article
              key={f.idx}
              className="reader-text"
              data-chapter={f.idx}
              ref={f.idx === idx ? textRef : undefined}
              onMouseUp={captureSelection}
            >
              <h2>{f.title}</h2>
              {/*
                * **划线漂了要说一声。**
                *
                * `highlight.resolve` 会核对那个位置的文字还是不是当初划的那段，
                * 对不上就标 `intact: false`——`core/highlight.ts` 的注释写着
                * 「漂了不猜也不删：只标 intact，**由界面照实说明**」。
                * 而界面只拿它做了过滤（`sliceByMarks` 只画 intact 的），
                * 一个字都没说。用户看到的是自己划的那道线凭空没了，
                * 而划线是铁律 3 里重扫恢复不了的数据——最容易让人以为丢了。
                *
                * 会漂的原因都是用户自己的动作：改了章节规则重新解析、
                * 开关了正文净化、切了繁简。所以这句话要点出「正文变过」。
                */}
              {mine.some((m) => !m.intact) && (
                <p className="muted" style={{ fontSize: '.8rem', textAlign: 'center' }}>
                  这一章有 {mine.filter((m) => !m.intact).length} 条划线对不上原文了
                  （正文变过：换过章节规则、改过正文净化或繁简）。
                  没有画在正文上，免得标错地方——原文和笔记都还在「书签划线」里。
                  {/*
                    * **这句话原来到此为止**：说完就没了，笔记还在、指着哪句话没人知道。
                    * 而修它不用猜——`excerpt` 当初就是按原样存下来当锚的，
                    * 正文只是挪了位置的话，那段字多半还在这一章里。
                    * ⚠️ 「正好一处」才改，出现两次的一律不动（判据在 `core/highlight.ts`
                    * 的 `reanchor`）——**猜错了是把笔记贴到另一句话上**，
                    * 比画不出来难看得多，而且看不出来。所以这里照实报三个数。
                    */}
                  {' '}
                  <button
                    className="mini"
                    disabled={正在对}
                    onClick={() => void (async () => {
                      set正在对(true);
                      try {
                        const r = await rpc<{ fixed: number; ambiguous: number; gone: number }>(
                          'highlight.reanchor', { bookId, chapterIdx: f.idx },
                        );
                        await reloadMarks(f.idx);
                        set对完(
                          r.fixed === 0 && r.ambiguous === 0 && r.gone === 0 ? '没有需要重对的。'
                          : `对上了 ${r.fixed} 条`
                            + (r.ambiguous ? `；有 ${r.ambiguous} 条那段字在这一章出现不止一次，没敢动` : '')
                            + (r.gone ? `；有 ${r.gone} 条的原文找不到了` : '') + '。',
                        );
                      } catch (e) {
                        set对完('重对失败：' + (e as Error).message);
                      } finally {
                        set正在对(false);
                      }
                    })()}
                  >
                    {正在对 ? '正在找…' : '试着重新对上'}
                  </button>
                </p>
              )}
              {/*
                * ⚠️ **结果那句话要摆在提示外面。**
                * 它原来在上面那个 `<p>` 里，而那个 `<p>` 的条件是「还有对不上的」——
                * **全都对上了的时候整块消失，把「对上了 N 条」一起带走**：
                * 用户点完只看见划线冒出来，没有一句确认。
                * 而恰恰是这一支最需要确认：另外两支（有没敢动的、有找不到的）
                * 提示还在，消息反而留得住。探针就是这么抓到的。
                */}
              {对完 && (
                <p className="muted" style={{ fontSize: '.8rem', textAlign: 'center' }}>{对完}</p>
              )}
              {shown.map((para) => {
                /*
                 * **整段就是图的时候才当图。**
                 *
                 * 图文混在同一段（`他抬头看<img …>然后走了`）不动：划线的偏移量
                 * 是按**这一段的完整文字**算的，把标签摘掉会让后面所有划线整体前移，
                 * 画到别的句子上——而那是铁律 3 的数据。这种写法实际上没见过
                 * （扒下来的 txt 里图都自己占一行）；真撞上了，用户可以开
                 * 「正文里的图片」那条净化规则把它整个删掉。
                 * ponytail: 要支持混排就得让 `sliceByMarks` 认识「显示文本 vs 原文」
                 * 两套偏移，那是另一件事。
                 */
                const 图 = splitImages(para.text);
                if (图.images.length > 0 && !图.text.trim()) {
                  return (
                    <p key={para.offset} data-offset={para.offset} className="para-img">
                      {图.images.map((src, i) => <BodyImage key={i} src={src} />)}
                    </p>
                  );
                }
                return (
                <p
                  key={para.offset}
                  data-offset={para.offset}
                  className={para.offset === speakingOffset ? 'speaking' : undefined}
                >
                  {sliceByMarks(para, mine).map((piece, i) =>
                    piece.mark ? (
                      /*
                       * **带笔记的划线不能点一下就没。**
                       *
                       * 原来一律「点击即删」，而带笔记的那条 title 显示的是笔记本身，
                       * 一个字都没提点下去会删——在划过的字上点一下是再自然不过的动作
                       * （想看看写了什么），代价却是笔记直接消失、没有撤销。
                       * 现在：没笔记的照旧一点就撤（那本来就是一个颜色而已），
                       * 带笔记的要确认一次。
                       */
                      <mark
                        key={i}
                        /* ⚠️ **这句话原来是假的**：写着「点击可删掉这条划线和笔记」，
                           而点击早就改成「先把笔记摆出来」了（删是笔记卡里那个键）。
                           笔记本身也不用再在 tooltip 里抄一遍——点一下它就贴着这句话开。 */
                        title="点一下：看笔记、写笔记、换颜色或删掉"
                        /*
                         * ⚠️ **不管有没有笔记，一律先把卡摆出来。**
                         *
                         * 原来是「没笔记的一点就删」，理由写着「那本来就是一个颜色而已」。
                         * 那句话现在不成立了：**颜色代表用途**（黄＝好句、蓝＝待查），
                         * 一条没写笔记的划线也是一条分好类的东西，一点就没、还没有撤销。
                         * 而且反过来那条路一直是缺的——**给已经划好的线补一句笔记**，
                         * 在阅读界面里根本没有入口，得开笔记面板去几十条里找。
                         *
                         * 顺带把两个阅读界面对齐了：`FileViewer` 那边一直是「都开卡」，
                         * 它那段注释还写着「判据和 txt 阅读器那张卡一样」——那句话当时是假的。
                         */
                        onClick={(e) => 摆笔记(piece.mark!, e.currentTarget)}
                        style={{
                          background: 底色(piece.mark.color),
                          color: 'inherit',
                          borderBottom: piece.mark.note ? '2px solid var(--accent)' : 'none',
                          cursor: 'pointer',
                        }}
                      >
                        {piece.text}
                      </mark>
                    ) : (
                      <span key={i}>{piece.text}</span>
                    ),
                  )}
                </p>
                );
              })}
            </article>
            );
          })}
          {/* 哨兵**在所有纸的下面，不在某一张里面**：它要同时管两件事——
              「这一章还没铺完」和「无限下滑该接下一章了」。左右翻页不铺它，
              那边分批由页码驱动（多列布局下这个 div 会白占一整列） */}
          {settings.mode !== 'page' && (shownParas < tailParas || (settings.mode === 'flow' && hasNext)) && (
            <div ref={moreRef} className="muted" style={{ textAlign: 'center', padding: '1rem' }}>
              {shownParas < tailParas
                ? `正在铺开后面的内容…（本章 ${tailParas} 段，已显示 ${shownParas} 段）`
                : '下一章…'}
            </div>
          )}
        </div>

        {/*
          * **在线朗读挂了要说一声。**
          *
          * `useTts` 一直在算 `fellBack`（注释就写着「界面上说一声」），
          * 而在补上下面这块之前，整个渲染进程**一次都没渲染过它**——于是实际发生的是：
          * 在线声音念着念着突然变成系统语音，没有任何解释。用户只会以为是自己设置错了，
          * 或者干脆觉得这个功能坏了。
          *
          * 说法上不摆原始报错（「429」对人没意义），先说发生了什么、再说怎么办。
          */}
        {/* 不放「去设置」按钮：朗读引擎在应用设置里，而这里是全屏阅读器，够不到——
            给一个点了没反应的按钮比不给更糟。说清路径就够了。
            这条提示会在下次开始或停止朗读时自己消失（useTts 里两处都会重置） */}
        {tts.fellBack && (
          <div className="tts-fallback" role="status">
            在线朗读没能继续，<strong>已经换成系统语音接着念</strong>。
            要换个引擎：回书架 → 设置 → 阅读 → 朗读。
            <span className="muted">　（{tts.fellBack}）</span>
          </div>
        )}

        {/* 右下角那个百分比角标删了：**底部这条已经有百分比**，两处说同一件事。
            留下的是能拖的这条——它既是显示也是控件，角标只能看 */}
        <div className="reader-foot">
          <span className="foot-at">第 {footIdx + 1} / {chapter?.total ?? '…'} 章</span>
          {/* 左右翻页模式下，界面上原来**一个能点的翻页控件都没有**——
              turn() 只绑在快捷键上，底部仅有一行「本章 1/12 页」的文字。
              鼠标用户根本翻不了页 */}
          {settings.mode === 'page' && (
            <span className="pager">
              <button
                className="mini"
                onClick={() => turn(-1)}
                disabled={idx <= 0 && page <= 0}
                title="上一页（翻到头会退到上一章）"
              >
                ‹ 上一页
              </button>
              <span className="pager-n">{page + 1} / {pages}</span>
              <button
                className="mini"
                onClick={() => turn(1)}
                disabled={!chapter || (idx >= chapter.total - 1 && page >= pages - 1)}
                title="下一页（翻到底会进下一章）"
              >
                下一页 ›
              </button>
            </span>
          )}
          {/* 拖动条**只在松手时才跳章**。原来绑 onChange，拖过去的每一章都会真的
              去读一次正文——12058 章的书上拖一下发几十次请求，界面直接卡住。
              拖动时只更新预览数字，`onPointerUp`/`onKeyUp` 才 go()。

              **`onBlur` 那条是必须的。** 拖到一半 Alt-Tab（或者触摸、笔迹被
              Chromium 用 pointercancel 掐掉），不会有任何 up 事件，`dragIdx` 就
              一直留在那个假值上——而它现在还管着上面那行章号和右边的百分比，
              底栏会永久停在「第 5000 / 12046 章」，之后按 ←/→ 翻章也不会变。
              失焦按**取消**处理而不是提交：手抖切个窗口不该把书跳到别处去。

              用 `onPointerUp` 不是 `onMouseUp`：触摸和笔一样能拖这条。 */}
          <input
            className="foot-range"
            type="range"
            min={0}
            max={Math.max(0, (chapter?.total ?? 1) - 1)}
            value={footIdx}
            onChange={(e) => setDragIdx(Number(e.target.value))}
            onPointerUp={() => { if (dragIdx !== null) { go(dragIdx); setDragIdx(null); } }}
            onKeyUp={() => { if (dragIdx !== null) { go(dragIdx); setDragIdx(null); } }}
            onBlur={() => setDragIdx(null)}
            title="拖到哪一章，松手才跳"
          />
          <span className="foot-pct">{pct}%</span>
        </div>
      </div>

      {/* 引擎管理。**和「设置 · 阅读」里是同一个组件**，不另抄一份——
          用户在阅读器里想改引擎，不该被赶回书架的设置弹窗 */}
      {管引擎 && (
        <TtsEnginesModal settings={settings} setSettings={setSettings} onClose={() => set管引擎(false)} />
      )}

      {showHl && (
        <HighlightsPanel
          bookId={bookId}
          跳到别的书={onOpenBook}
          chapters={toc}
          onClose={() => {
            setShowHl(false);
            // 面板里能删书签，删完右轨那个图标得跟着灭
            void rpc<Bookmark[]>('bookmark.list', { bookId }).then(setBookmarks);
          }}
          onJump={(ci, off) => {
            // 复用「进书恢复位置」的同一条路：restoreTo 会在章节加载后
            // 被消费成 pendingScroll，按 data-offset 定位到段落
            if (ci === idx) {
              setPendingScroll(off);
            } else {
              restoreTo.current = off;
              go(ci);
            }
          }}
        />
      )}
    </div>
  );
}
