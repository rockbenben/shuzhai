/**
 * 当场数一遍那些「会过期的数」。
 *
 * **这不是守卫，是把尺子。** 永远退出 0，什么都不断言——
 * AGENTS.md 明确写着这些数**故意不钉**：多一条迁移、多一个朗读引擎都是正常演进，
 * 钉住只会让每次正常改动都红一次，而那种测试很快会被人删掉。
 * 真正被钉住的只有纸色那 10 个 id（`builtin-themes.test.ts`，改 id 会让所有用户的
 * 主题静默失效）。
 *
 * 存在的理由是**摩擦**：那份文件让你「去 `chapter.ts` 数 `BUILTIN_RULES`、
 * 走 `clean.ts` 的 `allBuiltins()`、rpc 数两张表」，而这些名字一个比一个难猜——
 * `allBuiltins` 根本没导出、纸色那个数组叫 `BUNDLED_THEMES`。
 * 写这个脚本之前，我为了数这几个数试错了四次 import。
 *
 *   node scripts/counts.mjs
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './repo-root.mjs';
import { openDb, SCHEMA_VERSION } from '../src/core/db.ts';
import { BUILTIN_RULES, VOLUME_RULES } from '../src/core/chapter.ts';
import { listCleanRules } from '../src/core/clean.ts';
import { BUILTIN_TTS } from '../src/core/builtin-tts.ts';
import { BUNDLED_THEMES } from '../src/renderer/builtin-themes.ts';

const dir = mkdtempSync(join(tmpdir(), 'counts-'));
const db = openDb(join(dir, 'library.db'));

const row = (what, n, where) => console.log(`  ${String(n).padStart(5)}  ${what.padEnd(22)} ${where}`);

console.log('当场数的（都会随正常演进变，别抄进文档）：\n');
row('迁移条数', SCHEMA_VERSION, 'db.ts 的 SCHEMA_VERSION，也是新库的 user_version');
row('表', db.prepare("select count(*) n from sqlite_master where type='table'").get().n, 'sqlite_master');
row('章节规则', BUILTIN_RULES.length, 'chapter.ts 的 BUILTIN_RULES');
row('卷规则', VOLUME_RULES.length, 'chapter.ts 的 VOLUME_RULES');
row('内置净化规则', listCleanRules(db).filter((r) => r.builtin).length,
  'clean.ts 的 allBuiltins()（没导出，所以这里走 listCleanRules 过滤 builtin）');
row('朗读引擎', BUILTIN_TTS.length, 'builtin-tts.ts');
row('内置纸色', BUNDLED_THEMES.length, 'builtin-themes.ts 的 BUNDLED_THEMES（10 个 id 有测试钉着）');

/*
 * rpc 方法：`rpc.ts` 和 `main.ts` 两张表里的方法名去重。
 * **判据是「单引号包起来的完整方法名」**——按子串数两头都会错
 * （`search.indexed` 会被 `search.indexedBooks` 冒领），AGENTS.md 那条记着。
 */
const names = new Set();
for (const f of ['src/main/rpc.ts', 'src/main/main.ts']) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/^\s{4}'([a-z][a-zA-Z]*\.[a-zA-Z]+)':/gm)) names.add(m[1]);
}
row('rpc 方法', names.size, 'rpc.ts + main.ts 两张表去重');

/*
 * **界面上叫不到的 rpc。** 这个清点做过好几轮，每轮都揪出真的死功能
 * （**别在这儿记轮数**：原来写「四轮」，而 `docs/lessons.md` 那节当时已经记到第五轮了）
 * （改名撤销、书签、导出、`LinksDialog` 那 170 行）——而每一轮都有人重写一遍扫描器，
 * 其中一次还把路径分隔符写反、三段全空，看起来像「一个问题都没有」。
 *
 * 判据是 AGENTS.md 定的那条：**单引号包起来的完整方法名**在 `src/renderer/` 里
 * 出现过就算在用。它有两个已知的偏差，别指望这个数直接等于「死功能个数」：
 *   - 注释里提到方法名也算「在用」（本文件那条记着）；
 *   - 模板字符串拼出来的调用（`rpc(\`export.${kind}\`)`）会被算成没人叫。
 * 所以这里只打印名单，**分类要人来做**，三档（误报 / 给外部工具的 / 量过决定不补的）
 * 和历轮结果都在 `docs/lessons.md`「定期清点：哪些 rpc 界面上根本调不到」那节。
 * ⚠️ **这里原来写「见 AGENTS.md 那三档」，而 AGENTS.md 里一个「误报」都没有**——
 * 指路指错了，正是那份文件自己记着的那类毛病。也别在这儿记「上一轮 N 个」：
 * 原来写 30，当场数是 26，而且名单一变「全部对得上」这句就不作数了。
 */
const ui = readdirSync(join(ROOT, 'src/renderer'))
  .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('.test.'))
  .map((f) => readFileSync(join(ROOT, 'src/renderer', f), 'utf8'))
  .join('');
const dead = [...names].filter((n) => !ui.includes(`'${n}'`)).sort();
row('其中界面叫不到的', dead.length, '要人分类，三档见 docs/lessons.md 那节');
console.log(`
    ${dead.join('  ')}`);

db.close();
rmSync(dir, { recursive: true, force: true });
