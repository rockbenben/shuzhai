/**
 * 端到端走一遍普通人的完整路径：
 * 第一次打开 → 加目录 → 书架 → 点开一本 → 读到最后一章 → 被问「记一句」
 * → 打分写评 → 回书架 →「我的书评」里找到它 → 搜书名也搜得到。
 *
 * 「选文件夹」那一步走 rpc——它会弹**系统对话框**，那是模态窗口，
 * CDP 从此收不到任何指令（这个坑在朗读那轮踩过）。**其余全部走界面**：
 * 能点的都点，点不了的才绕。
 *
 *   node scripts/ui-check/walk.mjs <书库目录>
 */
import { connect, guardTestLibrary, rpc, setInput, 切档} from './cdp.mjs';

const LIB = process.argv[2];
if (!LIB) {
  console.error('用法：node scripts/ui-check/walk.mjs <书库目录>\n（会往当前连着的库里加这个目录，请用测试档案）');
  process.exit(1);
}

await guardTestLibrary();
const { send, ev, wait, reload, close } = await connect();
const fail = [];
/** 等一个条件成立。**固定等待是走查里最常见的假失败来源**——
 *  实测同一条路径 1.8 秒不够、2.5 秒够，那报出来的「功能坏了」其实是等得不够 */
const until = async (expr, ms = 9000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(expr)) return true;
    await wait(400);
  }
  return false;
};

/** 切到侧栏某一档（低频那几档收在「更多」里，它会先展开） */
const 切到 = 切档(ev, until);

const step = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✗'} ${name}${detail ? '　' + detail : ''}`);
  if (!ok) fail.push(name);
};

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await reload();
await wait(3000);

// ① 加目录（rpc，因为界面那个按钮会弹系统对话框）
const add = await rpc('root.add', { path: LIB });
step('加书库目录', !add.err, add.err ?? `收进来 ${add.r?.report?.added ?? '?'} 本`);
await reload();
await wait(3200);

const n = await ev("document.querySelectorAll('.book').length");
step('书架铺出来了', n > 0, `${n} 张卡`);

/*
 * ② 点开一本**能在书斋里读的**书。
 *
 * 不能随手点第一张卡：PDF / EPUB 那些是只编目的，点开走的是
 * `ui.openFile` → 系统默认程序——**会在这台机器上弹出个外部阅读器**，
 * 而且走查后面全部作废（阅读器根本没打开）。第一版就是这么断的。
 * 判据用「有章节数」：只编目的格式章节数天生是 0。
 */
const pick = (await rpc('book.list', { filter: {}, limit: 50, sort: 'time' })).r
  ?.find((b) => (b.chapter_count ?? 0) > 1);
if (!pick) { step('库里有能读的 txt', false, '一本都没有'); close(); process.exit(1); }
const title = await ev(`(() => {
  // 按 id 认卡片，别按书名：同名的书是常态（同一本书的 txt 和 epub 各一条记录）
  const c = document.querySelector('.book[data-book-id="${pick.id}"]');
  if (!c) return null;
  c.querySelector('.book-art').click();
  return ${JSON.stringify(pick.title)};
})()`);
await until("!!document.querySelector('.reader-text h2')");
const chap = await ev("(document.querySelector('.reader-text h2')||{}).textContent");
step('点开一本书', !!chap, `《${title}》→ ${chap}`);

/*
 * ③ 跳到最后一章、滚到底 → 应该被问「记一句」
 *
 * **点目录的最后一项，不要按标题去搜。** 原来是往目录搜索框里打「第N章」——
 * 那假设了章节标题长这个样子，而 make-testlib 里就有一本《没有章节的散文》，
 * 目录项叫「未识别章节 1」。挑中它时搜不到 → 跳不过去 → 停在第一章 →
 * 滚到底也不是书的末尾 → 「读完时问了要不要记一句」失败。
 *
 * 而挑哪本书是按 mtime 排的（sort: time），重造一次测试书库就可能换一本——
 * **于是这条走查时红时绿，而红的时候看起来像应用回归**。
 * 点最后一项和标题、章数、书都无关，稳定。
 */
