/**
 * 钉住「筛选编辑器有哪些条件」这件事**只有一份说法**。
 *
 * `App.tsx` 顶上那两颗入口键（「筛选」「＋ 新建分类」）的 `title` 是在介绍
 * 这一台编辑器能干什么。原来两处各写了一份清单、写得不一样，
 * 而刚加进来的「字数」两边都没提。**一句介绍功能的提示，手写就一定会飘。**
 * 现在那句从 `CategoryDialog` 导出的 `COND_GROUPS` 推出来，
 * 而这一条查的是：**`COND_GROUPS` 和那一屏真的摆出来的行对不对得上**。
 *
 * 为什么放在这里而不是单元测试：`.tsx` 里的 JSX 用 `node --test` 跑不了
 * （原生剥类型不认 `.tsx`，同 `core/pacing.ts` 那个理由），所以按静态走查做。
 *
 * 跑法：`node scripts/cond-groups.mjs`（在 `lint:ui` 里）
 */
import { readFileSync } from 'node:fs';

const 源 = readFileSync('src/renderer/CategoryDialog.tsx', 'utf8');

// COND_GROUPS 里登记的名字
const 块 = /export const COND_GROUPS = \[([\s\S]*?)\]/.exec(源);
if (!块) {
  console.error('✗ 找不到 COND_GROUPS 了——它被改名或删掉的话，App.tsx 那句提示就成了无源之水');
  process.exit(1);
}
const 登记 = [...块[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

/*
 * 屏上真的摆出来的行，两种写法：
 *   一组('格式', …)                     —— 芯片那几排
 *   <span className="cond-label">文件夹  —— 下拉和输入框那两排
 * ⚠️ 「名字」那一行不算条件（它是分类名，不是筛选条件），所以显式排掉。
 */
const 出现 = new Set();
/*
 * ⚠️ **先去掉注释再匹配。** 第一版没去，于是**我自己写的那条解释注释**
 * （里面照抄了那个 class 名）被当成屏上真摆了一行，报「COND_GROUPS 写了、
 * 屏上没有」。这个仓库记过同一个形状：「把当时那句错的指针原样引一遍，
 * 筛子会再报你一次」。
 */
const 去注释 = (文本) => 文本.split('\n')
  .map((行) => (/^\s*(\/\/|\*|\/\*)/.test(行) ? '' : 行)).join('\n');
const 净 = 去注释(源);
for (const m of 净.matchAll(/一组\(\s*'([^']+)'/g)) 出现.add(m[1]);
// 标签的写法有两种：`>文件夹</span>` 一行搞定，和 `>` 换行再写词（后面跟着
// 一个说明用的 .cond-hint）。两种都要认——只认前一种的话，
// 「字数」这一行会**看起来不存在**，于是新加一个条件反而被尺子打回。
for (const m of 净.matchAll(/className="cond-label">\s*([^<>\n]+?)\s*(?:\n|<\/span>)/g)) {
  const 名 = m[1].trim();
  // 只收「一行就是一个词」的那种。`{标题}` 是 `一组()` 那个助手自己的形参；
  // 带引号或顿号的是把解释写在同一行的那一排（字数），不是条件名
  if (名 && !名.startsWith('{') && !/[「」·，。、]/.test(名)) 出现.add(名);
}
const 不是条件 = new Set(['名字']);
const 实际 = [...出现].filter((n) => !不是条件.has(n));

const 漏了 = 实际.filter((n) => !登记.includes(n));
const 多了 = 登记.filter((n) => !实际.includes(n));

/*
 * **自检**：把两个名字对调一下，尺子必须报。
 * 少了这一段，把判据写成「永远通过」也照样绿——这个仓库的走查全都带这一条。
 */
const 试 = (a, b) => a.filter((x) => !b.includes(x));
if (试(['文件夹', '假条件'], ['文件夹']).length !== 1) {
  console.error('✗ 自检没过：这把尺子连「多了一个假条件」都抓不住');
  process.exit(2);
}

if (漏了.length || 多了.length) {
  if (漏了.length) console.log(`⚠ 屏上摆了这一行，COND_GROUPS 没登记：${漏了.join('、')}`);
  if (多了.length) console.log(`⚠ COND_GROUPS 写了，屏上没有这一行：${多了.join('、')}`);
  console.log('\n那句提示（`筛选提示`）是给「筛选」「＋ 新建分类」两颗键用的，');
  console.log('对不上就是它在介绍一个不存在的条件。改 COND_GROUPS，别去 App.tsx 手写。');
  process.exit(1);
}
// 顺带确认 App.tsx 没有偷偷回去手写
const 应用 = readFileSync('src/renderer/App.tsx', 'utf8');
const 手写 = 应用.match(/title="按[^"]*(文件夹|评分|标签)[^"]*"/g) ?? [];
if (手写.length) {
  console.log(`⚠ App.tsx 里又有手写的条件清单（${手写.length} 处），应该用 {筛选提示}`);
  for (const h of 手写) console.log('   ' + h.slice(0, 70));
  process.exit(1);
}
console.log(`✔ 条件清单只有一份（${登记.join('、')}），两颗入口键的提示都从它推出来`);
