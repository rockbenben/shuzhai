/**
 * rpc 参数校验。
 *
 * 只钉一件事：**参数名写错时必须报错，不能返回「成功」**。
 *
 * 起因是真踩到的——`tag.delete` 要的是 `tagId`，调用方传了 `id`：
 * `Number(undefined)` 是 NaN 而不是抛错，`delete from tag where id = NaN`
 * 一行都不匹配，处理函数照样 `return { ok: true }`。连着两次「删除成功」，
 * 标签一个没少。这张表对外部工具开放（AGENTS.md §13），
 * 而外部调用方最容易错的恰恰是参数名。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../core/db.ts';
import { FileCache } from '../core/reader.ts';
import { createRpc } from './rpc.ts';
import { CONFIRM_THRESHOLD } from '../core/rename.ts';

let dir: string;
let db: DatabaseSync;
let rpc: ReturnType<typeof createRpc>;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'rpc-'));
  db = openDb(join(dir, 'library.db'));
  db.prepare("insert into book(id, title, author) values(1, '雪中悍刀行', '烽火戏诸侯')").run();
  rpc = createRpc(db, new FileCache(), dir);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('参数名写错要抛错，不能静默成功', async () => {
  await rpc['tag.add']!({ bookIds: [1], names: ['玄幻'] });
  const before = (await rpc['tag.list']!(undefined)) as unknown[];
  assert.equal(before.length, 1, '前置：标签建上了');

  // 正确的参数名是 tagId。传 id 的话 Number(undefined) = NaN
  await assert.rejects(
    async () => rpc['tag.delete']!({ id: 1 }),
    /tagId/,
    '参数名写错必须报错——原来这里返回 { ok: true } 而一条都没删',
  );

  const after = (await rpc['tag.list']!(undefined)) as unknown[];
  assert.equal(after.length, 1, '报错之后标签当然还在');

  // 传对了就真的删掉。`confirmed` 是后来加的闸（打在书上的标签删了没有撤销，
  // 见下面那条测试）——这里带上它，才验得到「参数名对了就真的生效」这件事
  const id = (before[0] as { id: number }).id;
  await rpc['tag.delete']!({ tagId: id, confirmed: true });
  assert.equal(((await rpc['tag.list']!(undefined)) as unknown[]).length, 0);
});

test('必填的字符串参数漏了也要抛，不能把 undefined 拼进路径', async () => {
  // `String(undefined)` 是 'undefined' 这个字符串，于是原来会去写
  // `…\036\undefined\书库元数据.csv`，再报一句 ENOENT——
  // **路径里带着 undefined 的文件系统错误，谁也猜不到真正的原因是漏传了 dir**
  await assert.rejects(async () => rpc['export.meta']!({ format: 'csv' }), /dir/);
  await assert.rejects(async () => rpc['export.meta']!({ dir: '', format: 'csv' }), /dir/);
  await assert.rejects(async () => rpc['export.meta']!({ dir: 123, format: 'csv' }), /dir/);
});

test('缺参数、传了不是数字的东西，都要抛', async () => {
  await assert.rejects(async () => rpc['tag.delete']!({}), /tagId/);
  await assert.rejects(async () => rpc['tag.delete']!({ tagId: '不是数字' }), /tagId/);
  await assert.rejects(async () => rpc['tag.delete']!(undefined), /tagId/);
  // 读路径同样：拿不到 bookId 就别往下走
  await assert.rejects(async () => rpc['chapter.read']!({ idx: 0 }), /bookId/);
});

/*
 * 同一件事，落在**铁律 3 的数据**上。
 *
 * `reading.save` 原来三个数字参数全走裸 `Number()`，而 `node:sqlite`
 * 把 NaN **静默绑成 NULL**（不报错、不警告）。外部工具把 `chapterIdx`
 * 写成 `chapterIndex`，结果是 `chapter_idx = NULL` + 一个成功响应，
 * 下次打开这本书 `?? 0` 把它兜成 0——回到第一章，而重扫恢复不了。
 */
