import { useEffect, useRef, useState } from 'react';
import { ENCODINGS } from '../core/encoding.ts';
import { formatOf } from '../core/book-format.ts';
import { SERIAL_STATUS, READING_STATUS, FILE_STATUS, labelOf, SITE_LABELS } from '../core/labels.ts';
// 只引类型：cover-source 运行时带着 node:sqlite，渲染包不能碰
import type { FetchOneResult } from '../core/cover-source.ts';
// 同上，只引类型。`BookShelfMembership` 是 core 给「编辑一本书时要列出的
// 全部分类」定的形状（`shelvesForBook`），别在这儿手抄一份——加字段会漏改
import type { BookShelfMembership } from '../core/library.ts';
import { rpc } from './rpc.ts';
import { StarRating } from './StarRating.tsx';
import { Cover } from './Cover.tsx';
import { TagPicker } from './TagPicker.tsx';

export interface Detail {
  id: number;
  title: string;
  author: string | null;
  aliases: string | null;
  intro: string | null;
  serial_status: string;
  /** 主在线地址（bookDetail 从 online_link 带出）。「来源站点」显示的就是它，
   *  不再有单独的自由文本框 */
  primary_url: string | null;
  primary_site: string | null;
  note: string | null;
  /** 逗号分隔。`bookDetail` 从 `book_tag` 带出来的，形状和 `book.list` 那份一样 */
  tags: string | null;
  path: string | null;
  encoding: string | null;
  /** 这个编码是用户自己指定的（`book_file.encoding_locked`），扫描时别再探测 */
  encoding_locked?: number;
  word_count: number | null;
  chapter_count: number | null;
  /** 手填本地章数（盖过 chapter_count 的显示值）。NULL = 用自动识别 */
  chapter_count_override: number | null;
  file_status: string | null;
  reading_status: string | null;
  rating: number | null;
  comment: string | null;
  drop_reason: string | null;
  reread_count: number;
  chapter_idx: number | null;
  char_offset: number | null;
}

// 这两套原来在这里和 Settings.tsx 各有一份，导出又要第三份——收进 core/labels.ts 了
const STATUS = SERIAL_STATUS;
const READING = READING_STATUS;

/** spec §2.1 的探测顺序，用户手动指定时也是这几个 */


interface Props {
  bookId: number;
  onClose: (changed: boolean) => void;
  /**
   * 打开「在线地址」。
   *
   * **`LinksDialog` 原来是够不到的**：`setLinksFor` 全仓库从来没有被赋过值，
   * 于是 170 行的界面加 `link.list` / `addBatch` / `check` / `setPrimary` / `remove`
   * 五个 rpc 一起悬空。死 rpc 扫描抓不到这种——那几个 rpc 确实被调用了，
   * 调用者正是这个没人挂载的组件（AGENTS.md：「另一半是组件没被挂载」）。
   *
   * 入口放这儿而不是卡片上：卡片那排已经五个按钮挤满了，而这本来就是**这本书的
   * 元数据**——上面「来源站点」显示的就是这里面的主地址，两处说的是同一件事。
   */
  onLinks: (bookTitle: string) => void;
  /*
   * 这三样原来是**卡片工具条上的按钮**（章节 / 改名 / 导出），
   * 而那排是**乘以每张卡**的：一屏 8 张卡就是 40 个按钮。
   *
   * 三个都是「一本书一辈子点一次」的操作（换切分规则、改文件名、导个 EPUB），
   * 而这个弹窗本来就是这个应用**唯一的详情页**（`onLinks` 已经是这么挂的）。
   * 收进来之后卡片上只剩「编辑」和「评价」——后者是这个应用的正事。
   *
   * **只在这本书真有文件时给**：手工添的「只有记录」那类点了必然出错
   * （章节会得到「书 N 没有主文件」，改名预览一片空白）——
   * 摆一个点了必然出错的按钮，比没有更糟。
   */
  onChapters: (bookTitle: string) => void;
  onRename: () => void;
  onExport: (bookTitle: string) => void;
  /**
   * 分类那排动了（在这儿就地新建了一个）——侧栏的分类页签和计数要跟着刷新。
   *
   * 侧栏是**另一个组件**，这个弹窗够不着它那份 `cats`。不报这一声的话，
   * 刚建的分类要等下一次 `loadCounts`（关掉弹窗、改筛选、重扫）才出现，
   * 而用户此刻正站在「我刚建的那个分类」旁边，看不见它。
   */
  onCatsChanged: () => void;
}

