import { useState } from 'react';
import { rpc } from './rpc.ts';
// 类型从 core 引：这个仓库栽在「渲染进程手抄一份」上已经五次了
import type { ManualBook } from '../core/manual.ts';
import { StarRating } from './StarRating.tsx';

interface Props {
  /** 建好之后回调，带上新书的 id 和书名——外面负责搜出来让用户看见 */
  onAdded: (id: number, title: string) => void;
  onClose: () => void;
}

/**
 * 添一本「读过但本地没有文件」的书（个人评价体系的第二半）。
 *
 * 用户对这个应用的模型是两部分：**书评是主体，本地文件是可选的**。
 * 网上看的、纸质的、别的设备上读的，也该能留一条记录和一句评价。
 *
 * 星级和短评就放在这个对话框里——**添这本书的理由本来就是想给它写评价**，
 * 让人建完再去卡片上点一次「评价」是白白多一步。标签留到卡片上打，
 * 那一格需要「已用过的标签」列表，塞进来会让这个框变成第二个评价浮层。
 */
export function AddBookDialog({ onAdded, onClose }: Props) {
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [stars, setStars] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** 撞名时先停下来给人看提示，点「去看看这本」再走 onAdded */
  const [added, setAdded] = useState<{ id: number; title: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await rpc<ManualBook>('book.addManual', {
        title,
        author: author || null,
        rating: stars,
        comment: comment.trim() || null,
      });
      // 评价跟着一起发过去，由 core 决定怎么落——认领到已有的一本时
      // **那本书自己有的那一半不覆盖**（见 `core/manual.ts` 的 `applyReview`）。
      // 原来是这儿再发一句 `reading.setStatus`：旧评价会被直接盖掉，
      // 而用户以为自己在新建一本书，根本不知道盖掉了什么
      if (r.existed) {
        // **不能一边 setNote 一边 onAdded**：后者会立刻关掉对话框，这句提示
        // 一帧都留不住。撞名是要让人看见的——不然用户以为新建了一本，
        // 实际评价写到了另一条记录上
        /*
         * **作者要摆出来。** 不填作者时，同名只有一本我们会认领它
         * （见 `core/manual.ts`），而那本可能是另一个人写的——
         * 不说作者，用户不知道自己的评价落到了谁身上。
         */
        /*
         * **被挡下来的那一半要如实说。** 那本书原来就写着评价时，
         * 这次填的不会覆盖它——不说的话用户以为自己写进去了。
         */
        const kept = r.kept
          ? `　那本书原来就写着${r.kept.rating != null ? ` ★${r.kept.rating}` : ''}`
            + `${r.kept.comment ? `「${r.kept.comment}」` : ''}，没有被你这次填的覆盖——`
            + '要改的话去那本书里改。'
          : '';
        setNote(
          `库里已经有《${title.trim()}》${r.author ? `（${r.author}）` : ''}了，`
          + '你写的评价已经记在那本上。不是同一本的话，去那本书里把作者补上再添一次。'
          + kept,
        );
        setAdded({ id: r.id, title: title.trim() });
        return;
      }
      onAdded(r.id, title.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>添一本读过的书</h2>
        <p className="muted" style={{ margin: '0 0 .8rem', fontSize: '.85rem' }}>
          网上看的、纸质的、别的设备上读的——本地没有 txt 也能记一条。
          <br />
          以后要是把这本书的 txt 拷进书库，扫描时会<strong>自动认领这条记录</strong>，
          评价不会丢、也不会多出一本重复的。
        </p>

        <input
          autoFocus
          value={title}
          placeholder="书名（必填）"
          onChange={(e) => setTitle(e.target.value)}
          style={{ width: '100%', marginBottom: '.4rem' }}
        />
        <input
          value={author}
          placeholder="作者（选填。同名的书不止一本时，填了才分得清是哪本）"
          onChange={(e) => setAuthor(e.target.value)}
          style={{ width: '100%', marginBottom: '.6rem' }}
        />

        <div style={{ marginBottom: '.5rem' }}>
          <StarRating value={stars} onChange={setStars} />
        </div>

        <input
          value={comment}
          placeholder="一句话评价，比如「烂尾了别看」"
          onChange={(e) => setComment(e.target.value)}
          style={{ width: '100%' }}
        />

        {note && <p className="muted" style={{ marginBottom: 0 }}>{note}</p>}
        {error && <p className="danger" style={{ marginBottom: 0 }}>{error}</p>}

        <div className="row modal-actions" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>关闭</button>
          {added ? (
            <button className="primary" onClick={() => onAdded(added.id, added.title)}>
              去看看这本
            </button>
          ) : (
            <button className="primary" onClick={() => void submit()} disabled={busy || !title.trim()}>
              添加
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
