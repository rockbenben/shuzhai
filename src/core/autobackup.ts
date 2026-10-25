// 自动备份（spec §10）。
//
// 备份内容本身在 backup.ts，这里只管两件事：**什么时候该备**、**留几份**。
// 拆开是因为「该不该备份」是纯逻辑，能直接测；而真备份要读整个库、写文件。
//
// 一条判据值得写明：**按「距上次备份多久」算，不按固定时刻**。
// 桌面应用不是常驻服务，用户可能好几天不开——按时刻排会一次都不触发，
// 而他恰恰是最需要备份的那种人。

import { readdir, unlink, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, setSetting } from './db.ts';
import { exportBackup } from './backup.ts';

/**
 * 自动备份文件名的前缀。
 *
 * ⚠️ **这是写进用户磁盘的标识符，不是产品名——以后别再顺手改。**
 * 它**同时用来写文件名和认已有的文件**（`backupName` 写、`prune` 按
 * `startsWith(PREFIX)` 挑）。换一个前缀之后：
 *
 *   - 磁盘上用旧前缀存的备份**一个都不再被认出来**；
 *   - 「只保留最近 N 份」只数得到新文件，旧的永远不会被清，堆到天荒地老。
 *
 * （恢复倒是不受影响：备份弹窗没有列表，走的是文件选择器，用户还能自己挑那些旧文件。
 * 真正丢的是「留几份」这条自动清理——而备份护的正是铁律 3 那三样重扫恢复不了的数据。）
 *
 * 从 `novel-manager-backup-` 改成现在这个，**只是因为当时全盘搜过、一个备份文件
 * 都没有**（`backup.dir` 从没配过，用户也没手动导出过），迁移成本恰好是零。
 * 那是一次性的窗口，现在已经关上了：真要再改，得先写「两个前缀都认、
 * 只按新前缀写」的过渡逻辑。同类的还有 `webdav.ts` 的 `BACKUP_NAME`。
 */
export const PREFIX = 'shuzhai-backup-';
const LAST_KEY = 'backup.lastAt';
const LAST_ERROR_KEY = 'backup.lastError';

export interface AutoBackupConfig {
  enabled: boolean;
  dir: string;
  /** 每几天备一次 */
  everyDays: number;
  /** 保留最近几份 */
  keep: number;
}

/** `backup.autoConfig` 的返回：配置 + 上次备份时间 + 上次自动备份错误。**界面和对话框共用这一份** */
export interface AutoBackupStatus extends AutoBackupConfig {
  lastAt: string | null;
  /** 上次自动备份失败的原因；成功备份后清掉 */
  lastError: string | null;
}

export const DEFAULT_AUTOBACKUP: AutoBackupConfig = {
  enabled: false,
  dir: '',
  everyDays: 7,
  keep: 5,
};

/** 默认备份文件夹名。**位置由主进程按系统「文档」目录拼**——core 不 import electron */
export const DEFAULT_BACKUP_FOLDER = '书斋备份';

/**
 * 给没配过目录的库装上默认目录；**只有从没配过目录、也从没备份过的库**才顺手打开自动备份。
 * 用户明确关过（`backup.auto = '0'`）或已经备份过的，不替他们打开自动备份；
 * 但目录为空时仍会补上默认目录，用户之后想开自动备份就有落点。
 *
 * 放在主进程 `openDb` 之后、窗口打开之前调。`defaultDir` 由主进程用
 * `app.getPath('documents')` 拼出来；core 拿不到那个路径，也不该 import electron。
 */
export function ensureDefaultBackupConfig(db: DatabaseSync, defaultDir: string): void {
  const hadDir = !!getSetting(db, 'backup.dir');
  const autoSet = !!db
    .prepare('select 1 from app_setting where key = ?')
    .get('backup.auto');
  const lastAt = getSetting(db, 'backup.lastAt');

  if (!hadDir) setSetting(db, 'backup.dir', defaultDir);
  // 只有「三样都没有」的新库才默认打开：用户已经选过目录的，不替他改主意。
  if (!hadDir && !autoSet && !lastAt) setSetting(db, 'backup.auto', '1');
}

export function readConfig(db: DatabaseSync): AutoBackupConfig {
  return {
    enabled: getSetting(db, 'backup.auto') === '1',
    dir: getSetting(db, 'backup.dir'),
    everyDays: Number(getSetting(db, 'backup.everyDays')) || DEFAULT_AUTOBACKUP.everyDays,
    keep: Number(getSetting(db, 'backup.keep')) || DEFAULT_AUTOBACKUP.keep,
  };
}

/**
 * 现在该不该备份。`now` 是参数不是内部取时间——不传时间就没法测，
 * 而「刚好到期」「从没备过」这两个边界恰恰最容易写错。
 */
