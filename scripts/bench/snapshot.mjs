// 快照：只拷库，不拷正文。
//
// **三个文件一起拷是硬要求**：`library.db-wal` 里有未合并的已提交帧（2026-09-25 实测
// 那份库旁边躺着 4.1 MB 的 -wal），只拿主文件会让 sqlite 拿到对不上的 WAL。
// 这条在 `src/main/migrate-userdata.ts` 那次搬家上丢过两条事务，方向相反、根是同一个。
//
// **40 GB 的 txt 一个字节都不拷**：铁律 1 保证应用永远不往原文写，
// 所有读取都是按 (offset, length) 定点读，原地读即可——而「定点读一个 52 MB 的文件」
// 正是被量的对象。
import { copyFileSync, existsSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DB = 'library.db';
export const SIDECARS = [DB + '-wal', DB + '-shm'];

/** 快照落点：环境变量能改，默认放系统盘之外（真实库 597 MB，C 盘常年紧） */
export function snapshotDir() {
  return process.env.SHUZHAI_BENCH_DIR || join('D:', 'tmp', 'szperf');
}
/** Electron 的 --user-data-dir 要的是那个目录，库在它下面的 shuzhai/ 里 */
export function userDataDir() {
  return join(snapshotDir(), 'userdata');
}
/**
 * 快照的库在哪。**平铺在 --user-data-dir 给的那个目录下，不再套一层应用名**：
 * Electron 的 `--user-data-dir` 就是**直接**把 userData 定成那个目录，
 * 应用名那一层只在没传这个参数时才套（`%APPDATA%\shuzhai\`）。
 *
 * 第一版照抄了真实库的形状，写成 `userdata/shuzhai/library.db`——
 * 于是应用对着 `userdata/library.db` **新建了一个空库**并跑完迁移，
 * 起得来、接口通、一句错都不报，只是 `books: 0`。
 * 那正是 AGENTS.md 开头那场「数据目录搬家」事故的形状（应用只是开了个新库），
 * 差别是这次量得出来：`launch` 那行会打印本数。**所以那个数别去掉。**
 */
export function snapshotDbPath() {
  return join(userDataDir(), DB);
}

/** 来源指纹：记住这份快照是从哪个库、什么时候拷的。见 spec §2 */
export function fingerprintOf(srcStat, copiedAt) {
  return JSON.stringify({
    srcSize: srcStat.size,
    srcMtimeMs: Math.round(srcStat.mtimeMs),
    copiedAt,
  });
}

/** 读不懂就退回 null，别抛——闸门要的是「有没有封条」这个二值判断 */
export function parseFingerprint(s) {
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    return typeof o.srcSize === 'number' && typeof o.copiedAt === 'number' ? o : null;
  } catch {
    return null;
  }
}

/**
 * 真实库的位置。**靠 `package.json` 的 name 算，不是照抄路径**：
 * `app.getPath('userData')` 取的就是那个字段（AGENTS.md 开头那场数据事故讲的是动它的后果）。
 */
export function liveDbPath() {
  const name = process.env.SHUZHAI_APP_NAME || 'shuzhai';
  const base = process.platform === 'win32'
    ? join(process.env.APPDATA, name)
    : join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), name);
  return join(base, DB);
}

export function makeSnapshot({ force = false } = {}) {
  const src = liveDbPath();
  if (!existsSync(src)) throw new Error(`找不到真实库：${src}`);
  const dst = snapshotDbPath();
  if (existsSync(dst) && !force) {
    throw new Error(
      `快照已存在：${dirname(dst)}\n  要重来的话先 node scripts/bench.mjs teardown（或加 --force）`,
    );
  }
  mkdirSync(dirname(dst), { recursive: true });

  // 主文件 + 侧车，三个一起。侧车可能不存在（库被干净关闭过），那是正常状态。
  copyFileSync(src, dst);
  const 带了 = [DB];
  for (const side of SIDECARS) {
    const s = join(dirname(src), side);
    if (existsSync(s)) {
      copyFileSync(s, join(dirname(dst), side));
      带了.push(side);
    }
  }

  const fp = fingerprintOf(statSync(src), Date.now());
  sealSnapshot(dst, fp);
  return { dst, fingerprint: fp, files: 带了 };
}

/**
 * **趁库还关着**写两行：来源指纹，和关掉封面抓取。
 *
 * 抓取必须在测之前断掉，否则整张表都是它的数（历史量级：开着抓取的首屏 40.8 秒）。
 * 比起来之后再叫停干净——后者会留下一段「已经开始抓但被叫停」的中间态。
 * `cover.autofetch` 这个键 `src/main/cover-fetcher.ts` 已经在读，不新开开关。
 */
export function sealSnapshot(dbPath, fingerprint) {
  const db = new DatabaseSync(dbPath);
  try {
    const 写 = db.prepare('insert or replace into app_setting(key, value) values(?, ?)');
    写.run('perf.snapshot', fingerprint);
    写.run('cover.autofetch', '0');
  } finally {
    db.close(); // 关的时候 sqlite 自己会把 WAL 合并回去
  }
}

export function dropSnapshot() {
  rmSync(snapshotDir(), { recursive: true, force: true });
}
