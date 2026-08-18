/**
 * 找「算出来了、界面上没人读」的字段。
 *
 * 这个仓库最常见的一类缺陷，到这一轮已经抓到五个：`useTts` 的 `fellBack`
 * 和 `at`、`reading.save` 返回的 `finished`、`bookmark.list`/`remove`、
 * 建索引的 `onProgress`。形状完全一样——主进程算得好好的，渲染进程一次都没读。
 * **typecheck 不会报**（没人读一个字段不是类型错误），测试也不会报
 * （core 那半是对的）。只有拿两边比一遍才看得见。
 *
 *   node scripts/dead-fields.mjs
 *
 * 做法：把 `src/core` 里导出的 interface 字段名收齐，去 `src/renderer` 里找。
 * 一个字段名在渲染进程里一次都没出现 = 候选。**这是筛子不是判据**——
 * 有些接口纯粹是 core 内部用的，报出来是正常的，要人去看一眼。
 *
 * ⚠ 扫描器自己坏过：上一版按路径前缀过滤，而 `join()` 给的是反斜杠路径，
 * 键全对不上、三段全空——**一个静默找不到任何东西的扫描器比没有更糟**。
 * 所以开头有自检：读不到已知的字段就报错退出。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './repo-root.mjs';

const core = join(ROOT, 'src', 'core');
const renderer = join(ROOT, 'src', 'renderer');

const read = (dir, suffix) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(suffix) && !f.endsWith('.test.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

const coreFiles = read(core, '.ts');
const rendererText = [
  ...read(renderer, '.tsx'),
  ...read(renderer, '.ts'),
].map((f) => f.text).join('\n');

if (!coreFiles.length || rendererText.length < 1000) {
  console.error('✗ 自检没过：源码目录读不到东西，扫描器坏了');
  process.exit(1);
}

/** 从 `export interface X { ... }` 里抠出字段名 */
function fieldsOf(text) {
  const out = [];
  const re = /export interface (\w+)\s*\{([\s\S]*?)\n\}/g;
  for (const m of text.matchAll(re)) {
    const names = [...m[2].matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]);
    if (names.length) out.push({ iface: m[1], names });
  }
  return out;
}

/*
 * ⚠️ **自检要验两层，而下面那一层是新加的。**
 *
 * 原来只验「渲染进程里找得到这两个已知字段」——那验的是**读文件读对了没有**。
 * 而判据本身（从 interface 里抠字段名）坏掉时，这个脚本会一边报「一切正常」
 * 一边什么都没查。这个循环里刚踩过一次同形状的：一条新判据的正则在生成时
 * 被吃掉反斜杠，变成永远匹配不上的字面量，**代码带着坏模式它照样全绿**。
 *
 * 所以先拿一段合成的 interface 喂 `fieldsOf`，抠不出字段就报错退出。
 */
// **诱饵要长得像真代码**：`fieldsOf` 认的是 `\w+`（标识符），
// 第一版用了中文字段名，抠不出来——那不是判据坏了，是诱饵不像样
const DECOY_SRC = [
  'export interface DecoyShape {',
  '  alpha: number;',
  '  beta?: string | null;',
  '}',
].join(String.fromCharCode(10));
const decoy = fieldsOf(DECOY_SRC).find((x) => x.iface === 'DecoyShape');
if (!decoy || decoy.names.join(',') !== 'alpha,beta') {
  console.error('✗ 自检没过：合成的 interface 都抠不出字段，这个脚本的判据已经失效了');
  process.exit(1);
}

// 自检：这两个字段现在**确实**被渲染进程读着，扫不到它们就说明筛子漏了
for (const known of ['fellBack', 'exactDuplicate']) {
  if (!rendererText.includes(known)) {
    console.error(`✗ 自检没过：渲染进程里找不到 ${known}，扫描器读错文件了`);
    process.exit(1);
  }
}

const suspects = [];
for (const { file, text } of coreFiles) {
  for (const { iface, names } of fieldsOf(text)) {
    const dead = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(rendererText));
    if (dead.length) suspects.push({ file, iface, dead, total: names.length });
  }
}

console.log('自检通过：能读到源码、渲染进程里找得到已知字段、合成的 interface 也抠得出字段\n');
if (!suspects.length) {
  console.log('没有找到界面上一次都没读过的字段。');
} else {
  for (const s of suspects) {
    console.log(`${s.file}  ${s.iface}  (${s.dead.length}/${s.total} 个没被读过)`);
    console.log(`   ${s.dead.join(' · ')}`);
  }
  console.log(`\n共 ${suspects.length} 个接口有没被读过的字段。**这是筛子不是判据**——`);
  console.log('core 内部用的接口报出来是正常的，逐个看一眼，找的是「本该显示给人看」的那些。');
}
