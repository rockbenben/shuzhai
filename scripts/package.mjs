/**
 * 打包：暂存在**工作区外**，成品搬进 `release/`。
 *
 *   node scripts/package.mjs          → 出安装器 + 便携 zip，成品在 `release/`
 *   node scripts/package.mjs --dir    → 只出解包版（不碰 `release/`）
 *
 * **为什么不在仓库里直接打包**（这条是踩出来的，不是洁癖）：
 * 跑着这个仓库的那台桌面端，会把工作区里读过的文件以「共享读写、**不共享删除**」
 * 的方式挂住不放。实测被挂住的是各个 `release` 目录下的 `app.asar`
 * （`win-unpacked/resources/app.asar`）——用 Restart Manager
 * 查出来的占着者是宿主自己的 `node.mojom.NodeService` 进程。
 * 而 electron-builder 每打一次都要**重写** `app.asar`，于是：
 *
 *   - 同一个输出目录**连打两次，第二次一定 EBUSY**；
 *   - 那个文件从此**删不掉**（改属性、截断内容、MoveFileEx 登记重启删，全被拒，
 *     共享冲突错误码 32），只有宿主退出才会松手。
 *
 * 2026-10-23 就为了绕开这个，临时打过一份 `release-new/`、`release-verify/`，
 * 三个输出目录并存——那正是「为什么有 release-new、release-verify」的原因。
 *
 * 所以这里的做法是：**暂存目录放到工作区外**（`%TEMP%\shuzhai-dist`），
 * 打完只把**成品**（electron-builder 在输出目录里生成的那些文件）搬进 `release/`。
 * 工作区里一个 `app.asar` 都不留 → 锁不着、删不掉、也不会 EBUSY。
 *
 * **`release/` 的约定**：里面永远是**这一次**打出来的那一套——
 * 先把新成品拷进去，再删掉不在这一套里的旧文件（和 `win-unpacked/`）。
 * 残留删不掉时只警告，不让整次打包失败。
 *
 * ⚠️ `--publish never` 是本地打包该有的默认：electron-builder 配了
 * `publish.provider: github`，不加这个参数时它在 CI 环境变量下会去推 GitHub。
 * 本地只想出包，不该有推送。
 *
 * **这地方是唯一的决断点。** CI 的打包那步（`.github/workflows/release.yml`）
 * **不传**这个参数——传了也到不了这儿：`package.mjs` 只认 `--dir`，其余 argv
 * 一律不转发。workflow 那边原来写的是 `npm run dist -- --publish never`，看着
 * 像两道保险，其实那一道是装饰（2026-10-24 删掉了，让这儿说了算）。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './repo-root.mjs';

const 只要解包版 = process.argv.includes('--dir');
const 暂存 = join(tmpdir(), 'shuzhai-dist');
const 成品目录 = join(ROOT, 'release');

/** 跑一个 node 脚本；退出码非 0 就直接停。 */
function 跑(脚本, 参数) {
  const r = spawnSync(process.execPath, [脚本, ...参数], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n❌ ${脚本} 退出码 ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

function 兆(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---- 1. 清出一个干净的暂存目录（在工作区外）----
rmSync(暂存, { recursive: true, force: true });
mkdirSync(暂存, { recursive: true });

// ---- 2. 渲染进程先打包（electron-builder 只吃 `dist/`）----
console.log('\n[1/3] vite build');
跑(join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), ['build']);

// ---- 3. electron-builder，输出到暂存目录 ----
console.log('\n[2/3] electron-builder');
const builderArgs = [
  `--config.directories.output=${暂存}`,
  '--publish',
  'never',
  ...(只要解包版 ? ['--dir'] : []),
];
跑(join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), builderArgs);

if (只要解包版) {
  const app = join(暂存, 'win-unpacked');
  console.log(`\n[3/3] 解包版在暂存目录里（**没搬进 release/**）`);
  if (existsSync(app)) {
    console.log(`     启动它：${join(app, '书斋.exe')}`);
  } else {
    console.log(`     ⚠️ 没找到 ${app}，看看 electron-builder 上面打印了什么`);
  }
  process.exit(0);
}

// ---- 4. 成品搬进 `release/` ----
console.log('\n[3/3] 成品搬进 release/');
const 成品 = readdirSync(暂存, { withFileTypes: true }).filter((e) => e.isFile());
if (!成品.length) {
  console.error(`❌ 暂存目录里一个文件都没有：${暂存}`);
  process.exit(1);
}

mkdirSync(成品目录, { recursive: true });
for (const f of 成品) {
  copyFileSync(join(暂存, f.name), join(成品目录, f.name));
}
const 本轮 = new Set(成品.map((f) => f.name));

// 删掉不在这一套里的旧东西（`win-unpacked/` 和上一版的包）
for (const e of readdirSync(成品目录, { withFileTypes: true })) {
  if (e.isFile() && 本轮.has(e.name)) continue;
  const p = join(成品目录, e.name);
  try {
    rmSync(p, { recursive: true, force: true });
  } catch (err) {
    console.warn(`   ⚠️ 删不掉 ${e.name}（${err.code}）——多半是宿主还挂着一个 app.asar，不影响这次出包`);
  }
}

// ---- 5. 收尾：暂存目录里那份解包版不要了（它带 app.asar，留着只会又被挂住）----
rmSync(暂存, { recursive: true, force: true });

console.log('\nrelease/ 现在是这样：');
for (const e of readdirSync(成品目录, { withFileTypes: true })) {
  if (!e.isFile()) continue;
  const s = statSync(join(成品目录, e.name));
  console.log(`   ${e.name.padEnd(42)} ${兆(s.size)}`);
}
console.log('\n工作区里没有 app.asar（暂存在 %TEMP%），所以下次打包不会再 EBUSY。');
