/**
 * 界面体检的公共部分：连上跑着的应用，发指令，量东西。
 *
 * **为什么要有这么一层**：这一轮轮走查里，同样的 WebSocket 样板抄了几十遍，
 * 而真正会咬人的东西（颜色怎么解析、焦点为什么聚不上）每次都要重新想一遍。
 * 把踩过的坑写在这里，下次直接用。
 *
 * 用法：应用要**先跑起来**并开着调试端口——
 *   node_modules/electron/dist/electron.exe \
 *     --user-data-dir=<测试档案> --remote-debugging-port=9876 .
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
// 仓库根**只此一份**，别在这儿再算一遍（那个文件顶上记着抄三份的下场）
import { ROOT } from '../repo-root.mjs';

export const CDP_PORT = 9876;
/**
 * 维护接口的地址。**跟主进程读同一个环境变量**（`SHUZHAI_API_PORT`）。
 *
 * 写死 30036 时有一个真事故：用户自己开着应用时，走查实例绑不上那个口，
 * 于是这里每一句 rpc **全打到了真实库上**。换个口就互不干扰：
 *
 *   $env:SHUZHAI_API_PORT=30037; electron --user-data-dir=... --remote-debugging-port=9876 .
 *   $env:SHUZHAI_API_PORT=30037; node scripts/ui-check/notes.mjs
 */
export const API = 'http://127.0.0.1:' + (process.env.SHUZHAI_API_PORT || '30036');

/**
 * **闸门：默认拒绝在真实书库上跑。**
 *
 * CLAUDE.md 里那条「不要在用户的真实书库上驱动阅读器界面」是踩出来的——
 * 用 CDP 点封面、点下一章，应用会忠实地把阅读进度写进 `reading_state`，
 * 而那是重扫恢复不了的数据（实测把一本书从第 572 章点到了 485 章）。
 * 测试库只有个位数的书，真实库是八千本，用这个数就分得开。
 * 真要在大库上量（性能压测），显式传 `--big`。
 */
/**
 * 把关只跑一次，结果缓下来。`connect()` 和 `rpc()` 都等它。
 *
 * ⚠️ **为什么不只靠各个脚本自己调一句 `guardTestLibrary()`：**
 * 因为临时写的那些脚本不会调。实测踩过一次：我在 scratchpad 里写了个
 * 只 `import { connect, rpc }` 的小脚本，而那一刻**用户自己的应用正占着 30036**——
 * `API` 这个地址是写死的，于是那些 rpc **全打到了真实库上**，
 * 往里面写了两条测试划线（后来删掉了）。
 * 而测试实例那边因为端口被占，压根儿没有自己的接口。
 *
 * 所以把它挪到了**绕不过去的地方**：只要连上、或者发一句 rpc，就先问一句
 * 「这个库多少本书」。这条和 README 里那句「用独立的 --user-data-dir」不重复：
 * 那句管的是**档案目录**，而这里出事的是**端口**。
 */
let 把关过 = null;
const 确认不是真实库 = () => (把关过 ??= guardTestLibrary());

export async function guardTestLibrary(argv = process.argv) {
  const stats = await (await fetch(`${API}/api/stats`)).json();
  const big = argv.includes('--big');
  if (stats.books > 100 && !big) {
    console.error(
      `✗ 拒绝运行：连上的这个库有 ${stats.books} 本书，看着像真实书库。\n`
      + '  这些脚本会点开书、翻章、改状态——那会写进 reading_state，重扫恢复不了。\n'
      + '  要在测试库上跑：用 --user-data-dir 指一个测试档案。\n'
      + '  真要在大库上量性能：加 --big（并且自己确认那是个副本）。',
    );
    process.exit(1);
  }
  return stats;
}

/**
 * 往测试库里塞一点**评价数据**，再开始量。
 *
 * 起因：测试库里 0 个标签、0 条书评，于是「标签管理」「批量打标签」「我的书评」
 * 这几个界面走查量的全是**空壳**——一个 101 行的标签列表、一条会折两行的长书评、
 * 一个长标签名，这些只有有数据才现形的版面问题，走查从来没见过。
 * 实测过一次：手工塞进 99 个标签再跑，那才是第一次真的量到那个列表。
 *
 * 只在还没有标签时塞（跑第二遍不会越堆越多，同 README 里
 * 「自定义封面源那条会写库」那个坑）。走的是 rpc，和界面同一条路。
 */