export function shouldBackup(cfg: AutoBackupConfig, lastAt: string | null, now: Date): boolean {
  if (!cfg.enabled || !cfg.dir) return false;
  if (!lastAt) return true; // 从没备过，立刻备一次

  const last = new Date(lastAt).getTime();
  if (Number.isNaN(last)) return true; // 记录坏了，当作没备过
  return now.getTime() - last >= Math.max(1, cfg.everyDays) * 86_400_000;
}

/** 备份文件名。用时间戳排序，不依赖文件系统的 mtime */
export function backupName(iso: string): string {
  return `${PREFIX}${iso.replace(/[:.]/g, '-')}.json`;
}

/**
 * 只留最近 `keep` 份，其余删掉。
 * **只删自己产生的文件**——按前缀认，绝不动导出目录里别的东西。
 */
export async function prune(dir: string, keep: number): Promise<string[]> {
  // **两个前缀都认，只按新的写。** 上面那段警告说了改前缀的下场，
  // 而它当时只写了「以后别再改」，没有兑现「这一次改了怎么办」——
  // 旧前缀的备份不被 prune 数进来，`keep = 5` 就悄悄变成「5 份新的 + N 份旧的，
  // 无限长」，而它们护的正是铁律 3 那三张重扫恢复不了的表。
  // 一行的事，比那段十五行的警告有用。
  const OLD_PREFIX = 'novel-manager-backup-';
  const files = (await readdir(dir).catch(() => []))
    .filter((f) => (f.startsWith(PREFIX) || f.startsWith(OLD_PREFIX)) && f.endsWith('.json'))
    // 文件名里是 ISO 时间戳，**同前缀内**字典序就是时间序；两个前缀混在一起时
    // 前缀本身会先参与比较，所以先按时间戳排，取不到时间戳的沉到最前（先被清）
    .sort((a, b) => (a.replace(/^[a-z-]+backup-/, '') < b.replace(/^[a-z-]+backup-/, '') ? -1 : 1));

  const doomed = files.slice(0, Math.max(0, files.length - Math.max(1, keep)));
  for (const f of doomed) await unlink(join(dir, f)).catch(() => {});
  return doomed;
}

export interface AutoBackupResult {
  path: string;
  pruned: string[];
}

/** 真正执行一次自动备份，并记下时间 */
export async function runBackup(
  db: DatabaseSync,
  cfg: AutoBackupConfig,
  now: Date,
): Promise<AutoBackupResult> {
  // **说了怎么办才算数**：这句原来只说「还没选」，而用户此刻要知道的是去哪儿选。
  // 那个按钮就在同一个弹窗里（同 `openHint` 那条：报错是用户唯一会照着做的那句话）
  if (!cfg.dir) throw new Error('还没选备份文件夹——在「备份与恢复」里点「选备份文件夹…」，挑一个正在同步的文件夹最好');
  await mkdir(cfg.dir, { recursive: true });

  const iso = now.toISOString();
  const path = join(cfg.dir, backupName(iso));
  await writeFile(path, JSON.stringify(exportBackup(db)), 'utf8');

  // 先写新的再删旧的：反过来的话中途失败会既没新的也少了旧的
  const pruned = await prune(cfg.dir, cfg.keep);
  setSetting(db, LAST_KEY, iso);
  clearBackupError(db);
  return { path, pruned };
}

export function lastBackupAt(db: DatabaseSync): string | null {
  return getSetting(db, LAST_KEY) || null;
}

/** 上次自动备份失败的原因。**成功备份后由 `runBackup` 清掉** */
export function lastBackupError(db: DatabaseSync): string | null {
  return getSetting(db, LAST_ERROR_KEY) || null;
}

/** 记下自动备份失败的原因；下一次成功备份由 `runBackup` 清掉 */
export function recordBackupError(db: DatabaseSync, message: string): void {
  setSetting(db, LAST_ERROR_KEY, message.trim() || '未知错误');
}

function clearBackupError(db: DatabaseSync): void {
  setSetting(db, LAST_ERROR_KEY, '');
}

/** 启动、定时和扫描完成后都会来问一句；不该备就什么都不做 */
export async function maybeBackup(
  db: DatabaseSync,
  now: Date,
): Promise<AutoBackupResult | null> {
  // 空库不备：默认自动备份开着时，第一次开机还没有书，没必要在文档目录里
  // 留一份空 JSON；等扫描完成后的那次检查再备。
  if (!db.prepare('select 1 from book limit 1').get()) return null;
  const cfg = readConfig(db);
  if (!shouldBackup(cfg, lastBackupAt(db), now)) return null;
  return runBackup(db, cfg, now);
}
