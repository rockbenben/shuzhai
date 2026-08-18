import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import {
  addHighlight,
  listHighlights,
  updateNote,
  removeHighlight,
  resolveForChapter,
  notesOf,
  setColor,
  colorNames,
  setColorNames,
  COLOR_NAMES,
  COLOR_NAMES_KEY,
  notedChapters,
  reanchor,
  解析矩形,
  tagHighlights,
  tagsOfHighlights,
} from './highlight.ts';

let dir: string;
let db: DatabaseSync;
let bookId: number;

/** 那条划线上的笔记 */
const noteOf = (id: number) =>
  (db.prepare('select note from highlight where id = ?').get(id) as { note: string | null }).note;

const TEXT = '少年提剑出门，风雪满衣。他在客栈里遇到了旧识，两人相视一笑。';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-hl-'));
  db = openDb(join(dir, 'library.db'));
  bookId = Number(db.prepare("insert into book(title) values('测试书')").run().lastInsertRowid);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 按文本里的一段话造划线，偏移量从文本里现算，避免手写数字算错 */
function highlightOf(phrase: string, note?: string) {
  const at = TEXT.indexOf(phrase);
  assert.ok(at >= 0, `测试文本里没有「${phrase}」`);
  return addHighlight(db, {
    bookId,
    chapterIdx: 0,
    charOffset: at,
    length: phrase.length,
    excerpt: phrase,
    note,
  });
}

test('划线存的是位置和一小段摘录，不是正文', () => {
  highlightOf('风雪满衣');
  const h = listHighlights(db, bookId)[0];

  assert.equal(h.char_offset, TEXT.indexOf('风雪满衣'));
  assert.equal(h.length, 4);
  assert.equal(h.excerpt, '风雪满衣');
  assert.ok(h.excerpt.length < TEXT.length, '摘录是用来核对的锚，不是正文缓存');
});

test('长度和偏移的合法性', () => {
  assert.throws(
    () => addHighlight(db, { bookId, chapterIdx: 0, charOffset: 0, length: 0, excerpt: '' }),
    /长度必须大于 0/,
  );
  assert.throws(
    () => addHighlight(db, { bookId, chapterIdx: 0, charOffset: -1, length: 2, excerpt: 'x' }),
    /不能是负数/,
  );
});

test('摘录会被截断，不让它变成正文缓存', () => {
  const long = '字'.repeat(500);
  addHighlight(db, { bookId, chapterIdx: 0, charOffset: 0, length: 500, excerpt: long });
  assert.equal(listHighlights(db, bookId)[0].excerpt.length, 200);
});

test('位置没漂时标 intact', () => {
  highlightOf('客栈里');
  const [h] = resolveForChapter(db, bookId, 0, TEXT);
  assert.equal(h.intact, true);
});

test('正文变了导致位置漂移时，如实标出来而不是去别处找', () => {
  highlightOf('客栈里');
  // 模拟追更后重新解析：正文前面插了一句，偏移量整体后移
  const shifted = '这是新加的一句。' + TEXT;
  const [h] = resolveForChapter(db, bookId, 0, shifted);

  assert.equal(h.intact, false, '位置对不上了');
  assert.equal(h.excerpt, '客栈里', '原文摘录还在，界面据此告诉用户划的是哪句');
  assert.equal(
    listHighlights(db, bookId).length,
    1,
    '漂了也不能自动删——认错位置比不认更糟，用户会以为当初划的就是那句',
  );
});

test('笔记增删改', () => {
  const { id } = highlightOf('风雪满衣');
  assert.equal(listHighlights(db, bookId)[0].note, null);

  updateNote(db, id, '这句好');
  assert.equal(listHighlights(db, bookId)[0].note, '这句好');

  updateNote(db, id, null);
  assert.equal(listHighlights(db, bookId)[0].note, null);

  removeHighlight(db, id);
  assert.equal(listHighlights(db, bookId).length, 0);
});

