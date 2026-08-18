/**
 * 全界面 × 多分辨率的客观体检。
 *
 * **不靠看截图**：`RES` × `SURFACES` 上百屏，眼睛一定会漏，而且漏掉的
 * 恰恰是「差 3 像素」这种。这里量能算出对错的东西：
 *   整页横向滚动 / 元素跑出视口 / 弹窗超高又不能滚 / 点击目标 / 对比度 /
 *   文字被硬切 / 最后一行只剩一个字
 *
 * 跑法（应用要先开着，见 cdp.mjs 顶部）：
 *   node scripts/ui-check/audit.mjs
 */
import { readFileSync } from 'node:fs';
import { connect, guardTestLibrary, seedReviewData, parseColor, contrast } from './cdp.mjs';

/*
 * **第一档是窗口自己的下限**（`main.ts` 的 `minWidth: 760, minHeight: 520`）——
 * 用户真能把窗口拖到那么小，而这份清单原来最小只跑到 1280×720，
 * 于是 760–1280 这一整段是盲区，连 `styles.css` 里那条 `@media (max-width: 900px)`
 * 都从来没被走查碰过。补上之后一口气量出 17 条，其中真缺陷是：
 * 窄屏下复选框的间距豁免失效（20×20 挨太近）、正文净化的说明栏被正则列挤到
 * 「最后一行只剩一个字」。另外 3 条是探针自己的误报（翻页模式后面几页
 * 本来就排在右边，被 clip-path 裁掉）。
 *
 * 只加下限这一档，不加 900 的边界值：760 已经走的是窄分支，1280 走宽分支，
 * 再加一档只多 25% 的时间、换一个边界 off-by-one，暂时不值。
 */
/*
 * ⚠️ **每一屏的 `wait` 必须盖得住它自己 `open` 里那串轮询的预算。**
 *
 * 好几屏的 `open` 不是一下点开的，是「先点开一本书/一个弹窗，再 `setInterval`
 * 等某个按钮出现」。那个内层轮询有自己的上限（`n > 40` × `200ms` = 8 秒），
 * 而外层 `wait` 是这一屏总共等多久——**外层比内层短的话，慢一点就必然报
 * 「没打开」，而那句话说的不是真正的原因**（它其实还在等）。
 *
 * 实测过两次：「书内搜索」在 1920×1080 报「等完了也找不到 .find-panel」，
 * 重跑就干净。查下来当时是 `wait: 3400` 对着一个 8 秒的内层轮询。
 * 一口气量了全部十屏，**六屏都是这个毛病**。
 *
 * 下面这段自检把它钉住：以后谁加一屏、或者把内层轮询调长，对不上就当场退出。
 * （`until` 一成立就收工，所以把上限调大在正常情况下不花时间。）
 */
function checkWaits() {
  const src = readFileSync(new URL('./audit.mjs', import.meta.url), 'utf8').split(String.fromCharCode(10));
  const bad = [];
  let cur = null;
  for (const line of src) {
    const head = /^  \{ name: '([^']+)', wait: (\d+),/.exec(line);
    if (head) {
      if (cur) bad.push(...verdict(cur));
      cur = { name: head[1], wait: Number(head[2]), budget: 0 };
      continue;
    }
    if (!cur) continue;
    for (const m of line.matchAll(/\+\+[nm] > (\d+)\) clearInterval\(t2?\); \}, (\d+)\)/g)) {
      cur.budget = Math.max(cur.budget, Number(m[1]) * Number(m[2]));
    }
  }
  if (cur) bad.push(...verdict(cur));
  if (bad.length) {
    console.error('✗ 自检没过：这几屏的 wait 比它自己 open 里那串轮询还短，慢一点就会报假的「没打开」');
    for (const b of bad) console.error('   ' + b);
    process.exit(2);
  }
}

/** 外层 wait 盖不住内层轮询就是个隐患，理由写在 checkWaits 上面 */
function verdict(s) {
  return s.budget && s.wait < s.budget ? [`${s.name}: wait=${s.wait} 盖不住内层的 ${s.budget}`] : [];
}
checkWaits();

const RES_全 = [[760, 520], [1280, 720], [1440, 900], [1920, 1080], [2560, 1440]];

/*
 * **能只跑一部分**：`node audit.mjs 760x520 全库搜索 设置`。
 * 不加参数就是全量（CI 之外没人手动跑全量以外的东西，所以默认不变）。
 *
 * 加这个是因为**跑一趟全量要接近一小时**（实测每档约十分钟），
 * 而「改一处、量一次」是这类走查唯一有用的用法——
 * 改完等一小时才知道有没有撑破版面，等到第二次就不会再等了，
 * 于是走查从「工具」变成「发版前跑一次的仪式」。
 */
const 参数 = process.argv.slice(2);
const 要的分辨率 = 参数.filter((a) => /^\d+x\d+$/.test(a));
const 要的界面 = 参数.filter((a) => !/^\d+x\d+$/.test(a));
const RES = 要的分辨率.length
  ? RES_全.filter(([w, h]) => 要的分辨率.includes(`${w}x${h}`))
  : RES_全;
if (要的分辨率.length && RES.length !== 要的分辨率.length) {
  console.error('这些分辨率不在表里：', 要的分辨率.filter((r) => !RES_全.some(([w, h]) => `${w}x${h}` === r)).join(' '));
  process.exit(2);
}

