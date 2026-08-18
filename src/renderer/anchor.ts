import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/**
 * **浮层从哪个键出来，就贴着那个键开。**
 *
 * 这个阅读器有两条轨：左上那条（书架/目录/上下一章/设置/顶部/底部）和右下那条
 * （加书签/搜索/评价/书签划线/自动滚/朗读/夜间）。而三个浮层原来**都钉在右下**，
 * 包括从左上「设置」点开的那一个。当场量的：设置那个键在 `x=18`，
 * 浮层开在 `x=1110`——1440 宽的窗口里，东西从对角线另一头冒出来。
 *
 * 原来那条注释自己写着理由：「两个入口一个浮层，位置只能有一个，那就跟着
 * 最常用的那个走」。现在三个浮层各是各的，那条约束就没了。
 *
 * 位置在这儿是**信息不是装饰**：它说的是「刚才那一下是从哪个键出来的」。
 *
 * ⚠️ **必须量出来，不能按轨的顶端算。** 「设置」是左轨第 5 格，
 * 齐着轨顶开就差了四格（一百多像素），那和「跟着按钮」不是一回事。
 *
 * ⚠️ **`useLayoutEffect` 不是 `useEffect`**：浮层要在**第一帧就在正确的位置**，
 * 晚一帧就是肉眼可见的一跳。判据抄 `Reader.tsx` 卸章补偿那处
 * （顺带：后台窗口里 rAF 根本不跑，用 rAF 排这件事会直接不动）。
 */
export type 贴哪边 = 'left-top' | 'right-bottom';

/** 浮层和轨之间留的缝 */
const 缝 = 8;
/** 浮层离容器上下边至少留这么多，别贴着边 */
const 边距 = 8;

export function useAnchored(
  开着: boolean,
  按钮: RefObject<HTMLElement | null>,
  浮层: RefObject<HTMLElement | null>,
  轨: RefObject<HTMLElement | null>,
  边: 贴哪边,
): CSSProperties {
  const [样式, set样式] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!开着) return;
    const b = 按钮.current;
    const p = 浮层.current;
    const r = 轨.current;
    const main = p?.offsetParent as HTMLElement | null;
    if (!b || !p || !r || !main) return;

    const 量 = () => {
      const B = b.getBoundingClientRect();
      const P = p.getBoundingClientRect();
      const R = r.getBoundingClientRect();
      const M = main.getBoundingClientRect();
      // 夹回容器里：小窗口上一个 500 高的浮层贴着第 5 格开，底下会掉出屏幕
      const 夹 = (v: number, 高: number) => Math.max(边距, Math.min(v, M.height - 高 - 边距));
      /*
       * ⚠️ **另外两个边要显式写 `auto`。** CSS 里 `.reader-panel` 钉的是
       * `right` + `bottom`；只补一个 `left` 上去的话，left 和 right 同时成立，
       * 浮层会被拉成整栏宽——不是没生效，是**变形**，比没生效更难认。
       */
      if (边 === 'left-top') {
        set样式({ left: R.right - M.left + 缝, top: 夹(B.top - M.top, P.height), right: 'auto', bottom: 'auto' });
      } else {
        set样式({ right: M.right - R.left + 缝, bottom: 夹(M.bottom - B.bottom, P.height), left: 'auto', top: 'auto' });
      }
    };

    量();
    /*
     * 内容会变高（朗读面板念起来之后多一条声线、设置里展开「间距和留白」），
     * 变高之后夹取的结果就不一样了。**只观察浮层自己**——观察容器会
     * 在每次翻页时白跑一遍。
     */
    const ro = new ResizeObserver(量);
    ro.observe(p);
    window.addEventListener('resize', 量);
    return () => { ro.disconnect(); window.removeEventListener('resize', 量); };
  }, [开着, 按钮, 浮层, 轨, 边]);

  use浮层焦点(开着, 按钮, 浮层);

  return 样式;
}

/**
 * **开的时候焦点进浮层，关的时候还给那个键。**
 *
 * 抽出来是因为**目录那一层不走 `useAnchored`**（它是钉在正文栏上的抽屉、
 * 不贴着按钮开），而焦点这条规矩对它一样成立。
 *
 * 当场量的：开着设置面板按两下 Tab，走的是「书架 → 目录」——**根本没进面板**。
 * 因为焦点还留在外面，而浮层在 DOM 里排得靠后，用键盘的人要把整条轨和正文
 * 都 Tab 一遍才够得着自己刚打开的那个面板。
 *
 * 这里**不做焦点圈套**（`modal-a11y.ts` 那种）：那几个是真弹窗、背后有遮罩，
 * 而这三个是贴着按钮开的浮层，正文还在读——Tab 出去是正常操作，不该拦。
 * 要的只有两件事：**进得去**、**关掉之后回到原处**。
 *
 * ⚠️ **`tabIndex` 是就地写到 DOM 上的，不走 props。** 收在这儿是为了让那六个
 * 调用点（两个阅读界面 × 设置/朗读/评价）一个字都不用改——判据同这个仓库那条
 * 「同一份约定抄成几份必然分叉」。React 不管这个属性，所以它不会被重渲染抹掉。
 *
 * ⚠️ **关掉时只在焦点「无家可归」的时候才收回来。** 浮层一从 DOM 上摘掉，
 * `activeElement` 就掉回 `body`——那才是该还给按钮的情形。
 * 如果用户自己 Tab 到别处、或者点了正文里的什么东西，抢焦点比不抢更糟。
 */
export function use浮层焦点(
  开着: boolean,
  按钮: RefObject<HTMLElement | null>,
  浮层: RefObject<HTMLElement | null>,
): void {
  const 开过了 = useRef(false);
  useEffect(() => {
    const 层 = 浮层.current;
    if (开着 && !开过了.current) {
      /*
       * ⚠️ **浮层里已经有东西拿到焦点就别抢。** 现在这三个浮层里没有自动聚焦的
       * 控件（查过了），但哪天有人给某个面板的输入框加一句 `autoFocus`，
       * 它会先跑、这条 effect 后跑——**焦点当场被抢走，而且一句报错都没有**。
       * 一个条件挡掉一整类。
       */
      if (层 && !层.contains(document.activeElement)) {
        层.tabIndex = -1;
        // 程序移过来的焦点不该画一圈轮廓——那一圈是给「Tab 到这儿」看的
        层.style.outline = 'none';
        层.focus({ preventScroll: true });
      }
    } else if (!开着 && 开过了.current) {
      const 现在 = document.activeElement as HTMLElement | null;
      if (!现在 || 现在 === document.body) 按钮.current?.focus({ preventScroll: true });
    }
    开过了.current = 开着;
  }, [开着, 按钮, 浮层]);
}
