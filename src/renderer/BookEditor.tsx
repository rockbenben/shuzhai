import { useEffect, useRef, useState } from 'react';
import { ENCODINGS } from '../core/encoding.ts';
import { formatOf } from '../core/book-format.ts';
import { SERIAL_STATUS, READING_STATUS } from '../core/labels.ts';
import { rpc } from './rpc.ts';
import { StarRating } from './StarRating.tsx';
import { Cover } from './Cover.tsx';

export interface Detail {
  id: number;
  title: string;
  author: string | null;
  aliases: string | null;
  intro: string | null;
  serial_status: string;
  source_site: string | null;
  note: string | null;
  path: string | null;
  encoding: string | null;
  /** 这个编码是用户自己指定的（`book_file.encoding_locked`），扫描时别再探测 */
  encoding_locked?: number;
  word_count: number | null;
  chapter_count: number | null;
  file_status: string | null;
  reading_status: string | null;
  rating: number | null;
  comment: string | null;
  drop_reason: string | null;
  reread_count: number;
  chapter_idx: number | null;
  char_offset: number | null;
}

// 这两套原来在这里和 Settings.tsx 各有一份，导出又要第三份——收进 core/labels.ts 了
const STATUS = SERIAL_STATUS;
const READING = READING_STATUS;

/** spec §2.1 的探测顺序，用户手动指定时也是这几个 */


interface Props {
  bookId: number;
  onClose: (changed: boolean) => void;
  /**
   * 打开「在线地址」。
   *
   * **`LinksDialog` 原来是够不到的**：`setLinksFor` 全仓库从来没有被赋过值，
   * 于是 170 行的界面加 `link.list` / `addBatch` / `check` / `setPrimary` / `remove`
   * 五个 rpc 一起悬空。死 rpc 扫描抓不到这种——那几个 rpc 确实被调用了，
   * 调用者正是这个没人挂载的组件（AGENTS.md：「另一半是组件没被挂载」）。
   *
   * 入口放这儿而不是卡片上：卡片那排已经五个按钮挤满了，而这本来就是**这本书的
   * 元数据**，旁边「来源站点」那个单行输入框想表达的也正是同一件事。
   */
  onLinks: (bookTitle: string) => void;
  /*
   * 这三样原来是**卡片工具条上的按钮**（章节 / 改名 / 导出），
   * 而那排是**乘以每张卡**的：一屏 8 张卡就是 40 个按钮。
   *
   * 三个都是「一本书一辈子点一次」的操作（换切分规则、改文件名、导个 EPUB），
   * 而这个弹窗本来就是这个应用**唯一的详情页**（`onLinks` 已经是这么挂的）。
   * 收进来之后卡片上只剩「编辑」和「评价」——后者是这个应用的正事。
   *
   * **只在这本书真有文件时给**：手工添的「只有记录」那类点了必然出错
   * （章节会得到「书 N 没有主文件」，改名预览一片空白）——
   * 摆一个点了必然出错的按钮，比没有更糟。
   */
  onChapters: (bookTitle: string) => void;
  onRename: () => void;
  onExport: (bookTitle: string) => void;
}

