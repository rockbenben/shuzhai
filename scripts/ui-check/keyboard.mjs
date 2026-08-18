/**
 * 键盘走一圈：每一站有没有看得见的焦点标记。
 *
 * **必须用真的按 Tab**（CDP 发键盘事件）。`:focus-visible` 只在键盘触发的
 * 聚焦时匹配，JS 调 `el.focus()` 不算——据此报过 **327 条**假的
 * 「聚焦看不出来」，横跨日夜两遍、每个界面都有，形状特别像真的系统性缺陷。
 *
 *   node scripts/ui-check/keyboard.mjs
 */
import { connect, guardTestLibrary, rpc, 开工具 } from './cdp.mjs';

await guardTestLibrary();
const { send, ev, wait, key, reload, close } = await connect();

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await reload();
await wait(2800);
await ev('document.body.focus()');

/** 等一个条件成立（这个脚本原来只有固定等待，而折叠展开那一下不是同步的） */
const until = async (expr, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await wait(200); }
  return false;
};
/** 点侧栏底部的某个管理工具（低频那九个收在「更多工具」里） */
const 开工具了 = 开工具(ev, until);

const STOPS = 20;
const blind = [];
const stops = [];
for (let i = 0; i < STOPS; i++) {
  await key('Tab', 'Tab', 9);
  const r = await ev(`(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return JSON.stringify({ 停在: 'body' });
    const s = getComputedStyle(el);
    const 看得见 = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
    return JSON.stringify({
      元素: (typeof el.className === 'string' && el.className ? el.className : el.tagName).slice(0, 26),
      文: (el.textContent || el.placeholder || '').trim().slice(0, 14),
      看得见,
      focusVisible: el.matches(':focus-visible'),
      outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor,
    });
  })()`);
  const o = JSON.parse(r);
  stops.push(o);
  if (o.元素 && !o.看得见) blind.push(o);
}
/*
 * ── 第二段：弹窗开着时，Tab 跑不跑得出去 ──────────────
 *
 * 上面那一段只在**书架上**走，弹窗一个都没开过。而实测（改之前）：
 * 弹窗开着按 26 次 Tab，**8～18 站落在背后的书架上**，
 * 打开时焦点还常常停在背后那个触发按钮上。对键盘用户就是
 * 「打开弹窗，然后开始逐个走背后的书架」。
 *
 * 焦点约束现在由 `src/renderer/modal-a11y.ts` 一处统一做（18 个弹窗共用
 * 同一套 .modal-backdrop > .modal 标记），所以这里抽查两个就够——
 * 一个内容同步渲染的，一个内容异步到的（后者曾经是唯一漏网的那个）。
 */
const TRAP = [
  // ⚠️ 低频工具收进侧栏的「更多工具」了，先展开再点（展开那一下不是同步的，
  //    所以这里只负责点开折叠；`开工具了` 那条路才带轮询）
  ['正文净化', 开工具了],
  ['编辑一本书', "(() => { const b=[...document.querySelectorAll('.book-tools button')].find(x=>x.textContent.trim()==='编辑'); if(!b) return 0; b.click(); return 1; })()"],
];
const leak = [];
const landed = [];
/*
 * 弹窗自己有没有名字。**`role="dialog"` 只说了「这是个对话框」，没说是哪个**——
 * 这个应用有十九个弹窗，屏幕阅读器统一念一句「对话框」等于没念，
 * 用户还得自己 Tab 一圈去猜。名字接在那个看得见的标题上（`modal-a11y.ts`）。
 */
