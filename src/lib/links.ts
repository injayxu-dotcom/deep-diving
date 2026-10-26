import { useMemo } from 'react';
import { useStore, type FlowNode } from '../store/useStore';
import { linkedImageNodes } from './graph';

/**
 * P2 图 → 概念关联的订阅钩子。
 *
 * ⚠️ 与 LeftPanel 种子列表同款的坑：zustand 选择器每次调用都执行，
 * 直接在 selector 里 `nodes.filter(...)` 会返回新数组 → useSyncExternalStore
 * 判定快照不稳定 → "Maximum update depth exceeded" 白屏。
 * 所以这里只取稳定引用（s.nodes），派生全部放 useMemo。
 */
export function useLinkedImages(conceptId: string | undefined): FlowNode[] {
  const nodes = useStore((s) => s.nodes);
  return useMemo(() => linkedImageNodes(nodes, conceptId), [nodes, conceptId]);
}
