import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchStartDecision, makeProgressGate, recoveryDelay, uiYieldDecision } from './pacing.ts';

/**
 * 这两组断言守的是**只在八千本的真实书库上才暴露**的两个问题。
 * 小库上（测试库 7 本）它们永远不会触发，所以只能在这里钉住。
 */

test('扫描 8000 个文件，进度事件不能也发 8000 条', () => {
  const gate = makeProgressGate(150);
  let sent = 0;
  // 真实量级：7414 个文件，整趟约 117 秒（第一次）——按 16ms 一个文件算
  for (let i = 0; i < 7414; i++) if (gate(i, i * 16)) sent++;
  assert.ok(sent < 900, `发了 ${sent} 条，太多了`);
  assert.ok(sent > 100, `只发了 ${sent} 条，进度条会一卡一卡的`);
  // 真实数据：限流前 7414 条把渲染进程冲垮，限流后 34 条
  assert.ok(sent < 7414 / 8, '至少要降一个量级');
});

test('第一条一定发——不然点完「扫描」那一下像没反应', () => {
  const gate = makeProgressGate(150);
  assert.equal(gate(0, 1_000_000), true);
  // 紧跟着的第二条要被挡下
  assert.equal(gate(1, 1_000_001), false);
});

test('文件很少的时候不会漏报', () => {
  const gate = makeProgressGate(150);
  // 7 本的测试库：第一条发，其余在同一毫秒里被挡——挡了也没关系，
  // 扫完 scan-done 会把进度换成报告
  const sent = [0, 1, 2, 3, 4, 5, 6].filter((i) => gate(i, 100)).length;
  assert.equal(sent, 1);
});

test('时间真的过去了就会再发', () => {
  const gate = makeProgressGate(150);
  gate(0, 0);
  assert.equal(gate(1, 100), false);
  assert.equal(gate(2, 150), true);
  assert.equal(gate(3, 200), false);
  assert.equal(gate(4, 301), true);
});

test('人在看的时候让路，走开了接着跑', () => {
  // 正在抓 + 用户回来了 → 让路
  assert.equal(uiYieldDecision(true, true, false), 'yield');
  // 没在抓 + 用户回来了 → 无事
  assert.equal(uiYieldDecision(true, false, false), 'none');
  // 用户走开 + 先前是为让路才停的 → 接着跑
  assert.equal(uiYieldDecision(false, false, true), 'resume');
});

test('用户自己关掉的开关，切个窗口不能把它打开', () => {
  // **这一条最容易写漏**：yielded=false 表示「不是为让路停的，是用户关的」
  assert.equal(uiYieldDecision(false, false, false), 'none');
  // 已经在跑了就别重复启动
  assert.equal(uiYieldDecision(false, true, true), 'none');
});

test('启动延迟到点：没人看就开跑，人在用就挂起等失焦', () => {
  // 没在跑 + 窗口失焦：开跑。后台回填本来就该在没人看的时候做
  assert.equal(launchStartDecision(false, false), 'start');
  // 没在跑 + 人正在用：不跑（抓封面书架慢二三十倍），挂到失焦恢复那条路上
  assert.equal(launchStartDecision(false, true), 'defer');
  // 已经在跑（手动开的）：什么都不做
  assert.equal(launchStartDecision(true, false), 'nothing');
  assert.equal(launchStartDecision(true, true), 'nothing');
});

test('暂停后的复检节奏：2/4/8 分钟翻倍，之后封顶 10 分钟', () => {
  assert.equal(recoveryDelay(0), 120_000);
  assert.equal(recoveryDelay(1), 240_000);
  assert.equal(recoveryDelay(2), 480_000);
  // 不能无限翻倍，否则限流持续一晚上就变成几小时才探一次
  assert.equal(recoveryDelay(3), 600_000);
  assert.equal(recoveryDelay(99), 600_000);
});
