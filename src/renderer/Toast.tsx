import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 右下角那一条通知。
 *
 * ── 什么时候给按钮，什么时候自己走 ──────────────────────
 *
 * 判据是用户定的：**「不需要操作的时候，不该出现『知道了』——多余。」**
 *
 * 一个只用来「把这个盒子藏起来」的按钮，什么活都没干，却要用户点一下才肯走。
 * 所以：
 *
 *   - **有下一步可做**（扫描出了失败/缺失，旁边就摆着「去处理」）→ 给按钮，
 *     同时给一个**更长的** `auto`（调用方现在传 25 秒）：到点自己走。
 *     旧规是「有动作就永久停留」，用户改成了「N 秒没处理也该消失」——
 *     前提是动作的去处是持久的（侧栏「需要处理」档带着计数），通知只是引子，
 *     它走了待办一点不少。`auto` 传 0（永不走）只许用在「关掉就找不回」的通知。
 *   - **没有下一步**（扫描干净、只是通报跳过了多少、一句报错）→ 给个短些的
 *     `auto`，到时自己走，一个按钮都不出。
 *
 * ⚠️ **鼠标停在上面 / 键盘焦点在里面就暂停计时。**
 * 扫描报告里那几行跳过统计是要读的（「跳过 1342 个：屏蔽规则 1251…」），
 * 而「读到一半它自己跑了」比多一个按钮糟得多。停住不动，移开接着走。
 * 这条不是锦上添花：没有它，自动消失就是在拿信息换整洁。
 *
 * ⚠️ **`auto` 是「这一条存在多久」，不是「渲染多久」。** 内容变了要重新计时，
 * 所以 `key` 由调用方给（换一份报告就是换一条通知）。
 */
export function Toast(
  { children, auto = 0, danger, onClose }:
  {
    children: ReactNode;
    /** 多少毫秒后自己消失。0 = 不自动走（那时调用方自己得给出路） */
    auto?: number;
    danger?: boolean;
    onClose: () => void;
  },
) {
  const [停住, set停住] = useState(false);
  /*
   * ⚠️ **`onClose` 走 ref，不进 effect 的依赖。**
   * 调用方多半是写在 JSX 里的箭头函数——每次渲染都是新的一个，
   * 进了依赖就等于「每渲染一次重新计时」，那条通知会一直不走。
   */
  const 关 = useRef(onClose);
  关.current = onClose;

  /*
   * ⚠️ **「暂停」必须记着已经走了多久——原来这里是重新计时。**
   *
   * 计时写在 `useEffect(..., [auto, 停住])` 里，所以「停住」一变依赖就变了：
   * 清理函数把旧定时器 `clearTimeout` 掉，下一次 effect 又**重新等满一个
   * `auto`**。于是指针在通知上停 10 秒、移开之后还要**再等满 12 秒**——
   * 实测 12241ms（基准是不碰它 11856ms），而顶上那句注释写的正是「移开接着走」。
   *
   * 为什么这在真实使用里是「有的通知一直不消失」：通知就在**右下角**，
   * 而那是鼠标待着的默认位置之一。指针每一次路过或停在上面，计时就归零重来，
   * 于是一条 12 秒的通报能被拖成好几倍；带动作那条是 25 秒，更明显。
   *
   * 改法是记下**这一场已经走了多少**，移开时接着走完剩下的，而不是从头再来。
   * ⚠️ **`auto` 变了要作废上一场的进度**——那是另一场计时了
   * （`key` 换报告会重挂组件，但 `auto` 本身也可能变）。
   */
  const 剩下 = useRef<number | null>(null);
  const 上次Auto = useRef(auto);

  useEffect(() => {
    if (上次Auto.current !== auto) {
      上次Auto.current = auto;
      剩下.current = null;
    }
    if (!auto || 停住) return;
    const 等 = 剩下.current ?? auto;
    const 开始 = performance.now();
    const t = setTimeout(() => { 剩下.current = null; 关.current(); }, 等);
    return () => {
      clearTimeout(t);
      剩下.current = Math.max(0, 等 - (performance.now() - 开始));
    };
  }, [auto, 停住]);

  return (
    <div
      className={`card toast${danger ? ' toast-danger' : ''}`}
      role={danger ? 'alert' : 'status'}
      // 键盘/读屏的人也要能停：焦点进来（比如 Tab 到里面的按钮）同样暂停
      onMouseEnter={() => set停住(true)}
      onMouseLeave={() => set停住(false)}
      onFocus={() => set停住(true)}
      onBlur={() => set停住(false)}
    >
      {children}
    </div>
  );
}
