import { useCallback, useEffect, useRef, useState } from 'react';
/* ⚠️ **引 core 那一份，别手抄。** 这儿原来是个手抄的 `Row`，
   而它已经掉了 `cfi` 这一列——`dup-decls.mjs` 当场报「同一个 rpc 两种返回类型」 */
import { COLORS, COLOR_NAMES, type Highlight, type HighlightColor } from '../core/highlight.ts';
import type { Tag } from '../core/library.ts';
import { rpc } from './rpc.ts';
import { use色名, 刷新色名, 底色 } from './highlight-view.ts';
import { whenAgo, sqlTime } from '../core/format.ts';

/** highlight.list 返回的行——**库里的列名，snake_case**，别按驼峰读 */


/** bookmark.list 返回的行——同样是库里的列名 */
/*
 * 这是**书签**的一行，不是划线。原来它叫 `Mark`——而 `core/paragraphs.ts` 里
 * 也有个 `Mark`，指的是**划线**（char_offset + length + color），
 * `Reader.tsx` 里的 `marks` / `openMark` 用的正是那个。
 * 同一个名字两件事，比两份同名的类型更容易读错。
 */
/** 全库那一档怎么归组。「最近」不分组，就是一条时间线 */
type 归组 = '按书' | '按颜色' | '按标签' | '最近';

interface BookmarkRow {
  id: number;
  chapter_idx: number;
  char_offset: number;
  excerpt: string | null;
  note: string | null;
  created_at: string;
  /**
   * 这条书签还指不指得准。`bookmark.resolve` 拿存下来的摘录和那个位置的正文对账。
   * 没存摘录的老书签无从对账，那边当作 true——**别把「不知道」说成「错了」**。
   */
  intact?: boolean;
}

/** highlight.notes 的行（那个 rpc 在 SQL 里已转驼峰） */
interface NoteRow {
  id: number; bookId: number; title: string; chapterIdx: number;
  excerpt: string | null; note: string; color: string | null; createdAt: string;
  /**
   * 这条笔记记在哪儿：划线上，还是书签上。
   *
   * ⚠️ **`id` 在两张表里会重号**（划线 7 和书签 7 都存在），
   * 所以 React key 要用 `kind + ':' + id`——只拿 id 的话
   * 两条撞在一起会被当成同一个节点，**一条静默消失**。
   */
  kind: 'highlight' | 'bookmark';
  /**
   * **框选出来的那种**（迁移 22）。不是 null 就说明它没有文字，
   * 「摘录」那一行是自动生成的一句说明而不是原文——得标出来，否则一屏里分不出来。
   */
  rect?: string | null;
  /**
   * 这条笔记自己的标签（迁移 23）。
   * 颜色只有四个，而「这条是什么」本来就是两维。
   * ⚠️ **书签那半恒为空数组**：关系表只挂在划线上。
   */
  tags?: string[];
}

/*
 * ⚠️ **点的颜色引 core 的 `COLORS`，本地这张表只管「那个点画成什么样」。**
 * 这里原来是一份手写的 `Record<string, string>`——core 加一种颜色，
 * 这儿漏了就画成灰点，而且**不报错**。用 `COLORS` 遍历，漏了当场编译不过。
 *
 * 底色不复用 `HL_COLORS`：那几个是**半透明**的（压在正文上要透出字），
 * 而这里是实心小圆点，透明的看不清。同一件事两种用途，值本来就该不同。
 */
/**
 * **框选那种要一眼看得出来。**
 *
 * 它和文字划线摆在同一列里，而两者回去之后是两回事：
 * 文字划线指着一句话，**框选指的是页上那一块**（扫描页 / 插图 / 公式），
 * 而它的「摘录」是一句自动生成的说明不是原文。不标的话，一屏里它们长得一样。
 * 形状拄书签那个书签图标：一个小记号 + 一句可读的 title。
 */
const 框选记号 = (
  <span
    aria-hidden
    title="框选：指的是页上那一块，不是一句话"
    style={{ marginRight: '.3rem', opacity: 0.75 }}
  >
    ⬚
  </span>
);

const DOT: Record<HighlightColor, string> = {
  yellow: '#dcb428', green: '#50b46e', blue: '#5a96dc', pink: '#dc6ea0',
};

interface Props {
  /**
   * 当前这本书。**全库模式下没有当前这本书，所以可缺**——
   * 这个面板原来只在阅读器和查看器里挂得起来，也就是说
   * **想看自己记过什么，得先随便打开一本书**。而笔记恰恰是铁律 3 里
   * 重扫恢复不了的那几样，却是全应用唯一没有顶层入口的东西。
   * GoodNotes 和 MarginNote 都把「我所有的笔记」放在顶层，这里照做。
   */
  bookId?: number;
  /** 章节标题表，把 chapter_idx 显示成人话。全库模式下用不上 */
  chapters?: Array<{ idx: number; title: string }>;
  /**
   * 跳到某条笔记那儿。
   *
   * ⚠️ **第三个参数是划线的 id，别省。** txt 那边靠 `charOffset` 就能精确落点
   * （按段落偏移定位），而**查看器落不了**：EPUB 的锚是 CFI、PDF 是页内偏移，
   * 光有一个 `charOffset` 还原不出位置。给了 id，那边能把这条划线的 Range
   * 现算出来、滚过去、闪一下。书签没有 id，那时候不传。
   */
  onJump?: (chapterIdx: number, charOffset: number, 划线id?: number) => void;
  onClose: () => void;
  /**
   * 点「全库笔记」里的一条：**打开那本书、落到那一处**。
   * 不给的话那一档还是只读的（判据同这个仓库那条：不给入口好过给一个点了不动的）。
   */
  跳到别的书?: (bookId: number, chapterIdx: number) => void;
  /**
   * 目录里没有这一条时，这个位置该怎么称呼。
   *
   * ⚠️ **不能一律叫「第 N 章」。** 这个面板现在三种界面共用：txt 的位置是章、
   * EPUB 的是节、**PDF 的是页**——一本 PDF 的书签写着「第 5 章」是错的，
   * 而 PDF 十有八九没有 outline，走的正是这条兜底。
   */
  兜底位置名?: (idx: number) => string;
}

/**
 * 划线笔记的回看（spec §5.1「可在笔记面板中汇总查看」——一直没还的欠账）。
 * 「本书」按章节列全部划线，点跳转；「全库」只列带笔记的，按书分组浏览。
 */
