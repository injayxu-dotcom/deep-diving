import { useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useStore, type FlowNode } from '../store/useStore';
import {
  DIMENSIONS,
  INTEL_LABEL,
  NOTE_NEW,
  NOTE_TONES,
  VISION_DIMS,
  dimColor,
  noteTone,
  seedOrigin,
  tiltOf,
} from '../types';
import { collectDescendants, groupColor } from '../lib/graph';
import { useLinkedImages } from '../lib/links';
import { QUADRANT_NAME } from '../lib/scoring';
import { Icon, type IconName } from './Icon';
import { useCopy } from './RightPanel';
import { DetailToggle, NodeBody, nodeHasDetail } from './NodeBody';

function Spinner() {
  return <span className="spin" aria-label="AI 生成中" />;
}

/**
 * 操作按钮。
 * 必须阻止 mousedown 冒泡，否则点按钮会连带触发节点拖拽。
 */
function Act({
  label,
  onClick,
  tone = 'default',
  disabled,
  icon,
}: {
  label: string;
  onClick: () => void;
  tone?: 'default' | 'accent' | 'danger';
  disabled?: boolean;
  icon?: IconName;
}) {
  return (
    <button
      className={`nact ${tone}`}
      disabled={disabled || undefined}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {icon ? <Icon name={icon} size={11} /> : null}
      {label}
    </button>
  );
}

/** 操作条内嵌在节点里，跟随节点缩放平移，不会遮挡节点内容 */
function Actions({ children }: { children: React.ReactNode }) {
  return <div className="nacts nodrag nowheel">{children}</div>;
}

/** 上传图片的动作按钮：内部藏一个 file input */
function PickImage({ nodeId }: { nodeId: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const attachImages = useStore((s) => s.attachImages);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        multiple
        hidden
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void attachImages(nodeId, files);
        }}
      />
      <Act label="加参考图" icon="image" onClick={() => ref.current?.click()} />
    </>
  );
}

/** 节点上的图片缩略图网格 */
function Thumbs({ images }: { images: NonNullable<FlowNode['data']['images']> }) {
  const shown = images.slice(0, 4);
  return (
    <div className={`thumbs t${shown.length}`}>
      {shown.map((img) =>
        /* P5/D7：快照不存图片 dataUrl，恢复后图节点是「有名字的空壳」。
           空 src 的 <img> 会渲染成破图标，看着像坏了——显式画成占位，
           并在 title 里说清原因。 */
        img.dataUrl ? (
          <img key={img.id} src={img.dataUrl} alt={img.name} title={img.name} />
        ) : (
          <span key={img.id} className="thumb-empty" title={`${img.name}（快照不含图片，需重新上传）`}>
            <Icon name="image" size={14} />
          </span>
        ),
      )}
      {images.length > 4 ? <span className="thumb-more">+{images.length - 4}</span> : null}
    </div>
  );
}

/** 色卡条 */
function Palette({ colors }: { colors: string[] }) {
  return (
    <div className="palette">
      {colors.map((c) => (
        <span key={c} className="sw" style={{ background: c }} title={c} />
      ))}
    </div>
  );
}

/**
 * P2：图节点上的「→ 概念：X」chip。
 * 点名字定位到概念（画布选中即平移），点 × 取消关联。
 * 这是闭环的「回指」——图自己说得出它属于哪套概念，不用靠连线数。
 */
function LinkChip({ imageId }: { imageId: string }) {
  const conceptId = useStore((s) => s.nodes.find((n) => n.id === imageId)?.data.linkedConceptId);
  const nodes = useStore((s) => s.nodes);
  const concept = useMemo(() => nodes.find((n) => n.id === conceptId), [nodes, conceptId]);
  const setSelected = useStore((s) => s.setSelected);
  const unlink = useStore((s) => s.unlinkImageFromConcept);
  // 概念被删时 store 会清掉 linkedConceptId；老数据/异常情况下 chip 直接不渲染，
  // 不留一个点了没反应的「→ 概念：undefined」
  if (!conceptId || !concept) return null;
  return (
    <div className="nd-link">
      <button
        className="nd-link-go"
        title="定位到概念（选中并平移过去）"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setSelected(conceptId);
        }}
      >
        <Icon name="link" size={10} />
        <span className="nd-link-arrow">→</span>
        <span className="nd-link-t">{concept.data.label}</span>
      </button>
      <button
        className="nd-link-x"
        title="取消关联"
        aria-label="取消概念关联"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          unlink(imageId);
        }}
      >
        ×
      </button>
    </div>
  );
}