/** 每个界面怎么打开、怎么关掉。名字要和侧栏上的字一致 */
const SURFACES = [
  { name: '书架' },
  /*
   * **「我的书评」是另一种版面，不是筛过的书架**（`ReviewShelf.tsx`）——
   * 一栏排开的书评，正文是用户自己写的一句话，长短完全不受控。
   * 和「全库搜索」那条同一个理由：这里是最容易撑破版面的地方，
   * 而它在这份清单里一直是个盲区（走查从来只量默认那一档）。
   *
   * `seedReviewData` 种了两条（一条长的折两行、一条只有四个字），够量。
   *
   * ⚠️ **收尾必须切回「全部」。** 这些界面是接着跑的，书架档位不像弹窗那样
   * 会被那句关遮罩收掉——留在这一档的话，后面每一屏都在一个没有 `.book` 卡片的
   * 页面上量，而 `card:` / `editor:` 那几条会一齐报「打不开」。
   * ⚠️ **别指望它顺带把排序也还原**：切档应用的是 `排序默认()`，而那条链
   * 「存过的 → 这一档的 sort」**存过的在前**——前面哪一屏动过排序，这里就还是它。
   * 真要还原得自己 `localStorage.removeItem('shelf.sorts')`（`review.mjs` 收尾那处）。
   */
  /*
   * ⚠️ **这一屏量的是书评册，所以要显式切过去。**
   * 「我的书评」现在**默认是表格**（`SHELVES` 的 `view` 字段），不切的话这一屏
   * 量到的是表格——而表格已经有「书架·表格」在量，**书评册就会一屏都没有**。
   * 覆盖面是悄悄没的：报告上不会少一行，只是那一行量的是别的东西。
   *
   * ⚠️ **收尾要点两下**：先「封面墙」（点视图键会 `saveView`，把偏好写回墙），
   * 再「全部」（切档时应用 `loadView()`）。只点「全部」的话偏好还停在书评册，
   * 后面每一屏背后的书架都是书评册，`card:` / `editor:` 那几条要找的 `.book` 卡片
   * 一个都没有。
   */
  { name: '我的书评', wait: 3000, expect: '.rv',
    open: "(() => { const 找=()=>[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.startsWith('我的书评'));"
      + " if(!找()) { const m=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.startsWith('更多')); if(m) m.click(); }"
      + " let n=0; const t=setInterval(() => { const b=找(); if (b) { clearInterval(t); b.click();"
      + " const v=[...document.querySelectorAll('.viewpick .chip')].find(x=>x.textContent.trim()==='书评册'); if(v) v.click(); }"
      + " if (++n > 20) clearInterval(t); }, 150); return 1; })()",
    close: "(() => { const v=[...document.querySelectorAll('.viewpick .chip')].find(x=>x.textContent.trim()==='封面墙'); if(v) v.click();"
      + " const b=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.startsWith('全部')); if(b) b.click(); return 1; })()" },
  /*
   * **表格视图。** 八列并排，其中「评价」那一列装的是用户自己写的话——
   * 这一屏是整个应用最容易撑破版面的地方。
   *
   * 它自己横滚（`.tablewrap`），所以窄分辨率下量的是「有没有被挤扁」，
   * 不是「有没有溢出」——那两件事在这儿是反的：**挤扁不会报任何警告**
   * （表格确实没溢出），而挤扁的表根本读不了。实测 560 宽下作者列
   * 曾被压成一个字一行，是截图看出来的，不是探针。
   *
   * ⚠️ **收尾要切回封面墙**：视图是存进 localStorage 的偏好，留在表格的话
   * 后面每一屏背后的书架都是表格，而 `card:` / `editor:` 那几条要找 `.book` 卡片。
   * 同上面「我的书评」那一屏切回「全部」的理由。
   */
  { name: '书架·表格', wait: 2500, expect: '.booktable tbody tr',
    open: "(() => { const b=[...document.querySelectorAll('.viewpick .chip')].find(x=>x.textContent.trim()==='表格'); if(!b) return 0; b.click(); return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.viewpick .chip')].find(x=>x.textContent.trim()==='封面墙'); if(b) b.click(); return 1; })()" },
  /* 「筛选」开的是分类那个编辑器（多一条「就这么筛」的出路）。
     条件组比原来多了两组（读完年份 / 连载状态），高度值得单量一屏 */
  { name: '筛选', wait: 1500, expect: '.cat-modal .cond-chips',
    open: "(() => { const b=[...document.querySelectorAll('.main-head .chip')].find(x=>x.textContent.trim()==='筛选'); if(!b) return 0; b.click(); return 1; })()" },
  /*
   * **搜索结果那张表要有东西才量得到。** 原来这一条只是 `nav: '全库搜索'`——
   * 打开一个还没输入任何东西的面板，量的是**空壳**：结果表一行都没有。
   * 而这张表里放的正是用户自己写的东西（书名、★、那句短评、一串标签），
   * 长短完全不受控，是最容易撑破版面的地方。
   * 同 README 里那条「走查一直在量空壳弹窗」——`seedReviewData` 解决了标签和书评，
   * 但搜索面板还得**真的敲进去一个词**才长出行来。
   *
   * 「书」能命中测试库里绝大多数书名，`wait` 要盖过输入框那 280ms 的防抖。
   */
  { name: '全库搜索', wait: 7500, expect: '.modal table tbody tr',
    open: "(() => { const b=[...document.querySelectorAll('.nav-tool')].find(x=>x.textContent.trim()==='全库搜索'); if(!b) return 0; b.click();"
      + " let n=0; const t=setInterval(() => { const i=document.querySelector('.modal input');"
      + " if (i) { clearInterval(t);"
      + " const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;"
      + " set.call(i, '书'); i.dispatchEvent(new Event('input', { bubbles: true }));"
      + " } else if (++n > 40) clearInterval(t); }, 150); return 1; })()" },
  { name: '书库文件夹', nav: '书库文件夹' , expect: '.modal' },
  { name: '提取书名作者', nav: '提取书名作者' , expect: '.modal' },
  { name: '添读过的书', nav: '添读过的书' , expect: '.modal' },
  { name: '按书名打标签', nav: '按书名打标签' , expect: '.modal' },
  { name: '标签管理', nav: '标签管理' , expect: '.modal' },
  { name: '重复的书', nav: '重复的书' , expect: '.modal' },
  { name: '正文净化', nav: '正文净化' , expect: '.modal' },
  { name: '导出表格', nav: '导出表格' , expect: '.modal' },
  { name: '备份', nav: '备份' , expect: '.modal' },
  { name: '设置', nav: '设置' , expect: '.modal' },
  { name: '编辑一本书', card: '编辑' , expect: '.modal' },
  /* 这三样从卡片工具条搬进了「编辑一本书」——卡片那排原来是五个，
     而它乘以每张卡（一屏八张就是 40 个）。`editor:` 是先开编辑弹窗、
     再点里面那个 `.mini` 按钮 */
  { name: '章节怎么切', editor: '章节怎么切…' , expect: '.modal' },
  { name: '改名', editor: '改文件名…' , expect: '.modal' },
  /* 「评价」是**浮层不是弹窗**（`.rate-pop`，挂在卡片上）。
     给这份清单补 expect 时一刀切写成 .modal，四个分辨率立刻各报一条「没打开」——
     **而它在补 expect 之前一直是盲量的**：点完就量，点中没中、浮层渲染出来没有，
     一概不问。这就是补 expect 的意义。 */
  { name: '评价', card: '评价', expect: '.rate-pop' },
  /* 卡片上的「导出」——**和侧栏那个「导出表格」不是同一屏**。同一个组件
     两种形态：传了 book 是单本（EPUB / txt + 要不要净化），不传是全库（CSV / JSON）。
     这份清单原来只有后者，前者从来没被量过。
     ⚠ 只有真有文件的书才长这个按钮（手工添的「只有记录」那类没有正文可导）——
     测试库里第一张卡正好有文件，所以 card 这条路走得通。 */
  { name: '导出这一本', editor: '导出…', expect: '.modal' },
  /* **不能点「第一张卡」。** 只编目的 PDF 点开是走系统程序（还会在这台机器上
     弹个外部阅读器），文件缺失的书点开直接报错——两种都进不了阅读器，
     而这个 surface 原来没有 `expect`，于是探针量的是书架、报告一片干净。
     挑一本真有章节、且没有出问题标记的。

     ⚠ 判据**不要写成「数字 + 空格 + 章」**：书架上那个空格是 `U+00A0`
     （不换行空格，防止「45」和「章」被折到两行），拿普通空格去匹配永远落空，
     而且落得很安静——`find` 返回 undefined，报出来是「打不开」。 */
  { name: '阅读器', open: "(() => { const c=[...document.querySelectorAll('.book')].find(x => ((x.querySelector('.book-sub')||{}).textContent||'').includes('章') && !/文件缺失|未解析|PDF/.test(x.textContent)); if(!c) return 0; c.querySelector('.book-art').click(); return 1; })()", wait: 2600, expect: '.reader-text',
    close: "(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()" },
  /* 排版六项从设置弹窗搬进来之后，这个浮层从 251px 长到 443px——**它是最可能
     在 720p 上顶出屏幕的东西**，而原来这份清单只开阅读器、不开浮层 */
  /* open 里**不能写死等多久**再点「设置」——阅读器渲染快慢跟书的大小和机器忙闲
     都有关，实测 1800ms 有时不够，于是点了个还不存在的按钮，报出来是「没打开」。
     改成轮询：等右轨出现了再点，最多试 40 次（8 秒）。 */
  { name: '阅读设置浮层', wait: 3200, expect: '.reader-panel',
    open: "(() => { const c=[...document.querySelectorAll('.book')].find(x =>"
      + " ((x.querySelector('.book-sub')||{}).textContent||'').includes('章')"
      + " && !/文件缺失|未解析|PDF/.test(x.textContent));"
      + " if(!c) return 0; c.querySelector('.book-art').click();"
      + " let n=0; const t=setInterval(() => {"
      + "   const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('设置'));"
      + "   if (b) { b.click(); clearInterval(t); } else if (++n > 40) clearInterval(t);"
      + " }, 200); return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()" },

  /*
   * 目录**浮层**。它是覆盖整片阅读区的一大块（照用户给的 legado 参考改的，
   * 原来是挤占式侧栏），而**这份清单里一直没有它**——改完那一轮跑走查全 0，
   * 量的却根本不是这一屏。同本文件那条「一条『扫一遍』的判据，
   * 要问清楚它扫的是哪几屏」。
   *
   * 它是最该量的那类：一行一个章节标题，标题长度完全不受控（用户的书），
   * 而浮层左边还要给左轨让开 7rem——760px 上只剩不到 550px。
   */
  /* 设置浮层的**朗读页**。单独一屏，因为它的版面风险和排版页不是一回事：
     引擎名字长（「思必驰-灵动女声」这种），而浮层只有十几 rem 宽 */
  /* 朗读那一层。**原来这一条叫「阅读设置·朗读」，点的是设置浮层里的「朗读」页签**
     ——而那个页签已经没了（朗读搬成自己那一层）。它于是点不着、超时放弃，
     可 `expect` 写的是通用的 `.reader-panel select`，排版页上照样成立：
     **报告干干净净，量的是排版页。** 现在 `expect` 改成 `.tts-timer`
     （定时那一排，只有这一层有），量错屏就会当场报「没打开」。 */
  { name: '阅读器·朗读', wait: 9500, expect: '.tts-timer',
    open: "(() => { const c=[...document.querySelectorAll('.book')].find(x => ((x.querySelector('.book-sub')||{}).textContent||'').includes('章') && !/文件缺失|未解析|PDF|EPUB/.test(x.textContent)); if(!c) return 0; c.querySelector('.book-art').click();"
      + " let n=0; const t=setInterval(() => { const b=[...document.querySelectorAll('.reader-tools button')].find(x=>/朗读/.test(x.title||''));"
      + "   if (b) { b.click(); clearInterval(t); } else if (++n > 40) clearInterval(t); }, 200); return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()" },

  /* 引擎管理。**一行四个元素**（名字 / POST / 试听 / 删），窄窗口下最容易挤，
     而且它是从阅读器里开的 modal——`.reader .modal` 那条宽度限制只作用在这儿 */
  { name: '朗读引擎', wait: 12000, expect: '.tts-list',
    open: "(() => { const c=[...document.querySelectorAll('.book')].find(x => ((x.querySelector('.book-sub')||{}).textContent||'').includes('章') && !/文件缺失|未解析|PDF|EPUB/.test(x.textContent)); if(!c) return 0; c.querySelector('.book-art').click();"
      + " let n=0; const t=setInterval(() => {"
      + "   const b=[...document.querySelectorAll('.reader-tools button')].find(x=>/朗读/.test(x.title||''));"
      + "   if (b && !document.querySelector('.reader-panel')) { b.click(); return; }"
      + "   const g=[...document.querySelectorAll('.reader-panel button')].find(x=>/管理引擎/.test(x.textContent));"
      + "   if (g) { g.click(); clearInterval(t); } else if (++n > 50) clearInterval(t); }, 200); return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='关闭'); if(b) b.click();"
      + " const r=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(r) r.click(); return 1; })()" },

  { name: '阅读器·目录', wait: 9800, expect: '.toc-item',
    open: "(() => { const c=[...document.querySelectorAll('.book')].find(x =>"
      + " ((x.querySelector('.book-sub')||{}).textContent||'').includes('章')"
      + " && !/文件缺失|未解析|PDF/.test(x.textContent));"
      + " if(!c) return 0; c.querySelector('.book-art').click();"
      + " let n=0; const t=setInterval(() => {"
      + "   const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('目录'));"
      + "   if (b) { b.click(); clearInterval(t); } else if (++n > 40) clearInterval(t);"
      + " }, 200); return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()" },

  /*
   * PDF / EPUB 的**内置查看器**。它们和 txt 阅读器是两个界面
   * （只有翻页、缩放、记住读到哪儿），所以要各自量一遍。
   *
   * ⚠️ `make-testlib.mjs` 里那两个是**真的 PDF 和真的 EPUB**——
   * 原来是改了扩展名的 txt，那时 PDF 只编目、内容无所谓；有了查看器之后
   * 假文件只能测到「打不开」那条路。
   *
   * `wait` 给得大：pdf.js / epub.js 是**动态 import** 的（一兆多的 chunk），
   * 第一次打开要把它下下来再解析。
   */
  /* ⚠️ 这一屏偶尔开不起来（单独驱动 5 次都是 216–827ms 就画出来，不是慢）。
     **重试放在整屏那一级**，见上面 `重试过` 那段——写在这里没用：
     点进查看器之后书架已经卸载，再点也点不着。 */
  { name: 'PDF 查看器', wait: 12000, expect: '.viewer-body canvas',
    open: "(() => { const c=[...document.querySelectorAll('.book')].find(x=>x.textContent.includes('一本PDF电子书')); if(!c) return 0; c.querySelector('.book-open').click(); return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()" },

  /* PDF 自己的书签就是它的目录，和 EPUB 那一屏共用同一套 `.toc` 界面，
     所以窄屏那条规则也该对它成立。夹具里那个 PDF **带了 outline**
     （`make-testlib.mjs` 里专门造的），没有的话这一屏根本开不出来。 */
  { name: 'PDF 查看器·目录', wait: 12000, expect: '.toc .toc-item',
    open: "(() => { const c=[...document.querySelectorAll('.book')].find(x=>x.textContent.includes('一本PDF电子书')); if(!c) return 0; c.querySelector('.book-open').click();"
      + " let n=0; const t=setInterval(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('目录'));"
      + "   if (b) { b.click(); clearInterval(t); } else if (++n > 40) clearInterval(t); }, 250); return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()" },
  /*
   * ✅ **EPUB 那一屏加回来了（2026-08-26，第二次）。** 前两次拿出去是因为它永远红：
   * 「`display()` 既不 resolve 也不 reject，根因不明、偶发」。
   *
   * **根因查到了，而且不在 epub.js 里，也不在这个界面里**：这个走查连的是
   * **后台窗口**，`document.visibilityState` 是 `hidden`，Chromium 于是把
   * `requestAnimationFrame` 掐到 **0 帧**（当场量的：1.5 秒 0 帧，而 `setTimeout` 照走）。
   * epub.js 的排版和 pdf.js 的分块渲染都挂在 rAF 上，所以两样都「画一半就停住」。
   * 修的地方在 `cdp.mjs` 的 `connect()`——一句 `Emulation.setFocusEmulationEnabled`，
   * 整段理由写在那儿。
   *
   * 按上一轮自己定的判据验过了：**连开 5 次全好**（每次 0.8s，不转圈、不报错），
   * 五个分辨率连跑两轮 **EPUB 这一屏一条都没报**（第一轮 760×520 另有两条
   * 「打不开」，那是 `editor:` 挑卡片挑到了 PDF——原因和修法见下面那段，
   * 和 EPUB 无关；第二轮五个分辨率全 0）。判据也不再是「iframe 存在」这种弱的——
   * `expect` 要的是 iframe 里**真的有文字**（高度塌成 0 那个 bug 正是靠弱判据蒙混过去的）。
   */
  { name: 'EPUB 查看器', wait: 20000, expect: '.viewer-body iframe',
    ready: "(() => { const f=document.querySelector('.viewer-stage iframe');"
      + " try { const d=f&&f.contentDocument; return !!(d&&d.body&&d.body.innerText.trim().length>10&&f.getBoundingClientRect().height>50); } catch { return false; } })()",
    open: "(() => { const c=[...document.querySelectorAll('.book')].find(x=>x.textContent.includes('一本EPUB电子书')); if(!c) return 0; c.querySelector('.book-open').click(); return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()" },

  /* EPUB 的**目录侧栏**。它和 txt 阅读器的目录共用 `.toc` 那套 class，
     所以窄屏那条「浮在正文上而不是挤占」的规则也该对它成立——
     760×520 那一档正是当初给 txt 目录补那条规则的原因。 */
  { name: 'EPUB 查看器·目录', wait: 20000, expect: '.toc .toc-item',
    open: "(() => { const c=[...document.querySelectorAll('.book')].find(x=>x.textContent.includes('一本EPUB电子书')); if(!c) return 0; c.querySelector('.book-open').click();"
      + " let n=0; const t=setInterval(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('目录'));"
      + "   if (b) { b.click(); clearInterval(t); } else if (++n > 80) clearInterval(t); }, 250); return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()" },


  /*
   * ── 下面七个是补的。补之前这份清单只有 18 个界面，而渲染进程有 20 个弹窗/面板，
   *    缺的恰好是手工走查里挖出最多缺陷的那几个——书内搜索、书签与划线、
   *    批量打标签、自定义封面源、设置的「书库」那一页，以及「在线地址」
   *    （它在补上入口之前根本进不去，所以从来没资格进这份清单）。
   *
   *    **最要紧的是「阅读器·翻页」**：翻页模式下 `.reader-body` 带 `clip-path`，
   *    而滚动模式下那条 CSS 根本不生效。真出过一次下一页的文字从右边漏出来、
   *    压在工具轨上的缺陷，这份清单当时看不见，因为它只测滚动模式。
   */

  // 头部那两个批量按钮不是 .nav-tool，得自己找
  /* 分类：一个名字 + 一条规则，右边一栏实时列出圈中的书。
     它是这份清单里**唯一的两栏弹窗**，窄屏要叠成一列——正是这一屏要量的东西 */
  { name: '新建分类', wait: 1500, expect: '.cat-modal .cond-chips',
    open: "(() => { const b=[...document.querySelectorAll('button')].find(x=>/新建分类/.test(x.textContent||'')); if(!b) return 0; b.click(); return 1; })()" },

  { name: '批量打标签', wait: 1200, expect: '.modal',
    open: "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='批量打标签'); if(!b||b.disabled) return 0; b.click(); return 1; })()" },

  { name: '批量改状态', wait: 1200, expect: '.modal',
    open: "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='批量改状态'); if(!b||b.disabled) return 0; b.click(); return 1; })()" },

  { name: '设置·书库', wait: 7500, expect: '.modal',
    open: "(() => { const s=[...document.querySelectorAll('.nav-tool')].find(x=>x.textContent.trim()==='设置'); if(!s) return 0; s.click();"
      + " let n=0; const t=setInterval(() => { const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.trim()==='书库');"
      + "   if (b) { b.click(); clearInterval(t); } else if (++n > 40) clearInterval(t); }, 150); return 1; })()" },

  /* 自定义封面源在「设置 → 书库」里，点「加一个源」才长出那一行控件。
   *
   * ⚠ **这一条会写库，所以必须自己收尾。** 它每跑一次就留下一行「新的搜索源」，
   * 一个分辨率留一行，一轮下来就是 `RES.length` 行。同一个档案目录上跑几轮之后，
 * 这个界面比第一次高一大截——
   * **同一个脚本重复跑，量的已经不是同一个东西了**，而报告上看不出任何异常。
   * `close` 里把自己加的那一行删掉，让每一轮的起点一样。
   *
   * ⚠ **认的是名字，不是位置。** 「最后一行」在正常情况下就是自己加的那行，
   * 但 `open` 那串 setInterval 万一没点着「加一个源」，最后一行就是**用户自己配的源**，
   * 而 `×` 是直接落库的删除（`CoverSources.tsx` 里 `save(list.filter(...))`）。
   * `新的搜索源` 是 `blankSource()` 给的默认名（`src/core/cover-custom.ts`），
   * 只删名字还没被改过的那行；一行都没有就什么都不做。 */
  { name: '自定义封面源', wait: 7500, expect: '.modal',
    close: "(() => { const rows=[...document.querySelectorAll('.modal .row')].filter(r=>[...r.querySelectorAll('button')].some(b=>/试一下/.test(b.textContent||'')) && [...r.querySelectorAll('input')].some(i=>i.value==='新的搜索源')); const row=rows[rows.length-1]; if(row){ const x=[...row.querySelectorAll('button')].find(b=>b.textContent.trim()==='×'); if(x) x.click(); } return 1; })()",
    open: "(() => { const s=[...document.querySelectorAll('.nav-tool')].find(x=>x.textContent.trim()==='设置'); if(!s) return 0; s.click();"
      + " let n=0; const t=setInterval(() => { const b=[...document.querySelectorAll('.tabs button')].find(x=>x.textContent.trim()==='书库');"
      + "   if (b) { b.click(); clearInterval(t);"
      + "     let m=0; const t2=setInterval(() => { const a=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='加一个源');"
      + "       if (a) { a.click(); clearInterval(t2); } else if (++m > 40) clearInterval(t2); }, 150);"
      + "   } else if (++n > 40) clearInterval(t); }, 150); return 1; })()" },

  /* 在线地址：编辑弹窗里那个按钮。**这个界面在这一轮之前是够不到的**。
     挑「有章节的那本」而不是第一张卡——`walk.mjs` 往它身上写数据，
     `link.addBatch` 也往它身上加地址；开第一张卡多半是空表，
     那样量到的永远是空状态，表格里那颗「主站」radio 一次都测不到 */
  { name: '在线地址', wait: 10500, expect: '.modal',
    open: "(() => { const c=[...document.querySelectorAll('.book')].find(x =>"
      + " ((x.querySelector('.book-sub')||{}).textContent||'').includes('章')"
      + " && !/文件缺失|未解析|PDF/.test(x.textContent)); if(!c) return 0;"
      + " const e=[...c.querySelectorAll('.book-tools button')].find(x=>x.textContent.trim()==='编辑'); if(!e) return 0; e.click();"
      + " let n=0; const t=setInterval(() => { const b=[...document.querySelectorAll('.modal button')].find(x=>/在线地址/.test(x.textContent));"
      + "   if (b) { b.click(); clearInterval(t); } else if (++n > 60) clearInterval(t); }, 150); return 1; })()" },

  { name: '书内搜索', wait: 9500, expect: '.find-panel',
    open: "(() => { const c=[...document.querySelectorAll('.book')].find(x =>"
      + " ((x.querySelector('.book-sub')||{}).textContent||'').includes('章')"
      + " && !/文件缺失|未解析|PDF/.test(x.textContent)); if(!c) return 0; c.querySelector('.book-art').click();"
      + " let n=0; const t=setInterval(() => { const b=[...document.querySelectorAll('.reader-tools button')].find(x=>/在这本书里搜/.test(x.title||''));"
      + "   if (b) { b.click(); clearInterval(t); } else if (++n > 40) clearInterval(t); }, 200); return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()" },

  { name: '书签与划线', wait: 9500, expect: '.modal',
    open: "(() => { const c=[...document.querySelectorAll('.book')].find(x =>"
      + " ((x.querySelector('.book-sub')||{}).textContent||'').includes('章')"
      + " && !/文件缺失|未解析|PDF/.test(x.textContent)); if(!c) return 0; c.querySelector('.book-art').click();"
      + " let n=0; const t=setInterval(() => { const b=[...document.querySelectorAll('.reader-tools button')].find(x=>/书签、划线/.test(x.title||''));"
      + "   if (b) { b.click(); clearInterval(t); } else if (++n > 40) clearInterval(t); }, 200); return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='关闭'); if(b) b.click();"
      + " const r=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(r) r.click(); return 1; })()" },

  /*
   * **「我的笔记」：从书架直接开的那一份笔记面板。**
   *
   * 和上面那条「书签与划线」是同一个组件、不同的模式（不传 `bookId` 就是全库），
   * 但**量的不是同一屏**：那一档没有页签栏、多一排按颜色筛的 chip、
   * 每行右边多两个小键（改笔记 / 删）、底下还多一个「导出全部笔记…」。
   * 挤的东西比那一档多，760x520 那一档最容易先出事。
   *
   * ⚠️ **它得有笔记才有东西可量**——空面板只有一句提示，
   * 那正是「走查量的全是空壳」那条老毛病。`seedReviewData` 只塞标签和书评，
   * 所以这里自己补两条带笔记的划线，`open` 里同步做完再点。
   */
  { name: '我的笔记', wait: 2500, expect: '.modal',
    open: "(async () => {"
      + " const q = (m, p) => window.novel.rpc(m, p);"
      + " const bs = await q('book.list', { filter: {}, limit: 5 });"
      + " const rows = bs.rows ?? bs;"
      + " for (const b of rows.slice(0, 2)) {"
      + "   const h = await q('highlight.add', { bookId: b.id, chapterIdx: 1, charOffset: 0, length: 4, excerpt: '走查用的摘录', color: 'blue' });"
      + "   await q('highlight.setNote', { id: h.id, note: '走查用的笔记，用来把这一屏填满好量版面' });"
      + " }"
      + " [...document.querySelectorAll('.nav-tool')].find(b=>b.textContent.trim()==='我的笔记')?.click();"
      + " return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='关闭'); if(b) b.click(); return 1; })()" },

  /*
   * **多选那一屏是另一屏。**
   *
   * 上面那一条量的是默认状态，而**批量那条动作条要点开「多选」才出现**：
   * 「已选 N 条 / 选这一屏 / 清空 / 改颜色（N）/ 打标签 / 删掉 N 条」一排七个东西挤在一行，
   * 760 宽那一档正是最容易先出事的。不单列一条的话这一排永远不会被量到——
   * 同这份清单里那条「走查一直在量空壳弹窗」，只不过这次空的不是内容是**状态**。
   */
  { name: '我的笔记·多选', wait: 3000, expect: '.modal',
    /*
     * ⚠️ **不在这里再造笔记。** 上一条「我的笔记」每跑一遍就多两条，
     * 这里再造就是每个分辨率四条——实测到 2560 那一档已经滞到
     * `wait` 盖不住，报了一条假的「没打开」。它紧接在上一条后面跑，
     * 库里肯定已经有笔记了，直接开就行。
     */
    open: "(() => {"
      + " [...document.querySelectorAll('.nav-tool')].find(b=>b.textContent.trim()==='我的笔记')?.click();"
      + " let n = 0; const t = setInterval(() => {"
      + "   const chip = [...document.querySelectorAll('.modal .chip')].find(x=>x.textContent.trim()==='多选');"
      + "   if (chip) { chip.click();"
      + "     setTimeout(() => [...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='选这一屏')?.click(), 120);"
      + "     clearInterval(t); } else if (++n > 16) clearInterval(t); }, 100);"
      + " return 1; })()",
    close: "(() => { const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='关闭'); if(b) b.click(); return 1; })()" },

  /* 翻页模式。排版是存 localStorage 的，改完直接开书就生效（Reader 挂载时读一次）。
     `close` 里必须改回滚动模式——不然后面的界面全在翻页模式下量，而那不是默认 */
  { name: '阅读器·翻页', wait: 3200, expect: '.reader-body.page-mode',
    open: "(() => { const K='novel.read-settings'; const s=JSON.parse(localStorage.getItem(K)||'{}');"
      + " localStorage.setItem(K, JSON.stringify(Object.assign({}, s, { mode: 'page' })));"
      + " const c=[...document.querySelectorAll('.book')].find(x =>"
      + " ((x.querySelector('.book-sub')||{}).textContent||'').includes('章')"
      + " && !/文件缺失|未解析|PDF/.test(x.textContent)); if(!c) return 0; c.querySelector('.book-art').click(); return 1; })()",
    close: "(() => { const K='novel.read-settings'; const s=JSON.parse(localStorage.getItem(K)||'{}');"
      + " localStorage.setItem(K, JSON.stringify(Object.assign({}, s, { mode: 'scroll' })));"
      + " const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()" },

  /* 无限下滑。量的是「好几章摞在一起」时的版面：章与章之间那条缝、
     以及上面那几张纸不再各自撑到一屏高（那条 `min-height` 只留给最后一张）。
     `close` 同样必须改回按章——不然后面的界面全在无限下滑下量 */
  { name: '阅读器·无限下滑', wait: 3600, expect: '.reader-body.flow-mode article[data-chapter]',
    open: "(() => { const K='novel.read-settings'; const s=JSON.parse(localStorage.getItem(K)||'{}');"
      + " localStorage.setItem(K, JSON.stringify(Object.assign({}, s, { mode: 'flow' })));"
      + " const c=[...document.querySelectorAll('.book')].find(x =>"
      + " ((x.querySelector('.book-sub')||{}).textContent||'').includes('章')"
      + " && !/文件缺失|未解析|PDF/.test(x.textContent)); if(!c) return 0; c.querySelector('.book-art').click();"
      + " let n=0; const t=setInterval(() => { const b=document.querySelector('.reader-body');"
      + "   if (b) { b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); }"
      + "   if (document.querySelectorAll('article[data-chapter]').length > 2 || ++n > 14) clearInterval(t); }, 220); return 1; })()",
    close: "(() => { const K='novel.read-settings'; const s=JSON.parse(localStorage.getItem(K)||'{}');"
      + " localStorage.setItem(K, JSON.stringify(Object.assign({}, s, { mode: 'scroll' })));"
      + " const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()" },
];

