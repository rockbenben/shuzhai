import { useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from './rpc.ts';
import { BatchPlanList } from './BatchPlanList.tsx';
import type { Filter, Tag } from '../core/library.ts';

interface Props {
  /** 当前筛选条件。批量作用于**整个筛选结果**，不是当前加载的那 120 本 */
  filter: Filter;
  /** 预填的标签名。从「按书名打标签」点进来时就是那个词 */
  initialNames?: string[];
  onClose: (changed: boolean) => void;
}


/**
 * 给整个筛选结果打标签（个人评价体系，见 specs/2026-08-14-personal-reviews-design.md）。
 *
 * 为什么是「对筛选结果」而不是逐本勾选：用户的 8172 本**全部平铺在一个目录下**，
 * 没有子目录可以借力，唯一的批量抓手就是书名关键词搜索（重生 / 穿越 / 系统 /
 * 华娱 / 大明 / 三国……）。而书架分页一次 120 本，勾选天然够不到第 121 本以后。
 *
 * 形状照抄重命名对话框那条规矩：**先预览、确认了才落库**，做完还给一次撤销。
 */
export function BatchTagDialog({ filter, initialNames, onClose }: Props) {
  const [names, setNames] = useState<string[]>(initialNames ?? []);
  const [draft, setDraft] = useState('');
  const [all, setAll] = useState<Tag[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [plan, setPlan] = useState<{ sample: Array<{ bookId: number; title: string }>; total: number; already: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 刚打上的那一批，撤销要用。`tag.addByFilter` 返回的是**实际新增**的，
   *  所以撤销不会误摘用户之前打好的 */
  const [done, setDone] = useState<{ tagIds: number[]; bookIds: number[]; names: string[]; already: number } | null>(null);

  useEffect(() => {
    void rpc<Tag[]>('tag.list').then(setAll).catch(() => {});
  }, []);

  useEffect(() => {
    // 用 matchCount 而不是 book.counts：后者要算 7 个分档，这里只要一个数
    void rpc<{ n: number }>('book.matchCount', { filter })
      .then((r) => setTotal(r.n))
      .catch((e: Error) => setError(e.message));
  }, [filter]);

  /*
   * **预览走 `tag.planByFilter`，不是 `book.list`。**
   * 圈中几本和会变几本不是一个数：搜「重生」268 本、其中 200 本上一轮已经打过，
   * 真正会新增关联的只有 68 本。原来按钮上写 `matchCount`、结果卡写实际新增，
   * 于是「打上（268 本）」点完变成「已给 68 本打上」。
   * 标签一变就要重算——加一个标签，本来「已经有了」的书就又会变了。
   */
  useEffect(() => {
    if (names.length === 0) { setPlan(null); return; }
    let alive = true;
    void rpc<{ sample: Array<{ bookId: number; title: string }>; total: number; already: number }>(
      'tag.planByFilter', { filter, names },
    ).then((p) => { if (alive) setPlan(p); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [filter, names]);

  const add = (raw: string) => {
    const n = raw.trim();
    if (n && !names.includes(n)) setNames((x) => [...x, n]);
    setDraft('');
  };

  const matches = useMemo(() => {
    const q = draft.trim();
    const pool = all.filter((t) => !names.includes(t.name));
    return (q ? pool.filter((t) => t.name.includes(q)) : pool).slice(0, 12);
  }, [all, names, draft]);

  const apply = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await rpc<{ tagIds: number[]; bookIds: number[] }>('tag.addByFilter', { filter, names });
      // 「本来就有」的数取自刚才那份预览——它和这次写入是同一份判定算出来的
      setDone({ ...r, names, already: plan?.already ?? 0 });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [filter, names, plan]);

  const undo = useCallback(async () => {
    if (!done) return;
    setBusy(true);
    try {
      for (const tagId of done.tagIds) {
        await rpc('tag.remove', { bookIds: done.bookIds, tagId });
      }
      setDone(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [done]);

  /*
   * **撤销只活在这个弹窗里**（那批 bookId 存在 React state 里，没有落库的日志）。
   * 打完标签之后点遮罩不再关——那是最容易误触的一下，代价是撤销就没了。
   * 关闭按钮就在旁边，上面写着这句话。批量改状态那个弹窗同一套规矩。
   */
  const close = () => { if (!busy) onClose(done !== null); };

  /** **会变的那几本**，不是圈中的那几本——按钮上写的就是这个数 */
  const n = plan?.total ?? 0;

  return (
    <div className="modal-backdrop" onClick={() => { if (!done) close(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          给当前筛选出的 {total ?? '…'} 本书打标签
        </h2>
        <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
          {/* 原来这里写的是 `**整个筛选结果**`——从文档注释里抄过来的 markdown，
              JSX 不认，界面上老老实实显示成四个星号 */}
          作用于<strong>整个筛选结果</strong>，不只是屏幕上这一页。
          <strong>确认无误再点「打上」，在那之前什么都不会改</strong>。
        </p>

        {done ? (
          <div className="card">
            <strong>
              已给 {done.bookIds.length} 本书打上「{done.names.join('、')}」
            </strong>
            <p className="muted" style={{ margin: '.4rem 0 0', fontSize: '.85rem' }}>
              {done.already > 0 && `另外 ${done.already} 本本来就有，没有重复打。`}
              撤销只会摘掉这次新打上的，不影响你之前打好的。
            </p>
          </div>
        ) : (
          <>
            {names.length > 0 && (
              <div className="rate-tags">
                {names.map((n) => (
                  <button key={n} className="chip on" onClick={() => setNames((x) => x.filter((y) => y !== n))}>
                    {n} ×
                  </button>
                ))}
              </div>
            )}

            <input
              value={draft}
              placeholder="标签名，回车加一个"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(draft); }}
              style={{ width: '100%' }}
            />

            {matches.length > 0 && (
              <div className="rate-tags">
                {matches.map((t) => (
                  <button key={t.id} className="chip" onClick={() => add(t.name)}>
                    {t.name}
                    <span className="muted"> {t.count}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="card" style={{ marginTop: '.7rem' }}>
              <strong>
                {names.length === 0 ? '先加一个标签'
                  : plan == null ? '正在算会给哪几本打上…'
                  : n === 0 ? '圈中的书都已经有这些标签了'
                  : `会打上标签的 ${n} 本`}
              </strong>
              {/* 和「批量改阅读状态」共用一份（`BatchPlanList.tsx`）——
                  这里原来写的是「同 `BatchStatusDialog`」，那句指路正是分叉前的形状 */}
              {n > 0 && <BatchPlanList sample={plan?.sample} total={n} />}
              {plan != null && plan.already > 0 && (
                <p className="muted" style={{ margin: '.4rem 0 0', fontSize: '.82rem' }}>
                  另外 {plan.already} 本本来就有这些标签，不会重复打。
                </p>
              )}
            </div>
          </>
        )}

        {error && <p className="danger" style={{ marginBottom: 0 }}>{error}</p>}

        <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
          {done && <button onClick={() => void undo()} disabled={busy}>撤销</button>}
          <span style={{ flex: 1 }} />
          <button onClick={close} disabled={busy}>
            {done ? '关闭（撤销机会就没了）' : '关闭'}
          </button>
          {!done && (
            <button
              className="primary"
              onClick={() => void apply()}
              disabled={busy || names.length === 0 || n === 0}
            >
              打上（{n} 本）
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
