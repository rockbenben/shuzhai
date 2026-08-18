/**
 * 在真实书库上找**自相矛盾的记录**。只读，一个字都不写。
 *
 *   node scripts/integrity.mjs                 # 默认 %APPDATA%/shuzhai/library.db
 *   node scripts/integrity.mjs <别的库.db>
 *
 * **为什么要有它**：这个仓库反复栽在「派生字段脱节」上——状态是想读却有读完时间、
 * 进度条还满格那一族。单元测试挡得住新写的代码，**挡不住已经躺在库里的那些行**，
 * 而那些行只有在真实数据上才看得见（测试库 8 本永远撞不到）。
 *
 * 它头两轮的战绩，都是「不报错所以没人发现」的那种：
 *   - 一本「已读完」的书进度停在 89.7%（`saveProgress` 无条件写 percent，
 *     而 status 只升不降），卡片上顶着「读完」角标还画着一根进度条；
 *   - **774 本有封面的书里 771 本的 `cover_path` 指着一个已经不存在的目录**
 *     ——数据目录搬家只 rename 了 covers 目录，没改写这一列。图片一直好好地
 *     躺在新目录里，而书架上是一整墙占位封面（迁移 18 收拾的就是这个）。
 *
 * **每一条查询就是一句不变式**，所以查出东西就是退出码 1，不是「参考信息」。
 * （同 `counts.mjs` 的区别：那个数的是会正常变的数，这个查的是不该成立的事。）
 *
 * 开头有**自检**：往一个临时库里造一行明知有毛病的记录，同一批判据认不出来
 * 就当场退出——不然判据写坏时它会一边报「全都干净」一边什么都没查
 * （`dead-fields` / `dead-mounts` / `stale-refs` 都为这条补过诱饵）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/core/db.ts';

/** 每条都是「不该有的行」。名字写成人话，因为报出来是给人看的 */
const CHECKS = [
  ['读完了，进度却不是 100', "select 1 from reading_state where status='finished' and ifnull(percent,0) != 100"],
  ['没读完，却留着读完时间', "select 1 from reading_state where status!='finished' and finished_at is not null"],
  // 「我的书评」那一档按 rated_at 排，没有它的评价会沉到最后、等于消失
  ['有评价内容，却没有评价时间', "select 1 from reading_state where (rating is not null or ifnull(comment,'')!='') and rated_at is null"],
  ['有评价时间，却什么都没写', "select 1 from reading_state where rated_at is not null and rating is null and ifnull(comment,'')=''"],
  ['不是弃坑，却留着弃坑原因', "select 1 from reading_state where status!='dropped' and ifnull(drop_reason,'')!=''"],
  ['评分超出 0-5', 'select 1 from reading_state where rating is not null and (rating < 0 or rating > 5)'],
  ['短评只有空白', "select 1 from reading_state where comment is not null and trim(comment)=''"],
  ['划线笔记只有空白', "select 1 from highlight where note is not null and trim(note)=''"],
  ['标签名前后带空白', 'select 1 from tag where name != trim(name)'],
  ['一本书上同一个标签两条', 'select 1 from book_tag group by book_id, tag_id having count(*) > 1'],
  ['book_tag 指向不存在的书或标签', 'select 1 from book_tag bt left join book b on b.id=bt.book_id left join tag t on t.id=bt.tag_id where b.id is null or t.id is null'],
  /*
   * PDF / EPUB 读到第几页存在 `app_setting` 的 `viewer.<bookId>` 里——**不是一张表**，
   * 所以没有外键、`on delete cascade` 也管不着它。管书的那几处
   * （备份 / 删除 / 整理 / 合并）都已经单独认得它了，这一条是**兜底**：
   * 哪天又冒出一条删书的路径没跟上，这里会看见一行指向不存在的书的设置。
   */
  ['viewer.<id> 指向不存在的书', "select 1 from app_setting s where s.key like 'viewer.%' and not exists (select 1 from book b where 'viewer.' || b.id = s.key)"],
  /*
   * **自建目录**（`outline.<bookId>`，迁移 24）是**第二个按 id 命名的设置**，
   * 形状和上一条一模一样，所以兵底也要一模一样。
   * ⚠️ 它刚加进来时这一条就漏了——全量审计量出来的，
   * 同一次还漏了 `deletion.ts` / `library.ts` / `versions.ts` 三处。
   */
  ['outline.<id> 指向不存在的书', "select 1 from app_setting s where s.key like 'outline.%' and not exists (select 1 from book b where 'outline.' || b.id = s.key)"],
  /*
   * 笔记的标签（`highlight_tag`，迁移 23）。形状拄 `book_tag` 那一条：
   * 两边外键都带 `on delete cascade`，所以这条平时应该恒为 0；
   * 不为 0 就说明有人绕过了外键（比如 §13 那条外部写入的路）。
   */
  ['highlight_tag 指向不存在的划线或标签', 'select 1 from highlight_tag ht left join highlight h on h.id=ht.highlight_id left join tag t on t.id=ht.tag_id where h.id is null or t.id is null', ['highlight_tag']],
  /*
   * **矩形摘录的坐标得是四个 0–1 的数**（迁移 22）。
   * 前门（`addHighlight`）和备份那头（`sanitizeMark`）都走 `解析矩形` 校验过，
   * 这一条兵的是 **§13 那条外部写入的路**：坐标坏了不报错，
   * 只是在页上画出一个位置乱七八糟的框。SQL 里拆四段比 JS 那份笨，
   * 但它只需要答「对不对」不需要答「是多少」。
   */
  ['框选的坐标不是四个 0-1 的数', "select 1 from highlight where rect is not null and (rect not like '%,%,%,%' or rect like '%,%,%,%,%' or cast(substr(rect, 1, instr(rect, ',') - 1) as real) < 0 or cast(substr(rect, 1, instr(rect, ',') - 1) as real) > 1)", ['highlight', 'rect']],
  // 一本书恰好一个主文件：卡片上的字数章节数、阅读器读哪个文件，全看它
  ['一本书有两个以上主文件', 'select book_id from book_file group by book_id having sum(is_primary) > 1'],
  ['有文件却一个主文件都没有', 'select book_id from book_file group by book_id having sum(is_primary) = 0'],
  ['两条记录指向同一个磁盘路径', 'select path from book_file group by path having count(*) > 1'],
  /*
   * 「一切正常」而**从来没解析过**——那本书点开是空的，而它不在任何「有问题」的档里。
   * 真实库里逮到过一本：7.1 MB、`parsed_at` 是 null，当场试解析 204 毫秒切出 1624 章。
   * 根因是扫描的「size + mtime 没变就跳过」那一档不看解析过没有（已修）。
   */
  ["标着 ok 却从来没解析过", "select 1 from book_file where status = 'ok' and parsed_at is null"],
  // 章节表是派生数据（重解析就有），但它错了用户是**看得见**的：
  // 数对不上 → 目录条数不对；offset 越界 → 阅读器按字节读到的是垃圾
  ['章节表的行数和 chapter_count 对不上', 'select 1 from book_file f where ifnull(f.chapter_count,0) != (select count(*) from chapter c where c.file_id = f.id)'],
  ['章节的 offset+length 超出文件大小', 'select 1 from chapter c join book_file f on f.id = c.file_id where c.offset + c.length > f.size'],
  // 下面三条要主文件的章节数，章节数为 0（没解析过、或只编目的格式）的一律跳过
  ['读到的章号超过这本书的章节数', 'select 1 from reading_state r join book_file f on f.book_id=r.book_id and f.is_primary=1 where ifnull(f.chapter_count,0)>0 and ifnull(r.chapter_idx,0) >= f.chapter_count'],
  ['书签指向不存在的章', 'select 1 from bookmark m join book_file f on f.book_id=m.book_id and f.is_primary=1 where ifnull(f.chapter_count,0)>0 and m.chapter_idx >= f.chapter_count'],
  ['划线指向不存在的章', 'select 1 from highlight h join book_file f on f.book_id=h.book_id and f.is_primary=1 where ifnull(f.chapter_count,0)>0 and h.chapter_idx >= f.chapter_count'],
];

