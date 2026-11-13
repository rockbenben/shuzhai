import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { upload, BACKUP_NAME, conflictName, type DavConfig } from './webdav.ts';

// 真 HTTP + 临时磁盘服务端，验证条件写实际发生，避免 Response mock 缺 url 时假绿。
async function fixture(
  options: { etag?: 'strong' | 'weak' | 'none'; pairReads?: boolean; legacy?: boolean; readFailure?: number|'disconnect'; failMainOnce?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'shuzhai-dav-review-'));
  const main = join(dir, BACKUP_NAME);
  const original = '{"createdAt":"2026-01-01","review":"original"}';
  writeFileSync(options.legacy ? join(dir, 'novel-manager-backup.json') : main, original);
  let puts = 0;
  const held: Array<() => void> = [];
  const etag = (body: string) => '"' + createHash('sha256').update(body).digest('hex') + '"';
  const server = createServer(async (req, res) => {
    const path = join(dir, basename(new URL(req.url!, 'http://localhost').pathname));
    if (req.method === 'GET') {
      if (options.readFailure) {
        if(options.readFailure==='disconnect') req.socket.destroy();
        else res.writeHead(options.readFailure).end();
        return;
      }
      if (!existsSync(path)) { res.writeHead(404).end(); return; }
      const body = readFileSync(path, 'utf8');
      const reply = () => {
        if (options.etag !== 'none') res.setHeader('etag', (options.etag === 'weak' ? 'W/' : '') + etag(body));
        res.end(body);
      };
      if (options.pairReads && path === main && held.length < 2) {
        held.push(reply);
        if (held.length === 2) held.forEach(run => run());
      } else reply();
    } else if (req.method === 'PUT') {
      puts++;
      const bytes: Buffer[] = [];
      for await (const chunk of req) bytes.push(Buffer.from(chunk));
      if (path===main && options.failMainOnce) { options.failMainOnce=false;res.writeHead(507).end();return; }
      if ((req.headers['if-none-match'] === '*' && existsSync(path))
        || (req.headers['if-match'] && (!existsSync(path) || req.headers['if-match'] !== etag(readFileSync(path, 'utf8'))))) {
        res.writeHead(412).end(); return;
      }
      writeFileSync(path, Buffer.concat(bytes));
      res.writeHead(201).end();
    } else res.writeHead(405).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const cfg: DavConfig = { url: `http://127.0.0.1:${(server.address() as {port:number}).port}/`, username:'', password:'' };
  return { cfg, dir, main, original, puts: () => puts, async close() {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, {recursive:true,force:true});
  } };
}

for (const etag of ['none', 'weak'] as const) {
  test(`远端只有 ${etag} ETag 时拒绝覆盖，不伪装并发安全`, async () => {
    const f = await fixture({etag});
    try {
      await assert.rejects(upload(f.cfg, '{"review":"local"}'), /ETag/);
      assert.equal(f.puts(),0);
      assert.equal(readFileSync(f.main,'utf8'),f.original);
    } finally { await f.close(); }
  });
}

test('两个客户端读到同一强 ETag，只允许一个原子覆盖', async () => {
  const f = await fixture({pairReads:true});
  try {
    const results = await Promise.all([upload(f.cfg,'{"review":"A"}'),upload(f.cfg,'{"review":"B"}')]);
    assert.equal(results.filter(r=>r.ok).length,1);
    assert.equal(results.find(r=>!r.ok)?.status,412);
    assert.ok(['{"review":"A"}','{"review":"B"}'].includes(readFileSync(f.main,'utf8')));
  } finally { await f.close(); }
});

for (const readFailure of [401,503,507,'disconnect'] as const) {
  test(`远端查询 ${readFailure} 不得当成不存在并继续写入`, async () => {
    const f=await fixture({readFailure});
    try {
      await assert.rejects(upload(f.cfg,'{}'));
      assert.equal(f.puts(),0);
      assert.equal(readFileSync(f.main,'utf8'),f.original);
    } finally {await f.close();}
  });
}

test('冲突副本已保存而主文件写入失败，重试核对旧副本后完成', async () => {
  const f=await fixture({failMainOnce:true});
  try {
    const first=await upload(f.cfg,'{"review":"local"}',{remoteNewerThan:'2020'});
    assert.equal(first.ok,false);
    assert.equal(first.status,507);
    assert.equal(readFileSync(f.main,'utf8'),f.original);
    assert.equal(readFileSync(join(f.dir,first.savedConflict!),'utf8'),f.original);
    const retry=await upload(f.cfg,'{"review":"local"}',{remoteNewerThan:'2020'});
    assert.equal(retry.ok,true);
    assert.equal(readFileSync(f.main,'utf8'),'{"review":"local"}');
    assert.equal(readFileSync(join(f.dir,retry.savedConflict!),'utf8'),f.original);
  } finally {await f.close();}
});

test('旧文件名兜底后创建新主备份也须使用排他条件', async () => {
  const f = await fixture({legacy:true});
  const intruder = '{"review":"concurrent"}';
  try {
    let injected = false;
    const result = await upload(f.cfg,'{"review":"local"}',{fetchImpl:async (url,options)=>{
      if (options?.method === 'PUT' && String(url).endsWith(BACKUP_NAME) && !injected) {
        injected=true;
        writeFileSync(f.main,intruder);
      }
      return fetch(url,options);
    }});
    assert.equal(result.ok,false);
    assert.equal(result.status,412);
    assert.equal(readFileSync(f.main,'utf8'),intruder);
  } finally { await f.close(); }
});

test('同名冲突副本内容不同时拒绝覆盖，两份远端原件均保留', async () => {
  const f = await fixture();
  const conflict = join(f.dir,conflictName('device','2026-01-01'));
  writeFileSync(conflict,'已有的其他冲突内容');
  try {
    await assert.rejects(upload(f.cfg,'{}',{remoteNewerThan:'2020'}),/冲突副本/);
    assert.equal(readFileSync(conflict,'utf8'),'已有的其他冲突内容');
    assert.equal(readFileSync(f.main,'utf8'),f.original);
  } finally { await f.close(); }
});
