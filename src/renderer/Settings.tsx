// 设置（spec §6 等）。
//
// 这个弹窗一度长到 428 行、六段全塞在一个滚动条里，而且**保存语义是混的**：
// 排版和朗读改了立即生效，扫描设置却要点「保存」——同一个弹窗里两套规矩，
// 用户改完排版看见「保存」按钮，不点心里没底，点了又不知道刚才改的算不算数。
//
// 重做的四条：
//
// 1. **分页，而且按「什么时候会动它」分**：一开始是两页，可「书库」那一页
//    量出来内容 1382px、可视 498px——**要滚 884px（1.8 屏）才走完 7 个区**，
//    而「阅读」那页只有 981px。现在是四页：
//    `阅读`（书架外观 + 字体 + 纸色 + 朗读引擎）· `键盘`（快捷键表 + 老板键）·
//    `书库`（扫描 + 评价 + 磁盘开关 + 连载规则 + 整理）· `联网`（自定义书源 + 批量补全）。
//    切页不动机制：还是那排 `.tabs` + `aria-current`。
// 2. **全部即时生效，没有保存按钮。** 少一个概念。写库的那几项改一下就落一次盘，
//    反正都是单个键值，代价可以忽略。
//    ⚠️ 这一条**曾经有两句假话**：老板键和实时监听改完都不当场生效
//    （一个只在启动时注册、一个只在 reschedule 时才重起监听），而头栏写着
//    「改动即时生效」。现在两处都走同一条 `applyLiveSettings`——
//    理由和读数都在 `docs/lessons.md`「设置里那句即时生效」那一节。
// 3. **说明只留会导致数据事故的那几句**。原来每个开关下面挂三四行解释，
//    读完一屏才知道有几个选项。真正必须说的只有两处：重命名/删除那个总开关，
//    和在线朗读会把正文发到第三方。其余移进 title 里——
//    ⚠️ **但「这一格改了要重启」这种话不许只放 title**：那正是假话的藏身处。
//    低频的长说明收进 `<details>`，`<summary>` 上留结论。
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
import { etaWords, relTime } from '../core/format.ts';
import { CoverSources } from './CoverSources.tsx';
import { TtsEngines } from './TtsEngines.tsx';
import {
  ACTION_NAMES, DEFAULT_KEYS, loadKeys, saveKeys, loadSettings, saveSettings, acceleratorLabel,
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

/**
 * 「整理数据库」那一串报数。**预览和落库共用这一份**——两处说的数必须是同一个数，
 * 而 `RepairReport` 加字段时这里会编译不过，而不是安静地少报一项
 * （原来那份就漏过 `wronglyMissing`，于是它刚改了 N 条、屏上却说「没有发现需要整理的记录」）。
 */
function 整理报数(r: RepairReport): string {
  const 段 = [
    r.orphanBooks && `没有文件的空记录 ${r.orphanBooks} 条`,
    r.missingPrimary && `定下用哪一份的 ${r.missingPrimary} 本`,
    r.staleMissing && `内容还在别处的「缺失」${r.staleMissing} 条`,
    r.rootlessGone && `书库文件夹已移走的 ${r.rootlessGone} 条`,
    r.wronglyMissing && `其实文件还在、改回正常的 ${r.wronglyMissing} 条`,
  ].filter(Boolean);
  return 段.length ? 段.join('、') : '没有需要整理的记录';
}

type Tab = 'read' | 'keys' | 'library' | 'net';

/** 四个页签装什么。切法按「什么时候会动它」，不按代码模块 */
const TABS: Array<{ id: Tab; 名: string }> = [
  { id: 'read', 名: '阅读' },
  { id: 'keys', 名: '键盘' },
  { id: 'library', 名: '书库' },
  { id: 'net', 名: '联网' },
];

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
  /** 「看看会整理哪些」摆出来的那句话；摆出来之后才出现「确认整理」 */
  const [repairPreview, setRepairPreview] = useState<string | null>(null);
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
  /** 一句反馈。`坏` 决定它是红字还是灰字——报错和通报不能长得一样 */
  const [fontMsg, setFontMsg] = useState<{ 话: string; 坏?: boolean } | null>(null);
  // 只列**从文件导进来的**那些（`convertTheme` 生成的 id 都以 imported- 开头）。
  // 调过色的那几张不列——它们借用内置的 id，撤销走的是阅读器里那个「恢复默认」
  const [papers, setPapers] = useState<ImportedTheme[]>(
    () => loadImportedThemes().filter((t) => t.id.startsWith('imported-')),
  );
  const [paperMsg, setPaperMsg] = useState<{ 话: string; 坏?: boolean } | null>(null);
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

  /**
   * 凡是要主进程重新应用一遍的设置（排程 / 文件监听 / 老板键）都叫这一声。
   *
   * 只留这一个出口，是因为「哪一栏改完该调哪条」这张表**迟早会漏一行**——
   * 漏掉的就是老板键和实时监听那两处，而屏上当时写着「改动即时生效」。
   * 老板键注册成没成从返回值带回来：占了要当场说，不能只 `console.warn` 在终端里。
   */
  const [bossKeyOk, setBossKeyOk] = useState<boolean | null>(null);
  const 应用设置 = () => void (async () => {
    try {
      const r = await window.novel.applyLiveSettings() as { bossKeyOk?: boolean } | undefined;
      setBossKeyOk(r?.bossKeyOk !== false);
    } catch { setBossKeyOk(null); }
  })();

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
            {TABS.map((t) => (
              <button key={t.id} aria-current={tab === t.id} onClick={() => setTab(t.id)}>{t.名}</button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: '0.78rem' }}>改动即时生效</span>
        </div>

        <div className="settings-body">
        {tab === 'read' ? (
          <>
            {/* **外观和纸色是两件事，界面上也要分开摆。**
                合成一项的时候，选「护眼」连书架都变绿——那不是配色方案，
                那是把两个决定塞进了一个下拉框 */}
            <div className="field">
              <span className="muted" id="set-appearance">应用外观</span>
              {/* 三档写成一个表，别再抄第三遍 aria-current 那套。
                  ⚠️ `role="group"` + `aria-labelledby`：这一排三颗键的可及名是
                  「亮 / 暗 / 跟随系统」，光念这三个字听不出**这是在问什么**——
                  组名接上那个看得见的标题，读屏才念出「应用外观 群组」。
                  （没做成 fieldset/legend：`.field` 的排版规则盯的是
                  `> .muted:first-child`，legend 当 flex 项各浏览器不一致。） */}
              <div className="tabs" role="group" aria-labelledby="set-appearance">
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
              <span className="muted" style={{ fontSize: '0.78rem' }}>书架、侧栏、对话框</span>
            </div>

            {/* 阅读器里调的东西在这儿只指路、不放控件：在书架上调字号，屏幕上
                没有一个字会变，留一份控件就是两处改同一件事、其中一处看不见效果。
                ⚠️ **逐个点名，别写「都」**：列出来的每一项都得真在阅读界面里
                （齿轮管排版，朗读弹窗管换引擎），多一个少一个都会把指路变成假话。
                这段的历史（两栏 / 说大话的「都」）在 docs/lessons.md 搜「设置弹窗」。 */}
            {/* ⚠️ 这句原来写的是「这里只管书架外观，以及字体和引擎装了哪些」——
                漏了纸色，而它是这一页唯一一句「这页管什么」。改成实话：
                这一页管**装了哪些**，用哪个不归这里管。
                两行之间用 `<br />` 而不是换行续写：JSX 会把两行文本用一个空格
                连起来，中文句子里凭空多一道缝（`scripts/cjk-join.mjs` 盯的就是它）。 */}
            <p className="muted" style={{ fontSize: '0.8rem', margin: '0 0 0.7rem' }}>
              这一页管的是<strong>装了哪些</strong>：书架外观、字体、纸色、朗读引擎。
              <br />
              <strong>用哪一个</strong>——字号、行距、纸色选哪张、繁简、自动滚动、换哪个引擎念——都在阅读界面里边看边调：齿轮管排版，朗读弹窗管换引擎，改一下整页当场变。
            </p>

            <h3>字体</h3>
            {/* 装字体。**应用不下载任何字体**——用户自己把文件装进来，
                装没装、许可允不允许都是他自己的事；**选用哪个**在阅读器齿轮里 */}
            <div className="row" style={{ marginBottom: '.5rem' }}>
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
                    setFontMsg({ 话: (e as Error).message, 坏: true });
                  }
                })()}
              >
                加一个字体…
              </button>
            </div>
            {/* 原来是一排 chip、点名字就把这个字体删了——同一个弹窗里的朗读引擎
                已经为这个形状改过一轮（「找不着也不敢点」）。跟着那一份走：
                名字是名字，删是写着「删掉」的那颗键，键上带名字。 */}
            {fonts.length > 0 && (
              <div className="item-list">
                {fonts.map((f) => (
                  <div className="item-row" key={f.name}>
                    <span className="item-name" title={f.file}>{f.name}</span>
                    {f.bundled && <span className="chip-n" title="随应用一起发布的那份，删不掉">随应用</span>}
                    <span className="muted" style={{ fontSize: '.78rem' }}>{Math.round(f.size / 1024)} KB</span>
                    <button
                      className="mini"
                      aria-label={`删掉字体 ${f.name}`}
                      title={`删掉 ${f.name}`}
                      onClick={() => void (async () => {
                        await rpc('font.remove', { name: f.name });
                        const list = await rpc<FontFile[]>('font.list');
                        setFonts(list);
                        applyFontFaces(list);
                        // 正在用的那个被删了就退回跟随界面，否则正文会掉回默认字体而没人说一声
                        if (read.font === `"${f.name}"`) applyRead({ font: '' });
                        setFontMsg({ 话: `「${f.name}」删掉了` });
                      })()}
                    >
                      删掉
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* 说明压到两行。原来五行——一屏设置里最长的一段，而它讲的是
                「选哪个字体」这种看一次就够的事 */}
            <p className="muted" style={{ fontSize: '0.78rem', margin: '0 0 0.6rem' }}>
              支持 ttf / otf / woff / woff2，会复制进书斋自己的文件夹，原文件删了也不影响。
              <br />
              长时间读<strong>黑体比楷体稳</strong>：笔画粗细均匀，屏幕上不发虚。
            </p>
            {fontMsg && (
              <p className={fontMsg.坏 ? 'danger' : 'muted'} style={{ fontSize: '0.8rem', margin: '0 0 0.5rem' }}>
                {fontMsg.话}
              </p>
            )}

            {/* 朗读引擎。**管理在这儿，挑用在阅读器的设置浮层里**——同字体那一段：
                「装哪些」看一次就够，「用哪个」要一边听一边换。

                ⚠️ 这一段的存在本身就是那条决定：**应用不预置任何在线引擎**。
                用户的原话是「有些设置是私人化的，可能不方便分享，比如 tts 源」。 */}
            {/* 导一张纸进来。**内置那 10 张里有 6 张就是这么转出来的**
                （发布前跑 `convertTheme` 生成 `builtin-themes.ts`），
                而用户一直没有这条路——「能读不能建」，同标签那个死循环。 */}
            <h3>纸色</h3>
            <div className="row" style={{ marginBottom: '.5rem' }}>
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
                    setPaperMsg({ 话: 话.join('，') + '。在阅读器的设置浮层里选它' });
                  } catch (e) {
                    setPaperMsg({ 话: (e as Error).message, 坏: true });
                  }
                })()}
              >
                加一个纸色…
              </button>
            </div>
            {/* 同字体那一排：名字是名字，删是那颗写着「删掉」的键 */}
            {papers.length > 0 && (
              <div className="item-list">
                {papers.map((t) => (
                  <div className="item-row" key={t.id}>
                    <span className="item-name" title={t.name}>{t.name}</span>
                    <button
                      className="mini"
                      aria-label={`删掉纸色 ${t.name}`}
                      title={`删掉 ${t.name}`}
                      onClick={() => {
                        saveImportedThemes(loadImportedThemes().filter((x) => x.id !== t.id));
                        setPapers(loadImportedThemes().filter((x) => x.id.startsWith('imported-')));
                        // 正在用的那张被删了就退回第一张，同删字体、删朗读引擎那两处：
                        // 不退的话正文会掉回一个不存在的纸色而没人说一声
                        if (read.theme === t.id) applyRead({ theme: BUNDLED_THEMES[0].id });
                        setPaperMsg({ 话: `「${t.name}」删掉了` });
                      }}
                    >
                      删掉
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="muted" style={{ fontSize: '0.78rem', margin: '0 0 0.6rem' }}>
              能导入 legado「阅读」导出的主题文件——<strong>随应用发布的 10 张里有 6 张就是这么转的</strong>。
              <br />
              导入的纸色和你在阅读器里调过的颜色<strong>都跟着备份走</strong>，换台机器恢复一下就回来。
            </p>
            {paperMsg && (
              <p className={paperMsg.坏 ? 'danger' : 'muted'} style={{ fontSize: '0.8rem', margin: '0 0 0.5rem' }}>
                {paperMsg.话}
              </p>
            )}

            <h3>朗读引擎</h3>
            <TtsEngines read={read} applyRead={applyRead} />

          </>
        ) : (tab === 'keys' ? (
          <>
            <h3>快捷键</h3>
            {/*
             * 这张表原来只有 `tbody`：读屏走到那两颗单字键时既不知道是**哪一行**
             * 也不知道是**哪一列**，七行听起来一模一样。行头给动作名（`scope="row"`）、
             * 列头给三列，两颗键各自带名字。
             */}
            <table className="hotkeys">
              <thead>
                <tr>
                  <th scope="col">动作</th>
                  <th scope="col">现在的键</th>
                  <th scope="col">改绑</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(ACTION_NAMES) as Action[]).map((a) => (
                  <tr key={a}>
                    <th scope="row" style={{ fontSize: '0.85rem' }}>{ACTION_NAMES[a]}</th>
                    <td style={{ fontSize: '0.82rem' }}>
                      <code>{keys[a].map(keyLabel).join(' / ')}</code>
                    </td>
                    <td style={{ width: '7rem' }}>
                      <button
                        className="mini"
                        aria-label={`改「${ACTION_NAMES[a]}」的键`}
                        title={`点一下，再按一个新键`}
                        onClick={() => setCapturing(capturing === a ? null : a)}
                      >
                        {capturing === a ? '按一个键…' : '改'}
                      </button>
                      <button
                        className="mini"
                        aria-label={`把「${ACTION_NAMES[a]}」还原成默认的键`}
                        title="还原成默认的键"
                        // 「改」和「还原」原来边贴边（缝 4px、键只有 24px 高），
                        // 而这两个动作的后果完全相反：一个是开始录键，一个是立刻改掉绑定
                        style={{ marginLeft: '.35rem' }}
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
            {/* Esc 取消早就实现了，屏上第一次写出来；「只记单个键」也是真的——
                录键那里收的是 `e.key` 一个值，按 Ctrl+T 只会记下 t */}
            <p className="muted" style={{ fontSize: '.78rem', margin: '.35rem 0 0' }}>
              {capturing
                ? `正在录「${ACTION_NAMES[capturing]}」：按一个新键记下，Esc 取消。`
                : '「改」是点一下再按一个新键；这里只记单个键，不带 Ctrl / Shift。'}
            </p>

            <div className="field">
              <span className="muted" id="set-boss">老板键</span>
              <input
                value={bossKey}
                aria-labelledby="set-boss"
                onChange={(e) => { setBossKey(e.target.value); put('reader.bossKey', e.target.value); 应用设置(); }}
                style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}
                title="全局生效，按一下藏窗口、再按一下叫回来"
              />
            </div>
            {/*
             * 输入框里那串是**注册用的原值**（`CommandOrControl+Shift+H`），
             * 改存的内容就注册不上了；可屏上只摆这串，Windows 用户看到的是
             * 一个键帽上不存在的名字。所以另起一行说「这台机器上按什么」。
             * 「要重启才认」那句原来挂在 title 里、和头栏「改动即时生效」互相打脸，
             * 现在主进程改完就重注册，那句话跟着删了（注册失败改成屏上报）。
             */}
            <p className="muted" style={{ margin: '.2rem 0 0', fontSize: '.78rem' }}>
              这台机器上按 <strong>{acceleratorLabel(bossKey) || '（还没填）'}</strong>，改了就重新注册
            </p>
            {bossKeyOk === false && (
              <p className="warn-line">
                这个组合键没注册上——多半被别的程序占了。换个组合键试试；藏窗口以外的功能都不受影响。
              </p>
            )}
          </>
        ) : (tab === 'library' ? (
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
                <span className="muted" style={{ fontSize: '0.82rem' }}>KB 以下不收</span>
              </span>
            </div>
            <p className="muted" style={{ fontSize: '0.8rem', margin: '0.1rem 0 0.5rem' }}>
              小说目录里常有「说明.txt」「广告.txt」这类零碎，默认 10 KB 把它们挡在外面。装的是短文合集就调小，<strong>填 0 是全都收</strong>。改完要<strong>重新扫描一次</strong>才会把之前跳过的收进来。
            </p>

            <div className="field">
              <span className="muted">定期扫描</span>
              <select
                // 这一排的标题是 `<span className="muted">`，不是 <label>——
                // 读屏念得出选项，念不出「这是在问什么」。同 `RenameDialog` 那处
                aria-label="定期扫描怎么排"
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                  put('scan.mode', e.target.value);
                  应用设置();
                }}
              >
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              {mode === 'interval' && (
                <>
                  <input
                    type="number" min={1} value={hours}
                    aria-label="每隔多少小时扫一次"
                    onChange={(e) => {
                      setHours(e.target.value);
                      put('scan.intervalHours', e.target.value);
                      应用设置();
                    }}
                    style={{ width: '4.5rem' }}
                  />
                  <span className="muted">小时</span>
                </>
              )}
              {mode === 'daily' && (
                <input
                  type="time" value={time}
                  aria-label="每天几点扫"
                  onChange={(e) => {
                    setTime(e.target.value);
                    put('scan.dailyTime', e.target.value);
                    应用设置();
                  }}
                />
              )}
            </div>

            <label className="row" style={{ gap: '.4rem', fontSize: '0.87rem', marginTop: '.5rem' }}>
              <input
                type="checkbox" checked={watchOn}
                onChange={(e) => {
                  setWatchOn(e.target.checked);
                  put('scan.watch', e.target.checked ? '1' : '0');
                  // ⚠️ 这一声不能省：`startWatching()` 原来只在启动和「定期扫描」改动时跑，
                  // 于是勾上了要等下一次别的改动（或重启）才开始监听——A/B 实测过，
                  // 见 docs/lessons.md「设置里那句即时生效」
                  应用设置();
                }}
              />
              <span title="文件变动后等 5 秒再扫，避开写到一半的文件。文件夹里文件多时事件会很密，觉得吵就关掉——定期扫描一样能发现变化">
                实时监听文件夹变动（追更后自动重新解析）
              </span>
            </label>

            <h3>评价</h3>
            <label className="row" style={{ gap: '.4rem', fontSize: '0.87rem' }}>
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
            <p className="muted" style={{ fontSize: '0.8rem', marginTop: '.2rem' }}>
              关掉后书架上不显示 ★：封面角标、搜索结果里的那一列都会收起来。点「评价」时五颗星照旧在，<strong>已经打过的分一个都不会丢</strong>。
            </p>

            <h3>改动磁盘文件</h3>
            <label className="row" style={{ gap: '.4rem', fontSize: '0.87rem' }}>
              <input
                type="checkbox" checked={renameOn}
                onChange={(e) => { setRenameOn(e.target.checked); put('rename.enabled', e.target.checked ? '1' : '0'); }}
              />
              <span>允许改文件名、允许删除重复文件</span>
            </label>
            {/* 这段必须留全文——它说明的是「程序在什么情况下会动你的磁盘」，
                是这个应用唯一会造成不可逆后果的地方 */}
            <p className="warn-line">
              关掉之后两者被<strong>彻底禁用</strong>，不只是界面上看不见，别的程序也调不动它。删除<strong>一律移入系统回收站</strong>，而且只删「磁盘上确实还有这本书的另一个文件」的那些。除此之外程序不会删除或移动你的任何文件。
            </p>

            <h3>按文件夹设连载状态</h3>
            <p className="muted" style={{ fontSize: '0.82rem', margin: '0 0 0.4rem' }}>
              书库本来就按状态分文件夹放，这里把那个信息接进来：以后扫描到的新书自动按这套规则补状态，<strong>但不覆盖你手动改过的书</strong>。
              <br />
              <strong>文件夹名你自己定</strong>——没在下面点过的走「其余文件夹」那一档。
            </p>
            <label className="row" style={{ gap: '.4rem', fontSize: '0.87rem', marginBottom: '.3rem' }}>
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
              <label key={d.dir} className="row" style={{ gap: '.4rem', fontSize: '0.87rem', marginBottom: '.3rem' }}>
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
              {serialPreview && <span style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>{serialPreview}</span>}
              {serialMsg && <span style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>{serialMsg}</span>}
            </div>

            <h3>整理数据库</h3>
            {/* 那五种名目原来平铺 145 字，占掉这一页小半屏。收进 details，
                **summary 上留的是结论不是名目**：只动记录、不碰磁盘，
                而「应用外删掉的文件」不归这儿管——那半句必须常显，
                不然有人在整理完之后发现它还在，会以为这个键没使。 */}
            <p className="muted" style={{ fontSize: '0.82rem', margin: '0 0 0.2rem' }}>
              <strong>只动记录，不碰磁盘文件。</strong>
              你在应用外自己删掉的文件不算这一类——那种请到侧栏「需要处理」点「批量清理失效文件」，这儿清不掉。
            </p>
            <details style={{ margin: '0 0 0.4rem' }}>
              <summary className="muted" style={{ fontSize: '0.8rem', cursor: 'pointer' }}>
                它清的是哪五种情况
              </summary>
              <p className="muted" style={{ fontSize: '0.8rem', margin: '.3rem 0 0' }}>
                没有文件的空记录、有好几份却没定下用哪份的、标着「文件缺失」而内容其实还在别处的、书库文件夹已经移走的、被屏蔽却误标成「缺失」的。
                <strong>表过态的书不删</strong>——打过分的、写过短评的、记过弃坑原因的、贴过标签的、标过想读的都留着，那些重扫恢复不了。
              </p>
            </details>
            <div className="row">
              <button
                onClick={() => void (async () => {
                  const r = await rpc<RepairReport>('library.repair', { dryRun: true });
                  const 话 = 整理报数(r);
                  if (r.orphanBooks + r.missingPrimary + r.staleMissing + r.rootlessGone + r.wronglyMissing === 0) {
                    setRepairPreview(null);
                    setRepairMsg(话);
                    return;
                  }
                  // 先摆出来给人看再动手：这里头有「整条记录删掉」那一种，
                  // 而按下去之前屏幕上一个字都不会说会删几条
                  setRepairPreview(`会动 ${话}`);
                  setRepairMsg(null);
                })()}
              >
                看看会整理哪些
              </button>
              {repairPreview && (
                <button
                  className="primary"
                  onClick={() => void (async () => {
                    const r = await rpc<RepairReport>('library.repair');
                    setRepairPreview(null);
                    setRepairMsg(`已整理：${整理报数(r)}`);
                  })()}
                >
                  确认整理
                </button>
              )}
              {repairPreview && <span style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>{repairPreview}</span>}
              {repairMsg && <span style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>{repairMsg}</span>}
            </div>

          </>
        ) : (
          <>
            {/* 这一页只放**要出网**的两件事：源配在哪、批量补全怎么跑。
                「自定义书源」原来夹在「改动磁盘文件」和「连载状态」中间，
                切四页时若不把它挪过来，书库页会剩 3 区而联网页挤 4 区 */}
            <CoverSources />

            <h3>联网补全</h3>
            <label className="row" style={{ gap: '.4rem', fontSize: '0.87rem' }}>
              {/* 绑 autofetch（用户那个开关），不是 running：自动暂停让路、队列跑完时
                  running 都会是 false 而开关仍开着，绑它会让勾选框视觉上自己取消 */}
              <input
                type="checkbox"
                checked={cover?.autofetch ?? false}
                onChange={(e) => 封面操作(e.target.checked ? 'cover.fetchStart' : 'cover.fetchStop')}
              />
              <span>批量联网找书：在线地址、封面、简介、分类一起补（可选，默认不开）</span>
            </label>
            {/* 隐私这句必须留全文：联网补全会把书名和作者发出去。
                默认走「点一本补一本」（书籍编辑器里的「联网补全」），
                这里是给不想一本本点的人准备的批量任务 */}
            <p className="warn-line">
              平时用<strong>书籍编辑器里的「联网补全」</strong>，点一本补一本；这个开关是批量，把没补过的书都跑一遍：记下过地址的直接读那一页，没地址的按书名搜。会把<strong>书名和作者</strong>发到搜索源，除此之外不发任何数据；搜索结果只有书名、作者都精确一致才采用——宁可没有，不能配错。
              <br />
              {/* 这条不是客套：抓一本要在隐藏窗口里真的渲染一遍对面的页面，
                  实测能让书架从 1.9 秒变成 40 秒。让路是自动的，但得让人知道，
                  否则「开着开关却看到剩余数不动」会被当成坏了 */}
              <strong>你在用应用时它自动停下让路</strong>，你离开这个窗口几秒后它接着跑；不让路的话，补全期间整个界面会明显变慢。
            </p>
            {/*
             * 状态行分四态说，**「照这个速度还要约 N 分钟」只在真在跑的时候才配出现**。
             *
             * 原来是一个 `{cover && …}` 无条件铺一整行，而 ETA 用的 `gapMs` 是**上一次
             * 的退避间隔**——开关关着时它是个历史值。于是屏上出现过
             * 「勾都没勾：已补全 0 · 剩余 14 · 照这个速度还要约 1 分钟」，
             * 同一行后面还挂着「关着不跑」，两句自相矛盾。
             * 「开着但没在跑」那句解释原来另起一段、和这行说的是同一件事，合到这里来。
             */}
            {cover && (() => {
              const 数 = `已补全 ${cover.done} · 剩余 ${cover.pending} · 没找到 ${cover.nomatch}`
                + (cover.failed > 0 ? ` · 失败 ${cover.failed}` : '');
              const 式 = { fontSize: '0.82rem', margin: '0.2rem 0 0.4rem' } as const;
              if (!cover.autofetch) {
                return <p className="muted" style={式}>{数} · 批量开关没开，不会跑</p>;
              }
              // 原因说的是「上次为什么停」，必须带上时间和「会自动重试」，
              // 不然限流早解除了，这句话还挂着像在报现在的故障
              if (cover.pausedReason) {
                return (
                  <p className="muted" style={式}>
                    {数}
                    <span className="danger">
                      　{cover.pausedReason}
                      {cover.pausedAt && `（${relTime(cover.pausedAt)}暂停，稍后自动重试，恢复后接着跑）`}
                    </span>
                  </p>
                );
              }
              if (!cover.running) {
                return (
                  <p className="muted" style={式}>
                    {数} · {cover.pending === 0
                      ? '开关开着，待补全的都跑完了——之后扫进新书会自动接着抓'
                      : '开关开着，此刻没有在跑：你在用应用时它自动让路，离开这个窗口几秒后接着跑'}
                  </p>
                );
              }
              const eta = etaWords(cover.pending, cover.gapMs);
              return (
                <p className="muted" style={式}>
                  {数}
                  {/* 速率是自适应的（撞限流翻倍、顺利跑一段减半）。不显示的话，
                      回填慢到一分钟一本时用户只会觉得「卡住了」，看不出是在自己让路 */}
                  {cover.gapMs > 3000 && ` · 每本间隔 ${Math.round(cover.gapMs / 1000)} 秒（网站那边限过访问，间隔已自动放慢）`}
                  {/* 2026-09-26 那轮「剩余数怎么不动」的真相是应用那 7 天根本没开，
                      可屏幕上没有一句读得出来这件事：间隔是内部退避值，人换算不出
                      「6035 本 × 60 秒」是几天，于是只剩「坏了」那一种读法。 */}
                  {eta && ` · ${eta}（按应用开着的时间算——它跟着应用走：关着不跑，开着从上次接着）`}
                </p>
              );
            })()}
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
              {checking ? '正在检查…' : '检查那三个搜索源（起点 / 书旗 / 豆瓣）'}
            </button>
            {/* 这个按钮的真实收益得写在它旁边，不然「重试 830 本」读起来像有救。
                实测在案：`cover-source.ts` 的 `resetMisses` 上面记着「随机抽 10 本重试，
                命中 **0/10**」，而那次点下去要发 167 个请求、其中 136 个注定白打。
                nomatch 是问过了、站上没有同一本；failed（没问出来）才真该重试，
                那个由 `cover-fetcher.ts` 的 `start()` 自动清回队列，不用人点。 */}
            {cover && cover.nomatch > 0 && (
              <p className="muted" style={{ fontSize: '0.82rem', margin: '0.2rem 0 0' }}>
                「没找到」多半是网站上真没有同一本——试过抽查几本重新搜，基本捞不回来。所以这个键多半白按。
              </p>
            )}
            {srcCheck && (
              <p className="muted" style={{ fontSize: '0.82rem', margin: '0.4rem 0 0' }}>
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
        )))}
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