/**
 * 跑一遍。
 *
 * ⚠️ **库可能比代码旧。** 这是个**只读**工具，它不跑迁移；
 * 而用户的库只有在应用自己启动时才会升级。实测就栓在这里：
 * 刚加了 `highlight_tag`（迁移 23）的判据，而真实库还停在 21，
 * 一句 `no such table` 把**整个体检炸掉**——剩下二十多条一条都没跑成。
 *
 * 所以表不在就**跳过并说一声**，不是静默当它过了：
 * 「这条没查」和「这条查了是 0」是两回事（同这个仓库那条
 * 「工具静默地什么都没做，看起来和没问题一模一样」）。
 */
const 有表 = (db, t) =>
  db.prepare("select count(*) n from sqlite_master where type='table' and name=?").get(t).n > 0;
/** ⚠️ **列也算。** 第一版只看了表，结果在 `rect`（迁移 22 加的**列**）上又炋了一次 */
const 有列 = (db, t, c) =>
  有表(db, t) && db.prepare(`pragma table_info(${t})`).all().some((x) => x.name === c);

/**
 * 跑一遍。第三个元素是可选的**前置**：`[表]` 或 `[表, 列]`——
 * 不在就返回 `null`（「没查」），而不是 0（「查了，干净」）。
 */
const run = (db) => CHECKS.map(([name, sql, 前置]) => {
  if (前置 && !(前置.length === 1 ? 有表(db, 前置[0]) : 有列(db, 前置[0], 前置[1]))) return [name, null];
  return [name, db.prepare(`select count(*) n from (${sql})`).get().n];
});

