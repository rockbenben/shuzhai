import { useEffect, useRef, useState } from 'react';
import { loadShowRating } from './settings.ts';
import { rpc } from './rpc.ts';
import { 拆标签 } from './TagPicker.tsx';

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

export interface MetaHit {
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
  /**
   * 打开一本书。`chapterIdx` **只有正文命中时才传**（落在命中的那一章）；
   * 书名/作者那档不传——让书自己接着上次读到的地方，而不是从第 1 章重开
   * 并把已存进度覆盖掉。
   */
  onOpen: (bookId: number, chapterIdx?: number) => void;
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
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [manageIndex, setManageIndex] = useState(false);
  const results = useRef<HTMLDivElement>(null);
  /** 建了索引的书。**正文搜索只在这些书里搜** */
  const [books, setBooks] = useState<IndexedBook[]>([]);
  /** 「删掉全部索引」问过一次了吗。按仓库已有的行内确认写法（同「分类」那个删除键） */
  const [要全删吗, set要全删吗] = useState(false);
  /** 想给哪本书建索引：在这里搜书名，选中就建 */
  const [pick, setPick] = useState('');
  const [picks, setPicks] = useState<MetaHit[]>([]);
  const term = q.trim().toLowerCase();

  const reloadIndexed = () =>
    rpc<IndexedBook[]>('search.indexedBooks').then(setBooks).catch(() => setBooks([]));

  useEffect(() => { void reloadIndexed(); }, []);

  /**
   * **请求的「第几代」。**晚回来的那一代不许盖掉新的。
   *
   * ⚠️ **300ms 防抖只挡得住「还没发出去的那次」，挡不住「已经在飞的那次」。**
   * 大库上 FTS 查询要几百毫秒到几秒，于是：先搜一个词、再补一个字 →
   * 旧查询晚回来 → `setHits` 把它盖上去 → **屏幕上显示的是上一个词的结果**，
   * 而输入框里是新词。点一条跳过去，落到的是旧词的位置。
   *
   * 判据和 `App.tsx` 的 `refresh` 一样（那边叫 `gen`）：**输入一变，旧结果立刻作废。**
   */
  const 代 = useRef(0);
  const 选书代 = useRef(0);

  // 「给哪本书建索引」的书名搜索。走 searchMeta，不需要索引
  useEffect(() => {
    const 我的 = ++选书代.current;
    setPicks([]);
    if (!pick.trim()) return;
    const t = setTimeout(() => {
      rpc<MetaHit[]>('search.meta', { query: pick })
        .then((r) => { if (选书代.current === 我的) setPicks(r.slice(0, 8)); })
        .catch(() => { if (选书代.current === 我的) setPicks([]); });
    }, 250);
    return () => { clearTimeout(t); ++选书代.current; };
  }, [pick]);

