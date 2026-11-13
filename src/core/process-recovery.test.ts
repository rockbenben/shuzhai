import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';

// 只在依赖调用完成的边界暂停真实业务函数，父进程随后强制终止子进程。
// 没有生产代码故障开关，也不依赖默认档案路径。
const childConfig = process.env.SHUZHAI_RECOVERY_CHILD;
if (childConfig) {
  const { root, point, action } = JSON.parse(childConfig) as { root: string; point: string; action: string };
  const stop = () => {
    fs.writeFileSync(join(root, 'paused'), point);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = originalPrepare.call(this, sql);
    const run = statement.run.bind(statement);
    statement.run = ((...args: unknown[]) => {
      const result = Reflect.apply(run, statement, args);
      if ((point === 'after-log' && sql.startsWith('insert into rename_log'))
        || (point === 'after-update' && sql.startsWith('update book_file set path'))
        || (point === 'restore-transaction' && sql.includes('update reading_state set status'))
        || (point === 'scan-anchors' && sql.includes('update reading_state set chapter_idx'))
        || (point === 'snapshot-seal' && sql.startsWith('insert or replace into app_setting') && args[0] === 'perf.snapshot')
        || (point === 'delete-transaction' && sql.startsWith('delete from book_file'))) stop();
      return result;
    }) as typeof statement.run;
    return statement;
  };
  const originalRename = fs.promises.rename;
  let renamed = 0;
  fs.promises.rename = async (...args) => {
    await originalRename(...args);
    renamed++;
    if ((point === 'first-move' && renamed === 1) || (point === 'second-move' && renamed === 2)) stop();
  };
  const originalSyncRename = fs.renameSync;
  fs.renameSync = (...args) => {
    originalSyncRename(...args);
    if (point === 'migration-cover' && String(args[0]).endsWith('covers')) stop();
    if (point === 'migration-db' && String(args[0]).endsWith('library.db')) stop();
  };
  syncBuiltinESMExports();
  const db = openDb(join(root, 'library.db'));
  if (action === 'rename' || action === 'undo') {
    const { applyRename, undoBatch, previewRename } = await import('./rename.ts');
    if (action === 'undo') await undoBatch(db, null, 'crash');
    else {
      const rows = await previewRename(db, [1], { template: point === 'second-move' || root.includes('case-') ? 'SOURCE{ext}' : 'target{ext}' });
      await applyRename(db, null, rows, 'crash');
    }
  } else if (action === 'restore') {
    const { importBackup } = await import('./backup.ts');
    importBackup(db, JSON.parse(fs.readFileSync(join(root, 'backup.json'), 'utf8')));
  } else if (action === 'delete') {
    const { deleteDuplicates } = await import('./deletion.ts');
    await deleteDuplicates(db, [1], async path => {
      await fs.promises.rename(path, join(root, 'trash.txt'));
      if (point === 'after-trash') stop();
    });
  } else if (action === 'scan') {
    const { scanRoot } = await import('./scan.ts');
    await scanRoot(db, { id:1, path:root }, { minBytes:0 });
  } else if (action === 'migrate') {
    db.close();
    const { migrateUserData } = await import('../main/migrate-userdata.ts');
    migrateUserData(join(root, 'old'), join(root, 'new'));
  } else if (action === 'snapshot') {
    db.close();
    process.env.SHUZHAI_BENCH_DIR = join(root, 'bench');
    const { makeSnapshot } = await import(new URL('../../scripts/bench/snapshot.mjs', import.meta.url).href);
    await makeSnapshot({ sourcePath: join(root, 'library.db') });
  } else if (action === 'webdav') {
    const { upload } = await import('./webdav.ts');
    await upload({ url: 'https://fixture.invalid', username: '', password: '' }, '{"createdAt":"2026-11-13"}', {
      remoteNewerThan: '2020-01-01',
      fetchImpl: async (url, options) => {
        if (options?.method === 'GET') return new Response(fs.readFileSync(join(root, 'remote.json')), {headers:{etag:'"fixture"'}});
        assert.ok(String(url).includes('.conflict-'));
        fs.writeFileSync(join(root, 'conflict.json'), String(options?.body));
        stop();
        return new Response(null, { status: 201 });
      },
    });
  }
  throw new Error('未到达预期中断点');
} else {
  async function killAt(root: string, action: string, point: string): Promise<void> {
    const child = fork(import.meta.filename, [], {
      env: { ...process.env, SHUZHAI_RECOVERY_CHILD: JSON.stringify({ root, action, point }) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    const exited = once(child, 'exit');
    let error = '';
    child.stderr!.on('data', chunk => { error += String(chunk); });
    try {
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(join(root, 'paused'))) {
        assert.equal(child.exitCode, null, error);
        assert.ok(Date.now() < deadline, `未到达 ${point} ${error}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      child.kill('SIGKILL');
      await exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  }

  function fixture(prefix: string): string {
    const root = fs.mkdtempSync(join(tmpdir(), `shuzhai-kill-${prefix}-`));
    fs.writeFileSync(join(root, 'source.txt'), 'original bytes');
    const db = openDb(join(root, 'library.db'));
    db.prepare("insert into book(id,title) values(1,'fixture')").run();
    db.prepare('insert into book_file(id,book_id,path,size,mtime,is_primary) values(1,1,?,14,0,1)').run(join(root, 'source.txt'));
    db.exec("insert into reading_state(book_id,status,char_offset,comment) values(1,'reading',77,'review'); insert into bookmark(book_id,chapter_idx,note) values(1,0,'bookmark')");
    db.close();
    return root;
  }

  for (const mode of ['normal', 'case']) {
    for (const point of ['after-log', 'first-move', 'after-update', ...(mode === 'case' ? ['second-move'] : [])]) {
      test(`强制终止 ${mode} 改名 ${point} 后重开并撤销`, async () => {
        const root = fixture(mode);
        try {
          await killAt(root, 'rename', point);
          const db = openDb(join(root, 'library.db'));
          try {
            const { undoBatch } = await import('./rename.ts');
            const result = await undoBatch(db, null, 'crash');
            assert.equal(result.failed.length, 0, JSON.stringify(result));
            assert.equal(fs.readFileSync(join(root, 'source.txt'), 'utf8'), 'original bytes');
            assert.equal((db.prepare('select path from book_file where id=1').get() as {path:string}).path, join(root, 'source.txt'));
            assert.equal((db.prepare('select char_offset from reading_state').get() as {char_offset:number}).char_offset, 77);
            assert.equal((db.prepare('select note from bookmark').get() as {note:string}).note, 'bookmark');
            assert.equal(fs.readdirSync(root).filter(name => name.includes('.renaming-')).length, 0);
          } finally { db.close(); }
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      });
    }
  }

  for (const mode of ['normal', 'case']) {
    test(`撤销 ${mode} 时强制终止后可再次撤销`, async () => {
      const root = fixture(mode);
      try {
        const db = openDb(join(root, 'library.db'));
        const { applyRename, previewRename, undoBatch } = await import('./rename.ts');
        const rows = await previewRename(db, [1], { template: mode === 'case' ? 'SOURCE{ext}' : 'target{ext}' });
        await applyRename(db, null, rows, 'crash');
        db.close();
        await killAt(root, 'undo', 'first-move');
        const reopened = openDb(join(root, 'library.db'));
        try {
          const result = await undoBatch(reopened, null, 'crash');
          assert.equal(result.failed.length, 0, JSON.stringify(result));
          assert.equal(fs.readFileSync(join(root, 'source.txt'), 'utf8'), 'original bytes');
          assert.equal((await undoBatch(reopened, null, 'crash')).ok, 0);
        } finally { reopened.close(); }
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  for (const point of ['after-trash', 'delete-transaction']) {
    test(`删除 ${point} 强制终止后整理记录，副本和笔记完整`, async () => {
      const root = fixture('delete');
      try {
        fs.copyFileSync(join(root, 'source.txt'), join(root, 'survivor.txt'));
        const db = openDb(join(root, 'library.db'));
        db.prepare('insert into book_file(book_id,path,size,mtime) values(1,?,14,0)').run(join(root, 'survivor.txt'));
        db.close();
        await killAt(root, 'delete', point);
        const reopened = openDb(join(root, 'library.db'));
        try {
          const { repairLibrary } = await import('./library.ts');
          repairLibrary(reopened);
          assert.equal(fs.readFileSync(join(root, 'survivor.txt'), 'utf8'), 'original bytes');
          assert.equal(fs.readFileSync(join(root, 'trash.txt'), 'utf8'), 'original bytes');
          assert.equal((reopened.prepare('select count(*) n from book_file').get() as {n:number}).n, 1);
          assert.equal((reopened.prepare('select note from bookmark').get() as {note:string}).note, 'bookmark');
          assert.equal((reopened.prepare('select comment from reading_state').get() as {comment:string}).comment, 'review');
        } finally { reopened.close(); }
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  test('恢复事务中强制终止后，旧书评和书签完整保留', async () => {
    const root = fixture('restore');
    try {
      const db = openDb(join(root, 'library.db'));
      const { exportBackup } = await import('./backup.ts');
      const backup = exportBackup(db);
      backup.books[0].reading!.comment = 'replacement';
      fs.writeFileSync(join(root, 'backup.json'), JSON.stringify(backup));
      db.close();
      await killAt(root, 'restore', 'restore-transaction');
      const reopened = openDb(join(root, 'library.db'));
      try {
        assert.equal((reopened.prepare('select comment from reading_state').get() as {comment:string}).comment, 'review');
        assert.equal((reopened.prepare('select note from bookmark').get() as {note:string}).note, 'bookmark');
        assert.equal((reopened.prepare('pragma integrity_check').get() as {integrity_check:string}).integrity_check, 'ok');
      } finally { reopened.close(); }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('重解析迁移锚点时强制终止，重开仍为同一旧快照，重扫可完整迁移', async () => {
    const root = fixture('scan');
    const body = (titles: string[]) => titles.map(t=>t+'\n'+'临时正文。\n'.repeat(300)).join('\n');
    const path = join(root,'source.txt');
    try {
      fs.writeFileSync(path,body(['第一章 起','第二章 承']));
      const db = openDb(join(root,'library.db'));
      const { scanRoot } = await import('./scan.ts');
      try {
        db.exec('delete from book');
        db.prepare('insert into library_root(id,path) values(1,?)').run(root);
        await scanRoot(db,{id:1,path:root},{minBytes:0});
        db.exec("update reading_state set status='reading',chapter_idx=1,char_offset=12; insert into bookmark(book_id,chapter_idx,note) values(1,1,'保留笔记'); insert into chapter_fts(content,book_id,chapter_idx) values('原索引',1,1)");
      } finally { db.close(); }
      fs.writeFileSync(path,body(['第零章 序','第一章 起','第二章 承']));
      await killAt(root,'scan','scan-anchors');
      const reopened = openDb(join(root,'library.db'));
      try {
        assert.deepEqual(reopened.prepare('select title from chapter order by idx').all().map(r=>r.title),['第一章 起','第二章 承']);
        assert.equal(reopened.prepare('select chapter_idx from reading_state').get()!.chapter_idx,1);
        assert.equal(reopened.prepare('select chapter_idx from bookmark').get()!.chapter_idx,1);
        assert.equal(reopened.prepare('select content from chapter_fts').get()!.content,'原索引');
        await scanRoot(reopened,{id:1,path:root},{minBytes:0});
        assert.equal(reopened.prepare('select chapter_idx from reading_state').get()!.chapter_idx,2);
        assert.equal(reopened.prepare('select chapter_idx from bookmark').get()!.chapter_idx,2);
        assert.equal(reopened.prepare('select note from bookmark').get()!.note,'保留笔记');
      } finally { reopened.close(); }
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  });

  for (const point of ['migration-cover', 'migration-db']) {
    test(`迁移 ${point} 强制终止后重启完成并读到封面`, async () => {
      const root = fixture('migration');
      try {
        const old = join(root, 'old');
        fs.mkdirSync(join(old, 'covers'), { recursive: true });
        fs.writeFileSync(join(old, 'covers', 'cover.png'), 'cover fixture');
        const db = openDb(join(old, 'library.db'));
        db.prepare('insert into book(title,cover_path) values(?,?)').run('migrated', join(old, 'covers', 'cover.png'));
        db.close();
        await killAt(root, 'migrate', point);
        const { migrateUserData } = await import('../main/migrate-userdata.ts');
        const { coverDataUrl } = await import('./cover.ts');
        migrateUserData(old, join(root, 'new'));
        const reopened = openDb(join(root, 'new', 'library.db'));
        try { assert.ok(await coverDataUrl(reopened, 1)); } finally { reopened.close(); }
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }

  test('快照封存时强制终止，不留下可用封条和未隔离的备份设置', async () => {
    const root = fixture('snapshot');
    try {
      const db = openDb(join(root, 'library.db'));
      db.exec("insert into app_setting(key,value) values('backup.auto','1')");
      db.close();
      await killAt(root, 'snapshot', 'snapshot-seal');
      const snapshot = openDb(join(root, 'bench', 'userdata', 'library.db'));
      try {
        assert.equal(snapshot.prepare("select value from app_setting where key='perf.snapshot'").get(), undefined);
      } finally { snapshot.close(); }
      const { assertSnapshotReady } = await import(new URL('../../scripts/bench/snapshot.mjs', import.meta.url).href);
      assert.throws(() => assertSnapshotReady(join(root, 'bench', 'userdata')), /隔离封存/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('WebDAV 冲突副本完成后强制终止，远端原件保留且可以重试', async () => {
    const root = fixture('webdav');
    const remote = '{"createdAt":"2026-01-01","review":"remote review"}';
    const local = '{"createdAt":"2026-11-13","review":"local review"}';
    try {
      fs.writeFileSync(join(root, 'remote.json'), remote);
      await killAt(root, 'webdav', 'after-conflict');
      assert.equal(fs.readFileSync(join(root, 'remote.json'), 'utf8'), remote);
      assert.equal(fs.readFileSync(join(root, 'conflict.json'), 'utf8'), remote);
      const { upload } = await import('./webdav.ts');
      const result = await upload({ url: 'https://fixture.invalid', username: '', password: '' }, local, {
        remoteNewerThan: '2020-01-01',
        fetchImpl: async (url, options) => {
          if (options?.method === 'GET') return new Response(fs.readFileSync(join(root, 'remote.json')), {headers:{etag:'"fixture"'}});
          const path = join(root, String(url).includes('.conflict-') ? 'conflict.json' : 'remote.json');
          fs.writeFileSync(path, String(options?.body));
          return new Response(null, { status: 201 });
        },
      });
      assert.equal(result.ok, true);
      assert.equal(fs.readFileSync(join(root, 'remote.json'), 'utf8'), local);
      assert.equal(fs.readFileSync(join(root, 'conflict.json'), 'utf8'), remote);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