test('reading.save 参数名写错要抛错，绝不能把进度写成 NULL', async () => {
  // saveProgress 只 update，不 insert——扫描时才建这一行。
  // 也正因为是 update，NaN 才更危险：它命中的是一条**已经有进度**的行
  db.prepare("insert or ignore into reading_state(book_id, status) values(1, 'reading')").run();
  await rpc['reading.save']!({ bookId: 1, chapterIdx: 300, charOffset: 42 });
  const ok = db.prepare('select chapter_idx, char_offset from reading_state where book_id = 1')
    .get() as { chapter_idx: number; char_offset: number };
  assert.equal(ok.chapter_idx, 300);

  // 写错名字：必须抛，而且**库里那一行一个字都不能变**
  await assert.rejects(
    // **async 箭头函数**：`reading.save` 是同步的，同步抛出不会变成 rejected promise，
    // 写成 `Promise.resolve(fn())` 的话异常在 Promise 建起来之前就跑出去了
    async () => rpc['reading.save']!({ bookId: 1, chapterIndex: 999 }),
    /chapterIdx/,
  );
  const after = db.prepare('select chapter_idx, char_offset from reading_state where book_id = 1')
    .get() as { chapter_idx: number; char_offset: number };
  assert.equal(after.chapter_idx, 300, '进度被改了——这正是最糟的那种失败');
  assert.equal(after.char_offset, 42);
});

test('可选的数字参数：不传用默认值，传了垃圾要抛错', async () => {
  await rpc['reading.save']!({ bookId: 1, chapterIdx: 5 });   // charOffset 不传
  const r = db.prepare('select char_offset from reading_state where book_id = 1')
    .get() as { char_offset: number };
  assert.equal(r.char_offset, 0, '不传就是 0，不是 NULL');

  await assert.rejects(
    async () => rpc['reading.save']!({ bookId: 1, chapterIdx: 5, charOffset: '第三段' }),
    /charOffset/,
  );
});

/*
 * ⚠️ **`Number(null)` 是 0，不是 NaN。**
 *
 * 上一版 `num()` 只判 `Number.isFinite`，于是 null / '' / [] / false / '   '
 * 全都变成一个合法的 0 混了进去。最重的一处是 `reading.save`：
 * 外部工具给没设的字段传 JSON null，`chapter_idx` 就被写成 0，
 * 用户下次打开这本书回到第一章——**铁律 3 的数据，重扫恢复不了**。
 * 上一条测试只覆盖了「参数名写错」（undefined → NaN）那条路，漏了这一整类。
 */
test('null / 空串 / 数组 / false 都不算数字，不许当成 0 混进去', async () => {
  db.prepare("insert or ignore into reading_state(book_id, status) values(1, 'reading')").run();
  await rpc['reading.save']!({ bookId: 1, chapterIdx: 300, charOffset: 42 });

  for (const bad of [null, '', [], false, '   ']) {
    await assert.rejects(
      async () => rpc['reading.save']!({ bookId: 1, chapterIdx: bad }),
      /chapterIdx/,
      `chapterIdx = ${JSON.stringify(bad)} 应当被挡下`,
    );
  }
  const after = db.prepare('select chapter_idx, char_offset from reading_state where book_id = 1')
    .get() as { chapter_idx: number; char_offset: number };
  assert.equal(after.chapter_idx, 300, '进度被写成 0 了——这正是最糟的那种失败');
  assert.equal(after.char_offset, 42);
});

/*
 * 撤销改名**也是真的在改磁盘文件**，一样要过总开关。
 * 原来 `rename.apply` / `version.deleteFiles` / `version.keepOnly` 三处都挡了，
 * 只有 `rename.undo` 漏了——而 `rename.apply` 的注释写着
 * 「只挡界面的话这条 rpc 就是后门」，那就是那个后门。
 */
test('总开关关掉时，撤销改名也要被挡下', async () => {
  db.prepare("insert into app_setting(key, value) values('rename.enabled', '0') "
    + 'on conflict(key) do update set value = excluded.value').run();
  await assert.rejects(async () => rpc['rename.undo']!({ batchId: 'whatever' }), /允许改文件名/);
  db.prepare("update app_setting set value = '1' where key = 'rename.enabled'").run();
});

/*
 * **超过阈值要先确认过——这条原来只活在界面里。**
 *
 * spec §3.3 把「超 50 个二次确认」列为安全阀，而 `CONFIRM_THRESHOLD` 在 core 里
 * 一直**只有一个声明、从来没被用过**：真正拦人的是 `RenameDialog` 自己抄的第二份。
 * 于是走 rpc 进来（AGENTS.md §13 明说这条路对外开放）一次改五百个文件，
 * 一道确认都没有——而 `rename_log` 只留最近 20 批，超出就找不回来了。
 *
 * 判据有两条，第二条才是重点：**光「抛了错」不够，得说清楚怎么办**。
 * 同 `reader.ts` 的 `openHint`——只把英文换成中文等于没修。
 */
