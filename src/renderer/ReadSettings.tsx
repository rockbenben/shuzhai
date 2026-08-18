import { useEffect, useMemo, useState } from 'react';
import { rpc } from './rpc.ts';
import {
  applySettings, colorThemes, saveThemeOverride, resetThemeOverride, isThemeOverridden,
  READ_FONTS, type ReadSettings,
} from './settings.ts';

// ⚠️ 引同一份，不在这儿再声明一个（`dup-decls.mjs` 盯着这件事）
import type { FontFile } from './Settings.tsx';

/**
 * 阅读设置里**和格式无关的那两组**：纸（纸色 + 调色）和字（字号 / 行距 / 缩进 /
 * 段距 / 正文字体）。
 *
 * ── 为什么要抽出来 ─────────────────────────────────────
 *
 * 用户的原话：「非 txt 的阅读界面也应该和 txt 一致的，不该分开」。
 * 而在这之前，**这两组只长在 `Reader.tsx` 里**——想换张纸、调个字号，
 * 开着 EPUB 的人得退出去、随便找一本 txt 打开、在那儿改、再退出来重新开。
 * 而 EPUB 是**认这些设置的**（开书时那次 `themes.override` 就在读它们）。
 *
 * 那就只有两条路：在查看器里抄一份，或者收成一份两边共用。
 * 这个仓库被「抄第二份」咬过三次，所以是后者。
 *
 * ⚠️ **`能改正文` 不是开关，是事实。** PDF 那一页是 canvas 上的一张图，
 * 字号行距一样都作用不到它——那时候整个「字」组不摆出来，
 * 而不是摆出来点了没反应（本仓库那条：摆一排点了必然出错的按钮，比没有更糟）。
 * 纸色那组照旧摆：它至少管着四周的壳。
 */
