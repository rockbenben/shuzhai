import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { scanRoot } from './scan.ts';
import { FileCache } from './reader.ts';
import { exportEpub, exportTxt, exportCsv, exportJson, exportNotes, exportAllNotes, exportFilename, freeName, pngFromDataUrl } from './export.ts';
import { setColorNames } from './highlight.ts';
import { tagBooks } from './library.ts';
import { labelOf, READING_STATUS } from './labels.ts';
import { makeZip } from './zip.ts';
import { setStatus } from './status.ts';
import { listBooks } from './library.ts';
import { exportBackup } from './backup.ts';

let dir: string;
let db: DatabaseSync;
let cache: FileCache;
let bookId: number;

const filler = Array.from({ length: 500 }, () => '寻常的一行正文。').join('\n');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'novel-exp-'));
  db = openDb(join(dir, 'library.db'));
  const lib = join(dir, 'books');
  mkdirSync(lib);
  const rootId = Number(
    db.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid,
  );
  writeFileSync(
    join(lib, '《测试书》某作者.txt'),
    ['第一章 起', '第二章 承', '第三章 转']
      .map((t, i) => `${t}\n这是第${i}章的正文 <含&特殊字符>。\n${filler}\n`)
      .join(''),
    'utf8',
  );
  await scanRoot(db, { id: rootId, path: lib });
  bookId = (db.prepare('select id from book').get() as { id: number }).id;
  cache = new FileCache();
});

afterEach(async () => {
  await cache.releaseAll();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 把 zip 拆回来验内容——只写不读的话没法证明写对了 */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i < buf.length - 4 && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const dataStart = i + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? data : inflateRawSync(data));
    i = dataStart + compSize;
  }
  return out;
}

test('zip 写出来的能被解回原样', () => {
  const zip = makeZip([
    { name: 'a.txt', data: '压缩的内容'.repeat(50) },
    { name: 'b.bin', data: '不压缩', method: 'store' },
  ]);
  const files = readZip(zip);
  assert.equal(files.get('a.txt')!.toString('utf8'), '压缩的内容'.repeat(50));
  assert.equal(files.get('b.bin')!.toString('utf8'), '不压缩');
});

test('EPUB 的 mimetype 必须是第一个条目且不压缩', () => {
  // 违反这条有些阅读器会直接拒绝打开，所以它不是可选项
  const zip = makeZip([
    { name: 'mimetype', data: 'application/epub+zip', method: 'store' },
    { name: 'x', data: 'y' },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(8), 0, '压缩方法必须是 0（store）');
  const nameLen = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLen).toString(), 'mimetype');
});

test('导出的 EPUB 结构完整、章节都在', async () => {
  const epub = await exportEpub(db, cache, bookId);
  const files = readZip(epub);

  assert.equal(files.get('mimetype')!.toString(), 'application/epub+zip');
  assert.ok(files.has('META-INF/container.xml'));
  assert.ok(files.has('OEBPS/content.opf'));
  assert.ok(files.has('OEBPS/nav.xhtml'));

  const opf = files.get('OEBPS/content.opf')!.toString('utf8');
  assert.match(opf, /<dc:title>测试书<\/dc:title>/);
  assert.match(opf, /<dc:creator>某作者<\/dc:creator>/);

  for (let i = 0; i < 3; i++) assert.ok(files.has(`OEBPS/ch${i}.xhtml`), `缺第 ${i} 章`);
  const ch0 = files.get('OEBPS/ch0.xhtml')!.toString('utf8');
  assert.match(ch0, /<h2>第一章 起<\/h2>/);
  assert.match(ch0, /这是第0章的正文 &lt;含&amp;特殊字符&gt;/, 'XML 特殊字符必须转义');
});

test('同一本书导两次得到完全相同的文件', async () => {
  // 里面掺时间戳的话，用户每次导出都得到不同的文件，没法比对也没法去重
  const a = await exportEpub(db, cache, bookId);
  const b = await exportEpub(db, cache, bookId);
  assert.ok(a.equals(b));
});

test('按章节区间导出', async () => {
  const txt = await exportTxt(db, cache, bookId, { fromIdx: 1, toIdx: 1 });
  assert.match(txt, /第二章 承/);
  assert.ok(!txt.includes('第一章 起'));
  assert.ok(!txt.includes('第三章 转'));

  await assert.rejects(() => exportTxt(db, cache, bookId, { fromIdx: 99 }), /没有章节/);
});

