import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keyLabel, DEFAULT_KEYS, hydrateUserThemes, loadImportedThemes, colorThemes, isNightTheme,
  loadView, saveView, loadSort, saveSort,
} from './settings.ts';

/** 这个模块读 localStorage，node 里没有——喂一个最小的 */
function stubStorage(raw: string | null): void {
  const 里面: Record<string, string> = raw === null ? {} : { 'novel.imported-themes': raw };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => 里面[k] ?? null,
    setItem: (k: string, v: string) => { 里面[k] = v; },
  };
}

/** 一个能读能写的假 localStorage（上面那个 `stubStorage` 是只给纸色用的只读桩） */
function 假存储(): void {
  const 里面: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => 里面[k] ?? null,
    setItem: (k: string, v: string) => { 里面[k] = v; },
  };
}

/*
 * **视图是每一档各记各的。**
 *
 * 第一版是一个全局键，症状两个方向都有：在「全部」里切成表格，「在读」「弃坑」
 * 全跟着变；反过来在「我的书评」里切一下封面墙，又会盖到别的档上。
 * 而这件事**类型检查兜不住、界面上也不报错**——只是视图静默变成了另一个。
 */
test('视图偏好按档位分开存，一档不影响另一档', () => {
  假存储();
  assert.equal(loadView('all'), null, '没存过就是 null，让调用方回落到这一档的默认');

  saveView('all', 'table');
  assert.equal(loadView('all'), 'table');
  assert.equal(loadView('rated'), null, '在「全部」里选的视图不许串到「我的书评」');

  saveView('rated', 'wall');
  assert.equal(loadView('rated'), 'wall');
  assert.equal(loadView('all'), 'table', '反过来也不许串——两档各记各的');
});

/*
 * **排序也是每一档各记各的**，判据和视图一模一样。
 *
 * 它原来是一个全局键，而能改排序的地方有两处：顶栏那个下拉，和**表格的表头**。
 * 于是「在『我的书评』的表格里点一下『评分』表头」＝「把『全部』的默认排序也改了」，
 * 症状是**刚点开读过的书在「全部」里不排第一了**（它没评分，沉到八千本后面），
 * 而用户完全不知道为什么——这是用户真的报上来的。
 */
test('排序偏好按档位分开存，一档不影响另一档', () => {
  假存储();
  assert.equal(loadSort('all'), null, '没存过就是 null，让调用方回落到这一档的默认');

  saveSort('rated', 'rating');
  assert.equal(loadSort('rated'), 'rating');
  assert.equal(loadSort('all'), null, '在「我的书评」里挑的排序不许串到「全部」');

  saveSort('all', 'title');
  assert.equal(loadSort('all'), 'title');
  assert.equal(loadSort('rated'), 'rating', '反过来也不许串');
});

test('认不出的排序键一律丢掉，不许让 orderBy 在开机时抛', () => {
  假存储();
  localStorage.setItem('shelf.sorts', JSON.stringify({ all: '瞎写的', rated: 'rating' }));
  assert.equal(loadSort('all'), null, '认不出的当没存过');
  assert.equal(loadSort('rated'), 'rating', '同一张表里好的那条要留着');

  localStorage.setItem('shelf.sorts', '{不是 json');
  assert.equal(loadSort('rated'), null);
});

test('排序和视图各存各的键，互不覆盖', () => {
  假存储();
  saveSort('all', 'title');
  saveView('all', 'table');
  assert.equal(loadSort('all'), 'title', '写视图不许把排序冲掉');
  assert.equal(loadView('all'), 'table');
});

test('认不出的视图名一律丢掉，不许渲染成空白书架', () => {
  假存储();
  // localStorage 是用户手改得了的；一个不认识的视图名会让书架什么都不画
  localStorage.setItem('shelf.views', JSON.stringify({ all: '瞎写的', rated: 'table' }));
  assert.equal(loadView('all'), null, '认不出的当没存过');
  assert.equal(loadView('rated'), 'table', '同一张表里好的那条要留着');

  // 整个值坏掉也不能抛——开机时抛一次，用户看到的是白屏
  localStorage.setItem('shelf.views', '{不是 json');
  assert.equal(loadView('rated'), null);
});

