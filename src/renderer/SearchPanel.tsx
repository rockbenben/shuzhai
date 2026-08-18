import { useEffect, useState } from 'react';
import { loadShowRating } from './settings.ts';
import { rpc } from './rpc.ts';

interface Hit {
  bookId: number;
  bookTitle: string;
  chapterIdx: number;
  chapterTitle: string;
  snippet: string;
}

interface IndexedBook {
  bookId: number;
  title: string;
  chapters: number;
}

interface MetaHit {
  bookId: number;
  title: string;
  author: string | null;
  tags: string | null;
  /** 评分和短评。**搜出来的结果也要看得见评价**，理由见下面渲染那一段 */
  rating: number | null;
  comment: string | null;
  /** 这本有没有可搜的正文（主文件的章节数）。0 = 建不出索引，见下面渲染那一段 */
  chapters: number;
}

interface Props {
  onOpen: (bookId: number, chapterIdx: number) => void;
  onClose: () => void;
}

/** 把 【命中】 标出来。搜索结果里不高亮，用户得自己在一行字里找 */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/(【[^】]*】)/).map((part, i) =>
        part.startsWith('【') ? (
          <mark key={i} style={{ background: 'transparent', color: 'var(--accent)', fontWeight: 600 }}>
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function SearchPanel({ onOpen, onClose }: Props) {
  const showRating = loadShowRating();
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'meta' | 'full'>('meta');
  const [meta, setMeta] = useState<MetaHit[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 建了索引的书。**正文搜索只在这些书里搜** */
  const [books, setBooks] = useState<IndexedBook[]>([]);
  /** 「删掉全部索引」问过一次了吗。按仓库已有的行内确认写法（同「分类」那个删除键） */
  const [要全删吗, set要全删吗] = useState(false);
  /** 想给哪本书建索引：在这里搜书名，选中就建 */
  const [pick, setPick] = useState('');
  const [picks, setPicks] = useState<MetaHit[]>([]);

  const reloadIndexed = () =>
    rpc<IndexedBook[]>('search.indexedBooks').then(setBooks).catch(() => setBooks([]));

  useEffect(() => { void reloadIndexed(); }, []);

  // 「给哪本书建索引」的书名搜索。走 searchMeta，不需要索引
  useEffect(() => {
    if (!pick.trim()) { setPicks([]); return; }
    const t = setTimeout(() => {
      rpc<MetaHit[]>('search.meta', { query: pick }).then((r) => setPicks(r.slice(0, 8))).catch(() => setPicks([]));
    }, 250);
    return () => clearTimeout(t);
  }, [pick]);

  useEffect(() => {
    if (!q.trim()) {
      setMeta([]);
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      setError(null);
      /*
       * ⚠️ **出错要把上一次的结果清掉。**
       *
       * 原来只 `setError`，结果列表原封不动留在下面——实测搜 `100%` 时，
       * 屏幕上是「fts5: syntax error near "%"」紧跟着「命中 45 处 剑来 第1章…」，
       * 而那 45 处是**上一个查询**搜出来的。用户看到的是
       * 「一句看不懂的英文 + 一堆看起来像是这次搜出来的结果」，
       * 比单纯报错更容易误导。同这个仓库那条老规矩：
       * 「工具静默地什么都没做，和没问题长得一模一样」——这里是它的反面，
       * 做错了却摆着一份看起来没问题的结果。
       */
      const 出错 = (e: Error) => { setMeta([]); setHits([]); setError(e.message); };
      if (scope === 'meta') {
        rpc<MetaHit[]>('search.meta', { query: q }).then(setMeta).catch(出错);
      } else {
        rpc<Hit[]>('search.fullText', { query: q })
          .then(setHits)
          .catch(出错);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q, scope]);

  /**
   * 给一本书建索引。
   *
   * **按书建，不是全库。** 实测这个库有 653 万章——全库建一次要跑几小时、
   * 索引好几 GB，而界面上按一下就再也回不来了。而且全库正文搜索本来就低频：
   * 找书按书名作者（随时可用），找句子通常是在正在读的那一本里。
   */
  const buildFor = async (bookId: number, title: string) => {
    setBusy(`正在给《${title}》建索引…`);
    setError(null);
    /*
     * **进度要真的报出来。** 真实书库上量的：一本 12046 章的书要 **68 秒**，
     * 而原来这里从头到尾只有一句不动的「正在建索引…」——那 68 秒里用户
     * 唯一能做的判断是「它是不是死了」。
     * （主进程那头 `buildIndex` 的 onProgress 一直传的是 `undefined`，
     * 钩子写好了没人接，和 `fellBack`、`finished` 是同一个形状。）
     */
    const off = window.novel.onIndexProgress(({ done, total }) => {
      setBusy(`正在给《${title}》建索引… ${done}/${total} 章`);
    });
    try {
      const r = await rpc<{ chapters: number }>('search.buildIndex', { bookIds: [bookId] });
      await reloadIndexed();
      setPick('');
      setPicks([]);
      setError(null);
      setBusy(`《${title}》建好了，共 ${r.chapters} 章`);
      setTimeout(() => setBusy(null), 2500);
      return;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      // **一定要退订**：不退的话下一本书建索引时，上一次的回调还在改同一个
      // busy 文案，屏幕上两本书的进度会互相打架
      off();
    }
    setBusy(null);
  };

  const dropFor = async (bookId?: number) => {
    await rpc('search.dropIndex', bookId ? { bookIds: [bookId] } : {});
    await reloadIndexed();
    setHits([]);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 'min(52rem, 100%)' }} onClick={(e) => e.stopPropagation()}>
        {/*
          * **这个弹窗原来一个标题都没有。**
          *
          * 点开「全库搜索」，弹出来的是一个输入框加一个下拉——和书架头部那个
          * 搜索框长得一模一样，而默认档位（书名/作者/标签）**干的也确实是同一件事**。
          * 于是「这跟上面那个框有什么区别」没人答得上来，真正的区别（能搜正文）
          * 藏在一个没人会去点的下拉里。标题加上，差别写在第一句话里。
          */}
        <h2>全库搜索</h2>
        <p className="muted" style={{ margin: '0 0 .7rem', fontSize: '.85rem' }}>
          书名、作者、标签、<strong>你自己写的短评</strong>随时能搜。
          <strong>要搜正文，先给那本书建索引</strong>——
          按书建不是整库建：一本 500 章的书几秒，12000 章的要一分多钟。
        </p>
        <div className="row">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={scope === 'meta' ? '搜书名 / 作者 / 标签 / 你写的短评' : '搜正文'}
            style={{ flex: 1 }}
          />
          <select value={scope} onChange={(e) => setScope(e.target.value as 'meta' | 'full')}>
            {/* 「书名作者标签」三个词连着读，第一眼分不出是三样还是一样 */}
            {/* 「你写的短评」要写出来：搜得到但没人知道搜得到，等于没有 */}
            <option value="meta">书名 / 作者 / 标签 / 短评</option>
            <option value="full">正文内容</option>
          </select>
        </div>

        {scope === 'full' && (
          <div className="card" style={{ marginTop: '.6rem' }}>
            <div className="row">
              <strong style={{ fontSize: '.9rem' }}>
                正文搜索的范围：{books.length ? `${books.length} 本书` : '还没有书建索引'}
              </strong>
              <span style={{ flex: 1 }} />
              {/*
                * ⚠️ **两处都改过，原因是同一个**：这个键原来叫「全部删掉」，
                * 而它左边紧挨着的字是「正文搜索的范围：**N 本书**」——
                * 扫过去读到的是「N 本书……全部删掉」。这个应用**真的有删文件的功能**，
                * 所以最危险的那个动词后面必须跟着宾语。单本那个键的提示写的就是
                * 「删掉这本书的索引」，这里跟它对齐。
                *
                * 而且原来**一点就没了，不问一句**——下面那句话自己写着
                * 「全库建一次要跑几小时」。索引是能重建的（不算铁律 3），
                * 所以不上二次确认那一套，行内问一句就够。
                */}
              {books.length > 0 && (要全删吗 ? (
                <>
                  <button
                    className="danger"
                    style={{ fontSize: '.78rem', padding: '.1em .5em' }}
                    onClick={() => { set要全删吗(false); void dropFor(); }}
                  >
                    确认删掉这 {books.length} 本的索引
                  </button>
                  <button style={{ fontSize: '.78rem', padding: '.1em .5em' }} onClick={() => set要全删吗(false)}>
                    再看看
                  </button>
                </>
              ) : (
                <button style={{ fontSize: '.78rem', padding: '.1em .5em' }} onClick={() => set要全删吗(true)}>
                  删掉全部索引
                </button>
              ))}
            </div>
            <p className="muted" style={{ margin: '.25rem 0 .5rem', fontSize: '.82rem' }}>
              索引<strong>按本建</strong>——这个库有六百多万章，全库建一次要跑几小时。
              建索引只<strong>读</strong> txt，把正文副本存进数据库；
              <strong>原文件一个字节都不会改</strong>，索引随时能删。
            </p>

            {books.length > 0 && (
              <div className="row" style={{ flexWrap: 'wrap', gap: '.3rem', marginBottom: '.5rem' }}>
                {books.map((b) => (
                  <span key={b.bookId} className="chip" aria-pressed="true">
                    {b.title}
                    <span className="chip-n">{b.chapters}</span>
                    <button
                      style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: 'inherit' }}
                      title="删掉这本书的索引"
                      onClick={() => void dropFor(b.bookId)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="row">
              <input
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                placeholder="输入书名，给它建索引"
                style={{ flex: 1 }}
              />
              {busy && <span className="muted" style={{ fontSize: '.82rem' }}>{busy}</span>}
            </div>
            {picks.length > 0 && (
              <div className="row" style={{ flexWrap: 'wrap', gap: '.3rem', marginTop: '.4rem' }}>
                {/*
                  * ⚠️ **没有正文的书不能点，而且要说清为什么。**
                  *
                  * 这个列表原来什么书都收：选中一本 PDF，界面会说
                  * 「《X》建好了，共 **0** 章」——**一句为「什么都没干」而发的成功提示**，
                  * 那本书随后还会出现在「正文搜索的范围」里，而搜什么都搜不到。
                  *
                  * 判据写成**「有没有章节」而不是「是不是 PDF」**：只编目的格式章节表
                  * 天生是空的，而一本没解析成功的 txt 同样建不出东西——后者按格式判会漏掉。
                  *
                  * **不是藏起来而是禁用**：用户按书名搜过来，书却不出现，比出现但点不动更让人犯嘀咕
                  * （同这个仓库那条「摆一个点了必然出错的按钮比没有更糟」的另一半——
                  * 该说的是「为什么点不了」）。
                  */}
                {picks.map((b) => {
                  const 建过 = books.some((x) => x.bookId === b.bookId);
                  const 没正文 = !b.chapters;
                  return (
                    <button
                      key={b.bookId}
                      className="chip"
                      disabled={busy !== null || 建过 || 没正文}
                      title={没正文 ? '这本没有可搜的正文：PDF / EPUB 是只编目的，txt 则是还没解析出章节' : undefined}
                      onClick={() => void buildFor(b.bookId, b.title)}
                    >
                      {建过 ? '已建 · ' : 没正文 ? '没有正文 · ' : '+ '}
                      {b.title}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {error && <p className="danger">{error}</p>}

        <div style={{ maxHeight: '26rem', overflowY: 'auto', marginTop: '.6rem' }}>
          {scope === 'meta' ? (
            meta.length === 0 ? (
              q && <p className="muted">没有匹配的书。</p>
            ) : (
              <table className="search-meta">
                <tbody>
                  {meta.map((m) => (
                    <tr key={m.bookId}>
                      <td>
                        <button
                          style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
                          onClick={() => onOpen(m.bookId, 0)}
                        >
                          {m.title}
                        </button>
                        {/*
                          * **那句短评要在这儿出现。**
                          * 「下次不用再想这本我看过没」是这个应用的正事，而用户最常走的
                          * 就是在这里搜书名——卡片上兑现了，搜索结果里原来只有
                          * 书名/作者/标签，恰好在最该回答的地方不答。
                          * 说法和卡片一致：引号是画上去的，一眼看得出这是「我说的话」。
                          */}
                        {m.comment && (
                          <div className="book-note" style={{ maxWidth: '22rem' }} title={m.comment}>
                            {m.comment}
                          </div>
                        )}
                      </td>
                      <td className="muted">{m.author ?? '—'}</td>
                      {/* 「用评分」关掉时整列收起来——留一列空的只会让书名和
                          作者白挨挤（那张表在 760px 上本来就紧） */}
                      {showRating && (
                        <td style={{ width: '3.2rem' }}>
                          {m.rating != null && <span className="book-rating">★{m.rating}</span>}
                        </td>
                      )}
                      {/*
                        * ⚠️ **clamp 必须加在里面这个 `<div>` 上，不能加在 `<td>` 上。**
                        * Chromium 会把表格单元格上的 `display: -webkit-box`
                        * **blockify 成 `flow-root`**（当场量的 computed 值），
                        * 于是 `-webkit-line-clamp` 整个不生效——那一格不是「收成两行」，
                        * 是被 `overflow: hidden` **拦腰切断**（142px 的内容切在 55px 上，
                        * 最后一行从中间横着削掉半个字）。
                        * 而 CSS 里那段注释写着「收成两行」，**代码从来没兑现过**。
                        * 全文放 title 里。
                        */}
                      <td className="muted" style={{ fontSize: '.8rem' }} title={m.tags ?? ''}>
                        <div className="clamp2">{m.tags ?? ''}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : hits.length === 0 ? (
            q && books.length > 0 && <p className="muted">这 {books.length} 本书的正文里没有找到。</p>
          ) : (
            <>
              <p className="muted" style={{ fontSize: '.85rem', margin: '0 0 .3rem' }}>
                命中 {hits.length} 处
              </p>
              <table>
                <tbody>
                  {hits.map((h, i) => (
                    <tr key={i}>
                      <td style={{ width: '11rem', fontSize: '0.82rem' }}>
                        <div>{h.bookTitle}</div>
                        <div className="muted" style={{ fontSize: '0.75rem' }}>{h.chapterTitle}</div>
                      </td>
                      <td style={{ fontSize: '.85rem' }}>
                        <Snippet text={h.snippet} />
                      </td>
                      <td style={{ width: '4rem' }}>
                        <button
                          style={{ fontSize: '.78rem', padding: '.1em .5em' }}
                          onClick={() => onOpen(h.bookId, h.chapterIdx)}
                        >
                          跳转
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div className="row modal-actions" style={{ marginTop: '.8rem', justifyContent: 'flex-end' }}>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
