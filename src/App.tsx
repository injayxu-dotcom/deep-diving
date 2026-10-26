import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { ConceptNode, ImageNode, IntelNode, NoteNode, SeedNode, WordNode } from './components/nodes';
import { ComboBar } from './components/ComboBar';
import { DimensionWheel } from './components/DimensionWheel';
import { LeftPanel } from './components/LeftPanel';
import { RightPanel } from './components/RightPanel';
import { ReportDrawer } from './components/ReportDrawer';
import { SettingsModal } from './components/SettingsModal';
import { StatusBar, type SyncState } from './components/StatusBar';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DocModal } from './components/DocModal';
import { SeedComposer } from './components/SeedComposer';
import { AlertDialog, ToastHost } from './components/Alerts';
import { DeleteDialog } from './components/DeleteDialog';
import { GuideModal } from './components/GuideModal';
import { ClarifyStage } from './components/ClarifyStage';
import { DivingStage } from './components/DivingStage';
import { ReportStage } from './components/ReportStage';
import { StageNav } from './components/StageNav';
import { MoreMenu, type MoreItem } from './components/MoreMenu';
import { Icon, type IconName } from './components/Icon';
import { BriefDock } from './components/BriefDock';
import { CanvasContextMenu, useContextMenu } from './components/CanvasContextMenu';
import { RediveDialog } from './components/RediveDialog';
import { SnapshotModal } from './components/SnapshotModal';
import { ProjectLibrary } from './components/ProjectLibrary';
import { useStore, isEmptyWorkspace, guideDismissed, type FlowNode } from './store/useStore';
import ddLogo from './assets/DD-logo.svg';
import { exportJSON, pullCloud } from './lib/storage';
import { cloudEnabled, cloudPing } from './lib/cloudApi';
import { NOTE_NEW, type AppSettings } from './types';
import { NODE_H, NODE_W } from './lib/layout';
import { useTidy } from './lib/useTidy';

const nodeTypes: NodeTypes = {
  seed: SeedNode,
  word: WordNode,
  concept: ConceptNode,
  intel: IntelNode,
  image: ImageNode,
  note: NoteNode,
};

