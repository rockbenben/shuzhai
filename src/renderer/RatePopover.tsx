import { useCallback, useEffect, useRef, useState } from 'react';
import { 滚动方式 } from './settings.ts';
import { rpc } from './rpc.ts';
import { StarRating } from './StarRating.tsx';
import { TagPicker } from './TagPicker.tsx';

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
  onChanged: (patch: { rating?: number | null; comment?: string | null; tags?: string; reading_status?: string | null }) => void;
  onClose: () => void;
}

/**
 * 单本评价（个人评价体系，见 specs/2026-08-14-personal-reviews-design.md）。
 *
 * 形状由一条判断定死：**触发场景是「咦这本好像读过」，顺手标一下**。
 * 所以它是贴着卡片的小浮层而不是全屏对话框，而且**没有保存按钮**——
 * 星级点了就存、短评失焦或回车就存、标签点了就存。
 * 多一次「还得点保存」，这事就不会真的发生。
 *
 * ⚠️ **标签那一段不在这个文件里了**（`TagPicker.tsx`）：编辑弹窗也要
 * 就地打标签，而两处各写一份必然分叉。这里只剩「宿主」那部分——
 * 短评、星级，以及给标签区腾出高度的那次重新量尺寸。
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

  /*
   * **开出来就得看得见。** 浮层是 `top: 100%` 挂在卡片下面的，卡片靠近视口下沿时
   * 它整个开在折叠线以下——760×520 上量到顶边 y=551，而视口只有 520 高。
   * 封顶高度只治「太高」，治不了「开在下面」。
   *
   * 用 `block: 'nearest'` 让浏览器自己算要不要滚、滚多少：够得着就一动不动，
   * 够不着才把它带进来。自己算翻转/夹取是在重写一遍浏览器已经有的东西。
   * 滚动方式走那处统一判断——系统开了「减少动态效果」就直接跳过去。
   *
   * ⚠️ **抽成 `量一次` 是为了让标签区能叫得动它。**
   * 原来这是一个 `useEffect(..., [all])`，靠「用过的标签」那个数组当依赖——
   * 标签是异步来的、还会随增删变，它们会把浮层撑高，**只在挂载那一刻量
   * 等于按空浮层做决定**。而标签那一块现在搬进 `TagPicker` 了，宿主手上
   * 没有那个数组，所以改由它内容一变就报一声（`onGrow`）。
   */
  const 量一次 = useCallback(() => {
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
  }, []);

  // 挂载时先量一次（那时浮层里已经有星星和短评框了），之后标签区一变再量
  useEffect(() => { 量一次(); }, [量一次]);

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

  /*
   * **开的时候焦点进得来，关的时候还给开它的那个键。**
   *
   * 阅读界面那几层靠 `anchor.ts` 的 `use浮层焦点` 做这件事，这一层不归它管
   * （浮层是 CSS 挂在卡片下面的，不贴着某颗键量出来的位置开）。
   * 实测原来这一层打开后 `activeElement` 还在卡片外——**打分和写短评是这个应用
   * 唯一不可再生的内容**，键盘用户够不到它就是没做这件事。
   *
   * ⚠️ 归还只在焦点「无家可归」时做（浮层一摘掉 `activeElement` 就掉回 body）——
   * 用户自己点到别处去了就别抢，同 `use浮层焦点` 那条。
   */
  useEffect(() => {
    const 层 = box.current;
    if (!层) return;
    const 来处 = document.activeElement as HTMLElement | null;
    const 第一个 = 层.querySelector<HTMLElement>('button, input, textarea');
    if (第一个 && !层.contains(document.activeElement)) 第一个.focus();
    return () => {
      const 现在 = document.activeElement;
      if ((!现在 || 现在 === document.body) && 来处?.isConnected) 来处.focus();
    };
  }, []);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        await rpc('reading.setStatus', { bookId, ...patch });
        setError(null);
        onChanged({
          ...patch,
          ...(patch.status !== undefined ? { reading_status: patch.status as string } : {}),
        });
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [bookId, onChanged],
  );

  /** 清零的判断在 StarRating 里做，这里只管存。1星、2星都是弃坑 */
  const setStar = (next: number | null) => {
    setStars(next);
    const patch: Record<string, unknown> = { rating: next };
    if (next != null && next > 0 && next <= 2) {
      patch.status = 'dropped';
    }
    void save(patch);
  };

  return (
    <div className="rate-pop" ref={box} onClick={(e) => e.stopPropagation()}>
      {/* 原来这一层第一行光是书名（一个 div，不是标题），整层没有一句说这是干什么的、
          写完了要不要按什么。而阅读界面那张同动作的卡印的是「记一句《书名》」+
          「记下来」/「不用了」两颗。**两台保存模型不同（这台失焦即落库），
          但每一台都得自己说清自己**——所以这里补标题 + 一句自述，
          不去加一颗假的「记下来」（那是骗人，它本来就是即时保存） */}
      <h3 className="rate-title" title={bookTitle}>记一句《{bookTitle}》</h3>
      <p className="muted" style={{ margin: '.1rem 0 .35rem', fontSize: '.74rem' }}>
        点星、打完字就记下了，不用按保存。
      </p>

      <StarRating value={stars} hover={hover} onHover={setHover} onChange={setStar} />

      <input
        className="rate-comment"
        placeholder="一句话评价，比如「烂尾了别看」"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== (comment ?? '')) void save({ comment: text || null }); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />

      {/* 打标签 / 摘标签和编辑弹窗里是**同一份**（`TagPicker.tsx`）。
          两个界面各写一份的话，「失败就退回去」「点掉要拿 tagId」这些判据
          迟早分叉——同 `NoteCard` / `ReaderChrome` 那两次的理由。 */}
      <TagPicker
        bookId={bookId}
        tags={tags}
        onChange={(t) => onChanged({ tags: t })}
        onError={setError}
        onGrow={量一次}
      />

      {error && <p className="danger" style={{ margin: '0.4rem 0 0', fontSize: '0.82rem' }}>{error}</p>}

      {/* 出口。这一层是**失焦即落库**，没有「保存」可按，但「收起」照样要写出来——
          判据同目录那一层那句「只有写出来的那个才算入口」：Esc 和点外面是隐藏的，
          而这一层原来一颗出口键都没有，用户写完不知道自己是站在哪儿的。
          ⚠️ 它叫「收起」不叫「关闭」也不叫「不用了」：东西不会丢，只是把这层挪开 */}
      <div className="pop-foot">
        <button className="quiet" onClick={onClose}>收起</button>
      </div>
    </div>
  );
}
