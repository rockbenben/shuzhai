import { useEffect, useState } from 'react';
import { rpc } from './rpc.ts';
import type { ReadSettings } from './settings.ts';
import type { TtsState } from './useTts.ts';
import type { TtsEngine } from '../core/builtin-tts.ts';

/**
 * 朗读设置。**摆在阅读器里，不在设置弹窗里。**
 *
 * 判据是这个仓库早就写下的那条：**调完要立刻看到结果的设置，摆在能看到结果的
 * 那个界面里**（纸色和调色当初就是这么从「设置 → 阅读」搬进阅读器的）。
 * 挑朗读引擎更是如此——八十多个音色，光看名字（「灵动女声」「木兰 河南」）
 * 根本选不出来，得一边听一边换。而设置弹窗是从**书架**打开的：
 * 换一个引擎、关掉弹窗、点开书、按朗读、听两句、再退回去换下一个。
 *
 * ⚠️ **试听直接用阅读器自己的 `useTts`**，不另写一条播放路径。
 * 设置里那份原来是四十行的复制品，而本文件那条「试听必须走正式朗读那条路」
 * 说的就是它——两条路一分家，就会出现「试听好使、真念的时候不出声」
 * 这种最难查的情况。现在试听和正式朗读是同一段代码，想分家都难。
 */
