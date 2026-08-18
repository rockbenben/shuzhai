// 正文清洗（spec §2.4）。
//
// **运行时套用，原文件一个字节都不改。** 清洗只发生在把正文送去显示或导出的路上，
// 数据库里也不存清洗后的正文——存了就等于把「不存正文」那条原则毁掉。
//
// 规则是**按行**套的。这不是偷懒：网文正文里的垃圾（章尾广告、站点水印、
// 手机站提示）本来就是独占一行的，按行判既准又能直接给出「这一行被哪条规则删了」，
// 而这正是 diff 预览要显示的东西。

export interface CleanRule {
  id?: number;
  name: string;
  /** 正则源码 */
  pattern: string;
  /**
   * 替换成什么。替换后整行为空 → 这一行被删掉。
   * `@js:` 开头的是一段脚本，见 legado.ts 的 runJsReplacement
   */
  replacement: string;
  enabled: boolean;
  /** 一句话说明这条规则干什么。内置规则都写了——十几条规则光看名字判断不了该不该开 */
  note?: string;
  /** 正则 flags。不传按内置规则的老规矩用 `gu` */
  flags?: string;
  /**
   * 整章一起套，而不是按行。
   *
   * 绝大多数内置规则都是按行的——网文里的垃圾本来就独占一行，按行判既准，
   * 又能在 diff 预览里说清「这一行被哪条规则删了」。只有「删到章尾」这类
   * 天生跨行的才用整章模式，而它们也正是默认关着的那几条。
   */
  whole?: boolean;
}

/**
 * 内置规则（spec §2.4）。都是网文 txt 里最常见的几类噪音。
 * 措辞上尽量收窄：宁可漏掉几条广告，也不要误删正文——
 * 正文被吃掉是用户发现不了的，而广告留着只是碍眼。
 */
export const BUILTIN_CLEAN_RULES: CleanRule[] = [
  {
    name: '章尾广告行',
    note: '「手机站阅读」「请记住本站」「最新章节请访问」这类整行的广告',
    pattern:
      '^\\s*(手机站?阅读|请记住本站|最新章节请访问|一秒记住|天才一秒记住|手机用户请浏览|本书首发|请到|更新最快|^www\\.).*$',
    replacement: '',
    enabled: true,
  },
  {
    name: '含网址的整行',
    note: '整行就是个网址，或者网址前面挂着一句推广。句子里提到网址的不算',
    pattern: '^\\s*\\S*(https?://|www\\.|\\.com|\\.net|\\.org|\\.cc)\\S*\\s*$',
    replacement: '',
    enabled: true,
  },
  {
    name: '去行首尾空白',
    note: '剥掉每行首尾的空格和全角空格。段首缩进不受影响——那是阅读器按你的排版设置画上去的',
    pattern: '^[\\s\\u3000]+|[\\s\\u3000]+$',
    replacement: '',
    enabled: true,
  },
];

/** 缩进统一是可选的，默认不开——有人就喜欢原样（spec §2.4 写的是「可选」） */
export const INDENT_RULE: CleanRule = {
  name: '全角空格缩进统一',
  note: '给每个自然段开头补两个全角空格。有人就喜欢原样，所以默认关',
  pattern: '^(?=\\S)',
  replacement: '　　',
  enabled: false,
};

export interface CleanedLine {
  before: string;
  /** null 表示这一行被删掉了 */
  after: string | null;
  /** 动过它的规则名，没动过就是 undefined */
  by?: string;
}

function compile(rules: CleanRule[]): Array<{ name: string; re: RegExp; replacement: string }> {
  const out: Array<{ name: string; re: RegExp; replacement: string }> = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    try {
      // 导进来的规则自带 flags（可能有 i/m/s）；内置的沿用老规矩 gu
      out.push({ name: r.name, re: new RegExp(r.pattern, r.flags ?? 'gu'), replacement: r.replacement });
    } catch {
      // 坏正则跳过而不是让整章打不开。规则编辑器那边会单独校验并报错
    }
  }
  return out;
}

/**
 * 一条整章规则最多允许删掉多少比例的正文。
 *
 * **这是防「正文被吃掉」的最后一道闸。** 从阅读/乌云导进来的规则是给另一个
 * 正则引擎写的，方言翻译过来语义可能有微妙出入——实测那份规则里的
 * 「#07 标点——」会把一段 80 字的测试正文压成 32 字，整段变成「——」。
 *
 * 广告没删干净只是碍眼，正文被吃掉用户根本发现不了。所以宁可让规则失效。
 */
const MAX_SHRINK = 0.4;

export interface WholeResult {
  text: string;
  /** 因为删得太多而被跳过的规则名 */
  rejected: string[];
}

/**
 * 整章模式的规则：在切行**之前**对全文套一遍。
 * 替换里带 `@js:` 时逐个匹配跑脚本。
 *
 * **逐条检查缩水比例**：某条规则一下子删掉四成以上正文，就当它没生效。
 * 逐条判而不是最后统一判——一条坏规则不该让其它十几条一起作废。
 */
