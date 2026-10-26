import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useStore } from '../store/useStore';

/**
 * 「整理布局」的统一实现。
 *
 * 整理完必须跟一次 fitView —— 节点可能整体被挪出了当前视口，
 * 只整理不跟镜头的话用户会以为「点了一下什么都没发生」。
 * 还得等 React Flow 把新坐标应用到 DOM 再 fit，否则量到的是旧包围盒。
 *
 * 之前 Canvas 和 Shell 各抄了一份，改一处忘另一处就会两个按钮行为不一致。
 */
export function useTidy(): () => void {
  const { fitView } = useReactFlow();
  return useCallback(() => {
    if (!useStore.getState().tidy()) return;
    requestAnimationFrame(() => fitView({ padding: 0.25, duration: 400 }));
  }, [fitView]);
}
