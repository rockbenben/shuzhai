// 仓库根目录，给 `scripts/` 下的走查脚本共用。
//
// **为什么单独一个文件放一个常量**：这一行原来在 `dead-fields.mjs` /
// `dead-mounts.mjs` / `stale-refs.mjs` 里各抄了一份，而三份都带着同一个 bug——
// 用的是 `new URL(...).pathname`，那玩意儿是**百分号编码**的：
//
//     D:\项目\036  ->  /D:/%E9%A1%B9%E7%9B%AE/036
//
// 于是仓库一旦克隆到带空格或中文的路径下，三个脚本一起 ENOENT，
// 报的还是一个用户明明看得见的路径。`fileURLToPath` 是标准库里管这件事的那个，
// 顺带也处理了 Windows 上开头那个多余的斜杠。
//
// 抄三份的代价就是这个：修一次要修三处，而且很容易只修到两处
// （AGENTS.md 开头那条「同一份约定抄成几份必然分叉」说的就是它）。

import { fileURLToPath } from 'node:url';

/** 仓库根的绝对路径，不带结尾分隔符 */
export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
