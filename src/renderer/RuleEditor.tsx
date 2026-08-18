import { useCallback, useEffect, useState } from 'react';
import { rpc } from './rpc.ts';
import type { Suggestion } from '../core/suggest.ts';

interface Preview {
  count: number;
  titles: string[];
  recognized: boolean;
  ruleName: string;
}

interface Props {
  bookId: number;
  bookTitle: string;
  onClose: (changed: boolean) => void;
}


/**
 * 常见写法的现成正则。**只在猜不出来时才显示**——
 * 从书自己的正文里算出来的建议永远比一张通用清单准
 */
/*
 * 章节规则的预设。**名字里带 RULE 是有意的**：`core/rename.ts` 里也有个 `PRESETS`，
 * 那是改名的文件名模板。同一个名字两件事，比两份同名的东西更容易读错
 * （同 `Mark`／`BookmarkRow` 那次）。
 */
const RULE_PRESETS: Array<{ label: string; pattern: string }> = [
  { label: '第X章 / 第X节', pattern: '^第[〇零一二三四五六七八九十百千万\\d]+[章节]' },
  { label: 'Chapter N', pattern: '^[Cc]hapter\\s+\\d+' },
  { label: '【第X章】', pattern: '^【第?[〇零一二三四五六七八九十百千万\\d]+章?】' },
  { label: '纯数字编号（1. / 1、）', pattern: '^\\d+\\s*[.、．]' },
  { label: '空行分隔的短标题行', pattern: '^\\S.{0,18}$' },
];

/**
 * 章节规则编辑器（spec §2.2）。
 * 形状由一条规矩定死：**先预览，确认了才落库**。所以「应用」按钮在预览出来之前不可点。
 */
