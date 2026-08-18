import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFonts, addFont, removeFont } from './fonts.ts';

let dir: string;
let src: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shuzhai-font-'));
  src = join(dir, 'src');
  mkdirSync(src);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const make = (name: string, bytes = 'FONT') => {
  const p = join(src, name);
  writeFileSync(p, bytes);
  return p;
};

test('装字体：复制进 userData/fonts，文件名就是 family 名', () => {
  addFont(dir, make('LXGWWenKaiScreen.ttf'));
  const list = listFonts(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'LXGWWenKaiScreen');
  assert.ok(existsSync(list[0].file), '文件要真的复制过来——原路径多半是下载目录，说没就没');
});

test('装字体：只认 ttf/otf/woff/woff2，别的直接拒', () => {
  assert.throws(() => addFont(dir, make('说明.txt')), /不认识这种字体文件/);
  // .ttc 是多字体合集，CSS 里挑不出具体是哪一个，收进来只会得到一个不生效的选项
  assert.throws(() => addFont(dir, make('合集.ttc')), /不认识/);
  assert.deepEqual(listFonts(dir), []);
});

test('装字体：同名覆盖，不生成第二份', () => {
  addFont(dir, make('A.ttf', 'v1'));
  addFont(dir, make('A.ttf', 'v2-longer'));
  const list = listFonts(dir);
  assert.equal(list.length, 1, '重新装一遍是想换掉旧的，不该堆出两个看不出区别的名字');
  assert.equal(list[0].size, 'v2-longer'.length);
});

test('卸字体：只删 fonts 目录里的，name 里带 ../ 也伤不到外面', () => {
  addFont(dir, make('A.ttf'));
  const outside = join(dir, '别动我.txt');
  writeFileSync(outside, 'x');

  // name 来自渲染进程。不按列表查而是直接拼路径的话，这一下就删到外面去了
  assert.deepEqual(removeFont(dir, '../别动我'), { removed: false });
  assert.ok(existsSync(outside), '目录外的文件一个都不许碰');

  assert.deepEqual(removeFont(dir, 'A'), { removed: true });
  assert.deepEqual(listFonts(dir), []);
});

test('没有 fonts 目录时返回空数组，不抛', () => {
  assert.deepEqual(listFonts(join(dir, '不存在')), []);
});