const 没名字的弹窗 = [];
for (const [name, open] of TRAP) {
  await ev("(() => { for (let i=0;i<6;i++) { const b=document.querySelector('.modal-backdrop'); if(!b) break; b.click(); } return 1; })()");
  await wait(400);
  // `open` 可以是一句喂给页面的表达式，也可以是个驱动侧的函数
  // （侧栏那几个工具收进了「更多工具」，展开那一下不是同步的，得轮询）
  const 开了 = typeof open === 'function' ? await open(name) : await ev(open);
  if (!开了) { leak.push({ 界面: name, 问题: '打不开' }); continue; }
  await wait(1800);
  const start = await ev("(() => { const el=document.activeElement; return el && el.closest('.modal') ? '内' : '外'; })()");
  const 念作 = await ev("(() => { const m=[...document.querySelectorAll('.modal')].pop(); if(!m) return null; const by=m.getAttribute('aria-labelledby'); const t=by&&document.getElementById(by); const s=t?t.textContent.trim():(m.getAttribute('aria-label')||''); return s.slice(0,24); })()");
  landed.push({ 界面: name, 打开时焦点: start, 念作: 念作 || '（没名字）' });
  if (!念作) 没名字的弹窗.push({ 界面: name, 问题: 'role=dialog 有了，但没有 aria-labelledby / aria-label' });
  if (start !== '内') leak.push({ 界面: name, 问题: '打开时焦点没进弹窗' });
  for (let i = 0; i < 24; i++) {
    await key('Tab', 'Tab', 9);
    const outside = await ev("(() => { const el=document.activeElement; return !el || el === document.body || !el.closest('.modal'); })()");
    if (outside === true) { leak.push({ 界面: name, 问题: `第 ${i + 1} 次 Tab 跑出弹窗` }); break; }
  }
}
/*
 * ── 第三段：一个弹窗直接换成另一个 ──────────────
 *
 * 「按书名打标签」点一个词就直接换成「批量打标签」——**弹窗数目一直是 1**。
 * `modal-a11y` 的 `sync()` 原来只数个数，数目没变就当场返回：
 * 实测换完焦点掉回 `body`，新弹窗连 `role="dialog"` 都没有（屏幕阅读器
 * 因此不知道这是个对话框）。这里直接冲着那个机制来——在一个任务里
 * 拆掉旧遮罩、装上新的，不依赖某个具体弹窗（测试库只有 8 本，挖不出关键词）。
 */
await ev("(() => { for (let i=0;i<6;i++) { const b=document.querySelector('.modal-backdrop'); if(!b) break; b.click(); } return 1; })()");
await wait(400);
const swap = [];
if (await 开工具了('标签管理')) {
  await wait(1200);
  await ev(`(() => {
    const old = document.querySelector('.modal-backdrop');
    const box = document.createElement('div');
    box.className = 'modal-backdrop';
    box.innerHTML = '<div class="modal"><h2>换上来的第二个弹窗</h2><button>第一个按钮</button><button>第二个</button></div>';
    old.remove();
    document.body.appendChild(box);
    return 1;
  })()`);
  await wait(500);
  const inside = await ev("(() => { const el=document.activeElement; return !!(el && el.closest && el.closest('.modal')); })()");
  const marked = await ev("(() => { const m=document.querySelector('.modal'); return m.getAttribute('role') === 'dialog' && m.getAttribute('aria-modal') === 'true'; })()");
  if (inside !== true) swap.push({ 问题: '原地换掉一层之后，焦点没进新弹窗' });
  if (marked !== true) swap.push({ 问题: '原地换上来的弹窗没标 role=dialog / aria-modal' });
  await ev("(() => { const b=document.querySelector('.modal-backdrop'); if(b) b.remove(); return 1; })()");
} else {
  swap.push({ 问题: '打不开「标签管理」，这一段没测成' });
}

/*
 * ── 第四段：书架卡片上那排操作条，键盘够不够得到 ──────────────
 *
 * 卡片上的「编辑 / 章节 / 改名 / 评价 / 导出」原来是 `display: none`，
 * 只有 `:hover` 才显示——那样的元素**根本不在 tab 序里**，于是这五个动作
 * 全部只能用鼠标，而「评价」正是这个应用的核心动作（`:hover` 在触屏上也不存在）。
 *
 * **上面三段一条都报不出来**：它们量的是「Tab 到的地方怎么样」，
 * 而这里的问题是压根 Tab 不到——缺席不会报错。所以这一段直接钉「在不在 tab 序里」。
 */
