// 构建真实渲染入口；纯显示数据不能把 Node 文件/数据库模块带进浏览器依赖图。
import { test } from 'node:test';
import { isBuiltin } from 'node:module';
import { build } from 'vite';
import { ROOT } from '../repo-root.mjs';

test('渲染进程的运行时依赖图不含 Node 内置模块', async () => {
  await build({
    root: `${ROOT}/src/renderer`,
    logLevel: 'silent',
    build: { write: false },
    plugins: [{
      name: 'browser-boundary',
      enforce: 'pre',
      resolveId(source, importer) {
        if (isBuiltin(source)) throw new Error(`渲染进程依赖了 ${source}，来自 ${importer}`);
      },
    }],
  });
});
