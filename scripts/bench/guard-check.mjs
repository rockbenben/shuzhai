// `--big` 那道闸门的证据。
//
// **为什么不是「对着用户真实的库跑一次看它拒不拒」**：那是这次唯一会去驱真实实例的一步，
// 而驱它一次的成本是「万一它没拒，往 reading_state 里写了点什么」——铁律 3 里重扫恢复不了。
// 拒绝这件事不需要拿真库来证：闸门认的是**有没有封条**，所以造一份**去掉封条的快照副本**
// 就是同一个二值判断，而且一个字节都不碰用户的库。
import { copyFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { snapshotDir, userDataDir, snapshotDbPath } from './snapshot.mjs';
import { launch, kill, CDP_PORT } from './app.mjs';

const 没封条 = () => join(snapshotDir(), 'userdata-noseal');

/** 拷一份档案、把封条那一行删掉。副本不跑迁移，schema 和主快照一致 */
function 造没封条的副本() {
  const to = 没封条();
  rmSync(to, { recursive: true, force: true });
  // 平铺：和 snapshotDbPath 同一个形状（--user-data-dir 就是 userData 本身，不套应用名）
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(userDataDir())) {
    if (f.startsWith('library.db')) copyFileSync(join(userDataDir(), f), join(to, f));
  }
  const db = new DatabaseSync(snapshotDbPathOf(to));
  try {
    db.prepare("delete from app_setting where key = 'perf.snapshot'").run();
  } finally {
    db.close();
  }
  return to;
}
const snapshotDbPathOf = (dir) => join(dir, 'library.db');

/** 驱一次 `connect()`：它自己会在闸门处 process.exit(1)，放行则退出 0 */
function 探一次() {
  const r = spawnSync(process.execPath,
    [join(import.meta.dirname, 'probe-big.mjs'), '--big'],
    { encoding: 'utf8', env: { ...process.env, SHUZHAI_BENCH_CDP: CDP_PORT } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

export async function guardCheck() {
  if (!existsSync(snapshotDbPath())) {
    console.error('✗ 先跑 node scripts/bench.mjs snapshot');
    return 1;
  }
  let 失败 = 0;

  // ① 有封条：必须放行
  console.log('— 起「有封条」的快照');
  if (await launch() === 0) {
    const p = 探一次();
    const ok = p.code === 0;
    console.log(`${ok ? '✓' : '✗'} 有封条 + --big → ${ok ? '放行' : '被拒：' + p.out.trim()}`);
    失败 |= ok ? 0 : 1;
  } else 失败 = 1;
  await kill();

  // ② 没封条（等同用户自己的库在这道闸门眼里的样子）：必须拒绝
  console.log('— 起「去掉封条」的副本');
  const 副本 = 造没封条的副本();
  if (await launch({ dir: 副本 }) === 0) {
    const p = 探一次();
    const ok = p.code !== 0 && /没有测台封条/.test(p.out);
    console.log(`${ok ? '✓' : '✗'} 没封条 + --big → ${ok ? '当场拒绝' : '放行了！闸门没生效：' + p.out.trim()}`);
    失败 |= ok ? 0 : 1;
  } else 失败 = 1;
  // 收的是**那个副本**的实例。默认参数收的是 userdata——收错了就等于留一个孤儿占着
  // 调试端口，而下一个脚本连上的就是它；上一轮那个 EPERM 就是这么来的。
  await kill({ dir: 副本 });
  rmSync(副本, { recursive: true, force: true });

  console.log(失败 ? '\n✗ 闸门没立住' : '\n✓ 两头都对：有封条放行、没封条拒绝');
  return 失败;
}