export function applyWholeRulesDetailed(text: string, rules: CleanRule[]): WholeResult {
  let out = text;
  const rejected: string[] = [];

  for (const rule of compile(rules.filter((r) => r.whole))) {
    const before = out;
    const next = rule.replacement.startsWith('@js:')
      ? out.replace(rule.re, (m) => runJsReplacement(rule.replacement.slice(4), m))
      : out.replace(rule.re, rule.replacement);

    if (before.length > 0 && next.length < before.length * (1 - MAX_SHRINK)) {
      rejected.push(rule.name);
      continue; // 保留 before，当这条没生效
    }
    out = next;
  }

  return { text: out, rejected };
}

export function applyWholeRules(text: string, rules: CleanRule[]): string {
  return applyWholeRulesDetailed(text, rules).text;
}

/**
 * 逐行套规则，返回每一行的前后对照。**diff 预览和真正的清洗共用这一个函数**，
 * 于是「预览里看到的」和「实际生效的」不可能不一致。
 */
export function cleanLines(text: string, rules: CleanRule[], collapseBlank = true): CleanedLine[] {
  const compiled = compile(rules.filter((r) => !r.whole));
  const out: CleanedLine[] = [];
  let blankRun = 0;

  // 先把行尾的 \r 摘掉再比对。**CRLF 是文件格式，不是内容**——
  // 不摘的话「去行首尾空白」会命中每一行，于是「这行被改过吗」对 CRLF 文件
  // 永远是「是」（实测这个库 99.4% 的行都这样），diff 预览被它刷屏，
  // 真正该给用户看的删行反而挤不进去
  for (const raw of text.split('\n')) {
    const before = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let after = before;
    let by: string | undefined;

    for (const rule of compiled) {
      const next = after.replace(rule.re, rule.replacement);
      if (next !== after) {
        after = next;
        by ??= rule.name;
      }
    }

    // 本来有字、清完变空 → 这行是垃圾，删掉
    if (after.trim() === '' && before.trim() !== '') {
      out.push({ before, after: null, by });
      continue;
    }

    if (after.trim() === '') {
      blankRun++;
      // 连续空行只留一个（spec §2.4）
      if (collapseBlank && blankRun > 1) {
        out.push({ before, after: null, by: '合并连续空行' });
        continue;
      }
    } else {
      blankRun = 0;
    }

    out.push({ before, after, by });
  }

  return out;
}

/**
 * 清洗后的正文。阅读器和导出都走这条。
 * **顺序是先整章、后按行**——整章规则里有跨行的标点修复，
 * 先切行会让它们全部失配。
 */
export function cleanText(text: string, rules: CleanRule[], collapseBlank = true): string {
  return cleanLines(applyWholeRules(text, rules), rules, collapseBlank)
    .filter((l) => l.after !== null)
    .map((l) => l.after)
    .join('\n');
}

/** 只挑出「有变化」的行给预览用——一整章全列出来，用户根本找不到改了哪儿 */
export function cleanDiff(text: string, rules: CleanRule[], limit = 60): CleanedLine[] {
  const changed = cleanLines(text, rules).filter((l) => l.after === null || l.after !== l.before);

  // **删行优先**。名额有限，而整行删除是唯一会丢内容的操作，用户最该过目的就是它。
  // 按原顺序截断的话，一条命中每行的规则（比如剥缩进）就能把名额占满，
  // 章末的广告删除永远排不进来，预览等于没有
  const dropped = changed.filter((l) => l.after === null);
  const edited = changed.filter((l) => l.after !== null);
  return [...dropped.slice(0, limit), ...edited].slice(0, limit);
}

