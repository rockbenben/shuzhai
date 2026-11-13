import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeSnapshot, dropSnapshot, assertSnapshotReady } from './snapshot.mjs';
import { openDb, setSetting } from '../../src/core/db.ts';
import { maybeBackup } from '../../src/core/autobackup.ts';
import { exportBackup, importBackup } from '../../src/core/backup.ts';

test('快照目标是源库的硬链接时拒绝封存，源设置保持原样', async () => {
  const root=mkdtempSync(join(tmpdir(),'shuzhai-hardlink-'));
  const before=process.env.SHUZHAI_BENCH_DIR;
  const source=join(root,'source.db');
  const db=openDb(source);
  setSetting(db,'backup.auto','1');
  db.close();
  try {
    process.env.SHUZHAI_BENCH_DIR=join(root,'bench');
    const snapshot=await makeSnapshot({sourcePath:source});
    unlinkSync(snapshot.dst);
    linkSync(source,snapshot.dst);
    await assert.rejects(makeSnapshot({sourcePath:source,force:true}),/链接/);
    assert.throws(()=>assertSnapshotReady(join(root,'bench','userdata')),/链接/);
    const original=openDb(source);
    try { assert.equal(original.prepare("select value from app_setting where key='backup.auto'").get().value,'1'); }
    finally {original.close();}
  } finally {
    if(before===undefined)delete process.env.SHUZHAI_BENCH_DIR;
    else process.env.SHUZHAI_BENCH_DIR=before;
    rmSync(root,{recursive:true,force:true});
  }
});

test('测台内以两点开头的源库名仍是内部文件，不能漏过目录边界检查', async () => {
  const root=mkdtempSync(join(tmpdir(),'shuzhai-containment-'));
  const prior=process.env.SHUZHAI_BENCH_DIR;
  const source=join(root,'source.db');const db=openDb(source);db.close();
  try {
    const bench=join(root,'bench');process.env.SHUZHAI_BENCH_DIR=bench;
    await makeSnapshot({sourcePath:source});
    const internal=join(bench,'..source.db');const inner=openDb(internal);inner.close();
    await assert.rejects(makeSnapshot({sourcePath:internal,force:true}),/源书库不能在测台目录内/);
    assert.equal(existsSync(internal),true);
  } finally {
    if(prior===undefined)delete process.env.SHUZHAI_BENCH_DIR;else process.env.SHUZHAI_BENCH_DIR=prior;
    rmSync(root,{recursive:true,force:true});
  }
});

test('测台拒绝清理普通目录、父目录和目录链接', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shuzhai-isolation-'));
  const prior = process.env.SHUZHAI_BENCH_DIR;
  try {
    writeFileSync(join(dir, 'memo.txt'), 'keep');
    process.env.SHUZHAI_BENCH_DIR = dir;
    assert.throws(() => dropSnapshot());
    const linked = join(dir, 'link');
    const target = join(dir, 'target');
    mkdirSync(target);
    symlinkSync(target, linked, 'junction');
    process.env.SHUZHAI_BENCH_DIR = linked;
    assert.throws(() => dropSnapshot());
    assert.equal(readFileSync(join(dir, 'memo.txt'), 'utf8'), 'keep');
  } finally {
    if (prior === undefined) delete process.env.SHUZHAI_BENCH_DIR;
    else process.env.SHUZHAI_BENCH_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('快照隔离备份，并能从一致副本恢复个人数据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shuzhai-restore-'));
  const prior = process.env.SHUZHAI_BENCH_DIR;
  const source = join(dir, 'source.db');
  const db = openDb(source);
  try {
    const backups = join(dir, 'backups');
    mkdirSync(backups);
    const original = join(backups, 'shuzhai-backup-2020.json');
    writeFileSync(original, 'original backup');
    db.exec("insert into book(title) values('fixture'); insert into reading_state(book_id,status,chapter_idx,char_offset,comment) values(1,'reading',2,77,'original review'); insert into bookmark(book_id,chapter_idx,note) values(1,2,'original bookmark')");
    setSetting(db, 'backup.auto', '1');
    setSetting(db, 'backup.dir', backups);
    setSetting(db, 'backup.keep', '1');
    process.env.SHUZHAI_BENCH_DIR = join(dir, 'bench');
    const snapshot = await makeSnapshot({ sourcePath: source });
    assert.doesNotThrow(() => assertSnapshotReady(join(dir, 'bench', 'userdata')));
    const copy = openDb(snapshot.dst);
    try {
      assert.deepEqual(copy.prepare('select title from book').all().map(b => b.title), ['fixture']);
      copy.exec("update reading_state set comment='synthetic'");
      assert.equal(await maybeBackup(copy, new Date()), null);
      assert.notEqual(copy.prepare("select value from app_setting where key='backup.dir'").get().value, backups);
    } finally { copy.close(); }
    assert.equal(readFileSync(original, 'utf8'), 'original backup');
    const archive = exportBackup(db);
    const restored = openDb(':memory:');
    try {
      importBackup(restored, archive);
      assert.equal(restored.prepare('select comment,chapter_idx,char_offset from reading_state').get().comment, 'original review');
      assert.equal(restored.prepare('select char_offset from reading_state').get().char_offset, 77);
      assert.equal(restored.prepare('select note from bookmark').get().note, 'original bookmark');
    } finally { restored.close(); }
    dropSnapshot();
    assert.equal(existsSync(snapshot.dst), false);
    assert.equal(db.prepare('select comment from reading_state').get().comment, 'original review');
  } finally {
    db.close();
    if (prior === undefined) delete process.env.SHUZHAI_BENCH_DIR;
    else process.env.SHUZHAI_BENCH_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
