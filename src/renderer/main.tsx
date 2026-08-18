import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './shell.css';
import { App } from './App.tsx';
import { applySettings, loadSettings } from './settings.ts';

/**
 * **主题变量必须在第一次渲染之前写上去。**
 *
 * 放在 App 的 `useEffect` 里跑在首次 commit 之后：先用 CSS 里的裸默认值把
 * 整屏排一遍版，再改 `:root` 上的自定义属性——那会让**整篇文档**的样式失效，
 * 侧栏、顶栏、上百张卡片全部重算重排一遍，白付一整轮；而且它想修的那一帧
 * 闪白根本没修掉，只是挪到了 commit 之后。
 *
 * 写在这里，React 第一次排版拿到的就是最终颜色。
 */
applySettings(loadSettings());

/**
 * 选了「跟随系统」之后，**系统半夜自己切过去时也要跟上**。
 *
 * 只在启动时读一次的话，Windows 的深色模式排程一到点，应用还停在白天——
 * 而用户选这一档的意思正是「不用我管」。重读一次 localStorage 就够了，
 * 不是 auto 的时候 `wantsDark` 会照旧给出固定答案，这个回调等于空转。
 */
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  applySettings(loadSettings());
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