/** 校验一条规则能不能用。规则编辑器保存前调 */
export function validateRule(pattern: string): void {
  try {
    new RegExp(pattern, 'gu');
  } catch (e) {
    throw new Error(`正则无效：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── 规则的持久化 ──────────────────────────────────────────────────
//
// **内置规则是代码常量，不往库里灌种子数据。** 灌了之后升级时它们就成了「用户数据」，
// 改一条内置规则要写迁移，而用户那份可能已经被改过——分不清哪些该覆盖。
// 库里只存两样：用户自己加的规则，以及「用户停用了哪些内置规则」。

import type { DatabaseSync } from 'node:sqlite';
import { getSetting, setSetting } from './db.ts';
import { runJsReplacement } from './legado.ts';
import { PURIFY_RULES } from './builtin-rules.ts';

/**
 * 全部内置规则。**顺序就是负数 id 的来源**（见 listCleanRules），
 * 所以新的只能往后加——插在中间会让用户已经存下的启停设置对错行。
 */
function allBuiltins(): CleanRule[] {
  return [...BUILTIN_CLEAN_RULES, INDENT_RULE, ...PURIFY_RULES];
}

const DISABLED_KEY = 'clean.disabledBuiltins';

/**
 * 内置规则的启停覆盖：`{ 规则名: 用户要它开还是关 }`。没记的就按规则自带的默认。
 *
 * ⚠️ 这里原本存的是一个「被停用的名字」数组，判定写成 `r.enabled && !off.has(name)`。
 * 那个写法对默认**开**的规则是对的，但**默认关的规则永远开不起来**——
 * `false && 任何值` 还是 false，界面上勾了、设置也存下来了，就是不生效，
 * 不报错也不留痕。默认关的内置规则（缩进统一、下面二十条乌云净化）全中招。
 * 改成覆盖表之后两个方向都能表达。
 *
 * 老的数组格式还认——读到数组就当成「这些是被关掉的」。
 */
function builtinOverrides(db: DatabaseSync): Record<string, boolean> {
  try {
    const raw = JSON.parse(getSetting(db, DISABLED_KEY) || '{}') as unknown;
    if (Array.isArray(raw)) return Object.fromEntries((raw as string[]).map((n) => [n, false]));
    return (raw ?? {}) as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** 内置规则最终开不开：用户表过态就听用户的，否则按规则自带的默认 */
function builtinEnabled(r: CleanRule, ov: Record<string, boolean>): boolean {
  return ov[r.name] ?? r.enabled;
}

export function setBuiltinEnabled(db: DatabaseSync, name: string, enabled: boolean): void {
  const ov = builtinOverrides(db);
  ov[name] = enabled;
  setSetting(db, DISABLED_KEY, JSON.stringify(ov));
}

/**
 * 这本书生效的全部规则 = 内置（去掉被停用的）+ 全局自定义 + 这本书专属。
 * 不传 bookId 就只算内置和全局的。
 */
export function loadCleanRules(db: DatabaseSync, bookId?: number): CleanRule[] {
  const ov = builtinOverrides(db);
  const builtin = allBuiltins().map((r) => ({ ...r, enabled: builtinEnabled(r, ov) }));

  const custom = db
    .prepare(
      `select id, name, pattern, replacement, enabled, flags, whole from clean_rule
        where scope = 'global' or (scope = 'book' and book_id = ?)
        order by sort_order, id`,
    )
    .all(bookId ?? -1) as unknown as Array<{
    id: number;
    name: string;
    pattern: string;
    replacement: string;
    enabled: number;
    flags: string | null;
    whole: number | null;
  }>;

  return [
    ...builtin,
    ...custom.map((c) => ({
      ...c,
      enabled: c.enabled === 1,
      flags: c.flags ?? undefined,
      whole: c.whole === 1,
    })),
  ];
}

export interface CleanRuleRow extends CleanRule {
  id: number;
  scope: 'global' | 'book';
  book_id: number | null;
  builtin?: boolean;
}

/** 列出规则给设置界面看。内置的带 builtin 标记，只能启停不能删 */
export function listCleanRules(db: DatabaseSync): CleanRuleRow[] {
  const ov = builtinOverrides(db);
  const builtin = allBuiltins().map((r, i) => ({
    ...r,
    id: -(i + 1), // 负数 id，跟库里的自增 id 不会撞
    scope: 'global' as const,
    book_id: null,
    builtin: true,
    enabled: builtinEnabled(r, ov),
  }));

  // 库里 enabled 是 0/1，接口上是 boolean——中间这一层类型不能直接交叉，
  // 得先按库的形状取出来再转
  const custom = db
    .prepare('select id, name, pattern, replacement, enabled, scope, book_id from clean_rule order by sort_order, id')
    .all() as unknown as Array<{
    id: number;
    name: string;
    pattern: string;
    replacement: string;
    enabled: number;
    scope: 'global' | 'book';
    book_id: number | null;
  }>;

  return [...builtin, ...custom.map((c) => ({ ...c, enabled: c.enabled === 1 }))];
}

export function addCleanRule(
  db: DatabaseSync,
  rule: { name: string; pattern: string; replacement?: string; scope?: 'global' | 'book'; bookId?: number },
): { id: number } {
  validateRule(rule.pattern);
  if (!rule.name.trim()) throw new Error('规则名不能为空');
  const id = Number(
    db
      .prepare('insert into clean_rule(name, pattern, replacement, scope, book_id) values(?,?,?,?,?)')
      .run(
        rule.name.trim(),
        rule.pattern,
        rule.replacement ?? '',
        rule.scope ?? 'global',
        rule.bookId ?? null,
      ).lastInsertRowid,
  );
  return { id };
}

export function removeCleanRule(db: DatabaseSync, id: number): void {
  if (id < 0) throw new Error('内置规则不能删除，只能停用');
  db.prepare('delete from clean_rule where id = ?').run(id);
}

export function setCleanRuleEnabled(db: DatabaseSync, id: number, enabled: boolean): void {
  if (id < 0) {
    const all = allBuiltins();
    const rule = all[-id - 1];
    if (!rule) throw new Error('没有这条内置规则');
    setBuiltinEnabled(db, rule.name, enabled);
    return;
  }
  db.prepare('update clean_rule set enabled = ? where id = ?').run(enabled ? 1 : 0, id);
}
