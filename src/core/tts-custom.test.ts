import test from 'node:test';
import assert from 'node:assert/strict';
import { engineFromDraft, importLegadoTts, normalizeLegadoUrl, parseEngines, serializeEngines } from './tts-custom.ts';
import { renderRequest } from './tts.ts';

/** 手填那条路：只要那句话，或者 null */
const 哪儿不对 = (d: Parameters<typeof engineFromDraft>[0]) => {
  const r = engineFromDraft(d);
  return 'error' in r ? r.error : null;
};
/** 手填那条路：只要引擎 */
const 造 = (d: Parameters<typeof engineFromDraft>[0]) => {
  const r = engineFromDraft(d);
  if ('error' in r) throw new Error(r.error);
  return r.engine;
};

/** 「阅读」导出的 httpTTS.json 长这样（字段名和真配置一致） */
function legado(over: Record<string, unknown> = {}) {
  return {
    name: '思必驰 灵动女声',
    url: 'https://dds.dui.ai/runtime/v1/synthesize?voiceId=x&text={{java.encodeURI(java.encodeURI(speakText))}}&speed=1',
    contentType: 'audio/wav',
    ...over,
  };
}

test('导入：认得出的模板翻译成 {text}，双重编码也认出来', () => {
  const { engines, skipped } = importLegadoTts(JSON.stringify([legado()]));
  assert.equal(skipped, 0);
  assert.equal(engines.length, 1);
  assert.equal(engines[0].name, '思必驰 灵动女声');
  assert.ok(engines[0].url.includes('text={text}'), engines[0].url);
  assert.ok(!/\{\{|\}\}/.test(engines[0].url), '不能留下 JS 模板的残骸');
  assert.equal(engines[0].double, true, 'encodeURI(encodeURI(...)) 是双重编码');
  assert.equal(engines[0].contentType, 'audio/wav');
});

test('导入：单次编码不该被当成双重', () => {
  const { engines } = importLegadoTts(
    JSON.stringify([legado({ url: 'https://x.test/?t={{java.encodeURI(speakText)}}' })]),
  );
  assert.equal(engines[0].double, false);
});

test('导入：跑别的 JS 的、缺字段的一律拒收，而且数出来', () => {
  // 这一条是「绝不执行配置里的 JS」那条铁律在导入口的兑现。
  // **拒收要数出来**——静默丢掉的话，用户以为导进来了，然后听到一片安静
  const raw = JSON.stringify([
    legado(),
    // 地址的**路径**里有一段算不明白的 JS：不是 key=value，不敢丢，整条拒
    legado({ name: '路径里有 JS', url: 'https://x.test/{{java.md5(key)}}/?t={{java.encodeURI(speakText)}}' }),
    legado({ name: '', url: 'https://x.test/?t={{java.encodeURI(speakText)}}' }),
    legado({ name: '没地址', url: '' }),
    // 逗号后面那坨不是 JSON：读不出来就不猜
    legado({ name: '参数坏了', url: 'https://x.test/say,{这不是 JSON' }),
  ]);
  const { engines, skipped } = importLegadoTts(raw);
  assert.equal(engines.length, 1, '只有第一条该进来');
  assert.equal(skipped, 4, '拒了几个要如实报出来');
});

test('导入：同名的只留一条', () => {
  const { engines, skipped } = importLegadoTts(JSON.stringify([legado(), legado()]));
  assert.equal(engines.length, 1);
  assert.equal(skipped, 1);
});

test('导入：不是 JSON 要说人话', () => {
  assert.throws(() => importLegadoTts('<html>'), /httpTTS\.json/);
});