test('笔记面板只列写了笔记的', () => {
  highlightOf('风雪满衣');
  highlightOf('客栈里', '这里有个伏笔');
  highlightOf('相视一笑', '');

  const notes = notesOf(db, bookId) as Array<{ note: string; title: string }>;
  assert.equal(notes.length, 1, '没写笔记的划线不该混进笔记面板');
  assert.equal(notes[0].note, '这里有个伏笔');
  assert.equal(notes[0].title, '测试书', '要带上书名，跨书汇总时才认得出');
});

test('按章过滤', () => {
  addHighlight(db, { bookId, chapterIdx: 0, charOffset: 0, length: 2, excerpt: '少年' });
  addHighlight(db, { bookId, chapterIdx: 3, charOffset: 0, length: 2, excerpt: '后面' });

  assert.equal(listHighlights(db, bookId).length, 2);
  assert.equal(listHighlights(db, bookId, 0).length, 1);
  assert.equal(listHighlights(db, bookId, 3).length, 1);
  assert.equal(listHighlights(db, bookId, 9).length, 0);
});

test('颜色只认白名单里的', () => {
  addHighlight(db, {
    bookId, chapterIdx: 0, charOffset: 0, length: 2, excerpt: '少年',
    color: 'rainbow' as never,
  });
  assert.equal(listHighlights(db, bookId)[0].color, 'yellow', '不认识的颜色回落到默认');
});

test('删书会连带删掉划线', () => {
  highlightOf('风雪满衣', '笔记');
  db.prepare('delete from book where id = ?').run(bookId);
  assert.equal(listHighlights(db).length, 0);
});

/*
 * **只有空白的笔记＝没写。** 同 `status.ts` 里短评那条——都是用户打的字。
 *
 * 不挡的话，一个手滑的空格会让这条划线变成「带笔记的」：
 * `notesOf` 只滤 `note != ''`，全库笔记列表里于是多出一条空的；
 * 而阅读器里点带笔记的划线会**先摆出笔记**（有意的：带笔记的不能一点就删），
 * 摆出来却是空的。
 */
test('只有空白的笔记当作没写，真笔记前后的空格要去掉', () => {
  const id = addHighlight(db, {
    bookId, chapterIdx: 0, charOffset: 0, length: 4, excerpt: '一段正文',
  }).id;

  updateNote(db, id, '   ');
  assert.equal(noteOf(id), null, '空格不该变成一条笔记');
  assert.equal(notesOf(db).length, 0, '全库笔记列表里也不该有它');

  updateNote(db, id, '  这段写得好  ');
  assert.equal(noteOf(id), '这段写得好', '前后空格要去掉');
  assert.equal(notesOf(db).length, 1);

  // 新建的时候也一样
  const blank = addHighlight(db, {
    bookId, chapterIdx: 0, charOffset: 8, length: 4, excerpt: '另一段', note: '\n ',
  }).id;
  assert.equal(noteOf(blank), null);
});


/*
 * **安全阀不能只活在界面里**——这一族已经清过一轮（`rename.apply` /
 * `tag.rename` / `tag.delete` / `root.remove`），而当时那张表**漏了这一条**：
 * `highlight.remove` 一道闸都没有，返回 void，id 写错也照样报成功。
 * 划线上的笔记是铁律 3 里重扫恢复不了的数据，比标签还硬——
 * 删标签好歹只是分类没了，这个删的是用户自己写的话。
 */
test('带笔记的划线，不带 confirmed 删不掉，而且那条笔记一个字没少', () => {
  const { id } = highlightOf('风雪满衣', '这段写得好');
  assert.throws(() => removeHighlight(db, id), /写着笔记/);

  const left = listHighlights(db, bookId);
  assert.equal(left.length, 1, '被拦下来了，划线却已经没了——那是最糟的失败');
  assert.equal(left[0].note, '这段写得好');

  assert.deepEqual(removeHighlight(db, id, { confirmed: true }), { removed: 1 });
  assert.equal(listHighlights(db, bookId).length, 0);
});