const tools = [];
{
  /*
   * **书名是「打开这本书」的键盘入口。**
   *
   * 点封面才是主路径，而 `.book-art` 是个 `role: generic`、`tabIndex: -1` 的 div——
   * 拿 CDP 按 24 次 Tab 一次都不落在封面上，也就是**键盘用户一本书都打不开**
   * （那排工具里没有「打开」），屏幕阅读器在书架上也读不出任何东西。
   *
   * `.book-art` **不能**改成按钮：那排「编辑 / 章节 / 改名 / 评价 / 导出」
   * 就装在它里面，按钮套按钮是非法的。所以按钮只包 `<Cover/>`（`.book-open`）。
   * 也不做在书名上——那行只有 18px 高，`audit.mjs` 会报「点击目标偏小」，
   * 而那条判据是对的：一行字不该当按钮。
   *
   * 这里不走 70 次 Tab（要跨过整个侧栏才够得到书架，太慢），
   * 而是直接钉三件事：**在 tab 序里**（`tabIndex >= 0`）、**角色是按钮**、
   * **名字里有书名**。三条缺一条，键盘用户就打不开书。
   */
  const title = await ev(`(() => {
    const t = document.querySelector('.book-open');
    if (!t) return 'ERR 书架上一张卡都没有';
    t.focus();
    return JSON.stringify({
      标签: t.tagName, tabIndex: t.tabIndex,
      聚焦上了: document.activeElement === t,
      // 封面按钮里是图，没有文字——书名从同一张卡的 .book-title 上取
      文: (t.closest('.book')?.querySelector('.book-title')?.textContent || '').trim().slice(0, 20),
    });
  })()`);
  if (String(title).startsWith('ERR')) tools.push({ 问题: String(title) });
  else {
    const t = JSON.parse(title);
    if (t.tabIndex < 0) tools.push({ 问题: '封面不在 tab 序里——键盘打不开任何一本书', ...t });
    const doc = (await send('DOM.getDocument', { depth: -1 })).result;
    const { nodeIds } = (await send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: '.book-open' })).result;
    const { nodes } = (await send('Accessibility.getPartialAXTree', { nodeId: nodeIds[0], fetchRelatives: false })).result;
    const role = nodes[0]?.role?.value;
    const name = nodes[0]?.name?.value ?? '';
    if (role !== 'button') tools.push({ 问题: `封面按钮的角色是 ${role}，不是 button`, 名字: name });
    if (!name.includes(t.文)) tools.push({ 问题: '封面按钮的可及名称里没有书名', 名字: name, 书名: t.文 });
  }

  const ok = await ev(`(() => {
    const b = [...document.querySelectorAll('.book-tools button')].find((x) => /评价/.test(x.textContent));
    if (!b) return 'ERR 卡片上找不到「评价」按钮';
    b.focus();
    if (document.activeElement !== b) return 'ERR 聚焦不上——多半又被 display:none 藏起来了';
    const row = b.closest('.book-tools');
    const s = getComputedStyle(row);
    if (s.opacity === '0' || row.getBoundingClientRect().height < 1) return 'ERR 焦点进去了，但那一行没展开（:focus-within 没接上）';
    return 'ok';
  })()`);
  if (ok !== 'ok') tools.push({ 问题: String(ok) });
}

/*
 * ── 每个控件都得有个能读的名字 ──────────────
 *
 * 前面几段是一处一处钉的（卡片上那排、封面、五颗星）。这一条是通则：
 * **所有按钮/下拉/输入框，可及名称里必须有能读的字。** 两种坏法都抓：
 * 名字是空的、名字只有符号（五颗星原来算出来全是「★」，五个一模一样）。
 *
 * ⚠️ **不能拿长度当判据。** 量过：101 个控件里最长的第二名有 34 个字，
 * 而它是「打开《这本书名字特别长长长长长长长长到会换行》，某位名字也很长的作者」
 * ——**书名是用户数据，长是正常的**。判据只能是「有没有能读的字」。
 *
 * ⚠️ **必须在每一屏各扫一遍，不能只扫书架。** 第一版就只在书架上扫，
 * 结果是个摆设：星星只在评价浮层开着时才存在，而**两处真缺陷都在浮层里**。
 * 拿掉星星的 `aria-label` 去破坏它，它一声不吭。
 */
const 没名字 = [];
const scanNames = async (哪一屏) => {
  const doc = (await send('DOM.getDocument', { depth: -1 })).result;
  const { nodeIds } = (await send('DOM.querySelectorAll', {
    nodeId: doc.root.nodeId,
    selector: 'button, select, input, textarea, [role=button]',
  })).result;
  let 量了 = 0;
  for (const id of nodeIds) {
    const { nodes } = (await send('Accessibility.getPartialAXTree', { nodeId: id, fetchRelatives: false })).result;
    const n = nodes[0];
    if (!n || n.ignored) continue;
    量了++;
    const name = n.name?.value ?? '';
    if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(name)) {
      没名字.push({ 哪一屏, 角色: n.role?.value, 名字: name, 描述: (n.description?.value ?? '').slice(0, 24) });
    }
  }
  return 量了;
};