test('导出默认套用清洗规则，和读到的一致', async () => {
  const lib = join(dir, 'books');
  writeFileSync(
    join(lib, '带广告.txt'),
    `第一章 起\n正文一句。\n手机站阅读 m.x.com\n${filler}\n第二章 承\n正文二句。\n${filler}`,
    'utf8',
  );
  const rootId = (db.prepare('select id from library_root').get() as { id: number }).id;
  await scanRoot(db, { id: rootId, path: lib });
  const id = (db.prepare("select id from book where title='带广告'").get() as { id: number }).id;

  const cleaned = await exportTxt(db, cache, id);
  assert.ok(!cleaned.includes('手机站阅读'), '默认套清洗');

  const raw = await exportTxt(db, cache, id, { clean: false });
  assert.ok(raw.includes('手机站阅读'), '明确要原文时不清洗');
});

test('CSV 带 BOM 且正确转义', () => {
  setStatus(db, bookId, { status: 'reading', comment: '带,逗号和"引号"的短评' });
  const csv = exportCsv(db);

  // **按码位断言，不要写那个不可见字符。** 原来这里是 `startsWith('﻿')`，
  // 字面量里就是一个宽度为零、看不见的字符——和被测代码里那个是同一个。
  // 谁把仓库里的不可见字符统一清理一遍，两边一起没了，这条断言照样绿。
  assert.equal(csv.charCodeAt(0), 0xfeff, '不带 BOM 的话 Excel 打开中文是乱码');
  assert.match(csv, /"带,逗号和""引号""的短评"/, '逗号和引号都要转义');
  assert.match(csv, /测试书/);
});

test('CSV 的表头和状态值都是中文——这份是给 Excel 看的，不是给代码看的', () => {
  setStatus(db, bookId, { status: 'dropped', dropReason: '写崩了' });
  const [head, ...body] = exportCsv(db).split('\r\n');

  assert.match(head, /书名,作者/, '表头要是中文');
  assert.equal(head.includes('drop_reason'), false, '不能再出现数据库列名');
  assert.equal(head.includes('reread_count'), false, '不能再出现数据库列名');
  // 值也一样：对着 Excel 的人看不到源码，`dropped` 对他不是一个词
  assert.ok(body.some((l) => l.includes('弃坑')), '阅读状态要译成中文');
  assert.equal(body.some((l) => /(^|,)dropped(,|$)/.test(l)), false, '不能再出现内部值');
  // 没登记过的 id 原样带出去，**不能变成空白**——那等于悄悄丢数据
  assert.equal(labelOf(READING_STATUS, 'brand_new'), 'brand_new');
  assert.equal(labelOf(READING_STATUS, null), '');
});

test('JSON 导出含全部书籍信息和阅读状态', () => {
  setStatus(db, bookId, { status: 'dropped', dropReason: '弃了' });
  const rows = JSON.parse(exportJson(db)) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '测试书');
  assert.equal(rows[0].reading_status, 'dropped');
  assert.equal(rows[0].drop_reason, '弃了');
  assert.equal(rows[0].chapter_count, 3);
});

test('文件名模板，非法字符要处理掉', () => {
  const meta = { title: '书名/带:非法', author: '作者' };
  assert.equal(exportFilename('{作者} - {书名}', meta, '.epub'), '作者 - 书名_带_非法.epub');
  assert.equal(exportFilename('{title}', { title: '书', author: null }, '.txt'), '书.txt');
  assert.equal(
    exportFilename('{author}', { title: '兜底书名', author: null }, '.txt'),
    '兜底书名.txt',
    '模板算出空名字时要兜底成书名，不能导出一个只有扩展名的文件',
  );
});

/*
 * 书评这批数据**重扫恢复不了**，出口只有两个：备份，和这张表。
 * 少一样都算漏——`rated_at` 一度只在库里，导出和备份都没有它，
 * 于是「我 2025 年给什么打了高分」这种问题拿导出的表回答不了。
 *
 * 表头是中文的（上面那条测试钉着这件事），所以这里按中文列名断言。
 */
test('导出的表格带着评分、短评、评价时间和标签', () => {
  setStatus(db, bookId, { status: 'finished', rating: 5, comment: '一口气看完' });
  tagBooks(db, [bookId], ['玄幻', '值得再看']);

  const csv = exportCsv(db);
  const head = csv.split('\r\n')[0];
  for (const col of ['评分', '短评', '评价时间', '标签']) {
    assert.ok(head.includes(col), `表头里缺「${col}」：${head}`);
  }
  assert.match(csv, /一口气看完/);
  assert.match(csv, /玄幻/);

  // 评价时间那一格得真的有值——只加一列表头等于没加
  const cols = head.split(',');
  const row = csv.split('\r\n')[1].split(',');
  assert.ok((row[cols.indexOf('评价时间')] || '').trim(), '评价时间那一格是空的');

  // JSON 那份给工具用，键名保持数据库列名
  assert.match(exportJson(db), /"rated_at"/);
});

