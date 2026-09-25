//*跑格 + 出表。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotDir } from './snapshot.mjs';
import { API_PORT } from './app.mjs';
import { median, formatRow, renderReport } from './report.mjs';
import { CELLS, BIG } from './cells.mjs';

const SAMPLES = 3;

/**
 * 走 HTTP 发 rpc 并计时。`cdp.mjs` 里那个同名函数走的是页面 IPC；
 * 测台已经验过封条（`guard-check`），这里要的是「不依赖页面在场」的纯后端数。
 * 它**不吞 error**：rpc 报错就是这一格 `– 失败`，不是 0 ms。
 */
export async function rpc(method, params) {
  const t = Date.now();
  const res = await fetch(`http://127.0.0.1:${API_PORT}/api/rpc`, {
    method: 'POST',
    headers: { 'X-Api': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error}`);
  return { ms: Date.now() - t, r: j.result };
}

/**
 * 按文件名认那几本大样本。**书名会在别的书上重号，所以按路径认**；
 * `book.list` 的行里带着 `fl.path`。
 */
export async function resolveBig() {
  const { r } = await rpc('book.list', { filter: {}, limit: 100000 });
  const 书 = Array.isArray(r) ? r : (r.rows ?? []);
  const 表 = {};
  for (const [名字, 片段] of Object.entries(BIG)) {
    const hit = 书.find((b) => (b.path || '').includes(片段));
    if (hit) 表[名字] = hit.id;
  }
  return 表;
}

/** 一格的样本：cold 是第 1 遍（冷缓存，单列），median 取其余 */
function 收成一行(times) {
  if (!times.length) return { cold: null, medianMs: null };
  const cold = times[0];
  const rest = times.slice(1);
  return { cold, medianMs: rest.length ? median(rest) : cold };
}

/** 量具自己的地板：一次 HTTP 往返 + 主进程排队，拿近乎空操作的 rpc 连打几次 */
async function 量地板() {
  const 样本 = [];
  for (let i = 0; i < 7; i++) 样本.push((await rpc('search.indexed', {})).ms);
  return { 地板: median(样本), 全部: 样本.sort((a, b) => a - b) };
}

/**
 * **一趟**：按判据线要的分组顺序跑完所有格子，返回结构化记录。
 * 渲染留到最后统一做——多趟对比要的是同一批记录，不是已经印成字符串的行。
 */
async function 一趟({ 要跑, ev, 等到, dir, big }) {
  const 记录 = [];
  for (const cell of 要跑) {
    const 收 = (extra) => {
      const r = { ...cell, ...extra };
      记录.push(r);
      console.log(formatRow(r));
      return r;
    };
    if (cell.need === 'big' && !big.极品全能高手) { 收({ ms: null, cold: null, why: '快照里没找到那几本大样本' }); continue; }
    if (cell.needsIndex && !(await rpc('search.indexed', {})).r) {
      收({ ms: null, cold: null, why: '还没有任何书建过正文索引' });
      continue;
    }

    const times = [];
    let err;
    for (let i = 0; i < (cell.repeat ?? SAMPLES); i++) {
      try {
        if (cell.plane === 'ui') {
          /*
           * 两种起表口径，**别混**：
           * - `sinceReload`：从 `location.reload()` 起表，到那一屏的元素出现为止。
           *   「首屏铺 120 张卡」必须是这一种——旧表那句写的就是「整页重载→元素出现」。
           *   先等「书架出来了」再起表的话，等的那一步本身就是铺卡片这件事，
           *   量到的只剩一个空尾巴（实测到的假数：20 ms，旧表 324 ms）。
           * - 其余格子：书架就绪是 **setup** 不是被测对象，先等它，再计时。
           */
          const t0 = Date.now();
          await ev('location.reload()');
          if (cell.sinceReload) {
            await 等到(cell.wait, cell.name, cell.budgetMs ?? 30000);
            times.push(Date.now() - t0);
            break;
          }
          /*
           * 前置条件认的是**「书架这一屏出来了」，不是「有封面卡片」**：
           * 视图每一档各记一份，上一格切成表格的话，这里就是 120 个 tr、0 张 .book
           * （实测 B 组四格全卡在这句上）。
           */
          await 等到("(document.querySelectorAll('.book, .booktable tbody tr, .rv').length > 0)"
            + " || !!document.querySelector('.reader-text')", '书架首屏');
          /*
           * `setup` **不起表**，被测的那一下才起表。没这个区分的话，
           * 「目录铺 400 条」会把「打开一本 52 MB 的书」（那是另一格，~170 ms）
           * 也算进目录的耗时，报出一个谁也对不上的和。
           */
          const t = Date.now();
          if (cell.setup) await cell.setup({ ev, 等到, big });
          if (cell.open) await cell.open({ ev, 等到, big });
          await 等到(cell.wait, cell.name, cell.budgetMs ?? 30000);
          times.push(Date.now() - t);
          if (cell.close) await cell.close({ ev });
        } else {
          const { ms, r: 果 } = await cell.call(rpc, big, dir);
          /*
           * 格子可以自己声明「这一次调用**必须**拿到非空结果」。
           * 这条不是可有可无的断言：上一版 `search.inBook` 用的词在这本书里
           * 命中 0 条，于是那一格量的根本不是它名字声称的那件事，
           * 而我拿它得出了一个看起来合理的结论。**查不出空结果的表会自己骗人。**
           */
          if (cell.要真命中 && !(Array.isArray(果) ? 果.length : 果)) {
            throw new Error('这一格没命中任何东西，量到的不是它声称的那件事（换一个正文里真有的词）');
          }
          times.push(ms);
        }
      } catch (e) {
        err = e.message;
        break;
      }
    }
    const { cold, medianMs } = 收成一行(times);
    收({ ms: err ? null : medianMs, cold: err ? null : cold, why: err ? `失败：${err}` : undefined });
  }
  return 记录;
}

/**
 * 多趟之间**每趟的中位数**再取一次分布。
 * 为什么非要这一列：**一道的表不能用来比较**——同一批格子重复测的极差，
 * 比大多数格子那点子「变化量」还大。**具体多少不在代码里记**（那本身就是个
 * 会漂的数，而且这份注释自己抄第二份就被抓到过），正本在
 * `docs/lessons.md`「散布到底多大」那一节。
 * 另一条同样重要：一趟之内取三个样本的中位数**挡不住**这些——
 * 那三个样本是同温的，量到的是散布的**下界**。
 */
function 区间(每趟) {
  if (每趟.length < 2) return null;
  const 小 = Math.min(...每趟), 大 = Math.max(...每趟);
  return { 小, 大, 中: median(每趟), 成: Math.round((100 * (大 - 小)) / (median(每趟) || 1)) };
}

export async function runCells({ only, cell, readOnly = false, passes = 1 } = {}) {
  /*
   * `--only A|B` 只认组名，**精确匹配**。别拿它做子串匹配：实测 `--only B`
   * 会把「打开 52**MB** 那本」也捞进来——那种误捞不报错，只是表里多出几格、
   * 而你以为跑的是 B 组。要点名单一格，用 `--cell 名字片段`。
   */
  const 认 = (c) => (only ? c.g === only : true) && (cell ? c.name.includes(cell) : true);
  /*
   * **只读的格子先跑，标了「改动」的垫底**——不是按数组顺序。
   * 「批量改状态」是把筛选结果整个改成在读：它要是排在 B 组前面，
   * B 那些格子量的就是另一副库，而表上每个数都看着正常。
   */
  const 要跑 = CELLS.filter((c) => 认(c) && !(readOnly && c.改动))
    .sort((a, b) => !!a.改动 - !!b.改动);

  const 要界面 = 要跑.some((c) => c.plane === 'ui');
  const { connect, make等待 } = 要界面 ? await import('../ui-check/cdp.mjs') : {};
  const cdp = 要界面 ? await connect() : null;
  const ev = cdp?.ev;
  const 等到 = cdp ? make等待(cdp.ev, cdp.wait) : null;

  const dir = join(snapshotDir(), 'out');
  mkdirSync(dir, { recursive: true });
  const big = await resolveBig();
  const { 地板, 全部 } = await 量地板();
  console.log(`量具地板：中位 ${地板} ms（${全部.join('/')}）`
    + `——低于 ${地板 + 10} ms 的 rpc 格只能算「与地板同量级」，别看倍数。\n`);

  const 每趟 = new Map();
  let 记录 = [];
  for (let p = 0; p < passes; p++) {
    if (passes > 1) console.log(`— 第 ${p + 1}/${passes} 趟 —`);
    记录 = await 一趟({ 要跑, ev, 等到, dir, big });
    for (const r of 记录) {
      if (r.ms == null) continue;
      if (!每趟.has(r.name)) 每趟.set(r.name, []);
      每趟.get(r.name).push(r.ms);
    }
  }

  if (passes > 1) {
    console.log('\n' + '═'.repeat(72));
    console.log(`多趟分布（每趟一个中位数，共 ${passes} 趟）——**这一列才是能不能比较的判据**：`);
    for (const r of 记录) {
      const 区 = 区间(每趟.get(r.name) ?? []);
      if (!区) continue;
      console.log(`${区.成 >= 30 ? '↔' : ' '} ${String(r.name).padEnd(34)} `
        + `${(每趟.get(r.name).join(' / ')).padEnd(26)} 极差 ${区.大 - 区.小} ms（${区.成}%）`);
    }
    console.log('↔ = 极差超过中位数的 30%：这一格**单趟的数不可用来判退化**。');
  }
  cdp?.close();
  console.log('\n' + renderReport(记录, { 地板 }));
  return 0;
}