test('改名超过阈值时，没带 confirmed 一律拒绝，并且说清楚怎么办', async () => {
  db.prepare("insert or replace into app_setting(key, value) values('rename.enabled', '1')").run();
  const rows = Array.from({ length: CONFIRM_THRESHOLD + 1 }, (_, i) => ({
    fileId: i + 1, bookId: 1, from: `a${i}.txt`, to: `b${i}.txt`, status: 'ok',
  }));
  await assert.rejects(
    async () => rpc['rename.apply']!({ rows }),
    (e: Error) => /确认/.test(e.message) && /rename\.preview/.test(e.message),
    '超阈值该拒的没拒，或者报错里没说怎么办',
  );
  // 阈值以内不该被这道闸拦住（会走到别处去，但不能是「要先确认」）
  await assert.rejects(
    async () => rpc['rename.apply']!({ rows: rows.slice(0, CONFIRM_THRESHOLD) }),
    (e: Error) => !/要先确认/.test(e.message),
    '阈值以内被误拦了',
  );
});

/*
 * **合并标签要显式确认过——安全阀不能只活在界面里。**
 *
 * 「改名撞上已有的名字＝合并」是有意的，但合并**不可撤销**（两个标签变成一个，
 * `book_tag` 的行并过去就回不来了，和删除同一档）。界面上有一道确认，
 * 而 rpc 对外开放（AGENTS.md §13）——外部工具一句 `tag.rename` 就能悄悄并掉两个。
 * 同 `rename.apply` 那条二次确认，形状一模一样。
 *
 * 三条断言，最后一条是重点：**被拒之后两个标签都还在**——
 * 最糟的失败是「报了错，而标签已经并掉了」。
 */
test('改名撞上已有的名字时，没带 confirmMerge 一律拒绝', async () => {
  await rpc['tag.add']!({ bookIds: [1], names: ['甲标签', '乙标签'] });
  const list = (await rpc['tag.list']!(undefined)) as Array<{ id: number; name: string }>;
  const jia = list.find((t) => t.name === '甲标签')!;

  await assert.rejects(
    async () => rpc['tag.rename']!({ tagId: jia.id, name: '乙标签' }),
    (e: Error) => /合并/.test(e.message) && /confirmMerge/.test(e.message),
    '该拒的没拒，或者报错里没说怎么办',
  );
  const still = (await rpc['tag.list']!(undefined)) as Array<{ name: string }>;
  assert.ok(still.some((t) => t.name === '甲标签'), '被拒之后两个标签都该还在');
  assert.ok(still.some((t) => t.name === '乙标签'));

  // 改成一个不存在的名字不用确认——那只是改名
  await rpc['tag.rename']!({ tagId: jia.id, name: '丙标签' });
  const after = (await rpc['tag.list']!(undefined)) as Array<{ name: string }>;
  assert.ok(after.some((t) => t.name === '丙标签'));
});

/*
 * **删标签要显式确认过——这是「安全阀只活在界面里」的第三处。**
 *
 * 打在书上的标签删掉就没了：`book_tag` 的行没有日志、没有撤销
 * （删文件那条路好歹进回收站，这条连回收站都没有）。界面上有两段式确认，
 * 而 rpc 对外开放（AGENTS.md §13），外部工具传错一个 tagId，
 * 几百本书上的标签就一起没了。
 *
 * 三条断言，最后一条是重点：**被拒之后关联一条都没少**。
 */
test('删标签时，没带 confirmed 一律拒绝；空标签不用确认', async () => {
  await rpc['tag.add']!({ bookIds: [1], names: ['要删的'] });
  const list = (await rpc['tag.list']!(undefined)) as Array<{ id: number; name: string; count: number }>;
  const t = list.find((x) => x.name === '要删的')!;

  await assert.rejects(
    async () => rpc['tag.delete']!({ tagId: t.id }),
    (e: Error) => /本书上/.test(e.message) && /confirmed/.test(e.message),
    '该拒的没拒，或者报错里没说有几本书、下一步怎么办',
  );
  const still = (await rpc['tag.list']!(undefined)) as Array<{ name: string; count: number }>;
  assert.equal(still.find((x) => x.name === '要删的')?.count, 1, '被拒之后关联一条都不该少');

  // 空标签不用确认：删掉一个没打在任何书上的，什么都不会丢
  await rpc['tag.remove']!({ bookIds: [1], tagId: t.id });
  await rpc['tag.delete']!({ tagId: t.id });
  const after = (await rpc['tag.list']!(undefined)) as Array<{ name: string }>;
  assert.ok(!after.some((x) => x.name === '要删的'));
});

