// 导入「阅读 / 乌云」系的净化规则和主题。
//
// 这类规则是给 Android 上的阅读器写的，用的是 **Java 正则方言**，JS 直接编译
// 二十条里过不了十四条。差异都在这几处：
//
//   | Java 写法        | JS 里的意思            | 怎么办 |
//   |------------------|------------------------|--------|
//   | `(?i)` `(?m)` `(?s)` | 内联标志，JS 不支持 | 抽出来变成 RegExp 的 flags |
//   | `\h` `\H`        | 水平空白 / 非水平空白  | 换成 `[ \t]` / `[^ \t]` |
//   | `\v` `\V`        | **垂直空白类**（JS 里 `\v` 只是垂直制表符） | 换成 `[\n\r\f]` |
//   | `X++` `X*+`      | 占有量词               | 退化成贪婪——JS 没有等价物，语义上只影响回溯不影响匹配集 |
//
// 另外 `@js:` 开头的替换是一段脚本，`result` 是当前匹配到的文本。那些脚本只做
// 字符串变换（slice / replace / search），所以放进 `node:vm` 的最小沙箱里跑就够，
// **不给它 require、process、fs**——规则文件是从外面导进来的，不能当自己人。

import { runInNewContext } from 'node:vm';
import type { DatabaseSync } from 'node:sqlite';
import type { CleanRule } from './clean.ts';
import { escapeRe } from './format.ts';

export interface LegadoRule {
  group?: string;
  name: string;
  pattern: string;
  replacement: string;
  isEnabled?: boolean;
  isRegex?: boolean;
  order?: number;
}

export interface TranslatedRegex {
  source: string;
  flags: string;
  /** 翻译过程中做了哪些让步，导入结果里如实报给用户 */
  notes: string[];
}

/** Java 的 `\v` 是垂直空白**类**，JS 的 `\v` 只是一个垂直制表符 —— 含义完全不同 */
const JAVA_VERTICAL = '[\\n\\r\\f\\u000b\\u0085\\u2028\\u2029]';

/**
 * Java 正则 → JS 正则。
 *
 * **只在字符类外面替换 `\h` `\v`**：`[\h\d]` 这种写在类里的，
 * 直接塞一个 `[ \t]` 进去会变成嵌套字符类，语义就错了。
 */
export function translateJavaRegex(pattern: string): TranslatedRegex {
  const notes: string[] = [];
  let flags = 'g';
  let src = pattern;

  // 1. 内联标志。Java 允许出现在任意位置，作用域到分组结尾；
  //    这里一律提升为整条正则的 flag——净化规则里没见过在中途才开启的用法
  src = src.replace(/\(\?([imsux]+)\)/g, (_, f: string) => {
    for (const ch of f) {
      if ('ims'.includes(ch) && !flags.includes(ch)) flags += ch;
      if (ch === 'x') notes.push('忽略了 (?x) 宽松模式');
      if (ch === 'u') notes.push('忽略了 (?u)：JS 默认就是 Unicode 语义');
    }
    return '';
  });

  // 2. 占有量词 X++ / X*+ / X?+ / X{n,m}+ → 贪婪。
  //    JS 没有占有量词，去掉那个 + 只影响回溯效率，不影响能匹配到什么
  const possessive = /([*+?}])\+/g;
  if (possessive.test(src)) {
    notes.push('占有量词已退化成贪婪量词（JS 没有等价写法）');
    src = src.replace(possessive, '$1');
  }

  // 3. \h \H \v \V —— 只换字符类外面的
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      const next = src[i + 1];
      if (!inClass && (next === 'h' || next === 'H' || next === 'v' || next === 'V')) {
        if (next === 'h') out += '[ \\t]';
        else if (next === 'H') out += '[^ \\t]';
        else if (next === 'v') out += JAVA_VERTICAL;
        else out += `[^${JAVA_VERTICAL.slice(1, -1)}]`;
        notes.push(`\\${next} 已换成等价字符类`);
        i++;
        continue;
      }
      out += ch + next;
      i++;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    out += ch;
  }

  return { source: out, flags, notes };
}

/** 翻译完还得真能编译，不能编译的规则不该进库 */
export function compileJavaRegex(pattern: string): { re: RegExp; notes: string[] } {
  const t = translateJavaRegex(pattern);
  return { re: new RegExp(t.source, t.flags), notes: t.notes };
}

/**
 * `@js:` 脚本的执行时限。死循环不该拖住整个阅读器。
 *
 * **50 毫秒太紧了。** 机器忙的时候（这里实测是同时在跑应用和构建），
 * 连 `return typeof process;` 这种一行脚本都会撞上限——`legado.test.ts` 那条
 * 沙箱测试因此偶发红。而超时的后果是「这条规则悄悄不生效」，
 * 也就是说**用户看到的正文会随机器负载变**，比死循环本身更难查。
 * 250 毫秒对死循环仍然够快（一章最多跑几条规则），对正常脚本则宽裕得多。
 */
const JS_TIMEOUT_MS = 250;

/**
 * 跑一段 `@js:` 替换脚本。
 *
 * **沙箱里只有 `result` 和 JS 内置对象**——没有 require、process、fs、网络。
 * 规则文件是从外部导进来的，哪怕是用户自己下的，也不该当成自己人：
 * 它只是在改一段要显示的文字，不需要碰这台机器上的任何东西。
 */
export function runJsReplacement(script: string, matched: string): string {
  try {
    // 沙箱对象用 null 原型：连 Object.prototype 上的东西都不给
    const sandbox = Object.assign(Object.create(null) as Record<string, unknown>, {
      result: matched,
    });
    const value = runInNewContext(`(function(){ ${script} })()`, sandbox, {
      timeout: JS_TIMEOUT_MS,
      displayErrors: false,
    });
    return value === undefined || value === null ? matched : String(value);
  } catch {
    // 脚本坏了就当这条规则没生效，别让一章正文因此打不开
    return matched;
  }
}

