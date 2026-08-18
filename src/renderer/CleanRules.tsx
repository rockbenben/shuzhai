import { useCallback, useEffect, useState } from 'react';
import { rpc } from './rpc.ts';

interface Rule {
  id: number;
  name: string;
  pattern: string;
  replacement: string;
  enabled: boolean;
  scope: 'global' | 'book';
  builtin?: boolean;
  note?: string;
}

interface DiffLine {
  before: string;
  after: string | null;
  by?: string;
}

interface Props {
  /** 拿哪本书的哪一章做预览。没有书时只能编辑规则，看不了效果 */
  sampleBookId?: number;
  onClose: () => void;
}

/**
 * 正文清洗规则（spec §2.4）。
 * spec 要求「规则编辑时提供 diff 预览：左右对比清洗前后的某一章」——
 * 所以这个界面的重点不是规则列表，是右边那张前后对照表。
 */
export function CleanRules({ sampleBookId, onClose }: Props) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [sampleTitle, setSampleTitle] = useState('');
  /**
   * 整章规则干了什么。**行 diff 看不见它们**——整章规则是在切行之前跑的，
   * 它删掉的内容根本不在 before/after 里。原来预览连整章规则都不跑，
   * 打开「作者的话（删到章尾）」看到的是「没有任何一行会被改动」。
   * `rejected` 是被 40% 缩水保护挡下的规则名：写了规则、被安全阀拦住、
   * 界面上一个字都不说，是最让人摸不着头脑的一种。
   */
  const [whole, setWhole] = useState<{ removed: number; rejected: string[] }>({ removed: 0, rejected: [] });
  const [error, setError] = useState<string | null>(null);
  /** 预览算不出来。和上面那个 `error`（添加规则失败）分开：两者出现在不同位置 */
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');

  const reload = useCallback(async () => {
    setRules(await rpc<Rule[]>('clean.list'));
    if (sampleBookId !== undefined) {
      try {
        const r = await rpc<{
          title: string; diff: DiffLine[]; rejected: string[]; wholeRemoved: number;
        }>('clean.preview', { bookId: sampleBookId, idx: 0 });
        setSampleTitle(r.title);
        setDiff(r.diff);
        setWhole({ removed: r.wholeRemoved, rejected: r.rejected });
      } catch (e) {
        // 预览失败要**换掉**「正在试算…」，不是在它旁边再加一行红字——
        // 那句话会一直转下去，看起来像是还在算
        setPreviewErr((e as Error).message);
      }
    }
  }, [sampleBookId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = async (r: Rule) => {
    await rpc('clean.setEnabled', { id: r.id, enabled: !r.enabled });
    await reload();
  };

  const add = async () => {
    setError(null);
    try {
      await rpc('clean.add', { name, pattern });
      setName('');
      setPattern('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 'min(56rem, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <h2>正文净化</h2>
        <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
          净化是<strong>运行时套用</strong>的——原始 txt 一个字节都不会改，
          随时可以关掉规则看原文。
        </p>

        {/*
          * **规则表自己滚，别把预览挤到屏幕外面去。**
          *
          * 内置规则十条，一条三行（名字 + 说明 + 正则），整张表 1400px 高。
          * 而这个弹窗的全部意义是 spec 要的那句「规则编辑时提供 diff 预览」——
          * 实测 1280×720 下要往下滚 **808px** 才看得见预览，1920×1080 也要 448px。
          * 也就是说**改规则和看效果永远不在同一屏**，和「调完要立刻看到结果的设置
          * 摆在能看到结果的那个界面里」是同一条判据（纸色当初就是这么搬进阅读器的）。
          */}
        <div style={{ maxHeight: '38vh', overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: '3rem' }}>启用</th>
              {/*
                * **宽度给规则那一栏，不给正则。**
                *
                * 窄窗口早就把正则整列收掉了（`styles.css` 的 `.clean-pattern`），
                * 理由是「被压扁的是说明，而那一栏才是普通人判断该不该开这条规则的依据」。
                * **同一个理由在宽屏一样成立**：1440 下量到规则栏 ~250px（名字加说明折三行）、
                * 正则栏 ~480px——比例是反的。正则给会写正则的人看，说明给所有人看。
                * 收成 32%，全文照旧在 `title` 里。
                */}
              <th style={{ width: '48%' }}>规则</th>
              {/* 窄窗口收掉这一列，见 styles.css 的 .clean-pattern */}
              <th className="clean-pattern" style={{ width: '32%' }}>正则</th>
              <th style={{ width: '3rem' }} />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>
                  <input type="checkbox" checked={r.enabled} onChange={() => void toggle(r)} />
                </td>
                <td style={{ fontSize: '.87rem' }}>
                  {r.name}
                  {r.builtin && <span className="muted" style={{ fontSize: '.75rem' }}> 内置</span>}
                  {/* 十几条规则光看名字判断不了该不该开，说明得直接摆出来 */}
                  {r.note && (
                    <div className="muted" style={{ fontSize: '.75rem', marginTop: '.15rem' }}>{r.note}</div>
                  )}
                </td>
                {/* 净化规则的正则动辄几百个字符，不封顶会把整张表撑得没法看。
                    截断只是显示上的，鼠标悬停能看全文 */}
                <td
                  className="clean-pattern"
                  style={{
                    fontFamily: 'ui-monospace, monospace', fontSize: '.75rem',
                    overflowWrap: 'anywhere', maxHeight: '3.2em', overflow: 'hidden',
                  }}
                  title={r.pattern}
                >
                  {r.pattern}
                </td>
                <td>
                  {!r.builtin && (
                    <button
                      style={{ fontSize: '.75rem', padding: '.1em .4em' }}
                      onClick={async () => {
                        await rpc('clean.remove', { id: r.id });
                        await reload();
                      }}
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>

        <div className="row" style={{ marginTop: '.6rem' }}>
          <input
            placeholder="规则名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: '9rem' }}
          />
          <input
            placeholder="正则（按行匹配，替换后整行为空就删掉这行）"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}
          />
          <button onClick={add} disabled={!name || !pattern}>添加</button>
        </div>

        {error && <p className="danger">{error}</p>}

        <h3 style={{ fontSize: '.95rem', margin: '1rem 0 .3rem' }}>
          效果预览{sampleTitle && <span className="muted"> · {sampleTitle}</span>}
        </h3>
        {sampleBookId === undefined ? (
          <p className="muted" style={{ fontSize: '.85rem' }}>
            书架里还没有能试算的书——净化只对 txt 正文生效，PDF、EPUB 这些只编目不解析。
          </p>
        ) : previewErr ? (
          <p className="muted" style={{ fontSize: '.85rem' }}>这本书试算不出来：{previewErr}</p>
        ) : diff === null ? (
          <p className="muted" style={{ fontSize: '.85rem' }}>正在试算…</p>
        ) : (
          <>
        {whole.removed > 0 && (
          <p className="muted" style={{ fontSize: '.85rem', margin: '0 0 .4rem' }}>
            整章规则删掉了 <strong>{whole.removed.toLocaleString()}</strong> 个字
            （整段整段地删，下面那张按行对照的表里看不到它们）。
          </p>
        )}
        {whole.rejected.length > 0 && (
          <p className="danger" style={{ fontSize: '.85rem', margin: '0 0 .4rem' }}>
            <strong>{whole.rejected.join('、')}</strong> 这一条会删掉超过四成正文，
            已经当它没生效——多半是正则写宽了。
          </p>
        )}
        {diff.length === 0 ? (
          /* 上面刚说完「整章规则删掉了 N 个字」，这里再说「没有任何一行会被改动」
             就自相矛盾了——**下面这张表只管按行的规则**，话得说到这个份上 */
          <p className="muted" style={{ fontSize: '.85rem' }}>
            {whole.removed > 0 ? '按行的规则没有再改动任何一行。' : '这一章没有任何一行会被改动。'}
          </p>
        ) : (
          <div style={{ maxHeight: '16rem', overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>净化前</th>
                  <th>净化后</th>
                  <th style={{ width: '8rem' }}>规则</th>
                </tr>
              </thead>
              <tbody>
                {diff.map((l, i) => (
                  <tr key={i}>
                    <td style={{ fontSize: '.8rem', overflowWrap: 'anywhere' }}>{l.before}</td>
                    <td
                      style={{
                        fontSize: '.8rem',
                        overflowWrap: 'anywhere',
                        color: l.after === null ? 'var(--danger)' : 'var(--accent)',
                      }}
                    >
                      {l.after === null ? '（整行删除）' : l.after}
                    </td>
                    <td className="muted" style={{ fontSize: '.78rem' }}>{l.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
          </>
        )}

        {/* 真实书库上量出来的：预览里一有真的 diff 行，收尾那个键就掉到折叠线下面
            109px。测试库那 8 本预览是空的，所以永远发现不了 */}
        <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
          {/* ⚠️ **这个键只负责合上，改的每一项早就落库了**（`setting.set` / `clean.add`
              是改的当下就发的）。所以写「关闭」不写「完成」——「完成」在暗示
              「点了才算数」，用户拿 Esc 关掉时会怀疑自己的改动丢了。
              同样是即时保存的面板，书库文件夹 / 章节怎么切 / 标签管理 / 重复的书
              四处写的也都是「关闭」 */}
          <button className="primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
