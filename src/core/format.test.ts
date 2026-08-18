import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relTime, sqlTime, wan, activeFilterWords, whenAgo } from './format.ts';

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);
const ago = (ms: number) => relTime(NOW - ms, NOW);

test('相对时间按量级换单位', () => {
  assert.equal(ago(30 * 60_000), '30分钟前');
  assert.equal(ago(10 * 3600_000), '10小时前');
  assert.equal(ago(3 * 86400_000), '3天前');
  assert.equal(ago(150 * 86400_000), '5个月前'); // 「月」按 30 天算
  assert.equal(ago(3 * 365 * 86400_000), '3年前');
});

test('刚读完不说「0分钟前」', () => {
  // numeric:'auto' 会给「此刻」这种正常说法，自己拼数字永远差一口气
  assert.equal(ago(0), '此刻');
  assert.equal(ago(86400_000), '昨天');
});

test('时钟往回跳也不说未来', () => {
  // 系统时间被改过、或者库是从另一台机器拷来的，last_read_at 可能比现在大。
  // 「3天后读过」是纯粹的胡话，钳到 0
  assert.equal(relTime(NOW + 3 * 86400_000, NOW), '此刻');
});

test('库里的时间是 UTC，不能按本地时区解析', () => {
  // 这一条是整个文件里最要紧的：`datetime('now')` 存 UTC，而
  // `new Date('2026-08-16 13:21:38')` 在东八区会当成本地时间，差 8 小时——
  // 刚读完的书显示「8小时前」，看起来完全正常
  assert.equal(sqlTime('2026-08-16 13:21:38'), Date.UTC(2026, 7, 16, 13, 21, 38));
  assert.notEqual(sqlTime('2026-08-16 13:21:38'), new Date('2026-08-16 13:21:38').getTime());
  assert.equal(sqlTime('2020-01-01'), Date.UTC(2020, 0, 1));
  assert.equal(sqlTime(null), null);
  assert.equal(sqlTime('不是时间'), null);
});

test('字数：万以上进位，没有就是空串', () => {
  assert.equal(wan(0), '');
  assert.equal(wan(null), '');
  // **那个空格是 U+00A0，断言里写成转义**：源码里它和普通空格长得一模一样，
  // 哪天被编辑器换成普通空格，用真空格写的断言照样通过，而卡片会在
  // 「2」和「万字」之间断行——那正是它当初存在的理由
  assert.equal(wan(4317), '4317 字');
  assert.equal(wan(23_000), '2 万字');
});

/*
 * 「这一屏为什么空」不能把空结果归给某一个条件——除非确实只有那一个条件。
 * 实测过的反例：搜「连载」真有 1 本，再点一个那本书没有的标签，
 * 屏幕上说「没有带「连载」的书」，那是假话。
 */
test('条件不止一个时，一条都不许被单独归因', () => {
  const two = activeFilterWords({ keyword: '连载', tagNames: ['值得再看一遍的那种'] });
  assert.equal(two.length, 2, `两个条件就该列两条：${JSON.stringify(two)}`);
  assert.ok(two.some((x) => x.includes('连载')));
  assert.ok(two.some((x) => x.includes('值得再看一遍的那种')));

  // 只有一个条件时才轮得到那句具体的话，调用方按长度分支
  assert.equal(activeFilterWords({ keyword: '连载' }).length, 1);
  assert.equal(activeFilterWords({}).length, 0);
});

test('一个标签说「带 X 标签」，多个才说「同时带上」', () => {
  assert.match(activeFilterWords({ tagNames: ['玄幻'] })[0], /带「玄幻」标签/);
  const many = activeFilterWords({ tagNames: ['玄幻', '已完结'] })[0];
  assert.match(many, /同时/);
  assert.match(many, /玄幻/);
  assert.match(many, /已完结/);
});

test('「全部」那一档和没收起文件夹时，都不算条件', () => {
  assert.deepEqual(activeFilterWords({ shelfName: null }), []);
  assert.equal(activeFilterWords({ shelfName: '我的书评' }).length, 1);
  assert.equal(activeFilterWords({ categoryName: '四星以上' }).length, 1);
});

/*
 * 每加一个筛选条件，这里就得跟着加一条——否则「这一屏为什么空」会把
 * 空结果赖到别的条件头上。评分开关是第十八轮加的那个。
 */
test('「几星以上」也算一个条件', () => {
  assert.equal(activeFilterWords({ minRating: 4 }).length, 1);
  assert.match(activeFilterWords({ minRating: 4 })[0], /4 星以上/);
  assert.match(activeFilterWords({ minRating: 5 })[0], /5 星(?!以上)/, '5 星就是最高，不该说「以上」');
  assert.equal(activeFilterWords({ minRating: null }).length, 0);

  // 和别的条件叠加时，一条都不许被单独归因
  const two = activeFilterWords({ keyword: '重生', minRating: 4 });
  assert.equal(two.length, 2, JSON.stringify(two));
});

