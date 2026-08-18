// 内置纸色，一共 10 张，随应用一起发布：
//
//   - `day` / `night` / `eye` / `paper` —— 原来只活在 CSS 的 `:root[data-theme=…]` 里，
//     阅读纸色和应用外观拆开之后颜色必须由 JS 拿到，所以搬成了数据。
//   - `shuzhai-*` / `houmo-*` / `wx-*` —— 从「阅读 / 厚墨」和用户那份 legado web
//     配置转过来的 6 个配色。
//
// 和净化规则一样，转换（ARGB → hex、按亮度推前景色）在**发布前**跑完了，
// 存的是结果。运行时不读文件，Vite 把这个模块直接编进 dist。
//
// 十张都不在 CSS 里，得把颜色作为内联变量写到 :root 上（见 settings.ts 的 applySettings）。

import type { ImportedTheme } from './settings.ts';

/**
 * **原来 day / night / eye / paper 这四个只活在 CSS 里**（`:root[data-theme=…]`），
 * 颜色 JS 拿不到。阅读纸色和应用外观拆开之后，纸色必须由 JS 写成
 * `--read-*` 变量，所以它们得是数据——搬到这里，和别的纸色同一份来源。
 *
 * id 一个都没改：那是用户选中的纸色存进 localStorage 的键。
 */
export const BUNDLED_THEMES: ImportedTheme[] = [
  { id: "day", name: "日间", night: false, bg: "#f0f0ee", fg: "#333333", accent: "#2f6f4f", panel: "#ffffff", line: "#d9d9d9", muted: "#696969" },
  { id: "night", name: "夜间", night: true, bg: "#191919", fg: "#c8c6c2", accent: "#6ea583", panel: "#222222", line: "#3b3a3a", muted: "#999895" },
  { id: "eye", name: "护眼", night: false, bg: "#cce8cf", fg: "#2b3a2e", accent: "#2f6f4f", panel: "#d8eeda", line: "#b7cbb9", muted: "#4f6052" },
  { id: "paper", name: "羊皮纸", night: false, bg: "#e9dfc4", fg: "#4a3f2f", accent: "#775e33", panel: "#f4ecd8", line: "#d1c9b5", muted: "#675c4c" },
  // 这两个来自用户那份 legado web 版配置（`userConfig.json` 的「内置白天/黑夜」）：
  //   白天 bodyColor #eadfca（暖底）/ fontColor #262626；黑夜 #121212 / #171717 / #666666
  //
  // `bg` 是页面底色、`panel` 是正文那一栏。**panel 一度配成纯白 #ffffff，那是错的**：
  // 配置里写的 contentColor 虽然是 `#fff`，但截图上那一栏明显是暖米白而不是纸白——
  // 纯白压在 #eadfca 上，对比硬得像贴了张打印纸，暖底色的意义也被抵消掉了。
  // 改成 #f8f5ed：比页面亮一档、色温一致，两者才像同一张桌上的纸。
  //
  // panel 同时也是卡片、对话框、工具轨的底色，所以这一改是整体的，不只是阅读器。
  { id: "shuzhai-day", name: "书斋 - 白天", night: false, bg: "#ebe5d8", fg: "#262626", accent: "#7b6135", panel: "#f7f2e8", line: "#d3cfc6", muted: "#63615f" },
  { id: "shuzhai-night", name: "书斋 - 黑夜", night: true, bg: "#121212", fg: "#b0aca4", accent: "#9c968b", panel: "#1b1b1b", line: "#353533", muted: "#95928b" },
  { id: "houmo-day", name: "厚墨 - 日间", night: false, bg: "#efe7db", fg: "#2e2e2e", accent: "#404048", panel: "#f9f2e8", line: "#d4cec6", muted: "#63625f" },
  { id: "houmo-night", name: "厚墨 - 夜间", night: true, bg: "#2c3242", fg: "#d8d5d0", accent: "#00bbca", panel: "#373e50", line: "#4e5362", muted: "#bbb9b9" },
  { id: "wx-day", name: "微信阅读 - 日间", night: false, bg: "#eceef1", fg: "#333333", accent: "#286dae", panel: "#ffffff", line: "#d9d9d9", muted: "#696969" },
  { id: "wx-night", name: "微信阅读 - 夜间", night: true, bg: "#000000", fg: "#d8d5d0", accent: "#3897f1", panel: "#1a1a1a", line: "#353433", muted: "#92918d" },
];
