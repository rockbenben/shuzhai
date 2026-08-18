// 朗读（spec §6 的「朗读」）。两种引擎：
//
//   - **系统语音**（Chromium 自带的 `speechSynthesis`）：离线、不外发、零依赖。**默认用这个。**
//   - **在线引擎**：HTTP 拿音频。音色多得多（内置 89 个思必驰音色，含七种方言），
//     代价是**会把正文发到第三方服务器**。
//
// 这个模块只管在线引擎里可以纯函数化的部分：URL 模板怎么填、正文怎么切段。
// 真正发请求在主进程（渲染进程发跨域请求会被 CORS 挡掉，而且 AGENTS.md 规定 I/O 在主进程）。
//
// ⚠️ **绝不执行配置里的 JS。** 原始「阅读」配置的 URL 里可以写 `{{java.xxx}}`，
// `loginUrl` / `loginCheckJs` 更是任意代码。那些文件是别人给的。这里只认一件事：
// 把正文做 URI 编码填进去。别为了多支持几个引擎把这条放宽——
// 多几个音色换「跑陌生人的代码」，这笔账怎么算都不划算。

import type { TtsEngine } from './builtin-tts.ts';
import { hasReadable } from './format.ts';

export type { TtsEngine };

/**
 * 把正文填进 URL 模板。
 *
 * `double` 对应原配置里的 `java.encodeURI(java.encodeURI(speakText))`——
 * 那些服务真的要双重编码，少编一层拿回来的是乱码而不是报错。
 */
export function renderUrl(engine: TtsEngine, text: string): string {
  const once = encodeURIComponent(text);
  return engine.url.replace('{text}', engine.double ? encodeURIComponent(once) : once);
}

/** XML 里要转义的那五个。**percent 编码在 SSML 里是错的**，它会把 %E4%BD%A0 念出来 */
function xml转义(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 这一次请求发什么。**GET 和 POST 只在这儿分叉一次**，调用方不用管。
 *
 * POST 那条是给「阅读」里 `地址,{"method":"POST","body":"..."}` 那种引擎的
 * （百度就是），正文在 body 里而不是地址里。
 *
 * **headers 从配置里读**——Azure 那类要订阅密钥和 `application/ssml+xml`，
 * 少一个是 401、少另一个是 400。`Content-Type` 只在配置没给时兜底成 form。
 * （原来这儿写着「不从配置里读 header」，那条理由经不起推敲；
 * 为什么翻过来，去 docs/lessons.md 搜 Azure。）
 */
export function renderRequest(
  engine: TtsEngine,
  text: string,
): { url: string; init: RequestInit } {
  const once = encodeURIComponent(text);
  const uri = engine.double ? encodeURIComponent(once) : once;

  if (engine.method === 'POST') {
    const headers: Record<string, string> = { ...(engine.headers ?? {}) };
    /*
     * Content-Type 决定 body 怎么写，也决定**正文该怎么转义**：
     *   - form（默认）：percent 编码
     *   - SSML / XML（Azure）：XML 转义
     * 拿 percent 编码往 SSML 里塞，念出来是一串「百分之四十五」。
     */
    const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    if (!ct) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const 是xml = /xml/i.test(ct ?? '');
    return {
      url: engine.url,
      init: { method: 'POST', headers, body: (engine.body ?? '').replace('{text}', 是xml ? xml转义(text) : uri) },
    };
  }
  return { url: engine.url.replace('{text}', uri), init: engine.headers ? { headers: engine.headers } : {} };
}

/**
 * 模板合法吗。`{text}` **在地址和 body 里合起来出现且只出现一次**。
 *
 * ⚠️ 为什么要合起来数：POST 那种正文在 body 里，地址里一个 `{text}` 都没有；
 * 而 GET 那种反过来。分开数会把两种里的一种判成非法。
 */
export function validEngine(e: TtsEngine): boolean {
  if (!/^https?:\/\//.test(e.url)) return false;
  if (e.method !== undefined && e.method !== 'POST') return false;
  if (e.method === 'POST' && !e.body) return false;
  const 模板 = e.url + (e.body ?? '');
  if (模板.split('{text}').length !== 2) return false;
  // `{{...}}` 是原配置的 JS 模板。留下任何一个都说明转换没做干净
  return !/\{\{|\}\}/.test(模板);
}

/** 一段要念的文字 */
export interface TtsChunk {
  text: string;
  /** 在整章里的字符起点，用来做跟读高亮 */
  at: number;
}

const BREAK = /[。！？…；\n]/;

/**
 * 段里得有一个能念的字符才发出去。
 *
 * 抄的是 legado 的 `notReadAloudRegex`。真实书库里「整行只有符号」很常见——
 * 净化规则那轮抽 600 本，39.7% 的书有独立成行的 `……`，还有 `※※※`、`***` 这类分隔。
 * 把它们发给在线引擎是纯浪费：一次白跑的网络请求，而念一章本来就要发几十次，
 * 越接近限流阈值越容易听到「念着念着突然换成系统语音」
 */

/**
 * 把一章切成能念的小段。
 *
 * 为什么必须切：
 *   - 在线引擎是 GET，URL 长度有上限，整章几万字塞不进去；
 *   - `speechSynthesis` 喂超长文本会**静默截断**（原来的实现直接 `slice(0, 4000)`，
 *     所以一章只念开头就没声了，看起来像念完了）；
 *   - 切了才能做「念到哪高亮到哪」和「一段失败只重试这一段」。
 *
 * 在句末标点处断，断不开再退回硬切——宁可切在奇怪的地方，也不能因为
 * 一段没有标点就把整章卡住。
 */
export function splitForTts(text: string, max = 180): TtsChunk[] {
  const out: TtsChunk[] = [];
  let buf = '';
  let start = 0;

  const flush = () => {
    const t = buf.trim();
    // **at 要跟着 trim 一起挪**。不挪的话它指向被削掉的空白，
    // `text.slice(at, at + t.length)` 拿到的就不是这一段，跟读高亮整体偏移
    if (t && hasReadable(t)) out.push({ text: t, at: start + buf.indexOf(t[0]) });
    buf = '';
  };

  for (let i = 0; i < text.length; i++) {
    if (buf === '') start = i;
    buf += text[i];

    // **换行一律断。** 换行就是段落边界，念的时候本来就该停顿；
    // 不断的话空行会连同缩进被塞进同一段——发给在线引擎是白跑的字节
    if (text[i] === '\n') { flush(); continue; }

    if (buf.length >= max) {
      // 往回找最近的句末标点，找不到就硬切
      let cut = -1;
      for (let k = buf.length - 1; k > max * 0.4; k--) {
        if (BREAK.test(buf[k])) { cut = k; break; }
      }
      if (cut > 0) {
        const keep = buf.slice(0, cut + 1);
        const rest = buf.slice(cut + 1);
        const restStart = start + keep.length;
        buf = keep;
        flush();
        buf = rest;
        start = restStart;
      } else {
        flush();
      }
      continue;
    }

    if (BREAK.test(text[i]) && buf.length > max * 0.35) flush();
  }
  flush();
  return out;
}
