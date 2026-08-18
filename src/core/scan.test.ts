import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { scanRoot, fingerprint, walk, DEFAULT_IGNORE, emptyReport, mergeReport, type ScanReport } from './scan.ts';
import { parseFilename, countWords } from './filename.ts';
import { restoreProgress, type Chapter } from './chapter.ts';
import { applyRule } from './reparse.ts';
import { reparseBooks } from './metadata.ts';

let dir: string;
let db: DatabaseSync;
let root: { id: number; path: string };

/**
 * 造一本够长的书。**必须越过 10KB 的收录下限**，算清楚再写：
 * 一行 12 个汉字 = UTF-8 下 36 字节，加换行 37 字节；200 行一章约 7.4KB，
 * 两章 14.8KB 才收得进来。
 *
 * 这里踩过两次：60 行（6.5KB）和 120 行（8.9KB）都不够，而**被体积下限滤掉是静默的**
 * ——扫描报告里六项全是 0，不会告诉你有文件因为太小被跳过了。
 */
function writeBook(path: string, titles: string[], fillerLines = 200, lead = ''): void {
  const filler = Array.from({ length: fillerLines }, () => '风雪夜归人，孤灯照旧影。').join('\n');
  writeFileSync(path, lead + titles.map((t) => `${t}\n${filler}\n`).join(''), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novel-scan-'));
  db = openDb(join(dir, 'library.db'));
  const lib = join(dir, 'books');
  mkdirSync(lib);
  const id = Number(db.prepare('insert into library_root(path) values(?)').run(lib).lastInsertRowid);
  root = { id, path: lib };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** node:sqlite 返回的行是 null 原型对象，deepEqual 会因此判不等，摊平成普通对象 */
const books = () =>
  (db.prepare('select id, title, author from book order by id').all() as Array<
    Record<string, unknown>
  >).map((r) => ({ ...r })) as Array<{ id: number; title: string; author: string | null }>;

test('从文件名解析书名作者', () => {
  assert.deepEqual(parseFilename('《雪中悍刀行》烽火戏诸侯.txt'), {
    title: '雪中悍刀行',
    author: '烽火戏诸侯',
  });
  assert.deepEqual(parseFilename('【爱潜水的乌贼】诡秘之主.txt'), {
    title: '诡秘之主',
    author: '爱潜水的乌贼',
  });
  assert.deepEqual(parseFilename('斗破苍穹-天蚕土豆.txt'), {
    title: '斗破苍穹',
    author: '天蚕土豆',
  });
  assert.deepEqual(parseFilename('《庆余年》(完本).txt'), { title: '庆余年' }, '噪音标记要去掉');
  assert.deepEqual(parseFilename('没有作者信息.txt'), { title: '没有作者信息' });
});

test('字数不含空白', () => {
  assert.equal(countWords('风雪 夜\n归人'), 5, '风雪夜归人，空格和换行都不算');
});

test('首次扫描：建书、建文件、切章节', async () => {
  writeBook(join(root.path, '《雪中悍刀行》烽火戏诸侯.txt'), ['第一章 起', '第二章 承', '第三章 转']);
  const r = await scanRoot(db, root);

  assert.equal(r.added, 1);
  assert.equal(r.failed, 0);
  assert.deepEqual(books(), [{ id: 1, title: '雪中悍刀行', author: '烽火戏诸侯' }]);

  const file = db.prepare('select * from book_file').get() as Record<string, unknown>;
  assert.equal(file.chapter_count, 3);
  assert.equal(file.encoding, 'utf-8');
  assert.equal(file.status, 'ok');
  assert.ok((file.word_count as number) > 0);
  assert.equal((db.prepare('select count(*) n from chapter').get() as { n: number }).n, 3);
});

test('第二次扫描什么都不做（size + mtime 没变就不读文件）', async () => {
  writeBook(join(root.path, '测试书.txt'), ['第一章 起', '第二章 承']);
  await scanRoot(db, root);
  const r = await scanRoot(db, root);

  assert.equal(r.unchanged, 1);
  assert.equal(r.added, 0);
  assert.equal(r.updated, 0);
  assert.equal(books().length, 1, '不该重复建书');
});

test('文件改名后进度和元数据全部跟着走', async () => {
  // 这条是这个模块最要紧的一条：用户整理一次文件夹不能把进度弄丢
  const before = join(root.path, '旧名字.txt');
  writeBook(before, ['第一章 起', '第二章 承', '第三章 转']);
  await scanRoot(db, root);

  const bookId = books()[0].id;
  db.prepare('update book set author = ? where id = ?').run('我手填的作者', bookId);
  db.prepare("update reading_state set status='reading', chapter_idx=2, char_offset=88 where book_id=?").run(bookId);

  const after = join(root.path, '《新名字》某作者.txt');
  renameSync(before, after);
  const r = await scanRoot(db, root);

  assert.equal(r.moved, 1, '应判定为移动');
  assert.equal(r.added, 0, '不能当成新书');
  assert.equal(r.missing, 0, '也不能标成缺失');
  assert.equal(books().length, 1);

  const state = db.prepare('select * from reading_state where book_id = ?').get(bookId) as Record<string, unknown>;
  assert.equal(state.status, 'reading');
  assert.equal(state.chapter_idx, 2);
  assert.equal(state.char_offset, 88, '章内偏移也要保住');
  assert.equal(books()[0].author, '我手填的作者', '手填的元数据不能被文件名覆盖');
  assert.equal((db.prepare('select path from book_file').get() as { path: string }).path, after);
});

test('内容追更后重新解析，进度按标题落回同一章', async () => {
  const path = join(root.path, '连载中.txt');
  writeBook(path, ['第一章 起', '第二章 承']);
  await scanRoot(db, root);

  const bookId = books()[0].id;
  db.prepare('update reading_state set chapter_idx = 1, char_offset = 42 where book_id = ?').run(bookId);

  // 在最前面插一章，再往后追一章——序号会整体错位，只有标题匹配救得回来
  writeBook(path, ['第零章 楔子', '第一章 起', '第二章 承', '第三章 转']);
  utimesSync(path, new Date(), new Date(Date.now() + 10_000));

  const r = await scanRoot(db, root);
  assert.equal(r.updated, 1);
  assert.equal((db.prepare('select chapter_count c from book_file').get() as { c: number }).c, 4);

  const state = db.prepare('select * from reading_state where book_id = ?').get(bookId) as Record<string, unknown>;
  assert.equal(state.chapter_idx, 2, '原来读的「第二章 承」现在排第 2（0 基），序号已经错位');
  assert.equal(state.char_offset, 42);
});

test('没读过的书重新解析后仍然停在第 0 章，不许被「前言」顺带挪走', async () => {
  const path = join(root.path, '没打开过.txt');
  writeBook(path, ['第一章 起', '第二章 承', '第三章 转']);
  await scanRoot(db, root);
  const bookId = books()[0].id;

  const before = db.prepare('select * from reading_state where book_id = ?').get(bookId) as Record<string, unknown>;
  assert.equal(before.status, 'none', '扫进来的书不表态');
  assert.equal(before.chapter_idx, 0);

  // 前面加一大段没有标题的正文 → 解析出来会多一章「前言」，原来的第 0 章挪到第 1 位
  writeBook(path, ['第一章 起', '第二章 承', '第三章 转'], 200, '这是一大段没有标题的开场白。'.repeat(80) + '\n');
  utimesSync(path, new Date(), new Date(Date.now() + 10_000));
  await scanRoot(db, root);

  const titles = db.prepare('select title from chapter order by idx').all() as Array<{ title: string }>;
  assert.equal(titles[0].title, '前言', '前提：确实多出了一章前言');

  const after = db.prepare('select * from reading_state where book_id = ?').get(bookId) as Record<string, unknown>;
  assert.equal(after.chapter_idx, 0, '从没读过的书不该凭空长出进度');
  assert.equal(after.percent, 0);
});

test('章节数变了，percent 要跟着重算，不能留下「第 3 章 / 100%」', async () => {
  const path = join(root.path, '章节数会暴涨.txt');
  writeBook(path, ['第一章 起', '第二章 承']);
  await scanRoot(db, root);

  const bookId = books()[0].id;
  // 读到第 2 章（共 2 章）= 100%。status 要一起改成 reading——真实流程里
  // `reading.save` 就是这么干的，而「还是 want」现在意味着从没打开过、跳过恢复
  db.prepare(
    "update reading_state set status = 'reading', chapter_idx = 1, percent = 100 where book_id = ?",
  ).run(bookId);

  // 重新解析后切出 10 章：同一个 chapter_idx 只到 20%，percent 不跟着改就自相矛盾
  writeBook(path, Array.from({ length: 10 }, (_, i) => `第${i + 1}章 第${i + 1}节`));
  utimesSync(path, new Date(), new Date(Date.now() + 10_000));
  await scanRoot(db, root);

  const state = db.prepare('select * from reading_state where book_id = ?').get(bookId) as Record<string, unknown>;
  assert.equal((db.prepare('select chapter_count c from book_file').get() as { c: number }).c, 10);
  assert.equal(state.percent, 20, '(chapter_idx + 1) / 10');
});

test('已读完的 100% 是用户按的，重新解析不许把它算下去', async () => {
  const path = join(root.path, '读完了.txt');
  writeBook(path, ['第一章 起', '第二章 承']);
  await scanRoot(db, root);

  const bookId = books()[0].id;
  db.prepare(
    "update reading_state set status = 'finished', chapter_idx = 1, percent = 100 where book_id = ?",
  ).run(bookId);

  writeBook(path, Array.from({ length: 10 }, (_, i) => `第${i + 1}章 第${i + 1}节`));
  utimesSync(path, new Date(), new Date(Date.now() + 10_000));
  await scanRoot(db, root);

  const state = db.prepare('select * from reading_state where book_id = ?').get(bookId) as Record<string, unknown>;
  assert.equal(state.percent, 100);
});

test('文件消失只标 missing，不删记录', async () => {
  const path = join(root.path, '会消失的书.txt');
  writeBook(path, ['第一章 起', '第二章 承']);
  await scanRoot(db, root);
  rmSync(path);

  const r = await scanRoot(db, root);
  assert.equal(r.missing, 1);
  assert.equal(books().length, 1, '记录必须还在');
  assert.equal((db.prepare('select status from book_file').get() as { status: string }).status, 'missing');
});

test('忽略规则和体积下限都生效', async () => {
  mkdirSync(join(root.path, '备份2024'));
  writeBook(join(root.path, '备份2024', '旧版.txt'), ['第一章 起', '第二章 承']);
  writeFileSync(join(root.path, '说明.txt'), '太小了，不该被收进来');
  writeBook(join(root.path, '正常的书.txt'), ['第一章 起', '第二章 承']);

  const r = await scanRoot(db, root, { ignore: DEFAULT_IGNORE });
  assert.equal(r.added, 1);
  assert.deepEqual(books().map((b) => b.title), ['正常的书']);
});

test('扫描深度上限', async () => {
  const deep = join(root.path, 'a', 'b', 'c');
  mkdirSync(deep, { recursive: true });
  writeBook(join(deep, '很深的书.txt'), ['第一章 起', '第二章 承']);

  const shallow: string[] = [];
  for await (const p of walk(root.path, { recursive: true, maxDepth: 1, ignore: [] })) shallow.push(p);
  assert.equal(shallow.length, 0, 'maxDepth=1 够不到第三层');

  const full: string[] = [];
  for await (const p of walk(root.path, { recursive: true, maxDepth: 8, ignore: [] })) full.push(p);
  assert.equal(full.length, 1);
});

test('大文件用首尾指纹，改动尾部能认出来', async () => {
  const a = join(dir, 'a.bin');
  const b = join(dir, 'b.bin');
  const big = Buffer.alloc(200 * 1024, 0x41);
  writeFileSync(a, big);
  const changed = Buffer.from(big);
  changed[changed.length - 1] = 0x42; // 只改最后一个字节，模拟追更
  writeFileSync(b, changed);

  assert.notEqual(await fingerprint(a, big.length), await fingerprint(b, changed.length));
  assert.equal(await fingerprint(a, big.length), await fingerprint(a, big.length), '同一文件要稳定');
});

test('进度恢复的三档优先级', () => {
  const mk = (titles: string[]): Chapter[] =>
    titles.map((t, i) => ({ index: i, title: t, offset: i * 100, length: 100 }));

  const oldC = mk(['第一章', '第二章', '第三章']);

  const byTitle = restoreProgress(oldC, mk(['楔子', '第一章', '第二章', '第三章']), {
    chapterIdx: 2, charOffset: 10, globalOffset: 210,
  });
  assert.equal(byTitle.by, 'title');
  assert.equal(byTitle.chapterIdx, 3);

  const byIndex = restoreProgress(oldC, mk(['甲', '乙', '丙', '丁']), {
    chapterIdx: 1, charOffset: 5, globalOffset: 105,
  });
  assert.equal(byIndex.by, 'index');
  assert.equal(byIndex.chapterIdx, 1);

  const byOffset = restoreProgress(oldC, mk(['甲']), {
    chapterIdx: 2, charOffset: 5, globalOffset: 205,
  });
  assert.equal(byOffset.by, 'offset');
  assert.equal(byOffset.accurate, false, '不准就得如实标出来');
});

test('括号里多个噪音词连写也要去掉（真实库里 8000+ 本这个格式）', () => {
  // 一度写成「整个括号内容必须等于其中一个词」，于是 （校对版全本） 一个都没去掉，
  // 作者解析成了「（校对版全本）作者：某某」
  assert.deepEqual(parseFilename('《一世兵王》（校对版全本）作者：我本疯狂.txt'), {
    title: '一世兵王',
    author: '我本疯狂',
  });
  assert.deepEqual(parseFilename('《九天》（精校完本）作者：黑山老鬼.txt'), {
    title: '九天',
    author: '黑山老鬼',
  });
  assert.deepEqual(parseFilename('《万历1592》（全本已完结）作者：御炎.txt'), {
    title: '万历1592',
    author: '御炎',
  });
});

test('「作者：」前缀要剥掉', () => {
  assert.deepEqual(parseFilename('斗破苍穹 作者：天蚕土豆.txt'), {
    title: '斗破苍穹',
    author: '天蚕土豆',
  });
  assert.deepEqual(parseFilename('雪中悍刀行-作者:烽火戏诸侯.txt'), {
    title: '雪中悍刀行',
    author: '烽火戏诸侯',
  });
});

test('没有作者信息的仍然只给书名', () => {
  assert.deepEqual(parseFilename('《庆余年》（校对版全本）.txt'), { title: '庆余年' });
});

test('括号噪音的判据是「整段由噪音词元拼成」，不是「含有某个词」', () => {
  // 这张词元表是从真实库的 8173 个文件名统计出来的，93 种括号内容
  for (const [name, want] of [
    ['《南宋第一卧底》（校对版全本+番外）作者：龙渊.txt', { title: '南宋第一卧底', author: '龙渊' }],
    ['《某书》（实体版1-3全本）作者：某某.txt', { title: '某书', author: '某某' }],
    ['《某书》（精校版全本 + 番外）作者：某某.txt', { title: '某书', author: '某某' }],
    ['《某书》（实体封面全本）作者：某某.txt', { title: '某书', author: '某某' }],
    ['《某书》（校对版版全本）作者：某某.txt', { title: '某书', author: '某某' }],
    ['《某书》（修订版）作者：某某.txt', { title: '某书', author: '某某' }],
  ] as const) {
    assert.deepEqual(parseFilename(name), want, name);
  }
});

test('括号里是书名的一部分时不能删——库里真有这种', () => {
  // 「（中秋月明）」按「含有某个词就删」的判据会被一起吃掉
  const r = parseFilename('《某书（中秋月明）》作者：某某.txt');
  assert.ok(r.title.includes('中秋月明'), `实际解析成：${JSON.stringify(r)}`);
});

test('带册数的实体版也认得，但单独的数字不算噪音', () => {
  assert.deepEqual(parseFilename('《如果这是宋史》（实体版10册全本）作者：高天流云.txt'), {
    title: '如果这是宋史', author: '高天流云',
  });
  assert.deepEqual(parseFilename('《封神记》（实体版三册全本）作者：黄易.txt'), {
    title: '封神记', author: '黄易',
  });
  assert.deepEqual(parseFilename('《微微一笑很倾城》（实体版全本 +网络版番外）作者：顾漫.txt'), {
    title: '微微一笑很倾城', author: '顾漫',
  });

  // 单独的数字/中文数字是分卷标记，属于标题的一部分，不能删
  assert.ok(parseFilename('《某书（三）》作者：某某.txt').title.includes('三'));
  assert.ok(parseFilename('《某书（2）》作者：某某.txt').title.includes('2'));
});

test('长尾变体：卷范围、外篇续集后记、以及「版」的错别字', () => {
  for (const [name, want] of [
    ['《灵飞经》（实体版1-5卷）作者：凤歌.txt', { title: '灵飞经', author: '凤歌' }],
    ['《龙族》（实体版1-3部全本）作者：江南.txt', { title: '龙族', author: '江南' }],
    ['《余罪》（校对版全本+第八卷）作者：常书欣.txt', { title: '余罪', author: '常书欣' }],
    ['《修仙狂徒》（校对版全本+外卷）作者：王小蛮.txt', { title: '修仙狂徒', author: '王小蛮' }],
    ['《六指琴魔》（校对版全本+续集）作者：倪匡.txt', { title: '六指琴魔', author: '倪匡' }],
    ['《重生之心动》（精校版全本+外篇）作者：初恋璀璨如夏花.txt', { title: '重生之心动', author: '初恋璀璨如夏花' }],
    // 真实库里的错别字：把「版」打成了「办」「把」
    ['《大神戒》（校对办全本）作者：兔子来了.txt', { title: '大神戒', author: '兔子来了' }],
    ['《神兵圣手》（校对把全本）作者：林中清风.txt', { title: '神兵圣手', author: '林中清风' }],
    ['《至尊主播》（校对版全部）作者：兔子来了.txt', { title: '至尊主播', author: '兔子来了' }],
  ] as const) {
    assert.deepEqual(parseFilename(name), want, name);
  }
});

test('作者名里含「作者」二字的不受影响', () => {
  // 「新闻工作者」里有「作者」，按子串判会误报
  assert.deepEqual(parseFilename('《魂武双修》（校对版全本）作者：新闻工作者.txt'), {
    title: '魂武双修',
    author: '新闻工作者',
  });
});

test('被屏蔽的文件不算「缺失」——它只是被跳过了，文件还在磁盘上', async () => {
  const keep = join(root.path, '正常的书.txt');
  const skip = join(root.path, '要屏蔽的书.txt');
  writeBook(keep, ['第一章 起', '第二章 承']);
  writeBook(skip, ['第一章 起', '第二章 承']);
  await scanRoot(db, root);
  assert.equal(books().length, 2);

  // 手工标成屏蔽（正常路径是 ignore.ts 的 applyIgnoreToLibrary 来做）
  db.prepare("update book_file set excluded = 1 where path = ?").run(skip);

  // 再扫一次时用忽略规则把它挡在外面——扫描当然「见不到」它
  const r = await scanRoot(db, root, { ignore: ['**/要屏蔽*'] });
  assert.equal(
    r.missing,
    0,
    '**屏蔽 ≠ 缺失**：不排除的话每次扫描都报一串假警报，' +
      '实测真实库里 759 个屏蔽记录全被标成 missing，而文件一个都没少',
  );
  const st = db.prepare('select status from book_file where path = ?').get(skip) as { status: string };
  assert.equal(st.status, 'ok', '文件还在磁盘上，状态不该被改坏');
});

test('重新解析时，书签和划线跟着标题搬——它们和进度一样重扫恢复不了', async () => {
  // 原来只搬 `reading_state`，而 bookmark / highlight 存的是**裸的** chapter_idx
  // （`db.ts` 的表定义旁边自己就写着「重新解析后位置可能对不上」）。
  // 一本 1949 章的书重切成 546 章之后，每条书签都指向一个毫不相干的章节。
  const file = join(root.path, '会长的书 作者：某人.txt');
  writeBook(file, ['第一章 起', '第二章 承', '第三章 转', '第四章 合']);
  await scanRoot(db, root);
  const bookId = (db.prepare('select id from book').get() as { id: number }).id;

  // 书签放在「第三章 转」（此刻是 idx 2），划线放在「第四章 合」
  db.prepare("insert into bookmark(book_id, chapter_idx, char_offset, excerpt) values(?,2,0,'第三章 转')").run(bookId);
  db.prepare(`insert into highlight(book_id, chapter_idx, char_offset, length, excerpt)
              values(?,3,5,4,'风雪夜归')`).run(bookId);

  // 作者在**前面**加了两章 → 原来的第三章整体后移两位
  writeBook(file, ['第零章 新的前传', '第零点五章 又一章', '第一章 起', '第二章 承', '第三章 转', '第四章 合']);
  utimesSync(file, new Date(), new Date(Date.now() + 60_000));
  await scanRoot(db, root);

  const titleAt = (idx: number) =>
    (db.prepare(`select c.title t from chapter c join book_file f on f.id = c.file_id
                  where f.book_id = ? and c.idx = ?`).get(bookId, idx) as { t: string } | undefined)?.t;

  const bm = db.prepare('select chapter_idx i from bookmark where book_id = ?').get(bookId) as { i: number };
  // **不变式是「还指着同一章」，不是某个具体序号**——前面加几章要看内置规则
  // 认出几条（「第零点五章」就没被认成章节），写死数字会把测试变成在测规则
  assert.equal(titleAt(bm.i), '第三章 转', `书签跑到了「${titleAt(bm.i)}」`);
  assert.notEqual(bm.i, 2, '前面插了章，序号必须跟着动——没动就说明根本没搬');

  const hl = db.prepare('select chapter_idx i from highlight where book_id = ?').get(bookId) as { i: number };
  assert.equal(titleAt(hl.i), '第四章 合', `划线跑到了「${titleAt(hl.i)}」`);
});

test('标题在新目录里没了的时候，书签退回按序号并夹在范围内——不许指向不存在的章', async () => {
  const file = join(root.path, '会缩的书 作者：某人.txt');
  writeBook(file, ['第一章 甲', '第二章 乙', '第三章 丙', '第四章 丁', '第五章 戊']);
  await scanRoot(db, root);
  const bookId = (db.prepare('select id from book').get() as { id: number }).id;
  db.prepare("insert into bookmark(book_id, chapter_idx, char_offset, excerpt) values(?,4,0,'第五章 戊')").run(bookId);

  // 整本重写成只有两章，而且标题全换了
  writeBook(file, ['楔子', '正文'], 400);
  utimesSync(file, new Date(), new Date(Date.now() + 60_000));
  await scanRoot(db, root);

  const n = (db.prepare(`select count(*) n from chapter c join book_file f on f.id=c.file_id
                          where f.book_id = ?`).get(bookId) as { n: number }).n;
  const bm = db.prepare('select chapter_idx i from bookmark where book_id = ?').get(bookId) as { i: number };
  assert.ok(bm.i < n, `书签指向 #${bm.i}，而现在只有 ${n} 章——那是个点开就报错的位置`);
});

/*
 * **进度是估出来的，得说一声。**
 *
 * 重新解析之后章节变少、原来的章号超出新目录时，`restoreProgress` 只能退回
 * 最后一章并标 `accurate: false`——那个标记一直算着，而**调用方把它连同 `by`
 * 一起扔了**。用户那边是「打开书发现位置不对，一句解释都没有」，
 * 而阅读进度是铁律 3 里重扫恢复不了的数据，最容易让人以为丢了。
 * spec §2.3 第 3 档明写着要如实告诉用户。
 */
test('重解析后章节变少：进度估算过的书要出现在扫描报告里', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'guess-'));
  const db2 = openDb(join(dir2, 'library.db'));
  const lib = join(dir2, 'books');
  mkdirSync(lib);
  const file = join(lib, '会变短的书.txt');

  // 先来一本多章的
  writeFileSync(file, ['第一章 甲', '内容'.repeat(3000), '第二章 乙', '内容'.repeat(3000),
    '第三章 丙', '内容'.repeat(3000), '第四章 丁', '内容'.repeat(3000)].join('\n'), 'utf8');
  const root = { id: 1, path: lib, enabled: 1, recursive: 1, max_depth: 8 } as never;
  db2.prepare("insert into library_root(id, path) values(1, ?)").run(lib);
  await scanRoot(db2, root);
  const bookId = (db2.prepare('select id from book').get() as { id: number }).id;
  // 读到第 4 章。**status 也要设**：`scan.ts` 那条「没读过的书一个字都别动」
  // 的守卫看的是 status 和 char_offset，只写 chapter_idx 会被它挡掉（那条守卫是对的）
  db2.prepare("update reading_state set chapter_idx = 3, char_offset = 40, status = 'reading' where book_id = ?").run(bookId);

  // 换成一本只有一章的（同名同路径，内容变了 → 走「内容更新」那一档）
  writeFileSync(file, ['第一章 甲', '内容'.repeat(9000)].join('\n'), 'utf8');
  const r = await scanRoot(db2, root);

  assert.equal(r.progressGuessed.length, 1, `报告里没提这本书：${JSON.stringify(r.progressGuessed)}`);
  assert.match(r.progressGuessed[0].title, /会变短的书/);
  assert.equal(r.progressGuessed[0].from, 3);
  assert.equal(r.progressGuessed[0].to, 0, '只剩一章，只能退到第一章');

  db2.close();
  rmSync(dir2, { recursive: true, force: true });
});