test('没写笔记的划线照删不误——闸只拦真会丢东西的', () => {
  const { id } = highlightOf('风雪满衣');
  assert.deepEqual(removeHighlight(db, id), { removed: 1 });
  assert.equal(listHighlights(db, bookId).length, 0);
});

/** id 写错原来一声不吭地「成功」了，同 `tag.delete` 那次事故 */
test('删一个不存在的划线，报出来的是 removed: 0，不是成功', () => {
  assert.deepEqual(removeHighlight(db, 99999), { removed: 0 });
});

test('EPUB 的划线用 CFI 当锚，不走字节偏移那条路', () => {
  /*
   * 起因：用户说「划线也能做吧，我看其他项目也有的」——对，能做。
   * 原来那条锚（`chapter_idx + char_offset + length`）是**按字节偏移读 txt**
   * 那一整套的产物，而 EPUB 根本没有那个字节流。
   * epub.js 自带的那套是 CFI range，从选区算得出来、也能一字不差还原回 Range
   * （当场量过）。
   */
  const cfi = 'epubcfi(/6/6!/4/4,/1:2,/1:12)';
  const { id } = addHighlight(db, {
    bookId, chapterIdx: 2, charOffset: 0, length: 8,
    excerpt: '书斋测试用的 EPU', note: '这句要记一下', cfi,
  });
  const 存的 = listHighlights(db, bookId, 2).find((h) => h.id === id);
  assert.equal(存的?.cfi, cfi, 'CFI 要原样存下来——它是这条划线唯一的位置信息');
  assert.equal(存的?.note, '这句要记一下');

  /*
   * ⚠️ **带 cfi 的不能被判成「漂了」。**
   *
   * `resolveForChapter` 那条判据是拿 `char_offset` 去切 txt 正文。
   * 对 EPUB 的划线来说那个 `text` 是**另一本书的字符串**（或者干脆是空的），
   * 一切必然对不上——于是每一条都会被标成漂了，而它们好好的。
   */
  const 假正文 = '和这条划线毫无关系的一段文字';
  const r = resolveForChapter(db, bookId, 2, 假正文).find((h) => h.id === id);
  assert.equal(r?.intact, true, '带 cfi 的一律当好的，漂没漂只有还原成 Range 才知道');

  // txt 那条路一个字都不许变
  const { id: t } = addHighlight(db, {
    bookId, chapterIdx: 2, charOffset: 0, length: 4, excerpt: '和这条划',
  });
  const 文 = resolveForChapter(db, bookId, 2, 假正文).find((h) => h.id === t);
  assert.equal(文?.cfi ?? null, null, 'txt 的划线没有 cfi');
  assert.equal(文?.intact, true, '偏移对得上就是好的');
  const 歪 = resolveForChapter(db, bookId, 2, '换一段完全不同的文字').find((h) => h.id === t);
  assert.equal(歪?.intact, false, '对不上就要如实说漂了——这条判据不能被上面那一支带坏');
});



test('改颜色：认不出的颜色报错，不像新建那样悄悄退回黄的', () => {
  /*
   * 两者的处境不一样：新建时兜底是「给它一个默认」，
   * 而改色时用户**明确点了一种颜色**——悄悄换成黄的是擅自改变用户看到的东西。
   * 这条路还对外开放（§13 的 rpc），外部工具传错了该当场知道。
   */
  const id = addHighlight(db, {
    bookId: 1, chapterIdx: 0, charOffset: 0, length: 2, excerpt: '风雪', color: 'yellow',
  }).id;

  setColor(db, id, 'blue');
  assert.equal(listHighlights(db, 1)[0].color, 'blue');

  assert.throws(() => setColor(db, id, 'purple'), /认不出这个颜色/);
  // **报错之后那条划线一个字都不该变**——不是「改成默认色」，是「没改」
  assert.equal(listHighlights(db, 1)[0].color, 'blue');
});

