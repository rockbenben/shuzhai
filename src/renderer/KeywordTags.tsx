import { useEffect, useState } from 'react';
import { rpc } from './rpc.ts';
import type { Tag } from '../core/library.ts';

interface Keyword {
  word: string;
  count: number;
}

interface Props {
  /** 选中一个词：把它填进搜索框、并带着这个词去开批量打标签 */
  onPick: (word: string) => void;
  onClose: () => void;
}

/**
 * 按书名打标签（个人评价体系的配套，见
 * specs/2026-08-14-personal-reviews-design.md）。
 *
 * 存在的理由很具体：批量打标签作用于筛选结果，而这个库的唯一批量抓手是
 * **书名关键词**——可用户打开应用看到的是 8172 本、0 个标签，
 * 不知道该往搜索框里敲什么。这里把书名里的高频词直接列出来，
 * 点一条就搜出来 + 预填标签名。实测前 40 个词覆盖 30% 的书。
 *
 * 已经用过的词会标出来，这样翻一遍就知道自己铺到哪儿了——
 * 八千本靠几十次点击铺开，没有进度感是走不完的。
 */
export function KeywordTags({ onPick, onClose }: Props) {
  const [words, setWords] = useState<Keyword[] | null>(null);
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [w, t] = await Promise.all([
          rpc<Keyword[]>('library.titleKeywords'),
          rpc<Tag[]>('tag.list'),
        ]);
        setWords(w);
        setTags(new Set(t.map((x) => x.name)));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>按书名打标签</h2>
        {error && <p className="danger">{error}</p>}
        {words === null && <p className="muted">正在统计…</p>}

        {words && words.length === 0 && (
          <p className="muted" style={{ margin: '.2rem 0 0' }}>
            书名里没有反复出现的词，这一步帮不上忙——书名各不相同的库，
            直接用上面的搜索框按关键词找，再「批量打标签」。
          </p>
        )}

        {/* 说明和词表**同一个条件**，所以在同一个块里。一个词都没数出来时
            这段不铺出来——它讲的是「点一个词会怎样」，而此刻一个词都点不到；
            教一个不存在的操作，比不教更让人困惑（同一条道理在「重复的书」
            和预览表「只列会变的那些」上都记过） */}
        {words && words.length > 0 && (
          <>
          <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
            书名里反复出现的词，按出现次数排。<strong>点一个词</strong>就会搜出这些书、
            并带着这个词去打标签——你在那一步还能改标签名、也能反悔。
            <br />
            已经建过同名标签的会标灰，方便你知道铺到哪儿了。
          </p>
          <div className="kw-grid">
            {words.map((k) => (
              <button
                key={k.word}
                className={`chip${tags.has(k.word) ? ' used' : ''}`}
                onClick={() => onPick(k.word)}
                title={tags.has(k.word) ? `已经有「${k.word}」这个标签了` : `搜出这 ${k.count} 本并打上「${k.word}」`}
              >
                {k.word}
                <span className="muted"> {k.count}</span>
              </button>
            ))}
          </div>
          </>
        )}

        <div className="row modal-actions" style={{ marginTop: '.9rem', justifyContent: 'flex-end' }}>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
