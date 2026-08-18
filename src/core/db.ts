// 数据库（spec §11）。
//
// **用 Node 自带的 `node:sqlite`，不用 better-sqlite3。** Electron 40+ 直接自带
// Node 24（43 稳定版是 24.18.1），38/39 是 22.22，都 ≥ 22.5，这个模块全都有。
// 于是原生模块、`@electron/rebuild`、`asarUnpack` 整条链都不需要了。
//
// ⚠️ **只读连接的选项名是 `readOnly`，大写 O。** 写成 `readonly` 不会报错、
// 也不会有任何提示，你会拿到一个**可写**的连接——实测写进去了。
// `/api/query` 的只读保证全靠这一个字母。**钉它的是 `src/server/api.test.ts`**——
// 一条断言正确写法真的写不进去，另一条**故意用错误写法证明它可写**，
// 免得哪天有人觉得第一条多余把它删了。

import { DatabaseSync } from 'node:sqlite';

/**
 * 迁移数组，下标即版本号。**只能往后追加，不能改已有项**——
 * 用户机器上的 `reading_state` / `bookmark` / `rename_log` 重扫恢复不了（AGENTS.md 铁律 3）。
 *
 * 别学「往 CREATE TABLE 里加一列」那种改法：对已经建过表的库那是空操作，
 * 表还在，新列不会出现，读它的代码要到运行时才撞上 `no such column`。加列就得新写一条迁移。
 */
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  (db) =>
    db.exec(`
      create table library_root(
        id integer primary key,
        path text not null unique,
        enabled integer not null default 1,
        recursive integer not null default 1,
        max_depth integer not null default 8,
        created_at text not null default (datetime('now'))
      );

      create table book(
        id integer primary key,
        title text not null,
        author text,
        aliases text,
        intro text,
        cover_path text,
        serial_status text not null default 'unknown',
        source_site text,
        note text,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now'))
      );

      create table book_file(
        id integer primary key,
        book_id integer not null references book(id) on delete cascade,
        root_id integer references library_root(id) on delete set null,
        path text not null unique,
        size integer not null,
        mtime integer not null,
        content_hash text,
        encoding text,
        is_primary integer not null default 0,
        status text not null default 'ok',
        word_count integer,
        chapter_count integer,
        parsed_at text
      );
      create index idx_book_file_book on book_file(book_id);
      create index idx_book_file_hash on book_file(content_hash);

      create table chapter(
        id integer primary key,
        file_id integer not null references book_file(id) on delete cascade,
        idx integer not null,
        volume text,
        title text not null,
        offset integer not null,
        length integer not null
      );
      create index idx_chapter_file on chapter(file_id, idx);

      -- 阅读状态挂在 book 上而不是 book_file 上：换版本、文件被覆盖更新，进度都不丢（spec §11 末）
      create table reading_state(
        book_id integer primary key references book(id) on delete cascade,
        /*
         * ⚠ 这个 default 'want' 是历史遗留，**别靠它**。今天扫描和手工添书
         * 都显式写 'none'（scan.ts / manual.ts），第 17 条迁移还专门把八千条
         * 假的「想读」清成了 none——理由写在那条迁移上面：「想读」是用户说的话，
         * 扫进来的书没表过态。
         *
         * 现在有东西真的靠这个区分：repairLibrary 的孤儿判据认
         * 「status 不是 none 就是用户表过态，留着」。谁再写一条不带 status 的
         * insert，那本书就会带着一句它自己没说过的「想读」，而且从此清不掉。
         * 默认值没改成 none，是因为改它要重建 reading_state 整张表——
         * 那是这个库里最不能出事的一张（铁律 3），为一个没人走的分支不值当。
         *
         * （这段话里一个反引号都没有：整个 create table 在一个模板字符串里，
         * 反引号会当场把它截断。这个坑本仓库踩到第九次了。）
         */
        status text not null default 'want',
        chapter_idx integer not null default 0,
        char_offset integer not null default 0,
        global_offset integer not null default 0,
        percent real not null default 0,
        rating real,
        comment text,
        drop_reason text,
        reread_count integer not null default 0,
        last_read_at text,
        finished_at text
      );
    `),

  // 2：章节解析规则（spec §2.2 的规则编辑器 / §11 的 parse_rule）
  (db) =>
    db.exec(`
      create table parse_rule(
        id integer primary key,
        name text not null,
        pattern text not null,
        priority integer not null default 0,
        enabled integer not null default 1,
        scope text not null default 'book',
        book_id integer references book(id) on delete cascade
      );
      create index idx_parse_rule_book on parse_rule(book_id);
    `),

  // 3：重命名操作日志（spec §3.3）。**这张表是撤销的唯一依据**，
  // 而重命名是唯一会改用户磁盘文件的功能——日志丢了就撤不回来了。
  (db) =>
    db.exec(`
      create table rename_log(
        id integer primary key,
        batch_id text not null,
        file_id integer references book_file(id) on delete set null,
        old_path text not null,
        new_path text not null,
        renamed_at text not null default (datetime('now')),
        undone integer not null default 0
      );
      create index idx_rename_log_batch on rename_log(batch_id, id);
    `),

  // 4：应用设置。键值表，够用——为每个开关加一列迟早要写一堆迁移
  (db) =>
    db.exec(`
      create table app_setting(
        key text primary key,
        value text not null
      );
    `),

  // 5：分类树、标签、智能书架（spec §3.1 / §7）
  //
  // ⚠️ 这里有一条 **ALTER TABLE**：`book.category_id`。
  // 迁移 1 建 book 表时没这一列，而往那条 `create table` 里补一列对**已经建过库的人
  // 是空操作**——表已经在了，新列不会出现，读它的代码要到运行时才撞上 no such column。
  // 加列只能这么加。
  (db) =>
    db.exec(`
      create table category(
        id integer primary key,
        parent_id integer references category(id) on delete cascade,
        name text not null,
        sort_order integer not null default 0
      );

      create table tag(
        id integer primary key,
        name text not null unique
      );

      create table book_tag(
        book_id integer not null references book(id) on delete cascade,
        tag_id integer not null references tag(id) on delete cascade,
        primary key (book_id, tag_id)
      );

      create table smart_shelf(
        id integer primary key,
        name text not null,
        filter_json text not null,
        created_at text not null default (datetime('now'))
      );

      alter table book add column category_id integer references category(id) on delete set null;
    `),

  // 6：正文清洗规则（spec §2.4 / §11 的 clean_rule）。
  // 规则是**运行时套用**的，原 txt 一个字节都不改
  (db) =>
    db.exec(`
      create table clean_rule(
        id integer primary key,
        name text not null,
        pattern text not null,
        replacement text not null default '',
        enabled integer not null default 1,
        scope text not null default 'global',
        book_id integer references book(id) on delete cascade,
        sort_order integer not null default 0
      );
      create index idx_clean_rule_book on clean_rule(book_id);
    `),

  // 7：全文索引（spec §7）。**可关闭**，关掉就把表清空以省空间。
  //
  // 用 trigram 分词器：默认的 unicode61 会把一整段中文当成**一个词**，
  // 搜「提剑」永远命中不了「少年提剑出门」。trigram 把中文切成三字窗口，
  // 代价是**查询至少要 3 个字**——不够长时 search.ts 会回落到 LIKE，
  // 否则用户搜两个字得到的「无结果」是句假话。
  (db) =>
    db.exec(`
      create virtual table chapter_fts using fts5(
        content,
        book_id unindexed,
        chapter_idx unindexed,
        tokenize='trigram'
      );
    `),

  // 8：书签与阅读会话（spec §5）。**这两张和 reading_state 一样是不可再生数据**，
  // 重扫恢复不了，动它们的 schema 必须写新迁移
  (db) =>
    db.exec(`
      create table bookmark(
        id integer primary key,
        book_id integer not null references book(id) on delete cascade,
        chapter_idx integer not null,
        char_offset integer not null default 0,
        excerpt text,
        note text,
        created_at text not null default (datetime('now'))
      );
      create index idx_bookmark_book on bookmark(book_id, chapter_idx);

      create table reading_session(
        id integer primary key,
        book_id integer not null references book(id) on delete cascade,
        started_at text not null,
        ended_at text,
        from_percent real,
        to_percent real
      );
      create index idx_session_book on reading_session(book_id, id);
    `),

  // 9：在线地址（spec §4 / §11 的 online_link）。**只管地址，不抓正文**
  (db) =>
    db.exec(`
      create table online_link(
        id integer primary key,
        book_id integer not null references book(id) on delete cascade,
        url text not null,
        site text,
        is_primary integer not null default 0,
        note text,
        last_status text,
        last_checked_at text,
        latest_chapter_title text,
        latest_checked_at text,
        selector text
      );
      create index idx_link_book on online_link(book_id);
    `),

  // 10：划线与笔记（spec §5.1）。**和书签一样是不可再生数据**。
  //
  // 位置用「章号 + 章内字符偏移 + 长度」存，**不存正文**——存了就等于把
  // 「不存正文」那条原则破一个口子。代价是重新解析后位置可能对不上，
  // 所以顺手存一小段 excerpt 用来核对和显示，那不是正文缓存，是一句摘录。
  (db) =>
    db.exec(`
      create table highlight(
        id integer primary key,
        book_id integer not null references book(id) on delete cascade,
        chapter_idx integer not null,
        char_offset integer not null,
        length integer not null,
        excerpt text not null,
        note text,
        color text not null default 'yellow',
        created_at text not null default (datetime('now'))
      );
      create index idx_highlight_book on highlight(book_id, chapter_idx, char_offset);
    `),

  // 11：解析失败的原因。
  //
  // **原来只把原因放在那一次扫描的报告里**，报告一关就没了，
  // 库里只剩一个 `status='parse_failed'`。结果是「一堆解析失败」这个问题
  // 根本无从查起——连我自己回头查都得靠猜。凡是会失败的操作，
  // 失败原因必须和失败状态存在一起。
  (db) =>
    db.exec(`
      alter table book_file add column parse_error text;
      alter table book_file add column failed_at text;
    `),

  // 12：清洗规则加两列，为了能装下从「阅读 / 乌云」导进来的净化规则。
  // `flags` 是正则标志（那边的 `(?i)(?m)(?s)` 翻译过来的），
  // `whole` 表示整章一起套而不是按行——它们大量用 `^`/`$` 配 (?m)，按行套会全失配
  (db) =>
    db.exec(`
      alter table clean_rule add column flags text;
      alter table clean_rule add column whole integer not null default 0;
    `),

  // 13：被屏蔽的文件。
  //
  // **存成一个位而不是每次查询时现算**：屏蔽规则是 glob，SQL 里表达不了，
  // 而这个库有 8000+ 本书——把全部路径拉回 JS 里逐条 match 一遍，
  // 每次打开书架都要来一次。规则变了才重算一次，平时查询就是一个 where。
  (db) =>
    db.exec(`
      alter table book_file add column excluded integer not null default 0;
      create index idx_book_file_excluded on book_file(excluded);
    `),

  // 14：删除文件的日志。
  //
  // 这是 spec §0.1「移动和删除仍然不做」的**明确例外**，由用户要求加的。
  // 既然破了那条例，安全阀就得比重命名还严：**删除一律走系统回收站**
  // （`shell.trashItem`），不是真删。所以这张表记的是「谁被送进回收站了」，
  // 找回要去回收站，程序这边只负责如实记账。
  (db) =>
    db.exec(`
      create table delete_log(
        id integer primary key,
        path text not null,
        size integer,
        content_hash text,
        book_title text,
        deleted_at text not null default (datetime('now')),
        reason text
      );
    `),

  // 15：封面抓取的记账（设计见 docs/superpowers/specs/2026-08-13-covers-and-notes-design.md）。
  //
  // 这张表**是可再生的**——删了重抓一遍就有，不受铁律 3 约束。
  // 它存在的意义是断点：8000 本要跑几小时，中间必然关应用；
  // 「这本试过没匹配上」必须记住，否则每次重启都从头再撞同样的 8000 次网络请求。
  (db) =>
    db.exec(`
      create table cover_fetch(
        book_id integer primary key references book(id) on delete cascade,
        status  text not null,
        source  text,
        error   text,
        tried_at text not null default (datetime('now'))
      );
    `),
  // 16：评价时间（个人评价体系，设计见
  // docs/superpowers/specs/2026-08-14-personal-reviews-design.md）。
  //
  // 书评集最自然的浏览顺序是「最近写的」，而 `last_read_at` 对「读过但没在这个应用里
  // 读」的书是空的——那恰好是这个功能的主要场景（碰到「咦这本好像读过」顺手标）。
  // **这个字段以后补不回来**，所以现在就加。
  (db) => db.exec(`alter table reading_state add column rated_at text;`),

  /*
   * 17：**扫进来的书不再默认「想读」。**
   *
   * 「想读」是用户的表态，不是磁盘上一个文件的事实。而扫描给每一本新书都插了
   * `status = 'want'`，于是真实书库里 8172 本有 **8166 本是「想读」**——
   * 侧栏的「全部 8172」和「想读 8166」是同两批书，那一档等于没有。
   * 更糟的是它让「我打算读这本」这句话没法说了：所有书都已经这么说过了。
   *
   * 新增一档 `none`（未标记）当默认。这一步**只改那些证明没被碰过的行**：
   * 章节序号和章内偏移都是 0、没评分、没短评、没弃坑原因、没读过的时间戳、没重读过。
   * 只要有任何一样，说明用户真的动过它，一个字都不改。
   *
   * ⚠ **`percent` 不算证据，反而要顺手清掉。** 它是从「第几章 / 共几章」派生的，
   * 而这个库里有 **1646 本** `percent` 是 0.15%～1.3% 而 `chapter_idx` 是 0、
   * 也没有阅读时间——那是一个已经修掉的旧 bug 的残留（重解析给没读过的书
   * 写上了 0.1%～0.2% 的进度条，AGENTS.md 记着这件事）。
   * 拿它当「用户动过」的证据，这 1646 本就会永远卡在假的「想读」里，
   * 而且书架上还挂着一条谁也解释不了的进度。
   *
   * ⚠ 代价说清楚：**一个用户手动标成「想读」、但从没打开过的记录，
   * 和扫描留下的默认值长得一模一样**，会被一起清成「未标记」。
   * 没有别的字段能分开这两者。用户可以重新标一次，而反过来
   * （八千本假的「想读」）是没法收拾的。
   */
  /*
   * ⚠️ **这是这个应用会对用户数据做的最大一次静默改动**：真实库上它要清 8165 本
   * （整整一档书架当场清空）。而迁移是在窗口出来之前跑的，用户看到的只是
   * 「『想读』昨天还有七千多，今天没了」——**没有任何一句话解释**。
   *
   * 所以顺手把「清了几本」记进 `app_setting`，界面**只提一次**然后自己划掉。
   * 同本文件那条「静默跳过是这个仓库反复咬人的一条」。
   */
  (db) => {
    const n = db
      .prepare(
        `update reading_state set status = 'none', percent = 0
          where status = 'want'
            and chapter_idx = 0 and char_offset = 0
            and rating is null and comment is null and drop_reason is null
            and last_read_at is null and finished_at is null and reread_count = 0`,
      )
      .run().changes as number;
    if (n > 0) {
      db.prepare("insert or replace into app_setting(key, value) values('migrate.clearedWant', ?)").run(String(n));
    }
  },

  /*
   * 18：**搬家那次把封面文件搬走了，却没改写指向它们的那一列。**
   *
   * `book.cover_path` 存的是**绝对路径**，而数据目录从 `novel-manager` 换成
   * `shuzhai` 时（`src/main/migrate-userdata.ts`）只 rename 了目录本身。
   * 真实库上量的：774 本有封面，**771 本的图片就躺在新目录里、只是这一列还写着
   * 旧目录**，真丢的 0 个。也就是说那 771 张封面白抓了——而抓一本要 6 秒，
   * 队列里还排着几千本，用户看到的是一整墙的占位封面。
   *
   * 它**不报错**：读不到就当没有封面，卡片照常画占位图。所以这件事从搬家那天起
   * 一直静默地成立着，谁也不会把「书架上没封面」和「那次改了个目录名」联系起来。
   *
   * 只改前缀，不碰文件名。**判据里必须带上 covers 那一段**：光替换
   * `novel-manager` 会误伤用户自己起的书库文件夹名——`book_file.path`
   * 是用户的目录，一个字都不能动。
   *
   * ⚠️ **`cover_path` 存绝对路径本身是个隐患，这条迁移只是收拾现场。**
   * 备份把它原样导出，于是在另一台机器上恢复出来的封面路径一定是错的
   * （指向别人的用户目录）。真要治本得存相对 userData 的路径，那要动
   * `cover.ts`、`backup.ts` 和一批测试；而本仓库第一条规矩是**别再搬第二次**，
   * 所以现在只收拾现场，把账记在这儿。
   */
  (db) => db.exec(`
    update book
       set cover_path = replace(cover_path, '\\novel-manager\\covers\\',
                                            '\\shuzhai\\covers\\')
     where cover_path like '%\\novel-manager\\covers\\%';
  `),
  /**
   * `book_file.encoding_locked`：这个编码是**用户自己指定的**，别再拿探测结果盖掉。
   *
   * 起因和章节规则那条一模一样（见 `book-rule.ts` 顶上那段）：
   * 用户在「编辑一本书」里挑了一个编码重解，库里存下的是**结果**——
   * 分不出「探测出来的」还是「他选的」。于是这本书一追更、文件被覆盖写入，
   * `scanRoot` 重新 `detectEncoding` 一遍，**他挑的那个被静默盖掉，又变回乱码**。
   *
   * 而会去手工挑编码的，恰恰就是探测不准的那些书——同规则那条，
   * 这个洞只咬那些最需要它的人。
   */
  (db) => {
    /*
     * ⚠️ **先看有没有再加。** `alter table add column` 跑第二遍会抛
     * 「duplicate column name」，而这个仓库的迁移测试是**把 `user_version`
     * 倒回去再 `migrate()`**（`cover.test.ts` 那条倒回 17）——
     * 一加新迁移，倒回去的那条测试就会把它也跑一遍，当场红。
     * 判据不是「测试不方便」，是**迁移本身就该可重入**：
     * 出过一次意外、版本号没写上，下次开机就再也起不来了。
     */
    const 有了 = (db
      .prepare("select count(*) as n from pragma_table_info('book_file') where name = 'encoding_locked'")
      .get() as { n: number }).n > 0;
    if (!有了) db.exec('alter table book_file add column encoding_locked integer not null default 0;');
  },
  /**
   * 删掉一本书时，顺手删掉它的 `viewer.<id>`（PDF / EPUB 读到第几页）。
   *
   * 那个键**不是一张表**——没有外键，`on delete cascade` 管不着它。前几轮已经把
   * 管书的四处（备份 / 删除 / 整理 / 合并）逐个教会了认它，但那是**靠人记得改**：
   * 再冒出一条删书的路径，又会漏一次。
   *
   * ⚠️ **而漏掉的后果不只是留下一行垃圾**：`book.id` 是不带 `autoincrement` 的
   * `integer primary key`，**删掉最大那个 id 之后，下一本新书会拿到同一个 id**
   * （当场量过）。于是那行遗留的位置会**悄悄贴到另一本书上**——
   * 用户打开一本刚扫进来的书，直接跳到第 100 页，而没有任何地方说得出为什么。
   *
   * 触发器让这件事变成结构性的：谁删都一样，不用记得。
   * `integrity.mjs` 那条「viewer.<id> 指向不存在的书」仍然留着当兜底——
   * 它查的是「已经漏出来的」，这条防的是「以后再漏」。
   */
  (db) => db.exec(`
    create trigger if not exists 删书时清掉阅读位置
      after delete on book
    begin
      delete from app_setting where key = 'viewer.' || old.id;
    end;
  `),

  /*
   * 21：**EPUB 的划线锚点**（`cfi`）。
   *
   * 原来的锚是 `chapter_idx + char_offset + length`——那是**按字节偏移读 txt**
   * 那一整套的产物，EPUB 根本没有那个字节流。于是「划线」一直只有 txt 有，
   * 而用户的原话是「划线也能做吧，我看其他项目也有的」——对，能做，
   * 只是要另一套锚。
   *
   * EPUB 那套是 **CFI range**（`epubcfi(/6/6!/4/4,/1:2,/1:12)`），epub.js 自带：
   * 从选区算得出来，也能一字不差地还原回一个 DOM Range（当场量过）。
   *
   * ⚠️ **加列不是加表，但一样要走迁移。** `highlight` 是铁律 3 里
   * 重扫恢复不了的那几样之一；而且这一条是**可空**的：txt 的划线一行都不动，
   * 它们的 `cfi` 是 null，照旧走偏移那条路。
   * 判据分岔只在 `resolve`：有 `cfi` 的按 cfi 还原，没有的按偏移对。
   */
  (db) => {
    /*
     * ⚠️ **`alter table add column` 不是幂等的，而迁移会被重放。**
     *
     * `cover.test.ts` 那条把 `user_version` 拨回 17 再 `migrate()` 一遍——
     * 一个已经升到最新的库因此会把 18..21 全部重跑。18–20 都写成了
     * `create trigger if not exists` / update 那种可以重放的形状，
     * 而 sqlite **没有** `add column if not exists`，第一版就在那儿撞了
     * `duplicate column name: cfi`。
     *
     * 自己问一次表结构。判据不是「跑过没有」（那是 `user_version` 的事），
     * 是「这一列在不在」——重放安全的迁移都该这么写。
     */
    const 有 = (db.prepare('pragma table_info(highlight)').all() as Array<{ name: string }>)
      .some((c) => c.name === 'cfi');
    if (!有) db.exec('alter table highlight add column cfi text');
  },

  /*
   * 22：**PDF 的矩形摘录锢**（`rect`）。
   *
   * 扫描页、插图、公式、表格——这些页**没有文字层**，
   * 而 PDF 现有那套锢（页码 + 页内偏移 + 长度）整个建在文字层上，
   * 于是那些页上一个字都选不中、一条笔记都做不了。
   *
   * 参考的是 MarginNote：它的摘录有**四种形态——空白 / 文字 / 矩形 / 套索**，
   * 矩形那种不靠文字层，任何一页都成立。（GoodNotes 那套是在页上画墨迹，
   * 没抄：桌面应用没有笔，而墨迹是另一套数据模型。）
   *
   * **存的是归一化坐标，不是截图**：`"x,y,w,h"`，四个 0–1 的数，
   * 相对于那一页。两条理由：一是**铁律 2「不存正文」**——截下来的那块图
   * 就是原书的一部分；二是归一化之后**缩放、窗口大小、重新渲染都不影响它**。
   *
   * ⚠️ **又是一次加列。** 铁律 3 那句话已经在这张表上栓过两次
   * （`bookmark.note`、`highlight.cfi`），所以这一列加完**当场就走了一遍
   * `backup.ts` / `export.ts`**：备份的 select 和 insert、导出的位置名，一处都不能漏。
   *
   * 重放安全：同上一条，自己问一次表结构，sqlite 没有
   * `add column if not exists`。
   */
  (db) => {
    const 有 = (db.prepare('pragma table_info(highlight)').all() as Array<{ name: string }>)
      .some((c) => c.name === 'rect');
    if (!有) db.exec('alter table highlight add column rect text');
  },

  /*
   * 23：**给笔记打标签**。
   *
   * 颜色只有四个。用途一多就不够分——而「这条是什么」本来就是两维：
   * MarginNote 的卡片同时有**颜色标签**和**文字标签**，分组板两种都能分。
   *
   * ⚠️ **复用 `tag` 表，不另开一套。** 书的标签和笔记的标签共一份词表：
   * 一是「重生」这个词在两处意思一样，二是`TagManager` 那套改名 / 合并 / 删除
   * 直接就管得着它们，不用再做第二个标签管理器。
   * 否则就是本仓库那条「同一件事抄两份必分叉」。
   *
   * ⚠️ **新开一处存用户输入的地方，就要走一遍铁律 3**：
   * `backup.ts` 的 select / insert 当场就跟上了（否则重扫恢复不了，而备份里没有）。
   * 删书 / 删标签 / 删划线都靠 `on delete cascade` 兵底，不用谁记得。
   */
  (db) => db.exec(`
    create table if not exists highlight_tag(
      highlight_id integer not null references highlight(id) on delete cascade,
      tag_id integer not null references tag(id) on delete cascade,
      primary key (highlight_id, tag_id)
    );
  `),

  /*
   * 24：删书时顺手删掉它**自己加的目录**（`outline.<id>`）。
   *
   * 这是第二个「按 id 命名的设置」（第一个是 `viewer.<id>`，铁律 3 在它身上
   * 栓过一次：没有外键、`on delete cascade` 管不着，五处同时对它一无所知）。
   * 而 `book.id` 会被复用——漏清一行就会惄惄贴到另一本书上，而且不报错。
   *
   * 触发器让这件事变成结构性的：谁删都一样，不用记得（同迁移 20）。
   */
  (db) => db.exec(`
    create trigger if not exists 删书时清掉自建目录
      after delete on book
    begin
      delete from app_setting where key = 'outline.' || old.id;
    end;
  `),
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function currentVersion(db: DatabaseSync): number {
  return (db.prepare('pragma user_version').get() as { user_version: number }).user_version;
}

