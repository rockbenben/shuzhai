// Electron 主进程。所有文件 I/O、SQLite、扫描、重命名都在这里（spec §12）。
//
// **不需要构建步骤**：Electron 44 自带 Node 24.19.0，`.ts` 由 Node 原生剥类型直接跑，
// `node:sqlite` 也在（都实测过，见 AGENTS.md）。渲染进程那半才需要 Vite。

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, protocol, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { openDb, openReadonly, getSetting } from '../core/db.ts';
import { 清理暂存区, QUARANTINE_DIR } from '../core/deletion.ts';
import {
  nextRunDelay,
  shouldScanOnStartup,
  DEFAULT_SCHEDULE,
  type ScheduleConfig,
} from '../core/schedule.ts';
import { createApiServer, listen, callRpc, DEFAULT_PORT, type RpcMethods } from '../server/api.ts';
import { FileCache } from '../core/reader.ts';
import { LibraryWatcher } from '../core/watcher.ts';
import { maybeBackup } from '../core/autobackup.ts';
import { createRpc } from './rpc.ts';
import { CoverFetcher } from './cover-fetcher.ts';
import { migrateUserData } from './migrate-userdata.ts';
import { bundledFonts, listFonts } from '../core/fonts.ts';
// 「什么时候该发进度」的判据。放 core 是因为**这个文件 import electron，测不了**
import { makeProgressGate } from '../core/pacing.ts';
import { closeOpenSessions } from '../core/status.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** 没打包时的窗口图标。打包后 `build/` 不在 asar 里，这个路径不存在 */
const DEV_ICON = join(here, '..', '..', 'build', 'icon.ico');

/**
 * 去掉 Electron 的默认菜单。
 *
 * 那套 File / Edit / View / Window / Help 是 Electron 送的，跟这个应用没有关系——
 * 里面是「重新加载」「切换开发者工具」「实际大小」这类东西，对看小说的人只有干扰。
 *
 * **macOS 上不能真的去掉**：那边没有应用菜单的话，连 Cmd+C / Cmd+V 都会失效
 * （Chromium 在 macOS 上靠菜单项的 role 注册这些快捷键）。所以那边留一份最小的。
 */
function setupMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    /*
     * **记住上次拖成多大、摆在哪儿**（Electron 44 新增，走它自带的实现）。
     *
     * ⚠️ **`name` 不是给人看的标题，而且没有它这个选项直接无效**——
     * 它是 Electron 内部用来认这扇窗的键。文档那句话是「Has no effect if
     * window `name` is not provided」，也就是说漏了 `name` 不报错、不警告，
     * 只是**什么都不发生**（同这个仓库里 `readOnly` 大小写那条：拼错不报错，
     * 只是保证没了）。
     *
     * ⚠️ **别给抓封面那个隐藏窗口也起名字。** `name` 要求全局唯一、
     * 而且销毁之前不能复用，重名直接抛——那个窗口是反复建反复销的
     * （`cover-fetcher.ts`，那儿也写了一句）。
     *
     * ⚠️ typings 里它标着 `_Experimental_`。上它是用户拍的板：这功能本身
     * 自己写也就四十行（`getBounds()` + `isMaximized()` 存进 `app_setting`，
     * 启动时拿 `screen` 兜一下显示器没了的情况）。**哪天它被改掉或去掉，
     * 退路就是那四十行**，不是回到「每次都 1200×800 居中」。
     *
     * `width` / `height` 留着：第一次启动（还没存过状态）时才用得上。
     */
    name: 'main',
    windowStatePersistence: true,
    width: 1200,
    height: 800,
    // 窗口再窄就没法用了，而不设下限的话用户能一路拖到几十像素、再也拖不回来。
    // 760 是量出来的：侧栏 200 固定 + 封面墙一行放得下两张卡（每张最小 8.2rem）
    // + 头部那排控件换行之后还看得全。再窄封面墙只剩一列，那不是书架了。
    // ⚠️ 恢复出来的尺寸也要过这道下限——所以别把它去掉当成「反正存过了」。
    minWidth: 760,
    minHeight: 520,
    title: '书斋',
    /*
     * **没打包跑的时候（`npm start`）窗口图标要自己给。**
     *
     * 打包那条路一直是对的：`electron-builder` 按约定认 `build/icon.ico`
     * （`electron-builder.yml` 里因此一个字都没写），exe 和快捷方式都带着它。
     * 而 `npm start` 跑的是 `node_modules` 里那个 electron.exe，
     * 窗口图标不设就是 Electron 自带的原子——**看起来像图标没改成功**。
     *
     * 打包后 `build/` 不在 asar 里，所以那时 `existsSync` 为假、这一项不给：
     * 那条路本来就由 exe 自己嵌的图标负责。
     */
    ...(existsSync(DEV_ICON) ? { icon: DEV_ICON } : {}),
    webPreferences: {
      // spec §12：渲染进程不碰 Node，只能经 contextBridge 的白名单调主进程
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(join(here, '../../dist/index.html'));

  // 隐藏窗口也算「窗口」：封面抓取的隐藏 BrowserWindow 在队列跑的几小时里一直活着，
  // 这会让下面的 `window-all-closed` 永远不触发（不是「没窗口了」，是「还有一个没关」）。
  // 关主窗口这个信号必须直接挂在主窗口自己身上，不能借道那个事件（实测确认过）
  win.on('closed', () => app.quit());

  return win;
}

