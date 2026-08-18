// 渲染进程调主进程的唯一通道。preload 只暴露了 novel.rpc，方法表在 src/main/rpc.ts。

export interface ScanProgress {
  file: string;
  done: number;
  root: string;
}

export interface ScanDone {
  reason: string;
  report: { added: number; updated: number; moved: number; missing: number; failed: number };
}

declare global {
  interface Window {
    novel: {
      rpc: (method: string, params?: unknown) => Promise<unknown>;
      /** 拖进来的文件在磁盘上的路径。Electron 32+ 拿不到 File.path 了 */
      pathForFile: (file: File) => string | null;
      reschedule: () => Promise<unknown>;
      /** 返回取消订阅的函数 */
      onScanDone: (cb: (d: ScanDone) => void) => () => void;
      onScanProgress: (cb: (p: ScanProgress) => void) => () => void;
      /** 建全文索引的进度。一本 12046 章的书要 68 秒，不报进度只能干等 */
      onIndexProgress: (cb: (p: { done: number; total: number }) => void) => () => void;
    };
  }
}

/**
 * **把 Electron 的包装词剥掉。**
 *
 * `ipcRenderer.invoke` 失败时给的是
 * `Error invoking remote method 'rpc': Error: 书 4 没有第 0 章`——
 * 前面那截是 IPC 的实现细节，而它会**原样出现在每一个弹窗的红色报错行里**
 * （实测「正文净化」贴出来的就是这一整句英文）。剥在这里而不是各个调用点：
 * 所有 rpc 都走这一条路，修一次就够。
 */
// **只剥 Electron 那一层包装，不剥 `Error: `。** 第二条正则原来也在，
// 但它会连主进程自己写的、以「…Error: 」开头的消息一起吃掉——而那些是给人看的。
const humanize = (m: string) => m.replace(/^Error invoking remote method '[^']*':\s*Error:\s*/, '');

export const rpc = async <T,>(method: string, params?: unknown): Promise<T> => {
  try {
    return (await window.novel.rpc(method, params)) as T;
  } catch (e) {
    throw new Error(humanize((e as Error).message));
  }
};