  useEffect(() => {
    const 我的 = ++代.current;
    setMeta([]);
    setHits([]);
    setSearchError(null);
    results.current?.scrollTo({ top: 0 });
    const canSearch = !!q.trim() && (scope === 'meta' || books.length > 0);
    setSearching(canSearch);
    if (!canSearch) return;
    const t = setTimeout(() => {
      /*
       * ⚠️ **出错要把上一次的结果清掉。**
       *
       * 原来只 `setError`，结果列表原封不动留在下面——实测搜 `100%` 时，
       * 屏幕上是「fts5: syntax error near "%"」紧跟着「命中 45 处 某个词 第1章…」，
       * 而那 45 处是**上一个查询**搜出来的。用户看到的是
       * 「一句看不懂的英文 + 一堆看起来像是这次搜出来的结果」，
       * 比单纯报错更容易误导。同这个仓库那条老规矩：
       * 「工具静默地什么都没做，和没问题长得一模一样」——这里是它的反面，
       * 做错了却摆着一份看起来没问题的结果。
       */
      const 出错 = (e: Error) => {
        if (代.current !== 我的) return;
        setMeta([]);
        setHits([]);
        setSearchError(e.message);
      };
      if (scope === 'meta') {
        rpc<MetaHit[]>('search.meta', { query: q })
          .then((r) => { if (代.current === 我的) setMeta(r); })
          .catch(出错)
          .finally(() => { if (代.current === 我的) setSearching(false); });
      } else {
        rpc<Hit[]>('search.fullText', { query: q })
          .then((r) => { if (代.current === 我的) setHits(r); })
          .catch(出错)
          .finally(() => { if (代.current === 我的) setSearching(false); });
      }
    }, 300);
    return () => { clearTimeout(t); ++代.current; };
  }, [q, scope, books]);

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
      const r = await rpc<{ chapters: number; failed: number }>('search.buildIndex', { bookIds: [bookId] });
      await reloadIndexed();
      setPick('');
      setPicks([]);
      setError(r.failed ? `《${title}》已索引 ${r.chapters} 章，${r.failed} 章读取失败，请检查文件后重试。` : null);
      setBusy(r.failed ? null : `《${title}》建好了，共 ${r.chapters} 章`);
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
    setBusy('正在删除索引…');
    setError(null);
    try {
      await rpc('search.dropIndex', bookId ? { bookIds: [bookId] } : {});
      await reloadIndexed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal library-search" onClick={(e) => e.stopPropagation()}>
        <header className="library-search-head">
          <h2>全库搜索</h2>
          <div className="search-scopes" role="group" aria-label="搜索范围">
            <button aria-pressed={scope === 'meta'} onClick={() => { setScope('meta'); setManageIndex(false); }}>
              书籍资料
            </button>
            <button aria-pressed={scope === 'full'} onClick={() => setScope('full')}>正文内容</button>
          </div>
          <div className="search-query">
            <input
              autoFocus
              className="search-box"
              type="search"
              value={q}
              aria-label={scope === 'meta' ? '搜书名、别名、作者、标签或短评' : '搜已索引的正文'}
              onChange={(e) => setQ(e.target.value)}
              placeholder={scope === 'meta' ? '搜书名 / 作者 / 标签 / 短评' : '搜已索引的正文'}
            />
            {scope === 'full' && (
              <button aria-expanded={manageIndex} onClick={() => setManageIndex((v) => !v)}>管理索引</button>
            )}
          </div>
          {scope === 'full' && <p className="search-scope-hint muted">正文范围：已建索引的 {books.length} 本书</p>}
        </header>

        <div className="library-search-body" ref={results}>
          {scope === 'full' && manageIndex && (
            <section className="search-indexes" aria-label="正文索引">
              <div className="search-index-heading">
                <h3>正文索引</h3>
                {books.length > 0 && (要全删吗 ? (
                  <>
                    <button className="danger" disabled={!!busy} onClick={() => { set要全删吗(false); void dropFor(); }}>
                      确认删掉这 {books.length} 本的索引
                    </button>
                    <button onClick={() => set要全删吗(false)}>取消</button>
                  </>
                ) : (
                  <button disabled={!!busy} onClick={() => set要全删吗(true)}>删掉全部索引</button>
                ))}
              </div>
              <p className="muted">给 TXT 按本建索引。原文件保持原样。</p>
              {books.length > 0 && (
                <ul className="search-index-list">
                  {books.map((b) => (
                    <li key={b.bookId}>
                      <span className="search-index-title" title={b.title}>{b.title}</span>
                      <span className="muted">{b.chapters} 章</span>
                      <button disabled={!!busy} aria-label={`删除《${b.title}》的索引`} onClick={() => void dropFor(b.bookId)}>
                        删索引
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                autoFocus
                className="search-index-pick"
                type="search"
                value={pick}
                aria-label="输入书名，选择要建索引的书"
                onChange={(e) => setPick(e.target.value)}
                placeholder="输入书名，选择要建索引的书"
              />
              {picks.length > 0 && (
                <div className="search-index-picks">
                  {picks.map((b) => {
                    const 建过 = books.some((x) => x.bookId === b.bookId);
                    const 没正文 = !b.chapters;
                    return (
                      <button key={b.bookId} disabled={!!busy || 建过 || 没正文} onClick={() => void buildFor(b.bookId, b.title)}>
                        {b.title} <span>{建过 ? '已建索引' : 没正文 ? '没有可索引的正文' : '建索引'}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {busy && <p className="search-feedback muted" role="status">{busy}</p>}
          {error && <p className="search-feedback danger" role="alert">{error}</p>}
          {searchError ? <p className="search-feedback danger" role="alert">{searchError}</p> : searching ? (
            <p className="search-feedback muted" role="status">正在搜索…</p>
          ) : scope === 'meta' && meta.length ? (
            <>
              <p className="search-feedback muted" role="status">匹配 {meta.length} 本</p>
              <ul className="library-result-list">
                {meta.map((m) => {
                  const tags = 拆标签(m.tags);
                  const visibleTags = [...tags].sort((a, b) =>
                    Number(b.toLowerCase().includes(term)) - Number(a.toLowerCase().includes(term))).slice(0, 4);
                  return (
                    <li key={m.bookId}>
                      <button className="library-result" onClick={() => onOpen(m.bookId)}>
                        <span className="library-result-heading">
                          <strong>{m.title}</strong>
                          {showRating && m.rating != null && <span className="book-rating">★{m.rating}</span>}
                        </span>
                        {m.author && <span className="library-result-meta">{m.author}</span>}
                        {m.comment && <span className="book-note" title={m.comment}>{m.comment}</span>}
                        {tags.length > 0 && (
                          <span className="library-result-tags" title={tags.join('、')}>
                            {visibleTags.map((tag) => <span className="chip sm" key={tag}>{tag}</span>)}
                            {tags.length > visibleTags.length && (
                              <span className="muted">其余 {tags.length - visibleTags.length} 个标签</span>
                            )}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : scope === 'full' && hits.length ? (
            <>
              <p className="search-feedback muted" role="status">显示 {hits.length} 处匹配</p>
              <ul className="library-result-list">
                {hits.map((h, i) => (
                  <li key={i}>
                    <button className="library-result" onClick={() => onOpen(h.bookId, h.chapterIdx)}>
                      <span className="library-result-heading"><strong>{h.bookTitle}</strong></span>
                      <span className="library-result-meta">{h.chapterTitle}</span>
                      <span className="library-result-snippet"><Snippet text={h.snippet} /></span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="library-search-empty">
              {scope === 'meta' ? q.trim() ? (
                <>
                  <strong>没有匹配的书</strong>
                  <button onClick={() => setScope('full')}>切到「正文内容」</button>
                </>
              ) : <p>输入书名、别名、作者、标签或你写过的短评。</p> : books.length ? (
                <p>{q.trim() ? '已建索引的正文中没有匹配内容。' : '输入记得的词或句子，查找所在章节。'}</p>
              ) : !manageIndex && (
                <>
                  <strong>还没有可搜的正文</strong>
                  <button onClick={() => setManageIndex(true)}>给一本书建索引</button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="modal-actions library-search-foot">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
