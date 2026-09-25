// 合成夹具：**只往快照灌，真实库一个字节都不碰**。
//
// 为什么非灌不可：真实库现在 **0 条划线、0 条书签**，而 B 组要量的正是
// `HighlightsPanel` 全库那一档和 `ReviewTable` 八千行。直接量会得到「八千行表格里
// 三行有内容」这种数——看着正常，什么也说明不了。
// 量级对齐 8 月那次「八千多条 0.7 秒」，评分按「整库都有评价」这一最坏情况灌。
import { DatabaseSync } from 'node:sqlite';
import { snapshotDbPath } from './snapshot.mjs';

const 每本划线 = 16;
const 划线书数 = 520;   // 520 × 16 ≈ 8300 条

/**
 * 评分 / 短评：直接 SQL，趁实例没起。
 * 走 rpc 要 8299 次往返，纯等；而这一格量的就是「有评价的行铺满八千行」的那个形状。
 */
export function seedRatings() {
  const db = new DatabaseSync(snapshotDbPath());
  try {
    const n = db.prepare(`
      update reading_state
         set rating = 1 + (book_id % 5),
             comment = '合成短评：这一条是为了量 ReviewTable 八千行而灌的夹具，不是真话。',
             rated_at = datetime('now', '-' || (book_id % 400) || ' days')
      where 1 = 1`).run();
    return n.changes;
  } finally {
    db.close();
  }
}

/**
 * 划线走 rpc `highlight.add`，因为它要的是**字符**偏移，而 `chapter` 表存的是**字节**
 * 偏移（`docs/lessons.md`「偏移量是字节，不是字符」）——自己去换算必错一种编码。
 * excerpt 从真正文里截，这样「我的笔记」那一档的 reanchor 判据才有东西可对账。
 *
 * ⚠️ **正文也从 rpc 取，不从 CDP 取。** 第一版这里写的是
 * `ev("(await window.novel.rpc('chapter.read'))")`，得到 0 条而一句错都不报：
 * `ev` 的 `awaitPromise` 只对「表达式的返回值是个 Promise」成立，
 * 而**顶层 `await` 本身就是语法错**，它退回一句 `'ERR SyntaxError…'` 字符串，
 * 于是 `ch?.text` 是 undefined、每本书都过不了 `正文.length < 200` 那道跳。
 * 走 HTTP 的 rpc 既没有这个问题，也不需要页面对象在场。
 */
export async function seedHighlights({ rpc }) {
  const { r } = await rpc('book.list', { filter: {}, limit: 100000 });
  const 书 = (Array.isArray(r) ? r : (r.rows ?? [])).slice(0, 划线书数);
  let 条 = 0;
  let 跳过 = 0;
  for (const [i, b] of 书.entries()) {
    if (i % 50 === 0) console.log(`  划线 ${i}/${划线书数} 本 · 已灌 ${条} 条`);
    /*
     * **单本读不到要跳过，不能让整趟死。** 真实库里「文件不见了」是一档正常状态
     * （测台这趟实际撞上的一本），而 `chapter.read` 对它是报错不是返回空。
     * 但「跳过了几本」要计下来，最后一道 0 条的检查才不会把「全都读不到」
     * 当成「正常没东西可灌」。
     */
    let 正文 = '';
    try {
      const ch = (await rpc('chapter.read', { bookId: b.id, idx: 1 })).r;
      正文 = String(ch?.text ?? ch?.body ?? '').replace(/\s+/g, '');
    } catch {
      跳过++;
      continue;
    }
    if (正文.length < 200) { 跳过++; continue; }
    for (let k = 0; k < 每本划线; k++) {
      const 起 = Math.floor((正文.length - 40) * (k / 每本划线));
      const 段 = 正文.slice(起, 起 + 24);
      await rpc('highlight.add', {
        bookId: b.id, chapterIdx: 1, charOffset: 起, length: 段.length,
        excerpt: 段, note: k % 3 === 0 ? '合成笔记' : undefined,
        color: ['yellow', 'blue', 'green', 'red'][k % 4],
      });
      条++;
    }
  }
  // **0 条要抛，不能只打一行**：那会让后面每一格「全库笔记」都量到一个空面板，
  // 而表上每个数都看着正常。（同「空集合的 0 和『全都好好的』逐字相同」那一族。）
  if (!条) throw new Error(`一条划线都没灌进去：${跳过}/${书.length} 本读不到第 1 章正文`);
  return 条;
}