/** 把库升到最新版本。已经是最新就什么都不做（幂等）。 */
export function migrate(db: DatabaseSync): void {
  const from = currentVersion(db);
  if (from >= MIGRATIONS.length) return;

  db.exec('begin');
  try {
    for (let v = from; v < MIGRATIONS.length; v++) MIGRATIONS[v](db);
    // pragma 不能用占位符，这里拼的是自己数组的长度，不是外部输入
    db.exec(`pragma user_version = ${MIGRATIONS.length}`);
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
}

/**
 * 撞锁后的重试时长。
 *
 * ⚠️ **`node:sqlite` 的默认值是 0**——一旦撞上锁立刻抛 `database is locked`，
 * 一次都不重试。而这个应用**同时开着两个连接**：主进程写库，§13 的维护接口
 * 有一个只读连接。扫描期间只要有人调一次 `/api/stats`，正在写的那个文件就可能
 * 直接失败。
 *
 * 这不是假想：用户的库里一次扫描留下 126 个「解析失败」，文件全都完好、
 * 重新解析全部成功——就是这么来的。失败还只标了个状态、没记原因，
 * 于是看起来像文件有问题。
 */
const BUSY_TIMEOUT_MS = 5000;

/** 可写连接，只给主进程用。开 WAL——外部只读连接在应用运行时也能安全读（spec §13.2）。 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = WAL');
  db.exec('pragma foreign_keys = ON');
  db.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
  migrate(db);
  return db;
}

/**
 * 只读连接，`/api/query` 用它。写操作会被 SQLite 自己挡掉，不依赖我们解析 SQL。
 * 注意选项名的大小写，见文件头警告。
 */
export function openReadonly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  // 读这边也要设：读操作撞上写事务同样会立刻失败
  db.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

/** 设置的默认值。取不到就用这里的，不要在调用处各写一份 */
export const SETTING_DEFAULTS: Record<string, string> = {
  /** 重命名功能的总开关（spec §3.3）。**存在库里而不是界面里**——
   *  只在界面上禁用的话，通过 /api/rpc 就能绕过去 */
  'rename.enabled': '1',
};

export function getSetting(db: DatabaseSync, key: string): string {
  const row = db.prepare('select value from app_setting where key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? SETTING_DEFAULTS[key] ?? '';
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'insert into app_setting(key, value) values(?, ?) on conflict(key) do update set value = excluded.value',
  ).run(key, value);
}
