// 主题的形状只此一份：`core/legado.ts` 那边转换主题时用的就是它。
// 渲染进程原来抄了一份一模一样的九个字段——这个仓库栽在「抄第二份」上已经六次了
import type { ImportedTheme } from '../core/legado.ts';
export type { ImportedTheme };
// 阅读器的外观设置（spec §6）。
//
// 存 localStorage 而不是数据库：这些是**可再生**的偏好，丢了重设一次就行，
// 不值得为它写一条迁移。真正不可再生的（阅读进度、书签）才进库。

import { BUNDLED_THEMES } from './builtin-themes.ts';
import { SORT_KEYS } from '../core/library.ts';

/**
 * **阅读纸色和应用外观是两件事。**
 *
 * 原来一个 `theme` 同时管两者：选「护眼」书架也跟着变绿。而代码里还留着一行补丁
 * ——离开阅读器时把 `data-theme` 掰回日间「免得书架跟着变暗」——那正是这个模型
 * 不对的证据：既然要掰回去，说明本来就不该染过去。
 *
 * 同行也都是分开的：legado / 微信读书里纸色只属于阅读页，应用自己只有亮/暗。
 *
 * 现在 `appearance` 管应用，`theme` 只管正文那一栏。
 */
/**
 * `auto` = 跟着系统的日夜走（Windows 的「深色模式」有排程）。
 * **默认仍是 `light`**，不是 auto——这是用户明确定过的。
 */
export type Appearance = 'light' | 'dark' | 'auto';

/** 现在该不该用暗色。auto 的时候问系统，`applySettings` 和亮暗监听共用这一处判断 */
export const wantsDark = (a: Appearance): boolean =>
  a === 'dark' || (a === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);

/**
 * 滚动用不用平滑动画。**系统开了「减少动态效果」就直接跳过去。**
 *
 * 这个应用的动效总共只有四处，全在阅读器上：跳到某一段、「顶部」、「底部」，
 * 加上翻页模式那条 `transform` 过渡（那条在 CSS 里另有一条 media 挡着）。
 * 别看数量少——**这是个长文阅读应用**，前庭敏感的人正是长时间盯着正文的那批；
 * 而「底部」在一本几十 MB 的书上是一次横扫整章的动画。
 *
 * ⚠️ **自动滚动不在这条规矩里**：那是用户自己按下去的功能，本体就是匀速移动，
 * 关掉它等于把功能关掉（同视频播放器不因为这条就不许播）。
 *
 * 一处判断三处用——三个调用点各写一遍 matchMedia 就是抄第三份。
 */
export const 滚动方式 = (): ScrollBehavior =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

/**
 * 存档版本。**改默认值时必须 +1**，否则老用户拿不到新默认。
 *
 * 第一版拿「有没有 `appearance` 字段」当迁移标记，结果是：拆主题那次已经把
 * `appearance` 写进去了，等到改字体默认值时再想迁移，`migrate()` 一进来就
 * return —— **一个字段只能表达一次迁移**。用版本号才能表达第二次、第三次。
 */
const SCHEMA = 2;

export type ThemeId = string;


/*
 * 用户自己的纸色：**导进来的整张纸**，和**调过色的那几张**（同 id 覆盖内置的，
 * 见下面 `saveThemeOverride`）。两样都是他自己弄的，重装一次配不回来。
 *
 * ⚠️ **存在库里（`app_setting`），不是 localStorage。** 这一族别的东西
 * （字号、快捷键、排序）是「丢了重设一次就行」的可再生偏好，而这个不是：
 * 一张纸调到顺眼要来回试很多次，导进来的更是别处拿的文件。存库里才跟得上备份
 * （`backup.ts` 的 `BACKUP_SETTINGS`），同朗读引擎和自定义封面源那条。
 *
 * **但读必须是同步的**——`applySettings` / `colorThemes()` 在渲染当中就要用。
 * 所以库里那份是**正本**，进程里留一份缓存，开机 `hydrateUserThemes()` 灌一次。
 * localStorage 那个旧键**只在灌的时候读一次**当迁移来源，之后不再写。
 */
