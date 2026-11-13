/**
 * 点在一条划线上之后那张卡**里面长什么样**——两个阅读界面共用这一份。
 *
 * ── 为什么要抽出来 ──────────────────────────────────────
 *
 * 抽之前它是两份，而且**已经分叉了**：`FileViewer` 那张对没写笔记的划线
 * 也照开（写一句「这条划线没写笔记。」），`Reader` 那边**一点就删**。
 * 更难看的是 `FileViewer` 那段注释白纸黑字写着「判据和 txt 阅读器那张卡一样」——
 * 一句已经不成立的话。本仓库那条老毛病（同一件事两份实现必然分叉）的又一次。
 *
 * ── 这张卡为什么要能改 ──────────────────────────────────
 *
 * 抽之前它只能「看」和「删」：**给一条已经划好的线补一句笔记，在阅读界面里没有路**，
 * 得开笔记面板、在几十条里找到它、再点「写笔记」。而「先划下来、回头再写为什么」
 * 恰恰是这类应用最常见的动作（MarginNote 的「Modify Existing Excerpts」整节讲的就是它）。
 * 换颜色同理：颜色现在**代表用途**（黄＝好句、蓝＝待查），
 * 「读到一半发现这条其实是待查」是个真实的动作。
 *
 * ⚠️ **只管卡片里面**。往哪儿贴、贴不下怎么翻到上面去，两边各有各的算法
 * （`贴住` / `贴着`，一个量的是正文栏、一个还要处理 iframe），那部分不共用。
 */
import { useEffect, useRef, useState } from 'react';
import { COLORS, type HighlightColor } from '../core/highlight-data.ts';
import { 底色, use色名 } from './highlight-view.ts';

interface Props {
  /** 当前这条划线的笔记。null / 空串都算「还没写」 */
  笔记: string | null;
  /** 当前颜色。库里那一列是 string，认不出的按黄的显示（同 `底色`） */
  颜色: string;
  /** 存笔记。空串表示「清掉这条笔记」，由调用方转成 null */
  存笔记: (note: string) => Promise<void> | void;
  改颜色: (c: HighlightColor) => Promise<void> | void;
  删掉: () => Promise<void> | void;
  关闭: () => void;
  /**
   * **只属于某一个界面的键，从这里递进来。**
   *
   * 这张卡两个阅读界面共用一份（当初就是因为拄两份分叉了才抽出来的），
   * 所以**不把 PDF 的概念写进来**：「把框选那一块存成图片」只对 PDF 成立，
   * txt 那边没有「那一块」。给一个插槽，谁用谁填。
   */
  额外?: React.ReactNode;
}

