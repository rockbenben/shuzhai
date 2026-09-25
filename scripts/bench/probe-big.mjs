// guard-check 的探针：只走一次 `connect()`，让 `cdp.mjs` 里那道闸门自己说话。
// 放行 → 退出 0；被拒 → 它自己 process.exit(1)。
import { connect } from '../ui-check/cdp.mjs';

const { close } = await connect();
console.log('放行');
close();