test('改颜色：id 不存在要报错，不是静默成功', () => {
  // 一句 update 影响 0 行照样是「成功」——`tag.delete` 那次事故的形状
  assert.throws(() => setColor(db, 999999, 'green'), /没有这条划线/);
});

/*
 * ── 颜色代表什么 ───────────────────────────────────────
 *
 * 颜色是划线唯一的分类轴，可「蓝色代表什么」原来只在用户脑子里。
 * 下面几条守的是：**默认名永远在**（界面上不能出现没法称呼的圆点），
 * 而用户改过的那份要**存得住、读得回、还得挡得住脏数据**。
 */

test('颜色用途：没设过就是默认名，设过之后盖在上面', () => {
  assert.deepEqual({ ...colorNames(db) }, { ...COLOR_NAMES });

  setColorNames(db, { yellow: '好句', blue: '待查' });
  const 名 = colorNames(db);
  assert.equal(名.yellow, '好句');
  assert.equal(名.blue, '待查');
  // 没提到的两种退回默认名，**不是空字符串**——空的就是个没法称呼的圆点
  assert.equal(名.green, COLOR_NAMES.green);
  assert.equal(名.pink, COLOR_NAMES.pink);
});

test('颜色用途：只存用户真的改过的那几条', () => {
  setColorNames(db, { yellow: '好句', green: COLOR_NAMES.green });
  const 存的 = JSON.parse(
    (db.prepare('select value from app_setting where key = ?').get(COLOR_NAMES_KEY) as { value: string }).value,
  );
  // 和默认名一样的不入库：以后想改默认名时，不该被一堆「绿」挡住
  assert.deepEqual(存的, { yellow: '好句' });

  // 全清回默认名，那一行要整个消失，不是留一个 {}
  setColorNames(db, { yellow: '' });
  assert.equal(db.prepare('select value from app_setting where key = ?').get(COLOR_NAMES_KEY), undefined);
  assert.deepEqual({ ...colorNames(db) }, { ...COLOR_NAMES });
});

test('颜色用途：库里那行是脏的也得能开门', () => {
  /*
   * 这一行**外部工具经 rpc 也能写**（§13），所以什么都可能进来。
   * 判据是「读不出来就当没改过」——绝不能让一行烂 JSON 把笔记面板卡死。
   */
  const 写 = (v: string) =>
    db.prepare(
      'insert into app_setting(key, value) values(?, ?) on conflict(key) do update set value = excluded.value',
    ).run(COLOR_NAMES_KEY, v);

  写('{ 这不是 json');
  assert.deepEqual({ ...colorNames(db) }, { ...COLOR_NAMES });

  写('"一个字符串"');
  assert.deepEqual({ ...colorNames(db) }, { ...COLOR_NAMES });

  // 认不出的颜色键丢掉，认得出的照用
  写(JSON.stringify({ yellow: '好句', purple: '紫的', green: 123 }));
  const 名 = colorNames(db);
  assert.equal(名.yellow, '好句');
  assert.equal(名.green, COLOR_NAMES.green);
  assert.equal((名 as Record<string, string>).purple, undefined);
});

test('颜色用途：名字掐在 12 个字', () => {
  // 它要塞进阅读界面那一排色块的标签里，再长就把那一行挤断行了
  setColorNames(db, { yellow: '一二三四五六七八九十十一十二十三' });
  assert.equal(colorNames(db).yellow.length, 12);
});

/*
 * ── 目录上的「这一章有笔记」 ─────────────────────────────
 *
 * 反向导航：笔记面板能从笔记找到章，目录得能从章看出有没有笔记。
 */

