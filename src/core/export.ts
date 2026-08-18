// 导出（spec §9）：txt → EPUB、按章节区间拆分 txt、元数据 CSV/JSON。
//
// 全部走**已解析的章节结构**，不重新解析；正文按需从原文件定点读，
// 并可选套用清洗规则和繁简转换——和阅读器看到的是同一份内容。

import { join, extname } from 'node:path';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { readChapter, type FileCache } from './reader.ts';
import { makeZip } from './zip.ts';
import { formatOf, 位置名 } from './book-format.ts';
import { colorNames, COLOR_NAMES, type HighlightColor } from './highlight.ts';
import { hasNotesSql } from './library.ts';
import { sanitizeFilename } from './rename.ts';
import {
  META_LABELS, SERIAL_STATUS, READING_STATUS, FILE_STATUS, labelOf,
} from './labels.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ExportOptions {
  /** 只导出这个区间的章节（含两端），不传就是全书 */
  fromIdx?: number;
  toIdx?: number;
  /** 套用清洗规则。默认 true——导出的内容该和读到的一致 */
  clean?: boolean;
}

interface BookMeta {
  id: number;
  title: string;
  author: string | null;
  intro: string | null;
}

function bookMeta(db: DatabaseSync, bookId: number): BookMeta {
  const b = db.prepare('select id, title, author, intro from book where id = ?').get(bookId) as
    | BookMeta
    | undefined;
  if (!b) throw new Error(`没有这本书：${bookId}`);
  return b;
}

async function collect(
  db: DatabaseSync,
  cache: FileCache,
  bookId: number,
  opts: ExportOptions,
): Promise<Array<{ idx: number; title: string; text: string }>> {
  const rows = db
    .prepare(
      `select c.idx, c.title from chapter c
         join book_file f on f.id = c.file_id
        where f.book_id = ? and f.is_primary = 1
          and c.idx >= ? and c.idx <= ?
        order by c.idx`,
    )
    .all(bookId, opts.fromIdx ?? 0, opts.toIdx ?? Number.MAX_SAFE_INTEGER) as unknown as Array<{
    idx: number;
    title: string;
  }>;

  if (rows.length === 0) {
    /*
     * ⚠️ **先分清「没切出章节」和「这种格式压根没有正文」。**
     *
     * 导出的是**正文**，而 PDF / EPUB 是只编目的：`parseAndStore` 对它们直接返回，
     * 章节表天生是空的。原来两种情况共用一句「这个区间里没有章节」——
     * 用户（和外部工具，§13）照着那句话去查章节规则，而规则一个字都不用改。
     * 判据是这个仓库反复写的那条：**拦下来的理由要说的是真正那一样**，
     * 而且**要说怎么办**。
     */
    const 主文件 = db
      .prepare('select path from book_file where book_id = ? and is_primary = 1')
      .get(bookId) as { path: string } | undefined;
    if (主文件 && formatOf(主文件.path) === 'catalog') {
      throw new Error(
        '这本是只编目的格式（PDF / EPUB），应用不解析它的正文，所以导不出 EPUB / txt。'
        + '要它的书名作者评分标签，用「导出表格」；要正文，用系统的阅读器打开原文件。',
      );
    }
    throw new Error('这个区间里没有章节');
  }

  const out: Array<{ idx: number; title: string; text: string }> = [];
  for (const r of rows) {
    const ch = await readChapter(db, cache, bookId, r.idx, opts.clean === false);
    // 正文里去掉重复的标题行——EPUB 那边标题是单独的 <h2>
    const body = ch.text.startsWith(ch.title) ? ch.text.slice(ch.title.length) : ch.text;
    out.push({ idx: r.idx, title: r.title, text: body.trim() });
  }
  return out;
}

/**
 * 导出 EPUB（spec §9）。用已解析的章节结构生成，带元数据。
 *
 * EPUB 3 的最小骨架：mimetype（必须第一个且不压缩）、META-INF/container.xml、
 * OEBPS/content.opf（清单 + 阅读顺序）、nav.xhtml（目录）、每章一个 xhtml。
 */
