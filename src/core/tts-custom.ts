// 用户自己的朗读引擎——**存在他自己的库里，不进仓库**。
//
// 起因是用户的一句话：**「有些设置是私人化的，可能不方便分享，比如 tts 源，
// 默认设置只是系统离线语言，我其他加入的源只放在个人设置里。」**
//
// 这个仓库原来在 `builtin-tts.ts` 里**硬编码了 89 个在线朗读引擎**，
// 而那份名单是用户自己从几份「阅读」配置里挑出来、逐条探活验过的——
// 它是**他的东西**，跟着代码一起被分享出去不合适。
//
// 所以：**发布出去的应用只有系统离线语音**（Chromium 自带的 speechSynthesis，
// 不外发一个字）；谁想用在线引擎，自己导一份进来，存在他自己的
// `app_setting` 里（和「自定义封面源」同一个路子）。
//
// ⚠️ **安全那三条一条没松**，见 `tts.ts` 的 `validEngine`：
// 只认「把正文做 URI 编码填进一个 `{text}`」这一种模板，URL 里残留任何
// `{{ }}` 都判不合法——**绝不执行配置里的 JS**。这些文件仍然是从别处拿来的。

import type { TtsEngine } from './tts.ts';
import { validEngine } from './tts.ts';

/** 存在 `app_setting` 里的键。和 `cover.customSources` 同一个形态：一串 JSON */
export const TTS_ENGINES_KEY = 'tts.userEngines';

export function parseEngines(raw: string | null): TtsEngine[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as TtsEngine[];
    if (!Array.isArray(list)) return [];
    // **存进去的也要再验一遍**：这一列是用户能用文本编辑器改的（备份是 JSON），
    // 而 `tts.fetch` 拿它去发请求。同 `backup.ts` 那条「前门严、后门也得严」
    return list.filter((e) => e && typeof e.id === 'string' && typeof e.url === 'string' && validEngine(e));
  } catch {
    return [];
  }
}

export function serializeEngines(list: TtsEngine[]): string {
  return JSON.stringify(list);
}

/** 一条 legado 的 `url` 归一化之后的样子 */
export interface NormalizedUrl {
  url: string;
  method?: 'POST';
  body?: string;
  headers?: Record<string, string>;
  double: boolean;
  /** 算不明白、整个丢掉的那几格参数名 */
  dropped: string[];
}

/**
 * 把「阅读」里那一格 `url` 变成我们的形状。**导入和手填共用这一份。**
 *
 * ⚠️ 这个函数是补出来的，起因是一次真实的踩坑：POST 那种形状只有**导入**
 * 认得，而用户把同一行贴进**手填**的地址格，撞了一句
 * 「地址里还留着 {{...}}……把要念的那一段换成 {text} 就行」——
 * 一句**他照做也做不到**的话（那一行还有 `spd={{…}}`、还有逗号后面那坨）。
 * **同一份约定抄成两份必然分叉**，这次分叉的是「哪种写法认得」。
 *
 * 认得两种形状：光是地址（GET），和 `地址,{ "method":"POST","body":"…" }`。
 * 认不出来的返回一句**给人看的**话。
 */