export function HighlightsPanel({ bookId, chapters = [], onJump, onClose, 跳到别的书, 兜底位置名 }: Props) {
  /**
   * 从书架直接开的那一份：只有「全库笔记」这一档，没有「当前这本书」。
   * 判据用 `bookId === undefined` 而不是另加一个布尔 prop——
   * **少一个能和事实对不上的参数**（传了 bookId 又说自己是全库模式，那是两个真相）。
   */
  const 全库模式 = bookId === undefined;
  /**
   * **默认落在有东西的那一档。**
   *
   * 原来固定停在划线，而右轨那个按钮叫「书签、划线和笔记」，用户多半是**加完书签
   * 来找书签的**——结果开门看到的是「这本书还没划过线」，书签藏在旁边一个
   * 写着「书签 1」的页签里。铁律 3 的数据「加得进去、看不见」，这功能原来就栽在
   * 这上面一次；入口补上了，默认档没跟上等于只修了一半。
   *
   * 三档的初值在 `reload()` 里定：没划线但有书签就直接开在书签那一档。
   * **只在刚打开时定一次**，之后用户点哪档就是哪档。
   */
  const [tab, setTab] = useState<'book' | 'marks' | 'all'>(全库模式 ? 'all' : 'book');
  const picked = useRef(false);
  const [rows, setRows] = useState<Highlight[]>([]);
  const [all, setAll] = useState<NoteRow[]>([]);
  /**
   * 书签。**加得进去、看不见**是这个功能原来的状态：阅读器里按 b 会调
   * bookmark.add，而 bookmark.list / bookmark.remove 渲染进程从没调过。
   * 书签是铁律 3 的不可再生数据，一直往里存又永远读不出来是最糟的组合
   */
  const [marks, setMarks] = useState<BookmarkRow[]>([]);
  /**
   * 正在编辑哪一条笔记。
   *
   * ⚠️ **要带上「是划线还是书签」**：两者的 id 各自从 1 开始，光一个数字
   * 会让 1 号书签和 1 号划线同时进入编辑态——而且存的时候会调错那个 rpc。
   */
  const [editing, setEditing] = useState<{ 类: '划线' | '书签'; id: number } | null>(null);
  const [draft, setDraft] = useState('');

  /*
   * **关掉面板之前，把写了一半的笔记存了。**
   *
   * 这个笔记框是「显式保存」那一套：有「存」按钮、回车也存、**Esc 明确放弃**
   * （和标签管理的行内改名同一套手势，那是对的）。缺的是第三条路——
   * **关掉整个面板**（点外面、点「关闭」）时既没有失焦保存、也没有兜底，
   * 那句话就没了。当场量的：两条路都是「面板关了=true，库里=null」。
   *
   * 笔记是用户打的字，重扫恢复不了。评价浮层（第 69 轮）、编辑弹窗（第 70 轮）、
   * 阅读器那张卡片（第 81 轮）都已经改成「关掉时把没存的存了」，这是第四处。
   *
   * **Esc 仍然放弃**：它把 `editing` 设成 null，下面这段看见 null 就不写。
   * 「取消」和「关掉」是两件事，一个显式、一个顺手——这正是那三轮定下的判据。
   */
  const pending = useRef<{ 谁: { 类: '划线' | '书签'; id: number } | null; draft: string; base: string }>({
    谁: null, draft: '', base: '',
  });
  pending.current = { ...pending.current, 谁: editing, draft };
  useEffect(() => () => {
    const { 谁, draft: d, base } = pending.current;
    if (谁 && d.trim() !== base.trim()) {
      // 两种笔记走两个 rpc——同一句话存错表就是丢了
      const 方法 = 谁.类 === '划线' ? 'highlight.setNote' : 'bookmark.setNote';
      void rpc(方法, { id: 谁.id, note: d.trim() || null });
    }
  }, []);

  const reload = useCallback(async () => {
    // 全库模式没有当前这本书——那两个按书查的 rpc 一个都别发
    // （`bookId: undefined` 传过去，`highlight.list` 会把**全库的划线**都拉回来，
    //  几千条塞进「本书划线」那一档，而那一档在这个模式下根本不显示）
    if (bookId === undefined) {
      setAll(await rpc<NoteRow[]>('highlight.notes', {}));
      return;
    }
    const [hl, notes, bm] = await Promise.all([
      rpc<Highlight[]>('highlight.list', { bookId }),
      rpc<NoteRow[]>('highlight.notes', {}),
      // **走 resolve 不走 list**：要的是「这条书签还指得准吗」，不只是「有哪些书签」
      rpc<BookmarkRow[]>('bookmark.resolve', { bookId }),
    ]);
    setRows(hl);
    setAll(notes);
    setMarks(bm);
    if (!picked.current) {
      picked.current = true;
      if (hl.length === 0 && bm.length > 0) setTab('marks');
    }
  }, [bookId]);

  useEffect(() => { void reload(); }, [reload]);

  /*
   * **换一档就把颜色筛清掉。**
   *
   * 不清的话会出现一种最难看的空白：在「本书」里筛着绿的，切到「全库」——
   * 全库一条绿的都没有，于是列表全空，**而筛选那排上没有任何一个按钮
   * 显示成按下**（那排只列这一档真的用过的颜色，绿的压根不在里面）。
   * 用户看到的是「我的笔记全没了」，还找不到是哪儿筛的。
   *
   * 「把筛选带过去」听着更聪明，但它只在颜色恰好两边都有时才成立——
   * 一个**有时候对**的行为比一个总是对的行为差。
   */
  useEffect(() => { set只看(null); }, [tab]);

  const titleOf = (idx: number) =>
    chapters.find((c) => c.idx === idx)?.title ?? 兜底位置名?.(idx) ?? `第 ${idx + 1} 章`;

  const saveNote = async (类: '划线' | '书签', id: number) => {
    await rpc(类 === '划线' ? 'highlight.setNote' : 'bookmark.setNote', { id, note: draft.trim() || null });
    setEditing(null);
    await reload();
  };

  /**
   * 那个行内笔记框。**划线和书签共用一份**——两者唯一的差别是存去哪张表，
   * 而手势（回车存、Esc 放弃、中文输入法选词的回车不算提交）一模一样。
   */
  const 笔记框 = (类: '划线' | '书签', id: number) => (
    <div className="row" style={{ marginTop: '.3rem' }}>
      <input
        autoFocus value={draft} style={{ flex: 1 }}
        placeholder={类 === '书签' ? '记一句：为什么标这儿' : '记一句'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Escape 放弃编辑，不保存草稿
          if (e.key === 'Escape') { setEditing(null); return; }
          // 中文输入法选词的回车是确认候选词，不是提交——
          // 这个仓库已经在 Reader.tsx 的笔记输入框踩过一次（da6ab94），这里同款防护
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          void saveNote(类, id);
        }}
      />
      <button onClick={() => void saveNote(类, id)}>存</button>
    </div>
  );
  // 这两处的笔记都印在同一行上（下面 r.note / m.note 那两个 div），
  // 用户看着它按的删，所以带 confirmed——闸挡的是看不见笔记的那些路
  const remove = async (id: number) => {
    await rpc('highlight.remove', { id, confirmed: true });
    await reload();
  };
  /**
   * 全库那一档里删一条。**两种笔记走两个 rpc**——
   * 同一个 id 在两张表里都存在，发错表就是删了别人那条，而且不报错。
   */
  const 删掉 = async (kind: 'highlight' | 'bookmark', id: number) => {
    await rpc(kind === 'highlight' ? 'highlight.remove' : 'bookmark.remove', { id, confirmed: true });
    await reload();
  };
  /**
   * 批量改色 / 批量删。
   *
   * ⚠️ **一条一条发，不另开一个「批量 rpc」。** 安全阀在 `removeHighlight` 里（写了
   * 笔记的要 `confirmed`），另写一份批量版就是把同一条判据抄第二份——
   * 这个仓库已经被这件事咬过好几次。人手写得出来的笔记是几十条量级，
   * 多几次本地 IPC 不值得为它多一份实现。
   *
   * ⚠️ **两种笔记发两个 rpc**（同 `删掉`）：两张表的 `id` 会重号。
   */
  const 选中的 = () => 显示的全库.filter((n) => 选中.has(n.kind + ':' + String(n.id)));
  const 批量改色 = async (color: HighlightColor) => {
    const 中 = 选中的().filter((n) => n.kind === 'highlight');
    set忙(`改颜色… 0/${中.length}`);
    for (let i = 0; i < 中.length; i++) {
      await rpc('highlight.setColor', { id: 中[i].id, color });
      set忙(`改颜色… ${i + 1}/${中.length}`);
    }
    set忙(null);
    退出批量();
    await reload();
  };
  /**
   * 从一条笔记上摘一个标签。**不删 `tag` 本身**——那是标签管理器的事。
   *
   * ⚠️ rpc 收的是 `tagId` 不是名字，而这一档只拿到名字（`notesOf` 回的就是名字，
   * 因为名字才是用户认得的东西）——所以先拿 `tag.list` 换一下。
   * 换不到就不动手：猜一个 id 发过去就是摘了别人那个，而且不报错。
   */
  const 摘标签 
    = async (id: number, name: string) => {
      const tags = await rpc<Tag[]>('tag.list').catch(() => []);
      const t = tags.find((x) => x.name === name);
      if (!t) return;
      await rpc('highlight.untag', { ids: [id], tagId: t.id });
      await reload();
    };

  const 批量打标签 = async (raw: string) => {
    /*
     * ⚠️ **只对划线成立。** `highlight_tag` 只挂在划线上；书签那半没有这张关系表，
     * 一起发过去就是拿书签的 id 去标划线——两边 id 重号，而且不报错。
     */
    const ids = 选中的().filter((n) => n.kind === 'highlight').map((n) => n.id);
    if (!ids.length || !raw.trim()) return;
    set忙('打标签…');
    try {
      await rpc('highlight.tag', { ids, names: raw.split(/[,，\s]+/).filter(Boolean) });
    } catch (e) { set忙((e as Error).message); setTimeout(() => set忙(null), 3000); return; }
    set忙(null);
    退出批量();
    await reload();
  };

  const 批量删 = async () => {
    const 中 = 选中的();
    set忙(`删… 0/${中.length}`);
    for (let i = 0; i < 中.length; i++) {
      await rpc(中[i].kind === 'highlight' ? 'highlight.remove' : 'bookmark.remove',
        { id: 中[i].id, confirmed: true });
      set忙(`删… ${i + 1}/${中.length}`);
    }
    set忙(null);
    退出批量();
    await reload();
  };

  /** 改颜色。改完立刻重取——阅读界面那边靠 `highlight.list` 重画 */
  const 改颜色 = async (id: number, color: HighlightColor) => {
    await rpc('highlight.setColor', { id, color });
    set调色(null);
    await reload();
  };

  /**
   * **找得到才算有。**
   *
   * 这三档原来都是平铺的列表。十条的时候翻一翻就行，
   * 而一本认真读过的书几百条起——那时候「我记过一句关于 XX 的」这个最常见的需求
   * 只能靠滚。搜的是**摘录 + 笔记 + 位置名**（全库那档再加书名）：
   * 记笔记的人记得住的往往是自己写的那句话，不是原文。
   */
  const [找, set找] = useState('');
  const 词 = 找.trim().toLowerCase();
  const 中 = (...段: Array<string | null | undefined>) =>
    !词 || 段.some((x) => (x ?? '').toLowerCase().includes(词));

  /**
   * 全库那一档怎么归组。
   *
   * **归组不是排序。** 排序只能让同类挨着，归组才回答得了
   * 「蓝的那堆一共几条、分布在哪几本」——而颜色在这个应用里是用户自己定的
   * 用途（黄＝好句、蓝＝待查），「待查的还剩哪些」正是它最常被问的一句。
   * （MarginNote 的卡片分组板能按颜色 / 标签 / 文档 / 日期分，这里先收三种。）
   *
   * ⚠️ **书签没有颜色**，按颜色归组时它们自成一组，不能归到黄的里去。
   */
  const 分组名 = (n: NoteRow): string =>
    排序 === '按书' ? '《' + n.title + '》'
      : 排序 === '按颜色'
        ? (n.kind === 'bookmark' ? '书签' : (色名[n.color as HighlightColor] ?? '未知颜色'))
        : 排序 === '按标签'
          /*
           * ⚠️ **一条可以有好几个标签，而归组得选一个。**
           * MarginNote 那边是把同一张卡片**以引用形式同时放进好几组**，
           * 那得把行复制几份——而复制之后「已选 N 条」和批量删就都会数重。
           * 这里取**排在最前面那个**（名字已经按字序排好了），一条只归一处：
           * 回看笔记要的是「没漏掉」，不是「每个标签下都齐」。
           */
          ? (n.tags?.[0] ?? '没打标签')
          : '';

  /** 正在给哪条划线挑颜色 */
  const [调色, set调色] = useState<number | null>(null);

  /**
   * 每种颜色代表什么。**这是这套分类真正成立的地方**——
   * 颜色能标能筛，但不写明用途的话，隔一个月回来自己也不记得蓝色当初是什么意思。
   * GoodNotes 和 MarginNote 都把它交给用户自己定，这里照做。
   */
  const 色名 = use色名();
  const [改用途, set改用途] = useState(false);
  const [导出中, set导出中] = useState(false);
  /**
   * 全库那一档怎么排。
   *
   * **默认按书**：回看笔记多半是「《某某》里我记过什么」，同一本的挨在一起才好读。
   * **另一档按时间**：而「我最近记了些什么」是同样常见的一问，
   * 原来这一档只能按书排，那个问题**在应用里根本问不出来**——
   * 库里 `created_at` 一直有，只是没人读它（书签那一档显示了，划线和全库都没有）。
   */
  const [排序, set排序] = useState<归组>('按书');

  /**
   * 选中了哪几条（批量模式）。**键是 `kind:id`**：
   * 两张表的 `id` 会重号，只拿 id 当键就会把别人那条一起选上（而且不报错）。
   */
  const [选中, set选中] = useState<Set<string>>(new Set());
  const [批量, set批量] = useState(false);
  const [批量调色, set批量调色] = useState(false);
  /** 批量打标签那个输入框。`null` 就是没开 */
  const [标签草稿, set标签草稿] = useState<string | null>(null);
  const [忙, set忙] = useState<string | null>(null);
  /** 换一档 / 换一种归组 / 改一次筛选，选中就不算数了——屏上已经是另一批东西 */
  const 退出批量 = useCallback(() => { set批量(false); set选中(new Set()); set批量调色(false); set标签草稿(null); }, []);

  /**
   * 全库那一档一次铺多少行。
   *
   * **量出来的**（8 本书的测试库，逐级加到 8800 条带笔记的划线+书签）：
   *
   * | 条数 | 打开 | 切排序 | DOM 节点 | 弹窗高 |
   * |---|---|---|---|---|
   * | 220 | 42ms | 21ms | 2257 | 21040px |
   * | 1100 | 103ms | 83ms | 11137 | 102642px |
   * | 3300 | 273ms | 237ms | 33337 | 306646px |
   * | 8800 | **702ms** | **708ms** | 88837 | 816656px |
   *
   * 线性，每行约 80µs。8800 条时开一次 0.7 秒、换个排序又 0.7 秒——
   * 而目录那边正是量到 543ms 才开的窗口，这里已经过线了。
   * 一个有八千本书的人（这个仓库的真实书库就是 8172 本）记出八千条笔记，
   * 在设计范围之内。
   *
   * ⚠️ **做的是「先铺一截、要看再铺」，不是真窗口。** 目录那套（前后哨兵 +
   * IntersectionObserver）是为「一万两千章、还要定位到当前章」写的；
   * 这一档没有「当前那条」要对齐，翻到底再铺一截就够——**别把那套机械抄过来**。
   * 300 行约 25ms，一屏装得下十几条，翻几下才到底。
   */
  const 一屏 = 300;
  const [铺, set铺] = useState(一屏);
  /** 导出完把落盘路径摆出来——「导好了」和「导到哪儿了」是两件事 */
  const [导出到, set导出到] = useState<string | null>(null);
  const [用途草稿, set用途草稿] = useState<Record<string, string>>({});

  /** 只看某一种颜色。null＝都看 */
  const [只看, set只看] = useState<HighlightColor | null>(null);

  /*
   * 换了筛选 / 排序 / 页签就从头铺——那时候用户看的是另一批东西了。
   * ⚠️ **这个 effect 必须摆在依赖全都声明完之后。** 它读 `tab` / `排序` /
   * `只看` / `找`，而这四个散落在这个组件的前后两截；挪到 `铺` 旁边看着更顺，
   * 但那是 TDZ，`tsc` 当场报「used before its declaration」。
   */
  useEffect(() => { set铺(一屏); }, [tab, 排序, 只看, 找]);
  const 显示的划线 = rows
    .filter((r) => !只看 || r.color === 只看)
    .filter((r) => 中(r.excerpt, r.note, titleOf(r.chapter_idx)));
  const 显示的书签 = marks.filter((m) => 中(m.excerpt, m.note, titleOf(m.chapter_idx)));
  // 全库那档多搜一个书名：跨书回看时「哪本书里那句」是最自然的入口
  const 显示的全库 = all
    .filter((n) => !只看 || n.color === 只看)
    .filter((n) => 中(n.excerpt ?? '', n.note, n.title))
    /*
     * 按时间那一档在这儿排，不在 SQL 里——`notesOf` 是 `union all` 两张表，
     * 再按时间排一次要么套子查询、要么让两边各排各的（那是错的）。
     * 一个人写得出来的笔记条数，JS 排一遍是微秒级的事。
     *
     * ⚠️ **必须走 `sqlTime` 解析成毫秒，别拿字符串比。**
     * 先写的是 `localeCompare`，理由是「都是 `YYYY-MM-DD HH:MM:SS`，
     * 字典序就是时间序」——**那个前提不成立**：`asWhen`（`status.ts`）
     * 只要求「`sqlTime` 解析得出来」就原样留着，所以库里可以同时有
     * `2026-08-27 06:00:00` 和 `2026-08-27T05:00:00Z`（老备份、外部工具经 §13 写的）。
     * 而 `'T'`(0x54) > `' '`(0x20)，带 T 的那条永远排在后面，跟它是什么时候写的无关。
     */
    .sort((a, b) => {
      if (排序 === '最近') return (sqlTime(b.createdAt) ?? 0) - (sqlTime(a.createdAt) ?? 0);
      /*
       * 按颜色归组要**自己排一遍**：SQL 那边是按书排的，同色的根本不挨着。
       * 不排的话下面那句「组名变了就插一行表头」会插得满屏都是（同
       * 「按时间排就不能再按书名插表头」那条，一模一样的坑）。
       * 同一组内保持原来的按书次序：`Array.prototype.sort` 是稳定的。
       */
      if (排序 === '按颜色' || 排序 === '按标签') return 分组名(a).localeCompare(分组名(b), 'zh');
      return 0;
    });

  /**
   * ⚠️ **必须摆在 `显示的全库` 之后。** 它调 `选中的()`，而那个函数读 `显示的全库`——
   * 摆在前面就是 TDZ，**typecheck 一声不响，而渲染直接崩成白屏**（实测踩过）。
   * **真会改的那批**：选中的 ∩ 屏上还在的。
   *
   * ⚠️ **按钮上的数必须是这个数，不是 `选中.size`。**
   * 选中是一批 `kind:id`，而搜索框和颜色筛随时会把屏上那批变小——
   * 选了 10 条再搜一下，列表剩 2 条，而批量那几个函数本来就只动屏上这 2 条。
   * 按钮写「删掉 10 条」而实际删 2 条，是这个仓库明文反对的那种错
   * （批量打标签那边写着「**按钮上的数 = 真会改的数**」）。
   *
   * **不选择「一筛选就清空选中」**：那会把用户刚勾的一批默默丢掉。
   * 现在是筛回去就又回来了，而数字始终说的是实话。
   */
  const 会改的 = 选中的();
  const 能改色的 = 会改的.filter((n) => n.kind === 'highlight');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 'min(44rem, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: '.6rem' }}>
          {/* 标题里要有「书签」：它是这三样里唯一能从别处（右轨那个图标、按 B）
              加进来的，而加完的人只会照着「书签」这两个字找 */}
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{全库模式 ? '我的笔记' : '书签与划线'}</h2>
          {/* 全库模式只有一档，摆一排只有一个按钮的页签是噪音 */}
          {!全库模式 && (
          <div className="tabs">
            {/* 三档要么全是「范围」要么全是「类型」，不能混着来。原来是
                「本书 / 书签 / 全库笔记」——第一档说范围、第二档说类型，
                于是点开「本书」看到的是划线，而弹窗标题写着「书签与划线」 */}
            <button aria-current={tab === 'book'} onClick={() => setTab('book')}>
              划线{rows.length ? ' ' + rows.length : ''}
            </button>
            <button aria-current={tab === 'marks'} onClick={() => setTab('marks')}>书签{marks.length ? ' ' + marks.length : ''}</button>
            <button aria-current={tab === 'all'} onClick={() => setTab('all')}>全库笔记</button>
          </div>
          )}
        </div>

        {/* **搜索框只在真有一堆的时候才摆出来。** 三五条的时候它是噪音，
            而且会把上面那排页签往下挤。20 是拍的：一屏大概装得下十几条 */}
        {(rows.length + marks.length + all.length > 20) && (
          <input
            value={找}
            onChange={(e) => set找(e.target.value)}
            placeholder="搜摘录、笔记、章名"
            aria-label="在笔记里搜"
            style={{ width: '100%', marginBottom: '.5rem' }}
          />
        )}

        {/*
          * **给颜色写上用途。** 到这一步之前，颜色只是四种好看的底色：
          * 标得出来、筛得出来，但代表什么只在用户自己脑子里，隔一个月就忘了。
          * GoodNotes 的荧光笔预设、MarginNote 的「色彩标签」都是同一件事
          * （`docs/reference/` 那两份资料里各占一节）。
          *
          * ⚠️ **放在筛选那一排的外面、而且不设门槛。** 筛选那排要「用过两种以上」
          * 才出现，可「想清楚颜色代表什么」恰恰是**划线之前**的事——
          * 门槛设在那儿，就永远等到用完两种颜色才提示，那时候名字早该有了。
          */}
        {(tab === 'book' || 全库模式) && (
          <div style={{ marginBottom: '.5rem' }}>
            <button
              className="mini"
              aria-expanded={改用途}
              onClick={() => {
                if (!改用途) set用途草稿({ ...色名 });
                set改用途(!改用途);
              }}
            >
              颜色代表什么…
            </button>
            {改用途 && (
              <div className="card" style={{ marginTop: '.4rem', display: 'grid', gap: '.4rem' }}>
                <p className="muted" style={{ fontSize: '.78rem', margin: 0 }}>
                  写上它代表什么——比如黄＝好句、蓝＝待查、绿＝人物关系。
                  写完之后划线时那排色块、上面的筛选、导出的笔记都用这个名字。留空就还叫原来的。
                </p>
                {COLORS.map((c) => (
                  <label key={c} className="row" style={{ gap: '.4rem', alignItems: 'center' }}>
                    <span
                      aria-hidden
                      style={{
                        background: DOT[c], width: '.9rem', height: '.9rem',
                        borderRadius: '50%', display: 'inline-block', flex: '0 0 auto',
                      }}
                    />
                    <input
                      value={用途草稿[c] ?? ''}
                      maxLength={12}
                      placeholder={COLOR_NAMES[c]}
                      aria-label={COLOR_NAMES[c] + '色代表什么'}
                      onChange={(e) => set用途草稿({ ...用途草稿, [c]: e.target.value })}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                  </label>
                ))}
                <div className="row" style={{ gap: '.4rem' }}>
                  <button
                    className="primary"
                    onClick={() => void (async () => {
                      await rpc('highlight.setColorNames', 用途草稿);
                      // 改完必须广播：旁边阅读界面那排色块还缓存着旧名字
                      await 刷新色名();
                      set改用途(false);
                    })()}
                  >
                    保存
                  </button>
                  <button onClick={() => set改用途(false)}>取消</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/*
          * **按颜色筛。** 颜色是划线唯一的分类轴（黄＝好句、蓝＝待查……），
          * 能标不能筛的话那套分类等于只写给自己看。
          * ⚠️ **只列真的用到过的颜色**：一个全是黄色的库不该摆出四个点让人挨个试
          * （同分类界面那条「只列真的存在的那几种格式」）。
          */}
        {/* **按书 / 按颜色 / 最近。** 只在全库那一档摆——「本书」那一档本来就按章序排，
            而一本书里的笔记按时间看没有意义（读到哪儿记到哪儿，时间序≈章序） */}
        {tab === 'all' && all.length > 1 && (
          <div className="row" style={{ gap: '.3rem', marginBottom: '.5rem', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: '.78rem' }}>归组</span>
            {(['按书', '按颜色', '按标签', '最近'] as const).map((k) => (
              <button
                key={k}
                className="chip"
                aria-pressed={排序 === k}
                onClick={() => { set排序(k); 退出批量(); }}
              >
                {k}
              </button>
            ))}
            {/* **批量改色 / 批量删。** 颜色就四个，用途一多就不够分，
                「把这十条待查的都改成已查」原来得点二十下 */}
            <button
              className="chip"
              style={{ marginLeft: 'auto' }}
              aria-pressed={批量}
              onClick={() => (批量 ? 退出批量() : set批量(true))}
            >
              {批量 ? '退出多选' : '多选'}
            </button>
          </div>
        )}

        {/*
          * **选了几条、能对它们做什么，全写在这一条上。**
          *
          * ⚠️ **「全选」只选得了铺出来的那一截，所以名字就叫「选这一屏」。**
          * 这一档是先铺 300 行、翻到底再铺一截（量过的：八千多条全铺开要 0.7 秒），
          * 叫「全选」而只选中一截是在骗人——而这次骗的后果是批量删少删了东西，
          * 看上去像「删不干净」。
          */}
        {tab === 'all' && 批量 && (
          <div
            className="row"
            style={{
              gap: '.3rem', marginBottom: '.5rem', alignItems: 'center',
              /*
               * ⚠️ **底色用实心 token，不用半透明。**
               *
               * 第一版写的是 `var(--hover, rgba(127,127,127,.12))`——两个错叠在一起：
               * 一是**这个应用根本没有 `--hover` 这个 token**（token 只有
               * `--bg / --fg / --muted / --line / --panel / --accent / --danger`），一直在走兜底；
               * 二是 `audit.mjs` 的 `bgOf` **不做 alpha 合成**，把 12% 的灰当成实心中灰，
               * 于是 `--fg` 压上去量出 3.70（下限 4.5），**五个分辨率各报一条**。
               *
               * 那条报警就读数而言是假的（实际合成出来几乎是白的），但**让它变真比让它闭嘴容易**：
               * 用应用真有的实心底色，量到的就是眼睛看到的。
               */
              padding: '.35rem .5rem', borderRadius: '.4rem',
              background: 'var(--panel)', border: '1px solid var(--line)',
              /*
               * ⚠️ **加了底色就得把字色一起定。**
               * 不定的话它继承上来的是偏淡的那一档，压在 `--hover` 上
               * `audit.mjs` 量到**对比度 3.70（下限 4.5）**，五个分辨率各报一条。
               * 这一条胉眼看是看不出来的——这正是那个走查存在的理由。
               */
              color: 'var(--fg)',
            }}
          >
            <span style={{ fontSize: '.8rem', color: 'var(--fg)' }}>已选 {会改的.length} 条</span>
            <button
              className="mini"
              onClick={() => set选中(new Set(显示的全库.slice(0, 铺).map((n) => n.kind + ':' + String(n.id))))}
            >
              选这一屏
            </button>
            <button className="mini" onClick={() => set选中(new Set())} disabled={选中.size === 0}>清空</button>
            <span style={{ flex: 1 }} />
            {忙 && <span className="muted" style={{ fontSize: '.78rem' }}>{忙}</span>}
            {/* **改色只对划线成立。** 书签没有颜色这一列，
                选中里混着书签时把数写出来，别让人以为改了全部 */}
            <button
              className="mini"
              disabled={能改色的.length === 0 || !!忙}
              onClick={() => set批量调色((v) => !v)}
            >
              改颜色（{能改色的.length}）
            </button>
            <button
              className="mini"
              disabled={能改色的.length === 0 || !!忙}
              onClick={() => set标签草稿((v) => (v === null ? '' : null))}
            >
              打标签
            </button>
            <button
              className="mini"
              disabled={会改的.length === 0 || !!忙}
              onClick={() => void 批量删()}
            >
              删掉 {会改的.length} 条
            </button>
          </div>
        )}
        {tab === 'all' && 批量 && 标签草稿 !== null && (
          <div className="row" style={{ gap: '.3rem', marginBottom: '.5rem', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: '.78rem' }}>打上</span>
            <input
              autoFocus
              value={标签草稿}
              onChange={(e) => set标签草稿(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void 批量打标签(标签草稿); }}
              placeholder="标签名，逗号分隔"
              aria-label="给选中的笔记打标签"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="mini" onClick={() => void 批量打标签(标签草稿)}>打上</button>
          </div>
        )}
        {tab === 'all' && 批量 && 批量调色 && (
          <div className="row" style={{ gap: '.3rem', marginBottom: '.5rem', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: '.78rem' }}>改成</span>
            {COLORS.map((c) => (
              <button
                key={c}
                className="chip"
                aria-label={'都改成' + 色名[c] + '色'}
                onClick={() => void 批量改色(c)}
              >
                {色名[c]}
              </button>
            ))}
          </div>
        )}

        {(tab === 'book' || tab === 'all') && (() => {
          /*
           * 数哪一堆，跟着当前这一档走。
           *
           * ⚠️ **全库那一档也要能筛。** 「颜色代表什么」是**全库**的设置，
           * 用户把蓝定成「待查」之后最想问的一句正是
           * 「全库还剩哪些待查」——而那句话只有在这一档问得出来。
           * 原来这排只在「本书」档出现，等于把这套分类的用处砍掉一半。
           *
           * 书签的 `color` 是 null（书签本来就没有颜色），所以它们
           * 既不参与计数、也在筛某一种颜色时被滤掉——那是对的：
           * 「只看待查的」不该混进一堆没有颜色的书签。
           */
          const 这一堆: Array<{ color: string | null }> = tab === 'book' ? rows : all;
          const 数 = (c: string) => 这一堆.filter((r) => r.color === c).length;
          const 用过的 = COLORS.filter((c) => 数(c) > 0);
          if (用过的.length < 2) return null;
          return (
            <div className="row" style={{ gap: '.3rem', marginBottom: '.5rem', alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: '.78rem' }}>只看</span>
              <button className="chip" aria-pressed={只看 === null} onClick={() => set只看(null)}>全部</button>
              {/* **筛选按钮上要写颜色的名字，不能只有一个点。** 光四个圆点
                  就是四个没法称呼的按钮，对读屏更是——而这一排恰恰是
                  「按用途筛」的入口，用途正是那个名字 */}
              {用过的.map((c) => (
                <button
                  key={c}
                  className="chip"
                  aria-label={'只看「' + 色名[c] + '」的（' + 数(c) + ' 条）'}
                  aria-pressed={只看 === c}
                  onClick={() => set只看(只看 === c ? null : c)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '.3rem' }}
                >
                  <span
                    aria-hidden
                    style={{
                      background: DOT[c], width: '.7rem', height: '.7rem',
                      borderRadius: '50%', display: 'inline-block', flex: '0 0 auto',
                    }}
                  />
                  {色名[c]}
                  <span className="muted">{数(c)}</span>
                </button>
              ))}
            </div>
          );
        })()}

        {tab === 'book' ? (
          显示的划线.length === 0 ? (
            <p className="muted">
              {词 || 只看 ? '没有符合的划线。' : '这本书还没划过线。阅读时选中一段文字就能划。'}
            </p>
          ) : (
            显示的划线.map((r) => (
              <div key={r.id} className="card" style={{ marginBottom: '.45rem', padding: '.5rem .7rem' }}>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  {/* **点它就能换颜色。** 这个点原来只是个色标——而颜色是划线唯一的
                      分类手段（黄=好句、蓝=待查……），划的时候点错了就再也改不回来。
                      展开的四个点带中文名：一排纯色圆点对读屏就是四个「按钮」 */}
                  <div style={{ flexShrink: 0, marginTop: '.2rem' }}>
                    <button
                      className="hl-dot"
                      aria-label={'这条是' + (色名[r.color as HighlightColor] ?? '未知') + '色，点一下换颜色'}
                      aria-expanded={调色 === r.id}
                      style={{ background: DOT[r.color as HighlightColor] ?? '#999', width: '.9rem', height: '.9rem' }}
                      onClick={() => set调色(调色 === r.id ? null : r.id)}
                    />
                    {调色 === r.id && (
                      <div className="row" style={{ gap: '.2rem', marginTop: '.25rem' }}>
                        {COLORS.map((c) => (
                          <button
                            key={c}
                            className="hl-dot"
                            aria-label={'换成' + 色名[c] + '色'}
                            aria-pressed={r.color === c}
                            title={色名[c]}
                            style={{ background: DOT[c], width: '.9rem', height: '.9rem' }}
                            onClick={() => void 改颜色(r.id, c)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.85rem' }}>
                      {r.rect && 框选记号}
                      {r.excerpt}
                    </div>
                    {editing?.类 === '划线' && editing.id === r.id ? (
                      笔记框('划线', r.id)
                    ) : r.note ? (
                      <div className="muted" style={{ fontSize: '.8rem', marginTop: '.15rem' }}>{r.note}</div>
                    ) : null}
                    <div className="muted" style={{ fontSize: '0.75rem', marginTop: '.2rem' }}>
                      {titleOf(r.chapter_idx)}
                    </div>
                  </div>
                  <div className="row" style={{ flexShrink: 0, gap: '.25rem' }}>
                    <button className="mini" onClick={() => { onJump?.(r.chapter_idx, r.char_offset, r.id); onClose(); }}>
                      跳转
                    </button>
                    <button
                      className="mini"
                      onClick={() => {
                        setEditing({ 类: '划线', id: r.id });
                        setDraft(r.note ?? '');
                        // 打开时是什么样记下来：卸载时靠它判断「改过没有」
                        pending.current = { 谁: { 类: '划线', id: r.id }, draft: r.note ?? '', base: r.note ?? '' };
                      }}
                    >
                      {r.note ? '改笔记' : '写笔记'}
                    </button>
                    <button className="mini" onClick={() => void remove(r.id)}>删</button>
                  </div>
                </div>
              </div>
            ))
          )
        ) : tab === 'marks' ? (
          显示的书签.length === 0 ? (
            <p className="muted">{词 ? '没有匹配的书签。' : '这本书还没有书签。阅读时按 B 加一个。'}</p>
          ) : (
            显示的书签.map((m) => (
              <div key={m.id} className="card" style={{ marginBottom: '.45rem', padding: '.5rem .7rem' }}>
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.85rem' }}>{m.excerpt ?? '（没有摘录）'}</div>
                    {/*
                      * **漂了要说一声。** 和划线同一条判据：正文变过之后，
                      * 「章号 + 偏移」就指到别的句子上了，而这一行原来照旧显示
                      * 当初的摘录、旁边印着按**现在**的切分算出来的章名——
                      * 一个自信但错误的标签，点「跳转」落在哪儿谁也不知道。
                      * **不猜也不删**，只照实说，并且说清还能干什么。
                      */}
                    {m.intact === false && (
                      <div className="danger" style={{ fontSize: '.78rem', marginTop: '.15rem' }}>
                        正文变过，这条书签对不上原文了——跳过去多半不是原来那个位置。
                        上面这段摘录还是当初存下来的，可以拿它去「书内搜索」。
                      </div>
                    )}
                    {/* **书签也能记一句。** 这一列原来只显示不写——
                        全应用没有一个地方写得进去，那个显示分支是死代码。
                        「记一句为什么标这儿」正是书签比进度多出来的那点价值 */}
                    {editing?.类 === '书签' && editing.id === m.id ? (
                      笔记框('书签', m.id)
                    ) : m.note ? (
                      <div className="muted" style={{ fontSize: '.8rem', marginTop: '.15rem' }}>{m.note}</div>
                    ) : null}
                    <div className="muted" style={{ fontSize: '0.75rem', marginTop: '.2rem' }}>
                      {titleOf(m.chapter_idx)}
                      {/* **别把 `created_at` 直接印出来**：它是 sqlite 的 UTC 文本，
                          原样显示在东八区差 8 小时——一条刚加的书签会写着八小时前的
                          时刻，看起来像时钟坏了。判据在 `core/format.ts` 的 `whenAgo` */}
                      {whenAgo(m.created_at) && (
                        <span title={whenAgo(m.created_at)!.title}> · {whenAgo(m.created_at)!.text}</span>
                      )}
                    </div>
                  </div>
                  <div className="row" style={{ flexShrink: 0, gap: '.25rem' }}>
                    <button className="mini" onClick={() => { onJump?.(m.chapter_idx, m.char_offset); onClose(); }}>
                      跳转
                    </button>
                    <button
                      className="mini"
                      onClick={() => {
                        setEditing({ 类: '书签', id: m.id });
                        setDraft(m.note ?? '');
                        pending.current = { 谁: { 类: '书签', id: m.id }, draft: m.note ?? '', base: m.note ?? '' };
                      }}
                    >
                      {m.note ? '改笔记' : '写笔记'}
                    </button>
                    <button
                      className="mini"
                      onClick={() => void (async () => {
                        await rpc('bookmark.remove', { id: m.id, confirmed: true });
                        await reload();
                      })()}
                    >
                      删
                    </button>
                  </div>
                </div>
              </div>
            ))
          )
        ) : 显示的全库.length === 0 ? (
          /*
           * ⚠️ **比的是 `显示的全库`，不是 `all`。**
           * 原来比 `all`：搜出零条、或者按颜色筛剩零条时，`all` 还是非空，
           * 于是走进下面那个 `.map`，**渲染出一片什么都没有的空白**——
           * 既没有一行结果，也没有一句「没找到」。
           * 另外两档（划线、书签）比的一直都是过滤后的那个数组，是这一档漏了。
           */
          /*
           * 空状态要说**怎么做出一条来**，另外两个页签都说了
           * （「选中一段文字就能划」「按 B 加一个」），这一条原来只说「没有」。
           * 笔记比划线多一步：先划一段，再回到「划线」页签点「写笔记」——
           * 不说的话，用户看着这句话不知道该去哪儿。
           *
           * ⚠️ 这里必须用**块注释**，不能用花括号包起来的那种 JSX 注释：
           * 三元分支里只能放一个表达式，而那种注释是**子节点**语法，
           * 摆在分支开头会让 rolldown 报
           *
           * ⚠️⚠️ **这句话里不能写出那两个字符本身。** 写出来的话，
           * `no-literal-markdown` 那个守卫剥注释的正则会从这儿开始找结束符，
           * 一路吃到文件后面某条 JSX 注释的收尾——**把这条注释自己的结束符吃掉**，
           * 于是这一整段的 `**` 全漏出去，报成「星号漏进界面」。
           * 同族的第三次了（源码里的裸控制字符、块注释里的 glob）：
           * **在注释里提某种语法，就会把处理那种语法的工具骗了。**
           * 「Expected `,` or `)`」——报错指向的位置和注释毫无关系。
           */
          <p className="muted">
            {/* **「筛没了」和「本来就没有」是两句话。** 只说后一句的话，
                筛剩 0 条的人会以为自己的笔记没了——同这个仓库
                「不给入口好过给一个点了不动的」那一族判据 */}
            {词 || 只看
              ? '没有符合的笔记。'
              : '还没有写过笔记。在正文里划一段、或者加个书签，再给它写一句。'}
          </p>
        ) : (
          // 按书分组。同书的行在 SQL 里已经排在一起，这里只在书名变化时插标题
          显示的全库.slice(0, 铺).map((n, i, 这一屏) => (
            <div key={n.kind + ':' + String(n.id)}>
              {/* ⚠️ **和 `显示的全库` 比，不是和 `all` 比。**
                  这一行原来是 `all[i - 1].title`——而 `i` 是**过滤之后**那个数组的下标。
                  没搜索时两个数组一样，看不出问题；一搜就错位：
                  书名表头会跑到别人头上、或者整段消失 */}
              {/* ⚠️ **按时间排的时候不能再按书名插表头。**
                  同一本的行不再挨着，「书名变了就插一行」会插得满屏都是——
                  那时候书名归每一行自己写（见下面那行 muted） */}
              {/* ⚠️ 和**这一屏**比，不是和 `显示的全库` 比：只铺了一截的时候
                  下标对不上，书名表头会插错地方（同下面那条老注释说的病，
                  当初是拿没过滤的数组比出的错） */}
              {排序 !== '最近' && (i === 0 || 分组名(这一屏[i - 1]) !== 分组名(n)) && (
                <h3 style={{ fontSize: '.9rem', margin: '.7rem 0 .3rem' }}>
                  {分组名(n)}
                  {/* **组里几条要写出来。** 归组的用处就是「蓝的那堆一共几条」，
                      不写数字的话得自己数——而且铺到一半时数不对，所以数的是
                      `显示的全库`（筛过但没截断那份），不是这一屏 */}
                  {' '}
                  <span className="muted" style={{ fontWeight: 'normal', marginLeft: '.4rem', fontSize: '.8rem' }}>
                    {显示的全库.filter((x) => 分组名(x) === 分组名(n)).length} 条
                  </span>
                </h3>
              )}
              {/*
                * **这一档原来是个死胡同**：只列出来，点不动。
                * 「全库笔记」的用处正是「我记过一句关于 XX 的，在哪本书里来着」——
                * 找到了却去不了，等于只回答了半个问题。
                * 现在整张卡就是个按钮：点它**打开那本书、落到那一处**。
                */}
              {/*
                * **这一行原来整个是一个 `<button>`**，于是「改笔记」「删」
                * 塞不进来——按钮不能套按钮。可这一档是「我的笔记」唯一的顶层入口，
                * 看见一句写错的笔记却只能「打开那本书再改」，等于把最短的那条路堵上。
                * 现在拆成：文字那半仍然是跳转键，右边两个小键管改和删。
                */}
              <div
                className="card"
                style={{
                  marginBottom: '.4rem', padding: '.45rem .7rem',
                  display: 'flex', gap: '.5rem', alignItems: 'flex-start',
                }}
              >
                {批量 && (
                  <input
                    type="checkbox"
                    style={{ marginTop: '.2rem', flexShrink: 0 }}
                    checked={选中.has(n.kind + ':' + String(n.id))}
                    aria-label={'选中「' + (n.excerpt?.trim() || n.note || '这条') + '」'}
                    onChange={(e) => {
                      const k = n.kind + ':' + String(n.id);
                      set选中((v) => {
                        const next = new Set(v);
                        if (e.target.checked) next.add(k); else next.delete(k);
                        return next;
                      });
                    }}
                  />
                )}
                <button
                  className="find-hit"
                  style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0 }}
                  disabled={!跳到别的书 || 批量}
                  /*
                   * ⚠️ **颜色也挂在这个按钮上，别挂到里面那层 div。**
                   * tooltip 由**最近的**带 title 的祖先决定，而摘录那一行占了这一行大半——
                   * 挂在里面等于把「点它会跳回原文」这条唯一的说明盖掉，
                   * 而在「全库笔记」里那一跳正是这一行存在的理由。
                   */
                  title={[
                    跳到别的书 ? `打开《${n.title}》，跳到这条${n.kind === 'bookmark' ? '书签' : '划线'}` : '',
                    n.color ? `划的是${色名[n.color as HighlightColor] ?? n.color}` : '',
                  ].filter(Boolean).join('　') || undefined}
                  onClick={() => { 跳到别的书?.(n.bookId, n.chapterIdx); onClose(); }}
                >
                  {/* **书签上的笔记要看得出是书签。** 两种笔记摆在一列里，
                      摘录那一行长得一样，可它们回去之后是两回事：
                      划线指着具体一句话，书签指的是「这儿」。
                      书签的 `excerpt` 还可能是空的（加书签时不一定选中了文字） */}
                  {/*
                    * **摘录保持它在书里的样子**——底色衬在文字后面，和阅读器里那一条一模一样。
                    *
                    * 这一档能按颜色归组、按颜色筛、给颜色起名（「蓝＝待查」），
                    * 可**按书或按时间排的时候，一行看不出自己是什么颜色**——
                    * 而颜色在这个应用里是用户自己定的用途。
                    *
                    * ⚠️ **这一行不另摆一个小色块。** `HL_COLORS` 是 0.32–0.35 透明度、
                    * 专门衬在文字底下的，摊成一个色点压在米色卡上只有 1.25:1
                    * （不透明的黄也只有 1.87），够不到 WCAG 1.4.11 图形元件那条的 3:1——
                    * 同这一轮从表格里拿掉的空心星。衬在文字后面就没这个问题：
                    * 判的是**文字对这块底色**的对比度，深墨在淡黄上十几比一，
                    * 而这正是它在书里本来的读法。
                    *
                    * ⚠️ **别拿这段话去否掉「本书划线」那一档的 `.hl-dot`**：那个是**控件**
                    * （点它换颜色），所以它靠 1px 的 `--muted` 边框把**边界**立到 4.46:1，
                    * 颜色只负责认、不负责「看不看得清」。这一行没有那个控件，
                    * 一个纯展示的色块就只剩填充那一条路，而那条路走不通。
                    */}
                  <div style={{ fontSize: '.85rem' }}>
                    {n.kind === 'bookmark' && <span aria-hidden style={{ marginRight: '.3rem' }}>🔖</span>}
                    {n.rect && 框选记号}
                    <span style={n.color ? { background: 底色(n.color), borderRadius: '2px', padding: '0 .15rem' } : undefined}>
                      {n.excerpt?.trim() || (n.kind === 'bookmark' ? '书签' : '')}
                    </span>
                  </div>
                  {!(editing?.类 === (n.kind === 'bookmark' ? '书签' : '划线') && editing.id === n.id) && (
                    <div className="muted" style={{ fontSize: '.8rem', marginTop: '.15rem' }}>{n.note}</div>
                  )}
                  {/* **别把 `createdAt` 直接印出来**：它是 sqlite 的 UTC 文本，
                      照搬会比本地时间早八个钟头，看起来像时钟坏了。
                      判据在 `core/format.ts` 的 `whenAgo`——书签那一档早就这么做了，
                      划线和全库一直没跟上 */}
                  {/*
                    * **标签摆在笔记下面。** 颜色只有四个，标签才是说得清楚的那一维。
                    *
                    * ⚠️ **标签长什么样只有一份：`chip sm`**（`App.tsx` 那排书的标签用的就是它）。
                    * 这里原来写的是 `className="tag"`——而 **`.tag` 在整个应用里根本不是一个类**，
                    * 于是它们渲染成了裸文字：既不像标签、也和书架上那批对不上。
                    * 这种错**不报错也不影响测试**，只是看起来不对。
                    *
                    * ⚠️ 这一整块原来还**嵌在下面那个 `.muted` 里**（写《书名》·多久前那一行），
                    * 标签跟着变淡、语义上也不对。现在提到它前面。
                    */}
                  {(n.tags?.length ?? 0) > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.2rem', marginTop: '.2rem' }}>
                      {/*
                        * ⚠️ **打得上就要摘得下。** 只有「打标签」而没有「摘掉」的话，
                        * 把一批笔记标成「待查」之后**查完了就取不掉**，那个标签一直长。
                        * `highlight.untag` 这个 rpc 当时写了可界面上叫不到，
                        * `counts.mjs` 的「界面叫不到的 rpc」那一档当场把它列出来了——
                        * 同「重命名撤销」当年那次（rpc 好使、界面上根本没有入口）。
                        */}
                      {n.tags!.map((t) => (
                        <span key={t} className="chip sm" style={{ display: 'inline-flex', alignItems: 'center' }}>
                          {t}
                          {n.kind === 'highlight' && (
                            <button
                              className="mini"
                              aria-label={'把标签「' + t + '」从这条笔记上摘掉'}
                              title={'摘掉标签「' + t + '」'}
                              /*
                               * ⚠️ **点击目标至少 24×24，就算叉本身很小。**
                               * WCAG 2.2 AA 的下限是 24px，那条准则自带间距豁免（直径 24 的圆
                               * 不碰到别的目标就算合格）——**而标签是挨着摆的**，豁免圈必然相碰。
                               * 第一版 `padding: 0` + `lineHeight: 1` 量出来约 8×12，
                               * `audit.mjs` 的「点击目标偏小且挨得近」**五个分辨率各报一条**。
                               * 字形照旧小，只把可点的那块擑开。
                               */
                              style={{
                                marginLeft: '.1rem', padding: 0, border: 'none', background: 'none',
                                cursor: 'pointer', lineHeight: 1,
                                minWidth: '24px', minHeight: '24px',
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              }}
                              onClick={(e) => { e.stopPropagation(); void 摘标签(n.id, t); }}
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="muted" style={{ fontSize: '0.75rem', marginTop: '.2rem' }}>
                  {/* **组头没写书名的时候，每行自己写。** 按颜色归组时组头是用途，
                        不写的话一屏摘录看不出来自哪本书（同「最近」那一档早就踩过的） */}
                    {排序 !== '按书' && <>《{n.title}》</>}
                    {whenAgo(n.createdAt) && (
                      <span title={whenAgo(n.createdAt)!.title}>
                        {排序 !== '按书' ? ' · ' : ''}{whenAgo(n.createdAt)!.text}
                      </span>
                    )}
                  </div>
                </button>
                <div className="row" style={{ flexShrink: 0, gap: '.25rem', display: 批量 ? 'none' : undefined }}>
                  <button
                    className="mini"
                    onClick={() => {
                      const 类 = n.kind === 'bookmark' ? ('书签' as const) : ('划线' as const);
                      setEditing({ 类, id: n.id });
                      setDraft(n.note);
                      // 打开时是什么样记下来：卸载时靠它判断「改过没有」
                      pending.current = { 谁: { 类, id: n.id }, draft: n.note, base: n.note };
                    }}
                  >
                    改笔记
                  </button>
                  <button className="mini" onClick={() => void 删掉(n.kind, n.id)}>删</button>
                </div>
              </div>
              {editing?.类 === (n.kind === 'bookmark' ? '书签' : '划线') && editing.id === n.id && (
                <div style={{ marginTop: '-.2rem', marginBottom: '.4rem' }}>
                  {笔记框(n.kind === 'bookmark' ? '书签' : '划线', n.id)}
                </div>
              )}
            </div>
          ))
        )}

        {/*
          * ⚠️ **页脚要标 `modal-actions`。** 它有两层意思：
          * 一是那条 CSS 把动作行 `position: sticky` 粘在底下——这一档动辄几十条笔记，
          * 不粘住的话「导出全部」「关闭」得滚到最底才够得着；
          * 二是 `audit.mjs` 的「主按钮要不要滚才够得到」**只认这个类**，
          * 没标的话那条判据整条不跑、还一声不吭（走查自己会报「没标」，
          * 这一屏五个分辨率报的就是它）。
          */}
        {/* **还有多少没铺出来，说清楚。** 不说的话「我明明记过一条」翻到底就没了，
            看起来像笔记丢了——而它只是没铺 */}
        {tab === 'all' && 显示的全库.length > 铺 && (
          <button
            className="mini"
            style={{ width: '100%', marginTop: '.3rem' }}
            onClick={() => set铺((n) => n + 一屏)}
          >
            还有 {显示的全库.length - 铺} 条，再铺 {Math.min(一屏, 显示的全库.length - 铺)} 条
          </button>
        )}

        <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
          {/*
            * **把全部笔记导出来。** 原来只有「导出《某某》」里那一个入口，
            * 按本导——在三十本书里记过东西的人要点三十次。
            * 导出来的是一份 markdown，而书斋自己能读 `.md`：
            * 放回书库再扫一次，它就是一本可以翻的书。
            */}
          {(全库模式 || tab === 'all') && all.length > 0 && (
            <button
              style={{ marginRight: 'auto' }}
              disabled={导出中}
              onClick={() => void (async () => {
                set导出中(true);
                set导出到(null);
                try {
                  const dir = await rpc<string | null>('ui.pickFolder');
                  if (!dir) return;                   // 用户取消了选目录
                  const r = await rpc<{ path: string }>('export.allNotes', { dir });
                  set导出到(r.path);
                } catch (e) {
                  set导出到('导出失败：' + (e as Error).message);
                } finally {
                  set导出中(false);
                }
              })()}
            >
              {导出中 ? '导出中…' : '导出全部笔记…'}
            </button>
          )}
          {导出到 && (
            <span className="muted" style={{ fontSize: '.78rem', marginRight: 'auto' }}>{导出到}</span>
          )}
          <button className="primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
