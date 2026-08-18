import { useState } from 'react';
import { rpc } from './rpc.ts';

interface Props {
  /** 传了就是导出这一本；不传就是导出全库元数据 */
  book?: { id: number; title: string };
  onClose: () => void;
}

/**
 * 导出（spec §9）。
 *
 * 这个功能的后端一直是好的、也端到端验过，但**渲染进程从没调过那三个 rpc**
 * （`export.epub` / `export.txt` / `export.meta`），等于整个 §9 在界面上不存在。
 * 这里补上入口。
 *
 * 导出**不动原文件**（铁律 1）：它是按章节偏移读出来、套上清洗规则、写一份新的到
 * 你选的目录，原 txt 一个字节都不碰。
 */
export function ExportDialog({ book, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clean, setClean] = useState(true);

  const run = async (kind: 'epub' | 'txt' | 'notes' | 'csv' | 'json') => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const dir = await rpc<string | null>('ui.pickFolder');
      if (!dir) return; // 用户取消了选目录
      const r =
        kind === 'epub' || kind === 'txt'
          ? await rpc<{ path: string }>(`export.${kind}`, { bookId: book!.id, dir, clean })
          // 笔记不吃 `clean`：净化规则改的是**正文**，而摘录是当初划下的那几个字，
          // 事后按新规则改一遍等于篡改用户记下来的东西
          : kind === 'notes'
            ? await rpc<{ path: string }>('export.notes', { bookId: book!.id, dir })
            : await rpc<{ path: string }>('export.meta', { dir, format: kind });
      setDone(r.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          {/* 侧栏那个按钮叫「导出表格」，正文也说「导成一份表格」——
              标题却写「元数据」，同一件事三个说法，而「元数据」还是个系统词 */}
          {book ? `导出《${book.title}》` : '导出书库表格'}
        </h2>
        <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
          {/* 这里原来是一整条字符串，里面带着 `**原 txt 一个字节都不会动**`——
              markdown 的星号在 JSX 里不会变成加粗，界面上就是四个星号。
              而这句话正是铁律 1 对用户的承诺，该加粗的就用 <strong> */}
          {book ? (
            <>按章节读出来写一份新文件到你选的文件夹。<strong>原 txt 一个字节都不会动</strong>。</>
          ) : (
            '把全库的书名、作者、字数、阅读状态、评分短评、标签导成一份表格。'
          )}
        </p>

        {book && (
          <label className="row" style={{ marginBottom: '.7rem', fontSize: '.85rem' }}>
            <input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} />
            套用正文净化规则（去掉制作组页脚、推广行这些不属于作者的东西）
          </label>
        )}

        <div className="row">
          {book ? (
            <>
              <button onClick={() => void run('epub')} disabled={busy}>导出 EPUB</button>
              <button onClick={() => void run('txt')} disabled={busy}>导出 TXT</button>
              {/* **笔记也要能拿出去。** 记了几百条却只活在一个 sqlite 文件里，
                  那是只拥有一半。导成 markdown：纯文本、十年后打得开，
                  而且书斋自己就能读 `.md`——放回书库再扫一次就是一本能读的书 */}
              <button
                onClick={() => void run('notes')}
                disabled={busy}
                title="把这本书的划线、笔记和书签导成一份 markdown"
              >
                导出笔记
              </button>
            </>
          ) : (
            <>
              <button onClick={() => void run('csv')} disabled={busy}>导出 CSV</button>
              <button onClick={() => void run('json')} disabled={busy}>导出 JSON</button>
            </>
          )}
        </div>

        {done && (
          <p className="muted" style={{ marginBottom: 0, fontSize: '.85rem' }}>
            写好了：{done}
          </p>
        )}
        {error && <p className="danger" style={{ marginBottom: 0 }}>{error}</p>}

        <div className="row modal-actions" style={{ marginTop: '.9rem', justifyContent: 'flex-end' }}>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
