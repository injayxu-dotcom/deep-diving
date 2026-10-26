import { useEffect } from 'react';
import { ViewportPortal, useViewport } from '@xyflow/react';
import { useStore } from '../store/useStore';
import { DIMENSIONS, dimColor } from '../types';
import { NODE_H, NODE_W } from '../lib/layout';

/**
 * 半径必须够大：斜向四个维度的水平偏移是 R·cos30°，减去半个按钮宽后仍要
 * 大于中心块的半宽（64px），否则按钮会被中心压住点不动。
 * R=150 → 150×0.866−58 = 72 > 64，留出 8px 余量。
 */
const R = 150;

/**
 * 六维裂变轮盘。
 * 挂在 ViewportPortal 里，直接跟随画布坐标系，缩放平移时自动贴着节点。
 */
export function DimensionWheel() {
  const wheelId = useStore((s) => s.wheelId);
  const node = useStore((s) => s.nodes.find((n) => n.id === s.wheelId));
  const closeWheel = useStore((s) => s.closeWheel);
  const runFission = useStore((s) => s.runFission);
  const { zoom } = useViewport();

  useEffect(() => {
    if (!wheelId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeWheel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wheelId, closeWheel]);

  if (!wheelId || !node) return null;

  const cx = node.position.x + NODE_W / 2;
  const cy = node.position.y + NODE_H / 2;

  return (
    <ViewportPortal>
      <div
        className="wheel-root"
        style={{ transform: `translate(${cx}px, ${cy}px) scale(${1 / Math.max(zoom, 0.05)})` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="wheel-halo" />
        {DIMENSIONS.map((d, i) => {
          const ang = (i / DIMENSIONS.length) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(ang) * R;
          const y = Math.sin(ang) * R;
          return (
            <button
              key={d.key}
              className="wheel-item"
              style={{ transform: `translate(${x}px, ${y}px) translate(-50%, -50%)`, borderColor: dimColor(d.key) }}
              title={d.example}
              disabled={node.data.busy}
              onClick={(e) => {
                e.stopPropagation();
                void runFission(node.id, d.key);
                closeWheel();
              }}
            >
              <span className="wheel-name">{d.name}</span>
              <span className="wheel-desc">{d.desc}</span>
            </button>
          );
        })}
        <div className="wheel-center">
          <div className="wheel-word">{node.data.label}</div>
          <div className="wheel-tip">选一个维度裂变</div>
          <button className="wheel-close" onClick={closeWheel} aria-label="关闭">
            ×
          </button>
        </div>
      </div>
    </ViewportPortal>
  );
}
