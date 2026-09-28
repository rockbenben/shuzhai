/**
 * 字号这一面**现在长什么样** —— 一把尺子，不是守卫。
 *
 * ⚠️ **永远退出 0、什么都不断言**（同 `counts.mjs` 那一族）。它的用处是
 * 让「279 处内联字号、11 档取值」这件事不用重新 grep 一遍就能看见。
 * 什么时候该把它变成守卫？等真定下一套刻度的那天——在那之前
 * 报红只会让人学会无视它，而这个仓库已经为「大一统」否过一次了。
 *
 * 量的是两件事：**JSX 里写死的 `fontSize`**，和 **CSS 里写死的 `font-size`**。
 * 两边都数，是因为只数一边会得出错的结论——原来这两处还各写各的前导零
 * （`.85rem` / `0.85rem`），同一个值被算成两档。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const 扫 = (目录, 后缀) => readdirSync(目录)
  .filter((f) => f.endsWith(后缀))
  .map((f) => [join(目录, f), readFileSync(join(目录, f), 'utf8')]);

const 数 = (对, 正则, 取) => {
  const 档 = new Map();
  const 按文件 = new Map();
  let 总 = 0;
  for (const [文件, 源] of 对) {
    let 这文件 = 0;
    for (const m of 源.matchAll(正则)) {
      const 值 = 取(m);
      档.set(值, (档.get(值) ?? 0) + 1);
      总++; 这文件++;
    }
    if (这文件) 按文件.set(文件.replace(/^src\/renderer\//, ''), 这文件);
  }
  return { 档, 按文件, 总 };
};

const JSX = 数(扫('src/renderer', '.tsx'), /fontSize:\s*'([^']+)'/g, (m) => m[1]);
const CSS = 数(扫('src/renderer', '.css'), /font-size:\s*([0-9.]+rem)/g, (m) => m[1]);

const 列 = (档) => [...档.entries()].sort((a, b) => b[1] - a[1])
  .map(([值, 次]) => `    ${值.padEnd(9)} ×${次}`).join('\n');

const 前三 = [...JSX.档.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
const 占 = 前三.reduce((a, [, n]) => a + n, 0);

console.log(`内联 fontSize：${JSX.总} 处 / ${JSX.档.size} 档（写在三类里的话，前三档就占 ${占} 处、${Math.round(占 / JSX.总 * 100)}%）`);
console.log(列(JSX.档));
console.log(`\n按文件（前 8）：`);
console.log([...JSX.按文件.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  .map(([f, n]) => `    ${String(n).padStart(3)}  ${f}`).join('\n'));
console.log(`\nCSS 里的 font-size：${CSS.总} 处 / ${CSS.档.size} 档`);
console.log(列(CSS.档));
// 建议的落点**由当场量出来的前三档推**，不写死：哪天 0.8rem 用得比 0.85 多了，
// 这里跟着变，不会出现「文档里的建议已经过期」那种事。
// 值就是现在用得最多的那三个——**不发明新值**。
const 名 = ['say', 'say-sm', 'say-xs'];
console.log('\n要收的话，前三档建议落成：');
console.log(前三.map(([值, 次], i) =>
  `  .${名[i]} { font-size: ${值} }   ← 现在这样内联写的有 ${次} 处`).join('\n'));
console.log('\n这不是缺陷清单，也不报红。要收哪几档、收成什么样，是设计决定，不是尺子能定的。');