/*
 * ⚠️ **点名了就得说清点中了几个。** 不然写错一个界面名的后果是「一个都没跑」，
 * 而它印出来的是 `0 条`——和「全都好好的」逐字相同。
 * 这个仓库在别处栽过同一个形状（路径分隔符写反、asar 反斜杠），
 * 共同点都是**工具静默地什么都没找到，而「没找到」看起来和「没问题」一样**。
 */
if (要的界面.length) {
  const 有的 = SURFACES.map((s) => s.name);
  const 没有的 = 要的界面.filter((n) => !有的.includes(n));
  if (没有的.length) {
    console.error('这些界面不在表里：', 没有的.join(' '));
    process.exit(2);
  }
  console.log(`只跑点名的 ${要的界面.length} 个界面：${要的界面.join('、')}`);
}

// 页面里跑的体检函数。**注意这是模板字符串——里面不能出现反引号。**
// ⚠️ **这儿原来记着「吃过两次亏」，而底下那条自检注释早就写着「现在是第三次」——
// 一个会过期的数，记在两处，当场就对不上了。所以改成记症状：**模板提前结束之后，
// Node 报的是**注释那一行**的 ReferenceError（比如 art is not defined），
// 看起来像判据写错了，而真正的原因在几行之前的一对反引号里。
const PROBE = String.raw`
(() => {
  const bad = [];
  const vw = innerWidth, vh = innerHeight;
  if (document.documentElement.scrollWidth > vw + 1) {
    bad.push({ 类: '整页横向滚动', 值: document.documentElement.scrollWidth + ' > ' + vw });
  }

  /*
   * **封面上的字被右上角的角标压住。**
   *
   * 生成的封面左上起排书名，角标（格式 / ✎N / 读完 / 连载中 / ★N）浮在角上。
   * 没有真封面的书，**书名是唯一能认出它的东西**，压掉两个字这张卡就白画了。
   * 实测抓到的：一本 txt 打了 10 条笔记，「双格式的书」最后那个「书」整个躲在
   * ✎10 底下——而让位的那个浮动占位当时只在**格式角标**存在时才画。
   *
   * ⚠️ **比的是文字自己每一行的矩形（Range.getClientRects），不是块的矩形。**
   * 书名块是整宽的，浮动占位只让文字绕开角标、块本身照样和角标相交——
   * 拿块去比，每张带角标的卡都会报，全是假阳性。反过来，范围要划在
   * .book-art 上：角标是 .cover-ph 的**兄弟节点**，划在 cover-ph 里
   * 一条都量不到，而那个空结果看起来和「没问题」一模一样（两种错都真犯过）。
   */
  {
    const 交叠 = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    /*
     * ⚠️ **弹窗开着就不量。** 书架在每一个弹窗背后都还挂着，而这份探针每屏跑一次——
     * 不设范围的话，同一张被压住的卡会在四十来屏 × 五个分辨率上各报一次，
     * 一处问题变成上百行。孤字那条为同一件事加了 .book-art 排除，
     * 它上面那段注释记着实测：「每个分辨率 21 条，21 个界面各报一次同一个元素」。
     */
    const 有弹窗 = !!document.querySelector('.modal-backdrop');
    for (const art of (有弹窗 ? [] : document.querySelectorAll('.book-art'))) {
      const ph = art.querySelector('.cover-ph');
      if (!ph) continue;
      /*
       * ⚠️ **只收右上角那一列（.book-badge），别把 ★N 算进来。**
       * ★N 是 .book-rating，在卡片**底沿**的 .book-foot 里，而封面让位的那个
       * 浮动占位只让得出顶上几行——把它算进来，报出来的东西**没有任何改法能消掉**，
       * 而一条修不掉的告警很快就会被人整条删掉。
       */
      const 角标 = [...art.querySelectorAll('.book-badge')];
      if (!角标.length) continue;
      const P = ph.getBoundingClientRect();
      const 框 = 角标.map((g) => ({ g, r: g.getBoundingClientRect() }));
      let 报过 = false;
      const w = document.createTreeWalker(ph, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n && !报过; n = w.nextNode()) {
        if (!n.textContent.trim()) continue;
        const 盒 = n.parentElement ? n.parentElement.getBoundingClientRect() : P;
        const rg = document.createRange();
        rg.selectNodeContents(n);
        for (const rect of rg.getClientRects()) {
          /*
           * ⚠️ **被 -webkit-line-clamp 切掉的行也在这堆矩形里。**
           * Range 的矩形不认 overflow 裁剪：书名 clamp 到 4 行，第 5 行往后
           * 照样有坐标，一路排到卡片底下去——拿它去比，长书名会凭空报出
           * 一堆屏幕上根本看不见的「压住」。先和它自己那个盒子（clamp 之后的
           * 高度就是盒子的高度）以及封面框求交，只留真看得见的那部分。
           */
          const 可见 = {
            left: Math.max(rect.left, 盒.left, P.left),
            right: Math.min(rect.right, 盒.right, P.right),
            top: Math.max(rect.top, 盒.top, P.top),
            bottom: Math.min(rect.bottom, 盒.bottom, P.bottom),
          };
          if (可见.right <= 可见.left || 可见.bottom <= 可见.top) continue;
          for (const x of 框) {
            // 4px² 是抗锯齿和半像素的余量，不是「压一点没关系」
            if (交叠(可见, x.r) > 4) {
              bad.push({ 类: '封面上的字被角标压住', 元素: x.g.textContent.trim().slice(0, 8), 文: n.textContent.trim().slice(0, 14) });
              报过 = true;
              break;
            }
          }
          if (报过) break;
        }
      }
    }
  }

  const rgb = (s) => {
    if (!s) return null;
    const m = s.match(/[\d.]+/g); if (!m) return null;
    const v = m.slice(0, 3).map(Number);
    return s.startsWith('color(') ? v.map((x) => Math.round(x * 255)) : v;
  };
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = (a) => 0.2126 * lin(a[0]) + 0.7152 * lin(a[1]) + 0.0722 * lin(a[2]);
  const cr = (a, b) => { const x = L(a), y = L(b); const hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); };
  // 渐变也要认：封面是 linear-gradient 画的，只看 backgroundColor 会一路穿到页面底色
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') {
        const stops = [...s.backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)].map((m) => m[1].split(',').slice(0, 3).map(Number));
        if (stops.length) return stops;
      }
      const c = rgb(s.backgroundColor);
      /*
       * ⚠️ **半透明的底必须和它背后合成，不能拿原始色当底。**
       *
       * 这里原来是「只要 alpha 不是 0 就返回这个颜色」。于是
       * 「color-mix(in srgb, var(--accent) 12%, transparent)」（右轨和工具轨的 hover 底）
       * 被当成了**纯色的 accent**——「#262626」 的字压在纯 「#7b6135」 上算出 **2.60:1**，
       * 报「对比度不足」。而真实合成底是面板 + 12% 那点色 ≈ 「#f0eade」，实际约 11.9:1。
       *
       * **这个假阳性平时看不见**：它要求鼠标恰好停在那个键上。760×520 下布局一变，
       * CDP 的光标正好落在「底部」上，一口气报了 7 条——而同一份代码在别的分辨率下
       * 是 0 条。走查报出来的东西自己是假的时，比不报更贵：会有人去「修」一个没坏的地方。
       */
      const a = Number((s.backgroundColor.match(/[\d.]+/g) || [])[3] ?? 1);
      if (!c || a === 0) continue;
      if (a >= 1) return c;
      const 背后 = bgOf(e.parentElement);
      const 合成 = (b) => c.map((x, i) => Math.round(x * a + b[i] * (1 - a)));
      return Array.isArray(背后[0]) ? 背后.map(合成) : 合成(背后);
    }
    return [255, 255, 255];
  };
  const crBg = (fg, bg) => Array.isArray(bg[0]) ? Math.min(...bg.map((b) => cr(fg, b))) : cr(fg, bg);

  const seen = new Set();
  const push = (o) => { const k = JSON.stringify(o); if (!seen.has(k)) { seen.add(k); bad.push(o); } };

  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const tag = el.tagName.toLowerCase();
    const label = (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : tag).slice(0, 44);

    /*
     * ⚠️ **被祖先 clip-path 裁掉的不算跑出去。**
     *
     * 翻页模式是 CSS 多列，**后面几页本来就排在右边**，靠 .reader-body.page-mode 上
     * 那条 clip-path 裁掉，再用 translateX 把要看的那一列挪进来。
     * 于是段落的 rect 越过视口是**设计如此**：1024 宽下量到段落最右 1590，
     * 而截图上一个字都没漏出来。第一次跑窄窗口时它一口气报了三条，
     * 我差点去「修」一个不存在的溢出。
     *
     * 判据是「有没有祖先在裁」，不是特判某个类名——将来哪儿再用 clip-path 一样成立。
     *
     * ⚠️ **横向滚动容器同理。** 标签条改成一行横滚之后（照 legado 那条分组标签页），
     * 排在后面的 chip 的 rect 本来就越过视口——**它们被那个横滚容器裁着，
     * 滚一下就够得到**。不加这一支的话它一口气报了 13 条，
     * 而截图上一个 chip 都没漏在外面。
     *
     * 这条判据问的是「**用户够不够得到**」，而不是「rect 有没有越界」：
     * 被裁掉且无法滚动才是真跑出去，能滚到就不是。
     */
    const clipped = (() => {
      for (let e = el.parentElement; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.clipPath !== 'none') return true;
        if (/auto|scroll|hidden/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1) return true;
      }
      return false;
    })();
    if (!clipped && r.right > vw + 1 && r.left < vw && r.width < vw) {
      push({ 类: '跑出右边界', 元素: label, 值: Math.round(r.right) + ' > ' + vw });
    }
    if (!el.children.length && el.scrollWidth > el.clientWidth + 1 && s.overflowX === 'hidden' && s.textOverflow !== 'ellipsis') {
      push({ 类: '文字被硬切', 元素: label, 文: (el.textContent || '').trim().slice(0, 18) });
    }
    /*
     * **竖着被切断。** 上面那条只查横向，纵向这一类一直没人量，而它咬过两次：
     *
     *   - 搜索结果里那格标签：CSS 写着收成两行，而 clamp 加在**表格单元格**上，
     *     行高由表格说了算，clamp 不生效——142px 的内容切在 55px 上，
     *     最后一行从中间横着削掉半个字；
     *   - 卡片底部的标签行：写着「多的靠 +N 收口」，而装不下时**先掉行的正是
     *     那个 +N**，第二行又正好被 max-height 切掉——28 个标签的卡片上，
     *     「还有 25 个」这件事一个字都没说。
     *
     * 两条判据分开，因为病因不同：
     *   A. clamp 设了，却设在表格部件上 —— 那是**必然失效**的写法；
     *   B. 压根没 clamp，而内容比盒子高又 overflow:hidden —— 那就是硬切。
     *
     * 放过：clamp 真的生效的（浏览器自己画省略号，
     * ⚠️ 注意现代 Chromium 下它的 computed display 是 flow-root **不是 -webkit-box**，
     * 按 display 判会把好的也报进来——第一版就是这么报出 69 条的）、
     * 滚得到的（overflow-y auto/scroll）、以及正文和翻页模式（铁律 1、多列 + clip）。
     */
    const clamped = s.webkitLineClamp && s.webkitLineClamp !== 'none';
    if (clamped && /table/.test(s.display)) {
      push({ 类: 'clamp 加在表格单元格上，不生效', 元素: label, 值: s.display });
    }
    if (
      !clamped && s.overflowY === 'hidden' && el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0
      && s.textOverflow !== 'ellipsis'
      && !el.closest('.reader-text, .page-mode, .viewer-stage')
    ) {
      push({ 类: '竖着被切断', 元素: label, 值: el.scrollHeight + ' > ' + el.clientHeight, 文: (el.textContent || '').trim().slice(0, 16) });
    }
    /*
     * **书架卡片上那句短评被压成一行。**
     *
     * 这个应用的正事是「下次不用再想这本我看过没」，而它的兑现点就一处：
     * 「烂尾了别看」这句话要在**点开书之前**出现在卡片上。实测一行只印得下
     * 11-13 个字，而结论总在句子末尾——用户看到的是「前面三卷神作，后面像换」，
     * 真正有用的那半正好被切掉。
     *
     * **钉的是效果不是那个 CSS 属性值**：一句装不下一行的短评，必须排到两行。
     * 属性名将来怎么改都行，一行就是错的。
     */
    if (el.classList.contains('book-note')) {
      const lh = parseFloat(s.lineHeight) || 1;
      const lines = Math.round(el.getBoundingClientRect().height / lh);
      // 一行装得下的短评本来就只有一行，那不算问题——要看它是不是**被压**成一行
      const oneLineFits = el.scrollHeight <= lh * 1.5;
      if (lines < 2 && !oneLineFits) {
        push({ 类: '卡片上的短评被压成一行，结论那半看不到', 文: (el.textContent || '').trim().slice(0, 16) });
      }
    }
    /*
     * **最后一行只剩一个字。**
     *
     * 中文在任意两个汉字之间都能断行，所以一句话很容易折成
     * 「……当场跟着」/「变」——第二行一个孤字，看起来像没写完。
     * 一轮界面走查里这个形状出现了三次（书架卡片的「2 万」/「字」、
     * 设置里标签的「……每行字数」/「数」、说明句的「……当场跟着」/「变」），
     * 而上面那些判据一条都不响：没有溢出、没有截断、对比度也好好的。
     *
     * 判据：把 Range 的矩形按行归并，行数 ≥ 2 且最后一行窄于 1.35em。
     * 一个汉字正好 1em，两个字 2em，所以 1.35 卡在中间。
     *
     * ⚠ **getClientRects() 给的是「文本段」不是「行」。** 中英混排在同一行上
     * 也会返回两个矩形——第一版直接拿 rects.length 当行数，于是
     * 「字号 21px」「100%」「第 25 / 25 章」这些**单行**的东西全被报成孤字，
     * 四个分辨率一口气 128 条假警报。所以要先按 top 聚成行（同一行的
     * 中文段和西文段基线不同，top 会差几像素，用 0.6em 当容差）。
     *
     * 四处不看：
     *   - **书里的字**（.reader-text 里的正文、卡片上的书名）：那是用户的书，
     *     我们不改一个字（铁律 1），报出来也没法修，只会把这条判据变成噪音。
     *     ⚠ 书名在卡片上有**两处**：封面下方那行是 .book-title，
     *     画在占位封面上的那份竖排在题签上（.cover-ph 里那个 span）。
     *     只排除 .book-title 的话后者照报——实测每个分辨率 21 条（书架在每个
     *     弹窗背后都在，于是 21 个界面各报一次同一个元素）。
     *     ⚠️ **书名现在有三处**：书评册的落款（.rv-book）和表格里那一列（.cell-open）。
     *     那一档没有封面，书名本身就是「打开这本书」那个键——同样是用户的书名，
     *     同样一个字都改不了。（有作者时它有子元素、这条判据本来就跳过；
     *     没作者的书它是叶子，所以还是得点名。）
     *     占位封面因此有了个**只给走查用、不接任何样式**的类名 .cover-ph
     *     （见 Cover.tsx）：光圈 .book-art 还漏两条——编辑弹窗顶上那个封面预览
     *     也是同一个组件，但它不在书架的 .book-art 里面。
     *     顺带记一句省得下次当成回归：书名现在竖排在左上角那张题签上
     *     （renderer/cover-art.ts 的「题签字号」——⚠️ 这一段是模板字符串里的探针，
     *     写反引号会当场把它切断，别在这儿用），折行和字号都跟着卡片宽度走，
     *     首行能放的字数因此少两三个——同一本书「读完」前后折得不一样。
     *   - **真被截断了的**（末尾是「…」）：那是有意截断，不是孤字。
     *     ⚠ **判据是「有没有真的溢出」，不是「有没有设 line-clamp」。**
     *     原来要求 webkitLineClamp 等于 none，而书架卡片那行
     *     （.book-sub，-webkit-line-clamp: 2）正是这条判据的头号病人——
     *     「2 万」/「字」就出在它身上，却因为设了 clamp 而永远报不出来，
     *     shell.css 那条 word-break: keep-all 因此一个守卫都没有。
     *     内容装得下两行时 clamp 不会画省略号，孤字照样是孤字。
     *   - **断点是随便挑的**（overflow-wrap: anywhere）：路径、文件名那些格子
     *     本来就从中间硬断，最后一行短窄纯属概率，报出来全是噪音。
     *   - **纯行内元素**（display: inline）：一段话里加粗的那几个字换行时
     *     也会「最后一行只剩一个字」，但**那一行后面还接着别的字**，看起来
     *     一点问题都没有。实测「这里加的源排在它们之／后，前面都没找到才会问」
     *     被报了三个分辨率——句子是连着的，孤的只是 strong 自己。
     *     判据要看**块**的最后一行，所以行内的跳过（flex 子项会被块化成
     *     block，settings 那些 .field 里的说明照样查得到）。
     */
    if (!el.children.length && !el.closest('.reader-text')
        && !el.matches('.book-title, .rv-book, .cell-open') && !el.closest('.book-art, .cover-ph')
        && (el.textContent || '').trim().length >= 4
        && s.display !== 'inline' && s.display !== 'contents'
        && s.textOverflow !== 'ellipsis' && s.overflowWrap !== 'anywhere'
        && el.scrollHeight <= el.clientHeight + 1) {
      const px = parseFloat(s.fontSize);
      const rg = document.createRange();
      rg.selectNodeContents(el);
      const rows = [];
      for (const q of [...rg.getClientRects()].filter((x) => x.width > 0.5).sort((a, b) => a.top - b.top)) {
        const cur = rows[rows.length - 1];
        if (cur && q.top - cur.top < px * 0.6) { cur.l = Math.min(cur.l, q.left); cur.r = Math.max(cur.r, q.right); }
        else rows.push({ top: q.top, l: q.left, r: q.right });
      }
      const last = rows[rows.length - 1];
      if (rows.length >= 2 && last.r - last.l < px * 1.35) {
        push({ 类: '最后一行只剩一个字', 元素: label, 文: (el.textContent || '').trim().slice(-14) });
      }
    }
    /*
     * 点击目标：24px 是 WCAG 2.2 AA 的下限，**但那条准则自带间距豁免**——
     * 以每个目标为心画直径 24 的圆，圆不碰到别的目标就算合格。
     *
     * ⚠️ **pointer-events: none 的不算目标**，两头都不算：既不该因为它小而报，
     * 也不该拿它去挤别人的豁免圈。书架卡片那排工具条平时是折起来的
     * （height 0 加 pointer-events none，为的是留在 tab 序里，见 shell.css 那段），
     * 它有个 22x3 的盒子但**根本点不到**。
     * 不排掉的话：它自己报一条，还会把弹窗里那些 20x20 复选框的间距豁免
     * 一起破坏掉——那些复选框离它十万八千里，只是隔着遮罩在同一个视口里。
     * 一条把点不到的东西算成点击目标的判据，报出来的全是假的。
     */
    const clickable = (x) => {
      const cs = getComputedStyle(x);
      return cs.pointerEvents !== 'none' && cs.visibility !== 'hidden';
    };
    /*
     * **只和同一层的目标比。**
     * 弹窗开着的时候，背后书架上的按钮虽然还在视口里、坐标上也可能只隔几个像素，
     * 但**隔着一层挡住点击的遮罩，点不到**——拿它去挤弹窗里那个复选框的
     * 间距豁免圈，报出来的是假的。实测过一次：书库文件夹里一个 20x20 的复选框
     * 被背后书架上的「★4+」判成「挨得近」，两者相距 7px，而中间隔着遮罩。
     * 和上面那条 pointer-events 的排除是同一个道理，只是这次隔开它们的是层次。
     */
    const layerOf = (x) => x.closest('.modal') || document.body;
    if ((tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select') && !el.disabled
        && (r.width < 24 || r.height < 24) && clickable(el)) {
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let crowded = false;
      for (const o of document.querySelectorAll('button, a, input, select')) {
        if (o === el || o.disabled) continue;
        const q = o.getBoundingClientRect();
        if (!q.width || !q.height) continue;
        if (!clickable(o)) continue;
        if (layerOf(o) !== layerOf(el)) continue;
        if (Math.hypot(q.left + q.width / 2 - cx, q.top + q.height / 2 - cy) < 24) { crowded = true; break; }
      }
      if (crowded) push({ 类: '点击目标偏小且挨得近', 元素: label, 值: Math.round(r.width) + 'x' + Math.round(r.height) });
    }
    if (!el.children.length && (el.textContent || '').trim().length > 1) {
      const fg = rgb(s.color);
      if (fg) {
        const ratio = crBg(fg, bgOf(el));
        const px = parseFloat(s.fontSize);
        const need = (px >= 24 || (px >= 18.66 && Number(s.fontWeight) >= 700)) ? 3 : 4.5;
        if (ratio < need) push({ 类: '对比度不足', 元素: label, 值: ratio.toFixed(2) + ' < ' + need, 文: (el.textContent || '').trim().slice(0, 14) });
      }
    }
  }


  /*
   * **浮层盖住了阅读器那两条工具轨。**
   *
   * 这一整类前面五轮走查一条都报不出来：探针查横向溢出、裁切、点击目标、
   * 对比度、文字被硬切、最后一行只剩一个字——**没有一条查「这个键还点不点得到」**。
   * 真出过事：窄屏（<=900）那套把两条轨从两侧竖排改成底部横排，而 .toc 和
   * .reader-pop 两个绝对定位的浮层没跟着改，于是 760x520 上一点「目录」，
   * 14 个键一个都点不动——**而那五个分辨率当时全 0**。
   *
   * 判据故意**只管这两条轨**，不管「所有被盖住的控件」：浮层压住背后的正文和
   * 卡片是它的本分（评价浮层就压在书架上），一律管进来会是一片假警报，
   * 而一条会吵的判据很快会被人删掉。这两条轨是阅读器的常驻家什，
   * **任何时候都不该有东西压在上面**。
   *
   * ⚠️ **有遮罩的弹窗不算**：那层遮罩本来就该挡住背后一切
   * （判据同 modal-a11y 的「有没有那层挡住点击的遮罩」）。
   *
   * ⚠️ **判据是 elementFromPoint 打在键的中心，看最上面的是不是它自己**，
   * 不是矩形相交——后者会把「盖了但没盖住中心」也报出来。
   */
  if (!document.querySelector('.modal-backdrop')) {
    for (const b of document.querySelectorAll('.reader-rail button, .reader-tools button')) {
      if (b.disabled) continue;
      const q = b.getBoundingClientRect();
      if (q.width < 4 || q.height < 4) continue;
      const cs = getComputedStyle(b);
      if (cs.pointerEvents === 'none' || cs.visibility === 'hidden') continue;
      const cx = q.left + q.width / 2, cy = q.top + q.height / 2;
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;
      const top = document.elementFromPoint(cx, cy);
      if (!top || top === b || b.contains(top) || top.contains(b)) continue;
      const who = top.closest('.toc, .reader-pop, .reader-panel, .card') || top;
      const cls = String(who.className || '').split(/\s+/)[0] || who.tagName;
      push({ 类: '浮层盖住了工具轨上的键', 元素: (b.textContent || '').trim().slice(0, 8), 值: '被 ' + cls + ' 盖住' });
    }
  }

  /*
   * **浮层出没出屏幕。** 单开一个循环，只查「出界」和「超高又不能滚」这两条。
   *
   * ⚠ **别把浮层并进下面那个 .modal 循环里图省事。** 试过一次：同一个循环里还有
   * 第三条判据（弹窗页脚没标 .modal-actions），而浮层根本没有主按钮，
   * 于是它去挑「最后一个非关闭按钮」，挑中了目录里的一条章节和搜索框旁边的
   * 「搜索」键，五个分辨率一起报两条假的。这个文件里早写着：那种界面
   * **正确答案是不查，不是报一条**。
   *
   * 为什么要有这一条：一本书打 28 个标签，评价浮层（.rate-pop，这个应用最核心的
   * 那个动作）在 1440x900 下出界 95px、760x520 下出界 527px，而且 overflow 是
   * visible、max-height 是 none —— 滚都滚不动，底下那截永远够不到。
   * 而当时走查五个分辨率报的是 0 条：判据本身是对的，坏的是它扫的范围。
   * **加一条判据之前先问一句它扫的是哪几屏。**
   *
   * ⚠ 这一段里一个反引号都不能有：外面是 String.raw 模板（症状见文件顶上那条）
   * ——写这段说明时又踩了一次，node --check 报的是 Unexpected token，一眼看不出跟注释有关。
   */
  for (const p of document.querySelectorAll('.rate-pop, .toc, .reader-pop')) {
    const r = p.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(p);
    const 能滚 = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
    const cls = '.' + String(p.className || '').split(/\s+/)[0];
    if (r.top < -1 || r.bottom > vh + 1) {
      push({ 类: '浮层超出屏幕', 元素: cls, 值: Math.round(r.top) + '~' + Math.round(r.bottom) + ' / 视口 ' + vh });
    }
    if (r.height > vh - 8 && !能滚) {
      push({ 类: '浮层超高且不能滚', 元素: cls, 值: Math.round(r.height) + ' > ' + vh });
    }
  }

  for (const m of document.querySelectorAll('.modal, .reader-panel')) {
    const r = m.getBoundingClientRect();
    const s = getComputedStyle(m);
    if (r.height > vh - 8 && s.overflowY !== 'auto' && s.overflowY !== 'scroll') {
      push({ 类: '弹窗超高且不能滚', 元素: '.' + String(m.className).split(/\s+/).join('.'), 值: Math.round(r.height) + ' > ' + vh });
    }
    if (r.top < -1 || r.bottom > vh + 1) {
      push({ 类: '弹窗超出屏幕', 元素: '.' + String(m.className).split(/\s+/).join('.'), 值: Math.round(r.top) + '~' + Math.round(r.bottom) });
    }

    /*
     * **主按钮要滚多远才够得到。**
     *
     * 上面那两条量的是「弹窗溢出屏幕」，而**能滚的弹窗照样可以把主按钮埋在第二屏**，
     * 于是一路绿灯。实测「编辑一本书」在 1280×720 下「保存」要往下滚 449px——
     * 而书名 / 作者 / 别名这几个字段只在点它时才落库，不滚就关掉等于白改。
     * 能滚不等于找得到，是两条判据。
     *
     * ⚠ **不要用 offsetTop 算这个数**：.modal 自己没有 position，
     * offsetParent 是那个 fixed 的遮罩层，弹窗一居中，视口越高 offsetTop 越大——
     * 第一版就是这么写的，量出来 1920×1080 要滚的比 1280×720 还多。
     * **「一个数在更大的屏幕上更糟」这种反常，比断言失败更早暴露探针错误。**
     * 位置要按弹窗自己的滚动坐标算。
     *
     * 底部动作行用 position: sticky 粘住之后，它的 rect 就在视野里，这个数自然是 0。
     */
    const notClose = (b) => !/关闭|取消|再看看|不用了|知道了|先不管/.test(b.textContent || '')
      && !b.closest('.card');
    /*
     * **页脚里有主按钮却没标 .modal-actions：报出来。**
     * 下面那条判据只认 .modal-actions，没标的整条不跑、还一声不吭——
     * 真漏过四个（添读过的书 / 批量打标签 / 批量改名 / 整理书名）。
     *
     * ⚠ 这一条**不能塞进下面那个「弹窗超高」的 if 里**（第一版就塞错了，
     * 破坏实验一条都报不出来）：标记缺不缺是写法问题，跟此刻这个弹窗
     * 在这个分辨率下滚不滚得动无关。
     */
    /*
     * ⚠️ **阅读设置浮层不查这一条。** 它不是弹窗，是个浮层：**没有页脚、
     * 也没有主按钮**——每一格改了就生效。而这条判据拿 lastElementChild
     * 当页脚，于是把「试听一句」那一行当成了没标记的页脚，五个分辨率各报一条。
     *
     * 这和本文件记过的那次一模一样：「主按钮要滚动才够得到」原来挑中了
     * 「书库文件夹」里的「添加」和阅读设置里的「左右翻」——那两个界面
     * **根本没有主按钮**，**正确答案是不查，不是报一条**。
     */
    const foot = m.classList.contains('reader-panel') ? null : m.lastElementChild;
    const missed = foot && !foot.classList.contains('modal-actions')
      && [...foot.querySelectorAll('button')].filter(notClose)[0];
    if (missed) {
      push({ 类: '弹窗页脚没标 .modal-actions，主按钮那条没查', 元素: (missed.textContent || '').trim().slice(0, 12) });
    }

    if (m.scrollHeight > m.clientHeight + 1) {
      /* **只看页脚里那个主按钮**，不看别的。
         这条判据的原意是「改完不点它就白改」——编辑一本书 的「保存」在
         1280x720 下要往下滚 449px，而书名作者只在点它时才落库。

         判据是**在不在 .modal-actions 那条页脚里**，不是「最后一个非关闭按钮」。
         后者在窄窗口上会挑错人：书库文件夹 挑中了屏蔽规则那一行的「添加」
         （760 宽下报 138px）、阅读设置浮层挑中了「左右翻」（176px）——
         两个都是**段落级的动作**，而且都紧挨着你刚填的那个输入框，
         用到它的时候本来就已经滚到那儿了。这两个界面**根本没有主按钮**
         （改动即时生效，页脚只有「关闭」），所以正确答案是不查，不是报一条。
         代价是**没标 .modal-actions 的弹窗整条判据都不跑**，而且不吭声——
         审计时真漏过四个（添读过的书 / 批量打标签 / 批量改名 / 整理书名，
         它们的页脚里全是「点了才落库」的按钮）。所以下面补了一条：
         页脚里有主按钮却没标这个类的，直接报出来。**探针宁可说「我查不了」，
         也不能默默跳过**——同本仓库「一个静默找不到任何东西的扫描器比没有更糟」。

         顺带保留原来那条：列表项自己的按钮（.card 里面）不算——
         「重复的书」一组一张卡，滚到第 6 组去点它**本来就该滚**（真实库上报过 1078px）。 */
      const main = [...m.querySelectorAll('.modal-actions button')].filter(notClose).pop();
      if (main) {
        const q = main.getBoundingClientRect();
        const bottom = q.top - r.top + m.scrollTop + q.height;
        const need = Math.round(bottom - m.clientHeight);
        // 留 8px 余量给边框和四舍五入
        if (need > 8) {
          push({ 类: '主按钮要滚动才够得到', 元素: (main.textContent || '').trim().slice(0, 12), 值: need + 'px' });
        }
      }

      /*
       * **出口也要够得到——这是另一个问题。**
       *
       * 上面那条只问「主按钮」，而有整整一类弹窗**根本没有主按钮**：
       * 改动即时生效，页脚只有一个「关闭」。上面那段注释说得对——对那些界面
       * 「正确答案是不查，不是报一条」。可它随后就把这些弹窗**整个放过了**，
       * 而它们的「关闭」照样会掉到折叠线以下：实测 760x520 下
       * 标签管理 73px、书库文件夹 234px（只有 11 本书 28 个标签的测试库上），
       * 而走查从头到尾是绿的。
       *
       * 「够不够得到那个改完要点的键」和「够不够得到那个走人的键」是两个问题。
       * 这里补第二个。同样不看 .card 里的——列表项自己的「取消」滚到那儿本来就该滚。
       */
      const 出口 = [...m.querySelectorAll('button')]
        .filter((b) => /关闭|取消|再看看|不用了|知道了|先不管/.test(b.textContent || '') && !b.closest('.card'))
        .pop();
      if (出口) {
        const q2 = 出口.getBoundingClientRect();
        const need2 = Math.round(q2.top - r.top + m.scrollTop + q2.height - m.clientHeight);
        if (need2 > 8) {
          push({ 类: '出口要滚动才够得到', 元素: (出口.textContent || '').trim().slice(0, 12), 值: need2 + 'px' });
        }
      }
    }
  }
  return JSON.stringify(bad);
})()
`;

