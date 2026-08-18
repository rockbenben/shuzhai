// 朗读引擎：导入、手填、试听、删除，一个模块管到底。
//
// 原来这三件事散在设置那一页里，而且列表是**一排 chip、点名字就删**——
// 用户的库里有 88 个引擎，铺出来是一整片，找不着也不敢点。他的原话是
// 「太难看，而且不符合常理」。
//
// 重做的三条：
//
// 1. **列表就是列表**：一行一个，名字、GET/POST、试听、删除各在各的位置。
//    删除是写着「删」的那个键，不是「点名字」。
// 2. **当场能试听。** 加一个引擎最想知道的就是「它出不出声」，
//    而原来得先关掉设置、开一本书、进阅读器的浮层才试得了。
// 3. **试听走阅读器自己的 `useTts`**，不另写一条播放路径——本仓库那条
//    「试听必须和真念走同一条路，否则会出现『试听好使、真念的时候不出声』」。
//    试哪一个就把 `ttsEngine` 换成哪一个喂给它，别的一个字不动。

import { useEffect, useState } from 'react';
import { rpc } from './rpc.ts';
import { useTts } from './useTts.ts';
import type { ReadSettings } from './settings.ts';
import type { TtsEngine } from '../core/builtin-tts.ts';

/** 试听句子。**刻意带标点**——光念「测试」两个字，听不出这些引擎在语调和停顿上的区别 */
const 试听句子 = '他抬头看了看天，说：这雪，怕是要下上一夜。';

/** 超过这个数才给搜索框。少的时候摆一个空搜索框是噪声 */
const 要搜索的门槛 = 8;

/**
 * 「有几格没搬过来」那句话。导入和手填共用——两处各写一遍必然分叉，
 * 而这句话本身就是在说「别以为是应用的语速滑块坏了」。
 */
function 丢了什么(dropped: string[] | undefined): string {
  if (!dropped?.length) return '';
  // 一个的时候写「这几格」读着别扭
  const 量词 = dropped.length === 1 ? '这一格' : '这几格';
  const 那些 = dropped.length === 1 ? '那一项' : '那几项';
  return `。${dropped.join('、')} ${量词}没搬（写的是要算的 JS），${那些}用服务自己的默认值`;
}

