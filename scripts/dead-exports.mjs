/**
 * 找**导出了、但定义文件之外没有任何生产代码用它**的函数。
 * 范围是 `src/` + `scripts/`，形态是 `export function` **和 `export const`**——
 * 后者是 2026-09-26 补的：当轮刚清掉的两个死导出都是 `export const`，而这张筛子
 * 早就在走 `scripts/` 了，**范围对、形态没对**（同族那条记在 docs/lessons.md）。
 *
 * 这是「声明了但没接线」的第四种形状，也是**唯一一把此前不存在的筛子**。
 * 前三种各有一把：
 *
 * | 形状 | 谁在管 |
 * |---|---|
 * | rpc 存在、界面没调 | 死 rpc 清点（`docs/lessons.md` 那几轮） |
 * | 组件声明了、没被挂载 | `scripts/dead-mounts.mjs` |
 * | 字段没人读 | `scripts/dead-fields.mjs` |
 * | **core 导出了、没有任何入口包它** | ← 这个脚本 |
 *
 * 为什么必须单独一把：2026-09-14 的 `shelf_member`（分类的手动成员）整套数据层
 * ＋六个函数落了库，而**三个 rpc 和界面入口七天都没接**。上面三把一把都没响——
 * `dead-mounts` 查组件（这里连组件都没有）、`dead-fields` 查字段（core 内部读得好好的）、
 * 死 rpc 清点查「rpc 没人调」（这里 **rpc 压根儿没加**）。
 * 而 `shelvesForBook` 的注释写着「编辑一本书时要列出的全部分类」——它就是为那个
 * 还没写的界面写的。同期还翻出第二处：「从阅读导入净化规则」（`looksLikeCleanRules` /
 * `importCleanRules`）数据层在、rpc 和界面都没有，而同族的「导入主题」那条**接了**。
 *
 *   node scripts/dead-exports.mjs      （或 npm run lint:ui）
 *
 * **这是筛子不是判据**，同 `dead-fields.mjs`：报出来要人去看一眼。
 * 「只被测试引用」那一档尤其要人看——**有单测不等于有入口**，
 * 而单测全绿恰恰是最容易让人以为「做完了」的那种证据。
 *
 * ⚠️ **扫描器自己会坏，所以下面有自检**（四个诱饵 + 一个结构锚点）。
 * 这一版写出来的时候就在探针里踩过一次：`re.test()` 用带 `g` 的正则，
 * `lastIndex` 会在字符串之间残留，结果**在真/假之间来回跳**——
 * 把 `batchUpdate`（`rpc.ts` 明明调了）误报成零引用。**别给这种正则加 `g`。**
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
// 仓库根从脚本自己的位置算，不靠 cwd
import { ROOT } from './repo-root.mjs';

/*
 * 注释整块挖掉。**这一条是判据的一部分，不是省事**：
 * `builtin-tts.ts` 里有一句注释写着「填值的是同文件的 `renderUrl`」——
 * 不挖注释的话，一个**只在注释里被提到过**的函数会被算成「有消费者」，
 * 而它实际上一个调用点都没有（那次就是）。
 */
const strip = (src) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

function walk(dir, out = []) {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|cjs|mjs)$/.test(e)) out.push(rel);
  }
  return out;
}

const isTest = (f) => /\.test\.ts$/.test(f);