/**
 * 记录对不对得上**磁盘**：上面那些查的是「记录和记录」，这一条查「记录和文件」。
 *
 * `book_file.path` 指向用户自己的书库，文件不在是正常的（改名、拔移动硬盘），
 * 那是 `file_status` 的活，不在这儿判。`cover_path` 不一样——它指向的是
 * **应用自己拷进 userData 的文件**，不在就是我们自己的账没记对。
 */
function coverCheck(db) {
  const rows = db.prepare("select cover_path p from book where cover_path is not null and trim(cover_path) != ''").all();
  const gone = rows.filter((r) => !existsSync(r.p)).length;
  return [`封面文件不在了（共 ${rows.length} 本有封面）`, gone];
}

// ── 自检：判据还认得出坏东西吗 ────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'shuzhai-integ-'));
  try {
    const db = openDb(join(dir, 'library.db'));
    const bookId = Number(db.prepare("insert into book(title) values('诱饵')").run().lastInsertRowid);
    // 一行踩三条：读完了却 50%、不是弃坑却留着原因、有评价内容却没有评价时间
    db.prepare(
      `insert into reading_state(book_id, status, percent, rating, comment, drop_reason)
       values(?, 'finished', 50, 4, '写了一句', '不该留着的原因')`,
    ).run(bookId);
    // 再造一条封面路径指向不存在的文件
    db.prepare("update book set cover_path = ? where id = ?").run(join(dir, '压根没有这个文件.jpg'), bookId);
    // 再造一行指向不存在的书的阅读位置（那本书 id 谁都不会有）
    db.prepare("insert into app_setting(key, value) values('viewer.999999', '42')").run();

    const hit = run(db).filter(([, n]) => n > 0).map(([name]) => name);
    const [, coverGone] = coverCheck(db);
    db.close();

    const 该抓的 = ['读完了，进度却不是 100', '不是弃坑，却留着弃坑原因', '有评价内容，却没有评价时间', 'viewer.<id> 指向不存在的书'];
    const 漏了 = 该抓的.filter((x) => !hit.includes(x));
    if (漏了.length || coverGone !== 1) {
      console.error(`✗ 自检没过：造了一行明知有毛病的记录，这几条判据没认出来 → ${[...漏了, coverGone !== 1 ? '封面文件不在了' : ''].filter(Boolean).join('、')}`);
      process.exit(2);
    }
    console.log('自检通过：造出来的坏记录，该抓的五条都抓住了');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 正戏 ──────────────────────────────────────────────
const path = process.argv[2] ?? join(process.env.APPDATA ?? '', 'shuzhai', 'library.db');
const db = new DatabaseSync(path, { readOnly: true });
const books = db.prepare('select count(*) n from book').get().n;
const states = db.prepare('select count(*) n from reading_state').get().n;
console.log(`\n${path}\n${books} 本书 / ${states} 行阅读状态\n`);

let bad = 0;
let 跳过 = 0;
for (const [name, n] of [...run(db), coverCheck(db)]) {
  // `null` = 这一条靠的表在这个库里还不存在（库比代码旧）。
  // **写成「– 跳过」而不是 0**：没查和查了是 0 是两回事
  if (n === null) { 跳过++; console.log(`  –     –  ${name}（这个库还没有这张表，库比代码旧）`); continue; }
  if (n > 0) bad++;
  console.log(`  ${n ? '✗' : '✔'} ${String(n).padStart(5)}  ${name}`);
}
if (跳过) console.log(`
– ${跳过} 条没查：库里还没那张表。开一次应用让它跑完迁移再量一遍。`);
db.close();

console.log(bad ? `\n✗ ${bad} 类对不上。查是哪几本：把上面那条 sql 里的 select 1 换成 select *` : '\n✔ 全都对得上');
process.exit(bad ? 1 : 0);