const stats = await guardTestLibrary();
/*
 * **空库要当场说清楚，不要报一墙「打不开」。**
 * 一个刚建的 --user-data-dir 还没加书库时，几乎每个界面都开不出来
 * （没有书就没有卡片，也就点不到「编辑」「评价」这些），
 * 报告上是十几条「打不开」——看起来像应用坏了，其实是我忘了加书库。
 * 同本仓库「一个静默找不到任何东西的扫描器比没有更糟」，
 * 只是这次不是静默，是**噪声盖住了真正的原因**。
 */
if (!stats.books) {
  console.error('✗ 这个库里一本书都没有，走查没法量——先给这个档案加一个测试书库目录');
  console.error('  （走 rpc：POST /api/rpc  {"method":"root.add","params":{"path":"<书库目录>"}}）');
  process.exit(1);
}
/*
 * ⚠️ **先 connect 再 seed。** `connect()` 里有两道守卫（这是不是真实库、
 * 调试端口那头是不是我这份构建），而 `seedReviewData()` 是**走 HTTP 往库里写**
 * （加引擎、打标签、改状态）。反过来的话：端口 30036/9876 谁先绑上算谁的、
 * 未必是同一个实例，于是**先把另一份检出的库写脏了，再报一句「拒绝运行」**。
 * 这就是本文件自己那句「把关的对象和驱的对象不是同一个」，只是关卡晚了一步。
 */
