// 正文分段与划线套用（spec §5.1 的显示端）。
//
// 抽出来单独放的理由只有一个：**偏移量算错会把高亮画到别的句子上**，
// 而那种错在界面上看不出是 bug，只会让用户以为自己当初划错了。
// 纯函数才测得动。

export interface Paragraph {
  text: string;
  /** 这一段在章节正文里的字符偏移。划线位置换算全靠它 */
  offset: number;
}

/**
 * 按行切段，去掉空行。**关键是要记住每段在原文里的偏移**——
 * 渲染时把空行和首尾空白扔掉了，如果偏移跟着渲染结果算，
 * 划线位置就会比实际位置偏前，而且越往后偏得越多。
 */
export function splitParagraphs(body: string): Paragraph[] {
  const out: Paragraph[] = [];
  let cursor = 0;

  for (const raw of body.split('\n')) {
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text !== '') out.push({ text, offset: cursor + lead });
    cursor += raw.length + 1; // +1 是被 split 吃掉的那个 \n
  }
  return out;
}

export interface Mark {
  id: number;
  char_offset: number;
  length: number;
  color: string;
  note: string | null;
  intact: boolean;
}

export interface Piece {
  text: string;
  mark?: Mark;
}

/**
 * 把一段文字按落在它身上的划线切成若干片段。
 * 重叠的划线只认先开始的那条——真去做区间合并的话，一段文字会属于多条划线，
 * 点它该弹哪条笔记就没有答案了。
 */
export function sliceByMarks(para: Paragraph, marks: Mark[]): Piece[] {
  const start = para.offset;
  const end = start + para.text.length;

  const hits = marks
    .filter((m) => m.intact && m.char_offset < end && m.char_offset + m.length > start)
    .sort((a, b) => a.char_offset - b.char_offset);

  if (hits.length === 0) return [{ text: para.text }];

  const pieces: Piece[] = [];
  let at = start;

  for (const m of hits) {
    const from = Math.max(m.char_offset, at);
    const to = Math.min(m.char_offset + m.length, end);
    if (to <= at) continue; // 被前一条盖住了

    if (from > at) pieces.push({ text: para.text.slice(at - start, from - start) });
    pieces.push({ text: para.text.slice(from - start, to - start), mark: m });
    at = to;
  }

  if (at < end) pieces.push({ text: para.text.slice(at - start) });
  return pieces.filter((p) => p.text !== '');
}

/**
 * 朗读念到 `at` 这个位置时，高亮哪一段。返回段落的 `offset`，没有就 null。
 *
 * **两套坐标系必须换算**，这是这段逻辑存在的全部理由：
 * `tts.speak()` 喂的是**整章原文**（`chapter.text`，开头带标题，所以标题也会
 * 被念出来），而段落的 offset 是相对**去掉标题的正文**算的（阅读器把标题
 * 单独渲染成 `<h2>`，正文里不再重复）。不减掉这一截，高亮会整体偏后一段——
 * 而那种错很安静：看起来「一直在动」，只是永远比耳朵听到的慢一段。
 *
 * 念标题的那一下 `inBody` 是负的，返回 null——正文里没有对应的段落，
 * 这时候不该乱高亮一段。
 */
export function speakingParagraph(
  paras: Paragraph[],
  at: number,
  fullText: string,
  title: string,
): number | null {
  const inBody = at - (fullText.startsWith(title) ? title.length : 0);
  if (inBody < 0) return null;
  return paras.findLast((p) => p.offset <= inBody)?.offset ?? null;
}

/**
 * 把一段里的 `<img>` 摘出来。
 *
 * **起因**：从网站扒下来的 txt 里带插图（`<img src="https://…webp">`）。
 * 「HTML 残留」那条净化规则原来把标签删了了事——用户看到的是**图凭空消失**，
 * 而且他知道那儿本来有图。现在 `<img>` 从那条规则里排除掉，留到这里来渲染。
 *
 * **只认 http / https / data:image**。`javascript:` 这类一律当没有：
 * 这些 txt 是从别处拿来的，而渲染进程是 `file://` 加载的——同「绝不执行配置里的
 * JS」那条铁律，能从外部文件里进来的东西一律先问一句「它能让我干什么」。
 */
export function splitImages(text: string): { text: string; images: string[] } {
  const images: string[] = [];
  const rest = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const src = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
    if (/^(?:https?:\/\/|data:image\/)/i.test(src)) images.push(src);
    return '';
  });
  return { text: rest, images };
}
