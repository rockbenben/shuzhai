import { useCallback, useEffect, useState } from 'react';
import { rpc } from './rpc.ts';

/*
 * **类型从 core 引，别在这儿再抄一份。**
 *
 * 原来这里手写了 `Version` 和 `Group` 两个接口，而它们比 `core/versions.ts`
 * 那两份**少了 `mtime` 和 `contentHash`**——抄的时候漏的。后果不是编译错误，
 * 是这两个字段在界面这一侧根本不存在，想用的时候才发现「类型上没有」。
 *
 * 这是这个仓库反复出现的那个形状（AGENTS.md 开头就写着）：`Filter` 抄过一份、
 * `RepairReport` 抄过一份，都是抄的那份先掉队。引过来之后 core 加字段这边自动就有。
 */
import type { Version, VersionGroup as Group } from '../core/versions.ts';
import type { DeleteLogRow } from '../core/deletion.ts';
import { formatOf } from '../core/book-format.ts';
// 库里的时间是 UTC，印之前必须走它——`no-raw-time.test.ts` 那条守着
import { whenAgo } from '../core/format.ts';

/**
 * 文件大小。**不到 1 MB 的要按 KB 报**——原来一律 `.toFixed(1) MB`，
 * 一个 48 KB 的文件显示成「0.0 MB」，而它就摆在删除按钮旁边，
 * 看着像个空文件。而这一列的用途正是「哪份更全」。
 */
const size = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** 一组文件的共同目录（含末尾分隔符）。都在同一个文件夹时才有值 */
function commonDir(paths: string[]): string {
  if (paths.length < 2) return '';
  const cut = (p: string) => p.slice(0, p.search(/[^\\/]*$/));
  const first = cut(paths[0]);
  return paths.every((p) => cut(p) === first) ? first : '';
}

/**
 * 多版本归组（spec §8）+ 删除重复文件。
 *
 * ## 这个界面原来摊着三样东西，而它们对应的是同一个意图
 *
 * 「合并成一本」只并数据库记录，磁盘上一个文件都不动——点完之后组里**还是
 * 两个文件、还列在这里**，唯一的变化是那个按钮自己消失了。用户看到的就是
 * 「点了没反应」，而「合并成一本」这个名字承诺的恰恰是「只剩一本」。
 * 要真的只剩一份，还得再去点「主」、逐个勾「删」、点按钮、过二次确认——
 * 五步。三个概念（合并记录 / 选主版本 / 删文件）全暴露在界面上，
 * 而用户想的只有一句：**我只要留一份。**
 *
 * 现在一组一个动作：选「留哪份」，点一下，其余的进回收站。
 * 合并记录和设主版本由 `version.keepOnly` 在后面顺手做掉，不再是用户的事。
 *
 * **单选按钮本身不删任何东西。** 它是个用来「看看」的控件，一次误点丢掉的
 * 可能是内容不同的另一个版本（校对版 vs 精校版 内容真不一样）。
 * 破坏性动作必须由一个写明后果的按钮发起，并且过二次确认。
 *
 * 「都留着，只当成一本书」是另一个真实存在的意图（书架上从两张卡变一张，
 * 文件都保留），留成一个不起眼的次要动作。
 *
 * ## 安全阀一条没绕
 *
 * 删除是 spec §0.1「移动和删除仍然不做」的**例外**，由用户明确要求加的：
 *   - **移入系统回收站，不是真删**——这一条改变了整件事的风险等级
 *   - 走的还是 `deleteDuplicates`：两档判据、`delete_log`、
 *     文件进了回收站之后才动数据库记录
 *   - 二次确认里把「完全重复」和「另一个版本」分开说，风险差着量级
 */
/**
 * 这一组默认留哪一份。
 *
 * ⚠️ **能读的（txt）优先于只编目的（PDF / EPUB）**，哪怕后者是当前的主版本。
 *
 * 「同名同作者的两个文件」这个归组口径**不看格式**，于是
 * `三体.txt` 和 `三体.epub` 会落进同一组——而它们不是「校对版 vs 精校版」
 * 那种可以随便留一个的关系：txt 给的是章节、书内搜索、朗读、划线，
 * PDF/EPUB 只能一页页翻。留错了那一份，这本书就再也读不成了。
 *
 * 而原来的默认恰好会选错：默认是「当前的主版本」，可这一组里**每本书
 * 各有各的主版本**，`find` 拿到的是**列表里第一个**——`listGroups` 按
 * `f.id` 排，而目录遍历里 `.epub` 排在 `.txt` 前面。实测就是这样：
 * 打开「重复的书」，预选的是 EPUB，待删的是那份带章节的 txt。
 *
 * 判据用 `formatOf`（全应用唯一那一份），和 `primary.ts` 的 `preferReadable`
 * 是同一条；那边管的是合并之后主文件落在哪，这边管的是默认留哪一份。
 */
