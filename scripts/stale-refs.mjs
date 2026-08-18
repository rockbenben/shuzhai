// 注释和文档里指的东西，还在不在？
//
// 这个仓库最常见的缺陷不是代码错，是**文字指向了一个已经不存在的东西**——
// 它不报错、typecheck 也过、测试全绿，只有人真去点开那个名字才发现，然后要么
// 以为自己看漏了，要么以为那个安全阀根本不存在。
//
// 踩过几次、每次长什么样，记在 docs/lessons.md「指路指错了」那节，**这里不再抄一遍**
// （抄第二份必然分叉——上一版这个文件头说「三个」而 AGENTS.md 说「两个」，
// 正好演示了一遍）。
//
// 查两类：
//   ① 写出来的仓库路径 / 文件名，磁盘上有没有
//   ② 「某文件 的 某标识符」这种带文件限定的引用，那个标识符是不是真在那个文件里
//
// **自检**：三类命中数各自计数、各自设下限。合成一个总数是不行的——
// 那样其中一条正则整个失效，总数仍然过线，脚本会一边报「一切正常」一边什么都没查。
// 一个静默找不到任何东西的扫描器比没有更糟。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { ROOT } from './repo-root.mjs';

/**
 * 不走的目录。除了产物和 `.git`，还要跳过**没进版本库的那些**——
 * `scratchpad/`（干跑脚本，AGENTS.md 说了跑完就扔）、`.claude/`、`.superpowers/`。
 * 不跳的话本地会报出一堆 CI 里根本不存在的「缺陷」，而且它们还会混进 `byName`
 * 反过来把真正失效的引用**遮住**。目标是本地和干净检出跑出同一个结果。
 */
const SKIP = new Set([
  // 产物和版本库外的东西。**别加 'images'**——`docs/images/*.png` 是**跟踪着的**，
  // 跳过它会让 byName 少两个文件，跟「本地和干净检出结果一致」这个目标正好相反
  'node_modules', '.git', 'dist', 'release',
  // 没进版本库的：干跑脚本和各家工具的目录。不跳的话本地会报出 CI 复现不了的东西
  'scratchpad', '.claude', '.superpowers',
]);

/**
 * 名字对得上、但**故意**不在这个仓库里的东西。加一条就写清楚为什么。
 *
 * ⚠️ **这是按文件名全仓库静音的，别拿它豁免「某一处」引用。** 一条 ALLOW 会让这个
 * 名字在任何文件里都查不出来。这张表已经出过两次事，两次都是为了让**一句自指的话**
 * 通过而把一个常见名字永久静音：一次是某个测试文件名，一次是 <!-- stale-refs:off -->`test.ts`<!-- stale-refs:on -->。
 * 真要局部豁免用下面 `blankOut` 那对区段标记；更好的做法是**把那句话改掉**——
 * 一句需要豁免才能存在的提醒，多半本来就不该那么写。
 *
 * ⚠️ **下面这三条都是必需的，别当成「永远不触发的豁免」删掉。**
 * 这份说明一度写着相反的话（说 `$S/…` 那种带路径前缀的走别的分支、写不写都一样）——
 * 那是照着**改之前**的 NAME_RE 写的：后来放开了 `/` 前瞻，带路径的名字也按 basename
 * 查了，于是这三条同时变成了承重墙。**判断一条豁免死活的办法是把它删掉重跑**，
 * 别靠读代码猜（具体多几条不写在这儿——那个数每改一次 build/brand/README.md 就变）。
 */
const ALLOW = new Map([
  ['render.mjs', 'html-shot skill 的脚本，装在 ~/.claude/skills 下，不在本仓库'],
  ['icons.mjs', '同上'],
  ['make-icon.mjs', '早先生成图标的脚本，已删；build/brand/README.md 里是历史引用，那儿写明了'],
]);

/**
 * 递归列文件。**不用 `readdirSync(recursive: true)`**：那个没法中途剪枝，
 * 会把 `node_modules` 整个枚举一遍再让我们过滤，慢得没必要。
 */
function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p.slice(ROOT.length + 1).split(sep).join('/'));
  }
  return out;
}

const abs = (rel) => join(ROOT, rel);
const all = walk(ROOT);

const byName = new Map();
for (const f of all) {
  const b = basename(f);
  if (!byName.has(b)) byName.set(b, []);
  byName.get(b).push(f);
}

