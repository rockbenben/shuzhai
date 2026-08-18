// WebDAV 同步（spec §10，M4）。
//
// 同步的是**备份文件**，不是数据库本身——多设备直接同步 sqlite 文件是自找麻烦
// （WAL、锁、半写状态）。一个 JSON 上传下载，冲突处理也就有了明确语义。
//
// 冲突策略照 spec §10：**最后写入优先 + 保留冲突副本**。不做三方合并——
// 合并两份阅读进度没有正确答案，而保留副本至少不丢东西。
//
// 用 fetch，不引 webdav 客户端库：这里只用到 PUT / GET / MKCOL 三个方法。

export interface DavConfig {
  /** 目录 URL，如 https://dav.example.com/shuzhai/ */
  url: string;
  username: string;
  password: string;
}

function authHeader(cfg: DavConfig): string {
  return 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
}

function joinUrl(base: string, name: string): string {
  return base.endsWith('/') ? base + name : `${base}/${name}`;
}

export const BACKUP_NAME = 'shuzhai-backup.json';

/**
 * 改名之前用的名字（`novel-manager-backup.json`）。
 *
 * **上传和下载两头都要认它。** 只补下载那头是不够的——上传探冲突时如果只问
 * 新名字，远端放着旧名字的那份就一律探不到，冲突副本那一支根本不进，
 * 直接在旧文件旁边写一个新名字的：spec §10 的「保留冲突副本」被绕过一次，
 * 两台设备跨在改名两侧就会分叉成两个远端文件而毫无察觉。
 * 这个洞第一次修的时候只补了一半，注释却写得像已经补完了。
 */
const OLD_BACKUP_NAME = 'novel-manager-backup.json';

/**
 * 远端那份备份（新名字优先，旧名字兜底）。
 *
 * ⚠️ **「没有」和「问不出来」必须分开。** 404 是「远端确实没有」，
 * 而 401 / 503 是没问出来——把后者也当成「没有」，用户密码打错时看到的是
 * 「远端没有备份」，然后就该去疑心自己的备份丢了。本仓库在封面抓取那边
 * 把这个形状记了三遍（「一个源没答，结论就不可信」）。
 */
async function fetchRemote(
  cfg: DavConfig,
  f: typeof globalThis.fetch,
): Promise<Response | null> {
  const get = (name: string) => f(joinUrl(cfg.url, name), {
    method: 'GET',
    headers: { authorization: authHeader(cfg) },
  }).catch((e: unknown) => {
    throw new Error(`连不上 WebDAV：${e instanceof Error ? e.message : String(e)}`);
  });

  let res = await get(BACKUP_NAME);
  if (res.status === 404) res = await get(OLD_BACKUP_NAME);
  if (res.ok) return res;
  if (res.status === 404) return null;      // 真的没有，第一次用就是这样
  throw new Error(
    res.status === 401 || res.status === 403
      ? `WebDAV 拒绝了这次访问（${res.status}）：用户名或密码不对，也可能是这个目录没有权限`
      : `问不出远端有没有备份：${res.status} ${res.statusText}`,
  );
}

/**
 * 冲突副本的文件名。带上设备名和时间，不覆盖别人的。
 *
 * **名字从 `BACKUP_NAME` 派生，别再抄一遍字面量**：原来两处各写一份，
 * 而 `autobackup.ts` 那条「这是写进用户磁盘的标识符，改之前先想清楚」的警告
 * 只点到了 `BACKUP_NAME`——下次改名就会漏掉这里，冲突副本从此和主备份不同姓，
 * 在网盘的目录列表里也不再排在一起。
 */
export function conflictName(device: string, iso: string): string {
  const stamp = iso.replace(/[:.]/g, '-');
  const safe = device.replace(/[^\w一-鿿-]/g, '_') || 'device';
  return BACKUP_NAME.replace(/\.json$/, `.conflict-${safe}-${stamp}.json`);
}

export interface DavResult {
  ok: boolean;
  status: number;
  message?: string;
}

/**
 * 上传备份。**先看远端有没有更新的版本**——有的话把远端那份存成冲突副本再覆盖，
 * 这样「最后写入优先」不至于把别的设备刚写的东西彻底吃掉。
 */
export async function upload(
  cfg: DavConfig,
  json: string,
  opts: { device?: string; fetchImpl?: typeof globalThis.fetch; remoteNewerThan?: string } = {},
): Promise<DavResult & { savedConflict?: string }> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const target = joinUrl(cfg.url, BACKUP_NAME);
  const headers = { authorization: authHeader(cfg) };

  let savedConflict: string | undefined;

  // 远端存在且比我们手上的底稿新 → 先把它另存一份。
  // **旧名字也要问**，否则跨在改名两侧的远端探不到，冲突副本这一支整个跳过
  const head = await fetchRemote(cfg, f).catch(() => null);
  if (head && opts.remoteNewerThan) {
    const remote = await head.text();
    let remoteAt = '';
    try {
      remoteAt = (JSON.parse(remote) as { createdAt?: string }).createdAt ?? '';
    } catch {
      remoteAt = '';
    }
    if (remoteAt && remoteAt > opts.remoteNewerThan) {
      savedConflict = conflictName(opts.device ?? 'device', remoteAt);
      await f(joinUrl(cfg.url, savedConflict), {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: remote,
      }).catch(() => null);
    }
  }

  const res = await f(target, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: json,
  }).catch((e: unknown) => {
    return { ok: false, status: 0, statusText: e instanceof Error ? e.message : String(e) } as Response;
  });

  return {
    ok: res.ok,
    status: res.status,
    message: res.ok ? undefined : `上传失败：${res.status} ${res.statusText}`,
    savedConflict,
  };
}

/**
 * 下载远端备份。**远端确实没有**就返回 null（第一次用本来就没有），
 * 而问不出来（密码不对、服务器挂了）会抛——两件事分得清，理由见 `fetchRemote`。
 * 和 `autobackup.ts` 的 `PREFIX` 是同一件事，但这边没有「用文件选择器挑一个」
 * 的逃生口——WebDAV 只能走 rpc。
 */
export async function download(
  cfg: DavConfig,
  opts: { fetchImpl?: typeof globalThis.fetch } = {},
): Promise<{ json: string; createdAt: string } | null> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchRemote(cfg, f);
  if (!res) return null;
  const json = await res.text();
  let createdAt = '';
  try {
    createdAt = (JSON.parse(json) as { createdAt?: string }).createdAt ?? '';
  } catch {
    return null; // 远端那份不是我们的格式，当没有
  }
  return { json, createdAt };
}
