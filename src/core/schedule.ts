// 定期扫描的排程（spec §1.2）。
//
// 只负责**算下一次什么时候跑**，不负责跑——这样它是纯函数，能直接测，
// 而不用真的等一个小时。主进程拿到毫秒数去 setTimeout。

export type ScanMode = 'off' | 'startup' | 'interval' | 'daily';

export interface ScheduleConfig {
  mode: ScanMode;
  /** interval 模式：每几小时 */
  intervalHours: number;
  /** daily 模式：每天几点，"HH:MM" */
  dailyTime: string;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  mode: 'off',
  intervalHours: 6,
  dailyTime: '03:00',
};

/**
 * 距离下一次扫描还有多少毫秒。返回 null 表示不再排程。
 *
 * `now` 是参数而不是内部取 `Date.now()`：定时逻辑不传时间就没法测，
 * 而「每天三点」这种规则的边界（刚过三点、正好三点）恰恰是最容易写错的地方。
 */
export function nextRunDelay(cfg: ScheduleConfig, now: Date): number | null {
  switch (cfg.mode) {
    case 'off':
      return null;

    // 启动时扫一次就完了，不再排下一次
    case 'startup':
      return null;

    case 'interval': {
      const hours = Math.max(1, Math.floor(cfg.intervalHours));
      return hours * 3600_000;
    }

    case 'daily': {
      const m = /^(\d{1,2}):(\d{2})$/.exec(cfg.dailyTime);
      if (!m) return null;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (hh > 23 || mm > 59) return null;

      const target = new Date(now);
      target.setHours(hh, mm, 0, 0);
      // 今天这个点已经过了（或正好是现在）就排到明天，
      // 否则「正好三点启动」会得到 0，然后立刻又排一次 0，转成死循环
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
      return target.getTime() - now.getTime();
    }
  }
}

/** 启动时要不要先扫一次 */
export function shouldScanOnStartup(cfg: ScheduleConfig): boolean {
  return cfg.mode === 'startup';
}
