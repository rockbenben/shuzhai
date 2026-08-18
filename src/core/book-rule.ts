// 「这本书用哪条章节规则」——**全应用唯一的一份**。
//
// 起因：这句 SQL 原来抄在三处（`reparse.ts` 的 `bookRule`、`metadata.ts` 的
// `reparseBooks`、`backup.ts` 的导出），而**扫描那条路一处都没有**。
// 后果很具体：给一本追更的书手工配好章节规则，下次它更新、文件被覆盖写入，
// `scanRoot` 走「内容变了」那一档重新解析——**不读这条规则，回到自动选**。
// 用户看到的是「我明明设过，怎么又变回去了」，而且**会去手工配规则的，
// 恰恰就是自动选不对的那些书**。
//
// 同一个函数里，编码那一半的判断早就在了（`parseAndStore` 的
// 「用户手工指定过编码就听他的」），规则这一半只是没跟上。

import type { DatabaseSync } from 'node:sqlite';
import type { ParseRule } from './chapter.ts';

/** 这本书当前生效的自定义规则，没有就返回 null */
export function bookRule(db: DatabaseSync, bookId: number): string | null {
  const row = db
    .prepare("select pattern from parse_rule where book_id = ? and scope = 'book' and enabled = 1")
    .get(bookId) as { pattern: string } | undefined;
  return row?.pattern ?? null;
}

/**
 * 按**文件** id 找规则，编译成 `parseChapters` 能直接吃的形状。
 *
 * 给 `parseAndStore` 用：它手里只有 fileId。**放在它内部而不是让调用方传**——
 * 挡一次全护住，同 `buildFilter` 那条：让调用方各自记得传，迟早有人忘
 * （这次忘的正是扫描，而那是唯一会自动触发重解析的路径）。
 *
 * 规则坏了当作没有：一条存进去之后才失效的正则（比如换了 Node 版本），
 * 不该让这本书整个解析不出来——**别因为一条坏规则把所有东西都挡掉**，
 * 同 `isIgnored` 那条。
 */
export function ruleForFile(db: DatabaseSync, fileId: number): ParseRule[] | undefined {
  const row = db
    .prepare(
      `select p.pattern from parse_rule p
         join book_file f on f.book_id = p.book_id
        where f.id = ? and p.scope = 'book' and p.enabled = 1`,
    )
    .get(fileId) as { pattern: string } | undefined;
  if (!row) return undefined;
  try {
    return [{ name: 'custom', pattern: new RegExp(row.pattern) }];
  } catch {
    return undefined;
  }
}