test('取用那头也要过一遍关：库里的坏引擎不许发出去', () => {
  // 这一列跟着备份走，也能被用文本编辑器改。同 backup.ts 那条
  // 「一张表有前门校验，就要问一句还有没有别的门」
  const 好的 = { id: 'a', name: '好的', url: 'https://x.test/?t={text}', double: false, contentType: 'audio/mpeg' };
  const raw = JSON.stringify([
    好的,
    { id: 'b', name: '留着 JS 模板', url: 'https://x.test/?t={{java.exec(1)}}', double: false, contentType: 'audio/mpeg' },
    { id: 'c', name: '不是 http', url: 'file:///c:/x?t={text}', double: false, contentType: 'audio/mpeg' },
    { id: 'd', name: '没有占位符', url: 'https://x.test/say', double: false, contentType: 'audio/mpeg' },
    null,
  ]);
  const list = parseEngines(raw);
  assert.deepEqual(list.map((e) => e.id), ['a']);
  // 存坏了不该让整个朗读挂掉——读不出来就当一个都没有
  assert.deepEqual(parseEngines('{不是 json'), []);
  assert.deepEqual(parseEngines(null), []);
  assert.deepEqual(parseEngines('{"a":1}'), [], '不是数组也别炸');
  assert.deepEqual(parseEngines(serializeEngines([好的])), [好的], '存进去再取出来要一模一样');
});

test('手填：每一种填错都要说清是哪一格、该改成什么', () => {
  const 好的 = { name: '甲', url: 'https://x.test/?t={text}' };
  assert.equal(哪儿不对(好的), null);

  // **判据是「说了怎么办」**，不是「报了错」——只断言非空的话，
  // 把所有分支改成同一句「填错了」也能全绿
  assert.match(哪儿不对({ ...好的, name: '' }) ?? '', /起个名字/);
  assert.match(哪儿不对({ ...好的, name: '甲'.repeat(41) }) ?? '', /最多 40/);
  assert.match(哪儿不对({ ...好的, url: '' }) ?? '', /地址/);
  assert.match(哪儿不对({ ...好的, url: 'ftp://x.test/?t={text}' }) ?? '', /http/);
  assert.match(哪儿不对({ ...好的, url: 'https://x.test/say' }) ?? '', /要念的那一段/);
  assert.match(哪儿不对({ ...好的, url: 'https://x.test/?a={text}&b={text}' }) ?? '', /只能有一处/);
  assert.match(哪儿不对({ ...好的, contentType: '乱写的' }) ?? '', /audio\/mpeg/);
  // 逗号后面那坨读不出来
  assert.match(哪儿不对({ ...好的, url: 'https://x.test/say,{这不是 JSON' }) ?? '', /读不出来/);
});

test('手填：整行 legado 的 url 贴进来要能自动处理', () => {
  /*
   * ⚠️ **这条是踩出来的。** 原来手填只认「已经写好 {text} 的 GET 地址」，
   * 用户把百度那一行贴进地址格，撞了一句「把要念的那一段换成 {text} 就行」
   * ——**而他照做也做不到**：那一行还带着逗号后面那坨、还有 spd={{…}}。
   * 「说了怎么办」的前提是那件事真的做得到。
   *
   * 导入和手填现在共用 `normalizeLegadoUrl`，**同一份约定只此一份**。
   */
  // ① 光是 GET 地址，带着 legado 的 JS 模板
  const gets = 造({ name: '甲', url: 'https://x.test/?t={{java.encodeURI(java.encodeURI(speakText))}}' });
  assert.equal(gets.url, 'https://x.test/?t={text}');
  assert.equal(gets.double, true, '双重编码要从那一行认出来，不用他自己勾');

  // ② 整行百度：POST + 一格算不明白的 JS
  const r = engineFromDraft({ name: '百度语音', url: 百度.url });
  assert.ok(!('error' in r), 'error' in r ? r.error : '');
  if ('error' in r) return;
  assert.equal(r.engine.method, 'POST');
  assert.equal(r.engine.url, 'http://tts.baidu.com/text2audio');
  assert.ok(r.engine.body?.includes('tex={text}'));
  assert.deepEqual(r.dropped, ['spd'], '丢了哪一格手填这条路也要说');

  // ③ 真认不出来的才报错，而且**说的是真正那一样**
  assert.match(
    哪儿不对({ name: '甲', url: 'https://x.test/{{java.md5(k)}}/?t={{java.encodeURI(speakText)}}' }) ?? '',
    /不在「参数名=值」的位置/,
  );
});

