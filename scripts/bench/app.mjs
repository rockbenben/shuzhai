// 测台自己 spawn electron，不要求人手工敲三行 powershell。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ROOT } from '../repo-root.mjs';
import { waitPortFree } from '../ui-check/port-free.mjs';
import { snapshotDir, userDataDir } from './snapshot.mjs';

export const CDP_PORT = process.env.SHUZHAI_BENCH_CDP || '9876';
export const API_PORT = process.env.SHUZHAI_BENCH_API || '30037';
export const API = `http://127.0.0.1:${API_PORT}`;

/**
 * 每个档案目录一份 pid 记录，**按目录名（tag）索引**。`guard-check` 要在「有封条」和
 * 「没封条」两份目录之间来回起停，共用一个文件的话第二个实例的 pid 会把第一个盖掉——
 * 第一个就成了孤儿，而它占着调试端口，下一个脚本连上的就是它
 * （`ui-check/README.md`「先确认 9876 那头是谁」记的就是这件事）。
 */
const pidfileFor = (tag) => join(snapshotDir(), `bench-${tag}.pid`);

const exe = () => join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');

/**
 * 两条「装完依赖之后必然撞上」的检查，提前说成人话：
 * ① Electron 42 起不再有 postinstall，`npm ci` 之后那个 dist 目录根本不存在；
 * ② 没 build 就没有 dist/index.html，窗口白屏。
 * 这两条都不查 `npm test` 会自己绿给你看——四道闸门全绿也说明不了应用起得来。
 */
export function preflight() {
  if (!existsSync(exe())) {
    console.error('✗ 没有 electron 的二进制：' + exe());
    console.error('  装一下：npx install-electron   （或 node node_modules/electron/install.js）');
    return false;
  }
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    console.error('✗ 没有渲染包：dist/index.html');
    console.error('  先跑：npm run build');
    return false;
  }
  return true;
}

