/**
 * 快捷键：**表上写了的动作，两个阅读界面都得真认。**
 *
 * 设置 → 阅读 → 快捷键 那张表遍历的是 `ACTION_NAMES`（7 行，每行都能改、都能还原）。
 * 而动作是**两个界面各自**的 keydown 处理里认的：`Reader.tsx` 一个 switch、
 * `FileViewer.tsx` 一串 if。加一个动作只改表不改处理，症状是**按了什么都不发生**，
 * 一句错都不报——和这个仓库反复抓的「有单测不等于有入口」是同一族的另一头：
 * **有绑定不等于有实现**。
 *
 * 2026-10-03 量到的就是这一形：`toc` / `bookmark` / `search` 三个动作
 * 在 txt 里都管用，在 PDF / EPUB 查看器里一个都没接（实测三个键全「无变化」）。
 *
 * 判据是**认处理器里有没有引用这个动作名**，不是认功能在不在——
 * 功能在、键没接，正是这一条要抓的。
 *
 *   node scripts/key-actions.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const 读 = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

/** 表上声明了哪些动作（这一份是唯一说法，别在这儿抄第二份清单） */
const 声明 = 读('../src/renderer/settings.ts');
const 块 = /ACTION_NAMES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(声明)?.[1];
if (!块) { console.error('✗ 找不到 ACTION_NAMES——它改名了？这条守卫不能默认通过'); process.exit(1); }
const 动作 = [...块.matchAll(/^\s*([a-zA-Z]+):/gm)].map((m) => m[1]);
if (动作.length < 5) { console.error(`✗ ACTION_NAMES 只认出 ${动作.length} 个动作，多半是解析坏了`); process.exit(1); }

/**
 * 某个界面认了哪些动作。
 *
 * 处理器不长，从 `actionFor(` 往后取一段就够——**取不到就报，别默认通过**：
 * 那个 `actionFor(` 被改名或被挪进别的函数，这条守卫就整个空转了。
 */
function 认了的(文件, 源) {
  /*
   * 认**真正的调用点**：`= actionFor(` 或 `switch (actionFor(`。
   * 找第一个 'actionFor(' 会先撞上注释——文件顶上那段就写着
   * 「两边共用 loadKeys() + actionFor() 那一份」，于是窗口取到注释里，
   * 整条守卫看着像「这个动作没接」。第一版就是这么误报 autoScroll 的。
   */
  const 匹 = /=\s*actionFor\(|switch\s*\(\s*actionFor\(/.exec(源);
  const 起 = 匹 ? 匹.index : -1;
  if (起 < 0) return null;
  const 段 = 源.slice(起, 起 + 2400);
  return 动作.filter((a) => new RegExp(`case '${a}'|=== '${a}'`).test(段));
}

/**
 * 豁免：**必须带理由**，而且理由要能在源码里找到落点。
 *
 * `exit` 在查看器里走的是硬编码的 Escape，不走 `actionFor`——
 * 判据写在 `FileViewer.tsx` 那段注释里（退出键可以改绑成普通字母，
 * 那时候在短评框里打那个字母不该把卡片关掉）。**这是有意的不同，不是漏。**
 */
const 豁免 = [
  { 文件: 'FileViewer.tsx', 动作: 'exit', 理由: 'Esc 单独认，不走 actionFor', 要搜到: '仍然单独认' },
];

const 界面 = ['Reader.tsx', 'FileViewer.tsx'];
const 报 = [];
for (const 名 of 界面) {
  const 源 = 读(`../src/renderer/${名}`);
  const 有 = 认了的(名, 源);
  if (!有) { 报.push(`${名}: 找不到 actionFor( 那个调用——这条守卫对它空转了`); continue; }
  for (const a of 动作) {
    if (有.includes(a)) continue;
    const 免 = 豁免.find((x) => x.文件 === 名 && x.动作 === a);
    if (免) {
      if (!源.includes(免.要搜到)) 报.push(`${名}: 「${a}」挂着豁免，但源码里找不到那句理由（${免.要搜到}）——豁免过期了就删掉`);
      continue;
    }
    报.push(`${名}: 表上写着「${a}」，处理器里没认——按了什么都不发生`);
  }
}

/* ── 自检：该报的必须报，不该报的必须不报。没有这一段等于加了个摆设 ── */
function 自检() {
  const 好 = `const x = () => { switch (actionFor(k, e.key)) {\n${动作.map((a) => `  case '${a}': break;`).join('\n')}\n} };`;
  const 坏 = `const x = () => { const a = actionFor(k, e.key); if (a === 'prev') {} };`;
  const 漏 = 动作.filter((a) => !(动作.filter((z) => new RegExp(`case '${z}'|=== '${z}'`).test(坏)).includes(a)));
  const 抓到了 = 漏.length > 0;
  const 没误报 = 认了的('夹具', 好)?.length === 动作.length;
  if (!抓到了) return '自检失败：夹具里明明只认了 prev，却报不出漏了哪些——判据是死的';
  if (!没误报) return '自检失败：一份「七个都认了」的夹具被报成有漏——判据画得太紧';
  if (认了的('夹具', '没有调用')) return '自检失败：找不到 actionFor 却返回了结果（应该返回 null 并报错）';
  return null;
}
const 自检错 = 自检();

if (自检错) { console.error('✗ ' + 自检错); process.exit(1); }
if (报.length) {
  console.error(`✗ 快捷键对账：${报.length} 处表上说了、界面上没做`);
  for (const r of 报) console.error('  ' + r);
  process.exit(1);
}
console.log(`✔ 快捷键对账：表上 ${动作.length} 个动作，${界面.join(' / ')} 两边都认（豁免各带一句能在源码里找到的理由）`);
