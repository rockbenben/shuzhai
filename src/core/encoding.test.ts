import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWebPage } from './encoding.ts';

// 「中文」的 GBK 字节：中=D6 D0，文=CE C4
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4];
const ascii = (s: string) => [...new TextEncoder().encode(s)];

test('decodeWebPage：响应头声明 gb2312 时按 GBK 解（晋江/飞卢这类站）', () => {
  const buf = Uint8Array.from([...ascii('<html><title>'), ...GBK_ZHONGWEN, ...ascii('</title>')]);
  assert.ok(decodeWebPage(buf, 'text/html; charset=gb2312').includes('中文'));
});

test('decodeWebPage：响应头不带 charset 时扫 <meta>（晋江实测只有 meta 里写 gb18030）', () => {
  const buf = Uint8Array.from([
    ...ascii('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb18030"/></head><body>'),
    ...GBK_ZHONGWEN,
  ]);
  assert.ok(decodeWebPage(buf, 'text/html').includes('中文'));
});

test('decodeWebPage：声明 utf-8 时行为和 res.text() 一致', () => {
  const buf = new TextEncoder().encode('<html>中文简体</html>');
  assert.equal(decodeWebPage(buf, 'text/html; charset=utf-8'), '<html>中文简体</html>');
});

test('decodeWebPage：什么声明都没有时交给探测——UTF-8 页面不能被解坏', () => {
  const buf = new TextEncoder().encode('<html>中文简体小说</html>');
  assert.equal(decodeWebPage(buf, null), '<html>中文简体小说</html>');
});
