// 实时文件监听（spec §1.2，M4，**默认关闭**）。
//
// 用 Node 自带的 `fs.watch({recursive:true})`，不引 chokidar——实测 Windows 上
// 递归监听可用，子目录里的新文件能收到事件。
//
// 两个必须处理的现实问题：
//   1. **追更是边写边通知的**：一个文件保存过程中会连续来好几个事件，
//      立刻扫描会读到写了一半的文件。spec 说防抖 5 秒，这里就是那个 5 秒。
//   2. **目录文件数很大时事件会很密**，所以这个功能默认关闭，且防抖是全局的
//      （不是每文件一个定时器），再密的事件也只触发一次扫描。

import { realpathSync, watch, type FSWatcher } from 'node:fs';

/** spec §1.2 定的防抖时长 */
export const DEBOUNCE_MS = 5000;

export interface WatcherOptions {
  debounceMs?: number;
  /** 只关心 txt。别的文件变动不该惊动扫描 */
  extensions?: string[];
}

export class LibraryWatcher {
  #watchers: FSWatcher[] = [];
  #timer: NodeJS.Timeout | null = null;
  #debounce: number;
  #exts: string[];
  #onChange: () => void;
  #pending = new Set<string>();

  constructor(onChange: (changed: string[]) => void, opts: WatcherOptions = {}) {
    this.#debounce = opts.debounceMs ?? DEBOUNCE_MS;
    this.#exts = opts.extensions ?? ['.txt'];
    this.#onChange = () => {
      const changed = [...this.#pending];
      this.#pending.clear();
      onChange(changed);
    };
  }

  watchRoot(path: string): void {
    try {
      /*
       * ⚠️ **先解成真实长路径再监听，否则 Windows 上会把整个进程打死。**
       *
       * libuv 的 `fs-event.c` 收到事件后拿 `_wcsnicmp` 比对「报上来的文件名」和
       * 「当初监听的目录」，对不上就 **abort**：
       *   Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72
       * 而 8.3 短名路径（`C:\Users\RUNNER~1\…`）正好对不上——系统报上来的是长名。
       *
       * **这不是异常，是原地 abort**：下面那个 `try` 和 `w.on('error')` 一个都拦不住，
       * 应用连一句错都来不及说就没了。第一次真跑 CI 时它把整个测试文件打死，
       * 后面十条根本没跑（CI 数出 831，本机 841——那十条的差额就是这么来的）。
       *
       * 用户从目录对话框选出来的路径一般是长名，但 junction、映射盘、手敲的短名
       * 都可能不是。代价是一次 `realpathSync`，换掉一个**静默的进程死亡**。
       * 路径不在了它会抛，正好落到下面那个 catch 里，和原来的行为一样。
       */
      const 真路径 = realpathSync.native(path);
      const w = watch(真路径, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const name = String(filename).toLowerCase();
        if (!this.#exts.some((e) => name.endsWith(e))) return;

        this.#pending.add(String(filename));
        // 全局防抖：一次批量整理会来几百个事件，但只该触发一次扫描
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = setTimeout(this.#onChange, this.#debounce);
      });
      // 监听不上（权限、路径不在了）不该让应用起不来
      w.on('error', () => {});
      this.#watchers.push(w);
    } catch {
      // 同上：静默跳过这个目录
    }
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const w of this.#watchers) {
      try {
        w.close();
      } catch {
        // 已经关过了
      }
    }
    this.#watchers = [];
    this.#pending.clear();
  }

  get watching(): number {
    return this.#watchers.length;
  }
}