export function TtsEngines({
  read,
  applyRead,
}: {
  read: ReadSettings;
  applyRead: (patch: Partial<ReadSettings>) => void;
}) {
  const [engines, setEngines] = useState<TtsEngine[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [坏消息, set坏消息] = useState(false);
  const [搜, set搜] = useState('');
  // 手填那一格。**这是「还没提交的新建表单」**，关掉丢掉是对的
  const [draft, setDraft] = useState<{ name: string; url: string } | null>(null);
  /** 正在试听哪一个。喂给 useTts 的就是「把 ttsEngine 换成它」的那份设置 */
  const [试的, set试的] = useState<string | null>(null);

  const tts = useTts({ ...read, ttsEngine: 试的 ?? read.ttsEngine });

  useEffect(() => {
    void rpc<TtsEngine[]>('tts.engines').then(setEngines).catch(() => setEngines([]));
  }, []);

  const 说 = (话: string, 坏 = false) => { setMsg(话); set坏消息(坏); };
  const 重取 = async () => setEngines(await rpc<TtsEngine[]>('tts.engines'));

  const 试听 = (id: string) => {
    if (tts.speaking) { tts.stop(); set试的(null); return; }
    set试的(id);
    // 换引擎和开念在同一轮里发生，而 useTts 那头读的是这一次渲染时的设置，
    // 所以让出一帧再念——不让的话念的是上一个引擎
    setTimeout(() => tts.speak(试听句子), 0);
  };

  const 列出来的 = 搜.trim()
    ? engines.filter((e) => e.name.toLowerCase().includes(搜.trim().toLowerCase()))
    : engines;

  return (
    <>
      <div className="row" style={{ marginBottom: '.5rem', flexWrap: 'wrap' }}>
        <button
          onClick={() => void (async () => {
            const path = await rpc<string | null>('ui.pickTtsFile');
            if (!path) return;
            try {
              const r = await rpc<{ added: number; existed: number; skipped: number; dropped: string[] }>(
                'tts.importFile', { path },
              );
              await 重取();
              const 话 = [`导进来 ${r.added} 个`];
              if (r.existed) 话.push(`${r.existed} 个本来就有`);
              if (r.skipped) 话.push(`${r.skipped} 个没收——它们要跑配置里的 JS，而这个应用不跑`);
              说(话.join('，') + 丢了什么(r.dropped));
            } catch (e) {
              说((e as Error).message, true);
            }
          })()}
        >
          导入一份…
        </button>
        <button onClick={() => { setDraft(draft ? null : { name: '', url: '' }); setMsg(null); }}>
          {draft ? '收起' : '手填一个…'}
        </button>
        {engines.length > 要搜索的门槛 && (
          <input
            placeholder={`在 ${engines.length} 个里找`}
            value={搜}
            onChange={(e) => set搜(e.target.value)}
            style={{ flex: '1 1 8rem', minWidth: 0 }}
          />
        )}
      </div>

      {draft && (
        <div className="tts-form">
          <label className="field">
            <span className="muted" style={{ fontSize: '.78rem' }}>名字</span>
            <input
              placeholder="朗读设置的下拉里显示的就是它"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="field" style={{ marginTop: '.4rem' }}>
            <span className="muted" style={{ fontSize: '.78rem' }}>地址</span>
            <input
              placeholder="「阅读」里那一行整行贴进来也行"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
          </label>
          <p className="muted" style={{ fontSize: '.75rem', margin: '.4rem 0 .5rem' }}>
            要念的那一段写成 <code>{'{text}'}</code>。「阅读」的配置写的是
            {' '}<code>{'{{java.encodeURI(speakText)}}'}</code>，整行贴进来会自动认出来，
            走 POST 的那种也认。
          </p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button onClick={() => { setDraft(null); setMsg(null); }}>取消</button>
            <button
              className="primary"
              onClick={() => void (async () => {
                try {
                  const r = await rpc<{ id: string; name: string; dropped: string[] }>('tts.addEngine', draft);
                  await 重取();
                  setDraft(null);
                  说(`「${r.name}」加好了${丢了什么(r.dropped)}。点它那一行的「试听」听一句`);
                } catch (e) {
                  说((e as Error).message, true);
                }
              })()}
            >
              加进来
            </button>
          </div>
        </div>
      )}

      {/* 列表。一行一个，删除是写着「删」的那个键——原来是一排 chip、
          点名字就删，88 个铺出来既找不着也不敢点 */}
      {engines.length > 0 && (
        <div className="tts-list">
          {列出来的.map((e) => (
            <div className="tts-row" key={e.id}>
              <span className="tts-name" title={e.body ? `${e.url}\n${e.body}` : e.url}>
                {e.name}
              </span>
              {e.method === 'POST' && (
                <span className="chip-n" title="这条走 POST，正文在请求体里">POST</span>
              )}
              <button className="mini" onClick={() => 试听(e.id)}>
                {tts.speaking && 试的 === e.id ? '停' : '试听'}
              </button>
              <button
                className="mini"
                onClick={() => void (async () => {
                  await rpc('tts.removeEngine', { id: e.id });
                  await 重取();
                  // 正在用的那个被删了就退回系统语音，同卸字体那一处：
                  // 不退的话下次点朗读只会撞一句「没有这个朗读引擎」
                  if (read.ttsEngine === e.id) applyRead({ ttsEngine: 'system' });
                  说(`「${e.name}」删掉了`);
                })()}
              >
                删
              </button>
            </div>
          ))}
          {列出来的.length === 0 && (
            <p className="muted" style={{ fontSize: '.8rem', margin: '.4rem' }}>
              没有名字带「{搜}」的引擎
            </p>
          )}
        </div>
      )}

      <p className="muted" style={{ fontSize: '.78rem', margin: '.5rem 0 .6rem' }}>
        默认只有<strong>系统语音</strong>，离线、不外发一个字。
        在线引擎<strong>会把正文一段一段发到第三方服务器</strong>，所以要自己加。
        <br />
        加进来的<strong>只存在这台机器上</strong>，跟着备份走，不进代码仓库。
      </p>
      {tts.fellBack && (
        <p className="muted" style={{ fontSize: '.8rem', margin: '0 0 .5rem' }}>
          这个引擎没出声，已经退回系统语音：{tts.fellBack}
        </p>
      )}
      {msg && (
        <p className={坏消息 ? 'danger' : 'muted'} style={{ fontSize: '.8rem', margin: '0 0 .5rem' }}>
          {msg}
        </p>
      )}
    </>
  );
}
