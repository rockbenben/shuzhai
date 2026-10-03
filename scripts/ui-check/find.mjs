/**
 * 端到端走一遍**书内搜索**这条线：
 * 搜得到 → 点第几处就真的落在那一处 → 换一章也落得下去 → 切了繁简还搜得到；
 * 然后在 PDF 和 EPUB 查看器里各走一遍落点。
 *
 *   node scripts/ui-check/find.mjs
 *
 * ── 为什么单开一条 ──────────────────────────────────
 *
 * 已有的几条端到端覆盖的是**读**（`walk.mjs`）、**归置**（`review.mjs`）、
 * **做笔记**（`notes.mjs`）。搜索一直没有——而它是唯一一个「结果列成一排、
 * 每一条都要能点回去」的功能，`ordinal` 那条链（core 数出来 → 界面递过去 →
 * 屏幕上的段落表里找回第 n 处）三段里断任何一段，界面都**只是回到章首**，
 * 一句错都不报。单元测试能钉住第一段（`search.test.ts` / `paragraphs.test.ts`），
 * 后两段是 DOM，只有跑着的应用量得到。
 *
 * ⚠️ **和 `notes.mjs` 同一个理由，三个界面都要走。** txt 的落点走
 * `第n处`（内存里的段落表），PDF / EPUB 走 `找第几处`（DOM 里数）——
 * 两份实现，而这个仓库在两个阅读界面之间抓到过三次分叉，
 * 两边各自的测试都是绿的。
 *
 * ⚠️ **这条走查会点开书、翻章、切繁简**，那些都写进 `reading_state` / `app_setting`
 * （铁律 3 的数据）。只在测试档案上跑，由 `guardTestLibrary()` 把关。
 */
import { connect, guardTestLibrary, rpc, setInput } from './cdp.mjs';

await guardTestLibrary();
const { ev, wait, reload, close } = await connect();
// 同 notes.mjs：先刷新，别接在别人留下的那一屏上跑
await reload();
await wait(1800);

const fail = [];
const step = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✗'} ${name}${detail ? '　' + detail : ''}`);
  if (!ok) fail.push(name);
};
/** 等一个条件成立。固定等待是走查里最常见的假失败来源 */
const until = async (expr, ms = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await wait(300); }
  return false;
};

/** 从书架点开一本 `data-book-id` 的书 */
const 开书 = async (id) => {
  await ev(`(() => { const c=document.querySelector('.book[data-book-id="${id}"]');`
    + ` c?.querySelector('.book-art')?.click(); return !!c; })()`);
  return until("!!document.querySelector('.reader-body') || !!document.querySelector('.viewer-box')", 12000);
};

/**
 * 打开书内搜索、打一个词、搜。
 *
 * ⚠️ **那个键的 `title` 两个界面不一样**——txt 是「在这本书里搜…」，
 * 查看器是「在这本书里找一段话」。所以认「在这本书里」这一段就行，
 * 别钉全句（钉全句的症状是查看器那两段一条都搜不到，看着像搜索坏了）。
 *
 * ⚠️ **已经开着就先收掉再点。** 右轨那排键是 toggle（`只开一个(开着的 === w ? null : w)`），
 * 面板开着时再点一次是**把它关掉**，于是第二次 `搜()` 拿不到输入框。
 * 一条走查里连点数处就必须收一次，否则第一条之后的每一条都是空的。
 *
 * 卡在哪一步记在 `搜卡` 里，跟着读数一起印出来——走查最怕「一句 0 处」
 * 而分不清是功能坏了还是根本没点着。
 */
