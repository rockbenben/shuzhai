// 编码探测与解码（spec §2.1）。
//
// 两条跟 spec §12 建议不同的选择，都是实测出来的：
//
// 1. **不用 iconv-lite**。Node 自带 ICU 的 TextDecoder 已经能解 gbk / gb18030 /
//    big5 / utf-16，实测四种都正常。少一个依赖，打包也少一份事。
// 2. **不分 gbk 和 gb18030**，只留 gb18030。它是 gbk 的超集（gbk 又是 gb2312 的
//    超集），用 gb18030 解 gbk 内容结果完全一致，分两档只是多一个永远选不中的分支。
//
// UTF-8 校验能拦住什么，也是实测过的：`fatal: true` 对 0xFF、孤立续字节都正确抛错，
// 但**一段短 GBK 中文可能整段都是合法的 UTF-8 字节**（「小说」= D0 A1 CB B5，四个
// 字节全是合法的双字节序列）。所以校验通过不等于就是 UTF-8，必须再叠一层打分。

/**
 * 这个应用认得的编码，**全应用唯一的一份**。
 *
 * 原来这张表在渲染进程里私有一份（`BookEditor.tsx` 的下拉），core 只有类型——
 * 两边分家的话，界面上摆着一个 rpc 认不出来的值，而那个值会被原样存进
 * `book_file.encoding`、此后当成「用户指定的」用。类型直接从它推出来，想分家都难。
 */
export const ENCODINGS = ['utf-8', 'gb18030', 'big5', 'utf-16le', 'utf-16be'] as const;

export type Encoding = typeof ENCODINGS[number];

export interface Detection {
  encoding: Encoding;
  /** 0–1，用于在界面上标「疑似乱码」 */
  confidence: number;
  /** 中文短句，直接显示给用户看 */
  reason: string;
}

/** 探测只看开头这么多字节，几十 MB 的书不必整本读 */
const SAMPLE_BYTES = 64 * 1024;

const BOMS: Array<{ bytes: number[]; encoding: Encoding }> = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];

export function bomOf(buf: Uint8Array): Encoding | null {
  for (const { bytes, encoding } of BOMS) {
    if (buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b)) return encoding;
  }
  return null;
}

export function bomLength(encoding: Encoding, buf: Uint8Array): number {
  const hit = BOMS.find((b) => b.encoding === encoding && b.bytes.every((x, i) => buf[i] === x));
  return hit ? hit.bytes.length : 0;
}

/**
 * 一段文本「像不像正常中文」，0–1。
 * 判据是常用字占比：中日韩统一表意文字、中文标点、ASCII 可见字符都算好字符；
 * 替换符（解码失败留下的 U+FFFD）和控制字符算坏字符。
 * 用错编码解出来的结果会大量落进生僻字区和替换符，分数掉得很明显。
 */
export function textScore(s: string): number {
  if (s.length === 0) return 0;
  let good = 0;
  let bad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd) {
      bad += 4; // 替换符是硬证据，加重
    } else if (c === 0x09 || c === 0x0a || c === 0x0d) {
      good++;
    } else if (c < 0x20) {
      bad += 2; // 正文里不该有控制字符
    } else if (c < 0x7f) {
      good++;
    } else if (c >= 0x4e00 && c <= 0x9fff) {
      good++; // 中日韩统一表意文字
    } else if (c >= 0x3000 && c <= 0x303f) {
      good++; // 中文标点
    } else if (c >= 0xff00 && c <= 0xffef) {
      good++; // 全角字符
    } else if (c >= 0xe000 && c <= 0xf8ff) {
      bad += 2; // 私用区，正常小说不会有
    } else {
      bad++;
    }
  }
  return good / (good + bad);
}

function decode(buf: Uint8Array, encoding: Encoding): string {
  return new TextDecoder(encoding).decode(buf);
}

/** UTF-8 合法性校验。用 stream 模式，末尾被采样切断的半个字符不算错。 */
function isValidUtf8(buf: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 按 spec §2.1 的顺序探测：BOM → UTF-8 校验 → GB18030 → Big5 → UTF-16。
 *
 * 除 BOM 外全部走同一场打分竞赛，**没有为 UTF-16 单开启发式**。
 * 一度写过「数 0x00 字节」那种判据，它只对 ASCII 为主的 UTF-16 成立：
 * 中文 UTF-16 里汉字两个字节都非零（第 = U+7B2C → 2C 7B），一个 0x00 都数不到，
 * 而中文小说正是这个工具的主要场景。用错编码解出来的一律是乱码，
 * 打分本来就分得开，不需要第二套判据。
 *
 * UTF-8 即使校验通过也照样参赛：短 GBK 文本可能整段都是合法的 UTF-8 字节。
 */
export function detectEncoding(buf: Uint8Array): Detection {
  const sample = buf.subarray(0, SAMPLE_BYTES);

  const bom = bomOf(sample);
  if (bom) return { encoding: bom, confidence: 1, reason: `文件头有 ${bom} 的 BOM` };

  const candidates: Array<{ encoding: Encoding; score: number }> = [];

  if (isValidUtf8(sample)) {
    candidates.push({ encoding: 'utf-8', score: textScore(decode(sample, 'utf-8')) });
  }
  for (const enc of ['gb18030', 'big5', 'utf-16le', 'utf-16be'] as const) {
    candidates.push({ encoding: enc, score: textScore(decode(sample, enc)) });
  }

  candidates.sort((a, b) => b.score - a.score);
  const win = candidates[0];
  const runnerUp = candidates[1];

  // 同分优先 UTF-8：纯 ASCII 文本在所有候选下都是满分，不该被判成 GB18030
  const best =
    runnerUp && runnerUp.encoding === 'utf-8' && runnerUp.score >= win.score ? runnerUp : win;

  return {
    encoding: best.encoding,
    confidence: best.score,
    reason: `常用字占比 ${(best.score * 100).toFixed(1)}%，在候选编码里最高`,
  };
}

/** 按指定编码解码整个 buffer，自动跳过 BOM */
export function decodeText(buf: Uint8Array, encoding: Encoding): string {
  return decode(buf.subarray(bomLength(encoding, buf)), encoding);
}

/** 探测 + 解码，给「导入时预览前 500 字」用 */
export function decodeAuto(buf: Uint8Array): { text: string; detection: Detection } {
  const detection = detectEncoding(buf);
  return { text: decodeText(buf, detection.encoding), detection };
}
