import { test } from 'node:test';
import assert from 'node:assert/strict';
import { 续读位置, 续读进度, 续读提示, 选续读, type ResumeRow } from './resume.ts';

const row = (patch: Partial<ResumeRow> = {}): ResumeRow => ({
  bookId: 1,
  title: '测试书',
  author: null,
  status: 'reading',
  percent: 42.4,
  chapterIdx: 5,
  lastReadAt: '2026-08-12 10:00:00',
  path: 'D:/books/测试.txt',
  ...patch,
});

test('位置：txt 报章号和百分比', () => {
  assert.equal(续读位置(row()), '第 6 章 · 42%');
  // 0% 和 100% 不报百分比（前者没读进去，后者该是「读完」而不是浮钮）
  assert.equal(续读位置(row({ percent: 0 })), '第 6 章');
  assert.equal(续读位置(row({ percent: 100 })), '第 6 章');
});

test('位置：PDF / EPUB 不报假章号', () => {
  // `reading_state.chapter_idx` 对只编目的格式永远是 0——照直渲染就是「第 1 章」
  assert.equal(续读位置(row({ path: 'D:/books/书.pdf', chapterIdx: 0 })), 'PDF · 上次读到的位置');
  assert.equal(续读位置(row({ path: 'D:/books/书.epub', chapterIdx: 0 })), 'EPUB · 上次读到的位置');
});

test('位置：没有文件的手工书不报章号', () => {
  assert.equal(续读位置(row({ path: null })), '上次打开的那本');
});

test('进度弧只认 txt 的真实百分比；其余一律不画', () => {
  assert.equal(续读进度(row()), 42.4);
  assert.equal(续读进度(row({ percent: null })), null);
  assert.equal(续读进度(row({ percent: 120 })), 100);
  assert.equal(续读进度(row({ percent: -5 })), 0);
  assert.equal(续读进度(row({ path: 'D:/books/书.pdf' })), null, 'PDF 没有总页数，不能造分母');
  assert.equal(续读进度(row({ path: null })), null);
});

test('提示带上「上次读多久前」', () => {
  const now = Date.parse('2026-08-12T11:00:00Z');
  assert.match(续读提示(row(), now), /^第 6 章 · 42% · 1\s*小时/);
});

test('选续读：读完/弃坑/手工书都跳过，挑第一本有文件的在读书', () => {
  const finished = row({ bookId: 2, status: 'finished', lastReadAt: '2026-08-12 12:00:00' });
  const manual = row({ bookId: 3, status: 'reading', path: null, lastReadAt: '2026-08-12 11:30:00' });
  const text = row({ bookId: 4, lastReadAt: '2026-08-12 11:00:00' });
  assert.equal(选续读([finished, manual, text])?.bookId, 4);
  assert.equal(选续读([manual]), null, '只有手工书时不摆「继续阅读」');
  assert.equal(选续读([row({ bookId: 5, path: 'D:/books/书.pdf' })])?.bookId, 5, 'PDF 有文件，可以继续读');
  assert.equal(选续读([row({ status: 'dropped' })]), null);
  assert.equal(选续读([]), null);
});
