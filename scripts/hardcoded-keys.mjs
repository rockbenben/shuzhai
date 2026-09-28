/**
 * 找**写死在界面上的按键名**。
 *
 * 起因：`Reader.tsx` 当年把 tooltip 里写死的「（T）」「（←）」「（B）」改成
 * `键('toc')` / `键('prev')` / `键('bookmark')`（见它 1396 行那段注释）——
 * 理由是**那些键可以改绑**（`settings.ts` 的 `DEFAULT_KEYS`），改完界面还在说
 * 默认那个键，就是在陈述一件假的事。而那次只修了 `Reader.tsx` 一处：
 * `FileViewer.tsx` 的「上一页（←）」「下一页（→）」和两侧的「（空格）」漏网，
 * 隔了一轮才被 Design QA 那遍文本清点抓到。
 *
 * **一条修过一次的判据，另一份实现不会自己跟上。** 所以这里钉住形状：
 * 用户看得见的字符串里出现键名，就必须从键表来。
 *
 * ⚠️ `Esc` 是**故意留的例外**，不是漏网：两个界面的 Esc 都只认 `Escape` 本身、
 * 不走 `actionFor`（判据写在 `Reader.tsx` 那段——退出键改绑成普通字母之后，
 * 在短评框里打字不该把卡片关掉）。所以「回书架（Esc）」是真话；
 * 把它也改成 `键('exit')` 反而变成假话。
 *
 * 跑法：`node scripts/hardcoded-keys.mjs`（在 `lint:ui` 里）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const 目录 = 'src/renderer';

/** 会出现在用户可见文案里的键名。Esc 不在列（见文件顶上那段） */
const 键名 = /(（|\\$\{)(←|→|↑|↓|空格|Page Up|Page Down|回车|退格)(）|\})/;
/** 单个字母的键位提示：「（T）」「（B）」这种 */
const 字母键 = /（[A-Za-z]）/;

const 找文件 = (d, out = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) 找文件(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
};

/**
 * 只看**用户看得见的位置**：JSX 属性 `title="…"` / `placeholder="…"` /
 * `aria-label="…"`，以及模板串里拼进去的那段。注释和 `console.*` 不算。
 */
const 是注释 = (行) => /^\s*(\*|\/\/|\/\*)/.test(行);

const 命中 = [];
const 文件 = 找文件(目录);
for (const f of 文件) {
  const 源 = readFileSync(f, 'utf8').split('\n');
  源.forEach((行, i) => {
    if (是注释(行)) return;
    const 是可见文案 = /(title|placeholder|aria-label)\s*=\s*[{"`]/.test(行)
      || /(setError|setNotice|set批量话|setMsg|alert)\s*\(/.test(行);
    if (!是可见文案) return;
    if (键名.test(行) || 字母键.test(行)) {
      命中.push(`${f}:${i + 1}  ${行.trim().slice(0, 90)}`);
    }
  });
}

/*
 * **自检：先证明这把尺子抓得住东西。**
 * 同 `audit.mjs` 那条规矩——一个永远报 0 条的体检和没有体检是一回事。
 * 拿一段真的写死了键名的代码去问它，抓不到就是尺子坏了。
 */
const 诱饵 = 'title="上一页（←）"';
if (!键名.test(诱饵)) {
  console.error('✗ 自检没过：这把尺子连「上一页（←）」都抓不住，先修它');
  process.exit(2);
}
// 反例：从键表来的写法必须不被报（否则把判据写成「凡是 title 都报」也能全绿）
const 诱饵2 = 'title={`上一页（${键(\'prev\')}）`}';
if (字母键.test(诱饵2) || /（(←|→|空格)）/.test(诱饵2)) {
  console.error('✗ 自检没过：把 `键(...)` 的正确写法误报了');
  process.exit(2);
}
// Esc 那条例外是真的：它不该被报
const 诱饵3 = 'title="回书架（Esc）"';
if (键名.test(诱饵3) || 字母键.test(诱饵3)) {
  console.error('✗ 自检没过：Esc 是设计如此，不该报它');
  process.exit(2);
}

if (命中.length) {
  console.log(`⚠ 界面上写死了按键名（${命中.length} 处）——用户改绑之后这句话就是假的：`);
  for (const m of 命中) console.log('  ' + m);
  console.log('\n改成 `键(\'prev\')` 那样从 `loadKeys()` 来（`Esc` 是有意例外，见本文件顶部）。');
  process.exit(1);
}
console.log(`✔ ${文件.length} 个界面文件，用户看得见的文案里没有写死的按键名（Esc 除外，那是设计如此）`);
