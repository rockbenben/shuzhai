// 封面（spec §3.1）。
//
// **封面文件复制进 userData，不引用用户原来的位置。** 理由：用户很可能是从下载目录
// 或某个临时文件夹拖进来的，那些地方的文件说没就没，而封面丢了界面会一片空白。
// 复制一份的代价是几十 KB，换来的是它不会因为别处的清理而消失。
//
// **没有封面时不生成图片文件**，由界面用书名+作者画一个占位块就行——
// 生成图片要么引图形库，要么手写一个渲染器，而占位图的信息量只有「书名和作者」，
// CSS 一个盒子就画完了。

import { copyFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** 认得的图片扩展名。别的一律拒绝——拖个 exe 进来复制到 userData 没有任何意义 */
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/** 单张封面的大小上限。超过多半是误拖了别的图，存进去也只是浪费 */
const MAX_BYTES = 8 * 1024 * 1024;

export function coverDir(userDataDir: string): string {
  return join(userDataDir, 'covers');
}

/**
 * 设封面：把图片复制进 userData/covers，并把新路径写进库。
 * 换封面时旧文件会被删掉——留着只会攒垃圾，而它已经没有任何引用了。
 */
export async function setCover(
  db: DatabaseSync,
  userDataDir: string,
  bookId: number,
  sourcePath: string,
): Promise<{ path: string }> {
  const ext = extname(sourcePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    // 把**认得的那些列出来**，别让用户猜。`fonts.ts` 那条早就是这么写的
    throw new Error(
      `不是认得的图片格式：${ext || '（没有扩展名）'}。`
      + `支持 ${[...IMAGE_EXTS].join(' / ')}`,
    );
  }

  const data = await readFile(sourcePath);
  if (data.length > MAX_BYTES) {
    throw new Error(`图片太大（${(data.length / 1024 / 1024).toFixed(1)} MB），上限 8 MB`);
  }

  const dir = coverDir(userDataDir);
  await mkdir(dir, { recursive: true });

  const old = currentCover(db, bookId);
  // 文件名带上时间戳：同一本书换封面时不会因为路径没变而让界面继续显示旧图
  const target = join(dir, `${bookId}-${Date.now()}${ext}`);
  await copyFile(sourcePath, target);

  db.prepare("update book set cover_path = ?, updated_at = datetime('now') where id = ?").run(
    target,
    bookId,
  );

  if (old && old !== target) await unlink(old).catch(() => {});
  return { path: target };
}

export function currentCover(db: DatabaseSync, bookId: number): string | null {
  const row = db.prepare('select cover_path from book where id = ?').get(bookId) as
    | { cover_path: string | null }
    | undefined;
  return row?.cover_path ?? null;
}

/** 清掉封面。文件一起删——它只被这一处引用 */
export async function clearCover(db: DatabaseSync, bookId: number): Promise<void> {
  const old = currentCover(db, bookId);
  db.prepare("update book set cover_path = null, updated_at = datetime('now') where id = ?").run(bookId);
  if (old) await unlink(old).catch(() => {});
}

/**
 * 把封面读成 data URL 给界面用。
 *
 * **不让渲染进程直接用 file:// 引本地图片**：开发模式下页面跑在 http://localhost，
 * file:// 会被浏览器挡掉，于是「开发时看不见、打包后能看见」——这种只在一种模式下
 * 复现的差异最难查。走 data URL 两种模式行为一致，封面本来也就几十 KB。
 */
export async function coverDataUrl(db: DatabaseSync, bookId: number): Promise<string | null> {
  const path = currentCover(db, bookId);
  if (!path) return null;

  /*
   * **读不到 ≠ 文件没了，所以只有真没了才清记录。**
   *
   * 这里原来是 `.catch(() => null)` 吞掉一切，然后把 `cover_path` 清成 null。
   * 可读失败还有别的原因：文件被杀毒软件/看图软件锁着（EBUSY）、权限不对（EACCES/EPERM）、
   * 路径变成了目录（EISDIR）。**那些都是暂时的，而清掉是永久的**——
   * 封面文件还躺在 `covers` 目录里，库里却再也不知道它属于哪本书。
   *
   * 这条的分量在第 108 轮量出来过：真实库里 771 本的 `cover_path` 指着搬家前的
   * 旧目录，**只要被滚到屏幕上就会被这里清掉**（迁移 18 赶在渲染之前跑，才救下来）。
   *
   * 判据和本仓库另外两处一样：`webdav.ts` 的「404 才是真的没有，401/403 说是权限问题」、
   * 封面抓取那条「一个源没答，结论就不可信」。**分不出来的时候，别下结论。**
   */
  const got = await readFile(path).catch((e: NodeJS.ErrnoException) => e);
  if (!Buffer.isBuffer(got)) {
    if (got.code === 'ENOENT' || got.code === 'ENOTDIR') {
      db.prepare('update book set cover_path = null where id = ?').run(bookId);
    }
    return null;
  }
  const data = got;

  const mime = MIME[extname(path).toLowerCase()] ?? 'image/png';
  return `data:${mime};base64,${data.toString('base64')}`;
}

/*
 * ⚠️ **占位封面的颜色不在这儿，别再往回搬。**
 *
 * 这里原来有个 `placeholderHue`：按书名算一个 0–360 的色相。
 * 它**只被自己的测试调用过**——真正画占位封面的是渲染进程的 `Cover.tsx`，
 * 那边自己有一份。两份同名不同姓的实现摆在两个进程里，是这个仓库最常栽的形状。
 *
 * 而且现在连算法都换了（六匹书衣，不是三百六十个色相），所以这份没删的话
 * 就是「同一件事两份，其中一份还是假的」。要看颜色怎么定，去 `Cover.tsx`。
 * **搬不回来**：这个模块 import 了 `node:fs`，渲染进程一 import 就把它拖进包里。
 */
