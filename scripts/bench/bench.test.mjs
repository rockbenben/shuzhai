import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf, parseFingerprint } from './snapshot.mjs';
import { median, verdictOf, formatRow } from './report.mjs';

test('指纹认的是来源，不是目的地', () => {
  const 造 = (size, mtime) => ({ size, mtimeMs: mtime });
  const a = fingerprintOf(造(596905984, 1780000000000), 1780000100000);
  const b = fingerprintOf(造(596905984, 1780000000000), 1780000200000);
  assert.notEqual(a, b, '拷贝时刻不同就是两份快照');
  assert.equal(parseFingerprint(a).srcSize, 596905984);
  assert.equal(parseFingerprint('不是 json'), null, '读不懂的指纹要退回 null，别抛');
});

test('中位数取中间那个', () => {
  assert.equal(median([324, 332, 320]), 324);
  assert.equal(median([10]), 10);
  assert.equal(median([]), null, '空样本是「没测到」，不是 0');
});

test('判据线：300 进候选、1000 必修、没测到要看得见', () => {
  assert.equal(verdictOf(280), 'ok');
  assert.equal(verdictOf(301), 'candidate');
  assert.equal(verdictOf(1000), 'must-fix');
  assert.equal(verdictOf(null), '未测');
});

test('不可测的格子印「– 没查」，不印 0', () => {
  const 行 = formatRow({ name: '全文搜索 trigram', ms: null, old: '5–34 ms', why: '索引 0 行' });
  assert.match(行, /– 没查/);
  assert.doesNotMatch(行, /\b0 ms\b/, '空集合的 0 和「全都好好的」逐字相同');
});
