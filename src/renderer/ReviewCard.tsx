import { useCallback, useState, type CSSProperties, type Ref } from 'react';
import { rpc } from './rpc.ts';
import { StarRating } from './StarRating.tsx';

/** 卡片里那三样正在编辑的东西。`base` 是打开时的短评，用来判「改没改过」 */
export interface Reviewing {
  rating: number | null;
  comment: string;
  /** 是不是「读完了」那次触发的——只影响措辞 */
  done: boolean;
  base: string;
}

interface Detail {
  rating: number | null;
  comment: string | null;
}

/**
 * 评分 + 一句短评：**阅读器和 PDF/EPUB 查看器共用这一份**。
 *
 * 原来它整个长在 `Reader.tsx` 里，于是**只有 txt 够得到**。
 * 而评分和短评存在 `reading_state` 里、按 `book_id` 记，
 * 和格式一个字的关系都没有——查看器那条右轨的说明写着
 * 「那七个键全建立在 txt 的字节偏移和章节表上，对 PDF / EPUB 一条都不成立」，
 * 那条判据是对的，**只是把评价也一起算进去了**：它是唯一的例外。
 *
 * 后果是这个应用最核心的那件事（「别再重复翻开一本烂尾的书」）在一本 PDF 上
 * 要退出查看器、回书架、找到那本书、悬停、点「评价」才做得成——
 * 而人此刻正想关掉应用。缺的不是功能，是记录成本（同「批量改阅读状态」那条）。
 *
 * 抽出来而不是抄一份：这个仓库被「抄第二份」咬过三次（`shelfCounts` 绕开
 * `buildFilter`、渲染进程自己抄了一份 `Filter`、`labels` 抄了两遍）。
 * 尤其 `closeReview` 那条判据（**Esc 存、「不用了」丢**）抄错一次就是丢用户打的字。
 */
export function useReview(bookId: number) {
  /** 一本书一次会话只问一次「读完了」。用户自己点开的那条路不看它 */
  const [asked, setAsked] = useState(false);
  const [reviewing, setReviewing] = useState<Reviewing | null>(null);

  /** 读完了：先看看这本书是不是已经评过，没评过才问 */
  const askReview = useCallback(() => {
    if (asked) return;
    setAsked(true); // 先置位，避免滚动/翻页事件连着触发好几次
    void rpc<Detail>('book.detail', { bookId })
      .then((d) => {
        // 已经打过分或写过短评的，不再打扰
        if (d.rating != null || (d.comment ?? '').trim()) return;
        setReviewing({ rating: null, comment: '', done: true, base: '' });
      })
      .catch(() => {});
  }, [asked, bookId]);

  /**
   * **随时记一句，不用等读完。**
   *
   * 最值得记的那句话（「烂尾了别看」）说的是**读不下去**，按定义永远走不到读完。
   *
   * 和 `askReview` 三处不同：不看 `asked`（这是用户自己点的，不是打扰）、
   * 已经评过的照样开、**把现在的评分和短评填进去**——
   * 空着星星去问一本已经给了 5 分的书，是在说假话。
   */
  const openReview = useCallback(() => {
    void rpc<Detail>('book.detail', { bookId })
      .then((d) => setReviewing({
        rating: d.rating, comment: d.comment ?? '', done: false, base: d.comment ?? '',
      }))
      .catch(() => setReviewing({ rating: null, comment: '', done: false, base: '' }));
  }, [bookId]);

  /**
   * 关掉评价卡片——**把没存的那句话存了**。
   *
   * 有三条路会关它：Esc、点别的浮层（互斥）、以及卡片自己那个「不用了」。
   * 前两条的语义是「关掉」＝留住，只有「不用了」是明确放弃。
   *
   * 只在真的改动过时才写：没动过就别平白多一次写库。
   */
  const closeReview = useCallback(() => {
    if (reviewing && reviewing.comment.trim() !== reviewing.base.trim()) {
      void rpc('reading.setStatus', { bookId, comment: reviewing.comment.trim() || null });
    }
    setReviewing(null);
  }, [reviewing, bookId]);

  return { reviewing, setReviewing, askReview, openReview, closeReview };
}

