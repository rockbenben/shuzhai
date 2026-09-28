import { useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from './rpc.ts';
import type { Tag } from '../core/library.ts';

/**
 * 最多列几个「用过的标签」。再多一排就放不下，也就失去了「点一下就上」的意义。
 * 编辑弹窗里地方宽得多，但**故意用同一个数**：两处的「一眼扫过去能点几个」
 * 应该是同一件事，各定一个只会让两边手感不一样。
 */
const QUICK_TAGS = 12;

/**
 * 逗号分隔 ↔ 数组。`book.list` / `book.detail` 给的都是逗号分隔那一串。
 *
 * **只此一份。** 原来渲染进程有四处各写了一遍
 * `(s ?? '').split(',').map((t) => t.trim()).filter(Boolean)`（这个组件、
 * 书架卡片、表格、书评册），而**书架卡片那一份还漏了 trim**。
 * 四处里三处是逐字节相同的复制品，第四处是抄漏了一步的——这正是本仓库
 * 反复栽的那个形状。要改判据（比如以后允许多字分隔符）只改这儿。
 */
export function 拆标签(s: string | null | undefined): string[] {
  return (s ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

interface Props {
  bookId: number;
  /** 逗号分隔，`book.detail` / `book.list` 直接给的那个 */
  tags: string | null;
  /** 改完回调**新值**（逗号分隔，和上面同一个形状） */
  onChange: (tags: string) => void;
  /**
   * 出错时交给调用方显示，**这一块自己不画红字**。
   * 两个宿主各有各的报错位置（浮层在整块最下面、弹窗在底栏上方），
   * 让这一块自己画的话，编辑弹窗里那行红字会夹在标签和归类中间，
   * 离底栏那个「保存」很远。
   */
  onError: (msg: string | null) => void;
  /**
   * 这一块的内容变了（标签表回来、增删了一个）——宿主可能要重新量一次自己的尺寸。
   *
   * **只有评价浮层用得上**：它是 `top: 100%` 挂在卡片下面的，高度得跟着内容走，
   * 而「用过的标签」是异步来的，会把浮层撑高（那段判断写在 `RatePopover` 的
   * 量尺寸 effect 上，原本靠 `[all]` 当依赖）。标签表搬到这一块之后，
   * 宿主手上就没有那个数组了，所以由这一块主动报一声。
   * 编辑弹窗不需要——它是个居中弹窗，高度自己会撑开。
   */
  onGrow?: () => void;
}

/**
 * **给一本书打标签 / 摘标签**——`RatePopover`（卡片上的评价浮层）和
 * `BookEditor`（编辑弹窗）共用这一份。
 *
 * 抽出来是照着 `NoteCard.tsx` / `ReaderChrome.tsx` 那两次的理由：
 * 两个界面各写一份、判据又必须一样的东西，迟早分叉。这里要共用的判据是
 * 三条具体的：
 *
 * 1. **失败就退回去，别让界面撒谎**——先乐观地改本地 state，rpc 失败再撤回；
 * 2. **点掉一个标签要拿 `tagId`**（`tag.remove` 收的是 id 不是名字，
 *    名字只在本地列表里找得到，找不到就没法删——所以 `tag.list` 要一起取）；
 * 3. **新增完要重取 `tag.list`**：新标签得立刻出现在「用过的」那一排里，
 *    不然同一个标签第二本书要重新打一遍字。
 *
 * ⚠️ **打标签本身没有二次确认，这是有意的**：摘一个标签只是少一层归类，
 * 而它是可再生的（重打一次就是了）。要拦的是「删掉整个标签」——
 * 那会从几百本书上一起摘掉，安全阀在 `tag.delete` 和标签管理里。
 */
export function TagPicker({ bookId, tags, onChange, onError, onGrow }: Props) {
  const [mine, setMine] = useState<string[]>(() => 拆标签(tags));
  const [all, setAll] = useState<Tag[]>([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    void rpc<Tag[]>('tag.list').then(setAll).catch(() => {});
  }, []);

  /*
   * 宿主重新拉过详情（保存、重新解析、切到另一本书）时跟着走。
   *
   * 值一样时是空操作——`mine` 变出来的串和外面传回来的是同一个，
   * 所以这条不会和自己打架。**但它是必要的**：编辑弹窗保存一次就
   * `setD(fresh)`，不跟的话这一块会停在旧值上。
   */
  useEffect(() => { setMine(拆标签(tags)); }, [tags]);

  /*
   * 内容变了就报一声，让宿主重新量尺寸。
   *
   * **放在 effect 里而不是各个 setState 后面**：那几处 setState 是异步的，
   * 紧跟其后报的话 DOM 还没重排完，宿主量到的是旧高度。
   * 回调走 ref 是因为宿主十有八九传的是内联箭头函数——直接进依赖数组的话
   * 每次渲染都会报一声（不致命，但白跑）。
   */
  const grow = useRef(onGrow);
  grow.current = onGrow;
  useEffect(() => { grow.current?.(); }, [all, mine]);

  const addTag = async (raw: string) => {
    const name = raw.trim();
    if (!name || mine.includes(name)) { setDraft(''); return; }
    setMine((m) => [...m, name]);
    setDraft('');
    try {
      await rpc('tag.add', { bookIds: [bookId], names: [name] });
      setAll(await rpc<Tag[]>('tag.list'));
      onError(null);
      onChange([...mine, name].join(','));
    } catch (e) {
      setMine((m) => m.filter((x) => x !== name)); // 失败就退回去，别让界面撒谎
      onError((e as Error).message);
    }
  };

  const dropTag = async (name: string) => {
    const t = all.find((x) => x.name === name);
    setMine((m) => m.filter((x) => x !== name));
    if (!t) return;
    try {
      await rpc('tag.remove', { bookIds: [bookId], tagId: t.id });
      onError(null);
      onChange(mine.filter((x) => x !== name).join(','));
    } catch (e) {
      setMine((m) => [...m, name]);
      onError((e as Error).message);
    }
  };

  /** 用过的标签里，这本还没打上的那些。打过的已经在上面显示成可点掉的小块了 */
  const quick = useMemo(
    () => all.filter((t) => !mine.includes(t.name)).slice(0, QUICK_TAGS),
    [all, mine],
  );
  /** 边打边补全。空输入时不显示——那时候上面那排「用过的」本来就在 */
  const matches = useMemo(() => {
    const q = draft.trim();
    if (!q) return [];
    return all.filter((t) => !mine.includes(t.name) && t.name.includes(q)).slice(0, 8);
  }, [all, mine, draft]);

  const 候选 = matches.length > 0 ? matches : quick;

  return (
    <>
      {mine.length > 0 && (
        <div className="chip-row">
          {mine.map((t) => (
            <button key={t} className="chip on" onClick={() => void dropTag(t)} title="摘掉这个标签">
              {t} ×
            </button>
          ))}
        </div>
      )}

      <input
        className="tag-picker-input"
        value={draft}
        placeholder="加标签，回车新建"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void addTag(draft); }}
      />

      {候选.length > 0 && (
        <div className="chip-row">
          {候选.map((t) => (
            <button key={t.id} className="chip" onClick={() => void addTag(t.name)}>
              {t.name}
              <span className="muted"> {t.count}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