const { send, ev, wait, reload, close } = await connect();
// **空壳弹窗量不出版面问题**：标签管理/批量打标签/我的书评在没数据时几乎是空的。
// 先塞几个标签和两条书评（已经有就跳过），理由见 cdp.mjs 那段
const seed = await seedReviewData();
if (seed.seeded) console.log(`塞了 ${seed.tags} 个标签和两条书评，好让那几个界面有东西可量`);

/**
 * **自检：先证明这个探针抓得住东西。**
 * 往页面里塞一个必然不合格的元素（4px 的按钮、1.2:1 的文字），探针必须报出来。
 * 一个永远报 0 条的体检和没有体检是一回事——这一轮里探针自己错过六次。
 */
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await reload();
await ev(`(() => {
  const d = document.createElement('div');
  d.id = '__selftest';
  /*
   * 样本要把应用自己的按钮样式压掉：button 有 padding 和 1px 边框，
   * 写 width:4px 实际会渲染成 26.9x10.9，两个的中心相距 27px——
   * 正好满足 WCAG 2.5.8 的间距豁免，探针不报它是对的。
   * 第一版就栽在这儿：自检失败，而探针其实没坏。
   */
  d.innerHTML = '<button style="all:unset;display:inline-block;width:8px;height:8px;background:#000"></button>'
    + '<button style="all:unset;display:inline-block;width:8px;height:8px;background:#000"></button>'
    + '<span style="color:#eee;background:#fff">看不清的字</span>'
    /* 孤字：第二行只剩「变」。
       **用 pre-line 加一个换行，不靠调容器宽度去卡断点**——第一版写死
       width:170px 想让第 17 个字掉下去，实际按字宽算是 10 个字一行，
       第二行有 7 个字，根本不是孤字，自检直接红。
       断点由 CSS 决定的时候，字体一换这个夹具就失效了。

       ⚠ 换行**写成 HTML 实体 &#10;**，别在这儿敲反斜杠 n：这段字符串外面
       套着 audit.mjs 自己的模板字符串（所以这一整段注释里也不能出现反引号，
       症状见文件顶上那条），
       反斜杠 n 会在发出去之前就变成真的换行符，
       页面拿到的是一个断成两行的字符串字面量——整个夹具语法错误，
       于是三条自检**一起**变成 false（看起来像探针全坏了，其实一行都没跑）。 */
    + '<p id="__orphan" style="width:400px;font-size:16px;white-space:pre-line;margin:0">'
    + '在阅读器里调改一下整页正文当场就&#10;变</p>'
    /* 孤字，但**这一段设了 -webkit-line-clamp: 2**（书架卡片那行就是这么写的）。
       两行装得下，clamp 不会画省略号，所以它必须照样被报出来——
       判据看的是「有没有真的溢出」，不是「有没有设 clamp」。
       没有这条夹具，把判据改回「只看没设 clamp 的」也照样全绿。 */
    + '<p id="__clamped" style="width:400px;font-size:16px;white-space:pre-line;margin:0;'
    + 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">'
    + '读完了会自动标上已读完当场就&#10;好</p>'
    /* **诱饵：中英混排的单行，它必须不被报出来。**
       getClientRects() 给的是「文本段」不是「行」——中文段和西文段在同一行上
       也是两个矩形。第一版直接拿 rects.length 当行数，把这种单行的东西
       全报成孤字，四个分辨率一口气 128 条假警报。
       所以这条断言是反着来的，同 AGENTS.md 里 readOnly 那条
       「故意用错误写法证明它可写」。 */
    /* 浮层盖键：左边那个被绝对定位的白块压住（必须报），右边那个没有（必须不报）。
       少了后一个诱饵，把判据写成「轨上的键一律报」也能全绿。

       ⚠ 容器必须 position:fixed 钉在左上角，而且 flex-direction 要写成 row。
       不写的话应用**自己那条 .reader-rail 规则**会作用到这个夹具上
       （absolute + top:2rem + left:calc(...) + flex-direction:column），
       它被顶到 y=932 —— 而自检跑在 1440x900 上，**整个夹具在视口外**，
       elementFromPoint 返回 null，两条断言一起变成 false。
       第一版就是这么红的，看起来像判据坏了，其实是诱饵没在屏幕上。 */
    + '<div class="reader-rail" style="position:fixed;left:0;top:0;display:flex;flex-direction:row;gap:8px;z-index:99999">'
    + '<button style="all:unset;display:block;width:40px;height:40px;background:#ccc">目录</button>'
    + '<button style="all:unset;display:block;width:40px;height:40px;background:#ccc">搜索</button>'
    + '<div style="position:absolute;left:0;top:0;width:40px;height:40px;background:#fff;z-index:9"></div>'
    + '</div>'
    /* 封面角标压住书名：左边这个必须报，右边那个（角标在书名下方）必须不报。
       少了后一个诱饵，把判据写成「有角标就报」也能全绿——而那正是第一版
       拿**块**的矩形去比时的样子：每张带角标的卡片全中。 */
    + '<div class="book-art" id="__cover_bad" style="position:relative;width:120px;height:60px">'
    + '<div class="cover-ph" style="width:120px;height:60px;background:#333;color:#fff">压住的书名</div>'
    + '<span class="book-badge" style="position:absolute;left:0;top:0;background:#000;color:#fff">压 9</span>'
    + '</div>'
    + '<div class="book-art" id="__cover_ok" style="position:relative;width:120px;height:120px">'
    + '<div class="cover-ph" style="width:120px;height:120px;background:#333;color:#fff">让开的书名</div>'
    + '<span class="book-badge" style="position:absolute;left:0;top:96px;background:#000;color:#fff">让 9</span>'
    + '</div>'
    + '<p id="__decoy" style="width:600px;font-size:16px;margin:0">字号 21px 行距 1.8 倍 每行 53 字</p>';
  document.body.appendChild(d);
  return 1;
})()`);
const selfRaw = await ev(PROBE);
const self = JSON.parse(selfRaw);
await ev("(() => { document.getElementById('__selftest')?.remove(); return 1; })()");
const caughtSmall = self.some((b) => b.类.includes('点击目标'));
const caughtColor = self.some((b) => b.类 === '对比度不足');
const orphans = self.filter((b) => b.类 === '最后一行只剩一个字');
// 报出来的「文」是原样截的，夹具里那个换行符还在里面——
// 直接 endsWith('当场就变') 永远不成立，第一版就是这么把自检写红的
const endsWith = (t) => orphans.some((b) => b.文.replace(/\s+/g, '').endsWith(t));
const caughtOrphan = endsWith('当场就变');
const caughtClamped = endsWith('当场就好');
const falsePositive = orphans.some((b) => b.文.includes('每行 53 字'));
const 压住 = self.filter((b) => b.类 === '封面上的字被角标压住');
const caughtCoverText = 压住.some((b) => b.文.includes('压住的书名'));
const coverTextFalse = 压住.some((b) => b.文.includes('让开的书名'));
const covers = self.filter((b) => b.类 === '浮层盖住了工具轨上的键');
const caughtCover = covers.some((b) => b.元素 === '目录');
const coverFalse = covers.some((b) => b.元素 === '搜索');
if (!caughtSmall || !caughtColor || !caughtOrphan || !caughtClamped || falsePositive || !caughtCover || coverFalse
  || !caughtCoverText || coverTextFalse) {
  console.error('✗ 自检没过——探针坏了，先修它：'
    + `小目标 ${caughtSmall}，低对比 ${caughtColor}，孤字 ${caughtOrphan}，`
    + `夹在 line-clamp 里的孤字 ${caughtClamped}，中英混排被误报 ${falsePositive}，`
    + `浮层盖键 ${caughtCover}，没被盖的键被误报 ${coverFalse}，`
    + `角标压住书名 ${caughtCoverText}，没被压的被误报 ${coverTextFalse}`);
  close();
  process.exit(1);
}
console.log('自检通过：该抓的抓住了，不该抓的没误报\n');

