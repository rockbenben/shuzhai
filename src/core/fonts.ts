// 自定义正文字体：把字体文件装进 userData/fonts，渲染进程用 @font-face 挂上去。
//
// **不下载任何字体。** 用户自己把 ttf/otf 放进来——这台机器上装没装、
// 许可允不允许，都是用户自己的事，应用不替他做决定，也不往外发一个字节。
//
// 为什么要「装进来」而不是直接引用原路径：用户多半是从下载目录里选的，
// 那些文件说没就没。同一个理由让封面也复制进 userData（见 cover.ts）。

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/** 浏览器能直接用的几种。woff2 最小，ttf/otf 最常见；.ttc 不收——那是多字体合集，CSS 挑不出来 */
const OK_EXT = new Set(['.ttf', '.otf', '.woff', '.woff2']);

export interface InstalledFont {
  /** 文件名，同时也是 CSS 里的 family 名（去掉扩展名） */
  name: string;
  file: string;
  size: number;
  /** 随应用发布的，不能卸 */
  bundled?: boolean;
}

/**
 * 随应用发布的字体（`build/fonts/`，打包后进 `resources/fonts/`）。
 *
 * **走和用户自装字体完全同一条路**：同样在 `font.list` 里返回、同样由
 * `applyFontFaces` 挂 `@font-face`。这样「内置」不是一条独立分支，
 * 而只是列表里多几行——少一套要各自维护的逻辑。
 *
 * **文件不在也不报错**，只是列表里少一项。集成字体是可选的（协议允许但体积很大，
 * 见 AGENTS.md），仓库里默认不放二进制，缺了不该让应用起不来。
 */
export function bundledFonts(resourcesDir: string): InstalledFont[] {
  const dir = join(resourcesDir, 'fonts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => OK_EXT.has(extname(f).toLowerCase()))
    .map((f) => ({
      name: basename(f, extname(f)),
      file: join(dir, f),
      size: statSync(join(dir, f)).size,
      bundled: true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const dirOf = (userDataDir: string) => join(userDataDir, 'fonts');

export function listFonts(userDataDir: string): InstalledFont[] {
  const dir = dirOf(userDataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => OK_EXT.has(extname(f).toLowerCase()))
    .map((f) => ({ name: basename(f, extname(f)), file: join(dir, f), size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 装一个字体文件。复制进 `userData/fonts`，用文件名当 family 名。
 *
 * **同名直接覆盖**：用户重新装一遍多半就是想换掉那个坏的/旧的，
 * 生成 `xxx(1).ttf` 只会让字体列表里堆一串看不出区别的名字。
 */
export function addFont(userDataDir: string, srcPath: string): InstalledFont {
  const ext = extname(srcPath).toLowerCase();
  if (!OK_EXT.has(ext)) {
    throw new Error(`不认识这种字体文件：${ext || '（没有扩展名）'}。支持 ttf / otf / woff / woff2`);
  }
  const dir = dirOf(userDataDir);
  mkdirSync(dir, { recursive: true });
  const to = join(dir, basename(srcPath));
  copyFileSync(srcPath, to);
  return { name: basename(srcPath, ext), file: to, size: statSync(to).size };
}

/**
 * 卸掉一个字体。**只删 `fonts` 目录里的文件**——`name` 来自渲染进程，
 * 不做这一层的话一个 `../` 就能删到别处去。
 */
export function removeFont(userDataDir: string, name: string): { removed: boolean } {
  const hit = listFonts(userDataDir).find((f) => f.name === name);
  if (!hit) return { removed: false };
  rmSync(hit.file, { force: true });
  return { removed: true };
}