function Canvas({ helpLabel, onHelp, onCloseHelp, hint, helpOpen }: {
  helpLabel: string;
  onHelp: () => void;
  onCloseHelp: () => void;
  hint: { text: string; action: () => void } | null;
  helpOpen: boolean;
}) {
  const allNodes = useStore((s) => s.nodes);
  const allEdges = useStore((s) => s.edges);
  const attachImages = useStore((s) => s.attachImages);
  /** 右键「添加参考图 / 挂载参考图」共用的文件选择器 + 它的落点。
   *  必须是 Canvas 级的 ref（而不是 CanvasContextMenu 内部），原因见下面 input 的注释。 */
  const imgPickRef = useRef<HTMLInputElement>(null);
  const imgTarget = useRef<{ nodeId: string | null; flow: { x: number; y: number } | null } | null>(null);


  // 折叠：隐藏在渲染期推导，不动节点坐标也不写 hidden 进持久化。
  // 连线两端只要有一端被收起就一并藏掉，否则会留下指向空气的悬空线。
  const { nodes, edges } = useMemo(() => {
    const hidden = new Set(useStore.getState().hiddenNodeIds());
    if (!hidden.size) return { nodes: allNodes, edges: allEdges };
    return {
      nodes: allNodes.map((n) => (hidden.has(n.id) ? { ...n, hidden: true } : n)),
      edges: allEdges.filter((e) => !hidden.has(e.source) && !hidden.has(e.target)),
    };
  }, [allNodes, allEdges]);
  const selectedId = useStore((s) => s.selectedId);
  const onNodesChange = useStore((s) => s.onNodesChange);
  const onEdgesChange = useStore((s) => s.onEdgesChange);
  const onConnect = useStore((s) => s.onConnect);
  const setSelected = useStore((s) => s.setSelected);
  const setSelection = useStore((s) => s.setSelection);
  const closeWheel = useStore((s) => s.closeWheel);
  const addNodeAt = useStore((s) => s.addNodeAt);
  const createImageNode = useStore((s) => s.createImageNode);
  const openWheel = useStore((s) => s.openWheel);
  const linkImageToConcept = useStore((s) => s.linkImageToConcept);
  // P5：撤销 / 重做。禁用态**保持可见**（Tapnow 同款做法）——
  // 藏起来的话，用户不知道「能不能撤」，更不知道有这个东西
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const { screenToFlowPosition, getViewport, setCenter, fitView } = useReactFlow();
  /* P6-4：工具坞的「+」popover。新建的便签/图片要落在**用户正看着的地方**，
     所以先算画布可视区中心，再交给 store 换算成画布坐标。 */
  const [createOpen, setCreateOpen] = useState(false);
  const addNote = useStore((s) => s.addNote);
  const createRef = useRef<HTMLDivElement>(null);
  /* 「+ 新建」浮层的关闭行为：点外部 / Esc。
     之前只有再点一次按钮才会收起 —— 而它盖在画布上，用户的第一反应是
     "点旁边就回去了"，结果点完浮层还在，得回头再找那个 + 号。
     用 pointerdown（capture）而不是 click：等 click 的话，落在画布上的那一手
     已经开始框选/拖拽了，浮层才慢半拍收掉，读起来像两个动作。 */
  useEffect(() => {
    if (!createOpen) return;
    const onDown = (e: PointerEvent) => {
      if (createRef.current?.contains(e.target as Node)) return;
      setCreateOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCreateOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [createOpen]);
  const flowCenter = useCallback(() => {
    const box = document.querySelector('.canvas-wrap')?.getBoundingClientRect();
    const p = box
      ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return screenToFlowPosition(p);
  }, [screenToFlowPosition]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const { menu, open: openMenu, close: closeMenu } = useContextMenu();

  const handleTidy = useTidy();

  // 选中项若落在视口外，平移过去。
  // 从左侧添加种子时如果画布正停在别处，用户会以为点了没反应。
  // 只在 selectedId 变化时判定，避免拖动节点时反复抢镜头。
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!selectedId) return;
    const n = useStore.getState().nodes.find((x) => x.id === selectedId);
    if (!n) return;
    const vp = getViewport();
    const cx = n.position.x + (n.measured?.width ?? NODE_W) / 2;
    const cy = n.position.y + (n.measured?.height ?? NODE_H) / 2;
    const sx = cx * vp.zoom + vp.x;
    const sy = cy * vp.zoom + vp.y;
    const el = wrapRef.current;
    const m = 60;
    if (!el) return;
    if (sx < m || sy < m || sx > el.clientWidth - m || sy > el.clientHeight - m) {
      setCenter(cx, cy, { zoom: vp.zoom, duration: 400 });
    }
  }, [selectedId, getViewport, setCenter]);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      // 图片文件 → 建图节点（视觉资产层的入口）
      const files = Array.from(event.dataTransfer.files ?? []).filter((f) => /^image\//i.test(f.type));
      if (files.length) {
        void createImageNode(files, position);
        return;
      }
      // 情报卡词条 → 建种子
      const text = event.dataTransfer.getData('application/dd-text');
      if (text) addNodeAt(text, position);
    },
    [screenToFlowPosition, addNodeAt, createImageNode],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  /**
   * P2：图节点 → 概念节点的拖放关联。
   *
   * 拖动过程中实时算「图节点中心落在哪个概念里」，写进 store.linkHintId
   * ——概念节点据此高亮，让用户在松手之前就知道会发生什么；松手时按同一次
   * 命中结果建立关联。判据用「中心点在内」而不是「矩形相交」：后者蹭到
   * 边角就连上了，而用户的意图表达是「把图放到这个概念上」。
   *
   * ⚠️ linkHintId 是瞬态（不 persist）：它只在拖拽会话里有意义，
   * 刷新后没有会话，留着只会误亮。
   */
  const onNodeDrag = useCallback((_e: MouseEvent | TouchEvent, dragged: FlowNode) => {
    if (dragged.data.kind !== 'image') {
      if (useStore.getState().linkHintId) useStore.setState({ linkHintId: null });
      return;
    }
    const all = useStore.getState().nodes;
    const w = dragged.measured?.width ?? NODE_W;
    const h = dragged.measured?.height ?? 200;
    const cx = dragged.position.x + w / 2;
    const cy = dragged.position.y + h / 2;
    const hit = all.find(
      (n) =>
        n.data.kind === 'concept' &&
        !!n.measured &&
        cx >= n.position.x &&
        cx <= n.position.x + (n.measured.width ?? NODE_W) &&
        cy >= n.position.y &&
        cy <= n.position.y + (n.measured.height ?? 200),
    );
    if ((hit?.id ?? null) !== useStore.getState().linkHintId) {
      useStore.setState({ linkHintId: hit?.id ?? null });
    }
  }, []);

  const onNodeDragStop = useCallback(
    (_e: MouseEvent | TouchEvent, dragged: FlowNode) => {
      const hint = useStore.getState().linkHintId;
      useStore.setState({ linkHintId: null });
      if (dragged.data.kind !== 'image' || !hint || hint === dragged.id) return;
      linkImageToConcept(dragged.id, hint);
    },
    [linkImageToConcept],
  );

  const flowPosOf = (e: React.MouseEvent) =>
    screenToFlowPosition({ x: e.clientX, y: e.clientY });

  return (
    <div
      className="canvas-wrap"
      ref={wrapRef}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onContextMenu={(e) => e.preventDefault()}
      /* 双击空白 = 就地新建种子词。之前双击在画布上是空手势（zoomOnDoubleClick
         早在 P6 就关了），把它接给"最常做的那件事"，比留空强。
         只认画布底：节点双击各有归属（种子词/延伸词开轮盘、便签就地编辑），
         MiniMap / Controls / 浮层都不是画布。
         `.react-flow__pane` 是内容层，`.react-flow__background` 是网格 —— 网格是
         pane 的兄弟节点而不是子节点，只判 pane 的话点网格点会漏掉。 */
      onDoubleClick={(e) => {
        const t = e.target as HTMLElement;
        if (!t.closest) return;
        if (
          t.closest('.react-flow__node') ||
          t.closest('.react-flow__minimap') ||
          t.closest('.react-flow__controls')
        )
          return;
        if (!t.closest('.react-flow__pane') && !t.closest('.react-flow__background')) return;
        openMenu({ x: e.clientX, y: e.clientY, flow: flowPosOf(e), nodeId: null, seed: true });
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => setSelected(n.id)}
        onPaneClick={() => {
          setSelected(null);
          closeWheel();
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          const ev = e as React.MouseEvent;
          openMenu({ x: ev.clientX, y: ev.clientY, flow: flowPosOf(ev), nodeId: null });
        }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          setSelected(n.id);
          openMenu({ x: e.clientX, y: e.clientY, flow: null, nodeId: n.id });
        }}
        onNodeDoubleClick={(_, n) => {
          if (n.data.kind === 'seed' || n.data.kind === 'word') openWheel(n.id);
        }}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        // F8：左键拖拽=框选，中/右键平移。
        // 多选键显式带上 Shift —— React Flow 默认只认 Meta/Ctrl，
        // 而 Windows 用户的肌肉记忆是 Shift+点击，不配就要么点不中要么被当成框选。
        selectionOnDrag
        panOnDrag={[1, 2]}
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        selectionMode={SelectionMode.Partial}
        onSelectionChange={(sel) => setSelection(sel.nodes.map((n) => n.id))}
        nodeTypes={nodeTypes}
        /* 2026-10-17 连线改弧线：smoothstep（直角折线）读起来像电路板走线，
           节点一多就是一张网格。simplebezier 会按两节点的相对位置自动选
           切线方向（上下相邻时控制点走垂直），比 default(bezier) 更稳——
           后者控制点永远水平，上下摞起来的节点会被拉出夸张的 S 弯。 */
        defaultEdgeOptions={{ type: 'simplebezier' }}
        connectionLineType={ConnectionLineType.SimpleBezier}
        connectionLineStyle={{ stroke: 'var(--tone-teal)', strokeWidth: 1.5 }}
        minZoom={0.15}
        maxZoom={2.2}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        /* P6：双击在便签上是「编辑这一句」，所以关掉 RF 默认的双击缩放——
           两个行为抢同一下手势，用户永远不知道双击会发生哪一件 */
        zoomOnDoubleClick={false}
      >
        {/* 网格点：2026-10-16 按风格指南 §4「间距约 40–48 px、线宽 1 px、低对比」调整。
            色值 #E6DED2 = --line（细网格），RF 的 color 是 SVG 属性不吃 var()，故写字面量。 */}
        <Background variant={BackgroundVariant.Dots} gap={42} size={1} color="#E6DED2" />
        <Controls showInteractive={false} />
        {/* MiniMap 在 0 节点时是**一个白盒子**：没有任何节点色块，只剩边框和遮罩，
            在空画布上看着像渲染坏了。所以有节点才渲染。
            ⚠️ styles.css 里 `.canvas-wrap:has(.nd.exp)` 那条淡出规则仍然保留 ——
            它管的是"详情卡展开时让开点击"，和这里的空态是两件事。 */}
        {nodes.length > 0 ? (
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => {
              /* 2026-10-16 暖化：与节点卡的真实配色对齐 ——
                 种子词是陶土大卡、概念是浅陶土、联想词是暖灰、情报卡是可可灰。
                 2026-10-17（P0-1）：陶土整族调浅后，种子/概念改用 aqua-600 / aqua-500
                 深浅两档，避免两个都在 #f2b987 附近、缩略图上分不开；
                 顺手补上批次 4 新增的便签（D9 sun 黄，用户的声音在缩略图上也要认得出）。 */
              const k = (n.data as { kind?: string }).kind;
              if (k === 'seed') return '#E0A06E';
              if (k === 'concept') return '#F2B987';
              if (k === 'note') return '#F5D98D';
              if (k === 'image') return '#C9800A';
              if (k === 'intel') return '#A29386';
              return '#D9CFC2';
            }}
            maskColor="rgba(58,42,32,0.06)"
          />
        ) : null}
        <DimensionWheel />
      </ReactFlow>

      {/* 浮层卡片：都在 .canvas-wrap 内、居中于**画布**。
          两张都在顶部（top:14px），不会同时出现：hintbar 要 staleProduct（0 节点），
          而 0 节点时工具条上那个键是「查看引导」，走 guide 模态、不渲染 .helpbar。
          底部那条竖列是 .float-tools + .combo-bar，见下面 .combo-bar 的样式注释。 */}
      {helpOpen ? <HelpBar onClose={onCloseHelp} /> : null}
      {hint ? (
        <div className="hintbar">
          <span>{hint.text}</span>
          <button className="btn sm" onClick={hint.action}>
            去澄清
          </button>
        </div>
      ) : null}

      {/* 画布浮动工具条：底部居中。
          这三项（适应视图 / 整理布局 / 操作说明）是**视图操作**，不是应用级命令 ——
          它们的作用域就是这个画布，所以归画布，不归顶栏。
          （第 6 步曾先把它们收进顶栏 ⋯ 菜单作过渡，第 7 步搬到这里、菜单里随即删掉。）
          与深化稿逐项一致：bottom 14px / 高 38 / pad 4 / gap 2 / 圆角胶囊 /
          --glass + blur(14px) saturate(150%) / --sh-3。
          ⚠️ 没有把「导出」搬进来：第 6 步把它定为顶栏动作区成员（作用域是整个工作区），
             而深化稿的默认顶栏正是精简后不含导出的那一版。 */}
      {/* P5：撤销 / 重做常驻在画布工具条上，且**跟视图操作相邻**——
          它们都是"对画布的操作"，不是应用级命令。禁用态保留可见：
          藏起来的话用户既不知道能不能撤，也不知道有这个功能。 */}
      <div className="float-tools">
        {/* P6-4：快捷创建。Tapnow 的速添在侧栏，本项目的侧栏是「把素材放进来」
            （简报 / 参考图 / 深潜），所以创建动作归到画布工具坞里来的这一格。
            三样东西对应画布上三种可创建的对象；种子词仍以空态中央卡为首入口，
            这里是第二次之后的通道（和批次 1 的入口分工一致）。 */}
        <div className="float-create" ref={createRef}>
          <button
            className={`float-tool ${createOpen ? 'on' : ''}`}
            onClick={() => setCreateOpen((o) => !o)}
            data-act="create"
            title="新建：便签 / 图片 / 种子词"
            aria-label="新建：便签 / 图片 / 种子词"
            aria-expanded={createOpen}
          >
            <Icon name="plus" /> <span className="ft-t">新建</span>
          </button>
          {createOpen ? (
            <div className="create-pop" role="menu">
              <button
                className="create-i"
                data-act="create-note"
                onClick={() => {
                  addNote(NOTE_NEW, flowCenter(), true);
                  setCreateOpen(false);
                }}
              >
                <Icon name="note" size={13} />
                <span className="create-t">便签</span>
                <span className="create-h">写一句，贴在思考现场</span>
              </button>
              <button
                className="create-i"
                data-act="create-image"
                onClick={() => {
                  // 复用画布层那个常驻的 file input（右键菜单走的是同一条路）
                  imgTarget.current = { nodeId: null, flow: flowCenter() };
                  imgPickRef.current?.click();
                  setCreateOpen(false);
                }}
              >
                <Icon name="image" size={13} />
                <span className="create-t">图片</span>
                <span className="create-h">挂参考图，可四维提取</span>
              </button>
              <div className="create-i static" data-act="create-seed">
                <Icon name="seed" size={13} />
                <span className="create-t">种子词</span>
                <span className="create-h">一个词，长出一整枝</span>
              </div>
              <SeedComposer size="sm" autoFocus placeholder="例如：灼烧感" />
            </div>
          ) : null}
        </div>
        <span className="float-div" aria-hidden="true" />
        <button
          className="float-tool"
          onClick={undo}
          disabled={!canUndo}
          data-act="undo"
          title="撤销（Ctrl/⌘ + Z）"
          aria-label="撤销"
        >
          <Icon name="undo" /> <span className="ft-t">撤销</span>
        </button>
        <button
          className="float-tool"
          onClick={redo}
          disabled={!canRedo}
          data-act="redo"
          title="重做（Ctrl/⌘ + Shift + Z）"
          aria-label="重做"
        >
          <Icon name="redo" /> <span className="ft-t">重做</span>
        </button>
        <span className="float-div" aria-hidden="true" />
        <button
          className="float-tool"
          onClick={() => fitView({ padding: 0.25, duration: 400 })}
          data-act="fit"
          title="适应视图"
          aria-label="适应视图"
        >
          <Icon name="fit" /> <span className="ft-t">适应视图</span>
        </button>
        <button
          className="float-tool"
          onClick={handleTidy}
          disabled={allNodes.length < 2}
          data-act="tidy"
          title="整理布局"
          aria-label="整理布局"
        >
          <Icon name="tidy" /> <span className="ft-t">整理布局</span>
        </button>
        <span className="float-div" aria-hidden="true" />
        <button className="float-tool" onClick={onHelp} data-act="help" title={helpLabel} aria-label={helpLabel}>
          <Icon name="help" /> <span className="ft-t">{helpLabel}</span>
        </button>
      </div>

      {/* 右键菜单的「添加参考图 / 挂载参考图」共用的文件选择器。
          ⚠️ 刻意放在**常驻**的画布层、而不是 CanvasContextMenu 内部：
          点菜单项会 onClose() → menu 变 null → 那个组件整个卸载，
          放在它里面的 input 会在用户选完文件之前就从 DOM 消失，
          change 永远不触发 —— 表现是「文件选完了，什么也没发生，且不报错」。
          （节点右键的「挂载参考图」此前一直是坏的，就是这个原因。） */}
      <input
        ref={imgPickRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-act="canvas-img-pick"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // 清空 value：否则连续选同一个文件第二次不触发 change
          e.target.value = '';
          const t = imgTarget.current;
          imgTarget.current = null;
          if (files.length && t) {
            if (t.nodeId) void attachImages(t.nodeId, files);
            else if (t.flow) void createImageNode(files, t.flow);
          }
        }}
      />

      {/* F8：多选批量操作条（选中 ≥2 时浮现） */}
      <ComboBar />

      {/* 项目简报常驻画布：视线不用再跑到边上找简报 */}
      <BriefDock />

      {menu ? (
        <CanvasContextMenu
          menu={menu}
          onClose={closeMenu}
          onTidy={handleTidy}
          onFit={() => fitView({ padding: 0.25, duration: 400 })}
          onPickImages={(t) => {
            // 目标在点菜单那一刻就抓下来：此刻 menu 已被清空，再读就没了
            imgTarget.current = t;
            imgPickRef.current?.click();
          }}
        />
      ) : null}

      {nodes.length === 0 ? <CanvasEmpty /> : null}
    </div>
  );
}