const THEMES_KEY = 'novel.imported-themes';
const THEMES_SETTING = 'theme.imported';

/** 进程内的那份。`null` = 还没灌过 */
let 缓存: ImportedTheme[] | null = null;
/** 灌完之后要把纸色重新贴一遍——见 hydrateUserThemes */
let 写回库: ((list: ImportedTheme[]) => void) | null = null;

function 读旧的(): ImportedTheme[] {
  try {
    return JSON.parse(localStorage.getItem(THEMES_KEY) || '[]') as ImportedTheme[];
  } catch {
    return [];
  }
}

export function loadImportedThemes(): ImportedTheme[] {
  // 还没灌完就先用 localStorage 那份：开机头几帧也别让纸色是错的
  return 缓存 ?? 读旧的();
}

export function saveImportedThemes(list: ImportedTheme[]): void {
  缓存 = list;
  写回库?.(list);
}

/**
 * 开机灌一次。`get` / `set` 由 App 传进来（这个模块不认识 rpc，也不该认识）。
 *
 * **库里没有、而 localStorage 有**，就把旧的搬上去——那是这个键换地方之前
 * 用户调过的纸色，不能因为换了个地方就丢。搬完不删旧键：万一要回退，
 * 那份还在（它也不占地方）。
 */
export async function hydrateUserThemes(
  get: (key: string) => Promise<string | null>,
  set: (key: string, value: string) => Promise<unknown>,
): Promise<void> {
  写回库 = (list) => void set(THEMES_SETTING, JSON.stringify(list));
  let list: ImportedTheme[] = [];
  try {
    const raw = await get(THEMES_SETTING);
    if (raw) list = JSON.parse(raw) as ImportedTheme[];
    else {
      const 旧的 = 读旧的();
      if (旧的.length) { list = 旧的; 写回库(旧的); }
    }
  } catch {
    list = [];
  }
  缓存 = Array.isArray(list) ? list : [];
}

/**
 * 改某张纸的颜色。**存成同 id 的「用户主题」**，`colorThemes()` 里用户的那份
 * 会盖掉内置的——所以不用另建一套「覆盖」概念，改颜色和导入主题是同一条路。
 */
export function saveThemeOverride(t: ImportedTheme): void {
  const rest = loadImportedThemes().filter((x) => x.id !== t.id);
  saveImportedThemes([...rest, t]);
}

/** 撤掉对某张纸的改色，回到随应用发布的那份 */
export function resetThemeOverride(id: string): void {
  saveImportedThemes(loadImportedThemes().filter((x) => x.id !== id));
}

/** 这张纸有没有被改过色（界面据此决定要不要显示「恢复默认」） */
export function isThemeOverridden(id: string): boolean {
  return loadImportedThemes().some((x) => x.id === id);
}

/** 纸色下拉里能选的全部：随应用发布的 + 用户自己导的 */
export function allThemes(): Array<{ id: string; name: string }> {
  return colorThemes().map((t) => ({ id: t.id, name: t.name }));
}

/** 带颜色的那些纸色（内置发布的 + 用户导的）。用户导的同 id 覆盖内置的 */
export function colorThemes(): ImportedTheme[] {
  const mine = loadImportedThemes();
  const ids = new Set(mine.map((t) => t.id));
  return [...BUNDLED_THEMES.filter((t) => !ids.has(t.id)), ...mine];
}

/**
 * 这张纸色算不算夜间。**全应用唯一的一份判据。**
 *
 * 原来三处各写各的：本文件的迁移查主题自己声明的 `night` 字段（对的），
 * 而两个阅读界面各手写一份 `theme === 'night' || theme.endsWith('-night')`。
 * 后者错在**认 id 的拼法而不认那个字段**：导进来的 legado 主题 id 是
 * `imported-<名字>`，一张深色的导入主题 `night` 是 true、id 却不以 `-night` 结尾——
 * 于是应用外观已经是暗的，阅读器右轨那个键还写着「切到夜间」、图标还是月亮。
 *
 * 认字段不认名字：id 只是个名字，`night` 才是主题自己说的话。
 */