const docs = all.filter(
  (f) =>
    /\.(ts|tsx|mjs|cjs|md|yml|json|css|html)$/.test(f) &&
    // package-lock 里全是包名和路径，扫它只会刷屏
    !f.includes('package-lock') &&
    // `docs/reference/` 是照抄回来的第三方资料（GoodNotes 帮助中心、MarginNote 手册），
    // 一个字都不指向本仓库，天然不在「指路还对不对」的射程内。
    // 而且那些文件名**带空格**，NAME_RE 只会认最后一段：
    // <!-- stale-refs:off -->「AI and Other Commonly Used Plugins.md」被读成「Plugins.md」<!-- stale-refs:on -->，
    // 于是 92 处全是这么来的假阳性。**注意不是放进 SKIP**——那样它们会一并从
    // `byName` 里消失，别处再引用就查不出来了；这里只是不扫它们。
    !f.startsWith('docs/reference/'),
);
// **本文件自己也在 docs 里，一样被扫。** 原来是按路径字符串把自己排掉的，
// 于是这个文件成了全仓库唯一没人查的文件——上面那段写反了的 ALLOW 说明
// 正是这么活下来的（而且一改名，自我排除就失效，它会开始报自己）。
// 现在只把举反例的那几处圈进 `stale-refs:off`，其余照查。

// ① 完整的仓库路径。前面还挂着别的路径段的不算——legado 那个
//    `app/src/main/assets/defaultData/txtTocRule.json` 是**别人仓库**里的文件
// **目录段同样限到 4 层，理由和下面 NAME_RE 那段一模一样。**
// 原来这里是 `[A-Za-z0-9_./-]+\.` ——那个字符类**同时含 `/` 和 `.`**，
// 于是每个 `src/` 之类的锚点都会一路扫到行尾再逐字回溯。实测（matchAll，
// 拿 `docs/` + 20 个 `a.` 重复）：9KB 1.8ms → 18KB 7.1ms → 35KB 27.9ms →
// 70KB 110.4ms，标准的翻倍即四倍；同一段输入 NAME_RE 只要 0.1–0.2ms。
// 也就是说那条 764ms 的教训只落实到了 NAME_RE 上，这条比它还糟。
const PATH_RE = /(?<![A-Za-z0-9_/-])((?:src|scripts|docs|build|\.github)\/(?:[A-Za-z0-9_.-]+\/){0,4}[A-Za-z0-9_.-]+\.(?:ts|tsx|mjs|cjs|js|md|css|html|json|yml|png|ttf|otf|txt))\b/g;
//    带不带目录前缀都收：`chapter.ts`、`core/pacing.ts`、`./suggest.ts`、`$S/render.mjs`
//    都按 basename 去找。**前面允许有 `/`** ——不允许的话 `core/pacing.ts` 这种
//    半截路径谁都查不到，而这个仓库到处这么写（一度有十几处在覆盖之外）
//    前瞻里**不能排除 `*`**：这个仓库满篇 `**加粗**`，排掉的话 `**suggest.ts**`
//    这种写法永远查不到，而自检只看总数，察觉不到少了一类。
//    `.` 和字母数字仍然要排除——那是为了不把 `a.b.ts`、`x/*.test.ts` 的尾巴当成名字。
//    后缀里带上 md / yml，是为了收仓库根上那几个**被指得最多**的文件
//    （`AGENTS.md` 是正本、`novel-manager-spec.md` 是需求正本、CI 配置），
//    它们没有目录前缀，光靠 PATH_RE 够不着，改名了不会有任何东西响。
//    **故意不收 `.json`**：那会把 `res.json()` / `await r.json()` 这种方法调用
//    当成文件名，一次就冒出七八条误报——堵的洞没有捅的大。
//    **收 `.css`**：`styles.css` / `shell.css` 在注释里被指了九次，而它们没有目录
//    前缀，PATH_RE 够不着——正好这一轮还在往两份样式表之间搬规则。
//    目录段限到 4 层（`docs/superpowers/specs/` 底下那些是这个仓库最深的），
//    **不是为了好看**：写成 `(…\/)*` 时那个嵌套量词在 `/` 密集的文本上会指数回溯，
//    实测 40KB 的 `a/a/a/…` 要 764ms（限到 4 层是 1ms）。哪天有人提交一段
//    base64 或 data: URI，`npm run lint:ui` 就会变成一次没有输出的长时间卡死。
const NAME_RE = /(?<![.\w-])((?:[A-Za-z0-9_$-]+\/){0,4}[A-Za-z][A-Za-z0-9_-]*\.(?:test\.ts|ts|tsx|mjs|cjs|css|md|yml))\b/g;
// ② <!-- stale-refs:off -->「X.ts 的 Y」<!-- stale-refs:on -->（占位名，不是真文件）
const QUAL_RE = /`?([A-Za-z][A-Za-z0-9_./-]*\.(?:ts|tsx|mjs|cjs|css))`?\s*(?:里|中)?的\s*`?([A-Za-z_$][A-Za-z0-9_$]{2,}(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)`?/g;