// 目录是**浮层、默认收起**（照用户给的 legado 参考改的），先把它叫出来
await ev(`(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.trim()==='目录'); if(!b) return 0; b.click(); return 1; })()`);
await until("!!document.querySelector('.toc-item')", 6000);
const total = await ev("(() => document.querySelectorAll('.toc-item').length)()");
if (total > 1) {
  await ev("(() => { const t=[...document.querySelectorAll('.toc-item')].pop(); if(t) t.click(); return 1; })()");
  await wait(1800);
}
await ev("(() => { const b=document.querySelector('.reader-body'); b.scrollTop=b.scrollHeight; b.dispatchEvent(new Event('scroll')); return 1; })()");
const asked = await until("[...document.querySelectorAll('.card')].some(x=>x.textContent.includes('读完了'))");
step('读完时问了要不要记一句', asked);

// ④ 打分 + 写一句 + 记下来
if (asked) {
  await ev(`(() => {
    const c = [...document.querySelectorAll('.card')].find(x => x.textContent.includes('读完了'));
    [...c.querySelectorAll('.rate-stars button')][1].click();
    return 1;
  })()`);
  await ev(setInput("[...document.querySelectorAll('.card')].find(x=>x.textContent.includes('读完了')).querySelector(':is(textarea,input)')", '走查写的一句话'));
  await wait(400);
  await ev("(() => { const c=[...document.querySelectorAll('.card')].find(x=>x.textContent.includes('读完了')); const b=[...c.querySelectorAll('button')].find(x=>x.textContent.trim()==='记下来'); b.click(); return 1; })()");
  await wait(1100);
  const gone = await ev("![...document.querySelectorAll('.card')].some(x=>x.textContent.includes('读完了'))");
  step('记下来之后那张卡收起来', gone);
}

// ⑤ 回书架 →「我的书评」→ 短评看得见
await ev("(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); b.click(); return 1; })()");
await wait(1800);
// 「我的书评」收在侧栏的「更多」里了，`切档` 会先展开
await 切到('我的书评');
await wait(1500);
/*
 * ⚠️ **这一档的默认视图换过两次，探针跟着换过两次**：
 * 封面墙（`.book-note`）→ 书评册（`.rv-say`）→ 现在默认是**表格**（`.cell-say`）。
 *
 * **判据本身一个字没改**——「找得到它、那句话看得见」。换的只是那句话摆在哪。
 * 这也是为什么这里认的是「三种视图里任意一处印着它」而不是写死一个类名：
 * 默认视图是 `SHELVES` 里一个字段，改它不该让这条走查变红。
 */
const note = await ev(
  "(document.querySelector('.cell-say, .rv-say, .book-note')||{}).textContent",
);
// **要认那句话本身，不能只验「有一条书评」**：`querySelector` 拿的是这一档里
// 第一条，别的书写过短评也照样过——那是空过。
// 判据：印出来的就是这一趟写进去的那句
step('「我的书评」里能找到它，那句话看得见',
  String(note ?? '').includes('走查写的一句话'), note ?? '(这一档里没有那句话)');

/*
 * **切到这一档，排序要自己变成「最近评价的在前」。**
 *
 * `ORDER.rated` 的注释一直写着「「我的书评」这一档默认按它」，
 * 而 App 从来没这么做过——点开拿到的是「最新的在前」（文件时间）。
 * 于是这一档存在的理由（「我最近评过什么」）默认答不上来，
 * 要用户自己去下拉框里发现那个选项。注释描述了一件不存在的行为。
 */
const sortName = await ev(`(() => {
  const sel = document.querySelector('select');
  if (!sel) return '(没有排序控件)';
  return ([...sel.options].find((o) => o.selected) || {}).textContent || '(没选中)';
})()`);
step('切到「我的书评」，排序跟着变成按评价时间', /评价/.test(String(sortName)), String(sortName));

// ⑥ 搜得到。**先切回「全部」**——上一步停在「我的书评」那一档，
// 不切的话搜出 0 本，看起来像搜索坏了（第一版就误判成这样）
await 切到('全部');
await wait(1000);
await ev(setInput("document.querySelector('.search-box')", String(title ?? '').slice(0, 3)));
await wait(1100);
const found = await ev("document.querySelectorAll('.book').length");
step('按书名搜得到', found > 0, `${found} 本`);

close();
console.log(fail.length ? `\n✗ 断在：${fail.join('、')}` : '\n✔ 全程走通');
process.exit(fail.length ? 1 : 0);
