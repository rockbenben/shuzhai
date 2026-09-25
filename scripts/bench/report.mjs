// 报告：怎么把三遍样本收成一行、怎么标判据线。
//
// 判据线（spec §4，人批准的）：≥300ms 进候选，≥1s 不可接受，100–300ms 只记录不开活。
// 这条线不是凭空定的：目录是量到 543ms 才开的窗口，全库笔记是 0.7 秒改成一次铺 300 行。
export const CANDIDATE_MS = 300;
export const MUST_FIX_MS = 1000;

/** 空样本退回 null，**不是 0**：那一格是「没测到」，和「测到 0 毫秒」是两件事 */
export function median(samples) {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function verdictOf(ms) {
  if (ms === null || ms === undefined) return '未测';
  if (ms >= MUST_FIX_MS) return 'must-fix';
  if (ms >= CANDIDATE_MS) return 'candidate';
  return 'ok';
}

export function formatRow({ name, ms, cold, old, why, plane }) {
  const 数 = ms === null || ms === undefined
    ? `– 没查${why ? `（${why}）` : ''}`
    : `${ms} ms`;
  const 冷 = cold === null || cold === undefined ? '' : ` 冷 ${cold} ms`;
  const 判 = verdictOf(ms);
  const 标 = 判 === 'ok' ? ' ' : 判 === 'candidate' ? '⚠' : 判 === 'must-fix' ? '✗' : '?';
  return `${标} ${(plane || '').padEnd(6)} ${String(name).padEnd(34)} ${数.padEnd(40)}${冷}   旧表 ${old ?? '无基线'}`;
}

export function renderReport(rows, { 地板 } = {}) {
  return [
    `量级：${rows.length} 格。判据线 ≥${CANDIDATE_MS}ms 进候选、≥${MUST_FIX_MS}ms 必修。`,
    地板 ? `量具地板 ${地板} ms（一次 HTTP 往返本身）：低于 ${地板 + 10} ms 的 rpc 格与地板同量级，别算倍数。` : '',
    '',
    ...rows,
    '',
    '⚠ 这张表不断言任何东西——测台和 scripts/counts.mjs 同类：尺子，不是守卫。',
    '⚠ B 组那几格的数来自**合成夹具**（`seed` 灌进去的划线和评分），比真实使用严得多：',
    '  真实用户不会给八千本每本都写一句短评。**那一栏是上限，不是「你会感到的数」。**',
  ].join('\n');
}