/*
 * ⚠️ **书库根目录读不到的时候，一本都不许标「文件不见了」。**
 *
 * 「没见到」是靠遍历得出来的，而 `walk` 遇到 `readdir` 失败会**静默跳过整棵子树**。
 * 于是移动硬盘没插、网络盘断了、权限被改了——`seen` 是空的，
 * 而紧接着那个循环会把**整个书库**（真实库 8172 本）一口气标成「文件不见了」，
 * 书架上一片红字，而用户根本不会把它和「我忘了插硬盘」联系起来。
 *
 * 判据和本仓库另外三处同源：**「没答上来」不等于「答了没有」**。
 */
test('根目录整个读不到时，不许把库里的书标成「文件不见了」', async () => {
  writeBook(join(root.path, '《剑来》烽火戏诸侯.txt'), ['第一章 惊蛰', '第二章 泥瓶巷']);
  const first = await scanRoot(db, root);
  assert.equal(first.added, 1);

  // 把整个书库目录挪走：readdir 会 ENOENT，walk 静默跳过整棵子树
  const 挪到 = join(dir, 'books-拔掉了');
  renameSync(root.path, 挪到);

  const second = await scanRoot(db, root);
  assert.ok(second.skipped.unreadableDir, '根目录读不到要记一笔，别静默');
  assert.equal(second.missing, 0, '一整片没看到，不等于那些书没了');

  const st = db.prepare('select status from book_file').get() as { status: string };
  assert.equal(st.status, 'ok', '库里那一行不该被改成 missing');

  // 插回去再扫，一切照旧
  renameSync(挪到, root.path);
  const third = await scanRoot(db, root);
  assert.equal(third.missing, 0);
  assert.equal((db.prepare('select status from book_file').get() as { status: string }).status, 'ok');
});

