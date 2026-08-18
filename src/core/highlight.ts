// 划线与笔记（spec §5.1）。
//
// **位置用「章号 + 章内字符偏移 + 长度」存，不存正文。** 存正文就等于把
// 「不存正文」那条原则破一个口子，而且清洗规则一改，存下来的那份就和显示的对不上了。
//
// 代价是重新解析（追更、换章节规则）之后位置可能漂移。所以顺手存一小段 `excerpt`：
// 它不是正文缓存，是**用来核对的锚**——渲染时先看那个位置的文字还是不是它，
// 不是就说明漂了，界面照实标出来而不是把高亮画到别的句子上。

import type { DatabaseSync } from 'node:sqlite';
// 标签名的规矩只此一份（长度上限、去重、拆逗号）——不在这里再写一遍
import { splitTagNames, tagIdFor } from './library.ts';

export const COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
export type HighlightColor = (typeof COLORS)[number];

/**
 * 颜色**默认**叫什么。
 *
 * ⚠️ **这几个名字原来在渲染进程里抄了三份**——`HighlightsPanel` 的 `色名`、
 * `FileViewer` 的 `颜色名`，而 `Reader` 那份连名字都没有（四个圆点的 title
 * 都是同一句「用这个颜色划线」）。同 `labels.ts` 顶上说的那个病，正本挪到这儿。
 *
 * 而且这几个名字**是给用户改的**：GoodNotes 和 MarginNote 都把「这个颜色代表什么」
 * 交给用户自己定（黄＝好句、蓝＝待查、绿＝人物关系）。颜色不写明用途，
 * 那套分类等于只写给自己看——隔一个月回来，自己也不记得蓝色当初是什么意思。
 * 改过的名字存在 `app_setting` 的 `highlight.colorNames`，见下面 `colorNames`。
 */
export const COLOR_NAMES: Record<HighlightColor, string> = {
  yellow: '黄', green: '绿', blue: '蓝', pink: '粉',
};

/** 用户改过的颜色用途存在这个键下 */
export const COLOR_NAMES_KEY = 'highlight.colorNames';

/**
 * 每种颜色现在叫什么：用户改过的盖在默认名上。
 *
 * 库里那一行**什么都可能是**（老备份、外部工具经 rpc 写的），所以逐个校验：
 * 认不出的键丢掉，空字符串退回默认名——一个没有名字的颜色在界面上就是个
 * 没法称呼的圆点，对读屏更是四个一模一样的「按钮」。
 */
export function colorNames(db: DatabaseSync): Record<HighlightColor, string> {
  const out = { ...COLOR_NAMES };
  const row = db.prepare('select value from app_setting where key = ?').get(COLOR_NAMES_KEY) as
    | { value: string }
    | undefined;
  if (!row) return out;
  let 存的: unknown;
  try {
    存的 = JSON.parse(row.value);
  } catch {
    return out;               // 存坏了就当没改过，不要让一行烂 JSON 把界面卡住
  }
  if (!存的 || typeof 存的 !== 'object') return out;
  for (const c of COLORS) {
    const v = (存的 as Record<string, unknown>)[c];
    if (typeof v === 'string' && v.trim()) out[c] = v.trim().slice(0, 12);
  }
  return out;
}

/**
 * 改颜色的用途。传进来的是**整份**，没提到的颜色退回默认名。
 *
 * 名字掐在 12 个字：它要塞进阅读界面那一排色块的标签里，再长就把那行挤断了。
 * 和默认名一样的不存——库里只留用户真的改过的那几条，
 * 免得以后想改默认名时被一堆「黄」「绿」挡住。
 */
export function setColorNames(db: DatabaseSync, names: Record<string, unknown>): void {
  const 存: Record<string, string> = {};
  for (const c of COLORS) {
    const v = names[c];
    if (typeof v !== 'string') continue;
    const t = v.trim().slice(0, 12);
    if (t && t !== COLOR_NAMES[c]) 存[c] = t;
  }
  if (Object.keys(存).length === 0) {
    db.prepare('delete from app_setting where key = ?').run(COLOR_NAMES_KEY);
    return;
  }
  db.prepare(
    'insert into app_setting(key, value) values(?, ?) on conflict(key) do update set value = excluded.value',
  ).run(COLOR_NAMES_KEY, JSON.stringify(存));
}

