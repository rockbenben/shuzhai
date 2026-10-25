/**
 * 状态的中文说法，**全应用唯一的一份**。
 *
 * 这几套 id → 名字原来在渲染进程里抄了两遍（`BookEditor.tsx` 和 `Settings.tsx`，
 * 后者的注释还写着「和 BookEditor 里那份是同一套 id，改了两边都得改」），
 * 而导出在 core 里，够不到它们——差点抄成第三份。放这儿，三处都从这里引。
 *
 * 顺带解决导出的一个真问题：CSV 是**唯一一份会离开应用、在别的程序里打开**的
 * 东西，而它的表头一直是数据库列名（`serial_status` / `drop_reason` /
 * `reread_count`），值也是 `unknown` / `dropped`。对着 Excel 的人没有源码看。
 */

export const SERIAL_STATUS = [
  { id: 'ongoing', name: '连载中' },
  { id: 'finished', name: '已完结' },
  { id: 'abandoned', name: '太监' },
  { id: 'unknown', name: '未知' },
];

export const READING_STATUS = [
  // 扫进来的默认值：**还没表过态**。不叫「想读」——那是用户说的话
  { id: 'none', name: '未标记' },
  { id: 'want', name: '想读' },
  { id: 'reading', name: '在读' },
  { id: 'finished', name: '已读完' },
  { id: 'dropped', name: '弃坑' },
  { id: 'shelved', name: '搁置' },
] as const;
/*
 * `as const` 不是洁癖：`status.ts` 的 `ReadingStatus` 那个字面量联合类型是从这里算的。
 * **那边原来自己又写了一份纯 id 的清单**——同一张表两个副本，
 * 而这个仓库已经被「抄第二份」咬过七八次了（`SERIAL_STATUS` 当年就是这么删掉的）。
 */

/**
 * 「已经翻开过、或者表过态」的那几档——整张 `READING_STATUS` 去掉
 * 「未标记」（扫描的默认值）和「想读」（还没读）。
 *
 * **从那张表算出来，别另写一份清单**：加一档阅读状态时漏改一处，
 * 那一档的书就会从「读过没评价」那个待办里静默消失。
 * 同 `PROBLEM_FILE_STATUS` 那条。
 */
export const TOUCHED_STATUS = READING_STATUS
  .filter((s) => s.id !== 'none' && s.id !== 'want')
  .map((s) => s.id);

export const FILE_STATUS = [
  { id: 'ok', name: '正常' },
  { id: 'missing', name: '文件不见了' },
  { id: 'parse_failed', name: '解析失败' },
];

/**
 * 「算问题的」文件状态——除了 `ok` 以外的全部。
 *
 * 侧栏「需要处理」那一档、它的计数、卡片上那个警告角标，
 * 原来各自写着一份 `['missing', 'parse_failed']`（分别在 `App.tsx` 和
 * `library.ts`）。加第四档文件状态时那几处必须一起改，而漏掉一处不会有任何报错：
 * 侧栏数出 12 本、点进去只有 9 本，谁也不知道哪个对。
 * 本文件里那条「`shelfCounts` 曾经绕开 `buildFilter` 自己写 SQL」就是这个形状。
 */
export const PROBLEM_FILE_STATUS = FILE_STATUS.filter((s) => s.id !== 'ok').map((s) => s.id);

/** 查一个 id 的中文名，查不到就原样返回（新增的状态不会变成空白） */
// 参数收成 `ReadonlyArray`：上面那几张表现在是 `as const`，
// 而 `as const` 的数组不能赋给可变数组参数
export function labelOf(list: ReadonlyArray<{ id: string; name: string }>, id: unknown): string {
  if (id === null || id === undefined || id === '') return '';
  const hit = list.find((x) => x.id === String(id));
  return hit ? hit.name : String(id);
}

/**
 * 内置站点 id → 中文名。**站点适配器的 `label` 和界面上「来自起点」这类提示
 * 都从这里取**——适配器在 core（渲染进程够不到，它拖 node:sqlite），而界面
 * 也要显示同一个名字，抄第二份迟早分叉。
 * 自定义封面源 / 陌生站点的 id 不在表里，用时原样显示（多半是域名，本就可读）。
 */
export const SITE_LABELS: Record<string, string> = {
  qidian: '起点',
  shuqi: '书旗',
  zongheng: '纵横',
  fanqie: '番茄',
  douban: '豆瓣',
  duyuedu: '独阅读',
  jjwxc: '晋江',
  faloo: '飞卢',
};

/** CSV 表头。**顺序由 export.ts 的 META_COLUMNS 决定**，这里只管怎么叫 */
export const META_LABELS: Record<string, string> = {
  id: '编号',
  title: '书名',
  author: '作者',
  aliases: '别名',
  serial_status: '连载状态',
  category: '分类',
  tags: '标签',
  shelves: '书架分类',
  word_count: '字数',
  chapter_count: '章数',
  chapter_count_override: '手填章数',
  encoding: '编码',
  path: '文件路径',
  file_status: '文件状态',
  reading_status: '阅读状态',
  percent: '进度%',
  rating: '评分',
  comment: '短评',
  rated_at: '评价时间',
  drop_reason: '弃坑原因',
  reread_count: '重读次数',
  last_read_at: '最后阅读',
  source_site: '来源站点',
  note: '备注',
};

/*
 * ── 机械分段的章名 ────────────────────────────────────────────
 *
 * **生成和识别共用这一份。** 名字由 `chapter.ts` 的 `fallbackChunks` 造，
 * 阅读器靠它认「这本书的目录是硬分的、不是真的章名」。两处各写一个字面量
 * 的话，改一处漏一处，界面上就会把一本真书当成没切出来（或反过来）。
 *
 * ⚠️ **两种写法都要认。** `book.chapters` 会按这本书的繁简模式转换章名，
 * `未识别章节` 在繁体模式下是 `未識別章節`；只认简体的话，开着繁体的那本书
 * 永远看不到这条提示。
 */
export const FALLBACK_TITLE = '未识别章节';

export function fallbackTitle(n: number): string {
  return `${FALLBACK_TITLE} ${n}`;
}

/** 目录里这一串是不是 `fallbackChunks` 造的机械分段（序号必须从 1 连上来） */
export function 是机械分段(titles: string[]): boolean {
  if (titles.length === 0) return false;
  const re = /^(?:未识别章节|未識別章節) (\d+)$/;
  return titles.every((t, i) => {
    const m = re.exec(t);
    return !!m && Number(m[1]) === i + 1;
  });
}