test('快捷键表上写的是键盘上印的字，不是 DOM 的键名', () => {
  // 这张表是**显示**用的，存进去的仍然是 KeyboardEvent.key 的原值
  assert.equal(keyLabel('ArrowLeft'), '←');
  assert.equal(keyLabel('PageDown'), 'Page Down');
  assert.equal(keyLabel('Escape'), 'Esc');
  assert.equal(keyLabel(' '), '空格');
  // 单个字母按键帽上的样子写
  assert.equal(keyLabel('t'), 'T');
  // 认不出来的原样摆出去——**编不出人话的时候，原文比瞎猜的翻译有用**
  assert.equal(keyLabel('F7'), 'F7');
  /*
   * **默认那几个键一个都不许漏成 DOM 名字**——这条才是判据，
   * 上面几条只是例子。漏一个，设置里就摆着一句用户看不懂的话。
   *
   * 判据是「**还是不是驼峰**」（小写紧跟大写），不是「以 Page 开头」——
   * 第一版写成后者，把正确的 `Page Up` 也报了。
   */
  for (const ks of Object.values(DEFAULT_KEYS)) {
    for (const k of ks) {
      assert.ok(!/[a-z][A-Z]/.test(keyLabel(k)), `${k} 没翻译：界面上会写「${keyLabel(k)}」`);
    }
  }
});

/**
 * 用户自己的纸色搬了地方：localStorage → 库里的 `app_setting`。
 * **搬的时候不能把他调过的颜色丢掉**——那是他来回试出来的，重装配不回来。
 */
test('纸色：库里没有、localStorage 有，就搬上去', async () => {
  const 调过的 = [{ id: 'day', name: '白天', night: false, bg: '#112233', fg: '#eee', accent: '#f00', panel: '#223344', line: '#334455', muted: '#99a' }];
  stubStorage(JSON.stringify(调过的));
  const 库: Record<string, string> = {};
  await hydrateUserThemes(async (k) => 库[k] ?? '', async (k, v) => { 库[k] = v; });

  assert.deepEqual(loadImportedThemes(), 调过的, '搬完之后读出来的就是那份');
  assert.ok(库['theme.imported'], '**要写进库里**，不然备份带不走它');
  assert.deepEqual(JSON.parse(库['theme.imported']), 调过的);
});

test('纸色：库里有就用库里的，localStorage 那份不许盖回来', async () => {
  // 换台机器恢复备份之后就是这个局面：库里是恢复回来的，localStorage 是本机的旧货
  stubStorage(JSON.stringify([{ id: 'day', name: '本机旧的', night: false, bg: '#000', fg: '#fff', accent: '#f00', panel: '#111', line: '#222', muted: '#333' }]));
  const 库 = { 'theme.imported': JSON.stringify([{ id: 'imported-恢复回来的', name: '恢复回来的', night: true, bg: '#17161A', fg: '#d8d5d0', accent: '#C2A06A', panel: '#201F24', line: '#2a2930', muted: '#8a8790' }]) };
  await hydrateUserThemes(async (k) => (库 as Record<string, string>)[k] ?? '', async () => {});

  assert.deepEqual(loadImportedThemes().map((t) => t.id), ['imported-恢复回来的']);
});

test('「现在是不是夜间」认主题自己的 night 字段，不认 id 的拼法', async () => {
  // 导进来的深色主题：`night` 是 true，而 id 是 `imported-…`，不以 `-night` 结尾
  stubStorage(null);
  const 库 = {
    'theme.imported': JSON.stringify([{
      id: 'imported-暗色', name: '暗色', night: true,
      bg: '#17161A', fg: '#d8d5d0', accent: '#C2A06A', panel: '#201F24', line: '#2a2930', muted: '#8a8790',
    }]),
  };
  await hydrateUserThemes(async (k) => (库 as Record<string, string>)[k] ?? '', async () => {});

  assert.equal(isNightTheme('imported-暗色'), true, '它自己声明了 night: true');

  /*
   * **这一行是故意留着的**（同 `api.test.ts` 那条「拼错选项名确实可写」）：
   * 两个阅读界面原来各手写一份下面这个判断，而它在导入主题上就是错的——
   * 应用外观已经是暗的，阅读器右轨那个键还写着「切到夜间」、图标还是月亮。
   * 删掉它，上面那条断言就会显得多余，下一个人很容易把 `isNightTheme` 换回字符串匹配。
   */
  const 旧写法 = (t: string) => t === 'night' || t.endsWith('-night');
  assert.equal(旧写法('imported-暗色'), false, '旧写法说它不是夜间——这就是那个 bug');

  // 内置的那几张两种写法都对，所以两边各自的测试当年全是绿的
  for (const id of ['night', 'shuzhai-night']) {
    assert.equal(isNightTheme(id), true, id);
    assert.equal(旧写法(id), true, id);
  }
  assert.equal(isNightTheme('shuzhai-day'), false, '白天那张不是夜间');
  assert.equal(isNightTheme('根本没有这张'), false, '认不出来的一律当白天，别把界面弄暗');
});

test('纸色：库里坏了不许把应用带崩——当作一张都没有', async () => {
  stubStorage(null);
  await hydrateUserThemes(async () => '{不是 json', async () => {});
  assert.deepEqual(loadImportedThemes(), []);
  // 内置那 10 张照样在，纸色下拉不会空
  assert.ok(colorThemes().length >= 10);
});