/** 判据本身。抽成函数**只为一件事**：自检能拿合成的坏例子喂它 */
function classify(files, sources) {
  const 零引用 = [];
  const 只给测试用 = [];
  const 内部辅助 = [];      // 只给测试用，但自己文件里还在调 —— 为了能单独测而导出，正常
  const 导出多余 = [];      // 只有自己文件在用 —— `export` 是多余的
  for (const f of files) {
    const src = sources.get(f);
    /*
     * **`export const` 也要认。** 这一版原来只匹配 `export function`，于是
     * 2026-09-26 那两处死导出（`是大库测量`、`bindable`，都是 `export const`）
     * 它一条都看不见——而脚本**已经在走 `scripts/` 了**，所以「覆盖了 scripts/」
     * 是假的安全感：漏掉的是整个 `export const` 形态。
     * 加匹配的同时，下面「自己文件里还有没有别的引用」那一刀也要跟着把
     * `export const` 的声明行挖掉——否则名字永远留在声明行里，
     * 「真的没人用」会被误判成「导出多余」。
     */
    for (const m of src.matchAll(/^(?:export (?:async )?function|export const) (\w+)/gm)) {
      const name = m[1];
      // ⚠️ 不带 `g`：带 `g` 的 `test()` 会推进 lastIndex，循环里结果会跳
      const re = new RegExp(`\\b${name}\\b`);
      const 别处 = [...sources.keys()].filter((g) => g !== f && re.test(sources.get(g)));
      if (别处.some((g) => !isTest(g))) continue;          // 有生产消费者
      /*
       * 自己文件里（挖掉声明那一行之后）还有没有别的引用。
       * **这一刀是为了让报告能看**：不分的话，「内部辅助」会和「真的没人用」
       * 混成一档，而前者有二十几个、后者只有几个——重点会被淹掉。
       */
      const 自己还用 = new RegExp(`\\b${name}\\b`)
        .test(src.replace(
          // ⚠️ **只许挖「这个名字自己」那一行声明。** 整批按形态挖会咬人：
          // `export const use = () => ghostFn();` 被当成「use 的声明」挖掉之后，
          // `ghostFn` 唯一那条自引用就没了，「内部辅助」误判成「只给测试用」——
          // 是那条诱饵报出来的，不是我看出来的。
          new RegExp(`^export (?:async )?function ${name}\\b.*$|^export const ${name}\\b.*$`, 'gm'), ''));
      const 项 = { name, f, 谁: 别处 };
      if (别处.length) (自己还用 ? 内部辅助 : 只给测试用).push(项);
      else (自己还用 ? 导出多余 : 零引用).push(项);
    }
  }
  return { 零引用, 只给测试用, 内部辅助, 导出多余 };
}

// ── 自检 ────────────────────────────────────────────────
/*
 * **四个诱饵，方向各不相同**（该报的 / 该报但归另一档 / 不该报的 / 注释里的不算）。
 * 只验「还读得到文件吗」是不够的——判据本身坏掉时它照样全绿
 * （`dead-mounts.mjs` 顶上记着这条）。
 */
const 诱饵_零引用 = [['(诱饵)core/ghost.ts',
  'export function ghostFn(a: number): number {\n  return a + 1;\n}']];
const 诱饵_只给测试 = [
  ['(诱饵)core/ghost.ts', 'export function ghostFn(a: number): number {\n  return a + 1;\n}'],
  ['(诱饵)core/ghost.test.ts', "import { ghostFn } from './ghost.ts';\nghostFn(1);"],
];
/*
 * **反向诱饵：有生产消费者的必须一条都不报。**
 * 少了它，一个「什么都报」的坏判据也能通过上面两条。
 */
const 诱饵_有消费者 = [
  ['(诱饵)core/ghost.ts', 'export function ghostFn(a: number): number {\n  return a + 1;\n}'],
  ['(诱饵)core/use.ts', "import { ghostFn } from './ghost.ts';\nghostFn(2);"],
];
/*
 * ⚠️ **注释里的提及不算消费者**（见 `strip` 那段注释）。
 * 这也是一个方向：不挖注释的版本会把下面这个判成有消费者。
 */
const 诱饵_只在注释里 = [
  ['(诱饵)core/ghost.ts', 'export function ghostFn(): void {}'],
  ['(诱饵)core/use.ts', '// 填值的是同文件的 ghostFn\nconst x = 1;'],
];
/*
 * ⚠️ **「内部辅助」和「真的没人用」必须分开。** 这一刀是让报告能看的那一刀：
 * 不分的话二十几个内部辅助会和几个真缺口混成一档，重点当场淹掉。
 * 这个诱饵钉的就是那一刀：同一个函数，自己文件里调了一次、测试里也调了一次。
 */
const 诱饵_内部辅助 = [
  ['(诱饵)core/ghost.ts', 'export function ghostFn(): number {\n  return 1;\n}\nexport const use = () => ghostFn();'],
  ['(诱饵)core/ghost.test.ts', 'ghostFn();'],
];

