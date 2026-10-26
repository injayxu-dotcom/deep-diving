import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { Icon } from './Icon';

/**
 * 画布上的常驻简报面板。
 *
 * 为什么要它：视觉中心一直在画布中央，简报却躺在左栏/抽屉里，
 * 用户得不断把视线拽到边上再拽回来。挂在画布上等于把「这次要做什么」放在手边。
 *
 * 位置与收起状态存 localStorage——同一台机器上不用每次重摆。
 */

/**
 * P6-2「从简报再提取种子」的纯手动路径（D8：AI 版后置）。
 *
 * 拖走简报里的一句话 → 画布上长出一颗种子。用的是情报卡词条那套现成的
 * `application/dd-text` 载荷，画布的 drop 处理一行都不用改——
 * 「再提取几个」不是新能力，是让已有的东西从简报里也能拿得到。
 */
function dragText(text: string) {
  return (e: React.DragEvent) => {
    e.dataTransfer.setData('application/dd-text', text);
    e.dataTransfer.effectAllowed = 'copy';
  };
}

const KEY = 'dd.briefDock';

/**
 * P6-1「钉为便签」：把简报里的一句话复制成画布上的便签。
 *
 * 简报是长文，便签是短句——把要用的那一句摘出来贴在思考现场旁边，
 * 比反复展开浮层找它省事（指南 §1 原则 6「素材贴在思考现场旁边」）。
 * 只是换一种呈现，不是新能力：数据早就有了。
 */
function Pin({ text, what }: { text: string; what: string }) {
  const pinNote = useStore((s) => s.pinNote);
  if (!text) return null;
  return (
    <button
      className="bd-pin"
      title="把这一句钉成便签"
      aria-label={`把${what}钉成便签`}
      onClick={() => void pinNote(text, `项目简报 · ${what}`)}
    >
      <Icon name="pin" size={10} />
    </button>
  );
}

interface DockState {
  x: number | null;
  y: number | null;
  collapsed: boolean;
}

export function BriefDock() {
  const report = useStore((s) => s.report);
  const setReportOpen = useStore((s) => s.setReportOpen);
  const [st, setSt] = useState<DockState>(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...({ x: null, y: null, collapsed: true } as DockState), ...(JSON.parse(raw) as Partial<DockState>) };
    } catch {
      /* 读不到就用默认值 */
    }
    return { x: null, y: null, collapsed: true };
  });

  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(st));
    } catch {
      /* 隐私模式写不进去不影响使用 */
    }
  }, [st]);

  if (!report) return null;

  /** 相对画布容器取坐标：offsetParent 就是 .canvas-wrap（position: relative） */
  const clamp = (x: number, y: number) => {
    const el = ref.current;
    const box = el?.offsetParent as HTMLElement | null;
    if (!el || !box) return { x, y };
    return {
      x: Math.max(8, Math.min(x, box.clientWidth - el.offsetWidth - 8)),
      y: Math.max(8, Math.min(y, box.clientHeight - el.offsetHeight - 8)),
    };
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const box = el.offsetParent as HTMLElement | null;
    const r = el.getBoundingClientRect();
    const b = box?.getBoundingClientRect();
    // 首次拖动才落定坐标：没拖过时它是靠 CSS 贴在右上角的
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    setSt((s) => ({ ...s, x: r.left - (b?.left ?? 0), y: r.top - (b?.top ?? 0) }));
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const el = ref.current;
    const box = el?.offsetParent as HTMLElement | null;
    if (!el || !box) return;
    const b = box.getBoundingClientRect();
    const p = clamp(e.clientX - b.left - drag.current.dx, e.clientY - b.top - drag.current.dy);
    setSt((s) => ({ ...s, ...p }));
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const v = report.visual;

  return (
    <div
      ref={ref}
      className={`brief-dock ${st.collapsed ? 'mini' : ''}`}
      style={
        st.x == null || st.y == null ? undefined : { left: st.x, top: st.y, right: 'auto' }
      }
    >
      <div
        className="bd-head"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        title="拖动可移动，双击标题条收起"
      >
        <Icon name="doc" size={13} />
        <span className="bd-t">项目简报</span>
        <span className="bd-p" title={report.product}>
          {report.product}
        </span>
        <button
          className="icon-btn"
          aria-label={st.collapsed ? '展开简报' : '收起简报'}
          title={st.collapsed ? '展开简报' : '收起简报'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setSt((s) => ({ ...s, collapsed: !s.collapsed }))}
        >
          <Icon name={st.collapsed ? 'chevronLeft' : 'chevronDown'} size={12} />
        </button>
      </div>

      {!st.collapsed ? (
        <div className="bd-body">
          {report.summary ? (
            <p className="bd-sum" draggable title="拖一句话到画布，就长出一颗种子" onDragStart={dragText(report.summary)}>
              {report.summary}
              <Pin text={report.summary} what="调研摘要" />
            </p>
          ) : null}

          {v?.colors || v?.tone || v?.font ? (
            <div className="bd-kv">
              {v.colors ? (
                <div className="bd-row">
                  <span className="bd-k">色彩</span>
                  <span className="bd-v" draggable onDragStart={dragText(v.colors)}>{v.colors}</span>
                  <Pin text={v.colors} what="色彩" />
                </div>
              ) : null}
              {v.tone ? (
                <div className="bd-row">
                  <span className="bd-k">调性</span>
                  <span className="bd-v" draggable onDragStart={dragText(v.tone)}>{v.tone}</span>
                  <Pin text={v.tone} what="调性" />
                </div>
              ) : null}
              {v.font ? (
                <div className="bd-row">
                  <span className="bd-k">字体</span>
                  <span className="bd-v" draggable onDragStart={dragText(v.font)}>{v.font}</span>
                  <Pin text={v.font} what="字体" />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="bd-acts">
            <button className="btn xs" onClick={() => setReportOpen(true)}>
              <Icon name="eye" /> 完整简报
            </button>
          </div>
          {/* D8（纯手动）之后这里必须有一句交代，否则「从简报再提取几个」没有入口。
              两个手势各一句话说清：拖=当种子去裂变，钉=当便签留原话 */}
          <p className="bd-tip">拖句子到画布 = 加种子 · 点图钉 = 钉成便签</p>
        </div>
      ) : null}
    </div>
  );
}