export async function exportEpub(
  db: DatabaseSync,
  cache: FileCache,
  bookId: number,
  opts: ExportOptions = {},
): Promise<Buffer> {
  const meta = bookMeta(db, bookId);
  const chapters = await collect(db, cache, bookId, opts);
  // 不用随机数/时间戳：同样的书导两次应该得到同样的文件
  const uid = `shuzhai-book-${bookId}`;

  const files = chapters.map((c, i) => ({
    id: `ch${i}`,
    href: `ch${i}.xhtml`,
    title: c.title,
    xhtml: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh"><head><title>${esc(c.title)}</title>
<meta charset="utf-8"/></head><body><h2>${esc(c.title)}</h2>
${c.text
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => `<p>${esc(l)}</p>`)
  .join('\n')}
</body></html>`,
  }));

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${esc(uid)}</dc:identifier>
    <dc:title>${esc(meta.title)}</dc:title>
    <dc:language>zh</dc:language>
    ${meta.author ? `<dc:creator>${esc(meta.author)}</dc:creator>` : ''}
    ${meta.intro ? `<dc:description>${esc(meta.intro)}</dc:description>` : ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${files.map((f) => `    <item id="${f.id}" href="${f.href}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine>
${files.map((f) => `    <itemref idref="${f.id}"/>`).join('\n')}
  </spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">
<head><title>目录</title><meta charset="utf-8"/></head>
<body><nav epub:type="toc"><h1>目录</h1><ol>
${files.map((f) => `<li><a href="${f.href}">${esc(f.title)}</a></li>`).join('\n')}
</ol></nav></body></html>`;

  return makeZip([
    // 这一条必须第一个、必须 store，否则部分阅读器直接拒绝打开
    { name: 'mimetype', data: 'application/epub+zip', method: 'store' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    ...files.map((f) => ({ name: `OEBPS/${f.href}`, data: f.xhtml })),
  ]);
}

/** 按章节区间导出 txt（spec §9） */
export async function exportTxt(
  db: DatabaseSync,
  cache: FileCache,
  bookId: number,
  opts: ExportOptions = {},
): Promise<string> {
  const meta = bookMeta(db, bookId);
  const chapters = await collect(db, cache, bookId, opts);
  const head = `${meta.title}${meta.author ? `\n作者：${meta.author}` : ''}\n\n`;
  return head + chapters.map((c) => `${c.title}\n\n${c.text}`).join('\n\n');
}

/** CSV 字段转义。含逗号、引号、换行的一律加引号，内部引号翻倍 */
/*
 * **单独一个回车也要加引号**（CR，不只是 LF）。
 *
 * 当场量的：短评里夹一个孤零零的 CR，这里**不加引号**就原样写进 CSV，
 * 而 RFC 4180 说带换行的字段必须引起来——Excel 和多数解析器见到裸 CR 就断行，
 * 于是那一行从中间劈开，后面每一列全部错位。不报错，打开才发现表歪了。
 *
 * 够得着吗：够。短评是用户打的字，而 `reading.setStatus` 对外开放（§13），
 * 外部工具塞什么进来都行；从别的机器恢复来的备份也可能带着 CRLF。
 */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const META_COLUMNS = [
  'id', 'title', 'author', 'aliases', 'serial_status', 'category', 'tags',
  'word_count', 'chapter_count', 'encoding', 'path', 'file_status',
  // `rated_at` 跟着 rating / comment 一起走：拿出去分析「我 2025 年读了什么、
  // 给什么打了高分」要的就是这个日期，而它重扫恢复不了，只在这里和备份里有出口
  'reading_status', 'percent', 'rating', 'comment', 'rated_at', 'drop_reason', 'reread_count',
  'last_read_at', 'source_site', 'note',
];

function metaRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db
    .prepare(
      `select b.id, b.title, b.author, b.aliases, b.serial_status,
              c.name as category,
              -- **和应用内同一个分隔符（逗号），不要另立一套。**
              -- 这里原来用空格拼：而标签名里本来就允许有空格（「科幻 悬疑」是一个标签），
              -- 于是导出的表格里分不出「一个带空格的标签」和「两个标签」。
              -- 逗号在 CSV 里是安全的：csvCell 见到逗号会给整格加引号，
              -- Excel 和任何 CSV 解析器都认得。同本文件「同一件事只能有一个说法」。
              (select group_concat(t.name, ',') from book_tag bt join tag t on t.id = bt.tag_id
                where bt.book_id = b.id) as tags,
              f.word_count, f.chapter_count, f.encoding, f.path, f.status as file_status,
              r.status as reading_status, r.percent, r.rating, r.comment, r.rated_at,
              r.drop_reason, r.reread_count, r.last_read_at,
              b.source_site, b.note
         from book b
         left join category c on c.id = b.category_id
         left join book_file f on f.book_id = b.id and f.is_primary = 1
         left join reading_state r on r.book_id = b.id
        order by b.id`,
    )
    .all() as unknown as Array<Record<string, unknown>>;
}

/** 三个状态列换成中文，其余原样 */
function csvValue(col: string, v: unknown): unknown {
  if (col === 'serial_status') return labelOf(SERIAL_STATUS, v);
  if (col === 'reading_status') return labelOf(READING_STATUS, v);
  if (col === 'file_status') return labelOf(FILE_STATUS, v);
  return v;
}

/**
 * 元数据导出 CSV。
 *
 * **带 BOM**——不带的话 Excel 打开中文是乱码。（`export.test.ts` 里那条断言
 * 按码位写、不写那个不可见字符：两边都是零宽字符的话，谁把仓库里的不可见
 * 字符清理一遍，源码和断言一起失效而测试照样绿。）
 *
 * **表头和状态值都用中文。** 这是唯一一份会离开应用、在别的程序里打开的东西，
 * 而它原来印的是数据库列名（`serial_status` / `drop_reason` / `reread_count`）
 * 和内部值（`unknown` / `dropped`）——对着 Excel 的人没有源码可看。
 * JSON 那份保持原样：它是给工具的，键名要稳定。
 */

/**
 * 把一本书的**划线、笔记和书签**导成 markdown。
 *
 * ── 为什么要有这个 ─────────────────────────────────────
 *
 * 这个应用能划线、能写笔记、能回看，**却没有一条把它们拿出去的路**——
 * `exportEpub` / `exportTxt` 导的是书，`exportCsv` / `exportJson` 导的是书库清单，
 * 一个字都不带笔记。记了几百条却只活在一个 sqlite 文件里，那是**只拥有一半**。
 * （备份带它们，但备份是给恢复用的，不是给人读的。）
 *
 * ── 为什么是 markdown ─────────────────────────────────
 *
 * 1. 纯文本，十年后什么都打得开；
 * 2. 引用块 `>` 天然就是「原文」和「我的话」的分界；
 * 3. **书斋自己就能读 `.md`**（`TEXT_EXT` 里有它）——导出来的笔记
 *    放回书库目录再扫一次，就成了一本能读、能划线、能再记笔记的书。
 *
 * ── 顺序和分组 ────────────────────────────────────────
 *
 * 按位置升序，同一个位置里按创建时间。**位置怎么称呼走 `位置名`**，
 * 那是全应用唯一的一份（txt 说章、EPUB 说节、PDF 说页）。
 * txt 有章节表就用真章名，其余格式只有序号——**没有的东西不编**。
 */
export function exportNotes(db: DatabaseSync, bookId: number): string {
  const 色名 = colorNames(db);
  const 书 = db
    .prepare('select title, author from book where id = ?')
    .get(bookId) as { title?: string; author?: string | null } | undefined;
  if (!书) throw new Error(`没有这本书：${bookId}`);

  const 主 = db
    .prepare('select path from book_file where book_id = ? and is_primary = 1')
    .get(bookId) as { path?: string } | undefined;
  const 路 = 主?.path ?? null;

  const 划 = db
    .prepare(`select chapter_idx, char_offset, excerpt, note, color, created_at, rect
              from highlight where book_id = ? order by chapter_idx, char_offset, id`)
    .all(bookId) as Array<{
      chapter_idx: number; char_offset: number;
      excerpt: string; note: string | null; color: string; created_at: string;
      rect: string | null;
    }>;
  const 签 = db
    .prepare(`select chapter_idx, char_offset, excerpt, note, created_at
              from bookmark where book_id = ? order by chapter_idx, char_offset, id`)
    .all(bookId) as Array<{
      chapter_idx: number; char_offset: number;
      excerpt: string | null; note: string | null; created_at: string;
    }>;

  // 章名只有纯文本书查得到（其余格式没有章节表），查不到就用序号
  const 章名 = new Map<number, string>();
  /*
   * ⚠️ **`chapter` 是挂在 `book_file` 上的，不是挂在 `book` 上**（列是 `file_id`）——
   * 一本书可以有好几个文件，章节表跟着**主文件**走。
   * 写成 `where book_id = ?` 会 `no such column`，测试当场抓到过。
   */
  for (const r of db
    .prepare(`select c.idx, c.title from chapter c
              join book_file f on f.id = c.file_id
              where f.book_id = ? and f.is_primary = 1 order by c.idx`)
    .all(bookId) as Array<{ idx: number; title: string }>) {
    if (r.title?.trim()) 章名.set(r.idx, r.title.trim());
  }
  const 标题 = (i: number) => 章名.get(i) ?? 位置名(路, i);

  const 行: string[] = [];
  行.push(`# ${书.title ?? '（没有书名）'}`);
  if (书.author) 行.push('', `作者：${书.author}`);
  行.push('', `划线 ${划.length} 条 · 书签 ${签.length} 条`, '');

  if (划.length === 0 && 签.length === 0) {
    // **空也要导得出来。** 一个「这本书还没有笔记」的文件，比一句报错好——
    // 用户要的是「把我的笔记给我」，而答案确实是「一条都没有」
    行.push('这本书还没有划线，也没有书签。');
    return 行.join('\n') + '\n';
  }

  const 位置们 = [...new Set([...划, ...签].map((x) => x.chapter_idx))].sort((a, b) => a - b);
  for (const 位 of 位置们) {
    行.push(`## ${标题(位)}`, '');
    for (const h of 划.filter((x) => x.chapter_idx === 位)) {
      // 摘录进引用块；多行的摘录每行都要带 `>`，否则第二行就不在引用里了
      /*
       * **框选出来的那种没有文字。**
       *
       * 扫描页 / 插图上框的那一块，`excerpt` 存的是一句说明不是原文
       * （铁律 2：**不存正文**，截图也不存，库里只有四个归一化坐标）。
       * 直接当摘录丢进引用块的话，导出来是一段看不懂的引文；
       * 写成「在这一页框了一块」才说得通——回去看才知道是什么。
       */
      if (h.rect) {
        行.push('> （在这一页框了一块）');
      } else {
        行.push(...h.excerpt.split('\n').map((l) => `> ${l}`));
      }
      /*
       * **颜色代表什么，要跟着导出去。** `color` 这一列本来就查出来了，
       * 之前一直没人读——于是导出的 markdown 把「黄＝好句、蓝＝待查」
       * 这层分类整个丢掉，四种颜色出来长得一模一样。
       * 只写用户**改过名字**的那几种：全叫「黄」「绿」的话，标出来是噪音不是信息。
       */
      if (色名[h.color as HighlightColor] !== COLOR_NAMES[h.color as HighlightColor]) {
        行.push(`> —— ${色名[h.color as HighlightColor]}`);
      }
      if (h.note?.trim()) 行.push('', h.note.trim());
      行.push('');
    }
    for (const m of 签.filter((x) => x.chapter_idx === 位)) {
      行.push(`- 🔖 书签${m.excerpt?.trim() ? `：${m.excerpt.trim().replace(/\s+/g, ' ').slice(0, 80)}` : ''}`);
      if (m.note?.trim()) 行.push(`  - ${m.note.trim()}`);
    }
    行.push('');
  }
  return 行.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/**
 * **把全库的笔记导成一份 markdown。**
 *
 * `exportNotes` 一直是**按本**的，界面上唯一的入口在「导出《某某》」里。
 * 一个在三十本书里记过东西的人，想把笔记拿出来得点三十次——
 * 而「我记过一句关于 XX 的」这种问题恰恰是跨书的。
 *
 * ⚠️ **一本书的笔记长什么样，只有 `exportNotes` 那一份实现。**
 * 这里不重写一遍，而是把它的产物整段收进来、标题降一级（`#` 变 `##`）。
 * 抄第二份必然分叉，而「导出」正是最容易分叉的地方：颜色用途、
 * 位置怎么称呼、摘录怎么进引用块，每一条判据都在那份实现里。
 *
 * ⚠️ **「哪些书算记过笔记」走 `hasNotesSql`**，不另写一句 SQL：
 * 书架那一档、卡片上那个数都从它来，各写各的迟早对不上
 * （`shelfCounts` 绕开 `buildFilter` 那次就是这么来的）。
 */
export function exportAllNotes(db: DatabaseSync): string {
  const 书们 = db
    .prepare(`select b.id, b.title from book b where ${hasNotesSql()} order by b.title collate nocase`)
    .all() as unknown as Array<{ id: number; title: string | null }>;

  const 行: string[] = ['# 我的笔记', ''];
  if (书们.length === 0) {
    // 空也要导得出来——判据同 `exportNotes` 里那条
    行.push('还没有在任何一本书里划过线、加过书签。');
    return 行.join('\n') + '\n';
  }
  行.push(`共 ${书们.length} 本书`, '');

  for (const b of 书们) {
    // 标题降一级：那份产物以 `# 书名` 开头，直接拼在一起会变成一堆一级标题
    const 一本 = exportNotes(db, b.id).split('\n').map((l) => (l.startsWith('#') ? '#' + l : l)).join('\n');
    行.push(一本, '');
  }
  return 行.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function exportCsv(db: DatabaseSync): string {
  const rows = metaRows(db);
  const lines = [META_COLUMNS.map((c) => META_LABELS[c] ?? c).join(',')];
  for (const r of rows) lines.push(META_COLUMNS.map((c) => csvCell(csvValue(c, r[c]))).join(','));
  return '﻿' + lines.join('\r\n');
}

/** 元数据导出 JSON */
export function exportJson(db: DatabaseSync): string {
  return JSON.stringify(metaRows(db).map((r) => ({ ...r })), null, 2);
}

/**
 * 文件名模板（spec §9：`{作者} - {书名}.epub`）
 *
 * ⚠️ **洗文件名走 `rename.ts` 的 `sanitizeFilename`，别在这儿再写一遍。**
 * 这里原来手抄了它的前两条（非法字符换 `_`、去掉结尾的空格和点），
 * **第三条漏了**：Windows 的保留设备名（CON / PRN / AUX / NUL / COM1…）。
 * 一本叫《CON》的书导出来是 `CON.epub`，Windows 根本建不出这个文件。
 * 抄一半比不抄更糟——看起来处理过了。
 *
 * 兜底（模板算出空名字，比如模板只有 `{作者}` 而这本书没作者）挪到了洗之前，
 * 于是**书名本身也会被洗一遍**；原来那条路直接把没洗过的书名拼上扩展名。
 */
export function exportFilename(template: string, meta: { title: string; author: string | null }, ext: string): string {
  const filled = template
    .replace(/\{title\}|\{书名\}/g, meta.title)
    .replace(/\{author\}|\{作者\}/g, meta.author ?? '')
    .trim();
  return `${sanitizeFilename(filled || meta.title).name}${ext}`;
}

/**
 * 导出落盘时挑一个**不会覆盖任何东西**的路径：`X.txt` 已存在就用 `X (2).txt`。
 *
 * 三处导出（EPUB / txt / 表格）原来都是 `join(dir, name)` 直接 `writeFile`，
 * 而**`writeFile` 会静默截断已有文件**——注释还写着「写盘（新文件）」，
 * 那句话是空头支票。
 *
 * 为什么这算事故而不是小事：铁律 1 说**原文件内容只读**，写磁盘只有两个例外
 * （改名、删重复文件），两个都要「用户显式触发、带预览、可撤销」。导出既没有预览
 * 也没有撤销，而它落的是**用户自己挑的目录**——挑成书库文件夹、名字又正好撞上，
 * 覆盖掉的就是一本书。本仓库为 `fs.rename` 的同一个毛病修过一次
 * （`rename.ts` 的 `moveFile`），当时的话是「删除那条路进回收站，删错了拖得回来；
 * **覆盖没有回收站**」。
 *
 * **让名而不是报错**：导出是个无副作用的动作，为「上次导过一份」把用户拦下来
 * 不值当；而让出来的名字会随返回值一起报给调用方，界面照实显示落在哪儿了。
 */
export function freeName(dir: string, name: string): string {
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const p = join(dir, i === 1 ? name : `${base} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
  throw new Error(`${dir} 下同名文件太多了（${name}），清一清再导`);
}

/**
 * **把一段 PNG 的 data URL 落成文件。**
 *
 * 用处只有一个：**把 PDF 上框选的那一块存成图片**。
 *
 * ── 为什么图是渲染进程送过来的 ──────────────
 *
 * 那一块图要拿 pdf.js 把那一页画出来再裁，而 pdf.js **只在渲染进程**
 * （查看器动态 import 的，主进程一行都没引）。为了截一块图把整个 pdf.js
 * 搬进主进程是不值的——同「别把 opencc 搬进渲染包」那条，只是方向相反。
 *
 * ⚠️ **库里仍然只存四个坐标（铁律 2）。** 这个函数写的是**用户显式要的导出文件**，
 * 和 `exportNotes` 写 markdown 是同一类动作（spec §9），不是把正文缓存进库。
 */
export function pngFromDataUrl(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) throw new Error('不是一段 PNG 的 data URL');
  const buf = Buffer.from(m[1], 'base64');
  // 一张页面截图几百 KB 到几 MB；封个顶，别让一句写错的 rpc 把磁盘填了
  if (buf.length > 40 * 1024 * 1024) throw new Error('这张图太大了（超过 40 MB）');
  // PNG 的头八个字节是固定的。字面能解码不等于内容是 PNG
  const 魔数 = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 8 || 魔数.some((b, i) => buf[i] !== b)) throw new Error('解出来的不是 PNG');
  return buf;
}