/*
 * **导出的标签用和应用内同一个分隔符。**
 * 原来这里是空格拼的，而标签名里本来就允许有空格——于是导出的表格里
 * 分不出「一个带空格的标签」和「两个标签」。逗号在 CSV 里是安全的：
 * 见到逗号会给整格加引号，这条断言顺带钉着那个引号。
 */
test('导出的标签用逗号分隔，带空格的标签名不会被拆开', () => {
  tagBooks(db, [bookId], ['科幻 悬疑', '已完结']);
  const csv = exportCsv(db);
  const head = csv.split('\r\n')[0].split(',');
  const row = csv.split('\r\n')[1];

  // 那一格里有逗号，所以整格必须带引号；两个标签之间是逗号不是空格
  assert.match(row, /"[^"]*科幻 悬疑[^"]*"/, `标签那一格该带引号：${row}`);
  assert.ok(row.includes('科幻 悬疑,已完结') || row.includes('已完结,科幻 悬疑'), row);
  assert.ok(head.includes('标签'));
});

/*
 * **三条出口说的得是同一本书。**
 *
 * `book.list`（书架）、CSV/JSON（导出）、`exportBackup`（备份）各自拼一份
 * 「一本书是什么」——三处 SQL、三张字段表。它们服务的目的不同，字段本来就
 * 不必一样，但**同一件事的口径必须一样**：这本书有哪些标签、打了几分、
 * 写了什么短评、主文件是哪个。
 *
 * 上一轮刚在「评价过」上抓到同一个形状（书架一份 SQL、`/api/stats` 一份），
 * 而那种分叉**不报错、测试也全绿**，只会让两个地方说的数对不上。
 */
test('书架、导出、备份说的是同一本书', () => {
  const id = bookId;
  setStatus(db, id, { status: 'finished', rating: 4, comment: '还行，结尾差点意思' });
  tagBooks(db, [id], ['玄幻', '值得再看']);

  const shelf = (listBooks(db, {}) as Array<Record<string, unknown>>).find((b) => b.id === id)!;
  const meta = JSON.parse(exportJson(db)).find((r: Record<string, unknown>) => r.id === id);
  const backup = exportBackup(db).books.find((b) => b.title === shelf.title)!;

  // 标签：书架是逗号拼的串，备份是数组，导出也是逗号拼的串
  const tagsOf = (v: unknown) => String(v ?? '').split(',').filter(Boolean).sort();
  assert.deepEqual(tagsOf(shelf.tags), ['值得再看', '玄幻'].sort(), '书架的标签');
  assert.deepEqual(tagsOf(meta.tags), tagsOf(shelf.tags), '导出和书架的标签口径要一样');
  assert.deepEqual([...backup.tags].sort(), tagsOf(shelf.tags), '备份和书架的标签口径要一样');

  // 评价
  assert.equal(meta.rating, shelf.rating);
  assert.equal(backup.reading?.rating, shelf.rating);
  assert.equal(meta.comment, shelf.comment);
  assert.equal(backup.reading?.comment, shelf.comment);

  // 主文件：书架和导出都只取 is_primary = 1 那一个，备份带的是全部文件
  assert.equal(meta.path, shelf.path, '主文件路径要一样');
  assert.ok(backup.files.some((f) => f.path === shelf.path && f.isPrimary), '备份里那个主文件要对得上');

  // 三边都得看见这本书
  assert.equal(JSON.parse(exportJson(db)).length, (listBooks(db, {}) as unknown[]).length, '导出和书架的书数');
  assert.equal(exportBackup(db).books.length, (listBooks(db, {}) as unknown[]).length, '备份和书架的书数');
});

/*
 * **短评里夹一个单独的回车，CSV 那一行会从中间劈开。**
 *
 * `csvCell` 原来只认 `"` / 逗号 / 换行，**漏了单独的 CR**——RFC 4180 说带换行的
 * 字段必须引起来，Excel 和多数解析器见到裸 CR 就断行，后面每一列全部错位。
 * 不报错，打开表才发现歪了。够得着：短评是用户打的字，而 `reading.setStatus`
 * 对外开放（§13），外部工具塞什么进来都行；从别的机器恢复来的备份也可能带 CRLF。
 *
 * 断言分两半：引号加上了，**而且整份 CSV 的行数没变多**——
 * 只断言前者的话，哪天引号加错了地方，行数照样会多出来。
 */