interface Props {
  bookId: number;
  bookTitle: string;
  value: Reviewing;
  onChange: (r: Reviewing) => void;
  /** 存完或者「不用了」——两条路都只是把卡片收掉 */
  onDone: () => void;
  /** 定位交给调用方：这张卡贴着**点开它的那个键**开（见 `anchor.ts`） */
  boxRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
}

export function ReviewCard({ bookId, bookTitle, value, onChange, onDone, boxRef, style }: Props) {
  return (
    <div className="reader-pop card review-pop" ref={boxRef} style={style}>
      {/* **一句话说清是哪本书、为什么是现在。** 原来这儿是两行小字说明
          （「读不下去了也算——下次在书架上就能看见，不用再翻一遍」），
          而这张卡的活儿只是「写一句话」：说明比要写的东西还长。
          那句话没删，挪到底下去了——**它在那儿是提示，在这儿是障碍**。 */}
      <strong className="review-head">
        {value.done ? `《${bookTitle}》读完了` : `记一句《${bookTitle}》`}
      </strong>

      {/*
        * ⚠️ 这里曾经是**手写的第五份五颗星**——而 `StarRating` 当初正是为了防这个
        * 才抽出来的。手写那份缺了整套 `aria-label` / `aria-pressed`
        * （屏幕阅读器听到五个一模一样的「★ 按钮」），也没有「再点同一颗清零」。
        */}
      <StarRating value={value.rating} onChange={(n) => onChange({ ...value, rating: n })} />

      {/*
        * **短评用 `textarea`，而且用正文那套字体和字号。**
        *
        * 原来是个单行 `input`，宽约 200px：写一句「前面三卷是神作，中间开始注水」
        * 就只看得见后半截，回头改一个字得先用方向键找。而这句话是这个应用的
        * 立身之本（「别再重复翻开一本烂尾的书」），它值一个能看全的框。
        *
        * 字体走 `--read-font` / 贴着 `--read-size`：**写出来的字和读的字长一个样**。
        * 这是这次唯一一处刻意的字体选择——别处一律界面字体、小号。
        * 它也顺带解释了这张卡为什么长这样：它是压在这张纸上的一张便条。
        */}
      <textarea
        className="review-say"
        rows={2}
        value={value.comment}
        onChange={(e) => onChange({ ...value, comment: e.target.value })}
        placeholder="一句话就够：结局怎么样？值不值得再看？"
      />

      <div className="review-foot">
        {/* 说明挪到这儿：**写之前它是障碍，写完它是承诺**——
            告诉你这句话接下来会去哪儿 */}
        <span className="muted">
          {value.done ? '记下来，下次在书架上就看得见' : '读不下去了也算，下次在书架上就看得见'}
        </span>
        <span className="row" style={{ gap: '.4rem' }}>
          {/* ⚠️ **「不用了」是真的丢掉，Esc 是收起来。** 这条不对称一直存在
              （`closeReview` 里那段），但界面上一个字都没说——两个键长得一样，
              谁也猜不到其中一个会把刚打的字扔掉。写进 title 里 */}
          <button
            className="quiet"
            title="丢掉刚写的这一句。想收起来又留着的话按 Esc"
            onClick={onDone}
          >
            不用了
          </button>
          <button
            className="primary"
            disabled={value.rating == null && !value.comment.trim()}
            onClick={() => void (async () => {
              /*
               * 两个字段都发。原来只发填了的那个——读完那次无所谓（那本书按定义还没评过），
               * 但手动打开是在**改**一条已有的评价：只发非空的话，
               * 把短评删干净再点「记下来」什么都不会发生。
               */
              await rpc('reading.setStatus', {
                bookId,
                rating: value.rating,
                comment: value.comment.trim() || null,
              });
              onDone();
            })()}
          >
            记下来
          </button>
        </span>
      </div>
    </div>
  );
}
