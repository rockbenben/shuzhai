interface Props {
  value: number | null;
  onChange: (next: number | null) => void;
  /** 悬停预览。评价浮层要（鼠标扫过就能看到几星），添书对话框不需要 */
  hover?: number | null;
  onHover?: (n: number | null) => void;
}

/**
 * 五颗星。评价浮层和「添一本读过的书」都用它。
 *
 * **再点同一颗清零**——不然给错了分没法撤。
 *
 * 抽出来是因为这两处曾经各写了一份：同样的 `.rate-stars` 结构、同样的
 * 「点同一颗清零」、同样的「N 星 / 未评分」。以后要加半星或换成十分制，
 * 两份就得改两遍，而漏掉一份不会有任何报错。
 */
export function StarRating({ value, onChange, hover, onHover }: Props) {
  /*
   * ⚠️ **这里原来有一句 `if (!loadShowRating()) return null;`，已经去掉。**
   *
   * 「用评分」那个开关管的是**书架上的展示**——封面角标和搜索结果里的 ★ 那一列，
   * 两处各自在调用点判（`App.tsx` 的 `.book-rating`、`SearchPanel.tsx` 那个 `<td>`）。
   * 而这个组件是**打分用的输入控件**，它出现在评价浮层、编辑一本书、添读过的书、
   * 阅读器那张评价卡上——**那四处是「评价」本身，评分和短评是一件事的两半**，
   * 藏掉一半剩下的就不成立了。
   *
   * 藏在这儿的后果实测过：用户点开「评价」只看到一个输入框，
   * 第一反应是「这个应用只能写文字」，而不是「我关过一个开关」——
   * 界面上没有任何地方告诉他星星是被藏起来的。
   */
  const shown = hover ?? value ?? 0;
  return (
    /*
     * **`aria-label` 和 `aria-pressed` 不是装饰。** 拿 CDP 量过改之前的样子：
     * 五颗星算出来的可及名称**全是「★」**（按钮里的文字盖过 `title`，
     * `title` 只落在 description 上），这一组本身 `role: none` 也没有名字，
     * 而且没有任何地方说得出「现在是几星」。
     * 屏幕阅读器听到的就是五个一模一样的「★ 按钮」——**而打分是这个应用的核心动作**。
     *
     * `aria-pressed` 只给**当前那一颗**，不是给 1..N 全部：那样读出来是
     * 「1 星 已按下、2 星 已按下、3 星 已按下」，听的人得自己数；
     * 只标当前那颗，读出来就是「3 星，已按下」——一句话说清现在是几分。
     * 视觉上的填充跟 `shown`（含悬停预览）走，**而 aria 状态只跟 `value` 走**：
     * 鼠标扫过去不该改变屏幕阅读器听到的事实。
     */
    <div className="rate-stars" role="group" aria-label="评分" onMouseLeave={() => onHover?.(null)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={n <= shown ? 'on' : ''}
          aria-label={value === n ? `${n} 星（当前，再按一次清除评分）` : `${n} 星`}
          aria-pressed={value === n}
          onMouseEnter={() => onHover?.(n)}
          onClick={() => onChange(value === n ? null : n)}
          title={value === n ? '再点一次清除评分' : `${n} 星`}
        >
          ★
        </button>
      ))}
      <span className="muted">{value ? `${value} 星` : '未评分'}</span>
    </div>
  );
}