test('短评里的回车要被引号包住，不能把 CSV 劈成两行', () => {
  const cr = String.fromCharCode(13);
  setStatus(db, bookId, { comment: `前面好看${cr}后面烂尾` });
  const csv = exportCsv(db);

  assert.ok(csv.includes(`"前面好看${cr}后面烂尾"`), '带 CR 的短评没有被引起来');
  const rows = csv.split('\r\n').filter((l) => l.trim() !== '');
  assert.equal(rows.length, 2, `表头 + 一本书 = 2 行，实际 ${rows.length} 行：那条短评把行劈开了`);
});

/*
 * **导出绝不覆盖已有文件。**
 *
 * 三处导出（EPUB / txt / 表格）原来都是 `join(dir, name)` 直接 `writeFile`，
 * 而 `writeFile` 会**静默截断**已有文件——注释还写着「写盘（新文件）」。
 * 铁律 1 说原文件内容只读，写磁盘只有两个例外（改名、删重复文件），
 * 而导出既没预览也没撤销，落的又是**用户自己挑的目录**：挑成书库文件夹、
 * 名字正好撞上，覆盖掉的就是一本书。同 `rename.ts` 的 `moveFile`——
 * 「删错了还能从回收站拖回来，覆盖没有回收站」。
 */
test('导出落盘时让名，不覆盖任何已有文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'novel-free-'));
  try {
    const 已有 = join(dir, '《剑来》.txt');
    writeFileSync(已有, '这是用户原来那本书');

    const 第二次 = freeName(dir, '《剑来》.txt');
    assert.notEqual(第二次, 已有, '让名失败就会覆盖掉原来那本书');
    assert.match(第二次, /《剑来》 \(2\)\.txt$/);
    assert.equal(readFileSync(已有, 'utf8'), '这是用户原来那本书', '原文件一个字都不许动');

    // 第二个也占上之后再让一次
    writeFileSync(第二次, 'x');
    assert.match(freeName(dir, '《剑来》.txt'), /《剑来》 \(3\)\.txt$/);

    // 目录里没有同名的时候，就用原名
    assert.equal(freeName(dir, '没人占的名字.txt'), join(dir, '没人占的名字.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * **导 PDF / EPUB 的正文时，说的得是真正那一样。**
 *
 * 它们是只编目的格式：`parseAndStore` 直接返回，章节表天生是空的。
 * 而 `loadChapters` 原来对「章节表是空的」只有一句「这个区间里没有章节」——
 * 用户（和外部工具，§13）照着那句话去查章节规则，**而规则一个字都不用改**。
 *
 * 两条断言，第二条是重点：**理由要说清「怎么办」**（这个仓库那条
 * 「说了怎么办才是判据」）——只把话换一句、不给出路，等于没修。
 */
test('导出只编目的书：说清是格式的事，并给出路', async () => {
  const lib = join(dir, 'books');
  writeFileSync(join(lib, '一本PDF.pdf'), 'x'.repeat(20000), 'utf8');
  const rootId = (db.prepare('select id from library_root').get() as { id: number }).id;
  await scanRoot(db, { id: rootId, path: lib });
  const pdfId = (db.prepare("select id from book where title = '一本PDF'").get() as { id: number }).id;

  await assert.rejects(
    () => exportTxt(db, cache, pdfId, {}),
    (e: Error) => {
      assert.match(e.message, /只编目|PDF/, '要说清是这种格式没有正文，不是章节没切好');
      assert.match(e.message, /导出表格|系统的阅读器/, '要给出路：元数据走导出表格，正文用系统阅读器');
      return true;
    },
  );
});



/** 造一本带划线和书签的书。`ext` 决定位置该叫章 / 页 / 节 */
function 造本带笔记的书(db: DatabaseSync, ext: string) {
  const bookId = Number(
    db.prepare("insert into book(title, author) values('测试书','某作者')").run().lastInsertRowid,
  );
  // 根目录的 path 有唯一约束——同一条测试里造三本书就会撞，按扩展名分开
  const rootId = Number(
    db.prepare('insert into library_root(path, enabled) values(?, 1)').run('C:/x-' + ext).lastInsertRowid,
  );
  const fileId = Number(
    db.prepare(`insert into book_file(book_id, root_id, path, size, mtime, is_primary)
                values(?,?,?,1,1,1)`).run(bookId, rootId, 'C:/x-' + ext + '/书.' + ext).lastInsertRowid,
  );
  return { bookId, fileId };
}

test('导出笔记：位置怎么称呼跟着格式走（章 / 页 / 节）', () => {
  /*
   * ⚠️ 这条钉的是 `位置名` 那一份判据被真的用上了。
   * 三种格式的 `chapter_idx` 装的是三样东西——txt 是章号、PDF 是页码、
   * EPUB 是 spine 节号，**而且 PDF 那个本来就是 1 起的**。
   * 各写各的话，「第 0 页」这种错迟早出现。
   */
  for (const [ext, 该写] of [['txt', '第 4 章'], ['pdf', '第 3 页'], ['epub', '第 4 节']] as const) {
    const { bookId: id } = 造本带笔记的书(db, ext);
    db.prepare(`insert into highlight(book_id, chapter_idx, char_offset, length, excerpt, color)
                values(?,3,0,4,'风雪夜归','yellow')`).run(id);
    const md = exportNotes(db, id);
    assert.ok(md.includes('## ' + 该写), ext + ' 该写「' + 该写 + '」，实际是：' + md.slice(0, 160));
  }
});

test('导出笔记：摘录进引用块，笔记跟在下面，多行摘录每行都带 >', () => {
  const { bookId: id } = 造本带笔记的书(db, 'txt');
  db.prepare(`insert into highlight(book_id, chapter_idx, char_offset, length, excerpt, note, color)
              values(?,0,0,7,'第一行' || char(10) || '第二行','这句是题眼','yellow')`).run(id);
  db.prepare(`insert into bookmark(book_id, chapter_idx, char_offset, excerpt)
              values(?,0,0,'书签那一句')`).run(id);
  const md = exportNotes(db, id);
  assert.ok(md.includes('> 第一行'), md);
  // **第二行也要带 `>`**：不带的话它就掉出引用块，看起来像我说的话
  assert.ok(md.includes('> 第二行'), '多行摘录第二行没进引用块：' + md);
  assert.ok(md.includes('这句是题眼'), md);
  assert.ok(md.includes('书签那一句'), md);
  assert.ok(md.includes('划线 1 条 · 书签 1 条'), md);
});

test('导出笔记：一条都没有也要导得出来，不是报错', () => {
  // 用户要的是「把我的笔记给我」，而答案确实是「一条都没有」——
  // 一个说明白的文件比一句报错好
  const { bookId: id } = 造本带笔记的书(db, 'txt');
  const md = exportNotes(db, id);
  assert.ok(md.includes('这本书还没有划线，也没有书签。'), md);
  assert.ok(md.startsWith('# 测试书'), md);
});

test('导出笔记：有章节表就用真章名，没有才用序号', () => {
  const { bookId: id, fileId: fid } = 造本带笔记的书(db, 'txt');
  db.prepare(`insert into chapter(file_id, idx, title, offset, length)
              values(?,2,'第三章 山重水复',0,10)`).run(fid);
  db.prepare(`insert into highlight(book_id, chapter_idx, char_offset, length, excerpt, color)
              values(?,2,0,2,'柳暗','green')`).run(id);
  const md = exportNotes(db, id);
  assert.ok(md.includes('## 第三章 山重水复'), '该用真章名：' + md);
});

test('导出笔记：颜色的用途要跟着导出去，没起过名字的不写', () => {
  /*
   * 颜色是划线唯一的分类轴。用户把黄的定成「好句」、蓝的定成「待查」之后，
   * **导出的 markdown 里必须看得出这层分类**——否则四种颜色导出来长得一模一样，
   * 那套分类就只活在应用里，笔记一导出去就没了。
   *
   * 反面那半同样要钉：**没改过名字的不写**。全库只有「黄」「绿」的话，
   * 每条摘录后面缀一行「—— 黄」是噪音，不是信息。
   */
  const { bookId: id } = 造本带笔记的书(db, 'txt');
  db.prepare(`insert into highlight(book_id, chapter_idx, char_offset, length, excerpt, color)
              values(?,0,0,2,'好的那句','yellow')`).run(id);
  db.prepare(`insert into highlight(book_id, chapter_idx, char_offset, length, excerpt, color)
              values(?,0,4,2,'没起名的','green')`).run(id);

  assert.ok(!exportNotes(db, id).includes('——'), '一个名字都没起时不该写用途');

  setColorNames(db, { yellow: '好句' });
  const md = exportNotes(db, id);
  assert.ok(md.includes('> —— 好句'), '起过名的要写出来：' + md);
  assert.ok(!md.includes('—— 绿'), '没起过名的不该写：' + md);
});

test('导出全部笔记：按书分段，每本的内容和单独导出的一模一样', () => {
  /*
   * ⚠️ **判据是「和 `exportNotes` 一致」，不是「里面有那几个字」。**
   * 一本书的笔记长什么样只有那一份实现——颜色用途、位置怎么称呼、
   * 摘录怎么进引用块都在里面。这里要是自己拼一份，
   * 那三条判据就有了第二个版本，而分叉从来不报错。
   */
  const A = 造本带笔记的书(db, 'txt');
  db.prepare(`insert into highlight(book_id, chapter_idx, char_offset, length, excerpt, note, color)
              values(?,0,0,4,'甲书那句','甲的笔记','yellow')`).run(A.bookId);
  db.prepare("update book set title = '甲书' where id = ?").run(A.bookId);

  const B = 造本带笔记的书(db, 'pdf');
  db.prepare(`insert into bookmark(book_id, chapter_idx, char_offset, excerpt, note)
              values(?,2,0,'乙书那处','乙的笔记')`).run(B.bookId);
  db.prepare("update book set title = '乙书' where id = ?").run(B.bookId);

  const 全 = exportAllNotes(db);
  assert.ok(全.startsWith('# 我的笔记'), 全.slice(0, 60));

  for (const { bookId } of [A, B]) {
    // 单独导出的那份，标题降一级之后应该原样出现在全库那份里
    const 单 = exportNotes(db, bookId).split('\n').map((l) => (l.startsWith('#') ? '#' + l : l)).join('\n');
    assert.ok(全.includes(单.trim()), '这一本的内容和单独导出的不一致：' + 单.slice(0, 120));
  }
});

test('导出全部笔记：只收记过笔记的书，一本都没有时也导得出来', () => {
  // 没有任何笔记的书不该在里面占一段——那等于把整个书库抄一遍
  const 空 = 造本带笔记的书(db, 'txt');
  db.prepare("update book set title = '一条笔记都没有的书' where id = ?").run(空.bookId);
  assert.ok(!exportAllNotes(db).includes('一条笔记都没有的书'), '没笔记的书不该进来');

  // 全库一条都没有：给一句说明白的话，不是报错（同 `exportNotes` 那条）
  db.prepare('delete from highlight').run();
  db.prepare('delete from bookmark').run();
  const 全 = exportAllNotes(db);
  assert.ok(全.includes('还没有在任何一本书里划过线'), 全.slice(0, 120));
});

test('导出全部笔记：书名里的位置怎么称呼，跟着格式走', () => {
  // PDF 的位置是「页」不是「章」——这条判据在 `位置名` 里，
  // 全库导出必须照样吃到它（自己拼一份的话，第一个丢的就是这个）
  const p = 造本带笔记的书(db, 'pdf');
  db.prepare(`insert into highlight(book_id, chapter_idx, char_offset, length, excerpt, note, color)
              values(?,3,0,2,'某页','页上的笔记','blue')`).run(p.bookId);
  assert.ok(exportAllNotes(db).includes('第 3 页'), '该按页称呼');
});

/*
 * ── 框选那一块导成 PNG ────────────────────────
 *
 * 图是渲染进程画好送过来的（pdf.js 只在那边），所以主进程这头
 * **拿到的是一段从外面来的字符串**——而 §13 那条外部接口同样发得进来。
 * 校验不能只靠界面（同这个仓库那条「安全阀不能只活在界面里」）。
 */
test('导图：不是 PNG 的一律报错，不当成文件写下去', () => {
  const 真PNG = 'data:image/png;base64,'
    + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
  assert.ok(pngFromDataUrl(真PNG).length > 8);

  for (const bad of [
    '',
    '乱写的',
    'data:image/jpeg;base64,AAAA',
    'data:text/html;base64,AAAA',
    // 字面能解码，但内容不是 PNG——**这一条才是重点**：
    // 只看前缀的话，任何东西披上 `data:image/png` 都能写进磁盘
    'data:image/png;base64,' + Buffer.from('这不是图片').toString('base64'),
  ]) {
    assert.throws(() => pngFromDataUrl(bad), /不是一段 PNG|不是 PNG/, `${JSON.stringify(bad).slice(0, 40)} 该报错`);
  }
});