export function ReadSettingsPanel(
  { settings, set, 能改正文, 模式, 繁简 }: {
    settings: ReadSettings;
    set: <K extends keyof ReadSettings>(k: K, v: ReadSettings[K]) => void;
    能改正文: boolean;
    /**
     * 这个界面**认哪几种阅读方式**。不给就不摆「读」那一组。
     *
     * ⚠️ **这里列的是「做得到的」，不是「想给的」**：PDF 没有章的概念，
     * 它只有 `['scroll', 'page']` 两档，那时候 `scroll` 显示成「下滑」而不是
     * 「按章」——摆一个点了和另一个一模一样的按钮，比少一个更糟。
     */
    模式?: Array<ReadSettings['mode']>;
    /**
     * 繁简。`改` 由调用方给——txt 那边要重新取一遍章节正文，
     * EPUB 那边是把 iframe 里的文字节点就地换掉，两件事不一样。
     * `说明` 只有 PDF 用得上（那一页是图，转的只有朗读念的字）。
     */
    繁简?: { 值: string; 改: (m: string) => void; 说明?: string };
  },
) {
  const [fontFiles, setFontFiles] = useState<FontFile[]>([]);
  /** 改过一格颜色之后靠它逼一次重算——`colorThemes()` 读的是 localStorage */
  const [paperVer, setPaperVer] = useState(0);

  /*
   * ⚠️ **这儿只取名单，不注入 `@font-face`。**
   * 注入是「阅读界面」的事，得在**面板从没打开过**的时候也成立——
   * 两边（`Reader` / `FileViewer`）各自在挂载时做一次。
   * 放在这里的话，不开设置就用不上自己装的字体，而下拉里还选得到，看起来像装坏了。
   */
  useEffect(() => {
    void rpc<FontFile[]>('font.list').then(setFontFiles).catch(() => {});
  }, []);

  const paperNow = useMemo(
    () => colorThemes().find((t) => t.id === settings.theme),
    [settings.theme, paperVer],
  );
  /** 改一格颜色：存成同 id 的用户主题盖掉内置那份，然后立刻重写 --read-* */
  const setPaper = (k: 'bg' | 'panel' | 'fg', v: string) => {
    if (!paperNow) return;
    saveThemeOverride({ ...paperNow, [k]: v });
    applySettings(settings);
    setPaperVer((n) => n + 1);
  };

  /**
   * 一行「标签 值 [−][＋]」。
   *
   * ⚠️ **`nowrap` + 提示另起一行。** 两列排下来每格只有约 130px，
   * 「行距 1.8 倍」会在数字和单位之间折成两行——一行里只要有一格折了，
   * 整行就是双高，两列省下的高度当场还回去。
   * 而「每行 53 字」后面那句「约 1484px」是补充说明，自己占一行，
   * 加减键永远在右上角。
   */
  const step = (
    label: string,
    k: 'size' | 'line' | 'width' | 'indent' | 'para' | 'pad',
    min: number, max: number, d: number, unit: string,
    /** 存的值和显示的值不一样时用它（页边距存 rem、显示 px） */
    show: (n: number) => string = String,
    /** 跟在后面的一句小字 */
    hint?: (n: number) => string,
  ) => {
    const v = settings[k];
    const to = (n: number) => set(k, Number(Math.min(max, Math.max(min, n)).toFixed(1)));
    return (
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <span className="muted" style={{ fontSize: '.8rem', minWidth: 0, whiteSpace: 'nowrap' }}>
          {label} {show(v)}{unit}
          {hint && <span style={{ opacity: 0.75, display: 'block' }}>{hint(v)}</span>}
        </span>
        <span className="row" style={{ gap: '.3rem', flex: 'none' }}>
          <button disabled={v <= min} aria-label={label + '减小'} onClick={() => to(v - d)}>−</button>
          <button disabled={v >= max} aria-label={label + '增大'} onClick={() => to(v + d)}>＋</button>
        </span>
      </div>
    );
  };

  return (
    <>
      {/*
        * **纸色用色块，不用下拉。**
        *
        * 一张纸是什么样，名字说不清——「羊皮纸」「护眼」「legado 淡青」
        * 这些词只有见过的人才知道指哪个颜色，而下拉在收起来的时候
        * **一格颜色都不显示**。色块本身就是它要表达的东西。
        *
        * 每个块画的是那张纸的 `panel`（正文那一栏的底色），不是 `bg`（桌面色）——
        * 用户盯着看的是纸不是桌子。夜间那几张自然就是深色，不用另做标记。
        *
        * ⚠️ **只有色块的按钮必须带 `aria-label`**：屏幕阅读器听到的不能是
        * 十个一模一样的「按钮」（`keyboard.mjs` 那条「每个控件都要有能读的名字」
        * 就是为这种情况设的，五颗星当年栽过一次）。
        */}
      <h4 className="panel-group">纸</h4>
      <div className="paper-row">
        {colorThemes().map((t) => (
          <button
            key={t.id}
            className="paper-dot"
            aria-label={t.name}
            aria-pressed={settings.theme === t.id}
            title={t.name}
            /* ⚠️ **不给 borderColor**：边框归 `.paper-dot` 管（用当前界面的 `--muted`）。
               原来这里内联给的是这张纸自己的 `t.line`，浅色纸压在浅色面板上量到
               1.27:1，而 WCAG 1.4.11 要 3:1——十颗里六颗看不见。理由写在那条 CSS 上 */
            style={{ background: t.panel, color: t.fg }}
            onClick={() => set('theme', t.id as ReadSettings['theme'])}
          >
            {settings.theme === t.id ? '✓' : ''}
          </button>
        ))}
      </div>

      {/*
        * 调色摆在阅读器里，不在设置弹窗里。原来它在「设置 → 阅读」那一页，
        * 而那个弹窗是从书架打开的——**调正文颜色的时候正文根本不在屏幕上**。
        */}
      {paperNow && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="row" style={{ gap: '.5rem' }}>
            {/* **色块要带名字。** 只有 `title` 的话得挨个悬停才知道哪个是纸哪个是字——
                而这三样改错一个，整页正文当场看不清 */}
            {([['bg', '桌面'], ['panel', '纸'], ['fg', '文字']] as const).map(([k, label]) => (
              <label key={k} className="swatch" title={label + ' ' + paperNow[k]}>
                <input
                  type="color"
                  value={paperNow[k]}
                  aria-label={label}
                  onChange={(e) => setPaper(k, e.target.value)}
                />
                <span className="muted">{label}</span>
              </label>
            ))}
          </span>
          <span className="row">
            {isThemeOverridden(settings.theme) && (
              <button
                className="mini"
                title="回到随应用发布的那份配色"
                onClick={() => {
                  resetThemeOverride(settings.theme);
                  applySettings(settings);
                  setPaperVer((n) => n + 1);
                }}
              >
                复原
              </button>
            )}
          </span>
        </div>
      )}

      {/*
        * **字：天天动的那四项，两列排。** 六项一行一个的时候，字号和「顶部留白」
        * 在版面上等重——而后者大概一辈子调一次。同一行的两项是一对：
        * 字号↔行距、缩进↔段距。
        *
        * ⚠️ **PDF 那一页是 canvas 上的一张图**，这一整组作用不到它。
        * 那时候整组不摆出来，而不是摆出来点了没反应。
        */}
      {能改正文 && (
        <>
          <h4 className="panel-group">字</h4>
          <div className="step-grid">
            {step('字号', 'size', 12, 32, 1, 'px')}
            {step('行距', 'line', 1, 3, 0.1, ' 倍')}
            {step('缩进', 'indent', 0, 4, 0.5, ' 字')}
            {step('段距', 'para', 0, 3, 0.1, ' 行')}
          </div>

          {/*
            * **字体用芯片，而且每个芯片用它自己的字渲染。**
            *
            * 下拉的 `<option>` 上写 `fontFamily` 是**收不到效果的**——浏览器画收起来
            * 那一格时基本不认它。于是那个下拉从头到尾用同一种字显示十二个字体名，
            * 「宋体」和「黑体」长得一模一样，只能选一个、关掉、看一眼、再回来换。
            */}
          <div className="cond" style={{ gap: '.25rem' }}>
            <span className="muted" style={{ fontSize: '.8rem' }}>正文字体</span>
            <div className="font-row">
              {READ_FONTS.map((f) => (
                <button
                  key={f.label}
                  className="chip font-chip"
                  aria-pressed={settings.font === f.value}
                  title={f.label}
                  style={{ fontFamily: f.value || 'inherit' }}
                  onClick={() => set('font', f.value)}
                >
                  {f.label.replace(/（.*?）/g, '')}
                </button>
              ))}
              {fontFiles.map((f) => (
                <button
                  key={f.name}
                  className="chip font-chip"
                  aria-pressed={settings.font === '"' + f.name + '"'}
                  title={'自己装的：' + f.name}
                  style={{ fontFamily: '"' + f.name + '"' }}
                  onClick={() => set('font', '"' + f.name + '"')}
                >
                  {f.name}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {繁简 && (
        <>
          {/*
            * **繁简。** 运行时转换，不改原文件（铁律 1）。
            *
            * ⚠️ **它不是「txt 专有」的**——用户的原话：「只要是文字都该支持简繁」。
            * EPUB 的正文是 iframe 里真正的文字节点，转得了；PDF 那一页是图，
            * 转不了，但**朗读念的那段文字**是真文字，也该转。所以三个界面都摆，
            * 只有 PDF 多一句话说明它作用在哪儿（`说明`）。
            *
            * 上一轮把「版」和「读」漏在 txt 那边，就是因为按「这段代码原来长在哪」
            * 分而不是按「它对这一屏有没有作用」分。这一条是同一个判据的第三次应用。
            */}
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: '.8rem' }}>繁简</span>
            <select
              value={繁简.值}
              title="运行时转换，不改原文件"
              onChange={(e) => 繁简.改(e.target.value)}
            >
              <option value="off">原文</option>
              <option value="to-simplified">转简体</option>
              <option value="to-traditional">转繁体</option>
            </select>
          </div>
          {繁简.说明 && (
            <p className="muted" style={{ fontSize: '.75rem', margin: '-.2rem 0 .2rem' }}>{繁简.说明}</p>
          )}
        </>
      )}

      {/*
        * **版：这一页占多大。** 和「字」分开是有理由的——前面那四项改的是
        * 字长什么样，这两项改的是**纸有多宽、上面留多少**。它们也正是仅有的
        * 两项带补充说明的，塞进那个两列网格会把整行撑成双高。
        *
        * ⚠️ **这一组对 PDF 一样成立**，所以它在共用面板里、不在 `children` 里。
        * `--read-col` 管的是 `.viewer-stage` 的宽度、`--read-pad` 管的是
        * `.reader-body` 的上边距，两个查看器都吃这两条。原来它只长在
        * `Reader.tsx` 里，于是开着 PDF 的人**改不了这一页占多宽**。
        *
        * 只有**说法**要分：txt / EPUB 是排出来的字，说「每行 53 字」；
        * PDF 那一页是整张图，字数对它没有意义，同一个值直接说成「页宽 1113px」。
        * 「每行 N 字」就是最大宽度设置——单位是「字」不是 px，因为**字号可调**：
        * 同样 53 字，21px 下 1113px、28px 下 1484px。
        * **叫「每行」不叫「版口」**——版口是排版行话，这个应用是给普通人用的。
        * 上限 120 不是 80：2560 的屏上 80 字只占 1680px，剩下八百多是空桌子。
        */}
      <h4 className="panel-group">版</h4>
      {能改正文
        ? step('每行', 'width', 20, 120, 1, ' 字', String,
          (n) => `　约 ${Math.round(n * settings.size)}px`)
        : step('页宽', 'width', 20, 120, 1, 'px',
          (n) => String(Math.round(n * settings.size)))}
      {/* **不要把 `rem` 摆给用户看**——那是 CSS 单位，不是人话，而且旁边
          「字号 21px」用的是另一套。存的仍然是 rem（`--read-pad` 要它），
          只在显示时乘成 px。**叫「顶部」不叫「上下」**：`--read-pad` 只进了
          padding 简写的第一格，底下那 6rem 是给工具轨和状态条留的、不跟着动 */}
      {step('顶部留白', 'pad', 0, 8, 0.5, 'px', (n) => String(n * 16))}

      {模式 && 模式.length > 1 && (
        <>
          {/*
            * **读：怎么翻、翻多快。** 几档都摆出来、当前的高亮——原来是一个按钮
            * 显示当前模式，和旁边「点了就执行」的按钮长得一样，分不清是状态还是动作。
            * 名字说的是**读起来什么样**，不是实现（「无限下滑」不叫「连续滚动」）。
            * 自动滚跟它一组：两者回答的是同一个问题。
            *
            * ⚠️ **档位由调用方给，不在这儿写死。** PDF 只有两档，而且那时候
            * `scroll` 的名字要跟着变——一本 PDF 没有章，「按章」对它不成立。
            */}
          <h4 className="panel-group">读</h4>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: '.8rem' }}>阅读方式</span>
            <div className="tabs">
              {([
                {
                  m: 'scroll' as const,
                  名: 模式.includes('flow') ? '按章' : '下滑',
                  说: 模式.includes('flow')
                    ? '一次读一章，滚到底按「下一章」'
                    : '整本连着往下滚，滚轮一路到底',
                },
                { m: 'flow' as const, 名: '无限下滑', 说: '滚到章尾自动接上下一章，一路往下不用点' },
                { m: 'page' as const, 名: '左右翻', 说: '像纸书一样一页页翻，点正文两侧或用滚轮' },
              ]).filter((d) => 模式.includes(d.m)).map((d) => (
                <button
                  key={d.m}
                  aria-current={settings.mode === d.m}
                  title={d.说}
                  onClick={() => set('mode', d.m)}
                >{d.名}</button>
              ))}
            </div>
          </div>
          <label className="row" style={{ justifyContent: 'space-between', gap: '.4rem' }}>
            <span className="muted" style={{ fontSize: '.8rem' }} title={`${settings.autoScroll} px/s`}>自动滚</span>
            <input
              type="range"
              min={10}
              max={200}
              step={1}
              value={settings.autoScroll}
              onChange={(e) => set('autoScroll', Number(e.target.value))}
              style={{ flex: 1, minWidth: 0, accentColor: 'var(--accent)' }}
            />
            <span className="muted" style={{ fontSize: '.78rem', minWidth: '3.4rem', textAlign: 'right' }}>
              {/* **`px/s` 不是人话**（同这个面板里「顶部留白」不摆 rem 那条）。
                  换算成「一分钟几行」：一行的高度就是 字号 × 行距，
                  读书的人对「一分钟十几行」有感觉，对「40 px/s」没有。
                  确切的那个数留在 title 里，真要对齐某个值的人还找得到 */}
              约 {Math.max(1, Math.round((settings.autoScroll * 60) / (settings.size * settings.line)))} 行/分
            </span>
          </label>
        </>
      )}

    </>
  );
}
