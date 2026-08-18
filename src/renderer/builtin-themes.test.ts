import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_THEMES } from './builtin-themes.ts';
import { DEFAULTS } from './settings.ts';

// 这个文件是发布前生成的（见 legado.ts 的 convertTheme），运行时不再转换。
// 所以出问题只可能出在生成的那一刻——这几条守的就是「生成出来的东西是能用的」。

test('内置主题 id 唯一且稳定，默认那个必须在', () => {
  const ids = BUNDLED_THEMES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  // id 是用户选中的主题存进 localStorage 的键，**改了等于让所有人的主题失效**
  // day/night/eye/paper 原来只活在 CSS 里，纸色和应用外观拆开后必须由 JS 拿到颜色，
  // 所以搬进了这份数据。**id 一个都没改**——那是用户选中的纸色存进 localStorage 的键
  assert.deepEqual(ids, [
    'day', 'night', 'eye', 'paper',
    'shuzhai-day', 'shuzhai-night', 'houmo-day', 'houmo-night', 'wx-day', 'wx-night',
  ]);
  // DEFAULTS.theme 指着它。对不上的话新用户开阅读器是一片没有配色的裸样式，
  // 而且不报错——只是所有颜色变量都没被写上去
  assert.ok(ids.includes(DEFAULTS.theme), `DEFAULTS.theme = ${DEFAULTS.theme}，但内置里没有`);
});

