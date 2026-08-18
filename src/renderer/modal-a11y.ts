/**
 * 弹窗的键盘可达性：焦点进得去、跑不出来、关掉能回原处。
 *
 * ## 为什么是一处而不是十八处
 *
 * 渲染进程里**二十来个文件**各自渲染一份 `.modal-backdrop`。
 * （⚠️ **这儿不记准数**：原来写的「18 个文件、共 21 处」当场数是 21 / 23，
 * 而这个数每加一个弹窗就变一次。要准数就当场跑：
 * `grep -rl 'modal-backdrop' src/renderer/*.tsx | wc -l`。
 * 说服力在「不止一处」，不在到底几处。）
 * 焦点陷阱如果按弹窗写，就是抄十八份——本仓库开头那条
 * 「同一份约定抄成几份必然分叉」说的正是这个，而且已经被咬过三次
 * （`Filter`、`RepairReport`、`Version` 都是抄的那份先掉队）。
 *
 * 所有弹窗共用同一套标记（`.modal-backdrop` > `.modal`），所以在 App 挂一次
 * 全局的就够，十八个文件一个字都不用动。
 *
 * ## 实测到的三个毛病（改之前，CDP 真按 Tab 量的）
 *
 * | | 症状 |
 * |---|---|
 * | 焦点跑得出去 | 弹窗开着按 26 次 Tab，**8～18 站落在背后的书架上** |
 * | 打开时焦点不对 | 要么停在 `body`，要么**停在背后那个触发按钮上**（开「正文净化」，焦点还在侧栏那个按钮） |
 * | 关掉不回原处 | 关完焦点丢在 `body`，得从头 Tab |
 *
 * 对键盘用户就是：打开弹窗，按 Tab，开始逐个走背后的书架，
 * 弹窗里的控件要走完整个书架才够得到。
 *
 * ## 三条边界
 *
 * 1. **只管 `.modal`，不管 `.rate-pop` 和 `.reader-panel`。**
 *    后两个是浮层、没有遮罩、点外面就关——浮层里困住焦点是错的，
 *    用户本来就该能 Tab 出去。判据就是「有没有那层挡住点击的遮罩」。
 * 2. **只拦 Tab。** Esc 有它自己那张总表（`App.tsx`，靠 `defaultPrevented` 握手），
 *    这里一个字都不碰，免得变成同一件事的第二套机制。
 * 3. **嵌套要用栈。** 「在线地址」是开在「编辑一本书」里面的——
 *    约束要认最上面那一层，关掉之后焦点得回到中间那一层，不是一路回到书架。
 */

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** 这一层里真正能聚焦的东西。disabled 和藏起来的不算 */
function focusables(box: Element): HTMLElement[] {
  return [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // `offsetParent` 对 position: fixed 的元素恒为 null，会把整块判没；
    // 用有没有渲染出矩形来判，弹窗里怎么定位都不会误伤
    (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0,
  );
}

/** 最上面那一层弹窗。嵌套时后进的排在后面 */
function topModal(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('.modal');
  return all.length ? all[all.length - 1] : null;
}

/**
 * 挂上去，返回拆除函数。**在 App 里调一次就行。**
 */
/** 给没有 id 的标题编号用，同一页里不重就行 */
let 标题序号 = 0;

export function installModalA11y(): () => void {
  /** 每开一层记下「开之前焦点在哪」，关掉时还回去。嵌套靠它 */
  const stack: Array<HTMLElement | null> = [];
  let count = 0;
  /**
   * 上一次见到的最上面那一层。
   *
   * **只数个数不够**：一个弹窗直接换成另一个（`按书名打标签` 点一个词
   * 就直接换成 `批量打标签`）时数目一直是 1，`sync()` 当场返回——
   * 实测换完焦点掉回 `body`，新弹窗连 `role="dialog"` 都没有。
   * 认元素才认得出「换了一层」。
   */
  let top: HTMLElement | null = null;
  /**
   * 开了但还没送进焦点。
   *
   * **弹窗出现的那一刻里面可能是空的**——「编辑一本书」要先把书的详情取回来
   * 才渲染字段，遮罩已经在了、可聚焦的东西一个都还没有，于是焦点留在 body。
   * 实测就是这么一个：另外三个弹窗都进得去，只有它不行。
   * 记个标记，等内容到了再送一次。
   */
  let pending = false;

  /*
   * ⚠️ **对话框还得有个名字。** 只设 `role="dialog"` 的话，屏幕阅读器念的是
   * 一句光秃秃的「对话框」——而这个应用有十九个弹窗，光听这三个字等于没听见，
   * 用户还得自己 Tab 一圈去猜开的是哪个。
   *
   * 每个弹窗都**已经有一个可见的标题**（多数是 `h2`，朗读引擎那个是 `h3`），
   * 接上去就行，不另写一份 `aria-label`——另写的那份必然和看得见的标题分叉。
   * **一处管全部**，那十九个文件一个字都不用改。
   *
   * ⚠️ **必须能补第二次**：`编辑一本书` 的内容是异步到的，遮罩出现时里面还是空的，
   * 那一刻根本没有标题可接（走查当场抓到的就是这个——焦点那条早有 `pending` 兜着，
   * 这条一开始没跟上）。所以下面 observer 里还会再叫一次，
   * 而这个函数**接过了就立刻返回**，重复叫不花钱。
   */
  const 起名 = (box: HTMLElement | null) => {
    if (!box || box.getAttribute('aria-labelledby')) return;
    const 标题 = box.querySelector('h1, h2, h3');
    if (!标题) return;   // 没标题就不接——不替它编一个
    if (!标题.id) 标题.id = `modal-title-${++标题序号}`;
    box.setAttribute('aria-labelledby', 标题.id);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const box = topModal();
    if (!box) return;
    const items = focusables(box);
    if (!items.length) return;

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;

    // 焦点还在外面（刚打开、或者已经溜出去了）：抓回来
    if (!active || !box.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    // 到头了就绕回去
    if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  };

  const sync = () => {
    const all = document.querySelectorAll<HTMLElement>('.modal');
    const now = all.length;
    const nowTop = now ? all[now - 1] : null;
    if (now === count && nowTop === top) return;

    if (now > count) {
      // 开了新的一层：记下触发它的那个元素，关掉时还回去
      for (let i = count; i < now; i++) stack.push(document.activeElement as HTMLElement | null);
    } else if (now < count) {
      // 关掉一层：把焦点还给当初打开它的那个东西
      pending = false;
      for (let i = now; i < count; i++) {
        const back = stack.pop();
        if (back && back.isConnected && back.getClientRects().length > 0) back.focus();
      }
    }
    // 换了一层就当新的来处理——**不管数目变没变**。原地换掉那种数目根本不变
    if (nowTop && nowTop !== top) {
      // 屏幕阅读器要靠这两个属性才知道「这是个对话框，外面的内容不用念」
      nowTop.setAttribute('role', 'dialog');
      nowTop.setAttribute('aria-modal', 'true');
      起名(nowTop);
      // 已经有人 autoFocus 到里面了就别抢——那多半是个输入框，比按钮更合适
      if (!nowTop.contains(document.activeElement)) {
        const first = focusables(nowTop)[0];
        if (first) first.focus();
        else pending = true;   // 里面还是空的，等内容到了再送
      }
    }
    count = now;
    top = nowTop;
  };

  /**
   * **只在遮罩真的进出时才去数**，不要每次 DOM 变动都 `querySelectorAll`。
   * 书架一次铺 120 张卡，每张卡好几个节点——无差别地数会在最忙的时候空转几百次。
   */
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      const touched = [...r.addedNodes, ...r.removedNodes].some(
        (n) => n instanceof HTMLElement && (n.classList.contains('modal-backdrop') || n.querySelector?.('.modal')),
      );
      if (touched) { sync(); return; }
      // 标题也可能比遮罩晚到。**用已有的 `top`，不再查一次 DOM**——
      // 上面那条注释说的就是「书架铺 120 张卡时别无差别地数」
      if (top) 起名(top);
      // 内容后到的那种：遮罩早就在了，这一批变动是往里面填东西
      if (pending) {
        const box = topModal();
        const first = box && !box.contains(document.activeElement) ? focusables(box)[0] : undefined;
        if (first) { first.focus(); pending = false; return; }
        if (!box) pending = false;
      }
    }
  });

  document.addEventListener('keydown', onKey);
  obs.observe(document.body, { childList: true, subtree: true });
  sync();

  return () => {
    document.removeEventListener('keydown', onKey);
    obs.disconnect();
  };
}
