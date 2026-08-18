import { useEffect, useState } from 'react';
import { rpc } from './rpc.ts';
// 从 core 引：这里只用到书名/作者/封面三样，但类型的正本在那边（`enrich.ts`）
import type { Candidate } from '../core/enrich.ts';
import { blankSource, parseSources, serializeSources, type CustomSource } from '../core/cover-custom.ts';


interface TestResult { ok: boolean; found: number; candidates: Candidate[]; error?: string }

/**
 * 自定义封面搜索源。
 *
 * **只管封面**——阅读走本地 txt，这里只是「去哪儿找一张图和书名作者」。
 * 内置那三个（起点/书旗/豆瓣）仍然是代码：它们各有各的坑（起点要浏览器渲染、
 * 豆瓣藏在 JSON 里、书旗只收精确匹配块），硬塞进同一套正则配置只会做出个残缺的 DSL。
 *
 * **绝不执行配置里的 JS**（和朗读引擎同一条铁律）。只认「搜索地址 + 四条正则」，
 * 表达不了的源就别加——多几个源换「跑陌生人的代码」，这笔账怎么算都不划算。
 */
export function CoverSources() {
  const [list, setList] = useState<CustomSource[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, TestResult>>({});

  useEffect(() => {
    void rpc<string>('setting.get', { key: 'cover.customSources' })
      .then((raw) => setList(parseSources(raw)))
      .catch(() => {});
  }, []);

  const save = (next: CustomSource[]) => {
    setList(next);
    void rpc('setting.set', { key: 'cover.customSources', value: serializeSources(next) });
  };

  const patch = (id: string, p: Partial<CustomSource>) =>
    save(list.map((s) => (s.id === id ? { ...s, ...p } : s)));

  const field = (s: CustomSource, k: keyof CustomSource, label: string, hint: string) => (
    <label className="row" style={{ gap: '.4rem', marginBottom: '.35rem', alignItems: 'baseline' }}>
      <span className="muted" style={{ minWidth: '5rem', fontSize: '.82rem' }} title={hint}>{label}</span>
      <input
        value={String(s[k] ?? '')}
        onChange={(e) => patch(s.id, { [k]: e.target.value } as Partial<CustomSource>)}
        style={{ flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: '.8rem' }}
      />
    </label>
  );

  return (
    <>
      <h3>自定义封面搜索源</h3>
      <p className="muted" style={{ fontSize: '0.82rem', margin: '0 0 .5rem' }}>
        内置的起点、书旗、豆瓣不在这里——它们各自有专门的解析逻辑。这里加的源
        <strong>排在它们之后</strong>，前面都没找到才会问。
        <br />
        <strong>只用来找封面</strong>，不影响阅读。规则里
        <strong>不支持 JS</strong>：这些配置常常是从别处拿来的，跑陌生人的代码换几个源不划算。
      </p>

      {list.map((s) => (
        <div key={s.id} className="card" style={{ marginBottom: '.5rem', padding: '.6rem .8rem' }}>
          <div className="row" style={{ gap: '.5rem' }}>
            <label className="row" style={{ gap: '.3rem' }}>
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => patch(s.id, { enabled: e.target.checked })}
              />
              <input
                value={s.name}
                onChange={(e) => patch(s.id, { name: e.target.value })}
                style={{ width: '8rem' }}
              />
            </label>
            <span style={{ flex: 1 }} />
            <button onClick={() => setOpen(open === s.id ? null : s.id)}>
              {open === s.id ? '收起' : '编辑规则'}
            </button>
            <button
              disabled={testing === s.id}
              onClick={() => void (async () => {
                setTesting(s.id);
                try {
                  const r = await rpc<TestResult>('cover.testSource', { source: s });
                  setResult((m) => ({ ...m, [s.id]: r }));
                } finally {
                  setTesting(null);
                }
              })()}
            >
              {testing === s.id ? '试着…' : '用《斗破苍穹》试一下'}
            </button>
            <button onClick={() => save(list.filter((x) => x.id !== s.id))} title="删掉这个源">×</button>
          </div>

          {open === s.id && (
            <div style={{ marginTop: '.5rem' }}>
              {field(s, 'searchUrl', '搜索地址', '{q} 会被换成书名（已 URI 编码）')}
              <label className="row" style={{ gap: '.4rem', marginBottom: '.35rem' }}>
                <span className="muted" style={{ minWidth: '5rem', fontSize: '.82rem' }}>浏览器渲染</span>
                <input
                  type="checkbox"
                  checked={s.needsBrowser}
                  onChange={(e) => patch(s.id, { needsBrowser: e.target.checked })}
                />
                <span className="muted" style={{ fontSize: '.78rem' }}>
                  站点是 SPA（普通请求拿到空壳）才勾。勾了会慢一个数量级
                </span>
              </label>
              {field(s, 'blockRe', '结果块', '每条搜索结果的整块。不圈块的话书名和作者会各找各的，对不上号')}
              {field(s, 'titleRe', '书名', '第 1 个捕获组是书名')}
              {field(s, 'authorRe', '作者', '第 1 个捕获组是作者。没有作者的候选一律不会被采用')}
              {field(s, 'coverRe', '封面', '第 1 个捕获组是图片地址')}
            </div>
          )}

          {result[s.id] && (
            <p className="muted" style={{ fontSize: '.8rem', margin: '.4rem 0 0' }}>
              {result[s.id].ok
                ? `抽到 ${result[s.id].found} 条：` + result[s.id].candidates
                  .map((c) => `《${c.title}》${c.author ?? '（没抽到作者）'}`).join('、')
                : <span className="danger">{result[s.id].error ?? '没抽到候选'}</span>}
            </p>
          )}
        </div>
      ))}

      <button onClick={() => save([...list, blankSource(`src-${list.length + 1}-${Date.now()}`)])}>
        加一个源
      </button>
    </>
  );
}
