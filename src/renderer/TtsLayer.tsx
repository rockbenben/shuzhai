import { useEffect, useRef, useState } from 'react';
import { ICO } from './icons.tsx';
import { TtsPanel } from './TtsPanel.tsx';
import type { ReadSettings } from './settings.ts';
import type { TtsState } from './useTts.ts';

type Tts = TtsState & {
  speak: (text: string, from?: number) => void;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  skip: (d: number) => void;
};

/**
 * 定时关闭的那点状态。
 *
 * **单独抽成 hook，不塞进 `TtsLayer`**：`睡到 === 'chapter'`（这一章念完就停）
 * 要在**一章念完的那一刻**被问到，而那个判断在两个阅读界面里各不相同
 * （txt 是「有没有下一章」，查看器是「有没有下一节 / 下一页」）。
 * 于是状态在父组件、界面在 `TtsLayer`，中间靠 `睡到Ref` 传话——
 * 用 ref 是因为那个回调挂在 `useTts` 里，拿到的会是建立那一刻的闭包值。
 */
export function useSleepTimer() {
  const [睡到, set睡到] = useState<number | 'chapter' | null>(null);
  const [定时分钟, set定时分钟] = useState<number | null>(null);
  const [自定义, set自定义] = useState('20');
  /**
   * 「还有几分钟」要自己走一下才更新。**半分钟一跳就够**——
   * 这一行的用处是「大概还剩多久」，不是秒表；跳太勤白白重渲染整个阅读器。
   */
  const [现在, set现在] = useState(() => Date.now());
  const 睡到Ref = useRef(睡到);
  睡到Ref.current = 睡到;

  useEffect(() => {
    if (typeof 睡到 !== 'number') return;
    const t = setInterval(() => set现在(Date.now()), 30_000);
    set现在(Date.now());
    return () => clearInterval(t);
  }, [睡到]);

  return { 睡到, set睡到, 定时分钟, set定时分钟, 自定义, set自定义, 现在, 睡到Ref };
}

export type SleepTimer = ReturnType<typeof useSleepTimer>;

/**
 * 「朗读」那一整层：**播放器 + 声音/节奏设置 + 定时**。
 *
 * ── 为什么抽出来 ─────────────────────────────────────
 *
 * 用户的原话：「阅读界面上很多按钮怎么都没在非 txt 文件上出现，比如朗读」。
 * 而 EPUB 的正文**就在那个 iframe 里**——当场量的，一节 6981 个字。
 * 也就是说朗读对 EPUB 从来不是做不了，是没做。
 *
 * 那就只有两条路：在查看器里抄一份，或者收成一份两边共用。
 * 这个仓库被「抄第二份」咬过三次，所以是后者。
 *
 * 两边的差别只有一样：**念的是什么**。txt 给的是整章正文，
 * 查看器给的是当前这一节（EPUB）或这一页（PDF）的文字。
 * 所以这里收一个 `正文` 就够了，别的一个字都不用分叉。
 */