export function normalizeLegadoUrl(raw: string): NormalizedUrl | { error: string } {
  const 原 = (raw ?? '').trim();
  if (!原) return { error: '把地址填上，正文要发到那儿去' };

  // `地址,{JSON}` —— 逗号后面那坨是请求参数。**从第一个 `,{` 断开**
  const 断点 = 原.search(/,\s*\{/);
  let 地址 = 断点 >= 0 ? 原.slice(0, 断点) : 原;
  let method: 'POST' | undefined;
  let body: string | undefined;
  let headers: Record<string, string> | undefined;
  if (断点 >= 0) {
    let opt: Record<string, unknown>;
    try {
      opt = JSON.parse(原.slice(断点 + 1)) as Record<string, unknown>;
    } catch {
      return { error: '地址后面那段 { … } 读不出来（不是合法的 JSON），整行照原样贴进来试试' };
    }
    // header 只收「名字和值都是字符串」的那些，别的形状不猜
    if (opt.headers && typeof opt.headers === 'object') {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(opt.headers as Record<string, unknown>)) {
        if (typeof v === 'string') h[k] = v;
      }
      if (Object.keys(h).length) headers = h;
    }
    if (String(opt.method ?? 'GET').toUpperCase() === 'POST') {
      method = 'POST';
      body = typeof opt.body === 'string' ? opt.body : '';
    } else if (typeof opt.body === 'string' && opt.body) {
      // 不是 POST 却带着 body，形状对不上，不敢猜
      return { error: '地址后面那段 { … } 带着 body 却不是 POST，这种形状认不出来' };
    }
  }

  if (!/^https?:\/\//.test(地址)) return { error: '地址要以 http:// 或 https:// 开头' };

  const u = 换掉正文占位(地址);
  地址 = u.out;
  let double = u.double;
  if (body !== undefined) {
    const b = 换掉正文占位(body);
    body = b.out;
    double = double || b.double;
  }

  // 剩下的 `{{ }}` 一律丢掉那一个参数（算不明白就不算）
  const dropped: string[] = [];
  const 问号 = 地址.indexOf('?');
  if (问号 >= 0) {
    const r = 丢掉看不懂的(地址.slice(问号 + 1));
    地址 = 地址.slice(0, 问号 + 1) + r.out;
    dropped.push(...r.dropped);
  }
  if (body !== undefined) {
    const r = 丢掉看不懂的(body);
    body = r.out;
    dropped.push(...r.dropped);
  }

  const 模板 = 地址 + (body ?? '');
  if (/\{\{|\}\}/.test(模板)) {
    return {
      error: '这一行里有一段 JS 算不明白，而且它不在「参数名=值」的位置上，'
        + '不敢替你猜——这个应用不跑配置里的 JS。把那一段删掉，或者换一条引擎',
    };
  }
  const n = 模板.split('{text}').length - 1;
  if (n === 0) {
    return {
      error: '这一行里找不到「要念的那一段」。「阅读」的配置写的是 {{java.encodeURI(speakText)}}，'
        + '手填的话直接写 {text}',
    };
  }
  if (n > 1) return { error: `要念的那一段出现了 ${n} 次，只能有一处` };

  return { url: 地址, double, dropped, ...(method ? { method, body } : {}), ...(headers ? { headers } : {}) };
}

/**
 * 从「阅读」（legado）的 `httpTTS.json` 导一份进来。
 *
 * 那份配置里的 URL 可以写 `{{java.encodeURI(speakText)}}` 这种 JS 模板，
 * 而我们**只认一种**：把正文 URI 编码之后填进去。所以这里做的事就是
 * 把认得出的那一种翻译成 `{text}`，其余**一律拒收**并数出来告诉用户——
 * 静默丢掉的话，他会以为导进来了、然后在某个引擎上听到一片安静。
 *
 * `double` 是原配置里 `encodeURI(encodeURI(...))` 那种双重编码，真实存在。
 */
/** 按 `&` 切成一段一段，**`{{ }}` 里面的 `&` 不算分隔符**（`{{a && b}}` 真的存在） */
function 切参数(s: string): string[] {
  const out: string[] = [];
  let 起点 = 0;
  let 深 = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('{{', i)) { 深++; i++; continue; }
    if (s.startsWith('}}', i)) { 深 = Math.max(0, 深 - 1); i++; continue; }
    if (s[i] === '&' && 深 === 0) { out.push(s.slice(起点, i)); 起点 = i + 1; }
  }
  out.push(s.slice(起点));
  return out;
}

/**
 * 丢掉还带着 `{{ }}` 的那些参数，返回丢了哪几个（按参数名）。
 *
 * ⚠️ **这是「不认识就不猜」，不是「算一下」。** 百度那条的 `spd` 写的是
 * `{{(speakSpeed + 50) / 10 + 4}}`——一段拿用户语速做算术的 JS。
 * 要支持它就得有个表达式求值器，而那正是本仓库那条铁律拒绝的东西
 * （`tts.ts` 顶上：「多几个音色换『跑陌生人的代码』，这笔账怎么算都不划算」）。
 *
 * 丢掉这一个参数的代价是**那一项用服务自己的默认值**（百度不给 `spd` 就是默认语速），
 * 而收益是整条引擎能用了——比整条拒收强得多。**但必须报出来**：
 * 用户得知道语速那一格没搬过来，不然他会以为是应用的语速滑块坏了。
 */