export function RuleEditor({ bookId, bookTitle, onClose }: Props) {
  const [pattern, setPattern] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  /** null = 还在算。空数组 = 算完了但一条都没猜出来 */
  const [suggests, setSuggests] = useState<Suggestion[] | null>(null);
  /**
   * 打开这个弹窗时这本书**本来**切成几章、认没认出来。
   *
   * 有了它才能把建议说成人话：「切成 45 章」对一个不知道自己书里有多少章的人
   * 没有意义，「比现在少 34 章」才有。也才能在书本来就切得好的时候先说一句
   * 「不用动」——多数人点开「章节」只是想看看，不是来写正则的。
   */
  const [base, setBase] = useState<{ count: number; recognized: boolean } | null>(null);

  const runPreview = useCallback(
    async (p: string) => {
      setError(null);
      try {
        setPreview(await rpc<Preview>('chapter.preview', { bookId, pattern: p || undefined }));
      } catch (e) {
        setPreview(null);
        setError((e as Error).message);
      }
    },
    [bookId],
  );

  useEffect(() => {
    void (async () => {
      const cur = await rpc<string | null>('chapter.rule', { bookId });
      setSaved(cur);
      setPattern(cur ?? '');
      const p = await rpc<Preview>('chapter.preview', { bookId, pattern: cur ?? undefined });
      setPreview(p);
      // 记下「本来的样子」，后面所有说法都拿它当参照
      setBase({ count: p.count, recognized: p.recognized });
    })();
  }, [bookId]);

  // 猜规则要整本扫一遍（34MB 的书约 0.8 秒），和上面的预览并行跑，别让它卡住开场
  useEffect(() => {
    let alive = true;
    rpc<Suggestion[]>('chapter.suggest', { bookId })
      .then((s) => alive && setSuggests(s))
      .catch(() => alive && setSuggests([]));
    return () => { alive = false; };
  }, [bookId]);

  // 边打字边预览，但等手停下来再算——每敲一个字就整本重解析太浪费
  useEffect(() => {
    const t = setTimeout(() => void runPreview(pattern), 350);
    return () => clearTimeout(t);
  }, [pattern, runPreview]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await rpc<Preview>('chapter.applyRule', { bookId, pattern }));
      setSaved(pattern);
      setChanged(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      setPreview(await rpc<Preview>('chapter.clearRule', { bookId }));
      setSaved(null);
      setPattern('');
      setChanged(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => onClose(changed)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>章节怎么切 · {bookTitle}</h2>
        {/*
          * **开场先说这本书现在什么样**，而不是上来就讲正则。
          *
          * 多数人点开「章节」只是想看看，本来就切得好的书应该当场得到
          * 「不用动」这个答案。原来第一句是「内置规则认不出章节时用这里。
          * 写一条正则……」——一本已经切成 45 章的书也这么讲，等于催着人去改
          * 一个没坏的东西。
          */}
        <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
          {base === null ? (
            '正在看这本书现在切成几章…'
          ) : base.recognized && base.count > 1 ? (
            <>
              这本书现在切成 <strong>{base.count} 章</strong>，标题也认出来了。
              只有当你觉得下面这份目录不对，才需要动它——
              <strong>换规则会先试算给你看，不满意就别点应用。</strong>
            </>
          ) : (
            <>
              {/* 这句话必须和目录里**真正显示的**字一致。原来写「目录里都是
                  『第 N 段』」，而实际是「未识别章节 N」——对不上的说明比没有
                  说明更让人犯嘀咕：到底是我看错了还是它坏了 */}
              <strong>没能认出这本书的章节标题</strong>——现在是按固定字数硬分的段，
              目录里那些「未识别章节 N」就是这么来的。下面挑一个格式试试，
              <strong>试算满意了再点应用</strong>。
            </>
          )}
        </p>

        {suggests === null && (
          <p className="muted" style={{ margin: '0 0 .5rem', fontSize: '.85rem' }}>
            正在从这本书里找可能的标题格式…
          </p>
        )}

        {suggests !== null && suggests.length > 0 && (
          <div className="card" style={{ marginBottom: '.6rem' }}>
            <div style={{ fontSize: '.85rem', marginBottom: '.4rem' }}>
              <strong>从这本书自己的正文里找到的格式</strong>
              <span className="muted">　点一条看看它会切成什么样</span>
            </div>
            {suggests.map((s) => {
              /*
               * **和「现在」比，不是光报个数。**
               *
               * 一本已经切成 45 章的书，建议列表里四条各只有 11 章——那是把书
               * 剁碎，而原来它们和真正有用的建议长得一模一样（都是「11 章 + 几个
               * 例子」）。不认识正则的人只能挨个点，点错了就得再点回来。
               */
              const worse = base !== null && base.recognized && s.hits < base.count * 0.6;
              return (
                <button
                  key={s.pattern}
                  className="suggest"
                  onClick={() => setPattern(s.pattern)}
                  title={s.pattern}
                >
                  <span className="suggest-n">
                    切成 {s.hits} 章
                    {worse && (
                      <span className="muted" style={{ fontWeight: 400 }}>
                        （比现在少 {base!.count - s.hits}）
                      </span>
                    )}
                  </span>
                  <span className="suggest-eg">{s.samples.join('　·　')}</span>
                </button>
              );
            })}
          </div>
        )}

        {suggests !== null && suggests.length === 0 && (
          <div className="row" style={{ marginBottom: '.5rem' }}>
            <span className="muted" style={{ fontSize: '.82rem', alignSelf: 'center' }}>
              这本书里没找到反复出现的标题格式，试试这些常见写法：
            </span>
            {RULE_PRESETS.map((p) => (
              <button key={p.label} onClick={() => setPattern(p.pattern)} style={{ fontSize: '.82rem' }}>
                {p.label}
              </button>
            ))}
          </div>
        )}

        {/*
          * **正则收进折叠区。** 不写正则的人这辈子不用打开它，而原来它是这个
          * 弹窗里最显眼的一行输入框，占位符还直接写着「正则」——
          * 对认识的人是多余的提示，对不认识的人是一句听不懂的话加一个死胡同。
          * 点上面的建议照样会把内容填进来，折叠区会自动展开给人看到发生了什么。
          */}
        <details open={!!pattern}>
          <summary style={{ fontSize: '.85rem', cursor: 'pointer', color: 'var(--muted)', margin: '.2rem 0 .4rem' }}>
            自己写规则（要会正则表达式）
          </summary>
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="留空就用内置规则。拿去匹配的是每一行（首尾空白已去掉）"
            style={{ width: '100%', fontFamily: 'ui-monospace, monospace' }}
          />
        </details>

        {error && <p className="danger" style={{ marginBottom: 0 }}>{error}</p>}

        {preview && !error && (
          <div className="card" style={{ marginTop: '.7rem' }}>
            <strong>
              {/* 「将切出」对没改过任何东西的人是句怪话——那是现状不是「将」 */}
              {pattern === (saved ?? '') ? '现在切成' : '会切成'} {preview.count} 章
              {!preview.recognized && '——一条标题都没认出来，这是按固定字数硬分的段'}
            </strong>
            <ol style={{ margin: '.5rem 0 0', paddingLeft: '1.4rem', fontSize: '.87rem', maxHeight: '13rem', overflowY: 'auto' }}>
              {preview.titles.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ol>
            {preview.count > preview.titles.length && (
              <p className="muted" style={{ margin: '.4rem 0 0', fontSize: '.82rem' }}>
                只列出前 {preview.titles.length} 章
              </p>
            )}
          </div>
        )}

        {/* **用 `.modal-actions`（它是 sticky 的），不是普通的一行。**
            `scripts/ui-check/audit.mjs` 在 1280×720 上量到「应用这条规则」要往下
            滚 37px 才够得到——「能滚」和「找得到」是两条判据，而这个弹窗的
            全部意义就是点那一下。同一个 class 已经在设置 / 编辑 / 正文净化上用着 */}
        <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
          {saved && (
            <button onClick={clear} disabled={busy}>
              清除自定义规则
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={() => onClose(changed)}>关闭</button>
          <button
            className="primary"
            onClick={apply}
            disabled={busy || !pattern || !preview || !!error || pattern === saved}
          >
            {pattern === saved && saved ? '已应用' : '应用这条规则'}
          </button>
        </div>
      </div>
    </div>
  );
}
