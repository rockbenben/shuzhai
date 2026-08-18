// 分类、标签、筛选、智能书架（spec §3.1 / §7）。
//
// 筛选这一块的形状值得说明：**条件对象只有一处解释**（`buildFilter`），
// 书架列表、智能书架、统计都走它。筛选逻辑抄成两份的下场是「书架说 12 本、
// 智能书架说 9 本」，而两边各自都说得通、谁也不知道哪个对。

import { existsSync } from 'node:fs';
import { ensurePrimary } from './primary.ts';
import type { DatabaseSync } from 'node:sqlite';
import { PROBLEM_FILE_STATUS, TOUCHED_STATUS } from './labels.ts';
// 格式那一档认哪些扩展名，只此一份（`book-format.ts` 一个依赖都不 import）
import { BOOK_EXT } from './book-format.ts';

export interface Category {
  id: number;
  parent_id: number | null;
  name: string;
  sort_order: number;
}

export function listCategories(db: DatabaseSync): Category[] {
  return db
    .prepare('select * from category order by sort_order, name')
    .all() as unknown as Category[];
}

export function addCategory(db: DatabaseSync, name: string, parentId?: number | null): Category {
  if (!name.trim()) throw new Error('分类名不能为空');
  const id = Number(
    db.prepare('insert into category(name, parent_id) values(?, ?)').run(name.trim(), parentId ?? null)
      .lastInsertRowid,
  );
  return db.prepare('select * from category where id = ?').get(id) as unknown as Category;
}

/**
 * 删分类。子分类会跟着删（外键 cascade），但**书一本都不会删**——
 * `book.category_id` 是 set null，书只是回到「未分类」。
 */
export function removeCategory(db: DatabaseSync, id: number): void {
  db.prepare('delete from category where id = ?').run(id);
}

/**
 * `listTags` 返回的行。**导出给渲染进程用**——四个组件曾各自手抄一份同样的
 * `interface Tag`，而 TS 的结构化类型不会在这张表加字段时报错，
 * 三个抄本会悄悄过时。同一个 diff 里 `Filter` 和 `TitleKeyword` 都是从这里引的，
 * 这个漏了。
 */
export interface Tag {
  id: number;
  name: string;
  /** 打了这个标签的书有几本 */
  count: number;
}

export function listTags(db: DatabaseSync): Tag[] {
  return db
    .prepare(
      `select t.id, t.name, count(bt.book_id) as count
         from tag t left join book_tag bt on bt.tag_id = t.id
        group by t.id order by count desc, t.name`,
    )
    .all() as unknown as Tag[];
}

/** 给一批书打标签。标签不存在就建，已经打过的不会重复（主键挡着） */
/**
 * 把用户打的一串标签名理成一个个真标签。
 *
 * ⚠️ **逗号是 `book.list` 里 `tags` 那一列的分隔符**（`group_concat(t.name, ',')`），
 * 渲染进程拿到之后 `split(',')`。所以一个叫「科幻,悬疑」的标签会在卡片上
 * **变成两个根本不存在的标签**——tag 表里是一条，界面上是两个，
 * 而摘掉它们的按钮按名字去 `tag.list` 里找，找不到。
 *
 * 这正是 `bookKey` 特意挑 `\\u0000` 当分隔符要躲开的形状，
 * 只是这里的数据是用户自己打的：挑哪个字符都可能撞上，所以得在入口处理。
 *
 * **当分隔符切开，不是报错**：打「科幻,悬疑」的人多半就是想要两个标签。
 * 全角逗号「，」不切——那是正常的中文标点，可能真的是名字的一部分。
 */
/**
 * 标签名的长度上限。
 *
 * 不是洁癖：**一个 5000 字的标签名当场就把界面毁了**（量过，`tagBooks` 原来照收）。
 * 它会出现在书架上方那排开关里、卡片的标签行里、标签管理的列表里，
 * 每一处都按「一个词」排版；而想删掉它，得先在那些地方点中它。
 * 粘贴事故是最可能的来源——从别处复制一段话，落进那个输入框。
 *
 * 40 个字是给得很宽的：这个库里最长的标签是「值得再看一遍的那种」，9 个字。
 */
export const TAG_NAME_MAX = 40;

/** 拆逗号、去空白、丢空串。**规矩只此一份**，下面两个出口都从这儿走 */
function* tagParts(names: unknown[]): Generator<string> {
  for (const raw of names) {
    for (const part of String(raw).split(',')) {
      const n = part.trim();
      if (n) yield n;
    }
  }
}