export function NoteCard({ 笔记, 颜色, 存笔记, 改颜色, 删掉, 关闭, 额外 }: Props) {
  const 色名 = use色名();
  const [写着, set写着] = useState(false);
  const [草稿, set草稿] = useState(笔记 ?? '');

  /**
   * **正在写的那一份**：草稿 + 它原来那句 + 存到哪儿。
   *
   * ⚠️ **「原来那句」只在开始写的时候定下来**——换了划线之后 `笔记` 那个属性
   * 已经变了，拿它当基准会判错：该存的那份就存不上（而「没改过就别存」那条
   * 判据也跟着废了）。
   */
  const 写的 = useRef<{ 草稿: string; 原: string; 存: (n: string) => Promise<void> | void } | null>(null);

  /**
   * **把还没存的那份写回去。**
   *
   * ⚠️ **判据：没在写、或者和原来那句一模一样，就不写。**
   * 后半句护的是「点开一张有笔记的划线、什么也没改就关掉」——那次「保存」
   * 会把用户写的那句笔记抹成空。
   */
  const 存没存的 = () => {
    const w = 写的.current;
    if (!w) return;
    写的.current = null;
    if (w.草稿.trim() !== w.原.trim()) void w.存(w.草稿.trim());
  };

  /*
   * **关掉这张卡时，把写了一半的笔记存了。**
   *
   * 判据同笔记面板那个行内框（`HighlightsPanel.tsx`）：**用户在改的东西，
   * 关掉的时候要留住**——只有写着「取消」的那个动作才允许丢。笔记是用户
   * 打的字，重扫恢复不了。
   *
   * ⚠️ **原来这张卡没有这一层**，于是三条路都在丢打了一半的字：
   * 点「关闭」、切一章、**正文滚一下**（阅读器那边滚一下就把卡收掉——
   * 而它自己的注释写着「滚一下就把它连同字一起收掉，是这个仓库最忌讳的那种
   * 「悄悄丢用户打的字」」，那道防护当时只加在「刚划的那段」那张卡上）。
   *
   * ⚠️ **Esc 仍然放弃**：它把 `写的.current` 清了，下面两处看见「没在写」
   * 就不写。「取消」和「关掉」是两件事，一个显式、一个顺手。
   */
  useEffect(() => () => { 存没存的(); }, []);

  /*
   * 换了一条划线（同一张卡换内容）时，草稿要跟着换。
   * 不重置的话：点开 A 写了一半、关掉、点开 B——B 的框里是 A 的字。
   *
   * ⚠️ **换内容之前先把上一条那份没存的存了**——这也是「关掉」的一种，
   * 只是这张卡**没有被卸载**（点开另一条划线走的是换 props）。
   * 只重置不存，打了一半的字就这么没了。
   */
  useEffect(() => {
    存没存的();
    set写着(false);
    set草稿(笔记 ?? '');
  }, [笔记, 颜色]);

  const 存 = () => void (async () => {
    const 词 = 草稿.trim();
    const 认领 = 写的.current;
    /*
     * ⚠️ **先认领再存。**存完之后宿主会把 `笔记` 换成存进去那句——
     * 那个属性一变，上面那条「换内容」的 effect 就跑了，它会**再存一遍**。
     * （同一句话写两遍，值是一样的，但那是白跑一趟 rpc。）
     *
     * 存失败要把那份草稿**还回去**：它还在输入框里（`草稿` 没清），
     * 而关掉卡片时还得靠它兜住。
     */
    写的.current = null;
    try {
      await 存笔记(词);
    } catch (e) {
      写的.current = 认领;
      throw e;
    }
    set写着(false);
  })();

  return (
    <>
      {写着 ? (
        <div className="row" style={{ width: '100%' }}>
          <input
            autoFocus
            value={草稿}
            style={{ flex: 1, minWidth: 0 }}
            placeholder="记一句：为什么划这里"
            aria-label="给这条划线写笔记"
            onChange={(e) => {
              const v = e.target.value;
              set草稿(v);
              if (写的.current) 写的.current.草稿 = v;
            }}
            onKeyDown={(e) => {
              // Esc 放弃这次编辑（不动库里那条），判据同笔记面板里那个行内框
              if (e.key === 'Escape') {
                e.stopPropagation();
                写的.current = null;   // ← 放弃：真的不存
                set写着(false);
                set草稿(笔记 ?? '');
                return;
              }
              /*
               * ⚠️ **中文输入法选词的回车是确认候选词，不是提交。**
               * 这个仓库在阅读器的笔记输入框上踩过一次（da6ab94），
               * 笔记面板那个行内框也带着同款防护——第三处，判据一模一样。
               */
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              存();
            }}
          />
          <button onClick={存}>存</button>
        </div>
      ) : (
        <p className={`note-say${笔记?.trim() ? '' : ' muted'}`}>
          {笔记?.trim() || '这条划线还没写笔记。'}
        </p>
      )}

      {/* **换颜色：颜色是这条划线的分类，读到一半改主意是常事。**
          色块上写的是用户自己定的用途（黄＝好句、蓝＝待查），不是「黄绿蓝粉」 */}
      {!写着 && (
        <div className="row" style={{ gap: '.3rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {COLORS.map((c) => (
            <button
              key={c}
              className="hl-dot"
              aria-label={'换成「' + 色名[c] + '」'}
              aria-pressed={颜色 === c}
              title={色名[c]}
              style={{
                background: 底色(c),
                width: '1.3rem', height: '1.3rem',
                outline: 颜色 === c ? '2px solid var(--accent)' : 'none',
                outlineOffset: '1px',
              }}
              onClick={() => void 改颜色(c)}
            />
          ))}
        </div>
      )}

      <div className="note-keys">
        <button className="quiet" onClick={关闭}>关闭</button>
        {!写着 && (
          <button className="mini" onClick={() => {
            写的.current = { 草稿: 笔记 ?? '', 原: 笔记 ?? '', 存: 存笔记 };
            set草稿(笔记 ?? '');
            set写着(true);
          }}>
            {笔记?.trim() ? '改笔记' : '写笔记'}
          </button>
        )}
        {/* 笔记就印在这个按钮上面那一行，用户看着它按的——所以这一路带 confirmed。
            闸挡的是**看不见笔记**的那些路（外部接口、批量） */}
        {额外}
        <button className="danger mini" onClick={() => void 删掉()}>
          {笔记?.trim() ? '删掉划线和笔记' : '删掉划线'}
        </button>
      </div>
    </>
  );
}
