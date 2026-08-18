// 朗读的播放机（spec §6）。
//
// 原来的实现是一行 `synth.speak(chapter.text.slice(0, 4000))`：
// **一章只念开头**，念完就停，而且看起来像正常念完了——用户根本不知道被截了。
// 现在按句切段（`core/tts.ts` 的 `splitForTts`）排成队列逐段念，
// 念完一章接着念下一章。
//
// 两种引擎共用同一个队列：
//   - `system`：Chromium 自带的 `speechSynthesis`，离线、不外发。**默认**。
//   - 在线引擎：主进程取回 data URL，用 `<audio>` 放。音色多，但**会把正文发给第三方**。
//
// **在线引擎失败要退回系统语音**，不能让朗读直接哑掉——那些是陌生人的服务器，
// 实测 281 条配置里九成的域名已经死了，活着的随时也会死。

import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from './rpc.ts';
import { splitForTts, type TtsChunk } from '../core/tts.ts';
import type { ReadSettings } from './settings.ts';

export interface TtsState {
  speaking: boolean;
  /**
   * **停下来了，但队列还在。**
   *
   * 原来只有 `speak` 和 `stop` 两个动作，而 `stop` 会把队列清空、`idx` 归零——
   * 于是「停一下再接着听」这件事**做不到**：再点一次是 `speak(整章)`，
   * 从这一章开头重念。听到第 40 段接个电话，回来就得再听 39 段。
   * 暂停不动队列，所以「继续」是从**这一段**接着念。
   */
  paused: boolean;
  /**
   * 正在念的那一段：在整章里的字符区间（跟读高亮要它）**外加那一段的原文**。
   *
   * ⚠️ **`text` 不是冗余的。** 界面原来是拿 `正文.slice(at.from, at.to)` 显示
   * 「正在念的那一句」——**用队列的坐标去切另一份正文**。换章之后那两份就不是
   * 同一篇了，于是屏幕上那句话**既不是正在念的，也不是随便哪一句**，
   * 而是新正文里恰好落在旧区间上的一段。当场量到过：念着第 44 章，
   * 屏幕已经翻到第 43 章，那一行显示的是第 43 章里的字。
   * 让它自己带着原文，这类「显示的和念的不是一回事」就没有入口了。
   */
  at: { from: number; to: number; text: string } | null;
  /** 念到第几段 / 一共几段。界面上那条声线和「第 12/58 段」都靠它 */
  seg: { i: number; n: number } | null;
  /** 在线引擎挂了之后退回了系统语音，界面上说一声 */
  fellBack: string | null;
}