/*
 * ⚠️ **`.mjs` 里的 `export const` 也得验**：那两处死导出正是这个形态，
 * 而在此之前没有一条诱饵长这样——所以「脚本已经在走 scripts/」这件事
 * 从来没被证明过它真的看得见 `export const`。两个方向都要：
 * 没人用的要报，`.mjs` 之间互相 import 的不能报。
 */
const 诱饵_mjs_零引用 = [
  ['(诱饵)scripts/ghost.mjs', 'export const ghostThing = 1;\nexport function ghostFn() { return 2; }'],
];
const 诱饵_mjs_有消费者 = [
  ['(诱饵)scripts/ghost.mjs', 'export const ghostThing = 1;'],
  ['(诱饵)scripts/use.mjs', "import { ghostThing } from './ghost.mjs';\nconsole.log(ghostThing);"],
];

/*
 * ⚠️ 诱饵是 `[路径, 源码]` 的**数组**，不是 Map——`[...arr.keys()]` 拿到的是下标。
 * 而且**诱饵必须过一遍和真文件同一个 `strip`**：第一版漏了这一步，
 * 于是自检验的是另一条管线（注释没挖掉），「只在注释里提到」那个诱饵当场没过——
 * 而它要验的正是「注释算不算消费者」。自检和真实扫描差一层，等于没有自检。
 */
const 试 = (pairs) => classify(pairs.map((x) => x[0]), new Map(pairs.map(([p, s]) => [p, strip(s)])));
const ok =
  试(诱饵_零引用).零引用.length === 1 &&
  试(诱饵_只给测试).零引用.length === 0 && 试(诱饵_只给测试).只给测试用.length === 1 &&
  试(诱饵_有消费者).零引用.length === 0 && 试(诱饵_有消费者).只给测试用.length === 0 &&
  试(诱饵_只在注释里).零引用.length === 1 &&
  试(诱饵_内部辅助).内部辅助.length === 1 &&
  // 同一个诱饵文件里那个 `export const use` **是真没人用**，必须落在「零引用」那一档：
  // 这一条同时钉住两件事——两档分得开，而且 `export const` 形态确实被认到了。
  试(诱饵_内部辅助).零引用.map((x) => x.name).join() === 'use' &&
  试(诱饵_mjs_零引用).零引用.length === 2 &&
  试(诱饵_mjs_有消费者).零引用.length === 0 && 试(诱饵_mjs_有消费者).只给测试用.length === 0;
if (!ok) {
  console.error('✗ 自检没过：诱饵没抓对（四个方向里至少有一个坏了），这一轮的结果不算数');
  process.exit(2);
}

// ── 真扫 ────────────────────────────────────────────────
/*
 * ⚠️ **把自己排除掉。**
 *
 * 第一版这里必须排除：脚本里有一张锚点表写着 `['updateBook', 'addShelfBooks']`，
 * 那是**代码里的字符串**，`strip` 挖不掉——于是 `addShelfBooks` 永远「有消费者」。
 * 对照实验里露的马脚：把 `rpc.ts` 换回未接线的版本，`removeShelfBooks` /
 * `shelvesForBook` 都报了，**只有 `addShelfBooks` 没报**。
 *
 * 锚点后来换成结构判据（见下），所以**现在排不排除结果一样**（实测过）。
 * 留着是因为它防的是下一次：这个脚本里只要出现任何一个 core 函数名的字符串
 * （新加一个锚点、写一段举例），那一处就会永远被算成「有消费者」，
 * 而且**看不出任何异常**。扫描器把自己算进被测对象，是「探针会骗人」最难看的一种。
 */
const SELF = 'scripts/dead-exports.mjs';
const files = [...walk('src'), ...walk('scripts')].filter((f) => f !== SELF);
const sources = new Map(files.map((f) => [f, strip(readFileSync(join(ROOT, f), 'utf8'))]));
const coreFiles = files.filter((f) => f.startsWith('src/core/') && !isTest(f));

const 导出总数 = coreFiles.reduce(
  (n, f) => n + [...sources.get(f).matchAll(/^export (?:async )?function \w+/gm)].length, 0);
