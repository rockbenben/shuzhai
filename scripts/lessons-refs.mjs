/**
 * 钉住 `docs/lessons.md` 里那句「本文件」**不许指向 `AGENTS.md`**。
 *
 * 案例史是从 `AGENTS.md` 里拆出来的，拆的时候整段搬走、**没有逐句改**，
 * 于是老段落里那些「本文件那条『……』」有一半说的其实是 `AGENTS.md`。
 * 这一族的害处本档案自己第一节就写着（「指路指错了」）：**指针指错不报错**，
 * 下一个人 grep 不到，就以为那条规矩根本不存在。
 *
 * 剩下那些「本文件另一节」「本文件记着那次事故」只在**贴着本档案自己的上下文**
 * 时才讲得通，那些是对的，不报。所以这里不数出现次数，只认**能证伪的那一种**：
 * 引号里那句原文verbatim活在 `AGENTS.md` 里，而它前面写着「本文件」。
 *
 * 跑法：`node scripts/lessons-refs.mjs`（在 `lint:ui` 里）
 */
import { readFileSync } from 'node:fs';

/** 标点、空白、markdown 的强调符号都不算内容——比的是句子本身 */
const 净 = (s) => s.replace(/[\s*`_「」『』“”"'（）()【】\[\]…、，,。.:：;；·-]/g, '');

/** 至少这么长才当证据：两三个字的词到处都在，比出来全是噪音 */
const 最短 = 12;

const 约定 = 净(readFileSync('AGENTS.md', 'utf8'));

/** 一行之所以该报，是因为它「把一句 AGENTS.md 的原文挂在『本文件』后面」 */
function 该报(行) {
  /*
   * ⚠️ **先把引号里的内容抹掉，再看剩下的还有没有「本文件」。**
   * 不加这一道，**解释这件事的那几句自己会被报**：「而这份开头写着
   * 『本文件是协作约定的唯一权威来源』」——那行里的「本文件」是**被引用的对象**，
   * 不是指针，改口的话反而把要举的例子改没了。
   * 这个形状本档案记过（`cond-groups.mjs` 报了自己写的那条注释）：**尺子会扫到自己**。
   */
  const 外面 = 行.replace(/「[^」]*」/g, '');
  if (!外面.includes('本文件')) return null;
  for (const m of 行.matchAll(/「([^」]{6,80})」/g)) {
    const q = 净(m[1]);
    if (q.length >= 最短 && 约定.includes(q.slice(0, 最短))) return m[1];
  }
  return null;
}

const 全文 = readFileSync('docs/lessons.md', 'utf8');
const 行 = 全文.split('\n');
const 报 = [];
行.forEach((一, i) => {
  const 句 = 该报(一);
  if (句) 报.push([i + 1, 句, 一.trim().slice(0, 72)]);
});

/*
 * **三条自检，一条都不许省**（这个仓库的守卫栽过两次「看起来在跑，其实一行没跑」）：
 * 1. 诱饵必须抓到；2. 指向本档案自己的话不许报（否则长鸣）；
 * 3. **真的扫到了行**——「什么都没扫」和「扫了没问题」印出来是同一句「0 处」。
 */
const 诱饵 = '而本文件那条「同一份约定抄成几份必然分叉」已经被咬过三次';
if (!该报(诱饵)) {
  console.error('✗ 自检没过：诱饵（把 `AGENTS.md` 的句子挂在「本文件」后面）没被抓到——'
    + '多半是那句话在 `AGENTS.md` 里被改写了，证据源断了');
  process.exit(2);
}
if (该报('本文件另一节记着那次事故，这里不复述')) {
  console.error('✗ 自检没过：连「指向本档案自己」的正常写法都报，这尺子会长鸣');
  process.exit(2);
}
const 扫到 = 行.filter((一) => 一.replace(/「[^」]*」/g, '').includes('本文件')).length;
if (!扫到) {
  console.error('✗ 自检没过：一处「本文件」都没扫到——文件改名了还是读错了路径？');
  process.exit(2);
}

if (报.length) {
  for (const [行号, 句, 上下文] of 报) {
    console.log(`⚠ 第 ${行号} 行：「本文件」后面引的那句在 \`AGENTS.md\` 里 ——「${句}」`);
    console.log(`   ${上下文}`);
  }
  console.log(`\n共 ${报.length} 处（扫过 ${扫到} 行提到「本文件」的）。**改成写 \`AGENTS.md\`**，`);
  console.log('别留着让人去错的档案里 grep——指路指错不报错，只会让下一个人以为那条规矩不存在。');
  process.exit(1);
}
console.log(`✔ 「本文件」没有指向 \`AGENTS.md\` 的（扫了 ${扫到} 行，诱饵也抓到了）`);
