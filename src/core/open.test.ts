/*
 * 「打开一本书」这条路。
 *
 * 这个模块拆出来之前，四条判断连同副作用写在 `App.tsx` 里，一条测试都没有——
 * 而**其中的顺序是判据的一部分**，当时只有一句注释守着。下面四条
 * 「顺序」测试各钉住相邻的一对：把任意两判换个位置，就有一条会红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planOpen, type OpenBook } from './open.ts';

const 书 = (over: Partial<OpenBook> = {}): OpenBook => ({
  title: '某本书',
  path: 'D:/书库/某本书.txt',
  file_status: 'ok',
  chapter_count: 12,
  chapter_idx: 3,
  char_offset: 800,
  ...over,
});

test('正常的 txt：接着上次读到的地方开', () => {
  assert.deepEqual(planOpen(书()), { kind: 'reader', at: 3, off: 800 });
});

test('从没读过的书从头开', () => {
  assert.deepEqual(
    planOpen(书({ chapter_idx: null, char_offset: null })),
    { kind: 'reader', at: 0, off: undefined },
  );
});

/*
 * **显式跳到第 N 章时不继承上次的章内偏移。**
 *
 * 继承的话会跳进新章节里一个毫不相干的字节——用户点的是「第 8 章」，
 * 落地却在半中间，而且看起来像进度坏了。
 */
test('指定了章号就从那一章开头看，不带上次的偏移', () => {
  assert.deepEqual(planOpen(书(), 8), { kind: 'reader', at: 8, off: undefined });
  // 章号和偏移都给了才两个都用（书签跳转走的就是这条）
  assert.deepEqual(planOpen(书(), 8, 120), { kind: 'reader', at: 8, off: 120 });
});

test('手工添的「只有记录」的书：点它是去写评价，不是开阅读器', () => {
  assert.deepEqual(planOpen(书({ path: null })), { kind: 'review' });
});

test('PDF / EPUB 走内置查看器', () => {
  assert.deepEqual(planOpen(书({ path: 'D:/书库/某本书.pdf', chapter_count: 0 })),
    { kind: 'view', viewer: 'pdf', path: 'D:/书库/某本书.pdf' });
  assert.deepEqual(planOpen(书({ path: 'D:/书库/某本书.epub', chapter_count: 0 })),
    { kind: 'view', viewer: 'epub', path: 'D:/书库/某本书.epub' });
});

/*
 * mobi / azw3 / djvu **没有能进渲染包的现成库**，照旧交给系统默认程序。
 * 这一条钉的是「别把『不是 txt』一律当成『能在应用里看』」。
 */
test('其余只编目的格式仍然交给系统程序', () => {
  for (const ext of ['mobi', 'azw3', 'djvu']) {
    const p = planOpen(书({ path: `D:/书库/某本书.${ext}`, chapter_count: 0 }));
    assert.equal(p.kind, 'external', ext);
  }
});

/*
 * 两句报错都要**说清下一步做什么**。
 * 本仓库那条「『说了怎么办』才是判据」——只把英文换成中文不算修。
 */
test('打不开的时候，那句话要说清下一步做什么', () => {
  const 没了 = planOpen(书({ file_status: 'missing' }));
  assert.equal(没了.kind, 'error');
  assert.match(没了.kind === 'error' ? 没了.message : '', /扫描/);
  assert.match(没了.kind === 'error' ? 没了.message : '', /整理数据库/);

  const 没章节 = planOpen(书({ chapter_count: 0 }));
  assert.equal(没章节.kind, 'error');
  assert.match(没章节.kind === 'error' ? 没章节.message : '', /章节/);
});

// ── 下面四条钉的是**顺序**，各管相邻的一对 ──────────────────

test('顺序：只编目的书要排在「还没解析出章节」前面', () => {
  // 它们的章节数天生是 0。落到那句会得到「点『章节』设切分规则」，
  // 对一个 PDF 是**无解**的提示——这正是当初写在注释里的那条
  const p = planOpen(书({ path: 'D:/书库/某本书.epub', chapter_count: 0 }));
  assert.equal(p.kind, 'view', '章节数是 0 的 EPUB 仍然该走查看器，不该掉进「没解析出章节」');
});

test('顺序：「文件不在原位置了」要排在「交给系统程序」前面', () => {
  // 文件都没了，就别再去 ui.openFile 它——那只会换来一句系统的英文报错
  const p = planOpen(书({ path: 'D:/书库/某本书.pdf', file_status: 'missing' }));
  assert.equal(p.kind, 'error', '文件没了的 PDF 该报错，不该去开查看器');
});

test('顺序：「文件不在原位置了」要排在「只有记录」前面', () => {
  const p = planOpen(书({ path: null, file_status: 'missing' }));
  assert.equal(p.kind, 'error', '标着 missing 就该报错，不该当成手工添的记录');
});

test('顺序：「只有记录」要排在「还没解析出章节」前面', () => {
  // 一条压根没有文件的记录，「去点『章节』设切分规则」是无解的
  const p = planOpen(书({ path: null, chapter_count: 0 }));
  assert.equal(p.kind, 'review', '没有文件的记录该去写评价，不该被叫去设切分规则');
});