test('颜色都是合法的 hex，没有 ARGB 漏转的', () => {
  // 原文件是 8 位 ARGB（#ff000000），转换要剥掉 alpha。
  // 漏转的话 CSS 认不出来，主题一选就整片变透明或变黑，而且不报错
  for (const t of BUNDLED_THEMES) {
    for (const [k, v] of Object.entries(t)) {
      if (k === 'id' || k === 'name' || k === 'night') continue;
      assert.match(v as string, /^#[0-9a-f]{6}$/, `${t.name} 的 ${k} = ${String(v)}`);
    }
  }
});

// ── 纸色的两个客观判据 ─────────────────────────────────────────────
// 十张纸之间用眼睛来回比会疲劳失准，这两个数是算出来的。
// 实测发现过四处：日间/微信-日间对比 17:1（近黑压纯白，长读累）、
// 书斋-黑夜只有 3.12（低于 WCAG AA）、厚墨两张 panel === bg（根本没有正文栏）

const srgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h: string) => {
  const [r, g, b] = srgb(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** sRGB → CIELAB（D65）。ΔL 量层次，a*b* 量色温 */
const lab = (h: string) => {
  const [r, g, b] = srgb(h).map(lin);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};

/** CIE L*：明度，比原始亮度更接近人眼感觉 */
const lstar = (h: string) => {
  const y = lum(h);
  return y > 0.008856 ? 116 * y ** (1 / 3) - 16 : 903.3 * y;
};

test('每张纸的正文对比度都在区间里：够看，又不刺眼', () => {
  for (const t of BUNDLED_THEMES) {
    const c = ratio(t.fg, t.panel);
    assert.ok(c >= 4.5, `${t.name} 只有 ${c.toFixed(2)}:1，低于 WCAG AA 的 4.5`);
    // **上限也要管**：纯黑压纯白是 21:1，长时间读反而累——用户那份 legado 配置
    // 用 #262626 而不是 #000 正是这个道理
    assert.ok(c <= 15, `${t.name} 有 ${c.toFixed(2)}:1，近黑压纯白，长读会累`);
  }
});

test('次要文字读得到：章号、作者名、提示全靠它', () => {
  // **这一项一开始没量，所以一直不知道**：十张纸里七张的 muted 卡在 3.9–4.5，
  // 而它承载的是「第 514 / 573 章」「作者」「提示」——都是真要读的字。
  // 解法不是逐个拍颜色，是定义成「正文色朝纸色退一档」（见 builtin-themes.ts），
  // 色温自动跟着这张纸走，不会出现暖纸配冷灰
  for (const t of BUNDLED_THEMES) {
    const c = ratio(t.muted, t.panel);
    assert.ok(c >= 4.5, `${t.name} 的次要文字只有 ${c.toFixed(2)}:1，读不到`);
    assert.ok(c <= 9, `${t.name} 的次要文字 ${c.toFixed(2)}:1，和正文分不出主次`);
  }
});

test('分隔线看得见，但不抢眼', () => {
  // 微信阅读-夜间原来是 1.03——几乎和纸一个色，那条线等于没画
  for (const t of BUNDLED_THEMES) {
    const c = ratio(t.line, t.panel);
    assert.ok(c >= 1.15, `${t.name} 的分隔线只有 ${c.toFixed(2)}，看不见`);
    assert.ok(c <= 2.2, `${t.name} 的分隔线 ${c.toFixed(2)}，重得像框线`);
  }
});

/**
 * **强调色是当文字用的，判据要按文字来。**
 *
 * 原来这条按「非文字元素 3:1」判，理由写着「滑块、当前项、链接都靠它」——
 * 可那三样里有两样**是文字**：目录里当前那一章（`.toc-item[aria-current]`）、
 * 左轨当前那一格的标签。实测三张纸没过：微信-日间 3.06、书斋-白天 4.35
 * （**默认那张**）、羊皮纸 4.12，都是「看起来还行、量一下不够」。
 *
 * 两个底都要测：桌面色比纸色深，accent 压在桌上总是更吃力，
 * 而左轨恰恰浮在桌上。
 */
test('强调色当文字用得读得清——目录里的当前章、左轨的当前格都是它', () => {
  for (const t of BUNDLED_THEMES) {
    const onPanel = ratio(t.accent, t.panel);
    const onDesk = ratio(t.accent, t.bg);
    assert.ok(onPanel >= 4.5, `${t.name} 的强调色压在纸上只有 ${onPanel.toFixed(2)}:1`);
    assert.ok(onDesk >= 4.5, `${t.name} 的强调色压在桌上只有 ${onDesk.toFixed(2)}:1`);
  }
});

/*
 * 正文色压在**桌**上也要够看。
 *
 * 上面那条量的是「字压在纸上」（`fg` vs `panel`），而翻页模式下那几张
 * `position: sticky` 的卡片（划线配色、笔记、读完记一句）底色是 `--bg`——
 * 也就是**字压在桌上**，一个上面那条完全够不着的组合。
 * `styles.css` 里那条 `.reader-body.page-mode > .card` 的注释一度写着
 * 「对比度是同一档，builtin-themes.test.ts 钉着」，而当时**没有任何断言钉它**：
 * 桌纸明度差那条只管 bg 和 panel 差多少，`assert.notEqual(fg, bg)` 只禁止字面相同。
 * 与其把那句话删掉，不如让它变成真的。
 *
 * 「读完记一句」一本书只出现一次，错过就没了——这张卡的字看不清代价很实。
 */
test('正文色压在桌上也要够看：翻页模式那几张卡就是这么摆的', () => {
  for (const t of BUNDLED_THEMES) {
    const c = ratio(t.fg, t.bg);
    assert.ok(c >= 4.5, `${t.name} 的正文压在桌上只有 ${c.toFixed(2)}:1，低于 WCAG AA`);
    assert.ok(c <= 15, `${t.name} 的正文压在桌上 ${c.toFixed(2)}:1，近黑压纯白`);
  }
});

test('桌和纸是同一张桌上的两层，不能是两种色温', () => {
  // 只比 a*b*、不看明暗。暖纸配一张冷灰的正文栏，看起来像「贴了张别的纸」
  for (const t of BUNDLED_THEMES) {
    const [, a1, b1] = lab(t.bg);
    const [, a2, b2] = lab(t.panel);
    const gap = Math.hypot(a1 - a2, b1 - b2);
    assert.ok(gap <= 6, `${t.name} 桌纸色温差 ${gap.toFixed(1)}`);
  }
});

test('每张纸都看得出「正文栏」：桌和纸的明度差在区间里', () => {
  for (const t of BUNDLED_THEMES) {
    const d = Math.abs(lstar(t.bg) - lstar(t.panel));
    // 厚墨那两张原来 panel 和 bg 是同一个值，双色模型下等于没有正文栏
    assert.ok(d >= 1.5, `${t.name} 桌纸只差 ${d.toFixed(1)}，看不出正文栏`);
    assert.ok(d <= 12, `${t.name} 桌纸差 ${d.toFixed(1)}，割裂成两个色块`);
  }
});

test('前景和背景不能是一个颜色——那样正文就看不见了', () => {
  for (const t of BUNDLED_THEMES) {
    assert.notEqual(t.fg, t.bg, t.name);
    assert.notEqual(t.muted, t.bg, t.name);
  }
});

test('夜间主题的背景要真的比日间深', () => {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  };
  for (const t of BUNDLED_THEMES) {
    if (t.night) assert.ok(lum(t.bg) < 128, `${t.name} 标着夜间，背景却是亮的`);
    else assert.ok(lum(t.bg) > 128, `${t.name} 标着日间，背景却是暗的`);
  }
});