/*
 * **移掉一个还有书的书库文件夹，要显式确认过。**
 *
 * `root.remove` 只把 `root_id` 置空、不删记录（怕丢阅读进度，这是对的），
 * 但那些记录从此**谁也管不到**：扫描遍历不到、文件没了也标不上，
 * 在书架上装作一切正常，点开才报 ENOENT（AGENTS.md 那节记着这个形状）。
 * 真实库里那个文件夹装着 8172 本——一次误点就是整个书库进入这种状态，
 * 而它原来**界面和 rpc 两边都没有一句确认**。
 *
 * 空文件夹（刚加错路径想撤掉）不用问。
 */
test('移除还有书的书库文件夹要 confirmed；空文件夹不用', async () => {
  const rootId = Number(
    db.prepare("insert into library_root(path) values('D:/tmp/somewhere')").run().lastInsertRowid,
  );
  db.prepare(
    `insert into book_file(book_id, root_id, path, size, mtime, is_primary)
     values(1, ?, 'D:/tmp/somewhere/a.txt', 1, 1, 1)`,
  ).run(rootId);

  await assert.rejects(
    async () => rpc['root.remove']!({ id: rootId }),
    (e: Error) => /个文件/.test(e.message) && /confirmed/.test(e.message),
    '该拒的没拒，或者报错里没说有几个文件、怎么救回来',
  );
  assert.equal(
    (db.prepare('select count(*) n from library_root where id = ?').get(rootId) as { n: number }).n,
    1,
    '被拒之后那个文件夹还得在',
  );
  assert.equal(
    (db.prepare('select count(*) n from book_file where root_id = ?').get(rootId) as { n: number }).n,
    1,
    '被拒之后一条记录都不许变成孤儿',
  );

  await rpc['root.remove']!({ id: rootId, confirmed: true });
  assert.equal(
    (db.prepare('select count(*) n from library_root where id = ?').get(rootId) as { n: number }).n, 0,
  );

  // 空文件夹不用确认
  const empty = Number(
    db.prepare("insert into library_root(path) values('D:/tmp/empty')").run().lastInsertRowid,
  );
  await rpc['root.remove']!({ id: empty });
  assert.equal(
    (db.prepare('select count(*) n from library_root where id = ?').get(empty) as { n: number }).n, 0,
  );
});


/*
 * `ignore.globForDir` 拿每个书库根轮着试，试不中就换下一个——**它必须只吞
 * 「不在这个根下面」这一种**。改之前它 `catch {}` 吞掉一切，于是
 * 「文件夹名里的 `{…,…}` 表达不了」那句话**永远到不了用户面前**，
 * 用户看到的是一句说的不是真正那一样的「不在任何书库文件夹下面」。
 */
test('globForDir：只吞「不在这个根下面」，别的错要原样报出去', async () => {
  const lib = join(dir, 'globbooks');
  mkdirSync(lib, { recursive: true });
  db.prepare('insert into library_root(path) values(?)').run(lib);

  // ① 正常目录：出规则，而且元字符转义过
  const ok = (await rpc['ignore.globForDir']!({ dir: join(lib, '[完结]') })) as { pattern: string };
  assert.equal(ok.pattern, '[[]完结]/**');

  // ② 名字表达不了：**要说真正的原因**，不能被那个循环吞成「不在书库下面」
  await assert.rejects(
    async () => rpc['ignore.globForDir']!({ dir: join(lib, '{完结,精校}') }),
    /表达不了/,
  );

  // ③ 真的不在书库下面：还是那句话
  await assert.rejects(
    async () => rpc['ignore.globForDir']!({ dir: join(dir, '别处') }),
    /不在任何书库文件夹下面/,
  );
});

/*
 * **同一时刻只跑一次扫描。**
 *
 * 扫描有三个互相不知道的入口：用户点「扫描」、定时扫描、文件监听。
 * 而 `scanRoot` 是 async 的、大库上一百多秒——两次撞上就会交错。
 * 当场量过（6 个文件并发跑两次）：`book_file` 6 行是对的，
 * **而 `book` 变成 12 行**（六条幻影书，界面上是「只有记录」的重复条目），
 * 两次报告一个说「新增 4 缺失 2」、一个说「新增 2 缺失 4」——
 * **而磁盘上六个文件一个没少**。「缺失」是说给用户的一句假话，还会把书标红。
 */