/** 空画布指引。自动播种去掉后，这里是"直接进画布"用户看到的第一个界面 */
function CanvasEmpty() {
  return (
    <div className="canvas-empty">
      <div className="ce-card">
        <div className="ce-t">输入一个词开始</div>
        <div className="ce-s">它会成为第一颗种子。双击种子，可以沿六个维度裂变出更多词。</div>
        <SeedComposer size="lg" autoFocus placeholder="一个词，例如：锈蚀" />
        <div className="ce-or">或者</div>
        <div className="ce-s">
          在左栏填好项目名，点「开始深潜」，让 AI 从简报里替你挖出种子词。
        </div>
      </div>
    </div>
  );
}

/** 侧栏开合是设备级偏好（跟「不再弹引导」同理），不跟工作区内容上云 */
const PANEL_KEY = 'dd.panels';

function usePanels() {
  const [panels, setPanels] = useState(() => {
    try {
      const raw = localStorage.getItem(PANEL_KEY);
      if (raw) return { left: true, right: true, ...(JSON.parse(raw) as Record<string, boolean>) };
    } catch {
      /* 读不到就按默认全开 */
    }
    return { left: true, right: true };
  });
  /** 收起把手上点了区块图标时要滚到的那一区；被面板消费掉之后清空 */
  const [pendingSec, setPendingSec] = useState<string | null>(null);

  const persist = (next: { left: boolean; right: boolean }) => {
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式下写不进去也不影响本次会话 */
    }
    return next;
  };

  const toggle = (side: 'left' | 'right') => {
    setPanels((p) => persist({ ...p, [side]: !p[side] }));
    setPendingSec(null); // 手动开合不带锚点，否则下次展开会莫名滚一下
  };

  /** 从收起把手展开；带 secId 时展开后还要滚到那一区 */
  const open = (side: 'left' | 'right', secId?: string) => {
    setPanels((p) => persist({ ...p, [side]: true }));
    setPendingSec(secId ?? null);
  };

  /* 必须稳定引用：它会进 useFocusSec 的依赖数组，每次渲染换一个新函数的话
     effect 会反复跑，滚动就会一顿一顿地重来。 */
  const clearPending = useCallback(() => setPendingSec(null), []);

  return { panels, toggle, open, pendingSec, clearPending };
}