test('哪几章有笔记：划线按条数、书签也算，没笔记的章一条都不回', () => {
  const 划 = (ci: number, off: number) =>
    addHighlight(db, { bookId, chapterIdx: ci, charOffset: off, length: 2, excerpt: '风雪', color: 'yellow' });
  划(3, 0); 划(3, 10); 划(7, 0);
  db.prepare('insert into bookmark(book_id, chapter_idx, char_offset, excerpt) values(?,7,0,?)').run(bookId, '记一下');
  db.prepare('insert into bookmark(book_id, chapter_idx, char_offset, excerpt) values(?,9,0,?)').run(bookId, '只有书签');

  const 表 = notedChapters(db, bookId);
  assert.deepEqual({ ...表[3] }, { h: 2, b: 0 });
  assert.deepEqual({ ...表[7] }, { h: 1, b: 1 });
  assert.deepEqual({ ...表[9] }, { h: 0, b: 1 });

  /*
   * **回来的只能是有笔记的那几章。**
   * 这条不是洁癖：目录里有 12058 章的书，要是这儿按全章节返回，
   * 每开一次目录就搬一万两千个对象——而目录本来就是最容易卡的地方。
   */
  assert.deepEqual(Object.keys(表).sort(), ['3', '7', '9']);
});

test('哪几章有笔记：别的书的笔记不能算进来', () => {
  // book_id 没带对的话，两本书的目录会互相标记号——而且看起来完全正常
  const 另一本 = Number(db.prepare("insert into book(title) values('另一本')").run().lastInsertRowid);
  addHighlight(db, { bookId: 另一本, chapterIdx: 5, charOffset: 0, length: 2, excerpt: '别人', color: 'blue' });
  assert.deepEqual(notedChapters(db, bookId), {});
  assert.deepEqual(Object.keys(notedChapters(db, 另一本)), ['5']);
});

/*
 * ── 「全库笔记」要把书签上的笔记也算进来 ─────────────────
 *
 * 书签**也能写笔记**（`bookmark.setNote`，面板里那个行内笔记框两者共用）。
 * 而 `notesOf` 原来只查 `highlight`——于是一本书可以在书架上挂着
 * 「记过笔记」和 `✎ 3`（那两处按 `hasNotesSql` / `note_count` 算，
 * 是把书签算进去的），点开「我的笔记」却一条都没有。
 */

/** 只取「哪条笔记 → 什么内容」，好对比 */
const 笔记们 = (bookId?: number) =>
  (notesOf(db, bookId) as Array<{ kind: string; note: string; excerpt: string | null }>)
    .map((n) => n.kind + ':' + n.note);

test('全库笔记：划线和书签上的笔记都要列出来', () => {
  const h = addHighlight(db, {
    bookId, chapterIdx: 1, charOffset: 0, length: 2, excerpt: '风雪', color: 'blue',
  }).id;
  updateNote(db, h, '这句是题眼');

  db.prepare('insert into bookmark(book_id, chapter_idx, char_offset, excerpt, note) values(?,2,0,?,?)')
    .run(bookId, '书签那一句', '回头查这个典故');
  // 没写笔记的书签**不算笔记**：它只是个位置，列出来是噪音
  db.prepare('insert into bookmark(book_id, chapter_idx, char_offset, excerpt) values(?,3,0,?)')
    .run(bookId, '光是个书签');
  // 没写笔记的划线同理
  addHighlight(db, { bookId, chapterIdx: 4, charOffset: 0, length: 2, excerpt: '没笔记', color: 'yellow' });

  assert.deepEqual(笔记们(bookId), ['highlight:这句是题眼', 'bookmark:回头查这个典故']);
});

