/**
 * 什么时候该发、什么时候该跑——两个纯函数。
 *
 * 拆出来是因为**这两条规则都只在真实书库上才暴露，而真实书库跑不进测试**：
 * 一个是「8000 个文件就是 8000 条 IPC」，一个是「抓封面时界面慢二三十倍」。
 * 逻辑留在 `main.ts` / `cover-fetcher.ts` 里就只能靠人记着别改回去，
 * 而那两个文件都 import electron，测不了。
 *
 * 同 `schedule.ts`：把「什么时候」这件事从「怎么做」里剥出来，就能测。
 */

/**
 * 进度事件限流。**返回「这条要不要发」**，不自己持有定时器——
 * 有定时器就得管清理，而扫描结束时谁来清是另一个坑。
 *
 * 真实量级实测：一次增量扫描 8172 个文件发 7414 条 `scan-progress`，
 * 渲染进程一条不落全收到，然后被冲垮——状态栏卡在第一条不动 117 秒。
 * **进度条本来是为了避免「看起来像卡死」，结果它自己造成了卡死。**
 */
export function makeProgressGate(minGapMs = 150): (done: number, now: number) => boolean {
  let last = -Infinity;
  return (done, now) => {
    // **第一条一定发**：否则点完「扫描」要等 minGapMs 状态栏才出现，那一下会觉得没反应
    if (done === 0) { last = now; return true; }
    if (now - last < minGapMs) return false;
    last = now;
    return true;
  };
}

/** 界面活跃度变了，后台任务该怎么办 */
export type YieldAction =
  /** 停下来让路，并记住「是为让路才停的」 */
  | 'yield'
  /** 接着跑（只有先前是为让路才停的才会走到这里） */
  | 'resume'
  /** 什么都不做 */
  | 'none';

/**
 * 「人在看的时候让路」的判据。
 *
 * 三条规矩，缺一条就会咬人：
 * 1. 用户在看 + 正在跑 → 让路（真实库上实测：抓封面时书架 40.8 秒，停掉 1.9 秒）；
 * 2. 用户走开 + **先前是为让路才停的** → 接着跑；
 * 3. 用户走开 + **是用户自己关掉的** → 不动。
 *    第 3 条最容易写漏：漏了的话，用户关掉开关、切个窗口，它又自己开起来了。
 */
export function uiYieldDecision(
  uiActive: boolean,
  running: boolean,
  yielded: boolean,
): YieldAction {
  if (uiActive) return running ? 'yield' : 'none';
  return !running && yielded ? 'resume' : 'none';
}

/**
 * 启动时批量开关开着，半分钟的启动 cushion 到点：现在该不该真的开跑。
 *
 * - 已经在跑（用户手动开的）：什么都不做。
 * - 窗口没人看（失焦）：开跑——后台回填本来就该在没人看的时候做。
 * - 人正在用：**不跑，也别把这次启动白扔**——挂到失焦恢复那条路上
 *   （调用方把 `yielded` 置 true）：人切走 8 秒就开，人一直看着就一直不开。
 *   判据同「抓取进行中、窗口获焦就让路」：抓封面时书架慢二三十倍。
 */
export type LaunchAction = 'start' | 'defer' | 'nothing';
export function launchStartDecision(running: boolean, uiActive: boolean): LaunchAction {
  if (running) return 'nothing';
  return uiActive ? 'defer' : 'start';
}

/**
 * 自动暂停后多久再探一次：2 分钟起步，翻倍，封顶 10 分钟。
 *
 * 暂停前的 hold 阶段已经每 60 秒快速探过 5 次（都失败才停），所以暂停后
 * 放慢；而探针本身也是一次搜索请求，探太勤等于自己一直撞限流。
 *
 * ⚠️ **暂停后必须有人复检。** 原来暂停后同一会话里再也不探，限流 5 小时前
 * 就解除了、界面上还挂着「已自动暂停」——那句原因是**粘住的状态**，
 * 描述「上次为什么停」，用户却读成「现在还在限流」。
 */
const RECOVER_DELAYS_MS = [120_000, 240_000, 480_000] as const;
const RECOVER_MAX_DELAY_MS = 600_000;

export function recoveryDelay(attempt: number): number {
  return attempt < RECOVER_DELAYS_MS.length
    ? RECOVER_DELAYS_MS[attempt]
    : RECOVER_MAX_DELAY_MS;
}
