import { useEffect, useState } from 'react';
import { rpc } from './rpc.ts';
// 从 core 引：这里只用到书名/作者/封面/地址几个字段，但类型的正本在那边（`enrich.ts`）
import type { Candidate } from '../core/enrich.ts';
import { blankSource, parseSources, serializeSources, type CustomSource } from '../core/cover-custom.ts';


interface TestResult { ok: boolean; found: number; candidates: Candidate[]; error?: string }

/**
 * 自定义书源。
 *
 * 输入书名、输出这本书的主页地址：命中后会再读那个详情页，
 * 封面、简介、作者、分类一起补。阅读走本地 txt，不受影响。
 * 内置 8 个站点都在代码里（`site-adapters.ts`）：起点要浏览器渲染、豆瓣藏在 JSON 里、
 * 书旗只收精确匹配块、晋江/飞卢是 GBK，硬塞进同一套正则配置只会做出个残缺的 DSL。
 * 进搜索链的是能按书名搜的三个（起点/书旗/豆瓣）；另外五个不进搜索链——纵横、番茄、
 * 晋江、独阅读还能查更新，飞卢只解析详情页。
 *
 * **绝不执行配置的 JS**（和朗读引擎同一条铁律）。只认「搜索地址 + 几条正则」，
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
      <span className="muted" style={{ minWidth: '5rem', fontSize: '0.82rem' }} title={hint}>{label}</span>
      <input
        value={String(s[k] ?? '')}
        onChange={(e) => patch(s.id, { [k]: e.target.value } as Partial<CustomSource>)}
        style={{ flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }}
      />
    </label>
  );

  return (
    <>
      <h3>自定义书源</h3>
      <p className="muted" style={{ fontSize: '0.82rem', margin: '0 0 0.5rem' }}>
        内置 8 个站点都不用在这里配——起点、书旗、豆瓣能按书名搜（搜索链就是这三个）；
        纵横、番茄、独阅读、晋江、飞卢不进搜索链，但在「在线地址」那栏粘它们的详情页链接
        照样认得出。这里加的源在<strong>起点、书旗都没找到时</strong>才轮到，最后才是豆瓣兜底。
        <br />
        搜到书之后会再读它的详情页，<strong>封面、简介、分类一起补</strong>，不影响阅读。规则里
        <strong>不支持 JS</strong>：这些配置常常是从别处拿来的，跑陌生人的代码换几个源不划算。
      </p>

      {list.map((s) => (
        <div key={s.id} className="card" style={{ marginBottom: '.5rem', padding: '0.6rem 0.8rem' }}>
          <div className="row" style={{ gap: '.5rem' }}>
            <label className="row" style={{ gap: '.3rem' }}>
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => patch(s.id, { enabled: e.target.checked })}
                // 这一整排只有一个 <label> 包着两个控件，而 label 里没有文字——
                // 读屏念出来是「复选框、编辑框」，不知道是哪一个源的开关
                aria-label={`启用「${s.name || '这个源'}」`}
              />
              <input
                value={s.name}
                onChange={(e) => patch(s.id, { name: e.target.value })}
                placeholder="源的名字"
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
              {field(s, 'searchUrl', '搜索地址', '{q} 会被换成书名，中文不用你管编码')}
              <label className="row" style={{ gap: '.4rem', marginBottom: '.35rem' }}>
                <span className="muted" style={{ minWidth: '5rem', fontSize: '0.82rem' }}>浏览器渲染</span>
                <input
                  type="checkbox"
                  checked={s.needsBrowser}
                  onChange={(e) => patch(s.id, { needsBrowser: e.target.checked })}
                />
                <span className="muted" style={{ fontSize: '0.78rem' }}>
                  只有那种「页面要用浏览器画得出来」的站才勾。勾了会慢很多
                </span>
              </label>
              {field(s, 'blockRe', '结果块', '每条搜索结果的整块。不圈块的话书名和作者会各找各的，对不上号')}
              {field(s, 'titleRe', '书名', '第 1 个捕获组是书名')}
              {field(s, 'authorRe', '作者', '第 1 个捕获组是作者。没有作者的候选一律不会被采用')}
              {field(s, 'urlRe', '详情页地址', '第 1 个捕获组是这本书的主页地址，相对路径自动补全；配了它才补得了简介和分类')}
              {field(s, 'coverRe', '封面（可选）', '第 1 个捕获组是图片地址。详情页没给图时才用它兜底')}
            </div>
          )}

          {result[s.id] && (
            <p className="muted" style={{ fontSize: '0.8rem', margin: '0.4rem 0 0' }}>
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
