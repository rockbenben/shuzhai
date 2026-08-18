import { useEffect, useRef, useState } from 'react';

export interface Hit {
  chapterIdx: number;
  chapterTitle: string;
  /** 上下文片段，命中词用 【】 包起来（格式见 `core/snippet.ts`） */
  snippet: string;
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
  onJump: (chapterIdx: number) => void;
  onClose: () => void;
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
export function FindInBook({ 搜, onJump, onClose, 上限 }: Props) {
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
    <div className="reader-pop find-panel" onClick={(e) => e.stopPropagation()}>
      <div className="row">
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
            if (e.key === 'Escape') onClose();
          }}
          placeholder="在这本书里搜"
          style={{ flex: 1 }}
        />
        <button onClick={() => void search()} disabled={busy || !q.trim()}>
          {busy ? '搜索中…' : '搜索'}
        </button>
        <button onClick={onClose} style={{ padding: '.2em .5em' }}>×</button>
      </div>

      {hits !== null && (
        <p className="muted" style={{ fontSize: '.8rem', margin: '.4rem 0 .2rem' }}>
          {hits.length === 0
            ? '没有找到'
            : 上限 && hits.length >= 上限
              ? `命中很多，只列了前 ${上限} 处——换个更长的词能少一些`
              : `命中 ${hits.length} 处`}
        </p>
      )}

      {hits?.map((h, i) => (
        <button key={i} className="find-hit" onClick={() => { onJump(h.chapterIdx); onClose(); }}>
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
