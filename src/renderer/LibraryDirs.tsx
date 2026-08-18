import { useCallback, useEffect, useState } from 'react';
import type { ScanReport } from '../core/scan.ts';
import { rpc } from './rpc.ts';

export interface Root {
  id: number;
  path: string;
  enabled: number;
}

interface Preview {
  affected: number;
  samples: string[];
  withProgress: number;
}

/**
 * 书库目录与屏蔽规则（spec §1.1）。
 *
 * 这个界面要反复说清一件事：**屏蔽和停用都只影响以后的扫描，一本书都不会删。**
 * 阅读进度、书签、评分是重扫恢复不了的，因为改了个扫描规则就抹掉它们
 * 是不可接受的。
 */
export function LibraryDirs({ onClose }: { onClose: (changed: boolean) => void }) {
  const [roots, setRoots] = useState<Root[]>([]);
  /** 正在确认移除的那个书库文件夹。移除会把它底下所有书的记录变成孤儿 */
  const [killing, setKilling] = useState<number | null>(null);
  const [patterns, setPatterns] = useState<string[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  /** 正在选目录/扫描。选目录会弹系统对话框，扫描要走一遍磁盘 */
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setRoots(await rpc<Root[]>('root.list'));
    const g = await rpc<{ patterns: string[]; defaults: string[] }>('ignore.get');
    setPatterns(g.patterns);
    setDefaults(g.defaults);
  }, []);

  useEffect(() => {
    reload().catch((e: Error) => setError(e.message));
  }, [reload]);

  // 改一条规则就立刻试算影响范围——写错一个星号是看不出来的
  useEffect(() => {
    const t = setTimeout(() => {
      rpc<Preview>('ignore.preview', { patterns })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(t);
  }, [patterns]);

  const save = async (next: string[]) => {
    setError(null);
    try {
      await rpc('ignore.set', { patterns: next });
      setPatterns(next);
      setChanged(true);
      setMsg('已保存，下次扫描生效');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 登记一个书库目录。**扫描在 rpc 层做**（root.add 自己会扫这个新目录） */
  const addRoot = async () => {
    setError(null);
    setBusy(true);
    try {
      const path = await rpc<string | null>('ui.pickFolder');
      if (!path) return;
      const { report } = await rpc<{ report: ScanReport }>('root.add', { path });
      setChanged(true);
      // **只刷 roots**。整个 reload() 会连屏蔽规则一起重取，而 setPatterns 换了
      // 数组身份又会触发那个 debounce 的 ignore.preview——白跑一趟全库 glob 匹配
      setRoots(await rpc<Root[]>('root.list'));
      const skipped = Object.values(report.skipped).reduce((a, b) => a + (b ?? 0), 0);
      setMsg(
        report.added > 0
          ? `收进来 ${report.added} 本`
          : skipped > 0
            // 「扫完还是空的」必须有解释，否则用户只能怀疑是程序坏了
            ? `没收到书：跳过了 ${skipped} 个文件（太小、被屏蔽或读不了）`
            : '这个文件夹里没有找到书',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickDirToBlock = async () => {
    setError(null);
    const dir = await rpc<string | null>('ui.pickFolder');
    if (!dir) return;
    try {
      const { pattern } = await rpc<{ pattern: string }>('ignore.globForDir', { dir });
      if (patterns.includes(pattern)) {
        setMsg('这个文件夹已经在屏蔽列表里了');
        return;
      }
      await save([...patterns, pattern]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => onClose(changed)}>
      <div className="modal" style={{ width: 'min(48rem, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 .8rem', fontSize: '1.1rem' }}>书库文件夹</h2>

        <div className="row" style={{ justifyContent: 'space-between', margin: '0 0 .3rem' }}>
          <h3 style={{ fontSize: '.95rem', margin: 0 }}>放书的文件夹</h3>
          <button disabled={busy} onClick={() => void addRoot()}>
            {busy ? '正在读…' : '添加文件夹…'}
          </button>
        </div>
        {roots.length === 0 ? (
          <p className="muted">还没有文件夹。点右上角「添加文件夹」，选一个放 txt 的地方。</p>
        ) : (
          <table>
            <tbody>
              {roots.map((r) => (
                <tr key={r.id}>
                  <td style={{ width: '5.5rem' }}>
                    <label className="row" style={{ gap: '.3rem', fontSize: '0.82rem' }}>
                      <input
                        type="checkbox"
                        checked={r.enabled === 1}
                        onChange={async (e) => {
                          await rpc('root.setEnabled', { id: r.id, enabled: e.target.checked });
                          setChanged(true);
                          await reload();
                        }}
                      />
                      {r.enabled === 1 ? '启用' : '停用'}
                    </label>
                  </td>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: '.8rem', overflowWrap: 'anywhere' }}>
                    {r.path}
                  </td>
                  {/*
                    * **移除要问一次。** 这一下会让这个文件夹底下所有书的记录
                    * 变成孤儿：扫描遍历不到、文件没了也标不上，在书架上装作一切正常，
                    * 点开才报错（AGENTS.md 那节记着这个形状）。真实库里那个文件夹
                    * 装着八千多本——一次误点就是整个书库进入这种状态。
                    * 两段式，不用 `window.confirm`（原生模态框和这个应用不是一套）。
                    */}
                  <td style={{ width: '9rem' }}>
                    {killing === r.id ? (
                      <div className="row" style={{ gap: '.3rem' }}>
                        <button
                          className="danger"
                          style={{ fontSize: '.75rem', padding: '.1em .45em' }}
                          onClick={async () => {
                            setKilling(null);
                            /*
                             * **移完要说一句「怎么救回来」。** 那些记录现在没人管了：
                             * 扫描遍历不到、文件没了也标不上，在书架上装作一切正常，
                             * 点开才报错。用户此刻看到的是一个「好像还在、其实空了」的书库，
                             * 而这句话是他唯一会照着做的（同 `reader.ts` 的 `openHint` 那条）。
                             */
                            const out = await rpc<{ orphaned: number }>(
                              'root.remove', { id: r.id, confirmed: true },
                            );
                            setChanged(true);
                            await reload();
                            setMsg(
                              out.orphaned > 0
                                ? `已移除。这个文件夹底下的 ${out.orphaned} 条记录现在没人管了——`
                                  + '把文件夹加回来重新扫描就能认领回去；确定不要了的话，'
                                  + '到「设置 → 书库」点「整理数据库」清掉。'
                                : '已移除。',
                            );
                          }}
                          title="书和阅读进度都留着，但那些记录会变成没人管的孤儿"
                        >
                          确认移除
                        </button>
                        <button
                          style={{ fontSize: '.75rem', padding: '.1em .45em' }}
                          onClick={() => setKilling(null)}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        style={{ fontSize: '.75rem', padding: '.1em .45em' }}
                        onClick={() => setKilling(r.id)}
                        title="只移除这个文件夹的登记，书和阅读进度都留着；但那些记录会变成没人管的孤儿"
                      >
                        移除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ fontSize: '0.82rem', marginTop: '.3rem' }}>
          停用或移除都<strong>不会删书</strong>，也不动磁盘上的文件——只影响「还扫不扫这个文件夹」。
          （阅读进度、书签、评分重新扫描也恢复不了，所以这里不碰它们。）
        </p>

        <h3 style={{ fontSize: '.95rem', margin: '1.1rem 0 .3rem' }}>屏蔽规则</h3>
        <div className="row" style={{ marginBottom: '.5rem' }}>
          <button onClick={pickDirToBlock}>选一个文件夹来屏蔽…</button>
          <button
            onClick={() => void save(defaults)}
            title="回到内置的那几条（隐藏文件夹、备份、回收站等）"
          >
            恢复默认
          </button>
        </div>

        <table>
          <tbody>
            {patterns.map((p) => (
              <tr key={p}>
                <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: '.8rem' }}>{p}</td>
                <td style={{ width: '3rem' }}>
                  {/* 光一个「×」不说明删的是什么，而这条规则一删，
                      被它挡住的书下次扫描就会全部收进来。title 说清楚，
                      尺寸给够（24×24 是 WCAG 2.2 的下限） */}
                  <button
                    style={{ fontSize: '.9rem', minWidth: 24, height: 24, padding: 0, lineHeight: 1 }}
                    title={`删掉这条屏蔽规则：${p}`}
                    aria-label={`删掉屏蔽规则 ${p}`}
                    onClick={() => void save(patterns.filter((x) => x !== p))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="row" style={{ marginTop: '.5rem' }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) {
                void save([...patterns, draft.trim()]);
                setDraft('');
              }
            }}
            placeholder="手写一条，例如 临时/** 或 **/*样章*/**"
            style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}
          />
          <button
            disabled={!draft.trim()}
            onClick={() => {
              void save([...patterns, draft.trim()]);
              setDraft('');
            }}
          >
            添加
          </button>
        </div>
        <p className="muted" style={{ fontSize: '.82rem', marginTop: '.3rem' }}>
          规则是相对书库文件夹的 glob。<strong>要屏蔽整个子文件夹记得加 <code>/**</code></strong>——
          只写 <code>临时</code> 一个都挡不住，而且不会有任何报错。
        </p>

        {preview && (
          <div className="card" style={{ marginTop: '.6rem' }}>
            {preview.affected === 0 ? (
              <span className="muted">当前规则不影响任何已入库的书。</span>
            ) : (
              <>
                <strong>会屏蔽掉已入库的 {preview.affected} 本</strong>
                {preview.withProgress > 0 && (
                  <span className="danger">（其中 {preview.withProgress} 本有阅读进度）</span>
                )}
                <div className="muted" style={{ fontSize: '.78rem', marginTop: '.3rem' }}>
                  它们不会被删除，只是以后扫描不再更新。示例：
                </div>
                <ul style={{ margin: '.2rem 0 0', paddingLeft: '1.2rem', fontSize: '0.75rem' }}>
                  {preview.samples.slice(0, 5).map((s) => (
                    <li key={s} style={{ overflowWrap: 'anywhere' }}>{s}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {error && <p className="danger">{error}</p>}
        {msg && <p style={{ color: 'var(--accent)', fontSize: '.85rem' }}>{msg}</p>}

        <div className="row modal-actions" style={{ marginTop: '.9rem', justifyContent: 'flex-end' }}>
          <button onClick={() => onClose(changed)}>关闭</button>
        </div>
      </div>
    </div>
  );
}
