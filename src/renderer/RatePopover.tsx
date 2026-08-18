import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { 滚动方式 } from './settings.ts';
import { rpc } from './rpc.ts';
import type { Tag } from '../core/library.ts';
import { StarRating } from './StarRating.tsx';

interface Props {
  bookId: number;
  bookTitle: string;
  rating: number | null;
  comment: string | null;
  /** 逗号分隔，book.list 直接给的那个 */
  tags: string | null;
  /**
   * 改了任何一样就回调，**带上新值**。
   *
   * 原来是回调一声让书架 `refresh()`——那会把已加载的书全部重取一遍。
   * 滚到第 3000 本时点一颗星，就要重取 3000 本（实测 3840 本 = 64ms + 1.3MB）
   * 再整树重渲染。而新值这儿本来就有，直接给出去，书架改那一张卡就行。
   */
  onChanged: (patch: { rating?: number | null; comment?: string | null; tags?: string }) => void;
  onClose: () => void;
}

/** 最多列几个「用过的标签」。再多一排就放不下，也就失去了「点一下就上」的意义 */
const QUICK_TAGS = 12;

/**
 * 单本评价（个人评价体系，见 specs/2026-08-14-personal-reviews-design.md）。
 *
 * 形状由一条判断定死：**触发场景是「咦这本好像读过」，顺手标一下**。
 * 所以它是贴着卡片的小浮层而不是全屏对话框，而且**没有保存按钮**——
 * 星级点了就存、短评失焦或回车就存、标签点了就存。
 * 多一次「还得点保存」，这事就不会真的发生。
 */
