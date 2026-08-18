// 目录屏蔽规则（spec §1.1 的「全局忽略规则」）。
//
// 原来 `DEFAULT_IGNORE` 是写死在 scan.ts 里的常量，用户改不了——
// 而「这个目录别扫」是个再正常不过的需求（备份盘、临时下载、别人的书）。
//
// 两条设计上的选择：
//
// 1. **屏蔽只影响扫描，不删已入库的书。** spec §1.1 说停用目录后
//    「其下书籍在列表中标记为已停用而非删除」——阅读进度、书签、评分
//    都是重扫恢复不了的东西，因为改了个扫描规则就抹掉它们，是不可接受的。
// 2. **生效前先给预览**：这条规则会屏蔽掉哪些已入库的书。glob 写错一个星号
//    就可能把整个书库排除掉，而扫描结果是「什么都没少」——因为屏蔽掉的书
//    只是不再被更新，看不出异常。

import { isAbsolute, matchesGlob, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, setSetting } from './db.ts';

/** 默认屏蔽。都是明显不该当书库的东西 */
export const DEFAULT_IGNORE = [
  '**/.*',
  '**/node_modules/**',
  '**/*备份*/**',
  '**/*副本*/**',
  '**/$RECYCLE.BIN/**',
  '**/System Volume Information/**',
];

const KEY = 'scan.ignore';

export function loadIgnore(db: DatabaseSync): string[] {
  const raw = getSetting(db, KEY);
  if (!raw) return [...DEFAULT_IGNORE];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.map(String).filter(Boolean) : [...DEFAULT_IGNORE];
  } catch {
    return [...DEFAULT_IGNORE]; // 存坏了就回默认，别让扫描起不来
  }
}

export function saveIgnore(db: DatabaseSync, patterns: string[]): void {
  setSetting(db, KEY, JSON.stringify([...new Set(patterns.map((p) => p.trim()).filter(Boolean))]));
}

/** glob 写错了要当场说，而不是等到扫描时静默失配 */
/**
 * 挡住写不出来的规则。
 *
 * ⚠️ **这个名字比它做的事大**：实际只挡得住**空串**。
 * 当场量的——`[`、`[a-`、`{a,`、单个反斜杠、300 个 a，`validateGlob` 全部收下，
 * 因为 `path.matchesGlob` 对这些**不抛错**，只是永远不匹配
 * （`isIgnored` 那头也照着这条兜底：坏规则当作不匹配，不要因为它把所有文件都挡了）。
 *
 * **没有把它写严，是有意的**：
 *   - Node 不提供「这个 glob 合法吗」的接口，自己判括号配平就是在重写一个
 *     半吊子的 glob 解析器，而写错的方向是**误拒用户写对的规则**；
 *   - 真正的兜底在界面上：加规则那一栏底下有预览，
 *     写了个挡不住任何东西的规则会当场显示「当前规则不影响任何已入库的书」，
 *     旁边那句提示还专门点了最常犯的那个错（「只写 `临时` 一个都挡不住」）。
 *
 * 所以**别指望它挡下语法错误**。要加严的话先想清楚怎么不误伤
 * 「两个星号加斜杠、备份、再加斜杠两个星号」这类正常写法。
 *
 * ⚠️ 上面这句话本来是直接把那个 glob 写出来的，结果**它自己把这段注释截断了**：
 * 那个写法里带着 `*` 和 `/` 相邻的一段，正好是块注释的结束符，
 * 于是后面几行变成了代码，`tsc` 报「Cannot find name '备份'」。
 * 要在注释里提 glob，就用文字描述，别把那两个符号并排写出来。
 */
