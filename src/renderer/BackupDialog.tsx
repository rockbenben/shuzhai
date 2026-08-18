import { useCallback, useEffect, useState } from 'react';
import { rpc } from './rpc.ts';

interface AutoConfig {
  enabled: boolean;
  dir: string;
  everyDays: number;
  keep: number;
  lastAt: string | null;
}

/*
 * **从 core 引，别在这儿手抄一份。**
 * 这里原来内联写着一份只有两个字段的 `RestoreReport`，而 core 那份一直在长——
 * 于是「恢复完回来了多少书评/划线」在界面这一侧**根本不存在**。
 * 这个仓库栽在「手抄的第二份先掉队」上已经第五次了
 * （`Filter` / `RepairReport` / `Version` / 评分刻度 / 现在这个）。
 */
import type { RestoreReport } from '../core/backup.ts';
import { whenAgo } from '../core/format.ts';

/**
 * 备份与恢复（spec §10）。
 * 这个界面要说清一件事：**备的是重扫恢复不了的那些东西**——阅读进度、书签、
 * 评分短评。书本身丢不了，它们才丢得了。
 */
export function BackupDialog({ onClose }: { onClose: (changed: boolean) => void }) {
  const [cfg, setCfg] = useState<AutoConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [restore, setRestore] = useState<RestoreReport | null>(null);
  const [changed, setChanged] = useState(false);
  /** 已经选好、但还没确认要不要覆盖的备份文件 */
  const [pendingFile, setPendingFile] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setCfg(await rpc<AutoConfig>('backup.autoConfig'));
  }, []);

  useEffect(() => {
    reload().catch((e: Error) => setError(e.message));
  }, [reload]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = async (patch: Partial<AutoConfig>) => {
    const next = { ...cfg!, ...patch };
    setCfg(next);
    await rpc('setting.set', { key: 'backup.auto', value: next.enabled ? '1' : '0' });
    await rpc('setting.set', { key: 'backup.dir', value: next.dir });
    await rpc('setting.set', { key: 'backup.everyDays', value: String(next.everyDays) });
    await rpc('setting.set', { key: 'backup.keep', value: String(next.keep) });
  };

  if (!cfg) {
    return (
      <div className="modal-backdrop" onClick={() => onClose(false)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          {error ? <p className="danger">{error}</p> : <p className="muted">正在读取…</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose(changed)}>
      <div className="modal" style={{ width: 'min(44rem, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <h2>备份与恢复</h2>
        <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
          备份的是<strong>重新扫描恢复不了</strong>的东西：阅读进度、书签、评分短评、
          标签分类、各种规则。txt 文件本身不在备份里，也不需要。
        </p>

        <div className="row">
          <button
            className="primary"
            disabled={busy !== null}
            onClick={() => void run('正在备份…', async () => {
              if (!cfg.dir) {
                setError('先选一个备份文件夹');
                return;
              }
              const r = await rpc<{ path: string; pruned: string[] }>('backup.runAuto');
              setMsg(`已备份到 ${r.path}${r.pruned.length ? `，清理了 ${r.pruned.length} 份旧的` : ''}`);
              await reload();
            })}
          >
            立刻备份一次
          </button>

          {/*
            * **恢复要先看清楚再点。**
            *
            * 原来是「选完文件立刻覆盖」——而它覆盖的正是铁律 3 里重扫恢复不了的
            * 三样（阅读进度、书签、评分短评）。删文件那条路有预览、有二次确认、
            * 还送回收站；这条路一样会丢东西，却一句确认都没有。
            * 现在分两步：先选文件，再确认。
            */}
          <button
            disabled={busy !== null}
            onClick={() => void run('', async () => {
              const picked = await rpc<string | null>('ui.pickBackupFile');
              if (picked) setPendingFile(picked);
            })}
          >
            从备份文件恢复…
          </button>
          {busy && <span className="muted">{busy}</span>}
        </div>

        {pendingFile && (
          <div className="card" style={{ marginTop: '.6rem' }}>
            <strong className="danger">用这份备份覆盖现在的阅读进度？</strong>
            <p className="muted" style={{ margin: '.3rem 0', fontSize: '0.82rem', overflowWrap: 'anywhere' }}>
              {pendingFile}
            </p>
            <p className="muted" style={{ margin: '.3rem 0 .5rem', fontSize: '0.82rem' }}>
              备份里认得出的书，<strong>阅读进度、书签、评分短评会被备份里的那份替换</strong>——
              这三样重新扫描恢复不了，覆盖了就是覆盖了。认不出的书不动，
              书和 txt 文件也一个都不会动。
            </p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setPendingFile(null)}>再看看</button>
              <button
                className="danger"
                disabled={busy !== null}
                onClick={() => void run('正在恢复…', async () => {
                  const r = await rpc<RestoreReport>('backup.importFile', { path: pendingFile });
                  setPendingFile(null);
                  setRestore(r);
                  setChanged(true);
                  /*
                   * **说清回来了什么，不只是「认回 N 本」。**
                   * 那说的是书，而用户在这一刻想知道的是「我那几百条书评回来了吗」。
                   * 恢复是备份唯一被验证的时刻——一本书认回来了、而它的书评
                   * 因为某处漏了没落库，旧的那句话一个字都不会说。
                   * 数为 0 的不列出来：一个从没写过划线的人不需要看见「划线 0 处」。
                   */
                  // 标签是「词表」不是「书上的东西」，所以单独说一句：
                  // 恢复到一个没有这些标签的库上时，它们是新建出来的
                  const made = [
                    // 标签是「词表」不是「书上的东西」，所以单独说
                    r.createdTags > 0 && `新建了 ${r.createdTags} 个标签`,
                    // 「只有记录的书」是手工添的那种（没有本地文件）。它们靠书名作者认，
                    // 认不到就重新建出来——**得说一声，因为这是这次恢复真的往库里加了东西**
                    r.createdBooks > 0 && `补回 ${r.createdBooks} 本只有记录的书`,
                  ].filter(Boolean).join('，');
                  const got = [
                    r.restored.reviews && `书评 ${r.restored.reviews} 条`,
                    r.restored.highlights && `划线 ${r.restored.highlights} 处`,
                    r.restored.bookmarks && `书签 ${r.restored.bookmarks} 个`,
                    r.restored.sessions && `阅读记录 ${r.restored.sessions} 次`,
                  ].filter(Boolean).join('、');
                  /*
                   * **盖掉了什么也要说。** 恢复是无条件覆盖的（那是对的，
                   * 点「恢复」就是要拿备份里的那份为准），但拿一份三个月前的备份
                   * 恢复一下，这期间写的书评全被换掉，而报告只说回来了几条。
                   * 书评重扫恢复不了，所以这一句必须出现——**它是坏消息，
                   * 单独一句，不混在「回来了什么」那串里**。
                   */
                  const lost = r.overwrote > 0
                    ? `　其中 ${r.overwrote} 条把本地原来写的评价换成了备份里的那份。`
                    : '';
                  /*
                   * **备份里有坏字段也要说一声。** 备份是个用户能用文本编辑器打开的
                   * JSON，也可能来自更早/更新的版本。恢复不会因为一个坏字段就作废
                   * 整份备份（它是不可再生数据的唯一保险），但**收拾了什么得让人知道**
                   * ——否则「我明明写过 4 星，怎么恢复完没了」谁也解释不清。
                   */
                  const 收拾 = r.fixed > 0
                    ? `　备份里有 ${r.fixed} 处对不上（评分、状态、日期这类），已经按默认值收拾掉了。`
                    : '';
                  setMsg(`恢复完成：认回 ${r.matched} 本${got ? `，${got}` : ''}${made ? `，${made}` : ''}。${lost}${收拾}`);
                })}
              >
                确认覆盖
              </button>
            </div>
          </div>
        )}

        {msg && <p style={{ color: 'var(--accent)' }}>{msg}</p>}
        {error && <p className="danger">{error}</p>}

        {restore && restore.unmatched.length > 0 && (
          <div className="card" style={{ marginTop: '.6rem' }}>
            <strong className="danger">有 {restore.unmatched.length} 本没能认回本地文件</strong>
            {/*
              * **说了怎么办才算数。** 这段原来只说了原因（「可能是文件还没扫进来」），
              * 而这正是灾难恢复那条路——换台机器的人看到的就是这一屏，
              * 他需要知道的是「下一步做什么」。
              *
              * 那句建议敢给，是因为 `backup.test.ts` 把整条路钉住了：
              * 认不回来 → 扫描 → 再恢复一次就认得回来，**而且第三次也不翻倍**
              * （书签划线都按位置去重）。
              */}
            <p className="muted" style={{ margin: '.3rem 0', fontSize: '0.82rem' }}>
              这些书的进度还在备份文件里，但本地找不到对应的 txt——
              多半是文件还没扫进来。<strong>先把书库文件夹加进来扫描一次，再恢复一遍</strong>，
              这些就认得回来了；重复恢复不会让书签划线翻倍。
              <br />
              文件确实不在这台机器上的话，那几本就先留在备份里——
              <strong>程序不会凭空建条目</strong>，那样只会得到一堆点开就报错的幽灵。
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '.8rem' }}>
              {restore.unmatched.slice(0, 10).map((u, i) => (
                <li key={i}>
                  {u.title}
                  {u.author && <span className="muted"> / {u.author}</span>}
                  <div className="muted" style={{ fontSize: '0.75rem', overflowWrap: 'anywhere' }}>
                    {u.paths[0]}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <h3 style={{ fontSize: '.95rem', margin: '1.1rem 0 .3rem' }}>自动备份</h3>
        <label className="row" style={{ gap: '.4rem' }}>
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
          <span>定期自动备份</span>
        </label>

        <div className="row" style={{ marginTop: '.5rem' }}>
          <span className="muted" style={{ fontSize: '.85rem' }}>每</span>
          <input
            type="number"
            min={1}
            value={cfg.everyDays}
            onChange={(e) => void save({ everyDays: Number(e.target.value) })}
            style={{ width: '4.5rem' }}
          />
          <span className="muted" style={{ fontSize: '.85rem' }}>天，保留最近</span>
          <input
            type="number"
            min={1}
            value={cfg.keep}
            onChange={(e) => void save({ keep: Number(e.target.value) })}
            style={{ width: '4.5rem' }}
          />
          <span className="muted" style={{ fontSize: '.85rem' }}>份</span>
        </div>

        <div className="row" style={{ marginTop: '.5rem' }}>
          <button
            onClick={() => void run('', async () => {
              const dir = await rpc<string | null>('ui.pickFolder');
              if (dir) await save({ dir });
            })}
          >
            选备份文件夹…
          </button>
          <span className="muted" style={{ fontSize: '.8rem', overflowWrap: 'anywhere' }}>
            {cfg.dir || '还没选'}
          </span>
        </div>

        {/*
          * **把「选一个正在同步的文件夹」这条路说出来。**
          *
          * 备份护的是重扫恢复不了的三样，而默认它和书库在同一块盘上——
          * 盘坏了两个一起没。解决办法不需要应用自己会说 WebDAV：
          * 把这个目录指到 OneDrive / 坚果云 / 任何网盘客户端的同步目录就行。
          * 这个能力一直都有，只是界面上**一个字都没提**，等于没有。
          */}
        <p className="muted" style={{ fontSize: '.82rem', marginTop: '.4rem' }}>
          选一个<strong>正在同步的文件夹</strong>（OneDrive、坚果云、网盘客户端的文件夹都行），
          备份就跟着上了云——默认位置和书库在同一块盘上，盘坏了两份一起没。
        </p>
        <p className="muted" style={{ fontSize: '.82rem', marginTop: '.4rem' }}>
          {/* 原来是 `slice(0, 16).replace('T', ' ')`——那串是 `toISOString()` 的 **UTC**，
              截出来的还是 UTC，摆给用户看在东八区差 8 小时 */}
          {cfg.lastAt
            ? <span title={whenAgo(cfg.lastAt)?.title}>上次备份：{whenAgo(cfg.lastAt)?.text}</span>
            : '还没有备份过'}
          。按「距上次多久」算而不是固定时刻——好几天不开程序的话，固定时刻会一次都轮不到。
        </p>

        <div className="row modal-actions" style={{ marginTop: '.9rem', justifyContent: 'flex-end' }}>
          <button onClick={() => onClose(changed)} disabled={busy !== null}>关闭</button>
        </div>
      </div>
    </div>
  );
}
