import { useStore } from '../store/useStore';

/**
 * 阶段指示器：需求澄清 → 项目简报 → 发散画布。
 *
 * 为什么要有它：诊断 P1 说顶栏 10 个按钮「同权重平铺」，破坏性操作和高频轻操作没有区分。
 * 拆开看，那 10 个里有两个根本不是"动作"，是"去哪"——「需求澄清」「项目简报」。
 * 把它们从动作堆里拿出来做成导航，一头解决了动作区拥挤，另一头让"这套流程有三段"
 * 这件事第一次变得可见（原来只有按钮的 active 态隐晦地暗示）。
 *
 * 为什么三段都可点：三段的先后关系就是 F10 阶段机本身，让用户直接跳回去，
 * 比"要回简报只能重新走一遍"符合心智。当前所在的段不可点（已经在那一页）。
 *
 * ⚠️ v2（2026-10-16 批次 1）改名 + 重构：
 *   旧结构是「澄清需求｜画布深潜｜深潜简报(抽屉)」——第 3 段点开的是抽屉，
 *   而"深潜简报"这个名字和前置页的"项目简报"（用户自己写的需求）撞名，
 *   用户实测分不清哪个是哪个。现在：
 *   - 三段与 F10 阶段机一一对应：clarify / report / canvas；
 *   - 第 2 段（项目简报）点击回简报确认页改需求——这正是"重新深潜语义"的
 *     正入口（批次 2 会给它补语义说明框）；
 *   - AI 调研结果不占导航段，改名「调研洞察」，入口移到顶栏动作区
 *     （App.tsx 的 topbar-actions），导航只回答"我在哪、能回哪"。
 *
 * ⚠️ 类名一律 `nav-` 前缀。第一版直接叫 `.stage`，和 styles.css 里
 * ClarifyStage/ReportStage 那条**整页容器**的 `.stage` 撞名了，被它的
 * `flex-direction: column` 覆盖成竖排（徽标压在文字上方）。详见 styles.css 的注释。
 */
export function StageNav() {
  const report = useStore((s) => s.report);
  const product = useStore((s) => s.product);
  const goClarify = useStore((s) => s.goClarify);
  const goReport = useStore((s) => s.goReport);

  const archived = !!report;
  // 与改造前「澄清需求」按钮的 disabled 条件一致：项目名和简报都没有时无处可回
  const canClarify = !!product.trim() || archived;

  return (
    <nav className="nav-stages" aria-label="流程阶段">
      <button
        className={`nav-stage ${archived ? 'done' : ''}`}
        disabled={!canClarify}
        title="回到需求澄清，继续和 AI 对话补充信息"
        onClick={goClarify}
        data-act="stage-clarify"
      >
        <span className="nav-stage-n">{archived ? '✓' : '1'}</span>需求澄清
      </button>
      <span className="nav-stages-sep" aria-hidden="true" />
      <button
        className={`nav-stage ${archived ? 'done' : ''}`}
        title={archived ? '回到项目简报，修改后重新进入画布' : '还没有项目简报——去写一份，确认后进入画布'}
        onClick={goReport}
        data-act="stage-report"
      >
        <span className="nav-stage-n">{archived ? '✓' : '2'}</span>项目简报
      </button>
      <span className="nav-stages-sep" aria-hidden="true" />
      {/* 当前段：canvas 阶段恒为第 3 段，所以它是个不可点的 span。
          同一时刻只让一段处于 on，避免两个激活块打架。 */}
      <span className="nav-stage on" aria-current="step">
        <span className="nav-stage-n">3</span>发散画布
      </span>
    </nav>
  );
}