test('目录读得到、文件真的没了 —— 该标还是要标', async () => {
  const p = join(root.path, '《会被删掉的书》某人.txt');
  writeBook(p, ['第一章 起', '第二章 承']);
  await scanRoot(db, root);

  rmSync(p);
  const r = await scanRoot(db, root);
  assert.ok(!r.skipped.unreadableDir, '目录本身是读得到的');
  assert.equal(r.missing, 1, '看过了、确实没有——这时候就该标');
});

/*
 * ⚠️ **`stat` 抛了不等于那个文件没了。**
 *
 * 「同一份内容换了位置吗」这一判：老路径 `stat` 不到 → 判为移动，
 * **把记录的路径改指到新文件上**。而 `stat` 还会因为别的原因抛——被锁着、
 * 权限不对、网络盘抖了一下。那时候**老文件其实还在**，而记录已经被搬走了：
 * 阅读进度跟着新文件走，老文件下次扫描被当成一本新书重新收进来。
 *
 * 判据和本仓库另外三处一样：**只有 ENOENT / ENOTDIR 才是「真的没了」**。
 * 不下结论的代价只是多一条「完全重复」的记录——看得见、改得掉；
 * 而搬错记录是看不见的。
 */
test('老路径读不到、但不是「没了」→ 不判为移动', async () => {
  const p1 = join(root.path, '《原来那本》某人.txt');
  writeBook(p1, ['第一章 起', '第二章 承']);
  await scanRoot(db, root);
  const before = db.prepare('select id, path, content_hash from book_file').get() as
    { id: number; path: string; content_hash: string };

  rmSync(p1);
  // 同样内容出现在另一个位置
  const p2 = join(root.path, '《换了个名字》某人.txt');
  writeBook(p2, ['第一章 起', '第二章 承']);

  /*
   * 造一个**不是 ENOENT** 的 stat 失败。真机上那要靠文件被锁、权限不对、
   * 网络盘抖动才出得来，测试里造不稳——所以走 `statImpl` 这条注入缝
   * （同 `links.ts` 的 `fetchImpl`）。
   *
   * ⚠️ 第一版是往路径里塞 NUL，**没走通**：`node:sqlite` 会把字符串在 NUL 处
   * 截断（当场量的：存 10 个字符、取出来 4 个），落库的是个前缀，`stat` 给的
   * 还是 ENOENT——**诱饵测的不是被测的那一句**，破坏实验因此一声不吭。
   */
  const 锁住了 = () => Promise.reject(Object.assign(new Error('被占用'), { code: 'EBUSY' }));
  const r = await scanRoot(db, root, { statImpl: 锁住了 });

  assert.equal(r.moved, 0, '读不到 ≠ 没了——不该把记录搬到新文件上');
  const after = db.prepare('select path from book_file where id = ?').get(before.id) as { path: string };
  assert.equal(after.path, before.path, '老记录的路径一个字都不该改');
  assert.equal(r.added, 1, '新文件照常当一本新书收进来（多一条重复记录，看得见改得掉）');
});

