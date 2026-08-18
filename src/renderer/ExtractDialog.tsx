import { useEffect, useState } from 'react';
import { rpc } from './rpc.ts';

interface Row {
  bookId: number;
  filename: string;
  currentTitle: string;
  currentAuthor: string | null;
  title: string;
  author: string | null;
  changed: boolean;
}

interface Props {
  bookIds?: number[];
  onClose: (changed: boolean) => void;
}

/**
 * 从文件名批量提取书名作者（spec §3.2）。
 * spec 要求的形状：规则选择 + 预览表格 + **逐行可取消勾选**，再应用。
 * 默认只勾「有变化」的行——把没变的也勾上等于让用户在一堆噪音里找信号。
 */
export function ExtractDialog({ bookIds, onClose }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 改完之后真的改了几本。null = 还没应用 */
  const [done, setDone] = useState<number | null>(null);

  useEffect(() => {
    rpc<Row[]>('book.previewExtract', { bookIds })
      .then((r) => {
        setRows(r);
        setPicked(new Set(r.filter((x) => x.changed).map((x) => x.bookId)));
      })
      .catch((e: Error) => setError(e.message));
  }, [bookIds]);

  const toggle = (id: number) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const apply = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      /*
       * **改完说一声，别默默关掉。**
       * 原来是拿到返回值直接扔掉、立刻 `onClose(true)`——用户点了
       * 那个「改这 40 本的书名作者」，弹窗消失，到底改了几本无从得知。
       * 而这个动作改的是书名作者（用户看得见的字段），
       * 批量打标签和批量改状态都会摆一张结果卡，这里没有理由不摆。
       */
      const r = await rpc<{ updated: number }>('book.applyExtract', {
        rows: rows
          .filter((r) => picked.has(r.bookId))
          .map((r) => ({ bookId: r.bookId, title: r.title, author: r.author })),
      });
      setDone(r.updated);
      setBusy(false);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const changedCount = rows?.filter((r) => r.changed).length ?? 0;
  /**
   * **只列会变的那些。**
   *
   * 原来把全部行都铺出来，而「现在 = 将改为」的行一条信息都没有：
   * 这个库里 8172 本，其中绝大多数文件名早就规整过——那是八千行「没变化」，
   * 既翻不动，也把真正要核对的那几行埋了。预览的职责是「让我看清楚要改什么」。
   *
   * 上限 300 行：真有几千本要改时，表格本身会先卡死。剩下的照样会应用，
   * 所以**必须把「没列出来」这件事说出来**（AGENTS.md：静默截断读起来像「全在这儿了」）。
   */
  const LIST_MAX = 300;
  const shown = rows?.filter((r) => r.changed).slice(0, LIST_MAX) ?? [];
  const hiddenCount = changedCount - shown.length;

  return (
    <div className="modal-backdrop" onClick={() => onClose(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>从文件名提取书名作者</h2>
        {/* **没有要改的时候，这段「逐行核对」是句空话**——下面根本没有行 */}
        {changedCount > 0 && (
          <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
            这是<strong>猜测</strong>，不是事实。下面逐行核对，不对的取消勾选——
            应用后会覆盖现有的书名和作者。
          </p>
        )}

        {error && <p className="danger">{error}</p>}
        {!rows && !error && <p className="muted">正在试算…</p>}

        {rows && (
          <>
            <p style={{ margin: '0 0 .4rem', fontSize: '.87rem' }}>
              {changedCount === 0
                ? `这 ${rows.length} 本的书名作者都已经和文件名对得上，没有要改的。`
                : `${rows.length} 本里有 ${changedCount} 本会变，已勾选 ${picked.size} 本。下面只列会变的。`}
            </p>
            {hiddenCount > 0 && (
              <p className="muted" style={{ margin: '0 0 .4rem', fontSize: '.82rem' }}>
                表格只列前 {LIST_MAX} 本，还有 {hiddenCount} 本没列出来——
                <strong>它们也在勾选范围里</strong>，会一起应用。
              </p>
            )}
            {/* 一行都没有的时候连表头都不该出现——三个空列名说不出任何事 */}
            {shown.length > 0 && (
            <div style={{ maxHeight: '22rem', overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: '2rem' }} />
                    <th>文件名</th>
                    <th>现在</th>
                    <th>将改为</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.bookId}>
                      <td>
                        <input
                          type="checkbox"
                          checked={picked.has(r.bookId)}
                          onChange={() => toggle(r.bookId)}
                        />
                      </td>
                      <td style={{ fontSize: '.82rem', overflowWrap: 'anywhere' }}>{r.filename}</td>
                      <td style={{ fontSize: '.85rem' }}>
                        {r.currentTitle}
                        {r.currentAuthor && <span className="muted"> / {r.currentAuthor}</span>}
                      </td>
                      <td style={{ fontSize: '.85rem', color: r.changed ? 'var(--accent)' : undefined }}>
                        {r.title}
                        {r.author && <span className="muted"> / {r.author}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </>
        )}

        {/* 改完那张结果卡。**和批量打标签、批量改状态同一个形状**：
            这个动作改的是书名作者（用户看得见的字段），做完不说一声就关掉，
            用户没法知道到底改了几本——而勾了 40 本不等于改了 40 本
            （id 对不上的那些一行都不会动） */}
        {done !== null && (
          <div className="card">
            <strong>已经改好 {done} 本的书名和作者</strong>
            {done < picked.size && (
              <p className="muted" style={{ margin: '.4rem 0 0', fontSize: '.85rem' }}>
                勾了 {picked.size} 本，有 {picked.size - done} 本没能改——
                多半是那条记录已经不在了（比如刚被合并或删掉）。重新扫描一次再看看。
              </p>
            )}
          </div>
        )}

        {/* 没有要改的时候只留一个出口。摆着一个「改这 0 本的书名作者」，
            用户要么以为自己漏勾了，要么去点一个什么都不会发生的按钮 */}
        <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
          {done !== null ? (
            <button className="primary" onClick={() => onClose(true)}>关闭</button>
          ) : rows && changedCount === 0 ? (
            <button className="primary" onClick={() => onClose(false)}>知道了</button>
          ) : (
            <>
              <button onClick={() => onClose(false)}>取消</button>
              {/* ⚠️ **说清改的是什么**。原来写「应用勾选的 N 本」——「应用」没说应用什么，
                  而按完那句话说的是「已经改好 N 本的书名和作者」，动词都对不上。
                  更要紧的是这个应用里**「改书名作者」和「改文件名」是两件事**：
                  前者只动库，后者真动磁盘。两个按钮都把改的是什么写出来，
                  才不会点错（那边写的是「改这 N 个文件名」） */}
              <button className="primary" onClick={apply} disabled={busy || picked.size === 0}>
                改这 {picked.size} 本的书名作者
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
