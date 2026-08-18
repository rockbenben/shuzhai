// 预加载脚本。**刻意是 .cjs 而不是 .ts**：沙箱化的 preload 由 Chromium 加载，
// 走不到 Node 的类型剥离和 ESM 那条路，只能是 CommonJS。这里也就十行，不值得为它
// 单开一条构建流水线。
//
// 只暴露一个 `rpc` 函数，不暴露 ipcRenderer 本身——否则渲染进程可以往任意 channel
// 发消息，白名单就形同虚设。方法表在主进程的 src/main/rpc.ts，这边不复述。

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('novel', {
  rpc: (method, params) => ipcRenderer.invoke('rpc', method, params),

  /**
   * 拖进来的文件在磁盘上的路径。
   * **Electron 32 起 File.path 被拿掉了**，只能走 webUtils.getPathForFile——
   * 直接读 file.path 会拿到 undefined，而且不报错，表现是「拖了没反应」。
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  /** 改完扫描排程要叫一声，否则新设置得等到下次触发才生效 */
  reschedule: () => ipcRenderer.invoke('reschedule'),

  /**
   * 扫描进度（`scan-progress`），扫描**过程中**一路发过来的，不是扫完那一下——
   * 扫完是下面的 `onScanDone`。这条必须限流，8000 个文件就是 8000 条 IPC，
   * 判据在 `src/core/pacing.ts`。
   *
   * 下面这三个转发器**一个频道一个**，写死在这儿，不把 `ipcRenderer` 交出去——
   * 交出去等于渲染进程能往任意频道发消息，白名单就白设了。
   */
  onScanProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('scan-progress', handler);
    return () => ipcRenderer.off('scan-progress', handler);
  },

  /** 扫描跑完，带回一份报告（`scan-done`）。它一到就把进度条换成报告 */
  onScanDone: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('scan-done', handler);
    return () => ipcRenderer.off('scan-done', handler);
  },

  /** 建全文索引的进度。一本 12046 章的书要 68 秒，不报进度就只能干等 */
  onIndexProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('index-progress', handler);
    return () => ipcRenderer.off('index-progress', handler);
  },
});
