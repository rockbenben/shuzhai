import { makeSnapshot, dropSnapshot, liveDbPath } from './snapshot.mjs';

export const usage = () => [
  'node scripts/bench.mjs snapshot [--force]   拷真实库的三个文件 + 写封条',
  'node scripts/bench.mjs launch | kill        起 / 收那个跑在快照上的实例',
  'node scripts/bench.mjs seed                 灌合成夹具（评分短评 + 划线）',
  'node scripts/bench.mjs run [--only A|B] [--cell 片段] [--read-only] [--passes 3]',
  '                                            量，出表。--read-only 跳过标了「改动」的格子，',
  '                                            是改完东西想快速看一眼的两分钟路径；',
  '                                            --passes N 整表跑 N 趟并印每格极差——',
  '                                            要判断「有没有漂」必须用它：单趟的数',
  '                                            不支持任何比较结论。极差具体多少**不在这里记**',
  '                                            （那本身就是个会漂的数），正本在',
  '                                            docs/lessons.md「散布到底多大」那一节。',
  '                                            --cell 点名单一格（组名走 --only，精确匹配）',
  'node scripts/bench.mjs guard-check          验 --big 那道闸门真的会拒绝（不碰真实库）',
  'node scripts/bench.mjs teardown             删快照（实例还活着会拒绝，先 kill）',
].join('\n');

export async function main(cmd, argv) {
  switch (cmd) {
    case 'snapshot': {
      const r = makeSnapshot({ force: argv.includes('--force') });
      console.log(`✓ 快照：${r.dst}`);
      console.log(`  拷了 ${r.files.join(' + ')}（源：${liveDbPath()}）`);
      console.log(`  封条 ${r.fingerprint}`);
      return 0;
    }
    case 'teardown': {
      const { liveBenchPids } = await import('./app.mjs');
      const 活 = liveBenchPids();
      if (活.length) {
        console.error(`✗ 测台实例还活着（${活.join(' ')}）。`
          + '先 node scripts/bench.mjs kill——留着实例删快照，那个进程就对着一个没了的库跑。');
        return 1;
      }
      dropSnapshot();
      console.log('✓ 快照已删');
      return 0;
    }
    case 'launch': {
      const { launch } = await import('./app.mjs');
      return launch();
    }
    case 'kill': {
      const { killAll } = await import('./app.mjs');
      const n = await killAll();
      if (!n) console.log('没有要收的实例');
      return 0;
    }
    case 'guard-check': {
      const { guardCheck } = await import('./guard-check.mjs');
      return guardCheck();
    }
    case 'seed': {
      const { existsSync } = await import('node:fs');
      const { launch } = await import('./app.mjs');
      const { rpc } = await import('./run.mjs');
      const { seedRatings, seedHighlights } = await import('./seed.mjs');
      const { snapshotDbPath } = await import('./snapshot.mjs');
      if (!existsSync(snapshotDbPath())) {
        console.error('✗ 先跑 node scripts/bench.mjs snapshot');
        return 1;
      }
      console.log(`✓ 评分短评灌了 ${seedRatings()} 条`);
      if ((await launch()) !== 0) return 1;
      // 全走 HTTP 的 rpc，不连页面：正文也是 `chapter.read` 取（理由见 seed.mjs 那段
      // ——CDP 表达式里那句顶层 await 静默返回 'ERR …'，于是 0 条一句错都不报）
      console.log(`✓ 划线灌了 ${await seedHighlights({ rpc })} 条（实例留着，接着跑 run）`);
      return 0;
    }
    case 'run': {
      const { runCells } = await import('./run.mjs');
      const i = argv.indexOf('--only');
      const j = argv.indexOf('--cell');
      const k = argv.indexOf('--passes');
      // 界面级格子要连页面，而那是八千本的库——`connect()` 的闸门会拦。
      // 这里设 `SHUZHAI_BIG=1` 只是**申请**：放行仍由它去验快照里那行封条决定，
      // 所以这不是绕过守卫，是拿着钥匙过守卫（封条没了它照样当场退出）。
      process.env.SHUZHAI_BIG = '1';
      return runCells({
        only: i >= 0 ? argv[i + 1] : null,
        cell: j >= 0 ? argv[j + 1] : null,
        passes: k >= 0 ? Math.max(1, Number(argv[k + 1]) || 1) : 1,
        readOnly: argv.includes('--read-only'),
      });
    }
    default:
      console.error('✗ 不认识的命令：' + cmd);
      console.error(usage());
      return 2;
  }
}