export interface Highlight {
  id: number;
  book_id: number;
  chapter_idx: number;
  char_offset: number;
  /** EPUB 的锚点：一条 CFI range。txt 的划线这一列是 null，走偏移那条路 */
  cfi?: string | null;
  /**
   * **PDF 的矩形摘录**：`"x,y,w,h"`，四个 0–1 的数，相对于 `chapter_idx` 那一页。
   * 只有框选出来的那种有它；文字划线这一列是 null。
   */
  rect?: string | null;
  length: number;
  excerpt: string;
  note: string | null;
  color: string;
  created_at: string;
}

/** 摘录存这么长就够核对了，再长就成正文缓存了 */
const MAX_EXCERPT = 200;

/**
 * 把 `rect` 那一列解成四个数。**认不出来回 `null`——不猜。**
 *
 * 存的是归一化坐标（相对那一页，0–1），所以四个数都得在 [0,1] 里、
 * 宽高还得大于 0。超出去的一律当认不出来：**夹回去会画出一个位置不对的框**，
 * 而那比「这条画不出来」更糟（判据同 `pdf-text.ts` 的 `造Range`）。
 *
 * **这一份只此一份**：写库前校验、画的时候转百分比、导出时写位置，都走它。
 */
export function 解析矩形(s: string | null | undefined): { x: number; y: number; w: number; h: number } | null {
  const n = (s ?? '').split(',').map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) return null;
  const [x, y, w, h] = n;
  if (w <= 0 || h <= 0) return null;
  if (x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  return { x, y, w, h };
}