export async function seedReviewData() {
  const rpc = (method, params) => fetch(`${API}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Api': '1' },
    body: JSON.stringify({ method, params }),
  }).then((r) => r.json());

  /*
   * ⚠️ **朗读引擎要单独种一条，而且要排在下面那个 early return 前面。**
   * 仓库现在**默认一个在线引擎都不带**（那 88 条搬进用户自己的库了），而走查用的是
   * 全新档案目录——`.tts-list` 只在 `engines.length > 0` 时渲染，于是「朗读引擎」
   * 那一屏**永远打不开**，五个分辨率一起报「没打开」。
   * **一条永远变红的走查比没有更糟**：看的人会开始整份忽略。
   * （种下去的引擎不发任何请求，除非有人去点试听。）
   */
  if (!((await rpc('tts.engines')).result ?? []).length) {
    await rpc('tts.addEngine', { name: '走查用的假引擎', url: 'https://example.invalid/say?t={text}' });
  }

  const tags = (await rpc('tag.list')).result ?? [];
  if (tags.length >= 20) return { seeded: false, tags: tags.length };

  const books = ((await rpc('book.list', { limit: 6 })).result ?? []).map((b) => b.id);
  if (!books.length) return { seeded: false, tags: 0 };

  /*
   * 名字长短都要有：短标签排得下，长的才会撑破那一行。
   *
   * **数量要足够多**（原来是「超过筛选条收起时列的那 24 个」——那个截断和它的
   * 「+N」展开器已经没了：标签条改成一行横滚，全部列出来。留着这个数是为了
   * 让那一排真的溢出，量得到「不换行、能横滚」——
   * 而真实用户按题材打标签，几十个是常态。
   */
  const names = ['玄幻', '玄幻小说', '都市', '重生', '穿越', '系统', '已完结', '值得再看一遍的那种'];
  for (let i = 1; i <= 20; i++) names.push('题材' + i);
  await rpc('tag.add', { bookIds: books.slice(0, 3), names });
  // 一条折两行的长书评 + 一条短的
  await rpc('reading.setStatus', {
    bookId: books[0], rating: 2,
    comment: '前面三卷是神作，中间开始注水，最后两卷像换了个作者写的，彻底烂尾，别看',
  });
  await rpc('reading.setStatus', { bookId: books[1], rating: 5, comment: '一口气看完' });
  return { seeded: true, tags: names.length };
}

/**
 * 切到侧栏的某一档。
 *
 * **低频那几档（未标记 / 我的书评 / 读过没评价 / 已屏蔽）收在「更多」里**，
 * 主栏上直接找不到——所以先展开再点。两个走查都要这么做，
 * 各抄一份的话改一处漏一处（本仓库栽过八次的形状）。
 *
 * @returns 真的切过去了才是 true（「点了」和「切过去了」是两件事）
 */
export function 切档(ev, until) {
  return async (name) => {
    const 找 = `[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.startsWith(${JSON.stringify(name)}))`;
    if (!(await ev(`!!${找}`))) {
      await ev("(() => { const m=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.startsWith('更多')); if(m) m.click(); return 1; })()");
      await until(`!!${找}`, 5000);
    }
    if (!(await ev(`!!${找}`))) return false;
    await ev(`(() => { ${找}.click(); return 1; })()`);
    return until(
      `[...document.querySelectorAll('.nav-item')].some(x=>x.getAttribute('aria-current')==='true' && x.textContent.startsWith(${JSON.stringify(name)}))`,
      5000,
    );
  };
}

/**
 * 点侧栏底部的某个管理工具。
 *
 * **低频的那几个收进「更多工具」了**（提取书名作者 / 添读过的书 / 按书名打标签 /
 * 标签管理 / 重复的书 / 正文净化 / 导出表格 / 备份），主栏上留的是
 * 「全库搜索 / 我的笔记 / 书库文件夹 / 扫描书库 / 设置」——所以先展开再点。
 *
 * ⚠️ **这两份名单会变，别在这儿记个数。** 原来写死的是「九个」，而
 * 「书库文件夹」后来提到主栏去了（书从哪儿来不该埋在折叠里），那个数当场变假；
 * 更早「我的笔记」加进主栏时这句话也没跟上。`开工具` 认的是名字不是数，
 * 名单写在这儿只为了让人知道去哪儿找。
 *
 * ⚠️ 点完折叠键之后 **DOM 不是同步更新的**，必须等一下再找。
 */
export function 开工具(ev, until) {
  return async (name) => {
    const 找 = `[...document.querySelectorAll('.nav-tool')].find(x=>x.textContent.trim()===${JSON.stringify(name)})`;
    if (!(await ev(`!!${找}`))) {
      await ev("(() => { const m=[...document.querySelectorAll('.nav-tool')].find(x=>x.textContent.trim().startsWith('更多工具')); if(m) m.click(); return 1; })()");
      await until(`!!${找}`, 5000);
    }
    if (!(await ev(`!!${找}`))) return false;
    await ev(`(() => { ${找}.click(); return 1; })()`);
    return true;
  };
}

/** 连上页面。返回 { send, ev, wait, key, close } */
export async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('没找到应用页面——应用没跑，或者调试端口不是 ' + CDP_PORT);

  /**
   * ⚠️ **连上的这个页面，得是我这份构建。**
   *
   * 调试端口只认端口号，不认是谁开的。手上有第二个检出（worktree、或者上一轮
   * 忘了关的实例）时，`9876` 那头很可能是**别处那份 `dist/`**——脚本照跑、
   * 一条错都不报，量的却是另一棵树的界面。
   *
   * 实测的样子：改完表格、重新 build、跑体检，五个分辨率里**该消失的一条都没消失**。
   * 那看起来像「改了但没生效」，于是人会回去翻自己的 CSS——而真相是连错了实例。
   * 同 `确认不是真实库()` 那条是一个病：**把关的对象和驱的对象不是同一个**。
   */
  /*
   * ⚠️ **锚在这个文件自己的位置上，不是 `process.cwd()`。**
   * 按 cwd 算的话两头都错：在**脚本自己那个子目录里**跑（`cd` 进去再 `node audit.mjs`），
   * 拿去比的就成了那个子目录下的 dist，当场误杀一个好好的实例；
   * 反过来在主检出里 `node <worktree>/scripts/ui-check/audit.mjs`，比的又是
   * **主检出**那份 dist，于是放行了一个不是被审那棵树的实例——正是这道守卫要防的病。
   * 顺带：手拼 'file:///' + 路径 在带中文或空格的检出下和 `page.url` 的百分号编码对不上，
   * `repo-root.mjs` 顶上记着同一个坑（那三个脚本当年一起 ENOENT）。
   */
  const 我这份 = pathToFileURL(join(ROOT, 'dist', 'index.html')).href;
  if (page.url.toLowerCase() !== 我这份.toLowerCase()) {
    console.error('✗ 拒绝运行：调试端口 ' + CDP_PORT + ' 那头连的不是这个目录的构建。');
    console.error('  它加载的是：' + page.url);
    console.error('  这里期望的：' + 我这份);
    console.error('  多半是别的检出（worktree）或上一轮忘了关的实例还占着这个端口。');
    console.error('  关掉它，从这个目录重开一个，再跑。');
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));

  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  /** 在页面里求值。**出错会返回 'ERR …' 而不是悄悄给 undefined** */
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      return 'ERR ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text || '').slice(0, 200);
    }
    return r.result?.result?.value;
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 敲一个键。**要验焦点相关的东西只能用这条**——
   * `:focus-visible` 只在键盘触发的聚焦时匹配，JS 调 `el.focus()` 不算，
   * 据此报过 327 条假的「聚焦看不出来」。
   */
  const key = async (k, code = k, vk = 0) => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    }
    await wait(90);
  };

  /**
   * 重载页面，**等应用真的起来再返回**。四个脚本共用这一份，别各自抄。
   *
   * 两个坑，都是量出来的：
   *
   * 1. **绝不能加 `ignoreCache: true`。** 页面是 `file://` 上的
   *    `<script type="module" crossorigin>`，带上这个标志之后模块脚本会被 CORS
   *    拦掉——`performance` 里一条资源都没有、`#root` 永远是空的，
   *    而且**不抛任何错误**（错误收集器装上了，收到 0 条）。
   *    实测：普通 reload 起得来，加了这个标志 15 秒还是白的。
   *    要绕开缓存用 `Network.setCacheDisabled`，它没有这个副作用。
   * 2. **别按秒数猜。** 这台机器上一次普通 reload 实测 5.8s 和 14.6s 都出现过，
   *    原来写死的 2500ms 会让自检的夹具塞进旧文档、随后被新文档冲掉，
   *    报出来是「探针坏了」而探针好好的。
   */
  const reload = async (ms = 40000) => {
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    /*
     * **重试一次再放弃，而且带上诊断。**
     *
     * 实测这台机器上普通重载是 311–811ms（连做六次量的），
     * 但偶尔会有一次整整 40 秒都起不来——原因没查出来，
     * 而它报出来只有一句「应用没起来」，看着像应用坏了。
     * 一次重试几乎不花时间，却能把「偶发」和「真的起不来」分开；
     * 真的两次都失败时，把 `#root` 的长度和加载了几个资源打出来——
     * 白页（root 为空、资源 0 个）和「起来了但没渲染」是两回事。
     */
    for (let attempt = 1; attempt <= 2; attempt++) {
      await send('Page.reload', {});
      const t = Date.now();
      while (Date.now() - t < ms) {
        // 等 `.app`（外壳）**不是 `.wall`（书架网格）**：一个刚建好的空库
        // 铺的是「还没有书库目录」那一屏，压根没有 .wall——第一版等它，
        // 于是「第一次打开」这条最该走的路直接超时
        if (await ev("!!document.querySelector('.app') || !!document.querySelector('.reader')")) {
          if (attempt > 1) console.error(`  （重载第 1 次没起来，第 2 次好了——偶发，不是应用的问题）`);
          return true;
        }
        await wait(300);
      }
      if (attempt === 1) console.error(`  （重载等了 ${ms}ms 还没起来，再试一次）`);
    }
    const diag = await ev("(() => { try { return JSON.stringify({ root: (document.getElementById('root')||{}).innerHTML?.length ?? -1, 资源: performance.getEntriesByType('resource').length }); } catch (e) { return String(e); } })()");
    throw new Error(`应用没起来：重载两次都等了 ${ms}ms 还看不到书架。${diag}`);
  };

  /*
   * ⚠️⚠️ **这一句不能删：没有它 `requestAnimationFrame` 一帧都不跑。**
   *
   * 这台机器上应用窗口是后台窗口，`document.visibilityState` 是 **`hidden`**，
   * 于是 Chromium 把 rAF 掐到 0——当场量的：1.5 秒 **0 帧**，
   * 而 `setTimeout` 照走（所以看起来「页面是活的」）。
   *
   * 而 **pdf.js 和 epub.js 的渲染都挂在 rAF 上**，后果是这两样东西
   * 走查里**永远验不了**，而且症状完全不像「rAF 没跑」：
   *
   *   - PDF：第一页画得出来（第一块是同步画的），但 `render().promise`
   *     **永远不 resolve**。它还占着 canvas，于是往后每一次翻页都被 pdf.js
   *     拒掉（`Cannot use the same canvas during multiple render() operations`），
   *     而调用处是 `void 画(...)`，reject 被吞掉——
   *     **右轨、底部、键盘、滑块四条路一起哑掉，一句话都没有**。
   *   - EPUB：`display()` 既不 resolve 也不 reject，控制台一条错都没有。
   *     这个症状被当成「epub.js 在这个环境里不稳、开到第三本就画不出来」
   *     查了十几轮没查到根因（`docs/lessons.md` 里那一串）——**就是这一条**。
   *     开着它之后：**0.3 秒开出来，不转圈、不报错、翻页正常**。
   *
   * 试过的四个 CDP 方法里**只有这一个管用**（`Page.bringToFront` 无效，
   * 另外两个是在它之后测的、本来就已经 visible 了）：
   *
   *   基线                                 hidden    0 帧 / 1.5s
   *   Page.bringToFront                    hidden    0 帧
   *   Emulation.setFocusEmulationEnabled   visible 140 帧   ← 就是它
   *
   * 顺带解释了本文件 `callReactProp` 上面那条「这个环境里聚不上焦」——同一个根。
   */
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });

  /**
   * **拿真鼠标拖出一个选区**，不是 `dispatchEvent(new MouseEvent('mouseup'))`。
   *
   * ⚠️ 这个区别抓到过一个合成事件**永远抓不到**的 bug：真鼠标松手之后
   * 浏览器**必然再补一个 `click`**，而两个阅读界面的「点正文」都拿
   * 「有浮层就收起来」当第一条判据——刚弹出来的划线卡自己就是一层浮层，
   * 于是它在同一轮事件里被自己关掉，屏幕上什么都看不见。
   * 合成的 `mouseup` 不产生 `click`，所以走查一路绿，而**手一碰就是坏的**。
   *
   * `sel` 是一个 CSS 选择器，指向要拖的那个元素；它必须**整个在视口里**
   * （拖到视口外面选不中任何东西，而那看起来和「划线坏了」一模一样）。
   * 回选中的那段字，选不中回空串。
   */
  const 拖选 = async (sel) => {
    /*
     * ⚠️ **不在这里 `scrollIntoView`。** 查看器里 pdf.js 是滑到哪铺到哪，
     * 重铺那一下是 `replaceChildren()`——把整层文本节点换一批。
     * 它掉在拖完之后的话，**选区连同节点一起被抹掉**：
     * 事件全派到了、`selectstart` 和六个 `selectionchange` 都触发了，
     * 而 600ms 后一问选区是空的。实测：这句去掉就每次都中，加上就每次都空。
     * 所以**调用方自己先滑好、等它铺完**，这里只量和拖。
     */
    /*
     * 两种量法轮着来，因为哪一种都单独翻过车：
     *   行（`Range.getClientRects()`）——块元素必须用它，否则中线落在行隙上；
     *   整个元素的外接矩形——pdf.js 那种带缩放的单行 span 用它才准。
     * 两种都会先拿 `caretRangeFromPoint` 问一句「这个点下面真的是字吗」。
     */
    const 量 = async (整块) => JSON.parse(await ev(`(() => {
      const e = document.querySelector(${JSON.stringify(sel)});
      if (!e) return 'null';
      const r = document.createRange();
      r.selectNodeContents(e);
      const 侯选 = ${整块} ? [e.getBoundingClientRect()] : [...r.getClientRects()];
      const 行们 = 侯选.filter(
        (b) => b.width > 60 && b.height > 4 && b.top > 4 && b.bottom < innerHeight - 4);
      for (const b of 行们) {
        for (const f of [0.5, 0.4, 0.6, 0.3, 0.7]) {
          const y = Math.round(b.top + b.height * f);
          const cr = document.caretRangeFromPoint(Math.round(b.left + b.width / 2), y);
          if (cr && e.contains(cr.startContainer)) return JSON.stringify({ x: b.left, y, w: b.width });
        }
      }
      return 'null';
    })()`));

    for (let 轮 = 0; 轮 < 4; 轮++) {
      const box = await 量(轮 % 2 === 1);
      if (!box) { await wait(400); continue; }
      const y = box.y;
      const m = (type, x, buttons) =>
        send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons });
      await m('mousePressed', Math.round(box.x) + 2, 1);
      for (let i = 1; i <= 6; i++) await m('mouseMoved', Math.round(box.x + (box.w * i) / 6), 1);
      await m('mouseReleased', Math.round(box.x + box.w) - 2, 0);
      await wait(600);
      const 出 = String(await ev('getSelection().toString()'));
      if (出.trim()) return 出;
      await wait(400);
    }
    return '';
  };

  /*
   * ⚠️ **把关要问「我正在驱的这个实例」，不能问端口。**
   *
   * `guardTestLibrary()` 走的是写死的 `http://127.0.0.1:30036`，而那个端口
   * 属于「谁先绑上谁就占着」。于是会同时出两种错：
   *   ① 用户自己的应用占着端口时，测试实例根本没有接口，
   *     而脚本里每一句 HTTP rpc **全打到真实库上**（实测往里面写进去过两条划线）；
   *   ② 反过来，正当地驱测试实例时它又会因为「端口那头是真实库」而拒绝运行。
   *
   * 两种错同一个根：**把关的对象和驱的对象不是同一个**。
   * CDP 连上的那个页面才是我要点的，就问它自己：`window.novel.rpc` 走的是 IPC，
   * 直通它自己的主进程，和端口无关。
   */
  if (!process.argv.includes('--big')) {
    const n = await ev("window.novel.rpc('library.stats').then((s) => s.books).catch(() => -1)");
    if (Number(n) > 100) {
      console.error(
        `✗ 拒绝运行：CDP 连上的这个实例有 ${n} 本书，看着像真实书库。` + '\n'
        + '  这些脚本会点开书、翻章、改状态——那会写进 reading_state，重扫恢复不了。\n'
        + '  要在测试库上跑：用 --user-data-dir 开一个测试档案，并且连到那个实例的调试端口。\n'
        + '  真要在大库上量性能：加 --big（并且自己确认那是个副本）。',
      );
      process.exit(1);
    }
  }

  return { send, ev, wait, key, reload, 拖选, close: () => ws.close() };
}

