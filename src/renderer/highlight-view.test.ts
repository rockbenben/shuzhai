/**
 * **带笔记的划线，不能把颜色弄丢。**
 *
 * 这条是补一个真的 bug：EPUB / PDF 那份画法原来写的是
 * `h.note ? 'note' : h.color`，而 `note` 那条规则的底色写死是黄的——
 * 于是**只要在一条划线上写了笔记，它就变成黄的**，用户挑的颜色当场没了。
 * txt 那边从来不是这样（底色照留，另加一条 `borderBottom`），是这一份抄歪了。
 *
 * 「颜色代表什么」做完之后它更贵：用户把蓝定成「待查」、在上面写了笔记，
 * 结果显示成黄的——**恰恰是最要紧的那几条丢了分类**，而且不报错。
 *
 * 为什么值得单独钉：这层东西画在 iframe 里、用的是原生 `::highlight()`，
 * **不产生任何元素**，走查脚本量不到，肉眼也分不出「黄色的待查」和「黄色的好句」。
 * 只有把那段 CSS 抽出来直接读，判据才守得住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLORS } from '../core/highlight.ts';
import { HL_COLORS, 划线样式 } from './highlight-view.ts';

/** 从那段 CSS 里挑出某个键的一条规则 */
const 规则 = (css: string, key: string): string | null => {
  const m = new RegExp('::highlight\\(shuzhai-' + key.replace(/[-]/g, '\\-') + '\\)\\{([^}]*)\\}').exec(css);
  return m ? m[1] : null;
};

test('划线样式：自检——四种颜色都在，而且真的读到了内容', () => {
  const css = 划线样式();
  // 一个什么都没找到的断言和没有断言是一回事，先证明这段 CSS 真有东西
  assert.ok(css.length > 100, '样式表太短，八成是没生成：' + css);
  assert.equal(COLORS.length, Object.keys(HL_COLORS).length, 'core 的 COLORS 和这里的 HL_COLORS 对不上');
  for (const c of COLORS) assert.ok(规则(css, c), c + ' 这一档没有规则');
});

test('划线样式：带笔记的底色**和不带笔记的一模一样**，只多一条下划线', () => {
  const css = 划线样式();
  for (const c of COLORS) {
    const 素 = 规则(css, c);
    const 有笔记 = 规则(css, c + '-note');
    assert.ok(有笔记, c + ' 没有「带笔记」那一条规则');

    const 底 = /background:([^;]*)/.exec(素!)?.[1];
    const 底2 = /background:([^;]*)/.exec(有笔记!)?.[1];
    assert.equal(底2, 底, c + ' 写了笔记之后底色变了——那正是这条测试要拦的 bug');
    assert.equal(底2, HL_COLORS[c], c + ' 的底色不是 HL_COLORS 里那个');

    // 下划线是「这条有笔记」唯一的记号，没有它就和普通划线分不开了
    assert.match(有笔记!, /text-decoration:\s*underline/, c + ' 带笔记的少了下划线');
    assert.doesNotMatch(素!, /text-decoration:\s*underline/, c + ' 不带笔记的不该有下划线');
  }
});

test('划线样式：不许再有一个不带颜色的 note 键', () => {
  /*
   * 原来那条 `::highlight(shuzhai-note)` 就是 bug 本体。
   * 它要是哪天被谁「顺手加回来」，`画划线` 那边分组的键一改就又全画成黄的了。
   */
  const css = 划线样式();
  assert.equal(规则(css, 'note'), null, '又出现了一个不带颜色的 note 键');
});
