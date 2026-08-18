// 繁简转换（spec §2.5，M4）。
//
// **运行时转换，不改原文件**——和正文清洗是同一条规矩。
// 用 opencc-js：它是词组级的（「头发」→「頭髮」而不是「頭發」），
// 单字映射表做不到这一点，而网文里这类词很常见。

import * as OpenCC from 'opencc-js';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, setSetting } from './db.ts';

export type ConvertMode = 'off' | 'to-simplified' | 'to-traditional';

/** 真会动字形的那两种。`off` 不在里面，它什么都不做 */
type ActiveMode = 'to-simplified' | 'to-traditional';

const isActive = (m: unknown): m is ActiveMode =>
  m === 'to-simplified' || m === 'to-traditional';

/** 转换器构造有开销，按模式缓存 */
const cache = new Map<ActiveMode, (s: string) => string>();

/**
 * **参数类型故意窄成 `ActiveMode`**，不是 `ConvertMode`。
 * 原来它收整个联合、用「不是简体就按繁体」的三目兜底，于是一个未知模式
 * 会静默走进繁体分支；靠一句「别处别直接调它」的注释拦，是拿注释当类型用。
 * 窄掉之后编译器替你拦，注释也就不用写了。
 */
function converter(mode: ActiveMode): (s: string) => string {
  const hit = cache.get(mode);
  if (hit) return hit;

  const fn =
    mode === 'to-simplified'
      ? OpenCC.Converter({ from: 'tw', to: 'cn' })
      : OpenCC.Converter({ from: 'cn', to: 'tw' });
  cache.set(mode, fn);
  return fn;
}

/**
 * 套用繁简转换。**认不出来的模式一律当「原文」，绝不猜。**
 *
 * 类型上 `ConvertMode` 是个联合，但这个函数有一个 TS 管不到的入口：
 * rpc `convert.preview` 的参数从 HTTP 来，靠 `String(mode) as ConvertMode`
 * 硬转进来。原来 `converter()` 用的是「不是简体就按繁体」的三目，于是一个
 * 拼错的模式名（甚至漏传参数变成 `"undefined"`）会**静默返回整篇繁体**——
 * 调用方以为转换成功了，拿到的是错的。
 *
 * 现在只认这两种，其余原样返回：**擅自改变用户看到的字形是越界**
 * （同 `bookConvertMode` 读那头的兜底，它早就是这么写的）。
 *
 * ⚠️ **写那头由 `setBookConvertMode` 自己把关**，不能只靠这里：
 * rpc `convert.set` 走的是那条路，读回来时再兜底只会把一个存坏了的设置
 * 悄悄显示成「原文」，而调用方收到的是 `{ ok: true }`。
 */
export function convertText(text: string, mode: ConvertMode): string {
  if (text === '' || !isActive(mode)) return text;
  return converter(mode)(text);
}

const KEY = (bookId: number) => `convert.book.${bookId}`;

/** 某本书的显示模式。默认「原文」——擅自改变用户看到的字形是越界 */
export function bookConvertMode(db: DatabaseSync, bookId: number): ConvertMode {
  const v = getSetting(db, KEY(bookId));
  return isActive(v) ? v : 'off';
}

/**
 * **从外面进来的模式，认不出来就当场报错。**
 *
 * 两个 rpc 入口共用这一份：`convert.set`（存进库之前）和 `convert.preview`
 * （转之前）。两处原来都拿 `String(mode) as ConvertMode` 把 HTTP 参数硬转进来
 * ——TS 在这儿一点忙都帮不上，而**它们静默失败的样子还不一样**：
 * `set` 会把 `{"mode":"to-tradiitonal"}` 存成一个谁也不会再显示的值并回
 * `{ ok: true }`（看起来成功了，其实设置没生效）；`preview` 更隐蔽，
 * 它**原样退回你送进去的那段字**，调用方拿到的东西和「这段本来就不用转」
 * 长得一模一样（实测：照着 `s2t` / `t2s` 敲，两个方向都原样返回，
 * 看起来像 opencc 根本没打进安装包）。
 *
 * ⚠️ **和 `convertText` 的兜底不是一回事，别把这条搬进去。** 那个函数
 * 认不出来就当「原文」是**对的**——它在阅读界面的热路径上，宁可不转也不该
 * 让一段正文炸掉。差别在于**这里是信任边界**：参数刚从 HTTP 进来，
 * 拼错了就该让调用方知道。
 */
export function asMode(v: unknown): ConvertMode {
  if (v !== 'off' && !isActive(v)) {
    throw new Error(`认不出来的繁简模式：${String(v)}`);
  }
  return v;
}

/** **写那头唯一的入口**，自己把关，不指望调用方先验一遍 */
export function setBookConvertMode(db: DatabaseSync, bookId: number, mode: ConvertMode): void {
  setSetting(db, KEY(bookId), asMode(mode));
}
