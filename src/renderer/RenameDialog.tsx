import { useCallback, useEffect, useState } from 'react';
import { rpc } from './rpc.ts';

/*
 * 类型从 core 引，这里原来手抄了一份一模一样的 `RowStatus` / `Row` / `Report`。
 * **本仓库已经被「渲染进程手抄一份 core 的接口」咬过四次**
 * （`Filter`、`RepairReport`、`Version`，加这一份）——抄的那份先掉队，
 * 而 typecheck 一声不响：多一种 `RowStatus` 也好、少一个字段也好，
 * 手抄的那份自己是自洽的。`import type` 会被完全擦除，不会把 core 的
 * `node:fs/promises` 拖进渲染包（同 `App.tsx` 引 `Filter` 那处）。
 */
import type { RowStatus, RenameRow as Row, RenameReport as Report } from '../core/rename.ts';
// 模板预设也从 core 引：这里原来抄了一份一字不差的
// （上一轮把这个文件的三个类型并掉时漏了它——**同一个文件里的第二份**）
import { PRESETS } from '../core/rename.ts';


/** 状态 → 颜色和说明。spec §3.3 要求预览表格里把这几种标出来 */
const STATUS_META: Record<RowStatus, { color?: string; text: string }> = {
  ok: { color: 'var(--accent)', text: '正常' },
  unchanged: { text: '无变化' },
  conflict: { color: 'var(--danger)', text: '冲突' },
  sanitized: { color: 'var(--danger)', text: '含非法字符' },
  'too-long': { color: 'var(--danger)', text: '路径过长' },
  missing: { color: 'var(--danger)', text: '文件缺失' },
};

/*
 * 阈值从 core 引。这里原来自己写了一份 50，注释还写着「和后端的
 * `CONFIRM_THRESHOLD` 对应」——**那句话本身就是在承认它是第二份**。
 * 而这是个安全阀（spec §3.3）：谁把 core 那个调低，界面这份不跟着变，
 * 守卫就在没人发现的情况下松了。
 */
import { CONFIRM_THRESHOLD } from '../core/rename.ts';
import { whenAgo } from '../core/format.ts';
/** 表格最多铺多少行。批量改名能一次带上整个筛选结果，八千行铺不得 */
const LIST_MAX = 300;
const FIRST_USE_KEY = 'novel.rename-warned';

interface Props {
  bookIds: number[];
  onClose: (changed: boolean) => void;
}

