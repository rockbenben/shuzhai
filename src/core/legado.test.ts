import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import {
  translateJavaRegex,
  runJsReplacement,
  convertRules,
  importCleanRules,
  argbToHex,
  convertTheme,
  looksLikeCleanRules,
  looksLikeTheme,
  type LegadoRule,
} from './legado.ts';
import { cleanText, loadCleanRules, applyWholeRulesDetailed, type CleanRule } from './clean.ts';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-legado-'));
  db = openDb(join(dir, 'library.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── 正则方言翻译 ─────────────────────────────────────────

test('内联标志被提成 flags', () => {
  const t = translateJavaRegex('(?i)abc');
  assert.equal(t.source, 'abc');
  assert.ok(t.flags.includes('i'));

  const t2 = translateJavaRegex('(?mi)^x$');
  assert.equal(t2.source, '^x$');
  assert.ok(t2.flags.includes('m') && t2.flags.includes('i'));
});

test('内联标志出现在中间也能处理', () => {
  const t = translateJavaRegex('abc(?s).*def');
  assert.equal(t.source, 'abc.*def');
  assert.ok(t.flags.includes('s'));
});

test('占有量词退化成贪婪', () => {
  const t = translateJavaRegex('a++b*+c?+');
  assert.equal(t.source, 'a+b*c?');
  assert.ok(t.notes.some((n) => n.includes('占有量词')));
});

test('\\h 换成水平空白字符类', () => {
  const t = translateJavaRegex('a\\hb');
  assert.equal(t.source, 'a[ \\t]b');
  assert.ok(new RegExp(t.source).test('a b'));
  assert.ok(new RegExp(t.source).test('a\tb'));
  assert.ok(!new RegExp(t.source).test('a\nb'), '\\h 是水平空白，不该匹配换行');
});

test('字符类**里面**的 \\h 不能替换', () => {
  // [\h\d] 里塞一个 [ \t] 进去会变成嵌套字符类，语义就错了
  const t = translateJavaRegex('[\\h\\d]');
  assert.equal(t.source, '[\\h\\d]', '类里面的原样留着');
});

test('Java 的 \\v 是垂直空白类，不是垂直制表符', () => {
  const t = translateJavaRegex('a\\vb');
  const re = new RegExp(t.source);
  assert.ok(re.test('a\nb'), 'Java 的 \\v 要能匹配换行');
  assert.ok(re.test('a\rb'));
  assert.ok(!re.test('a b'), '但不匹配普通空格');
});

test('转义过的 \\\\h 不该被当成 \\h', () => {
  const t = translateJavaRegex('a\\\\hb');
  assert.equal(t.source, 'a\\\\hb', '这是「反斜杠 + 字母 h」，不是水平空白');
});

// ── @js: 沙箱 ────────────────────────────────────────────

test('@js 脚本能跑，拿得到 result', () => {
  assert.equal(runJsReplacement('return result.toUpperCase();', 'abc'), 'ABC');
  assert.equal(runJsReplacement('R=result; return R=="·"?"。":R;', '·'), '。');
});

test('沙箱里没有 require / process / fs', () => {
  // 规则文件是从外面导进来的，它只是在改一段要显示的文字，
  // 不该能碰这台机器上的任何东西
  for (const probe of [
    'return typeof require;',
    'return typeof process;',
    'return typeof globalThis.process;',
    'return typeof fetch;',
  ]) {
    const out = runJsReplacement(probe, 'x');
    assert.equal(out, 'undefined', probe);
  }
});

test('脚本报错时当这条规则没生效，不让正文打不开', () => {
  assert.equal(runJsReplacement('throw new Error("坏了")', '原文'), '原文');
  assert.equal(runJsReplacement('这不是合法的 JS !!!', '原文'), '原文');
});

test('死循环会被超时掐掉，不拖住阅读器', () => {
  const t0 = Date.now();
  assert.equal(runJsReplacement('while(true){}', '原文'), '原文');
  assert.ok(Date.now() - t0 < 3000, '应该在超时后很快返回');
});

test('脚本返回 undefined 时保留原文', () => {
  assert.equal(runJsReplacement('var x = 1;', '原文'), '原文');
});

// ── 规则转换与落库 ───────────────────────────────────────

const sample: LegadoRule[] = [
  { name: '去广告', pattern: '(?i)本站域名.*', replacement: '', isEnabled: true, isRegex: true },
  { name: '纯文本', pattern: 'a.b(c)', replacement: 'X', isEnabled: true, isRegex: false },
  { name: '坏正则', pattern: '(未闭合', replacement: '', isEnabled: true, isRegex: true },
];

test('转换：好的进来、坏的挑出来', () => {
  const { rules, result } = convertRules(sample);
  assert.equal(result.imported, 2);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].name, '坏正则');
  assert.ok(rules.every((r) => r.whole), '导进来的都是整章模式');
});

test('导进来的规则一律先停用，哪怕文件里写着 isEnabled: true', () => {
  // 这些规则是给另一个正则引擎写的，翻译过来语义可能有出入——
  // 实测真有一条会把正文整段吃掉。让用户对着 diff 预览一条条开，
  // 比默认全开然后某天发现正文少了半章要好
  const { rules } = convertRules(sample);
  assert.ok(rules.every((r) => !r.enabled), '文件里 isEnabled 是 true 也不能直接开');
});

test('isRegex=false 的按纯文本处理，特殊字符被转义', () => {
  const { rules } = convertRules([sample[1]]);
  const re = new RegExp(rules[0].pattern, rules[0].flags);
  assert.ok(re.test('a.b(c)'), '要能匹配字面量');
  assert.ok(!new RegExp(rules[0].pattern).test('axbc'), '`.` 不该还是通配符');
});