let 搜卡 = '';
const 搜 = async (词) => {
  搜卡 = '';
  // 出口那颗键认 **aria-label 里的「书内搜索」**这一截，不认「面板里第一个带 aria-label 的键」——
  // 后者在 2026-10-03 那次改文案（`×` → 「收起」）时飘掉了：换了写法就没标签，
  // 于是旧面板收不掉、下面三次点的全是空列表，报出来像「落点坏了」。
  // **探针按界面属性匹配，属性就是接口**（同上面 title 那一处），两边都得知道。
  if (await ev("!!document.querySelector('.find-panel')")) {
    await ev("(() => { const b=[...document.querySelectorAll('.find-panel button')]"
      + ".find(x=>/书内搜索/.test(x.getAttribute('aria-label')||'')); if(!b) return 'no-exit'; b.click(); return 1; })()");
    if (!(await until("!document.querySelector('.find-panel')", 4000))) { 搜卡 = '收不掉旧面板'; return false; }
    await wait(200);
  }
  const 开了 = await until(
    "(() => { const b=[...document.querySelectorAll('.reader-tools button')]"
    + ".find(x=>/在这本书里/.test(x.title||'')); if(!b) return false; b.click(); return true; })()",
    6000,
  );
  if (!开了) { 搜卡 = '右轨没有那个键'; return false; }
  if (!(await until("!!document.querySelector('.find-panel input')", 4000))) { 搜卡 = '面板没开'; return false; }
  await ev(setInput("document.querySelector('.find-panel input')", 词));
  await ev("(() => { [...document.querySelectorAll('.find-panel button')]"
    + ".find(b=>b.textContent.trim()==='搜索')?.click(); return 1; })()");
  const 出 = await until(
    "!![...document.querySelectorAll('.find-panel .find-hit,.find-panel .muted')]"
    + ".find(x=>/命中|没有找到|只列了/.test(x.textContent||''))",
    20000,
  );
  if (!出) 搜卡 = '搜完没读数';
  return 出;
};

const 命中数 = () => ev("document.querySelectorAll('.find-panel .find-hit').length");
/** 面板自己那句原话。缺了它，一条「0 处」分不清是没搜到还是没点着 */
const 读数 = () => ev("[...document.querySelectorAll('.find-panel .muted')].map(x=>x.textContent).join('｜').slice(0,60)");
const 点第k条 = (k) => ev(
  `(() => { const b=document.querySelectorAll('.find-panel .find-hit')[${k - 1}];`
  + ` if(!b) return false; b.click(); return true; })()`,
);

/**
 * **txt：点第 `第几` 处，屏幕是不是滚到了那一段。**
 *
 * 判据不是「哪一段顶到视口上沿」——**那一处如果已经贴近本章末尾，滚不动了**
 * （`scrollTo` 会被本章的最大滚动量夹住），按顶沿读就会读成「落在前面那一处」。
 * 实测踩过：`第 3 处` 落在本章最后三段里，读数报 `第 2 处`，看着像实现坏了。
 *
 * 所以量的是「该到的位置」和实际scrollTop的**差**：
 * 该到的位置 = `夹过的 min(最大滚动量, 那一段的顶 - 8)`——
 * 和 `Reader.tsx` 那条 effect 同一步算式，但独立在这里算一遍。
 * 差 0 就是落对了；落错一处的时候差的是整段高度，不会误判成 0。
 *
 * 数第几处的方法和 `core/paragraphs.ts` 的 `第n处` 一句一句对着来：
 * 标题排第 1（它画成 `<h2>`），之后按段落顺序，**那一段自己也算进去**。
 */
const 读落点 = (词, 第几) => ev(`(() => {
  const box = document.querySelector('.reader-body');
  const art = box && box.querySelector('article[data-chapter]');
  if (!box || !art) return null;
  const ps = [...art.querySelectorAll('p[data-offset]')];
  if (!ps.length) return null;
  const 词 = ${JSON.stringify(词)};
  const 第几 = ${第几};
  let 数 = 0, 目标 = null;
  const 扫 = (s) => {
    for (let a = s.indexOf(词); a >= 0; a = s.indexOf(词, a + 词.length)) if (++数 === 第几) return true;
    return false;
  };
  if (!扫(art.querySelector('h2')?.textContent ?? '')) {
    for (const p of ps) if (扫(p.textContent)) { 目标 = p; break; }
  }
  if (!目标) return { 章: Number(art.dataset.chapter), 差: null, 段: '数不到这一处' };
  const 最大 = box.scrollHeight - box.clientHeight;
  const 该 = Math.max(0, Math.min(最大, 目标.offsetTop - box.offsetTop - 8));
  const 顶 = 目标.offsetTop - box.offsetTop;
  const 可见 = 顶 >= box.scrollTop - 2 && 顶 + 目标.offsetHeight <= box.scrollTop + box.clientHeight + 2;
  return {
    章: Number(art.dataset.chapter),
    差: Math.round(box.scrollTop - 该),
    段: (目标.textContent ?? '').slice(0, 14),
    可见,
    夹住了: 顶 - 8 > 最大,
  };
})()`);