/*
 * **临时筛选那几样**（「就这么筛，不存」那条路）。
 *
 * 存成分类的规则只报名字（那是有意的，见函数上那段注释）；而临时筛选没有名字，
 * 不摊开来说，空结果那一屏就只剩「没有书」三个字，用户看不出是自己刚设的
 * 哪一条把结果筛空了。所以这几样各自要有一句话——同上面那条评分的规矩。
 */
test('临时筛选的每个条件都要有一句人话', () => {
  assert.match(activeFilterWords({ finishedYear: 2025 })[0], /2025 年读完/);
  assert.match(activeFilterWords({ statusNames: ['已读完'] })[0], /已读完/);
  assert.match(activeFilterWords({ serialNames: ['连载中'] })[0], /连载中/);
  assert.match(activeFilterWords({ formatNames: ['PDF'] })[0], /PDF/);

  // 多选是「任意一个」，别写成顿号——那会读成「同时」
  assert.match(activeFilterWords({ formatNames: ['PDF', 'TXT'] })[0], /或/);

  // 空数组和 null 都不算条件，否则空结果会归因到一个用户没设的条件上
  assert.deepEqual(activeFilterWords({ formatNames: [], serialNames: [], statusNames: [] }), []);
  assert.deepEqual(activeFilterWords({ finishedYear: null }), []);
});

/*
 * ⚠️ **目录的空串是「根目录直属的文件」，不是「没选目录」。**
 * 拿 `if (f.dir)` 判的话，站在根目录那一档时这个条件会**静默消失**——
 * 而它正在生效。同 `CategoryDialog` 里那个 `不限目录` 哨兵值存在的理由。
 */
test('目录：空串是根目录，不是「没筛」', () => {
  assert.equal(activeFilterWords({ dir: '' }).length, 1, '根目录也是一个条件');
  assert.match(activeFilterWords({ dir: '' })[0], /根目录/);
  assert.match(activeFilterWords({ dir: '仙侠' })[0], /仙侠/);
  assert.deepEqual(activeFilterWords({ dir: null }), []);
});


/*
 * 库里的时间文本是 **sqlite 的 UTC**（`2026-08-23 13:12:38`），
 * 而 JS 的 `new Date('2026-08-23 13:12:38')` 按**本地时区**解析——东八区差 8 小时。
 * 原样印出去不报错、不留痕，只是一条刚加的书签写着八小时前的时刻，
 * 看起来像时钟坏了。
 */
test('whenAgo 把库里那串当 UTC 读，不是当本地时间', () => {
  const 库里 = '2026-08-23 13:12:38';
  const 一小时后 = Date.parse('2026-08-23T14:12:38Z');
  const r = whenAgo(库里, 一小时后)!;
  assert.ok(r, '没算出来');
  // 当成本地时间读的话，东八区算出来是 -7 小时 → 被 max(0) 兜成「0 分钟前」，
  // 所以「1 小时」这三个字就是判据本身
  assert.match(r.text, /1\s*小时/, `当成本地时间读了：${r.text}`);
  assert.ok(r.title.includes('2026'), `title 里该是准确的本地时间，实际 ${r.title}`);
});

test('whenAgo 收到 null 就返回 null，不编一个「现在」', () => {
  assert.equal(whenAgo(null), null);
  assert.equal(whenAgo(undefined), null);
  assert.equal(whenAgo(''), null);
});

test('按时间排笔记：库里两种时间写法混着，只能按 sqlTime 排', () => {
  /*
   * 「我的笔记」的「最近」那一档要按 `created_at` 倒排。
   * 最省事的写法是拿字符串比——**而那个前提不成立**：
   * `asWhen`（`status.ts`）只要求「`sqlTime` 解析得出来」就原样留着，
   * 于是库里可以同时有 `2026-08-27 06:00:00` 和 `2026-08-27T05:00:00Z`
   * （老备份、外部工具经 §13 写进来的）。
   *
   * 这条测试**同时钉住错的那种写法会错**——只断言「新写法对」的话，
   * 下一个人把它改回 localeCompare 照样全绿。
   */
  const 早 = '2026-08-27T05:00:00Z';   // 带 T，实际更早
  const 晚 = '2026-08-27 06:00:00';    // 空格分隔，实际更晚

  assert.ok(sqlTime(早)! < sqlTime(晚)!, '解析出来的先后关系该是「早 < 晚」');

  // 按 sqlTime 倒排：晚的在前
  const 按解析 = [早, 晚].sort((a, b) => sqlTime(b)! - sqlTime(a)!);
  assert.deepEqual(按解析, [晚, 早]);

  // 而按字符串倒排：'T'(0x54) > ' '(0x20)，带 T 的那条被顶到最前，**是错的**
  const 按字符串 = [早, 晚].sort((a, b) => b.localeCompare(a));
  assert.deepEqual(按字符串, [早, 晚], '这一行钉的是「字符串比会排反」——它要是哪天成立了，说明格式变了');
  assert.notDeepEqual(按字符串, 按解析, '两种排法结果一样的话，这条测试什么都没验');
});
