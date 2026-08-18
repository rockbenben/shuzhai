// 「这个文件是什么书」——纯字符串判断，**一个依赖都不 import**。
//
// 单独一个文件是因为渲染进程也要用（书架上标格式、点开时决定走阅读器还是系统程序）。
// 放在 `scan.ts` 里的话，`App.tsx` 一 import，Vite 就把整个扫描器连同
// `node:fs/promises` / 编码探测 / 章节解析一起拖进渲染进程的包。

/**
 * 收哪些。**界面上说明收哪些格式就从这里取**，别在文案里另抄一份。
 *
 * ── 加不加一种格式，判据是这一条 ─────────────────────
 *
 * **收「这个扩展名基本只可能是一本书」的，不收「什么都可能是」的。**
 *
 * 理由是扫描对整个目录递归：收 `.html` 会把每一张存下来的网页拖进书架，
 * 收 `.doc` / `.docx` / `.rtf` / `.odt` 会把简历、笔记、报表一起收进来。
 * 而 `.epub` / `.mobi` / `.azw3` / `.fb2` / `.cbz` / `.umd` 这些扩展名
 * **只有电子书在用**，扫进来的就是书。
 *
 * ⚠️ **`.md` 是唯一一个破例的**，破得有理由：它确实什么都可能是
 * （README、笔记），但它是**纯文本**——整套正文机制（编码探测、章节切分、
 * 按字节偏移读、朗读、划线、书签、书内搜索、繁简、净化）对它一条不落地成立，
 * 而那是这个应用的主体。实测：`## 第一章 初见` 被现有章节规则切得和不带 `#`
 * 的纯文本**一模一样**，`##` 连标题里都不留，一条规则都不用新写。
 * 真扫进来一堆 README，用屏蔽规则挡掉（在「书库文件夹」里写一条认 README 的
 * glob）比整类不收划算。
 * ⚠️ 顺带一条写注释的坑：那条 glob 直接写进块注释里会**把注释提前闭合**
 *（`**` 后面紧跟一个斜杠就是 `*` 加 `/`），当场一串语法错。
 *
 * ⚠️ **`.md` 的代价要说清**：正文里的 markdown 记号（`#`、`**`）会**原样显示**——
 * 这个应用不渲染 markdown，它按纯文本读。介意的话在「正文净化」里加一条规则。
 *
 * **查过了、决定不收的**：`doc` / `docx` / `rtf` / `odt` / `html` / `chm`（通用文档
 * 格式，不是「一本书」的标志）。calibre 全都收，但 calibre 是转换器不是书库扫描器——
 * 它收的是「你手动喂给它的一个文件」，我们收的是「整个目录里自动扫到的」，
 * 两者的错误代价完全不同。
 */
export const BOOK_EXT = [
  // 能在应用内完整阅读的（见 TEXT_EXT）
  'txt', 'md', 'markdown',
  // 有内置查看器的（见 viewerOf）
  'pdf', 'epub',
  // 只编目，正文交给系统默认程序
  'mobi', 'azw3', 'azw', 'prc', 'pdb', 'fb2', 'fbz', 'umd', 'cbz', 'cbr', 'djvu',
];

/**
 * **纯文本那一档**——整套正文机制建立在按字节偏移读纯文本上。
 *
 * `md` / `markdown` 在这里而不在「只编目」那档：它们就是纯文本，
 * 编码探测、章节规则、划线的字节偏移**一条都不用改**（实测过）。
 */
export const TEXT_EXT = ['txt', 'md', 'markdown'];

/** 扩展名，不带点、小写。没有点就是空串 */
export const extOf = (path: string): string => {
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(i + 1).toLowerCase();
};

export const isBookFile = (name: string): boolean => BOOK_EXT.includes(extOf(name));

/**
 * 一本书属于哪一类。**三态互斥，一次算清**：
 *
 * - `manual` —— 没有文件，手工添的「读过但本地没有」的记录
 * - `text` —— 纯文本（txt / md），能在书斋里读（整套正文机制建立在按字节偏移读纯文本上）
 * - `catalog` —— 其余格式，只编目，正文交给系统默认程序
 *
 * 收 `null` 是故意的：判「有没有文件」和判「什么格式」本来就是同一个三选一，
 * 分成两处写，调用方就得记得先判 null 再判格式——`open()` 和角标那两处
 * 曾经各写了一份，而且写法还不一样。
 */
export const formatOf = (path: string | null): 'manual' | 'text' | 'catalog' =>
  !path ? 'manual' : TEXT_EXT.includes(extOf(path)) ? 'text' : 'catalog';

/**
 * 这个格式能不能在应用内渲染。
 *
 * **和 `formatOf` 分开是有意的**：那个函数回答的是「正文那一整套（按字节偏移
 * 定点读、章节索引、编码探测、清洗、繁简）能不能用」——只有 txt 能。
 * 而 PDF / EPUB 用的是**另一个查看器**，它们和 txt 那套一条都不共享：
 * 没有章节表、没有字节偏移、没有划线书签朗读。
 *
 * 把它们塞进 `formatOf` 的三态里，调用方就得处处判「是 catalog 但又能看」——
 * 那正是这个文件顶上警告过的「分成两处写，调用方就得记得先判 null 再判格式」。
 *
 * `mobi` / `azw3` / `fb2` / `cbz` / `umd` / `djvu` 那一批仍然回 null：
 * 没有能进渲染包的现成库，它们照旧交给系统默认程序。
 */
/**
 * 一本书里「第几个位置」该怎么念给人听。
 *
 * ⚠️ **只此一份。** 划线和书签的 `chapter_idx` 三种格式装的是三样东西：
 * txt 是**章**号、EPUB 是 **spine 节**号、PDF 是**页**码。
 * 「书签与划线」面板要说、导出笔记也要说——两处各写一份必然分叉
 * （这个仓库被「抄第二份」咬过四次）。
 *
 * ⚠️ **序号的起点也不一样，一起收在这儿**：PDF 的页码本来就是 1 起的，
 * 章号和节号是 0 起的。分开写的话「第 0 页」这种错迟早出现。
 */
export function 位置名(path: string | null, idx: number): string {
  const e = path ? extOf(path) : '';
  if (e === 'pdf') return `第 ${idx} 页`;
  return `第 ${idx + 1} ${formatOf(path) === 'text' ? '章' : '节'}`;
}

export const viewerOf = (path: string | null): 'pdf' | 'epub' | null => {
  const e = path ? extOf(path) : '';
  return e === 'pdf' ? 'pdf' : e === 'epub' ? 'epub' : null;
};