/** P2：图节点上的留用 / 淘汰标记（本地人工决策，无 AI） */
function KeepBadge({ imageId }: { imageId: string }) {
  const keep = useStore((s) => s.nodes.find((n) => n.id === imageId)?.data.keep);
  if (keep == null) return null;
  return (
    <span className={`nd-keep ${keep ? 'on' : 'off'}`} title={keep ? '已标记留用' : '已标记淘汰'}>
      {keep ? '留用' : '淘汰'}
    </span>
  );
}

/**
 * P2：概念卡面的关联图缩略图条 + 「参考图 N」徽标。
 * 概念自己不说「我出了哪些图」，用户就得满画布找——闭环在卡面上合拢。
 */
function LinkedThumbs({ conceptId }: { conceptId: string }) {
  const linked = useLinkedImages(conceptId);
  if (!linked.length) return null;
  const imgs = linked.flatMap((n) => n.data.images ?? []);
  const shown = imgs.slice(0, 3);
  return (
    <div className="nd-linked">
      <div className="nd-linked-head">
        <span className="nd-linked-badge">
          <Icon name="image" size={10} />参考图 {linked.length}
        </span>
        {imgs.length > 3 ? <span className="nd-linked-more">+{imgs.length - 3}</span> : null}
      </div>
      <div className="nd-linked-thumbs">
        {shown.map((img) =>
          img.dataUrl ? (
            <img key={img.id} src={img.dataUrl} alt={img.name} title={img.name} />
          ) : (
            <span key={img.id} className="thumb-empty" title={`${img.name}（快照不含图片）`}>
              <Icon name="image" size={12} />
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * 分组归属的可视化。
 *
 * 同组共用一个颜色，选中组内任一节点时整组一起亮起来——
 * 「这堆词是哪颗种子长出来的」原本只能靠连线一根根数，现在一眼可见。
 */
function useGroupVisuals(groupId?: string) {
  const lit = useStore((s) => {
    if (!groupId) return false;
    const sel = s.nodes.find((n) => n.id === s.selectedId);
    return !!sel && sel.data.groupId === groupId;
  });
  const color = groupColor(groupId);
  return {
    lit,
    style: color ? ({ '--grp': color } as React.CSSProperties) : undefined,
  };
}

/** 组标识：节点左上角的小圆点 */
function GroupDot() {
  return <span className="nd-grp" />;
}

/**
 * 折叠徽标：把延伸词收进父节点。
 * 常驻显示（不只在选择时），否则「拖着一坨词到处走」的问题还是没解——
 * 用户得先选中才能收，等于多一步。
 */
function FoldBadge({ id, count }: { id: string; count: number }) {
  const collapsed = useStore((s) => s.nodes.find((n) => n.id === id)?.data.collapsed ?? false);
  const toggleCollapse = useStore((s) => s.toggleCollapse);
  if (!count) return null;
  return (
    <button
      className={`nd-fold ${collapsed ? 'folded' : ''}`}
      title={collapsed ? `展开 ${count} 个延伸词` : `收起 ${count} 个延伸词`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        toggleCollapse(id);
      }}
    >
      <svg
        className="nd-fold-i"
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
      {count}
    </button>
  );
}

/** 后代数量。「收起延伸词」只在真的有延伸词时出现——叶子节点给了也是死按钮 */
function useKidCount(id: string) {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  // 必须走 useMemo：zustand 的 selector 在每次 setState 都会执行（只比较返回值决定是否重渲染），
  // 直接在 selector 里 collectDescendants 的话，连写一条日志都会让 N 个节点各跑一次 O(N+E)
  return useMemo(() => collectDescendants(id, nodes, edges).length, [id, nodes, edges]);
}

/** 节点忙碌时的文案：裂变中带上维度名，让用户知道哪个节点在为哪个方向工作 */
function busyText(data: { fissionDim?: string }): string {
  const dim = data.fissionDim ? DIMENSIONS.find((d) => d.key === data.fissionDim) : null;
  return dim ? `正在发散 · ${dim.name}…` : 'AI 生成中…';
}

/** 一键出方案的进度。三步串起来要十几秒，没有进度用户会以为点空了 */
function PlanBar({ plan }: { plan: { step: number; total: number } }) {
  const label =
    plan.total <= 2
      ? plan.step <= 1
        ? '评分 + 提示词'
        : '收尾'
      : plan.step <= 1
        ? '创意简报'
        : plan.step === 2
          ? '评分 + 提示词'
          : '收尾';
  return (
    <div className="nd-plan">
      <Spinner />
      出方案 {plan.step}/{plan.total} · {label}
    </div>
  );
}

/** 种子节点：画布的起点 */
export function SeedNode({ id, data, selected }: NodeProps<FlowNode>) {
  const openWheel = useStore((s) => s.openWheel);
  const requestDelete = useStore((s) => s.requestDelete);
  const toggleCollapse = useStore((s) => s.toggleCollapse);
  const runPlan = useStore((s) => s.runPlan);
  const kids = useKidCount(id);
  const expanded = useStore((s) => s.expandedId === id);
  const grp = useGroupVisuals(data.groupId);

  return (
    <div
      className={`nd nd-seed ${selected ? 'sel' : ''} ${expanded ? 'exp' : ''} ${grp.lit ? 'grp-lit' : ''}`}
      style={grp.style}
    >
      {grp.style ? <GroupDot /> : null}
      <Handle type="source" position={Position.Right} className="hnd" />
      <div className="nd-label">{data.label}</div>
      <SeedOriginBadge data={data} />
      <div className="nd-sub">
        {data.busy ? <Spinner /> : null}
        {data.busy ? busyText(data) : '种子 · 点下方按钮开始裂变'}
      </div>
      {data.seedWhy ? <div className="nd-why nd-seedwhy">{data.seedWhy}</div> : null}
      {data.plan ? <PlanBar plan={data.plan} /> : null}
      {data.images?.length ? <Thumbs images={data.images} /> : null}
      {data.palette?.length ? <Palette colors={data.palette} /> : null}
      <FoldBadge id={id} count={kids} />
      {!expanded && nodeHasDetail(data) ? <DetailToggle id={id} open={false} /> : null}
      {selected ? (
        <Actions>
          <Act label="六维裂变" icon="sparkles" tone="accent" disabled={data.busy} onClick={() => openWheel(id)} />
          <Act label="一键出方案" icon="wand" disabled={data.busy} onClick={() => void runPlan(id)} />
          <SeedActs label={data.label} />
          <PickImage nodeId={id} />
          {kids ? (
            <Act
              label={data.collapsed ? '展开延伸词' : '收起延伸词'}
              icon={data.collapsed ? 'chevronRight' : 'chevronDown'}
              onClick={() => toggleCollapse(id)}
            />
          ) : null}
          <Act label="删除" icon="trash" tone="danger" onClick={() => requestDelete([id])} />
        </Actions>
      ) : null}
      {expanded ? <NodeBody nodeId={id} /> : null}
    </div>
  );
}

/** 裂变词节点 */
export function WordNode({ id, data, selected }: NodeProps<FlowNode>) {
  const openWheel = useStore((s) => s.openWheel);
  const requestDelete = useStore((s) => s.requestDelete);
  const runPlan = useStore((s) => s.runPlan);
  const toggleConverge = useStore((s) => s.toggleConverge);
  const toggleCollapse = useStore((s) => s.toggleCollapse);
  const kids = useKidCount(id);
  const expanded = useStore((s) => s.expandedId === id);
  const dim = DIMENSIONS.find((d) => d.key === data.dim);
  const grp = useGroupVisuals(data.groupId);

  return (
    <div
      className={`nd nd-word ${selected ? 'sel' : ''} ${expanded ? 'exp' : ''} ${data.converged ? 'conv' : ''} ${grp.lit ? 'grp-lit' : ''}`}
      style={{ ...grp.style, ...(dim ? { borderLeftColor: dimColor(dim.key) } : null) }}
    >
      {grp.style ? <GroupDot /> : null}
      <Handle type="target" position={Position.Top} className="hnd" />
      <Handle type="source" position={Position.Bottom} className="hnd" />
      <div className="nd-label">{data.label}</div>
      {dim ? <span className="nd-dim">{dim.name}</span> : null}
      {data.direction ? <span className="nd-dir">可转译 · {data.direction}</span> : null}
      {data.plan ? (
        <PlanBar plan={data.plan} />
      ) : data.busy ? (
        <div className="nd-sub">
          <Spinner /> {busyText(data)}
        </div>
      ) : data.detail ? (
        <div className="nd-why">{data.detail}</div>
      ) : null}
      {data.images?.length ? <Thumbs images={data.images} /> : null}
      {data.palette?.length ? <Palette colors={data.palette} /> : null}
      {data.converged ? <span className="nd-flag">已收敛</span> : null}
      <FoldBadge id={id} count={kids} />
      {!expanded && nodeHasDetail(data) ? <DetailToggle id={id} open={false} /> : null}
      {selected ? (
        <Actions>
          <Act label="一键出方案" icon="wand" tone="accent" disabled={data.busy} onClick={() => void runPlan(id)} />
          <Act label="继续裂变" icon="sparkles" disabled={data.busy} onClick={() => openWheel(id)} />
          <Act label={data.converged ? '取消收敛' : '收敛'} icon="target" onClick={() => toggleConverge(id)} />
          <PickImage nodeId={id} />
          {kids ? (
            <Act
              label={data.collapsed ? '展开延伸词' : '收起延伸词'}
              icon={data.collapsed ? 'chevronRight' : 'chevronDown'}
              onClick={() => toggleCollapse(id)}
            />
          ) : null}
          <Act label="删除" icon="trash" tone="danger" onClick={() => requestDelete([id])} />
        </Actions>
      ) : null}
      {expanded ? <NodeBody nodeId={id} /> : null}
    </div>
  );
}

/**
 * 概念节点：已生成创意简报。
 *
 * 组合收敛出来的节点也走这里（type 同为 concept），
 * 所以「一键出方案」对组合词同样可用——上一版组合词没有简报入口，
 * 收敛完就走进了死胡同，只能干看着协同分。
 */
export function ConceptNode({ id, data, selected }: NodeProps<FlowNode>) {
  const requestDelete = useStore((s) => s.requestDelete);
  const runPlan = useStore((s) => s.runPlan);
  const toggleConverge = useStore((s) => s.toggleConverge);
  const toggleCollapse = useStore((s) => s.toggleCollapse);
  const kids = useKidCount(id);
  const expanded = useStore((s) => s.expandedId === id);
  // P2：图节点被拖着经过时高亮——告诉用户「松手就关联到我」
  const dropHint = useStore((s) => s.linkHintId === id);
  const b = data.brief;
  const grp = useGroupVisuals(data.groupId);

  return (
    <div
      className={`nd nd-concept ${selected ? 'sel' : ''} ${expanded ? 'exp' : ''} ${data.converged ? 'conv' : ''} ${grp.lit ? 'grp-lit' : ''} ${dropHint ? 'drop-hint' : ''}`}
      style={grp.style}
    >
      {grp.style ? <GroupDot /> : null}
      <Handle type="target" position={Position.Top} className="hnd" />
      <div className="nd-label">{data.label}</div>
      {b ? <div className="nd-why">{b.imagery || b.strategy}</div> : null}
      {data.combo?.synergy != null ? (
        <div className="nd-why nd-combo">
          协同 {data.combo.synergy.toFixed(1)}
          {data.combo.advice ? ` · ${data.combo.advice}` : ''}
        </div>
      ) : null}
      {data.plan ? (
        <PlanBar plan={data.plan} />
      ) : data.busy ? (
        <div className="nd-sub">
          <Spinner /> {busyText(data)}
        </div>
      ) : null}
      {data.score ? (
        <div className="nd-score">
          {data.score.v === 2
            ? `价值 ${(data.score.value ?? 0).toFixed(1)} · ${QUADRANT_NAME[data.score.quadrant ?? 'meh']}`
            : `匹配 ${(data.score.match ?? 0).toFixed(1)} · 差异 ${(data.score.diff ?? 0).toFixed(1)}（旧版）`}
        </div>
      ) : null}
      <LinkedThumbs conceptId={id} />
      {data.images?.length ? <Thumbs images={data.images} /> : null}
      {data.palette?.length ? <Palette colors={data.palette} /> : null}
      {data.converged ? <span className="nd-flag">已收敛</span> : null}
      <FoldBadge id={id} count={kids} />
      {!expanded && nodeHasDetail(data) ? <DetailToggle id={id} open={false} /> : null}
      {selected ? (
        <Actions>
          <Act label="一键出方案" icon="wand" tone="accent" disabled={data.busy} onClick={() => void runPlan(id)} />
          <Act label={data.converged ? '取消收敛' : '收敛'} icon="target" onClick={() => toggleConverge(id)} />
          <PickImage nodeId={id} />
          {kids ? (
            <Act
              label={data.collapsed ? '展开延伸词' : '收起延伸词'}
              icon={data.collapsed ? 'chevronRight' : 'chevronDown'}
              onClick={() => toggleCollapse(id)}
            />
          ) : null}
          <Act label="删除" icon="trash" tone="danger" onClick={() => requestDelete([id])} />
        </Actions>
      ) : null}
      {expanded ? <NodeBody nodeId={id} /> : null}
    </div>
  );
}

/**
 * 种子来源徽标（P6-1）。
 *
 * 指南 §4：「来源与模型推断不要混为一谈」。原来只有「深潜挖出来的种子」才有
 * 来源条，手动加的种子什么都没写——用户回头分不清哪些词是自己放进去的。
 * 现在两种都写明，只是文案与图标不同。
 */
function SeedOriginBadge({ data }: { data: FlowNode['data'] }) {
  const origin = seedOrigin(data);
  if (origin === 'dive') {
    return (
      <div className="nd-src" title={`为什么选它：${data.seedWhy || '—'}\n来源：${data.seedSource}`}>
        <Icon name="sparkles" size={10} />
        <span className="nd-src-k">简报提取</span>
        <span className="nd-src-t">{data.seedSource}</span>
      </div>
    );
  }
  return (
    <div className="nd-src manual" title="你自己添加的种子（不是模型推断）">
      <Icon name="plus" size={10} />
      <span className="nd-src-k">手动添加</span>
    </div>
  );
}

/** 种子节点的「复制」与「使用」——P6-2：把双击这种隐性操作显式化 */
function SeedActs({ label }: { label: string }) {
  const { copy, copied } = useCopy();
  return (
    <>
      <Act
        label={copied === 'seed' ? '已复制' : '复制'}
        icon="copy"
        onClick={() => void copy(label, 'seed')}
      />
    </>
  );
}

/**
 * P6-1：用户便签。
 *
 * 这是画布上唯一「用户自己的声音」——所以它和所有 AI 产物在视觉上必须一眼分开
 * （指南 §4）。三条纪律：
 * 1. 只用 D9 的五个暖色；AI 生成的卡永远不用便签黄；
 * 2. 双击就地编辑（textarea 覆盖卡面，不弹窗——便签的用法就是随手改一句）；
 * 3. 轻微倾斜由 id 推导（见 tiltOf），同一节点每帧角度相同，不会自己抖。
 */
export function NoteNode({ id, data, selected }: NodeProps<FlowNode>) {
  const setNoteText = useStore((s) => s.setNoteText);
  const setNoteTone = useStore((s) => s.setNoteTone);
  const requestDelete = useStore((s) => s.requestDelete);
  const { copy, copied } = useCopy();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.label);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const tone = useMemo(() => noteTone(data.noteTone), [data.noteTone]);

  // 从工具条新建的便签带着 noteDraft 落地：直接进编辑态，光标已经在里面
  useEffect(() => {
    if (data.noteDraft) {
      setDraft(data.label === NOTE_NEW ? '' : data.label);
      setEditing(true);
    }
    // 只在挂载时判一次：之后 noteDraft 由 setNoteText 清掉，不该再反复弹编辑器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 进入编辑时把光标放到末尾：便签多是接着写，不是重写
  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editing]);

  const commit = () => {
    setEditing(false);
    setNoteText(id, draft);
  };
  const cancel = () => {
    setDraft(data.label);
    setEditing(false);
  };

  return (
    <div
      className={`nd nd-note ${selected ? 'sel' : ''} ${editing ? 'editing' : ''}`}
      style={
        {
          '--note-bg': tone.bg,
          '--note-line': tone.line,
          transform: `rotate(${tiltOf(id)})`,
        } as React.CSSProperties
      }
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(data.label);
        setEditing(true);
      }}
      title={editing ? undefined : '双击编辑'}
    >
      <Handle type="target" position={Position.Top} className="hnd" />
      <Handle type="source" position={Position.Bottom} className="hnd" />
      {editing ? (
        <textarea
          ref={taRef}
          className="note-edit nodrag nowheel"
          value={draft}
          maxLength={200}
          rows={3}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') cancel();
            // Enter 换行、⌘/Ctrl+Enter 提交：便签常是多行的，回车直接提交会毁掉排版
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
          }}
        />
      ) : (
        <div className="note-text">{data.label || '空便签'}</div>
      )}
      {data.noteSource ? (
        <div className="note-src" title={`钉自：${data.noteSource}`}>
          <Icon name="pin" size={10} />
          {data.noteSource}
        </div>
      ) : null}
      {selected && !editing ? (
        <>
          <div className="note-tones nodrag">
            {NOTE_TONES.map((t) => (
              <button
                key={t.key}
                className={`note-tone ${t.key === (data.noteTone ?? 'sun') ? 'on' : ''}`}
                style={{ background: t.bg, borderColor: t.line }}
                title={t.label}
                aria-label={`换成${t.label}色`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setNoteTone(id, t.key);
                }}
              />
            ))}
          </div>
          <Actions>
            <Act label="编辑" icon="edit" onClick={() => { setDraft(data.label); setEditing(true); }} />
            <Act
              label={copied === 'note' ? '已复制' : '复制'}
              icon="copy"
              onClick={() => void copy(data.label, 'note')}
            />
            <Act label="删除" icon="trash" tone="danger" onClick={() => requestDelete([id])} />
          </Actions>
        </>
      ) : null}
    </div>
  );
}

