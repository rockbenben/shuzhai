import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilename } from './filename.ts';

test('「作者：」写明了，就不该输给破折号猜出来的切法', () => {
  // 全部取自真实书库的文件名。原来 `^(.+?)\s*[-_—]\s*(.+)$` 是非贪婪的，
  // 撞上第一个 - 或 _ 就切，而「作者：」那条判据排在它后面、永远轮不到。
  // 真实书库上量过：修好 24 本，控制组 8149 本一字未动。
  const cases: Array<[string, string, string]> = [
    ['红楼：琏玉凤钗 精校1_296章_作者：耶律承基.txt', '红楼：琏玉凤钗 精校1_296章', '耶律承基'],
    ['华娱之2000 ⊙1-849 作者：河狸的米饭.txt', '华娱之2000 ⊙1-849', '河狸的米饭'],
    ['我在大元当汉家天子 487 作者：我是海陵王.txt', '我在大元当汉家天子 487', '我是海陵王'],
    ['东京医途 (26.03.23)作者：睡醒了会饿.txt', '东京医途 (26.03.23)', '睡醒了会饿'],
  ];
  for (const [file, title, author] of cases) {
    const got = parseFilename(file);
    assert.equal(got.author, author, file);
    assert.equal(got.title, title, file);
    assert.ok(!(got.author ?? '').includes('作者'), '作者字段里不该再有「作者」二字');
  }
});

test('没有「作者：」时，破折号那条老规矩不变', () => {
  // **控制组**。上面那条改的是优先级，不能顺带改了这一支的行为
  assert.deepEqual(parseFilename('雪中悍刀行-烽火戏诸侯.txt'), { title: '雪中悍刀行', author: '烽火戏诸侯' });
  assert.deepEqual(parseFilename('斗破苍穹_天蚕土豆.txt'), { title: '斗破苍穹', author: '天蚕土豆' });
  assert.deepEqual(parseFilename('《庆余年》猫腻.txt'), { title: '庆余年', author: '猫腻' });
  assert.deepEqual(parseFilename('【猫腻】将夜.txt'), { title: '将夜', author: '猫腻' });
  assert.deepEqual(parseFilename('没有作者的书.txt'), { title: '没有作者的书' });
});
