/**
 * **markdown 的星号不许漏进界面。**
 *
 * `**这样**` 在文档注释里是加粗，搬进 JSX 就是四个星号显示给用户看。
 * 这个仓库的注释密度很高，从上面那段注释里顺手抄一句进 JSX 是最自然的动作，
 * 而抄完谁也不会再看一眼——实测一次抓到三处：
 * `BatchTagDialog`（作用于**整个筛选结果**）、`ExportDialog`（**原 txt 一个
 * 字节都不会动**）、`CoverSources`（提示气泡里的 **没有作者的候选…**）。
 *
 * 判据是硬的、结果是二值的，所以它在 `npm test` 里而不是在
 * `scripts/dead-mounts.mjs` 那种「筛子」脚本里——后者要人记得敲，
 * 而 `LinksDialog` 之所以能悬空一年多，正是因为「有个脚本能查」不等于有人查。
 *
 * ⚠ **自检**：先确认真的读到了文件、也真的挖掉了注释。一个静默什么都找不到的
 * 断言和没有断言是一回事（AGENTS.md 反复记着这条）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = import.meta.dirname;

/** 注释整块挖掉——注释里写 `**加粗**` 是本仓库的行文风格，那是要留的 */
const strip = (src: string): string =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/** glob 里的 `/**` 和 `**\/` 是语法不是强调（`LibraryDirs` 的屏蔽规则用到） */
const isGlob = (line: string): boolean => /\*\*\//.test(line) || /\/\*\*/.test(line);

/** 会被显示出来的位置：JSX 文本节点、字符串字面量 */
const SHOWN = /*  */ /(>[^<>]*\*\*)|(['"`][^'"`]*\*\*[^'"`]*['"`])/;

const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'));

test('自检：真的读到了渲染进程的源码，注释也真的挖掉了', () => {
  assert.ok(files.length >= 10, `只读到 ${files.length} 个文件，路径多半错了`);
  const sample = strip('/** 注释里的 **加粗** 要留着 */\nconst a = 1;');
  assert.ok(!sample.includes('**'), 'strip() 没挖掉块注释');
  assert.ok(strip('// 行注释里的 **加粗**\nconst b = 2;').includes('const b'), 'strip() 把代码也吃了');
});

/**
 * ⚠️ **JSX 文本经常跨行，判据不能只看一行。**
 *
 * 原来是逐行匹配：开标签在上一行、带星号的那句在下一行，
 * 于是 `>` 和星号不在同一行，**一条都报不出来**。
 * 当场撞到的：`TagManager` 那段合并确认，四个星号真的显示给用户看，而测试全绿。
 *
 * 现在整份源码一起看（字符类本来就跨行），报的时候再把行号找回来。
 */
function shownHits(src: string): string[] {
  const out: string[] = [];
  const re = /(>[^<>]*\*\*)|(['"`][^'"`\n]*\*\*[^'"`\n]*['"`])/g;
  for (const m of src.matchAll(re)) {
    const line = src.slice(0, m.index).split('\n').length;
    // ⚠️ 判「是不是 glob」要看**整段匹配**，不是那 90 个字的显示片段：
    // `LibraryDirs` 里屏蔽规则的例子（`**/…`）离开标签 200 多个字符，
    // 截断之后看不到那个 `**/`，于是被当成漏进界面的星号报了出来
    if (isGlob(m[0])) continue;
    const text = src.slice(m.index, m.index + 90).replace(/\s+/g, ' ');
    out.push(`${line}  ${text}`);
  }
  return out;
}

test('界面上不许出现字面的 markdown 星号', () => {
  const bad: string[] = [];
  for (const f of files) {
    for (const hit of shownHits(strip(readFileSync(join(DIR, f), 'utf8')))) bad.push(`${f}:${hit}`);
  }
  assert.deepEqual(bad, [], `这些星号会原样显示给用户，该加粗就用 <strong>：\n${bad.join('\n')}`);
});

/*
 * **自检第二层：判据还认得出跨行的那种吗。**
 * 只喂一行式的诱饵，跨行那半写坏了照样报「0 处」——而跨行正是它原来漏掉的形状。
 */
test('自检：一行式和跨行的都要抓得到，正常代码不许误报', () => {
  assert.equal(shownHits('<p>这是**加粗**的字</p>').length, 1, '一行式的抓不到');
  assert.equal(
    shownHits('<span className="muted">\n  这句**很重要**，跨了一行\n</span>').length, 1,
    '跨行的抓不到——那正是原来漏掉的形状',
  );
  assert.equal(shownHits('const a = b ** 2;\nconst c = d ** 3;').length, 0, '幂运算不该被报');
});