export function TtsLayer(
  { tts, settings, set, 正文, onManage, 计时 }: {
    tts: Tts;
    settings: ReadSettings;
    set: <K extends keyof ReadSettings>(k: K, v: ReadSettings[K]) => void;
    /** 现在这一屏的正文。空串＝这一页没有可念的文字（扫描版 PDF） */
    正文: string;
    /** 点「管理引擎…」 */
    onManage: () => void;
    计时: SleepTimer;
  },
) {
  const { 睡到, set睡到, 定时分钟, set定时分钟, 自定义, set自定义, 现在 } = 计时;

  /** 这一章念到哪儿了（0–100）。`tts.at.from` 是当前这一段在整章里的字符位置 */
  const 声线百分比 = tts.at && 正文.length > 0
    ? Math.min(100, Math.round((tts.at.from / 正文.length) * 100))
    : 0;
  /**
   * 正在念的那一句，截一下——这一行只是个提示，不是正文。
   *
   * ⚠️ **取的是 `at.text`（那一段自己带的原文），不是 `正文.slice(from, to)`。**
   * 整段理由在 `useTts.ts` 的 `at` 上面：拿队列的坐标去切另一份正文，
   * 换章之后显示的就是**不相干的一句**。
   */
  const 正在念的那一句 = (tts.at?.text ?? '').trim().slice(0, 40);

  return (
    <>
      {/*
        * **这一层最上面是个播放器，不是一个开关。**
        *
        * 原来这儿只有一个键：不念的时候写「从这一章开始念」，念着的时候翻成
        * 「停止朗读」。于是念起来之后**唯一能做的事就是停**——而且 `stop` 会把队列
        * 清掉、`idx` 归零，再点一次是从头重念。听到第 40 段接个电话，回来得再听 39 段。
        *
        * 现在：**暂停不动队列**（「继续」从这一段接着念）、上一段/下一段能跳、
        * 底下那条**声线**说这一章念到哪儿了——它是这个面板里唯一有时间维度的东西。
        */}
      {正文.trim() === '' ? (
        /* **这一页没有可念的字。** 扫描版 PDF 就是这样——一张图，没有文字层。
           说清楚比摆一个点了没反应的键强（本仓库那条老规矩） */
        <p className="muted" style={{ fontSize: '.8rem', margin: 0 }}>
          这一页没有可念的文字。扫出来的 PDF 是一张图，取不到字。
        </p>
      ) : !tts.speaking && !tts.paused ? (
        <button className="primary" style={{ width: '100%' }} onClick={() => tts.speak(正文)}>
          从这里开始念
        </button>
      ) : (
        <div className="voice">
          {/* ⚠️ **没有「停」这个键。** 有了暂停之后它就是第二个开关，
              而且两个名字只差一个字（「停」和「暂停」），谁也说不清区别。
              暂停就是没声音；退出阅读界面时 `useTts` 自己会停（卸载那条 effect）。 */}
          <div className="voice-keys">
            <button aria-label="上一段" title="上一段" onClick={() => tts.skip(-1)}>{ICO.prev}</button>
            <button
              className="primary"
              aria-label={tts.speaking ? '暂停' : '继续念'}
              title={tts.speaking ? '暂停。队列留着，继续时从这一段接着念' : '从这一段接着念'}
              onClick={() => (tts.speaking ? tts.pause() : tts.resume())}
            >
              {tts.speaking ? '暂停' : '继续'}
            </button>
            <button aria-label="下一段" title="下一段" onClick={() => tts.skip(1)}>{ICO.next}</button>
          </div>
          {/* **声线**：整章是这条线，念过的部分填上。
              数字是真的——`tts.at.from` 是这一段在整章里的字符位置 */}
          <div
            className="voice-line"
            role="progressbar"
            aria-label="这一章念到哪儿了"
            aria-valuenow={声线百分比}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{ ['--voice' as string]: 声线百分比 + '%' }}
          />
          <div className="voice-say">
            <span className="voice-at">
              {tts.seg ? '第 ' + (tts.seg.i + 1) + ' / ' + tts.seg.n + ' 段' : '准备中'}
            </span>
            <span className="voice-text">{正在念的那一句}</span>
          </div>
        </div>
      )}

      {/* **开它之前先把这边停掉**：那个组件自己带一份 useTts，
          两份同时念就是两个声音叠在一起 */}
      <TtsPanel read={settings} set={set} tts={tts} onManage={() => { tts.stop(); onManage(); }} />

      {/* 定时。**一排快捷键 + 自定义分钟**，而不是一个下拉——躺着按的时候一下就
          点中最常用的那档；而「还剩多久」必须单独一行摆出来：塞进下拉的当前项，
          不展开就看不见。存的是**到点的时刻**不是「还剩几分钟」，
          所以浮层关掉再打开还算得准 */}
      <h4 className="panel-group">定时</h4>
      <div className="tts-timer">
        <button aria-current={睡到 === null} onClick={() => set睡到(null)}>不定时</button>
        {[15, 30, 45, 60, 90].map((m) => (
          <button
            key={m}
            aria-current={typeof 睡到 === 'number' && 定时分钟 === m}
            onClick={() => { set定时分钟(m); set睡到(Date.now() + m * 60_000); }}
          >
            {m}
          </button>
        ))}
        <button aria-current={睡到 === 'chapter'} onClick={() => set睡到('chapter')}>
          这一章念完
        </button>
      </div>
      <label className="row" style={{ gap: '.35rem', fontSize: '.8rem', marginTop: '.3rem' }}>
        <span className="muted">自定义</span>
        <input
          type="number"
          min={1}
          max={600}
          value={自定义}
          onChange={(e) => set自定义(e.target.value)}
          style={{ width: '4rem' }}
        />
        <span className="muted">分</span>
        <button
          className="mini"
          disabled={!(Number(自定义) >= 1)}
          onClick={() => {
            const m = Math.min(600, Math.round(Number(自定义)));
            set定时分钟(m);
            set睡到(Date.now() + m * 60_000);
          }}
        >
          开始计时
        </button>
      </label>
      {睡到 !== null && (
        <div className="row" style={{ justifyContent: 'space-between', marginTop: '.3rem' }}>
          <span className="muted" style={{ fontSize: '.78rem' }}>
            {睡到 === 'chapter'
              ? '这一章念完就停'
              : Math.max(1, Math.round((睡到 - 现在) / 60_000)) + ' 分钟后停'}
          </span>
          <button className="mini" onClick={() => set睡到(null)}>取消</button>
        </div>
      )}
    </>
  );
}
