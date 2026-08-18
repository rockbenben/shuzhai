// Claude / AI 工具的本地维护接口（spec §13.1）。
//
// 三个端点，全部只绑 127.0.0.1：
//   GET  /api/stats  库概览
//   POST /api/query  只读 SQL —— 分析数据的主通道
//   POST /api/rpc    白名单方法 —— 凡是碰磁盘文件的操作只能走这里
//
// **为什么 POST 必须带 `X-Api` 头**：任何网页都能对 127.0.0.1 的端口发一个
// `text/plain` 的简单 POST，不触发预检。而 rpc 里有重命名这种真改磁盘的操作。
// 带自定义头会强制浏览器先发 CORS 预检，我们不响应预检，网页就永远发不进来；
// curl / Claude 加一个头是零成本。响应一律不带 CORS 头，GET 同样读不走。

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
// 状态清单走 `core/labels.ts` 那一份——全应用唯一的一份，别在这儿抄第二遍
import { READING_STATUS } from '../core/labels.ts';
import { ratedSql, countBooks, UNREVIEWED } from '../core/library.ts';

/** spec §13.1：30000 + 项目编号，和 031-zhengyin 的 30031 同一套约定 */
export const DEFAULT_PORT = 30036;

/** 单次查询的返回行数上限，防止一句 `select * from chapter` 把整库拖出来 */
export const MAX_ROWS = 10_000;

const API_HEADER = 'x-api';

/**
 * rpc 方法表。**这张表就是渲染进程 `contextBridge` 的白名单**，同一张，不抄第二份：
 * 界面能做的 Claude 都能做，且走同样的校验、rename_log 和安全阀（spec §13.1）。
 */
export type RpcMethods = Record<string, (params: unknown) => unknown>;

export interface ApiOptions {
  /** 只读连接，`/api/query` 专用。写操作由 SQLite 自己挡掉 */
  readonlyDb: DatabaseSync;
  rpc: RpcMethods;
}

/**
 * 查白名单并调用。**HTTP 和 IPC 共用这一处判据**——两边各写一份守卫，迟早会分叉成
 * 「界面能做但接口不能」或者更糟的反过来。
 * 用 `Object.hasOwn` 而不是 `in`：后者会让 `constructor`、`toString` 这些原型链上的
 * 名字通过检查。
 */
export function callRpc(rpc: RpcMethods, method: unknown, params: unknown): unknown {
  if (typeof method !== 'string' || !Object.hasOwn(rpc, method)) {
    throw new Error(`没有这个方法：${String(method)}`);
  }
  return rpc[method](params);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  // 刻意不设任何 Access-Control-* 头
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  return JSON.parse(raw);
}

/**
 * 主进程加载本模块的时刻。src 下的 .ts 是启动时加载一次的（AGENTS.md
 * 「改了 src/core 必须重启应用」）：任何 src/**.ts 的 mtime 晚于它，说明正在跑的
 * 还是旧代码，rpc 会按旧规则静默执行。外部工具发 rpc 前拿它对一下 mtime 即可，
 * 不用再「拿一本已知会变的书验一下」。pid 用来确认重启真的发生了（重启必换 pid）。
 */
export const STARTED_AT = new Date().toISOString();

/** 库概览（spec §13.1 的 GET /api/stats） */
export function collectStats(db: DatabaseSync): Record<string, unknown> {
  const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    startedAt: STARTED_AT,
    pid: process.pid,
    books: one('select count(*) n from book'),
    files: one('select count(*) n from book_file'),
    chapters: one('select count(*) n from chapter'),
    roots: one('select count(*) n from library_root'),
    /*
     * **五个状态一个都不能少，没有的就是 0。**
     * 原来是裸 `group by status`——一本都没有的状态根本不返回行，于是外部工具
     * 写 `byStatus.find(x => x.status === 'finished').n` 会当场炸，
     * 而它看起来只是「还没读完任何书」。同界面上那条「一律显示数字，没有就是 0」，
     * 只是这次的消费者是脚本，缺一个键比显示成空更难查。
     */
    byStatus: READING_STATUS.map((s) => ({
      status: s.id,
      n: one(`select count(*) n from reading_state where ifnull(status,'none') = '${s.id}'`),
    })),
    /*
     * **评价这一维**。这个应用的正事是「下次不用再想这本我看过没」，
     * 而这份概览原来只说书/文件/章节/根目录——恰好漏掉了它存在的理由。
     * §13 说这是给外部工具的主通道，「我评过多少本了」不该逼人去写 SQL。
     *
     * `rated` 的口径和书架那一档（`buildFilter` 的 `rated`）一致：
     * **有星级或有短评都算**——只写了句「烂尾了别看」没打分的也是评价过。
     */
    // 判据只此一份，见 `core/library.ts` 的 `ratedSql`——
    // 书架「我的书评」那一档用的是同一个，两份 SQL 迟早说不到一块儿去
    rated: one(`select count(*) n from reading_state where ${ratedSql()}`),
    commented: one("select count(*) n from reading_state where ifnull(comment,'') != ''"),
    /*
     * **读过、可是还没写一句**——这个应用唯一的待办清单，外部工具最该问的一个数
     * （「你还有 6 本读过没写」）。判据引 `core/library.ts` 的 `UNREVIEWED`，
     * 和侧栏那一档共用同一份，别在这儿另写一句 SQL：同一件事两份判据，
     * 改一处漏一处，界面和外部工具就开始各说各的。
     */
    /*
     * ⚠️ **`excluded: 'all'` 不能省。** 这个对象里别的数
     * （`rated` / `commented` / `byStatus`）数的都是**整张 `reading_state`**，
     * 被屏蔽的书也算；而 `countBooks` 默认把它们挡在外面。
     * 不加这一句，同一个 JSON 里 `rated` 含屏蔽、`unreviewed` 不含——
     * 外部工具拿这两个数一比就是一笔糊涂账（当场量的：2 对 1）。
     *
     * 判据：**一个返回对象里的几个数，口径必须一致**；
     * 至于该含不含屏蔽，跟着这个对象已有的约定走，别在这儿新开一套。
     */
    unreviewed: countBooks(db, { ...UNREVIEWED, excluded: 'all' }),
    tags: one('select count(*) n from tag'),
    taggedBooks: one('select count(distinct book_id) n from book_tag'),
    problems: db
      .prepare("select status, count(*) n from book_file where status != 'ok' group by status")
      .all(),
  };
}

