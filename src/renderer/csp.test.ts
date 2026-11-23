import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CSP, injectCsp } from './csp.ts';

test('CSP 注入到 head 里，content 就是那份策略', () => {
  const html = injectCsp('<html><head><title>书斋</title></head><body></body></html>');
  assert.ok(html.includes('<meta http-equiv="Content-Security-Policy"'));
  assert.ok(html.includes(`content="${CSP}"`));
  // 必须落在 head 里：放到 body 里 Chromium 当作页面内容，一句错都不报
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('</head>'));
});

test('注入是幂等的——不会因为别处也插一次就多出一条策略', () => {
  const once = injectCsp('<html><head></head></html>');
  assert.equal(injectCsp(once), once);
  assert.equal(once.split('Content-Security-Policy').length - 1, 1);
});

test('没有 head 就抛，不静静地返回一个没策略的产物', () => {
  assert.throws(() => injectCsp('<html><body>没有 head</body></html>'), /没有 <head>/);
});

test('策略本身钉死几件事：不许 eval、不许 inline script、base-uri 不是 none', () => {
  assert.ok(!CSP.includes('unsafe-eval'), '引入 eval 的依赖会把这条打穿，先回来改策略而不是顺手放行');
  assert.match(CSP, /(?:^|; )script-src 'self'(?:;|$)/, 'inline script 一旦放行，注入一段 <script> 就是执行一段脚本');
  // ⚠️ 这条钉的是 ebook 的可用性：epub.js 靠 <base href> 解析章节里的相对资源，
  // base-uri 写成 'none' 时它不报错，只是图片和样式全部静默失效
  assert.match(CSP, /(?:^|; )base-uri 'self'(?:;|$)/);
  assert.match(CSP, /(?:^|; )default-src 'none'(?:;|$)/);
});
