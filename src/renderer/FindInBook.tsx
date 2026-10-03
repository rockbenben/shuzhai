import { useEffect, useRef, useState } from 'react';

export interface Hit {
  chapterIdx: number;
  chapterTitle: string;
  /** 上下文片段，命中词用 【】 包起来（格式见 `core/snippet.ts`） */
  snippet: string;
  /**
   * 这是**本节**（txt 的一章 / PDF 的一页 / EPUB 的一节）里的第几处，从 1 起。
   * 正本是 `core/search.ts` 的 `SearchHit.ordinal`，理由写在那儿。
   *
   * ⚠️ **可选。** 全库那一档（FTS5 的 `snippet()`）给不出位置；PDF / EPUB 的
   * 搜法在渲染进程里，得自己数。给不出就照老样子落到节首。
   */
  ordinal?: number;
}

interface Props {
  /**
   * **怎么搜由调用方给。**
   *
   * ⚠️ 这一层原来写死了 `rpc('search.inBook')`，而那条路只有纯文本书走得通
   * （它靠章节表和字节偏移）。PDF / EPUB 的正文**只有渲染进程拿得到**
   * （pdf.js 的文字层、epub.js 加载的那一节），根本没法走 rpc。
   *
   * 于是外壳共用、搜法分岔——判据和 `highlight-view.ts` 的 `画布` 是同一条：
   * 界面（输入、回车、命中列表、`【】` 高亮、跳转）三种格式一个字都不用改。
   */
  搜: (query: string) => Promise<Hit[]>;
  /**
   * 跳到这一处。**连着「搜的是哪个词」一起给**——落点那边要在已经画出来的
   * 正文里数出第 `ordinal` 处（见 `highlight-view.ts` 的 `找第几处`），
   * 而那个词只有这一层知道。
   */
  onJump: (hit: Hit, 词: string) => void;
  onClose: () => void;
  /**
   * 这一层的根元素。**为的是关掉之后把焦点还给开它那颗键**——
   * 另外几层靠 `useAnchored` 顺带拿到了这条，这一层不贴着键开，
   * 于是实测关掉后焦点掉在 `BODY`：键盘用户再按 Tab 是从页面最开头重新走。
   */
  层Ref?: React.RefObject<HTMLDivElement | null>;
  /**
   * 结果封顶在多少处。
   *
   * ⚠️ **给了就一定要说出来。** 这个仓库那条老规矩：**悄悄截断，
   * 读起来就是「一共就这么多」**——用户会以为这本书里只有这几处，
   * 然后停止翻找。查看器那半逐页解析 PDF，不封顶会等好几秒。
   */
  上限?: number;
}

/**
 * 书内搜索（spec §6）。**不依赖全文索引**——只有一本书，逐章逐页读就够快，
 * 而且没建索引的人也能用。
 */
export function FindInBook({ 搜, onJump, onClose, 上限, 层Ref }: Props) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      setHits(await 搜(q));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reader-pop find-panel" aria-label="书内搜索" ref={层Ref} onClick={(e) => e.stopPropagation()}>
      <div className="row">
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
            if (e.key === 'Escape') onClose();
          }}
          placeholder="在这本书里找一段话"
          style={{ flex: 1 }}
        />
        <button onClick={() => void search()} disabled={busy || !q.trim()}
          title={busy ? undefined : '先打几个字'}>
          {busy ? '搜索中…' : '搜索'}
        </button>
        {/* 裸一个 × 的话，读屏念出来是「×」——这个仓库有条通则：
            **能点的图形要带名字**（`docs/lessons.md`「色块按钮要带名字」那一节） */}
        {/* ⚠️ `aria-label` 不能省：`find.mjs` 靠「面板里那颗带 aria-label 的键」认出口
            （改文案那次飘的是 title，这一轮飘的是它——**探针按界面属性匹配，属性就是接口**）。
            可见文字是「收起」，和另外几层同一个词。 */}
        <button className="quiet" onClick={onClose} aria-label="收起书内搜索" title="收起这一层">收起</button>
      </div>

      {hits !== null && (
        <p className="muted" style={{ fontSize: '0.8rem', margin: '0.4rem 0 0.2rem' }}>
          {hits.length === 0
            ? '没有找到'
            : 上限 && hits.length >= 上限
              ? `命中很多，只列了前 ${上限} 处——换个更长的词能少一些`
              : `命中 ${hits.length} 处`}
        </p>
      )}

      {hits?.map((h, i) => (
        <button key={i} className="find-hit" onClick={() => { onJump(h, q.trim()); onClose(); }}>
          <div className="muted" style={{ fontSize: '0.75rem' }}>{h.chapterTitle}</div>
          <div>
            {h.snippet.split(/(【[^】]*】)/).map((part, j) =>
              part.startsWith('【') ? (
                <mark key={j} style={{ background: 'transparent', color: 'var(--accent)', fontWeight: 600 }}>
                  {part.slice(1, -1)}
                </mark>
              ) : (
                <span key={j}>{part}</span>
              ),
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
