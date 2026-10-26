import { useViewport } from '@xyflow/react';
import { useStore } from '../store/useStore';

/**
 * 云端同步的四种状态。
 *
 * 为什么分四档而不是"通 / 不通"两档：「没开启」和「开了但没填令牌」要的行动
 * 完全不一样 —— 前者是去设置里打开开关，后者是去填一个值。同样是"没连上"，
 * 笼统说成一种会把用户引到错的地方。
 *
 * `error` 单列一档：云函数返回 403（令牌不匹配）时，之前的处理是
 * `.catch(maybeGuide)` 静默吞掉，用户界面上什么迹象都没有 ——
 * 看起来像"云端就是空的"。状态栏是它唯一的可观测出口。
 */
export type SyncState = 'off' | 'no-token' | 'ok' | 'error';

const SYNC_TEXT: Record<SyncState, string> = {
  off: '云端未开启 · 点此设置',
  'no-token': '云端未连接 · 点此配置令牌',
  ok: '云端已连接',
  error: '云端连接失败 · 点此查看',
};

/** 只有这两种需要用户动手，点一下开设置；ok / off 的文案本身已说明状态 */
const ACTIONABLE: SyncState[] = ['no-token', 'error', 'off'];

/**
 * 底部状态栏（30px，流内 footer，横跨三栏）。
 *
 * ⚠️ **不是**画布浮层 —— 它在 `.app` 里、`.body` 之后，所以画布高度不受它影响
 * （对比 `.float-tools` 那三块，它们是 `.canvas-wrap` 的绝对定位覆盖层）。
 *
 * 为什么四项里只有「缩放」订阅 useViewport：
 * 它在拖动/滚轮缩放时会连续变化。若放在 Shell 里取，整棵三栏树会跟着重渲染；
 * 放进这个组件就只有 30px 这一行重渲染。节点数 / 情报卡数同理，用选择器订阅。
 */
export function StatusBar({ sync, onOpenSettings }: { sync: SyncState; onOpenSettings: () => void }) {
  const stage = useStore((s) => s.stage);
  const nodeCount = useStore((s) => s.nodes.length);
  const intelCount = useStore((s) => s.intel.length);
  /* 种子词是 kind==='seed' 的那几颗，不等于节点总数 —— 用户心智里
     "我撒了几个种子"和"画布上有多少东西"是两回事。 */
  const seedCount = useStore(
    (s) => s.nodes.filter((n) => (n.data as { kind?: string }).kind === 'seed').length,
  );
  const { zoom } = useViewport();

  /* 澄清 / 简报是两个整页，没有"画布当前状态"可言，状态栏整条都不该出现。 */
  if (stage !== 'canvas') return null;

  const actionable = ACTIONABLE.includes(sync);

  return (
    <footer className="statusbar" data-sync={sync}>
      <div className="sb-left">
        {/* 阶段名与顶栏阶段指示器第三段同措辞（需求澄清 / 项目简报 / 发散画布）。
            状态栏只在画布阶段出现，所以这里恒为「发散画布」。 */}
        <span className="sb-lead">
          <i className="sb-dot" aria-hidden="true" />
          发散画布
        </span>
        <span className="sb-item">
          节点 <b>{nodeCount}</b>
        </span>
        <span className="sb-item">
          情报卡 <b>{intelCount}</b>
        </span>
        <span className="sb-item">
          种子词 <b>{seedCount}</b>
        </span>
        <span className="sb-item">
          缩放 <b>{Math.round(zoom * 100)}%</b>
        </span>
      </div>

      <div className="sb-right">
        {actionable ? (
          /* 可点：文案本身就是行动指引（"点此配置令牌"），不给 affordance 等于骗人 */
          <button className="sb-sync act" onClick={onOpenSettings} title="打开 AI 设置">
            <i className="sb-dot warn" aria-hidden="true" />
            {SYNC_TEXT[sync]}
          </button>
        ) : (
          <span className="sb-sync ok">
            <i className="sb-dot" aria-hidden="true" />
            {SYNC_TEXT[sync]}
          </span>
        )}
      </div>
    </footer>
  );
}