function Shell() {
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  /* 底部状态栏用的云端同步状态。每次设置变化或启动时主动探测一次，
     所以"填好令牌立刻变已连接"不需要刷新页面。 */
  const [sync, setSync] = useState<SyncState>('off');

  const [docOpen, setDocOpen] = useState(false);
  const stage = useStore((s) => s.stage);
  const apiKey = useStore((s) => s.settings.apiKey);
  const resetCanvas = useStore((s) => s.resetCanvas);
  const report = useStore((s) => s.report);
  const reportOpen = useStore((s) => s.reportOpen);
  const setReportOpen = useStore((s) => s.setReportOpen);
  const product = useStore((s) => s.product);
  const goClarify = useStore((s) => s.goClarify);
  const clarifyCount = useStore((s) => s.clarify.length);
  const nodeCount = useStore((s) => s.nodes.length);

  const { panels, toggle, open, pendingSec, clearPending } = usePanels();
  const settings = useStore((s) => s.settings);

  /** 探测当前设置下云端是否可达 → 四档状态。
   *
   * 用 cloudPing（只读 GET）而不是 pullCloud：后者会把云端工作区 hydrate 进本地，
   * 那是"同步数据"；这里只想知道"通不通"，不该顺带覆盖用户本地的内容。
   *
   * ⚠️ 「没填令牌」必须排在探测**之前**：没填令牌时请求照样发出去、照样吃一个
   * 403，若按探测结果优先就会显示"连接失败"，把用户引去排查网络 ——
   * 而他真正该做的只是填一个值。 */
  const probeSync = useCallback(async (s: AppSettings): Promise<SyncState> => {
    if (!cloudEnabled(s)) return 'off';
    if (!s.cloudToken.trim()) return 'no-token';
    try {
      await cloudPing(s);
      return 'ok';
    } catch {
      return 'error';
    }
  }, []);

  /* 设置变了就重新探测。
     ⚠️ 刻意**不**重新 pullCloud —— 用户可能正在改设置，hydrate 会把他本地
     的内容覆盖成云端的（哪怕云端只是旧存档）。这一条是第 11.7 节那条设计限制的正解。 */
  useEffect(() => {
    let alive = true;
    void probeSync(settings).then((st) => {
      if (alive) setSync(st);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiBase, settings.cloudToken]);
  const hydrateFromCloud = useStore((s) => s.hydrateFromCloud);
  const openGuide = useStore((s) => s.openGuide);
  const openSnapshots = useStore((s) => s.openSnapshots);
  // 空态下「操作说明」换成「查看引导」：这时候用户要的不是快捷键清单，是这套流程怎么走
  const empty = useStore(isEmptyWorkspace);

  // PRD 10.4：只填了项目名、从未深潜的老用户 → 顶栏补一条去澄清的提示
  const staleProduct = stage === 'canvas' && !!product.trim() && !report && clarifyCount === 0 && nodeCount === 0;

  // 启动后尝试从云端拉取更新的工作区（多设备同步）。
  // 仅在云端更新时才覆盖本地；拉取失败静默回退到本地。
  useEffect(() => {
    let alive = true;
    // 引导必须等云端拉取完再判定：本地是空的、云端有存档时，
    // 先 hydrate 才不会对着一个已有内容的工作区弹「欢迎使用」。
    const maybeGuide = () => {
      if (alive && !guideDismissed() && isEmptyWorkspace(useStore.getState())) openGuide();
    };
    /* 拉云端只为拿数据（hydrate），**失败不决定状态** ——
       状态由下面的 probeSync 负责。两者分开是因为职责不同：
         pullCloud 会**覆盖本地工作区**，不能在用户改设置时被随意调用；
         cloudPing 只发一个 GET 探可达性，是纯粹的探测。 */
    pullCloud(settings)
      .then((p) => {
        if (alive && p) hydrateFromCloud(p);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) void probeSync(settings).then((st) => alive && setSync(st));
        maybeGuide();
      });
    return () => {
      alive = false;
    };
    // 仅在首次挂载时拉一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * P5：撤销 / 重做快捷键。
   *
   * 输入框里不拦 —— 在那儿 Ctrl+Z 是「撤掉刚打的字」，属于浏览器原生行为，
   * 抢过来会把正在写简报 / 调整说明的人打断。
   * Cmd（macOS）与 Ctrl（Windows）都认：两套键盘的肌肉记忆不同，但都指向同一个动作。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (stage !== 'canvas') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) useStore.getState().redo();
        else useStore.getState().undo();
      } else if (k === 'y') {
        // Windows 习惯：Ctrl+Y 也是重做
        e.preventDefault();
        useStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage]);

  /**
   * 「⋯ 更多」里的项。
   *
   * 第 6 步时这里有 5 项；第 7 步把 `整理布局 / 适应视图 / 操作说明` 三项**移走**了 ——
   * 它们是"视图操作"，作用域是画布，归 `.float-tools` 画布浮动工具条（见 Canvas）。
   * 菜单里现在只剩两项真正的应用级命令：**交付文档**（依赖简报）与**清空**（唯一不可逆）。
   *
   * ⚠️ 菜单里同时容得下"清空"这种破坏性操作的唯一理由，是它**单独成项**：
   * 危险色 + 分隔线 + 一句后果。别再往里加平级的普通命令，否则这个区分就没了。
   */
  const moreItems: MoreItem[] = [
    {
      key: 'doc', icon: 'delivery', label: '交付文档',
      hint: report ? undefined : '还没有简报',
      disabled: !report,
      onClick: () => setDocOpen(true),
    },
    {
      /* P5：阶段快照。放在「清空」之前 —— 它是清空的**反向保险**：
         要清空的人可以先存一份，清空本身也能用撤销退回。 */
      key: 'snap', icon: 'layers', label: '阶段快照',
      hint: '存档 / 恢复画布',
      onClick: () => openSnapshots(),
    },
    {
      /* 唯一不可逆的操作。原来它和「操作说明」并排、同色同大小 —— 误点成本不成比例。
         收进菜单之后才有位置表达"这一项不一样"：危险色 + 分隔线 + 一句后果。 */
      key: 'clear', icon: 'trash', label: '清空', hint: '不可撤销',
      danger: true,
      onClick: () => setConfirmClear(true),
    },
  ];

  return (
    <div className="app">
      {stage === 'canvas' ? (
        <>
          <header className="topbar">
        <div className="brand">
          {/* 顶栏 / 画布左上角：完整插画，与澄清首屏、简报页、引导弹窗同一张图。
              之前这里是一个 17px 的眼睛向量标 —— 三处 hero 用插画、导航位用图标，
              同一个品牌在两处长得不一样，等于没有标识。 */}
          <span className="brand-mark">
            <img src={ddLogo} alt="" aria-hidden="true" />
          </span>
          <span className="brand-txt">
            <h1 className="brand-name">创意深潜</h1>
            <span className="brand-sub">Deep Diving</span>
          </span>
        </div>

        {/* 阶段指示器：把「澄清需求 / 深潜简报」从动作堆里拿出来当导航。
            位置与深化稿一致 —— 紧跟品牌，右侧留白交给 .topbar-spacer 撑开。 */}
        <StageNav />

        <span className="topbar-spacer" />

        <div className="topbar-actions">
          {/* 「调研洞察」= AI 深潜的结构化产出（行业/竞品/视觉/SWOT）。
              批次 1 从阶段指示器里移出来：导航三段只回答"我在哪、能回哪"，
              内容入口归动作区。disabled 条件与「交付文档」一致——没有调研就没有可看的。 */}
          <button
            className="btn ghost sm"
            disabled={!report}
            title={report ? '查看 AI 调研洞察' : '还没有调研洞察——先在左栏填项目名，点「开始深潜」'}
            onClick={() => setReportOpen(true)}
            data-act="insights"
          >
            <Icon name="sparkles" /> 调研洞察
          </button>
          {/* 「配置 API Key」与「AI 设置」原本是两个按钮、同一个动作（都开设置弹窗）。
              ④ 把主行动点统一成青色渐变之后，两个青色按钮并排会互相抢注意力 ——
              所以合成一个：没配 key 时它是「配置 API Key」，配好了就变回「AI 设置」，
              两种状态都是顶栏唯一的主行动点（与稿子一致）。 */}
          <button
            className="btn pri sm"
            title={apiKey ? 'AI 设置' : '还没配 AI 接口 —— 配好才能开始深潜'}
            onClick={() => setShowSettings(true)}
            data-act="settings"
          >
            <Icon name={apiKey ? 'settings' : 'key'} /> {apiKey ? 'AI 设置' : '配置 API Key'}
          </button>
          <button className="btn ghost sm" onClick={() => setShowProjects(true)} data-act="projects">
            <Icon name="tidy" /> 项目库
          </button>
          <button className="btn ghost sm" onClick={exportJSON} data-act="export">
            <Icon name="export" /> 导出
          </button>
          <MoreMenu items={moreItems} />
        </div>
      </header>

      {/* ⚠️ 这两条原来是**流内**的全宽条（插在顶栏和 .body 之间），
          一出现就把画布整体往下推 —— 而且它们本来就浮在画布语境里，
          没理由占一条版面。改成 `.canvas-wrap` 里的浮层卡片：
          位置相对**画布**居中（不是相对窗口），所以左右面板开合时它跟着画布走，
          不会出现"工具条在画布中心、提示卡在窗口中心"的错位。
          帮助卡锚在工具条正上方（触发它的入口就在工具条上）；
          提示条锚在画布顶部居中（它是主动提示，与底部的工具条不是一类）。 */}
      <main className="body">
        {panels.left ? (
          <LeftPanel onCollapse={() => toggle('left')} focusSec={pendingSec} onFocused={clearPending} />
        ) : (
          <SideRail side="left" label="项目" onOpen={() => open('left')} onJump={(id) => open('left', id)} />
        )}
        <Canvas
          helpLabel={empty ? '查看引导' : '操作说明'}
          onHelp={() => (empty ? openGuide() : setShowHelp((v) => !v))}
          onCloseHelp={() => setShowHelp(false)}
          hint={
            staleProduct
              ? {
                text: `已记录项目「${product.trim()}」，但还没有项目简报——先做一轮需求澄清，深潜会更准。`,
                action: goClarify,
              }
              : null
          }
          helpOpen={showHelp}
        />
        {panels.right ? (
          <RightPanel onCollapse={() => toggle('right')} focusSec={pendingSec} onFocused={clearPending} />
        ) : (
          <SideRail side="right" label="评分 · 日志" onOpen={() => open('right')} onJump={(id) => open('right', id)} />
        )}
      </main>

      {/* 底部状态栏：流内 footer（30px），横跨三栏。
          只在画布阶段出现 —— 澄清 / 简报是两个整页，没有"画布当前状态"可言。 */}
      <StatusBar sync={sync} onOpenSettings={() => setShowSettings(true)} />

      {reportOpen ? <ReportDrawer onClose={() => setReportOpen(false)} /> : null}
      {docOpen ? <DocModal onClose={() => setDocOpen(false)} /> : null}
      {showSettings ? <SettingsModal onClose={() => setShowSettings(false)} /> : null}

      {confirmClear ? (
        <ConfirmDialog
          title="清空全部内容？"
          body="会删除画布上所有节点与连线、深潜简报、情报卡片、上传的参考资料和补充方向。<br><br><b>项目名称与 AI 接口设置会保留。</b><br>此操作不可撤销，建议先「导出」备份。"
          okText="确认清空"
          danger
          onConfirm={() => {
            resetCanvas();
            setConfirmClear(false);
          }}
          onCancel={() => setConfirmClear(false)}
        />
      ) : null}
        </>
      ) : stage === 'report' ? (
        <ReportStage />
      ) : stage === 'diving' ? (
        <DivingStage />
      ) : (
        <ClarifyStage />
      )}

      {/* 全局反馈层与通用弹层：无论处于哪个 stage 都要能弹出 */}
      <AlertDialog />
      <ToastHost />
      <DeleteDialog />
      <GuideModal />
      <RediveDialog />
      <SnapshotModal />
      {showProjects ? <ProjectLibrary onClose={() => setShowProjects(false)} /> : null}
    </div>
  );
}