export function RenameDialog({ bookIds, onClose }: Props) {
  const [template, setTemplate] = useState(PRESETS[0].template);
  const [onConflict, setOnConflict] = useState<'skip' | 'number'>('skip');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 首次使用要说清楚这会真的改磁盘上的文件（spec §3.3 的安全阀）
  const [warned, setWarned] = useState(() => localStorage.getItem(FIRST_USE_KEY) === '1');
  const [confirming, setConfirming] = useState(false);
  /**
   * 可撤销的批次。**这是 spec §3.3 点名的安全阀，界面上必须够得到**——
   * `rename.undoable` / `rename.undo` 两个 rpc 一直是好的，但在补上这块之前渲染进程
   * 从没调过，等于「改错了能撤回来」这个承诺在界面上兑现不了。
   * `rename_log` 只留最近 20 批，超出这个窗口就真的找不回来了
   */
  const [undoable, setUndoable] = useState<Array<{ batchId: string; count: number; renamedAt: string }>>([]);

  const preview = useCallback(async () => {
    setError(null);
    try {
      const r = await rpc<Row[]>('rename.preview', { bookIds, template, onConflict });
      setRows(r);
      // 只默认勾选能安全执行的行；冲突、缺失、无变化都不勾
      setPicked(new Set(r.filter((x) => x.status === 'ok').map((x) => x.fileId)));
    } catch (e) {
      setRows(null);
      setError((e as Error).message);
    }
  }, [bookIds, template, onConflict]);

  useEffect(() => {
    const t = setTimeout(() => void preview(), 300);
    return () => clearTimeout(t);
  }, [preview]);

  const loadUndoable = useCallback(async () => {
    try {
      setUndoable(await rpc('rename.undoable'));
    } catch { /* 撤销列表取不到不该挡住重命名本身 */ }
  }, []);
  useEffect(() => { void loadUndoable(); }, [loadUndoable]);

  const undo = async (batchId: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await rpc<{ restored: number; failed: string[] }>('rename.undo', { batchId });
      setError(
        r.failed.length
          ? `撤回了 ${r.restored} 个，${r.failed.length} 个没撤成（文件可能又被改过或被占用）`
          : null,
      );
      await loadUndoable();
      await preview();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const doApply = async () => {
    if (!rows) return;
    setBusy(true);
    setConfirming(false);
    setError(null);
    try {
      const chosen = rows.filter((r) => picked.has(r.fileId));
      // `confirmed` 的意思是「预览已经摆给人看过了」——超过阈值时 rpc 会认这个标记，
      // 见 `src/main/rpc.ts` 的 `rename.apply`。界面这边的二次确认就是那道预览
      setReport(await rpc<Report>('rename.apply', { rows: chosen, confirmed: true }));
      await preview();
      /*
       * **改完要立刻把「撤回这一批」摆出来。**
       *
       * 原来只重算预览，而撤销列表是挂载时取一次的——于是刚改完 9 个文件，
       * 那一批的撤回按钮**不在界面上**，得关掉弹窗再打开才出现。
       * 而「刚点完执行、发现不对」正是最想撤的那一刻；
       * `rename_log` 还只留最近 20 批，等用户自己摸索出「关掉再开」要花的时间里，
       * 别的操作可能已经把它挤出窗口了。
       */
      await loadUndoable();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onApplyClick = () => {
    if (picked.size > CONFIRM_THRESHOLD) setConfirming(true);
    else void doApply();
  };

  if (!warned) {
    return (
      <div className="modal-backdrop">
        <div className="modal" style={{ maxWidth: '32rem' }}>
          {/* 标题里要说**这次要动几本**。原来只写「关于重命名」，通篇是通则，
              读起来像一份说明书——而用户此刻是带着「我要改这 68 本」来的，
              点下去之前根本不知道这一下涉及多少文件。

              ⚠️ 主按钮**说的是会发生什么，不是心情**：原来写「我明白了」，
              而这个键真正干的事这段话自己已经写明了——去试算预览，磁盘上还什么都没变。
              「我明白了」既没说去处，也和别处的「知道了」是同一件事的两种说法 */}
          <h2 style={{ margin: '0 0 .6rem', fontSize: '1.1rem' }}>
            要给 {bookIds.length} 本书改文件名
          </h2>
          <p style={{ marginTop: 0 }}>
            这个功能会<strong>真的修改磁盘上的文件名</strong>，不是只改程序里的显示。
            下一步是<strong>试算预览</strong>，那时磁盘上还什么都没变。
          </p>
          <p className="muted" style={{ fontSize: '0.87rem' }}>
            每次批量改名都会记录日志，最近 20 批可以整批撤销。程序不会删除或移动你的文件，
            也不会在扫描等后台流程里自动改名——只有你在这里点下去才会动。
          </p>
          <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
            <button onClick={() => onClose(false)}>取消</button>
            <button
              className="primary"
              onClick={() => {
                localStorage.setItem(FIRST_USE_KEY, '1');
                setWarned(true);
              }}
            >
              去试算预览
            </button>
          </div>
        </div>
      </div>
    );
  }

  const counts = rows
    ? rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {})
    : {};

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose(report !== null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>批量改名（{bookIds.length} 本）</h2>
        <p className="muted" style={{ margin: '0 0 .7rem', fontSize: '.85rem' }}>
          下面是<strong>试算结果</strong>，此刻磁盘上什么都没变。逐行核对后点「执行」才会真改。
        </p>

        {/* 可撤销的批次。spec §3.3 点名的安全阀，**必须在界面上够得到**——
            rename_log 只留最近 20 批，超出这个窗口就真的找不回来了 */}
        {undoable.length > 0 && (
          <div className="card" style={{ marginBottom: '.7rem' }}>
            <strong style={{ fontSize: '.9rem' }}>可以撤回的改名</strong>
            <span className="muted" style={{ fontSize: '.82rem' }}>
              　只留最近 {undoable.length} 批，再往前的撤不回来了
            </span>
            {undoable.map((b) => (
              <div key={b.batchId} className="row" style={{ alignItems: 'center', padding: '.2rem 0' }}>
                <span style={{ flex: 1, fontSize: '.85rem' }}>
                  {/* `renamed_at` 是 sqlite 的 UTC 文本，原样印出来在东八区差 8 小时。
                      判据在 `core/format.ts` 的 `whenAgo`，`no-raw-time.test.ts` 守着 */}
                  <span title={whenAgo(b.renamedAt)?.title}>{whenAgo(b.renamedAt)?.text ?? b.renamedAt}</span>
                  {' · '}{b.count} 个文件
                </span>
                <button onClick={() => void undo(b.batchId)} disabled={busy}>撤回这一批</button>
              </div>
            ))}
          </div>
        )}

        <div className="row" style={{ marginBottom: '.5rem' }}>
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => setTemplate(p.template)} style={{ fontSize: '.82rem' }}>
              {p.label}
            </button>
          ))}
        </div>

        <input
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          style={{ width: '100%', fontFamily: 'ui-monospace, monospace' }}
          placeholder="可用变量：{title} {author} {status} {wordcount} {index} {ext}"
        />

        <div className="row" style={{ margin: '.5rem 0' }}>
          <span className="muted" style={{ fontSize: '.85rem' }}>重名时</span>
          <select value={onConflict} onChange={(e) => setOnConflict(e.target.value as 'skip' | 'number')}>
            <option value="skip">跳过并标红</option>
            <option value="number">自动加序号 (2)</option>
          </select>
          {rows && (
            <span className="muted" style={{ fontSize: '.85rem' }}>
              正常 {counts.ok ?? 0} · 无变化 {counts.unchanged ?? 0} · 冲突 {counts.conflict ?? 0} ·
              非法字符 {counts.sanitized ?? 0} · 已勾选 {picked.size}
            </span>
          )}
        </div>

        {error && <p className="danger">{error}</p>}

        {report && (
          <div className="card" style={{ marginBottom: '.6rem' }}>
            <strong>执行完成</strong>：成功 {report.ok} · 失败 {report.failed.length}
            {report.failed.length > 0 && (
              <ul className="danger" style={{ margin: '.3rem 0 0', paddingLeft: '1.2rem', fontSize: '.85rem' }}>
                {report.failed.map((f) => (
                  <li key={f.oldName}>{f.oldName} —— {f.error}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/*
          * **表格最多铺 300 行。** 批量改名现在能一次带上整个筛选结果——
          * 这个库里一搜「重生」就是 268 本，全库更是 8172。
          * 「整理书名」那个弹窗踩过同样的坑（把八千行没有变化的行全铺出来）。
          * 没列出来的**照样在勾选范围里**，所以下面必须说出来：
          * 静默截断读起来就是「全在这儿了」。
          */}
        {rows && rows.length > LIST_MAX && (
          <p className="muted" style={{ margin: '0 0 .4rem', fontSize: '.82rem' }}>
            共 {rows.length} 行，表格只列前 {LIST_MAX} 行——
            <strong>没列出来的也在勾选范围里</strong>，会一起改。要逐行核对就先把筛选缩小些。
          </p>
        )}
        {rows && (
          <div style={{ maxHeight: '20rem', overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: '2rem' }} />
                  <th>原文件名</th>
                  <th>新文件名</th>
                  <th style={{ width: '8rem' }}>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, LIST_MAX).map((r) => {
                  const meta = STATUS_META[r.status];
                  return (
                    <tr key={r.fileId} className={r.status === 'unchanged' ? 'muted' : ''}>
                      <td>
                        <input
                          type="checkbox"
                          checked={picked.has(r.fileId)}
                          disabled={r.status !== 'ok' && r.status !== 'sanitized'}
                          onChange={() => toggle(r.fileId)}
                        />
                      </td>
                      <td style={{ fontSize: '.82rem', overflowWrap: 'anywhere' }}>{r.oldName}</td>
                      <td style={{ fontSize: '.82rem', overflowWrap: 'anywhere', color: meta.color }}>
                        {r.status === 'unchanged' ? '—' : r.newName}
                      </td>
                      <td style={{ fontSize: '.8rem', color: meta.color }}>
                        {meta.text}
                        {r.note && <div className="muted" style={{ fontSize: '.75rem' }}>{r.note}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {confirming ? (
          <div className="card" style={{ marginTop: '.8rem', borderColor: 'var(--danger)' }}>
            <strong className="danger">要给 {picked.size} 个文件改名，确认吗？</strong>
            <p className="muted" style={{ margin: '.3rem 0 .5rem', fontSize: '.85rem' }}>
              这会真的修改磁盘上的文件名。执行后可以整批撤销。
            </p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setConfirming(false)}>再看看</button>
              <button className="primary" onClick={doApply}>确认改名</button>
            </div>
          </div>
        ) : (
          <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
            <button onClick={() => onClose(report !== null)} disabled={busy}>关闭</button>
            <button className="primary" onClick={onApplyClick} disabled={busy || picked.size === 0}>
              改这 {picked.size} 个文件名
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
