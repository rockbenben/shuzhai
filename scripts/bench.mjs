// 大库性能测台。**它的退出码不表达性能结论**——跑成了就是 0，格子慢到多少只印在表上。
// 非零退出只有三种地方：自己用法错了、前置没满足（没快照 / 实例还活着不许删快照）、
// 以及 `guard-check` 在验那道闸门本身。**没有一种是「性能不达标」。**
//
// 和 scripts/counts.mjs 同类：尺子，不是守卫。别顺手给它加 `< 50ms` 这种断言——
// 换台机器就红，和「纸色那 10 个 id」被钉住的理由（改错是 bug）不是一类东西。
//
//   node scripts/bench.mjs snapshot            # ① 拷库 + 写封条 + 关抓取
//   node scripts/bench.mjs seed                # ② 起实例 + 灌合成夹具
//   node scripts/bench.mjs run [--only A|B] [--passes 3] [--read-only] [--cell 片段]
//                                              # ③ 量，出表
//   node scripts/bench.mjs kill                # ④ 收实例——**这一步不是可选的**：
//                                              #    teardown 不肯在有实例活着时删快照
//   node scripts/bench.mjs teardown            # ⑤ 删快照
//
// 另有两个验用的子命令：`launch` 单独起实例、`guard-check` 验闸门。
// 为什么拆成几段而不是「一条命令跑完」：`run` 不自起实例的话，A 组跑到第 20 格时
// 那个实例的缓存状态和刚开的实例不是一个东西。把起实例塞进 run 省一次命令，
// 换掉的是整份可复现性。
import { usage, main } from './bench/cli.mjs';

const [cmd, ...argv] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(usage());
  process.exit(cmd ? 0 : 2);
}
const code = await main(cmd, argv);
process.exit(code ?? 0);