/**
 * 收起把手上能直达的区块。id 必须和 LeftPanel / RightPanel 里的 data-sec 对上。
 * 只挑最常回看的几个 —— 把 7 个区块全列上就成了目录，反而更找不着。
 *
 * ⚠️ 把手上的按钮挂 `data-rail-sec`，**刻意不叫 data-sec**。
 * useFocusSec 是靠 `[data-sec="x"]` 找目标区块的；如果把手按钮也叫 data-sec，
 * 就出现了同名节点。今天不会错（点图标时面板还没渲染、把手已卸载），
 * 但那是"赌渲染顺序"，不是"设计上不可能"。两个用途给两个属性，就没有这个问题。
 */
const RAIL_SECS: Record<'left' | 'right', { id: string; icon: IconName; title: string }[]> = {
  left: [
    { id: 'brief', icon: 'doc', title: '项目简报' },
    { id: 'intel', icon: 'sparkles', title: '情报卡片墙' },
    { id: 'refs', icon: 'clip', title: '参考资料' },
  ],
  right: [
    { id: 'quad', icon: 'target', title: 'Now-How-Wow' },
    { id: 'rank', icon: 'gauge', title: '行动建议' },
    { id: 'logs', icon: 'list', title: '运行日志' },
  ],
};

/**
 * 侧栏收起后的把手。
 *
 * 26 → 46px：26px 只放得下箭头和竖排标题，整条近千像素全是空白，
 * 既浪费、也让人看不出「这里能点」。46px 够并排放下一列区块图标。
 * 点顶部区域 = 展开；点图标 = 展开并滚到该区块。
 */