export function isNightTheme(theme: ThemeId): boolean {
  return colorThemes().find((t) => t.id === theme)?.night ?? false;
}

export interface ReadSettings {
  /** 存档版本，见 SCHEMA。**改默认值时要 +1**，否则老用户拿不到新默认 */
  v: number;
  /** 应用外观：亮 / 暗。**只有它影响书架、侧栏、对话框** */
  appearance: Appearance;
  /** 阅读纸色。**只影响正文那一栏和阅读器**，不染到应用其余部分 */
  theme: ThemeId;
  /** 正文字号，px */
  size: number;
  /** 行距倍数 */
  line: number;
  /** 版口宽度，单位 em —— 量中文一行放多少字只能用 em，ch 是数字「0」的宽度，汉字约是它两倍 */
  width: number;
  /** 首行缩进，em */
  indent: number;
  /** 段距，em */
  para: number;
  /**
   * **顶部**留白，rem。名字不叫「上下」是因为它真的只管上边：
   * `styles.css` 两处都是 `padding: var(--read-pad) <左右> 6rem`，下边写死 6rem。
   * 界面上那个控件也叫「顶部留白」（`Reader.tsx` 的 `step`），别在这儿写成另一个意思。
   */
  pad: number;
  /**
   * 正文字体。**只作用于正文**，界面其余部分不跟着变——
   * 中文长文读宋体还是黑体是很个人的事，而把按钮菜单换成宋体只会更难认。
   * 值是 CSS font-family 串，用的全是 Windows 自带的字体，不下载任何东西。
   * 空串 = 跟随界面字体
   */
  font: string;
  /**
   * 阅读方式：`scroll` 按章滚动（默认）、`flow` 无限下滑、`page` 左右翻页。
   *
   * **`flow` 是一种滚动**——它和 `scroll` 的差别只有「滚到章尾接不接下一章」一条，
   * 所以 `Reader.tsx` 里那十几处判据写的都是 `mode === 'page'` 或 `!== 'page'`，
   * 不是列举。加第四种滚法时照这个写，别改成三分支。
   */
  mode: 'scroll' | 'flow' | 'page';
  /** 自动滚动速度，像素/秒。0 表示不自动滚 */
  autoScroll: number;

  // ── 朗读（spec §6）────────────────────────────────
  /** `'system'` = Chromium 自带的语音（离线、不外发）；其余是在线引擎的 id */
  ttsEngine: string;
  /** 系统语音用哪个嗓子。存 voiceURI，空 = 让浏览器自己挑中文的 */
  ttsVoice: string;
  /** 语速。系统语音 0.5–2，在线引擎不支持调速时忽略 */
  ttsRate: number;
  ttsPitch: number;
  ttsVolume: number;
  /** 念完一章自动翻到下一章接着念 */
  ttsContinuous: boolean;
}

/**
 * 排版默认值**照用户自己那份 legado web 版的配置**
 * （`userConfig.json`：fontSize 21 / lineHeight 1.8 / paragraphSpace 0.2 / readWidth 1120）。
 *
 * 原来是 18px / 1.9 / 0.7em / 38em —— 版口只有 684px，字也小一号，
 * 在 1200 宽的窗口里两边空掉一大片，看起来就是「粗糙」。
 *
 * **`width` 的单位是 em 不是 px**，因为字号是可调的：1120 ÷ 21 ≈ 53em，
 * 这样把字号调大时版口跟着长，一行的字数不变。
 *
 * **夜间和白天只差颜色，排版一模一样。** 那份配置里夜间是 18px / 800px，
 * 但用户说了以白天那套为准——两套排版会让人切主题时觉得「字怎么变了」。
 */