test('老路径真的没了 → 还是要判为移动，进度不许丢', async () => {
  const p1 = join(root.path, '《会被改名的》某人.txt');
  writeBook(p1, ['第一章 起', '第二章 承']);
  await scanRoot(db, root);
  const id = (db.prepare('select book_id from book_file').get() as { book_id: number }).book_id;
  db.prepare('update reading_state set chapter_idx = 1, status = ? where book_id = ?').run('reading', id);

  renameSync(p1, join(root.path, '《改名之后》某人.txt'));
  const r = await scanRoot(db, root);
  assert.equal(r.moved, 1, '真没了就该判为移动');
  assert.equal(r.added, 0);
  const st = db.prepare('select chapter_idx from reading_state where book_id = ?').get(id) as { chapter_idx: number };
  assert.equal(st.chapter_idx, 1, '移动不该动阅读进度');
});

/*
 * ⚠️ **「没变过」不等于「解析过」。**
 *
 * 扫描第 1 档是「size + mtime 都没变就连文件都不打开」。一条从没解析过的记录
 * （`parsed_at is null`）会被这一档**永远跳下去**——而它的 `status` 还是 `'ok'`，
 * 于是「需要处理」那一档也看不见它。
 *
 * 真实库里就有一本这样的：7.1 MB 的书，`chapter_count` / `parsed_at` / `encoding`
 * 全是 null，而当场试解析 **204 毫秒切出 1624 章**——文件一点问题都没有，
 * 只是那条记录从来没被喂给解析器。用户点开看到的是一本没有章节的书。
 */
