/**
 * 渲染进程的内容安全策略（CSP）。
 *
 * **为什么需要它**：这个页面渲染的东西全都来自别处——用户拖进来的 txt 里可能带着一段
 * `<script>`、EPUB 里的 XHTML 是别人写的、正文里的 `<img>` 指向谁都不知道。而渲染进程
 * 手里有两样东西不该交给这种内容：**`book://f/<id>` 能把书库里任何一本书整本读出来**，
 * 以及**它还发得出网络请求**。两样凑在一起，就是「注入一段脚本 → 把整库正文 POST 出去」。
 * 主进程那边该守的都守了（`renderer-policy.ts` 卡入口 URL、`contextIsolation` + `sandbox`、
 * IPC 走 `rpc.ts` 的白名单），缺的正是**「这段脚本不许跑、这个请求不许发」**这一层。
 *
 * ⚠️ **只在 `npm run build` 时注入（`vite.config.ts` 里那个插件），不进开发服务器。**
 * `@vitejs/plugin-react` 在 dev 下往页面里插的 refresh 预置脚本是**内联**的，HMR 还走
 * `ws://localhost`——照这份策略原样贴上去，`npm run dev` 当场白屏。要检安全策略就检产物。
 *
 * ## 每条指令为什么是现在这个值
 *
 * | 指令 | 值 | 依据 |
 * |---|---|---|
 * | `default-src` | `'none'` | 没列到的资源类型一律不许，新加资源时被迫回来这里想一遍 |
 * | `script-src` | `'self'` | 产物只有 Vite 打出来的那几个 module；源码里 `eval` / `new Function` 一个都没有 |
 * | `style-src` | `'self' 'unsafe-inline'` | React 的 `style=` 属性，加上 `applyFontFaces` 那个 `<style>` |
 * | `img-src` | `'self' data: blob: https:` | 封面是 data URL（`cover.ts` 刻意不让渲染进程引 `file://`）；epub.js 把章节里的图片换成 `blob:`；正文里的外链图是 `https:` |
 * | `font-src` | `'self' data: blob: file:` | 用户字体和随包发布的 HarmonyOS 都是 `file:///`（`settings.ts` 的 `applyFontFaces`）；EPUB 自带的字体是 `blob:` |
 * | `media-src` | `'self' data: blob:` | 在线朗读引擎由主进程取回、交回来的就是 data URL（`useTts.ts` 的 `new Audio(dataUrl)`） |
 * | `connect-src` | `'self' book: blob:` | 渲染进程只 fetch 这一个跨源协议（`FileViewer` 的 `book://f/<id>`），其余全走 IPC |
 * | `frame-src` | `'self' blob: about:` | EPUB 的每一节是 epub.js 建的 **srcdoc** iframe |
 * | `worker-src` | `'self' blob:` | pdf.js 的 worker 是打包产物（`pdf.worker.min-*.mjs`） |
 * | `base-uri` | `'self'` | ⚠️ **写 `'none'` 会静默弄坏 EPUB**：`epub.js` 的 `replaceBase` 往每一节的 `head` 里插 `<base href>`，用来解析章节里的相对图片和样式。实测 `'none'` 会报 base-uri 违规并把那个 `<base>` 挡掉，**画面上一个字都不少**，坏的只是相对资源 |
 * | `object-src` | `'none'` | 这个应用没有任何插件/内嵌对象 |
 * | `form-action` | `'none'` | 没有 `<form>`；有也不许提交出去 |
 *
 * ## 量过什么
 *
 * 2026-11-23 在打包产物上跑（`npm run build` 出来的 `dist/index.html`；本机装的是
 * Electron 45.3.1，lockfile 解析的是 45.4.1，同一 major 同一份 Chromium 大版本）：
 * `walk.mjs`（首扫 → 书架 → 阅读器 → 书评）、`audit.mjs --fast @smoke`（八块代表屏，
 * 含阅读器与 PDF 查看器）、`find.mjs`（txt / PDF / EPUB 三个阅读界面各走一遍落点）、
 * `notes.mjs`（PDF 文字层划线 → 笔记卡 → 导出），全程用 `securitypolicyviolation`
 * 收违规：**0 条**，三个查看器的正文都真的铺开了。另外单独验过 `data:` 音频（`new Audio`）
 * 和 `file:///` 字体（`FontFace.load`）。开发服务器另验一遍：`npm run dev` 的 html
 * 里没有这条策略，refresh 预置脚本照旧是内联的（注入只在 `apply: 'build'` 那条路上）。
 *
 * **复查条件**：引入会 `eval` 的依赖、开始从远端加载脚本、或新加一类资源时，重新跑上面那三条
 * 走查并再看一遍违规列表——**别靠读这份表推断**，`'none'` 挡掉的东西是静默的。
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: blob: file:",
  "media-src 'self' data: blob:",
  "connect-src 'self' book: blob:",
  "frame-src 'self' blob: about:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const 标签 = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`;

/**
 * 把 CSP 塞进构建出来的 `index.html`。
 *
 * ⚠️ **找不到 `<head>` 就抛**，不静静地原样返回：一个没有 CSP 的产物和「CSP 什么都放过了」
 * 在下载下来的那个 html 里长得一模一样，而那正是这个仓库最怕的一类失败。
 */
export function injectCsp(html: string): string {
  if (html.includes('Content-Security-Policy')) return html;
  if (!/<head(\s[^>]*)?>/i.test(html)) throw new Error('index.html 里没有 <head>，CSP 注入失败');
  return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n    ${标签}`);
}
