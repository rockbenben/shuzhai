/**
 * 端到端走一遍**「继续阅读」浮钮**：
 * 悬停才展开书名/章号/时间 → 进度弧等于真实百分比 → 点开落在保存的章节
 * → 换成 PDF 后不报假章号、不画弧、点开进查看器 → 通知给浮钮让位。
 *
 *   node scripts/ui-check/resume.mjs
 *
 * ── 为什么单开一条 ──────────────────────────────────
 *
 * 浮钮的判据全是 DOM/CSS：悬停展开、提示层不挡指针、通知抬到它上面、
 * 进度弧只认 txt 的真实 `percent`、PDF 不报「第 1 章」。`resume.ts` 的纯函数
 * 有单测，但**单元测试盖不到「提示有没有真的弹出来」**——那一段断了，
 * 界面上只是「鼠标放上去没反应」，一句错都不报。
 *
 * ⚠️ **会写 `reading_state`**（last_read_at / chapter_idx，还会把查看器那本
 * 改回「在读」）——和 `find.mjs` 同一类，只在测试档案上跑，由 `guardTestLibrary()` 把关。
 */
import { connect, guardTestLibrary, rpc } from './cdp.mjs';

await guardTestLibrary();
const { ev, wait, reload, send, close } = await connect();
// 同其它走查：先刷新，别接在别人留下的那一屏上跑
await reload();
await wait(1200);

const fail = [];
const step = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✗'} ${name}${detail ? '　' + detail : ''}`);
  if (!ok) fail.push(name);
};
/** 等一个条件成立。固定等待是走查里最常见的假失败来源 */
const until = async (expr, ms = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await ev(expr);
    // `ev` 失败回的是 `'ERR …'` 字符串，直接当真值会变成「等到了」——同 `make等待` 那条
    if (typeof v === 'string' && v.startsWith('ERR ')) {
      throw new Error(`等「${expr}」时探针报错：${v}`);
    }
    if (v) return true;
    await wait(300);
  }
  return false;
};
/** 把指针移到浮钮中心（真鼠标事件，`:hover` 才会成立） */
const hover = async () => {
  const b = JSON.parse(await ev(
    "(() => { const f=document.querySelector('.resume-fab');"
    + ' const r=f.getBoundingClientRect();'
    + ' return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2}); })()',
  ));
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: Math.round(b.x), y: Math.round(b.y),
  });
  await wait(350);
};
const tipState = () => ev(
  "(() => { const t=document.querySelector('.resume-fab-tip');"
  + ' return t ? getComputedStyle(t).visibility + "/" + getComputedStyle(t).opacity : null; })()',
);

const books = (await rpc('book.list', { filter: {}, limit: 50 })).r ?? [];
const text = books.find((b) => b.path && /\.(txt|md)$/i.test(b.path) && (b.chapter_count ?? 0) > 3);
const viewerBook = books.find((b) => /\.(pdf|epub)$/i.test(b.path ?? ''));
step('测试库里有一本可用的 txt（>3 章）', !!text);
step('测试库里有一本 PDF / EPUB', !!viewerBook);
if (!text || !viewerBook) {
  console.log('\n✗ 测试库缺夹具：先 node scripts/ui-check/make-testlib.mjs <目录> 再跑这一条');
  close();
  process.exit(1);
}

// 让这本 txt 成为最近在读；百分比由 core 按章数算，浮钮的弧必须和它一致
await rpc('reading.save', { bookId: text.id, chapterIdx: 1, charOffset: 0 });
const chapters = (await rpc('book.chapters', { bookId: text.id })).r ?? [];
await reload();
await wait(800);

step('侧栏不再有旧的那张「继续阅读」卡片',
  (await ev("document.querySelectorAll('.nav-resume').length")) === 0);
const fabThere = await ev("!!document.querySelector('.resume-fab')");
step('浮钮出现', fabThere);
if (!fabThere) {
  console.log('\n✗ 浮钮都没出现，后面的悬停/落点无从量起');
  close();
  process.exit(1);
}
step('提示默认收起', String(await tipState()).startsWith('hidden'));
const aria = String(await ev("document.querySelector('.resume-fab')?.getAttribute('aria-label') ?? ''"));
step('浮钮有可及名称（带书名）', aria.includes(text.title), aria);

