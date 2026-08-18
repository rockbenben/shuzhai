import { Fragment } from 'react';
import type { Book } from './App.tsx';
import { RatePopover } from './RatePopover.tsx';
import { sqlTime, whenAgo } from '../core/format.ts';

/**
 * 「我的书评」那一档的样子。**它不是封面墙。**
 *
 * 这个应用的立身之本是「下次不用再想这本我看过没」，兑现它的东西只有一样：
 * 我自己写下的那句判词。而在这一档里，那句话原来和别处一样被塞进封面底下
 * `.book-note` 那两行 0.72rem 的小字里——量过的，**一张卡最多印得下 22–26 个字**，
 * 再长就是省略号。也就是说：这个应用唯一不可再生、也唯一算得上「我的」的内容，
 * 在专门为它开的那一档里，占的地方比作者名还小。
 *
 * 所以这一档换一种形状：**我写的那句话是正文，书是落款**。
 * 中文书里给引文、序跋、批注用的脸是楷体（`settings.ts` 那份实测排序里它标着
 * 「短读」——一句短评正好是短读，那条结论在这里是正着用的），
 * 评分做成盖在左边的一枚**朱印**：印是「我读过、我给它定了个数」这件事本身，
 * 而且一栏红印竖着排下来，五星和二星扫一眼就分得开。
 *
 * ⚠️ **书名做成了可点的键，而封面墙那边明确没这么做**（`App.tsx` 里那句
 * 「也不做在书名上：那行只有 18px 高，`audit.mjs` 当场报点击目标偏小」）。
 * 两边不矛盾：那条判据说的是卡片上 0.85rem 挤在两行里的书名，
 * 这里的落款是 0.95rem 加上下 0.25rem 内边距，量出来 34px 高，本来就够。
 * 这一档没有封面，不给书名做入口的话**这里就一个打开书的入口都没有**。
 *
 * ⚠️ **月栏只在按评价时间排的时候画。** 月份是排序键本身——换成「评分高的在前」
 * 之后还画着「2026 年 8 月」，那是句假话（同 `format.ts` 的 `activeFilterWords`
 * 那条：宁可不归因，也别归错）。
 */

/** 印上刻的是汉字。1–5 之外（`rating` 是 real，将来可能有半星）原样印数字 */
const 汉数 = ['', '一', '二', '三', '四', '五'];

/** 这条书评记在哪个月。`rated_at` 是 sqlite 的 UTC 文本，必须走 `sqlTime` 补那个 Z */
function 月栏(raw: string | null | undefined): string {
  const t = sqlTime(raw);
  // 早年写的评价可能没有 `rated_at`（那一列是后加的），它们排在最后，单独成一栏
  if (t == null) return '没记时间';
  const d = new Date(t);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

interface Props {
  books: Book[];
  /** 当前排序是不是「最近评价的在前」。只有这时候月栏说的才是真话 */
  byRatedTime: boolean;
  onOpen: (b: Book) => void;
  /** 正在改的那一条。和封面墙共用 App 里那一个状态，Esc 那张表因此照样管得着 */
  editing: Book | null;
  onEdit: (b: Book | null) => void;
  onChanged: (bookId: number, patch: Partial<Book>) => void;
}

export function ReviewShelf({ books, byRatedTime, onOpen, editing, onEdit, onChanged }: Props) {
  let 上一栏: string | null = null;
  return (
    <div className="reviews">
      {books.map((b) => {
        const 栏 = byRatedTime ? 月栏(b.rated_at) : null;
        const 换栏 = 栏 !== null && 栏 !== 上一栏;
        if (栏 !== null) 上一栏 = 栏;
        const 时 = whenAgo(b.rated_at);
        const tags = (b.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
        return (
          <Fragment key={b.id}>
            {换栏 && <h2 className="rv-era">{栏}</h2>}
            <article className="rv">
              <div className="rv-mark">
                {/* 没打分只写了一句话的也在这一档里（`ratedSql`：有星级**或**有短评）。
                    那种就是没有印——空着比画一个「未评分」的灰印诚实 */}
                {b.rating != null && (
                  <span className="rv-seal" role="img" aria-label={`${b.rating} 星`} title={`${b.rating} 星`}>
                    {汉数[b.rating] || b.rating}
                  </span>
                )}
              </div>
              <div className="rv-body">
                {b.comment && <p className="rv-say">{b.comment}</p>}
                {/* 弃坑原因答的是另一个问题（「我当初为什么弃了它」），
                    所以带个前缀单独成行，不和短评混成一段。
                    封面墙那边不加前缀是因为一行只印得下 11 个字，这里不缺那三个字 */}
                {b.drop_reason && (
                  <p className="rv-why">
                    <span className="rv-label">弃坑</span>
                    {b.drop_reason}
                  </p>
                )}
                <div className="rv-foot">
                  <button
                    type="button"
                    className="rv-book"
                    onClick={() => onOpen(b)}
                    title="打开这本书"
                  >
                    《{b.title}》
                    {b.author && <span className="rv-by">{b.author}</span>}
                  </button>
                  {/*
                    * ⚠️ **标签要封个上限。** 原来是 `tags.map` 全铺：一本打了二十几个
                    * 标签的书，光标签就铺满两行、还个个带着边框，比它上面那句书评重得多——
                    * 而这一档的全部意思就是「我当时怎么说」，那句话是正文，标签是注脚。
                    * 六个大约占满一行，多的收进 `+N`，完整那份在悬停里
                    *（同表格那一列的判据，只是那边更窄、只摆两个）。
                    */}
                  {tags.length > 0 && (
                    <span className="rv-tags" title={tags.join('、')}>
                      {tags.slice(0, 6).map((t) => (
                        <span key={t} className="chip sm">{t}</span>
                      ))}
                      {tags.length > 6 && <span className="muted">+{tags.length - 6}</span>}
                    </span>
                  )}
                  {/*
                    * 落款那一组：什么时候写的 + 改评价。**捆在一个盒子里推到行尾**，
                    * 不是各自推——760 那一档（窗口自己的下限）正文区只有五百来像素，
                    * 各自推的话「改评价」自己掉到下一行、左边贴着边孤零零一个，
                    * 而日期还留在上一行。捆着就一起换行。
                    */}
                  <span className="rv-sign">
                    {/* 「3个月前」，准确到秒的本地时间在 title 里——说法和卡片、
                        书签面板一致，走 `format.ts` 的 `whenAgo`（库里存的是 UTC） */}
                    {时 && <span className="rv-when" title={时.title}>{时.text}</span>}
                    <button
                      type="button"
                      className="rv-edit"
                      title="改这本的打分、短评和标签"
                      aria-label={`改《${b.title}》的评价`}
                      onClick={() => onEdit(b)}
                    >
                      改评价
                    </button>
                  </span>
                </div>
              </div>
              {editing?.id === b.id && (
                <RatePopover
                  bookId={b.id}
                  bookTitle={b.title}
                  rating={b.rating}
                  comment={b.comment}
                  tags={b.tags}
                  onChanged={(patch) => onChanged(b.id, patch)}
                  onClose={() => onEdit(null)}
                />
              )}
            </article>
          </Fragment>
        );
      })}
    </div>
  );
}