export function useTts(settings: ReadSettings, onChapterEnd?: () => boolean) {
  const [state, setState] = useState<TtsState>(
    { speaking: false, paused: false, at: null, seg: null, fellBack: null },
  );

  const queue = useRef<TtsChunk[]>([]);
  const idx = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  // 每次「停止」都会 +1，异步回调靠它判断自己是不是已经过期了。
  // 没有这个的话：点停止 → 上一段的 fetch 才返回 → 又开始念，怎么都停不下来
  const run = useRef(0);
  const cfg = useRef(settings);
  cfg.current = settings;

  const stop = useCallback(() => {
    run.current++;
    window.speechSynthesis?.cancel();
    if (audio.current) { audio.current.pause(); audio.current = null; }
    queue.current = [];
    idx.current = 0;
    setState({ speaking: false, paused: false, at: null, seg: null, fellBack: null });
  }, []);

  /** 掐掉正在响的那一下，**队列不动**。暂停和跳段都要先做这件事 */
  const 掐声 = useCallback(() => {
    run.current++;
    window.speechSynthesis?.cancel();
    if (audio.current) { audio.current.pause(); audio.current = null; }
  }, []);

  // 离开阅读器、或者组件卸载时必须停——不然退回书架它还在念
  useEffect(() => stop, [stop]);

  const speakOne = useCallback(
    async (my: number): Promise<void> => {
      const chunk = queue.current[idx.current];
      if (!chunk) {
        // 这一章念完了。要不要接着念下一章由调用方决定（它才知道有没有下一章）
        if (cfg.current.ttsContinuous && onChapterEnd?.()) return;
        if (run.current === my) setState((s) => ({ ...s, speaking: false, paused: false, at: null, seg: null }));
        return;
      }
      if (run.current !== my) return;
      setState((s) => ({
        ...s,
        at: { from: chunk.at, to: chunk.at + chunk.text.length, text: chunk.text },
        seg: { i: idx.current, n: queue.current.length },
      }));

      const next = () => {
        if (run.current !== my) return;
        idx.current++;
        void speakOne(my);
      };

      if (cfg.current.ttsEngine !== 'system') {
        try {
          const { dataUrl } = await rpc<{ dataUrl: string }>('tts.fetch', {
            engineId: cfg.current.ttsEngine,
            text: chunk.text,
          });
          if (run.current !== my) return;
          const el = new Audio(dataUrl);
          el.volume = cfg.current.ttsVolume;
          el.playbackRate = cfg.current.ttsRate;
          el.onended = next;
          el.onerror = next; // 单段放不出来就跳过，别卡住整章
          audio.current = el;
          await el.play();
          return;
        } catch (e) {
          // 在线引擎挂了 → 退回系统语音，并且**把这一段也念掉**，不是从头再来
          if (run.current !== my) return;
          setState((s) => ({ ...s, fellBack: (e as Error).message }));
        }
      }

      const synth = window.speechSynthesis;
      if (!synth) { next(); return; }
      const u = new SpeechSynthesisUtterance(chunk.text);
      u.lang = 'zh-CN';
      u.rate = cfg.current.ttsRate;
      u.pitch = cfg.current.ttsPitch;
      u.volume = cfg.current.ttsVolume;
      const voice = synth.getVoices().find((v) => v.voiceURI === cfg.current.ttsVoice);
      if (voice) u.voice = voice;
      u.onend = next;
      u.onerror = next;
      synth.speak(u);
    },
    [onChapterEnd],
  );

  /** 从头念一段文字（一整章）。`from` 是起始字符位置，用来「从这里接着念」 */
  const speak = useCallback(
    (text: string, from = 0) => {
      run.current++;
      const my = run.current;
      window.speechSynthesis?.cancel();
      if (audio.current) { audio.current.pause(); audio.current = null; }
      queue.current = splitForTts(text);
      idx.current = Math.max(0, queue.current.findIndex((c) => c.at + c.text.length > from));
      if (idx.current < 0) idx.current = 0;
      setState({ speaking: true, paused: false, at: null, seg: null, fellBack: null });
      void speakOne(my);
    },
    [speakOne],
  );

  /** 从**当前这一段**接着念（暂停之后回来、或者跳过一段之后） */
  const 接着念 = useCallback(() => {
    if (!queue.current.length) return;
    掐声();
    const my = run.current;
    setState((s) => ({ ...s, speaking: true, paused: false }));
    void speakOne(my);
  }, [掐声, speakOne]);

  /**
   * 暂停。**队列和 `idx` 一个都不动**，`at` 也留着——
   * 界面那条声线因此停在原处，而不是归零。
   */
  const pause = useCallback(() => {
    if (!queue.current.length) return;
    掐声();
    setState((s) => ({ ...s, speaking: false, paused: true }));
  }, [掐声]);

  /**
   * 往前/往后跳一段。**夹在队列范围里**，跳到头就停在头一段——
   * 越界之后 `speakOne` 拿到 undefined 会当成「这一章念完了」，
   * 于是「按上一段按到头」会变成「跳到下一章」，那是最没道理的一种反应。
   */
  const skip = useCallback((d: number) => {
    if (!queue.current.length) return;
    idx.current = Math.max(0, Math.min(queue.current.length - 1, idx.current + d));
    接着念();
  }, [接着念]);

  return { ...state, speak, stop, pause, resume: 接着念, skip };
}
