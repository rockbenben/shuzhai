import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { assertRenderer, externalUrl } from './renderer-policy.ts';

test('IPC 拒绝其他窗口、子框架和导航后的远程页面', () => {
  const entry = 'file:///C:/app/dist/index.html';
  const frame = { url: `${entry}#shelf` };
  const contents = { mainFrame: frame } as unknown as WebContents;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  assert.doesNotThrow(() => assertRenderer(event, contents, entry));
  for (const change of [{ sender: {} }, { senderFrame: null }, { senderFrame: { url: entry } }]) {
    assert.throws(() => assertRenderer({ ...event, ...change } as IpcMainInvokeEvent, contents, entry));
  }
  for (const url of ['https://example.com/', 'file:///C:/other.html', `${entry}?other=1`]) {
    frame.url = url;
    assert.throws(() => assertRenderer(event, contents, entry));
  }
  frame.url = 'http://localhost:5173/';
  assert.doesNotThrow(() => assertRenderer(event, contents, frame.url));
});

test('系统浏览器只接受无凭据的 HTTP(S) 链接', () => {
  assert.equal(externalUrl('https://example.com/books'), 'https://example.com/books');
  assert.equal(externalUrl('http://example.com/'), 'http://example.com/');
  for (const url of [undefined, {}, 'bad', 'file:///C:/x', 'javascript:alert(1)', 'mailto:a@b.c', 'https://user:pass@example.com/']) {
    assert.equal(externalUrl(url), null);
  }
});
