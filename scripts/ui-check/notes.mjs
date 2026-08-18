/**
 * 端到端走一遍**做笔记**的完整路径：
 * 给颜色起用途 → 在正文里划一段并写笔记 → 目录上出现记号 → 面板里按用途筛得到
 * → 回书架从「我的笔记」跨书找到它 → 点一条跳回原处
 * → 切繁简把它弄漂 → 一键重新对上 → 导出全部笔记。
 *
 * 已有的三个端到端走查覆盖的是**读**（`walk.mjs`）和**归置**（`review.mjs`），
 * 笔记这条线一直没有——而它横跨 core 的六七个模块和两个阅读界面，
 * 每一环单独都有断言，串起来却没人走过。
 *
 *   node scripts/ui-check/notes.mjs
 *
 * ⚠️ **这条走查会往库里写笔记，跑完自己清干净。** 只在测试档案上跑
 * （`guardTestLibrary` 把关），理由同 CLAUDE.md 那条：
 * CDP 驱动阅读界面会写进铁律 3 的数据。
 */
import { connect, guardTestLibrary, rpc } from './cdp.mjs';

await guardTestLibrary();
const { ev, wait, 拖选, send, reload, close } = await connect();
/*
 * ⚠️ **一上来先刷新页面，别接着别人留下的那一屏跑。**
 *
 * 「每种颜色代表什么」在渲染进程里是**模块级缓存**（`highlight-view.ts` 的 `use色名`），
 * 只在第一个用到它的组件挂载时取一次；而这个脚本是走 **rpc** 改名字的，
 * 广播不到渲染进程。于是只要**前面有任何东西开过笔记面板或阅读器**
 * （另一个走查、一次截图），缓存里就已经是旧名字，而这个脚本改完名字直接去点
 * 「用『待查』划线」——那个按钮上写的还是「用『蓝』划线」，找不到、点不着。
 *
 * 报出来是 `✗ 划线那排色块写的是用途`，后面「划上了 []」「笔记存进库了」
 * 一连串跟着红，**看起来像划线功能整个坏了**。实测踩过一次。
 */
await reload();
await wait(2000);
const fail = [];
const step = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✗'} ${name}${detail ? '　' + detail : ''}`);
  if (!ok) fail.push(name);
};
/** 等一个条件成立。**固定等待是走查里最常见的假失败来源**（判据同 `walk.mjs`） */
const until = async (expr, ms = 9000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await wait(300); }
  return false;
};

/* ── 挑一本能读的 txt，并把它的笔记清空 ─────────────────── */
const 列 = (await rpc('book.list', { filter: {}, limit: 50 })).r;
const 书们 = 列.rows ?? 列;
let 本 = null;
for (const b of 书们) {
  const cs = (await rpc('book.chapters', { bookId: b.id })).r ?? [];
  if (cs.length < 3) continue;
  const ch = (await rpc('chapter.read', { bookId: b.id, idx: 1 })).r;
  if (ch && (ch.text || '').length > 200) { 本 = b; break; }
}
if (!本) { console.error('✗ 测试库里没有一本能读的 txt——先跑 make-testlib.mjs'); process.exit(1); }
console.log(`拿《${本.title}》走一遍`);

const 清空 = async () => {
  for (const h of ((await rpc('highlight.list', {})).r ?? [])) {
    await rpc('highlight.remove', { id: h.id, confirmed: true });
  }
  for (const b of 书们) {
    for (const m of ((await rpc('bookmark.list', { bookId: b.id })).r ?? [])) {
      await rpc('bookmark.remove', { id: m.id, confirmed: true });
    }
  }
};
await 清空();
await rpc('convert.set', { bookId: 本.id, mode: 'off' });

/* ── ① 给颜色起用途 ────────────────────────────────────── */
/*
 * ⚠️ **先把原来的名字记下来，收尾要还回去。**
 *
 * 色名存在 `app_setting` 里，是持久的、还进备份，而 `清空()` 只删划线和书签。
 * 不还原的话第二遍跑起来库里**已经**是「待查／好句」——下面那条断言于是恒真，
 * 就算 `setColorNames` 整个坏掉也照样绿（本仓库那句「一条永远绿的断言等于没有断言」）。
 * 顺带它还会把「待查／好句」留给后面每一个脚本和任何打开这个档案的人。
 */
