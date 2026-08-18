/**
 * 等某个端口真的能**绑**上。
 *
 *   node scripts/ui-check/port-free.mjs 9876
 *
 * **判据是 bind 得上，不是「连不上」。** 这条踩了两层，一层比一层深：
 *
 * 1. **「HTTP 不应答」不等于端口空了。** 重启走查用的实例时，我一直拿
 *    `curl` 失败当作端口空了，然后马上起新进程——日志里一片
 *    `bind() returned an error` / `Lock file can not be created`，新进程
 *    拿不到端口和单实例锁直接退出，而我在外面等一个永远不会就绪的接口。
 *    正在退出的进程**还占着 socket**，只是不答 HTTP 了。
 *
 * 2. **而「connect 被拒绝」也不够。** 改成探 ECONNREFUSED 之后又栽了一次：
 *    它说「空了」，紧接着 electron 的 `bind()` 照样失败。一个刚被关掉的
 *    监听 socket 会拒绝连接、却仍然占着地址（TIME_WAIT 那一族）——
 *    **拒绝连接和能不能绑是两件事**，而我要的一直是后者。
 *
 * 所以现在直接 `server.listen()` 试一下：能绑上就是真空了，立刻关掉让位。
 * 这是**问了真正那个问题**，不是找一个和它相关的代理指标。
 *
 * ⚠️ 端口空了**仍然不等于起得来**：单实例锁是**档案目录里的一个文件**，
 * 由进程持有（`Lock file can not be created! Error code: 32` 就是它）。
 * 稳妥的重启还要等 electron 进程一个都不剩，见 README 那节。
 */
import { createServer } from 'node:net';

const port = Number(process.argv[2]);
const bindable = () => new Promise((r) => {
  const s = createServer();
  s.once('error', () => r(false));
  s.once('listening', () => s.close(() => r(true)));
  s.listen(port, '127.0.0.1');
});

for (let i = 0; i < 60; i++) {
  if (await bindable()) { console.log('空了'); process.exit(0); }
  await new Promise((r) => setTimeout(r, 500));
}
console.log('等了 30 秒还绑不上');
process.exit(1);
