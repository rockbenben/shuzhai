import { useEffect, useState } from 'react';
import { rpc } from './rpc.ts';
import type { DirNode, Filter, SmartShelf, Tag } from '../core/library.ts';
import { READING_STATUS, SERIAL_STATUS } from '../core/labels.ts';
import { extOf } from '../core/book-format.ts';

/*
 * ⚠️ **预览用的行就是 `book.list` 那一份，不另抄一个窄类型。**
 * 抄一个「只要这四个字段」的接口看着更干净，而 `dup-decls.mjs` 会当场报
 * 「同一个 rpc 两种返回类型」——它盯的正是这个：加一个字段就会漏改一处，而且不报错。
 * 类型导入在打包时会被擦掉，不会因此把书架那一大坨牵进来。
 */
import type { Book } from './App.tsx';

/** 格式的中文说法。**扩展名本身就是名字**，只有「没有文件」那一档要翻译 */
const 格式名 = (f: string) => (f === 'manual' ? '只有记录' : f.toUpperCase());

/**
 * 这一台编辑器**当前摆得出来的条件**，按屏上从上到下的顺序。
 *
 * ⚠️ 顶上那句提示（`App.tsx` 的「筛选」和「＋ 新建分类」两颗键的 `title`）
 * **必须从这里来，不许手写**。原来两处各写了一份、还写得不一样
 * （一处列「状态、读完年份、格式」一处只列「阅读状态」），而刚加进来的
 * 字数区间两边都没提——**一句介绍功能的提示，手写就一定会飘**。
 * 有一条测试逐个对 `COND_GROUPS` 和这一屏真的摆出来的行，加一行不登记就红。
 */
export const COND_GROUPS = [
  '文件夹', '格式', '评分', '字数', '读完年份', '连载状态', '阅读状态', '标签',
] as const;

/** 两颗入口键的提示语。只此一份 */
export const 筛选提示 = `按${COND_GROUPS.join('、')}组合着筛一下；想留着就起个名字存成分类`;

/** 「不限」用的哨兵值：`dir` 的空串是**根目录直属**，不能拿来当「不限」 */
const 不限目录 = '\u0000';

/**
 * 「万字」那个输入框里的东西 → 规则里的一个字数条件；没填或填不出数就是空对象。
 *
 * ⚠️ 认的是**翻译出来的那个数**，不是原始字符串：把浏览器塞进来的怪串当成
 * 「用户填过了」，规则里就躺着一条 `NaN`，而 `JSON.stringify` 会把 NaN 写成
 * `null` —— 右边预览照常数「不限」，存下去的规则却带一条 null 的条件，
 * 两边筛的不是同一批书。判据要认翻译结果，不认形状（`library.ts` 的空规则那条同）。
 */
function 字数条件(key: 'minWords' | 'maxWords', 填的: string): Filter {
  const 文本 = 填的.trim();
  const 数 = Number(文本);
  if (!文本 || !Number.isFinite(数) || 数 < 0) return {};
  return { [key]: Math.round(数 * 10000) } as Filter;
}

/**
 * 建一个**分类**：一个名字 + 一条规则。
 *
 * 这个弹窗的存在本身就是那条判断的兑现——「按文件夹」「按评分」太粗，
 * 当不了分类，只能当规则。**存的是规则不是结果**：以后扫进来的书只要符合，
 * 自己就进这个分类。
 *
 * ── 这一版重做了什么 ─────────────────────────────────
 *
 * **1. 从「一个数」改成「一群书」。** 原来底下只有一行「按现在这条规则，圈中 12 本」。
 * 可 12 本对不对，光看数字**永远不知道**——圈错 12 本和圈对 12 本长得一模一样。
 * 而分类的全部价值就在「这条规则捞上来的是不是我想的那一堆」。
 * 现在右边一边改规则一边换人：**这是这次唯一花掉的那点「胆量」**，
 * 而它编码的是真事，不是装饰。
 *
 * **2. 五个条件统一成芯片。** 原来文件夹和评分是「不限」下拉、状态和标签是芯片——
 * 同一个界面里同一件事两套手势，人得学两遍。现在只有文件夹还是下拉
 * （它是一棵几十上百个节点的树，芯片摆不下），其余全是芯片，每组头一个都是「不限」。
 *
 * **3. 加了「格式」。** 真实库里 txt 和 pdf 混着放，而分类原来筛不出「只看 PDF」。
 * ⚠️ **只列真的存在的那几种**：一个全是 txt 的库不该摆出 mobi / azw3 / djvu
 * 三个点了必然圈中 0 本的芯片。
 */
