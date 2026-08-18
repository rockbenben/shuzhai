// scripts/verify-cover-fetch.mjs
// 对真实站点验证封面抓取。应用要开着（npm start 或直接起 electron.exe .）。
//
// 分两段，缺一不可：
//   1. **逐个源校验**（照 legado 的「校验书源」）：每个源各搜一本已知它一定有的书。
//      整条链是 起点 → 书旗 → 豆瓣 的 fallback，所以只看整条链的话，
//      **起点坏了会被书旗接住，一路绿灯，而命中率已经悄悄掉了一截**。
//   2. 整条链跑通：拿库里没封面的书真抓一次，确认封面落盘。
// 端口和 `scripts/ui-check/cdp.mjs` 一个写法：**你自己开着应用时它占着 30036**，
// 这个脚本就连不上自己那个实例了（见 scripts/ui-check/README.md 开头那段）
const B = 'http://127.0.0.1:' + (process.env.SHUZHAI_API_PORT || '30036');
const post = (p, b) =>
  fetch(B + p, {
    method: 'POST',
    headers: { 'X-Api': '1', 'content-type': 'application/json' },
    body: JSON.stringify(b),
    signal: AbortSignal.timeout(120_000),
  }).then((r) => r.json());
const q = async (sql) => (await post('/api/query', { sql })).rows;
const rpc = async (method, params) => {
  const j = await post('/api/rpc', { method, params });
  if (j.error) throw new Error(j.error);
  return j.result;
};

console.log('── 1. 逐个源校验 ──');
const checks = await rpc('cover.checkSources', {});
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.label.padEnd(3)} 候选 ${String(c.found).padStart(2)} 条${c.note ? `　${c.note}` : ''}`);
}
const down = checks.filter((c) => !c.ok);
if (down.length) {
  console.log(`\n  ${down.map((c) => c.label).join('、')} 有问题。`);
  console.log('  「提取不到候选」→ 先隔一小时再跑一次排除限流，还是 0 就是选择器该修了');
  console.log('  （解析函数在 src/core/cover-source.ts，各自有 fixture 测试可以对照）');
}

console.log('\n── 2. 整条链 ──');
// 已知在起点、且库里没封面的书（2026-08-13 实测精确命中过）
//
// ⚠️ **这几本在库里必须带作者，否则量到的 `nomatch` 是假的。**
// 匹配判据是 `matchWithAliases`：书名和作者都要一致，**本地没作者一律不匹配**。
// 在走查库上手工添一本《武炼巅峰》不填作者再跑，报的是
// 「10 条候选 → nomatch」——看起来像起点的解析器坏了，其实是这本书没作者。
// 补上「莫默」再跑就 `ok via qidian`。
const KNOWN = ['武炼巅峰', '踏星', '重生：我老婆是天后'];
const books = await q(`
  select id, title, author from book
   where cover_path is null and title in (${KNOWN.map((t) => `'${t}'`).join(',')})`);
/*
 * ⚠️ **别用 `process.exit()` 收尾**（这里原来是 `process.exit`，改掉了）。
 *
 * 症状：三个源明明都验过了，进程却在最后一刻抛
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 * **退出码 127**。而这个脚本的结论只能靠退出码读——「全过」和「崩了」于是长得一样，
 * 同这个仓库里那几条「工具静默地骗人」。
 *
 * 量出来的（HEAD 那版 vs 改完，同一个跑着的应用）：
 *   `process.exit`   → 3 次里 2 次 127     ← **是间歇的**，所以更像站点抽风而不是工具坏了
 *   `process.exitCode` → 5 次里 0 次非 0
 *
 * ⚠️ **别去追「是哪个 handle」——那条路我走过了，猜错的那个已经排除掉。**
 * 本来赖的是这行独有的 `AbortSignal.timeout(120_000)`（留了个 120 秒的定时器，
 * 五个走查脚本都没有它，而它们的退出码实测都是准的）。对照实验：同样
 * fetch 一次本地接口再 `process.exit`，**带 signal / 不带 signal / 改 exitCode
 * 三组各 20 次，非 0 都是 0 次**——复现不出来，这个解释是错的。
 * 真正的差别多半在「那次 rpc 跑了十几秒、应用那头正在出网」，没再往下挖：
 * `process.exitCode` 让 Node 自己收手柄，已经解决问题，而这是个开发脚本。
 */
if (books.length === 0) {
  console.log('  这几本都已有封面或不在库里——挑别的没封面的书改 KNOWN 再跑');
  process.exitCode = down.length ? 1 : 0;
} else {
  let ok = 0;
  for (const b of books) {
    try {
      const r = await rpc('cover.fetchOne', { bookId: b.id });
      const cp = (await q(`select cover_path from book where id = ${b.id}`))[0].cover_path;
      const good = r.status === 'ok' && !!cp;
      if (good) ok++;
      console.log(`  ${good ? '✓' : '✗'} 《${b.title}》 ${r.status} via ${r.source ?? '-'} → ${cp ?? '（没写 cover_path）'}`);
      if (r.applied?.length) console.log(`      顺带补上: ${r.applied.join('、')}`);
    } catch (e) {
      console.log(`  ✗ 《${b.title}》 抛错: ${e.message}`);
      console.log('      「加载超时」→ 网络/站点问题；上面第 1 段能告诉你是哪个源');
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`\n${books.length} 本试了，${ok} 本拿到真封面`);
  process.exitCode = ok > 0 && down.length === 0 ? 0 : 1;
}