/**
 * 闪起来那一段，**文字得正好是搜的那个词**。
 *
 * 这一条不为难自己：它不证明「是第 n 处」（第 n 处由 txt 那三条和 PDF 的页码证明），
 * 它证明的是 `找第几处` 交回的 Range **边界对**——起止各偏一个字、或者整段夹多了，
 * 都会在这里露出来。少了它，「闪得起来」可以是一个乱画的 Range。
 */
/**
 * 读 `shuzhai-flash` 里那一段的文字。`顶层` = PDF（主文档），否则 EPUB（iframe）。
 * ⚠️ **只读一次**：`闪一下` 1400ms 后自己撤，断言和读数不能各读一遍。
 */
const 闪的文字 = (顶层) => ev(顶层
  ? "(() => { const hl=window.CSS.highlights.get('shuzhai-flash');"
    + " const r=hl&&Array.from(hl)[0]; return r?r.toString():''; })()"
  : "(() => { const f=document.querySelector('iframe');"
    + " const hl=f?.contentWindow?.CSS?.highlights?.get('shuzhai-flash');"
    + " const r=hl&&Array.from(hl)[0]; return r?r.toString():''; })()");

/* ══ 一、txt ══════════════════════════════════════════ */

// 夹具里每章 12 段、四段轮着排，所以「价格闯关」在**同一章里正好三处**——
// 那是这一条要量的形状：三条结果，三个不同的落点。
const txt词 = '价格闯关';
const 列 = (await rpc('book.list', { filter: {}, limit: 60 })).r;
let 本 = null;
for (const b of (列.rows ?? 列)) {
  // PDF / EPUB 是只编目的，章节表天生是空的——`cs.length >= 6` 就把它们挡在外面了
  const cs = (await rpc('book.chapters', { bookId: b.id })).r ?? [];
  if (cs.length < 6) continue;
  本 = b; break;
}
if (!本) { console.error('✗ 测试库里没有一本 ≥6 章的 txt——先跑 make-testlib.mjs'); process.exit(1); }
console.log(`拿《${本.title}》走 txt 这一半`);

await 开书(本.id);
step('txt 进得了阅读器', !!(await ev("!!document.querySelector('.reader-body')")));

const 搜到了 = await 搜(txt词);
const 有几处 = await 命中数();
step('书内搜索列得出命中', 搜到了 && 有几处 >= 3, `拿到 ${有几处} 处`);

/*
 * ⚠️ **每点一条都要重新搜一遍。** 点下去的那一下 `FindInBook` 自己就把面板收了
 * （「开着浮层点正文是收起来」那一族规矩），所以上一条点完，下一处的列表已经没了。
 * 复用旧列表的症状是 `querySelectorAll` 拿到 0 条、于是「第 2 处」根本没被点过，
 * 而断言只是拿到一个空的落点——看起来像落点坏了。
 */
const 点一处 = async (词, k) => {
  if (!(await 搜(词))) return null;
  if (!(await 点第k条(k))) return null;
  await wait(800);
  return 读落点(词, k);
};

/** 一条一条点，看落点是不是那条自己说的那一处 */
const 落点 = [];
for (const k of [1, 2, 3]) {
  const r = await 点一处(txt词, k);
  if (!r) break;
  落点.push(r);
}
// 后端那三份「第几处」一起印出来：落点和它对不上，才分得出是数错了还是落错了
const 后端 = (await rpc('search.inBook', { bookId: 本.id, query: txt词 })).r
  .slice(0, 3).map((h) => `${h.chapterIdx}:${h.ordinal}`).join(' ');
step(
  '点第 1 / 2 / 3 处，三次都落在那一段上（差 ≤ 4px）',
  落点.length === 3 && 落点.every((r) => r.差 !== null && Math.abs(r.差) <= 4),
  落点.map((r) => (r ? `差${r.差}px${r.夹住了 ? '(已夹到底)' : ''}` : '量不到')).join(' / ') + `　后端 [${后端}]`,
);

