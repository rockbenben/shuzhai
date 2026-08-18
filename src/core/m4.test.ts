// M4 三件事的测试：繁简转换、实时监听、WebDAV 同步
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { convertText, bookConvertMode, setBookConvertMode, asMode } from './convert.ts';
import { LibraryWatcher } from './watcher.ts';
import { upload, download, conflictName, BACKUP_NAME, type DavConfig } from './webdav.ts';

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-m4-'));
  db = openDb(join(dir, 'library.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── 繁简转换 ─────────────────────────────────────────────

test('繁简互转，且是词组级的', () => {
  assert.equal(convertText('風雪夜歸人，孤燈照舊影。', 'to-simplified'), '风雪夜归人，孤灯照旧影。');
  assert.equal(convertText('风雪夜归人，孤灯照旧影。', 'to-traditional'), '風雪夜歸人，孤燈照舊影。');
  // 单字映射做不到这一条：「发」在「头发」里是「髮」，在「发现」里是「發」
  assert.equal(convertText('头发', 'to-traditional'), '頭髮');
  assert.equal(convertText('发现', 'to-traditional'), '發現');
});

test('关闭时原样返回', () => {
  const s = '風雪夜歸人';
  assert.equal(convertText(s, 'off'), s);
  assert.equal(convertText('', 'to-simplified'), '');
});

/** 拼错的、漏传的、别处抄来的写法——两条路都得挡住 */
const BAD_MODES = ['s2t', 'undefined', '', 'to-simplifed', 'traditional'];

test('认不出来的模式当「原文」，不许猜成繁体', () => {
  // `convert.preview` / `convert.set` 都是 rpc，mode 从 HTTP 来、
  // 靠 `String(mode) as ConvertMode` 硬转进来——**TS 在这儿一点忙都帮不上**。
  // 原来 converter() 是「不是简体就按繁体」的三目，于是拼错的模式名、
  // 甚至漏传参数变成的 'undefined'，都会静默返回整篇繁体，
  // 调用方还以为转换成功了。擅自改变用户看到的字形是越界。
  const s = '头发和发现';
  for (const bad of BAD_MODES) {
    assert.equal(convertText(s, bad as never), s, `模式 ${JSON.stringify(bad)} 不该转换`);
  }
  // 认得出的那两个照常工作
  assert.equal(convertText(s, 'to-traditional'), '頭髮和發現');
});

test('认不出来的模式也不许存进库——读那头兜底不算数', () => {
  // 读那头的兜底（`bookConvertMode` 认不出就返回 off）会把一个存坏了的设置
  // 悄悄显示成「原文」，而 `convert.set` 已经回了 `{ ok: true }`——
  // 用户以为设好了，那本书还是原文，谁也不会再想起来去看 app_setting。
  for (const bad of BAD_MODES) {
    assert.throws(
      () => setBookConvertMode(db, 9, bad as never),
      `模式 ${JSON.stringify(bad)} 不该被存下来`,
    );
  }
  assert.equal(bookConvertMode(db, 9), 'off', '一条都不该落库');
  // 三个合法值照常存得进去，off 也是合法的（那是「取消转换」）
  for (const ok of ['off', 'to-simplified', 'to-traditional'] as const) {
    setBookConvertMode(db, 9, ok);
    assert.equal(bookConvertMode(db, 9), ok);
  }
});

test('从外面进来的模式拼错了要招，不能原样退回原文', () => {
  // 实测踩过：照着 opencc 常见的 s2t / t2s 敲 rpc `convert.preview`，
  // 两个方向都原样返回——看起来像 opencc 根本没打进安装包
  for (const bad of ['s2t', 't2s', 'to-tradiitonal', '', 'undefined', undefined, null, 1]) {
    assert.throws(() => asMode(bad), /认不出来的繁简模式/, `模式 ${JSON.stringify(bad)} 该报错`);
  }
  for (const ok of ['off', 'to-simplified', 'to-traditional'] as const) {
    assert.equal(asMode(ok), ok);
  }
});

test('每本书的转换模式默认是「原文」', () => {
  assert.equal(bookConvertMode(db, 1), 'off', '擅自改变用户看到的字形是越界');
  setBookConvertMode(db, 1, 'to-simplified');
  assert.equal(bookConvertMode(db, 1), 'to-simplified');
  assert.equal(bookConvertMode(db, 2), 'off', '设置是按书的，不该串到别的书');
});

// ── 实时监听 ─────────────────────────────────────────────

/**
 * 等到某件事成立，最多等 `ms` 毫秒。
 *
 * **固定等待是假失败的头号来源**——`scripts/ui-check/README.md` 那条规矩
 * 本来只写给走查，而这里的监听测试正是同一个形状：`fs.watch` 的事件什么时候到
 * 由操作系统说了算，机器一忙（这个仓库跑测试时经常同时开着 electron 和走查）
 * 就可能晚于那个写死的 300ms。晚到的后果不是「这条红一下」——
 * 实测撞见过整份 `m4.test.ts` 提前中止、**连带 15 条没跑**，
 * 而报告只说「611 条里挂 1 条」，看不出少了哪些。
 *
 * 所以「等它发生」用轮询，「确认它不再发生」才用一段固定的安静期。
 */
async function until(cond: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

test('监听到 txt 变动，防抖后只触发一次', async () => {
  const lib = join(dir, 'books');
  mkdirSync(lib);

  let fired = 0;
  let changed: string[] = [];
  const w = new LibraryWatcher(
    (c) => {
      fired++;
      changed = c;
    },
    { debounceMs: 120 },
  );
  w.watchRoot(lib);
  assert.equal(w.watching, 1);

  // 连着写好几次，模拟追更时的连续事件
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(lib, `book${i}.txt`), '内容', 'utf8');
    await new Promise((r) => setTimeout(r, 15));
  }
  // 先等它真的响一次（轮询，不写死），再静一段看会不会响第二次
  assert.ok(await until(() => fired > 0), '等了 4 秒还没触发——监听多半没接上');
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(fired, 1, '五次写入只该触发一次扫描');
  assert.ok(changed.length > 0);
  w.close();
  assert.equal(w.watching, 0);
});

test('非 txt 文件的变动不惊动扫描', async () => {
  const lib = join(dir, 'books2');
  mkdirSync(lib);
  let fired = 0;
  const w = new LibraryWatcher(() => fired++, { debounceMs: 100 });
  w.watchRoot(lib);

  writeFileSync(join(lib, 'cover.jpg'), 'x');
  writeFileSync(join(lib, 'notes.md'), 'x');
  await new Promise((r) => setTimeout(r, 260));

  assert.equal(fired, 0);
  w.close();
});

test('监听不存在的目录不会让应用崩掉', () => {
  const w = new LibraryWatcher(() => {});
  w.watchRoot(join(dir, '根本不存在'));
  assert.equal(w.watching, 0, '悄悄跳过，不抛异常');
  w.close();
});

// ── WebDAV ───────────────────────────────────────────────

const cfg: DavConfig = { url: 'https://dav.test/nm/', username: 'u', password: 'p' };

/** 用一个内存 Map 假装远端 */
function fakeDav(store: Map<string, string>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'PUT') {
      store.set(key, String(init?.body ?? ''));
      return { ok: true, status: 201, statusText: 'Created', text: async () => '' } as Response;
    }
    const hit = store.get(key);
    return hit === undefined
      ? ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' } as Response)
      : ({ ok: true, status: 200, statusText: 'OK', text: async () => hit } as Response);
  }) as typeof globalThis.fetch;
}

