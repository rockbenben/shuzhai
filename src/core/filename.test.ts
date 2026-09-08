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

test('「作者[日]某某」没冒号也认（括号就是切点），站点水印剥掉', () => {
  // 真实书库：「寄生前夜作者[日]濑名秀明(www.cecewx.com)」——作者顶着国籍括号，
  // 后面还拖一个下载站水印。作者字段原本是 null，整串堆在书名里印上了封面。
  const got = parseFilename('寄生前夜作者[日]濑名秀明(www.cecewx.com).txt');
  assert.equal(got.title, '寄生前夜');
  assert.equal(got.author, '[日]濑名秀明');

  // 国籍括号在前、作者在后也认（NOISE 先剥掉「（精校全本）」）
  const got2 = parseFilename('某书作者[中]张三（精校全本）.txt');
  assert.equal(got2.title, '某书');
  assert.equal(got2.author, '[中]张三');
});

test('裸「作者」后面不是冒号/括号绝不切——真有书叫《作者不详》', () => {
  // 这是安全边界：书名里可以正常出现「作者」两个字，只有「作者：」或「作者[」才切
  assert.deepEqual(parseFilename('作者不详.txt'), { title: '作者不详' });
  assert.deepEqual(parseFilename('一个作者的自述.txt'), { title: '一个作者的自述' });
});

test('没有「作者：」时，破折号那条老规矩不变', () => {
  // **控制组**。上面那条改的是优先级，不能顺带改了这一支的行为
  assert.deepEqual(parseFilename('雪中悍刀行-烽火戏诸侯.txt'), { title: '雪中悍刀行', author: '烽火戏诸侯' });
  assert.deepEqual(parseFilename('斗破苍穹_天蚕土豆.txt'), { title: '斗破苍穹', author: '天蚕土豆' });
  assert.deepEqual(parseFilename('《庆余年》猫腻.txt'), { title: '庆余年', author: '猫腻' });
  assert.deepEqual(parseFilename('【猫腻】将夜.txt'), { title: '将夜', author: '猫腻' });
  assert.deepEqual(parseFilename('没有作者的书.txt'), { title: '没有作者的书' });
});
