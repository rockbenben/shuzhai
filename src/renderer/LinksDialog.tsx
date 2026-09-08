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
// 只引类型：enrich 运行时会拖上 node:sqlite，渲染包不能碰；`import type` 编译期就擦掉
import type { Candidate } from '../core/enrich.ts';
import { SITE_LABELS } from '../core/labels.ts';
// 只引类型：cover-source 运行时带着 node:sqlite，渲染包不能碰
import type { FetchOneResult } from '../core/cover-source.ts';

const STATUS_TEXT: Record<string, { text: string; color?: string }> = {
  ok: { text: '正常', color: 'var(--accent)' },
  suspect: { text: '疑似失效', color: '#b8860b' },
  dead: { text: '已失效', color: 'var(--danger)' },
};

interface Props {
  bookId: number;
  bookTitle: string;
  /** changed=true：这次补过封面/作者/简介，关弹窗后书架要刷新 */
  onClose: (changed?: boolean) => void;
}

/** 取回来的详情页候选 + 书名对不对得上（对不上只警告，不拦） */
interface Detail {
  candidate: Candidate;
  titleMismatch: boolean;
}

/**
 * 在线地址管理（spec §4）。**只管地址，不抓正文，不做在线阅读**——
 * 所以这个界面上没有「读」，只有「这个地址还活着吗」「对面更新到哪了」，
 * 以及「这一页上这本书的封面/简介/作者，补进来」。
 */