export default function CategoryDialog(
  { editing, seed, dirs, tags, onClose, onApply }:
  {
    editing: SmartShelf | null;
    /**
     * 新建/临时筛选时的**初值**。
     *
     * ⚠️ 不能拿 `editing` 兼这个差：调用方传的是 `editCat.id ? editCat : null`
     * （id 0 ＝ 还不是一个分类），于是 id 0 时 `editing` 是 null，
     * 规则就喂不进来——点「改」会开出一张空表，而屏幕上那条筛选还在生效。
     */
    seed?: Filter;
    dirs: DirNode[];
    tags: Tag[];
    onClose: (changed: boolean) => void;
    /**
     * 「就这么筛，不存」。给了这个回调才会出现那个键。
     *
     * 这是这个弹窗的第二种用法：**同一个规则编辑器，可以不落地成分类**。
     * 不另做一条常驻筛选条的理由写在 `App.tsx` 那个「筛选」键上。
     */
    onApply?: (f: Filter) => void;
  },
) {
  /** 初值：改分类时是它自己的规则，新建/临时筛选时是调用方喂进来的那条 */
  const 初值: Filter = editing?.filter ?? seed ?? {};
  const [name, setName] = useState(editing?.name ?? '');
  /** 两段式删除：点第一下只是把话摆出来，点第二下才真删（同标签管理那套手势） */
  const [要删吗, set要删吗] = useState(false);
  const [dir, setDir] = useState<string>(初值.dir ?? 不限目录);
  const [minRating, setMinRating] = useState<number | ''>(初值.minRating ?? '');
  /*
   * 字数区间。后端 `buildFilter` 一直认这两个键（单边的「10 万字以下」和
   * 「50 万字以上」都筛得了），缺的只是界面上摆不出来。
   * 存的是**字数**，这里过一道「万字」——卡片上印的就是万字，
   * 让人输 300000 而看的是「30 万」是同一条判据的反面。
   */
  const [minWan, setMinWan] = useState<string>(初值.minWords != null ? String(初值.minWords / 10000) : '');
  const [maxWan, setMaxWan] = useState<string>(初值.maxWords != null ? String(初值.maxWords / 10000) : '');
  const [tagIds, setTagIds] = useState<number[]>(初值.tagIds ?? []);
  const [status, setStatus] = useState<string[]>(初值.readingStatus ?? []);
  const [format, setFormat] = useState<string[]>(初值.format ?? []);
  const [serial, setSerial] = useState<string[]>(初值.serialStatus ?? []);
  /** 哪一年读完的。`''` = 不限 */
  const [year, setYear] = useState<string>(
    初值.finishedYear != null ? String(初值.finishedYear) : '',
  );
  /** 库里真的出现过的那几个「读完年份」。同「格式」那条：只列真有的 */
  const [有的年份, set有的年份] = useState<Array<{ year: string; n: number }>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState<number | null>(null);
  const [预览, set预览] = useState<Book[]>([]);
  /** 库里真的有的那几种格式（带本数）。空数组＝还没问回来，或者只有一种 */
  const [有的格式, set有的格式] = useState<Array<{ format: string; n: number }>>([]);

  useEffect(() => {
    void rpc<Array<{ format: string; n: number }>>('book.formatCounts')
      .then(set有的格式)
      .catch(() => set有的格式([]));
    void rpc<Array<{ year: string; n: number }>>('book.finishedYears')
      .then(set有的年份)
      .catch(() => set有的年份([]));
  }, []);

  const filter: Filter = {
    ...(dir === 不限目录 ? {} : { dir }),
    ...(minRating === '' ? {} : { minRating: Number(minRating) }),
    // 空串和填了又清空都算「不限」——和上面那排芯片的「不限」同一个意思
    ...字数条件('minWords', minWan),
    ...字数条件('maxWords', maxWan),
    ...(tagIds.length ? { tagIds } : {}),
    ...(status.length ? { readingStatus: status } : {}),
    ...(format.length ? { format } : {}),
    ...(serial.length ? { serialStatus: serial } : {}),
    ...(year === '' ? {} : { finishedYear: Number(year) }),
  };
  const rule = JSON.stringify(filter);

  /*
   * 规则一变就重问两样：**多少本**，以及**头几本是谁**。
   *
   * `alive` 挡住回来晚了的那一次——快改几下规则时后发的可能先回，
   * 不挡的话屏幕上会闪回上一条规则的结果。
   */
  useEffect(() => {
    let alive = true;
    const f = JSON.parse(rule) as Filter;
    void rpc<{ n: number }>('book.matchCount', { filter: f })
      .then((v) => alive && setN(v.n))
      .catch(() => alive && setN(null));
    void rpc<Book[]>('book.list', { filter: f, limit: 12, sort: 'title' })
      .then((v) => alive && set预览(v))
      .catch(() => alive && set预览([]));
    return () => { alive = false; };
  }, [rule]);

  const 空规则 = Object.keys(filter).length === 0;

  /*
   * ── **「把当前圈中的这些，都放进这一分类」** ─────────────────────
   *
   * 分类的成员＝规则命中 ∪ 手动加入（`shelf_member`，迁移 27）。数据层那两条
   * （`planShelfByFilter` / `addShelfBooksByFilter`）落了很久、`dead-exports.mjs`
   * 一直报「全仓库零引用」——缺的从来只是这个入口。
   *
   * 什么时候用得上：规则圈不中书的分类（纯手动那一类）靠编辑弹窗一本一本勾，
   * 一百本就要点一百下；而用户常常已经用别的方式圈好了那一批。
   *
   * ⚠️ **预览和执行必须是同一份口径**（同 `reading.planStatusByFilter` 那条判据）：
   * 按钮上写着 N、点完动 0 本是骗人，多动了书是事故。这里 N ＝ 还差的那几本，
   * **已经是手动成员的既不算进来、也不进撤销名单**。
   */
  /** 预览那三条数：还差几本、已经在了几本、样本是哪几本 */
  interface 批量预览 { sample: Array<{ bookId: number; title: string }>; total: number; already: number }
  const [批量, set批量] = useState<批量预览 | null>(null);
  const [新加的, set新加的] = useState<number[] | null>(null);
  const [批量忙, set批量忙] = useState(false);
  const [批量话, set批量话] = useState<string | null>(null);
  // 依赖记的是**序列化之后的那一条**（`rule`）：`filter` 每次渲染都是新的对象引用，
  // 拿它当依赖等于每敲一个字重问一次后端。上面那个预览的 effect 早就是靠 `rule`
  const 问批量 = (那一个: SmartShelf) => rpc<批量预览>('shelf.planAddByFilter', {
    shelfId: 那一个.id, filter: JSON.parse(rule) as Filter,
  });

  useEffect(() => {
    if (!editing) { set批量(null); return; }
    let alive = true;
    void 问批量(editing)
      .then((p) => alive && set批量(p))
      .catch(() => alive && set批量(null));
    return () => { alive = false; };
  }, [editing, rule]);

  const 批量加进去 = async () => {
    if (!editing) return;
    set批量忙(true);
    set批量话(null);
    try {
      const r = await rpc<{ bookIds: number[] }>('shelf.addBooksByFilter', {
        shelfId: editing.id, filter: JSON.parse(rule) as Filter,
      });
      set新加的(r.bookIds);
      set批量话(`已经把 ${r.bookIds.length} 本放进「${editing.name}」。`);
      set批量(await 问批量(editing));
    } catch (e) {
      set批量话((e as Error).message);
    } finally {
      set批量忙(false);
    }
  };

  const 撤销批量 = async () => {
    if (!editing || !新加的) return;
    set批量忙(true);
    try {
      // 一次把整批发过去——逐本发就是几千次 IPC，同 `reading.restoreStatus` 那条
      const r = await rpc<{ removed: number }>('shelf.removeBooks', {
        shelfId: editing.id, bookIds: 新加的,
      });
      set批量话(`已经摘掉这次放进去的 ${r.removed} 本（原来就在的没动）。`);
      set新加的(null);
      set批量(await 问批量(editing));
    } catch (e) {
      set批量话((e as Error).message);
    } finally {
      set批量忙(false);
    }
  };

  const save = async () => {
    setErr(null);
    try {
      await rpc('shelf.save', { name, filter, ...(editing ? { id: editing.id } : {}) });
      onClose(true);
    } catch (e) { setErr((e as Error).message); }
  };

  const 删掉 = async () => {
    if (!editing) return;
    try {
      await rpc('shelf.remove', { id: editing.id });
      onClose(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  /**
   * 一组芯片。
   *
   * ⚠️ **每组头一个是「不限」**，而不是「一个都不选＝不限」。后者是个**看不见的状态**：
   * 屏幕上几个芯片都是灰的，用户不知道这一行到底生效没有。「不限」亮着的时候，
   * 这一行在明说「我不管这个」。
   */
  const 一组 = (
    标题: string,
    项: Array<{ id: string; name: string; n?: number }>,
    选中: string[],
    切换: (id: string) => void,
    清空: () => void,
    说明?: string,
  ) => (
    <div className="cond">
      <span className="cond-label">
        {标题}
        {说明 && <span className="cond-hint">{说明}</span>}
      </span>
      <div className="cond-chips">
        <button className="chip" aria-pressed={选中.length === 0} onClick={清空}>不限</button>
        {项.map((x) => (
          <button key={x.id} className="chip" aria-pressed={选中.includes(x.id)} onClick={() => 切换(x.id)}>
            {x.name}{x.n !== undefined && <span className="chip-n">{x.n}</span>}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="modal-backdrop" onClick={() => onClose(false)}>
      <div className="modal cat-modal" onClick={(e) => e.stopPropagation()}>
        {/*
          * **一个编辑器，两种用法**：挑完条件可以「就这么筛」（临时的，不留下东西），
          * 也可以起个名字「存成分类」（留下来，以后扫进来的书符合就自己进）。
          *
          * 合成一个而不是各做一套，是因为它们要表达的是**同一样东西**——一条规则。
          * 分成两处的话，「按评分筛」会有两份实现、两套手势，
          * 而这个仓库被「同一份判据抄第二份」咬过好几次。
          */}
        <h2>{editing ? '改这个分类' : '筛选'}</h2>
        <p className="muted" style={{ fontSize: '0.85rem', marginTop: 0 }}>
          挑几个条件，右边随时看圈中了谁。
          {editing
            ? '分类存的是规则不是结果——以后扫进来的书只要符合，自己就进这一类。'
            : '想留着以后接着用，就起个名字存成分类；只看这一次的话，直接「就这么筛」。'}
        </p>

        <label className="cond">
          <span className="cond-label">名字</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="比如「精校的仙侠」"
          />
        </label>

        {/* 左边问什么，右边圈到了谁。窄屏自己叠成一列 */}
        <div className="cat-grid">
          <div className="cat-rule">
            <div className="cond">
              <span className="cond-label">文件夹</span>
              {/* 只有这一项还是下拉：目录是一棵几十上百个节点的树，芯片摆不下 */}
              <select
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                // 同这一屏新加的那两个字数框：这一排的标题只是个说明用的 span，
                // 不是包着控件的 label，读屏念不出这是在问什么
                aria-label="只看某个文件夹里的书"
              >
                <option value={不限目录}>不限</option>
                {dirs.map((d) => (
                  <option key={d.dir} value={d.dir}>
                    {d.dir === '' ? '最外层' : d.dir}（{d.total}）
                  </option>
                ))}
              </select>
            </div>

            {/* 只有一种格式的库不摆这一行：那时它是个永远只有「不限」和一个选项的开关 */}
            {有的格式.length > 1 && 一组(
              '格式',
              有的格式.map((x) => ({ id: x.format, name: 格式名(x.format), n: x.n })),
              format,
              (id) => setFormat((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])),
              () => setFormat([]),
              '选几个＝任意一种',
            )}

            {一组(
              '评分',
              [5, 4, 3, 2, 1].map((r) => ({ id: String(r), name: r === 5 ? '5 星' : r + ' 星以上' })),
              minRating === '' ? [] : [String(minRating)],
              (id) => setMinRating(minRating === Number(id) ? '' : Number(id)),
              () => setMinRating(''),
            )}

            {/*
             * **字数区间。** `buildFilter` 认这两个键很久了（单边也成立：只填一头
             * 就是「N 万字以上」/「N 万字以下」），缺的从来只是摆不出来。
             *
             * ⚠️ 用输入框不用芯片：芯片只能表达写死的几档（10 万 / 50 万），
             * 而「别给我那种十万字的短篇」要的是一条自己定的线。
             * 和「文件夹」那一行同一个道理——**值不受控的项不做成芯片**。
             *
             * 空着＝不限，跟右边那排芯片的「不限」是同一个意思，不额外摆开关。
             */}
            <div className="cond">
              <span className="cond-label">
                字数
                <span className="cond-hint">万字，空着＝不限；只填一头就是「以上」或「以下」</span>
              </span>
              <span className="cond-range">
                <input
                  type="number" min="0" step="0.1" inputMode="decimal"
                  value={minWan}
                  onChange={(e) => setMinWan(e.target.value)}
                  placeholder="最低"
                  aria-label="字数不少于（万字）"
                />
                <span className="muted">–</span>
                <input
                  type="number" min="0" step="0.1" inputMode="decimal"
                  value={maxWan}
                  onChange={(e) => setMaxWan(e.target.value)}
                  placeholder="最高"
                  aria-label="字数不多于（万字）"
                />
              </span>
            </div>

            {/*
              * **读完年份。** `finished_at` 一直在写、一直进备份，而在这之前
              * 界面上一处都用不到它——「我 2025 年读完了哪些」这个问题
              * 在这个应用里以前根本问不出来。
              *
              * 只列真的有的那几年（同「格式」那条）：一个只在 2025 年读完过书的库，
              * 不该摆出 2019–2026 八个点了必然圈中 0 本的芯片。
              * 一年都没有就整行不出现——那说明用户还没标过任何一本「已读完」。
              *
              * ⚠️ **单选**：一本书只有一个读完年份，多选「2024 或 2025」
              * 后端要改成 in 才成立，而那不是这一版要的。
              */}
            {有的年份.length > 0 && 一组(
              '读完年份',
              有的年份.map((y) => ({ id: y.year, name: `${y.year} 年`, n: y.n })),
              year === '' ? [] : [year],
              (id) => setYear((p) => (p === id ? '' : id)),
              () => setYear(''),
            )}

            {/* 连载状态是**书自己的属性**，不是我和它的关系——和阅读状态是两回事。
                后端一直筛得了，界面上一处都够不着 */}
            {一组(
              '连载状态',
              SERIAL_STATUS.map((s) => ({ id: s.id, name: s.name })),
              serial,
              (id) => setSerial((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])),
              () => setSerial([]),
              '选几个＝任意一档',
            )}

            {一组(
              '阅读状态',
              READING_STATUS.map((s) => ({ id: s.id, name: s.name })),
              status,
              (id) => setStatus((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])),
              () => setStatus([]),
              '选几个＝任意一档',
            )}

            {tags.length > 0 && 一组(
              '标签',
              tags.map((t) => ({ id: String(t.id), name: t.name, n: t.count })),
              tagIds.map(String),
              (id) => setTagIds((p) => (
                p.includes(Number(id)) ? p.filter((x) => x !== Number(id)) : [...p, Number(id)]
              )),
              () => setTagIds([]),
              '选几个＝同时带',
            )}
          </div>

          <div className="cat-hit">
            <div className="cat-hit-head">
              {空规则 ? '还没设规则' : n === null ? '正在数…' : '圈中 ' + n + ' 本'}
            </div>
            {空规则 ? (
              <p className="muted cat-hit-say">
                还没挑条件。存下来也行——以后往里手动加书就好。
              </p>
            ) : n === 0 ? (
              <p className="muted cat-hit-say">
                这条规则一本都没圈到。松一个条件试试——几个条件之间是<strong>同时</strong>成立的。
              </p>
            ) : (
              <>
                <ul className="cat-hit-list">
                  {预览.map((b) => (
                    <li key={b.id}>
                      <span className="cat-hit-title" title={b.title}>{b.title}</span>
                      <span className="cat-hit-by">
                        {b.author ?? '未知作者'}
                        {b.path && <span className="cat-hit-ext">{extOf(b.path).toUpperCase()}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
                {n !== null && n > 预览.length && (
                  <p className="muted cat-hit-say">还有 {n - 预览.length} 本</p>
                )}
              </>
            )}

            {/*
             * 批量入口**只在改一个已经存在的分类时出现**：新建那一步还没有 id，
             * 而「存成分类」和「一次性塞一百本」不该挤在同一次点击里——
             * 那是两件事，先把规则定下来再谈塞书。
             */}
            {editing && !空规则 && (
              <div className="cat-batch">
                {批量 && 批量.total === 0 ? (
                  <p className="muted cat-hit-say">
                    {批量.already > 0
                      ? <>这一批<strong>已经是</strong>「{editing.name}」的成员了（{批量.already} 本）。</>
                      : '右边这些一本都不用加。'}
                  </p>
                ) : (
                  <button className="mini" disabled={批量忙} onClick={() => void 批量加进去()}>
                    把这 {批量?.total ?? '几'} 本都放进「{editing.name}」
                  </button>
                )}
                {批量话 && (
                  <p className="muted cat-hit-say">
                    {批量话}
                    {新加的 && 新加的.length > 0 && (
                      <button className="mini" disabled={批量忙} onClick={() => void 撤销批量()}>
                        撤销
                      </button>
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {err && <p className="danger">{err}</p>}

        {/*
          * ⚠️ **分类原来能建、能改，就是删不掉。**
          *
          * `shelf.remove` 这个 rpc 一直在，而渲染进程里一次都没调过——
          * 死 rpc 清点当场把它揪出来了。后果不是少个功能：分类是**保存下来的筛选条件**，
          * 建错一个、或者哪天不想要了，那条标签栏就只增不减。
          *
          * 两段式确认，不 `window.confirm`（原生模态框和这个应用的内联确认不是一套，
          * 还会挡住自动化）。删的是他自己写的名字和规则，重扫恢复不了，
          * 但**书一本都不会少**——那句话要说出来，否则用户不敢点。
          */}
        <div className="modal-actions">
          {editing && (
            要删吗 ? (
              <>
                <button className="danger" onClick={() => void 删掉()}>
                  确认删掉「{editing.name}」
                </button>
                <button onClick={() => set要删吗(false)}>再看看</button>
              </>
            ) : (
              <button className="mini" onClick={() => set要删吗(true)} style={{ marginRight: 'auto' }}>
                删掉这个分类
              </button>
            )
          )}
          {!要删吗 && (
            <>
              {/*
                * **「就这么筛」排在前面**：从「筛选」那个键进来的人十有八九
                * 只是想看一眼，让他为此先想一个分类名是在收过路费。
                * 存成分类是**可选的第二步**，不是必经的那一步。
                *
                * 名字空着时「存成分类」不可点——那是它唯一的硬要求，
                * 而「就这么筛」不需要名字。
                */}
              {onApply && !editing && (
                <button className="primary" onClick={() => onApply(filter)} disabled={空规则}>
                  就这么筛
                </button>
              )}
              <button
                className={onApply && !editing ? undefined : 'primary'}
                onClick={() => void save()}
                disabled={!name.trim()}
                title={!name.trim() ? '存成分类要先起个名字' : undefined}
              >
                {editing ? '保存' : '存成分类'}
              </button>
              <button onClick={() => onClose(false)}>取消</button>
            </>
          )}
        </div>
        {要删吗 && (
          <p className="muted" style={{ margin: '0.4rem 0 0', fontSize: '0.85rem' }}>
            只删这条分类规则，书一本都不会少——那些书还在书架上，只是不再自动归到这一类。
          </p>
        )}
      </div>
    </div>
  );
}