/*
 * **换一章的那一处也要落得下去。**
 * 前面三条都在同一章，走的是「已经铺在这一屏」那条捷径；跨章要等
 * `chapter.read` 回来、`flow` 里有了这一章，`落点计划` 才兑现得了。
 * 少等这一步的症状是回到**新章的章首**——和第 1 处往往只差一个标题，很难看出来。
 *
 * 拿哪一条当「别一章的那一条」，问后端那份列表（它带 `ordinal`），
 * 不去猜界面上那行章名——猜章名等于把判据建在排版上。
 */
const 全 = (await rpc('search.inBook', { bookId: 本.id, query: txt词 })).r;
const 跨 = 全.findIndex((h, i) => i > 0 && h.chapterIdx !== 全[0].chapterIdx);
const 跨条 = 跨 >= 0 ? 全[跨] : null;
await 搜(txt词);
const 跨点 = 跨条 && await 点第k条(跨 + 1);
await wait(1600);
const 落在 = 跨条 && await 读落点(txt词, 跨条.ordinal);
step(
  `点第 ${跨 + 1} 条（第 ${跨条?.chapterIdx} 章的第 ${跨条?.ordinal} 处），那一段在视口里`,
  !!跨点 && !!落在 && 落在.章 === 跨条.chapterIdx && 落在.可见,
  落在 ? `第 ${落在.章} 章，差 ${落在.差}px，可见 ${落在.可见}` : '量不到',
);

/*
 * **繁简：切到「显示繁体」之后，照着屏幕打的繁体词得搜得到。**
 *
 * 这是这一轮修的原件：`searchInBook` 原来只套清洗、不套转换，而阅读器是两道都套的。
 * 于是满屏繁体、打个繁体词，界面回一句「没有找到」——而那句是假话。
 * 走 HTTP rpc 验不了字形对不对得上，只有点进这一本书、切了这一档才算数。
 */
await rpc('convert.set', { bookId: 本.id, mode: 'to-traditional' });
await reload();
await wait(1800);
await 开书(本.id);
const 繁体 = await 搜('價格闖關');
const 繁体处 = await 命中数();
step('显示繁体时搜繁体词搜得到（不是「没有找到」）', 繁体 && 繁体处 >= 3, `拿到 ${繁体处} 处`);
/*
 * ⚠️ **认 `<mark>`，不认 `【】`。** `FindInBook` 把 `makeSnippet` 的 `【】`
 * 拆成 `<mark>` 画上去（`part.slice(1, -1)` 把那对括号去掉），
 * 所以 `textContent` 里根本不会有它们——拿 `【…】` 断言永远红。
 */
const 繁体标 = await ev(
  "(() => { const m=document.querySelector('.find-panel .find-hit mark');"
  + " return m ? m.textContent : ''; })()",
);
step('命中片段是看得见的繁体的字，而且标出来了', 繁体标 === '價格闖關', `标出来的是「${繁体标}」`);
await rpc('convert.set', { bookId: 本.id, mode: 'off' });

/* ══ 二、PDF ══════════════════════════════════════════ */

/**
 * 落点在不在，问原生那一份注册表：`闪一下` 是把 Range 放进
 * `CSS.highlights` 的 `shuzhai-flash`（**顶层窗口一份的**）。
 * 放得进去 = `找第几处` 数到了那一处；1400ms 后它自己撤掉。
 */
