import { useEffect, useState } from 'react';
import { rpc } from './rpc.ts';
// 哪匹书衣、题签多大字——判据连同它们的算式都在那儿，那边测得到（`cover-art.test.ts`）
import { 书衣色, 题签字号 } from './cover-art.ts';

interface Props {
  bookId: number;
  title: string;
  /** 封面换过之后加一，用来强制重取 */
  version?: number;
  /** 不传就铺满容器，按 1:1.4 的书封比例撑高——封面墙里用这个 */
  width?: number;
  /**
   * 这本书到底有没有封面（book.list 里的 has_cover）。
   * **明确是 false 时根本不发那次请求**——五千本书的封面墙上，
   * 每本问一次就是五千次 IPC，界面会直接卡死。
   */
  hasCover?: boolean;
}

/**
 * 书封。有图就显示图，没有就画一件**装帧**顶上（spec §3.1）。
 *
 * 占位图**不生成图片文件**：它的信息量只有一个书名，CSS 一个盒子就画完了，
 * 而生成真图片要么引图形库、要么手写渲染器，还得管什么时候失效。
 *
 * ⚠️ **题签上只写书名，不写作者。** 作者就印在卡片下面那行
 * （「沈砚 · 38 章 · 3 万字」），封面再说一遍是同一件事说两次
 * ——同封面墙「读完的书不印两次时间」那条。而书名留着是有判据的：
 * 没有真封面的书，**书名是唯一能认出它的东西**（`audit.mjs` 那条判据的原话）。
 */
export function Cover({ bookId, title, version = 0, width, hasCover }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (hasCover === false) { setUrl(null); return; }
    let alive = true;
    rpc<string | null>('cover.get', { bookId })
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setUrl(null));
    return () => { alive = false; };
  }, [bookId, version, hasCover]);

  // 不给宽度时用 aspect-ratio 让它跟着格子走，写死像素在响应式网格里会错位
  const box = width === undefined
    ? { width: '100%', aspectRatio: '1 / 1.4' }
    : { width, height: Math.round(width * 1.4) };

  if (url) {
    return (
      <img
        src={url}
        alt={title}
        style={{ ...box, objectFit: 'cover', borderRadius: 4, display: 'block' }}
      />
    );
  }

  /*
   * 版式全在 `shell.css` 的 `.cover-ph`，这里只留**必须算出来的那两个值**：
   * 哪匹布、题签多大字。原来整块是内联样式，二十来行样式对象里混着三条判据。
   *
   * ⚠️ `cover-ph` 这个类名**走查要用**：这块里的字是**书名**，也就是用户自己的
   * 数据，`audit.mjs` 的「最后一行只剩一个字」必须跳过它（书名折成
   * 「正在连载的」/「书」我们改不了，也不该改）。书架上的那份被 `.book-art`
   * 圈住了，但编辑弹窗顶上那个小预览不在里面——实测因此每个分辨率还剩 2 条报不掉的。
   *
   * **不挂 `title` 属性**：书名就写在封面正下方，重复一遍没有新信息，
   * 而且会盖住外层 `.book-art` 那个真正有用的 title（短评）。
   */
  return (
    <div className="cover-ph" style={{ ...box, background: 书衣色(title) }}>
      <span style={{ fontSize: `${题签字号([...title].length)}cqw` }}>{title}</span>
    </div>
  );
}