test('上传后能下载回来', async () => {
  const store = new Map<string, string>();
  const json = JSON.stringify({ createdAt: '2026-08-12T10:00:00Z', books: [] });

  const up = await upload(cfg, json, { fetchImpl: fakeDav(store) });
  assert.equal(up.ok, true);
  assert.ok(store.has(`https://dav.test/nm/${BACKUP_NAME}`));

  const down = await download(cfg, { fetchImpl: fakeDav(store) });
  assert.equal(down?.createdAt, '2026-08-12T10:00:00Z');
});

test('远端更新时保留冲突副本，不直接吃掉', async () => {
  const store = new Map<string, string>();
  const remote = JSON.stringify({ createdAt: '2026-08-12T20:00:00Z', books: ['远端的' ] });
  store.set(`https://dav.test/nm/${BACKUP_NAME}`, remote);

  const mine = JSON.stringify({ createdAt: '2026-08-12T09:00:00Z', books: ['我的'] });
  const up = await upload(cfg, mine, {
    fetchImpl: fakeDav(store),
    device: '台式机',
    // 我手上这份基于 10 点的底稿，而远端是 20 点的 → 远端更新
    remoteNewerThan: '2026-08-12T10:00:00Z',
  });

  assert.ok(up.savedConflict, '远端比我新，必须先另存一份');
  assert.equal(store.get(`https://dav.test/nm/${up.savedConflict}`), remote, '冲突副本要是远端那份原文');
  assert.equal(store.get(`https://dav.test/nm/${BACKUP_NAME}`), mine, '最后写入优先');
});

