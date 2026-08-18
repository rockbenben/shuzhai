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
import { useEffect, useState } from 'react';
import { COLORS, type HighlightColor } from '../core/highlight.ts';
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

  /*
   * 换了一条划线（同一张卡换内容）时，草稿要跟着换。
   * 不重置的话：点开 A 写了一半、关掉、点开 B——B 的框里是 A 的字。
   */
  useEffect(() => { set写着(false); set草稿(笔记 ?? ''); }, [笔记, 颜色]);

  const 存 = () => void (async () => {
    await 存笔记(草稿.trim());
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
            onChange={(e) => set草稿(e.target.value)}
            onKeyDown={(e) => {
              // Esc 放弃这次编辑（不动库里那条），判据同笔记面板里那个行内框
              if (e.key === 'Escape') { e.stopPropagation(); set写着(false); set草稿(笔记 ?? ''); return; }
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
          <button className="mini" onClick={() => { set草稿(笔记 ?? ''); set写着(true); }}>
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