test('全库笔记：不传 bookId 是全库，传了只给那一本——两半都要挡住', () => {
  /*
   * `union all` 的占位符是按整条语句从左到右数的，两半各要一个参数。
   * 只传一个的话不是报错就是过滤错一半——而「多出别的书的笔记」
   * 在界面上看起来只是「书名分组多了一组」，很容易当成正常。
   */
  const 另一本 = Number(db.prepare("insert into book(title) values('另一本')").run().lastInsertRowid);
  const h = addHighlight(db, {
    bookId: 另一本, chapterIdx: 0, charOffset: 0, length: 2, excerpt: '别人', color: 'green',
  }).id;
  updateNote(db, h, '别人的划线笔记');
  db.prepare('insert into bookmark(book_id, chapter_idx, char_offset, excerpt, note) values(?,0,0,?,?)')
    .run(另一本, '别人的书签', '别人的书签笔记');

  const 这本 = addHighlight(db, {
    bookId, chapterIdx: 0, charOffset: 0, length: 2, excerpt: '我的', color: 'pink',
  }).id;
  updateNote(db, 这本, '我的划线笔记');

  assert.deepEqual(笔记们(bookId), ['highlight:我的划线笔记']);
  assert.deepEqual(笔记们(另一本), ['highlight:别人的划线笔记', 'bookmark:别人的书签笔记']);
  assert.equal(笔记们().length, 3, '不传 bookId 时该是全库三条');
});

test('全库笔记：两张表的 id 会重号，所以必须带 kind', () => {
  /*
   * 界面拿 `id` 当 React key。划线 1 和书签 1 撞在一起，
   * React 会当成同一个节点——**一条静默消失**，而且不报错。
   */
  const h = addHighlight(db, {
    bookId, chapterIdx: 0, charOffset: 0, length: 2, excerpt: '划线', color: 'yellow',
  }).id;
  updateNote(db, h, '划线的笔记');
  db.prepare('insert into bookmark(book_id, chapter_idx, char_offset, excerpt, note) values(?,0,1,?,?)')
    .run(bookId, '书签', '书签的笔记');

  const 全 = notesOf(db, bookId) as Array<{ id: number; kind: string }>;
  assert.equal(全.length, 2);
  assert.equal(全[0].id, 全[1].id, '这个测试的前提就是两个 id 撞上了');
  assert.notEqual(全[0].kind, 全[1].kind);
  // 界面该用的复合键
  assert.equal(new Set(全.map((n) => n.kind + ':' + n.id)).size, 2);
});

/*
 * ── 把漂了的划线重新对上 ────────────────────────────────
 *
 * 漂移原来是死路：正文变过之后画不出来，界面说一句「对不上原文了」就完了。
 * 而 `excerpt` 当初就是按原样存下来当锚的——在新正文里找一遍多半就有。
 *
 * **这几条测试真正守的是「什么时候不动手」。**
 */

test('重新对上：正文整体挪了位置，按 excerpt 找回来', () => {
  const 原 = '少年提剑出门，风雪满衣。';
  const id = addHighlight(db, {
    bookId, chapterIdx: 0, charOffset: 7, length: 4, excerpt: '风雪满衣', color: 'blue',
  }).id;
  updateNote(db, id, '这句是题眼');
  // 先确认这条在原文上是对得上的——不然下面「修好了」可能只是碰巧
  assert.equal(resolveForChapter(db, bookId, 0, 原)[0].intact, true);

  // 正文前面多了一句（改了净化规则、或者章节规则把标题算法变了）
  const 新 = '【第一章】' + 原;
  assert.equal(resolveForChapter(db, bookId, 0, 新)[0].intact, false, '前提：它该是漂了的');

  assert.deepEqual(reanchor(db, bookId, 0, 新), { fixed: 1, ambiguous: 0, gone: 0 });
  const 后 = resolveForChapter(db, bookId, 0, 新)[0];
  assert.equal(后.intact, true, '修完该对得上了');
  assert.equal(后.char_offset, 新.indexOf('风雪满衣'));
  assert.equal(后.note, '这句是题眼', '笔记一个字都不该动');
});

test('重新对上：那段字在这一章出现两次时**一律不动**', () => {
  /*
   * 这条是这个函数的要害。「他笑了笑。」这种短句一章里出现好几次是常事，
   * 挑哪一处都是猜——而猜错的后果是**把笔记贴到另一句话上**，
   * 比「画不出来」难看得多，还看不出来。
   */
  const 新 = '开头。他笑了笑。中间的一段话。他笑了笑。结尾。';
  const id = addHighlight(db, {
    bookId, chapterIdx: 1, charOffset: 999, length: 5, excerpt: '他笑了笑。', color: 'green',
  }).id;
  updateNote(db, id, '别把我贴到另一句上');

  assert.deepEqual(reanchor(db, bookId, 1, 新), { fixed: 0, ambiguous: 1, gone: 0 });
  const 后 = listHighlights(db, bookId, 1)[0];
  assert.equal(后.char_offset, 999, '没改成任何一处——包括第一处');
  assert.equal(后.note, '别把我贴到另一句上');
});

