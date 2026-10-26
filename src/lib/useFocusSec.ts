import { useEffect } from 'react';

/**
 * 消费收起把手带来的区块锚点：面板展开后滚到那个区块。
 *
 * 为什么是 effect 而不是在点击处 setTimeout：后者要赌"React 已经把面板渲染出来了"，
 * effect 天然在 commit 之后跑，不依赖时序假设。
 * 为什么消费完就回调清空：否则用户手动折叠再展开一次，会被重复滚一遍。
 *
 * ⚠️ 不变量：`data-sec` 只挂在**面板内的区块**上。
 * 收起把手上的按钮用的是 `data-rail-sec`（见 App.tsx 的 SideRail），刻意不同名 ——
 * 否则这里的选择器可能命中把手自己，把滚动作用到一条没有滚动条的窄条上，
 * 表现为"点了图标没反应"，而且不报错。
 *
 * 滚动容器由浏览器自己找最近的可滚动祖先：`.panel`（styles.css:118）是
 * `overflow-y: auto` 的 flex 列，正好是它。不需要手写 scrollTop 计算。
 */
export function useFocusSec(focusSec?: string | null, onFocused?: () => void) {
  useEffect(() => {
    if (!focusSec) return;
    document.querySelector(`[data-sec="${focusSec}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    onFocused?.();
  }, [focusSec, onFocused]);
}