{
  await send('DOM.enable', {});
  await send('Accessibility.enable', {});
  const 量了 = await scanNames('书架');
  // 自检：一个控件都没量到的话，「0 处」是假的太平
  if (量了 < 20) {
    console.error(`✗ 自检没过：书架上只量到 ${量了} 个控件，这一段多半没跑起来`);
    process.exit(1);
  }
  // 诱饵：塞一个只有符号的按钮，判据必须认出来
  await ev("(() => { const b=document.createElement('button'); b.id='name-decoy'; b.textContent='◇'; document.body.appendChild(b); return 1; })()");
  const root = (await send('DOM.getDocument', { depth: -1 })).result.root.nodeId;
  const d = (await send('DOM.querySelectorAll', { nodeId: root, selector: '#name-decoy' })).result;
  const dn = (await send('Accessibility.getPartialAXTree', { nodeId: d.nodeIds[0], fetchRelatives: false })).result.nodes[0];
  await ev("(() => { const x=document.getElementById('name-decoy'); if(x) x.remove(); return 1; })()");
  if (/[\u4e00-\u9fffA-Za-z0-9]/.test(dn?.name?.value ?? '')) {
    console.error(`✗ 自检没过：塞了个只有「◇」的按钮，判据却说它有名字 → ${JSON.stringify(dn?.name?.value)}`);
    process.exit(1);
  }
}

/*
 * ── 第五段：打分这个控件，屏幕阅读器读得懂吗 ──────────────
 *
 * 前四段量的都是「焦点」，而这一段量的是**名字和状态**。拿 CDP 的可及性树
 * 量过改之前的样子：五颗星算出来的可及名称**全是「★」**（按钮里的文字盖过
 * `title`，`title` 只落在 description 上），那一组本身 `role: none` 也没有名字，
 * 而且没有任何地方说得出「现在是几星」——听到的是五个一模一样的「★ 按钮」。
 * **而打分是这个应用的核心动作。**
 *
 * 这一段不看焦点，所以上面四段一条都报不出来（同第四段那条：**缺席不会报错**）。
 */
const ax = [];
{
  await send('DOM.enable', {});
  await send('Accessibility.enable', {});
  const axOf = async (selector) => {
    const doc = (await send('DOM.getDocument', { depth: -1 })).result;
    const { nodeIds } = (await send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector })).result;
    const out = [];
    for (const nodeId of nodeIds) {
      const { nodes } = (await send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })).result;
      const n = nodes[0];
      out.push({
        role: n?.role?.value,
        name: n?.name?.value ?? '',
        pressed: n?.properties?.find((x) => x.name === 'pressed')?.value?.value,
      });
    }
    return out;
  };

  /*
   * **自己把那个差值造出来**：先把评分设成 3，再断言「第 3 颗是按下的」。
   * 不设的话，一本没评分的书五颗都是 false，那条断言等于没测
   * （同本文件那条「一条只在某种数据下才会红的判据，如果那种数据不是它自己造的，
   * 它就是永远绿的」）。
   */
  await ev("(() => { for (let i=0;i<6;i++) { const b=document.querySelector('.modal-backdrop'); if(!b) break; b.click(); } return 1; })()");
  await wait(400);
  const b = ((await rpc('book.list', { limit: 1 })).r ?? [])[0];
  if (!b) {
    ax.push({ 问题: '库里一本书都没有，这一段没测成' });
  } else {
    await rpc('reading.setStatus', { bookId: b.id, rating: 3 });
    await reload();
    await wait(2200);
    const opened = await ev(`(() => {
      // 按 id 认卡片，别按书名：同名的书是常态（txt 和 epub 各一条记录）
      const c = document.querySelector('.book[data-book-id="${b.id}"]');
      if (!c) return 0;
      const t = [...c.querySelectorAll('.book-tools button')].find((x) => x.textContent.trim() === '评价');
      if (!t) return 0; t.click(); return 1; })()`);
    if (!opened) ax.push({ 问题: '打不开评价浮层，这一段没测成' });
    else {
      await wait(1200);
      // 浮层开着时再扫一遍名字——星星就在这一屏上，只扫书架等于没扫
      await scanNames('评价浮层');
      const stars = await axOf('.rate-stars button');
      const group = (await axOf('.rate-stars'))[0];

      if (stars.length !== 5) ax.push({ 问题: `量到 ${stars.length} 颗星，该是 5 颗` });
      const names = stars.map((x) => x.name);
      if (new Set(names).size !== names.length) ax.push({ 问题: '五颗星的可及名称分不出来', 名字: names });
      if (names.some((n) => !n || n === '★')) ax.push({ 问题: '有星星没有可及名称（读出来只有一个 ★）', 名字: names });

      const pressed = stars.map((x) => x.pressed === true || x.pressed === 'true');
      const 第几颗 = pressed.indexOf(true) + 1;
      if (pressed.filter(Boolean).length !== 1 || 第几颗 !== 3) {
        ax.push({ 问题: `按下的该是第 3 颗（刚设成 3 星），实际 ${JSON.stringify(pressed)}` });
      }
      if (!group?.name) ax.push({ 问题: '这一组没有名字，读的人不知道这排按钮是干什么的' });

      // **诱饵**：塞一个五个都叫「★」的假控件，判据必须认出「分不出来」
      await ev(`(() => {
        const d = document.createElement('div');
        d.className = 'ax-decoy';
        d.innerHTML = '<button>★</button><button>★</button>';
        document.body.appendChild(d);
        return 1; })()`);
      const decoy = await axOf('.ax-decoy button');
      await ev("(() => { const d=document.querySelector('.ax-decoy'); if(d) d.remove(); return 1; })()");
      if (decoy.length !== 2 || new Set(decoy.map((x) => x.name)).size !== 1) {
        console.error(`✗ 自检没过：塞了两个都叫「★」的按钮，判据没认出它们同名 → ${JSON.stringify(decoy)}`);
        process.exit(1);
      }
    }
  }
}

