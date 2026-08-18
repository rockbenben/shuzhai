import { useCallback, useEffect, useState } from 'react';
import { rpc } from './rpc.ts';
import { BatchPlanList } from './BatchPlanList.tsx';
import type { Filter } from '../core/library.ts';
import { READING_STATUS } from '../core/labels.ts';

interface Props {
  /** 当前筛选条件。批量作用于整个筛选结果，不是当前加载的那 120 本 */
  filter: Filter;
  onClose: (changed: boolean) => void;
}


interface Result {
  changed: Array<{ bookId: number; from: string }>;
  same: number;
  kept: number;
}

interface Plan {
  /** 只回前 20 本当样本，`total` 才是会变的全量——整库 8000 本时全传是 334 KB */
  sample: Array<{ bookId: number; title: string }>;
  total: number;
  same: number;
  kept: number;
}

/**
 * 给整个筛选结果改阅读状态。
 *
 * 为什么需要它：真实书库 8172 本，而打过分的 1 本、写过短评的 0 本。
 * 这个应用的正事是「下次不用再想这本我看过没」，而在这之前要说「这本读过」
 * 只有逐本点开、逐本编辑、逐本手工添三条路——对八千本的库等于没有入口。
 * 抓手和「批量打标签」一样是书名关键词（那 8172 本全平铺在一个目录下，
 * 没有子目录可借力），所以这两个弹窗长得像是故意的。
 *
 * 形状照「批量打标签」：先看清楚圈中了谁，确认了才落库，做完还给一次撤销。
 *
 * ⚠️ **预览走 `reading.planStatusByFilter`，不是 `book.list`。**
 * 原来是后者（按当前排序取前 20 本），而默认排序把**动过的书排在最前**——
 * 那批恰恰是一本都不会改的。于是「会被改的书」列的正好是不会改的，
 * 按钮上写着「（153 本）」，点完卡片说「已把 0 本标成…」。
 * 现在预览和执行共用后端同一份判定，列出来的就是待会真会变的。
 */
export function BatchStatusDialog({ filter, onClose }: Props) {
  const [status, setStatus] = useState<string>('finished');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Result | null>(null);

  // 换目标状态要重算：「本来就是这个状态」这一档跟着目标走
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const p = await rpc<Plan>('reading.planStatusByFilter', { filter, status });
        if (alive) setPlan(p);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [filter, status]);

  const apply = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(await rpc<Result>('reading.setStatusByFilter', { filter, status }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [filter, status]);

  const [msg, setMsg] = useState<string | null>(null);

  const undo = useCallback(async () => {
    if (!done) return;
    setBusy(true);
    try {
      // 一次把整批发过去。逐本发的话八千本就是八千次 IPC——这个仓库在封面上栽过
      const r = await rpc<{ restored: number }>('reading.restoreStatus', { rows: done.changed });
      /*
       * **撤完要说一声。** 原来是 `setDone(null)` 了事：结果卡消失，
       * 撤了几本无从得知——和当年「整理书名」那个「点完弹窗就关，改了几本不知道」
       * 是同一个形状。
       *
       * 数对不上时要说清为什么：那几本的记录已经不在了（中途被
       * 「只留这一份」或「整理数据库」删掉），撤销够不着它们。
       */
      const 没撤回来 = done.changed.length - r.restored;
      setMsg(
        没撤回来 > 0
          ? `已经把 ${r.restored} 本改回原来的状态。另外 ${没撤回来} 本的记录已经不在了，撤销够不着它们。`
          : `已经把 ${r.restored} 本改回原来的状态。`,
      );
      setDone(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [done]);

  const name = READING_STATUS.find((s) => s.id === status)?.name ?? status;
  const n = plan?.total ?? 0;

  /*
   * **撤销只活在这个弹窗里**（那一批快照存在 React state 里，没有 `rename_log`
   * 那样的落库日志）。所以改完之后点遮罩不再关——那是最容易误触的一下，
   * 而代价是撤销机会没了。关闭按钮就在旁边，上面写着这句话。
   */
  const close = () => { if (!busy) onClose(done !== null); };

  return (
    <div className="modal-backdrop" onClick={() => { if (!done) close(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>把筛选出来的书标成…</h2>
        <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
          作用于<strong>整个筛选结果</strong>，不只是屏幕上这一页。
          <strong>确认无误再点下面那个按钮，在那之前什么都不会改</strong>。
        </p>

        {done ? (
          <div className="card">
            <strong>已把 {done.changed.length} 本标成「{name}」</strong>
            <p className="muted" style={{ margin: '.4rem 0 0', fontSize: '.85rem' }}>
              {done.same > 0 && `另外 ${done.same} 本本来就是这个状态，没重复写。`}
              {done.kept > 0 && (
                <>
                  <br />
                  有 <strong>{done.kept}</strong> 本你已经动过（读完了，或者读到过第几章），
                  批量没有碰它们——不然会出现「想读，却已经读到一半」这种自相矛盾的记录，
                  已读完那些还会丢掉读完的日期。要改的话，点开那本书自己改。
                </>
              )}
            </p>
          </div>
        ) : (
          <>
            <div className="tabs" style={{ marginBottom: '.7rem', flexWrap: 'wrap' }}>
              {READING_STATUS.map((s) => (
                <button key={s.id} aria-current={status === s.id} onClick={() => setStatus(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>

            <div className="card">
              <strong>
                {plan == null ? '正在算会改哪些…' : n === 0 ? '这一批里没有会变的书' : `会被改的 ${n} 本`}
              </strong>
              {/* 和「批量打标签」共用一份（`BatchPlanList.tsx`）。
                  「样本条数由服务端定、这边不另立上限」那条判据跟着它走 */}
              {n > 0 && <BatchPlanList sample={plan?.sample} total={n} />}
              {plan != null && (plan.same > 0 || plan.kept > 0) && (
                <p className="muted" style={{ margin: '.5rem 0 0', fontSize: '.82rem' }}>
                  {plan.same > 0 && `另外 ${plan.same} 本本来就是「${name}」。`}
                  {plan.kept > 0 && `有 ${plan.kept} 本你已经动过（读完了，或者读到过第几章），批量不会碰——不然会变成「想读，却已经读到一半」这种说不通的记录。要改的话，点开那本书自己改。`}
                </p>
              )}
            </div>
          </>
        )}

        {error && <p className="danger" style={{ marginBottom: 0 }}>{error}</p>}
        {msg && <p style={{ color: 'var(--accent)', marginBottom: 0 }}>{msg}</p>}

        <div className="row modal-actions" style={{ marginTop: '.9rem', justifyContent: 'flex-end' }}>
          {done && done.changed.length > 0 && (
            <button onClick={() => void undo()} disabled={busy}>撤销</button>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={close} disabled={busy}>
            {done && done.changed.length > 0 ? '关闭（撤销机会就没了）' : '关闭'}
          </button>
          {!done && (
            <button className="primary" onClick={() => void apply()} disabled={busy || n === 0}>
              标成「{name}」（{n} 本）
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