test('手填：id 按名字生成，前后空格不算数，音频类型不填给默认', () => {
  const e = 造({ name: '  我的引擎  ', url: '  https://x.test/?t={text}  ' });
  assert.equal(e.name, '我的引擎');
  assert.equal(e.id, 'user-我的引擎');
  assert.equal(e.url, 'https://x.test/?t={text}');
  assert.equal(e.double, false);
  assert.equal(e.contentType, 'audio/mpeg');
  // 手填的这份也得过取用那道关，不然存进去了却发不出去
  assert.deepEqual(parseEngines(serializeEngines([e])), [e]);
});

/**
 * 用户给的真配置（百度）。**这条以前整条被拒**：导入器只切到逗号为止，
 * 剩下的地址里一个 `{text}` 都没有。
 */
const 百度 = {
  name: '百度语音',
  url: 'http://tts.baidu.com/text2audio,{ "method": "POST", "body": "tex={{java.encodeURI(java.encodeURI(speakText))}}&spd={{(speakSpeed + 50) / 10 + 4}}&per=3&cuid=baidu_speech_demo&idx=1&cod=2&lan=zh&ctp=1&pdt=505&vol=5&aue=6&pit=5&_res_tag_=audio" }',
  contentType: 'audio/mpeg',
};

test('导入：`地址,{JSON}` 的 POST 引擎收得下', () => {
  const { engines, skipped, dropped } = importLegadoTts(JSON.stringify([百度]));
  assert.equal(skipped, 0);
  assert.equal(engines.length, 1);
  const e = engines[0];
  assert.equal(e.url, 'http://tts.baidu.com/text2audio', '逗号后面那坨不许留在地址里');
  assert.equal(e.method, 'POST');
  assert.equal(e.double, true, 'encodeURI(encodeURI(...)) 是双重编码');
  assert.ok(e.body?.includes('tex={text}'), e.body ?? '(没有 body)');
  // **算不明白的那一格整个丢掉，不去执行它**——铁律：不跑配置里的 JS
  assert.ok(!/\{\{|\}\}/.test(e.body ?? ''), '不许留下没转干净的 JS：' + e.body);
  assert.ok(!e.body?.includes('spd='), 'spd 那一格是 JS 算术，该丢掉');
  assert.deepEqual(dropped, ['spd'], '丢了哪一格要说出来，不然用户以为语速滑块坏了');
  // 其余参数一个都不许少——少一个百度就不给音频
  for (const k of ['per=3', 'cuid=baidu_speech_demo', 'lan=zh', 'aue=6', '_res_tag_=audio']) {
    assert.ok(e.body?.includes(k), `${k} 没了：${e.body}`);
  }
});

test('导入：{{ }} 不在 key=value 里就不敢丢，整条拒收', () => {
  // 丢一个参数是「那一项用服务默认值」，而在别的位置乱丢会把请求改成另一个意思。
  // **分不出来的时候别下结论**——这条规矩本仓库记了好几遍
  const 怪的 = { name: '怪的', url: 'https://x.test/{{java.md5(k)}}/say?t={{java.encodeURI(speakText)}}' };
  const { engines, skipped } = importLegadoTts(JSON.stringify([怪的]));
  assert.equal(engines.length, 0);
  assert.equal(skipped, 1);
});

test('导入：参数串里那段 {{ }} 不是 key=value，就不敢丢——整条拒收', () => {
  /*
   * 丢一个 `key=value` 是「那一项用服务自己的默认值」，代价看得懂；
   * 而在别的位置乱丢会把请求改成**另一个意思**，代价看不懂。
   * **分不出来的时候别下结论**——这条规矩本仓库记了好几遍。
   *
   * ⚠️ 这条测试是补出来的：原来那个诱饵把 JS 放在地址的**路径**里，
   * 走的是另一条分支（那一段压根不进 `丢掉看不懂的`），
   * 于是那道守卫拆掉也没人红。**一条谁都不靠的断言等于没有断言。**
   */
  const 怪的 = {
    name: '参数串里有裸 JS',
    url: 'https://x.test/say,{ "method": "POST", "body": "tex={{java.encodeURI(speakText)}}&{{java.md5(k)}}&per=3" }',
  };
  const { engines, skipped } = importLegadoTts(JSON.stringify([怪的]));
  assert.equal(engines.length, 0, '不敢丢就该整条拒掉，不能悄悄改了请求还收下');
  assert.equal(skipped, 1);
});