/**
 * 只读 SQL。真正的只读保证来自连接本身（`openReadonly`），不靠解析 SQL——
 * 关键字黑名单那种做法总能被绕过，而 SQLite 自己的 readOnly 不会。
 * 这里额外拦多语句，只是为了给出一句清楚的报错：`prepare` 其实会放行 `select 1; drop ...`。
 */
export function runQuery(db: DatabaseSync, sql: unknown, params: unknown): unknown {
  if (typeof sql !== 'string' || sql.trim() === '') throw new Error('缺少 sql');
  if (sql.replace(/;\s*$/, '').includes(';')) throw new Error('一次只能执行一条语句');

  const stmt = db.prepare(sql);
  const args = Array.isArray(params) ? params : [];

  // **边取边停，不能 `all()` 完再 slice。** 那样 MAX_ROWS 只挡住了「发出去多少」，
  // 挡不住「取出来多少」：真实库上 `select * from chapter` 是 658 万行，实测
  // 17 秒 / 4 GB RSS——而这里跑在 Electron 主进程，整个应用连着卡死。
  // 改成 iterate 之后同一句是 23 毫秒 / 12 MB。
  // 代价：`rowCount` 是「返回了几行」而不是全表总数（要总数自己 `count(*)`，
  // 那才是本来就该用的写法，而不是让主进程把 658 万行拉进内存再数一遍）。
  const rows: unknown[] = [];
  for (const row of stmt.iterate(...(args as never[]))) {
    if (rows.length === MAX_ROWS) return { rows, rowCount: MAX_ROWS, truncated: true };
    rows.push(row);
  }
  return { rows, rowCount: rows.length, truncated: false };
}

export function createApiServer(opts: ApiOptions): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';

      try {
        if (method === 'GET' && url.pathname === '/api/stats') {
          return send(res, 200, collectStats(opts.readonlyDb));
        }

        if (method === 'POST') {
          // 见文件头：这一行是挡浏览器跨站的全部依仗
          if (!req.headers[API_HEADER]) {
            return send(res, 403, { error: `POST 需要带 ${API_HEADER} 请求头` });
          }
          const body = (await readJson(req)) as Record<string, unknown>;

          if (url.pathname === '/api/query') {
            return send(res, 200, runQuery(opts.readonlyDb, body.sql, body.params));
          }

          if (url.pathname === '/api/rpc') {
            const name = body.method;
            if (typeof name !== 'string' || !Object.hasOwn(opts.rpc, name)) {
              return send(res, 404, {
                error: `没有这个方法：${String(name)}`,
                available: Object.keys(opts.rpc),
              });
            }
            return send(res, 200, { result: await callRpc(opts.rpc, name, body.params) });
          }
        }

        send(res, 404, { error: '没有这个端点', endpoints: ['GET /api/stats', 'POST /api/query', 'POST /api/rpc'] });
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
}

/**
 * 起服务。**只绑 127.0.0.1**，不是 0.0.0.0——绑通配地址等于把改文件名的能力
 * 开放给整个局域网。
 *
 * 起不来只返回 null，不抛：维护接口是附属品，端口被占不能拖垮应用（spec §13.1）。
 */
export function listen(server: Server, port = DEFAULT_PORT): Promise<number | null> {
  return new Promise((resolve) => {
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : null);
    });
  });
}