const 原来的色名 = (await rpc('highlight.colorNames', {})).r ?? {};
await rpc('highlight.setColorNames', { blue: '待查', yellow: '好句' });
const 用途 = (await rpc('highlight.colorNames', {})).r ?? {};
step('给颜色起了用途', 用途.blue === '待查' && 用途.yellow === '好句', JSON.stringify(用途));

/* ── ② 进阅读器，在正文里划一段并写笔记 ──────────────────── */
await ev("(() => { for (let i=0;i<6;i++){ const b=document.querySelector('.modal-backdrop'); if(!b) break; b.click(); } return 1; })()");
await ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='书架')?.click()`);
await until("!!document.querySelector('.wall')");
await ev(`(() => { const c=document.querySelector('.book[data-book-id="${本.id}"]'); c?.querySelector('.book-art')?.click(); return !!c; })()`);
step('阅读器开了', await until("!!document.querySelector('.reader-text')", 20000));

// 跳到第 2 章：第 1 章往往是全书开头，选区更容易撞上标题
await ev(`[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.trim()==='目录')?.click()`);
await until("!!document.querySelector('.toc-item')");
await ev(`[...document.querySelectorAll('.toc-item')][1]?.click()`);
await wait(1200);

/*
 * ⚠️ **用真鼠标拖，不是合成 `mouseup`**（`拖选` 上面记着为什么）。
 * 先挑一段整段都在视口里的正文，拖到视口外选不中东西。
 */
await ev(`(() => {
  const p = [...document.querySelectorAll('article[data-chapter] p[data-offset]')]
    .find(x => { const r = x.getBoundingClientRect();
      return (x.textContent||'').trim().length >= 8 && r.width > 40; });
  p?.setAttribute('data-走查', '1');
  p?.scrollIntoView({ block: 'center' });
  return !!p;
})()`);
// 滑完先等一下：拖选自己不滑（理由写在它上面）
await wait(1200);
const 选中 = await 拖选('article[data-chapter] p[data-走查]');
step('选中了一段正文', String(选中).length >= 4, JSON.stringify(选中));

await until(`[...document.querySelectorAll('button')].some(b=>(b.getAttribute('aria-label')||'').startsWith('用「'))`);
const 色块 = await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')).filter(x=>x&&x.startsWith('用「')))`);
step('划线那排色块写的是用途', String(色块).includes('用「待查」划线'), String(色块));
await ev(`[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'')==='用「待查」划线')?.click()`);
await until(`(await window.novel.rpc('highlight.list', { bookId: ${本.id} })).length > 0`.replace('await ', ''), 3000).catch(() => {});
await wait(900);
let 划 = ((await rpc('highlight.list', { bookId: 本.id })).r ?? []);
step('划上了', 划.length === 1 && 划[0].color === 'blue', JSON.stringify(划.map((h) => h.color)));

// 点它，在卡上补一句笔记（这条路原来不存在：没笔记的划线一点就删）
await ev(`document.querySelector('.reader-text mark')?.click()`);
step('点划线开出笔记卡', await until("!!document.querySelector('.note-pop')"));
await ev(`[...document.querySelectorAll('.note-pop button')].find(b=>b.textContent.trim()==='写笔记')?.click()`);
await until("!!document.querySelector('.note-pop input')");
await ev(`(() => { const i=document.querySelector('.note-pop input'); if(!i) return 0;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'走查写的笔记');
  i.dispatchEvent(new Event('input',{bubbles:true}));
  i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 1; })()`);
await wait(900);
划 = ((await rpc('highlight.list', { bookId: 本.id })).r ?? []);
step('笔记存进库了', 划[0]?.note === '走查写的笔记', JSON.stringify(划[0]?.note));

/* ── ③ 目录上出现记号 ──────────────────────────────────── */
await ev(`document.querySelector('.note-pop .quiet')?.click()`);
await ev(`[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.trim()==='目录')?.click()`);
await until("!!document.querySelector('.toc-item')");
const 记号 = await ev(`JSON.stringify([...document.querySelectorAll('.toc-item')].map(b=>{const m=b.querySelector('.toc-mark');return m?m.textContent.trim():null;}).filter(Boolean))`);
step('目录上标出了这一章有笔记', String(记号).includes('划线'), String(记号));
await ev(`document.querySelector('.toc-close')?.click()`);