/*
 * **自检第二层：那个「看得见焦点标记」的判据还认得出坏东西吗。**
 *
 * 上面那一条验的是「键盘事件送到了」——那是输入这一层。
 * 而判据本身（outline 宽度 / box-shadow）写坏时，这个脚本会一边报
 * 「0 处没有焦点标记」一边什么都没查。同 `dead-fields` / `dead-mounts` /
 * `stale-refs` 这一轮补的那三个诱饵。
 *
 * 做法：往页面里塞一个**明确没有焦点标记**的按钮，用同一段判据量它，
 * 判不出「看不见」就说明判据失效了。塞完就撤，不影响后面的量。
 */
const decoyBlind = await ev(`(() => {
  const b = document.createElement('button');
  b.textContent = '诱饵';
  b.style.cssText = 'outline: none !important; box-shadow: none !important; position: fixed; left: -9999px';
  document.body.appendChild(b);
  const s = getComputedStyle(b);
  const 看得见 = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
  b.remove();
  return 看得见;
})()`);
if (decoyBlind !== false) {
  console.error('✗ 自检没过：一个明确没有焦点标记的按钮都判成「看得见」——这个脚本的判据已经失效了');
  process.exit(1);
}

close();

// **自检**：Tab 得真的走动过。一站都没换过说明键盘事件没送到，
// 那时候「0 处没有焦点标记」是假的太平
const distinct = new Set(stops.map((s) => s.元素 + s.文)).size;
if (distinct < 3) {
  console.error(`✗ 自检没过：走了 ${STOPS} 次 Tab 只到过 ${distinct} 个地方——键盘事件多半没送到，这轮结果不算数`);
  process.exit(1);
}

console.log(`Tab 走了 ${stops.length} 站，到过 ${distinct} 个不同的地方`);
for (const s of stops.slice(0, 4)) console.log('   ', JSON.stringify(s));
console.log(`\n没有可见焦点标记的：${blind.length} 处`);
for (const b of blind) console.log('   ', JSON.stringify(b));

console.log('\n弹窗里的焦点：');
for (const x of landed) console.log('   ', JSON.stringify(x));
console.log(`焦点跑出弹窗的：${leak.length} 处`);
for (const x of leak) console.log('   ', JSON.stringify(x));

console.log(`
原地换一层弹窗：${swap.length ? '' : '焦点和标记都对'}`);
for (const x of swap) console.log('   ', JSON.stringify(x));

console.log(`
卡片上键盘够不够得到：${tools.length ? '' : '封面是按钮、在 tab 序里、名字里有书名；那排操作条聚焦时会展开'}`);
for (const x of tools) console.log('   ', JSON.stringify(x));

console.log(`
打分那个控件（可及名称和状态）：${ax.length ? '' : '五颗星各有名字，当前那颗标着已按下，这一组叫「评分」'}`);
for (const x of ax) console.log('   ', JSON.stringify(x));

console.log(`
弹窗自己有没有名字：${没名字的弹窗.length ? '' : '开着的弹窗都念得出标题'}`);
for (const x of 没名字的弹窗) console.log('   ', JSON.stringify(x));

console.log(`
每个控件都有能读的名字：${没名字.length ? '' : '书架和评价浮层上，所有按钮/下拉/输入框都有'}`);
for (const x of 没名字) console.log('   ', JSON.stringify(x));

process.exit(blind.length + leak.length + swap.length + tools.length + ax.length + 没名字.length + 没名字的弹窗.length ? 1 : 0);
