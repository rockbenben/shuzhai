// 快照：只拷库，不拷正文。
//
// SQLite 在线备份同时覆盖主库和已提交 WAL，避免逐文件复制遇到并发写入。
//
// **40 GB 的 txt 一个字节都不拷**：铁律 1 保证应用永远不往原文写，
// 所有读取都是按 (offset, length) 定点读，原地读即可——而「定点读一个 52 MB 的文件」
// 正是被量的对象。
import { existsSync, rmSync, statSync, mkdirSync, lstatSync, readdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, parse, sep } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

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

const OWNER = '.shuzhai-bench.json';

function checkedDirectory(path = snapshotDir()) {
  const dir = resolve(path);
  // 每一层都检查，父目录的 junction 也能把看似安全的路径转到真实档案。
  for (let current = dir; current !== parse(current).root; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('测台路径不能经过目录链接');
  }
  return dir;
}

function checkOwner(dir) {
  const marker = join(dir, OWNER);
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || lstatSync(marker).nlink > 1) throw new Error('目录没有独立的测台归属标记，拒绝清理');
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  if (owner.directory !== realpathSync(dir) || owner.kind !== 'shuzhai-bench') throw new Error('测台归属标记不匹配');
}

function checkDatabaseLinks(dbPath) {
  checkedDirectory(dirname(dbPath));
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (info && (info.isSymbolicLink() || info.nlink > 1)) throw new Error('快照数据库及侧车不能是软链接或硬链接');
  }
}

export async function makeSnapshot({ force = false, sourcePath } = {}) {
  const src = sourcePath ?? liveDbPath();
  if (!existsSync(src)) throw new Error(`找不到真实库：${src}`);
  const dir = checkedDirectory();
  const source = realpathSync(src);
  const sourceRelative = relative(dir, source);
  if (sourceRelative !== '..' && !sourceRelative.startsWith(`..${sep}`) && !isAbsolute(sourceRelative)) throw new Error('源书库不能在测台目录内');
  if (existsSync(dir) && readdirSync(dir).length) checkOwner(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, OWNER), JSON.stringify({ kind: 'shuzhai-bench', directory: realpathSync(dir) }));
  const dst = snapshotDbPath();
  if (existsSync(dst) && !force) {
    throw new Error(
      `快照已存在：${dirname(dst)}\n  要重来的话先 node scripts/bench.mjs teardown（或加 --force）`,
    );
  }
  mkdirSync(dirname(dst), { recursive: true });
  checkDatabaseLinks(dst);

  // SQLite 在线备份取得一致快照，包括已提交的 WAL，源连接只读。
  const sourceDb = new DatabaseSync(src, { readOnly: true });
  try { await backup(sourceDb, dst); } finally { sourceDb.close(); }
  const 带了 = [DB];

  const fp = fingerprintOf(statSync(src), Date.now());
  sealSnapshot(dst, fp);
  return { dst, fingerprint: fp, files: 带了 };
}

/**
 * 趁实例未启动写来源指纹，并隔离抓取和自动备份。
 *
 * 抓取必须在测之前断掉，否则整张表都是它的数（历史量级：开着抓取的首屏 40.8 秒）。
 * 比起来之后再叫停干净——后者会留下一段「已经开始抓但被叫停」的中间态。
 * `cover.autofetch` 这个键 `src/main/cover-fetcher.ts` 已经在读，不新开开关。
 */
export function sealSnapshot(dbPath, fingerprint) {
  checkDatabaseLinks(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('begin');
    const 写 = db.prepare('insert or replace into app_setting(key, value) values(?, ?)');
    写.run('perf.snapshot', fingerprint);
    写.run('cover.autofetch', '0');
    写.run('backup.auto', '0');
    写.run('backup.dir', join(dirname(dbPath), 'backups'));
    db.exec('commit');
  } catch (error) {
    db.exec('rollback');
    throw error;
  } finally {
    db.close(); // 关的时候 sqlite 自己会把 WAL 合并回去
  }
}

export function assertSnapshotReady(dir) {
  const path = join(dir, DB);
  checkDatabaseLinks(path);
  if (!existsSync(path)) throw new Error('测台快照不存在，请先创建快照');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const get = key => db.prepare('select value from app_setting where key=?').get(key)?.value;
    if (!parseFingerprint(get('perf.snapshot')) || get('backup.auto') !== '0'
      || get('cover.autofetch') !== '0' || resolve(get('backup.dir') ?? '') !== resolve(dir, 'backups')) {
      throw new Error('测台快照尚未完成隔离封存，请重新创建快照');
    }
  } finally { db.close(); }
}

export function dropSnapshot() {
  const dir = checkedDirectory();
  if (!existsSync(dir)) return;
  checkOwner(dir);
  rmSync(dir, { recursive: true, force: true });
}