export function validateGlob(pattern: string): void {
  if (!pattern.trim()) throw new Error('规则不能为空');
  try {
    matchesGlob('a/b/c.txt', pattern);
  } catch (e) {
    throw new Error(`这条规则无效：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 把一个绝对路径变成相对某个书库根的 glob。
 * 用户在界面上选一个子目录说「屏蔽它」，得到的就是这个。
 */
/**
 * 「这个文件夹不在这个书库目录下面」。
 *
 * **单独一个类型是必要的**：`ignore.globForDir` 那条 rpc 会拿每个根目录轮着试，
 * 试不中就换下一个——它必须只吞掉这一种。改之前它 `catch {}` 吞掉一切，
 * 于是「文件夹名里的 `{…,…}` 表达不了」那句话**永远到不了用户面前**，
 * 用户看到的是一句说的不是真正那一样的「不在任何书库文件夹下面」。
 * 同本文件那条「拦下来的理由要说的是真正那一样」。
 */
export class NotUnderRoot extends Error {}

export function globForDir(rootPath: string, dirPath: string): string {
  const raw = relative(rootPath, dirPath);
  // ⚠️ 跨盘符时 `relative` 返回的是**绝对路径**（D:\books → E:\别处 得到 `E:\别处`），
  // 它不以 `..` 开头，只判 `..` 会漏掉这种情况
  if (!raw || raw.startsWith('..') || isAbsolute(raw)) {
    throw new NotUnderRoot('这个文件夹不在任何书库文件夹下面');
  }
  return `${raw.split(sep).join('/').split('/').map(escapeGlobPart).join('/')}/**`;
}

/**
 * 把文件夹名里的 glob 元字符转义掉。
 *
 * **这不是洁癖：中文书库的目录名常常带方括号**（`[完结]`、`[精校]`、`[TXT]`）。
 * 改之前点「屏蔽这个文件夹」，生成的规则是 `[完结]/**`——**一本都挡不住**，
 * 因为方括号是 glob 的字符类。而且不报错：用户加了一条规则，什么都没发生。
 *
 * `*` 和 `?` 是反过来的毛病：目录真叫 `第*卷` 时，`第*卷/**` 会把
 * **`第一卷`、`第二卷` 全挡掉**——挡的是用户没点的那些。
 *
 * 转义写法是量出来的（`path.matchesGlob`）：
 *
 * | 写法 | 结果 |
 * |---|---|
 * | `[完结]/**` 原样 | 挡不住自己 |
 * | 反斜杠转义 | **也挡不住**（这个匹配器不认反斜杠转义） |
 * | `[[]完结[]]/**` 字符类 | ✔ 挡得住，而且不误伤 |
 *
 * ⚠️ **`{…,…}` 没救**：花括号展开发生在前面，`[{]`、反斜杠都试过，一律匹配不上；
 * 而原样写会挡住展开出来的那些名字（`{完结,精校}/**` 挡的是 `完结/`）。
 * 那种名字就明说表达不了，让用户手写一条——**生成一条会挡错东西的规则比不生成更糟**。
 */
export function escapeGlobPart(seg: string): string {
  if (/\{[^}]*,/.test(seg)) {
    throw new Error(
      `文件夹名里的「{…,…}」在屏蔽规则里表达不了：${seg}`
      + '　这种名字请在下面手写一条规则（比如用 * 代替那一段），先看预览挡住了几本再保存',
    );
  }
  return seg.replace(/[[*?]/g, (c) => `[${c}]`);
}

/** 一个相对路径会不会被这批规则挡掉。判据和 scan.ts 的 walk 里一模一样 */
export function isIgnored(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.split(sep).join('/');
  return patterns.some((p) => {
    try {
      return matchesGlob(normalized, p);
    } catch {
      return false; // 坏规则当作不匹配，不要因为它把所有文件都挡了
    }
  });
}

/**
 * 「这个文件在这个书库文件夹下，而且被这批规则挡住了吗」。
 *
 * **预览和生效必须问同一个函数。** 这两处原来各写了一遍，而且**已经分叉了一条**：
 * 生效那头有 `!isAbsolute(rel)`（`relative()` 在跨盘时返回的是绝对路径，
 * 那种情况下这个文件根本不在这个目录下），预览那头没有——
 * 于是那种文件会被算进「会挡掉 N 本」，实际却不会被挡。
 *
 * 分叉本身比它今天的后果重要：本仓库那条「同一份约定抄成几份必然分叉」
 * 已经被咬过好几次，而这里是**抄的那份先掉队**的又一例。
 *
 * ⚠️ 不含「整个文件夹被停用」那一支——那是另一件事，
 * 而预览回答的是**「这条规则挡掉谁」**，不是「保存之后一共剩几本」。
 */
export function hiddenByPatterns(rootPath: string, filePath: string, patterns: string[]): boolean {
  const rel = relative(rootPath, filePath);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && isIgnored(rel, patterns);
}

export interface IgnorePreview {
  /** 会被挡掉的已入库文件数 */
  affected: number;
  /** 举几个例子给用户看 */
  samples: string[];
  /** 其中有阅读进度的有几本——这些只是不再更新，记录和进度都留着 */
  withProgress: number;
}

/**
 * 试算：这批规则会挡掉哪些**已经在库里**的书。
 *
 * 这一步不能省。glob 少写一个星号（`备份/**` vs `**\/备份/**`）就可能
 * 从「挡掉一个子目录」变成「什么都没挡」或者「挡掉全部」，
 * 而扫描报告里看不出区别——被挡掉的书只是不再被更新，不会报错。
 */
export function previewIgnore(db: DatabaseSync, patterns: string[]): IgnorePreview {
  const roots = db.prepare('select id, path from library_root').all() as unknown as Array<{
    id: number;
    path: string;
  }>;
  const files = db
    .prepare('select f.path, f.root_id, r.percent from book_file f left join reading_state r on r.book_id = f.book_id')
    .all() as unknown as Array<{ path: string; root_id: number | null; percent: number | null }>;

  const rootPath = new Map(roots.map((r) => [r.id, r.path]));
  const preview: IgnorePreview = { affected: 0, samples: [], withProgress: 0 };

  for (const f of files) {
    const base = f.root_id === null ? null : rootPath.get(f.root_id);
    if (!base) continue;
    if (!hiddenByPatterns(base, f.path, patterns)) continue;

    preview.affected++;
    if (f.percent && f.percent > 0) preview.withProgress++;
    if (preview.samples.length < 8) preview.samples.push(f.path);
  }

  return preview;
}


export interface ApplyReport {
  excluded: number;
  restored: number;
}

/**
 * 把当前的屏蔽规则和目录启停**落到每个文件的 `excluded` 位上**，
 * 书架据此过滤。
 *
 * 为什么要落成一个位、而不是查询时现算：屏蔽规则是 glob，SQL 里表达不了；
 * 而这个库有 8000+ 本书，每次打开书架都把全部路径拉回来逐条 match 一遍太浪费。
 * 规则变了才重算一次。
 *
 * **这个函数一本书都不删。** 它只改 `excluded` 这一位，规则去掉之后
 * `restored` 那部分会原样回来，阅读进度、书签、评分全程没被碰过。
 */
export function applyIgnoreToLibrary(db: DatabaseSync): ApplyReport {
  const patterns = loadIgnore(db);
  const roots = db.prepare('select id, path, enabled from library_root').all() as unknown as Array<{
    id: number;
    path: string;
    enabled: number;
  }>;
  const byId = new Map(roots.map((r) => [r.id, r]));

  const files = db
    .prepare('select id, root_id, path, excluded from book_file')
    .all() as unknown as Array<{ id: number; root_id: number | null; path: string; excluded: number }>;

  const report: ApplyReport = { excluded: 0, restored: 0 };
  const setFlag = db.prepare('update book_file set excluded = ? where id = ?');

  db.exec('begin');
  try {
    for (const f of files) {
      const root = f.root_id === null ? undefined : byId.get(f.root_id);
      let hide = false;

      if (!root) {
        // 目录登记被移除了：不算屏蔽，否则用户换个目录管理就会「书全没了」
        hide = false;
      } else if (root.enabled === 0) {
        hide = true; // 整个目录被停用
      } else {
        hide = hiddenByPatterns(root.path, f.path, patterns);
      }

      const next = hide ? 1 : 0;
      if (next === f.excluded) continue;
      setFlag.run(next, f.id);
      if (next === 1) report.excluded++;
      else report.restored++;
    }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }

  return report;
}