await hover();
const shown = await until(
  "getComputedStyle(document.querySelector('.resume-fab-tip')).visibility === 'visible'", 5000,
);
step('悬停展开提示', shown);
const tipText = String(await ev(
  "document.querySelector('.resume-fab-tip')?.innerText?.replace(/\\s+/g, ' ') ?? ''",
));
step('提示带书名、章号、上次读多久前',
  tipText.includes(text.title) && /第\s*2\s*章/.test(tipText)
  && /(分钟|小时|天|月|年)前|此刻/.test(tipText),
  tipText);

const recent = (await rpc('reading.recent', { limit: 10 })).r ?? [];
const me = recent.find((r) => r.bookId === text.id);
const pct = me?.percent;
const dash = await ev(
  "document.querySelector('.resume-fab-ring-bar')?.getAttribute('stroke-dasharray') ?? null",
);
step('进度弧等于真实百分比',
  dash != null && typeof pct === 'number' && Math.abs(parseFloat(dash) - pct) < 0.01,
  `弧 ${dash} / 库里 ${pct}`);

const rootFont = Number(await ev("parseFloat(getComputedStyle(document.documentElement).fontSize)"));
const toastBottom = Number(await ev("parseFloat(getComputedStyle(document.querySelector('.toasts')).bottom)"));
step('通知给浮钮让位（5rem）', Math.abs(toastBottom - rootFont * 5) <= 1,
  `${toastBottom}px / 5rem=${rootFont * 5}px`);

await ev("document.querySelector('.resume-fab').click()");
const 第一章选择器 = JSON.stringify('.reader-text[data-chapter="1"]');
const opened = await until(`!!document.querySelector(${第一章选择器})`, 15000);
const h2 = String(await ev(`document.querySelector(${JSON.stringify('.reader-text[data-chapter="1"] h2')})?.textContent ?? ''`));
step('点开落在保存的那一章', opened && h2 === (chapters[1]?.title ?? ''),
  `读到「${h2}」，应为「${chapters[1]?.title ?? ''}」`);
await ev("[...document.querySelectorAll('.reader-rail button')].find((b) => b.textContent.includes('书架'))?.click()");
await until("!!document.querySelector('.resume-fab')", 12000);

/*
 * PDF / EPUB：同一个浮钮，换一本只编目的。**它绝不能报「第 1 章」**——
 * `reading_state.chapter_idx` 对这两种格式恒为 0；也没有总页数画进度弧。
 *
 * ⚠️ `markOpened` 只提升 none/want/shelved 三档状态；一本已经读完/弃坑的
 * PDF 被打开后**仍是读完/弃坑**，`选续读` 不会选它。先把状态放回在读。
 */
await wait(1200);
if (viewerBook.reading_status !== 'reading') {
  await rpc('reading.setStatus', { bookId: viewerBook.id, status: 'reading' });
}
await rpc('reading.markOpened', { bookId: viewerBook.id });
await wait(1200);
await reload();
await wait(700);
await hover();
const viewerMeta = String(await ev(
  "document.querySelector('.resume-fab-meta')?.textContent ?? ''",
));
step('PDF / EPUB 不报假章号',
  /PDF|EPUB/.test(viewerMeta) && !/第\s*\d+\s*章/.test(viewerMeta), viewerMeta);
step('PDF / EPUB 不画进度弧',
  (await ev("document.querySelectorAll('.resume-fab-ring-bar').length")) === 0);

await ev("document.querySelector('.resume-fab').click()");
const viewerOpened = await until("!!document.querySelector('.viewer-body')", 25000);
step('PDF / EPUB 点开进查看器', viewerOpened);
if (viewerOpened) {
  await ev("[...document.querySelectorAll('.reader-rail button')].find((b) => b.textContent.includes('书架'))?.click()");
}

console.log(fail.length
  ? `\n✗ ${fail.length} 条没过：\n  - ${fail.join('\n  - ')}`
  : '\n✔ 继续阅读浮钮这一条线全过');
close();
process.exit(fail.length ? 1 : 0);
