/*
 * 「打开一本书」到底是什么意思——**一个纯判断**。
 *
 * 原来这四条判断连同副作用一起写在 `App.tsx` 的 `open()` 里（四十行、五个分支），
 * 谁也测不了。而其中至少两条的**顺序**是有讲究的，当时只有一句注释守着：
 *
 *   - 「PDF 交给系统程序」必须排在「还没解析出章节」之前——只编目的书章节数
 *     天生是 0，落到那句会得到「点『章节』设切分规则」，**对一个 PDF 是无解的提示**；
 *   - 「文件不在原位置了」必须排在最前——文件都没了，就别再去 `ui.openFile` 它。
 *
 * 本仓库那条「『只在大库上暴露』的判据，要拆进 core 才守得住」说的就是这件事：
 * 写在渲染进程里就只能靠人记着别调顺序。现在 `open.test.ts` 逐条钉着，
 * 调换顺序当场红。
 *
 * 副作用留在 `App.tsx`（setError / 开评价浮层 / 走 rpc / 进阅读器）——
 * **这个模块一个 import 都不带**（`book-format.ts` 本身也是零依赖），
 * 所以渲染进程值导入它不会把任何 node 内置模块拖进包里。
 */
import { formatOf, viewerOf } from './book-format.ts';

/**
 * `planOpen` 要看的那几样。
 *
 * **故意只收这几个字段**而不是整行 `Book`：这样它的契约就是「我只看这些」，
 * 而调用方那边的行类型再长也照样传得进来（结构化类型）。
 */
export interface OpenBook {
  title: string;
  /** 主文件路径。**为空 = 手工添的「读过但本地没有文件」的记录**，不是坏数据 */
  path: string | null;
  file_status: string | null;
  chapter_count: number | null;
  chapter_idx: number | null;
  char_offset: number | null;
}

/** 「打开」这一下该发生什么。副作用由调用方去做 */
export type OpenPlan =
  /** 进阅读器，从第 `at` 章、章内第 `off` 个字节起 */
  | { kind: 'reader'; at: number; off: number | undefined }
  /** 只有记录、没有文件的书：点它就是要看/改评价，不是要开阅读器 */
  | { kind: 'review' }
  /**
   * PDF / EPUB：**在应用内看**，但走的是另一个查看器
   * （只有翻页和缩放，没有章节表、划线、书签、朗读——那一整套建立在 txt 上）。
   */
  | { kind: 'view'; viewer: 'pdf' | 'epub'; path: string }
  /** 其余只编目的格式（mobi / azw3 / djvu）：交给系统默认程序 */
  | { kind: 'external'; path: string }
  /** 打不开，`message` 是给用户看的那句话（**必须说清下一步做什么**） */
  | { kind: 'error'; message: string };

export function planOpen(b: OpenBook, at?: number, off?: number): OpenPlan {
  /*
   * ⚠️ **下面四判的顺序是判据的一部分**，别按「看起来更顺」重排。
   * 每一条都有一条测试钉着它排在谁前面。
   */

  // ① 文件不在原位置了。排最前：文件都没了，后面几判（交给系统程序、
  //    进阅读器）没有一个做得成，而且报错要说清怎么救
  if (b.file_status === 'missing') {
    return {
      kind: 'error',
      message:
        `《${b.title}》的文件不在原位置了。先扫描一次；` +
        `要是扫完还在这儿，去设置里点「整理数据库」——它认得内容还在别处的残留记录`,
    };
  }

  // ② 手工添的「读过但本地没有文件」的书。不单独判的话会落进 ④ 那句
  //    「还没有解析出章节」——对一条压根没有文件的记录，那个提示是无解的
  if (!b.path) return { kind: 'review' };

  /*
   * ③ 不是 txt 的。**必须排在 ④ 之前**：它们的章节数天生是 0，
   *   落到 ④ 会得到「点『章节』设切分规则」——对一个 PDF 是无解的提示。
   *
   * PDF / EPUB 有内置查看器，其余（mobi / azw3 / djvu）交给系统默认程序。
   */
  if (formatOf(b.path) !== 'text') {
    const v = viewerOf(b.path);
    return v ? { kind: 'view', viewer: v, path: b.path } : { kind: 'external', path: b.path };
  }

  // ④ txt 但还没切出章节
  if (!b.chapter_count) {
    return {
      kind: 'error',
      message: `《${b.title}》还没有解析出章节。把鼠标移到封面上点「章节」可以自定义切分规则`,
    };
  }

  /*
   * 起点：没指定就接着上次读到的地方。
   *
   * **显式传了 `at` 时不继承上次的章内偏移**——那是「跳到第 N 章」，
   * 从那一章的开头看才对；继承的话会跳到新章节里一个毫不相干的字节上。
   */
  return {
    kind: 'reader',
    at: at ?? b.chapter_idx ?? 0,
    off: off ?? (at === undefined ? b.char_offset ?? undefined : undefined),
  };
}
