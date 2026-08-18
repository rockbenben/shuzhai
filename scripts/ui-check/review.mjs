/**
 * 端到端：**把一批书归置好**。
 *
 * `walk.mjs` 走的是「第一次打开 → 读完一本 → 回来找到它」，
 * 而评价体系那一批（添读过的书、批量打标签、标签管理合并、按星级筛、
 * 批量改状态）**一条端到端守卫都没有**——单元测试各自都有，
 * 但「点开那个弹窗、填进去、看结果对不对」这条链一直靠人手工走一遍。
 *
 * 这个脚本把手工那一遍固定下来。和 walk.mjs 分开写而不是接在后面：
 * 那边讲的是「第一次用」，这边讲的是「已经有一堆书了怎么归置」，
 * 两个故事混在一起谁都读不顺。
 *
 *   node scripts/ui-check/review.mjs
 *
 * **要一个已经有书的测试库**（先跑 walk.mjs，或自己 root.add 一个）。
 */
import { connect, guardTestLibrary, rpc, setInput, 切档, 开工具} from './cdp.mjs';

/*
 * 开关上的标签文字。**只取文本节点，跳过 `.chip-n` 那个书数**——
 * 标签开关和星级开关都在名字后面挂着一个书数的 span，拿整个 `textContent`
 * 去全等匹配会得到「★3+4」，一下都点不到，而报出来的是
 * 「筛完界面 9 / 后端 4」——**看起来像筛选功能坏了**（这一轮真的据此红过两步）。
 */
const CHIP_LABEL = "(x => [...x.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim())";

const stats = await guardTestLibrary();
if (!stats.books) {
  console.error('✗ 这个库里一本书都没有——先给这个档案加一个测试书库目录再跑');
  process.exit(1);
}

const { send, ev, wait, key, reload, close } = await connect();
const fail = [];

/** 等一个条件成立。固定等待是走查里最常见的假失败来源，见 README */
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
/** 点侧栏底部的某个管理工具（低频那九个收在「更多工具」里） */
const 开工具了 = 开工具(ev, until);

const step = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✗'} ${name}${detail ? '　' + detail : ''}`);
  if (!ok) fail.push(name);
};

const closeModal = async () => {
  await ev("(() => { const b=document.querySelector('.modal-backdrop'); if(b) b.click(); return 1; })()");
  await wait(500);
};

/**
 * 按钮名字点开一个弹窗。
 *
 * **不能只在 `.nav-tool` 里找**：侧栏那排是 `.nav-tool`，
 * 而「批量打标签」「批量改状态」在书架上方的 `.main-head` 里，一个类名都没有。
 * 第一版就是这么写的，报出来是「按钮点不开」——听着像功能坏了，
 * 其实是探针只翻了半个页面。
 */