export async function launch({ dir = userDataDir() } = {}) {
  if (!preflight()) return 1;
  if (!existsSync(dir)) {
    console.error('✗ 档案目录不存在：' + dir + '\n  先跑 node scripts/bench.mjs snapshot');
    return 1;
  }
  /*
   * **起之前先确认两个口都绑得上。** 上一个实例还没退干净就起新的，新进程 `bind()`
   * 失败直接退出（`ui-check/port-free.mjs` 顶注记着这一族坑，两层：不应答 ≠ 空了，
   * 拒绝连接也 ≠ 空了），而外面那句就绪轮询会**从还活着的旧实例拿到答案**。
   * 实测就栽在这儿：`guard-check` 第二趟报「8299 本 · 就绪」，而 `startedAt`
   * 和第一趟逐字相同——「没封条要拒绝」那一下实际驱的是**上一个实例**。
   */
  for (const p of [Number(CDP_PORT), Number(API_PORT)]) {
    if (!(await waitPortFree(p, { tries: 20 }))) {
      console.error(`✗ 端口 ${p} 十秒还绑不上：有实例没退干净。`
        + '  先 node scripts/bench.mjs kill；还不行就 tasklist 找 electron.exe。');
      return 1;
    }
  }
  const child = spawn(exe(), [
    `--user-data-dir=${dir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '.',
  ], {
    cwd: ROOT,
    // **detached + unref**：不这么做的话，`node scripts/bench.mjs launch` 一退出，
    // 它的控制台一关，Electron 收到 CTRL_CLOSE_EVENT 就自己走了——
    // 实测症状是「就绪了、8299 本、下一句 kill 却说『没有要收的实例』」，
    // 而 30037 已经没人应答。人肉开的那个窗口没这个问题，所以走查脚本一直没撞上。
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, SHUZHAI_API_PORT: API_PORT },
  });
  child.unref();
  writeFileSync(pidfileFor(basename(dir)), String(child.pid));

  // 就绪判据是接口通了，不是窗口出来了（历史量级是一秒多）。
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const s = await (await fetch(`${API}/api/stats`)).json();
      if (typeof s.books === 'number') {
        console.log(`✓ 实例就绪 pid ${child.pid} · ${s.books} 本 · startedAt ${s.startedAt}`);
        return 0;
      }
    } catch { /* 还没起来 */ }
  }
  console.error(`✗ 30 秒没等到接口。多半是 ${API_PORT} 也被占着——换 SHUZHAI_BENCH_API，`
    + '别去抢用户那个实例的口（那正是 cdp.mjs 那道闸门防的事）。');
  await kill({ dir });
  return 1;
}

/**
 * 先请它自己走，不走再强制。
 *
 * 首选不带 `/F` 是有原因的：主进程退出时要跑 `closeOpenSessions('quit')`
 * （AGENTS.md 列着 43.5.1 修的那条 Windows 关机崩溃）。**但对隐藏窗口的进程
 * 这一条发不出去**——`taskkill` 不带 `/F` 靠的是 `WM_CLOSE`，而 `windowsHide`
 * 起来的实例压根没有窗口收得到它。实测症状就是「发了退出，十秒了还在」。
 * 所以：先给它三秒，没走就 `/F /T` 连子进程一起收（测台是快照，不是用户的库，
 * 强制退出不丢任何不可再生的东西——真正的那份还在原处）。
 */
export async function kill({ dir = userDataDir() } = {}) {
  const f = pidfileFor(basename(dir));
  if (!existsSync(f)) return false;
  const pid = Number(readFileSync(f, 'utf8'));
  const taskkill = (args) => spawnSync('taskkill', args, { stdio: 'ignore' });
  const gone = async (ms) => {
    for (let i = 0; i < ms / 250; i++) {
      try { process.kill(pid, 0); } catch { return true; }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  taskkill(['/PID', String(pid)]);
  if (!(await gone(3000))) {
    taskkill(['/PID', String(pid), '/T', '/F']);
    if (!(await gone(10000))) {
      console.error(`✗ pid ${pid} 强制也收不掉——手动 tasklist 看一眼，别放着占端口`);
      return false;
    }
  }
  rmSync(f, { force: true });
  // 进程没了 ≠ 端口空了（见 port-free.mjs 顶注），下一趟起实例前要等的是后者
  await waitPortFree(Number(CDP_PORT), { tries: 20 });
  await waitPortFree(Number(API_PORT), { tries: 20 });
  console.log(`✓ 实例已收（${basename(dir)} · pid ${pid}）`);
  return true;
}

/**
 * 把所有还活着的测台实例都收掉。**先按 pid 记录，再按命令行扫一遍孤儿。**
 *
 * 为什么需要第二条：旧版 `kill` 先删记录、再去等进程消失，等的过程中失败了就留下
 * 「进程活着而记录没了」——下一句 `kill` 报「没有要收的实例」，而 9876/30037 被一个
 * 没人认领的实例占着，下一个脚本连上的就是它。实测踩过一次，卡住了整趟 guard-check。
 *
 * 认孤儿的依据是**命令行里带着这个快照目录的绝对路径**，不是「是 electron 就行」：
 * 用户自己那个实例的 `--user-data-dir` 是默认的 `%APPDATA%\shuzhai`，匹配不上，
 * 所以这条不会误伤（这也正是它不能写成 `taskkill /IM electron.exe` 的原因）。
 */
export async function killAll() {
  const 活 = runningPids();
  const 记录到的 = new Set(活.map((p) => p.pid));
  for (const p of 活) await kill({ dir: join(snapshotDir(), p.tag) });
  let 扫 = 0;
  for (const pid of 孤儿pids()) {
    if (记录到的.has(pid)) continue;
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    扫++;
  }
  if (扫) {
    console.log(`✓ 另收掉 ${扫} 个没有记录的测台实例（按命令行认的孤儿）`);
    await waitPortFree(Number(CDP_PORT), { tries: 20 });
    await waitPortFree(Number(API_PORT), { tries: 20 });
  }
  return 活.length + 扫;
}

/** 命令行里带快照路径的 electron pid。查询失败就返回空——**宁可漏收也不误杀**。 */
function 孤儿pids() {
  const dir = snapshotDir().replace(/'/g, ''); // 路径进 PowerShell 字符串：单引号一律剔掉
  const q = `Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" `
    + `| Where-Object { $_.CommandLine -like '*${dir}*' } | ForEach-Object { $_.ProcessId }`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', q], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return (r.stdout || '').split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean);
}

/**
 * 还活着的测台进程：pid 记录里的 + 命令行扫出来的孤儿。
 * `teardown` 判「敢不敢删快照」用的是这个，**不是只看记录**——只看记录的话，
 * 一个记录丢了但还占着端口和库的实例会被当成不存在，快照当场删在它脚下。
 */
export function liveBenchPids() {
  return [...new Set([...runningPids().map((p) => p.pid), ...孤儿pids()])];
}
export function runningPids() {
  const d = snapshotDir();
  if (!existsSync(d)) return [];
  const alive = [];
  for (const f of readdirSync(d)) {
    if (!/^bench-.*\.pid$/.test(f)) continue;
    const pid = Number(readFileSync(join(d, f), 'utf8'));
    if (!pid) continue;
    try {
      process.kill(pid, 0); // 不发信号，只问「这进程在不在」：不在抛 ESRCH
      alive.push({ pid, tag: f.replace(/^bench-|\.pid$/g, '') });
    } catch {
      rmSync(join(d, f), { force: true }); // 死实例留下的陈旧记录，顺手清掉
    }
  }
  return alive;
}
