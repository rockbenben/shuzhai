import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { injectCsp } from './src/renderer/csp.ts';

/*
 * **CSP 只在打包时注入，不进 dev server。**
 *
 * dev 下 `@vitejs/plugin-react` 插的 refresh 预置脚本是内联的、HMR 走 `ws://`，
 * 照产物那份策略贴上去当场白屏。要验策略就验产物——判据和策略正文都在
 * `src/renderer/csp.ts`，`scripts/verify-release.mjs` 在发版前再核一次产物里有没有它。
 */
function cspPlugin() {
  return {
    name: 'shuzhai-csp',
    apply: 'build' as const,
    transformIndexHtml: {
      order: 'post' as const,
      handler: (html: string) => injectCsp(html),
    },
  };
}

export default defineConfig({
  root: 'src/renderer',
  // 生产环境是用 file:// 加载的，绝对路径会 404
  base: './',
  plugins: [react(), cspPlugin()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
});