/** 走一次 rpc（和界面同一张白名单）。返回 { ms, r, err } */
export async function rpc(method, params) {
  await 确认不是真实库();
  const t = Date.now();
  const res = await fetch(`${API}/api/rpc`, {
    method: 'POST',
    headers: { 'X-Api': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const j = await res.json();
  return { ms: Date.now() - t, r: j.result, err: j.error };
}

/**
 * 颜色解析。**两种写法都要认**：
 *   `rgb(38, 38, 38)`                      → 0–255
 *   `color(srgb 0.968 0.949 0.909 / 0.88)` → 0–1，要乘 255
 * 只 match 数字取前三个的话，0.96 会被当成 96——据此报过一堆「对比度 1.38」的假警报。
 */
export const parseColor = (s) => {
  if (!s) return null;
  const m = s.match(/[\d.]+/g);
  if (!m) return null;
  const v = m.slice(0, 3).map(Number);
  return s.startsWith('color(') ? v.map((x) => Math.round(x * 255)) : v;
};

const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = (a) => 0.2126 * lin(a[0]) + 0.7152 * lin(a[1]) + 0.0722 * lin(a[2]);

/** WCAG 对比度 */
export const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * 直接调 React 挂在元素上的某个处理函数——**绕开焦点**。
 *
 * 这个环境（无头/后台窗口）里聚不上焦：`el.focus()`、CDP 真实点击、
 * user32 把窗口调到前台，三种办法 `document.activeElement` 全是 BODY，
 * `focusout` 触发 0 次。于是「失焦才保存」的输入框看起来永远在丢数据。
 * 返回可注入页面的表达式片段。
 */
export const callReactProp = (getterExpr, prop, argExpr = '{ target: el }') => `(() => {
  const el = ${getterExpr};
  if (!el) return '没找到元素';
  const k = Object.keys(el).find((x) => x.startsWith('__reactProps'));
  if (!k || typeof el[k][${JSON.stringify(prop)}] !== 'function') return '这个元素上没有 ${prop}';
  el[k][${JSON.stringify(prop)}](${argExpr});
  return 'ok';
})()`;

/** 像用户打字那样改一个受控/非受控输入框的值 */
export const setInput = (getterExpr, text) => `(() => {
  const el = ${getterExpr};
  if (!el) return '没找到输入框';
  /*
   * ⚠️ **拿元素自己的原型，别按 tagName 查表。** React 把 value 改成了
   * 受控属性，要绕过去得拿**那个元素真正的原型**上的 setter。
   * 查表那写法漏过 textarea（评价卡那个框），而拿错原型不报错，
   * 只是值没进去、React 也收不到。
   */
  const proto = Object.getPrototypeOf(el);
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  return el.value;
})()`;
