import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { fileURLToPath } from 'node:url';

/** 只允许主窗口的入口文档调用特权 IPC；同源 iframe 也不能代调。 */
export function assertRenderer(event: IpcMainInvokeEvent, contents: WebContents, entry: string): void {
  if (event.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) {
    throw new Error('不接受此页面的调用');
  }
  const actual = new URL(event.senderFrame.url);
  const expected = new URL(entry);
  actual.hash = expected.hash = '';
  if (actual.href === expected.href) return;
  // Chromium 与 Node 对 Windows 短路径中的 ~ 编码不同。只对本地文件解码比较，
  // 查询参数仍须一致；fileURLToPath 会拒绝编码后的路径分隔符等非法文件 URL。
  if (actual.protocol === 'file:' && expected.protocol === 'file:' && actual.search === expected.search) {
    try { if (fileURLToPath(actual) === fileURLToPath(expected)) return; } catch { /* 拒绝非法路径 */ }
  }
  throw new Error('不接受此页面的调用');
}

/** 外部链接只交给系统浏览器，不给新页面预加载脚本。 */
export function externalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
