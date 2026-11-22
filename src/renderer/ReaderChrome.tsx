// 两个阅读界面（`Reader.tsx` 的 txt 阅读器、`FileViewer.tsx` 的 PDF/EPUB 查看器）
// **共用的那几块壳**。
//
// 为什么单开一个文件：这两个界面是两份实现，而这个仓库在它们之间抓到过三次分叉
// （`NoteCard.tsx` 就是第一次抽出来的成果——抽之前查看器那份「一点就删」，
// 而它的注释还写着「判据和 txt 一样」）。去重扫描这次又报出三处逐字节相同的 JSX，
// 都在这儿了。
//
// ⚠️ **只收「两边判据必须一样」的东西。** 往哪儿贴、贴不下怎么翻上去、
// PDF 那一页是 canvas 所以纸色作用不到——那些两边算法不同，不共用
// （同 `NoteCard.tsx` 顶上那条）。

import type { ReactNode } from 'react';
import { ICO } from './icons.tsx';
import { TtsEngines } from './TtsEngines.tsx';
import { isNightTheme, type ReadSettings, type ThemeId } from './settings.ts';

export function ReaderPager({ unit, previous, next, position, children }: {
  unit: '章' | '页';
  previous: { run: () => void; title: string; disabled?: boolean };
  next: { run: () => void; title: string; disabled?: boolean };
  position?: string;
  children?: ReactNode;
}) {
  return (
    <div className="reader-foot" role="group" aria-label={unit === '章' ? '章节导航' : '翻页'}>
      <button disabled={previous.disabled} onClick={previous.run} title={previous.title}>
        {ICO.prev}<span>上一{unit}</span>
      </button>
      <div className="reader-position">
        {children}
        {position && <span className="pager-n">{position}</span>}
      </div>
      <button disabled={next.disabled} onClick={next.run} title={next.title}>
        <span>下一{unit}</span>{ICO.next}
      </button>
    </div>
  );
}

/**
 * 一键白天 / 夜间。
 *
 * 主题下拉在设置浮层里，但「天黑了」是最高频的一次点击，所以让它单独占一个位置。
 * 两个阅读界面同一个键、同一个位置。
 *
 * ⚠️ **「现在是不是夜间」走 `isNightTheme`，别再手写 id 的拼法。**
 * 两处原来各写一份 `theme === 'night' || theme.endsWith('-night')`——
 * 而导进来的 legado 主题 id 是 `imported-<名字>`：一张深色的导入主题
 * `night` 是 true 而 id 不以 `-night` 结尾，于是应用外观已经是暗的，
 * 这个键却还写着「切到夜间」、图标还是月亮。
 */
export function NightToggle({ theme, setTheme }: {
  theme: ThemeId;
  setTheme: (v: ThemeId) => void;
}) {
  const night = isNightTheme(theme);
  return (
    <button
      onClick={() => setTheme(night ? 'shuzhai-day' : 'shuzhai-night')}
      title={night ? '切到白天' : '切到夜间'}
    >
      {night ? ICO.sun : ICO.moon}<span>{night ? '白天' : '夜间'}</span>
    </button>
  );
}

/**
 * 朗读引擎弹窗。两个阅读界面原来逐字节相同地各写一份。
 *
 * 结构（`.modal-backdrop` + `.modal`）保持原样不动：焦点那一套由
 * `modal-a11y.ts` 一处管全部弹窗，认的是这两个类名。
 */
export function TtsEnginesModal({ settings, setSettings, onClose }: {
  settings: ReadSettings;
  setSettings: (f: (prev: ReadSettings) => ReadSettings) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        {/* 对话框标题一律 h2：同族里「书签与划线」是 h2，这里原来是 h3，
            文档大纲跳了一级。`modal-a11y` 认 h1-h3，两个都接得到名字，所以只有大纲受影响 */}
        <h2 style={{ marginTop: 0 }}>朗读引擎</h2>
        <TtsEngines
          read={settings}
          applyRead={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
        />
        <div className="modal-actions">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 书名放在目录和搜索旁边，读正文时不占空间。
 *
 * 「收起」那个键不能省：Esc 和再按一次「目录」也行，但**只有写出来的那个才算入口**
 * （同本仓库那条「有入口不等于找得到」）。
 *
 * `children` 是给查看器塞它自己那块用的（PDF 的「把这一页加进目录」）——
 * 那一块只有 PDF 有，不属于共用判据。
 */
export function TocHead({ bookTitle, filter, setFilter, onClose, children }: {
  bookTitle: string;
  filter: string;
  setFilter: (v: string) => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="toc-head">
      <div className="toc-title">
        <h3 className="pop-title">目录</h3>
        <span className="toc-book-context" title={bookTitle}>{bookTitle}</span>
        <button className="toc-close" onClick={onClose}>收起</button>
      </div>
      <input
        type="search"
        aria-label="搜索章节标题"
        placeholder="搜索章节标题"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ width: '100%' }}
      />
      {children}
    </div>
  );
}