function 丢掉看不懂的(s: string): { out: string; dropped: string[] } {
  // **XML 和 form 是两种东西，不能用同一把刀。**
  // 这一条是踩出来的：Azure 的 body 是一整段 SSML，里面没有 `&`，
  // 于是整段被当成**一个** `key=value`（`version="1.0"` 那个等号）**整个丢掉**，
  // 用户看到的是「这一行里找不到要念的那一段」——而那一段其实早就认出来了。
  return /<[a-zA-Z?!/]/.test(s) ? 丢掉标记里的属性(s) : 丢掉表单里的参数(s);
}

/**
 * XML/SSML：把带着 `{{ }}` 的**整个属性**去掉。
 *
 * Azure 那条是 `rate="{{speakSpeed*4}}%"`——**这一格在 SSML 里本来就是可选的**，
 * 去掉整个属性，`<prosody pitch="default">` 照样合法，语速就是服务的默认。
 * 只把 `{{…}}` 抠掉是不行的：留下 `rate="%"` 是个非法值，Azure 会当场拒。
 *
 * 属性之外还留着 `{{ }}`（比如在文本内容里）就不动它——外面 `validEngine`
 * 会把整条拒掉。**分不出来的时候别下结论。**
 */
function 丢掉标记里的属性(s: string): { out: string; dropped: string[] } {
  const dropped: string[] = [];
  const out = s.replace(
    /\s+([\w:.-]+)\s*=\s*(["'])[^"']*\{\{[^"']*\2/g,
    (_m, name: string) => { dropped.push(name); return ''; },
  );
  return { out, dropped };
}

/** form / query string：把带着 `{{ }}` 的**整个 `key=value`** 去掉 */
function 丢掉表单里的参数(s: string): { out: string; dropped: string[] } {
  const dropped: string[] = [];
  const 留下 = 切参数(s).filter((seg) => {
    if (!/\{\{/.test(seg)) return true;
    const 等号 = seg.indexOf('=');
    // 不是 `key=value` 的形状就不敢动——整条引擎会在外面被 validEngine 拒掉
    if (等号 <= 0) return true;
    dropped.push(seg.slice(0, 等号));
    return false;
  });
  return { out: 留下.join('&'), dropped };
}

/**
 * 把认得出的那种 JS 模板换成 `{text}`，并说一句是不是双重编码。
 *
 * **只认这两种**：`{{java.encodeURI(speakText)}}` 和它套两层的写法。
 * 别的一概不碰——留在原地，由 `validEngine` 把整条拒掉。
 */
function 换掉正文占位(s: string): { out: string; double: boolean } {
  const double = /\{\{\s*java\.encodeURI\s*\(\s*java\.encodeURI\s*\([^}]*?\)[^}]*?\)\s*\}\}/.test(s);
  return { out: s.replace(/\{\{[^{}]*speakText[^{}]*\}\}/g, '{text}'), double };
}

/**
 * 从「阅读」（legado）的 `httpTTS.json` 导一份进来。
 *
 * 那份配置里的 `url` 有两种形状：
 *
 *   - 光是地址（GET）：`https://…/synthesize?text={{java.encodeURI(speakText)}}&…`
 *   - **地址加一坨请求参数**（多半是 POST）：
 *     `http://tts.baidu.com/text2audio,{ "method": "POST", "body": "tex={{…}}&spd={{…}}&…" }`
 *
 * 第二种以前整条拒收（只切到逗号为止，剩下的地址里没有 `{text}`）。现在两种都收。
 *
 * ⚠️ **仍然一行配置里的 JS 都不执行**：只把「正文那一格」翻译成 `{text}`，
 * 别的 `{{ }}` 参数整个丢掉（见 `丢掉看不懂的`），一个都算不明白就把整条拒掉。
 *
 * 拒了几个、丢了哪些参数都返回出去——**静默丢掉的话，用户会以为导进来了、
 * 然后在某个引擎上听到一片安静，或者以为语速滑块坏了**。
 */
export function importLegadoTts(raw: string): {
  engines: TtsEngine[];
  skipped: number;
  dropped: string[];
} {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('这不是一份 JSON。「阅读」里导出的朗读引擎是 httpTTS.json');
  }
  const list = Array.isArray(data) ? data : [data];
  const out: TtsEngine[] = [];
  const dropped: string[] = [];
  let skipped = 0;

  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? '').trim();
    const raw地址 = String(o.url ?? '');
    if (!name || !raw地址) { skipped++; continue; }

    const r = normalizeLegadoUrl(raw地址);
    if ('error' in r) { skipped++; continue; }
    dropped.push(...r.dropped);

    const e: TtsEngine = {
      id: `user-${name}`.slice(0, 60),
      name,
      url: r.url,
      double: r.double,
      contentType: String(o.contentType ?? 'audio/mpeg'),
      ...(r.method ? { method: r.method, body: r.body } : {}),
      ...(r.headers ? { headers: r.headers } : {}),
    };
    if (!validEngine(e)) { skipped++; continue; }
    out.push(e);
  }

  // 同名的只留第一条：id 是按名字生成的，重复会让「选中的是哪一个」说不清
  const seen = new Set<string>();
  const engines = out.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  return { engines, skipped: skipped + (out.length - engines.length), dropped: [...new Set(dropped)] };
}