const openTool = async (name) => {
  /*
   * ⚠️ **低频的那几个收进侧栏的「更多工具」了**，主栏上直接找不到。
   * （**别在这儿记个数**：那份名单会变，`cdp.mjs` 的 `开工具` 上记着为什么。）
   * `开工具` 会先展开再点——不展开的话这里返回 false，
   * 报出来是「按钮点不开」，而按钮好好地在折叠里。
   */
  if (!(await 开工具了(name))) {
    // 不是侧栏工具（比如书架顶部那几个批量按钮）就照旧按文字找
    const found = await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(name)});
      if (!b || b.disabled) return 0;
      b.click();
      return 1;
    })()`);
    if (!found) return false;
  }
  return until("!!document.querySelector('.modal')");
};

const enter = (sel) => `(() => {
  const i = document.querySelector(${JSON.stringify(sel)});
  if (!i) return 0;
  const k = Object.keys(i).find((x) => x.startsWith('__reactProps'));
  i[k].onKeyDown({ key: 'Enter', preventDefault() {}, target: i });
  return 1;
})()`;

const blur = (sel) => `(() => {
  const i = document.querySelector(${JSON.stringify(sel)});
  if (!i) return 0;
  const k = Object.keys(i).find((x) => x.startsWith('__reactProps'));
  i[k].onBlur({ target: i });
  return 1;
})()`;

const numIn = (sel, re) => `(() => {
  const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${re}.test(x.textContent));
  const m = (b ? b.textContent : '').match(/(\\d+)/);
  return m ? Number(m[1]) : -1;
})()`;

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

/*
 * **阅读方式也要收拾。** 它存在 localStorage 里，跨重载保留——上一跑（或者手工
 * 调过的探针）留下的「左右翻」「无限下滑」会让后面凡是开阅读器的步骤全部错位，
 * 而报出来的话跟真正的原因毫无关系（「评价卡片打不开」）。
 * 同下面那条「先删掉这份走查会用到的标签」，判据是同一条。
 */
await ev("(() => { const k='novel.read-settings'; const s=JSON.parse(localStorage.getItem(k)||'{}'); s.mode='scroll'; localStorage.setItem(k, JSON.stringify(s)); return 1; })()");

await reload();
await wait(3000);

/*
 * **开跑之前先收拾上一次的残局。**
 *
 * 这份走查往库里造东西：标签、划线、评价。跑到一半挂掉（上一个改动把界面弄坏了、
 * 探针中途报错、人按了 Ctrl-C）就会留下半截数据，而下一次跑**报出来的是假失败**——
 * 而且失败的步骤名和真正的原因对不上（README 里「症状会飘到别的步骤上」那条）。
 *
 * 实测踩过两次：
 *   - 「临时·待删」那个标签留着 → 第 11 步从「这个标签已经存在」开跑；
 *   - 「走查标签」多挂了一本 → 报「还挂着 3 本（该是 2）」，那一步在第 2 步，
 *     当时红的却是第 2、6、7 三步。
 *
 * 所以收拾放在**开头**、放在**一处**：让造数据的步骤各写一遍 pre-clean，
 * 就又是「同一份约定抄成几份」了。
 */
const FIXTURE_TAGS = ['走查标签', '走查甲', '走查甲乙', '临时·待删'];
for (const t of ((await rpc('tag.list')).r ?? [])) {
  if (FIXTURE_TAGS.includes(t.name)) await rpc('tag.delete', { tagId: t.id, confirmed: true });
}
for (const b of ((await rpc('book.list', { page: { limit: 200 } })).r ?? [])) {
  for (const h of ((await rpc('highlight.list', { bookId: b.id })).r ?? [])) {
    // **带 confirmed**：带笔记的划线有闸（第 96 轮加的）。不带的话，上一跑只要
    // 留下一条带笔记的划线，整个走查在开头就抛——而这里正是收拾残局的地方
    await rpc('highlight.remove', { id: h.id, confirmed: true });
  }
}

// ── ① 添读过的书：不填作者时认领已有那本，不新建 ──────────────
const TITLE = '走查添的书';
await rpc('book.addManual', { title: TITLE });
await openTool('添读过的书');
await until("!!document.querySelector('.modal')");
await ev(setInput("document.querySelectorAll('.modal input')[0]", TITLE));
await wait(400);
await ev("(() => { const b=[...document.querySelectorAll('.modal-actions button')].find(x=>/添加|记下/.test(x.textContent)); if(b) b.click(); return 1; })()");
const claimed = await until("(document.querySelector('.modal')||{}).textContent?.includes('库里已经有')");
step('不填作者再添一次，认领已有那本而不是新建', claimed, claimed ? '' : '没看到「库里已经有」那句');
await closeModal();

// ── ② 批量打标签：按钮上的数就是真会改的数 ──────────────────
//
// ⚠️ **先给一部分书打上这个标签**，否则「筛中的本数」和「会变的本数」相等，
// 两种写法给出同一个数——**这条判据就永远绿**。第一版就是这么写的：
// 把第一轮那个 bug（按钮上写 matchCount）原样放回去，走查照样全过。
// 判据要自己造出那个差值，不能指望库里恰好有。
// 这一步靠「先有 2 本带着这个标签」造出差值。上一次的残局在开头统一清过了
const someBooks = ((await rpc('book.list', { limit: 2 })).r ?? []).map((b) => b.id);
await rpc('tag.add', { bookIds: someBooks, names: ['走查标签'] });
await reload();
await wait(2600);
const matched = ((await rpc('book.matchCount', { filter: {} })).r ?? {}).n ?? 0;

if (await openTool('批量打标签')) {
  // ⚠️ `setInput` 收的是**取元素的表达式**，不是选择器——直接传 '.modal input'
  // 会拼成 `const el = .modal input`，一个语法错误。而它的返回值不看就发现不了：
  // 表面现象是「打上（0 本）」，看起来像批量打标签坏了
  await ev(setInput("document.querySelector('.modal input[placeholder*=\"标签名\"]')", '走查标签'));
  await wait(600);
  await ev(enter('.modal input[placeholder*="标签名"]'));
  // 等预览算完（按钮上的数从 0 变成真数），别按固定时间猜
  await until("(() => { const b=[...document.querySelectorAll('.modal-actions button')].find(x=>/打上/.test(x.textContent)); return b && !/（0 本）/.test(b.textContent); })()");
  const planned = await ev(numIn('.modal-actions button', /打上/));
  await ev("(() => { const b=[...document.querySelectorAll('.modal-actions button')].find(x=>/打上/.test(x.textContent)); if(b) b.click(); return 1; })()");
  await until("(document.querySelector('.modal .card')||{}).textContent?.includes('已给')");
  const done = await ev(numIn('.modal .card strong', /已给/));
  step(
    '批量打标签：按钮上的数就是真改的数（不是筛中的总数）',
    planned > 0 && planned === done && planned < matched,
    `筛中 ${matched} / 按钮说 ${planned} / 实际改 ${done}`,
  );

  await ev("(() => { const b=[...document.querySelectorAll('.modal-actions button')].find(x=>x.textContent.trim()==='撤销'); if(b) b.click(); return 1; })()");
  await wait(1600);
  await closeModal();
  // 撤销只该摘掉**这次新打上的**，先前那两本要原样留着——
  // `tag.addByFilter` 返回的是实际新增的关联，撤销靠的就是它
  const left = ((await rpc('tag.list')).r ?? []).find((t) => t.name === '走查标签');
  step(
    '撤销只摘这次新打的，不动之前打好的',
    !!left && left.count === someBooks.length,
    left ? `还挂着 ${left.count} 本（该是 ${someBooks.length}）` : '标签整个没了',
  );
  await rpc('tag.delete', { tagId: left?.id });
} else {
  step('批量打标签：能打开', false, '按钮点不开');
}

// ── ③ 标签管理：搜得到 + 改名即合并 ────────────────────────
const twoBooks = ((await rpc('book.list', { limit: 2 })).r ?? []).map((b) => b.id);
await rpc('tag.add', { bookIds: twoBooks, names: ['走查甲', '走查甲乙'] });
await reload();
await wait(2600);
if (await openTool('标签管理')) {
  if (await ev('!!document.querySelector(\'.modal input[placeholder*="搜标签"]\')')) {
    await ev(setInput("document.querySelector('.modal input[placeholder*=\"搜标签\"]')", '走查甲'));
    await wait(900);
  }
  const shown = await ev("(() => [...document.querySelectorAll('.modal .row button')].map(b=>b.textContent.trim()).filter(t=>t.startsWith('走查甲')))()");
  step('标签管理里搜得到，两个变体挨在一起', Array.isArray(shown) && shown.length === 2, JSON.stringify(shown));

  const before = ((await rpc('tag.list')).r ?? []).length;
  await ev("(() => { const b=[...document.querySelectorAll('.modal .row button')].find(x=>x.textContent.trim()==='走查甲乙'); if(b) b.click(); return !!b; })()");
  await wait(700);
  await ev(setInput("document.querySelector('.modal .row input')", '走查甲'));
  await wait(400);
  await ev(blur('.modal .row input'));
  await wait(1200);
  /*
   * **合并要先问一次。** 合并不可撤销（两个标签变成一个，`book_tag` 的行并过去
   * 就回不来了），而最容易撞上的一幕是「改了一半改主意去点关闭」——
   * mousedown 会先让输入框失焦，改名就执行了。所以失焦之后**不该直接合并**，
   * 而该摆一句话出来问。
   */
  const 问了 = await ev("(() => { const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='确认合并'); return !!b; })()");
  const 还没合 = ((await rpc('tag.list')).r ?? []).length === before;
  step('合并前先问一次，而且在确认之前一个标签都没动',
    问了 === true && 还没合, `问了=${问了} / 还没合=${还没合}`);

  await ev("(() => { const b=[...document.querySelectorAll('.modal button')].find(x=>x.textContent.trim()==='确认合并'); if(b) b.click(); return !!b; })()");
  await wait(1600);
  const after = ((await rpc('tag.list')).r ?? []).length;
  step('确认之后才真的合并', after === before - 1, `${before} → ${after}`);
  await closeModal();
} else {
  step('标签管理：能打开', false, '按钮点不开');
}

// ── ④ 分类：文件夹＋评分这类规则组合出来的一堆，界面剩下的和后端算的要一致 ──
//
// 原来这一步测的是书架上那排「★3+」开关。**那排开关已经不在了**——
// 按文件夹、按评分当规则可以，当分类太粗（一个文件夹里什么都有，
// 三星以上横跨所有题材），现在它们退回到分类编辑器里当字段。
// 判据一个字没变：**界面剩的和后端算的一致，而且真的筛掉了一些**。
//
// ⚠️ **自己造出一本 5 分的书**，别指望库里恰好有。
// 第一版靠 `minRating: 1` 判断「有没有评过分的书」就开跑，
// 结果撞上一本 2 分的：`minRating: 3` 后端算 0、界面也 0，
// **两边都是 0 当然一致，这条断言什么都没证明**。
const oneBook = ((await rpc('book.list', { limit: 1 })).r ?? [])[0];
await rpc('reading.setStatus', { bookId: oneBook?.id, rating: 5 });
const anyRated = ((await rpc('book.matchCount', { filter: { minRating: 3 } })).r ?? {}).n ?? 0;
if (anyRated > 0) {
  // 开跑前先收拾上一跑留下的同名分类（同本文件开头那段「收拾残局」）
  for (const c of ((await rpc('shelf.list', {})).r ?? [])) {
    if (c.name === '走查·三星以上') await rpc('shelf.remove', { id: c.id });
  }
  await rpc('shelf.save', { name: '走查·三星以上', filter: { minRating: 3 } });
  await reload();
  // **等那一排真的出现，别按固定时间猜**（README 第一条：固定等待是假失败的头号来源）
  await until(`[...document.querySelectorAll('.shelf-tabs .chip')].some(c => ${CHIP_LABEL}(c) === '走查·三星以上')`);
  const clicked = await ev(`(() => { const c=[...document.querySelectorAll('.shelf-tabs .chip')].find(x=>${CHIP_LABEL}(x)==='走查·三星以上'); if(!c) return 0; c.click(); return 1; })()`);
  const expect = ((await rpc('book.matchCount', { filter: { minRating: 3 } })).r ?? {}).n ?? -1;
  // 等书架真的收敛到那个数，而不是等一个拍脑袋的毫秒数
  await until(`document.querySelectorAll('.book').length === ${expect}`, 6000);
  const shown = await ev("(() => document.querySelectorAll('.book').length)()");
  const unfiltered = ((await rpc('book.matchCount', { filter: {} })).r ?? {}).n ?? 0;
  step(
    '按分类筛，书架上剩的和后端算的一致（而且真的筛掉了一些）',
    !!clicked && shown === expect && expect > 0 && expect < unfiltered,
    `不筛 ${unfiltered} / 筛完界面 ${shown} / 后端 ${expect}`,
  );
  // 收尾：点回「全部」并把这个分类删掉，不给后面的步骤留残局
  await ev(`(() => { const c=[...document.querySelectorAll('.shelf-tabs .chip')].find(x=>${CHIP_LABEL}(x)==='全部'); if(c) c.click(); return 1; })()`);
  await wait(600);
  for (const c of ((await rpc('shelf.list', {})).r ?? [])) {
    if (c.name === '走查·三星以上') await rpc('shelf.remove', { id: c.id });
  }
  await reload();
} else {
  step('按分类筛', false, '造不出评过 3 分以上的书，这一步没测成');
}

// ── ⑤ 批量改状态：预览列的是**会变的**那些，不是它的补集 ──────
if (await openTool('批量改状态')) {
  // 等预览算完再读那两个数：`planStatusByFilter` 在整库上要三百毫秒
  await until("!!document.querySelector('.modal .card ol li')");
  const n = await ev(numIn('.modal-actions button', /标成/));
  const listed = await ev("(() => document.querySelectorAll('.modal .card ol li').length)()");
  // **要钉准数，不能只写 `listed <= n`**——listed=1、n=7 时那也成立，等于没验。
  // 预览最多列 20 本（`BatchStatusDialog` 的 `PREVIEW`），所以准数是 min(n, 20)
  const want = Math.min(n, 20);
  step('批量改状态：预览列的就是会变的那些', n > 0 && listed === want,
    `会变 ${n} / 列出 ${listed}（该列 ${want}）`);
  await closeModal();
} else {
  step('批量改状态：能打开', false, '按钮点不开');
}

// ── ⑥ 备份 → 丢掉书评 → 恢复 → **界面上真的回来了** ──────────
//
// 这条链原来只有单元测试。而它是最不该只靠单测的一条：
// 备份带没带上、恢复有没有落库、**落库了界面上看不看得见**，是三件事，
// 这个循环里前两件各漏过两次（rated_at 那一列、整张 highlight 表）。
//
// 「选文件」那两步走 rpc——它们弹的是系统对话框，CDP 从此收不到指令
// （同 walk.mjs 里「加目录」那步）。**其余全部在界面上验。**
{
  const target = ((await rpc('book.list', { limit: 1 })).r ?? [])[0];
  const title = String(target?.title ?? '');
  await rpc('reading.setStatus', { bookId: target?.id, rating: 5, comment: '备份走查写的一句' });
  const bk = (await rpc('backup.export')).r;

  // 丢掉它：清空评分短评，模拟「换了台机器 / 库坏了」
  await rpc('reading.setStatus', { bookId: target?.id, rating: null, comment: null });
  await reload();
  // ⚠️ **按 id 认卡片，别按书名**：同名的书是常态（同一本书的 txt 和 epub 各一条
  // 记录，测试库里正好有一对）。按书名拿到的是**第一张**，于是这一段可能在量
  // 另一本书的卡片——而它照样会给出一个「结论」。同本文件 ⑭ ⑮ 那两步栽过一次
  const cardOf = () => `document.querySelector('.book[data-book-id="${target?.id}"]')`;
  /*
   * ⚠️ **`reload()` 之后要等卡片真的铺出来再读 DOM。**
   * 卡片来自 `book.list` 那条异步 rpc，不等就读，`cardOf` 拿到 undefined，
   * 于是 `goneFromUi` 是 false——报出来是「恢复坏了」，而其实是**读太早**。
   * 实测偶发过一次：刚重启完的第一跑最慢，正好输在这儿。
   * 这是本仓库那条「固定等待是假失败的头号来源」的同族，
   * 只不过这里连固定等待都没有（同「等的是 A、点的是 B」那次）。
   */
  await until(`!!${cardOf()}`);
  const goneFromUi = await ev(`(() => { const c = ${cardOf()};
    return !!c && !c.querySelector('.book-note') && !c.querySelector('.book-rating'); })()`);

  const rep = (await rpc('backup.import', { backup: bk })).r;
  await reload();
  // 同上：等那句短评真的回到卡片上。等不到也只是 until 返回 false，
  // 断言照样会红——**等的是它，断言的也是它，但等待不会把断言变成永远绿**
  await until(`(() => { const c = ${cardOf()}; return !!c && !!c.querySelector('.book-note'); })()`);
  const backInUi = await ev(`(() => { const c = ${cardOf()};
    if (!c) return 0;
    const note = (c.querySelector('.book-note') || {}).textContent || '';
    const star = (c.querySelector('.book-rating') || {}).textContent || '';
    return note.includes('备份走查写的一句') && star.includes('5'); })()`);
  step('备份→丢掉→恢复：书评在书架上回来了', goneFromUi === true && backInUi === true,
    `丢掉时卡片上确实没有=${goneFromUi} / 恢复后回来了=${backInUi}`);
  step('恢复报告说清了回来几条书评', (rep?.restored?.reviews ?? 0) >= 1,
    JSON.stringify(rep?.restored ?? '(报告里没有 restored)'));
}


/**
 * 点目录第 n 项，并且**确认真的翻过去了**——没翻过去就再点。
 *
 * 「点了目录」和「翻过去了」是两件事：目录刚铺出来那一瞬间 DOM 还会被重渲染
 * （正文和目录是两条 rpc），那一下点了等于没点。而后面所有断言都建立在
 * 「现在在第 n 章」上——不确认的话，报出来的失败原因全是别的东西
 * （实测两次：一次报「说了=false」像提示语坏了，一次报「点上了=false」像按钮没了）。
 *
 * 返回「到底翻过去没有」，调用方要把它写进断言。
 */
/**
 * 点目录里的第 n 项，并且**确认真的翻过去了**。
 *
 * 目录现在是**浮层，默认收起**（照用户给的 legado 参考改的），所以第一步是把它叫出来；
 * 而选完一章它会自己收起，重试时要再叫一次。
 */
const 开目录 = async () => {
  if (await ev("!!document.querySelector('.toc-item')")) return true;
  await ev(`(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.trim()==='目录'); if(!b) return 0; b.click(); return 1; })()`);
  return until("!!document.querySelector('.toc-item')", 6000);
};

const 翻到目录项 = async (n) => {
  if (!(await 开目录())) return false;
  /*
   * ⚠️ **读 `.toc-t`，不是整个按钮。** 目录项右边现在还挂着一个
   * 「划线 2 · 书签」的记号，它也在 `textContent` 里——
   * 连着截前 12 个字，拿去和正文 h2 比就永远对不上，
   * 而失败长得像「跳章跳不过去」，跟记号一点关系都看不出来。
   */
  const title = await ev(`(() => { const t=[...document.querySelectorAll('.toc-item')][${n}]; if (!t) return ''; const s = t.querySelector('.toc-t'); return (s ?? t).textContent.trim().slice(0, 12); })()`);
  if (!title) return false;
  const 到了 = `((document.querySelector('.reader-text h2')||{}).textContent||'').includes(${JSON.stringify(title)})`;
  for (let i = 0; i < 5; i++) {
    if (!(await 开目录())) return false;
    await ev(`(() => { const t=[...document.querySelectorAll('.toc-item')][${n}]; if(t) t.click(); return 1; })()`);
    if (await until(到了, 3000)) return true;
  }
  return false;
};

// 同 cardOf：按 id 认，别按书名（同名的书是常态）
const cardOf2 = (id) => `document.querySelector('.book[data-book-id="${id}"]')`;

// ── ⑦ 划线漂了要说一声，而不是让它凭空消失 ──────────────
//
// 划线存的是「章号 + 章内偏移 + 长度」。用户改了章节规则、开关了正文净化、
// 切了繁简，那个偏移就指到别的句子上了。`highlight.resolve` 拿存下来的
// `excerpt` 和该位置的正文对账，对不上就标 `intact: false`——
// **不猜也不删**（认错位置比不认更糟），由界面照实说一句。
//
// 而**划线是重扫恢复不了的数据**：一道线凭空没了，最容易让人以为丢了。
// 这条行为一直只有人手工验过。
{
  const b = ((await rpc('book.list', { limit: 20 })).r ?? [])
    .find((x) => (x.chapter_count ?? 0) > 3 && x.file_status === 'ok');
  if (!b) {
    step('划线漂了要说一声', false, '库里没有能读的多章 txt，这一步没测成');
  } else {
    const ch = (await rpc('chapter.read', { bookId: b.id, idx: 1 })).r;
    const raw = String(ch?.text ?? '');
    const body = raw.startsWith(ch?.title ?? '') ? raw.slice((ch?.title ?? '').length) : raw;
    // 一条对得上的、一条故意错位的
    await rpc('highlight.add', { bookId: b.id, chapterIdx: 1, charOffset: 10, length: 6, excerpt: body.slice(10, 16) });
    await rpc('highlight.add', { bookId: b.id, chapterIdx: 1, charOffset: 20, length: 6, excerpt: '这六个字不在' });

    await reload();
    /*
     * ⚠️ **这一段每一步的结果都要进断言。** 它偶发红过**两次**，两次报出来都是
     * 「说了=false」——看着像划线提示坏了，其实是**前面某一下没点上**：
     * 卡片还没铺出来、或者目录还没到就点了 `.toc-item`，于是停在第 0 章，
     * 而那两条划线在第 1 章。
     *
     * `until` **超时是返回 false 不是抛**，所以不检查返回值的话，
     * 一路能走到最后一句断言，报一个和真正原因毫无关系的失败。
     * 同本文件那条「『这个动作真的发生了』必须进断言」。
     */
    await until(`!!${cardOf2(b.id)}`);
    const 开了书 = await ev(`(() => { const c = ${cardOf2(b.id)}; if (!c) return false; c.querySelector('.book-art').click(); return true; })()`);
    const 到正文 = await until("!!document.querySelector('.reader-text h2')");
    // 正文和目录是两条 rpc（`chapter.read` / `book.chapters`），正文先到是常事
    // 目录是浮层、默认收起，所以先叫出来再等它铺开
    const 目录到了 = (await 开目录()) && (await until("document.querySelectorAll('.toc-item').length > 1"));
      // 「点了目录」和「翻过去了」是两件事，判据在 `翻到目录项` 上
    const 到第二章 = await 翻到目录项(1);
    const said = await until("(document.querySelector('.reader-text')||{}).textContent?.includes('对不上原文')", 12000);
    const painted = await ev("(() => document.querySelectorAll('.reader-text mark, .reader-text .hl').length)()");
    step('划线漂了：说了一句，而且只画对得上的那条',
      开了书 === true && 到正文 === true && 目录到了 === true && 到第二章 === true && said === true && painted === 1,
      `开了书=${开了书} / 到正文=${到正文} / 目录到了=${目录到了} / 到第二章=${到第二章} / 说了=${said} / 画出来 ${painted} 条（该是 1）`);

    // 收拾干净：这两条划线是走查造的，别留给下一遍
    for (const h of ((await rpc('highlight.list', { bookId: b.id })).r ?? [])) {
      await rpc('highlight.remove', { id: h.id, confirmed: true });
    }
    await ev("(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>x.textContent.includes('书架')); if(b) b.click(); return 1; })()");
    await wait(1200);
  }
}


// ── ⑧ 「在读」那一档要按「最近读的在前」排，不看全局偏好 ──────
//
// 这一档存在的理由是「接着读哪本」。默认排序恰好等价于「最后阅读时间倒序」，
// 所以平时看不出问题——**而用户一旦把全局排序改成「按书名」，
// 该接着读的那本就被埋进字母序里了**（实测过）。
// 和「我的书评」那条是同一个判据，所以守卫也照它写。
{
  const two = ((await rpc('book.list', { limit: 6 })).r ?? []).filter((b) => (b.chapter_count ?? 0) > 3).slice(0, 2);
  for (const b of two) {
    /*
     * ⚠️ **光调 `reading.save` 造不出「在读」。** `saveProgress` 只把
     * `none/want/shelved` 推成「在读」，**已读完的书它一个字都不动**
     * （那是对的：第 97 轮定的，读完的书回头翻一下不该变回在读）。
     * 于是这两本里只要有一本恰好是「已读完」，这一步就红，
     * 而报出来的是「第一本不是它」——和真正的原因对不上。
     *
     * 实测被这个咬过一次：我在别处拿探针把那本书标成了已读完。
     * **走查步骤要自己把前提摆出来，不能靠库里恰好是什么。**
     * `keepProgress` 是为了别顺手把重读次数加一（第 107 轮加的那条路）。
     */
    await rpc('reading.setStatus', { bookId: b.id, status: 'reading', keepProgress: true });
    await rpc('reading.save', { bookId: b.id, chapterIdx: 2, charOffset: 0 });
    await wait(1200);   // 让两本的 last_read_at 落在不同的秒上
  }
  await reload();
  // 先把全局排序改成「按书名」，再切到「在读」
  await ev(`(() => { const sel=document.querySelector('select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(sel,'title');
    sel[Object.keys(sel).find(k=>k.startsWith('__reactProps'))].onChange({ target: sel }); return 1; })()`);
  await wait(1200);
  await 切到('在读');
  await wait(1200);
  const sortName = await ev("(() => { const s=document.querySelector('select'); return ([...s.options].find(o=>o.selected)||{}).textContent || ''; })()");
  const first = await ev("(() => ((document.querySelector('.book-title')||{}).textContent||'').trim())()");
  const want = two.length === 2 ? two[1].title : '';
  step('「在读」按最近读的排，不被全局偏好带跑',
    /最新/.test(String(sortName)) && String(first).startsWith(String(want).slice(0, 6)),
    `排序=${sortName} / 第一本=${first}（该是 ${want}）`);
  /*
   * 收拾：把这一轮点出来的排序偏好清掉，别留给下一遍。
   *
   * ⚠️ **原来这儿写的是 `setItem('novel.sort', 'time')`——那个键已经没人读了**
   * （`settings.ts` 换成了每档一份的 `shelf.sorts`），于是这句「收拾」是个空操作，
   * 而真正的偏好原样留给了后面每一个脚本：它们共用一个 `--user-data-dir`，
   * 于是「全部」在后面几屏里一直按书名排，而 `walk.mjs` 有一条
   * 「切到「我的书评」，排序跟着变成按评价时间」会因此变红——
   * 报出来的症状和原因隔着两个脚本。
   */
  await ev("(() => { localStorage.removeItem('shelf.sorts'); return 1; })()");
}


// ── ⑨ 侧栏那几个数要跟着横向筛选走 ───────────────────────
//
// 当年为目录开关补过这条（「否则『全部 8172』旁边列着 153 本书」），
// 而后来加的标签、星级、以及一直就有的搜索词都没跟上——
// **同一个错位，同一条理由，只是新条件没人回头看那句话**。
// 星级那排开关后来降级成了分类里的一个字段，所以这一步现在点的是分类；
// 判据一个字没变。
{
  for (const c of ((await rpc('shelf.list', {})).r ?? [])) {
    if (c.name === '走查·侧栏对账') await rpc('shelf.remove', { id: c.id });
  }
  await rpc('shelf.save', { name: '走查·侧栏对账', filter: { minRating: 3 } });
  await reload();
  await until("document.querySelectorAll('.book').length > 0");
  const before = await ev("(() => Number((([...document.querySelectorAll('.nav-item')].find(x=>x.textContent.startsWith('全部'))||{}).textContent||'').replace(/[^0-9]/g,'')))()");
  await until(`[...document.querySelectorAll('.shelf-tabs .chip')].some(c => ${CHIP_LABEL}(c) === '走查·侧栏对账')`);
  const clicked = await ev(`(() => { const c=[...document.querySelectorAll('.shelf-tabs .chip')].find(x=>${CHIP_LABEL}(x)==='走查·侧栏对账'); if(!c) return 0; c.click(); return 1; })()`);
  await wait(1800);
  const after = await ev("(() => Number((([...document.querySelectorAll('.nav-item')].find(x=>x.textContent.startsWith('全部'))||{}).textContent||'').replace(/[^0-9]/g,'')))()");
  const shown = await ev("(() => document.querySelectorAll('.book').length)()");
  step('点一个分类之后，侧栏「全部」跟着变，而且和书架对得上',
    !!clicked && after === shown && after < before,
    `筛之前 ${before} / 筛之后侧栏 ${after} / 书架 ${shown}`);
  for (const c of ((await rpc('shelf.list', {})).r ?? [])) {
    if (c.name === '走查·侧栏对账') await rpc('shelf.remove', { id: c.id });
  }
  await reload();
}

// ── ⑩ 读不下去的时候也记得下来 ─────────────────────────
//
// 阅读器里那张评分+短评的卡片原来只有一个触发点：读完最后一章。
// 而**最值得记的那句话说的正是「读不下去」**——按定义永远走不到读完，
// 想写的人得退回书架、找到那本书、悬停、点「评价」，
// 而他此刻正想关掉应用。
//
// 判据挑的是「一本已经评过的书」：`askReview` 见到它会**直接不问**
// （「已经评过的不再打扰」是对的），所以这一步只要能打开、
// 而且填的是库里现在的值，就证明走的是手动那条路而不是读完那条。
{
  /*
   * **自己把「已经评过」这个前提摆出来。**
   *
   * 原来是在库里**找**一本已经评过的多章书——而那要靠前面某个步骤碰巧评过它。
   * 在一个全新的测试库上跑，这一步直接报「库里没有……这一步没测成」，
   * 而那句话读起来像走查坏了。同本文件那条：
   * **走查步骤要自己把前提摆出来，不能靠上一步停在哪儿。**
   */
  const 挑中 = ((await rpc('book.list', { page: { limit: 200 } })).r || [])
    .find((b) => b.path && b.chapter_count > 1);
  if (挑中) await rpc('reading.setStatus', { bookId: 挑中.id, rating: 4, comment: '走查先评过的一句' });
  await reload();
  await until("document.querySelectorAll('.book').length > 0");
  const target = ((await rpc('book.list', { page: { limit: 200 } })).r || [])
    .find((b) => b.path && b.chapter_count > 1 && (b.rating != null || b.comment));
  if (!target) {
    step('读不下去时也能记一句', false, '库里一本「有文件、多章」的书都没有，这一步没测成');
  } else {
    const 原评分 = target.rating ?? null;
    const 原短评 = target.comment ?? null;
    // 同上：按 id 认卡片
    await ev(`(() => { const a=document.querySelector('.book[data-book-id="${target.id}"]'); if(!a) return 0; a.querySelector('.book-art').click(); return 1; })()`);
    await until("!!document.querySelector('.reader-text')");
    const btn = "[...document.querySelectorAll('.reader-tools button')].find(b => b.textContent.trim() === '评价')";
    const 有按钮 = await ev(`!!(${btn})`);
    if (有按钮) await ev(`(${btn}).click()`);
    await wait(1000);
    const c = JSON.parse(await ev(`(() => {
      // ⚠️ 评价卡那个框是 textarea。这四处原来写死了 input，
      // 于是这三步从落地那天起就是红的——而没人跑过它。
      // 现在不写死标签名：换回 input 也照样能用。
      const inp = document.querySelector('.reader-main .card :is(textarea,input)');
      const stars = [...document.querySelectorAll('.reader-main .card .rate-stars button')];
      return JSON.stringify({
        开了: !!inp,
        读完了: [...document.querySelectorAll('.reader-main .card strong')].some(s => s.textContent.includes('读完了')),
        短评: inp ? inp.value : null,
        星: stars.filter(b => b.className.includes('on')).length,
      });
    })()`));
    step('阅读器里随时够得到「评价」，而且填的是这本书现在的评价',
      有按钮 === true && c.开了 === true && !c.读完了
        && c.短评 === (原短评 ?? '') && c.星 === Math.floor(原评分 ?? 0),
      `${JSON.stringify(c)} / 库里是 ${原评分} ${JSON.stringify(原短评)}`);

    const 话 = '第三卷开始注水，我弃了';
    await ev(setInput("document.querySelector('.reader-main .card :is(textarea,input)')", 话));
    await wait(300);
    await ev("(() => { const b=[...document.querySelectorAll('.reader-main .card button')].find(x=>x.textContent.trim()==='记下来'); if(b) b.click(); return 1; })()");
    await wait(1400);
    const 存完 = ((await rpc('book.list', { page: { limit: 200 } })).r || []).find((b) => b.id === target.id);
    // **两条一起才算数**：话记进去了，而且没顺手把评分改掉
    // （原来只发填了的那个字段，改成两个都发之后就得盯住这一条）
    step('没读完也记得进去，而且没碰星星就不动评分',
      存完?.comment === 话 && (存完?.rating ?? null) === 原评分,
      JSON.stringify({ comment: 存完?.comment, rating: 存完?.rating }));
    await rpc('reading.setStatus', { bookId: target.id, rating: 原评分, comment: 原短评 });
    await ev("(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>/书架/.test(x.textContent)); if(b) b.click(); return 1; })()");
    await wait(900);
  }
}

// ── ⑪ 删掉一个正在生效的标签 ─────────────────────────
//
// ⚠️ **这一步要自己回到「全部」那一档。** 上一步停在「读过没评价」上，
// 而这里的判据是「撤掉标签筛选之后满架的书都回来了」——留在待办那一档的话
// 满架本来就只有一两本，报出来是「9 → 0」，看着像筛选没撤掉。
// 同本文件那条「走查步骤要自己把前提摆出来，不能靠上一步停在哪儿」。
//
// 点亮「玄幻」再去标签管理里删掉它（改名撞上别的名字＝合并也一样），
// `pickedTags` 里那个 id 就悬空了。实测（改之前）：书架 **9 → 0**，
// 而那个开关**已经从筛选栏里消失**——屏幕上没有任何东西说明为什么空。
// 同第 44 轮那条：**界面必须显示正在生效的状态**，做不到就别让它继续生效。
{
  await reload();
  /*
   * **先把前提摆出来：回「全部」那一档，并且清掉还挂着的标签筛选。**
   *
   * 上一步停在「读过没评价」上；而更前面的步骤（批量打标签）万一中途失败，
   * 会留下一个**被点亮的标签**。两样都会让这一步的判据说假话：
   * 前者报「9 → 0」像筛选没撤掉，后者报「还挂着筛选」——而挂着的是别人的。
   *
   * 同本文件那条：**走查步骤要自己把前提摆出来，不能靠上一步停在哪儿。**
   */
  await ev("(() => { const b=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.startsWith('全部')); if(b) b.click(); return !!b; })()");
  await until("[...document.querySelectorAll('.nav-item')].some((x) => x.getAttribute('aria-current') === 'true' && x.textContent.startsWith('全部'))");
  await ev("(() => { const c=[...document.querySelectorAll('.dir-chips .chip')].find(x=>/不按标签筛/.test(x.textContent)); if(c) c.click(); return !!c; })()");
  await until("![...document.querySelectorAll('.dir-chips .chip')].some(x => /不按标签筛/.test(x.textContent))");
  await until("document.querySelectorAll('.book').length > 0");
  const 满架 = await ev("document.querySelectorAll('.book').length");
  // 打给全部书，`tag.list` 按 count desc 排，它一定落在前 24 个开关里
  const all = ((await rpc('book.list', { page: { limit: 200 } })).r || []).map((b) => b.id);
  await rpc('tag.add', { bookIds: all, names: ['临时·待删'] });
  await reload();
  await until("[...document.querySelectorAll('.dir-chips .chip')].some(x => x.textContent.startsWith('临时·待删'))");
  await ev("(() => { const c=[...document.querySelectorAll('.dir-chips .chip')].find(x=>x.textContent.startsWith('临时·待删')); c.click(); return 1; })()");
  await until("[...document.querySelectorAll('.dir-chips .chip')].some(x => /不按标签筛/.test(x.textContent))");

  await openTool('标签管理');
  const 删了 = await ev(`(() => {
    const row = [...document.querySelectorAll('.modal li, .modal tr, .modal .row')].find(r => r.textContent.includes('临时·待删'));
    if (!row) return 0;
    const b = [...row.querySelectorAll('button')].find(x => /删除/.test(x.textContent));
    if (!b) return 0;
    b.click(); return 1;
  })()`);
  await wait(600);
  await ev("(() => { const b=[...document.querySelectorAll('.modal button')].find(x=>/确认删除/.test(x.textContent)); if(b) b.click(); return 1; })()");
  await wait(1200);
  await ev("(() => { const b=[...document.querySelectorAll('.modal button')].find(x=>/关闭|完成/.test(x.textContent)); if(b) b.click(); return 1; })()");
  await wait(1800);

  const 之后 = await ev(`(() => JSON.stringify({
    书架: document.querySelectorAll('.book').length,
    还挂着筛选: [...document.querySelectorAll('.dir-chips .chip')].some(x => /不按标签筛/.test(x.textContent)),
  }))()`);
  const a = JSON.parse(之后);
  step('删掉一个正在生效的标签，筛选跟着撤掉（而不是留下一个看不见的条件）',
    !!删了 && a.书架 === 满架 && a.还挂着筛选 === false,
    `删成功=${!!删了} / 满架 ${满架} → 现在 ${a.书架} / 还挂着筛选=${a.还挂着筛选}`);
}

// ── ⑫ 「读过没评价」这个待办 ─────────────────────────
//
// 这是这个应用唯一的待办清单：那几本书的结论此刻只在用户脑子里。
// 三件事一起钉：**出现**（有一本读过没写的时候）、**筛得对**（列出来的那几本
// 确实一条评价都没有）、**做完就消失**（写完一句之后那一档自己收起来）。
// 最后那条最容易漏——一个做完了还挂在那儿的待办，比没有待办更烦。
{
  const books = ((await rpc('book.list', { page: { limit: 200 } })).r || []);
  const target = books.find((b) => b.rating == null && !b.comment);
  if (!target) {
    step('「读过没评价」这个待办', false, '库里找不到一本「没评价」的书，这一步没测成');
  } else {
    /*
     * **这一步要独占这个待办。** 它靠「写完最后一条 → 那一档空了」来验
     * 那句「读过的书都写过一句了」，而**更早的步骤会把别的书标成读过**
     * （标签、批量改状态那几步都会）。不清一遍的话待办里有两本，
     * 写完一条还剩一本，等不到「空」——报出来是那句话没说，
     * 看着像文案坏了。同本文件那条「每一步自己把前提摆出来」。
     */
    for (const b of books) {
      const 动过 = b.reading_status && !['none', 'want'].includes(b.reading_status);
      if (b.id !== target.id && 动过 && b.rating == null && !b.comment) {
        await rpc('reading.setStatus', { bookId: b.id, status: 'none' });
      }
    }
    await rpc('reading.setStatus', { bookId: target.id, status: 'finished' });
    await reload();
    // 这一档收在侧栏的「更多」里了，`切到` 会先展开再点
    await 切到('读过没评价');
    await until("document.querySelectorAll('.book').length > 0");
    const listed = JSON.parse(await ev(`(() => JSON.stringify({
      本数: document.querySelectorAll('.book').length,
      有评价的: [...document.querySelectorAll('.book')].filter(b => b.querySelector('.book-note') || b.querySelector('.book-rating')).length,
      有它: [...document.querySelectorAll('.book-title')].some(x => x.textContent.trim() === ${JSON.stringify(target.title)}),
    }))()`));
    step('「读过没评价」列出来的确实一条评价都没有',
      listed.有它 === true && listed.有评价的 === 0,
      JSON.stringify(listed));

    /*
     * **做完的那一刻，人还站在这一档里。** 写完最后一条之后不换档、不重载，
     * 只碰一下排序下拉触发刷新——屏幕上该说「读过的书都写过一句了」，
     * 而不是通用的「这一档还没有书」（他刚做完，不是「还没有」）。
     * 这一档平时按计数隐藏，所以那句话只有这一条走法能看到。
     */
    await rpc('reading.setStatus', { bookId: target.id, comment: '写完了，这本不错' });
    await ev(`(() => {
      const sel = document.querySelector('.main-head select') || document.querySelector('select');
      if (!sel) return 0;
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(sel, 'title'); sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 1;
    })()`);
    await until("document.querySelectorAll('.book').length === 0");
    const said = await ev("((document.querySelector('.empty') || {}).textContent || '').includes('读过的书都写过一句了')");
    step('清空的那一刻说的是「做完了」，不是「还没有书」', said === true,
      (await ev("((document.querySelector('.empty') || {}).textContent || '').slice(0, 40)")));

    await reload();
    await wait(2000);
    const gone = await ev("[...document.querySelectorAll('.nav-item')].every(x=>!x.textContent.startsWith('读过没评价'))");
    step('写完一句之后，那一档自己收起来', gone === true,
      '做完了还挂在那儿的待办，比没有待办更烦');
    await rpc('reading.setStatus', { bookId: target.id, status: 'none', comment: null });
  }
}

// ── ⑬ 在待办里打星：卡片和浮层都要留住 ──────────────────────
//
// 打星和写短评是**一个动作的两半**。站在「读过没评价」里给一本书打个星，
// 那本书立刻不再属于这一档——要是顺手把卡片抽走，就等于**连着把浮层一起卸掉**，
// 而用户十有八九正要接着写那句话（本仓库记过「浮层被重挂就丢值」那次事故）。
//
// 所以这一步钉的是三件事：**浮层还在**（能接着写）、**卡片还在**（纸没被抽走）、
// **侧栏的数已经跟着变了**（进度看得见）。中间那条最容易被后人「优化」掉。
{
  const books = ((await rpc('book.list', { page: { limit: 200 } })).r || []);
  const todo = books.filter((b) => b.rating == null && !b.comment).slice(0, 2);
  if (todo.length < 2) {
    step('在待办里打星，卡片和浮层都留住', false, '库里凑不出两本没评价的书，这一步没测成');
  } else {
    for (const b of todo) await rpc('reading.setStatus', { bookId: b.id, status: 'finished' });
    await reload();
    // 这一档收在侧栏的「更多」里，`切到` 会先展开再点。
    // ⚠️ 上一处（⑫）改了而这里漏了，报出来是「书架上 9 / 侧栏 0」——
    // 看着像待办算错了，其实是**根本没切过去**
    await 切到('读过没评价');
    await until("document.querySelectorAll('.book').length === 2");
    const 前 = await ev("(() => Number((([...document.querySelectorAll('.nav-item')].find(x=>x.textContent.startsWith('读过没评价'))||{}).textContent||'').replace(/[^0-9]/g,'')))()");
    // 重试要拿库里的值当准绳，所以先认准这一本是谁
    const 待办第一本标题 = await ev("(() => ((document.querySelector('.book .book-title')||{}).textContent||'').trim())()");
    // ⚠️ `search.meta` 回的是 `bookId` 不是 `id`——写错的话下面那个重试永远看不到评分，
    // 而星星是「再点一次清除」，于是它会一直点下去（实测点了 5 次，靠奇数次才碰巧留在亮）
    const 待办第一本 = (((await rpc('search.meta', { keyword: String(待办第一本标题) })).r ?? [])[0] ?? {}).bookId;

    await ev(`(() => {
      const card = document.querySelector('.book');
      const b = [...card.querySelectorAll('.book-tools button')].find(x => x.textContent.trim() === '评价');
      if (b) b.click();
      return 1;
    })()`);
    await until("!!document.querySelector('.rate-pop')");
    /*
     * ⚠️ **拿库里的值当准绳来重试，别盲目再点一次。**
     * 浮层挂载之后 `tag.list` 才回来，那一下重渲染会让中间点的那一次落空
     * （和这一轮修目录项是同一个形状）。但星星**再点一次是清除评分**，
     * 所以不能盲目重点——每次先问库里有没有分，没有才再点。
     */
    const 点上星 = await (async () => {
      // **最多两次。** 星星是开关，盲目重试会把刚点上的又关掉——
      // 两次之后还没有就让断言红，报出真相比蒙对一次有用
      for (let i = 0; i < 2; i++) {
        await ev("(() => { const s=[...document.querySelectorAll('.rate-pop .rate-stars button')]; if(s[3]) s[3].click(); return 1; })()");
        for (let j = 0; j < 6; j++) {
          await wait(400);
          const got = ((await rpc('book.detail', { bookId: 待办第一本 })).r ?? {}).rating;
          if (got != null) return true;
        }
      }
      return false;
    })();
    await wait(1800);
    /*
     * ⚠️ **库里到了 ≠ 界面刷了。** 上面那个重试拿库里的值当准绳（对的），
     * 但它一拿到就返回，而卡片上的 ★ 和侧栏那个数要等下一次 `book.counts` 回来。
     * 不等就量，报出来是「卡片上有星了=false」——看着像界面没兑现。
     * 同本文件那条「等的是 A，测的是 B，就得为 B 单独等一次」。
     */
    await until("!!document.querySelector('.book .book-rating')", 8000);
    const a = JSON.parse(await ev(`(() => JSON.stringify({
      浮层还在: !!document.querySelector('.rate-pop'),
      还能写短评: !!document.querySelector('.rate-pop .rate-comment, .rate-pop input, .rate-pop textarea'),
      书架上: document.querySelectorAll('.book').length,
      侧栏: Number(((([...document.querySelectorAll('.nav-item')].find(x=>x.textContent.startsWith('读过没评价'))||{}).textContent)||'0').replace(/[^0-9]/g,'')),
      卡片上有星了: !!document.querySelector('.book .book-rating'),
    }))()`));
    a.点上星 = 点上星;
    step('在待办里打星：浮层和卡片都留住，而侧栏的数跟着变',
      点上星 === true && a.浮层还在 === true && a.还能写短评 === true && a.书架上 === 2
        && a.卡片上有星了 === true && a.侧栏 === 前 - 1,
      `${JSON.stringify(a)} / 打星之前侧栏 ${前}`);

    await ev("(() => { document.body.click(); return 1; })()");
    for (const b of todo) {
      await rpc('reading.setStatus', { bookId: b.id, status: 'none', rating: null, comment: null });
    }
  }
}

// ── ⑭ 打了一半按 Esc，那句话不能没 ──────────────────────
//
// 短评本来只在 `onBlur` 里存。而关掉浮层有三条路，**其中一条不经过失焦**：
// 按 Esc（App 那张「关掉最上面一层」的表直接卸载组件，光标还在输入框里，
// React 不会补一个 blur）。也就是「打了一半按 Esc」= 那句话没了，
// 而短评重扫恢复不了。现在 `RatePopover` 卸载时兜一次。
//
// ⚠️ 这一步能验得了，靠的正是那次修改：**判据不再依赖焦点**
// （这个环境里输入框聚不上焦，本仓库为此报过三次不存在的 bug）。
{
  const target = ((await rpc('book.list', { page: { limit: 200 } })).r || [])
    .find((b) => b.rating == null && !b.comment);
  if (!target) {
    step('打了一半按 Esc，那句话要存住', false, '库里没有一本没评价的书，这一步没测成');
  } else {
    await reload();
    await until("document.querySelectorAll('.book').length > 0");
    /*
     * ⚠️ **按 id 找卡片，别按书名。** 同名的书是常态（同一本书的 txt 和 epub
     * 各一条记录，测试库里正好有一对），`textContent.includes(书名)` 拿到的是
     * **第一张**——于是话存进了另一本同名的书，而这里查的是自己挑的那本。
     * 症状是「那句话没存住」，看起来像组件卸载时没兜住，实际上代码是对的。
     */
    await ev(`(() => {
      const card = document.querySelector('.book[data-book-id="${target.id}"]');
      if (!card) return 0;
      const b = [...card.querySelectorAll('.book-tools button')].find(x => x.textContent.trim() === '评价');
      if (b) b.click();
      return 1;
    })()`);
    // ⚠️ 浮层没开出来也要说出来。不然框里根本没打上字，报出来的却是
    // 「库里是 null」——和「组件卸载时没兜住」逐字相同，而那是另一个 bug
    const 浮层开了 = await until("!!document.querySelector('.rate-pop')");
    const 话 = '按 Esc 之前写的一句';
    await ev(setInput("document.querySelector('.rate-pop .rate-comment')", 话));
    await wait(300);
    await key('Escape', 'Escape', 27);
    await wait(1600);
    const after = ((await rpc('book.list', { page: { limit: 200 } })).r || []).find((b) => b.id === target.id);
    step('打了一半按 Esc，那句话要存住',
      浮层开了 === true && (await ev("!document.querySelector('.rate-pop')")) === true && after?.comment === 话,
      `浮层开了=${浮层开了} / 库里是 ${JSON.stringify(after?.comment)}`);
    await rpc('reading.setStatus', { bookId: target.id, comment: null, rating: null });
  }
}

// ── ⑮ 「编辑一本书」里打了一半按 Esc ──────────────────────
//
// 和上一步同一个形状，只是换了个界面：这个弹窗里**两套保存语义并存**，
// 而且都对——书名作者跟着「保存」按钮走（看得见那个按钮），
// 评分/状态/短评是改了就生效。问题出在后者的实现：星级 onChange 立刻存，
// **而短评是 onBlur 才存**，按 Esc 关掉不经过失焦，那句话就没了。
{
  const target = ((await rpc('book.list', { page: { limit: 200 } })).r || [])
    .find((b) => b.rating == null && !b.comment);
  if (!target) {
    step('编辑弹窗里打了一半按 Esc，短评要存住', false, '库里没有一本没评价的书，这一步没测成');
  } else {
    await reload();
    await until("document.querySelectorAll('.book').length > 0");
    // 同上一步：按 id 找，别按书名（同名的书是常态）
    await ev(`(() => {
      const card = document.querySelector('.book[data-book-id="${target.id}"]');
      if (!card) return 0;
      const b = [...card.querySelectorAll('.book-tools button')].find(x => x.textContent.trim() === '编辑');
      if (b) b.click();
      return 1;
    })()`);
    const 弹窗开了 = await until("[...document.querySelectorAll('.modal input')].some(x => /一句话/.test(x.placeholder || ''))");
    const 话 = '编辑弹窗里按 Esc 之前写的';
    await ev(setInput(
      "[...document.querySelectorAll('.modal input')].find(x => /一句话/.test(x.placeholder || ''))",
      话,
    ));
    await wait(300);
    await key('Escape', 'Escape', 27);
    await wait(1600);
    const after = ((await rpc('book.list', { page: { limit: 200 } })).r || []).find((b) => b.id === target.id);
    step('编辑弹窗里打了一半按 Esc，短评要存住',
      弹窗开了 === true && (await ev("!document.querySelector('.modal')")) === true && after?.comment === 话,
      `弹窗开了=${弹窗开了} / 库里是 ${JSON.stringify(after?.comment)}`);
    await rpc('reading.setStatus', { bookId: target.id, comment: null });
  }
}

// ── ⑯ 按自己写的那句话找书 ─────────────────────────────
//
// 这个应用存下来的最有用的东西就是「烂尾了别看」这种话。全库搜索原来
// **显示**短评却不按它匹配——「我记得给哪本书写过『烂尾』」答不上来。
//
// ⚠️ 只加在全库搜索，**没有加进书架那个搜索框**：后者的筛选条件正是
// 「批量打标签」「批量改状态」的作用范围，往里塞一个新的匹配面等于悄悄加宽它们。
// 这一步顺带把那条也钉住。
{
  const target = ((await rpc('book.list', { page: { limit: 200 } })).r || [])
    .find((b) => !b.comment);
  if (!target) {
    step('按自己写的那句话找得到书', false, '库里每本都有短评了，这一步没测成');
  } else {
    const 话 = '走查写的一句：后面彻底崩了';
    await rpc('reading.setStatus', { bookId: target.id, comment: 话 });
    await reload();
    await until("document.querySelectorAll('.book').length > 0");
    await openTool('全库搜索');
    await until("!!document.querySelector('.modal input')");
    await ev(setInput("document.querySelector('.modal input')", '崩了'));
    await until("document.querySelectorAll('.modal table tbody tr').length > 0");
    const hit = await ev(`(() => [...document.querySelectorAll('.modal table tbody tr td:first-child button')].map(b=>b.textContent.trim()).includes(${JSON.stringify(target.title)}))()`);
    step('全库搜索按短评找得到那本书', hit === true, `搜「崩了」没找到《${target.title}》`);

    // 书架那个框不许跟着变宽——批量操作靠的是它
    const 书架 = ((await rpc('book.matchCount', { filter: { keyword: '崩了' } })).r || {}).n;
    step('书架搜索框不按短评匹配（批量操作的作用范围不许被悄悄加宽）',
      书架 === 0, `book.matchCount 说 ${书架} 本`);
    await rpc('reading.setStatus', { bookId: target.id, comment: null });
  }
}

// ── ⑰ 阅读器里那张卡片：Esc 是「关掉」，不是「不要了」 ──────────
//
// 评价浮层和「编辑一本书」都已经改成「关掉时把没存的存了」，这里是最后一处不一致。
// 旁边那个「不用了」才是明确放弃——它写着自己要干什么；而 Esc 在这个应用里
// 到处都是「关掉最上面一层」，用户按它多半只是想把卡片收起来接着读。
//
// 两条一起钉：**Esc 要存住**、**「不用了」要真的丢掉**。
// 少了后一条，把 Esc 改成「什么都存」也能骗过这一步。
{
  const target = ((await rpc('book.list', { page: { limit: 200 } })).r || [])
    .find((b) => b.path && b.chapter_count > 1);
  if (!target) {
    step('阅读器里 Esc 关掉卡片不丢那句话', false, '库里没有能读的多章书，这一步没测成');
  } else {
    const 开卡片 = async () => {
      await ev(`(() => {
        const card = document.querySelector('.book[data-book-id="${target.id}"]');
        if (!card) return 0;
        card.querySelector('.book-art').click(); return 1;
      })()`);
      await until("!!document.querySelector('.reader-text')");
      await ev("(() => { const b=[...document.querySelectorAll('.reader-tools button')].find(x=>x.textContent.trim()==='评价'); if(b) b.click(); return 1; })()");
      await until("!!document.querySelector('.reader-main .card .rate-stars')");
    };
    const 回书架 = async () => {
      await ev("(() => { const b=[...document.querySelectorAll('.reader-rail button')].find(x=>/书架/.test(x.textContent)); if(b) b.click(); return 1; })()");
      await wait(900);
    };
    const 库里 = async () => ((await rpc('book.list', { page: { limit: 200 } })).r || [])
      .find((b) => b.id === target.id)?.comment ?? null;

    await rpc('reading.setStatus', { bookId: target.id, comment: null });
    await reload();
    await until("document.querySelectorAll('.book').length > 0");
    await 开卡片();
    await ev(setInput("document.querySelector('.reader-main .card :is(textarea,input)')", '按 Esc 之前写的'));
    await wait(300);
    await key('Escape', 'Escape', 27);
    await wait(1400);
    step('阅读器里 Esc 关掉卡片，那句话要存住', (await 库里()) === '按 Esc 之前写的', `库里是 ${JSON.stringify(await 库里())}`);
    await 回书架();

    await rpc('reading.setStatus', { bookId: target.id, comment: null });
    await reload();
    await until("document.querySelectorAll('.book').length > 0");
    await 开卡片();
    await ev(setInput("document.querySelector('.reader-main .card :is(textarea,input)')", '这句该被丢掉'));
    await wait(300);
    await ev("(() => { const b=[...document.querySelectorAll('.reader-main .card button')].find(x=>x.textContent.trim()==='不用了'); if(b) b.click(); return !!b; })()");
    await wait(1400);
    step('而「不用了」要真的丢掉', (await 库里()) === null, `库里是 ${JSON.stringify(await 库里())}`);
    await 回书架();
    await rpc('reading.setStatus', { bookId: target.id, comment: null });
  }
}

// ── ⑱ 笔记写到一半关掉面板 ────────────────────────────────
//
// 这是「关掉时把没存的存了」的第四处（前三处：评价浮层、编辑弹窗、阅读器那张卡片）。
// 笔记框是「显式保存」那一套：有「存」按钮、回车也存、**Esc 明确放弃**
// （和标签管理的行内改名同一套手势）。缺的是第三条路——关掉整个面板。
//
// 两条一起钉：**关掉要存住**、**Esc 要真的放弃**。
// 少了后一条，把兜底写成「什么都存」也能骗过这一步。
{
  const b = ((await rpc('book.list', { page: { limit: 200 } })).r || [])
    .find((x) => x.path && x.chapter_count > 1);
  if (!b) {
    step('笔记写到一半关掉面板，那句话要存住', false, '库里没有能读的多章书，这一步没测成');
  } else {
    const ch = (await rpc('chapter.read', { bookId: b.id, idx: 1 })).r;
    const body = String(ch?.text ?? '').slice(String(ch?.title ?? '').length);
    const noteOf = async () => ((await rpc('highlight.list', { bookId: b.id })).r || [])[0]?.note ?? null;
    const 开面板 = async () => {
      await reload();
      await until("document.querySelectorAll('.book').length > 0");
      await ev(`(() => { const c=document.querySelector('.book[data-book-id="${b.id}"]'); if(c) c.querySelector('.book-art').click(); return 1; })()`);
      await until("!!document.querySelector('.reader-text')");
      await ev("(() => { const x=[...document.querySelectorAll('.reader-tools button')].find(t=>t.textContent.includes('书签划线')); if(x) x.click(); return 1; })()");
      await until("!!document.querySelector('.modal')");
      await ev("(() => { const x=[...document.querySelectorAll('.modal button')].find(t=>/写笔记|改笔记/.test(t.textContent)); if(x) x.click(); return !!x; })()");
      await until("!!document.querySelector('.modal input')");
    };
    const 回书架 = async () => {
      await ev("(() => { const x=[...document.querySelectorAll('.reader-rail button')].find(t=>/书架/.test(t.textContent)); if(x) x.click(); return 1; })()");
      await wait(900);
    };

    for (const h of ((await rpc('highlight.list', { bookId: b.id })).r || [])) {
      await rpc('highlight.remove', { id: h.id, confirmed: true });
    }
    await rpc('highlight.add', {
      bookId: b.id, chapterIdx: 1, charOffset: 10, length: 6, excerpt: body.slice(10, 16),
    });

    await 开面板();
    await ev(setInput("document.querySelector('.modal input')", '关掉之前写的笔记'));
    await wait(300);
    await ev("(() => { const x=[...document.querySelectorAll('.modal button')].find(t=>t.textContent.trim()==='关闭'); if(x) x.click(); return !!x; })()");
    await wait(1400);
    step('笔记写到一半关掉面板，那句话要存住', (await noteOf()) === '关掉之前写的笔记',
      `库里是 ${JSON.stringify(await noteOf())}`);
    await 回书架();

    await rpc('highlight.setNote', { id: ((await rpc('highlight.list', { bookId: b.id })).r || [])[0].id, note: null });
    await 开面板();
    await ev(setInput("document.querySelector('.modal input')", '这句该被放弃'));
    await wait(300);
    await key('Escape', 'Escape', 27);
    await wait(600);
    const 收了 = await ev("!document.querySelector('.modal input')");
    await ev("(() => { const x=[...document.querySelectorAll('.modal button')].find(t=>t.textContent.trim()==='关闭'); if(x) x.click(); return 1; })()");
    await wait(1400);
    step('而 Esc 是「取消这次编辑」，写的那句要真的放弃',
      收了 === true && (await noteOf()) === null, `输入框收了=${收了} / 库里是 ${JSON.stringify(await noteOf())}`);
    await 回书架();

    for (const h of ((await rpc('highlight.list', { bookId: b.id })).r || [])) {
      // 走查自己造的，删是明知故犯——所以带 confirmed（万一以后造的那条带了笔记）
      await rpc('highlight.remove', { id: h.id, confirmed: true });
    }
  }
}

// ── ⑲ 带笔记的书签，按「撤书签」撤不掉，而且屏幕上说了去哪儿删 ──────────────
//
// 阅读器右轨那个「撤书签」是「这一章有书签就撤掉」——**一个按钮/一个快捷键
// 无声删掉一段笔记**，屏幕上连它写的什么都不显示。而笔记是铁律 3 的数据。
// 闸在 `status.ts` 的 `removeBookmark` 里（单元测试钉着），
// **而「界面上兑现了没有」是另一件事**——这个仓库最常见的缺陷正是
// 「代码里想到了、界面上没兑现」。所以这一步只看屏幕。
{
  const b = ((await rpc('book.list', { limit: 20 })).r ?? [])
    .find((x) => (x.chapter_count ?? 0) > 3 && x.file_status === 'ok');
  if (!b) {
    step('带笔记的书签撤不掉', false, '库里没有能读的多章 txt，这一步没测成');
  } else {
    for (const m of ((await rpc('bookmark.list', { bookId: b.id })).r ?? [])) {
      await rpc('bookmark.remove', { id: m.id, confirmed: true });
    }
    await rpc('bookmark.add', { bookId: b.id, chapterIdx: 1, excerpt: '少年提剑出门', note: '这里开始注水' });

    await reload();
    await ev(`(() => { const c=document.querySelector('.book[data-book-id="${b.id}"]'); if(c) c.querySelector('.book-art').click(); return !!c; })()`);
    await until("!!document.querySelector('.reader-text h2')");
    await until("document.querySelectorAll('.toc-item').length > 1");

    /*
     * ⚠️ **先确认真的翻到那一章了，再等按钮。**「点了目录」和「翻过去了」是两件事，
     * 而那个键只有在**当前这一章有书签**时才叫「撤书签」——还停在原来那一章的话，
     * 它一直叫「加书签」，12 秒等完报 `点上了=false`，看着像按钮不见了。
     * 实测偶发过一次。同第 ⑦ 步那条（第 106 轮补的），一模一样的形状。
     */
    const 到第二章2 = await 翻到目录项(1);
    /*
     * ⚠️ **那个键在 `.reader-tools`，不在 `.reader-rail`。** 右轨是
     * ["书架","目录","上一章","下一章","设置","顶部","底部"]，工具条才是
     * ["撤书签","搜索","评价","书签划线","自动滚","朗读","夜间"]。
     * 写错的后果特别阴：`until` 超时是**返回 false 不是抛**，于是这一步
     * 一路走到断言，报出来的失败原因和真正的原因毫无关系。
     *
     * ⚠️ 按**完整文字**匹配：这一排里「书签划线」也含「书签」两个字，
     * 拿「包含」去找会点开面板（本文件记过一次「探针误点了有副作用的按钮」）。
     */
    await until("[...document.querySelectorAll('.reader-tools button')].some(x => x.textContent.trim() === '撤书签')", 12000);
    const 点上了 = await ev("(() => { const x=[...document.querySelectorAll('.reader-tools button')].find(t=>t.textContent.trim()==='撤书签'); if(x) x.click(); return !!x; })()");
    await wait(1200);

    const 还在 = ((await rpc('bookmark.list', { bookId: b.id })).r ?? []).length;
    const 说了 = await ev("(() => (document.body.textContent || '').includes('写着笔记') && (document.body.textContent || '').includes('书签划线'))()");
    /*
     * **「还在 1 条」单独拿出来是句废话**——没点上的时候它也成立。
     * 第一版就是这么写的，于是按钮根本没找到那次，报的是
     * 「库里还剩 1 条（该是 1）/ 说了=false」，看起来像提示语坏了。
     * 所以「点上了」必须进断言。
     */
    step('带笔记的书签撤不掉，而且屏幕上说了去哪儿删',
      到第二章2 === true && 点上了 === true && 还在 === 1 && 说了 === true,
      `到第二章=${到第二章2} / 点上了=${点上了} / 库里还剩 ${还在} 条（该是 1）/ 说了=${说了}`);

    // 顺带钉住那句话不是「读取失败：…」——那一格是给读正文失败用的，
    // 借它说别的事就是一句假话
    const 没冒充读取失败 = await ev("(() => !(document.body.textContent || '').includes('读取失败：这条书签'))()");
    step('那句话没冒充成「读取失败」', 没冒充读取失败 === true, `冒充了=${!没冒充读取失败}`);

    for (const m of ((await rpc('bookmark.list', { bookId: b.id })).r ?? [])) {
      await rpc('bookmark.remove', { id: m.id, confirmed: true });
    }
  }
}

// ── 「用评分」那个总开关 ────────────────────────────────
//
// ⚠️ **这个开关只管「书架上的展示」，不管「评价里的输入」**（用户定的口径）。
//
// 管：书架卡片的 ★ 角标、全库搜索结果里的 ★ 那一列——两处各自在调用点判
// `loadShowRating()`。
// **不管**：评价浮层、编辑一本书、添读过的书、阅读器那张评价卡里的五颗星——
// 那四处是「评价」本身，**评分和短评是一件事的两半**，藏掉一半剩下的就不成立了。
//
// 这条判据改过一次：原来 gate 写在 `StarRating` 组件里，于是四个输入界面的星星
// 也一起消失。实测后果是用户点开「评价」只看到一个输入框，
// 第一反应是「这个应用只能写文字」——而不是「我关过一个开关」。
//
// ⚠️ **两个反面都不能少**：关掉之后**短评照样要能写**（否则「把整个浮层藏掉」
// 也能骗过去，那是关功能不是藏评分），而且**浮层里的五颗星照样要在**
// （否则就退回改之前那个样子了）。
{
  const 设 = async (on) => {
    await ev("(() => { localStorage.setItem('novel.show-rating', " + JSON.stringify(on ? '1' : '0') + "); return 1; })()");
    await reload();
    await until("document.querySelectorAll('.book').length > 0");
  };
  const 量 = async () => {
    const 角标 = await ev("document.querySelectorAll('.book-rating').length");
    await ev("(() => { const c=[...document.querySelectorAll('.book')].find(x=>x.querySelector('.book-open')); if(!c) return 0; const b=[...c.querySelectorAll('button')].find(x=>(x.title||'').includes('打分')); if(b) b.click(); return 1; })()");
    await until("!!document.querySelector('.rate-pop')", 5000);
    const 星 = await ev("document.querySelectorAll('.rate-pop .rate-stars button').length");
    const 能写短评 = await ev("!!document.querySelector('.rate-pop input')");
    await ev("(() => { document.body.click(); return 1; })()");
    return { 角标, 星, 能写短评 };
  };

  await 设(true);
  const 开 = await 量();
  await 设(false);
  const 关 = await 量();
  await 设(true);
  const 再开 = await 量();

  step('「用评分」只藏书架上的 ★，评价里的五颗星和短评照旧',
    开.角标 > 0 && 开.星 === 5
      && 关.角标 === 0 && 关.星 === 5 && 关.能写短评 === true
      && 再开.角标 === 开.角标 && 再开.星 === 5,
    '开着 卡片★' + 开.角标 + '/浮层星' + 开.星
      + '　关掉 卡片★' + 关.角标 + '（该 0）/浮层星' + 关.星 + '（该 5）/还能写短评=' + 关.能写短评
      + '　再开 卡片★' + 再开.角标 + '/浮层星' + 再开.星);
}

// ── 无限下滑：滚到章尾自动接上下一章，进度记在读到的那一章上 ──────
//
// 这一步钉的**不是「有没有接上来」，是「接上来之后进度记在哪一章」**——
// 后者才是铁律 3 的数据。第一版把 `appendNext` 写进了滚动监听的依赖，
// 于是每接一章就重建一次监听、把那 700ms 还没落地的进度 `clearTimeout` 掉：
// 症状是一路滚下去底栏一直写「第 1 章」，而章节确实在往下接——
// **只钉「接上来了」的话，那个 bug 完整地活着通过。**
{
  /*
   * **挑章数最多的那本，不是第一本够格的。**
   *
   * 第一版是 `.find(b => b.chapter_count >= 6)`，在测试库上挑中了一本 25 章的小书——
   * 接上来 9 章加起来还不到一屏，**根本滚不动**，于是顶上露出来的永远是第 1 章，
   * 报出来是「底栏第 1 章 / chapterIdx=0」，**和那个真 bug 的症状一模一样**
   * （而那个 bug 已经修好了）。下面那条「真的滚起来了」就是为这种情况准备的：
   * 再遇到内容不够，报的是真正的原因。
   */
  const target = ((await rpc('book.list', { page: { limit: 200 } })).r || [])
    .filter((b) => b.path && b.chapter_count >= 6)
    .sort((a, b) => b.chapter_count - a.chapter_count)[0];
  if (!target) {
    step('无限下滑：一章接一章滚下去，而进度记在读到的那一章上', false, '库里没有六章以上的书，这一步没测成');
  } else {
    /*
     * ⚠️ **设完 scrollTop 要自己派发一个 scroll 事件。**
     * 走查窗口不在前台，Chromium 把产帧整条停了：`scrollTop` 改得动，
     * 而 scroll 事件和 IntersectionObserver **一次都不派发**
     * （各挂一个对照监听量过，1.5 秒里都是 0 次）。不补这一下，
     * 量到的是「功能坏了」，而坏的是环境。
     */
    const 滚 = (topExpr) => `(() => { const b=document.querySelector('.reader-body'); if(!b) return -1; b.scrollTop = ${topExpr}; b.dispatchEvent(new Event('scroll')); return b.scrollTop; })()`;
    const 章数 = () => ev("document.querySelectorAll('article[data-chapter]').length");
    const 存模式 = (m) => ev(`(() => { const k='novel.read-settings'; const s=JSON.parse(localStorage.getItem(k)||'{}'); s.mode='${m}'; localStorage.setItem(k, JSON.stringify(s)); return 1; })()`);

    await 存模式('flow');
    await rpc('reading.save', { bookId: target.id, chapterIdx: 0, charOffset: 0 });
    await reload();
    await until("!!document.querySelector('.book-open')");
    await ev(`(() => {
      const card = document.querySelector('.book[data-book-id="${target.id}"]');
      if (!card) return 0;
      card.querySelector('.book-art').click(); return 1;
    })()`);
    const 开了 = await until("!!document.querySelector('.reader-body.flow-mode article[data-chapter]')");
    // **等「回到上次读到的地方」跑完再开始滚。** 那个 effect 会 `scrollTo`，
    // 抢在它前面滚等于白滚——而它把容器拉回顶部之后，报出来是「章号认不出来」
    await wait(900);

    for (let i = 0; i < 8; i++) {
      const n = await 章数();
      await ev(滚('b.scrollHeight'));
      if (!(await until(`document.querySelectorAll('article[data-chapter]').length > ${n}`, 4000))) break;
    }
    const w = await ev("[...document.querySelectorAll('article[data-chapter]')].map(a=>Number(a.dataset.chapter))");
    /*
     * 进度是 700ms 节流写的，别读太早：读早了报出来是「章号认不出来」，而真相只是还没写。
     *
     * ⚠️ **等法是轮询，不是 `await wait(1500)`**（同本文件那条「别按秒数猜」）。
     * 固定等待在这一步实测会偶发变红：连跑两遍，第一遍
     * 「窗口 12 章（连着号）／底栏第 1 章／chapterIdx=0」，第二遍
     * 「底栏第 11 章／chapterIdx=10」——**同样的条件，两个结果**。
     * 原因是最后一章接上来的时机是浮动的：滚动循环结束之后还可能再接一章，
     * 那一下会把那 700ms 还没落地的写入重排，1500ms 就不够了。
     * （窗口不可见时 rAF 不跑、IntersectionObserver 一次都不派发，
     * 那时候接章完全由这里手工派发的 scroll 驱动、时机是定死的；
     * `cdp.mjs` 把窗口变成 visible 之后，观察器自己也会接章，时机就浮动了。）
     *
     * 轮询到「真的写进去了」为止，**上限还在**：真坏了照样超时、照样红。
     */
    for (let i = 0; i < 30; i++) {
      if ((((await rpc('reading.last', { bookId: target.id })).r)?.chapterIdx ?? 0) > 0) break;
      await wait(200);
    }
    const 滚了多远 = await ev("Math.round(document.querySelector('.reader-body').scrollTop)");
    const 底栏 = await ev("(document.querySelector('.reader-foot')||{}).textContent||''");
    const 章号 = Number(底栏.match(/第 (\d+) \//)?.[1] ?? 1);
    const 库 = (await rpc('reading.last', { bookId: target.id })).r;
    const 连着 = w.length > 0 && w.every((v, i) => v === w[0] + i);

    step('无限下滑：一章接一章滚下去，而进度记在读到的那一章上',
      开了 && 滚了多远 > 300 && w.length >= 4 && 连着 && 章号 > 1 && (库?.chapterIdx ?? 0) > 0,
      `《${target.title}》开了=${开了}　滚了 ${滚了多远}px${滚了多远 <= 300 ? '（内容太少，压根没滚起来——不是进度坏了）' : ''}　窗口 ${w.length} 章${连着 ? '（连着号）' : '（跳号了：' + JSON.stringify(w) + '）'}　底栏第 ${章号} 章　库里 chapterIdx=${库?.chapterIdx}`);

    /*
     * **卸章那一下不许把正文抽走。** 窗口接满之后会从视野上方卸掉几章并补偿
     * `scrollTop`；补偿写漏了的话，正文会当场往上蹿掉卸掉的那一段高度。
     * 判据是「顶上还是同一章、进去的深度还是那么多」——
     * 只钉「窗口没超上限」的话，把补偿整个删掉也照样绿。
     */
    const 位置 = () => ev(`(() => {
      const b = document.querySelector('.reader-body');
      const arts = [...b.querySelectorAll('article[data-chapter]')];
      const top = b.scrollTop + 4;
      const a = arts.findLast(x => x.offsetTop - b.offsetTop <= top) || arts[0];
      return JSON.stringify({ 章: Number(a.dataset.chapter), 深: Math.round(b.scrollTop - (a.offsetTop - b.offsetTop)), 窗: arts.map(x=>Number(x.dataset.chapter)) });
    })()`);

    // 一直滚到窗口接满（12 章），卸章才会发生
    for (let i = 0; i < 30; i++) {
      const w0 = await 章数();
      await ev(滚('b.scrollHeight'));
      await until(`document.querySelectorAll('article[data-chapter]').length !== ${w0}`, 3000);
      if (await ev("document.querySelectorAll('article[data-chapter]').length >= 12")) break;
    }
    const 卸前 = JSON.parse(await 位置());
    /*
     * **触发卸章的那一下不能再动 scrollTop。** 第一版在两次测量之间
     * 又滚了一屏，于是“章号变了”——那是我自己滚过去的，不是被卸跑的。
     * 已经在底下了，光派一个 scroll 事件就够触发接下一章。
     */
    await ev("(() => { const b=document.querySelector('.reader-body'); b.dispatchEvent(new Event('scroll')); return b.scrollTop; })()");
    await until(`JSON.stringify([...document.querySelectorAll('article[data-chapter]')].map(a=>Number(a.dataset.chapter))) !== ${JSON.stringify(JSON.stringify(卸前.窗))}`, 4000);
    await wait(400);
    const 卸后 = JSON.parse(await 位置());
    const 连着2 = 卸后.窗.every((v, i) => v === 卸后.窗[0] + i);

    step('无限下滑：窗口是滑动的，卸掉上面几章不会把正文抽走',
      卸后.窗.length <= 12 && 卸后.窗[0] > 0 && 连着2
        && 卸后.章 === 卸前.章 && Math.abs(卸后.深 - 卸前.深) < 8,
      `卸前 第${卸前.章}章/深${卸前.深}/窗${卸前.窗.length}(起${卸前.窗[0]})　`
        + `卸后 第${卸后.章}章/深${卸后.深}/窗${卸后.窗.length}(起${卸后.窗[0]})`);

    // 收尾：模式和进度都放回去，免得给后面的步骤和下一跑留残局
    await 存模式('scroll');
    await rpc('reading.save', { bookId: target.id, chapterIdx: 0, charOffset: 0 });
    await reload();
  }
}

close();
console.log(fail.length ? `\n✗ 断在：${fail.join('、')}` : '\n✔ 全程走通');
process.exit(fail.length ? 1 : 0);
