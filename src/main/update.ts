import { readFileSync } from 'node:fs';
import { app, type BrowserWindow, dialog } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateCheckResult } from 'electron-updater';

/**
 * 应用内更新检查。
 *
 * **默认关闭**：开关在设置弹窗的「联网」页里（`app_setting` 的 `update.check`），
 * 用户不打开就一次网络请求都不发。这个应用管的是用户的书库，联网得用户自己点头。
 *
 * **下载和安装都要用户点头**：electron-updater 默认 autoDownload=true（一发现
 * 新版就开下）、autoInstallOnAppQuit=true（下载完退出应用就顺手装上）。两条都
 * 关掉——否则「告诉用户有新版」就变成了「悄悄把用户的程序换掉」。
 *
 * ⚠️ **electron-updater 是 CommonJS 包，而本仓库是 ESM。** 它的 `autoUpdater`
 * 是用 `Object.defineProperty(exports, …, { get })` 导出的，cjs-module-lexer
 * 认不出来（箭头函数那个写法它不扫）——`import { autoUpdater } from 'electron-updater'`
 * 直接抛 `Named export 'autoUpdater' not found`。只能走默认导入再自己取。
 * 这条坑记在这里，免得下一个人「顺手改成具名导入」然后在启动时炸掉。
 */

/** 一次检查的结果。调用方（设置弹窗）只需要知道这个 */
export type UpdateOutcome = 'upToDate' | 'available' | 'downloaded' | 'failed' | 'skipped';

export interface UpdateHost {
  /** 主窗口。弹窗挂到它身上才像这个应用的对话框 */
  getWindow: () => BrowserWindow | null;
}

/**
 * autoUpdater 是进程级单例，事件挂在它身上。
 *
 * error 事件**必须**有人听：EventEmitter 没有监听者时会抛未捕获异常，
 * 而打包后的应用没有控制台，这一次崩溃会直接带走整个应用。
 */
let 已挂错误监听 = false;
function 挂错误监听(): void {
  if (已挂错误监听) return;
  已挂错误监听 = true;
  // 延迟取：autoUpdater 是导出上的 getter，第一次取它才会真正建实例
  const { autoUpdater } = electronUpdater;
  autoUpdater.on('error', (err: Error) => {
    // 只记日志：检查失败（离线、限流、发布页还没准备好）不值得弹一个用户没法处理的框
    console.warn('[update] 更新检查出错：', err?.message ?? err);
  });
}

/**
 * 发布页地址。**唯一事实源是 package.json 的 repository 字段**，不另写一份副本。
 * 下载失败时它是指给用户看的第二条路——应用内更新失败不该是死路。
 *
 * 读不到就当没有：地址只是失败提示里的一句附赠，缺了不该让整个检查报错。
 */
const RELEASES_URL = ((): string => {
  try {
    const 原文 = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(原文) as { repository?: { url?: string } };
    const m = (pkg.repository?.url ?? '').match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return m ? `https://github.com/${m[1]}/${m[2]}/releases/latest` : '';
  } catch {
    return '';
  }
})();

/** 弹一个只有「好」按钮的框。有窗口就挂在窗口上 */
async function 说一句(host: UpdateHost, 标题: string, 正文: string): Promise<void> {
  const win = host.getWindow();
  const 选项 = { type: 'info' as const, message: 标题, detail: 正文, buttons: ['好'], defaultId: 0 };
  if (win && !win.isDestroyed()) await dialog.showMessageBox(win, 选项);
  else await dialog.showMessageBox(选项);
}

/**
 * 查一次更新。
 *
 * manual=true（设置弹窗里点的那一下）**一定**给用户一个说法：已是最新、
 * 失败了、还是有新版——点了没反应会被误读成「已是最新」。
 * manual=false（启动时的自动检查）只在真有新版时才出声，其余一律沉默。
 */
export async function checkForUpdates(host: UpdateHost, manual: boolean): Promise<UpdateOutcome> {
  挂错误监听();
  // 开发运行不查：本地跑起来的版本号和发布页上的没有可比性
  if (!app.isPackaged) {
    if (manual) await 说一句(host, '开发运行不检查更新', '只有打包后的应用才有更新可查。');
    return 'skipped';
  }
  const { autoUpdater } = electronUpdater;
  // 发现新版只通知，下载由用户点「下载」触发
  autoUpdater.autoDownload = false;
  // 下载完也不在退出时自动装：装不装必须用户点过「现在安装」
  autoUpdater.autoInstallOnAppQuit = false;

  let 结果: UpdateCheckResult | null;
  try {
    结果 = await autoUpdater.checkForUpdates();
  } catch (e) {
    const 原因 = e instanceof Error ? e.message : String(e);
    console.warn('[update] 检查更新失败：', 原因);
    if (manual) await 说一句(host, '检查更新失败', `没能连上发布服务器：${原因}`);
    return 'failed';
  }
  if (!结果?.isUpdateAvailable) {
    if (manual) await 说一句(host, '已是最新版本', '当前运行的就是最新发布版。');
    return 'upToDate';
  }

  const 新版本号 = 结果.updateInfo.version;
  const win = host.getWindow();
  const 选项 = {
    type: 'info' as const,
    message: `发现新版本 v${新版本号}`,
    detail: '要现在下载吗？下载完成后还会再问一次是否安装。',
    buttons: ['下载', '稍后'],
    defaultId: 0,
    cancelId: 1,
  };
  const 第一次 = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, 选项)
    : await dialog.showMessageBox(选项);
  // 用户说「稍后」：什么都不做，也不留半个下载
  if (第一次.response !== 0) return 'available';

  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    const 原因 = e instanceof Error ? e.message : String(e);
    console.warn('[update] 下载更新失败：', 原因);
    await 说一句(host, '下载更新失败', RELEASES_URL ? `${原因}\n\n也可以到发布页手动下载：${RELEASES_URL}` : 原因);
    return 'failed';
  }

  const 安装选项 = {
    type: 'info' as const,
    message: `新版本 v${新版本号} 已下载`,
    detail: '现在退出并安装吗？安装会重启应用。',
    buttons: ['现在安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
  };
  const 第二次 = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, 安装选项)
    : await dialog.showMessageBox(安装选项);
  // 装不装由用户决定；已经下好的包留在缓存里
  if (第二次.response !== 0) return 'downloaded';
  autoUpdater.quitAndInstall();
  return 'downloaded';
}