/** 手填一个引擎要填的那几格。`contentType` 不填就用默认 */
export interface EngineDraft {
  name: string;
  url: string;
  double?: boolean;
  contentType?: string;
}

/**
 * 手填的这份变成一条引擎，或者返回一句**给人看的**话说哪儿不对。
 *
 * ⚠️ **地址那一格收的东西和导入完全一样**——整行 legado 的 `url` 贴进来也行
 * （带 `,{ "method":"POST", … }`、带 `{{java.encodeURI(speakText)}}` 都认）。
 * 原来这里只认「已经写好 `{text}` 的 GET 地址」，用户把百度那行贴进来，
 * 撞了一句「把要念的那一段换成 {text} 就行」——**而他照做也做不到**。
 * 「说了怎么办」的前提是那件事真的做得到。
 *
 * `validEngine` 只回 true/false，对**导入**够用（整份文件成批过一遍），
 * 对**手填**不够：用户对着一个输入框，得知道是哪一格、错在哪儿。
 */
export function engineFromDraft(
  d: EngineDraft,
): { engine: TtsEngine; dropped: string[] } | { error: string } {
  const name = (d.name ?? '').trim();
  if (!name) return { error: '给它起个名字——朗读设置的下拉里显示的就是这个' };
  if (name.length > 40) return { error: `名字太长了（${name.length} 个字，最多 40 个）` };
  if (d.contentType && !/^[\w.+-]+\/[\w.+-]+$/.test(d.contentType.trim())) {
    return { error: '音频类型要写成 audio/mpeg 这样的形式，不填就按 audio/mpeg 算' };
  }

  const r = normalizeLegadoUrl(d.url ?? '');
  if ('error' in r) return r;

  const engine: TtsEngine = {
    // id 按名字生成，和导入那条路一致：同名的就是同一个，不会悄悄多出一条
    id: `user-${name}`.slice(0, 60),
    name,
    url: r.url,
    // 手填时勾了「编码两遍」就听他的；贴的是 legado 那行就按那行说的算
    double: r.double || !!d.double,
    contentType: d.contentType?.trim() || 'audio/mpeg',
    ...(r.method ? { method: r.method, body: r.body } : {}),
    ...(r.headers ? { headers: r.headers } : {}),
  };
  if (!validEngine(engine)) return { error: '这一行认不出来，换一条引擎试试' };
  return { engine, dropped: r.dropped };
}