test('导入：{{ }} 里面的 & 不算参数分隔符', () => {
  const e = { name: '带与号的', url: 'https://x.test/?t={{java.encodeURI(speakText)}}&f={{a && b}}&keep=1' };
  const { engines, dropped } = importLegadoTts(JSON.stringify([e]));
  assert.equal(engines.length, 1);
  assert.deepEqual(dropped, ['f']);
  assert.ok(engines[0].url.endsWith('?t={text}&keep=1'), engines[0].url);
});

/**
 * 用户给的第二条真配置（Azure）。**body 是一整段 SSML，不是 form**——
 * 这条以前报「这一行里找不到要念的那一段」，而 `{{speakText}}` 其实早认出来了：
 * 是「丢掉算不明白的参数」那一步拿 form 的刀去切 XML，把整段 body 当成
 * 一个 `key=value`（`version="1.0"` 那个等号）整个丢掉了。
 */
const Azure = {
  name: 'Azure 云希',
  url: 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1,'
    + '{"method":"POST","body":"<speak version=\\"1.0\\" xml:lang=\\"zh-CN\\">'
    + '<voice name=\\"zh-CN-YunxiNeural\\"><prosody rate=\\"{{speakSpeed*4}}%\\" pitch=\\"default\\">'
    + '{{speakText}}</prosody></voice></speak>",'
    + '"headers":{"Ocp-Apim-Subscription-Key":"KEY","Content-Type":"application/ssml+xml",'
    + '"X-Microsoft-OutputFormat":"audio-24khz-48kbitrate-mono-mp3","User-Agent":"legado"}}',
};

test('导入：body 是 SSML 的（Azure）——整段留住，只去掉算不明白的那个属性', () => {
  const { engines, skipped, dropped } = importLegadoTts(JSON.stringify([Azure]));
  assert.equal(skipped, 0);
  const e = engines[0];
  assert.equal(e.method, 'POST');
  assert.equal(e.url, 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
  // 整段 SSML 要还在，正文那一格换成 {text}
  assert.ok(e.body?.startsWith('<speak'), e.body ?? '(没有 body)');
  assert.ok(e.body?.includes('>{text}</prosody>'), e.body ?? '');
  assert.ok(e.body?.includes('zh-CN-YunxiNeural'), '别的属性一个都不许丢');
  // rate 那一格是 JS 算术：**整个属性去掉**，留下 rate="%" 是非法值，Azure 会当场拒
  assert.ok(!e.body?.includes('rate='), e.body ?? '');
  assert.ok(e.body?.includes('pitch="default"'), '同一个标签上别的属性不许受连累');
  assert.deepEqual(dropped, ['rate']);
  // header 非要不可：少了密钥是 401，少了 Content-Type 是 400
  assert.equal(e.headers?.['Ocp-Apim-Subscription-Key'], 'KEY');
  assert.equal(e.headers?.['Content-Type'], 'application/ssml+xml');
});

test('SSML 的 body 要 XML 转义，不是 percent 编码', () => {
  const { engines } = importLegadoTts(JSON.stringify([Azure]));
  const { url, init } = renderRequest(engines[0], '他说「a<b & c」。');
  assert.equal(url, 'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
  // percent 编码塞进 SSML，念出来是一串「百分之四十五」
  const 发出去的 = String(init.body);
  assert.ok(!发出去的.includes('%'), 发出去的);
  assert.ok(发出去的.includes('a&lt;b &amp; c'), 发出去的);
  assert.equal((init.headers as Record<string, string>)['Ocp-Apim-Subscription-Key'], 'KEY');
});
