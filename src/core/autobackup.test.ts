import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, setSetting } from './db.ts';
import {
  shouldBackup,
  backupName,
  prune,
  runBackup,
  maybeBackup,
  lastBackupAt,
  readConfig,
  PREFIX,
  DEFAULT_AUTOBACKUP,
  type AutoBackupConfig,
} from './autobackup.ts';

let dir: string;
let out: string;
let db: DatabaseSync;

const cfg = (o: Partial<AutoBackupConfig> = {}): AutoBackupConfig => ({
  ...DEFAULT_AUTOBACKUP,
  enabled: true,
  dir: out,
  ...o,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-ab-'));
  out = join(dir, '备份');
  mkdirSync(out);
  db = openDb(join(dir, 'library.db'));
  db.prepare("insert into book(title) values('测试书')").run();
  db.prepare('insert into reading_state(book_id) values(1)').run();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const now = new Date('2026-08-13T10:00:00Z');
const files = () => readdirSync(out).filter((f) => f.startsWith(PREFIX)).sort();

test('关闭时不备份', () => {
  assert.equal(shouldBackup(cfg({ enabled: false }), null, now), false);
});

test('没设目录就不备份——总比往不知道哪儿写好', () => {
  assert.equal(shouldBackup(cfg({ dir: '' }), null, now), false);
});

test('从没备过就立刻备一次', () => {
  assert.equal(shouldBackup(cfg(), null, now), true);
});

test('按「距上次多久」算，不按固定时刻', () => {
  // 桌面应用不是常驻服务，按时刻排的话好几天不开机的人一次都触发不到，
  // 而他恰恰最需要备份
  const six = new Date('2026-08-07T10:00:00Z').toISOString();
  assert.equal(shouldBackup(cfg({ everyDays: 7 }), six, now), false, '才过 6 天');

  const eight = new Date('2026-08-05T10:00:00Z').toISOString();
  assert.equal(shouldBackup(cfg({ everyDays: 7 }), eight, now), true, '过了 8 天该备了');
});

test('刚好到期就备', () => {
  const exactly = new Date('2026-08-06T10:00:00Z').toISOString();
  assert.equal(shouldBackup(cfg({ everyDays: 7 }), exactly, now), true);
});

test('上次时间记坏了当作没备过', () => {
  assert.equal(shouldBackup(cfg(), '不是时间', now), true, '宁可多备一次，也不能一直不备');
});

test('间隔 0 天会被压到 1 天，不然每次检查都触发', () => {
  const justNow = new Date('2026-08-13T09:59:00Z').toISOString();
  assert.equal(shouldBackup(cfg({ everyDays: 0 }), justNow, now), false);
});

test('文件名按时间戳排序，字典序就是时间序', () => {
  const a = backupName('2026-08-09T10:00:00.000Z');
  const b = backupName('2026-08-13T10:00:00.000Z');
  assert.ok(a < b, `${a} 应排在 ${b} 前面`);
  assert.ok(!/[\\/:*?"<>|]/.test(a), a);
});

test('真备份写出文件并记下时间', async () => {
  const r = await runBackup(db, cfg(), now);
  assert.equal(files().length, 1);
  assert.ok(r.path.endsWith('.json'));
  assert.equal(lastBackupAt(db), now.toISOString());

  // 备份文件要真的能解析，且带着那本书
  const json = JSON.parse(readFileSync(r.path, 'utf8')) as { books: Array<{ title: string }> };
  assert.equal(json.books[0].title, '测试书');
});

test('只保留最近 N 份', async () => {
  for (const d of ['09', '10', '11', '12', '13']) {
    await runBackup(db, cfg({ keep: 3 }), new Date(`2026-08-${d}T10:00:00Z`));
  }
  const left = files();
  assert.equal(left.length, 3);
  assert.ok(left[0].includes('2026-08-11'), `最旧的应是 11 号，实际 ${left[0]}`);
  assert.ok(left[2].includes('2026-08-13'));
});

test('清理只动自己产生的文件', async () => {
  writeFileSync(join(out, '用户自己的东西.json'), '别删我', 'utf8');
  writeFileSync(join(out, '书库元数据.csv'), 'x', 'utf8');
  for (const d of ['09', '10', '11']) {
    await runBackup(db, cfg({ keep: 1 }), new Date(`2026-08-${d}T10:00:00Z`));
  }
  const all = readdirSync(out).sort();
  assert.ok(all.includes('用户自己的东西.json'), '不认识的文件一个都不能碰');
  assert.ok(all.includes('书库元数据.csv'));
  assert.equal(files().length, 1);
});

test('keep 设成 0 也至少留一份', async () => {
  await runBackup(db, cfg({ keep: 0 }), now);
  assert.equal(files().length, 1, '留 0 份等于备了个寂寞');
});

test('maybeBackup：不该备时什么都不做', async () => {
  setSetting(db, 'backup.auto', '1');
  setSetting(db, 'backup.dir', out);
  setSetting(db, 'backup.everyDays', '7');

  assert.ok(await maybeBackup(db, now), '第一次该备');
  assert.equal(await maybeBackup(db, now), null, '刚备完不该再备');
  assert.equal(files().length, 1);

  const later = new Date('2026-08-25T10:00:00Z');
  assert.ok(await maybeBackup(db, later), '过了 12 天该备了');
  assert.equal(files().length, 2);
});

test('设置读写往返', () => {
  setSetting(db, 'backup.auto', '1');
  setSetting(db, 'backup.dir', 'D:\\备份');
  setSetting(db, 'backup.everyDays', '3');
  setSetting(db, 'backup.keep', '10');

  const c = readConfig(db);
  assert.deepEqual(c, { enabled: true, dir: 'D:\\备份', everyDays: 3, keep: 10 });
});

test('没设目录时 runBackup 明确报错', async () => {
  await assert.rejects(() => runBackup(db, cfg({ dir: '' }), now), /备份文件夹/);
});

test('目录不存在会自动建出来', async () => {
  const nested = join(dir, '不存在', '的目录');
  await runBackup(db, cfg({ dir: nested }), now);
  assert.equal(readdirSync(nested).length, 1);
});

test('prune 对不存在的目录不报错', async () => {
  assert.deepEqual(await prune(join(dir, '没有这个目录'), 3), []);
});

/*
 * 改前缀那次（`novel-manager-backup-` → `shuzhai-backup-`）留下的坑：
 * `prune` 按前缀挑文件，只认新前缀的话，旧备份既不被数进 `keep`、也永远不被清，
 * 堆到天荒地老——而它们护的正是铁律 3 那三张重扫恢复不了的表。
 */
test('prune 认得出改名之前的备份，一起纳入「只留最近 N 份」', async () => {
  const d = join(dir, '混着两种前缀');
  mkdirSync(d, { recursive: true });
  const names = [
    'novel-manager-backup-2026-01-01T00-00-00.json',
    'novel-manager-backup-2026-02-01T00-00-00.json',
    'shuzhai-backup-2026-03-01T00-00-00.json',
    'shuzhai-backup-2026-04-01T00-00-00.json',
  ];
  for (const n of names) writeFileSync(join(d, n), '{}');

  const gone = await prune(d, 2);
  const left = readdirSync(d).sort();
  assert.equal(left.length, 2, `只该留 2 份，实际留了 ${left.join('、')}`);
  // 留下的必须是**时间上最新的两份**，不是「新前缀的那两份」——
  // 排序要按时间戳，不能让前缀本身参与比较
  assert.deepEqual(left, [
    'shuzhai-backup-2026-03-01T00-00-00.json',
    'shuzhai-backup-2026-04-01T00-00-00.json',
  ]);
  assert.equal(gone.length, 2);
});