test('并发扫同一片：只干一次活，不造幻影书、不报假的缺失', async () => {
  const lib = join(dir, 'racebooks');
  mkdirSync(lib, { recursive: true });
  db.prepare('insert into library_root(path) values(?)').run(lib);
  const filler = Array.from({ length: 400 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
  for (let i = 1; i <= 4; i++) {
    writeFileSync(join(lib, `《并发${i}》某人.txt`), `第一章 起\n${filler}\n第二章 承\n${filler}\n`, 'utf8');
  }

  const 之前 = (db.prepare('select count(*) n from book').get() as { n: number }).n;
  //  直接回 ScanReport，不是 { report }
  const [a, b] = await Promise.all([
    rpc['library.scan']!({}) as Promise<{ added: number; missing: number }>,
    rpc['library.scan']!({}) as Promise<{ added: number; missing: number }>,
  ]);

  const files = (db.prepare('select count(*) n from book_file where path like ?').get(`${lib}%`) as { n: number }).n;
  const books = (db.prepare('select count(*) n from book').get() as { n: number }).n - 之前;
  assert.equal(files, 4, '磁盘上就 4 个文件');
  assert.equal(books, 4, `并发扫出了 ${books} 条 book 记录——多出来的是幻影书`);
  assert.equal(a.missing + b.missing, 0, '文件一个没少，不该报「缺失」');
  // 两次拿到的是同一份报告（第二次跟着第一次走，没重复干活）
  assert.equal(a.added, b.added);
});

/*
 * **并发建同一本书的索引会让 FTS 行数翻倍**——那本书里每次搜索都出双份。
 *
 * 「重复建不翻倍」那条判据（`search.test.ts` 钉着）只在**顺序**建时成立：
 * 它是「先删这本书的旧条目再插」，两次交错时两边都先删了、再各插一遍。
 * 而界面上那是个按钮，双击就并发了。
 */
test('并发建同一本书的索引：不翻倍', async () => {
  const lib = join(dir, 'idxbooks');
  mkdirSync(lib, { recursive: true });
  db.prepare('insert into library_root(path) values(?)').run(lib);
  const filler = Array.from({ length: 400 }, () => '风雪夜归人，孤灯照旧影。').join('\n');
  writeFileSync(join(lib, '《测索引》某人.txt'), `第一章 起\n${filler}\n第二章 承\n${filler}\n`, 'utf8');
  await rpc['library.scan']!({});

  const bookId = (db.prepare('select id from book where title = ?').get('测索引') as { id: number }).id;
  const 行数 = () => (db.prepare('select count(*) n from chapter_fts where book_id = ?').get(bookId) as { n: number }).n;

  await rpc['search.buildIndex']!({ bookIds: [bookId] });
  const 单次 = 行数();
  assert.equal(单次, 2, '两章就该两行');

  await Promise.all([
    rpc['search.buildIndex']!({ bookIds: [bookId] }),
    rpc['search.buildIndex']!({ bookIds: [bookId] }),
  ]);
  assert.equal(行数(), 单次, `并发建完变成 ${行数()} 行——搜出来会是双份`);
});

/*
 * ── 数组参数缺了要说人话 ──────────────────────
 *
 * 这条是**打包验证逆推出来的**：往打好的包里发一句
 * `{"method":"highlight.tag","params":{}}`，回来的是
 * `Cannot read properties of undefined (reading 'map')`——而旁边两个方法
 * 回的是「参数 bookId 缺失或者不是数字」。
 *
 * rpc 是对外开放的（§13），而这个仓库明文反对让实现细节进用户可见的报错
 * （渲染进程 `rpc.ts` 那个 `humanize` 就是为这个写的）。
 *
 * 当时全库有 9 处同一形状，而里面好几条是**真会写盘的**
 * （批量改书、批量重命名、合并）。
 */
test('数组参数缺了或者不是数组，要报人话不是 JS 内部错', async () => {
  for (const [方法, 键] of [
    ['highlight.tag', 'ids'],
    ['highlight.untag', 'ids'],
    ['tag.add', 'bookIds'],
    ['tag.remove', 'bookIds'],
    ['book.batchUpdate', 'bookIds'],
    ['version.merge', 'bookIds'],
  ] as Array<[string, string]>) {
    for (const 坏 of [{}, { [键]: null }, { [键]: 7 }, { [键]: 'a,b' }]) {
      await assert.rejects(
        async () => rpc[方法]!(坏),
        (e: Error) => {
          assert.match(e.message, new RegExp(键), `${方法} 的报错要提到是哪个参数：${e.message}`);
          assert.doesNotMatch(
            e.message, /Cannot read propert|undefined is not|is not a function/,
            `${方法} 把 JS 内部错泄给了调用方：${e.message}`,
          );
          return true;
        },
        `${方法} 收到 ${JSON.stringify(坏)} 该报错`,
      );
    }
  }
});