if (coreFiles.length < 40 || 导出总数 < 100) {
  console.error(`自检没过：读到 ${coreFiles.length} 个 core 文件、${导出总数} 个 export function——`
    + '太少了，多半是路径或正则坏了。宁可报错，也不要报一份「一切正常」。');
  process.exit(2);
}
const { 零引用, 只给测试用, 内部辅助, 导出多余 } = classify(coreFiles, sources);
/*
 * **锚点：确认扫描器读的是这一棵树。**
 *
 * 这里原来写的是「`addShelfBooks` 必须**不**被报出来」——那条断言把
 * 「扫描器读错文件」和「那个函数真的被摘掉了」混成了一句话。做对照实验
 * （故意把 `rpc.ts` 换回未接线的版本，看筛子抓不抓得到）时它会喊
 * 「扫描器读错文件了」，而扫描器其实完全正确。
 * **一条会在正常实验里误报的锚点，会让人开始无视它**（同 `README` 里
 * 「一条偶尔变红的走查和一条永远绿的一样没用」）。
 *
 * 现在问一个**结构上不会变**的事实：扫到的文件里有 `rpc.ts`，且里面有 rpc 方法键。
 */
const RPC = 'src/main/rpc.ts';
if (!sources.has(RPC) || !/'\w+\.\w+':/.test(sources.get(RPC))) {
  console.error(`✗ 自检没过：没读到 ${RPC} 里的 rpc 方法表，扫描器读错文件了`);
  process.exit(2);
}

console.log(`自检通过：${coreFiles.length} 个 core 文件、${导出总数} 个导出，诱饵和锚点都对\n`);

const 短 = (x) => `  ${x.f.replace('src/core/', '')}  ${x.name}` +
  (x.谁.length ? `  ← ${x.谁.map((y) => y.replace(/^src\//, '')).join(', ')}` : '');

/*
 * 两档重点，两档只报个数。
 *
 * ⚠️ **后两档为什么不逐个列。** 它们加起来三十来个，而**一条真正的缺口会被
 * 三十行「内部辅助」淹掉**——这个脚本存在的唯一理由是让人看见那几个缺口。
 * 报个数是为了「有人想知道时还查得到」，不是为了让人逐个看。
 */
if (零引用.length) {
  console.log(`⚠ 全仓库一个引用都没有（${零引用.length}）——`
    + '要么是死代码，要么是「数据层落了、入口没接」：');
  for (const x of 零引用) console.log(短(x));
  console.log();
}
if (只给测试用.length) {
  console.log(`⚠ 只有测试在引用（${只给测试用.length}）——**有单测不等于有入口**：`);
  for (const x of 只给测试用) console.log(短(x));
  console.log();
}
if (内部辅助.length) {
  console.log(`· 另有 ${内部辅助.length} 个「只给测试用、但自己文件里还在调」的内部辅助`
    + '（为了让测试能单独测而导出，正常，不列了）');
}
if (导出多余.length) {
  console.log(`· 另有 ${导出多余.length} 个「只有自己文件在用」——`
    + '`export` 是多余的，想收拾可以顺手去掉（不列了）');
}
if (!零引用.length && !只给测试用.length) {
  console.log('\n✔ core 的每个导出都有生产消费者');
  process.exit(0);
}
console.log('\n**这是筛子不是判据**：core 内部用的函数报出来是正常的，'
  + '逐个看一眼，找的是「本该有入口」的那些。');
/*
 * ⚠️ **故意退出 0。** 这一档里现在就有真东西（批量归类、导入净化规则两处功能缺口），
 * 而它们是**产品决定**不是缺陷——做成硬规则的话，`lint:ui` 会一直红，
 * 而一条永远红的筛子很快会被人加 `|| true` 或者干脆删掉。
 * 什么时候能升级成 `dead-mounts.mjs` 那样的硬规则：等「零引用」那一档清空，
 * 或者把它们挪进一张**基线表**（那时基线的两个方向都要能失败，见
 * `docs/lessons.md` 的 2c-2 那节）。
 */
process.exit(0);