/**
 * 讲「指错了」这件事本身的段落，里面举的**全是反例**，扫它等于自己报自己。
 * 用一对不可见的标记圈起来（markdown 里是注释，什么都不渲染）：
 *
 *     <!-- stale-refs:off -->  …反例…  <!-- stale-refs:on -->
 *
 * 故意做成**区段**而不是整文件豁免，更不是 ALLOW：别处真正的指路还得接着查。
 */
const blankOut = (txt) =>
  txt.replace(
    /<!--\s*stale-refs:off\s*-->[\s\S]*?<!--\s*stale-refs:on\s*-->/g,
    (m) => m.replace(/[^\n]/g, ' '), // 换成等长空白，行号才不会串
  );

/**
 * 代码文件里**只看注释**，把代码本身抹成空白。
 *
 * 这个脚本查的是「**注释和文档**里指的东西」，而代码里的字符串字面量多半是
 * 运行时路径、不是指路：<!-- stale-refs:off -->`writeFileSync(join(lib, 'notes.md'))`<!-- stale-refs:on --> 是测试往临时目录里
 * 造的夹具，`await r.json()` 更是压根不是文件名。把它们一起收进来只会逼着人
 * 往 ALLOW 里塞通用名字——而那正是这张表烂掉的方式。
 *
 * markdown / yml 这类整篇都是文档，不做这一步。
 */