test('远端没有更新时不产生冲突副本', async () => {
  const store = new Map<string, string>();
  store.set(
    `https://dav.test/nm/${BACKUP_NAME}`,
    JSON.stringify({ createdAt: '2026-08-12T08:00:00Z' }),
  );
  const up = await upload(cfg, JSON.stringify({ createdAt: '2026-08-12T12:00:00Z' }), {
    fetchImpl: fakeDav(store),
    remoteNewerThan: '2026-08-12T10:00:00Z',
  });
  assert.equal(up.savedConflict, undefined);
});

test('远端还没有备份时下载返回 null，而不是报错', async () => {
  assert.equal(await download(cfg, { fetchImpl: fakeDav(new Map()) }), null, '第一次用本来就没有');

  /*
   * 改名之前存上去的那份也要认得出来。
   * **这条守的不是「能不能恢复」，是「会不会静默分叉」**：download 返回 null
   * 在调用方读起来是「远端还没有」，于是下次上传不会存冲突副本，
   * 直接在旧文件旁边写一个新名字的——spec §10 的「保留冲突副本」恰好被绕过一次。
   * 现有的每条 webdav 测试都拿 BACKUP_NAME 自己当键，所以改名怎么改它们都是绿的。
   */
  const legacy = new Map([[
    'https://dav.test/nm/novel-manager-backup.json',
    JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', books: [] }),
  ]]);
  const old = await download(cfg, { fetchImpl: fakeDav(legacy) });
  assert.ok(old, '远端还是旧名字时不能当成「没有备份」');
  assert.equal(old.createdAt, '2026-01-01T00:00:00.000Z');
});

test('远端是别的格式时当作没有', async () => {
  const store = new Map<string, string>();
  store.set(`https://dav.test/nm/${BACKUP_NAME}`, '<html>登录页</html>');
  assert.equal(await download(cfg, { fetchImpl: fakeDav(store) }), null);
});

/*
 * 上传那头也得认旧名字。
 *
 * `download` 的注释里写着「旧名字也要认」，还解释了不认会怎么静默分叉——
 * 但那次只补了下载。**上传探冲突时仍然只 GET 新名字**：远端放着旧名字的那份
 * 一律探不到（head.ok 为 false），于是冲突副本那一支根本不进，
 * 直接在旧文件旁边写一个新名字的。注释说这个洞补好了，其实只补了一半。
 */
test('上传探冲突时，旧名字的远端备份也要算数', async () => {
  const store = new Map([[
    'https://dav.test/nm/novel-manager-backup.json',
    JSON.stringify({ createdAt: '2026-08-12T20:00:00Z', books: ['旧名字那份'] }),
  ]]);
  const up = await upload(cfg, JSON.stringify({ createdAt: '2026-08-12T10:00:00Z' }), {
    fetchImpl: fakeDav(store),
    device: '台式机',
    remoteNewerThan: '2026-08-12T10:00:00Z',
  });
  assert.ok(up.savedConflict, '远端那份比我们新，必须先存一份冲突副本再覆盖');
  assert.ok(
    [...store.keys()].some((k) => k.includes(up.savedConflict!)),
    '冲突副本要真的传上去',
  );
});

/*
 * **「没有备份」和「问不出来」是两回事。** 原来任何非 2xx 都会退回旧名字再试，
 * 两次都不成就返回 null——而 null 在调用方读起来是「第一次用，远端还没有」。
 * 于是密码打错、服务器 503，用户得到的结论是「远端没有备份」。
 * 这是本仓库记了三遍的那个形状（封面抓取那边是「没问出来 ≠ 问过了没有」）。
 */
test('密码不对不能报成「远端没有备份」', async () => {
  const denied = (async () => ({
    ok: false, status: 401, statusText: 'Unauthorized', text: async () => '',
  })) as unknown as typeof globalThis.fetch;
  await assert.rejects(
    () => download(cfg, { fetchImpl: denied }),
    /401|用户名|密码/,
  );
});

test('冲突副本文件名里的非法字符要处理掉', () => {
  const name = conflictName('我的/电脑:1', '2026-08-12T10:00:00.000Z');
  assert.ok(!/[\\/:*?"<>|]/.test(name), name);
  assert.ok(name.endsWith('.json'));
});