/* ── ④ 面板里按用途筛 ──────────────────────────────────── */
/*
 * ⚠️ **这个键不在 `.reader-rail` 里，在 `.reader-tools` 里。**
 * 阅读器是两条轨：左轨（`.reader-rail`）放常驻动作（书架 / 目录 / 上下章 / 设置…），
 * 右轨（`.reader-tools`）放这一本相关的（加书签 / 搜索 / 评价 / 书签划线…）。
 * 按整个页面找、按整名比最稳——第一版写死 `.reader-rail`，
 * 于是「笔记面板开了」报红，而面板本身好好的。
 */
await ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='书签划线')?.click()`);
step('笔记面板开了', await until("!!document.querySelector('.modal')"));
step('面板里看得见这条笔记', await ev(`(document.querySelector('.modal')?.textContent||'').includes('走查写的笔记')`));
await ev(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent.trim()==='关闭')?.click()`);

/* ── ⑤ 弄漂它，再一键对回来 ───────────────────────────── */
await rpc('convert.set', { bookId: 本.id, mode: 'to-traditional' });
const 漂了 = ((await rpc('highlight.resolve', { bookId: 本.id, chapterIdx: 划[0].chapter_idx })).r ?? []);
step('切繁简之后它确实漂了', 漂了.length > 0 && 漂了[0].intact === false, JSON.stringify(漂了.map((x) => x.intact)));
const 修 = (await rpc('highlight.reanchor', { bookId: 本.id, chapterIdx: 划[0].chapter_idx })).r ?? {};
const 修后 = ((await rpc('highlight.resolve', { bookId: 本.id, chapterIdx: 划[0].chapter_idx })).r ?? []);
/*
 * ⚠️ **「没敢动」也算走通。** 夹具那几本正文是同一段重复的，
 * 那时候锚在本章出现不止一次，`reanchor` **按判据就该不动手**——
 * 把它当失败会逼着下一个人去「修」一个正确的行为。
 * 要断言的是：**要么对回来了，要么明说为什么没动**。
 */
step('漂了之后能对回来（或明说没敢动）',
  (修.fixed === 1 && 修后[0]?.intact === true) || 修.ambiguous > 0,
  JSON.stringify(修));
await rpc('convert.set', { bookId: 本.id, mode: 'off' });