export const DEFAULTS: ReadSettings = {
  v: SCHEMA,
  appearance: 'light',
  theme: 'shuzhai-day',
  size: 21,
  line: 1.8,
  width: 53,
  indent: 2,
  para: 0.2,
  pad: 2,
  /**
   * 默认就用随应用发布的 HarmonyOS Sans SC。
   *
   * **装了才有的字体不能当默认**——那会让没装的人打开就是回退字体，
   * 而他不知道自己看到的不是设计的样子。这一个是带在包里的，一定在；
   * 回退链后面仍挂着系统黑体，万一打包时没带上也不会光秃秃。
   */
  font: '"HarmonyOS Sans SC", "HarmonyOS Sans", sans-serif',
  mode: 'scroll',
  autoScroll: 40,
  // **默认用系统语音**：离线、不把正文发给任何人。在线引擎要用户自己选
  ttsEngine: 'system',
  ttsVoice: '',
  ttsRate: 1,
  ttsPitch: 1,
  ttsVolume: 1,
  ttsContinuous: true,
};

const KEY = 'novel.read-settings';


/**
 * 拆分前存下来的 `theme` 是**应用主题**，不是纸色——直接当纸色继承过来是错的。
 *
 * 最典型的就是 `'day'`：那是拆分前的默认值，绝大多数人**从没主动选过**它，
 * 而它这张纸的正文栏是纯白。继承过来的结果就是「换了新版，正文还是白的」。
 *
 * 判据是**有没有 `appearance` 字段**：没有就说明这份设置是拆分前存的。
 *
 * - `day` → 没选过，给新的默认纸色
 * - `night` → 他要的是「暗」，那是外观不是纸色，转成 appearance + 对应的夜间纸
 * - `eye` / `paper` / 各种 `xx-day` → **是主动挑的样子，原样留着**
 */
function migrate(saved: Partial<ReadSettings> & { theme?: string }): Partial<ReadSettings> {
  if (saved.v === SCHEMA) return saved;

  const out: Partial<ReadSettings> = { ...saved, v: SCHEMA };

  // 外观：从旧的「应用主题」推出来
  if (!saved.appearance) {
    if (saved.theme === 'night') { out.appearance = 'dark'; out.theme = 'shuzhai-night'; }
    else if (saved.theme === 'day' || !saved.theme) { out.appearance = 'light'; out.theme = DEFAULTS.theme; }
    else out.appearance = isNightTheme(saved.theme) ? 'dark' : 'light';
  }

  /**
   * 字体：`''`（跟随界面）在改默认值之前是**旧默认**，不是用户挑的。
   * 留着它，随包发布的 HarmonyOS Sans 对老用户就等于没有——而这个「没生效」
   * 完全静默：下拉里选得到，正文却还是界面字体。
   */
  if (!out.font) out.font = DEFAULTS.font;

  return out;
}

export function loadSettings(): ReadSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...migrate(JSON.parse(raw) as Partial<ReadSettings>) } : DEFAULTS;
  } catch {
    return DEFAULTS; // 存坏了就用默认值，不要让阅读器打不开
  }
}

