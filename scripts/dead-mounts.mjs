/**
 * 找**挂不上的组件**：`{x && <Dialog/>}` 里的 `x` 是个 state，而它的 setter
 * 从来没有被赋过非空值。于是那个组件的渲染条件恒为假，界面上够不到。
 *
 * 这一类是这个仓库栽过三次的形状，最近一次是 `LinksDialog`（在线地址）：
 * 170 行界面 + `link.list` / `addBatch` / `check` / `setPrimary` / `remove`
 * 五个 rpc 一起悬空，而 `setLinksFor` 全仓库只出现在声明和「关掉」两处。
 *
 * **`scripts/dead-fields.mjs` 和死 rpc 清点都抓不到它**——那五个 rpc 确实被
 * 调用了，调用者正是这个没人挂载的组件自己（AGENTS.md：「查『rpc 没被调用』
 * 只能发现一半，另一半是『组件没被挂载』」）。typecheck 也不会响：state 声明了、
 * 组件 import 了、类型全对。
 *
 *   node scripts/dead-mounts.mjs      （或 npm run lint:ui）
 *
 * **这是筛子不是判据**，同 `dead-fields.mjs`：报出来要人去看一眼。
 * 「界面上会显示成星号的 markdown」那条查得死板、判据是硬的，所以它不在这儿，
 * 在 `src/renderer/no-literal-markdown.test.ts`——`npm test` 每次都跑，
 * 而这个脚本要人记得敲。
 *
 * ⚠ **扫描器自己会坏，所以开头有自检。** 同 `dead-fields.mjs` 的教训：
 * 一个静默找不到任何东西的扫描器比没有更糟。解析不出足够多的 useState 声明
 * 就报错退出，而不是报告「一切正常」。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// 仓库根从脚本自己的位置算，不靠 cwd——`cd scripts && node dead-mounts.mjs` 也得能跑
import { ROOT } from './repo-root.mjs';

const DIR = join(ROOT, 'src', 'renderer');

/** 注释整块挖掉。这个仓库注释比代码多，不挖干净会被淹掉 */
const strip = (src) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'));
const sources = new Map(files.map((f) => [f, strip(readFileSync(join(DIR, f), 'utf8'))]));
const all = [...sources.values()].join('\n');

// ── 自检 ────────────────────────────────────────────────
/*
 * ⚠️ **`=` 两边要允许换行。** 原来写死成 `] = useState`，于是这种写法一条都认不出来：
 *
 *     const [x, setX] =
 *       useState<SomeLongType | null>(null);
 *
 * 后果是**静默少报**：那个 state 从分析里整个消失，挂不上的组件因此藏得住。
 * 现在仓库里恰好没有这种写法（所以自检还是绿的），而它只需要谁把一行写长一点。
 * 同一个形状这轮已经撞到第三次（第 72 轮的 markdown 判据、
 * 第 84 轮那个死 rpc 扫描器）——**凡是「找某种写法」的正则，
 * 先问一句「这种写法会不会跨行」。**
 */
const DECL_RE = /const \[(\w+), (set\w+)\]\s*=\s*useState/g;
const declCount = [...all.matchAll(DECL_RE)].length;
if (files.length < 10 || declCount < 30) {
  console.error(`自检没过：读到 ${files.length} 个文件、${declCount} 个 useState 声明——` +
    '太少了，多半是路径或正则坏了。宁可报错，也不要报一份「一切正常」。');
  process.exit(2);
}


// ── 全部 setter 调用，扫一遍收齐 ────────────────────────
// 不要按 setter 名逐个正则扫全文：206 个声明 × 226 KB = 42 MB 的重复扫描，
// 而且随 src/renderer 变大而变坏。一遍分好组，后面查表
const callsBySetter = new Map();
for (const [, setter, args] of all.matchAll(/\b(set[A-Z]\w*)\(([^)]*)\)/g)) {
  let list = callsBySetter.get(setter);
  if (!list) callsBySetter.set(setter, (list = []));
  list.push(args);
}

/** 只是「关掉」的赋值。全部调用都长这样 = 这个 state 永远打不开 */
const CLOSING = /^\s*(null|undefined|false|\[\]|''|""|0)\s*$/;

/** 判据本身。抽成函数**只为一件事**：自检能拿合成的坏例子喂它 */
function findDead(pairs, calls) {
  const out = [];
  for (const [file, src] of pairs) {
    for (const [, name, setter] of src.matchAll(new RegExp(DECL_RE.source, 'g'))) {
      // 只看「拿它当渲染条件」的 state——纯数据 state（列表、草稿）不在这一类里
      if (!new RegExp(`\\{\\s*${name}\\s*(!==\\s*null\\s*)?&&|\\{${name}\\s*\\?`).test(src)) continue;
      const list = calls.get(setter) ?? [];
      if (list.every((a) => CLOSING.test(a))) out.push({ file, name, setter, n: list.length });
    }
  }
  return out;
}

/*
 * ⚠️ **自检要验的是「还抓得住坏东西吗」，不是「还读得到文件吗」。**
 *
 * 上面那一段只验了后者。而这个循环里刚踩过：一条新加的判据，正则在生成时
 * 被吃掉了反斜杠，变成一个永远匹配不上的字面量——**代码带着坏模式它照样全绿**，
 * 而它的自检（「扫到了几条 insert or ignore」）一样全绿。
 * 两者差一层，而差的那一层正好是判据本身。
 *
 * 所以喂一段**必然该被抓到**的合成源码进去，抓不到就报错退出。
 */