/*
 * **Windows 的任务栏按 AppUserModelID 归组、也按它取图标。**
 *
 * 不设的话，没打包跑（`npm start`）时任务栏认的是 `electron.exe` 自己的身份，
 * 于是那儿显示的还是 Electron 的原子——**光给 `BrowserWindow` 一个 icon
 * 只能改掉标题栏和 Alt-Tab，任务栏不跟着变**。
 *
 * 值和 `electron-builder.yml` 的 `appId` 一致：打包后系统本来就用这个 id，
 * 显式设一遍不改变任何行为，只是让没打包那条路也对得上。
 */
app.setAppUserModelId('top.newzone.shuzhai');

/*
 * PDF / EPUB 查看器要在**渲染进程**里读文件，而那边 `contextIsolation: true` /
 * `nodeIntegration: false`，碰不到磁盘（spec §12，这条不能破）。
 *
 * 所以开一个自定义协议：`book://f/<bookId>` → 主进程查库、把主文件流回去。
 *
 * ⚠️ **它只放行库里登记过的文件**。用 `book://f/<id>` 而不是
 * `book://<绝对路径>`，是因为后者等于给渲染进程一把「读任意文件」的钥匙——
 * 这个应用别的地方一条都没有这种口子（所有文件 I/O 都在主进程）。
 * 拿 id 查库，天然只能读到书库里的书。
 *
 * `registerSchemesAsPrivileged` **必须在 app ready 之前**调用，
 * 所以它在这儿，不在 `whenReady` 里面。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'book',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // pdf.js 会按需取片段；不给 stream 的话它只能整本先下下来
      stream: true,
      /*
       * ⚠️ **`corsEnabled` 不能省。** 渲染进程是 `file://` 加载的（`loadFile`），
       * 取 `book://` 属于**跨源** fetch——不开这一条，请求直接被挡在渲染进程里，
       * pdf.js 报的是 `Unexpected server response (0)`，
       * **看起来像文件坏了或者协议没注册**，而主进程那边一条日志都没有
       * （请求根本没到处理器）。实测踩到过。
       */
      corsEnabled: true,
    },
  },
]);

