/**
 * 渲染进程里有没有「和 core 同名的第二份类型」。
 *
 * **这个仓库栽在这上面已经六次了**：`Filter`、`RepairReport`、`Version`、
 * 评分刻度、`RestoreReport`、`RenameDialog` 那三个（`RowStatus` / `Row` / `Report`）。
 * 形状每次都一样——渲染进程手写一份和 core 同名的接口，然后**抄的那份先掉队**：
 * 少一个字段、多一档取值。而 typecheck 一声不响，因为手抄的那份自己是自洽的。
 *
 * 最贵的一次：`Settings.tsx` 里那份 `RepairReport` 只有 4 个字段而 core 有 5 个，
 * 漏的是 `wronglyMissing`——于是那一轮如果只修好了那一类，
 * 用户看到的是**「没有发现需要整理的记录」**，一句错话。
 *
 * 判据收窄到「**名字撞上**」才做得成硬规则：
 *   - 只比名字，不比字段。子集拷贝（`ChapterText` 少一个 `bookId`）也要报——
 *     那正是掉队的起点。
 *   - 同名但**指的是两件事**同样要报（`Mark` 在 core 里是划线、
 *     在 `HighlightsPanel` 里曾经是书签）：一个名字两个所指比两份同名类型更难读。
 *   - 改法二选一：从 core `import type`，或者**改个名字**。
 *
 * 全部清干净之后现在是 0 处，所以这是硬规则不是筛子。
 *
 *   node scripts/dup-decls.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './repo-root.mjs';

// 类型和常量都要认。`const` 只认顶层的（行首没有缩进）——
// 函数体里的局部常量和 core 撞名毫无问题
const DECL = /^(?:export )?(?:interface|type|const) (\w+)\b/gm;

/** 某个目录里所有非测试的 .ts/.tsx 声明了哪些类型名 */
function declaredIn(dirs, exts, onlyExported) {
  const out = new Map();
  for (const d of dirs) {
    for (const f of readdirSync(join(ROOT, d))) {
      if (!exts.some((e) => f.endsWith(e)) || f.endsWith('.test.ts') || f.endsWith('.test.tsx')) continue;
      const rel = `${d}/${f}`;
      const src = readFileSync(join(ROOT, rel), 'utf8');
      const re = onlyExported ? /^export (?:interface|type|const) (\w+)\b/gm : DECL;
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) {
        if (!out.has(m[1])) out.set(m[1], []);
        out.get(m[1]).push(rel);
      }
    }
  }
  return out;
}

