/**
 * **源码里不许出现裸控制字符。**
 *
 * 这条是踩出来的：`suggest.ts` 的 `NUM_MARK` 和 `versions.ts` 的 `bookKey` 都拿 NUL
 * 当分隔符（「选一个正文里绝不会出现的字符」，这个选择本身没问题），
 * 而它们**在源码里写的是一个真的 0x00 字节**，不是转义。
 *
 * 后果不是运行时的，是工具链的：`grep` / `rg` 见到 NUL 就把整个文件判成二进制，
 * 输出变成一句 `Binary file … matches`——**不给行号、不给内容**。
 * 于是那两个文件从所有文本搜索里消失了：全量审计时 `grep -rn NUM_MARK src/`
 * 一行都搜不到，看起来像这个常量根本没人用；`git diff` 也会把它当二进制。
 *
 * 改成 `\u0000` 这种转义就行，**值一模一样**。
 *
 * 判据硬、结果二值，所以放在 `npm test` 里而不是 `scripts/` 下的走查脚本里——
 * 后者要人记得敲（`LinksDialog` 能悬空那么久正是因为「有个脚本能查」不等于有人查）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const EXT = /\.(ts|tsx|mjs|cjs|js|css|html)$/;

/** 制表、换行、回车之外的 C0，加上 DEL */
const isTrap = (code: number): boolean =>
  (code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0x7f;

/** 判据本身。抽成函数**只为一件事**：自检能拿合成的坏例子喂它 */
function trapsIn(src: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) if (isTrap(src.charCodeAt(i))) out.push(i);
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(e)) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, 'src')).concat(walk(join(ROOT, 'scripts')));

test('自检：真的读到了源码，而且判据认得出合成的坏例子', () => {
  assert.ok(files.length >= 60, `只读到 ${files.length} 个文件，路径多半错了`);
  // 诱饵照着真实事故的样子写：一个当分隔符用的裸 NUL
  assert.equal(trapsIn(`const NUM_MARK = '${String.fromCharCode(0)}';`).length, 1, '裸 NUL 抓不出来');
  // 这里必须用 String.raw：普通模板字面量会把 \u0000 直接算成一个真的 NUL，
  // 于是「转义写法」这条诱饵测的其实是裸字符，永远红
  assert.equal(trapsIn(String.raw`const NUM_MARK = '\u0000';`).length, 0, '转义写法不该被报');
  assert.equal(trapsIn('制表\t换行\n回车\r都不算').length, 0, '正常空白不该被报');
});

test('源码里没有裸控制字符（有的话那个文件会从所有 grep 里消失）', () => {
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const i of trapsIn(src)) {
      const line = src.slice(0, i).split('\n').length;
      const code = src.charCodeAt(i).toString(16).padStart(4, '0');
      bad.push(`${f.slice(ROOT.length + 1)}:${line}  U+${code}`);
    }
  }
  assert.deepEqual(bad, [], `写成 u 转义（四位十六进制）就行，值一模一样：\n${bad.join('\n')}`);
});