test('重新对上：那段字真没了就不动，也不删', () => {
  // 「找不到」和「找错了」是两回事。原文和笔记都还在，用户自己去处理
  const id = addHighlight(db, {
    bookId, chapterIdx: 2, charOffset: 3, length: 4, excerpt: '早就删掉的那句', color: 'pink',
  }).id;
  updateNote(db, id, '这条的原文没了');
  assert.deepEqual(reanchor(db, bookId, 2, '完全不相干的一章正文。'), { fixed: 0, ambiguous: 0, gone: 1 });
  assert.equal(listHighlights(db, bookId, 2).length, 1, '不许删');
  assert.equal(listHighlights(db, bookId, 2)[0].note, '这条的原文没了');
});

test('重新对上：对得上的和 EPUB 那些一条都不碰', () => {
  const 文 = '第一句。第二句。第三句。';
  // 对得上的
  addHighlight(db, { bookId, chapterIdx: 3, charOffset: 0, length: 4, excerpt: '第一句。', color: 'yellow' });
  // EPUB 的：cfi 是锚，char_offset 是占位——拿这套字符偏移的逻辑去动它是错的
  addHighlight(db, {
    bookId, chapterIdx: 3, charOffset: 0, length: 4, excerpt: '第二句。', color: 'blue',
    cfi: 'epubcfi(/6/6!/4/4,/1:0,/1:4)',
  });
  assert.deepEqual(reanchor(db, bookId, 3, 文), { fixed: 0, ambiguous: 0, gone: 0 });
  const 都 = listHighlights(db, bookId, 3);
  assert.equal(都.length, 2);
  for (const h of 都) assert.equal(h.char_offset, 0, '一条都不该动');
});

test('重新对上：切了繁简之后，拿转过的字形再找一次', () => {
  /*
   * 正文是**运行时**转的，而 `excerpt` 是当初划下来那一刻的字形。
   * 在简体下划的线、后来切成繁体读——正文成了繁体、摘录还是简体，
   * 那条划线就永远找不回来。而切繁简是阅读设置里一个键的事。
   *
   * ⚠️ 这里**不 import `convert.ts`**（那会把 opencc 拖进渲染包，
   * 而这个文件渲染进程也在引）：转换那一路是从外面注进来的，
   * 测试里拿一个假的转换函数就够——要验的是「会不会拿转过的再找一次」。
   */
  const 假转 = (t: string) => t.replace(/涌/g, '湧').replace(/动/g, '動');
  const 繁体正文 = '第一段。江水湧動不息，岸上有人。第三段。';
  const id = addHighlight(db, {
    bookId, chapterIdx: 5, charOffset: 0, length: 4, excerpt: '涌动不息', color: 'blue',
  }).id;
  updateNote(db, id, '切了繁简也要认得我');

  // 不给转换函数：找不到
  assert.deepEqual(reanchor(db, bookId, 5, 繁体正文), { fixed: 0, ambiguous: 0, gone: 1 });

  // 给了：拿「湧動不息」找回来
  assert.deepEqual(reanchor(db, bookId, 5, 繁体正文, 假转), { fixed: 1, ambiguous: 0, gone: 0 });
  const 后 = resolveForChapter(db, bookId, 5, 繁体正文)[0];
  assert.equal(后.intact, true, '修完该对得上了');
  assert.equal(后.char_offset, 繁体正文.indexOf('湧動不息'));
  /*
   * **摘录也换成了当前这一版的字形**——不换的话下次打开又是「对不上」
   * （`intact` 比的就是它）。这不算改用户的东西：`excerpt` 是核对用的锚，
   * 用户写的字在 `note` 里，那一列一个字都不许动。
   */
  assert.equal(后.excerpt, '湧動不息');
  assert.equal(后.note, '切了繁简也要认得我');
});