export function RatePopover({ bookId, bookTitle, rating, comment, tags, onChanged, onClose }: Props) {
  const [stars, setStars] = useState<number | null>(rating);
  const [hover, setHover] = useState<number | null>(null);
  /**
   * 短评用**受控** state，不用 defaultValue。
   *
   * 点一颗星会 `onChanged()` → 书架改那张卡 → 这个组件带着新 props 重渲染。
   * 非受控输入框在这种情况下，DOM 里的值和 React 的认知会脱节——实测
   * 「先点星、再打字、失焦」存进去的是**空串**。受控之后这条路是死的。
   */
  const [text, setText] = useState(comment ?? '');
  const [mine, setMine] = useState<string[]>(() =>
    (tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
  );
  const [all, setAll] = useState<Tag[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  /*
   * **收摊之前把没存的那句话存了。**
   *
   * 短评本来只在 `onBlur` 里存。而关掉这个浮层有三条路，**其中一条不经过失焦**：
   * 按 Esc（App 那张「关掉最上面一层」的表直接 `setRating(null)`，
   * 光标还在输入框里，React 卸载组件时不会补一个 blur）。
   * 也就是「打了一半按 Esc」= 那句话没了——而短评重扫恢复不了。
   *
   * 点外面和点关闭按钮那两条是安全的（mousedown 会先把焦点挪走、blur 先跑），
   * 但**安全得很偶然**：它靠的是浏览器的事件顺序，而不是这段代码说了算。
   * 卸载时兜一次，三条路就都稳了。
   *
   * ref 存草稿是必要的：cleanup 里读到的必须是**最后一次**输入，
   * 而不是这个 effect 建立时那一刻的闭包值。
   */
  const pending = useRef({ text, comment });
  pending.current = { text, comment };
  useEffect(() => () => {
    const { text: t, comment: c } = pending.current;
    if (t !== (c ?? '')) void rpc('reading.setStatus', { bookId, comment: t || null });
  }, [bookId]);

  useEffect(() => {
    void rpc<Tag[]>('tag.list').then(setAll).catch(() => {});
  }, []);

  /*
   * **开出来就得看得见。** 浮层是 `top: 100%` 挂在卡片下面的，卡片靠近视口下沿时
   * 它整个开在折叠线以下——760×520 上量到顶边 y=551，而视口只有 520 高。
   * 封顶高度只治「太高」，治不了「开在下面」。
   *
   * 用 `block: 'nearest'` 让浏览器自己算要不要滚、滚多少：够得着就一动不动，
   * 够不着才把它带进来。自己算翻转/夹取是在重写一遍浏览器已经有的东西。
   * 滚动方式走那处统一判断——系统开了「减少动态效果」就直接跳过去。
   */
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    /*
     * ⚠️ **`scrollIntoView` 治不了「下面根本没得滚」。**
     *
     * 上面那段说的是「够不着就把它带进来」，而卡片在**最后一排**时，
     * 滚动容器下面没有内容可滚，浏览器就一动不动。加了一对同名不同格式的书
     * （测试库从 9 本变 11 本）之后当场量到：760×520 浮层 345~677 / 视口 520，
     * **出界 157px**；1280×720 出界 107px。1440 以上不出界——
     * 也就是说这条一直在，只是原来那个库的卡片摆不到那个位置上。
     *
     * 所以先挑边：**下面放不下、而上面更宽敞，就翻到卡片上方**。
     * 判据里不写魔法数字——比的是「浮层多高」和「两边各有多少」。
     * `max-height: 70vh` 照旧生效，翻上去也不会顶穿。
     *
     * ⚠️ 这个 effect 要跟着 `all`（用过的标签）重跑：标签是异步来的，
     * 它们会把浮层撑高，**只在挂载那一刻量等于按空浮层做决定**。
     */
    const 卡 = (el.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    if (卡) {
      const 下面 = window.innerHeight - 卡.bottom;
      const 上面 = 卡.top;
      const 翻 = el.offsetHeight > 下面 && 上面 > 下面;
      el.classList.toggle('flip-up', 翻);
      /*
       * ⚠️ **光翻转不够，翻到宽敞那边照样可能装不下。**
       *
       * 只加翻转那一版当场量到：1280×720 好了，而 760×520 从
       * 「下面出界 157px」变成「**上面出界 129px**」——浮层 332 高，
       * 卡片上方 203、下方 175，挑了大的那边仍然不够。
       * 那个窗口只有 520 高、卡片自己占 142，**本来就没有 332 的地方**。
       *
       * 所以按选中那一边的实际空间再封一次顶。`70vh` 那条判据不在这儿重写，
       * 用 `min()` 让它继续生效（整段理由在 `styles.css` 的 `.rate-pop` 上）。
       * 结果是小窗口上浮层变矮、里面可以滚——**比五颗星整个落在屏幕外强**。
       */
      const 空 = Math.max(上面, 下面) - 10;
      if (空 > 0) el.style.maxHeight = `min(70vh, ${Math.round(空)}px)`;
    }
    el.scrollIntoView({ block: 'nearest', behavior: 滚动方式() });
  }, [all]);

  // 点外面就关掉。**捕获阶段监听**——卡片本身也有点击处理（点封面会开阅读器），
  // 冒泡阶段会先被它吃掉。
  //
  // Esc 不在这儿管了：App 有一张「关掉最上面那一层」的表，评价浮层是其中一层。
  // 两边都挂一个监听不会出错（都指向同一层，幂等），但那是同一个机制的两份实现
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [onClose]);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        await rpc('reading.setStatus', { bookId, ...patch });
        setError(null);
        onChanged(patch);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [bookId, onChanged],
  );

  /** 清零的判断在 StarRating 里做，这里只管存 */
  const setStar = (next: number | null) => {
    setStars(next);
    void save({ rating: next });
  };

  const addTag = async (raw: string) => {
    const name = raw.trim();
    if (!name || mine.includes(name)) { setDraft(''); return; }
    setMine((m) => [...m, name]);
    setDraft('');
    try {
      await rpc('tag.add', { bookIds: [bookId], names: [name] });
      setAll(await rpc<Tag[]>('tag.list'));
      onChanged({ tags: [...mine, name].join(',') });
    } catch (e) {
      setMine((m) => m.filter((x) => x !== name)); // 失败就退回去，别让界面撒谎
      setError((e as Error).message);
    }
  };

  const dropTag = async (name: string) => {
    const t = all.find((x) => x.name === name);
    setMine((m) => m.filter((x) => x !== name));
    if (!t) return;
    try {
      await rpc('tag.remove', { bookIds: [bookId], tagId: t.id });
      onChanged({ tags: mine.filter((x) => x !== name).join(',') });
    } catch (e) {
      setMine((m) => [...m, name]);
      setError((e as Error).message);
    }
  };

  /** 用过的标签里，这本还没打上的那些。打过的已经在上面显示成可点掉的小块了 */
  const quick = useMemo(
    () => all.filter((t) => !mine.includes(t.name)).slice(0, QUICK_TAGS),
    [all, mine],
  );
  /** 边打边补全。空输入时不显示——那时候上面那排「用过的」本来就在 */
  const matches = useMemo(() => {
    const q = draft.trim();
    if (!q) return [];
    return all.filter((t) => !mine.includes(t.name) && t.name.includes(q)).slice(0, 8);
  }, [all, mine, draft]);


  return (
    <div className="rate-pop" ref={box} onClick={(e) => e.stopPropagation()}>
      <div className="rate-title" title={bookTitle}>{bookTitle}</div>

      <StarRating value={stars} hover={hover} onHover={setHover} onChange={setStar} />

      <input
        className="rate-comment"
        placeholder="一句话评价，比如「烂尾了别看」"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== (comment ?? '')) void save({ comment: text || null }); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />

      {mine.length > 0 && (
        <div className="rate-tags">
          {mine.map((t) => (
            <button key={t} className="chip on" onClick={() => void dropTag(t)} title="点掉">
              {t} ×
            </button>
          ))}
        </div>
      )}

      <input
        className="rate-tag-input"
        value={draft}
        placeholder="加标签，回车新建"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void addTag(draft); }}
      />

      {(matches.length > 0 ? matches : quick).length > 0 && (
        <div className="rate-tags">
          {(matches.length > 0 ? matches : quick).map((t) => (
            <button key={t.id} className="chip" onClick={() => void addTag(t.name)}>
              {t.name}
              <span className="muted"> {t.count}</span>
            </button>
          ))}
        </div>
      )}

      {error && <p className="danger" style={{ margin: '.4rem 0 0', fontSize: '.82rem' }}>{error}</p>}
    </div>
  );
}