export function splitTagNames(names: string[]): string[] {
  const out: string[] = [];
  for (const n of tagParts(names)) {
    if ([...n].length > TAG_NAME_MAX) {
      throw new Error(
        `标签名太长了（${[...n].length} 个字，最多 ${TAG_NAME_MAX} 个）：${n.slice(0, 12)}…`
        + '　标签是用来一眼扫过去的词，长句子请写进短评',
      );
    }
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * 「这个标签的 id，没有就建一个」——**全应用唯一的一份**。
 *
 * 原来五处各抄一遍同样的两句 SQL：`tagBooks`、按筛选结果打标签那处、
 * `highlight.ts` 的 `tagHighlights`、以及 `backup.ts` 恢复划线标签和书标签两处。
 * **抄本已经分叉过**：按筛选结果那处上面的注释量过「1000 条 insert 不复用语句
 * 404ms、复用 1ms」，于是它把 `book_tag` 那句提出了循环——
 * 而 `tag` 这两句五处全都还留在循环里，等于那条量出来的判据只落实了一半。
 *
 * ⚠️ **返回的是闭包不是普通函数**：两条语句只 prepare 一次，循环里反复用。
 * 顺手把「这个标签是不是刚建出来的」带回去——`backup.ts` 的 `createdTags`
 * 要数它，而那个数曾经在说假话（数成了「处理了几条关联」）。
 */
export function tagIdFor(db: DatabaseSync): (name: string) => { id: number; made: boolean } {
  const ins = db.prepare('insert or ignore into tag(name) values(?)');
  const sel = db.prepare('select id from tag where name = ?');
  return (name) => {
    const made = ins.run(name).changes > 0;
    return { id: (sel.get(name) as { id: number }).id, made };
  };
}

/**
 * **恢复备份用的那一版：规矩和 `splitTagNames` 一样，但太长的截断而不是抛。**
 *
 * 前门抛是对的——用户当场看得见报错，改短了重来。而恢复那条路抛一次就是
 * **整份备份作废**，而备份是不可再生数据的唯一保险。
 *
 * 实测恢复原来一个字不看，四条前门专门防住的东西全能落库：空标签、
 * 60 个字的名字、`科幻,悬疑`（卡片上按逗号拆，会变出两个点不掉的假标签）、
 * 前后带空格的（那正是「玄幻 / 玄幻」分裂的源头之一）。
 *
 * 返回 `fixed`：**这一条原样就合法吗**。不合法就算一处，界面照实说。
 */
export function normalizeTagNames(names: unknown[]): { names: string[]; fixed: number } {
  const out: string[] = [];
  let fixed = 0;
  for (const raw of names) {
    const parts: string[] = [];
    for (const n of tagParts([raw])) {
      const chars = [...n];
      parts.push(chars.length > TAG_NAME_MAX ? chars.slice(0, TAG_NAME_MAX).join('') : n);
    }
    // 原样就合法 = 恰好拆出一条、而且和原文一模一样
    if (parts.length !== 1 || parts[0] !== String(raw)) fixed++;
    for (const n of parts) if (!out.includes(n)) out.push(n);
  }
  return { names: out, fixed };
}

export function tagBooks(db: DatabaseSync, bookIds: number[], names: string[]): { tagged: number } {
  let tagged = 0;
  const idOf = tagIdFor(db);
  db.exec('begin');
  try {
    for (const name of splitTagNames(names)) {
      const tagId = idOf(name).id;
      for (const bookId of bookIds) {
        /*
         * ⚠️ **只数真的打上去的。**
         * 这里原来是无条件 `tagged++`——数的是「试了几次」，
         * 给 10 本已经有这个标签的书再打一遍照样返回 10。
         * 和 `backup.ts` 的 `createdTags` 是同一个形状，而两处都**没人读**，
         * 所以谁也没发现它在说假话（`dead-fields.mjs` 报的「没被读过」
         * 有时候不是「界面少了点什么」，是「这个数从来没被验证过」）。
         * `insert or ignore` 的 `changes` 才是真相。
         */
        if (db.prepare('insert or ignore into book_tag(book_id, tag_id) values(?, ?)')
          .run(bookId, tagId).changes > 0) tagged++;
      }
    }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return { tagged };
}

export function untagBooks(db: DatabaseSync, bookIds: number[], tagId: number): void {
  for (const bookId of bookIds) {
    db.prepare('delete from book_tag where book_id = ? and tag_id = ?').run(bookId, tagId);
  }
}

/**
 * 给**整个筛选结果**打标签。
 *
 * 为什么不在渲染进程里取完 id 再调 `tagBooks`：书架是分页的（一次 120 本），
 * 前端手上根本没有第 121 本以后的 id；而这个库有 8172 本，把 id 全传过来
 * 也只是白白搬一遍数据。圈书这件事在主进程做，前端只给筛选条件。
 *
 * **返回的是实际新增关联的 bookIds**——本来就有这个标签的不算。界面拿它做「撤销」，
 * 撤销时只摘掉这一批，不会把用户之前打好的一起摘掉。
 */
/**
 * 打标签之前先看会给哪几本**新增**关联。
 *
 * ⚠️ **「圈中了几本」和「会变几本」不是一个数。** `tagBooksByFilter` 返回的是
 * 实际新增的关联（`insert or ignore`，本来就有这个标签的不算），而按钮上原来
 * 写的是 `book.matchCount`——于是搜「重生」268 本、其中 200 本上一轮已经打过，
 * 按钮说「打上（268 本）」，点完结果卡说「已给 68 本打上」。
 *
 * 和批量改状态那次是同一个形状（本仓库「预览列出来的正好是不会变的那些」）：
 * **预览和执行必须是同一段判定算出来的**，不能一个走 matchCount、一个走真写入。
 */
export function planTagByFilter(
  db: DatabaseSync,
  filter: Filter,
  names: string[],
  /**
   * 回几本书名当样本。**计数照旧是真实的全量**——界面只列前 20 本，
   * 而整库 8172 本时回传全部书名是 233 KB，界面转手扔掉 99.7%（实测）。
   * 同本仓库当年为「批量改名」加 `book.idsByFilter` 的那条：
   * 回传的东西缩到界面真正要用的那些。
   */
  sampleSize = 20,
): { sample: Array<{ bookId: number; title: string }>; total: number; already: number } {
  const { sql, params } = buildFilter(filter);
  const books = db
    .prepare(`select b.id, b.title ${BOOK_JOIN} where ${sql} order by b.title collate nocase, b.id`)
    .all(...params) as unknown as Array<{ id: number; title: string }>;

  // **和写入那头共用同一份理名字的规则**，否则「科幻,悬疑」在预览里算一个
  // 不存在的标签（于是每本都「会变」），执行时却切成两个——预览和执行分叉
  const wanted = splitTagNames(names);
  if (wanted.length === 0) return { sample: [], total: 0, already: 0 };

  // 还不存在的标签，谁都还没有——那一档下面按「缺了它」处理
  const known = new Map<string, number>();
  for (const n of wanted) {
    const row = db.prepare('select id from tag where name = ?').get(n) as { id: number } | undefined;
    if (row) known.set(n, row.id);
  }
  const missing = wanted.length - known.size;

  const have = new Map<number, Set<number>>();
  if (known.size) {
    const ids = [...known.values()];
    for (const r of db
      .prepare(`select book_id, tag_id from book_tag where tag_id in (${ids.map(() => '?').join(',')})`)
      .all(...ids) as unknown as Array<{ book_id: number; tag_id: number }>) {
      (have.get(r.book_id) ?? have.set(r.book_id, new Set()).get(r.book_id)!).add(r.tag_id);
    }
  }

  const sample: Array<{ bookId: number; title: string }> = [];
  let total = 0;
  let already = 0;
  for (const b of books) {
    // 缺了任意一个就算「会变」——有几个新标签就至少新增几条关联
    const mine = have.get(b.id);
    const lacks = missing > 0 || [...known.values()].some((t) => !mine?.has(t));
    if (lacks) {
      total++;
      if (sample.length < sampleSize) sample.push({ bookId: b.id, title: b.title });
    } else already++;
  }
  return { sample, total, already };
}

export function tagBooksByFilter(
  db: DatabaseSync,
  filter: Filter,
  names: string[],
): { tagIds: number[]; bookIds: number[] } {
  const { sql, params } = buildFilter(filter);
  const ids = (
    db
      .prepare(
        `select b.id ${BOOK_JOIN} where ${sql}`,
      )
      .all(...params) as unknown as Array<{ id: number }>
  ).map((r) => r.id);

  const tagIds: number[] = [];
  const changed = new Set<number>();
  // **prepare 提到循环外面。** `ids` 可能是几千本（批量作用于整个筛选结果），
  // 每次循环重新 prepare 一遍纯属浪费——这个仓库在 `parseAndStore` 上量过
  // 同一件事：1000 条 insert 不复用语句 404ms，复用 1ms。
  // `tagIdFor` 里那两句 tag 语句同理，它自己就是个 prepare 一次的闭包
  const idOf = tagIdFor(db);
  db.exec('begin');
  try {
    const link = db.prepare('insert or ignore into book_tag(book_id, tag_id) values(?, ?)');
    for (const name of splitTagNames(names)) {
      const tagId = idOf(name).id;
      tagIds.push(tagId);
      for (const bookId of ids) {
        if (link.run(bookId, tagId).changes > 0) changed.add(bookId);
      }
    }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return { tagIds, bookIds: [...changed] };
}

/**
 * 改标签名。**目标名已经存在时就是合并**：书迁过去、旧标签删掉。
 *
 * 题材标签靠手打，`玄幻` / `玄幻 ` / `玄幻小说` 分裂是必然的。没有合并这条路，
 * 标签列表会在几百条之后烂掉，而那时已经没法收拾了。
 */
export function renameTag(db: DatabaseSync, tagId: number, raw: string): { mergedInto: number } {
  const name = raw.trim();
  if (!name) throw new Error('标签名不能为空');
  // 长度上限和打标签那头共用一条，理由见 `TAG_NAME_MAX`
  if ([...name].length > TAG_NAME_MAX) {
    throw new Error(
      `标签名太长了（${[...name].length} 个字，最多 ${TAG_NAME_MAX} 个）`
      + '　标签是用来一眼扫过去的词，长句子请写进短评',
    );
  }
  // 改名不能切成两个（那是「改名」不是「拆分」），所以这里是拒绝而不是切开。
  // 理由和 `splitTagNames` 同一条：逗号是卡片那一列的分隔符
  if (name.includes(',')) {
    throw new Error('标签名里不能有半角逗号——它是书架卡片上分隔标签用的。要两个标签就分两次打');
  }
  const exists = db.prepare('select id from tag where name = ?').get(name) as
    | { id: number }
    | undefined;

  if (!exists || exists.id === tagId) {
    db.prepare('update tag set name = ? where id = ?').run(name, tagId);
    return { mergedInto: tagId };
  }

  db.exec('begin');
  try {
    // insert or ignore：两个标签都打过的书不能插两遍（主键挡着，但要静默跳过）
    db.prepare(
      'insert or ignore into book_tag(book_id, tag_id) select book_id, ? from book_tag where tag_id = ?',
    ).run(exists.id, tagId);
    db.prepare('delete from tag where id = ?').run(tagId); // book_tag 由外键级联删掉
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return { mergedInto: exists.id };
}

/**
 * 语法碎片里的字。含这些字的 n-gram 一律丢掉。
 *
 * 中文没有词边界，只能数 n-gram，于是「重生之都市修仙」会同时数出
 * `重生` `生之` `之都` `都市`……其中「生之」「游之」「我的」「我是」「这个」
 * 这类碎片在真实书名里出现频率极高（实测「生之」140 次、「我的」176 次），
 * 排进前列会把真正有用的题材词挤下去。
 *
 * **`都` 故意不在这里**——「都市」122 本，是这个库里第二大的题材词。
 */
const PARTICLE = /[的之了是我你他她它这那个们不就也和与]/;

export interface TitleKeyword {
  word: string;
  count: number;
}

/**
 * 从书名里挖高频词，给「批量打标签」当起手式。
 *
 * 为什么需要：批量打标签作用于筛选结果，而唯一的批量抓手是书名关键词——
 * 可用户打开应用看到的是 8172 本、0 个标签，**不知道该往搜索框里敲什么**。
 * 实测这个库前 40 个词能覆盖 30% 的书（重生 268、都市 122、网游 106、
 * 三国 94、系统 92……），列出来点一下就能铺开几百本。
 *
 * **不是 AI**（铁律 4）：数 n-gram 而已。
 */
export function titleKeywords(db: DatabaseSync, minCount = 25, limit = 80): TitleKeyword[] {
  const titles = (db.prepare('select title from book').all() as unknown as Array<{ title: string }>)
    .map((r) => r.title);

  const grams = new Map<string, number>();
  for (const t of titles) {
    // 括号里多半是「（校对版全本）」「(1)」这类补充说明，不是题材
    const clean = t.replace(/[（(【[].*?[)）\]】]/g, '').replace(/[^一-龥A-Za-z0-9]/g, ' ');
    const seen = new Set<string>(); // 同一本书里重复出现只算一次
    for (const seg of clean.split(/\s+/)) {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= seg.length; i++) {
          const g = seg.slice(i, i + n);
          if (!/[一-龥]/.test(g) || PARTICLE.test(g) || seen.has(g)) continue;
          seen.add(g);
          grams.set(g, (grams.get(g) ?? 0) + 1);
        }
      }
    }
  }

  const sorted = [...grams].filter(([, n]) => n >= minCount).sort((a, b) => b[1] - a[1]);
  const keep: TitleKeyword[] = [];
  for (const [word, count] of sorted) {
    // 已经收了一个更短的词，而这个词的书几乎都在它里面 → 是它的派生，不单列
    // （`重生军嫂` 之于 `重生`）
    if (keep.some((k) => word.includes(k.word) && k.count >= count * 0.9)) continue;
    keep.push({ word, count });
    if (keep.length >= limit) break;
  }
  return keep;
}

/** 删标签。`book_tag` 由外键 on delete cascade 一起清掉 */
export function deleteTag(db: DatabaseSync, tagId: number): void {
  db.prepare('delete from tag where id = ?').run(tagId);
}

export interface Filter {
  /** 书名 / 作者 / 别名 模糊匹配 */
  keyword?: string;
  categoryId?: number | null;
  tagIds?: number[];
  /** 阅读状态：want / reading / finished / dropped / shelved */
  readingStatus?: string[];
  /** 连载状态：ongoing / finished / abandoned / unknown */
  serialStatus?: string[];
  minWords?: number;
  maxWords?: number;
  /** 只看文件缺失的 / 只看解析失败的 */
  fileStatus?: string[];
  /**
   * 被屏蔽目录下的书怎么处理。默认 'hide'——用户屏蔽一个目录就是不想再看见它们。
   * 'only' 用来做侧栏那个「已屏蔽」档，让它们**还找得回来**（书没删）。
   */
  excluded?: 'hide' | 'only' | 'all';
  /**
   * 只看某个目录（含子目录）。相对根目录的路径，用 `/` 分隔，`''` = 根目录直属的文件。
   *
   * **不做成标签。** 目录是库里已有的事实（`book_file.path` + `root_id`），
   * 按它筛不需要新数据、不需要迁移；派生成标签则会往标签列表里塞十几条噪音，
   * 而且文件一移动就静默失效，得重新打。
   */
  dir?: string;
  /**
   * 藏起来的目录（含子目录）。
   *
   * 和 `dir` 的区别是**用途不同，不是同一件事的两种写法**：`dir` 是导航
   * （「现在只看这一个」，看完就切走），`hideDirs` 是长期偏好
   * （「这几个我平时不想看见」，设一次基本不再动）。用树做后者很别扭——
   * 一次只能选一个、每次还要点开点回去。
   *
   * **默认空 = 全都显示，隐藏必须是显式的。** 反过来做成「只显示选中的」，
   * 下次扫描新加的目录会默认不可见，而且不会有任何提示。
   */
  hideDirs?: string[];
  /**
   * 只看这几种格式。值是**扩展名本身**（`txt` / `pdf` / `epub` …），
   * 外加 `manual`＝手工添的、根本没有文件的那些。多选是**任意一种**。
   *
   * ⚠️ **不用 `formatOf` 那套三态（manual / text / catalog）。**
   * 那个三态回答的是「能不能在书斋里读」，是给代码用的判断；
   * 而人挑分类时想的是「PDF」「txt」，不是「只编目的」。
   * `catalog` 还把 pdf / epub / mobi 揉成一坨——正好是最需要分开的地方。
   *
   * 想要「能在书斋里读的」也表达得出来：选 txt 就是。
   * **一个轴一套说法**，不给同一件事配两种词。
   */
  format?: string[];
  /** 只看几星以上（含）。个人评价体系，见 specs/2026-08-14-personal-reviews-design.md */
  minRating?: number;
  /**
   * 只看这一年读完的（`reading_state.finished_at`）。
   *
   * `finished_at` 一直在写（标成「已读完」时、翻到最后一页时、手工添读过的书时），
   * 也一直进备份，**而界面上从来没显示过、更筛不了**——和 `minRating` 当年
   * 那条「能存不能筛」是同一族。用户拿它回答的是「我 2025 年读完了哪些」。
   *
   * ⚠️ 年份口径走 `YEAR_SQL`，别在别处另写一个 `strftime`——那是 UTC 陷阱。
   */
  finishedYear?: number;
  /**
   * 只看评价过的（true）/ 只看还没评价的（false）。
   * 「评价过」= 有星级**或**有短评——只写了一句「烂尾了别看」没打分的也算，
   * 那句话恰恰是「避免重复阅读」最有用的信息
   */
  rated?: boolean;
  /**
   * **记过笔记的**（划线或书签，任意一样）。
   *
   * 笔记原来在书架上**完全看不见**：`highlight` / `bookmark` 两张表只在孤儿检测
   * 那条 SQL 里露过一次面。也就是说认真读过、划了几十条的书，
   * 在书架上和从没打开过的书一模一样——**记完就找不着了**。
   */
  hasNotes?: boolean;
}

/**
 * 把筛选条件翻译成 where 子句和参数。**只有这一处**。
 * 返回的 sql 片段总是以 `1=1` 开头，调用方直接拼在 where 后面即可。
 */
/**
 * 筛选用的 from/join 骨架。**`buildFilter` 生成的 where 依赖这三张表的别名**
 * （`b` / `fl` / `r`），所以两者必须成对使用——别再各写各的。
 *
 * 本来这段在 `listBooks`、`shelfCounts`、`countBooks`、`tagBooksByFilter`
 * 里各抄了一份。四份的话，以后要给筛选加一个 join（比如按分类名筛）就得记住
 * 四个地方，漏一个就是本文件开头警告的那种「书架说 12 本、智能书架说 9 本」。
 */
export const BOOK_JOIN = `from book b
     left join book_file fl on fl.book_id = b.id and fl.is_primary = 1
     left join reading_state r on r.book_id = b.id`;

/**
 * `Filter` 认得的全部键。**多一个不认识的就报错，绝不能默默忽略。**
 *
 * 起因：`buildFilter` 从 `'1=1'` 起手，只给认识的键追加条件——于是
 * **一个拼错的键 = 没有任何条件 = 整个书库**。读的时候顶多是「结果不对」，
 * 而按筛选批量写的那几条（`tag.addByFilter`、`reading.setStatusByFilter`）
 * 会当场把整库改掉，还返回一个成功。
 * `{keywords: '...'}`（少个 d 多个 s）就够了，而 rpc 表对外开放（AGENTS.md §13），
 * 外部调用方最容易错的正是键名。
 *
 * 挡在这里而不是挡在某一条 rpc 上：所有走筛选的路径共用它，
 * 挡一次全都护住——挡在调用方就是抄 N 份。
 */
const FILTER_KEYS = new Set([
  'keyword', 'categoryId', 'tagIds', 'readingStatus', 'serialStatus',
  'minWords', 'maxWords', 'fileStatus', 'excluded', 'dir', 'hideDirs',
  'minRating', 'rated', 'format', 'hasNotes', 'finishedYear',
]);

/**
 * 「评价过」的判据。**有星级或有短评都算**——只写了句「烂尾了别看」没打分的
 * 也是评价过，那句话恰恰是「避免重复阅读」最有用的信息。
 *
 * 抽成一处是因为它已经有两份了：书架「我的书评」那一档（`buildFilter`）
 * 和 `/api/stats` 的 `rated`。**两份 SQL 说同一件事，改一处漏一处不会有任何报错**——
 * 侧栏说 40 本、`/api/stats` 说 12 本，外部工具和界面对不上账，
 * 而谁也说不清哪个是对的。同本文件那条 `PROBLEM_FILE_STATUS`。
 *
 * @param alias `reading_state` 在那条 SQL 里的别名（`buildFilter` 用 `r`，
 *   直接查 `reading_state` 的地方传空串）
 */
/**
 * 「记过笔记」的判据：**有划线或有书签都算**。
 *
 * 抽成一处的理由和 `ratedSql` 一模一样：它马上就会有三份用途——
 * 卡片上那个数、侧栏「记过笔记」那一档、筛选条件。
 * **三份 SQL 说同一件事，改一处漏两处不会有任何报错**，
 * 而对不上账的时候谁也说不清哪个是对的。
 *
 * ⚠️ 用 `exists` 不用 `count`：这里只问「有没有」，
 * 而一本书几百条划线时 `count` 要把它们全数一遍。
 */
export function hasNotesSql(): string {
  return `(exists (select 1 from highlight h2 where h2.book_id = b.id)`
    + ` or exists (select 1 from bookmark k2 where k2.book_id = b.id))`;
}

/**
 * 用户输入 → `like` 的实参。**配套的 SQL 必须跟着写 `escape '\'`**，
 * 不写的话这里转出来的反斜杠会被当成普通字符，反而搜不到。
 *
 * ⚠️ `%` 和 `_` 在 `like` 里是通配符，而用户以为自己搜的是字面上那个字符。
 * 实测：书架顶上那个搜索框里输一个 `%`，11 本书全中；输 `_` 一样；
 * 输 `剑%来` 也能命中《剑来》——看起来像「搜得挺聪明」，其实是搜错了。
 *
 * **三处 like 拼接共用这一份**：书架筛选（本文件 `buildFilter`）、
 * 全库搜索的书名档（`search.ts` 的 `searchMeta`）、
 * 正文短查询的回落路径（`search.ts` 的 `searchFullText`）。
 * 各自加转义必然分叉——这个仓库已经被「抄第二份」咬过好几次。
 */
export function likeArg(raw: string): string {
  return '%' + raw.trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/**
 * 「这本书是哪一年读完的」。**全应用只此一份表达式**——按年份筛（`buildFilter`）
 * 和年份下拉里那几个数（`finishedYears`）必须是同一个算法，
 * 两份的话会出现「下拉里写着 2025 有 3 本，点进去 0 本」，而谁也说不清哪个对
 * （同 `ratedSql` / `hasNotesSql` 那两条）。
 *
 * ⚠️ **必须带 `'localtime'`。** `finished_at` 是 sqlite 的 `datetime('now')`，
 * 存的是 **UTC**；而「我 2026 年读完了几本」问的是**用户日历上的**年份。
 * 东八区 1 月 1 日 0 点半读完的书，库里记的是 `2025-12-31 16:30`——
 * 不加这个修饰符，它会被算进 2025 年。不报错、不留痕，只是每年元旦前后
 * 那几个小时读完的书归错年份。同 `format.ts` 的 `sqlTime` 那条：
 * 库里的时间文本原样拿来用，就是把 UTC 当本地时间。
 */
export const YEAR_SQL = "strftime('%Y', r.finished_at, 'localtime')";

/**
 * 库里出现过哪几个「读完年份」，各多少本。给筛选器那排年份芯片用。
 *
 * **只列真的有的那几年**——同 `formatCounts` 那条判据：一个只在 2025 年
 * 读完过书的库，不该摆出 2019–2026 八个点了必然圈中 0 本的芯片。
 */
export function finishedYears(db: DatabaseSync): Array<{ year: string; n: number }> {
  return db
    .prepare(
      `select ${YEAR_SQL} as year, count(distinct b.id) as n
         ${BOOK_JOIN}
        where r.finished_at is not null
        group by 1 order by 1 desc`,
    )
    .all() as unknown as Array<{ year: string; n: number }>;
}

export function ratedSql(alias = ''): string {
  const c = alias ? `${alias}.` : '';
  return `(${c}rating is not null or ifnull(${c}comment, '') != '')`;
}

export function buildFilter(f: Filter): { sql: string; params: Array<string | number> } {
  for (const k of Object.keys(f ?? {})) {
    if (!FILTER_KEYS.has(k)) {
      throw new Error(`不认识的筛选条件：${k}。可选：${[...FILTER_KEYS].join(' / ')}`);
    }
  }
  const parts: string[] = ['1=1'];
  const params: Array<string | number> = [];

  if (f.keyword?.trim()) {
    // 字符串字面量一律用单引号：SQLite 里双引号是**标识符**，
    // `ifnull(b.author, "")` 会被当成一个名叫空串的列，报 no such column
    parts.push("(b.title like ? escape '\\' or ifnull(b.author, '') like ? escape '\\' or ifnull(b.aliases, '') like ? escape '\\')");
    // ⚠️ 走 `likeArg`：`%` / `_` 是通配符，不转义的话输一个 `%` 就是「全部」
    const like = likeArg(f.keyword);
    params.push(like, like, like);
  }
  if (f.categoryId !== undefined) {
    if (f.categoryId === null) parts.push('b.category_id is null');
    else {
      parts.push('b.category_id = ?');
      params.push(f.categoryId);
    }
  }
  if (f.readingStatus?.length) {
    parts.push(`ifnull(r.status, 'none') in (${f.readingStatus.map(() => '?').join(',')})`);
    params.push(...f.readingStatus);
  }
  if (f.serialStatus?.length) {
    parts.push(`b.serial_status in (${f.serialStatus.map(() => '?').join(',')})`);
    params.push(...f.serialStatus);
  }
  // 路径分隔符两种都认：库里存的是 Windows 的反斜杠，但传进来的用 `/`
  const ROOT = '(select path from library_root where id = fl.root_id)';
  /** 「这个文件在 dir 底下」的条件。`''` = 根目录直属（根路径后只剩一个分隔符） */
  const under = (d: string) =>
    d === ''
      ? { sql: `fl.path not like ${ROOT} || '\\%\\%'`, param: null }
      : { sql: `fl.path like ${ROOT} || '\\' || ? || '\\%'`, param: d.replace(/\//g, '\\') };

  if (f.dir !== undefined) {
    const u = under(f.dir);
    parts.push(u.sql);
    if (u.param !== null) params.push(u.param);
  }
  for (const d of f.hideDirs ?? []) {
    const u = under(d);
    // 主文件可能为 null（书还没有文件），`not (...)` 对 null 求值是 null 而不是 true，
    // 那本书会被静默滤掉。ifnull 兜住
    parts.push(`ifnull(not (${u.sql}), 1)`);
    if (u.param !== null) params.push(u.param);
  }
  if (f.fileStatus?.length) {
    parts.push(`ifnull(fl.status, 'ok') in (${f.fileStatus.map(() => '?').join(',')})`);
    params.push(...f.fileStatus);
  }
  if (f.minWords !== undefined) {
    parts.push('ifnull(fl.word_count, 0) >= ?');
    params.push(f.minWords);
  }
  if (f.maxWords !== undefined) {
    parts.push('ifnull(fl.word_count, 0) <= ?');
    params.push(f.maxWords);
  }
  // 默认把被屏蔽的挡在外面。判据落在 book_file.excluded 上，
  // 由 ignore.ts 的 applyIgnoreToLibrary 在规则变化时重算
  if (f.excluded === 'only') parts.push('ifnull(fl.excluded, 0) = 1');
  else if (f.excluded !== 'all') parts.push('ifnull(fl.excluded, 0) = 0');

  if (f.tagIds?.length) {
    // 要求**同时**具备所有选中的标签，不是任意一个——「玄幻 + 已完结」问的是交集
    parts.push(
      `(select count(*) from book_tag bt where bt.book_id = b.id and bt.tag_id in
         (${f.tagIds.map(() => '?').join(',')})) = ?`,
    );
    params.push(...f.tagIds, f.tagIds.length);
  }

  /*
   * 按格式筛。**多选是「任意一种」**（`or`），和标签那条「同时具备」（`and`）相反——
   * 一本书只有一个主文件，「既是 txt 又是 pdf」按定义是空集，
   * 照标签那套写就是一条永远筛不出东西的规则。
   *
   * ⚠️ **认不出的值要当场报错，不能悄悄不匹配。** `like '%.xyz'` 匹配不到任何东西，
   * 于是一个拼错的格式名 = 一个永远空的分类，而界面上只会说「圈中 0 本」——
   * 判据抄本文件 `FILTER_KEYS` 那条：**默默忽略比报错危险**。
   */
  if (f.format?.length) {
    const 认得 = new Set([...BOOK_EXT, 'manual']);
    const 不认得 = f.format.filter((x) => !认得.has(x));
    if (不认得.length) throw new Error(`认不出这种格式：${不认得.join('、')}`);
    const 条件: string[] = [];
    for (const e of f.format) {
      // `manual` 不是扩展名，是「压根没有文件」——手工添的那些书
      if (e === 'manual') { 条件.push('fl.id is null'); continue; }
      条件.push('lower(fl.path) like ?');
      params.push(`%.${e}`);
    }
    parts.push(`(${条件.join(' or ')})`);
  }

  if (f.minRating !== undefined) {
    parts.push('ifnull(r.rating, -1) >= ?');
    params.push(f.minRating);
  }
  // 哪一年读完的。**表达式只此一份**（`YEAR_SQL`），下拉里的年份和按它筛出来的
  // 必须是同一个算法，否则会出现「下拉里写着 2025 有 3 本、点进去 0 本」
  if (f.finishedYear !== undefined) {
    parts.push(`${YEAR_SQL} = ?`);
    params.push(String(f.finishedYear));
  }
  // 「评价过」= 有星级**或**有短评。只写了句「烂尾了别看」没打分的也得算——
  // 那句话正是「避免重复阅读」最有用的信息
  if (f.rated !== undefined) {
    const has = ratedSql('r');
    parts.push(f.rated ? has : `not ${has}`);
  }
  // 「记过笔记」= 有划线**或**有书签。判据只此一份（`hasNotesSql`），
  // 卡片上那个数、侧栏那一档、筛选都从它来——同 `ratedSql` 那条
  if (f.hasNotes !== undefined) {
    parts.push(f.hasNotes ? hasNotesSql() : `not ${hasNotesSql()}`);
  }

  return { sql: parts.join(' and '), params };
}

export type SortBy = 'time' | 'title' | 'words' | 'rated' | 'rating' | 'finished';

/**
 * 排序。**默认按文件时间**，不是 `book.updated_at`。
 *
 * `updated_at` 是数据库行的更新时间，一次全库扫描会把成千上万本书写成同一个值——
 * 实测用户库里 **7459 本共用一个时间戳**，所以「按更新时间排」在那批里完全是随机的，
 * 而且看起来像是排过了。文件的 mtime 才是「这本书什么时候到我这儿的」。
 *
 * 都要带 `b.id` 兜底：mtime 相同的文件不少（同一批拷进来的），
 * 没有稳定的次级键的话，翻到第二页可能出现重复或漏掉的书。
 */
const ORDER: Record<SortBy, string> = {
  // **读过的排最前面**，按最后阅读时间倒序；没读过的跟在后面按文件时间。
  // 原来是单独一张「继续阅读」卡片，但它只放得下一本，而且那本书在下面的
  // 书架里还会再出现一次。排序里解决就不用那张卡了，还能一路看到前几本
  time: `case when r.last_read_at is null then 1 else 0 end,
         r.last_read_at desc,
         ifnull(fl.mtime, 0) desc, b.id desc`,
  // ⚠️ 中文是**码位序，不是拼音序**（丙 < 乙 < 甲）。SQLite 没有拼音排序，
  // 而分页要求排序在 SQL 里做——8000 本不可能拉到前端 localeCompare 一遍。
  // 实际价值是把同前缀的系列排到一起，不是给人按字典查
  title: 'b.title collate nocase, b.id',
  words: 'ifnull(fl.word_count, 0) desc, b.id desc',
  // 「我的书评」这一档默认按它：最近写的排前面。没评价过的沉到最后而不是混在中间——
  // 这一档本来就是给「翻翻我写过什么」用的
  rated: `case when r.rated_at is null then 1 else 0 end,
          r.rated_at desc, b.id desc`,
  rating: 'ifnull(r.rating, -1) desc, r.rated_at desc, b.id desc',
  // 「最近读完的在前」。没读完的沉到最后，不混在中间——同上面 `rated` 那条。
  // 表格视图那一列的表头点一下走的就是它；`finished_at` 在这之前
  // **界面上一处都没用过**（一直只在库里和备份里）
  finished: `case when r.finished_at is null then 1 else 0 end,
             r.finished_at desc, b.id desc`,
};

/**
 * 排序键 → order by 子句。**不认识的当场报错，不许拼进 SQL。**
 *
 * 原来是直接 `ORDER[page.sort ?? 'time']`，两个毛病：
 *
 *  1. **拼错了只会得到一句 SQLite 原文。** 外部工具传 `sort: 'recent'`，
 *     `undefined` 被拼进去，用户看到的是 `no such column: undefined`——
 *     和 `convert.set` 那次一模一样的形状（rpc 表对外开放，见 AGENTS.md §13，
 *     而外部调用方最容易错的就是参数名和取值）。
 *  2. **对象取值会命中原型链。** `ORDER['constructor']` 给的是
 *     `function Object() { [native code] }`，`ORDER['toString']` 同理——
 *     拼进 SQL 只会得到语法错误（**不是注入**，因为拿不到任意字符串），
 *     但 `api.test.ts` 早就为 rpc 白名单钉过「原型链上的名字不算」这一条，
 *     同一个道理在这儿也成立。
 *
 * 用 `Object.hasOwn` 判，两个毛病一起没。
 */
/**
 * 认得的排序键。**从 `ORDER` 自己算出来，不另写一份清单**——
 * 渲染进程要用它校验 localStorage 里存的偏好（用户能手改那个值），
 * 而抄一份下来，加一档排序时必然漏掉其中一份。
 */
export const SORT_KEYS: SortBy[] = Object.keys(ORDER) as SortBy[];

function orderBy(sort: SortBy | undefined): string {
  const key = sort ?? 'time';
  if (!Object.hasOwn(ORDER, key)) {
    throw new Error(`不认识的排序方式：${String(key)}。可选：${Object.keys(ORDER).join(' / ')}`);
  }
  return ORDER[key];
}

/**
 * 书架列表。不传筛选就是全部。
 *
 * **必须能分页**：实测有人的库里 5000+ 本书，一次全铺出来光渲染就卡死，
 * 何况每张封面还要单独取一次。`limit` 不传时给一个够大的默认值，
 * 让老调用方（备份、导出）行为不变。
 */
export function listBooks(
  db: DatabaseSync,
  filter: Filter = {},
  page: { limit?: number; offset?: number; sort?: SortBy } = {},
): unknown[] {
  const { sql, params } = buildFilter(filter);
  return db
    .prepare(
      `select b.id, b.title, b.author, b.serial_status, b.category_id,
              (b.cover_path is not null) as has_cover,
              fl.path, fl.word_count, fl.chapter_count, fl.status as file_status,
              r.status as reading_status, r.percent, r.rating,
              -- 短评要在卡片上悬停就能看见（「烂尾了别看」必须在点进去之前出现），
              -- 所以列表里就得带上，理由和下面 chapter_idx 那条一样
              r.comment, r.rated_at,
              -- 什么时候读完的。**表格视图那一列**，也是这个字段第一次露面：
              -- 它一直在写、一直进备份，界面上从来没显示过
              r.finished_at,
              -- 弃坑原因和短评一样要在卡片上看得见。**它甚至更该看见**：
              -- 「我当初为什么弃了它」正是决定「要不要再翻开」的那句话
              r.drop_reason,
              -- 点书要接着上次的位置打开。**列表里就得带上**，否则每张封面
              -- 还要单独问一次进度——8000 本就是 8000 次 IPC，那个坑踩过一次了
              r.chapter_idx, r.char_offset, r.last_read_at,
              -- 上次读到那一章**叫什么**。「读到 505 章」只说了位置，
              -- 「大仙手下唯一的活口」才让人想起来读到哪了。走
              -- idx_chapter_file 索引，120 行的一页可以忽略不计
              (select c.title from chapter c
                where c.file_id = fl.id and c.idx = r.chapter_idx) as chapter_title,
              (select group_concat(t.name, ',') from book_tag bt
                 join tag t on t.id = bt.tag_id where bt.book_id = b.id) as tags,
              -- **记了几条笔记**。列表里就得带上，理由同上面 chapter_idx 那条：
              -- 每张卡再单独问一次就是 8000 次 IPC。
              -- ⚠️ 这几行注释在**模板字符串里**，写反引号会当场把它截断
              -- 划线和书签**一起数**：卡片上要回答的是「这本书我记过东西吗」，
              -- 而不是「划线几条、书签几条」——那个细分在「书签与划线」面板里
              ((select count(*) from highlight h3 where h3.book_id = b.id)
               + (select count(*) from bookmark k3 where k3.book_id = b.id)) as note_count
         ${BOOK_JOIN}
        where ${sql}
        order by ${orderBy(page.sort)}
        limit ? offset ?`,
    )
    .all(...params, page.limit ?? 100000, page.offset ?? 0);
}

/**
 * 一个**分类**：一个名字 + 一条筛选规则。
 *
 * 「按文件夹」「按评分」这类东西**只配当规则，不配当分类**——它们太粗，
 * 一个文件夹里什么都有，三星以上横跨所有题材。用户真正想要的是
 * 「A ＝ 某某文件夹里四星以上的那些」，那是几条规则的**组合**。
 * 所以界面上只摆分类，文件夹和评分退回到分类编辑器里当字段。
 */
export interface SmartShelf {
  id: number;
  name: string;
  filter: Filter;
}

export function saveShelf(db: DatabaseSync, name: string, filter: Filter, id?: number): { id: number } {
  if (!name.trim()) throw new Error('分类名不能为空');
  if (id) {
    const n = db
      .prepare('update smart_shelf set name = ?, filter_json = ? where id = ?')
      .run(name.trim(), JSON.stringify(filter), id).changes as number;
    // 数 `changes` 不是无条件报成功——那是本仓库栽过好几次的形状（`tag.delete`）
    if (n === 0) throw new Error(`没有 id 为 ${id} 的分类。先用 shelf.list 看一下有哪些`);
    return { id };
  }
  const made = Number(
    db
      .prepare('insert into smart_shelf(name, filter_json) values(?, ?)')
      .run(name.trim(), JSON.stringify(filter)).lastInsertRowid,
  );
  return { id: made };
}

export function listShelves(db: DatabaseSync): SmartShelf[] {
  const rows = db.prepare('select id, name, filter_json from smart_shelf order by id').all() as
    unknown as Array<{ id: number; name: string; filter_json: string }>;
  return rows.map((r) => ({ id: r.id, name: r.name, filter: JSON.parse(r.filter_json) as Filter }));
}

export function removeShelf(db: DatabaseSync, id: number): void {
  db.prepare('delete from smart_shelf where id = ?').run(id);
}


export interface ShelfCounts {
  /**
   * 当前**筛选范围内**一共几本（`scope` 里那些条件都算数）。侧栏「全部」那一档
   * 显示的就是它——选了标签/分类之后，侧栏的数要跟着变，否则
   * 「全部 8172」旁边列着 153 本书。
   *
   * ⚠️ **别拿它判断「库是不是空的」**，那是下面 `total` 的活。
   * 一个圈不中任何书的筛选会让它变成 0，而库里可能有八千本。
   */
  all: number;
  /**
   * **整个书库一共几本，不受 `scope` 影响。**
   *
   * 补它是因为界面上有三处（搜索框、顶栏那排控件、分类那一排）要问的是
   * 「这个用户到底有没有书」——空库的第一屏应该只剩「选一个文件夹」。
   * 那三处原来问的是 `all`，而 `all` 带着当前筛选：
   *
   * **筛出 0 本 → 这三样一起消失 → 用户没有任何办法取消那个筛选。**
   * 搜一个不存在的词，搜索框自己就没了，连刚打的字都改不掉；
   * 点中一个圈不中书的分类，那排分类连同「全部」一起消失，只能重启应用。
   *
   * 更糟的是**代码注释当时写着「判据是整个库空，不是当前筛选为空」**——
   * 描述的是一件它没做到的事（本仓库反复出现的那个形状）。
   */
  total: number;
  byReading: Record<string, number>;
  problem: number;
  /** 被屏蔽的有几本。侧栏要显示出来，让用户知道它们还在 */
  excluded: number;
  /**
   * 评价过的有几本（「我的书评」那一档）。
   *
   * **加档位就得加计数**：侧栏的数字来自这里，漏了的话那一档永远是光秃秃的
   * 一个名字，用户不知道自己评过多少本。加「我的书评」时就漏了这一条。
   */
  rated: number;
  /**
   * 记过笔记的有几本（「记过笔记」那一档）。
   *
   * ⚠️ **加档位就得加这一条**（上面 `rated` 那段警告的正是这个）——
   * 侧栏里数为 0 的次要档整个不显示，漏了计数的话那一档**压根不出现**，
   * 而不是显示成 0。这次就是这么栽的：档位、筛选、卡片角标全做完了，
   * 侧栏上找不到它，看起来像筛选没生效。
   */
  noted: number;
  /**
   * 三档星级开关各有几本（★5 / ★4+ / ★3+，累计，跟着当前的横向筛选走）。
   *
   * **Calibre 的 Tag Browser 里每一档评分都写着有几本**，我们这排开关原来什么都不写——
   * 而它旁边那排标签开关是带书数的（`.chip-n`）。**同一排界面里两种说法**，
   * 更要紧的是：点一个 0 本的档位得到的是一屏空书架，用户不知道是自己筛错了还是坏了
   * （同「摆着一个 0 本的按钮」那条）。
   *
   * 一条 `sum(case when …)` 算完三档，不是三条 count——本文件那句
   * 「再加两三档就该把它们并成一条」说的就是这里。
   */
  byRating: Record<number, number>;
  /** 读过、可是还没写一句——这个应用唯一的待办清单 */
  unreviewed: number;
}

/**
 * 当前筛选条件命中多少本。
 *
 * 书架头部原来显示 `books.length`，那是**已加载的数量**——分页之后永远是 120，
 * 跟「筛出来多少本」是两回事。批量打标签作用于整个筛选结果，那个数字必须是真的。
 *
 * 不复用 `shelfCounts`：它要算 7 个分档，这里只要一个数。
 */
/**
 * 筛选结果的 id 列表。**只要 id，一列都不多取。**
 *
 * 起因：批量改名原来是 `book.list({ limit: matched })` 拉回整个筛选结果，
 * 然后 `.map(b => b.id)` 把其余的全扔掉——而 `listBooks` 一行选 19 个列
 * （含 comment / chapter_title / path）。在真实库上点「全部」就是把 8172 本
 * 整个序列化过一趟 IPC，只为拿 8172 个数字（本文件量过：3000 本约 1.3 MB JSON）。
 *
 * 另外两个批量（打标签、改状态）都在主进程里按 filter 做完，压根不回传书。
 * 改名做不到那样——它得先出预览让用户核对（spec §3.3 的安全阀），
 * 所以退一步：回传的东西缩到只剩 id。
 */
export function bookIdsByFilter(db: DatabaseSync, filter: Filter = {}): number[] {
  const { sql, params } = buildFilter(filter);
  return (
    db.prepare(`select distinct b.id ${BOOK_JOIN} where ${sql}`).all(...params) as unknown as Array<{ id: number }>
  ).map((r) => r.id);
}

/**
 * 库里每种格式各有多少本。
 *
 * 分类那个「格式」筛选**只列真的存在的那几种**：一个全是 txt 的库不该摆出
 * mobi / azw3 / djvu 四个点了必然圈中 0 本的芯片——本仓库那条老规矩
 * 「摆一排点了必然出错的按钮，比没有更糟」。
 *
 * ⚠️ **一条 SQL 走一遍，不是每种格式各查一次。** 那样是 7 次全表扫；
 * 这个库 8000 多本，开个弹窗要等小一秒。
 *
 * ⚠️ 不在 SQL 里现算扩展名（sqlite 没有 `reverse`，切字符串要写一长串
 * `instr` 嵌套）。按已知的那几种各来一个 `sum(case ...)` 更直白，
 * 而 `BOOK_EXT` 本来就是**唯一**那份格式清单。
 */
export function formatCounts(db: DatabaseSync): Array<{ format: string; n: number }> {
  const 列 = BOOK_EXT.map((e) => `sum(case when lower(fl.path) like '%.${e}' then 1 else 0 end) as "${e}"`);
  列.push("sum(case when fl.id is null then 1 else 0 end) as \"manual\"");
  const row = db.prepare(`select ${列.join(', ')} ${BOOK_JOIN}`).get() as Record<string, number>;
  return [...BOOK_EXT, 'manual']
    .map((f) => ({ format: f, n: Number(row[f] ?? 0) }))
    .filter((x) => x.n > 0);
}

export function countBooks(db: DatabaseSync, filter: Filter = {}): number {
  const { sql, params } = buildFilter(filter);
  return (
    db
      .prepare(
        `select count(distinct b.id) n ${BOOK_JOIN} where ${sql}`,
      )
      .get(...params) as { n: number }
  ).n;
}

/**
 * 侧栏各档的数量。**一条 group by 查回来**——把全部书拉到前端再数，
 * 在五千本的库上是一次几 MB 的 IPC。
 *
 * `scope` 是**当前生效的横向筛选**（现在只有目录）。选中一个目录之后，
 * 侧栏写「全部 8172」而列表只有 153 本，用户会以为列表坏了。
 *
 * ⚠️ 这里**必须走 `buildFilter`**，不能自己另写一套 SQL。原来就是自己写的，
 * 于是「需要处理」按 `f.status != 'ok'`（任意文件）数，而书架按
 * `fileStatus in (missing, parse_failed)`（主文件）筛——两边各自都说得通，
 * 数字对不上时谁也不知道哪个对。这正是本文件开头警告的那件事。
 */
/**
 * 「读过、可是还没写一句」——这个应用唯一的待办清单。
 *
 * **判据只此一份**：侧栏那一档（`shelfCounts`）、书架那一档（`App.tsx` 的 `SHELVES`）
 * 和 `/api/stats` 都引它。两份 SQL 说同一件事，改一处漏一处不会有任何报错——
 * 侧栏说 6 本、外部工具拿到 12 本，而谁也说不清哪个对（同 `ratedSql` 那条）。
 *
 * 两半缺一不可：光 `rated: false` 是整个书库（真实库 8171 本），
 * 那不是待办；「读过」的口径从 `TOUCHED_STATUS` 算，不在这儿另写一份。
 */
export const UNREVIEWED: Filter = { rated: false, readingStatus: TOUCHED_STATUS };

export function shelfCounts(db: DatabaseSync, scope: Filter = {}): ShelfCounts {
  const FROM = BOOK_JOIN;

  const count = (extra: Filter): number => {
    const { sql, params } = buildFilter({ ...scope, ...extra });
    return (
      db.prepare(`select count(distinct b.id) n ${FROM} where ${sql}`).get(...params) as {
        n: number;
      }
    ).n;
  };

  const byReading: Record<string, number> = {};
  {
    const { sql, params } = buildFilter(scope);
    for (const row of db
      .prepare(
        `select ifnull(r.status, 'none') as status, count(distinct b.id) as n
           ${FROM} where ${sql} group by 1`,
      )
      .all(...params) as unknown as Array<{ status: string; n: number }>) {
      byReading[row.status] = row.n;
    }
  }

  const byRating: Record<number, number> = {};
  {
    const { sql, params } = buildFilter(scope);
    const row = db
      .prepare(
        `select sum(case when rating >= 5 then 1 else 0 end) as r5,
                sum(case when rating >= 4 then 1 else 0 end) as r4,
                sum(case when rating >= 3 then 1 else 0 end) as r3
           from (select distinct b.id as id, ifnull(r.rating, -1) as rating
                   ${FROM} where ${sql})`,
      )
      .get(...params) as { r5: number | null; r4: number | null; r3: number | null };
    // 一行都没有时 sum() 给的是 null，不是 0
    byRating[5] = row.r5 ?? 0;
    byRating[4] = row.r4 ?? 0;
    byRating[3] = row.r3 ?? 0;
  }

  return {
    all: count({}),
    /*
     * ⚠️ **绕开 `count()`，因为那个闭包会把 `scope` 拌进去。**
     * 这一条要的正是「不看当前筛选，整个库有多少本」——写成 `count({})` 就又
     * 变回 `all` 了，而两者长得一模一样，看代码看不出来。
     * 屏蔽掉的书不算（`buildFilter` 默认 `excluded: 'hide'`）：用户屏蔽一个目录
     * 就是不想再看见它们，它们不该让一个空库看起来「有书」。
     */
    total: (() => {
      const { sql, params } = buildFilter({});
      return (db.prepare(`select count(distinct b.id) n ${FROM} where ${sql}`).get(...params) as {
        n: number;
      }).n;
    })(),
    byReading,
    byRating,
    // 「算问题的」那张清单只此一份，见 `labels.ts` 的 `PROBLEM_FILE_STATUS`——
    // 侧栏那一档和它的计数原来各写一份，加第四档时漏一处就会数不对
    problem: count({ fileStatus: PROBLEM_FILE_STATUS }),
    excluded: count({ excluded: 'only' }),
    rated: count({ rated: true }),
    noted: count({ hasNotes: true }),
    /*
     * **读过、可是还没写一句。** 这是这个应用唯一的待办清单：
     * 那几本书的结论此刻只在用户脑子里，而「下次不用再想这本我看过没」
     * 全靠它落到库里。真实库上量的：动过的 7 本，其中 6 本还没写——
     * 短得可以一次做完，正是待办该有的长度。
     *
     * 「读过」的口径从 `TOUCHED_STATUS` 算（整张阅读状态表去掉「未标记」和「想读」），
     * 不在这儿另写一份。
     */
    unreviewed: count(UNREVIEWED),
  };
}


export interface RepairReport {
  orphanBooks: number;
  missingPrimary: number;
  staleMissing: number;
  rootlessGone: number;
  /** 被屏蔽却标着「文件缺失」、但文件其实还在磁盘上的，恢复成 ok */
  wronglyMissing: number;
}

/**
 * 修一致性问题。目前两类：
 *
 * 1. **没有任何文件的书**。扫描过程被打断、或多版本合并的中间态会留下这种记录，
 *    它们在书架上点开就报错，纯属噪音。**只删没有阅读进度也没有书签的**——
 *    进度和书签是重扫恢复不了的，宁可留一条打不开的记录，也不能删掉它们。
 * 2. **有文件但没有主版本**。这种书读不了，因为读章节的查询都带 `is_primary = 1`。
 *    挑字数最多的那个当主版本。
 * 3. **内容还在别处的 `missing` 记录**。这种是扫描无论如何都修不好的：
 *    用户先把文件**复制**到新目录（扫描时旧路径还在，于是正确地按「完全重复」
 *    收成第二条记录），之后才在应用外把旧的那份删掉。扫描下次只能把旧记录标
 *    `missing`——它没法回溯地知道那两条其实是一回事。结果是「需要处理」永远挂着
 *    一个清不掉的数字，而界面还在劝用户「扫描一次」，重扫多少遍都没用。
 *    内容确实还在磁盘上（按 content_hash 找到并 `existsSync` 确认过），
 *    那条 missing 记录就只是残留，删掉。
 * 4. **不属于任何目录、文件也没了的记录**。`root.remove` 只把 `root_id` 置空、不删记录
 *    （怕丢阅读进度，这是对的），但这样一来**没有任何目录管得到它**：扫描永远遍历不到，
 *    连「文件缺失」都标不上，于是它在书架上装作一切正常，点开才报 ENOENT。
 *    文件确实不在了就删掉记录——没有任何流程能让它复活。
 */
export function repairLibrary(db: DatabaseSync): RepairReport {
  const report: RepairReport = {
    orphanBooks: 0, missingPrimary: 0, staleMissing: 0, rootlessGone: 0, wronglyMissing: 0,
  };

  db.exec('begin');
  try {
    // 被屏蔽却标着「文件缺失」的：扫描会跳过屏蔽的文件，于是它们每一轮都
    // 「没见到」，被误判为缺失。扫描那头已经修了（不再新标），但**已经标坏的
    // 不会自己好**——扫描根本不会再碰屏蔽的文件。实测这个库里有 759 条这样的记录，
    // 文件一个都没少。这里逐个确认文件真在磁盘上，再恢复成 ok
    const wrong = db
      .prepare("select id, path from book_file where status = 'missing' and ifnull(excluded, 0) = 1")
      .all() as unknown as Array<{ id: number; path: string }>;
    for (const f of wrong) {
      if (!existsSync(f.path)) continue; // 文件真没了，那它确实是缺失
      db.prepare("update book_file set status = 'ok' where id = ?").run(f.id);
      report.wronglyMissing++;
    }

    // 先清残留的 missing——清完可能有书变空，正好由下面的孤儿那一步收尾
    const stale = db
      .prepare(
        `select m.id, m.book_id, m.is_primary, s.path as alive
           from book_file m join book_file s
             on s.content_hash = m.content_hash and s.id != m.id and s.status = 'ok'
          where m.status = 'missing' and m.content_hash is not null`,
      )
      .all() as unknown as Array<{ id: number; book_id: number; is_primary: number; alive: string }>;

    for (const m of stale) {
      // 记录可能早就和磁盘脱节了，别光信 status='ok'
      if (!existsSync(m.alive)) continue;
      db.prepare('delete from book_file where id = ?').run(m.id);
      report.staleMissing++;
      if (m.is_primary === 1) {
        db.prepare(
          `update book_file set is_primary = 1 where id = (
             select id from book_file where book_id = ? order by ifnull(word_count,0) desc, id limit 1)`,
        ).run(m.book_id);
      }
    }

    // 不属于任何目录、文件也没了的：谁也管不到，删掉
    const rootless = db
      .prepare('select id, book_id, is_primary, path from book_file where root_id is null')
      .all() as unknown as Array<{ id: number; book_id: number; is_primary: number; path: string }>;

    for (const f of rootless) {
      if (existsSync(f.path)) continue; // 文件还在，留着——用户可能会把目录再加回来
      db.prepare('delete from book_file where id = ?').run(f.id);
      report.rootlessGone++;
      if (f.is_primary === 1) {
        db.prepare(
          `update book_file set is_primary = 1 where id = (
             select id from book_file where book_id = ? order by ifnull(word_count,0) desc, id limit 1)`,
        ).run(f.book_id);
      }
    }

    /*
     * ⚠ **「没有文件」不等于「没人要」——手工添的书本来就没有文件。**
     *
     * 这一步删的是「谁也管不到的孤儿记录」（`root.remove` 那节写着为什么要有它）。
     * 但 `manual.ts` 添的书**只往 `book` 表写一行，一个 `book_file` 都没有**，
     * 于是它们全部落进这个 not exists。当场量的（四本手工添的书，跑一次「整理数据库」）：
     *
     * | 这本书身上有什么 | 改之前 |
     * |---|---|
     * | 弃坑 +「第三卷开始注水，别看了」 | **删了** |
     * | 一个标签「想找的书」 | **删了**（`book_tag` 跟着 cascade） |
     * | 标了「想读」 | **删了** |
     * | 写了短评 | 留着 |
     *
     * 原来的判据只认「评分 / 短评 / 读到哪儿」，而这个应用的正事不止那两样：
     * **弃坑原因**是最能拦住重复阅读的一句话（`App.tsx` 把它排在短评前面就是这个理由），
     * **标签**是用户手打的分类，**「想读」**是他自己表的态。三样都重扫恢复不了，
     * 而按下去的是设置里那个叫「整理数据库」的按钮——听起来像是在打扫，
     * 不像是在删东西。
     *
     * 现在的判据：**表过态就算数**（`status != 'none'`，`none` 是扫描进来的默认值，
     * 那条迁移特意把假的「想读」清成了它，所以这个信号是可信的），
     * 加上标签、弃坑原因，和原来那几样。
     */
    const orphans = db
      .prepare(
        `select b.id from book b
          where not exists (select 1 from book_file f where f.book_id = b.id)
            and not exists (select 1 from bookmark k where k.book_id = b.id)
            and not exists (select 1 from highlight h where h.book_id = b.id)
            and not exists (select 1 from book_tag bt where bt.book_id = b.id)
            and not exists (
              select 1 from reading_state r where r.book_id = b.id
                and (ifnull(r.status, 'none') != 'none'
                     or r.chapter_idx > 0 or r.percent > 0 or r.rating is not null
                     or r.comment is not null or r.drop_reason is not null
                     or r.last_read_at is not null))
            -- PDF / EPUB 读到哪儿存在 app_setting 里（见 deletion.ts 那段），
            -- 上面那些 not exists 一个都看不见它
            and not exists (select 1 from app_setting s where s.key = 'viewer.' || b.id)
            -- 自建目录（迁移 24）也是用户手打的字，同样重扫恢复不了
            and not exists (select 1 from app_setting s where s.key = 'outline.' || b.id)`,
      )
      .all() as unknown as Array<{ id: number }>;
    for (const o of orphans) {
      db.prepare('delete from book where id = ?').run(o.id);
      report.orphanBooks++;
    }

    /*
     * 主版本不能用的书。**两种都收**：
     *   - 压根没有主版本（合并/删除的中间态）——这种书读不了，
     *     读章节的查询都带 `is_primary = 1`；
     *   - **主版本在，但它标着 missing / parse_failed，而旁边有一份好的**。
     *     后者是真实库上撞见的《乌纱》：磁盘上被删掉的那份恰好是主文件，
     *     卡片挂着「文件不见了」，而 `book.list` 的 `path` 取的就是主文件——
     *     **这本书打不开**，虽然另一份好好地在磁盘上。扫描那头已经修了
     *     （标 missing 时顺手换），但**已经坏掉的不会自己好**：那条记录
     *     早就是 missing，扫描不会再标它一次。
     *
     * 判据走 `primary.ts` 的 `ensurePrimary`——这条 SQL 原来在这个仓库里有四份。
     */
    const badPrimary = db
      .prepare(
        `select b.id from book b
          where exists (select 1 from book_file f where f.book_id = b.id)
            and not exists (
              select 1 from book_file f
               where f.book_id = b.id and f.is_primary = 1 and f.status = 'ok')`,
      )
      .all() as unknown as Array<{ id: number }>;
    for (const b of badPrimary) {
      if (ensurePrimary(db, b.id)) report.missingPrimary++;
    }

    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return report;
}

export interface DirNode {
  /** 相对根目录的路径，`/` 分隔。`''` = 根目录直属的文件 */
  dir: string;
  /** 这个目录**直接**放着多少本（不含子目录） */
  own: number;
  /** 连子目录一起数多少本 */
  total: number;
  depth: number;
}

/** 一条「这个目录里的书是什么连载状态」的规则 */
export interface SerialDirRule {
  /** 相对根目录的路径，`/` 分隔，和 `listDirs` 的 `dir` 同一口径 */
  dir: string;
  /** `ongoing` / `finished` / `abandoned` / `unknown`，和书籍编辑器里那四档一致 */
  status: string;
}

/**
 * 按目录批量设连载状态。
 *
 * 用户的书库本来就是按状态分目录放的（`未完` 82 本、其余 8090 本），
 * 那个信息一直摆在磁盘上没被用起来——全库 8171 本 `serial_status` 都是 `unknown`。
 *
 * **规则是数据不是常量**：目录名用户自己定，`未完` 只是他现在的叫法。
 * 没有规则命中的走 `fallback`（传 null 就是不动它们）。
 *
 * `onlyUnknown` 是给扫描用的：**只补新书，不覆盖用户手动改过的**。
 * 手动标成「太监」的书不该在下次扫描时被规则重设回「已完结」——
 * 这个仓库在 `setStatus` 上踩过「改 A 顺带写 B」的坑，同一类问题。
 *
 * **被屏蔽的书照样要设**（这里和 `listDirs` 口径**故意不同**）。屏蔽是
 * 「我平时不想看见」，不改变「这本书完没完结」这个事实；跟着那边滤掉的话，
 * 这个库里 759 本会静静地停在 `unknown`，而界面上完全看不出漏了谁。
 */
export function applySerialByDir(
  db: DatabaseSync,
  rules: SerialDirRule[],
  fallback: string | null,
  opts: { onlyUnknown?: boolean; dryRun?: boolean } = {},
): { changed: number; byStatus: Record<string, number> } {
  const rows = db
    .prepare(
      `select b.id, b.serial_status as cur, fl.path, r.path as root
         from book b
         join book_file fl on fl.book_id = b.id and fl.is_primary = 1
         join library_root r on r.id = fl.root_id
        where 1 = 1
          ${opts.onlyUnknown ? "and b.serial_status = 'unknown'" : ''}`,
    )
    .all() as unknown as Array<{ id: number; cur: string; path: string; root: string }>;

  // 长的先匹配：`Archive/实体书` 的规则要盖过 `Archive` 的
  const sorted = [...rules].sort((a, b) => b.dir.length - a.dir.length);
  const byStatus: Record<string, number> = {};
  const todo: Array<[string, number]> = [];

  for (const r of rows) {
    if (!r.path.startsWith(r.root)) continue;
    const rel = r.path.slice(r.root.length).replace(/^[\\/]+/, '');
    const parts = rel.split(/[\\/]/);
    parts.pop(); // 文件名
    const dir = parts.join('/');
    // 规则作用于整棵子树：`未完` 命中 `未完/2024`
    const hit = sorted.find((x) => x.dir === dir || (x.dir !== '' && dir.startsWith(`${x.dir}/`)));
    const next = hit ? hit.status : fallback;
    if (!next || next === r.cur) continue;
    byStatus[next] = (byStatus[next] ?? 0) + 1;
    todo.push([next, r.id]);
  }

  if (!opts.dryRun && todo.length > 0) {
    db.exec('begin');
    try {
      // prepare 提到循环外面：这里一次可能是八千本
      const up = db.prepare('update book set serial_status = ?, updated_at = datetime(\'now\') where id = ?');
      for (const [status, id] of todo) up.run(status, id);
      db.exec('commit');
    } catch (e) {
      db.exec('rollback');
      throw e;
    }
  }

  return { changed: todo.length, byStatus };
}

/**
 * 书库的目录树（用来做「只看某个目录」）。
 *
 * **不做成标签。** 目录是库里已有的事实，按它筛不需要新数据、不需要迁移，
 * 也不会因为文件移动而失效；派生成标签则两样都会出问题，还会往标签列表里塞噪音。
 *
 * 数目录走 SQL 的 group by，不要把八千本书拉回前端再数——同一个坑在书架计数上踩过。
 */
export function listDirs(db: DatabaseSync): DirNode[] {
  const rows = db
    .prepare(
      `select r.path as root, f.path as path
         from book_file f join library_root r on r.id = f.root_id
        where ifnull(f.status,'ok') != 'missing' and ifnull(f.excluded, 0) = 0`,
    )
    .all() as unknown as Array<{ root: string; path: string }>;

  const own = new Map<string, number>();
  for (const r of rows) {
    if (!r.path.startsWith(r.root)) continue;
    // 两种分隔符都要认：库里存的是 Windows 的反斜杠
    const rel = r.path.slice(r.root.length).replace(/^[\\/]+/, '');
    const parts = rel.split(/[\\/]/);
    parts.pop(); // 文件名
    const dir = parts.join('/');
    own.set(dir, (own.get(dir) ?? 0) + 1);
  }

  // 只出现在中间的目录（自己不直接放书）也要有节点，否则树是断的
  const all = new Set(own.keys());
  for (const d of [...all]) {
    const parts = d.split('/');
    for (let i = 1; i < parts.length; i++) all.add(parts.slice(0, i).join('/'));
  }

  const nodes = [...all].map((dir) => ({
    dir,
    own: own.get(dir) ?? 0,
    total: [...own].reduce(
      (n, [d, c]) => (d === dir || (dir !== '' && d.startsWith(`${dir}/`)) ? n + c : n),
      0,
    ),
    depth: dir === '' ? 0 : dir.split('/').length,
  }));

  return nodes.sort((a, b) => a.dir.localeCompare(b.dir, 'zh'));
}
