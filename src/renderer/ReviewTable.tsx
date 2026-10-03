import type { Book } from './App.tsx';
import { RatePopover } from './RatePopover.tsx';
import { 拆标签 } from './TagPicker.tsx';
import { whenAgo, wan, displayChapters } from '../core/format.ts';
import { labelOf, READING_STATUS } from '../core/labels.ts';
import type { SortBy } from '../core/library.ts';

/**
 * 表格视图：**评分、评价、状态、读完年份一屏看全**。
 *
 * 存在的理由是封面墙和书评册都答不上「我这一批书的账目」——封面墙一屏八本、
 * 每本只印得下两行小字；书评册一次只讲一本书的一句话。而用户原来是拿 Notion
 * 的数据库表管这些的（一行一本，评分、评价、状态、读完年份、题材并排），
 * 「批量补评价」「2025 年读完了哪些」这类问题只有表格答得快。
 *
 * ⚠️ **只读，不做就地编辑。** 点评价那一格开的是 `RatePopover`——
 * 评分/短评/标签的写入**只有那一条路**。表格里再做一套就地编辑，
 * 就是这个仓库开头那句警告说的「同一份判据抄第二份」，
 * 而它已经被咬过好几次（`shelfCounts` 绕开 `buildFilter`、渲染进程自己抄 `Filter`）。
 * 那个浮层本来就是「点了就存、没有保存键」，快慢和 Notion 差不多。
 *
 * ⚠️ **两个点击目标，分工按格子走**：书名那一格＝打开这本书，
 * 评价那一格＝改评价。不做「点整行开浮层」——那样书名就得在行里再套一个按钮，
 * 按钮套按钮既非法又难点（封面墙那边 `.book-open` 踩过）。
 */

/** 表头点一下按这一列排。**只给真有排序实现的那几列**——`ORDER` 里有什么就是什么 */
/**
 * 表头点一下按哪一列排，**以及那一列真排的方向**。
 *
 * ⚠️ 方向跟着 `core/library.ts` 的 `ORDER` 抄——那几条是写死方向的字符串，
 * 而 `title` 恰恰是**升序**（`b.title collate nocase, b.id`，没有 desc）。
 * 原来不分方向、正在生效的那一列一律画 `▾`，于是「书名」那一列箭头朝下、
 * 数据却从小往大走（实测头两行「一本EPUB电子书」→「一本PDF电子书」）——
 * **箭头在说一件没发生的事**。六列里只有这一列会撒这个谎，
 * 恰好是最常被点的那一列。
 */
const 列排序: Partial<Record<string, { 键: SortBy; 向: 'asc' | 'desc' }>> = {
  书名: { 键: 'title', 向: 'asc' },
  评分: { 键: 'rating', 向: 'desc' },
  评价: { 键: 'rated', 向: 'desc' },
  读完: { 键: 'finished', 向: 'desc' },
  // 排的是这一列自己：读过的在前按最后阅读时间倒序、没读过的沉底。
  // 不能用「最新的在前」（time）——它取阅读/入库时间较新者，会让这一列空白
  // （没在应用里打开过）的行拿文件时间插进有日期的行中间
  上次读: { 键: 'lastread', 向: 'desc' },
  '字数·章节': { 键: 'words', 向: 'desc' },
};

interface Props {
  books: Book[];
  sort: SortBy;
  /** 点表头。**单向**：`ORDER` 里那几条是写死方向的字符串，双向要改 core 的排序接口 */
  onSort: (s: SortBy) => void;
  onOpen: (b: Book) => void;
  editing: Book | null;
  onEdit: (b: Book | null) => void;
  onChanged: (bookId: number, patch: Partial<Book>) => void;
}