test('重新对上：转过的字形出现两次，照样不动手', () => {
  // 「正好一处」那条判据对转过的锚同样成立——不然绕开转换就能猜
  const 假转 = (t: string) => t.replace(/涌/g, '湧');
  const 文 = '甲湧乙。丙湧丁。';
  const id = addHighlight(db, {
    bookId, chapterIdx: 6, charOffset: 99, length: 1, excerpt: '涌', color: 'green',
  }).id;
  updateNote(db, id, '别乱贴');
  assert.deepEqual(reanchor(db, bookId, 6, 文, 假转), { fixed: 0, ambiguous: 1, gone: 0 });
  const 后 = listHighlights(db, bookId, 6)[0];
  assert.equal(后.char_offset, 99, '没动');
  assert.equal(后.excerpt, '涌', '摘录也没动');
});

/*
 * ── PDF 的矩形摘录 ─────────────────────────
 *
 * 扫描页 / 插图那些**没有文字层**的页靠它做笔记。
 * 存的是归一化坐标，不是截图（铁律 2）。
 */
test('框选范围认不出来就报错，不当没传', () => {
  for (const bad of ['', '乱写', '0,0,1', '0,0,1,1,1', '0,0,0,0.5', '-0.1,0,0.5,0.5', '0.9,0,0.5,0.5', 'a,b,c,d']) {
    assert.throws(
      () => addHighlight(db, { bookId, chapterIdx: 1, charOffset: 0, length: 1, excerpt: '图', rect: bad }),
      /认不出来的框选范围/,
      `rect ${JSON.stringify(bad)} 该报错`,
    );
  }
  // 边界上的整页要放行（浮点误差容得下）
  assert.ok(addHighlight(db, { bookId, chapterIdx: 1, charOffset: 0, length: 1, excerpt: '整页', rect: '0,0,1,1' }).id);
});

test('框选的 rect 原样存、原样读得回来', () => {
  addHighlight(db, {
    bookId, chapterIdx: 11, charOffset: 0, length: 1,
    excerpt: '第 11 页那张图', color: 'blue', rect: '0.1,0.2,0.3,0.25',
  });
  const h = listHighlights(db, bookId).find((x) => x.excerpt.includes('11'))!;
  assert.equal(h.rect, '0.1,0.2,0.3,0.25');
  assert.deepEqual(解析矩形(h.rect), { x: 0.1, y: 0.2, w: 0.3, h: 0.25 });
  // 文字划线那一列是 null，两种锢分得开
  addHighlight(db, { bookId, chapterIdx: 11, charOffset: 5, length: 4, excerpt: '一句正文' });
  assert.equal(listHighlights(db, bookId).find((x) => x.excerpt === '一句正文')!.rect ?? null, null);
});

test('笔记多到超过 sqlite 占位符上限时，标签照样查得出来', () => {
  /*
   * 一条 id 一个占位符，上限 32766（当场量的：32766 过得去、32767 报错）。
   * 超了就是 `too many SQL variables` **硬抛**，而这一句是打开「我的笔记」的必经之路。
   * 这条不造三万条划线（那太慢），只把**占位符数**推过线：
   * 传一堆不存在的 id，分批对了就不会抛。
   */
  const id = addHighlight(db, { bookId, chapterIdx: 1, charOffset: 0, length: 4, excerpt: '一句' }).id;
  tagHighlights(db, [id], ['伏笔']);
  const 一堆 = [id, ...Array.from({ length: 40000 }, (_, i) => 900000 + i)];
  const got = tagsOfHighlights(db, 一堆);
  assert.deepEqual(got[id], ['伏笔'], '分批之后还得能拼回来');
});