export function BookEditor({ bookId, onClose, onLinks, onChapters, onRename, onExport }: Props) {
  const [d, setD] = useState<Detail | null>(null);
  const [form, setForm] = useState<Partial<Detail>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** 「已读完 → 在读」问那一句时开着。理由在下拉的 onChange 上 */
  const [rereadAsk, setRereadAsk] = useState(false);
  const [coverVer, setCoverVer] = useState(0);
  /** 「联网找封面」是点一下抓一本。抓一次要开隐藏窗口搜三个源，会花几秒 */
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    rpc<Detail>('book.detail', { bookId })
      .then((x) => {
        setD(x);
        setForm(x);
      })
      .catch((e: Error) => setError(e.message));
  }, [bookId]);

  const set = (k: keyof Detail, v: string) => setForm((f) => ({ ...f, [k]: v }));

  /*
   * **短评和弃坑原因：收摊之前把没存的存了。**
   *
   * 这个弹窗里有两套保存语义，而且都是对的：书名作者那些跟着「保存」按钮走
   * （用户看得见那个按钮），评分/状态/短评是**改了就生效**（「点了弃坑却因为忘了
   * 按保存而没生效，是最气人的那类 bug」，注释就在上面）。
   *
   * 问题出在「改了就生效」的实现方式：星级是 onChange 立刻存，
   * **而这两个输入框是 onBlur 才存**——按 Esc 关掉弹窗不经过失焦，那句话就没了。
   * 同 `RatePopover` 那次，判据一样：**短评重扫恢复不了**。
   *
   * 这里比浮层那次多一层麻烦：这两个框是**非受控**的（`defaultValue`，
   * 本仓库明确记着别改成受控），所以 cleanup 只能从 DOM 上读当下的值。
   */
  /*
   * ⚠️ **不能在 cleanup 里读 ref 拿 DOM 的值**——试过，拿到的是 null：
   * React 卸载一棵子树时**先把 ref 置空**，`useEffect` 的 cleanup 是之后才跑的。
   * 所以草稿要一边打一边记（`onInput` 存进 ref）。
   * 用 `onInput` 而不是 `onChange` + state：这两个框是**非受控**的，
   * 本仓库明确记着别改成受控（改成受控那次「先点星、再打字、失焦」存进去的是空串）。
   */
  const draft = useRef<{ comment?: string; drop?: string }>({});
  const saved = useRef<{ comment: string; drop: string }>({ comment: '', drop: '' });
  useEffect(() => () => {
    const patch: Record<string, unknown> = {};
    const { comment: c, drop: dr } = draft.current;
    if (c !== undefined && c !== saved.current.comment) patch.comment = c || null;
    if (dr !== undefined && dr !== saved.current.drop) patch.dropReason = dr || null;
    if (Object.keys(patch).length > 0) void rpc('reading.setStatus', { bookId, ...patch });
  }, [bookId]);

  /** 阅读状态是**立即生效**的，不跟着「保存」走——改状态和改书名是两件事，
   *  用户点了「弃坑」却因为忘了按保存而没生效，是最气人的那类 bug */
  const saveStatus = async (patch: Record<string, unknown>) => {
    try {
      await rpc('reading.setStatus', { bookId, ...patch });
      setD(await rpc<Detail>('book.detail', { bookId }));
      setChanged(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await rpc('book.update', {
        bookId,
        fields: {
          title: form.title,
          author: form.author || null,
          aliases: form.aliases || null,
          intro: form.intro || null,
          serial_status: form.serial_status,
          source_site: form.source_site || null,
          note: form.note || null,
        },
      });
      setChanged(true);
      setMsg('已保存');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reparse = async (encoding?: string) => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await rpc<{ ok: number; failed: Array<{ error: string }> }>('book.reparse', {
        bookIds: [bookId],
        encoding,
      });
      if (r.failed.length > 0) setError(r.failed[0].error);
      else {
        setMsg(encoding ? `已按 ${encoding} 重新解析` : '已重新解析');
        setD(await rpc<Detail>('book.detail', { bookId }));
        setChanged(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!d) {
    return (
      <div className="modal-backdrop" onClick={() => onClose(changed)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          {error ? <p className="danger">{error}</p> : <p className="muted">正在读取…</p>}
        </div>
      </div>
    );
  }

  const reading = {
    status: d.reading_status ?? 'none',
    rating: d.rating,
    comment: d.comment,
    drop_reason: d.drop_reason,
    chapterIdx: d.chapter_idx ?? 0,
    charOffset: d.char_offset ?? 0,
  };

  const field = (label: string, key: keyof Detail, placeholder = '') => (
    <label style={{ display: 'block', marginBottom: '.6rem' }}>
      <span className="muted" style={{ fontSize: '.85rem' }}>{label}</span>
      <input
        value={(form[key] as string) ?? ''}
        onChange={(e) => set(key, e.target.value)}
        placeholder={placeholder}
        style={{ width: '100%', marginTop: '.15rem' }}
      />
    </label>
  );

  return (
    <div className="modal-backdrop" onClick={() => onClose(changed)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 .8rem', fontSize: '1.1rem' }}>编辑《{d.title}》</h2>

        <div
          className="row"
          style={{
            alignItems: 'flex-start',
            marginBottom: '.8rem',
            outline: dragging ? '2px dashed var(--accent)' : 'none',
            outlineOffset: 4,
          }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (!file) return;
            const path = window.novel.pathForFile(file);
            if (!path) { setError('拿不到这个文件的路径'); return; }
            void (async () => {
              try {
                await rpc('cover.set', { bookId, path });
                setCoverVer((v) => v + 1);
                setChanged(true);
                setError(null);
              } catch (err) {
                setError((err as Error).message);
              }
            })();
          }}
        >
          <Cover bookId={bookId} title={d.title} version={coverVer} width={92} />
          <div>
            <div className="muted" style={{ fontSize: '.85rem' }}>封面</div>
            <p className="muted" style={{ fontSize: '.8rem', margin: '.2rem 0 .4rem' }}>
              把图片拖到这里，或者点下面的按钮。没有封面时用书名画一件素色书衣顶上。
            </p>
            <div className="row">
              {/* 联网找封面是**点一下抓一本**，不是后台自动跑全库。
                  书名作者会发到搜索源去，那是用户该自己决定的事 */}
              <button
                className="primary"
                disabled={fetching}
                onClick={() => void (async () => {
                  setFetching(true);
                  setFetchMsg(null);
                  try {
                    const r = await rpc<{ status: string; source?: string }>('cover.fetchOne', { bookId });
                    setCoverVer((v) => v + 1);
                    setChanged(true);
                    setFetchMsg(
                      r.status === 'ok'
                        ? `找到了（来自${r.source ?? '搜索源'}）`
                        : '几个源上都没有书名作者都对得上的，可以自己选一张',
                    );
                  } catch (e) {
                    setFetchMsg((e as Error).message);
                  } finally {
                    setFetching(false);
                  }
                })()}
              >
                {fetching ? '正在找…' : '联网找封面'}
              </button>
              <button
                onClick={() => void (async () => {
                  const path = await rpc<string | null>('ui.pickImage');
                  if (!path) return;
                  try {
                    await rpc('cover.set', { bookId, path });
                    setCoverVer((v) => v + 1);
                    setChanged(true);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                })()}
              >
                选一张图…
              </button>
              <button
                onClick={() => void (async () => {
                  await rpc('cover.clear', { bookId });
                  setCoverVer((v) => v + 1);
                  setChanged(true);
                })()}
              >
                清除封面
              </button>
            </div>
            {fetchMsg && (
              <p className="muted" style={{ fontSize: '.8rem', margin: '.35rem 0 0' }}>{fetchMsg}</p>
            )}
          </div>
        </div>

        {field('书名', 'title')}
        {field('作者', 'author')}
        {field('别名（多个用逗号分隔，参与搜索匹配）', 'aliases')}
        {field('来源站点', 'source_site')}
        {/* 「来源站点」是一个单行输入框，只放得下一个地址；而抓封面的时候顺手
            记下的源页可能有好几条，还带着「哪条是主站」和探活结果。
            那些存在 online_link 表里，得有个门进去 */}
        {/* 书名从这儿传出去：这个弹窗手里就有 `d.title`，而 App 那头只能去
            当前那一页（最多 120 本）里 find 一遍，翻页之后的书会找不到、
            标题落成空串 */}
        <p style={{ margin: '-.3rem 0 .7rem' }}>
          <button type="button" className="mini" onClick={() => onLinks(d.title)}>在线地址…</button>
          <span className="muted" style={{ fontSize: '.8rem' }}>
            　这本书的网上地址，可以存多条、标一个主站、批量探活
          </span>
        </p>

        {/* 这本书的几件不常做的事。原来是卡片工具条上的三个按钮，
            而那排乘以每张卡——一屏八张就是 40 个 */}
        {/*
          * ⚠️ **PDF / EPUB 这类只编目的书，三个键里只有「改文件名」成立。**
          *
          * 它们没有章节、也没有可导的正文：点「章节怎么切」开出来的是一份
          * **0 章**的规则编辑器（换条规则也白搭——`parseAndStore` 对只编目的格式
          * 直接返回），点「导出」拿到的是一句「这个区间里没有章节」——
          * 一句**听起来像章节切歪了**、而其实是「这种格式压根没有正文」的话。
          *
          * 判据是这个仓库早写着的那条：**摆一个点了必然出错的按钮，比没有更糟**
          * （当年「只有记录」的书就是为此把这三个键藏掉的，只是那次的门槛是
          * 「有没有文件」，而 PDF 是**有**文件的，所以从那道门槛底下漏了过去）。
          * 改文件名照旧留着——给一个 PDF 改文件名完全成立。
          */}
        {d.path && (
          <p style={{ margin: '-.3rem 0 .9rem', display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
            {formatOf(d.path) !== 'catalog' && (
              <button type="button" className="mini" title="这本书的章节怎么切——切得不对时可以换一条规则，先试算再决定"
                onClick={() => onChapters(d.title)}>章节怎么切…</button>
            )}
            <button type="button" className="mini" title="按模板改这本书在磁盘上的文件名。先试算给你看，改完还能撤销"
              onClick={() => onRename()}>改文件名…</button>
            {formatOf(d.path) !== 'catalog' && (
              <button type="button" className="mini" title="把这本书导成 EPUB 或 txt。原 txt 一个字节都不会动"
                onClick={() => onExport(d.title)}>导出…</button>
            )}
          </p>
        )}

        <label style={{ display: 'block', marginBottom: '.6rem' }}>
          <span className="muted" style={{ fontSize: '.85rem' }}>连载状态</span>
          <select
            value={form.serial_status ?? 'unknown'}
            onChange={(e) => set('serial_status', e.target.value)}
            style={{ width: '100%', marginTop: '.15rem' }}
          >
            {STATUS.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'block', marginBottom: '.6rem' }}>
          <span className="muted" style={{ fontSize: '.85rem' }}>简介</span>
          <textarea
            value={form.intro ?? ''}
            onChange={(e) => set('intro', e.target.value)}
            rows={3}
            style={{ width: '100%', marginTop: '.15rem', font: 'inherit', color: 'var(--fg)', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 5, padding: '.25em .5em' }}
          />
        </label>

        {field('备注', 'note')}

        <div className="card" style={{ marginBottom: '.6rem' }}>
          <div className="row">
            <span className="muted" style={{ fontSize: '.85rem' }}>阅读状态</span>
            <select
              value={reading.status}
              onChange={(e) => {
                /*
                 * **「已读完 → 在读」会清掉阅读位置**（spec §5.1 把它定义成「重读」），
                 * 而用户在这个下拉里选「在读」有两种意图，应用分不出来：
                 * 「我要重读一遍」和「我标错了，其实还没读完」。
                 * 穷举过 36 种状态转换，**只有这一种会动用户数据**，
                 * 而进度是铁律 3 里重扫恢复不了的。所以先问一句，别替他猜。
                 *
                 * **没有位置可丢的就不问**（读到第 0 章、章内偏移也是 0）——
                 * 判据同 `tag.delete` / `root.remove`：只有真会丢东西的才拦。
                 */
                const to = e.target.value;
                if (reading.status === 'finished' && to === 'reading'
                    && (reading.chapterIdx > 0 || reading.charOffset > 0)) {
                  setRereadAsk(true);
                  return;
                }
                void saveStatus({ status: to });
              }}
            >
              {READING.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>

            {/*
              * 两段式确认，和标签删除、移除书库文件夹是同一套手势（**不用
              * `window.confirm`**：原生模态框和这个应用的内联确认不是一套，
              * 还会挡住自动化）。两个按钮都写明白自己要干什么，
              * 而**会丢东西的那个才是 `danger`**。
              */}
            {rereadAsk && (
              <div className="card" style={{ marginTop: '.5rem' }}>
                <div style={{ fontSize: '0.85rem' }}>
                  这本书标着「已读完」，而库里还记着读到第 {reading.chapterIdx + 1} 章。
                  改成「在读」是哪个意思？
                </div>
                <div className="row" style={{ gap: '.4rem', marginTop: '.5rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => { setRereadAsk(false); void saveStatus({ status: 'reading', keepProgress: true }); }}
                  >
                    其实还没读完（留着第 {reading.chapterIdx + 1} 章）
                  </button>
                  <button
                    className="danger"
                    onClick={() => { setRereadAsk(false); void saveStatus({ status: 'reading' }); }}
                  >
                    重新读一遍（回到开头，记一次重读）
                  </button>
                  <button onClick={() => setRereadAsk(false)}>取消</button>
                </div>
              </div>
            )}

            {/*
              * **和卡片上那个评价浮层用同一个控件。**
              * 这里原来是自己写的一个下拉，还多出半星那一档（1 / 1.5 / 2 …）——
              * 于是同一个字段两套刻度：浮层给 5 颗整星，这儿给 9 档。
              * `StarRating` 抽出来正是为了这个，它的注释里就写着
              * 「以后要加半星或换成十分制，两份就得改两遍」，而这是第三份。
              *
              * **已有的半星不会被弄丢**：`StarRating` 亮的是向下取整的颗数，
              * 旁边照旧写「4.5 星」，不点就不会写回去。要改刻度改那一个组件。
              */}
            <span className="muted" style={{ fontSize: '.85rem', marginLeft: '.5rem' }}>评分</span>
            <StarRating value={reading.rating} onChange={(n) => saveStatus({ rating: n })} />
            {d.reread_count > 0 && (
              <span className="muted" style={{ fontSize: '.82rem' }}>已重读 {d.reread_count} 次</span>
            )}
          </div>

          <input
            // 和评价浮层、添书弹窗用同一句：同一个输入框不能有两个说法
            ref={() => { saved.current.comment = reading.comment ?? ''; }}
            onInput={(e) => { draft.current.comment = (e.target as HTMLInputElement).value; }}
            placeholder="一句话评价，比如「烂尾了别看」"
            defaultValue={reading.comment ?? ''}
            onBlur={(e) => saveStatus({ comment: e.target.value || null })}
            style={{ width: '100%', marginTop: '.4rem' }}
          />

          {reading.status === 'dropped' && (
            <input
              ref={() => { saved.current.drop = reading.drop_reason ?? ''; }}
              onInput={(e) => { draft.current.drop = (e.target as HTMLInputElement).value; }}
              placeholder="弃坑原因（选填）"
              defaultValue={reading.drop_reason ?? ''}
              onBlur={(e) => saveStatus({ dropReason: e.target.value || null })}
              style={{ width: '100%', marginTop: '.4rem' }}
            />
          )}
        </div>

        <div className="card" style={{ fontSize: '.85rem' }}>
          <div className="muted" style={{ overflowWrap: 'anywhere' }}>{d.path}</div>
          <div style={{ marginTop: '.3rem' }}>
            {/* **锁住了要显示出来。** 不说的话，「我选的编码怎么又变了」和
                「我选的编码一直没变」在屏幕上长得一模一样——
                同本文件那条：界面必须显示正在生效的状态 */}
            编码 <strong>{d.encoding ?? '未知'}</strong>
            {d.encoding_locked ? <span className="muted">（你指定的）</span> : null} · {d.chapter_count ?? 0} 章 ·{' '}
            {d.word_count ?? 0} 字
            {d.file_status !== 'ok' && <span className="danger"> · {d.file_status}</span>}
          </div>
          <div className="row" style={{ marginTop: '.5rem' }}>
            <button onClick={() => reparse()} disabled={busy}>重新解析</button>
            <select
              defaultValue=""
              disabled={busy}
              onChange={(e) => e.target.value && reparse(e.target.value)}
              title="乱码时手动指定编码重新解析"
            >
              <option value="">按指定编码重解…</option>
              {ENCODINGS.map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
              {/* **凡是能锁住的东西都得有一条解锁的路**（同规则编辑器的「清除规则」）。
                  挑错一次就再也回不到自动探测，那是个死胡同 */}
              {d.encoding_locked ? <option value="auto">回到自动探测</option> : null}
            </select>
          </div>
        </div>

        {error && <p className="danger" style={{ marginBottom: 0 }}>{error}</p>}
        {msg && <p style={{ color: 'var(--accent)', marginBottom: 0 }}>{msg}</p>}

        <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => onClose(changed)}>关闭</button>
          <button className="primary" onClick={save} disabled={busy || !form.title}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
