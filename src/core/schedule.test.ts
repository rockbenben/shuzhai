import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRunDelay, shouldScanOnStartup, DEFAULT_SCHEDULE, type ScheduleConfig } from './schedule.ts';

const cfg = (o: Partial<ScheduleConfig>): ScheduleConfig => ({ ...DEFAULT_SCHEDULE, ...o });

test('关闭时不排程', () => {
  assert.equal(nextRunDelay(cfg({ mode: 'off' }), new Date()), null);
});

test('「启动时扫」只在启动那一次跑，不排下一次', () => {
  const c = cfg({ mode: 'startup' });
  assert.equal(shouldScanOnStartup(c), true);
  assert.equal(nextRunDelay(c, new Date()), null);
});

test('按小时间隔', () => {
  assert.equal(nextRunDelay(cfg({ mode: 'interval', intervalHours: 6 }), new Date()), 6 * 3600_000);
  assert.equal(
    nextRunDelay(cfg({ mode: 'interval', intervalHours: 0 }), new Date()),
    3600_000,
    '0 小时会变成死循环，下限压到 1 小时',
  );
});

test('每天定点：今天还没到就排今天', () => {
  const now = new Date('2026-08-12T01:00:00');
  const delay = nextRunDelay(cfg({ mode: 'daily', dailyTime: '03:00' }), now)!;
  assert.equal(delay, 2 * 3600_000);
});

test('每天定点：今天已经过了就排明天', () => {
  const now = new Date('2026-08-12T05:00:00');
  const delay = nextRunDelay(cfg({ mode: 'daily', dailyTime: '03:00' }), now)!;
  assert.equal(delay, 22 * 3600_000);
});

test('正好卡在那一刻要排明天，否则会变成 0 延迟的死循环', () => {
  const now = new Date('2026-08-12T03:00:00');
  const delay = nextRunDelay(cfg({ mode: 'daily', dailyTime: '03:00' }), now)!;
  assert.equal(delay, 24 * 3600_000);
  assert.ok(delay > 0, '任何情况下都不能返回 0');
});

test('时间格式不对就不排程，而不是崩掉', () => {
  for (const bad of ['25:00', '03:99', '三点', '', '3:0']) {
    assert.equal(nextRunDelay(cfg({ mode: 'daily', dailyTime: bad }), new Date()), null, bad);
  }
});

test('跨月边界也算得对', () => {
  const now = new Date('2026-08-31T23:30:00');
  const delay = nextRunDelay(cfg({ mode: 'daily', dailyTime: '01:00' }), now)!;
  assert.equal(delay, 90 * 60_000, '应排到 9 月 1 日 01:00');
});
