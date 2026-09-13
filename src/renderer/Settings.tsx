// 设置（spec §6 等）。
//
// 这个弹窗一度长到 428 行、六段全塞在一个滚动条里，而且**保存语义是混的**：
// 排版和朗读改了立即生效，扫描设置却要点「保存」——同一个弹窗里两套规矩，
// 用户改完排版看见「保存」按钮，不点心里没底，点了又不知道刚才改的算不算数。
//
// 重做的三条：
//
// 1. **分两页**：「阅读」是天天要动的（主题、字号、朗读、快捷键），
//    「书库」是设一次就不管的（扫描、安全开关、整理）。
// 2. **全部即时生效，没有保存按钮。** 少一个概念。写库的那几项改一下就落一次盘，
//    反正都是单个键值，代价可以忽略。
// 3. **说明只留会导致数据事故的那几句**。原来每个开关下面挂三四行解释，
//    读完一屏才知道有几个选项。真正必须说的只有两处：重命名/删除那个总开关，
//    和在线朗读会把正文发到第三方。其余移进 title 里。
// 4. **弹窗是「头 / 滚动体 / 底栏」三段 flex**（settings-head / settings-body /
//    modal-actions）：原来整个弹窗一个滚动条，sticky 底栏浮在内容上，最后一行
//    正文正好滚到折缝时被切掉半个字（朗读引擎那句「自己加」常年只剩半截）。
//    底栏放到滚动体外就没有「压字」这回事，页签标题行也一起固定了。

import { useEffect, useRef, useState } from 'react';
import { loadShowRating, saveShowRating, keyLabel, loadImportedThemes, saveImportedThemes } from './settings.ts';
import type { ImportedTheme } from './settings.ts';
import { BUNDLED_THEMES } from './builtin-themes.ts';
import type { DirNode } from '../core/library.ts';
import { SERIAL_STATUS } from '../core/labels.ts';
import type { RepairReport } from '../core/library.ts';
import { rpc } from './rpc.ts';
import { parseMinBytes, MIN_BYTES_KEY, MIN_BYTES_DEFAULT } from '../core/scan.ts';
import { relTime } from '../core/format.ts';
import { CoverSources } from './CoverSources.tsx';
import { TtsEngines } from './TtsEngines.tsx';
import {
  ACTION_NAMES, DEFAULT_KEYS, loadKeys, saveKeys, loadSettings, saveSettings,
  applySettings, applyFontFaces, READ_FONTS,
  type Action, type ReadSettings,
} from './settings.ts';

const MODES = [
  { id: 'off', name: '不自动扫描' },
  { id: 'startup', name: '每次启动扫一次' },
  { id: 'interval', name: '每隔几小时' },
  { id: 'daily', name: '每天固定时刻' },
];

/** 连载状态四档。原来这里和 BookEditor 各存一份，注释还写着「改了两边都得改」 */
const SERIAL = SERIAL_STATUS;

type Tab = 'read' | 'library';

export interface FontFile { name: string; file: string; size: number; bundled?: boolean }



