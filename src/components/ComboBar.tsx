import { useStore } from '../store/useStore';

/**
 * F8 批量操作条：选中 ≥ 2 个节点时浮在画布右下角。
 *
 * [组合收敛] 只在 2-6 个节点时可用（PRD 8.2 输入约束）；
 * 单个节点没有批量意义，选中 1 个时整条不出现。
 */
export function ComboBar() {
  const selection = useStore((s) => s.selection);
  const nodes = useStore((s) => s.nodes);
  const converging = useStore((s) => s.converging);
  const runCombo = useStore((s) => s.runCombo);
  const runBatchScore = useStore((s) => s.runBatchScore);
  const requestDelete = useStore((s) => s.requestDelete);
  const clearSelection = useStore((s) => s.clearSelection);

  if (selection.length < 2) return null;

  const picked = selection
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n) => !!n);
  const n = picked.length;
  const anyBusy = picked.some((x) => x!.data.busy);
  const comboOk = n >= 2 && n <= 6 && !anyBusy && !converging;
  // 可批量评分：只对真正的「词/概念」评，intel/image 没有语义
  const scorable = picked.some(
    (x) => x!.data.kind === 'seed' || x!.data.kind === 'word' || x!.data.kind === 'concept',
  );
  const count = selection.length;

  return (
    <div className="combo-bar">
      <span className="combo-count">已选中 {count} 个节点</span>
      <button
        className="btn pri xs"
        disabled={!comboOk}
        title={n > 6 ? '组合上限 6 个节点' : n < 2 ? '组合至少需要 2 个节点' : ''}
        onClick={() => void runCombo(selection)}
      >
        {converging ? '组合中…（两轮 AI）' : '组合收敛'}
      </button>
      <button className="btn ghost xs" disabled={converging || !scorable} onClick={() => void runBatchScore(selection)}>
        批量评分
      </button>
      <button
        className="btn ghost xs"
        disabled={converging}
        onClick={() => requestDelete(selection)}
      >
        批量删除
      </button>
      <button className="btn ghost xs" disabled={converging} onClick={clearSelection}>
        取消选择
      </button>
    </div>
  );
}