/**
 * 情报卡节点：深潜后钉在画布上的调研结论（P6-1 便签化）。
 *
 * 「便签化」不是换颜色，是把它的身份说清楚：这是**从侧栏拿到画布上的素材卡**
 * （指南 §4），不是用户的批注。所以纸白底 + 顶部来源条（哪种情报 + 哪来的），
 * 并给一个「钉为便签」把其中一句摘出来——素材和想法从此各归各位。
 */
export function IntelNode({ id, data, selected }: NodeProps<FlowNode>) {
  const requestDelete = useStore((s) => s.requestDelete);
  const pinNote = useStore((s) => s.pinNote);
  const c = data.intel;

  return (
    <div
      className={`nd nd-intel ${selected ? 'sel' : ''} ${data.converged ? 'conv' : ''}`}
      style={{ transform: `rotate(${tiltOf(id, 0.5)})` }}
    >
      <Handle type="target" position={Position.Left} className="hnd" />
      <Handle type="source" position={Position.Right} className="hnd" />
      <div className="intel-src" title="深潜从简报与竞品信息里提炼的素材卡，可以直接钉成便签用">
        <Icon name="doc" size={10} />
        <span className="intel-src-k">{c ? INTEL_LABEL[c.kind] ?? '调研素材' : '调研素材'}</span>
        <span className="intel-src-t">深潜提取</span>
      </div>
      <div className="nd-label">{data.label}</div>
      {c?.summary ? <div className="intel-sum">{c.summary}</div> : null}
      {c?.points?.length ? (
        <ul className="intel-pts">
          {c.points.slice(0, 4).map((p, i) => (
            <li key={i}>
              <span>{p.text}</span>
              <button
                className="intel-pin nodrag"
                title="把这一句钉成便签"
                aria-label="钉为便签"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void pinNote(p.text, `情报卡 · ${data.label}`, id);
                }}
              >
                <Icon name="pin" size={10} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {selected ? (
        <Actions>
          <Act
            label="钉为便签"
            icon="pin"
            onClick={() =>
              void pinNote(
                c?.summary || data.label,
                `情报卡 · ${data.label}`,
                id,
              )
            }
          />
          <Act label="删除" icon="trash" tone="danger" onClick={() => requestDelete([id])} />
        </Actions>
      ) : null}
    </div>
  );
}

/** 参考图节点：视觉资产层的载体 */
export function ImageNode({ id, data, selected }: NodeProps<FlowNode>) {
  const requestDelete = useStore((s) => s.requestDelete);
  const runVision = useStore((s) => s.runVision);
  const expanded = useStore((s) => s.expandedId === id);
  const imgs = data.images ?? [];
  const dims = data.visual?.dims ?? {};
  const have = VISION_DIMS.filter((d) => dims[d.key]);

  return (
    <div className={`nd nd-image ${selected ? 'sel' : ''} ${expanded ? 'exp' : ''} ${data.converged ? 'conv' : ''}`}>
      <Handle type="target" position={Position.Top} className="hnd" />
      <Handle type="source" position={Position.Bottom} className="hnd" />
      {imgs.length ? <Thumbs images={imgs} /> : <div className="pempty">还没有图</div>}
      <div className="nd-label">
        {data.label}
        <KeepBadge imageId={id} />
      </div>
      <LinkChip imageId={id} />
      {data.palette?.length ? <Palette colors={data.palette} /> : null}
      {data.busy ? (
        <div className="nd-sub">
          <Spinner /> AI 提取中…
        </div>
      ) : null}
      {/* P6-3：卡面只报「提了哪几维」，不摊结论——结论在参考图 tab，
          卡面一摊四段字就回到原来那坨读图结果了 */}
      {have.length ? (
        <div className="nd-dims">
          {have.map((d) => (
            <span key={d.key} className={`nd-dim-tag ${dims[d.key]!.from}`} title={`${d.label}：${dims[d.key]!.text}`}>
              {d.label}
            </span>
          ))}
        </div>
      ) : null}
      {!expanded && nodeHasDetail(data) ? <DetailToggle id={id} open={false} /> : null}
      {selected ? (
        <Actions>
          <PickImage nodeId={id} />
          {/* 四个按需动作，一次只问一件事。配色是本地算的（图不外传），
              另外三个才发图给模型——按钮上的顺序也按这个来 */}
          {VISION_DIMS.map((d) => (
            <Act
              key={d.key}
              label={`提取${d.label}`}
              icon={d.key === 'palette' ? 'palette' : 'eye'}
              tone={d.key === 'palette' ? 'default' : undefined}
              disabled={data.busy}
              onClick={() => void runVision(id, d.key)}
            />
          ))}
          <Act label="删除" icon="trash" tone="danger" onClick={() => requestDelete([id])} />
        </Actions>
      ) : null}
      {expanded ? <NodeBody nodeId={id} /> : null}
    </div>
  );
}


