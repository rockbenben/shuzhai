import { useCallback, useEffect, useState } from 'react';
import { rpc } from './rpc.ts';
import { whenAgo } from '../core/format.ts';

/*
 * ⚠️ **引 core 那一份，别在这儿再声明一遍。**
 *
 * 这里原来自己抄了个 `interface Link`，而 `listLinks` 是 `select *`——
 * 库里有几列它就回几列。抄本当场就已经掉队两列（`book_id`、`latest_checked_at`），
 * 而 TS 的结构化类型不会为「少写几个字段」报错，所以没人发现。
 *
 * 它还骗了另一个守卫：`dead-fields.mjs` 报「`LinkRow` 的 `latest_checked_at`
 * 没被读过」——那不是这个字段没用，是**读它的那一份类型被抄丢了**。
 * 两个检查各看见半个问题，凑不到一起。
 */
import type { LinkRow } from '../core/links.ts';

const STATUS_TEXT: Record<string, { text: string; color?: string }> = {
  ok: { text: '正常', color: 'var(--accent)' },
  suspect: { text: '疑似失效', color: '#b8860b' },
  dead: { text: '已失效', color: 'var(--danger)' },
};

interface Props {
  bookId: number;
  bookTitle: string;
  onClose: () => void;
}

/**
 * 在线地址管理（spec §4）。**只管地址，不抓正文，不做在线阅读**——
 * 所以这个界面上没有「读」，只有「这个地址还活着吗」和「对面更新到哪了」。
 */
export function LinksDialog({ bookId, bookTitle, onClose }: Props) {
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLinks(await rpc<LinkRow[]>('link.list', { bookId }));
  }, [bookId]);

  useEffect(() => {
    reload().catch((e: Error) => setError(e.message));
  }, [reload]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 'min(50rem, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <h2>在线地址 · {bookTitle}</h2>
        <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
          这里只记地址、查死链、看对面更新到第几章，<strong>不抓正文也不在这里读</strong>。
        </p>

        {links.length === 0 ? (
          <p className="muted">还没有地址。把网址粘到下面的框里，会自动挑出来。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: '3rem' }}>主</th>
                <th>站点 / 地址</th>
                <th style={{ width: '6rem' }}>状态</th>
                <th>对面最新章</th>
                <th style={{ width: '5rem' }} />
              </tr>
            </thead>
            <tbody>
              {links.map((l) => {
                const st = l.last_status ? STATUS_TEXT[l.last_status] : null;
                return (
                  <tr key={l.id}>
                    <td>
                      {/* 这颗 radio 原来是默认的 20×20，`ui-check/audit.mjs` 量出来
                          「点击目标偏小且挨得近」——WCAG 2.2 AA 的下限是 24，
                          而它旁边 24px 内就有别的目标（同一行的链接），豁免不了。
                          外面那层 `<label>` 是顺带把整格都变成点击区，
                          和 `LibraryDirs` 里「启用」那个写法一致 */}
                      <label
                        style={{ display: 'block', padding: '.3rem', cursor: 'pointer' }}
                        title={`把「${l.site || l.url}」设成主站`}
                      >
                        <input
                          type="radio"
                          name="primary-link"
                          style={{ width: '1.5rem', height: '1.5rem', margin: 0 }}
                          checked={l.is_primary === 1}
                          onChange={() => void run('', async () => {
                            await rpc('link.setPrimary', { id: l.id });
                            await reload();
                          })}
                        />
                      </label>
                    </td>
                    <td style={{ fontSize: '0.82rem', overflowWrap: 'anywhere' }}>
                      <div>{l.site}</div>
                      <a
                        href={l.url}
                        onClick={(e) => {
                          e.preventDefault();
                          window.open(l.url, '_blank');
                        }}
                        className="muted"
                        style={{ fontSize: '0.75rem' }}
                      >
                        {l.url}
                      </a>
                    </td>
                    <td style={{ fontSize: '.82rem', color: st?.color }}>
                      {st?.text ?? '未检查'}
                      {l.last_checked_at && (
                        <div className="muted" style={{ fontSize: '.72rem' }} title={whenAgo(l.last_checked_at)?.title}>
                          {/* 原来是 `slice(5, 16)` 截那串 UTC 文本，差 8 小时 */}
                          {whenAgo(l.last_checked_at)?.text}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: '.82rem' }}>
                      {/*
                        * ⚠️ **不写「未配置」。**
                        *
                        * 「未配置」是在说「你还没设，去设一下」——**而应用里根本没有设它的地方**：
                        * `selector` 只有 `link.add` 收，没有改它的 rpc，这个弹窗也只调 `link.addBatch`。
                        * 于是那句话把人支去找一个不存在的按钮。（`dead-fields.mjs` 一直报
                        * `LinkRow.selector` 没人读，正是这件事的另一半。）
                        *
                        * 改成陈述事实 + 说清后果：没有规则，所以这一格没有内容。
                        * 真要让人配得了，得先加一条「改提取规则」的 rpc——那是加功能，不是改文案。
                        */}
                      {l.latest_chapter_title ?? (
                        <span className="muted" title="这条地址没有提取规则，所以查不到对面更新到第几章">
                          没有提取规则
                        </span>
                      )}
                    </td>
                    <td>
                      <button
                        style={{ fontSize: '.75rem', padding: '.1em .45em' }}
                        onClick={() => void run('', async () => {
                          await rpc('link.remove', { id: l.id });
                          await reload();
                        })}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <textarea
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={2}
          placeholder="把网址粘在这里，一次可以粘一大段（中文标点会自动断开）"
          style={{
            width: '100%', marginTop: '.7rem', font: 'inherit', fontSize: '.85rem',
            color: 'var(--fg)', background: 'var(--bg)', border: '1px solid var(--line)',
            borderRadius: 5, padding: '.3em .5em',
          }}
        />

        <div className="row modal-actions">
          <button
            disabled={!paste.trim() || busy !== null}
            onClick={() => void run('正在导入…', async () => {
              const r = await rpc<{ added: number }>('link.addBatch', { bookId, text: paste });
              setPaste('');
              await reload();
              if (r.added === 0) setError('这段文字里没找到网址');
            })}
          >
            从粘贴内容导入
          </button>
          <button
            disabled={links.length === 0 || busy !== null}
            onClick={() => void run('正在检查…（同域名间隔 2 秒，慢是故意的）', async () => {
              await rpc('link.check', { bookId });
              await reload();
            })}
            title="逐个访问看还活不活着。同域名串行且间隔 2 秒，避免打扰对方站点"
          >
            检查死链
          </button>
          {busy && <span className="muted" style={{ fontSize: '.85rem' }}>{busy}</span>}
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>关闭</button>
        </div>

        {error && <p className="danger" style={{ marginBottom: 0 }}>{error}</p>}
      </div>
    </div>
  );
}