export function ReviewTable({ books, sort, onSort, onOpen, editing, onEdit, onChanged }: Props) {
  return (
    // 横向滚动**关在自己这个盒子里**：页面本身横滚是走查里单独一条判据，
    // 而八列在 760 那一档（窗口自己的下限）一定装不下
    <div className="tablewrap">
      <table className="booktable">
        <thead>
          <tr>
            {/*
              * ⚠️ **没有「读了多久」这一列，那是查过之后决定不加的。**
              *
              * `reading_session` 记着起止时间，看起来现成——但它记的是
              * **阅读器开着多久**，不是读了多久：会话在进阅读器时开、离开时关，
              * 应用退出时 `closeOpenSessions('quit')` 用当下时间收尾，
              * 于是开着窗口挂机就照记。真实库上量的：单次最长 216496 秒（60 小时），
              * 有一本 16 次会话累计 66 小时。摆出来就是一个**看着正常的假数**。
              * 而且 `status.ts` 顶上写着 spec §14 明确不做阅读时长统计。
              * （整段记在 `docs/lessons.md`。）
              */}
            {['书名', '作者', '评分', '评价', '状态', '读到', '上次读', '读完', '题材', '字数·章节'].map((h) => {
              const c = 列排序[h];
              const 生效 = !!c && sort === c.键;
              return (
                <th
                  key={h}
                  className={h === '评价' ? 'col-say' : undefined}
                  /* 方向本来就该由表格自己报出来，不该只画成一个给眼睛看的箭头 */
                  aria-sort={生效 ? (c!.向 === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c ? (
                    <button
                      type="button"
                      className="th-sort"
                      aria-pressed={生效}
                      onClick={() => onSort(c.键)}
                      title={`按${h}排（${c.向 === 'asc' ? '从小到大' : '从大到小'}）`}
                    >
                      {h}
                      {/* 箭头只画在正在生效的那一列上，而且**跟着那一列真排的方向走**。
                          单向仍然是真的——这里没有可切换的样子，画两个方向才是撒谎 */}
                      {生效 && <span aria-hidden="true"> {c.向 === 'asc' ? '▴' : '▾'}</span>}
                    </button>
                  ) : (
                    h
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {books.map((b) => {
            const 读完 = whenAgo(b.finished_at);
            const 上次 = whenAgo(b.last_read_at);
            const tags = 拆标签(b.tags);
            // 手填章数盖过自动识别，判据和封面卡同一份（format.ts 的 displayChapters）
            const 章数 = displayChapters(b.chapter_count_override, b.chapter_count);
            return (
              <tr key={b.id}>
                {/* 书名那一格＝打开这本书。浮层挂在这一格上（它 position: relative），
                    挂 <tr> 上定位在各浏览器里不稳 */}
                <td className="col-title">
                  <button type="button" className="cell-open" onClick={() => onOpen(b)} title="打开这本书">
                    {b.title}
                  </button>
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
                </td>
                {/* `col-by` / `col-status`：不许在汉字之间断行，理由在 shell.css 那条上 */}
                <td className="muted col-by">{b.author ?? '佚名'}</td>
                <td>
                  {/*
                    * 表格里一行一颗颗排得开，所以用真的星形；封面墙上那个 ★N
                    * 是因为卡片太小会糊成一团，书评册那边是一枚印。三处形态不同，
                    * 答的是同一件事——能放下的东西不一样。
                    *
                    * ⚠️ **不用 `StarRating`**：那是个**输入控件**（必填 `onChange`、
                    * 一行五个按钮），而这一列是只读的。搬过来的话一屏 120 行
                    * 就是 600 个点了没反应的按钮，键盘 Tab 一遍走不完，
                    * 屏幕阅读器也会把它念成可操作的东西。
                    *
                    * ⚠️ **不画空心的那几颗。**
                    *
                    * 原来补了同色淡星凑满五颗，理由是「等宽好对齐」——那条理由是从
                    * 书评册搬过来的，**在表格里根本不成立：列本来就是等宽的**，
                    * 对齐早由表格保证了。而它的代价是真的：走查在五个分辨率上
                    * 一齐报「对比度 1.23 < 4.5」，要修到合规就得暗到接近实心星，
                    * 那又把「实心 vs 空心」的区分毁了。
                    *
                    * 去掉之后一列扫下来是长短不一的星条，比灰底衬着更好认。
                    * 「几星」由 `aria-label` / `title` 说，不靠数格子。
                    */}
                  {/* ⚠️ **0 分要画一横，不能画成空的。** `status.ts` 只挡 `<0` 和 `>5`，
                      所以 0 是合法值（rating 那一列是 REAL，0.4 也会 round 成 0）——
                      而空格子和「没打过分」在这一列里长得一模一样，
                      偏偏这一列正是这个视图要回答的东西。原来那五颗淡星兜着这件事，
                      拿掉之后就只剩 aria-label 说得出来，而看得见的人听不到它 */}
                  {b.rating != null && (
                    <span className="cell-stars" title={`${b.rating} 星`} aria-label={`${b.rating} 星`} role="img">
                      {'★'.repeat(Math.round(b.rating)) || '—'}
                    </span>
                  )}
                </td>
                {/*
                  * 评价那一格＝改评价。**空的时候也要能点**——「读过没评价」那一档
                  * 整列都是空的，而那一档正是这个应用唯一的待办清单，
                  * 表格视图在那儿的全部意义就是一行行补下去。
                  */}
                <td className="col-say">
                  {(() => {
                    const mainText = b.comment || b.drop_reason;
                    return (
                      <button
                        type="button"
                        // ⚠️ `cell-blank` 不是 `empty`——后者是空书架那句提示的类名，撞了会把整格撑塌
                        className={`cell-say${mainText ? '' : ' cell-blank'}`}
                        onClick={() => onEdit(b)}
                        title={mainText ?? undefined}
                        aria-label={`改《${b.title}》的评价`}
                      >
                        {/* 夹两行的那层 span 不能省——理由在 shell.css 的 `.cell-say > span` 上 */}
                        <span>{mainText || '＋ 评价'}</span>
                      </button>
                    );
                  })()}
                </td>
                {/* 状态那一格顺带说「重读过几次」。**不加列**：这张表已经十列，
                    加一列要连带动 `min-width`（判据在 shell.css 的 `.booktable`），
                    而这句话本来就是状态的一部分。
                    ⚠️ 数的是重读次数（`status.ts` 里读完之后再开读才自增），1 ＝ 翻回来过一次 */}
                <td className="muted col-status">
                  {labelOf(READING_STATUS, b.reading_status)}
                  {(b.reread_count ?? 0) > 0 && (
                    <span title="读完之后又翻开过。重新开读会把进度归零，所以「读到」那一列是从头算的">
                      {' · 重读 '}{b.reread_count}{' 次'}
                    </span>
                  )}
                </td>
                {/*
                  * **读到哪。** 封面墙上是压在封面下沿那条进度条，表格里给数字——
                  * 条形只能看个大概，而表格的用处正是一列上下比得出来。
                  * 读完的不再报百分比：状态那一列已经说过一遍了，同一行不说两次
                  * （同封面墙 `.book-read` 那条判据）。
                  */}
                <td className="muted col-num">
                  {b.reading_status !== 'finished' && !!b.percent && b.percent > 0 && (
                    <span title={b.chapter_title ? `读到「${b.chapter_title}」` : undefined}>
                      {Math.round(b.percent)}%
                    </span>
                  )}
                </td>
                {/*
                  * **上次读**＝「多久没碰了」。「3个月前」意味着这本其实已经弃了，
                  * 而这个应用的目标正是别再重复翻开它。
                  *
                  * ⚠️ **读完的书这一格留空。** 读完的书是翻到最后一页才读完的，
                  * 于是 `last_read_at` 和 `finished_at` 基本是同一个时刻——两列并排
                  * 印着一模一样的「上个月／上个月」，同一行把同一件事说了两遍。
                  * （封面墙那边早有同一条：读完的书不再报「读到 12/12」。）
                  * 这么一来两列天然互补：没读完的看左边，读完的看右边。
                  */}
                <td className="muted col-when">
                  {b.reading_status !== 'finished' && 上次 && (
                    <span title={上次.title}>{上次.text}</span>
                  )}
                </td>
                {/* 「读完」这一列是 `finished_at` 第一次在界面上露面。
                    说法和别处一致（`whenAgo`），准确日期在悬停里 */}
                <td className="muted col-when">
                  {读完 && <span title={读完.title}>{读完.text}</span>}
                </td>
                {/* ⚠️ **表格里只摆两个，比封面墙少一个。** 这一列在表格里是提示不是内容，
                    而它不许换行（理由在 shell.css 的 `.booktable .rv-tags` 上）——
                    摆几个直接就是这一列要占多宽，三个长标签能吃掉「评价」小半列。
                    完整那份在悬停的 title 里 */}
                <td>
                  {tags.length > 0 && (
                    <span className="rv-tags" title={tags.join('、')}>
                      {tags.slice(0, 2).map((t) => (
                        <span key={t} className="chip sm">{t}</span>
                      ))}
                      {tags.length > 2 && <span className="muted">+{tags.length - 2}</span>}
                    </span>
                  )}
                </td>
                {/* 字数走 `format.ts` 的 `wan()`，别在这儿另写一个除一万——
                    那个函数连「数字和单位之间用不换行空格」都处理过了 */}
                <td className="muted col-num">
                  {wan(b.word_count)}
                  {章数 ? `${b.word_count ? ' · ' : ''}${章数} 章` : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