export function TtsPanel(
  { read, set, tts, onManage }:
  {
    read: ReadSettings;
    set: <K extends keyof ReadSettings>(k: K, v: ReadSettings[K]) => void;
    tts: TtsState & { speak: (text: string) => void; stop: () => void };
    /** 点「管理引擎…」。放这儿而不是塞进设置里：换引擎是一边听一边换的事 */
    onManage: () => void;
  },
) {
  /**
   * **这一次的声音是不是「试听」放出来的。**
   *
   * 试听和正文朗读共用同一个 `useTts`（那是有意的：两条播放路径一分家就会出现
   * 「试听好使、真念的时候不出声」）。代价是这个键原来只看 `tts.speaking`——
   * **整章念起来的时候，试听键会翻成「停」**，而按下去停掉的是那一整章。
   * 一个写着「试听一句」的位置，长出一个会停掉朗读的键。
   *
   * 记一笔谁开的口，这个键就只管自己那一摊。
   */
  const [试听中, set试听中] = useState(false);
  useEffect(() => { if (!tts.speaking) set试听中(false); }, [tts.speaking]);

  const [engines, setEngines] = useState<TtsEngine[]>([]);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    void rpc<TtsEngine[]>('tts.engines')
      .then((list) => {
        setEngines(list);
        /*
         * **存着的那个 id 可能已经不在了**：在设置里删掉了、或者从一份没有它的
         * 备份恢复过来。不管的话这个下拉是**一片空白**——看起来像它坏了，
         * 而点朗读只会撞一句「没有这个朗读引擎」。
         *
         * 判据同「删掉一个正在生效的标签」那条：**界面显示不出正在生效的状态，
         * 就别让那个状态继续生效。**
         */
        if (read.ttsEngine !== 'system' && !list.some((e) => e.id === read.ttsEngine)) {
          set('ttsEngine', 'system');
        }
      })
      .catch(() => setEngines([]));
    // 只在挂载时问一次：引擎是在设置里管的，改完那边会自己重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    /*
     * 语音列表是异步填的：**第一次 `getVoices()` 往往返回空数组**，得等
     * `voiceschanged`。不等的话音色下拉永远是空的，看起来像系统里没装中文语音。
     */
    const load = () => setVoices(window.speechSynthesis?.getVoices() ?? []);
    load();
    window.speechSynthesis?.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load);
  }, []);

  const slider = (
    label: string,
    key: 'ttsRate' | 'ttsPitch' | 'ttsVolume',
    opts: { min: number; max: number; step: number; fmt: (v: number) => string },
  ) => (
    <label className="row" style={{ justifyContent: 'space-between', gap: '.4rem' }}>
      <span className="muted" style={{ fontSize: '.8rem', minWidth: '2.4rem' }}>{label}</span>
      <input
        type="range"
        min={opts.min}
        max={opts.max}
        step={opts.step}
        value={read[key]}
        onChange={(e) => set(key, Number(e.target.value))}
        style={{ flex: 1, minWidth: 0, accentColor: 'var(--accent)' }}
      />
      <span className="muted" style={{ fontSize: '.78rem', minWidth: '2.6rem', textAlign: 'right' }}>
        {opts.fmt(read[key])}
      </span>
    </label>
  );

  return (
    <>
      {/* 分成「声音」和「节奏」两组。**十来行控件平铺下来分不出主次**——
          换引擎/音色是一件事（换完要试听），调语速音量是另一件 */}
      <h4 className="panel-group">声音</h4>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted" style={{ fontSize: '.8rem' }}>引擎</span>
        <select
          value={read.ttsEngine}
          onChange={(e) => set('ttsEngine', e.target.value)}
          style={{ maxWidth: '9.5rem' }}
        >
          <option value="system">系统语音（离线）</option>
          {engines.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>

      {/* **一个在线引擎都没有是默认状态，不是出错。**（应用不预置任何在线引擎，
          理由见 `builtin-tts.ts` 顶上。）空着不说话的话，用户会以为这个下拉坏了；
          说了就得说清去哪儿加——同本仓库那条「功能名要出现在通往它的那句话里」 */}
      {engines.length === 0 && (
        <p className="muted" style={{ fontSize: '.75rem', margin: '.1rem 0' }}>
          只有系统语音。想用在线的去<strong>设置 · 阅读 · 朗读引擎</strong>导一份、或者手填一个。
        </p>
      )}

      {read.ttsEngine === 'system' && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="muted" style={{ fontSize: '.8rem' }}>音色</span>
          <select
            value={read.ttsVoice}
            onChange={(e) => set('ttsVoice', e.target.value)}
            style={{ maxWidth: '9.5rem' }}
          >
            <option value="">自动挑中文</option>
            {voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>)}
          </select>
        </div>
      )}

      {/* **在线引擎会把正文发出去，这句话不能省**（本文件那条：会造成数据事故
          或者把正文外发的说明，必须留全文） */}
      {read.ttsEngine !== 'system' && (
        <p className="muted" style={{ fontSize: '.75rem', margin: '.1rem 0' }}>
          在线引擎<strong>会把正文一段一段发到第三方服务器</strong>；服务挂掉时自动退回系统语音。
        </p>
      )}
      {read.ttsEngine === 'system' && voices.length === 0 && (
        <p className="muted" style={{ fontSize: '.75rem', margin: '.1rem 0' }}>
          系统里没装中文语音。Windows 设置 → 时间和语言 → 语音 里可以加。
        </p>
      )}

      <div className="row" style={{ gap: '.4rem', flexWrap: 'wrap' }}>
        <button
          disabled={tts.speaking && !试听中}
          title={
            tts.speaking && !试听中
              ? '正在念这一章。要试听先在上面按「暂停」'
              : '念一句带标点的话——听得出这个引擎的语调和停顿'
          }
          onClick={() => {
            if (试听中) { tts.stop(); set试听中(false); return; }
            set试听中(true);
            tts.speak(试听句子);
          }}
        >
          {试听中 ? '停下试听' : '试听一句'}
        </button>
        <button className="mini" onClick={onManage} style={{ marginLeft: 'auto' }}>管理引擎…</button>
      </div>

      <h4 className="panel-group">节奏</h4>
      {slider('语速', 'ttsRate', { min: 0.5, max: 2, step: 0.1, fmt: (v) => `${v.toFixed(1)}×` })}
      {slider('音量', 'ttsVolume', { min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` })}
      {/* **音调只有系统语音有。** 在线引擎走的是 `new Audio()`，
          那上面只有 volume 和 playbackRate，没有 pitch——摆出来就是个调了不动的控件 */}
      {read.ttsEngine === 'system'
        && slider('音调', 'ttsPitch', { min: 0, max: 2, step: 0.1, fmt: (v) => v.toFixed(1) })}
      <label className="row" style={{ gap: '.3rem', fontSize: '.8rem' }}>
        <input
          type="checkbox"
          checked={read.ttsContinuous}
          onChange={(e) => set('ttsContinuous', e.target.checked)}
        />
        <span>一章念完接着念下一章</span>
      </label>
      {tts.fellBack && (
        <p className="muted" style={{ fontSize: '.75rem', margin: '.1rem 0' }}>
          这个引擎没出声，已经退回系统语音：{tts.fellBack}
        </p>
      )}
    </>
  );
}

/** 试听句子。**刻意带标点**——光念「测试」两个字，听不出这些引擎在语调和停顿上的区别 */
const 试听句子 = '他抬头看了看天，说：这雪，怕是要下上一夜。';
