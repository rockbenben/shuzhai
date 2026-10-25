import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fallbackTitle, 是机械分段 } from './labels.ts';

test('机械分段的章名生成和识别共用一份', () => {
  assert.equal(fallbackTitle(3), '未识别章节 3');
  assert.equal(是机械分段([fallbackTitle(1), fallbackTitle(2)]), true);
  assert.equal(是机械分段([fallbackTitle(1)]), true, '一整本只有一段也要认');
  // `book.chapters` 会按书的繁简模式转换章名——繁体也要认
  assert.equal(是机械分段(['未識別章節 1', '未識別章節 2']), true);
  assert.equal(是机械分段(['第1章 开端', '第2章 继续']), false);
  assert.equal(是机械分段(['未识别章节 2', '未识别章节 3']), false, '序号必须从 1 连上来');
  assert.equal(是机械分段(['未识别章节 1', '第2章 真的']), false, '混进真章名就不是机械分段');
  assert.equal(是机械分段([]), false);
});