test('落库并去重，导两次不会翻倍', () => {
  importCleanRules(db, sample);
  const n1 = (db.prepare('select count(*) n from clean_rule').get() as { n: number }).n;
  importCleanRules(db, sample);
  const n2 = (db.prepare('select count(*) n from clean_rule').get() as { n: number }).n;
  assert.equal(n1, 2);
  assert.equal(n2, 2);
});

test('导进来的规则在清洗时真的生效，而且是整章模式', () => {
  importCleanRules(db, [
    // 跨行匹配：按行套的话这条永远匹配不上
    { name: '合并断行', pattern: '(?s)【广告开始】.*?【广告结束】', replacement: '', isRegex: true, isEnabled: true },
  ]);
  // 导入默认是停用的，用户在界面上开了才生效——这里模拟他开了
  db.prepare('update clean_rule set enabled = 1').run();
  const rules = loadCleanRules(db);
  // 正文要够长，否则删掉广告块本身就超过四成，会被缩水保护挡下
  const body = '正文正文正文正文正文正文正文正文正文正文。'.repeat(4);
  const text = `${body}\n【广告开始】\n买它\n【广告结束】\n${body}`;
  const out = cleanText(text, rules);

  assert.ok(!out.includes('买它'), '跨行的广告块应被整段删掉');
  assert.ok(out.includes('正文正文'));
});

test('带 @js 的替换在清洗链路里也能跑通', () => {
  importCleanRules(db, [
    { name: '标点归一', pattern: '[·．]', replacement: '@js:return "。";', isRegex: true, isEnabled: true },
  ]);
  db.prepare('update clean_rule set enabled = 1').run();
  const out = cleanText('他说·然后走了．', loadCleanRules(db));
  assert.equal(out, '他说。然后走了。');
});

// ── 主题 ─────────────────────────────────────────────────

test('ARGB 转十六进制，顺序不能当成 RGBA', () => {
  // #fff9f2e8 是 alpha=ff, rgb=f9f2e8。按 RGBA 读会把 ff 当成红色，整个偏色
  assert.equal(argbToHex('#fff9f2e8'), '#f9f2e8');
  assert.equal(argbToHex('#ff3897f1'), '#3897f1');
  assert.equal(argbToHex('#f9f2e8'), '#f9f2e8', '六位的原样返回');
  assert.throws(() => argbToHex('#abc'), /认不出的颜色/);
});

test('深色主题要配浅色字，不能照抄一个固定文字色', () => {
  const night = convertTheme({
    themeName: '微信阅读 - 夜间',
    isNightTheme: true,
    primaryColor: '#ff000000',
    accentColor: '#ff3897f1',
    backgroundColor: '#ff000000',
    bottomBackground: '#ff1a1a1a',
  });
  assert.equal(night.bg, '#000000');
  assert.equal(night.night, true);
  assert.ok(parseInt(night.fg.slice(1), 16) > 0x888888, '黑底必须配浅字，否则黑底黑字');

  const day = convertTheme({
    themeName: '厚墨 - 日间',
    isNightTheme: false,
    primaryColor: '#fff9f2e8',
    accentColor: '#ff404048',
    backgroundColor: '#fff9f2e8',
    bottomBackground: '#fff9f2e8',
  });
  assert.equal(day.bg, '#f9f2e8');
  assert.ok(parseInt(day.fg.slice(1), 16) < 0x888888, '浅底配深字');
});

test('标成日间但背景其实很暗时，按实际亮度走', () => {
  const t = convertTheme({
    themeName: '标错了的主题',
    isNightTheme: false,
    primaryColor: '#ff111111',
    accentColor: '#ff3897f1',
    backgroundColor: '#ff111111',
    bottomBackground: '#ff111111',
  });
  assert.equal(t.night, true, '文件里说日间，但背景是近黑色——照它说的会变成黑底黑字');
});

test('认得出哪个文件是规则、哪个是主题', () => {
  assert.ok(looksLikeCleanRules(sample));
  assert.ok(!looksLikeCleanRules({ themeName: 'x', backgroundColor: '#fff' }));
  assert.ok(looksLikeTheme({ themeName: 'x', backgroundColor: '#fff' }));
  assert.ok(!looksLikeTheme(sample));
});


test('删掉正文四成以上的规则会被整条作废', () => {
  // 最后一道闸：广告没删干净只是碍眼，正文被吃掉用户根本发现不了。
  // 那份真实规则里的「#07 标点——」就会把 80 字压成 32 字
  const greedy: CleanRule[] = [
    { name: '贪吃鬼', pattern: '[^\n]+', replacement: '——', enabled: true, flags: 'g', whole: true },
  ];
  const text = '这是一段完整的正文，不该被一条规则整段吃掉。'.repeat(3);
  const r = applyWholeRulesDetailed(text, greedy);

  assert.equal(r.text, text, '删太多就当这条没生效');
  assert.deepEqual(r.rejected, ['贪吃鬼'], '要说出是哪条被作废了');
});

test('一条坏规则不该连累其它规则', () => {
  const mixed: CleanRule[] = [
    { name: '正常的', pattern: '广告', replacement: '', enabled: true, flags: 'g', whole: true },
    // 注意双反斜杠：TS 字符串里 '\s' 会退化成 's'，正则就变成只匹配字母 s 了
    { name: '贪吃鬼', pattern: '[\\s\\S]+', replacement: 'x', enabled: true, flags: 'g', whole: true },
  ];
  const text = '正文正文正文广告正文正文正文正文正文正文';
  const r = applyWholeRulesDetailed(text, mixed);

  assert.ok(!r.text.includes('广告'), '正常那条要照常生效');
  assert.deepEqual(r.rejected, ['贪吃鬼']);
});
