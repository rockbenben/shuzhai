// 批量操作前那份「会动到哪几本」的预览列表。
//
// 两个批量弹窗（`BatchStatusDialog` 改阅读状态、`BatchTagDialog` 打标签）共用这一份。
// 原来各写一份，而**判据只写在其中一份上**，另一份的注释是
// 「同 `BatchStatusDialog`：条数由服务端的样本决定，这边不另立一个上限」——
// 那句「同某某」正是分叉前的形状（`NoteCard.tsx` 抽出来之前，查看器那份的注释
// 也写着「判据和 txt 一样」，而它已经不一样了）。

/**
 * ⚠️ **这边不另立「显示几条」的上限。**
 *
 * 回几本样本是**服务端**定的（`planStatusByFilter` / 打标签那条对应的
 * `sampleSize`）。界面再截一刀，「…以及另外 N 本」那个数就会和真正会动的本数对不上——
 * 而这两个弹窗的全部作用就是让人在按下去之前知道**会动多少本**。
 *
 * 所以 `sample` 有几条画几条，剩下的交给那一行「…以及另外 N 本」。
 */
export function BatchPlanList({ sample, total }: {
  sample: Array<{ bookId: number; title: string }> | undefined;
  total: number;
}) {
  const 列出的 = sample?.length ?? 0;
  return (
    <ol style={{ margin: '.5rem 0 0', paddingLeft: '1.4rem', fontSize: '.87rem', maxHeight: '12rem', overflowY: 'auto' }}>
      {sample?.map((b) => <li key={b.bookId}>{b.title}</li>)}
      {total > 列出的 && (
        <li className="muted">…以及另外 {total - 列出的} 本</li>
      )}
    </ol>
  );
}
