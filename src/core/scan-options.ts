// 扫描收录下限；设置界面与扫描器共用，不含文件 I/O。
/**
 * **收录下限：小于这么多字节的文件不收。**
 *
 * 默认 10 KB，为的是滤掉小说目录里那些零碎（「说明.txt」「广告.txt」「目录.txt」）。
 * 但它**不是对所有书库都成立**：真实案例是一个装短文合集的目录，
 * 55 个 txt 里 27 个在 3–8 KB 之间，一扫全被挡在外面——而那 27 篇正是用户要的书。
 * 症状还特别不像回事：pdf 一个不少地进来了，txt 少了一半。
 *
 * 所以它现在是个设置。**键和默认值定义在这一处**：rpc 读它、设置界面显示它，
 * 两边不许各写一份（本仓库那条「同一份约定抄成几份必然分叉」）。
 */
export const MIN_BYTES_KEY = 'scan.minBytes';
export const MIN_BYTES_DEFAULT = 10 * 1024;

/**
 * 把存进 `app_setting` 的那个字符串解释成字节数。
 *
 * ⚠️ **坏值一律退回默认，不能当成 0。** `Number('')` 是 0、`Number(null)` 也是 0——
 * 照单全收的话，一个空设置就等于「下限取消」，用户会莫名其妙多出几千个说明文档。
 * `0` 只有用户**明确填 0** 时才成立（那时 raw 是 `'0'`）。
 */
export function parseMinBytes(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || String(raw).trim() === '') return MIN_BYTES_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : MIN_BYTES_DEFAULT;
}
