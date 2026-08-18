/**
 * **打包产物名不许走 `${productName}`。**
 *
 * `productName` 是「书斋」，产物就叫 `书斋-1.0.0-x64.exe`——本地看着没问题，
 * 一进 GitHub Release 的下载地址就变成 `%E4%B9%A6%E6%96%8B-1.0.0-x64.exe`：
 * 直接链接、curl 命令、校验和、别人转贴的那一行全带着一串转义，
 * 而 README 首屏那个「⬇ 下载」是整份 README 最该点得下去的一个链接。
 * 走 `${name}`（`package.json` 的 `name`，恒是 ASCII 无空格）就没这回事。
 *
 * **为什么要一条测试而不是只留注释**：`electron-builder.yml` **没有任何一道现有检查读它**——
 * `npm test` / `typecheck` / `lint:ui` 全都不碰，而 CI 里**故意不跑 `npm run dist`**
 * （那个 workflow 里专门有一节写为什么）。也就是说把它改回 `${productName}`，
 * 四道闸门**全绿**，问题要等到发版之后有人点那个链接才浮出来。
 * 判据硬、结果二值，所以放 `npm test` 里，同 `no-control-chars.test.ts`。
 *
 * ⚠️ **改名的时候会撞上这条**：`productName` / `shortcutName` / 窗口标题 / `<title>` /
 * `nav-brand` 改完，产物名**不会跟着变**——那是有意的，别去动 `package.json` 的 `name`
 * 来「修」它：那个字段决定 `%APPDATA%\shuzhai`，动它等于把用户的书库换到一个空目录
 * （铁律 3，重扫恢复不了）。要让产物名跟着走，改这里的 `artifactName` 模板。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * 判据本身。抽成函数**只为一件事**：自检能拿合成的坏例子喂它
 *（同 `no-control-chars.test.ts`——一条永远绿的断言等于没有断言）。
 *
 * 收的是每一行 `artifactName:`：这个文件里有两处（`win` 一处、`nsis` 覆盖一处），
 * 而**将来加 mac/linux 就会有第三处**，所以别写死几条，扫全文。
 */
export function 用了产物名模板(yml: string): { 行: string; 坏: boolean }[] {
  return yml
    .split(/\r?\n/)
    .filter((l) => /^\s*artifactName\s*:/.test(l))
    .map((行) => ({ 行: 行.trim(), 坏: 行.includes('${productName}') }));
}

test('electron-builder.yml 的产物名都走 ${name}，不走 ${productName}', () => {
  const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8');
  const 全部 = 用了产物名模板(yml);

  // 一条都没扫到，多半是这个文件被重排过而不是「问题没了」——那种绿是假的
  assert.ok(全部.length >= 2, `只扫到 ${全部.length} 行 artifactName，至少该有 win 和 nsis 两处`);

  const 坏的 = 全部.filter((x) => x.坏).map((x) => x.行);
  assert.deepEqual(坏的, [], `这几行会让产物名带上中文、进 URL 就是一串转义：\n  ${坏的.join('\n  ')}`);

  // 顺带钉住「真的用了 ${name}」——全部删掉 artifactName 也能让上面那条绿
  assert.ok(全部.every((x) => x.行.includes('${name}')), '产物名模板该走 ${name}');
});

test('自检：合成一份坏的，判据要认出来', () => {
  const 坏 = 'win:\n  artifactName: ${productName}-${version}.${ext}\nnsis:\n  artifactName: ${name}-setup.${ext}\n';
  const 出 = 用了产物名模板(坏);
  assert.equal(出.length, 2);
  assert.deepEqual(出.map((x) => x.坏), [true, false]);
});