export function BookEditor({ bookId, onClose, onLinks, onChapters, onRename, onExport, onCatsChanged }: Props) {
  const [d, setD] = useState<Detail | null>(null);
  const [form, setForm] = useState<Partial<Detail>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** 「已读完 → 在读」问那一句时开着。理由在下拉的 onChange 上 */
  const [rereadAsk, setRereadAsk] = useState(false);
  /** 有关掉会丢的改动时，问一句「放弃还是继续」。三条关法（遮罩 / 关闭键 / Esc）
      都走 `requestClose`，Esc 在下面 onKeyDown 里靠 preventDefault 拦下 App 那张总表 */
  const [confirmClose, setConfirmClose] = useState(false);
  /** 文件不见了时点「清理这条失效记录」的二次确认（同 confirmClose 的两段式，不用原生 confirm） */
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [coverVer, setCoverVer] = useState(0);
  /** 「联网补全」是点一下补一本。跑一遍书源链要开隐藏窗口，会花几秒 */
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /**
   * 手填本地章数的输入框文本。**单独一个状态、不混进 `form`**：它是数字、
   * 留空要变成 null，而且占位提示和「自动识别是几章」那行灰字都要盯着它。
   * null = 详情还没到；'' = 用户清空了（回到自动）
   */
  const [overrideText, setOverrideText] = useState<string | null>(null);
  /**
   * 这本书在**每个分类**里的归属（`shelf.forBook`）。null = 还没取回来。
   *
   * 一次全取回来，不在前端自己算规则：分类的成员＝规则命中 ∪ 手动加入，
   * 而规则那一半是 `buildFilter` 在主进程里现算的（`library.test.ts` 钉着
   * 「不存快照」）。前端自己判一遍就是第二份判据，两边迟早对不上。
   * 分类数很少（用户自建），逐个跑一次规则判定是 `shelvesForBook` 干的事。
   */
  const [shelves, setShelves] = useState<BookShelfMembership[] | null>(null);
  /** 「＋ 新建分类」那个小表单开着时的名字。null = 没开 */
  const [newCat, setNewCat] = useState<string | null>(null);

  useEffect(() => {
    rpc<Detail>('book.detail', { bookId })
      .then((x) => {
        setD(x);
        setForm(x);
        setOverrideText(x.chapter_count_override != null ? String(x.chapter_count_override) : '');
      })
      .catch((e: Error) => setError(e.message));
    // 换了一本书就重取分类；同一个弹窗里改完由各个操作自己重取（见 `归类`）
    rpc<BookShelfMembership[]>('shelf.forBook', { bookId })
      .then(setShelves)
      .catch((e: Error) => setError(e.message));
  }, [bookId]);

  const set = (k: keyof Detail, v: string) => setForm((f) => ({ ...f, [k]: v }));

  /** 重取这本书的分类归属。勾完一个分类之后要重画——规则命中的那些摘不掉，
   *  只有重算一遍才知道「现在这个勾还在不在」 */
  const 重取分类 = async () => setShelves(await rpc<BookShelfMembership[]>('shelf.forBook', { bookId }));

  /**
   * 勾上 / 摘掉一个分类（只动**手动**那一半）。
   *
   * ⚠️ **规则命中的分类点了没反应，这是有意的。** 成员＝规则命中 ∪ 手动加入，
   * 而规则那一半是现算的：摘掉手动那一笔，这本书照样在里面——勾还是亮的。
   * 「点了没反应」和「本来就该亮着」在屏幕上长得一模一样，所以那种情况
   * 干脆不给点（`disabled` + 标一个「规则」），而不是让它点了白点。
   */
  const 归类 = async (s: BookShelfMembership) => {
    setError(null);
    try {
      if (s.manual) await rpc('shelf.removeBooks', { shelfId: s.id, bookIds: [bookId] });
      else await rpc('shelf.addBooks', { shelfId: s.id, bookIds: [bookId] });
      await 重取分类();
      setChanged(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * 就地新建一个分类，并**立刻把这本书归进去**。
   *
   * 建的是**空规则**的分类——也就是纯手动分类。core 明确支持这一档
   * （`Filter.shelf` 那条注释写着「空规则 + 手动成员 = 纯手动分类」），
   * 而它正是「归类这本书时发现没有想要的分类」最常见的答案：你要的是一个筐，
   * 不是一条规则。
   *
   * ⚠️ **不在这儿复用 `CategoryDialog`**（那个带实时预览的规则编辑器）：
   * 它是**另一个 `.modal`**，而这个弹窗开着的时候再叠一层，焦点陷阱会认错
   * 最上面那一层——本文件顶上那条注释记着这个坑（`onLinks` / `onChapters` /
   * `onRename` / `onExport` 四个入口都因此先关掉自己再开子弹窗）。
   * 而在这儿关掉自己 = 用户刚打的那些书名简介全丢，代价比省一次点击大得多。
   * 要按规则自动收书的那种分类，去侧栏的分类编辑器建——那儿有实时预览。
   */
  const 建分类 = async () => {
    const name = (newCat ?? '').trim();
    if (!name) return;
    setError(null);
    try {
      const { id } = await rpc<{ id: number }>('shelf.save', { name, filter: {} });
      await rpc('shelf.addBooks', { shelfId: id, bookIds: [bookId] });
      await 重取分类();
      setNewCat(null);
      setChanged(true);
      onCatsChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /*
   * **短评和弃坑原因：收摊之前把没存的存了。**
   *
   * 这个弹窗里有两套保存语义，而且都是对的：书名作者那些跟着「保存」按钮走
   * （用户看得见那个按钮），评分/状态/短评是**改了就生效**（「点了弃坑却因为忘了
   * 按保存而没生效，是最气人的那类 bug」，注释就在上面）。
   *
   * 问题出在「改了就生效」的实现方式：星级是 onChange 立刻存，
   * **而这两个输入框是 onBlur 才存**——按 Esc 关掉弹窗不经过失焦，那句话就没了。
   * 同 `RatePopover` 那次，判据一样：**短评重扫恢复不了**。
   *
   * 这里比浮层那次多一层麻烦：这两个框是**非受控**的（`defaultValue`，
   * 本仓库明确记着别改成受控），所以 cleanup 只能从 DOM 上读当下的值。
   */
  /*
   * ⚠️ **不能在 cleanup 里读 ref 拿 DOM 的值**——试过，拿到的是 null：
   * React 卸载一棵子树时**先把 ref 置空**，`useEffect` 的 cleanup 是之后才跑的。
   * 所以草稿要一边打一边记（`onInput` 存进 ref）。
   * 用 `onInput` 而不是 `onChange` + state：这两个框是**非受控**的，
   * 本仓库明确记着别改成受控（改成受控那次「先点星、再打字、失焦」存进去的是空串）。
   */
  const draft = useRef<{ comment?: string }>({});
  const saved = useRef<{ comment: string }>({ comment: '' });
  useEffect(() => () => {
    const patch: Record<string, unknown> = {};
    const { comment: c } = draft.current;
    if (c !== undefined && c !== saved.current.comment) {
      const val = c || null;
      patch.comment = val;
      if (d?.reading_status === 'dropped') patch.dropReason = val;
    }
    if (Object.keys(patch).length > 0) void rpc('reading.setStatus', { bookId, ...patch });
  }, [bookId, d?.reading_status]);

  /** 阅读状态是**立即生效**的，不跟着「保存」走——改状态和改书名是两件事，
   *  用户点了「弃坑」却因为忘了按保存而没生效，是最气人的那类 bug */
  const saveStatus = async (patch: Record<string, unknown>) => {
    try {
      await rpc('reading.setStatus', { bookId, ...patch });
      setD(await rpc<Detail>('book.detail', { bookId }));
      setChanged(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * 返回有没有真的存上——存失败得留在原地改。
   * **保存成功就是编辑结束，弹窗关掉**（底栏「保存」和未保存卡片里的「保存并关闭」
   * 同一条路）；评分/状态那些即时生效的不受影响。
   */
  const save = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await rpc('book.update', {
        bookId,
        fields: {
          title: form.title,
          author: form.author || null,
          aliases: form.aliases || null,
          intro: form.intro || null,
          serial_status: form.serial_status,
          note: form.note || null,
          // 手填本地章数：留空 = 回到自动识别（null）；填了就交给 core 校验正整数
          chapter_count_override: overrideText && overrideText.trim() ? Number(overrideText) : null,
        },
      });
      // **重新拉一份当基线**：form 还拿着刚改的值、d 是旧的，不刷新会一直算成
      // 「有没存的改动」，存完再关反而被拦一道。同 saveStatus 里那次 re-fetch。
      const fresh = await rpc<Detail>('book.detail', { bookId });
      setD(fresh);
      setForm(fresh);
      setOverrideText(fresh.chapter_count_override != null ? String(fresh.chapter_count_override) : '');
      setConfirmClose(false);
      setChanged(true);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const reparse = async (encoding?: string) => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await rpc<{ ok: number; failed: Array<{ error: string }> }>('book.reparse', {
        bookIds: [bookId],
        encoding,
      });
      if (r.failed.length > 0) setError(r.failed[0].error);
      else {
        setMsg(encoding ? `已按 ${encoding} 重新解析` : '已重新解析');
        setD(await rpc<Detail>('book.detail', { bookId }));
        setChanged(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 文件没了、用户认了：删掉这条失效指针。跑完这本书要么整条没了（一样你的数据都没有）、
   * 要么变成「只有记录」（评价进度留着）——两种都不再有文件可编辑，所以直接关弹窗刷新。
   * 判据在 core 的 `cleanupMissing`，这儿只发 rpc。
   */
  const doCleanup = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc('library.cleanupMissing', { bookIds: [bookId] });
      onClose(true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (!d) {
    return (
      <div className="modal-backdrop" onClick={() => onClose(changed)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          {error ? <p className="danger">{error}</p> : <p className="muted">正在读取…</p>}
        </div>
      </div>
    );
  }

  const reading = {
    status: d.reading_status ?? 'none',
    rating: d.rating,
    comment: d.comment,
    drop_reason: d.drop_reason,
    chapterIdx: d.chapter_idx ?? 0,
    charOffset: d.char_offset ?? 0,
  };

  /*
   * **跟着「保存」按钮走的字段，改了没存就是脏的。** 书名、作者、别名、
   * 简介、备注、连载状态、手填章数——这几样只在 `book.update` 那一刻落库，
   * 而遮罩、关闭键、Esc 三条路本来都直接 onClose，改完手一滑就没了。
   *
   * 评分 / 阅读状态 / 短评 / 封面 / 重新解析是**改了就生效**（各自立刻 rpc），
   * 没有「丢掉」一说，**不算脏**——把它们也算进来，存完评分再关也会被拦。
   */
  const overrideVal = overrideText && overrideText.trim() ? Number(overrideText) : null;
  const overrideDirty = overrideVal === null
    ? d.chapter_count_override != null          // 把一个手填值清空了（要回到自动）
    : Number.isNaN(overrideVal) ? true          // 填了还没解析成数的东西
    : overrideVal !== d.chapter_count_override;
  const dirty =
    (form.title ?? '') !== (d.title ?? '') ||
    (form.author || '') !== (d.author || '') ||
    (form.aliases || '') !== (d.aliases || '') ||
    (form.intro || '') !== (d.intro || '') ||
    (form.note || '') !== (d.note || '') ||
    (form.serial_status ?? '') !== (d.serial_status ?? '') ||
    overrideDirty;

  /** 三条关法都从这儿走：有没存的改动先问一句，没有就直接关 */
  const requestClose = () => {
    if (dirty) { setConfirmClose(true); return; }
    onClose(changed);
  };

  const field = (label: string, key: keyof Detail, placeholder = '') => (
    <label style={{ display: 'block', marginBottom: '.6rem' }}>
      <span className="muted" style={{ fontSize: '0.85rem' }}>{label}</span>
      <input
        value={(form[key] as string) ?? ''}
        onChange={(e) => set(key, e.target.value)}
        placeholder={placeholder}
        style={{ width: '100%', marginTop: '.15rem' }}
      />
    </label>
  );

  return (
    <div
      className="modal-backdrop"
      onClick={requestClose}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // 确认正开着：Esc = 收回确认、接着编辑（别让 App 那张 Esc 总表把弹窗整个关掉）
        if (confirmClose) { e.preventDefault(); setConfirmClose(false); return; }
        // 有没存的改动：拦下 App 的关闭，先问。干净就不拦，交给 App 那张总表关
        if (dirty) { e.preventDefault(); setConfirmClose(true); }
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 0.8rem', fontSize: '1.1rem' }}>编辑《{d.title}》</h2>

        <div
          className="row"
          style={{
            alignItems: 'flex-start',
            marginBottom: '.8rem',
            outline: dragging ? '2px dashed var(--accent)' : 'none',
            outlineOffset: 4,
          }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (!file) return;
            const path = window.novel.pathForFile(file);
            if (!path) { setError('拿不到这个文件的路径'); return; }
            void (async () => {
              try {
                await rpc('cover.set', { bookId, path });
                setCoverVer((v) => v + 1);
                setChanged(true);
                setError(null);
              } catch (err) {
                setError((err as Error).message);
              }
            })();
          }}
        >
          <Cover bookId={bookId} title={d.title} version={coverVer} width={92} />
          <div>
            <div className="muted" style={{ fontSize: '0.85rem' }}>封面</div>
            <p className="muted" style={{ fontSize: '0.8rem', margin: '0.2rem 0 0.4rem' }}>
              把图片拖到这里，或者点下面的按钮。没有封面时用书名画一件素色书衣顶上。
            </p>
            <div className="row">
              {/* 联网补全是**点一下补一本**，不是后台自动跑全库。
                  书名作者会发到搜索源去，那是用户该自己决定的事 */}
              <button
                className="primary"
                disabled={fetching}
                onClick={() => void (async () => {
                  setFetching(true);
                  setFetchMsg(null);
                  try {
                    const r = await rpc<FetchOneResult>('cover.fetchOne', { bookId });
                    setCoverVer((v) => v + 1);
                    setChanged(true);
                    setFetchMsg(
                      r.status === 'ok'
                        ? `找到了（来自${r.source ? (SITE_LABELS[r.source] ?? r.source) : '搜索源'}）`
                        : (r.note ?? '几个源上都没有书名作者都对得上的，可以自己选一张'),
                    );
                  } catch (e) {
                    setFetchMsg((e as Error).message);
                  } finally {
                    setFetching(false);
                  }
                })()}
              >
                {fetching ? '正在补全…' : '联网补全'}
              </button>
              <button
                onClick={() => void (async () => {
                  const path = await rpc<string | null>('ui.pickImage');
                  if (!path) return;
                  try {
                    await rpc('cover.set', { bookId, path });
                    setCoverVer((v) => v + 1);
                    setChanged(true);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                })()}
              >
                选一张图…
              </button>
              <button
                onClick={() => void (async () => {
                  await rpc('cover.clear', { bookId });
                  setCoverVer((v) => v + 1);
                  setChanged(true);
                })()}
              >
                清除封面
              </button>
            </div>
            {fetchMsg && (
              <p className="muted" style={{ fontSize: '0.8rem', margin: '0.35rem 0 0' }}>{fetchMsg}</p>
            )}
          </div>
        </div>

        {field('书名', 'title')}
        {field('作者', 'author')}
        {field('别名（多个用逗号分隔，参与搜索匹配）', 'aliases')}
        {/*
          * 「来源站点」＝主在线地址，**不是一个能打字的框**。
          * 它原来就是个自由文本框，写的和 online_link 表里那条主地址是同一件事，
          * 两份记录必然分叉（真实库里 875 本写着站点 id、6 本写着 URL，而链接表里
          * 全都有）。地址统一在「在线地址…」里管（多条、主站、探活、取封面），
          * 这儿只读显示；没地址时「联网补全」命中也会自动带上。
          */}
        <label style={{ display: 'block', marginBottom: '.6rem' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>来源站点</span>
          {d.primary_url ? (
            <div style={{ marginTop: '.15rem', fontSize: '0.82rem', overflowWrap: 'anywhere' }}>
              <a
                href={d.primary_url}
                onClick={(e) => {
                  e.preventDefault();
                  window.open(d.primary_url!, '_blank');
                }}
                title="在浏览器里打开"
              >
                {d.primary_site ? `${d.primary_site} · ` : ''}{d.primary_url}
              </a>
            </div>
          ) : (
            <div className="muted" style={{ marginTop: '.15rem', fontSize: '0.82rem' }}>
              未记录——在下面「在线地址…」里添加，或点「联网补全」命中后自动带上
            </div>
          )}
        </label>
        {/* 书名从这儿传出去：这个弹窗手里就有 `d.title`，而 App 那头只能去
            当前那一页（最多 120 本）里 find 一遍，翻页之后的书会找不到、
            标题落成空串 */}
        <p style={{ margin: '-.3rem 0 0.7rem' }}>
          <button type="button" className="mini" onClick={() => onLinks(d.title)}>在线地址…</button>
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            　存多条网址、标主站、查打不打得开、粘网址一键补全封面/信息
          </span>
        </p>

        {/* 这本书的几件不常做的事。原来是卡片工具条上的三个按钮，
            而那排乘以每张卡——一屏八张就是 40 个 */}
        {/*
          * ⚠️ **PDF / EPUB 这类只编目的书，三个键里只有「改文件名」成立。**
          *
          * 它们没有章节、也没有可导的正文：点「章节怎么切」开出来的是一份
          * **0 章**的规则编辑器（换条规则也白搭——`parseAndStore` 对只编目的格式
          * 直接返回），点「导出」拿到的是一句「这个区间里没有章节」——
          * 一句**听起来像章节切歪了**、而其实是「这种格式压根没有正文」的话。
          *
          * 判据是这个仓库早写着的那条：**摆一个点了必然出错的按钮，比没有更糟**
          * （当年「只有记录」的书就是为此把这三个键藏掉的，只是那次的门槛是
          * 「有没有文件」，而 PDF 是**有**文件的，所以从那道门槛底下漏了过去）。
          * 改文件名照旧留着——给一个 PDF 改文件名完全成立。
          */}
        {d.path && (
          <p style={{ margin: '-.3rem 0 0.9rem', display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
            {formatOf(d.path) !== 'catalog' && (
              <button type="button" className="mini" title="这本书的章节怎么切——切得不对时可以换一条规则，先试算再决定"
                onClick={() => onChapters(d.title)}>章节怎么切…</button>
            )}
            <button type="button" className="mini" title="按模板改这本书在磁盘上的文件名。先试算给你看，改完还能撤销"
              onClick={() => onRename()}>改文件名…</button>
            {formatOf(d.path) !== 'catalog' && (
              <button type="button" className="mini" title="把这本书导成 EPUB 或 txt。原 txt 一个字节都不会动"
                onClick={() => onExport(d.title)}>导出…</button>
            )}
          </p>
        )}

        <label style={{ display: 'block', marginBottom: '.6rem' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>连载状态</span>
          <select
            value={form.serial_status ?? 'unknown'}
            onChange={(e) => set('serial_status', e.target.value)}
            style={{ width: '100%', marginTop: '.15rem' }}
          >
            {STATUS.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>

        {/*
          * **本地章数手填修正**：卡片上「连载中 · 到N章」的 N 是解析出来的，
          * 切章切错（漏切、整章没识别）时 N 就是错的。手填一个数盖过它——
          * 只改**显示**，不动解析结果（体检、更新判断仍用真实章数）。
          * 留空 = 回到自动识别。
          *
          * ⚠️ **手填值要和自动值同时摆出来**：重新解析/同名文件替换会刷新自动值，
          * 手填值不会被清掉（那是用户数据）。两者不一致时让用户看得见「漂移」，
          * 他自己决定要不要清空——别悄悄替他改。
          */}
        <label style={{ display: 'block', marginBottom: '.6rem' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>本地章数（切错了手填，留空用自动）</span>
          <input
            type="number"
            min={1}
            step={1}
            value={overrideText ?? ''}
            onChange={(e) => setOverrideText(e.target.value)}
            placeholder={d.chapter_count != null ? `自动识别：${d.chapter_count} 章` : '自动识别不到，可手填'}
            style={{ width: '100%', marginTop: '.15rem' }}
          />
          {overrideText && overrideText.trim() && (
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              自动识别为 {d.chapter_count ?? 0} 章；手填值只改书架显示，重新解析不会清掉它
            </span>
          )}
        </label>

        <label style={{ display: 'block', marginBottom: '.6rem' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>简介</span>
          <textarea
            value={form.intro ?? ''}
            onChange={(e) => set('intro', e.target.value)}
            rows={3}
            style={{ width: '100%', marginTop: '.15rem', font: 'inherit', color: 'var(--fg)', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 5, padding: '.25em .5em' }}
          />
        </label>

        {field('备注', 'note')}

        <div className="card" style={{ marginBottom: '.6rem' }}>
          <div className="row">
            <span className="muted" style={{ fontSize: '0.85rem' }}>阅读状态</span>
            <select
              value={reading.status}
              onChange={(e) => {
                /*
                 * **「已读完 → 在读」会清掉阅读位置**（spec §5.1 把它定义成「重读」），
                 * 而用户在这个下拉里选「在读」有两种意图，应用分不出来：
                 * 「我要重读一遍」和「我标错了，其实还没读完」。
                 * 穷举过 36 种状态转换，**只有这一种会动用户数据**，
                 * 而进度是铁律 3 里重扫恢复不了的。所以先问一句，别替他猜。
                 *
                 * **没有位置可丢的就不问**（读到第 0 章、章内偏移也是 0）——
                 * 判据同 `tag.delete` / `root.remove`：只有真会丢东西的才拦。
                 */
                const to = e.target.value;
                if (reading.status === 'finished' && to === 'reading'
                    && (reading.chapterIdx > 0 || reading.charOffset > 0)) {
                  setRereadAsk(true);
                  return;
                }
                void saveStatus({ status: to });
              }}
            >
              {READING.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>

            {/*
              * 两段式确认，和标签删除、移除书库文件夹是同一套手势（**不用
              * `window.confirm`**：原生模态框和这个应用的内联确认不是一套，
              * 还会挡住自动化）。两个按钮都写明白自己要干什么，
              * 而**会丢东西的那个才是 `danger`**。
              */}
            {rereadAsk && (
              <div className="card" style={{ marginTop: '.5rem' }}>
                <div style={{ fontSize: '0.85rem' }}>
                  这本书标着「已读完」，而库里还记着读到第 {reading.chapterIdx + 1} 章。
                  改成「在读」是哪个意思？
                </div>
                <div className="row" style={{ gap: '.4rem', marginTop: '.5rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => { setRereadAsk(false); void saveStatus({ status: 'reading', keepProgress: true }); }}
                  >
                    其实还没读完（留着第 {reading.chapterIdx + 1} 章）
                  </button>
                  <button
                    className="danger"
                    onClick={() => { setRereadAsk(false); void saveStatus({ status: 'reading' }); }}
                  >
                    重新读一遍（回到开头，记一次重读）
                  </button>
                  <button onClick={() => setRereadAsk(false)}>取消</button>
                </div>
              </div>
            )}

            {/*
              * **和卡片上那个评价浮层用同一个控件。**
              * 这里原来是自己写的一个下拉，还多出半星那一档（1 / 1.5 / 2 …）——
              * 于是同一个字段两套刻度：浮层给 5 颗整星，这儿给 9 档。
              * `StarRating` 抽出来正是为了这个，它的注释里就写着
              * 「以后要加半星或换成十分制，两份就得改两遍」，而这是第三份。
              *
              * **已有的半星不会被弄丢**：`StarRating` 亮的是向下取整的颗数，
              * 旁边照旧写「4.5 星」，不点就不会写回去。要改刻度改那一个组件。
              */}
            <span className="muted" style={{ fontSize: '0.85rem', marginLeft: '.5rem' }}>评分</span>
            <StarRating
              value={reading.rating}
              onChange={(n) => {
                if (n != null && n > 0 && n <= 2) {
                  void saveStatus({ rating: n, status: 'dropped' });
                } else {
                  void saveStatus({ rating: n });
                }
              }}
            />
            {d.reread_count > 0 && (
              <span className="muted" style={{ fontSize: '0.82rem' }}>已重读 {d.reread_count} 次</span>
            )}
          </div>

          <input
            // 评价与弃坑原因合一：同一件事只保留一个输入框，符合用户直觉习惯
            key={reading.status === 'dropped' ? 'dropped' : 'normal'}
            ref={() => { saved.current.comment = reading.comment ?? reading.drop_reason ?? ''; }}
            onInput={(e) => { draft.current.comment = (e.target as HTMLInputElement).value; }}
            placeholder="一句话评价，比如「烂尾了别看」"
            defaultValue={reading.comment ?? reading.drop_reason ?? ''}
            onBlur={(e) => {
              const val = e.target.value.trim() || null;
              if (reading.status === 'dropped') {
                void saveStatus({ comment: val, dropReason: val });
              } else {
                void saveStatus({ comment: val });
              }
            }}
            style={{ width: '100%', marginTop: '.4rem' }}
          />
        </div>

        {/*
          * ── 标签 ────────────────────────────────────────────
          *
          * 这一块原来**只有一个入口**：卡片上那个评价浮层（`RatePopover`）。
          * 于是「编辑这本书」点进来找不到标签——而标签和书名作者一样，
          * 是这本书自己的属性，不在详情页里说不过去。
          *
          * 打 / 摘的判据（乐观更新、失败回滚、点掉要拿 `tagId`）和浮层里
          * 是**同一份**，在 `TagPicker.tsx`；这儿只给它一个位置。
          */}
        <div className="card" style={{ marginBottom: '.6rem' }}>
          <div className="muted" style={{ fontSize: '0.85rem' }}>标签</div>
          <p className="muted" style={{ fontSize: '0.8rem', margin: '0.15rem 0 0.4rem' }}>
            点下面「用过的」直接打上，或者在框里打字回车新建。改了就生效，不跟着「保存」走。
          </p>
          <TagPicker
            bookId={bookId}
            tags={d.tags ?? null}
            /*
             * 值这一块自己存着（`TagPicker` 里那份 `mine`），所以这儿不接新值——
             * 接了也没有第二个读者。但**要报一声 `changed`**：关掉弹窗时书架
             * 得重取一次，否则侧栏那排标签开关上的数字还是旧的。
             */
            onChange={() => setChanged(true)}
            onError={setError}
          />
        </div>

        {/*
          * ── 归类 ────────────────────────────────────────────
          *
          * 数据层从迁移 27 就在（`shelf_member`：一个分类的成员＝规则命中 ∪
          * 手动加入），而**界面入口一直没补**——那条 commit 的说明最后一句是
          * 「此提交只有数据层和测试，界面入口后续补上」，而 `shelvesForBook`
          * 的注释更直白，写着「编辑一本书时要列出的全部分类」。
          * 这一块就是补上的那另一半。
          */}
        <div className="card" style={{ marginBottom: '.6rem' }}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>归类</span>
            <button
              type="button"
              className="mini"
              onClick={() => setNewCat(newCat === null ? '' : null)}
              title="建一个纯手动分类，建完直接把这本书放进去"
            >
              ＋ 新建分类
            </button>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', margin: '0.15rem 0 0.4rem' }}>
            分类平时是一条规则，符合的书自己就进去；这里勾的是额外把它放进去。
            标着「规则」的那些本来就命中，摘不掉——要去掉得改那条规则。
          </p>

          {shelves === null ? (
            <span className="muted" style={{ fontSize: '0.82rem' }}>正在读取…</span>
          ) : shelves.length === 0 ? (
            <span className="muted" style={{ fontSize: '0.82rem' }}>
              还没有分类。点上面的「＋ 新建分类」建一个；要建按规则自动收书的那种，
              去侧栏的「＋ 新建分类」，那儿能一边改规则一边看圈中了谁。
            </span>
          ) : (
            <div className="chip-row">
              {shelves.map((s) => (
                <button
                  key={s.id}
                  className="chip"
                  aria-pressed={s.manual || s.ruleHit}
                  /* 规则命中的不可点，理由见 `归类` 那段注释 */
                  disabled={s.ruleHit}
                  onClick={() => void 归类(s)}
                  title={
                    s.ruleHit
                      ? '这条分类的规则本来就命中它——摘不掉，要去掉得改那条规则'
                      : s.manual ? '点一下从这条分类里摘掉' : '点一下加进这条分类'
                  }
                >
                  {s.name}
                  {s.ruleHit && <span className="chip-n">规则</span>}
                </button>
              ))}
            </div>
          )}

          {newCat !== null && (
            <div className="row" style={{ marginTop: '.5rem', gap: '.4rem', flexWrap: 'wrap' }}>
              <input
                autoFocus
                value={newCat}
                placeholder="新分类的名字"
                onChange={(e) => setNewCat(e.target.value)}
                onKeyDown={(e) => {
                  // 回车就建。**Esc 在这儿只收起这个小表单**，别让它冒到遮罩上
                  // ——遮罩那条管的是「关整个弹窗」，而用户此刻想关的是这一行
                  if (e.key === 'Enter') void 建分类();
                  if (e.key === 'Escape') { e.stopPropagation(); setNewCat(null); }
                }}
                style={{ flex: 1, minWidth: '8rem' }}
              />
              <button className="primary" disabled={!newCat.trim()} onClick={() => void 建分类()}>
                建好并归类
              </button>
              <button onClick={() => setNewCat(null)}>取消</button>
            </div>
          )}
        </div>

        {/* **没文件（手工添的、或清理后只剩记录的书）就没有这张卡**——编码、章数、
            重新解析全是关于文件的，摆给一本没有文件的书只是噪音。 */}
        {d.path && d.file_status === 'missing' ? (
          /*
           * **文件没了：打开、重解都无从谈起，给一条能直接了结它的路。**
           * 原来这儿只印一个红的 `missing`，点开书报错时给的引导又是「整理数据库」——
           * 而自己删掉的唯一文件整理数据库也清不掉，它只能挂一辈子「文件不见了」。
           * 两段式确认同 confirmClose：这一下会删记录（你的评价进度都留着，变「只有记录」）。
           */
          <div className="card" style={{ fontSize: '0.85rem', borderColor: 'var(--danger)' }}>
            <div className="danger" style={{ fontWeight: 600 }}>文件已经不在原位置了</div>
            <div className="muted" style={{ overflowWrap: 'anywhere', marginTop: '.2rem' }}>{d.path}</div>
            <div style={{ marginTop: '.4rem' }}>
              你可能在应用外删了它、或挪走了文件夹。清理会删掉这条记录：你写过评价、进度、标签的，
              书留着变成「只有记录」；一样没写过的，连书一起移走。
            </div>
            {confirmCleanup ? (
              <div className="row" style={{ marginTop: '.5rem', gap: '.4rem' }}>
                <button onClick={() => setConfirmCleanup(false)} disabled={busy}>取消</button>
                <button className="danger" disabled={busy} onClick={() => void doCleanup()}>确实清理</button>
              </div>
            ) : (
              <div className="row" style={{ marginTop: '.5rem' }}>
                <button className="danger" onClick={() => setConfirmCleanup(true)}>清理这条失效记录…</button>
              </div>
            )}
          </div>
        ) : d.path ? (
          <div className="card" style={{ fontSize: '0.85rem' }}>
            <div className="muted" style={{ overflowWrap: 'anywhere' }}>{d.path}</div>
            <div style={{ marginTop: '.3rem' }}>
              {/* **锁住了要显示出来。** 不说的话，「我选的编码怎么又变了」和
                  「我选的编码一直没变」在屏幕上长得一模一样——
                  同本文件那条：界面必须显示正在生效的状态 */}
              编码 <strong>{d.encoding ?? '未知'}</strong>
              {d.encoding_locked ? <span className="muted">（你指定的）</span> : null} · {d.chapter_count ?? 0} 章 ·{' '}
              {d.word_count ?? 0} 字
              {d.file_status && d.file_status !== 'ok' && (
                <span className="danger"> · {labelOf(FILE_STATUS, d.file_status)}</span>
              )}
            </div>
            <div className="row" style={{ marginTop: '.5rem' }}>
              <button
                title="用系统默认程序打开这个文件"
                onClick={() => void rpc('ui.openFile', { path: d.path }).catch((e: Error) => setError(e.message))}
              >
                打开文件
              </button>
              <button
                title="在文件管理器里定位到它（文件在哪个文件夹、改名挪位置都在这儿办）"
                onClick={() => void rpc('ui.revealFile', { path: d.path }).catch((e: Error) => setError(e.message))}
              >
                打开所在目录
              </button>
              <button onClick={() => reparse()} disabled={busy}>重新解析</button>
              <select
                defaultValue=""
                disabled={busy}
                onChange={(e) => e.target.value && reparse(e.target.value)}
                title="乱码时手动指定编码重新解析"
              >
                <option value="">按指定编码重解…</option>
                {ENCODINGS.map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
                {/* **凡是能锁住的东西都得有一条解锁的路**（同规则编辑器的「清除规则」）。
                    挑错一次就再也回不到自动探测，那是个死胡同 */}
                {d.encoding_locked ? <option value="auto">回到自动探测</option> : null}
              </select>
            </div>
          </div>
        ) : null}

        {/*
          * **有关掉会丢的改动时拦一道。** 两段式内联确认，同下拉里「已读完→在读」
          * 那一句、标签删除、移除书库文件夹一个手势（**不用 window.confirm**：
          * 原生模态和这个应用的内联确认不是一套，还挡自动化）。
          * 三条关法（遮罩 / 关闭 / Esc）汇到 `requestClose` 才开得了这一层；
          * 「放弃修改」是会丢东西的那个，所以它是 danger。焦点默认落在「继续编辑」
          * 上——手滑敲回车也是安全的那一边。
          */}
        {confirmClose && (
          <div className="card" style={{ marginBottom: '.6rem', borderColor: 'var(--danger)' }}>
            <div style={{ fontSize: '0.9rem' }}>
              书名、作者、简介这些改动还没保存，关掉就丢了。要怎么办？
            </div>
            <div className="row" style={{ gap: '.4rem', marginTop: '.5rem', flexWrap: 'wrap' }}>
              <button autoFocus onClick={() => setConfirmClose(false)}>继续编辑</button>
              <button
                className="primary"
                disabled={busy || !form.title}
                onClick={() => void save().then((ok) => { if (ok) onClose(true); })}
              >
                保存并关闭
              </button>
              <button className="danger" onClick={() => onClose(changed)}>放弃修改并关闭</button>
            </div>
          </div>
        )}

        {error && <p className="danger" style={{ marginBottom: 0 }}>{error}</p>}
        {msg && <p style={{ color: 'var(--accent)', marginBottom: 0 }}>{msg}</p>}

        <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
          <button onClick={requestClose}>关闭</button>
          <button
            className="primary"
            onClick={() => void save().then((ok) => { if (ok) onClose(true); })}
            disabled={busy || !form.title}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