export interface ImportResult {
  imported: number;
  skipped: Array<{ name: string; reason: string }>;
  notes: Array<{ name: string; note: string }>;
}

/** 认出这是不是一份净化规则文件 */
export function looksLikeCleanRules(data: unknown): data is LegadoRule[] {
  return (
    Array.isArray(data) &&
    data.length > 0 &&
    data.every((r) => typeof r === 'object' && r !== null && 'pattern' in r && 'replacement' in r)
  );
}

/**
 * 把一份净化规则转成本项目的清洗规则。
 *
 * 这些规则**大多要整章一起看**（用 `^`/`$` 配 `(?m)`，或者跨行匹配），
 * 而内置那几条是按行套的。所以导进来的一律标成整章模式，
 * 见 `clean.ts` 的 `whole`。
 *
 * ⚠️ **一律导成「停用」，不管文件里 isEnabled 写的是什么。**
 * 这些规则是给另一个正则引擎写的，翻译过来语义可能有出入——实测那份规则里
 * 有一条会把正文整段吃掉。让用户在清洗规则界面里对着 diff 预览一条条开，
 * 比默认全开然后某天发现正文少了半章要好得多。
 */
export function convertRules(rules: LegadoRule[]): { rules: CleanRule[]; result: ImportResult } {
  const out: CleanRule[] = [];
  const result: ImportResult = { imported: 0, skipped: [], notes: [] };

  for (const r of rules) {
    const name = String(r.name ?? '未命名').trim();

    if (r.isRegex === false) {
      // 纯文本替换：转义成正则，语义不变
      out.push({
        name,
        pattern: escapeRe(String(r.pattern)),
        replacement: String(r.replacement ?? ''),
        enabled: false, // 见函数注释：一律先停用
        flags: 'g',
        whole: true,
      });
      result.imported++;
      continue;
    }

    try {
      const t = translateJavaRegex(String(r.pattern));
      new RegExp(t.source, t.flags); // 编译不过就别进库
      out.push({
        name,
        pattern: t.source,
        replacement: String(r.replacement ?? ''),
        enabled: false, // 见函数注释：一律先停用
        flags: t.flags,
        whole: true,
      });
      result.imported++;
      for (const note of new Set(t.notes)) result.notes.push({ name, note });
    } catch (e) {
      result.skipped.push({
        name,
        reason: e instanceof Error ? e.message.slice(0, 120) : String(e),
      });
    }
  }

  return { rules: out, result };
}

/** 落库。同名同表达式的不重复导入 */
export function importCleanRules(db: DatabaseSync, rules: LegadoRule[]): ImportResult {
  const { rules: converted, result } = convertRules(rules);

  db.exec('begin');
  try {
    for (const r of converted) {
      const dup = db
        .prepare('select id from clean_rule where name = ? and pattern = ?')
        .get(r.name, r.pattern);
      if (dup) continue;
      db.prepare(
        `insert into clean_rule(name, pattern, replacement, enabled, scope, flags, whole)
         values(?,?,?,?,'global',?,1)`,
      ).run(r.name, r.pattern, r.replacement, r.enabled ? 1 : 0, r.flags ?? 'g');
    }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }

  return result;
}

// ── 主题 ────────────────────────────────────────────────────────────

export interface LegadoTheme {
  themeName: string;
  isNightTheme: boolean;
  /** 都是 #AARRGGBB */
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  bottomBackground: string;
}

export interface ImportedTheme {
  id: string;
  name: string;
  night: boolean;
  bg: string;
  fg: string;
  accent: string;
  panel: string;
  line: string;
  muted: string;
}

export function looksLikeTheme(data: unknown): data is LegadoTheme {
  return (
    typeof data === 'object' && data !== null && 'themeName' in data && 'backgroundColor' in data
  );
}

/**
 * `#AARRGGBB` → `#RRGGBB`。
 * **顺序是 ARGB 不是 RGBA**——按 RGBA 读会把透明度当成红色，
 * 导进来的主题会整个偏色。
 */
export function argbToHex(argb: string): string {
  const s = argb.replace('#', '').trim();
  if (s.length === 8) return `#${s.slice(2)}`;
  if (s.length === 6) return `#${s}`;
  throw new Error(`认不出的颜色：${argb}`);
}

/** 算相对亮度，用来决定正文该用深色还是浅色字 */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 按比例把颜色往黑或白推一点，用来生成面板色和分隔线 */
function shift(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(c + 255 * amount))),
  );
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 转成本项目的主题。
 *
 * 那边只给了背景、主色、强调色，**没有正文颜色**——手机阅读器是按夜间模式
 * 自己定的。这里按背景亮度推：浅底配深字、深底配浅字。
 * 直接照抄一个固定的文字色，遇到深色主题会变成黑底黑字。
 */
export function convertTheme(t: LegadoTheme): ImportedTheme {
  const bg = argbToHex(t.backgroundColor);
  const night = t.isNightTheme || luminance(bg) < 0.5;
  const fg = night ? '#d8d5d0' : '#1f1f1f';

  return {
    id: `imported-${t.themeName.replace(/\s+/g, '-')}`,
    name: t.themeName,
    night,
    bg,
    fg,
    accent: argbToHex(t.accentColor),
    panel: argbToHex(t.bottomBackground ?? t.primaryColor),
    line: shift(bg, night ? 0.09 : -0.09),
    muted: shift(fg, night ? -0.22 : 0.32),
  };
}