const DECOY = [[
  '(诱饵)',
  `const [ghostDialog, setGhostDialog] = useState(null);
   {ghostDialog && <GhostDialog onClose={() => setGhostDialog(null)} />}`,
]];
if (findDead(DECOY, new Map([['setGhostDialog', ['null']]])).length !== 1) {
  console.error('✗ 自检没过：合成的「挂不上的组件」都抓不到，这个脚本的判据已经失效了');
  process.exit(2);
}
/*
 * **第二个诱饵：同一件事写成跨行的样子。**
 *
 * `const [x, setX] =` 换行再 `useState(...)`——真代码里迟早会出现
 * （泛型一长 Prettier 就会这么折）。而判据要是写死成 `] = useState`，
 * 这个 state 会从分析里**整个消失**，挂不上的组件因此藏得住，
 * 而脚本照样报「一切正常」。这一轮扫下来仓库里恰好还没有这种写法，
 * 所以这条诱饵是**唯一**能证明那半判据活着的东西。
 */
const DECOY_WRAPPED = [['(跨行诱饵)',
  `const [wrapped, setWrapped] =
     useState(null);
   {wrapped && <WrappedDialog onClose={() => setWrapped(null)} />}`,
]];
if (findDead(DECOY_WRAPPED, new Map([['setWrapped', ['null']]])).length !== 1) {
  console.error('✗ 自检没过：`=` 换行的 useState 认不出来——判据又变回按行匹配了');
  process.exit(2);
}
console.log(`自检通过：${files.length} 个文件、${declCount} 个 useState，诱饵也抓到了`);

const dead = findDead(sources, callsBySetter);

/*
 * ── 第二类：**能存不能筛的阅读状态** ──────────────────────────
 *
 * `READING_STATUS`（`core/labels.ts`）里的每一档，编辑弹窗和批量改状态都摆着
 * 那个选项；而侧栏的书架清单是 `App.tsx` 里另一张表。**两张表对不上时，
 * 标成那一档的书除了「全部」以外哪儿都不出现**——不在「在读」，不在「未标记」，
 * 也不在「想读」，等于存进去就找不回来了。
 *
 * 实际栽过：`shelved`（搁置）从一开始就在 `READING_STATUS` 里，
 * 而侧栏一直没有那一档。后端全是好的（`book.counts` 数得到、按
 * `readingStatus` 也筛得出来），缺的只是 `SHELVES` 里的一行。
 * 和 `Filter.minRating` 那次是同一族：**能存不能筛**。
 *
 * 这条判据是硬的（两张表的 id 集合要对得上），所以直接报，不当筛子。
 */
const labels = readFileSync(join(ROOT, 'src', 'core', 'labels.ts'), 'utf8');
/*
 * ⚠️ 截到数组结束那一句**不能只认 `];`**：那张表后来加了 `as const`
 * （`status.ts` 的字面量联合类型要靠它），于是收尾变成 `] as const;`——
 * 一认不出来就一路读进下一张表（`FILE_STATUS`），报出「`ok` / `missing`
 * 在 SHELVES 里没有对应档位」这种莫名其妙的话。当场撞见过。
 */
const statusBlock = labels.slice(labels.indexOf('READING_STATUS'));
const statusEnd = statusBlock.search(/\]\s*(?:as const)?\s*;/);
const statusIds = [...statusBlock.slice(0, statusEnd).matchAll(/id: '([a-z]+)'/g)]
  .map((m) => m[1]);
const appSrc = readFileSync(join(DIR, 'App.tsx'), 'utf8');
const shelfBlock = appSrc.slice(appSrc.indexOf('const SHELVES'));
const shelfStatuses = [...shelfBlock.slice(0, shelfBlock.indexOf('\n];')).matchAll(/readingStatus: \['([a-z]+)'\]/g)]
  .map((m) => m[1]);

// 自检：两张表都得解析得出东西来，否则这条判据是静默通过的
if (statusIds.length < 4 || shelfStatuses.length < 3) {
  console.error(`✗ 自检没过：解析到 ${statusIds.length} 个阅读状态、${shelfStatuses.length} 个状态书架，`
    + '多半是哪张表的写法变了，这一轮的结果不算数');
  process.exit(1);
}
const noShelf = statusIds.filter((id) => !shelfStatuses.includes(id));

if (dead.length === 0 && noShelf.length === 0) {
  console.log(`✔ 没有挂不上的组件（阅读状态 ${statusIds.length} 档，书架都对得上）`);
  process.exit(0);
}
if (noShelf.length) {
  console.log(`\n⚠ 这些阅读状态存得进去、却没有一档书架列得出来（${noShelf.length}）：`);
  for (const id of noShelf) {
    console.log(`  ${id}：READING_STATUS 里有，App.tsx 的 SHELVES 里没有对应的 readingStatus`);
  }
}
if (dead.length === 0) process.exit(1);
console.log(`\n⚠ 挂不上的组件（${dead.length}）——渲染条件恒为假，界面上够不到：`);
for (const d of dead) {
  console.log(`  ${d.file}：${d.name} 是渲染条件，但 ${d.setter} 的 ${d.n} 次调用全是「关掉」`);
}
process.exit(1);