test('从没解析过的记录，即使文件没变也要补上解析', async () => {
  const p = join(root.path, '《从没解析过的》某人.txt');
  writeBook(p, ['第一章 起', '第二章 承', '第三章 转']);
  await scanRoot(db, root);

  const f = db.prepare('select id, chapter_count from book_file').get() as { id: number; chapter_count: number };
  assert.equal(f.chapter_count, 3);

  // 造出那条陈记录：解析痕迹全清掉，但 size/mtime 原样（也就是「没变」）
  db.prepare(
    "update book_file set chapter_count = null, parsed_at = null, encoding = null, status = 'ok' where id = ?",
  ).run(f.id);
  db.prepare('delete from chapter where file_id = ?').run(f.id);

  const r = await scanRoot(db, root);
  assert.equal(r.unchanged, 0, '没解析过就不能算「未变」——那一档会让它永远卡着');

  const after = db.prepare('select chapter_count, parsed_at from book_file where id = ?').get(f.id) as
    { chapter_count: number; parsed_at: string | null };
  assert.equal(after.chapter_count, 3, '该补上解析');
  assert.ok(after.parsed_at, '该记下解析时间');
  assert.equal(
    (db.prepare('select count(*) n from chapter where file_id = ?').get(f.id) as { n: number }).n, 3,
    '章节要真的写回去',
  );
});