export function saveSettings(s: ReadSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** 把设置写到 :root 上，CSS 变量负责其余的事 */
export function applySettings(s: ReadSettings): void {
  const root = document.documentElement;

  // 应用外观：亮 / 暗。**只有这一个开关会影响书架、侧栏和对话框**
  root.dataset.theme = wantsDark(s.appearance) ? 'night' : 'day';

  // 阅读纸色：只喂给阅读器（`.reader` 里再映射回 --bg/--fg/--panel）。
  // 找不到就退回第一张纸——不能让正文变成没有配色的裸样式，那是不报错的白屏
  const paper = colorThemes().find((t) => t.id === s.theme) ?? colorThemes()[0];
  root.style.setProperty('--read-desk', paper.bg);
  root.style.setProperty('--read-paper', paper.panel);
  root.style.setProperty('--read-ink', paper.fg);
  root.style.setProperty('--read-edge', paper.line);
  root.style.setProperty('--read-muted', paper.muted);
  root.style.setProperty('--read-accent', paper.accent);
  root.style.setProperty('--read-size', `${s.size}px`);
  root.style.setProperty('--read-line', String(s.line));
  root.style.setProperty('--read-width', `${s.width}em`);
  /*
   * 同一个宽度的**像素值**。`--read-width` 是 `em`，只有在正文那一栏上算才对——
   * 别的元素拿它做 calc 会按**那个元素自己的字号**解析，得出一个不相干的数。
   * 两条工具轨要贴着正文栏摆，所以需要这一份。
   */
  root.style.setProperty('--read-col', `${s.width * s.size}px`);
  root.style.setProperty('--read-indent', `${s.indent}em`);
  root.style.setProperty('--read-para', `${s.para}em`);
  root.style.setProperty('--read-pad', `${s.pad}rem`);
  // 空串 = 跟随界面字体，用 inherit 让它落回上层的 font-family
  root.style.setProperty('--read-font', s.font || 'inherit');
}

/**
 * 可选的正文字体。**全是 Windows 自带的**，不下载任何字体文件——
 * 这个应用只有一个运行时依赖，不会为了字体破例。
 *
 * 每条都写了两个名字：中文名给中文系统，英文名给英文版 Windows，
 * 只写一个的话在另一种系统上会静默回落到默认字体。
 */
/**
 * 正文字体候选。分两组：**系统里装了就能直接选**的（这一份），
 * 和用户自己拖进来的字体文件（`font.list`，在 Settings 里另起一个 optgroup）。
 *
 * 前几个是免费商用的国产屏幕字体，**装了才有、没装自动落到后面的备选**——
 * CSS 的 font-family 回退链天生就干这件事，不需要探测「装没装」。
 *
 * 排序按「PC 上长时间读」排，不是按知名度。**这一版的顺序是量出来的**
 * （21px 真实正文，五体各三档字重，量每字宽和墨量＝平均暗度，见 AGENTS.md）：
 *
 * - **HarmonyOS Sans SC 排第一**，因为它随包发布、一定在，而且 Regular 的
 *   墨量 11.4% 是四个黑体里最重的，不用再调字重就落在舒服的区间。
 * - MiSans / 阿里普惠体 / 思源黑体 Regular 在 10.4–10.8%，略轻一档。
 * - **上一版说「阿里字形偏窄、一行能多塞字」，实测不成立**：五个字体的每字宽
 *   是 19.96–20.40px，差不到 2%。中文是等宽方块字，字面差异远小于印象。
 * - 思源宋体 Regular 只有 7.7% 墨量，比黑体轻近三成——这就是「宋体在屏幕上
 *   发虚」的来源，它得往上加一档字重才够。
 * - **霞鹜文楷放在最后，而且标了「短读」**：楷体有书写的粗细变化和斜势、
 *   字重偏轻，适合短篇和慢读；PC 上一读几小时容易累。它在中文圈很火，
 *   但「火」和「适合长时间读」是两件事。
 */
export const READ_FONTS: Array<{ label: string; value: string }> = [
  { label: '跟随界面', value: '' },
  { label: 'MiSans（推荐）', value: '"MiSans", "MiSans VF", sans-serif' },
  { label: 'HarmonyOS Sans', value: '"HarmonyOS Sans SC", "HarmonyOS Sans", sans-serif' },
  { label: '阿里巴巴普惠体', value: '"Alibaba PuHuiTi 3.0", "Alibaba PuHuiTi", sans-serif' },
  { label: '思源黑体', value: '"Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans SC", sans-serif' },
  { label: '思源宋体', value: '"Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", serif' },
  { label: '霞鹜文楷（短读）', value: '"LXGW WenKai Screen", "LXGW WenKai", serif' },
  { label: '微软雅黑', value: '"Microsoft YaHei", "微软雅黑", sans-serif' },
  { label: '宋体', value: '"SimSun", "宋体", serif' },
  { label: '黑体', value: '"SimHei", "黑体", sans-serif' },
  { label: '楷体', value: '"KaiTi", "楷体", "STKaiti", serif' },
  { label: '仿宋', value: '"FangSong", "仿宋", "STFangsong", serif' },
];

/**
 * 把用户装进 `userData/fonts` 的字体挂成 `@font-face`，family 名就是文件名。
 *
 * **只挂一个 `<style>` 标签、每次整体重写**：字体装了卸了都走这一条路，
 * 增量维护多个标签迟早出现「卸了还在列表里」或者反过来。
 *
 * 路径要 `encodeURI`——中文字体名（`霞鹜文楷.ttf`）在 `url()` 里不编码会解析失败，
 * 而失败是静默的：字体只是不生效，看起来像「装了没用」。
 */
export function applyFontFaces(fonts: Array<{ name: string; file: string }>): void {
  const id = 'shuzhai-fontfaces';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = fonts
    .map((f) => `@font-face{font-family:"${f.name}";src:url("file:///${encodeURI(f.file.replace(/\\/g, '/'))}");font-display:swap}`)
    .join('\n');
}

/** 快捷键绑定（spec §6：全部可自定义）。存 localStorage，和排版一样是可再生的偏好 */
export type Action = 'prev' | 'next' | 'exit' | 'toc' | 'bookmark' | 'search' | 'autoScroll';

export const ACTION_NAMES: Record<Action, string> = {
  prev: '上一章',
  next: '下一章',
  exit: '退出阅读器',
  toc: '开关目录',
  bookmark: '加书签',
  search: '书内搜索',
  autoScroll: '开关自动滚动',
};

export const DEFAULT_KEYS: Record<Action, string[]> = {
  prev: ['ArrowLeft', 'PageUp'],
  next: ['ArrowRight', 'PageDown'],
  exit: ['Escape'],
  toc: ['t'],
  bookmark: ['b'],
  search: ['f'],
  autoScroll: [' '],
};


/**
 * 键名怎么写给人看。
 *
 * 存的一直是 `KeyboardEvent.key` 的原值（`actionFor` 要拿它比对），
 * 而**界面上原样摆的也是那个原值**：设置里那张快捷键表写着
 * `ArrowLeft / PageUp`、`Escape`、`t`——那是 DOM 的词，不是键盘上印的字。
 * 同本文件那条「别把 CSS 单位和排版行话摆给用户」（`rem` 那次）：
 * 用户认的是 ← 和 Esc。
 *
 * **只改显示，不改存的值。**
 */
export function keyLabel(k: string): string {
  const map: Record<string, string> = {
    ' ': '空格',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    PageUp: 'Page Up', PageDown: 'Page Down',
    Escape: 'Esc', Enter: '回车', Backspace: '退格', Tab: 'Tab',
    Home: 'Home', End: 'End',
  };
  // 单个字母按键盘上印的样子写（大写）。`t` 在键帽上是 `T`
  return map[k] ?? (k.length === 1 ? k.toUpperCase() : k);
}

const KEYS_KEY = 'novel.read-keys';

export function loadKeys(): Record<Action, string[]> {
  try {
    const raw = localStorage.getItem(KEYS_KEY);
    return raw ? { ...DEFAULT_KEYS, ...(JSON.parse(raw) as Partial<Record<Action, string[]>>) } : DEFAULT_KEYS;
  } catch {
    return DEFAULT_KEYS;
  }
}

export function saveKeys(keys: Record<Action, string[]>): void {
  localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
}

/** 按下的这个键对应哪个动作，没绑就返回 null */
export function actionFor(keys: Record<Action, string[]>, key: string): Action | null {
  for (const [action, bound] of Object.entries(keys) as Array<[Action, string[]]>) {
    if (bound.includes(key)) return action;
  }
  return null;
}



/*
 * ⚠️ **新键名，旧的 `novel.sort` 弃掉。** 那个键里存的是一个裸字符串（`"rating"`），
 * 而这里要存一张表；同一个键上换形状会让老用户开机时 `JSON.parse('rating')` 抛，
 * 那个 catch 再把他选过的排序静默吃掉。换名字让旧键自然失效——
 * **一次性回到默认，比抛一次异常再回到默认干净**（视图那次是同一个判断）。
 */
const SORT_KEY = 'shelf.sorts';

const SHOW_RATING_KEY = 'novel.show-rating';

/**
 * 书架卡片、全库搜索结果、评价浮层和读完那张卡片里，**显不显示 ★ 评分**。
 *
 * **默认显示。** 关掉之后短评、弃坑原因、标签一样不动——那几样才是
 * 「下次不用再想这本我看过没」的主力，而评分是个可有可无的判断：
 * 真实库里 8172 本只有 1 本打过分，写过短评的却是另一回事。
 *
 * 存 localStorage 而不是数据库：这是**可再生的显示偏好**（同收起的文件夹、
 * 排序），丢了重设一次就行，不值得为它写一条迁移。
 *
 * ⚠️ **只管「显示」，不管「有没有」。** 关掉它不会清掉任何人的评分，
 * 打开就全回来了——不然它就成了一个会毁数据的开关，而铁律 3 里
 * `reading_state` 是重扫恢复不了的。
 */
export function loadShowRating(): boolean {
  try {
    // 只有明确存了 '0' 才算关掉：没存过、存了别的、读不到，都当作显示
    return localStorage.getItem(SHOW_RATING_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveShowRating(v: boolean): void {
  try {
    localStorage.setItem(SHOW_RATING_KEY, v ? '1' : '0');
  } catch {
    /* 无痕模式之类，存不上就算了——这是可再生偏好 */
  }
}

/**
 * **「这一档上次是怎么看的」——排序和视图共用这一份。**
 *
 * 两者形状完全一样（`档位 → 值` 的一张表、认不出的值要丢掉、坏了不能抛），
 * 抄两份的话下次改一处必然漏一处。存的是 JSON 对象。
 *
 * ⚠️ **认不出的值一律丢掉。** localStorage 是用户手改得了的，而一个不认识的
 * 排序键会让 `orderBy` 当场抛（那是对的，但不该在开机时抛），
 * 一个不认识的视图名会让书架什么都不画。
 * 认得的清单从 `core/library.ts` 的 `ORDER` 和本文件的 `VIEW_KEYS` 算出来，
 * 不在这儿抄第二份。
 */
function 每档记一份(key: string, 认得的: readonly string[]): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, string>;
    return Object.fromEntries(
      Object.entries(o ?? {}).filter(([, v]) => 认得的.includes(v)),
    );
  } catch {
    return {};
  }
}

/**
 * ⚠️ **写的时候按原样合并，不拿「认得的」过滤一遍。**
 * 过滤放在读那一头就够了；写的时候也过滤的话，将来从 `ORDER` 里去掉一个排序键，
 * 会顺手把别档记着的那条也抹掉——而用户只是改了这一档。
 */
function 记下(key: string, shelfId: string, v: string): void {
  try {
    let 旧: Record<string, string> = {};
    /*
     * ⚠️ **要判「是不是对象」，不能只靠 try/catch。**
     * `JSON.parse('"table"')` **不抛**，回来的是字符串 `'table'`，
     * 于是 `{...'table', all: 'wall'}` 写出去的是 `{0:'t',1:'a',…,all:'wall'}`——
     * 那玩意儿下次 parse 得出对象，于是**每存一次就再抄一遍，永远好不了**。
     * （`'[1,2]'`、`'null'` 同理。读那头的 `每档记一份()` 会把它们滤掉，
     * 所以界面上看不出来——正是这个仓库最怕的那种坏法。）
     */
    try {
      const o: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
      if (o && typeof o === 'object' && !Array.isArray(o)) 旧 = o as Record<string, string>;
    } catch { /* 坏了就当空的 */ }
    localStorage.setItem(key, JSON.stringify({ ...旧, [shelfId]: v }));
  } catch {
    /* 存不下就算了，这些都是丢了重设一次就行的显示偏好 */
  }
}

/**
 * 这一档上次用的是哪种排序。**没存过就返回 null**，让调用方回落到
 * 这一档自己的默认（`SHELVES` 的 `sort`）——这里不替它决定。
 *
 * ⚠️ **每一档各记各的，不是全局一个。**
 *
 * 原来是一个全局键，而这个应用有两处能改排序：顶栏那个下拉，和**表格视图的表头**。
 * 于是「在『我的书评』的表格里点一下『评分』表头」＝「把『全部』的默认排序也改了」，
 * 而用户根本不觉得自己动过什么全局设置——**列表头感觉是「排这张表」，不是「改我的默认」**。
 * 真实症状：刚点开读过的书在「全部」里不排第一了（它没评分，沉到八千本后面），
 * 而用户完全不知道为什么。判据和视图那条一模一样，也和 `SHELVES` 的 `sort` 一脉相承：
 * **一档有它自己的问题要答，就别让全局偏好替它回答。**
 */
export function loadSort(shelfId: string): string | null {
  return 每档记一份(SORT_KEY, SORT_KEYS as readonly string[])[shelfId] ?? null;
}

export function saveSort(shelfId: string, v: string): void {
  记下(SORT_KEY, shelfId, v);
}

/**
 * 书架用哪种视图看。**和档位是两个轴**：换档＝换看哪一堆，换视图＝换怎么看这一堆。
 *
 * - `wall` 封面墙——绝大多数档位的默认，这个应用抓了几百张真封面，那是它的卖点
 * - `reviews` 书评册——我写的那句话是正文（见 `ReviewShelf.tsx`）
 * - `table` 表格——评分/评价/状态/读到/上次读/读完一屏看全，「我的书评」的默认
 *
 * ⚠️ **每一档各记各的，不是全局一个。**
 *
 * 第一版是一个全局键，症状是**两个方向都串味**：在「全部」里切成表格，
 * 「在读」「弃坑」「记过笔记」全跟着变成表格；反过来在「我的书评」里
 * 切一下封面墙，这个偏好又会盖到别的档上。而视图是**跟着这一档要答的问题**走的
 * ——「我的书评」要清点账目（表格），「全部」要按封面找书（墙），
 * 这两件事本来就不该共用一个记忆。
 *
 * 存法仍然照搬排序那对，**只在用户自己点那三个键时才存**：
 * 切档也会改视图（那是那一档的默认），不该被记成偏好。
 */
/*
 * ⚠️ **用了个新键名。** 旧的 `shelf.view` 里存的是一个裸字符串（`"table"`），
 * 而这里要存一张表；同一个键上换形状的话，`JSON.parse('table')` 会抛，
 * 老用户第一次打开时那个 catch 会把他之前选的视图静默吃掉。
 * 换个名字，旧键自然失效——**一次性回到默认，比抛一次异常再回到默认干净**。
 */
const VIEW_KEY = 'shelf.views';
export const VIEW_KEYS = ['wall', 'reviews', 'table'] as const;
export type ViewKind = (typeof VIEW_KEYS)[number];


/**
 * 这一档上次用的是哪种视图。**没存过就返回 null**，让调用方回落到
 * 这一档自己的默认（`SHELVES` 的 `view` 字段）——这里不替它决定。
 */
export function loadView(shelfId: string): ViewKind | null {
  // 和排序共用 `每档记一份` / `记下`：两者形状一样，抄两份下次必漏一处
  return (每档记一份(VIEW_KEY, VIEW_KEYS)[shelfId] as ViewKind | undefined) ?? null;
}

export function saveView(shelfId: string, v: ViewKind): void {
  记下(VIEW_KEY, shelfId, v);
}