/* ── ⑥ 回书架，从「我的笔记」跨书找到它 ────────────────── */
await ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='书架')?.click()`);
await until("!!document.querySelector('.wall')");
await until(`[...document.querySelectorAll('.nav-tool')].some(b=>b.textContent.trim()==='我的笔记')`);
await ev(`[...document.querySelectorAll('.nav-tool')].find(b=>b.textContent.trim()==='我的笔记')?.click()`);
step('从书架开得出「我的笔记」', await until("!!document.querySelector('.modal')"));
step('全库那一档里有它', await ev(`(document.querySelector('.modal')?.textContent||'').includes('走查写的笔记')`));
await ev(`[...document.querySelectorAll('.modal button')].find(x=>(x.textContent||'').includes('走查写的笔记'))?.click()`);
step('点一条能跳回那本书', await until("!!document.querySelector('.reader-text')", 20000));

/* ── ⑥b 同一条路在**查看器**里再走一遍（PDF）─────────────
 *
 * ⚠️ **这一段才是这条走查最值钱的地方。** 两个阅读界面是两份实现，
 * 这个仓库已经在它们之间抓到过三次分叉：带笔记的划线画成黄的、
 * 点划线一个删一个开卡、目录记号只有一边有。
 * 单元测试看不见分叉——两边各自的断言都是绿的。
 *
 * 没有能读的 PDF 就**跳过而不是报错**：夹具里没有不等于功能坏了。
 */
const pdf = 书们.find((b) => /PDF/i.test(b.title));
if (!pdf) {
  console.log('· 测试库里没有 PDF，查看器这一段跳过');
} else {
  await ev(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='书架')?.click()`);
  await until("!!document.querySelector('.wall')");
  await ev(`(() => { const c=document.querySelector('.book[data-book-id="${pdf.id}"]'); c?.querySelector('.book-art')?.click(); return !!c; })()`);
  const 开了 = await until("document.querySelectorAll('.textLayer span').length > 0", 30000);
  step('PDF 查看器把文字层铺出来了', 开了);

  if (开了) {
    // 在文字层里拉一段。⚠️ 监听挂在舞台上、只认落在 `.textLayer` 里的选区
    /*
     * ⚠️ **派完 `mouseup` 还要补一个 `click`。**
     *
     * 真鼠标松手之后浏览器**必然再发一个 `click`**，而划线卡自己就算
     * 一层浮层——那一下 `click` 曾经把刚开的卡在同一轮事件里又关了，
     * 屏幕上划了一段什么提示都没有。这条走查原来只派 `mouseup`，
     * 于是一路绿，而**手一碰就是坏的**。txt 那一段用的是真鼠标（`拖选`），
     * 这里用合成事件：pdf.js 是滑到哪铺到哪，重铺那一下
     * `replaceChildren()` 会把刚拖出来的选区连同节点一起抹掉，
     * 真鼠标在夹具那本 PDF 上驱不稳（试过五种等法）。
     * **要抢的是那个顺序，不是硬件**，所以派事件就够了。
     */
    const 选 = await ev(`(() => {
      const 层 = document.querySelector('.textLayer');
      const w = document.createTreeWalker(层, NodeFilter.SHOW_TEXT);
      let t = null;
      while (w.nextNode()) { if (w.currentNode.data.trim().length >= 4) { t = w.currentNode; break; } }
      if (!t) return '';
      const r = document.createRange();
      r.setStart(t, 0); r.setEnd(t, Math.min(4, t.data.length));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      t.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      t.parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return s.toString();
    })()`);
    step('在 PDF 文字层里选中了一段', String(选).trim().length > 0, JSON.stringify(选));

    await until(`[...document.querySelectorAll('button')].some(b=>(b.getAttribute('aria-label')||'').startsWith('用「'))`, 6000);
    const 色2 = await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')).filter(x=>x&&x.startsWith('用「')))`);
    step('查看器的色块也写用途（和 txt 一致）', String(色2).includes('用「待查」划线'), String(色2));

    await ev(`[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'')==='用「待查」划线')?.click()`);
    await wait(900);
    const 划2 = ((await rpc('highlight.list', { bookId: pdf.id })).r ?? []);
    step('PDF 上划上了', 划2.length === 1, JSON.stringify(划2.map((h) => [h.chapter_idx, h.color])));

    /*
     * **点一条没写笔记的划线：该开卡，不该一点就删。**
     * 这一条正是两个界面当初分叉的地方，所以两边都要走一遍。
     */
    await ev(`(() => {
      const 层 = document.querySelector('.textLayer');
      const t = 层 && 层.textContent || '';
      // 原生高亮不产生元素，只能拿坐标点：点在文字层第一个 span 的中间
      const sp = 层?.querySelector('span');
      if (!sp) return 0;
      const r = sp.getBoundingClientRect();
      for (const type of ['mousedown', 'mouseup', 'click']) {
        sp.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + 4, clientY: r.top + r.height / 2 }));
      }
      return 1;
    })()`);
    const 开卡 = await until("!!document.querySelector('.note-pop')", 4000);
    step('点 PDF 上的划线开出笔记卡（不是一点就删）',
      开卡 && ((await rpc('highlight.list', { bookId: pdf.id })).r ?? []).length === 1);
    if (开卡) {
      const 卡键 = await ev(`JSON.stringify([...document.querySelectorAll('.note-pop button')].map(b=>b.textContent.trim()).filter(Boolean))`);
      step('卡上有「写笔记」和换颜色（和 txt 共用一份）', String(卡键).includes('写笔记'), String(卡键));
      await ev(`document.querySelector('.note-pop .quiet')?.click()`);
    }

    // 目录记号：PDF 的目录来自 outline，`chapter_idx` 装的是页码
    await until(`[...document.querySelectorAll('.reader-rail button')].some(x=>x.textContent.trim()==='目录')`, 20000);
    await ev(`[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.trim()==='目录')?.click()`);
    if (await until("!!document.querySelector('.toc-item')", 6000)) {
      const 记2 = await ev(`JSON.stringify([...document.querySelectorAll('.toc-item')].map(b=>{const m=b.querySelector('.toc-mark');return m?m.textContent.trim():null;}).filter(Boolean))`);
      step('PDF 目录上也标出了有笔记', String(记2).includes('划线'), String(记2));
      await ev(`document.querySelector('.toc-close')?.click()`);
    } else {
      console.log('· 这本 PDF 没有 outline，目录记号那一步跳过');
    }

    /* ── ⑥c 框选：扫描页那条路 ───────────────────────
     *
     * 扫描页 / 插图 / 公式没有文字层，上面那整条路对它们一条都不成立。
     *
     * ⚠️ **这一段要用真鼠标拖**（`Input.dispatchMouseEvent`），不能合成：
     * 真鼠标松手后浏览器**必然再补一个 `click`**，而刚弹出来的卡自己就算一层浮层——
     * 文字划线靠「有选区就不算点击」拦得住，而**框选根本没有选区**，
     * 同一个 bug 在这条新路上又来了一遍（判据现在是「框选模式下点页面永远不算点正文」）。
     * 合成事件不带 `click`，抢不到那一下。
     */
    await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='框选')?.click()`);
    const 框选开了 = await until(
      "getComputedStyle(document.querySelector('.textLayer')).pointerEvents === 'none'", 4000);
    step('开框选之后文字层让路（选字和框选不抢手势）', 框选开了);

    const 页框 = JSON.parse(await ev(`(() => {
      const p = document.querySelector('.pdf-page[data-n="1"]');
      if (!p) return 'null';
      const r = p.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height), vh: innerHeight });
    })()`));
    if (框选开了 && 页框) {
      const x0 = 页框.x + Math.round(页框.w * 0.2);
      const y0 = Math.max(80, 页框.y + Math.round(页框.h * 0.1));
      const x1 = 页框.x + Math.round(页框.w * 0.6);
      const y1 = Math.min(页框.vh - 80, y0 + 120);
      const m = (t, x, y, b) =>
        send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', clickCount: 1, buttons: b });
      await m('mousePressed', x0, y0, 1);
      for (let i = 1; i <= 5; i++) {
        await m('mouseMoved', x0 + Math.round(((x1 - x0) * i) / 5), y0 + Math.round(((y1 - y0) * i) / 5), 1);
      }
      await m('mouseReleased', x1, y1, 0);
      await wait(800);

      const 色3 = await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')).filter(x=>x&&x.startsWith('用「')))`);
      step('拖完弹出划线卡（那一下 click 没把它关掉）', String(色3).length > 2, String(色3));

      await ev(`[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'').startsWith('用「'))?.click()`);
      await wait(900);
      const 框了 = ((await rpc('highlight.list', { bookId: pdf.id })).r ?? []).filter((h) => h.rect);
      step('框选落库了，rect 是四个归一化坐标',
        框了.length === 1 && /^[0-9.]+,[0-9.]+,[0-9.]+,[0-9.]+$/.test(框了[0].rect ?? ''),
        JSON.stringify(框了.map((h) => [h.chapter_idx, h.rect])));
      step('页面上画出来了（框选不走 CSS.highlights，是真的有元素）',
        (await ev("document.querySelectorAll('.hl-rect').length")) > 0);
    }
    // 自己收拾干净：不退出的话后面那几步都在框选模式下跑
    await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='退出框选')?.click()`);
  }
}

/* ── ⑦ 导出全部笔记 ───────────────────────────────────── */
const { tmpdir } = await import('node:os');
const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const 出目录 = mkdtempSync(join(tmpdir(), 'shuzhai-notes-'));
try {
  const r = (await rpc('export.allNotes', { dir: 出目录 })).r ?? {};
  const 文 = r.path ? readFileSync(r.path, 'utf8') : '';
  step('导出的 markdown 里有这条笔记', 文.includes('走查写的笔记'), r.path ?? '(没导出来)');
} finally {
  rmSync(出目录, { recursive: true, force: true });
}

/* ── 自检：这条走查真的会红吗 ─────────────────────────── */
/*
 * 一条永远绿的走查等于没有走查（本仓库反复记着这条）。
 * 这里故意问一句必然不成立的话，确认 `step` 真的把它记进 `fail`。
 */
const 之前 = fail.length;
step('自检：故意问一句不成立的', await ev("!!document.querySelector('.绝不存在的东西')"));
const 自检过了 = fail.length === 之前 + 1;
fail.pop();
if (!自检过了) { console.error('✗ 自检没通过——这条走查报不出失败，本身就是坏的'); process.exit(2); }
console.log('✔ 自检通过：这条走查报得出失败');

await 清空();
// 色名还回去，理由在上面 ① 那段
await rpc('highlight.setColorNames', 原来的色名);
close();
console.log(fail.length ? `\n✗ 断在：${fail.join('、')}` : '\n✔ 做笔记这条路全程走通');
process.exit(fail.length ? 1 : 0);