function SideRail({ side, label, onOpen, onJump }: {
  side: 'left' | 'right';
  label: string;
  onOpen: () => void;
  onJump: (secId: string) => void;
}) {
  return (
    <div className={`side-rail ${side}`}>
      <button
        className="side-rail-head"
        onClick={onOpen}
        title={`展开「${label}」`}
        aria-label={`展开${label}`}
      >
        <Icon name={side === 'left' ? 'chevronRight' : 'chevronLeft'} size={14} />
        <span className="side-rail-t">{label}</span>
      </button>
      <div className="side-rail-secs">
        {RAIL_SECS[side].map((s) => (
          <button
            key={s.id}
            className="side-rail-sec"
            data-rail-sec={s.id}
            onClick={() => onJump(s.id)}
            title={`展开并跳到「${s.title}」`}
            aria-label={`展开并跳到${s.title}`}
          >
            <Icon name={s.icon} size={15} />
          </button>
        ))}
      </div>
      {/* 下方留白同样可点展开 —— 手感上「点空白也能开」比只剩顶部一小块大得多。
         是装饰性热区（键盘用户走上面的真按钮），所以 tabIndex=-1 且对读屏隐藏。 */}
      <button className="side-rail-rest" onClick={onOpen} tabIndex={-1} aria-hidden="true" />
    </div>
  );
}

function HelpBar({ onClose }: { onClose: () => void }) {
  return (
    <div className="helpbar">
      <div className="help-items">
        <span>
          <b>左栏填项目名 → 开始深潜</b> 一次产出简报 + 情报卡 + 种子词
        </span>
        <span>
          <b>双击节点</b> 打开六维裂变轮盘
        </span>
        <span>
          <b>拖节点圆点连线</b> AI 判定共性 / 对立 / 递进
        </span>
        <span>
          <b>图片拖进画布</b> 建参考图节点，自动取色；「AI 读图」需视觉模型
        </span>
      </div>
      <button className="icon-btn" onClick={onClose} aria-label="关闭">
        ×
      </button>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Shell />
    </ReactFlowProvider>
  );
}