function 默认留(g: Group): number {
  const 能读 = g.versions.filter((v) => formatOf(v.path) === 'text' && v.status === 'ok');
  const 候选 = 能读.length > 0 ? 能读 : g.versions;
  return (候选.find((v) => v.isPrimary) ?? 候选[0]).fileId;
}

export function VersionsDialog({ onClose }: { onClose: (changed: boolean) => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  /** 每组留哪一份。默认是当前的主版本 */
  const [keep, setKeep] = useState<Map<string, number>>(new Map());
  /** 正在确认的那一组。一次只确认一组——这是个一组一个决定的界面 */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  /**
   * **这一组没删成的原因，就摆在那个按钮旁边。**
   *
   * 原来成功和失败都只写进上面那个 `msg`，而它渲染在整个分组列表的**上方**——
   * 用户滚到某一组、点了「确认」，反馈出现在看不见的地方，看上去就是「点了没反应」。
   * 失败尤其要留在原地：那一组还在，人还站在它面前。
   */
  const [失败, set失败] = useState<string | null>(null);
  /**
   * **删过的那些。** `delete_log` 一直在记（路径、大小、书名、时间、去处），
   * `version.deleteHistory` 这个 rpc 也一直在——**而界面上一处都不调**，
   * 死 rpc 清点当场揪出来的。
   *
   * 后果不是少个功能：删文件是这个应用**唯一会动用户磁盘**的两件事之一
   * （铁律 1 的那个例外），整套安全阀（回收站 → 暂存区 → 30 天）都建在
   * 「删错了还拿得回来」上，而**「我到底删过什么」在界面上根本查不到**。
   * 尤其是挪进暂存区那一路：去处是 `userData/quarantine` 底下一个带时间戳的
   * 文件名，不看这份记录就只能去回收站白找一趟。
   *
   * 摆在这个弹窗里而不是另开一个顶层入口：删除就是在这儿发生的，
   * 「我刚删了什么」和「还有哪些重复」是同一件事的两半。
   */
  const [删过的, set删过的] = useState<DeleteLogRow[]>([]);
  const [看删除记录, set看删除记录] = useState(false);

  const reload = useCallback(async () => {
    const gs = await rpc<Group[]>('version.groups');
    setGroups(gs);
    setKeep(new Map(gs.map((g) => [g.key, 默认留(g)])));
    // 删完一批要跟着变——这个弹窗自己就是产生删除记录的地方
    set删过的(await rpc<DeleteLogRow[]>('version.deleteHistory').catch(() => []));
  }, []);

  useEffect(() => {
    reload().catch((e: Error) => setError(e.message));
  }, [reload]);

  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
      setChanged(true);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * 真正下手的那一下。**两个按钮共用这一份**——「确认移入回收站」传 `永久 = false`，
   * 「回收站用不了，直接删掉」传 `true`。各写一份的话，下面那三条判据迟早分叉。
   *
   * ⚠️ **一个都没删成时，不要用「已移入回收站 0 个」开头。**
   * 那是一句以成功框架报告彻底失败的话——用户读到的前六个字是「已移入回收站」，
   * 而实际上什么都没发生，那一组还原样摆在那儿。
   *
   * ⚠️ **失败要留在原地**：`confirming` 不关闭、用 danger 色。那一组还在，
   * 人还站在它面前，反馈就该在他眼前——而不是渲染在整个列表上方看不见的地方。
   *
   * ⚠️ **只报 core 给的那句，界面不猜原因。** 第一版我在这儿一律加了句
   * 「如果这些文件在网络盘上……」，而实测那次失败根本不是网络盘，
   * 是那个文件早就不在磁盘上了（Windows 抛 `Failed to parse path`）。
   * 判断在 `deletion.ts` 的「说人话」里——那一层才知道路径长什么样、文件在不在。
   */
  const 执行 = (
    g: { title: string },
    keptId: number,
    drop: Array<{ fileId: number }>,
    /** 回收站收不下时，改挪进暂存区（`quarantineIfNoTrash`） */
    永久: boolean,
  ) => act(async () => {
    const r = await rpc<{ deleted: unknown[]; failed: Array<{ path: string; reason: string }> }>(
      'version.keepOnly',
      { keepFileId: keptId, dropFileIds: drop.map((v) => v.fileId), quarantineIfNoTrash: 永久 },
    );
    if (r.deleted.length === 0) {
      set失败(`一个都没能删：${r.failed[0]?.reason ?? '未知原因'}`);
      return;
    }
    setConfirming(null);
    set失败(null);
    setMsg(
      `《${g.title}》${永久 ? '已挪到暂存区' : '已移入回收站'} ${r.deleted.length} 个`
      // 挪进暂存区的必须说清去处和期限，否则用户会去回收站白找一趟
      + (永久 ? '（不在系统回收站里；30 天没人动就会清掉）' : '')
      + (r.failed.length ? `，另 ${r.failed.length} 个没能删：${r.failed[0].reason}` : ''),
    );
  });

  /*
   * **进来不再逐个问 `version.canDelete` 了。**
   *
   * 原来一打开就对每个文件问一遍，把删不掉的行灰掉。那在「逐个勾选」的模型下
   * 是对的，但 `keepOnly` 会**先合并记录再删**，而 canDelete 拦人的那两条
   * （「这本书只有这一个文件而它有阅读进度」）合并之后根本不成立——
   * 留下的那一份就在同一本书里。也就是说合并前问出来的「删不掉」是个
   * **会被自己解掉的假警报**，摆在按钮旁边只会让人不敢点。
   * 真出错还是会在结果里如实报出来。
   */

  return (
    <div className="modal-backdrop" onClick={() => onClose(changed)}>
      <div className="modal" style={{ width: 'min(56rem, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <h2>重复的书</h2>
        {/* 一组都没有时**不铺这段说明**：它讲的是怎么在几个版本之间做取舍，
            而此刻屏幕上一个版本组都没有。「先点『定位』比对一下」尤其糟——
            界面上根本没有「定位」这个按钮 */}
        {groups.length > 0 && (
          <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
            同名同作者的多个文件算一组。<strong>选中要留的那一份，其余移入系统回收站</strong>
            （不是真删，删错了能拖回来）。
            <br />
            标<span className="danger">「完全重复」</span>的删了等于没删；
            没标的是<strong>内容不一样的另一个版本</strong>（比如校对版 / 精校版），
            <strong>删掉那份内容就真的没了</strong>——先点「定位」比对一下再决定。
          </p>
        )}

        {error && <p className="danger">{error}</p>}
        {msg && <p style={{ color: 'var(--accent)', fontSize: '.85rem' }}>{msg}</p>}

        {groups.length === 0 ? (
          <p className="muted">
            没有同名同作者的重复文件。扫描时会自动比对，以后有了会出现在这里。
          </p>
        ) : (
          groups.map((g) => {
            const dir = commonDir(g.versions.map((v) => v.path));
            const keptId = keep.get(g.key) ?? g.versions[0].fileId;
            const drop = g.versions.filter((v) => v.fileId !== keptId);
            const risky = drop.filter((v) => !v.exactDuplicate);
            /* 留下的和删掉的**不是同一种格式**——那时候「另一个版本」这个说法
               会漏掉真正要紧的那一半：能读的和只能翻的，差的不是内容是能力 */
            const kept = g.versions.find((v) => v.fileId === keptId);
            const 丢掉能读的 = kept && formatOf(kept.path) !== 'text'
              && drop.some((v) => formatOf(v.path) === 'text');
            return (
              <div key={g.key} className="card" style={{ marginBottom: '.8rem' }}>
                <div className="row">
                  <strong>{g.title}</strong>
                  <span className="muted">{g.author ?? '未知作者'}</span>
                  <span className="muted" style={{ fontSize: '.82rem' }}>{g.versions.length} 个文件</span>
                </div>
                {/* 共同目录说一次就够。分散在不同文件夹时 commonDir 返回空，
                    那时候每一行印的就是各自的整条路径——因为那时候目录**是**区别 */}
                {dir && (
                  <div className="muted" style={{ fontSize: '0.75rem', overflowWrap: 'anywhere' }}>
                    都在 {dir}
                  </div>
                )}

                <table style={{ marginTop: '.4rem' }}>
                  <thead>
                    <tr>
                      <th style={{ width: '3.5rem' }}>留</th>
                      <th>文件</th>
                      <th style={{ width: '6rem' }}>字数</th>
                      <th style={{ width: '4rem' }}>章数</th>
                      <th style={{ width: '5rem' }}>大小</th>
                      <th style={{ width: '5rem' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {g.versions.map((v) => (
                      <tr key={v.fileId}>
                        <td>
                          {/* 选它只是「留哪份」的意思，**不会当场删掉任何东西** */}
                          <input
                            type="radio"
                            name={`keep-${g.key}`}
                            checked={v.fileId === keptId}
                            onChange={() => setKeep((m) => new Map(m).set(g.key, v.fileId))}
                            aria-label={`留下 ${v.path.split(/[\\/]/).pop()}`}
                          />
                        </td>
                        {/* **只印文件名，不印整条路径。**
                            这个弹窗全部的用处是「决定留哪一份」，而两份的区别
                            就在文件名上（「（校对版）」「（精校版）」）。原来整条
                            绝对路径铺四行、四行里前三行半一模一样，真正要看的
                            那几个字被挤到第四行末尾。共同的目录在组头上说一次。 */}
                        {/* 悬停里带上确切时间。
                            **不给它单开一列**：决定「留哪份」要的是「哪个更新」，
                            那一条下面那个「最新」角标已经在说了（`newest` 由 `mtime`
                            算出来）。确切日期只在「这库有多久没动过」这种时候有用，
                            为它花掉一列宽度不划算——这张表已经五列了。
                            `dead-fields.mjs` 报 `mtime` 没人读，而它和 `DeleteCheck.identical`
                            是同一个形状：**字段没被读，是因为同一个事实有更合适的来源**。 */}
                        <td
                          style={{ fontSize: '.82rem', overflowWrap: 'anywhere' }}
                          title={`${v.path}
修改时间：${new Date(v.mtime).toLocaleString('zh-CN')}`}
                        >
                          {dir ? v.path.slice(dir.length) : v.path}
                          <div style={{ fontSize: '.72rem' }}>
                            {v.mostWords && <span style={{ color: 'var(--accent)' }}>字数最多 </span>}
                            {v.newest && <span style={{ color: 'var(--accent)' }}>最新 </span>}
                            {v.exactDuplicate && <span className="danger">完全重复 </span>}
                            {v.status !== 'ok' && <span className="danger">{v.status}</span>}
                          </div>
                        </td>
                        <td style={{ fontSize: '0.82rem' }}>{v.wordCount?.toLocaleString() ?? '—'}</td>
                        <td style={{ fontSize: '0.82rem' }}>{v.chapterCount ?? '—'}</td>
                        <td style={{ fontSize: '0.82rem' }}>{size(v.size)}</td>
                        <td>
                          <button
                            style={{ fontSize: '.75rem', padding: '.1em .45em' }}
                            onClick={() => void rpc('ui.revealFile', { path: v.path })}
                          >
                            定位
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {confirming === g.key ? (
                  <div className="card" style={{ marginTop: '.6rem', borderColor: 'var(--danger)' }}>
                    <strong className="danger">把这 {drop.length} 个移入回收站？</strong>
                    <p className="muted" style={{ margin: '.3rem 0 .5rem', fontSize: '.85rem' }}>
                      {risky.length > 0 ? (
                        <>
                          <strong className="danger">
                            其中 {risky.length} 个不是完全重复，是内容不一样的另一个版本
                          </strong>
                          ——删掉之后那份内容在库里就没有了：
                        </>
                      ) : (
                        <>要删的都是<strong>内容完全相同</strong>的重复文件，删了等于没删。</>
                      )}
                      <br />
                      {drop.map((v) => (
                        <span key={v.fileId} style={{ display: 'block', fontSize: '.8rem' }}>
                          · {v.path.split(/[\\/]/).pop()}
                        </span>
                      ))}
                      {丢掉能读的 && (
                        <>
                          <strong className="danger">
                            {`留下的是 ${kept ? (kept.path.split('.').pop() ?? '').toUpperCase() : ''}，而要删的里面有 txt。`}
                          </strong>
                          {'——这本书之后只能一页页翻：'}
                          <strong>章节目录、书内搜索、朗读、划线和笔记都用不了</strong>
                          {'，已经划过的线也显示不出来。想留能读的那份就先在上面改选。'}
                          <br />
                        </>
                      )}
                      <strong>是移入系统回收站，不是真删</strong>——删错了可以从回收站还原。
                      {丢掉能读的
                        ? '评分和短评挂在书上，不会受影响；读到第几章还在库里，但没有正文可对了。'
                        : '阅读进度挂在书上而不是文件上，不会受影响。'}
                    </p>
                    {失败 && <p className="danger" style={{ margin: '0 0 .5rem' }}>{失败}</p>}
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button onClick={() => { setConfirming(null); set失败(null); }}>再看看</button>
                      <button
                        // 不是 primary：这一下真的会把文件从库里拿走，不该和「保存」同色
                        className="danger"
                        onClick={() => void 执行(g, keptId, drop, false)}
                      >
                        确认移入回收站
                      </button>
                      {/*
                        * ⚠️ **只在回收站真的收不下之后才出现**（所以挂在 `失败` 上）。
                        *
                        * 网络共享上没有回收站（实测 `shell.trashItem` 抛
                        * `Failed to perform delete operation`），而那儿的重复文件照样占着空间。
                        *
                        * **搬进暂存区不是真删，铁律 1 没有被破**：文件还在磁盘上、还拿得回来，
                        * 只是从书库目录挪进了应用自己的目录，30 天没人动才清。
                        * 也正因为不丢内容，**这条路不限于「内容完全相同」的那些**——
                        * 那道闸是给真删用的。
                        *
                        * **必须是第二次点击**：上面那句话写着「移入系统回收站」，
                        * 悄悄改成别的地方就是让界面撒谎。所以这个键单独出现、单独写明去处。
                        */}
                      {失败 && (
                        <button className="danger" onClick={() => void 执行(g, keptId, drop, true)}>
                          回收站用不了，先挪到暂存区（30 天后清空）
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="row" style={{ marginTop: '.5rem' }}>
                    {/* 按钮上写清楚**会发生什么**，不写「合并」这种看不出后果的词 */}
                    <button className="danger" onClick={() => { setConfirming(g.key); set失败(null); }}>
                      只留选中的这份，另 {drop.length} 个移入回收站
                    </button>
                    {/* 「都留着」是另一个真实的意图：书架上从多张卡变一张，文件不动。
                        只有在它真的被当成了多本书时才有意义 */}
                    {g.bookIds.length > 1 && (
                      <button
                        onClick={() => void act(async () => {
                          await rpc('version.merge', { bookIds: g.bookIds });
                          setMsg(`《${g.title}》的 ${g.versions.length} 个文件已归到同一本书下，文件都还在。`);
                        })}
                        title="文件都保留，只是书架上不再显示成多本。优先保留有阅读进度的那本"
                      >
                        都留着，只当成一本书
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}

        {/*
          * **删过的那些。** 默认折起来、一行——它是「事后查账」，不是每次打开
          * 都要读一遍的东西（同书架那份体检名单的手势）。一条都没有就整个不出现。
          */}
        {删过的.length > 0 && (
          <div className="card" style={{ marginTop: '.8rem', fontSize: '.82rem' }}>
            <button className="mini" onClick={() => set看删除记录((v) => !v)}>
              {看删除记录 ? '收起' : `删过的 ${删过的.length} 个`}
            </button>
            {看删除记录 && (
              <div style={{ marginTop: '.5rem' }}>
                {/* ⚠️ **「去哪儿找」比「删了什么」更要紧。** 回收站那一路人人会找，
                    暂存区那一路不说就没人找得到——路径带时间戳，猜不出来。
                    `reason` 里 core 已经把去处写全了，这里原样摆出来，界面不另编一句 */}
                <p className="muted" style={{ margin: '0 0 .5rem' }}>
                  文件都没有真删：进了系统回收站，或者（回收站用不了时）挪进了应用的暂存区。
                  下面每条都写着去处。
                </p>
                {删过的.map((d) => {
                  const 时 = whenAgo(d.deleted_at);
                  return (
                    <div key={d.id} style={{ marginBottom: '.45rem' }}>
                      <div>
                        《{d.book_title ?? '未知书名'}》
                        {时 && <span className="muted" style={{ marginLeft: '.4rem' }} title={时.title}>{时.text}</span>}
                      </div>
                      {/* 路径可能很长（网络盘那种），单独一行、等宽、能横滚 */}
                      {/* ⚠️ 不叫 `path`：那个只在 `.statusbar` 里才有样式，
                          在这儿写它拿不到任何东西（而且加一条全局 `.path` 就是
                          又一次类名撞车，`docs/lessons.md` 刚记过两回） */}
                      <div className="log-path" title={d.path}>{d.path}</div>
                      <div className="muted" style={{ fontSize: '.78rem' }}>{d.reason}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="row modal-actions" style={{ marginTop: '.6rem' }}>
          <span style={{ flex: 1 }} />
          <button onClick={() => onClose(changed)}>关闭</button>
        </div>
      </div>
    </div>
  );
}