app.whenReady().then(async () => {
  /**
   * **只允许跑一个实例。** 这不是洁癖，是两处实际后果：
   *
   * 1. 两个实例开同一个 `library.db`。第二个多半直接 `disk I/O error`——
   *    而它原来是一句未捕获的 promise 拒绝，**界面上什么都没有**，
   *    用户看到的就是「点了图标没反应」（实测踩到过）。
   * 2. 两份封面抓取队列同时跑，对同一个站点的请求速率直接翻倍——
   *    而限流是这个功能最大的敌人，一限流就会把「没匹配上」这个假结论写进库。
   *
   * 顺带也解释了原来那个「HTTP 服务偶尔悄悄绑不上 30036」：端口被前一个实例占着。
   */
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  // 改名「小说管理器 → 书斋」把数据目录也换了（novel-manager → shuzhai）。
  // **必须在 openDb 之前搬**，否则会在空目录里建一个新库，而用户看到的是书库消失
  const migrated = migrateUserData(
    join(app.getPath('appData'), 'novel-manager'),
    app.getPath('userData'),
  );
  if (migrated) console.log(`[migrate] 书库已从 novel-manager 搬到 shuzhai：${migrated.moved.join('、')}`);

  const dbPath = join(app.getPath('userData'), 'library.db');
  let db;
  try {
    db = openDb(dbPath);
  } catch (e) {
    // 打不开库就没什么可做的了，但**必须说话**——静默退出等于「点了没反应」
    dialog.showErrorBox(
      '打不开书库',
      `${e instanceof Error ? e.message : String(e)}\n\n${dbPath}\n\n`
        + '如果应用已经开着一个窗口，先把它关掉再试。',
    );
    app.quit();
    return;
  }
  /*
   * 开机时还有没关上的会话，说明**上次是被杀掉或者崩了**（正常退出走 `before-quit`）。
   * 这时候不知道它什么时候结束的，只能用「最后一次知道他在读」那个时刻，
   * 进度保守地当作没推进——判据和理由在 `core/status.ts` 的 `closeOpenSessions`。
   */
  closeOpenSessions(db, 'crash');

  /*
   * `book://f/<bookId>` 的处理器。查的是**主文件**，和 `book.list` 的 `path`
   * 取的是同一个（`is_primary = 1`）——不然「卡片上写着这本能看、点开却是另一份」。
   *
   * ⚠️ 用 `net.fetch(file://…)` 而不是自己 `createReadStream`：它带 Range 支持，
   * pdf.js 才能按需取片段。（本文件别处那条「不用 net.fetch」说的是**网络请求**，
   * 那里全局 fetch 就够；这里是给协议处理器喂本地文件，是它的正经用法。）
   */
  protocol.handle('book', async (req) => {
    const id = Number(new URL(req.url).pathname.replace(/^\//, ''));
    if (!Number.isInteger(id) || id <= 0) return new Response('bad id', { status: 400 });
    const row = db
      .prepare('select path from book_file where book_id = ? and is_primary = 1')
      .get(id) as { path: string } | undefined;
    if (!row) return new Response('not in library', { status: 404 });
    if (!existsSync(row.path)) return new Response('file gone', { status: 404 });
    /*
     * ⚠️ **直接流文件，不要走 `net.fetch(file://…)`。**
     *
     * 那条路会把一次**本地文件读取**塞进 Chromium 的网络栈——而这个应用里
     * 网络栈上还跑着**封面抓取**（隐藏窗口 + 后台队列，一本接一本地抓）。
     * 实测的症状：应用刚起来时 PDF / EPUB 都打得开，抓封面一开始跑，
     * `fetch('book://…')` 就**挂住不返回**，查看器永远停在「正在打开…」，
     * 而主进程一条日志都没有、协议本身也没坏（隔一会儿单独 fetch 又好使）。
     * 排查时它表现得像「epub.js 的毛病」，因为 PDF 那边的失败被我先归到别处了。
     *
     * `Readable.toWeb` 是流式的：一本几十兆的 PDF 不会整个读进内存。
     */
    const st = statSync(row.path);
    return new Response(Readable.toWeb(createReadStream(row.path)) as ReadableStream, {
      headers: {
        'content-type': row.path.toLowerCase().endsWith('.pdf')
          ? 'application/pdf'
          : row.path.toLowerCase().endsWith('.epub')
            ? 'application/epub+zip'
            : 'application/octet-stream',
        'content-length': String(st.size),
      },
    });
  });

  // 阅读器的文件句柄缓存。整个应用一份——重命名前要能从这里把句柄释放掉
  const cache = new FileCache();
  // 封面抓取：隐藏窗口 + 后台队列，需要 BrowserWindow 所以建在 main 这层
  const coverFetcher = new CoverFetcher(db, app.getPath('userData'));

  setupMenu();
  const win = createWindow();

  // 需要 electron 能力的方法拼在这里，rpc.ts 本身保持可在普通 Node 测试里跑
  const rpc: RpcMethods = {
    ...createRpc(
      db,
      cache,
      app.getPath('userData'),
      (() => {
        /*
         * **进度要限流：一次扫描 8000 个文件就是 8000 条 IPC。**
         *
         * 判据和它的理由都在 `core/pacing.ts`（那里有测试守着，
         * 这个文件 import electron 所以测不了）。这里只管「发不发得出去」。
         */
        const gate = makeProgressGate();
        return (p: { file: string; done: number; root: string }) => {
          if (win.isDestroyed()) return; // 窗口可能已经关了（退出时的最后一次扫描）
          if (gate(p.done, Date.now())) win.webContents.send('scan-progress', p);
        };
      })(),
      // 删除一律走系统回收站，不是真删——删错了还能拖回来。
      // 阅读器可能正开着这个文件，Windows 上不先放开句柄会失败
      async (path: string) => {
        await cache.release(path);
        await shell.trashItem(path);
      },
      (() => {
        // 建索引的进度也要限流：**12046 章就是 12046 条 IPC**，
        // 和扫描那条是同一个坑（见 core/pacing.ts）
        const gate = makeProgressGate();
        return (p: { done: number; total: number }) => {
          if (win.isDestroyed()) return;
          if (gate(p.done, Date.now())) win.webContents.send('index-progress', p);
        };
      })(),
    ),

    /** 打开系统的选目录对话框，返回选中的路径（取消则 null）。不写任何东西 */
    'ui.pickFolder': async () => {
      const r = await dialog.showOpenDialog({
        title: '选择放书的文件夹',
        properties: ['openDirectory'],
      });
      return r.canceled ? null : r.filePaths[0];
    },


    /** 选一张封面图。只返回路径，复制那一步在 cover.set 里做 */
    'ui.pickImage': async () => {
      const r = await dialog.showOpenDialog({
        title: '选择封面图片',
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] }],
        properties: ['openFile'],
      });
      return r.canceled ? null : r.filePaths[0];
    },

    /** 选一个字体文件。只返回路径，复制那一步在 font.add 里做 */
    'ui.pickFont': async () => {
      const r = await dialog.showOpenDialog({
        title: '选择字体文件',
        filters: [{ name: '字体', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
        properties: ['openFile'],
      });
      return r.canceled ? null : r.filePaths[0];
    },

    /** 选一份纸色配置。只选不读——读文件是 theme.importFile 的事 */
    'ui.pickThemeFile': async () => {
      const r = await dialog.showOpenDialog({
        title: '选择纸色配置（「阅读」里导出的主题）',
        filters: [{ name: '纸色配置', extensions: ['json'] }],
        properties: ['openFile'],
      });
      return r.canceled ? null : r.filePaths[0];
    },

    /** 选一份朗读引擎配置。只选不读——读文件是 tts.importFile 的事 */
    'ui.pickTtsFile': async () => {
      const r = await dialog.showOpenDialog({
        title: '选择朗读引擎配置（httpTTS.json）',
        filters: [{ name: '朗读引擎配置', extensions: ['json'] }],
        properties: ['openFile'],
      });
      return r.canceled ? null : r.filePaths[0];
    },

    /** 选一个备份文件。只选不读——读文件是 backup.importFile 的事 */
    'ui.pickBackupFile': async () => {
      const r = await dialog.showOpenDialog({
        title: '选择备份文件',
        filters: [{ name: '备份文件', extensions: ['json'] }],
        properties: ['openFile'],
      });
      return r.canceled ? null : r.filePaths[0];
    },

    /**
     * 用系统默认程序打开一个文件。PDF / EPUB 这类只编目的书走这条——
     * **只读地交出去**，应用自己不解析、不改、不复制。
     */
    'ui.openFile': async (params: unknown) => {
      const path = (params as { path?: string })?.path;
      if (!path) throw new Error('缺少 path');
      const err = await shell.openPath(path);
      // openPath 不抛，失败时返回一串错误文字——不看它的话「点了没反应」
      if (err) throw new Error(err);
      return { ok: true };
    },

    /** 在资源管理器里定位一个文件（spec §8：只帮用户找到，不替他动） */
    'ui.revealFile': (params: unknown) => {
      const path = (params as { path?: string })?.path;
      if (!path) throw new Error('缺少 path');
      shell.showItemInFolder(path);
      return { ok: true };
    },

    /**
     * 字体列表 = **随应用发布的 + 用户自己装的**。在这里覆盖 rpc.ts 那份，
     * 因为「随应用发布的字体在哪」只有主进程知道：打包后在 resources/fonts，
     * 开发时在仓库的 build/fonts。
     */
    'font.list': () => [
      ...bundledFonts(app.isPackaged ? process.resourcesPath : join(here, '../../build')),
      ...listFonts(app.getPath('userData')),
    ],

    // 封面抓取：需要 BrowserWindow，所以和 trash 一样拼在 main 这层
    'cover.fetchStatus': () => coverFetcher.status(),
    'cover.fetchStart': () => { coverFetcher.start(); return { ok: true }; },
    'cover.fetchStop': () => { coverFetcher.stop(); return { ok: true }; },
    'cover.retryMisses': () => ({ reset: coverFetcher.retryMisses() }),
    // 校验三个源（照 legado 的「校验书源」）。源必然会坏，而坏了只表现为命中率悄悄下降
    'cover.checkSources': () => coverFetcher.checkSources(),
    /** 试一条自定义源的规则。和正式抓取走同一条路，不然「试着好使真抓不出来」 */
    'cover.testSource': (params) => {
      const p = params as { source: Parameters<typeof coverFetcher.testSource>[0]; title?: string };
      return coverFetcher.testSource(p.source, p.title || '斗破苍穹');
    },
    'cover.fetchOne': (params) => coverFetcher.fetchOne(Number((params as { bookId: number }).bookId)),
  };

  // 渲染进程入口。和 /api/rpc 共用 callRpc 那一处判据，不另写守卫
  ipcMain.handle('rpc', (_event, method: string, params: unknown) => callRpc(rpc, method, params));

  // 窗口已就绪：开关开着的话延迟半分钟接着抓（内部自带延迟，这里直接调）
  coverFetcher.resumeIfEnabled();

  /*
   * **人在看的时候不抓封面。**
   *
   * 抓一张 = 在隐藏窗口里真的渲染一遍起点页面，和应用自己的渲染进程抢资源。
   * 真实书库上实测：抓取开着时书架要 40.8 秒才铺出来，停掉只要 1.9 秒。
   * 而那个库还有 6778 本待抓，十几个小时——这十几个小时里应用基本没法用，
   * 而且用户根本不会把这件事和「封面抓取」联系起来。
   * 窗口失焦 8 秒后接着抓，回来就让路；用户那个开关一个字不动。
   */
  win.on('focus', () => { console.log('[cover] 窗口获得焦点，抓取让路'); coverFetcher.setUiActive(true); });
  win.on('blur', () => { console.log('[cover] 窗口失焦，8 秒后接着抓'); coverFetcher.setUiActive(false); });
  if (win.isFocused()) coverFetcher.setUiActive(true);

  // AI 维护接口（spec §13.1）。起不来只记日志——它是附属品，不能拖垮应用
  const server = createApiServer({ readonlyDb: openReadonly(dbPath), rpc });
  /*
   * ⚠️ **端口可以用 `SHUZHAI_API_PORT` 换一个。**
   *
   * 不是为了配置而配置：30036 写死时，**用户自己开着应用就没法跑走查**——
   * 第二个实例（独立 `--user-data-dir`）绑不上端口，于是它压根儿没有接口，
   * 而 `scripts/ui-check/` 那套写死了地址——实测结果是
   * **每一句 rpc 都打到了用户的真实库上**（往里面写过两条测试划线）。
   * 现在两头读同一个环境变量，走查实例自己占一个口，互不干扰。
   */
  const 指定的口 = Number(process.env.SHUZHAI_API_PORT);
  const port = await listen(
    server,
    Number.isInteger(指定的口) && 指定的口 > 0 && 指定的口 < 65536 ? 指定的口 : DEFAULT_PORT,
  );
  console.log(
    port === null
      ? `[api] 维护接口未启动：${DEFAULT_PORT} 端口被占用。应用其余功能不受影响`
      : `[api] 维护接口已就绪 http://127.0.0.1:${port}`,
  );


  // 老板键（spec §6）：一键把窗口藏起来/叫回来。
  // **注册失败不报错**——这个组合键很可能被别的软件占了，
  // 而为了一个可有可无的快捷键让应用起不来是本末倒置。
  const bossKey = getSetting(db, 'reader.bossKey') || 'CommandOrControl+Shift+H';
  const registered = globalShortcut.register(bossKey, () => {
    if (win.isVisible()) win.hide();
    else {
      win.show();
      win.focus();
    }
  });
  if (!registered) console.warn(`[hotkey] 老板键 ${bossKey} 注册失败，可能被别的程序占用`);

  // ── 定期扫描（spec §1.2）────────────────────────────────────────
  //
  // ponytail: 扫描跑在主进程里。章节解析是同步的，超大库会让窗口顿一下——
  // 但每本书之间都有 await，事件循环有喘息，实测量级是几十毫秒。
  // 真觉得卡了再按 spec §12 挪进 utilityProcess，接口不用改。
  let timer: NodeJS.Timeout | null = null;

  const readSchedule = (): ScheduleConfig => ({
    mode: (getSetting(db, 'scan.mode') || DEFAULT_SCHEDULE.mode) as ScheduleConfig['mode'],
    intervalHours: Number(getSetting(db, 'scan.intervalHours') || DEFAULT_SCHEDULE.intervalHours),
    dailyTime: getSetting(db, 'scan.dailyTime') || DEFAULT_SCHEDULE.dailyTime,
  });

  const runScan = async (reason: string) => {
    // 走 callRpc 而不是直接取那个函数：白名单校验只有这一处
    const report = await callRpc(rpc, 'library.scan', {});
    // 状态栏要能看见后台扫描发生过，否则书架自己变了会让人莫名其妙
    win.webContents.send('scan-done', { reason, report });
    return report;
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    const delay = nextRunDelay(readSchedule(), new Date());
    if (delay === null) return;
    timer = setTimeout(() => {
      void runScan('定期扫描').finally(schedule); // 跑完再排下一次，不会叠加
    }, delay);
  };

  if (shouldScanOnStartup(readSchedule())) void runScan('启动时扫描');
  schedule();

  // 实时文件监听（spec §1.2，M4）。**默认关闭**——目录文件数很大时事件会很密
  let watcher: LibraryWatcher | null = null;
  const startWatching = () => {
    watcher?.close();
    watcher = null;
    if (getSetting(db, 'scan.watch') !== '1') return;

    watcher = new LibraryWatcher(() => void runScan('检测到文件变动'));
    for (const r of db.prepare('select path from library_root where enabled = 1').all() as Array<{
      path: string;
    }>) {
      watcher.watchRoot(r.path);
    }
  };
  startWatching();

  // 自动备份（spec §10）。判据是「距上次多久」而不是固定时刻——
  // 桌面应用不常驻，按时刻排的话好几天不开机的人一次都轮不到，
  // 而他恰恰最需要备份。这里只是定期来问一句「该备了吗」。
  const checkBackup = () => {
    void maybeBackup(db, new Date())
      .then((r) => {
        if (r) console.log(`[backup] 自动备份完成：${r.path}（清理 ${r.pruned.length} 份旧的）`);
      })
      .catch((e: Error) => console.warn('[backup] 自动备份失败：', e.message));
  };
  /*
   * ⚠️ **开机那一次要往后挪。** `exportBackup` 是**同步**读整个库拼 JSON——
   * 真实库上量的：8172 本 **829 ms / 5.53 MB**（冷热差不多，它是纯 CPU 和 SQL）。
   * 主进程被它占住的这段时间 IPC 一律不回，而开机恰恰是渲染进程在连着要
   * `book.list` / `book.counts` 的时刻：用户看到的是「点开图标之后书架慢了将近一秒」，
   * 而他完全不会把这件事和「自动备份」联系起来。
   *
   * 挪 30 秒就够了：这时候首屏早就铺完，用户在翻书架。
   * 判据和封面抓取那条「给界面让路」是同一个（那处是 40.8 秒 vs 1.9 秒，
   * 比这个夸张得多，但形状一样）。
   *
   * **代价说清楚**：开了不到 30 秒就关掉的话这次不备了。可以接受——
   * `shouldBackup` 按「距上次多久」算，下次开机照样轮得到；
   * 而开机半分钟就关的人，这半分钟里也没产生什么要护的东西。
   */
  /*
   * 暂存区里躺够 30 天的清掉。**开机时做一次就够**——这个目录只有
   * 「回收站收不下」时才会进东西（网络盘上的重复文件），一天进不了几个，
   * 不值得为它单开一个定时器。
   *
   * ⚠️ 判据在 `deletion.ts` 的 `该清掉`：**名字里读不出入区时间的一律不动**。
   * 这一步是真删，而那个目录用户自己也打得开、也可能往里放东西。
   */
  void 清理暂存区(join(app.getPath('userData'), QUARANTINE_DIR))
    .then((r) => { if (r.清掉) console.log(`[暂存区] 清掉 ${r.清掉} 个躺够 30 天的，还留着 ${r.留着} 个`); })
    .catch((e: Error) => console.warn('[暂存区] 清理失败：', e.message));

  const firstBackup = setTimeout(checkBackup, 30_000);
  const backupTimer = setInterval(checkBackup, 6 * 3600_000);

  // 设置改了要立刻重新排，不能等到下一次触发
  ipcMain.handle('reschedule', () => {
    schedule();
    startWatching();
    return { ok: true };
  });

  app.on('before-quit', () => {
    /*
     * **退出时把没关上的阅读会话收掉。** 会话由渲染进程「卸载时 `session.end`」，
     * 而**直接退出应用时 React 的 cleanup 根本不跑**——真实库上量到 30 条里
     * 13 条（43%）就是这么悬着的。这里知道的是「就是现在结束的」，
     * 所以进度取这本书当前的 `percent`（`saveProgress` 一路写着的那个）。
     * 判据和开机那次不一样，理由写在 `core/status.ts` 的 `closeOpenSessions` 上。
     */
    closeOpenSessions(db, 'quit');
    globalShortcut.unregisterAll();
    if (timer) clearTimeout(timer);
    clearTimeout(firstBackup);
    clearInterval(backupTimer);
    watcher?.close();
    coverFetcher.stop(false); // 退出不算用户关开关，下次启动 resumeIfEnabled 还会接着抓
    server.close();
    void cache.releaseAll();
    db.close();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