export function Settings({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('read');

  const [mode, setMode] = useState('off');
  const [hours, setHours] = useState('6');
  const [time, setTime] = useState('03:00');
  const [renameOn, setRenameOn] = useState(true);
  /** 收录下限，界面上按 KB 填。**空串 = 还没读回来**，别当成 0 */
  const [minKb, setMinKb] = useState('');
  const [showRating, setShowRating] = useState(loadShowRating);
  const [watchOn, setWatchOn] = useState(false);
  const [bossKey, setBossKey] = useState('CommandOrControl+Shift+H');
  const [read, setRead] = useState<ReadSettings>(loadSettings);
  const [keys, setKeys] = useState(loadKeys);
  const [capturing, setCapturing] = useState<Action | null>(null);
  const [repairMsg, setRepairMsg] = useState<string | null>(null);
  /**
   * 联网补全的状态。**类型写在这儿而不是从 core 引**：它是主进程
   * `CoverFetcher.status()` 拼出来的（`autofetch` / `running` / `pausedReason`
   * / `gapMs` 加上 `fetchStats` 那几个数），core 里没有对应的那个形状。
   * `autofetch` 是用户那个开关（意图，落库跨重启），`running` 是此刻在不在跑——
   * 自动暂停让路、队列跑完时 running 为 false 而开关仍开着。
   */
  const [cover, setCoverState] = useState<{
    autofetch: boolean;
    running: boolean;
    pausedReason: string | null;
    /** 自动暂停的时刻；原因文案是粘住的状态，不标时间会被读成「现在还在限流」 */
    pausedAt: number | null;
    gapMs: number;
    done: number;
    pending: number;
    nomatch: number;
    failed: number;
  } | null>(null);
  const [coverErr, setCoverErr] = useState<string | null>(null);
  /**
   * 联网补全那几个键都是同一套动作：发一条 rpc → 立刻刷一次状态 → **清掉上一次的错话**。
   *
   * 开关和「重试没找到的」原来各抄一份一模一样的 `try/catch`。抄本一分叉，
   * 漏掉 `setCoverErr(null)` 的那一份会让上一次的错话一直挂在界面上——
   * 而补全其实已经好了，用户看到的是一句过期的坏消息。
   */
  const 封面操作 = (method: string) => void (async () => {
    try {
      await rpc(method);
      setCoverState(await rpc('cover.fetchStatus'));
      setCoverErr(null);
    } catch (err) {
      setCoverErr(err instanceof Error ? err.message : String(err));
    }
  })();
  /** 「检查三个源」的结果。源必然会坏（改版、限流、下架），而坏了只表现为命中率悄悄下滑 */
  const [srcCheck, setSrcCheck] = useState<Array<{ label: string; ok: boolean; note: string }> | null>(null);
  const [checking, setChecking] = useState(false);
  const [fonts, setFonts] = useState<FontFile[]>([]);
  const [fontMsg, setFontMsg] = useState<string | null>(null);
  // 只列**从文件导进来的**那些（`convertTheme` 生成的 id 都以 imported- 开头）。
  // 调过色的那几张不列——它们借用内置的 id，撤销走的是阅读器里那个「恢复默认」
  const [papers, setPapers] = useState<ImportedTheme[]>(
    () => loadImportedThemes().filter((t) => t.id.startsWith('imported-')),
  );
  const [paperMsg, setPaperMsg] = useState<string | null>(null);
  /** 按目录设连载状态：一级目录 + 每个目录一档规则，规则存库里、用户自己定 */
  const [dirs, setDirs] = useState<Array<{ dir: string; total: number; depth: number }>>([]);
  const [serialRules, setSerialRules] = useState<Array<{ dir: string; status: string }>>([]);
  const [serialFallback, setSerialFallback] = useState('');
  const [serialPreview, setSerialPreview] = useState<string | null>(null);
  const [serialMsg, setSerialMsg] = useState<string | null>(null);

  const saveSerial = async (rules: Array<{ dir: string; status: string }>, fallback: string) => {
    setSerialPreview(null);
    setSerialMsg(null);
    await rpc('setting.set', { key: 'library.serialRules', value: JSON.stringify({ rules, fallback: fallback || null }) });
  };
  const tryAudio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    void (async () => {
      setMode((await rpc<string>('setting.get', { key: 'scan.mode' })) || 'off');
      setHours((await rpc<string>('setting.get', { key: 'scan.intervalHours' })) || '6');
      setTime((await rpc<string>('setting.get', { key: 'scan.dailyTime' })) || '03:00');
      /*
       * ⚠️ **和守卫用同一个判据：只有 '1' 算开。**
       *
       * 这里原来是 `!== '0'`，而 `rpc.ts` 那四处守卫是 `!== '1'`——
       * 两边对「什么算开」的定义不一样。现在碰巧安全，因为
       * `SETTING_DEFAULTS['rename.enabled'] = '1'` 让没设过时两边都判成开；
       * 可只要那个值变成别的（维护接口写进个 'true'、默认表哪天被动过），
       * 就是这么个死循环：**rpc 说「开关关着，去设置里打开」，用户去看，它是开着的**。
       *
       * 对齐之后任何意外的值都一律显示为「关」——和真正会拒绝执行的那一头一致，
       * 那句报错才不会撒谎。
       */
      setRenameOn((await rpc<string>('setting.get', { key: 'rename.enabled' })) === '1');
      const raw = await rpc<string>('setting.get', { key: MIN_BYTES_KEY });
      setMinKb(String(Math.round(parseMinBytes(raw) / 1024)));
      setWatchOn((await rpc<string>('setting.get', { key: 'scan.watch' })) === '1');
      setBossKey(
        (await rpc<string>('setting.get', { key: 'reader.bossKey' })) || 'CommandOrControl+Shift+H',
      );
      // 装好的字体要在这里挂 @font-face，否则下拉里选得到、正文却不生效
      const fl = await rpc<FontFile[]>('font.list');
      setFonts(fl);
      applyFontFaces(fl);
    })();

  }, []);

  // 抓取进度轮询。只在「书库」页可见时轮，2 秒一次——比推事件简单，
  // 而且这个数字不需要实时到毫秒
  useEffect(() => {
    if (tab !== 'library') return;
    let alive = true;
    const load = () =>
      void rpc<typeof cover>('cover.fetchStatus').then((s) => { if (alive) setCoverState(s); }).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [tab]);

  // 目录列表和连载状态规则：进「书库」页时取一次就够，它们不会自己变
  useEffect(() => {
    if (tab !== 'library') return;
    void rpc<DirNode[]>('library.dirs')
      .then((d) => setDirs(d.filter((x) => x.dir !== ''))).catch(() => {});
    void rpc<string>('setting.get', { key: 'library.serialRules' })
      .then((raw) => {
        if (!raw) return;
        const p = JSON.parse(raw) as { rules?: Array<{ dir: string; status: string }>; fallback?: string | null };
        setSerialRules(p.rules ?? []);
        setSerialFallback(p.fallback ?? '');
      })
      .catch(() => {});
  }, [tab]);

  /** 排版、朗读、快捷键都在 localStorage，改了立刻生效 */
  const applyRead = (patch: Partial<ReadSettings>) => {
    const next = { ...read, ...patch };
    setRead(next);
    saveSettings(next);
    applySettings(next);
  };

  /** 书库那几项在数据库，也是改了就落盘——没有「保存」这一步 */
  const put = (key: string, value: string) => void rpc('setting.set', { key, value });

  // 捕获下一个按键当作新绑定
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === 'Escape') { setCapturing(null); return; }
      const next = { ...keys, [capturing]: [e.key] };
      setKeys(next);
      saveKeys(next);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing, keys]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="row settings-head">
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>设置</h2>
          <div className="tabs">
            <button aria-current={tab === 'read'} onClick={() => setTab('read')}>阅读</button>
            <button aria-current={tab === 'library'} onClick={() => setTab('library')}>书库</button>
          </div>
          <span style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: '.78rem' }}>改动即时生效</span>
        </div>

        <div className="settings-body">
        {tab === 'read' ? (
          <>
            {/* **外观和纸色是两件事，界面上也要分开摆。**
                合成一项的时候，选「护眼」连书架都变绿——那不是配色方案，
                那是把两个决定塞进了一个下拉框 */}
            <div className="field">
              <span className="muted">应用外观</span>
              {/* 三档写成一个表，别再抄第三遍 aria-current 那套 */}
              <div className="tabs">
                {([
                  ['light', '亮'],
                  ['dark', '暗'],
                  ['auto', '跟随系统'],
                ] as const).map(([v, label]) => (
                  <button
                    key={v}
                    aria-current={read.appearance === v}
                    onClick={() => applyRead({ appearance: v })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="muted" style={{ fontSize: '.78rem' }}>书架、侧栏、对话框</span>
            </div>

            {/* 阅读器里调的东西在这儿只指路、不放控件：在书架上调字号，屏幕上
                没有一个字会变，留一份控件就是两处改同一件事、其中一处看不见效果。
                ⚠️ **逐个点名，别写「都」**：列出来的每一项都得真在阅读界面里
                （齿轮管排版，朗读弹窗管换引擎），多一个少一个都会把指路变成假话。
                这段的历史（两栏 / 说大话的「都」）在 docs/lessons.md 搜「设置弹窗」。 */}
            <p className="muted" style={{ fontSize: '0.8rem', margin: '0 0 0.7rem' }}>
              正文怎么排——<strong>字号、行距、纸色、字体、繁简、阅读方式、自动滚动</strong>——
              和用哪个朗读引擎，都在阅读界面里边看边调：工具栏的齿轮管排版，
              朗读弹窗管换引擎，改一下整页当场变。这里只管书架外观，
              以及字体和引擎<strong>装了哪些</strong>。
            </p>

            <h3>字体</h3>
            {/* 装字体。**应用不下载任何字体**——用户自己把文件装进来，
                装没装、许可允不允许都是他自己的事；**选用哪个**在阅读器齿轮里 */}
            <div className="row" style={{ marginBottom: '.5rem', flexWrap: 'wrap' }}>
              <button
                onClick={() => void (async () => {
                  const path = await rpc<string | null>('ui.pickFont');
                  if (!path) return;
                  try {
                    await rpc('font.add', { path });
                    const list = await rpc<FontFile[]>('font.list');
                    setFonts(list);
                    applyFontFaces(list);
                    setFontMsg(null);
                  } catch (e) {
                    setFontMsg((e as Error).message);
                  }
                })()}
              >
                装一个字体…
              </button>
              {fonts.map((f) => (
                <button
                  key={f.name}
                  title={`卸掉 ${f.name}`}
                  onClick={() => void (async () => {
                    await rpc('font.remove', { name: f.name });
                    const list = await rpc<FontFile[]>('font.list');
                    setFonts(list);
                    applyFontFaces(list);
                    // 正在用的那个被卸了就退回跟随界面，否则正文会掉回默认字体而没人说一声
                    if (read.font === `"${f.name}"`) applyRead({ font: '' });
                  })()}
                >
                  {f.name} ×
                </button>
              ))}
            </div>
            {/* 说明压到两行。原来五行——一屏设置里最长的一段，而它讲的是
                「选哪个字体」这种看一次就够的事 */}
            <p className="muted" style={{ fontSize: '.78rem', margin: '0 0 .6rem' }}>
              支持 ttf / otf / woff / woff2，会复制进书斋自己的文件夹，原文件删了也不影响。
              <br />
              长时间读<strong>黑体比楷体稳</strong>：笔画粗细均匀，屏幕上不发虚。
            </p>
            {fontMsg && <p className="danger" style={{ fontSize: '.8rem', margin: '0 0 .5rem' }}>{fontMsg}</p>}

            {/* 朗读引擎。**管理在这儿，挑用在阅读器的设置浮层里**——同字体那一段：
                「装哪些」看一次就够，「用哪个」要一边听一边换。

                ⚠️ 这一段的存在本身就是那条决定：**应用不预置任何在线引擎**。
                用户的原话是「有些设置是私人化的，可能不方便分享，比如 tts 源」。 */}
            {/* 导一张纸进来。**内置那 10 张里有 6 张就是这么转出来的**
                （发布前跑 `convertTheme` 生成 `builtin-themes.ts`），
                而用户一直没有这条路——「能读不能建」，同标签那个死循环。 */}
            <h3>纸色</h3>
            <div className="row" style={{ marginBottom: '.5rem', flexWrap: 'wrap' }}>
              <button
                onClick={() => void (async () => {
                  const path = await rpc<string | null>('ui.pickThemeFile');
                  if (!path) return;
                  try {
                    const r = await rpc<{ themes: ImportedTheme[]; skipped: number }>(
                      'theme.importFile', { path },
                    );
                    const 原有 = loadImportedThemes();
                    const 进来的 = r.themes.filter((t) => !原有.some((x) => x.id === t.id));
                    saveImportedThemes([...原有, ...进来的]);
                    setPapers(loadImportedThemes().filter((t) => t.id.startsWith('imported-')));
                    const 话 = [`导进来 ${进来的.length} 张`];
                    if (r.themes.length - 进来的.length) 话.push(`${r.themes.length - 进来的.length} 张本来就有`);
                    if (r.skipped) 话.push(`${r.skipped} 张没认出来`);
                    setPaperMsg(话.join('，') + '。在阅读器的设置浮层里选它');
                  } catch (e) {
                    setPaperMsg((e as Error).message);
                  }
                })()}
              >
                导入纸色…
              </button>
              {papers.map((t) => (
                <button
                  key={t.id}
                  title={`删掉 ${t.name}`}
                  onClick={() => {
                    saveImportedThemes(loadImportedThemes().filter((x) => x.id !== t.id));
                    setPapers(loadImportedThemes().filter((x) => x.id.startsWith('imported-')));
                    // 正在用的那张被删了就退回第一张，同卸字体、删朗读引擎那两处：
                    // 不退的话正文会掉回一个不存在的纸色而没人说一声
                    if (read.theme === t.id) applyRead({ theme: BUNDLED_THEMES[0].id });
                    setPaperMsg(null);
                  }}
                >
                  {t.name} ×
                </button>
              ))}
            </div>
            <p className="muted" style={{ fontSize: '.78rem', margin: '0 0 .6rem' }}>
              能导入 legado「阅读」导出的主题文件——<strong>随应用发布的 10 张里有 6 张就是这么转的</strong>。
              <br />
              导入的纸色和你在阅读器里调过的颜色<strong>都跟着备份走</strong>，换台机器恢复一下就回来。
            </p>
            {paperMsg && <p className="muted" style={{ fontSize: '.8rem', margin: '0 0 .5rem' }}>{paperMsg}</p>}

            <h3>朗读引擎</h3>
            <TtsEngines read={read} applyRead={applyRead} />

            <h3>快捷键</h3>
            <table>
              <tbody>
                {(Object.keys(ACTION_NAMES) as Action[]).map((a) => (
                  <tr key={a}>
                    <td style={{ fontSize: '.85rem' }}>{ACTION_NAMES[a]}</td>
                    <td style={{ fontSize: '.82rem' }}>
                      <code>{keys[a].map(keyLabel).join(' / ')}</code>
                    </td>
                    <td style={{ width: '7rem' }}>
                      <button
                        className="mini"
                        onClick={() => setCapturing(capturing === a ? null : a)}
                      >
                        {capturing === a ? '按一个键…' : '改'}
                      </button>
                      <button
                        className="mini"
                        onClick={() => {
                          const next = { ...keys, [a]: DEFAULT_KEYS[a] };
                          setKeys(next);
                          saveKeys(next);
                        }}
                      >
                        还原
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="field">
              <span className="muted">老板键</span>
              <input
                value={bossKey}
                onChange={(e) => { setBossKey(e.target.value); put('reader.bossKey', e.target.value); }}
                style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}
                title="全局生效，按一下藏窗口、再按一下叫回来。重启应用后生效；被别的软件占用时会注册失败，不影响其它功能"
              />
            </div>
          </>
        ) : (
          <>
            <h3>扫描入库</h3>
            {/*
              * **收录下限。** 真实案例：一个装短文合集的目录，55 个 txt 里 27 个
              * 在 3–8 KB 之间，一扫全被 10 KB 那条线挡在外面——而 pdf 一个不少地进来了，
              * 症状看着完全不像「有条大小限制」。
              *
              * 单位用 KB 不用字节：10240 不是人话（同阅读设置里「顶部留白不摆 rem」那条）。
              * 存进库的仍然是字节。
              */}
            <div className="field">
              <span className="muted">最小的书</span>
              <span className="row" style={{ gap: '.35rem' }}>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={minKb}
                  style={{ width: '5rem' }}
                  aria-label="小于多少 KB 的文件不收"
                  onChange={(e) => setMinKb(e.target.value)}
                  onBlur={() => {
                    /*
                     * **失焦才落库**，不是每敲一个数字存一次：中间态（空串、光一个「1」）
                     * 存进去就是一条错的下限，而下一次扫描会照着它办。
                     * 空着或者填了非数字就退回默认，并且把框里也纠回来——
                     * 界面上留一个存不进去的值，比拒绝更让人摸不着头脑。
                     */
                    const n = Number(minKb);
                    const 字节 = minKb.trim() !== '' && Number.isFinite(n) && n >= 0
                      ? Math.floor(n * 1024)
                      : MIN_BYTES_DEFAULT;
                    setMinKb(String(Math.round(字节 / 1024)));
                    put(MIN_BYTES_KEY, String(字节));
                  }}
                />
                <span className="muted" style={{ fontSize: '.82rem' }}>KB 以下不收</span>
              </span>
            </div>
            <p className="muted" style={{ fontSize: '.8rem', margin: '.1rem 0 .5rem' }}>
              小说目录里常有「说明.txt」「广告.txt」这类零碎，默认 10 KB 把它们挡在外面。
              装的是短文合集就调小，<strong>填 0 是全都收</strong>。
              改完要<strong>重新扫描一次</strong>才会把之前跳过的收进来。
            </p>

            <div className="field">
              <span className="muted">定期扫描</span>
              <select
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                  put('scan.mode', e.target.value);
                  void window.novel.reschedule();
                }}
              >
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              {mode === 'interval' && (
                <>
                  <input
                    type="number" min={1} value={hours}
                    onChange={(e) => {
                      setHours(e.target.value);
                      put('scan.intervalHours', e.target.value);
                      void window.novel.reschedule();
                    }}
                    style={{ width: '4.5rem' }}
                  />
                  <span className="muted">小时</span>
                </>
              )}
              {mode === 'daily' && (
                <input
                  type="time" value={time}
                  onChange={(e) => {
                    setTime(e.target.value);
                    put('scan.dailyTime', e.target.value);
                    void window.novel.reschedule();
                  }}
                />
              )}
            </div>

            <label className="row" style={{ gap: '.4rem', fontSize: '.87rem', marginTop: '.5rem' }}>
              <input
                type="checkbox" checked={watchOn}
                onChange={(e) => { setWatchOn(e.target.checked); put('scan.watch', e.target.checked ? '1' : '0'); }}
              />
              <span title="文件变动后等 5 秒再扫，避开写到一半的文件。文件夹里文件多时事件会很密，觉得吵就关掉——定期扫描一样能发现变化">
                实时监听文件夹变动（追更后自动重新解析）
              </span>
            </label>

            <h3>评价</h3>
            <label className="row" style={{ gap: '.4rem', fontSize: '.87rem' }}>
              <input
                type="checkbox" checked={showRating}
                onChange={(e) => { setShowRating(e.target.checked); saveShowRating(e.target.checked); }}
              />
              <span>用评分（★）</span>
            </label>
            {/*
              * 说清**关掉之后哪几处会变**，以及**数据不会丢**。
              * 后半句是必须的：一个看起来会毁数据的开关，用户不敢点。
              */}
            {/*
              * ⚠️ **这段话原来还写着「按星级筛的那排开关也一起收起来」，而那排开关
              * 已经不在了**——按评分筛降级成了分类里的一个字段。**界面上撤掉一样东西，
              * 要顺手搜一遍还有谁在提它**；一句描述不存在的东西的说明，
              * 比没有说明更让人找不着北。
              *
              * 也顺手收短了：四处枚举读起来像文档。用户在这一刻只需要知道两件事——
              * 星星会不见，分不会丢。后半句是必须的：一个看起来会毁数据的开关，用户不敢点。
              */}
            <p className="muted" style={{ fontSize: '.8rem', marginTop: '.2rem' }}>
              关掉后书架上不显示 ★：封面角标、搜索结果里的那一列都会收起来。
              点「评价」时五颗星照旧在，<strong>已经打过的分一个都不会丢</strong>。
            </p>

            <h3>改动磁盘文件</h3>
            <label className="row" style={{ gap: '.4rem', fontSize: '.87rem' }}>
              <input
                type="checkbox" checked={renameOn}
                onChange={(e) => { setRenameOn(e.target.checked); put('rename.enabled', e.target.checked ? '1' : '0'); }}
              />
              <span>允许改文件名、允许删除重复文件</span>
            </label>
            {/* 这段必须留全文——它说明的是「程序在什么情况下会动你的磁盘」，
                是这个应用唯一会造成不可逆后果的地方 */}
            <p className="warn-line">
              关掉之后两者被<strong>彻底禁用</strong>，不只是界面上藏起来，外部接口调用也会被拒绝。
              删除<strong>一律移入系统回收站</strong>，而且只删「磁盘上确实还有这本书的另一个文件」的那些。
              除此之外程序不会删除或移动你的任何文件。
            </p>

            <CoverSources />

            <h3>按文件夹设连载状态</h3>
            <p className="muted" style={{ fontSize: '0.82rem', margin: '0 0 .4rem' }}>
              书库本来就按状态分文件夹放，这里把那个信息接进来：以后扫描到的新书
              自动按这套规则补状态，<strong>但不覆盖你手动改过的书</strong>。
              <br />
              <strong>文件夹名你自己定</strong>——没在下面点过的走「其余文件夹」那一档。
            </p>
            <label className="row" style={{ gap: '.4rem', fontSize: '.87rem', marginBottom: '.3rem' }}>
              <span style={{ minWidth: '7rem' }}>其余文件夹</span>
              <select
                value={serialFallback}
                onChange={(e) => { setSerialFallback(e.target.value); void saveSerial(serialRules, e.target.value); }}
              >
                <option value="">不改（保持原样）</option>
                {SERIAL.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            {dirs.filter((d) => d.depth === 1).map((d) => (
              <label key={d.dir} className="row" style={{ gap: '.4rem', fontSize: '.87rem', marginBottom: '.3rem' }}>
                <span style={{ minWidth: '7rem' }}>{d.dir} <span className="muted">{d.total}</span></span>
                <select
                  value={serialRules.find((r) => r.dir === d.dir)?.status ?? ''}
                  onChange={(e) => {
                    const next = serialRules.filter((r) => r.dir !== d.dir);
                    if (e.target.value) next.push({ dir: d.dir, status: e.target.value });
                    setSerialRules(next);
                    void saveSerial(next, serialFallback);
                  }}
                >
                  <option value="">跟随「其余文件夹」</option>
                  {SERIAL.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            ))}
            <div className="row" style={{ marginTop: '.4rem' }}>
              <button
                onClick={() => void (async () => {
                  // 先干跑一次摆出来给人看：这是八千本的改动，别点一下就默默改完
                  const r = await rpc<{ changed: number; byStatus: Record<string, number> }>(
                    'library.applySerial',
                    { rules: serialRules, fallback: serialFallback || null, dryRun: true },
                  );
                  if (r.changed === 0) { setSerialMsg('按现在的规则没有书需要改'); return; }
                  const bits = Object.entries(r.byStatus)
                    .map(([k, n]) => `${SERIAL.find((s) => s.id === k)?.name ?? k} ${n} 本`);
                  setSerialPreview(`会改 ${r.changed} 本：${bits.join('、')}`);
                })()}
              >
                看看会改哪些
              </button>
              {serialPreview && (
                <button
                  className="primary"
                  onClick={() => void (async () => {
                    const r = await rpc<{ changed: number; byStatus: Record<string, number> }>('library.applySerial', {
                      rules: serialRules, fallback: serialFallback || null,
                    });
                    setSerialPreview(null);
                    setSerialMsg(`已设置 ${r.changed} 本`);
                  })()}
                >
                  确认应用
                </button>
              )}
              {serialPreview && <span style={{ color: 'var(--accent)', fontSize: '.85rem' }}>{serialPreview}</span>}
              {serialMsg && <span style={{ color: 'var(--accent)', fontSize: '.85rem' }}>{serialMsg}</span>}
            </div>

            <h3>整理数据库</h3>
            <p className="muted" style={{ fontSize: '0.82rem', margin: '0 0 .4rem' }}>
              清掉扫描修不好的残留记录（空书、缺主版本、文件其实还在别处的「文件缺失」、
              移走文件夹后的孤儿），<strong>只动记录，不碰磁盘文件</strong>。
              你在应用外自己删掉的文件不算残留——去侧栏「需要处理」档
              点「批量清理失效文件」，那种记录这儿清不掉。
            </p>
            <div className="row">
              <button
                onClick={() => void (async () => {
                  // **类型从 core 引，别在这儿手抄一份。** 抄的那份漏了
                  // `wronglyMissing`，于是只修好那一类的那一轮报的是
                  // 「没有发现需要整理的记录」——而它刚改了 N 条。
                  // 引过来之后，core 再加字段这里就会编译不过，而不是安静地少报一项
                  const r = await rpc<RepairReport>('library.repair');
                  const bits = [
                    r.orphanBooks && `空书 ${r.orphanBooks}`,
                    r.missingPrimary && `补主版本 ${r.missingPrimary}`,
                    r.staleMissing && `残留的「缺失」记录 ${r.staleMissing}`,
                    r.rootlessGone && `孤儿记录 ${r.rootlessGone}`,
                    // **这一项原来漏了。** `RepairReport` 有 5 个字段，这里只列了 4 个，
                    // 于是只修好这一类的那一轮，用户看到的是「没有发现需要整理的记录」
                    // ——一句错话，而它刚改了 N 条
                    r.wronglyMissing && `其实文件还在的 ${r.wronglyMissing}`,
                  ].filter(Boolean);
                  setRepairMsg(bits.length ? `已清理：${bits.join('、')}` : '没有发现需要整理的记录');
                })()}
              >
                整理一次
              </button>
              {repairMsg && <span style={{ color: 'var(--accent)', fontSize: '.85rem' }}>{repairMsg}</span>}
            </div>

            <h3>联网补全</h3>
            <label className="row" style={{ gap: '.4rem', fontSize: '.87rem' }}>
              {/* 绑 autofetch（用户那个开关），不是 running：自动暂停让路、队列跑完时
                  running 都会是 false 而开关仍开着，绑它会让勾选框视觉上自己取消 */}
              <input
                type="checkbox"
                checked={cover?.autofetch ?? false}
                onChange={(e) => 封面操作(e.target.checked ? 'cover.fetchStart' : 'cover.fetchStop')}
              />
              <span>批量联网找书：在线地址、封面、简介、分类一起补（可选，默认不开）</span>
            </label>
            {/* 开关绑的是意图，所以「开着但没在跑」得说出来，不然看着像卡住了 */}
            {cover?.autofetch && !cover.running && !cover.pausedReason && (
              <p className="muted" style={{ fontSize: '0.82rem', margin: '.2rem 0 0' }}>
                {cover.pending === 0
                  ? '开关开着，待补全的都跑完了——之后扫进新书会自动接着抓'
                  : '开关开着，此刻没有在跑：你在用应用时它会自动让路，切走几秒接着跑'}
              </p>
            )}
            {/* 隐私这句必须留全文：联网补全会把书名和作者发出去。
                默认走「点一本补一本」（书籍编辑器里的「联网补全」），
                这里是给不想一本本点的人准备的批量任务 */}
            <p className="warn-line">
              平时用<strong>书籍编辑器里的「联网补全」</strong>，点一本补一本；这个开关是批量，
              把没补过的书都跑一遍：记下过地址的直接读那一页，没地址的按书名搜。
              会把<strong>书名和作者</strong>发到搜索源，除此之外不发任何数据；
              搜索结果只有书名、作者都精确一致才采用——宁可没有，不能配错。
              <br />
              {/* 这条不是客套：抓一本要在隐藏窗口里真的渲染一遍对面的页面，
                  实测能让书架从 1.9 秒变成 40 秒。让路是自动的，但得让人知道，
                  否则「开着开关却看到剩余数不动」会被当成坏了 */}
              <strong>你在用应用时它自动停下让路</strong>，切走几秒后接着跑；
              不让路的话，补全期间整个界面会明显变慢。
            </p>
            {cover && (
              <p className="muted" style={{ fontSize: '0.82rem', margin: '.2rem 0 .4rem' }}>
                已补全 {cover.done} · 剩余 {cover.pending} · 没找到 {cover.nomatch}
                {cover.failed > 0 && ` · 失败 ${cover.failed}`}
                {/* 速率是自适应的（撞限流翻倍、顺利跑一段减半）。不显示的话，
                    回填慢到一分钟一本时用户只会觉得「卡住了」，看不出是在自己让路 */}
                {cover.gapMs > 3000 && ` · 每本间隔 ${cover.gapMs / 1000} 秒（撞过限流，会自己提回来）`}
                {/* 原因说的是「上次为什么停」，必须带上时间和「会自动重试」，
                    不然限流早解除了，这句话还挂着像在报现在的故障 */}
                {cover.pausedReason && (
                  <span className="danger">
                    　{cover.pausedReason}
                    {cover.pausedAt && `（${relTime(cover.pausedAt)}暂停，稍后自动重试，恢复后接着跑）`}
                  </span>
                )}
              </p>
            )}
            {/* 挂着的时候给个人工出口；不等两分钟一次的探针 */}
            {cover?.pausedReason && (
              <button onClick={() => 封面操作('cover.fetchStart')}>立即继续</button>
            )}
            {/* 只提 nomatch：failed 已经由 `start()` 自动清回队列，不用人点。
                按钮上的数字也得跟着，不然点完发现少了几本，看起来像没生效 */}
            {cover && cover.nomatch > 0 && (
              <button
                onClick={() => 封面操作('cover.retryMisses')}
              >
                重试没找到的 {cover.nomatch} 本
              </button>
            )}
            {/* 源必然会坏（改版、限流、下架），而坏了在这儿只表现为「命中率悄悄往下掉」。
                不给个能主动查的入口，等发现时错误结论已经写进库几百条了 */}
            <button
              disabled={checking}
              style={{ marginLeft: '.4rem' }}
              onClick={() => void (async () => {
                setChecking(true);
                try {
                  setSrcCheck(await rpc('cover.checkSources'));
                  setCoverErr(null);
                } catch (err) {
                  setCoverErr(err instanceof Error ? err.message : String(err));
                } finally {
                  setChecking(false);
                }
              })()}
            >
              {checking ? '正在检查…' : '检查三个源'}
            </button>
            {srcCheck && (
              <p className="muted" style={{ fontSize: '0.82rem', margin: '.4rem 0 0' }}>
                {srcCheck.map((s) => (
                  <span key={s.label} style={{ marginRight: '.8rem' }} title={s.note}>
                    {s.ok ? '✓' : '✗'} {s.label}
                    {!s.ok && <span className="danger"> {s.note}</span>}
                  </span>
                ))}
              </p>
            )}
            {coverErr && <span className="danger">　{coverErr}</span>}
          </>
        )}
        </div>

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
