import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderUrl, renderRequest, validEngine, splitForTts } from './tts.ts';
import type { TtsEngine } from './tts.ts';
import { BUILTIN_TTS } from './builtin-tts.ts';

const engine = (over = {}) => ({
  id: 't', name: '测试', url: 'https://x.test/say?text={text}', double: false,
  contentType: 'audio/wav', ...over,
});

test('URL 模板只替换 {text}，正文做 URI 编码', () => {
  assert.equal(renderUrl(engine(), '你好'), 'https://x.test/say?text=%E4%BD%A0%E5%A5%BD');
});

test('双重编码的引擎真的编两次', () => {
  // 少编一层拿回来的是乱码，而且**不报错**——服务端照样返回音频，只是念的是乱码
  const once = encodeURIComponent('你好');
  assert.equal(renderUrl(engine({ double: true }), '你好'), `https://x.test/say?text=${encodeURIComponent(once)}`);
});

test('正文里的 & 和 = 不会把 URL 参数搞乱', () => {
  const url = renderUrl(engine(), 'a&b=c');
  assert.ok(url.endsWith('text=a%26b%3Dc'), url);
});

test('带 {{...}} 的模板一律非法——那是没转换干净的 JS 表达式', () => {
  // 放行它等于执行陌生人给的代码
  assert.equal(validEngine(engine({ url: 'https://x.test/?t={{java.encodeURI(speakText)}}' })), false);
  assert.equal(validEngine(engine({ url: 'https://x.test/?t={text}&x={{java.md5(1)}}' })), false);
});

test('占位符必须有且只有一个', () => {
  assert.equal(validEngine(engine({ url: 'https://x.test/say' })), false);
  assert.equal(validEngine(engine({ url: 'https://x.test/?a={text}&b={text}' })), false);
  assert.equal(validEngine(engine()), true);
});

test('非 http 的一律不认', () => {
  assert.equal(validEngine(engine({ url: 'file:///c:/x?t={text}' })), false);
  assert.equal(validEngine(engine({ url: 'javascript:alert(1){text}' })), false);
});

test('随应用发布的引擎：一个都没有，而且真放了也得合法', () => {
  // **默认零个在线引擎**，这是「在线引擎会把正文发到第三方服务器」那条限制
  // 的兑现方式——比一句界面提示硬。哪天真放一个进去，下面两条照样管着它
  assert.equal(BUILTIN_TTS.length, 0, '默认不该带任何在线引擎——用户自己的那些存在他自己的库里');
  for (const e of BUILTIN_TTS) assert.ok(validEngine(e), `${e.name}: ${e.url}`);
  assert.equal(new Set(BUILTIN_TTS.map((e) => e.id)).size, BUILTIN_TTS.length, 'id 不能重复');
});

test('切段：在句末标点处断，不丢字', () => {
  const text = '第一句话在这里。第二句话也在这里！第三句话呢？还有第四句。';
  const parts = splitForTts(text, 12);
  assert.ok(parts.length > 1);
  assert.equal(parts.map((p) => p.text).join(''), text.replace(/\s/g, ''), '一个字都不能丢');
  for (const p of parts) assert.ok(/[。！？…；]$/.test(p.text), `没断在句末: ${p.text}`);
});

test('切段：没有标点的长段也不会卡住', () => {
  // 硬切总比整章念不了强
  const text = '啊'.repeat(500);
  const parts = splitForTts(text, 100);
  assert.ok(parts.length >= 5);
  assert.equal(parts.map((p) => p.text).join(''), text);
});

test('切段：整行只有符号的不发出去', () => {
  // 抄 legado 的 notReadAloudRegex。真实书库里 39.7% 的书有独立成行的 `……`，
  // 发给在线引擎是纯浪费的一次请求，而念一章本来就要发几十次
  const text = '少年提剑出门。\n……\n※※※\n***\n———\n风雪满衣。';
  const parts = splitForTts(text, 180);
  assert.deepEqual(parts.map((p) => p.text), ['少年提剑出门。', '风雪满衣。']);
  // 剩下的段落 at 仍然要对得上原文
  for (const p of parts) assert.equal(text.slice(p.at, p.at + p.text.length), p.text);
});

test('切段：每一段都能在原文里按 at 定位——跟读高亮靠它', () => {
  const text = '少年提剑出门。风雪满衣。他走了很远，很远。';
  for (const p of splitForTts(text, 10)) {
    assert.equal(text.slice(p.at, p.at + p.text.length), p.text, `at 对不上: ${JSON.stringify(p)}`);
  }
});

test('切段：空白和空行不会变成空段', () => {
  // 空段发给在线引擎就是一次白跑的请求，发给系统语音则是一次莫名其妙的停顿
  const parts = splitForTts('第一段。\n\n\n   \n第二段。', 50);
  assert.deepEqual(parts.map((p) => p.text), ['第一段。', '第二段。']);
});

test('原来的实现只念前 4000 字——现在整章都切得出来', () => {
  const text = '这是一句测试的话。'.repeat(1200); // 约 10800 字
  const parts = splitForTts(text);
  assert.equal(parts.map((p) => p.text).join('').length, text.length);
  assert.ok(parts.length > 50);
});

test('POST 引擎：正文在 body 里，地址原样发出去', () => {
  // 「阅读」里百度那条就是这个形状。正文不在地址里——**所以 {text} 要合起来数**
  const e: TtsEngine = {
    id: 'p', name: '百度', url: 'http://tts.baidu.com/text2audio',
    double: true, contentType: 'audio/mpeg',
    method: 'POST', body: 'tex={text}&per=3&lan=zh',
  };
  assert.ok(validEngine(e), '地址里没有 {text} 不代表它非法');

  const { url, init } = renderRequest(e, '你好');
  assert.equal(url, 'http://tts.baidu.com/text2audio', '地址不许被填进去什么');
  assert.equal(init.method, 'POST');
  assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/x-www-form-urlencoded');
  // 双重编码要真的编两遍，少一层拿回来的是乱码
  assert.equal(init.body, `tex=${encodeURIComponent(encodeURIComponent('你好'))}&per=3&lan=zh`);
});

test('POST 引擎：body 里留着 JS 模板，或者两处各一个 {text}，都算非法', () => {
  const base = { id: 'p', name: 'x', url: 'http://x.test/say', double: false, contentType: 'audio/mpeg' };
  assert.equal(validEngine({ ...base, method: 'POST', body: 'tex={{java.md5(k)}}&a={text}' }), false);
  // 一次请求只念一段文字，两个占位符说明哪儿理解错了
  assert.equal(validEngine({ ...base, url: 'http://x.test/?t={text}', method: 'POST', body: 'tex={text}' }), false);
  // POST 却没有 body：形状对不上
  assert.equal(validEngine({ ...base, method: 'POST', body: '' }), false);
});

test('GET 引擎照旧：地址填进去、不发 body', () => {
  const { url, init } = renderRequest(engine(), '你好');
  assert.equal(url, 'https://x.test/say?text=%E4%BD%A0%E5%A5%BD');
  assert.equal(init.method, undefined);
  assert.equal(init.body, undefined);
});
