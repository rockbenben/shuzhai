// 重命名界面与执行端共用的预设和阈值，不加载磁盘操作。
/** 可撤销的批次数上限（spec §3.3：至少保留最近 20 批） */
export const UNDO_BATCHES = 20;

/** 超过这个数量要二次确认（spec §3.3） */
export const CONFIRM_THRESHOLD = 50;

export const PRESETS = [
  { label: '《书名》作者', template: '《{title}》{author}{ext}' },
  { label: '作者 - 书名', template: '{author} - {title}{ext}' },
  { label: '书名（状态）', template: '{title}（{status}）{ext}' },
  { label: '书名', template: '{title}{ext}' },
];
