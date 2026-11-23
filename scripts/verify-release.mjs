// 发布前验证实际更新载体，不能用「文件存在」代替内容校验。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { ROOT } from './repo-root.mjs';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const config = load(readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8'));
assert.equal(pkg.name, 'shuzhai', 'name 决定用户数据目录，不能改');
assert.deepEqual(config.nsis.installerLanguages, ['zh_CN']);
assert.equal(config.nsis.displayLanguageSelector, false);

// **渲染进程的 CSP 只在打包时注入**（`vite.config.ts` 里那个插件，判据在
// `src/renderer/csp.ts`）。产物里没这一条，等于这次发出去的安装包没有安全策略——
// 而它和「有策略、只是恰好什么都放行」在下载下来的 html 里长得一模一样。
assert.match(
  readFileSync(join(ROOT, 'dist', 'index.html'), 'utf8'),
  /<meta http-equiv="Content-Security-Policy" content="[^"]*default-src 'none'/,
  '渲染进程产物里没有 CSP',
);
const dir = join(ROOT, 'release');
const info = load(readFileSync(join(dir, 'latest.yml'), 'utf8'));
const installer = `${pkg.name}-${pkg.version}-x64-setup.exe`;
assert.equal(info.version, pkg.version, '更新清单版本与应用不符');
assert.equal(info.path, installer, '旧版 updater 的 path 必须指向本次安装包');
assert.ok(Array.isArray(info.files) && info.files.length === 1, '本项目只有一个可更新的 NSIS 载体');
const file = info.files[0];
assert.equal(file.url, installer, '更新清单必须指向本次 NSIS 安装包');
const path = join(dir, installer);
assert.equal(file.size, statSync(path).size, '更新清单文件大小不符');
const hash = createHash('sha512');
for await (const chunk of createReadStream(path)) hash.update(chunk);
const digest = hash.digest('base64');
assert.equal(file.sha512, digest, '更新清单 SHA-512 不符');
assert.equal(info.sha512, digest, '旧版 updater 的 SHA-512 不符');
for (const name of [`${installer}.blockmap`, `${pkg.name}-${pkg.version}-x64.zip`]) {
  assert.ok(statSync(join(dir, name)).size > 0, `发布资产为空：${name}`);
}
console.log(`发布校验通过：${pkg.version} · NSIS + ZIP + blockmap · 更新清单大小/SHA-512 · 中文安装配置 · 产物带 CSP`);