const 顶层有闪 = "window.CSS?.highlights ? window.CSS.highlights.has('shuzhai-flash') : false";
const PDF词 = 'Shuzhai';
const 列2 = (await rpc('book.list', { filter: {}, limit: 60 })).r;
const PDF本 = (列2.rows ?? 列2).find((b) => /PDF/.test(b.title));
if (PDF本) {
  await reload(); await wait(1500);
  await 开书(PDF本.id);
  /*
   * ⚠️ **要等到页真的铺开，不能只等到右轨。**
   * `.reader-tools` 在 `搜正文.current` 装上**之前**就渲染出来了，而那个 ref
   * 的初值是 `async () => []`——在这之前搜，得到的是**空列表**，界面上印的是
   * 「没有找到」，和「这本书里真没有那个词」逐字相同。
   * 这就是本仓库反复记的那一族：「没找到」看起来和「不存在」一模一样。
   */
  const 进了 = await until("!!document.querySelector('.pdf-page')", 30000);
  step('PDF 的页真的铺开了', 进了);
  if (进了) {
    const 有 = await 搜(PDF词);
    step('PDF 里搜得到', 有 && (await 命中数()) >= 2,
      `拿到 ${await 命中数()} 处，面板说「${await 读数()}」${搜卡 ? '（卡在' + 搜卡 + '）' : ''}`);
    const 第2 = await 点第k条(2);
    const 闪了 = await until(顶层有闪, 5000);
    step('PDF 点第 2 条能落到那一处（闪得起来）', 第2 && 闪了);
    /*
     * ⚠️ **页码和 Range 的文字一次读。** `闪一下` 1400ms 后自己撤掉，
     * 分两次 `ev` 就是让第二次去抢那 1400ms——抢不过就是「闪不起来」的假红。
     */
    const 落 = await ev(
      "(() => { const hl=window.CSS.highlights.get('shuzhai-flash'); if(!hl) return null;"
      + " const r=Array.from(hl)[0]; if(!r) return null;"
      + " const el=r.startContainer.nodeType===3?r.startContainer.parentElement:r.startContainer;"
      + " const 壳=el?.closest?.('.pdf-page');"
      + " return { 页: 壳?Number(壳.dataset.n):null, 文字: r.toString() }; })()",
    );
    step('PDF 落点确实落在它自己那一条上', 落?.页 === 2, `量到第 ${落?.页} 页，本该第 2 页`);
    step('PDF 闪起来那一段的文字正好是搜的词（Range 边界没画歪）', 落?.文字 === PDF词,
      `量到「${落?.文字}」`);
  }
} else {
  step('测试库里有一本 PDF', false, '没找到——find.mjs 的第二段跑不起来');
}

/* ══ 三、EPUB ══════════════════════════════════════════ */

const 列3 = (await rpc('book.list', { filter: {}, limit: 60 })).r;
const EPUB本 = (列3.rows ?? 列3).find((b) => /EPUB/.test(b.title));
if (EPUB本) {
  await reload(); await wait(1500);
  await 开书(EPUB本.id);
  /*
   * 等到 iframe **里有正文**为止。⚠️ **别拿字数当门槛**：spine 的第一节是封面页，
   * 夹具里那句「书斋测试用的 EPUB。」才十几个字，卡 `> 50` 会一路等到超时，
   * 看起来像 EPUB 查看器坏了。
   */
  const 进了 = await until(
    "(() => { const f=document.querySelector('iframe');"
    + " const d=f?.contentDocument; return !!(d && d.body && d.body.textContent.trim().length > 0); })()",
    30000,
  );
  step('EPUB 的节真的铺开了（iframe 里有正文）', 进了);
  if (进了) {
    const EPUB词 = '柳暗花明';
    const 有 = await 搜(EPUB词);
    step('EPUB 里搜得到', 有 && (await 命中数()) >= 3,
      `拿到 ${await 命中数()} 处，面板说「${await 读数()}」${搜卡 ? '（卡在' + 搜卡 + '）' : ''}`);
    const 第3 = await 点第k条(3);
    /*
     * ⚠️ **EPUB 的注册表在 iframe 那个窗口上**，不在顶层。
     * 「闪一下闪上去撤不掉」那条坑（`闪一下` 顶上的注释）记的就是这两个窗口
     * 不是一回事——定时器要排顶层，而 `CSS.highlights` 各算各的。
     */
    const 读 = "(() => { const f=document.querySelector('iframe');"
      + " const w=f?.contentWindow; if(!w?.CSS?.highlights) return false;"
      + " return w.CSS.highlights.has('shuzhai-flash'); })()";
    const 闪了 = await until(读, 5000);
    const 文字 = await 闪的文字(false);
    step('EPUB 点第 3 条能落到那一处（闪得起来）', 第3 && 闪了);
    step('EPUB 闪起来那一段的文字正好是搜的词（Range 边界没画歪）', 文字 === EPUB词,
      `读到「${文字}」`);
  }
} else {
  step('测试库里有一本 EPUB', false, '没找到——find.mjs 的第三段跑不起来');
}

console.log(fail.length ? `\n✗ ${fail.length} 条没过：\n  - ${fail.join('\n  - ')}` : '\n✔ 书内搜索这一条线全过');
close();
process.exit(fail.length ? 1 : 0);