/*
 * ⚠️ 这条钉的是「**不会每次扫描都重解析一遍**」，**不是**「真的没打开文件」——
 * 后者从外面看不出来：跳过快档之后会走「hash 一样」那一支，报的还是 `unchanged`。
 * 快档省下的是**时间**（8000 个文件逐个算 hash），那个断言不了。
 * 真正把两半条件都钉住的是上面那条测试：拆掉任意一半，它都红。
 */
test('解析过、而且确实没变的，不会被重解析', async () => {
  writeBook(join(root.path, '《正常的》某人.txt'), ['第一章 起', '第二章 承']);
  await scanRoot(db, root);
  const r = await scanRoot(db, root);
  assert.equal(r.unchanged, 1, '正常的书不该每次扫描都重解析一遍——那是几分钟的代价');
  assert.equal(r.added + r.updated, 0);
});

test('手工设过章节规则的书，追更覆盖写入之后规则还在', async () => {
  /*
   * **这一条守的是「用户选过的东西不许被自动的那套盖掉」。**
   *
   * 原来的样子：`scanRoot` 走「内容变了」那一档时调
   * `parseAndStore(db, id, path)`，**规则参数一次都没传**，于是每次追更
   * 都重新自动选一遍。而会去手工配规则的，**恰恰就是自动选不对的那些书**——
   * 用户看到的是「我明明设过，怎么又变回去了」。
   */
  const p = join(root.path, '追更的书 作者：某某.txt');
  // 这本书的标题内置规则认得（第N章），但用户偏要按「◆」切
  const 正文 = Array.from({ length: 200 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
  writeFileSync(p, ['第一章 起', '◆ 甲', '第二章 承', '◆ 乙'].map((t) => `${t}\n${正文}\n`).join(''), 'utf8');
  await scanRoot(db, root);

  const bookId = (db.prepare('select id from book limit 1').get() as { id: number }).id;
  const fileId = (db.prepare('select id from book_file where book_id = ?').get(bookId) as { id: number }).id;
  /*
   * 摘掉「前言」再比。第一处命中之前攒够 1 KB 就会立这一章（`chapter.ts` 里
   * 那条已知行为），而这条测试问的是**用了哪条规则**，不是有没有前言——
   * 第一版没摘，报的是「多出来一个『前言』」，看着像规则错了。
   */
  const 标题 = () => (db.prepare('select title from chapter where file_id = ? order by idx').all(fileId) as Array<{ title: string }>)
    .map((r) => r.title).filter((t) => t !== '前言');

  // 自动选的时候用的是内置规则
  assert.deepEqual(标题(), ['第一章 起', '第二章 承'], '一开始该按内置规则切');

  // 用户手工设一条：按「◆」切
  await applyRule(db, bookId, '^◆');
  assert.deepEqual(标题(), ['◆ 甲', '◆ 乙'], '设完该按用户那条切');

  // 追更：内容变了、文件被覆盖写入（多一章）
  writeFileSync(p, ['第一章 起', '◆ 甲', '第二章 承', '◆ 乙', '第三章 转', '◆ 丙'].map((t) => `${t}\n${正文}\n`).join(''), 'utf8');
  utimesSync(p, new Date(), new Date(Date.now() + 60_000));
  await scanRoot(db, root);

  assert.deepEqual(标题(), ['◆ 甲', '◆ 乙', '◆ 丙'],
    '追更之后仍然按用户设的那条切——自动选不许盖掉手工选');
});

test('没设过规则的书，追更之后照旧自动选', async () => {
  // 「依然会自动切换」那一半：这条不能因为上面那条而失效
  const p = join(root.path, '没设规则的书 作者：某某.txt');
  const 正文 = Array.from({ length: 200 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
  writeFileSync(p, ['第一章 起', '第二章 承'].map((t) => `${t}\n${正文}\n`).join(''), 'utf8');
  await scanRoot(db, root);
  const fileId = (db.prepare('select id from book_file limit 1').get() as { id: number }).id;

  writeFileSync(p, ['第一章 起', '第二章 承', '第三章 转'].map((t) => `${t}\n${正文}\n`).join(''), 'utf8');
  utimesSync(p, new Date(), new Date(Date.now() + 60_000));
  await scanRoot(db, root);

  const n = (db.prepare('select count(*) n from chapter where file_id = ?').get(fileId) as { n: number }).n;
  assert.equal(n, 3, '没有手工规则时，追更该重新自动选、认出新的那一章');
});

test('手工指定过编码的书，追更覆盖写入之后编码还在；auto 能解锁', async () => {
  /*
   * 和上面那条章节规则的形状一模一样：`forceEncoding` 是**调用方当场传的**，
   * 用完就没了，而库里存的是**结果**——分不出「探测出来的」还是「用户选的」。
   * 于是追更一覆盖，`scanRoot` 重新探测一遍，用户挑的那个被静默盖掉。
   * 而会去手工挑编码的，恰恰就是探测不准的那些书。
   */
  const p = join(root.path, '编码要指定的书 作者：某某.txt');
  const 正文 = Array.from({ length: 200 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
  writeFileSync(p, ['第一章 起', '第二章 承'].map((t) => `${t}\n${正文}\n`).join(''), 'utf8');
  await scanRoot(db, root);

  const bookId = (db.prepare('select id from book limit 1').get() as { id: number }).id;
  const fileId = (db.prepare('select id from book_file limit 1').get() as { id: number }).id;
  const 现在 = () => db.prepare('select encoding, encoding_locked as locked from book_file where id = ?')
    .get(fileId) as { encoding: string; locked: number };

  assert.equal(现在().locked, 0, '自动探测出来的不该带「用户指定」的记号');

  // 用户手工挑一个（这本书其实是 utf-8，挑 big5 是为了让结果一眼看得出来）
  await reparseBooks(db, [bookId], 'big5');
  assert.equal(现在().encoding, 'big5');
  assert.equal(现在().locked, 1, '手工挑过就要记下来');

  // 追更：内容变了、文件被覆盖写入
  writeFileSync(p, ['第一章 起', '第二章 承', '第三章 转'].map((t) => `${t}\n${正文}\n`).join(''), 'utf8');
  utimesSync(p, new Date(), new Date(Date.now() + 60_000));
  await scanRoot(db, root);
  assert.equal(现在().encoding, 'big5', '追更之后仍然按用户指定的编码——自动探测不许盖掉手工选');

  // **能锁上就得能解开**：挑错一次不能变成死胡同
  await reparseBooks(db, [bookId], 'auto');
  assert.equal(现在().locked, 0, 'auto 该把记号去掉');
  assert.equal(现在().encoding, 'utf-8', '解锁之后重新探测，认回真正的编码');
});

test('没指定过编码的书，追更之后照旧自动探测', async () => {
  const p = join(root.path, '编码不指定的书 作者：某某.txt');
  const 正文 = Array.from({ length: 200 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
  writeFileSync(p, ['第一章 起', '第二章 承'].map((t) => `${t}\n${正文}\n`).join(''), 'utf8');
  await scanRoot(db, root);
  const fileId = (db.prepare('select id from book_file limit 1').get() as { id: number }).id;

  writeFileSync(p, ['第一章 起', '第二章 承', '第三章 转'].map((t) => `${t}\n${正文}\n`).join(''), 'utf8');
  utimesSync(p, new Date(), new Date(Date.now() + 60_000));
  await scanRoot(db, root);

  const r = db.prepare('select encoding, encoding_locked as locked from book_file where id = ?')
    .get(fileId) as { encoding: string; locked: number };
  assert.equal(r.locked, 0);
  assert.equal(r.encoding, 'utf-8', '没锁的时候该照旧探测');
});

test('每个字段都要参与合并——加了字段忘了合并这里就红', () => {
  /*
   * ⚠️ **这条测试守的不是某个字段，是「有没有漏字段」这件事本身。**
   *
   * 原来合并是手写在 `rpc.ts` 的 `doScan` 里的一串 for 循环，漏了
   * `progressGuessed`：`scanRoot` 一直往里填、`App.tsx` 一直在渲染它，
   * 中间那一层把它扔了——于是「有 N 本书重新切章之后进度只能估」那条提示
   * **永远不出现**。不报错、测试全绿、界面上什么都没有。
   *
   * 做法是造一份「每个字段都非空」的报告，合并之后逐个字段确认它没被吃掉。
   * 以后往 `ScanReport` 加字段，只要在这儿的样例里也填上，忘了合并就红。
   */
  const 满的: ScanReport = {
    added: 1, updated: 2, moved: 3, missing: 4, failed: 5, unchanged: 6,
    skipped: { tooSmall: 7, notBook: 8 },
    otherExts: { doc: 9 },
    failures: [{ path: 'a.txt', error: '坏了' }],
    progressGuessed: [{ title: '某书', from: 10, to: 3 }],
  };
  const 空 = (v: unknown): boolean =>
    v === 0 || (Array.isArray(v) && v.length === 0)
    || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

  // **先证伪探针本身**：样例里不该有任何一个空字段，否则这条测试等于没断言
  for (const [k, v] of Object.entries(满的)) {
    assert.equal(空(v), false, `样例里的 ${k} 是空的，这条测试守不住它`);
  }

  const 总 = emptyReport();
  mergeReport(总, 满的);
  for (const k of Object.keys(满的) as Array<keyof ScanReport>) {
    assert.equal(空(总[k]), false, `合并之后 ${k} 还是空的——mergeReport 漏了这个字段`);
  }
  // 数值要真的相加，不是覆盖
  mergeReport(总, 满的);
  assert.equal(总.added, 2);
  assert.equal(总.skipped.notBook, 16);
  assert.equal(总.otherExts.doc, 18);
  assert.equal(总.failures.length, 2);
  assert.equal(总.progressGuessed.length, 2);
});

test('不收的格式要按扩展名报出来，不是静默丢掉', async () => {
  /*
   * 用户库里 16 个 `.doc`、4 个 `.chm` 从来没被提起过一次——
   * `walk` 里那句 `else if (isBookFile(...))` 不符合就直接落空。
   * 「这个格式我们不收」对用户完全不可见，而扫描报告说一切正常。
   */
  const dir = mkdtempSync(join(tmpdir(), 'shuzhai-notbook-'));
  writeFileSync(join(dir, '一本书.txt'), '第一章\n正文'.repeat(400));
  for (const n of ['文档.doc', '帮助.chm', '封面.jpg', '没有扩展名']) {
    writeFileSync(join(dir, n), 'x'.repeat(3000));
  }

  const 不收: string[] = [];
  const 收了: string[] = [];
  for await (const p of walk(dir, {
    recursive: true, maxDepth: 4, ignore: [],
    onOther: (e) => 不收.push(e),
  })) 收了.push(p);

  assert.equal(收了.length, 1);
  assert.ok(收了[0].endsWith('.txt'));
  assert.deepEqual(不收.sort(), ['(无扩展名)', 'chm', 'doc', 'jpg']);
  rmSync(dir, { recursive: true, force: true });
});