const report = {};
for (const [W, H] of RES) {
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await reload();
  const res = `${W}x${H}`;
  report[res] = {};
  /*
   * **一屏第一次打不开先重来一遍，第二次才算数。**
   *
   * 这个环境里偶尔会有一两屏开不起来，而且**每次换位置**：一轮是 PDF 查看器
   * （1280 和 1440），下一轮全过，再下一轮变成 1440 的 PDF 加「书签与划线」。
   * 单独驱动 PDF 那一屏 5 次，216–827ms 就画出来了——**不是慢，是环境性偶发**。
   *
   * 给某一屏单独加重试治不了：点进查看器之后书架已经卸载，再点也点不着。
   * 所以重试放在**整屏**这一级：收尾、回到书架、整屏重来。
   * 真坏掉的界面会连着失败两次，照样报出来；而「一条偶尔变红的走查和一条
   * 永远绿的一样没用」——两种情况下人都不会再去看它。
   */
  const 重试过 = new Set();
  for (let si = 0; si < SURFACES.length; si++) {
    const s = SURFACES[si];
    // 只跑点名的那几个界面（不点名就全跑）
    if (要的界面.length && !要的界面.includes(s.name)) continue;
    /* **收干净再开下一个，不能只点一层。**
       原来这里只点一次 `.modal-backdrop`，而有些界面会叠两层（「在线地址」是
       编辑弹窗里再开一个）。剩下那层会一直留到后面的界面上，探针于是量到了
       压在底下的东西——实测「在线地址」报出一个 20×20 的复选框，
       而那个复选框在**设置**里，跟这个界面毫无关系。
       报错报到不相干的界面上，比不报更费时间。 */
    await ev("(() => { for (let i=0;i<5;i++) { const b=document.querySelector('.modal-backdrop'); if(!b) break; b.click(); } return 1; })()");
    await wait(400);
    await ev("(() => { for (let i=0;i<3;i++) window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return 1; })()");
    await wait(250);
    /*
     * ⚠️ **`ev()` 出错时返回的是字符串 `ERR …`，那是个真值。**
     *
     * 于是 `if (!ok)` 和轮询里的 `!(await ev(has))` 都会把「页面里那段表达式抛了异常」
     * 读成「成功」——`open` 那一大串 IIFE 一旦踩到 null，报告上是干干净净的 0 条，
     * 而那一屏根本没打开。同一个文件反复警告的
     * 「一个静默什么都没查的扫描器比没有更糟」，换了个入口又出现一次。
     */
    const isErr = (v) => typeof v === 'string' && v.startsWith('ERR ');

    let ok = 1;
    if (s.nav) {
      /*
       * **低频的那几个收进「更多工具」了**，主栏上直接找不到（别记个数，名单会变）。
       * ⚠️ 点完那个折叠键之后 **DOM 不是同步更新的**（React 那一下要等一帧），
       * 所以必须轮询——同一个表达式里点完就找，永远找不到。
       */
      const 找 = `[...document.querySelectorAll('.nav-tool')].find(x=>x.textContent.trim()===${JSON.stringify(s.nav)})`;
      if (!(await ev(`!!${找}`))) {
        await ev("(() => { const m=[...document.querySelectorAll('.nav-tool')].find(x=>x.textContent.trim().startsWith('更多工具')); if(m) m.click(); return 1; })()");
        for (let i = 0; i < 20 && !(await ev(`!!${找}`)); i++) await wait(150);
      }
      ok = await ev(`(() => { const b=${找}; if(!b) return 0; b.click(); return 1; })()`);
    }
    else if (s.editor) {
      /* 先开「编辑一本书」，等它把详情取回来（那个弹窗是异步渲染的），再点里面那个按钮。
       *
       * ⚠️ **必须挑一本 txt，不能拿「第一张卡」。** 原来是
       * `querySelectorAll('.book-tools button').find(文本==='编辑')`，也就是
       * **DOM 里第一张卡**——而书架默认按「读过的排最前」排，走查自己点开过的
       * PDF / EPUB 就会排到最前面。那两种格式的编辑弹窗里**没有**「章节怎么切…」
       * 和「导出…」（只编目的书切不了章、也导不出目录格式，那是有意的），
       * 于是这两屏报「打不开」，而报出来的样子和「界面坏了」一模一样。
       * 实测就是这么红的：760×520 那一轮红，别的分辨率绿，**只因为卡片顺序不同**。
       * 「改名」一直是绿的——它对 PDF 照样成立，所以留着。那个对照正好指出了病因。
       */
      ok = await ev("(() => { const c=[...document.querySelectorAll('.book')]"
        + ".find(x => !/文件缺失|未解析|PDF|EPUB|只有记录/.test(x.textContent));"
        + " const b=c && [...c.querySelectorAll('.book-tools button')].find(x=>x.textContent.trim()==='编辑');"
        + " if(!b) return 0; b.click(); return 1; })()");
      const 找 = `[...document.querySelectorAll('.modal .mini')].find(x=>x.textContent.trim()===${JSON.stringify(s.editor)})`;
      for (let i = 0; i < 40 && !(await ev(`!!${找}`)); i++) await wait(200);
      ok = await ev(`(() => { const b=${找}; if(!b) return 0; b.click(); return 1; })()`);
    }
    else if (s.card) ok = await ev(`(() => { const b=[...document.querySelectorAll('.book-tools button')].find(x=>x.textContent.trim()===${JSON.stringify(s.card)}); if(!b) return 0; b.click(); return 1; })()`);
    else if (s.open) ok = await ev(s.open);
    /* **打不开也要收尾。** `open` 里的写操作往往排在「找得到那张卡吗」前面——
       翻页模式那条一进门就把 `mode:'page'` 写进 localStorage，然后才 `return 0`。
       不收尾的话后面所有界面、所有分辨率都在翻页模式下量，而报告上一点异常都没有。 */
    if (isErr(ok) || !ok) {
      if (s.close) { await ev(s.close); await wait(900); }
      if (!重试过.has(s.name)) { 重试过.add(s.name); si--; continue; }
      report[res][s.name] = [{ 类: isErr(ok) ? '打开时报错' : '打不开', ...(isErr(ok) ? { 值: ok.slice(4, 120) } : {}) }];
      continue;
    }
    /* **开没开要验一下。** 这条 surface 的 open 里有个 setTimeout，第一版写的
       等待比它还短——探针跑完浮层才出现，报出来是干干净净的「0 条」。
       一个静默什么都没查的扫描器比没有更糟，这个仓库栽过。

       **等法是轮询，不是 `await wait(s.wait)`。** 固定等待是假失败的头号来源
       （README 里那条，`walk.mjs` 早就改成轮询了，这里是最后一处没跟上的）：
       同一次运行里「书内搜索」在 1920×1080 报了「没打开」，紧接着重跑就干净——
       等的是同一个 3400ms，只是那一次开书慢了一点。一条**偶尔**变红的走查，
       和一条永远绿的一样没用，因为两种情况下人都不会去看它。

       ⚠️ **`s.wait` 是下限，不是上限**——轮询只负责往后延，不许提前收工。
       多数 surface 的 `expect` 是通用的 `.modal`，而它们的 `open` 是一串
       `setInterval` 点击（在线地址：先开「编辑一本书」，那个**也是 `.modal`**，
       再等 150ms 去点「在线地址」）。元素一成立就量，量到的是链子中间那一屏，
       而 `.modal` 的复查照样通过——报告干干净净，量的却是别的界面。
       那几个 1600 / 1800 / 3400 是当初一屏一屏试出来的，不能被轮询吃掉。

       上限取 `max(s.wait, 8000)`：真打不开的界面原来只烧 `s.wait`，
       别让它变成 `s.wait + 8000`（书签与划线 3.4s → 11.4s，四个分辨率 +32 秒）。 */
    const settle = s.wait ?? 800;
    if (s.expect) {
      const t0 = Date.now();
      /* `ready`：**判据比「那个元素在不在」更硬**时用它（写一段返回布尔的表达式）。
         EPUB 那一屏就非要它不可——「iframe 存在」这种弱判据，正是当初让
         「iframe 高度塌成 0」蒙混过关的那一条。 */
      const has = s.ready || `!!document.querySelector(${JSON.stringify(s.expect)})`;
      const deadline = t0 + Math.max(settle, 8000);
      for (;;) {
        const r = await ev(has);
        if (r || isErr(r) || Date.now() >= deadline) break;
        await wait(200);
      }
      // 等满 settle 再量；元素来得比 settle 晚就再补 600ms 让它排完版
      await wait(Math.max(600, settle - (Date.now() - t0)));
      const final = await ev(has);
      if (isErr(final) || !final) {
        if (s.close) { await ev(s.close); await wait(900); }
        if (!重试过.has(s.name)) { 重试过.add(s.name); si--; continue; }
        report[res][s.name] = [{ 类: '没打开', 值: isErr(final) ? final.slice(4, 120) : ('等完了也不满足 ' + (s.ready ? 'ready 判据' : s.expect)) }];
        continue;
      }
    } else {
      await wait(settle);
    }
    let bad = [];
    try { bad = JSON.parse(await ev(PROBE)); } catch { bad = [{ 类: '探针出错' }]; }
    if (bad.length) report[res][s.name] = bad;
    if (s.close) { await ev(s.close); await wait(900); }
  }
  /*
   * **一档跑完就说一声。** 这个脚本原来全程一个字都不打印，跑完才一次性
   * 输出五行——而它要十几分钟。「十分钟没有任何输出」和「卡死了」
   * 在终端里长得一模一样：这一轮我据此 kill 了一次、又重跑了两次，
   * 全是白等。同本文件（AGENTS.md）那条「长任务一定要有进度」——
   * 那条规矩当初是为扫描写的，走查自己没照做。
   */
  const done = Object.values(report[res]).reduce((a, b) => a + b.length, 0);
  console.log(`  ${res} 跑完，${done} 条`);
}
await send('Emulation.clearDeviceMetricsOverride');
close();

let total = 0;
for (const [res, surfaces] of Object.entries(report)) {
  const n = Object.values(surfaces).reduce((a, b) => a + b.length, 0);
  total += n;
  console.log(`${res}：${n} 条`);
  for (const [name, bad] of Object.entries(surfaces)) {
    for (const b of bad) console.log('   ', name, JSON.stringify(b));
  }
}
process.exit(total > 0 ? 1 : 0);
