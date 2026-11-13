// 改名「小说管理器 → 书斋」时把数据目录一起搬过来。
//
// `app.getPath('userData')` 取的是 package.json 的 `name`，改名等于换目录——
// 应用会在一个**空目录**里重新开张，而它一句错都不报，只是开了个新库。
// 用户看到的是「书库消失」，里面还有阅读进度和书签（铁律 3，重扫恢复不了）。

import { existsSync, renameSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 只搬这些。Cache / GPUCache / Local Storage 那些是 Chromium 的，重建就行，搬过去反而可能带上坏状态 */
const DIRS = ['covers', 'backups'];

/**
 * 搬之前先把 WAL 落进主库。
 *
 * **踩过：第一版把 `library.db` / `-wal` / `-shm` 三个一起 rename 过去，
 * 结果最后写进去的两条记录没了**（两本书的 `cover_path` 变成 null，封面文件还在磁盘上）。
 * `-shm` 是 WAL 的共享索引、是**派生数据**，搬一个陈旧的过去，sqlite 可能据它
 * 认定 WAL 只到某个位置，尾部已提交的事务就被无声地丢掉。
 *
 * AGENTS.md 里「三个一起拷」说的是**拷贝快照**（那时候必须一起，否则 WAL 对不上）；
 * **搬家不一样**：先 checkpoint 把 WAL 合进主库，再只搬主库，最省事也最不会错。
 */
function checkpoint(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('pragma wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

/**
 * 把旧目录里的库搬到新目录。**同盘 rename，不是拷贝**——598 MB 拷一遍要几十秒，
 * 而 rename 是瞬时且原子的。
 *
 * 判据是**新目录里有没有 `library.db`**，不是「新目录存不存在」：Electron 启动时
 * 早就把 userData 建出来了（Cache 之类），拿目录存在与否判断永远不会触发。
 *
 * 逐项搬、逐项判断，所以**中途挂了也能接着来**：下次启动看到新目录还是没有
 * `library.db`，会把剩下的继续搬完。`library.db` 放**最后**搬，它一到位就算迁移完成。
 */
export function migrateUserData(oldDir: string, newDir: string): { moved: string[] } | null {
  if (oldDir === newDir) return null;
  if (!existsSync(join(oldDir, 'library.db'))) return null; // 没有旧库，新装或者已经搬过
  if (existsSync(join(newDir, 'library.db'))) return null; // 新库已经在了，绝不覆盖

  mkdirSync(newDir, { recursive: true });
  const moved: string[] = [];

  const move = (name: string) => {
    const from = join(oldDir, name);
    const to = join(newDir, name);
    if (!existsSync(from) || existsSync(to)) return;
    renameSync(from, to);
    moved.push(name);
  };

  for (const d of DIRS) move(d);

  const library = new DatabaseSync(join(oldDir, 'library.db'));
  try {
    const columns = library.prepare('pragma table_info(book)').all() as Array<{name:string}>;
    if (columns.some(column => column.name === 'cover_path')) {
      const rows = library.prepare('select id,cover_path from book where cover_path is not null').all() as Array<{id:number;cover_path:string}>;
      library.exec('begin');
      try {
        for (const row of rows) {
          const local = relative(join(oldDir,'covers'),row.cover_path);
          if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) continue;
          const target = join(newDir,'covers',local);
          // 目录未搬动时旧图仍在，目标同名文件可能是别人的；继续引用原图。
          if (!existsSync(row.cover_path) && existsSync(target)) library.prepare('update book set cover_path=? where id=?').run(target,row.id);
        }
        if (library.prepare("select 1 from sqlite_master where type='table' and name='app_setting'").get()) {
          const saved=library.prepare("select value from app_setting where key='backup.dir'").get() as {value:string}|undefined;
          if (saved) {
            const local=relative(join(oldDir,'backups'),saved.value);
            const target=join(newDir,'backups',local);
            if (local!=='..' && !local.startsWith(`..${sep}`) && !isAbsolute(local) && !existsSync(saved.value) && existsSync(target)) {
              library.prepare("update app_setting set value=? where key='backup.dir'").run(target);
            }
          }
        }
        library.exec('commit');
      } catch (error) { library.exec('rollback'); throw error; }
    }
  } finally { library.close(); }

  // 先把 WAL 合进主库，再只搬主库。见上面 checkpoint 的注释：
  // 三个文件一起搬丢过尾部两条已提交的事务
  checkpoint(join(oldDir, 'library.db'));
  move('library.db');
  // checkpoint(TRUNCATE) 之后 -wal 是空的、-shm 是纯派生数据，两个都不搬，直接扔掉
  for (const junk of ['library.db-wal', 'library.db-shm']) {
    rmSync(join(oldDir, junk), { force: true });
  }

  return moved.length > 0 ? { moved } : null;
}

/** 旧目录里还剩什么（迁移后用来告诉用户能不能删了） */
export function leftovers(oldDir: string): string[] {
  if (!existsSync(oldDir)) return [];
  return readdirSync(oldDir);
}