export function LinksDialog({ bookId, bookTitle, onClose }: Props) {
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [coverBroken, setCoverBroken] = useState(false);
  const [result, setResult] = useState<{ applied: string[]; skipped: string[] } | null>(null);
  const [changed, setChanged] = useState(false);

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

  // 取详情页用哪个地址：粘贴框里有就用它（一次粘一大段也能抽出第一条），
  // 否则用主地址（没有主地址就第一条）。
  const primary = links.find((l) => l.is_primary === 1) ?? links[0];
  const detailRef = paste.trim() || primary?.url || '';

  const c = detail?.candidate;

  return (
    <div className="modal-backdrop" onClick={() => onClose(changed)}>
      <div className="modal" style={{ width: 'min(50rem, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <h2>在线地址 · {bookTitle}</h2>
        <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
          粘一个这本书的网址，可以<strong>一键把封面、简介、作者补进来</strong>；
          地址也会记下，用来查死链、看对面更新到第几章。<strong>不抓正文也不在这里读</strong>。
        </p>

        {links.length === 0 ? (
          <p className="muted">还没有地址。把网址粘到下面的框里，会自动挑出来。</p>
        ) : (
          <>
          <table>
            <thead>
              <tr>
                <th style={{ width: '3rem' }}>主</th>
                <th>站点 / 地址</th>
                <th style={{ width: '6rem' }}>状态</th>
                <th>对面最新章</th>
                <th style={{ width: '9rem' }}>最新章正则</th>
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
                      {l.latest_chapter_title ?? (
                        <span className="muted">还没检查过</span>
                      )}
                    </td>
                    <td>
                      <input
                        defaultValue={l.selector ?? ''}
                        placeholder="留空自动识别"
                        style={{ width: '100%', font: 'inherit', fontSize: '.75rem' }}
                        onBlur={(e) => {
                          const v = e.target.value;
                          if ((l.selector ?? '') === (v.trim() ? v : '')) return;
                          void run('', async () => {
                            await rpc('link.setSelector', { id: l.id, selector: v });
                            await reload();
                          });
                        }}
                      />
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
          <p className="muted" style={{ fontSize: '.75rem', marginTop: '.3rem' }}>
            内置站点（起点、书旗、纵横、番茄、豆瓣）留空就自动识别最新章；其他网站可以填一个正则，第一个捕获组＝最新章标题。要浏览器渲染才出内容的陌生站正则也取不到，只能探活。
          </p>
          </>
        )}

        {/* 详情页预览：取回来、还没落库。确认才写，写也只补空缺 */}
        {c && (
          <div
            style={{
              border: '1px solid var(--line)', borderRadius: 6, padding: '.7rem',
              margin: '.7rem 0', background: 'var(--bg)',
            }}
          >
            <div className="row" style={{ gap: '.7rem', alignItems: 'flex-start' }}>
              {c.coverUrl && !coverBroken && (
                <img
                  src={c.coverUrl}
                  alt="对面的封面"
                  onError={() => setCoverBroken(true)}
                  style={{
                    width: '4.6rem', height: '6.4rem', objectFit: 'cover',
                    borderRadius: 4, border: '1px solid var(--line)', flex: 'none',
                  }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{c.title || '（没认出书名）'}</div>
                {c.author && <div className="muted" style={{ fontSize: '.82rem' }}>作者：{c.author}</div>}
                {c.category && <div className="muted" style={{ fontSize: '.82rem' }}>分类：{c.category}</div>}
                {c.tags && c.tags.length > 0 && (
                  <div className="muted" style={{ fontSize: '.82rem' }}>标签：{c.tags.join('、')}</div>
                )}
                {c.intro && (
                  <p style={{ fontSize: '.8rem', margin: '.4rem 0 0', maxHeight: '7.5em', overflow: 'auto' }}>
                    {c.intro}
                  </p>
                )}
              </div>
            </div>

            {detail!.titleMismatch && (
              <p className="danger" style={{ fontSize: '.8rem', margin: '.5rem 0 0' }}>
                对面书名「{c.title}」和本地「{bookTitle}」对不上——只会补本地还空着的字段
                （封面、简介、作者），<strong>不会改你的书名</strong>。确认这是同一本书再应用。
              </p>
            )}

            <div className="row" style={{ marginTop: '.6rem' }}>
              <button
                disabled={busy !== null}
                onClick={() => void run('正在补全…（封面要下载，稍等）', async () => {
                  const r = await rpc<{ applied: string[]; skipped: string[] }>('enrich.apply', {
                    bookId, candidate: c, trustIdentity: true,
                  });
                  setDetail(null);
                  setCoverBroken(false);
                  setResult(r);
                  if (r.applied.length) setChanged(true);
                  await reload();
                })}
              >
                应用到这本书（只补空缺）
              </button>
              <button disabled={busy !== null} onClick={() => { setDetail(null); setCoverBroken(false); }}>
                取消
              </button>
            </div>
          </div>
        )}

        {result && (
          <p style={{ fontSize: '.85rem', margin: '.5rem 0', color: result.applied.length ? 'var(--accent)' : undefined }}>
            {result.applied.length
              ? `已补全：${result.applied.join('、')}`
              : '本地这些字段都已经有了，没有要补的。'}
            {result.skipped.length > 0 && (
              <span className="muted" title={result.skipped.join('\n')}>（{result.skipped.length} 项跳过）</span>
            )}
          </p>
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
              const r = await rpc<{ added: number; urls: string[]; skipped: number }>('link.addBatch', { bookId, text: paste });
              setPaste('');
              await reload();
              if (r.urls.length === 0) {
                setError('这段文字里没找到网址');
              } else if (r.added === 0 && r.skipped > 0) {
                setError(`${r.skipped} 条都已在列表里`);
              } else if (r.skipped > 0) {
                setError(`加了 ${r.added} 条，${r.skipped} 条已存在，跳过`);
              }
            })}
          >
            从粘贴内容导入
          </button>
          {/*
            * **和编辑器里「联网补全」是同一条链**（enrichBook）：地址就是这本书的
            * 网上身份——粘进来先落库（① 身份先记下，addLink 幂等，应用时不会存两行），
            * 再读那个详情页出预览（② trustIdentity，只补空缺，对不上只警告）；
            * 这一页读不出书目信息（不是详情页/改版/反爬/超时）就和 enrichBook 一样
            * 安静回落到按书名搜源（③ 搜索路径有书名+作者精确匹配兜底，不用预览）。
            * 原来这三件事是「导入 → 取信息 → 应用」三个互不相干的手势，而且②失败
            * 就是一句死话，③那条链在这个弹窗里根本够不到。
            */}
          <button
            disabled={!detailRef || busy !== null || detail !== null}
            title={paste.trim()
              ? '先记下粘的地址，再读那一页补封面/信息；读不出来就按书名搜源'
              : '读主地址那一页补封面/信息（起点要开后台窗口，稍慢）；读不出来就按书名搜源'}
            onClick={() => void run('正在读取这个页面…（起点要开后台窗口，稍慢）', async () => {
              setResult(null);
              setCoverBroken(false);
              if (paste.trim()) {
                const imp = await rpc<{ added: number; urls: string[]; skipped: number }>(
                  'link.addBatch', { bookId, text: paste },
                );
                if (imp.urls.length > 0) {
                  setPaste('');
                  await reload();
                }
              }
              try {
                const d = await rpc<Detail>('link.fetchDetail', { bookId, ref: detailRef });
                setDetail(d);
              } catch (e) {
                const why = (e as Error).message;
                const r = await rpc<FetchOneResult>('cover.fetchOne', { bookId });
                await reload();
                if (r.status === 'ok') {
                  setChanged(true);
                  setResult({
                    applied: [
                      `这页没认出信息，按书名在${r.source ? (SITE_LABELS[r.source] ?? r.source) : '搜索源'}找到`,
                      ...(r.applied ?? []),
                    ],
                    skipped: [],
                  });
                } else {
                  setError(
                    r.note
                      ? `这个页面读不出书目信息（${why}）；${r.note}`
                      : `这个页面读不出书目信息（${why}）；按书名搜了几个源也没对上`,
                  );
                }
              }
            })}
          >
            从链接补全封面/信息
          </button>
          <button
            disabled={links.length === 0 || busy !== null}
            onClick={() => void run('正在检查…（同域名间隔 2 秒，慢是故意的）', async () => {
              await rpc('link.checkUpdates', { bookId });
              await reload();
            })}
            title="逐个访问看还活不活着；内置站点（起点/书旗/纵横/番茄）顺带取回对面最新章。同域名串行间隔 2 秒"
          >
            检查
          </button>
          {busy && <span className="muted" style={{ fontSize: '.85rem' }}>{busy}</span>}
          <span style={{ flex: 1 }} />
          <button onClick={() => onClose(changed)}>关闭</button>
        </div>

        {error && <p className="danger" style={{ marginBottom: 0 }}>{error}</p>}
      </div>
    </div>
  );
}
