/**
 * 应用外壳那套颜色的对比度。
 *
 * `builtin-themes.test.ts` 守的是**阅读纸色**（`--read-*`），这一份守的是
 * 书架、侧栏、对话框用的那一套。补它是因为真出过两处，而且都不报错：
 *
 * 1. `--accent` 当小字用时压在**页面底色**上只有 4.12——「读到 2/60 · 3个月前」
 *    那行、选中的标签正好落在那儿。（压在 `--panel` 上是 4.53，勉强过，
 *    所以只测其中一个会漏掉。）
 * 2. `.primary` 主按钮在**夜间**是白字压浅金色，2.46——每个弹窗里最该看清的
 *    那个按钮几乎读不出来。亮暗两边都写 `color: #fff` 是最容易犯的错：
 *    填充色在两边的亮度是**反的**。
 *
 * 直接从 styles.css 里读变量，不是在测试里抄一份——抄的那份不会跟着改。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

/** 取某个选择器块里的自定义属性 */
function vars(selector: string): Record<string, string> {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `styles.css 里找不到 ${selector}`);
  const block = css.slice(i, css.indexOf('\n}', i));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)) out[m[1]] = m[2];
  return out;
}

const hex = (h: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];

const lum = (c: [number, number, number]) => {
  const [r, g, b] = c.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 对比度 */
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(hex(a)), lum(hex(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** accent 12% 混进底色——选中的 chip 就是这个底 */
const tint = (accent: string, base: string, p = 0.12): string => {
  const [a, b] = [hex(accent), hex(base)];
  return `#${a.map((v, i) => Math.round(v * p + b[i] * (1 - p)).toString(16).padStart(2, '0')).join('')}`;
};

const day = vars(':root {');
const night = vars(":root[data-theme='night']");

/**
 * **反证：把改之前的两个值放回来，上面那几条必须失败。**
 *
 * 照 `api.test.ts` 那条「故意用错误写法证明它可写」的先例——一条永远绿的
 * 断言和没有断言是一回事，而这几条的阈值是量出来的，很容易被下一轮
 * 「调个颜色」调到刚好不触发。
 */
test('这几条不是摆设：改之前的值确实过不了', () => {
  assert.ok(ratio('#8a6d3b', day.bg) < 4.5, '旧 accent 压在页面底色上本来就不够');
  assert.ok(ratio('#ffffff', night.accent) < 4.5, '夜间主按钮的白字本来就读不清');
  assert.ok(ratio(night.danger, night.panel) < 4.5, '夜间的填充红当文字本来就读不清');
  // 印泥两边不同值的**唯一**理由：日间那枚印压在夜间的深纸上就是个红点
  assert.ok(ratio('#a8332a', night.bg) < 3, '日间那枚印在夜间的纸上本来就看不见');
});

for (const [name, v] of [['日间', day], ['夜间', night]] as const) {
  test(`${name}：accent 当小字用，两种底色上都要过 AA`, () => {
    // **两个都要测**：日间 accent 压 panel 是 4.53、压 bg 只有 4.12，
    // 只测 panel 会放过真正出问题的那一个
    assert.ok(ratio(v.accent, v.panel) >= 4.5, `accent/panel = ${ratio(v.accent, v.panel).toFixed(2)}`);
    assert.ok(ratio(v.accent, v.bg) >= 4.5, `accent/bg = ${ratio(v.accent, v.bg).toFixed(2)}`);
  });

  test(`${name}：选中的标签，字压在自己的淡底上`, () => {
    const chip = tint(v.accent, v.panel);
    assert.ok(ratio(v.accent, chip) >= 4.5, `accent/chip = ${ratio(v.accent, chip).toFixed(2)}`);
  });

  test(`${name}：主按钮和危险按钮的字压在填充色上`, () => {
    assert.ok(
      ratio(v['on-accent'], v.accent) >= 4.5,
      `on-accent/accent = ${ratio(v['on-accent'], v.accent).toFixed(2)}`,
    );
    // danger 按钮和角标都是白字
    assert.ok(ratio('#ffffff', v.danger) >= 4.5, `白/danger = ${ratio('#ffffff', v.danger).toFixed(2)}`);
  });

  /**
   * 危险色分两支的理由：**填充和文字的诉求在亮暗两边是反的**。
   * 夜间那个中深红当填充刚好（白字压得住 5.80），当文字压在深纸上只有 2.86——
   * 而「其中 3 个不是完全重复，删掉那份内容就没了」这种话恰恰最该看清。
   */
  test(`${name}：危险提示当文字读得清`, () => {
    const onPanel = ratio(v['danger-ink'], v.panel);
    const onBg = ratio(v['danger-ink'], v.bg);
    assert.ok(onPanel >= 4.5, `danger-ink/panel = ${onPanel.toFixed(2)}`);
    assert.ok(onBg >= 4.5, `danger-ink/bg = ${onBg.toFixed(2)}`);
  });

  /**
   * **评分印**（「我的书评」那一档）。两条，缺一条都不够：
   *
   * 1. 印上那个汉字是白的 —— 4.5，正常文字那条线。
   * 2. **印本身也要在纸上看得见** —— 3.0，WCAG 1.4.11 给图形元件的那条线。
   *    只测第一条会漏掉真正出过的那种情况：白字在印上好好的，
   *    而整枚印糊进夜间的深底色里，屏幕上只剩一个红点。
   */
  test(`${name}：评分印，白字读得清、印在纸上看得见`, () => {
    assert.ok(ratio('#ffffff', v.seal) >= 4.5, `白/seal = ${ratio('#ffffff', v.seal).toFixed(2)}`);
    assert.ok(ratio(v.seal, v.bg) >= 3, `seal/bg = ${ratio(v.seal, v.bg).toFixed(2)}`);
  });

  test(`${name}：正文和次要文字`, () => {
    assert.ok(ratio(v.fg, v.bg) >= 7, `fg/bg = ${ratio(v.fg, v.bg).toFixed(2)}`);
    assert.ok(ratio(v.muted, v.bg) >= 4.5, `muted/bg = ${ratio(v.muted, v.bg).toFixed(2)}`);
    assert.ok(ratio(v.muted, v.panel) >= 4.5, `muted/panel = ${ratio(v.muted, v.panel).toFixed(2)}`);
  });
}
