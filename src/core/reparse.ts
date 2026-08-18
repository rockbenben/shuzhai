// 章节规则编辑器的后端（spec §2.2）。
//
// spec 把这个功能定为「解析失败时的兜底，不可省略」，所以它的形状由一条规矩决定：
// **先预览，确认了才落库。** 预览这条路一个字都不写数据库——用户拿不准的时候可以
// 随便试，试坏了没有代价。

import type { DatabaseSync } from 'node:sqlite';
import { detectEncoding } from './encoding.ts';
import { parseChapters, type ParseRule } from './chapter.ts';
import { suggestRules, type Suggestion } from './suggest.ts';
import { parseAndStore } from './scan.ts';
import { readBook } from './reader.ts';

/** 预览里最多列几个标题。spec §2.2 写的是「前 20 章标题」 */
const PREVIEW_TITLES = 20;

export interface ParsePreview {
  count: number;
  titles: string[];
  recognized: boolean;
  ruleName: string;
}

/**
 * 用户写的正则可能是无效的，也可能是灾难性回溯的。
 * 无效的在这里就报清楚；回溯的靠 chapter.ts 里「标题行不超过 40 字」那条限住——
 * 每次只拿一个短字符串去匹配，炸不出什么来。
 */
function compile(pattern: string): ParseRule {
  try {
    return { name: 'custom', pattern: new RegExp(pattern) };
  } catch (e) {
    throw new Error(`正则无效：${e instanceof Error ? e.message : String(e)}`);
  }
}

function primaryFile(db: DatabaseSync, bookId: number): { id: number; path: string } {
  const row = db
    .prepare('select id, path from book_file where book_id = ? and is_primary = 1')
    .get(bookId) as { id: number; path: string } | undefined;
  if (!row) {
    /*
     * **说人话，别甩一个数字 id。** 这条路真的走得到：手工添的「只有记录」
     * 那类书压根没有文件，而卡片上「章节」那个按钮曾经照样显示——点下去
     * 用户看到的是「书 9 没有主文件」，那是数据库里的说法，不是他能懂的话。
     * 界面那头已经把按钮挡掉了，这里是给外部工具（§13）和以后的调用方兜底。
     */
    const t = db.prepare('select title from book where id = ?').get(bookId) as
      { title: string } | undefined;
    throw new Error(
      t ? `《${t.title}》只有一条记录，本地没有文件——章节切分要有 txt 才谈得上。`
        + '把文件放进书库文件夹再扫描一次，它会认领这条记录，你写的评价不会丢。'
        : `找不到这本书（id ${bookId}）`,
    );
  }
  return row;
}

/**
 * 试算：这条规则会切出多少章、前 20 章叫什么。
 * **只读，不写库。** pattern 为空时用内置规则，让用户看到「默认能切成什么样」。
 */
export async function previewChapters(
  db: DatabaseSync,
  bookId: number,
  pattern?: string,
): Promise<ParsePreview> {
  const { path } = primaryFile(db, bookId);
  const buf = await readBook(path);
  const { encoding } = detectEncoding(buf);
  const rules = pattern ? [compile(pattern)] : undefined;
  const { chapters, recognized, ruleName } = parseChapters(buf, encoding, rules);

  return {
    count: chapters.length,
    titles: chapters.slice(0, PREVIEW_TITLES).map((c) => c.title),
    recognized,
    ruleName,
  };
}

/**
 * 从这本书自己的正文里猜候选规则，给规则编辑器当起手式。
 * **只读文件，一个字都不写库**——和 previewChapters 一样，用户可以随便点。
 */
export async function suggestForBook(db: DatabaseSync, bookId: number): Promise<Suggestion[]> {
  const { path } = primaryFile(db, bookId);
  const buf = await readBook(path);
  return suggestRules(buf, detectEncoding(buf).encoding);
}

/**
 * 确认应用：按这条规则重新切章并落库，同时把规则记在这本书上，
 * 以后这本书重新解析（比如追更）都用它。
 *
 * 进度按 spec §2.3 恢复——这一步和扫描走的是同一个 `parseAndStore`，
 * 不另写一份，否则「换了规则之后进度怎么办」会有两套答案。
 */
export async function applyRule(
  db: DatabaseSync,
  bookId: number,
  pattern: string,
): Promise<ParsePreview> {
  compile(pattern); // 先验一遍，别写进库才发现是坏的
  const { id: fileId, path } = primaryFile(db, bookId);

  const r = await parseAndStore(db, fileId, path, [compile(pattern)]);
  db.prepare(
    `update book_file set chapter_count = ?, word_count = ?, encoding = ?,
            status = 'ok', parsed_at = datetime('now') where id = ?`,
  ).run(r.chapters, r.words, r.encoding, fileId);

  // 一本书只留一条自定义规则，改了就覆盖——留一串历史规则没人看得懂哪条在生效
  db.prepare("delete from parse_rule where book_id = ? and scope = 'book'").run(bookId);
  db.prepare(
    "insert into parse_rule(name, pattern, scope, book_id) values('自定义', ?, 'book', ?)",
  ).run(pattern, bookId);

  return previewChapters(db, bookId, pattern);
}

// 「这本书用哪条规则」只此一份，见 `book-rule.ts`。这里转出去是为了让 rpc
// 那张表继续从 `reparse.ts` 引（它引的是「规则编辑器」这一族的东西）
export { bookRule } from './book-rule.ts';

/** 去掉自定义规则，回到内置规则重新解析 */
export async function clearRule(db: DatabaseSync, bookId: number): Promise<ParsePreview> {
  db.prepare("delete from parse_rule where book_id = ? and scope = 'book'").run(bookId);
  const { id: fileId, path } = primaryFile(db, bookId);
  const r = await parseAndStore(db, fileId, path);
  db.prepare(
    `update book_file set chapter_count = ?, word_count = ?, parsed_at = datetime('now') where id = ?`,
  ).run(r.chapters, r.words, fileId);
  return previewChapters(db, bookId);
}