const commentsOnly = (txt) => {
  // ⚠️ **块注释要按状态跟着走，不能只看行首。** 第一版判的是
  // `/^\s*(\/\/|\/\*|\*)/`，于是两类注释整块被抹掉：JSX 的 `{/* … */}`
  // （开头是 `{`）和**续行不写 `*`** 的块注释——这个仓库两种都到处是。
  // 实测 525 行注释因此不在扫描范围内，其中 6 处是真的指路（`RuleEditor.tsx`
  // 里那条 `scripts/ui-check/audit.mjs` 是完整路径，正是 PATH_RE 存在的理由）。
  // 一个**只查了一半文件**的检查器，和静默什么都没查是同一件事。
  let inBlock = false;
  return txt
    .split('\n')
    // 其余仍然**按行判、不解析语法**：行尾注释只留 `//` 之后那一截，
    // 其余抹成等长空白——行号和列号都不能串，报出来的位置要能直接点开。
    // ponytail: 字符串里出现 `//`（比如 `'http://…'`）会被当成注释开头，
    // 于是那行后半截也进了扫描范围。代价只是多扫几个 URL，而 URL 里没有
    // <!-- stale-refs:off -->`xxx.ts`<!-- stale-refs:on --> 这种形状，实测零误报；真出问题再上正经的词法扫描。
    .map((line) => {
      if (inBlock) {
        if (line.includes('*/')) inBlock = false;
        return line;
      }
      const slash = line.indexOf('//');
      // ⚠️ **只认「行首（最多带一个 `{` 或 `(`）就是 `/*`」的那种开头。**
      //
      // 光用 `indexOf('/*')` 的话，**字符串字面量里的 `/*` 会开出一个假块注释**，
      // 而它当然没有 `*/` 收尾——于是从那一行到文件末尾全被当成注释扫。
      // 这个仓库里满地都是触发它的东西：`'**/node_modules/**'` 这类 glob、
      // JSX 里的 `<code>/**</code>`（`LibraryDirs.tsx` 就有，而且这一轮还在改它）、
      // 连本文件自己的 `line.indexOf('/*')` 都算一个。
      // 形状和第一版那个 `/^\s*(\/\/|\/\*|\*)/` 一模一样，只是反过来：
      // 上次是**漏扫**真注释，这次是**多扫**真代码——两种都让检查器悄悄查错了范围。
      //
      // 判据用「前面除了空白只允许 `{` `(`」：这个仓库的块注释一律另起一行
      // （JSX 里前面挂个 `{`），而字符串里的 `/*` 前面必然有别的代码。
      const star = /^[\s{(]*\/\*/.test(line) ? line.indexOf('/*') : -1;
      // `//` 在前就是行注释，里面的 `/*` 不算块开头——本文件自己就写着 `x/*.test.ts`，
      // 认成块开头的话它后面**整个文件**都会被当注释扫
      if (star >= 0 && (slash < 0 || star < slash)) {
        if (line.indexOf('*/', star + 2) < 0) inBlock = true;
        return line;
      }
      if (/^\s*(\/\/|\*)/.test(line)) return line;
      return slash >= 0 ? ' '.repeat(slash) + line.slice(slash) : ' '.repeat(line.length);
    })
    .join('\n');
};

const CODE = /\.(ts|tsx|mjs|cjs)$/;

/** 目标文件按需读一次就够，热门的 `chapter.ts` 会被点名很多回 */
const textCache = new Map();
const textOf = (rel) => {
  if (!textCache.has(rel)) textCache.set(rel, readFileSync(abs(rel), 'utf8'));
  return textCache.get(rel);
};

const bad = [];
let pathRefs = 0;
let nameRefs = 0;

/*
 * ⚠️ **自检要验「还抓得住坏东西吗」，不是「还数得出引用吗」。**
 *
 * 下面那三个计数验的是后者：三类各自设下限，一条正则整个失效能被发现。
 * 但**判据本身**（「这个名字在不在仓库里」）坏掉时，它照样会一边报
 * 「一切正常」一边什么都没查。这个循环里刚踩过一次同形状的。
 *
 * 所以拿三段合成的坏引用喂那三条正则：都抓不到就报错退出。
 */
// **诱饵要长得像真的引用**：三条正则认的都是 ASCII 的路径/文件名/标识符，
// 第一版拿中文名当诱饵，三段里只认出一段——那不是判据坏了，是诱饵不像样
const DECOY = [
  'src/core/no-such-file.ts',
  'nosuchmodule.ts',
  'clean.ts 的 noSuchFunction',
].join(String.fromCharCode(10));
const decoyHits = [...DECOY.matchAll(PATH_RE)].length
  + [...DECOY.matchAll(NAME_RE)].length
  + [...DECOY.matchAll(QUAL_RE)].length;
if (decoyHits < 3) {
  console.error(`✗ 自检没过：三段合成的坏引用只认出 ${decoyHits} 段——这个脚本的判据已经失效了`);
  process.exit(1);
}
let qualRefs = 0;

for (const f of docs) {
  const raw = readFileSync(abs(f), 'utf8');
  const txt = blankOut(CODE.test(f) ? commentsOnly(raw) : raw);
  const lineOf = (i) => txt.slice(0, i).split('\n').length;

  // 完整路径先查，记下吃掉的区间，免得 NAME_RE 就同一处再报一遍
  const taken = [];
  for (const m of txt.matchAll(PATH_RE)) {
    pathRefs++;
    taken.push([m.index, m.index + m[0].length]);
    if (existsSync(abs(m[1])) || ALLOW.has(basename(m[1]))) continue;
    bad.push(`${f}:${lineOf(m.index)}  路径不存在：${m[1]}`);
  }

  for (const m of txt.matchAll(NAME_RE)) {
    if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue; // 已按完整路径报过
    // 这里**不往 `taken` 里加**：同一个 `/g` 正则的 matchAll 不会给出重叠的匹配，
    // 加进去谁也读不到（实测 368 个匹配里被自己挡下的是 0 个），只是把后面每一次
    // `taken.some` 的比较次数翻上去，还让人以为两个循环之间有状态往来
    nameRefs++;
    const n = basename(m[1]);
    if (byName.has(n) || ALLOW.has(n)) continue;
    /*
     * ⚠️ **依赖里的文件也算数。** `byName` 是仓库自己那棵树建的，
     * `node_modules` 在 SKIP 里（枚举它慢得没必要），于是一句
     * 「这块 CSS 是从 `node_modules/pdfjs-dist/web/pdf_viewer.css` 搬来的」
     * 会被报成「找不到」——而那正是**最该守的一类指路**：
     * 升级依赖时，那个文件挪了位、改了名，注释就成了假的，
     * 而搬过来的那份 CSS 也就该重搬了。
     *
     * 不整棵枚举 `node_modules`，只在真报错前**按这一条路径查一次**。
     */
    if (existsSync(abs(m[1]))) continue;
    bad.push(`${f}:${lineOf(m.index)}  找不到这个文件：${m[1]}`);
  }

  for (const m of txt.matchAll(QUAL_RE)) {
    const [, file, ident] = m;
    let cands = existsSync(abs(file)) ? [file] : (byName.get(basename(file)) ?? []);
    // 同名文件不止一个时（`rpc.ts` 在 main 和 renderer 各有一个），**优先同目录那个**。
    // 不挑的话「任意一个里有这个名字就算过」——写在 `src/main/` 的注释说
    // <!-- stale-refs:off -->「`rpc.ts` 的 someRendererThing」<!-- stale-refs:on --> 会被 renderer 那份放行，那正是要抓的错。
    if (cands.length > 1) {
      const here = f.slice(0, f.lastIndexOf('/') + 1);
      const same = cands.filter((c) => c.startsWith(here));
      if (same.length) cands = same;
    }
    if (!cands.length) continue; // 上面那两条已经会报「文件不存在」
    qualRefs++;
    const root = ident.split('.')[0];
    // ponytail: 只做「这几个字符在那个文件里出现过」的粗判，不解析声明。
    // 漏得掉的是「名字还在、但只剩注释里提了一句」——比如某条规则改了名、
    // 而旧名字仍留在同文件的注释里。真被这种漏怕了，再按声明形式匹配
    // （`function Y` / `const Y` / `name: 'Y'`），代价是要处理解构、对象键之类的误报。
    if (cands.some((c) => textOf(c).includes(root))) continue;
    bad.push(`${f}:${lineOf(m.index)}  「${file} 的 ${ident}」——${cands.join('|')} 里没有 ${ident}`);
  }
}

// 自检：三条正则各自得有命中。下限压得比现状低不少（现状是几百 / 几百 / 几十），
// 因为**删文档不该让 CI 变红**——那会把人指向正则，而正则根本没坏。
// 它要拦的是「某条正则整个失效」，那种情况命中数会掉到 0 或个位数。
const low = [
  pathRefs < 20 && `路径 ${pathRefs}`,
  nameRefs < 20 && `文件名 ${nameRefs}`,
  qualRefs < 5 && `限定引用 ${qualRefs}`,
].filter(Boolean);
if (low.length) {
  console.error(`✗ 自检没过：${low.join('、')}——对应的正则多半没匹配上，这轮结果不算数`);
  process.exit(2);
}

/*
 * ── 反过来查一遍：**代码里的模块，AGENTS.md 提没提** ──────────────
 *
 * 上面查的是「文档指向的东西还在不在」，这一条是它的**对偶**。
 * 为什么要有：`AGENTS.md` 那张「在哪 | 是什么」的表就是给下一个人（或下一个 AI）
 * 的索引，**一个整块的子系统不在表里，下一个人就会当它不存在、再造一遍**——
 * 这个仓库为「走查工具已经有了，先跑它别再造」赔过一整轮。
 *
 * 实际漏过：`open.ts` / `primary.ts` / `reading-pos.ts` / `book-rule.ts` /
 * `FileViewer.tsx` / `CategoryDialog.tsx` 六个，一次全在表外。
 *
 * 判据很松——**「在 AGENTS.md 里出现过」就算**，不要求单独一行
 * （`zip.ts` 跟着 `export.ts` 一行、`tts-custom.ts` 跟着 `tts.ts` 一行，都算）。
 * 松到这个程度还漏，那就是真漏了。渲染进程不查：那儿几十个弹窗组件，
 * 逐个进表只会把这份每次会话都要内联的文件撑大。
 */
const 索引 = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
const 该进索引 = ['src/core/', 'src/main/', 'src/server/'];
// ⚠️ `all` 里**已经是正斜杠的相对路径**了（见上面 `walk`），别再切一次 ROOT——
// 第一版切了，结果一个都挑不出来，自检当场拦住
const 模块 = all.filter(
  (r) => 该进索引.some((d) => r.startsWith(d)) && r.endsWith('.ts') && !r.endsWith('.test.ts'),
);
const 没提到 = 模块.filter((r) => !索引.includes(basename(r)));

if (模块.length < 20) {
  console.error(`✗ 自检没过：只挑出 ${模块.length} 个该进索引的模块——那条路径判据多半没匹配上`);
  process.exit(2);
}
if (没提到.length) {
  for (const r of 没提到) console.log(`AGENTS.md 没提到这个模块：${r}`);
  console.log(`\n共 ${没提到.length} 个模块不在 AGENTS.md 的索引里。`
    + '那张表是下一个人的地图——不在表上的东西，他会当它不存在、再造一遍。');
  process.exit(1);
}

if (!bad.length) {
  console.log(`✔ 指路都对得上（路径 ${pathRefs} / 文件名 ${nameRefs} / 「X 的 Y」 ${qualRefs}）`);
  console.log(`✔ core/main/server 的 ${模块.length} 个模块，AGENTS.md 里都提到了`);
  process.exit(0);
}
for (const b of bad) console.log(b);
console.log(`\n共 ${bad.length} 处指向了不存在的东西。改注释；真是误报再动 ALLOW 或区段标记，理由要写清楚。`);
process.exit(1);