export function addHighlight(
  db: DatabaseSync,
  h: {
    bookId: number;
    chapterIdx: number;
    charOffset: number;
    length: number;
    excerpt: string;
    note?: string;
    color?: HighlightColor;
    /**
     * **EPUB 的锚点**：一条 CFI range（`epubcfi(/6/6!/4/4,/1:2,/1:12)`）。
     *
     * txt 那条路一个字都不改——它的锚是 `chapter_idx + char_offset + length`，
     * 也就是按字节偏移读正文那一整套的产物，而 EPUB 根本没有那个字节流。
     * 有 `cfi` 的行按 cfi 还原，没有的按偏移对，判据只在 `resolve` 里分这一次岔。
     *
     * ⚠️ 有 `cfi` 时 `charOffset` / `length` 是**占位**（0 和选中的字数），
     * 它们对 EPUB 没有意义——但 `length > 0` 那条校验还得过，
     * 所以传的是选中文字的长度，不是 0。
     */
    cfi?: string;
    /**
     * **PDF 的矩形摘录**：`"x,y,w,h"`，四个 0–1 的数。
     *
     * 扫描页 / 插图 / 公式那些没有文字层的页靠它做笔记。
     * ⚠️ 有 `rect` 时 `charOffset` / `length` 是**占位**（同 `cfi` 那一条），
     * 但 `length > 0` 那条校验还得过，所以传 1。
     */
    rect?: string;
  },
): { id: number } {
  if (h.length <= 0) throw new Error('划线长度必须大于 0');
  if (h.rect !== undefined && !解析矩形(h.rect)) {
    throw new Error(`认不出来的框选范围：${h.rect}`);
  }
  if (h.charOffset < 0) throw new Error('偏移量不能是负数');
  const color = h.color && COLORS.includes(h.color) ? h.color : 'yellow';

  const id = Number(
    db
      .prepare(
        `insert into highlight(book_id, chapter_idx, char_offset, length, excerpt, note, color, cfi, rect)
         values(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        h.bookId,
        h.chapterIdx,
        h.charOffset,
        h.length,
        h.excerpt.slice(0, MAX_EXCERPT),
        h.note?.trim() || null,  // 只有空白的当作没写，同 `updateNote`
        color,
        h.cfi?.trim() || null,
        h.rect?.trim() || null,
      ).lastInsertRowid,
  );
  return { id };
}

export function listHighlights(db: DatabaseSync, bookId?: number, chapterIdx?: number): Highlight[] {
  if (bookId === undefined) {
    return db
      .prepare('select * from highlight order by book_id, chapter_idx, char_offset')
      .all() as unknown as Highlight[];
  }
  if (chapterIdx === undefined) {
    return db
      .prepare('select * from highlight where book_id = ? order by chapter_idx, char_offset')
      .all(bookId) as unknown as Highlight[];
  }
  return db
    .prepare('select * from highlight where book_id = ? and chapter_idx = ? order by char_offset')
    .all(bookId, chapterIdx) as unknown as Highlight[];
}

/**
 * 改一条划线上的笔记。**只有空白的当作没写**（`trim()` 认全角空格和换行）。
 *
 * 不这么做的话，一个手滑的空格会让这条划线变成「带笔记的」：
 * `notesOf` 只滤 `note != ''`，于是全库笔记列表里多出一条空的；
 * 而阅读器里点这条划线会**先摆出笔记**（那是有意的：带笔记的不能一点就删），
 * 摆出来却是空的，删按钮藏在那个空框里。
 *
 * 同 `status.ts` 里短评那条——都是用户打的字，判据要一致。
 */
export function updateNote(db: DatabaseSync, id: number, note: string | null): void {
  db.prepare('update highlight set note = ? where id = ?').run(note?.trim() || null, id);
}

/**
 * 改一条划线的颜色。
 *
 * ⚠️ **认不出的颜色一律报错，不像 `addHighlight` 那样退回黄色。**
 * 两者的处境不一样：新建时兜底是「给它一个默认」，
 * 而改色时用户**明确点了一种颜色**——把它悄悄换成黄的是擅自改变用户看到的东西
 * （同 `convert.ts` 那条：认不出的模式一律当原文，绝不猜）。
 * 而且改色这条路对外开放（§13 的 rpc），外部工具传错了该当场知道。
 *
 * ⚠️ **id 不存在也要报错。** 一句 `update` 影响 0 行照样是「成功」，
 * 这是 `tag.delete` 那次事故的形状（判据在下面 `removeHighlight` 上面）。
 */
export function setColor(db: DatabaseSync, id: number, color: string): void {
  if (!COLORS.includes(color as HighlightColor)) {
    throw new Error(`认不出这个颜色：${color}。只有 ${COLORS.join(' / ')}`);
  }
  const r = db.prepare('update highlight set color = ? where id = ?').run(color, id);
  if (Number(r.changes) === 0) throw new Error(`没有这条划线：${id}`);
}

/*
 * **带笔记的划线，删之前要确认一次。**
 *
 * 笔记是用户打的字，铁律 3 里重扫恢复不了的那几样之一——而这条路原来
 * 一道闸都没有：一句 `delete`，返回 void，**id 写错也照样报成功**
 * （`tag.delete` 那次事故的形状）。
 *
 * 界面上带笔记的划线点一下会**先把笔记摆出来**，删是里面写明白的按钮；
 * 而 rpc 对外开放（§13），外部工具一句 `highlight.remove` 就能悄悄删掉。
 * **安全阀不能只活在界面里**——同 `tag.delete` / `root.remove` 那两条。
 *
 * 判据和那两条一致：**只有真会丢东西的才拦**。没写笔记的划线就是一段颜色，
 * 重新划一次就有，拦它只会让人烦。
 */
export function removeHighlight(
  db: DatabaseSync,
  id: number,
  opts: { confirmed?: boolean } = {},
): { removed: number } {
  const row = db.prepare('select note from highlight where id = ?').get(id) as
    | { note: string | null }
    | undefined;
  if (!row) return { removed: 0 };
  const note = (row.note ?? '').trim();
  if (note && !opts.confirmed) throw new Error(noteGuard('划线', note));
  return { removed: db.prepare('delete from highlight where id = ?').run(id).changes as number };
}

/**
 * 拦下来的那句话要**同时对两种人说得通**：在界面上看到它的人，和走接口的人。
 * 「说了怎么办」才是判据（同 `reader.ts` 的 `openHint`）。
 */
export function noteGuard(what: string, note: string): string {
  const s = note.length > 24 ? note.slice(0, 24) + '…' : note;
  return `这条${what}上写着笔记「${s}」，删了就没了（重新扫描也恢复不回来）。要删的话去阅读器右边的「书签划线」里删，那里看得见笔记本身；走接口的话带上 confirmed: true 再发一次。`;
}

export interface ResolvedHighlight extends Highlight {
  /** 那个位置的文字还是不是当初划的那段 */
  intact: boolean;
}

/**
 * 把某一章的划线对到当前正文上，并核对有没有漂移。
 *
 * 漂了**不猜也不删**：只标 `intact: false`，由界面照实说明。
 * 自动去别处找一遍看似贴心，但认错位置比不认更糟——用户会以为自己当初划的就是那句。
 */
export function resolveForChapter(
  db: DatabaseSync,
  bookId: number,
  chapterIdx: number,
  text: string,
): ResolvedHighlight[] {
  return listHighlights(db, bookId, chapterIdx).map((h) => ({
    ...h,
    /*
     * ⚠️ **带 `cfi` 的那些不走这条判据。**
     *
     * 它们是 EPUB 的划线，锚是一条 CFI range，而 `text` 这一路是
     * 「按字节偏移读 txt」那一整套的产物——拿 `char_offset` 去切一段
     * **和这本书毫无关系的字符串**，结果必然对不上，于是每一条都会被标成「漂了」。
     * 那时候界面会说一句「这条划线漂了」，而它其实好好的。
     *
     * 对 EPUB 来说「漂没漂」只有把 CFI 还原成 Range 才知道，
     * 而那件事只有渲染进程做得了（要那个 iframe）。所以这里一律当好的，
     * 由查看器那边还原不出来时自己说。
     */
    intact: h.cfi
      ? true
      : text.slice(h.char_offset, h.char_offset + h.length) === h.excerpt.slice(0, h.length),
  }));
}

/**
 * **把漂了的划线重新对上。**
 *
 * 漂移一直是个死路：正文变过（换章节规则、开关净化、切繁简）之后，
 * 那条划线画不出来了，界面照实说一句「对不上原文了」——**然后就没有然后了**。
 * 笔记还在，可它指着的那句话在哪儿，谁也不知道。这是铁律 3 的数据变成废纸的一条路。
 *
 * 而修它其实不用猜：`excerpt` 当初就是**按原样存下来当锚**的。
 * 正文只是整体挪了位置，那段字多半还在这一章里——在新正文里找一遍就有了。
 *
 * ⚠️ **只在「不多不少正好一处」时才改，别的一律不动。**
 * 找到两处以上说明这段字在这一章里出现了多次（「他笑了笑。」这种短句很常见），
 * 挑哪一处都是猜——而猜错的后果是**把笔记贴到另一句话上**，
 * 比「画不出来」难看得多，而且用户看不出来。一处都没有就是真没了，同理不动。
 * 这条判据和 `chapter.ts` 那句「章节数变多不等于切对了」是同一族：
 * **能动手不等于该动手**。
 *
 * ⚠️ **带 `cfi` 的一条都不碰**：那是 EPUB 的锚，`char_offset` 是占位，
 * 在这套「按字符偏移」的逻辑里它没有意义（同 `resolveForChapter` 那段）。
 */
export function reanchor(
  db: DatabaseSync,
  bookId: number,
  chapterIdx: number,
  text: string,
  /**
   * 按这本书**当前的繁简模式**转一遍。给了的话，原样找不到时会拿转过的再找一次。
   *
   * ⚠️ **传函数进来，不在这个文件里 import `convert.ts`。**
   * 那个模块带着 opencc（本仓库唯一的运行时依赖），而这个文件**渲染进程也在引**
   * （`COLORS` / `COLOR_NAMES` / `HighlightColor`）——一 import 就把 opencc
   * 整个拖进渲染包，AGENTS.md 明确写着别这么干。
   *
   * 为什么需要它：正文是**运行时**转的，而 `excerpt` 是当初划下来那一刻的字形。
   * 用户在简体下划了线、后来切成繁体读，正文成了繁体、摘录还是简体，
   * 那条划线就永远找不回来——而切繁简是阅读设置里一个键的事。
   */
  转?: (s: string) => string,
): { fixed: number; ambiguous: number; gone: number } {
  const out = { fixed: 0, ambiguous: 0, gone: 0 };
  for (const h of resolveForChapter(db, bookId, chapterIdx, text)) {
    if (h.intact || h.cfi) continue;
    const 原锚 = h.excerpt.slice(0, h.length);
    if (!原锚) { out.gone++; continue; }
    // 先按原样找；找不到再拿转过的找一次。**转过的也要照样守「正好一处」那条**
    const 候选 = [原锚];
    const 转过 = 转?.(原锚);
    if (转过 && 转过 !== 原锚) 候选.push(转过);

    let 命中 = -1;
    let 歧义 = false;
    for (const 锚 of 候选) {
      const 头 = text.indexOf(锚);
      if (头 < 0) continue;
      if (text.indexOf(锚, 头 + 1) >= 0) { 歧义 = true; continue; }
      命中 = 头;
      /*
       * 找回来的时候**把 excerpt 也换成当前这一版的字形**。
       * 不换的话下次打开又是「对不上」——`intact` 比的就是它。
       * 这不算改用户的东西：`excerpt` 是**核对用的锚**，不是用户写的字
       * （用户写的是 `note`，那一列一个字都不动）。判据在本文件顶上。
       */
      if (锚 !== 原锚) {
        db.prepare('update highlight set excerpt = ?, length = ? where id = ?').run(锚, 锚.length, h.id);
      }
      break;
    }
    if (命中 < 0) { 歧义 ? out.ambiguous++ : out.gone++; continue; }
    db.prepare('update highlight set char_offset = ? where id = ?').run(命中, h.id);
    out.fixed++;
  }
  return out;
}

/** 笔记面板：只列写了笔记的那些（spec §5.1 的「笔记面板中汇总查看」） */
/**
 * **哪几章有笔记**，以及各有几条。给目录用。
 *
 * 起因是个走不通的方向：笔记面板能从笔记找到章，**反过来不行**——
 * 翻着目录看不出自己在哪一章划过线、哪一章夹过书签。
 * GoodNotes 的侧栏把有批注的页标出来，就是这件事
 * （`docs/reference/goodnotes/` 里「Viewing, Searching, & Navigating」那一节）。
 * ⚠️ 那批文件名**带空格**，别在注释里写全名——`stale-refs` 只认得出最后一段，
 * 会把它当成一个叫 <!-- stale-refs:off -->`Documents.md`<!-- stale-refs:on --> 的文件报缺失。指到目录就够了。
 *
 * ⚠️ **必须是分组计数，不能把划线全查出来在外面数。**
 * 这个库里有 12058 章的书，重度用户的划线也是几千条起——
 * 而「有笔记的章」永远是**很小的一撮**，让 sqlite 去分组，回来的行数
 * 就是那一撮的大小。目录本来就是这个应用里最容易卡的地方
 * （全铺开排版要 482ms，所以才开的窗口），别在它头上再挂一个 O(划线数)。
 *
 * 顺手把书签也带上：对着目录的人问的是「这一章我留过东西没有」，
 * 划线和书签在那个问题里是一回事，让界面查两次是白费。
 * 所以这个函数**同时读 `bookmark`**——它在 `status.ts` 名下，
 * 但那边没有「按章汇总」这个需求，为它单开一个函数反而要在界面上合并两份结果。
 */
export function notedChapters(
  db: DatabaseSync,
  bookId: number,
): Record<number, { h: number; b: number }> {
  const out: Record<number, { h: number; b: number }> = {};
  const 收 = (表: 'highlight' | 'bookmark', 键: 'h' | 'b') => {
    const rows = db
      .prepare(`select chapter_idx as idx, count(*) as n from ${表} where book_id = ? group by chapter_idx`)
      .all(bookId) as unknown as Array<{ idx: number; n: number }>;
    for (const r of rows) {
      const 格 = (out[r.idx] ??= { h: 0, b: 0 });
      格[键] = r.n;
    }
  };
  收('highlight', 'h');
  收('bookmark', 'b');
  return out;
}

export function notesOf(db: DatabaseSync, bookId?: number): unknown[] {
  /*
   * ⚠️ **书签上的笔记也是笔记。**
   *
   * 这里原来只查 `highlight`——而书签**也能写笔记**（`bookmark.setNote`，
   * 面板里那个行内笔记框划线和书签共用一份）。于是「全库笔记」把它们全漏了：
   * 一本书可以在书架上挂着「记过笔记」和 `✎ 3`（那两处按 `hasNotesSql` /
   * `note_count` 算，**是把书签算进去的**），点开「我的笔记」却一条都没有。
   *
   * 这正是铁律 3 那条改过的判据要问的：新开一处存用户输入的地方，
   * 要问的不是「它进没进那张表」，而是**「谁在靠原来那个位置取数」**。
   * `bookmark.note` 加进来的时候，这个取数的地方没跟上。
   *
   * ⚠️ **`id` 在两张表里会重号。** 界面拿它当 React key，
   * 划线 7 和书签 7 撞在一起就是一条静默消失——所以带上 `kind` 一起给出去。
   */
  const 条件 = (别名: string) =>
    `where ${别名}.note is not null and ${别名}.note != ''`
    + (bookId === undefined ? '' : ` and ${别名}.book_id = ?`);
  const sql = `select h.id, h.book_id as bookId, b.title, h.chapter_idx as chapterIdx,
                      h.char_offset as charOffset, h.excerpt, h.note, h.color,
                      h.created_at as createdAt, h.rect, 'highlight' as kind
                 from highlight h join book b on b.id = h.book_id
                ${条件('h')}
                union all
               select k.id, k.book_id, b.title, k.chapter_idx,
                      k.char_offset, k.excerpt, k.note, null,
                      -- 书签没有 rect（那是 PDF 框选的位置）。
                      -- ⚠️ 列数必须对齐：union all 按位置对，少一列就整个错位
                      k.created_at, null, 'bookmark'
                 from bookmark k join book b on b.id = k.book_id
                ${条件('k')}
                order by bookId, chapterIdx, charOffset`;
  // 两半各要一个参数——`union all` 的占位符是按整条语句从左到右数的
  const rows = (bookId === undefined ? db.prepare(sql).all() : db.prepare(sql).all(bookId, bookId)) as
    unknown as Array<{ id: number; kind: string; tags?: string[] }>;
  /*
   * **标签一次查完再贴回去**，不每行一句 SQL（同 `tagsOfHighlights` 上面那条）。
   * ⚠️ **只有划线有标签**：书签那半没有这张关系表，
   * 而两边的 `id` 会重号——不按 `kind` 分开就会把划线 7 的标签贴到书签 7 上，
   * 而且不报错（同这个函数上面那条「带着 kind 一起给出去」）。
   */
  const 标 = tagsOfHighlights(db, rows.filter((r) => r.kind === 'highlight').map((r) => r.id));
  for (const r of rows) r.tags = r.kind === 'highlight' ? (标[r.id] ?? []) : [];
  return rows;
}

/*
 * ── 笔记的标签 ──────────────────────────────
 *
 * 颜色只有四个，而「这条是什么」本来就是两维。
 * **复用 `tag` 表**（与书的标签同一份词表），名字的规矩走 `splitTagNames`——
 * 长度上限、去重、拆逗号，一条都不另写。
 */

/** 给几条划线打标签。回真的打上去几条（已经有的不算，同 `tagBooks`） */
export function tagHighlights(
  db: DatabaseSync,
  ids: number[],
  names: string[],
): { tagged: number } {
  let tagged = 0;
  const idOf = tagIdFor(db);
  db.exec('begin');
  try {
    for (const name of splitTagNames(names)) {
      const tagId = idOf(name).id;
      for (const id of ids) {
        if (db.prepare('insert or ignore into highlight_tag(highlight_id, tag_id) values(?, ?)')
          .run(id, tagId).changes > 0) tagged++;
      }
    }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return { tagged };
}

/** 摘一个标签。**不删 `tag` 本身**——那是标签管理器的事 */
export function untagHighlights(db: DatabaseSync, ids: number[], tagId: number): void {
  for (const id of ids) {
    db.prepare('delete from highlight_tag where highlight_id = ? and tag_id = ?').run(id, tagId);
  }
}

/**
 * 这几条各自有哪些标签。
 *
 * ⚠️ **一次查完，不要每条一句 SQL。** 全库笔记那一档一屏 300 行，
 * 每行一句就是 300 句——目录那边量到 543ms 就开了窗口，这里同理。
 */
export function tagsOfHighlights(db: DatabaseSync, ids: number[]): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  if (ids.length === 0) return out;
  /*
   * ⚠️ **分批发：一条 id 一个占位符，而 sqlite 的上限是 32766。**
   *
   * 超过就是 `too many SQL variables` **硬抛**，而这一句是打开「我的笔记」
   * 的必经之路——一个记得多的人会发现那个面板直接打不开。
   * 这个库量过 8800 条带笔记的划线，离上限不远，而它只会涨。
   * （当场量的：32766 个占位符过得去，32767 就报错。）
   */
  const 批 = 20000;
  for (let i = 0; i < ids.length; i += 批) {
    const 这批 = ids.slice(i, i + 批);
    const rows = db
      .prepare(
        `select ht.highlight_id as id, t.name from highlight_tag ht
           join tag t on t.id = ht.tag_id
          where ht.highlight_id in (${这批.map(() => '?').join(',')})
          order by t.name`,
      )
      .all(...这批) as unknown as Array<{ id: number; name: string }>;
    for (const r of rows) (out[r.id] ??= []).push(r.name);
  }
  return out;
}
