import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * **库里的时间文本不许直接印到界面上。**
 *
 * sqlite 的 `datetime('now')` 存的是 **UTC**（`2026-08-23 13:12:38`）。
 * 原样显示就是把 UTC 当本地时间摆给用户看——东八区差 8 小时，
 * 而且**不报错、不留痕**：书签面板上一条刚加的书签写着八小时前的时刻，
 * 看起来像时钟坏了。真出过两处（`HighlightsPanel` 的 `{m.created_at}`、
 * `LinksDialog` 的 `l.last_checked_at.slice(5, 16)`）。
 *
 * 正确的路是 `core/format.ts` 的 `whenAgo`（内部走 `sqlTime` 补上那个 `Z`）。
 *
 * 判据硬、结果二值（当下是 0 处），所以放 `npm test` 里而不是 `scripts/` 下——
 * 后者要人记得敲。
 */
const DIR = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/*
 * 两种写法都管：库里的列名是 `created_at`，而 rpc 那头常常已经转成驼峰
 * （`chapter.read` 那类查询里到处是 `as chapterIdx`），所以 `createdAt` 也算。
 */
/** 「把一个时间字段整个塞进花括号」——JSX 子节点和属性值都是这个形状 */
const RAW = /\{\s*[A-Za-z_$][\w$]*\.[\w$]*(_at|At)\s*\}/g;
/** 「拿它当字符串切」——`slice` / `substring` / `split` 都是在当文本用 */
const SLICED = /\.[\w$]*(_at|At)\.(slice|substring|substr|split|replace)\s*\(/g;

function scan() {
  const bad: string[] = [];
  let 看了 = 0;
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.tsx')) continue;
    看了++;
    const src = readFileSync(join(DIR, f), 'utf8');
    for (const re of [RAW, SLICED]) {
      for (const m of src.matchAll(re)) {
        const line = src.slice(0, m.index).split('\n').length;
        bad.push(`${f}:${line} ${m[0]}`);
      }
    }
  }
  return { bad, 看了 };
}

test('库里的时间文本不许直接印到界面上（那是 UTC，差 8 小时）', () => {
  const { bad, 看了 } = scan();
  // 自检：一个文件都没读到的话，「0 处」是假的太平
  assert.ok(看了 >= 10, `只扫到 ${看了} 个 .tsx，这条判据多半没跑起来`);
  assert.deepEqual(bad, [], `这些地方把库里的 UTC 文本直接摆给用户了，改走 core/format.ts 的 whenAgo：\n${bad.join('\n')}`);
});

test('判据自检：喂两种坏写法都得被抓到', () => {
  const 诱饵 = [
    '<div>{m.created_at}</div>',
    '<span>{l.last_checked_at.slice(5, 16)}</span>',
    '<div>{n.createdAt}</div>',
    '<span>{r.ratedAt.slice(0, 10)}</span>',
  ];
  for (const s of 诱饵) {
    const hit = RAW.test(s) || SLICED.test(s);
    RAW.lastIndex = 0; SLICED.lastIndex = 0;
    assert.ok(hit, `这条判据认不出坏写法了：${s}`);
  }
  // 反向：走了 whenAgo 的不许被报
  const 好写法 = '<span title={whenAgo(m.created_at)?.title}>{whenAgo(m.created_at)?.text}</span>';
  const 误报 = RAW.test(好写法) || SLICED.test(好写法);
  RAW.lastIndex = 0; SLICED.lastIndex = 0;
  assert.equal(误报, false, '把正确写法也报了');
});