/** 渲染进程里「自己声明的」和「从别处 import 进来的」不是一回事——只看前者 */
function ownDecls(rel, src) {
  const names = [];
  for (const m of src.matchAll(DECL)) {
    // `export type { X } from '...'` / `import type { X }` 都不是自己声明
    const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
    if (/\bfrom\b/.test(line) || line.includes('{')) {
      if (/^\s*(?:export|import) type \{/.test(line)) continue;
    }
    names.push(m[1]);
  }
  return names.map((n) => ({ name: n, file: rel }));
}

export function findDupes(coreNames, rendererDecls) {
  return rendererDecls
    .filter((d) => coreNames.has(d.name))
    .map((d) => ({ ...d, core: coreNames.get(d.name).join('、') }));
}

const coreNames = declaredIn(['src/core', 'src/main', 'src/server'], ['.ts'], true);

/*
 * **core 内部自己撞车也要报。** 判据一放宽就抓到两个：
 *
 * - `READING_STATUS` 在 `labels.ts`（带中文名）和 `status.ts`（纯 id）各一份。
 *   加一档漏改一处的后果是：侧栏和编辑弹窗里摆着那一档，
 *   而 `setStatus` 说「不认识的阅读状态」。`SERIAL_STATUS` 当年就是这么删掉的，
 *   **而阅读状态这一份一直活到现在**。
 * - `FetchLike` 三份：两份是 `typeof globalThis.fetch` 的重复别名，
 *   第三份（`links.ts`）是**另一件事**（探活用的窄接口），已改名 `ProbeFetch`。
 */
const coreDupes = [...coreNames.entries()]
  .filter(([, files]) => new Set(files).size > 1)
  .map(([name, files]) => ({ name, files: [...new Set(files)] }));

const rendererDecls = [];
const rendererFiles = [];
for (const f of readdirSync(join(ROOT, 'src/renderer'))) {
  if (!/\.(ts|tsx)$/.test(f) || /\.test\.(ts|tsx)$/.test(f)) continue;
  const rel = `src/renderer/${f}`;
  const src = readFileSync(join(ROOT, rel), 'utf8');
  rendererDecls.push(...ownDecls(rel, src));
  rendererFiles.push({ name: f, src });
}

/*
 * **自检第二层：这个检测器还认得出「同名的第二份」吗。**
 *
 * 只验「读得到文件、解析得出类型名」是不够的——判据写坏时它会一边报
 * 「0 处」一边什么都没查。所以喂一段**必然该被抓到的**合成输入：
 * 一个和 core 同名的接口。诱饵要照着真代码的样子写（ASCII 标识符、
 * 真实的声明形状），不然测的是诱饵不像样，不是判据坏了。
 */
{
  const known = [...coreNames.keys()][0];
  if (!known || coreNames.size < 30) {
    console.error(`✗ 自检没过：从 core 里只解析出 ${coreNames.size} 个导出类型，判据多半已经失效`);
    process.exit(1);
  }
  const decoySrc = `interface ${known} {\n  a: string;\n}\n`;
  const decoy = findDupes(coreNames, ownDecls('src/renderer/__decoy.tsx', decoySrc));
  if (decoy.length !== 1) {
    console.error(`✗ 自检没过：一个和 core 同名的接口都抓不出来（${known}）——判据已经失效`);
    process.exit(1);
  }
  /*
   * **常量那一半也要有自己的诱饵。** 只喂一个 interface 的话，
   * `const` 那条分支写坏了这个脚本照样报「0 处」——而它正是这一轮新加的那半。
   */
  const knownConst = [...coreNames.keys()].find((n) => /^[A-Z][A-Z0-9_]{2,}$/.test(n));
  if (!knownConst) {
    console.error('✗ 自检没过：core 里一个全大写的常量都没解析出来，const 那半多半没在工作');
    process.exit(1);
  }
  const decoyConst = findDupes(coreNames, ownDecls('src/renderer/__decoy.tsx', `const ${knownConst} = 1;
`));
  if (decoyConst.length !== 1) {
    console.error(`✗ 自检没过：一个和 core 同名的常量抓不出来（${knownConst}）——const 那半已经失效`);
    process.exit(1);
  }

  // 反过来：一个 core 里没有的名字不许被报出来
  const clean = findDupes(coreNames, ownDecls('src/renderer/__decoy.tsx', 'interface ZzzNotInCore { a: string }\n'));
  if (clean.length !== 0) {
    console.error('✗ 自检没过：core 里根本没有的名字也被报出来了');
    process.exit(1);
  }
}


/*
 * ── 第三条判据：同一个 rpc 方法，在渲染进程里只能有一种返回类型 ──
 *
 * 「渲染进程手抄一份 core 的形状」这个家族已经栽过八次，前七次抄的都是**有名字的**
 * 类型，所以上面那两条判据抓得住。第八次抄的是 `rpc<{ … }>` 里的**匿名内联形状**
 * （`book.counts` 的六个字段），它躲开了上面全部判据——名字都没有，撞什么名。
 *
 * 收窄成这一条才做得成硬规则：**同一个方法名被标了两种返回类型**，必有一份是抄的，
 * 而且已经分叉了。当场抓到一处：`root.add` 在 `App.tsx` 是 `{ report: ScanReport }`、
 * 在 `LibraryDirs.tsx` 是手写的 `{ report: { added; skipped } }`。
 *
 * **不管只出现一次的**（`{ n: number }` 这种小形状是正常的，管进来会太吵，
 * 那种判据很快会被人删掉）——只管「同一个方法两种说法」。
 */
function rpcReturnTypes(files) {
  const byMethod = new Map(); // 方法名 -> Map(类型文本 -> [文件])
  for (const { name: f, src } of files) {
    // rpc<类型>('方法名'  ——类型里可能有嵌套的尖括号，所以按配平数
    for (const m of src.matchAll(/\brpc<([\s\S]*?)>\(\s*['"`]([\w.]+)['"`]/g)) {
      const 类型 = m[1].replace(/\s+/g, ' ').trim();
      const 方法 = m[2];
      // 尖括号没配平说明我截到了别的地方，跳过（宁可漏报也别瞎报）
      if ((类型.match(/</g) || []).length !== (类型.match(/>/g) || []).length) continue;
      if (!byMethod.has(方法)) byMethod.set(方法, new Map());
      const 表 = byMethod.get(方法);
      if (!表.has(类型)) 表.set(类型, []);
      表.get(类型).push(f);
    }
  }
  const out = [];
  for (const [方法, 表] of byMethod) {
    if (表.size > 1) out.push({ 方法, 说法: [...表].map(([t, fs]) => `${fs.join('、')}: ${t}`) });
  }
  return out;
}

/*
 * ── 第四条判据：core 内部**私有**的同名同值常量 ──
 *
 * 上面第二条（core 内部撞名）走的是 `declaredIn(..., onlyExported = true)`，
 * 两个 `const` 都不导出时它一声不吭。放宽之后当场抓到两处，而且都已经在
 * 「同一件事两处各写一份」的老路上：
 *
 * - `MD_HEADING`（`chapter.ts` / `suggest.ts`）：markdown 标题前缀 `^#{1,6}…`。
 *   两边剥法一分叉，`suggest` 猜出来的规则套回正文就匹配不上——
 *   而两处都能跑、都不报错。
 * - `READABLE`（`suggest.ts` / `tts.ts`）：「这段字里有没有能读的字符」。
 *
 * 两处都合并了（前者导出、后者搬进 `format.ts` 的 `hasReadable`）。
 *
 * ⚠️ **私有的要同名「又」同值才报。** 只按名字报会把 `convert.ts` 和 `ignore.ts`
 * 各自的 `const KEY`（一个是 `convert.book.${id}`，一个是 `'scan.ignore'`）
 * 也算进来——那是重名不是抄本，而报错误的东西会让人把整条判据删掉。
 *
 * ⚠️ **只看单行的 `const`。** 值就写在那一行上，比得出「同值」；
 * 多行的 `interface X {` 第一行两个同名的必然一样，拿它当同值是满屏误报。
 *
 * ⚠️ **而且只认顶层的——行首不许有缩进**（同这个文件顶上 `DECL` 那条注释）。
 * 第一版把每行 `trim()` 了再比，于是函数体里的局部变量全进来了：
 * `const out = []`、`const r = await parseAndStore(...)`、`const dir = coverDir(...)`
 * 一口气报 13 处，没有一处是抄本。**局部变量撞名毫无问题**，
 * 而一条会报十几处假阳性的判据活不过下一次改动。
 */
function privateCopies(files) {
  const byKey = new Map();
  for (const { name: rel, src } of files) {
    for (const raw of src.split('\n')) {
      /*
       * ⚠️ **这个仓库的文件是 CRLF**，`split('\n')` 会给每行留一个尾部 `\r`，
       * 而下面那条 `.*;$` 要求以分号收尾——不剥它，这条判据**一行都匹配不到**，
       * 而它照样安静地报「✔ 干净」。上一版就是这么空转的，
       * 破坏实验（把 `MD_HEADING` 抄回 `suggest.ts`）连着两轮退出码 0 才发现。
       */
      const t = raw.replace(/\r$/, '');
      /*
       * ⚠️ **`export ` 那个前缀必须一起收，比对前再剥掉。**
       *
       * 第一版只认行首的 `const`，于是漏掉了**最常见的形状**：一份导出、
       * 另一份是私有抄本。破坏实验当场证明——把 `MD_HEADING` 抄回 `suggest.ts`
       * （`chapter.ts` 那份已改成 `export const`），守卫退出码 0，一声不吭。
       * 自检里的诱饵当时是「两份都私有」，所以它一路绿着，
       * 而真实世界里的那个形状根本没被覆盖。**诱饵得照着真的坑长。**
       */
      const m = /^(?:export )?const (\w+) = .*;$/.exec(t);
      if (!m) continue;
      // 分隔符写成转义，**别在源码里放一个真的 0x01 字节**（AGENTS.md 那条）
      const 值 = t.replace(/^export /, '');
      const key = m[1] + '\u0001' + 值;
      if (!byKey.has(key)) byKey.set(key, { name: m[1], line: 值, files: new Set() });
      byKey.get(key).files.add(rel);
    }
  }
  return [...byKey.values()].filter((v) => v.files.size > 1);
}

const coreFiles = [];
for (const d of ['src/core', 'src/main', 'src/server']) {
  for (const f of readdirSync(join(ROOT, d))) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    coreFiles.push({ name: `${d}/${f}`, src: readFileSync(join(ROOT, `${d}/${f}`), 'utf8') });
  }
}

{
  // 同这个脚本里另外三条：判据写坏了它照样会报「0 处」，所以喂一对必然该被抓到的，
  // 外加一对**同名不同值**的反向诱饵——那种不许被报出来
  const 报了 = privateCopies([
    { name: 'a.ts', src: "export const SAME = /x/;\nconst KEY = 'a';\n" },
    { name: 'b.ts', src: "const SAME = /x/;\nconst KEY = 'b';\n" },
  ]);
  if (报了.length !== 1 || 报了[0].name !== 'SAME') {
    console.error('✗ 自检没过：私有的同名同值常量抓不出来（或者把同名不同值的也报了）——第四条判据已经失效');
    process.exit(1);
  }
}

const dupes = findDupes(coreNames, rendererDecls);
const rpcSplit = rpcReturnTypes(rendererFiles);
const privDupes = privateCopies(coreFiles);

{
  /*
   * 这半也要有自己的诱饵：判据写坏了它照样会报「0 处」（同这个脚本上面那两条）。
   * `demo.only` 是**反向诱饵**——只出现一次的形状不许被报出来，
   * 不然 31 处 `rpc<{ n: number }>` 会把这个脚本变成一台噪声机。
   */
  const 报了 = rpcReturnTypes([
    { name: 'A.tsx', src: "rpc<{ x: number }>('demo.same');\nrpc<{ y: number }>('demo.only');\n" },
    { name: 'B.tsx', src: "rpc<{ x: number; z: string }>('demo.same');\n" },
  ]);
  if (报了.length !== 1 || 报了[0].方法 !== 'demo.same') {
    console.error('✗ 自检没过：同一个 rpc 被标了两种返回类型都抓不出来——这半判据已经失效');
    process.exit(1);
  }
}

console.log(`自检通过：core 导出 ${coreNames.size} 个类型/常量，渲染进程自己声明 ${rendererDecls.length} 个，诱饵也抓到了`);
if (dupes.length === 0 && coreDupes.length === 0 && rpcSplit.length === 0 && privDupes.length === 0) {
  console.log('✔ 没有同名的第二份声明（渲染进程 vs core、core 内部含私有常量、rpc 返回类型都干净）');
  process.exit(0);
}
for (const p of privDupes) {
  console.log(`
  core 内部私有的同名同值常量：${p.name}   ${[...p.files].join('、')}`);
  console.log(`      ${p.line}`);
}
for (const r of rpcSplit) {
  console.log(`
  同一个 rpc 两种返回类型：${r.方法}`);
  for (const 说 of r.说法) console.log(`      ${说}`);
}
console.log(`
共 ${dupes.length + coreDupes.length + privDupes.length} 处撞名。要么引同一份，要么改个名字：`);
for (const d of dupes) console.log(`  渲染进程 ${d.file}  ${d.name}  ——core 里也有：${d.core}`);
for (const d of coreDupes) console.log(`  core 内部  ${d.name}  ——${d.files.join('、')}`);
process.exit(1);
