import { useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from './rpc.ts';
import type { Tag } from '../core/library.ts';

/**
 * 标签管理（个人评价体系，见 specs/2026-08-14-personal-reviews-design.md）。
 *
 * 为什么必须有：题材标签靠手打，`玄幻` / `玄幻 ` / `玄幻小说` 分裂是必然的。
 * 没有合并这条路，标签列表会在几百条之后烂掉，而那时已经没法收拾了。
 * **改名撞上已有的名字就是合并**——不另做一个「合并」按钮，那只是同一件事的两种说法。
 */
export function TagManager({ onClose }: { onClose: (changed: boolean) => void }) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  /** 正在问「要不要合并」的那一对。合并不可撤销，不能失焦就执行 */
  const [merging, setMerging] = useState<{ from: Tag; into: Tag } | null>(null);
  const [draft, setDraft] = useState('');
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  /** 点了「删除」但还没确认的那一个。删掉不可撤销，见下面那段 */
  const [confirming, setConfirming] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setTags(await rpc<Tag[]>('tag.list'));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /*
   * **改名撞上已有的名字＝合并，而合并要问一次。**
   *
   * 合并是**不可撤销**的：两个标签变成一个，`book_tag` 的行并过去就回不来了
   * （和删除同一档，删除早就有两段式确认）。而原来这条路是**静默**的：
   * 输入框失焦就执行，连「合并了」都不说一声。
   *
   * 最容易撞上的一幕：改了一半改主意，去点「关闭」——**mousedown 会先让
   * 输入框失焦**，于是改名照样执行；名字正好和别的标签一样时，那就是一次
   * 谁也没打算做的合并。（按 Esc 反而是安全的：那条路显式取消。
   * 「两种关法结果相反」本身就说不过去。）
   *
   * 所以：改成一个**不存在**的名字照旧直接改（那只是改名，改回去就是了）；
   * 撞上已有的名字先摆出来问，说清两边各几本。
   */
  const rename = async (t: Tag) => {
    const name = draft.trim();
    setEditing(null);
    if (!name || name === t.name) return;
    const hit = tags.find((x) => x.id !== t.id && x.name === name);
    if (hit) { setMerging({ from: t, into: hit }); return; }
    await doRename(t, name);
  };

  const doRename = async (t: Tag, name: string) => {
    setMerging(null);
    try {
      // confirmMerge 的意思是「合并这件事已经问过人了」——撞上已有名字时
      // rpc 会认这个标记（见 src/main/rpc.ts 的 tag.rename）
      await rpc('tag.rename', { tagId: t.id, name, confirmMerge: true });
      setChanged(true);
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (t: Tag) => {
    setConfirming(null);
    try {
      // confirmed 的意思是「已经问过人了」——上面那个两段式确认就是它的凭据
      // （见 src/main/rpc.ts 的 tag.delete）
      await rpc('tag.delete', { tagId: t.id, confirmed: true });
      setChanged(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const shown = useMemo(() => {
    const k = q.trim();
    return k ? tags.filter((t) => t.name.includes(k)) : tags;
  }, [tags, q]);

  return (
    <div className="modal-backdrop" onClick={() => onClose(changed)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>标签管理</h2>
        {/* 一个标签都没有时不讲「改名即合并」——那是有标签之后才用得上的规矩。
            空状态该说的是**下一步去哪儿**，不是这里的操作语义 */}
        {merging && (
          <div className="card" style={{ marginBottom: '.6rem' }}>
            <div style={{ fontSize: '.9rem', marginBottom: '.4rem' }}>
              <strong>「{merging.into.name}」已经有了。</strong>
              <span className="muted">
                　改成它就是把这两个标签并成一个：「{merging.from.name}」
                {merging.from.count} 本 +「{merging.into.name}」{merging.into.count} 本，
                两边都打过的书只算一次。<strong>合并不能撤销。</strong>
              </span>
            </div>
            <div className="row" style={{ gap: '.4rem' }}>
              <button className="danger" onClick={() => void doRename(merging.from, merging.into.name)}>
                确认合并
              </button>
              <button onClick={() => setMerging(null)}>取消</button>
            </div>
          </div>
        )}
        {tags.length > 0 && (
          <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
            共 {tags.length} 个标签。<strong>改成一个已经存在的名字就是合并</strong>——
            两个标签的书会并到一起，两边都打过的书只算一次。
          </p>
        )}

        {/*
          * **搜一下，不然合并这条路走不通。**
          *
          * 这个弹窗存在的唯一理由是把「玄幻 / 玄幻小说」这种手打出来的分裂并回去，
          * 而 `listTags` 是**按书数降序**排的——两个变体的书数几乎不可能一样，
          * 于是它们在列表里根本不挨着。实测 100 个标签时是 101 行平铺，
          * 没有搜索、没有排序：要合并就得从头翻，翻到再往回找另一个。
          * 排序本身没错（标签选择器那边「常用的在前」是对的），
          * 缺的是**按名字把变体聚到一起**的办法。
          */}
        {tags.length > 8 && (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜标签名。想合并就搜那个词，几个变体会一起出来"
            style={{ width: '100%', marginBottom: '.6rem' }}
          />
        )}

        {error && <p className="danger">{error}</p>}

        <div style={{ maxHeight: '22rem', overflowY: 'auto' }}>
          {shown.map((t) => (
            <div key={t.id} className="row" style={{ padding: '.25rem 0', alignItems: 'center' }}>
              {editing === t.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void rename(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    // preventDefault 是给 App 那个「Esc 关掉最上面一层」看的：
                    // 不挡的话按一次 Esc 既取消了改名、又把整个标签管理关掉
                    if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                  }}
                  style={{ flex: 1 }}
                />
              ) : (
                <button
                  style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none' }}
                  onClick={() => { setEditing(t.id); setDraft(t.name); }}
                  title="点一下改名"
                >
                  {t.name}
                </button>
              )}
              <span className="muted" style={{ fontSize: '.85rem', minWidth: '4rem', textAlign: 'right' }}>
                {t.count} 本
              </span>
              {/*
                * **删除要问一次。** 一个打在几百本书上的标签，点一下就全摘了，
                * 而这件事**没有撤销**（`book_tag` 的行没了就是没了，也没有日志）。
                * 用两段式而不是 `window.confirm`：原生模态框和这个应用自己的
                * 内联确认不是一套，而且会挡住自动化（本文件早写过这条）。
                */}
              {confirming === t.id ? (
                <>
                  <button
                    className="danger"
                    onClick={() => void remove(t)}
                    title="这个标签会从所有书上摘掉，不能撤销"
                  >
                    确认删除（{t.count} 本书上摘掉）
                  </button>
                  <button onClick={() => setConfirming(null)}>取消</button>
                </>
              ) : (
                <button
                  className="danger"
                  onClick={() => setConfirming(t.id)}
                  title="删掉这个标签，以及它在所有书上的关联"
                >
                  删除
                </button>
              )}
            </div>
          ))}
          {tags.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>
              还没有任何标签。搜出一批书再「批量打标签」，或者用「按书名打标签」从书名里挖词。
            </p>
          )}
          {tags.length > 0 && shown.length === 0 && (
            <p className="muted" style={{ margin: 0 }}>没有名字里带「{q.trim()}」的标签。</p>
          )}
        </div>

        <div className="row modal-actions" style={{ marginTop: '.9rem', justifyContent: 'flex-end' }}>
          <button onClick={() => onClose(changed)}>关闭</button>
        </div>
      </div>
    </div>
  );
}
