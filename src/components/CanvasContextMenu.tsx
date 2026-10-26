import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { NOTE_NEW } from '../types';
import { Icon, type IconName } from './Icon';

/**
 * 画布右键菜单。
 *
 * 分两套：空白处（新建种子词 / 新建便签 / 添加参考图 / 整理布局 / 适应视图 / 取消选择）
 * 与节点上（裂变 / 简报 / 评分 / 收敛 / 折叠 / 加图 / 删除）。
 * 多选时额外给「组合收敛」。
 *
 * 新建种子词与便签都要带落点——右键在哪，东西就长在哪，省一次拖拽。
 */

export interface MenuState {
  x: number;
  y: number;
  /** 画布流坐标，仅空白处右键时有 */
  flow: { x: number; y: number } | null;
  nodeId: string | null;
  /** 打开即进入「输入种子词」态：双击空白处走这条（省掉"再点一次菜单项"） */
  seed?: boolean;
}

export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const open = useCallback((s: MenuState) => setMenu(s), []);
  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    // 画布一缩放/平移，屏幕坐标就对不上了，直接关掉比追着更新坐标简单
    const onWheel = () => setMenu(null);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', close);
    };
  }, [menu, close]);

  return { menu, open, close };
}

interface Item {
  key: string;
  label: string;
  icon: IconName;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
  /** 默认点完就关；「新建种子词」要留在菜单里输入词，所以显式关掉这个行为 */
  closeAfter?: boolean;
}

export function CanvasContextMenu({
  menu,
  onClose,
  onTidy,
  onFit,
  onPickImages,
}: {
  menu: MenuState;
  onClose: () => void;
  onTidy: () => void;
  onFit: () => void;
  /**
   * 打开文件选择器，目标 = 挂到这个节点 / 在这个坐标新建。
   *
   * ⚠️ 为什么由**父层**持有那个 `<input type=file>`，而不是放在这里：
   * 点菜单项会 `onClose()` → menu 变 null → **本组件整个卸载**，
   * 放在这里的 input 在用户还没选完文件时就从 DOM 里消失了，
   * change 事件永远不触发。实测就是「文件选完了，什么也没发生，且不报错」。
   * 挂在常驻的画布层才活得下来。
   */
  onPickImages: (target: { nodeId: string | null; flow: { x: number; y: number } | null }) => void;
}) {
  const nodes = useStore((s) => s.nodes);
  const selection = useStore((s) => s.selection);
  const addNodeAt = useStore((s) => s.addNodeAt);
  const addNote = useStore((s) => s.addNote);
  const clearSelection = useStore((s) => s.clearSelection);
  const openWheel = useStore((s) => s.openWheel);
  const runBrief = useStore((s) => s.runBrief);
  const runScore = useStore((s) => s.runScore);
  const runPrompts = useStore((s) => s.runPrompts);
  const runCombo = useStore((s) => s.runCombo);
  const toggleConverge = useStore((s) => s.toggleConverge);
  const toggleCollapse = useStore((s) => s.toggleCollapse);
  const requestDelete = useStore((s) => s.requestDelete);
  const linkImageToConcept = useStore((s) => s.linkImageToConcept);
  const unlinkImageFromConcept = useStore((s) => s.unlinkImageFromConcept);

  const [newSeed, setNewSeed] = useState('');
  /* 双击空白处直接进输入态（见 MenuState.seed）。菜单是条件渲染的，
     每次打开都是新挂载，所以初值取一次就够，不需要再同步。 */
  const [seeding, setSeeding] = useState(!!menu.seed);
  /** P2：图节点右键「关联到概念…」展开的概念列表态（与 seeding 同款：菜单内换内容） */
  const [linking, setLinking] = useState(false);
  const node = menu.nodeId ? nodes.find((n) => n.id === menu.nodeId) : null;
  const concepts = useMemo(() => nodes.filter((n) => n.data.kind === 'concept'), [nodes]);

  const runItem = (it: Item) => {
    it.run();
    if (it.closeAfter !== false) onClose();
  };

  /* 菜单贴边回收：右键 / 双击都可能落在画布右下角，菜单是 position: fixed、
     直接以光标为左上角，超出视口的那一截正好是「创建」按钮 —— 功能就在眼前够不着。
     在 paint 前量一次尺寸再夹回视口内，不会看到跳动。
     没有依赖数组是有意的：菜单在 seeding/linking 之间切换时高度会变，得重新夹一次；
     靠 setState 的对象同一性判断收口，不会形成死循环。 */
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(menu.x, window.innerWidth - b.width - pad));
    const top = Math.max(pad, Math.min(menu.y, window.innerHeight - b.height - pad));
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  });

  const nodeItems: Item[] = node
    ? [
        ...(node.data.kind === 'seed' || node.data.kind === 'word'
          ? [
              {
                key: 'wheel',
                label: node.data.kind === 'seed' ? '六维裂变' : '继续裂变',
                icon: 'sparkles' as IconName,
                disabled: !!node.data.busy,
                run: () => void openWheel(node.id),
              },
            ]
          : []),
        ...(node.data.kind === 'word'
          ? [
              {
                key: 'brief',
                label: '生成创意简报',
                icon: 'doc' as IconName,
                disabled: !!node.data.busy,
                run: () => void runBrief(node.id),
              },
            ]
          : []),
        ...(node.data.kind === 'concept'
          ? [
              {
                key: 'score',
                label: 'AI 评分',
                icon: 'gauge' as IconName,
                disabled: !!node.data.busy,
                run: () => void runScore(node.id),
              },
              {
                key: 'prompts',
                label: '生成提示词',
                icon: 'wand' as IconName,
                disabled: !!node.data.busy || !node.data.brief,
                run: () => void runPrompts(node.id),
              },
            ]
          : []),
        {
          key: 'converge',
          label: node.data.converged ? '取消收敛' : '收敛这个词',
          icon: 'target',
          run: () => toggleConverge(node.id),
        },
        {
          key: 'collapse',
          label: node.data.collapsed ? '展开延伸词' : '收起延伸词',
          icon: 'layers',
          run: () => toggleCollapse(node.id),
        },
        {
          key: 'image',
          label: '挂载参考图',
          icon: 'image',
          run: () => onPickImages({ nodeId: node.id, flow: menu.flow }),
        },
        ...(node.data.kind === 'image'
          ? [
              {
                key: 'link',
                label: node.data.linkedConceptId ? '改关联到概念…' : '关联到概念…',
                icon: 'link' as IconName,
                run: () => setLinking(true),
                closeAfter: false,
              },
            ]
          : []),
        {
          key: 'del',
          label: '删除',
          icon: 'trash',
          danger: true,
          run: () => requestDelete([node.id]),
        },
      ]
    : [];

  const paneItems: Item[] = [
    {
      key: 'seed',
      label: '在此新建种子词',
      icon: 'seed',
      run: () => setSeeding(true),
      closeAfter: false,
    },
    {
      /* 便签与种子词同为「内容创建」，排在种子词后面：种子词是这套流程的主料，
         便签是旁注。`draft = true` 让便签一落地就进编辑态（与工具条那条路径同一个行为）——
         右键点完还要再双击一次才能写字，等于这个入口白给。 */
      key: 'note',
      label: '在此新建便签',
      icon: 'note',
      run: () => {
        if (menu.flow) addNote(NOTE_NEW, menu.flow, true);
      },
    },
    {
      /* 在右键位置新建一个 image 节点。
         与**节点**右键的「挂载参考图」是两件事：那个把图挂到已有节点上（attachImages），
         这个画布空白处没有节点可挂，所以走 createImageNode 在原地建一个。
         放第二项是因为它和「新建种子词」同属**内容创建**，而 tidy/fit 是视图操作 ——
         分组跟阅读顺序一致，不用逐项解释。 */
      key: 'add-img',
      label: '添加参考图',
      icon: 'image',
      run: () => onPickImages({ nodeId: null, flow: menu.flow }),
    },
    {
      key: 'tidy',
      label: '整理布局',
      icon: 'tidy',
      run: onTidy,
    },
    {
      key: 'fit',
      label: '适应视图',
      icon: 'fit',
      run: onFit,
    },
    ...(selection.length > 1
      ? [
          {
            key: 'combo',
            label: `组合收敛这 ${selection.length} 个词`,
            icon: 'sparkles' as IconName,
            run: () => void runCombo(selection),
          },
        ]
      : []),
    ...(selection.length
      ? [
          {
            key: 'unselect',
            label: '取消选择',
            icon: 'x' as IconName,
            run: () => clearSelection(),
          },
        ]
      : []),
  ];

  const items = node ? nodeItems : paneItems;

  const submitSeed = () => {
    const w = newSeed.trim();
    if (!w || !menu.flow) return;
    addNodeAt(w, menu.flow);
    setNewSeed('');
    setSeeding(false);
    onClose();
  };

  return (
    <>
      <div className="ctx-mask" onPointerDown={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div
        className="ctx-menu"
        ref={boxRef}
        style={{ left: pos.left, top: pos.top }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {linking && node ? (
          /* P2：图节点右键「关联到概念…」的概念列表。
             拖放是主路径（把图拖到概念上），这里服务「概念挨得太远拖不过去」
             与「想改挂到别个概念」——多概念时逐个试太折磨。 */
          <div className="ctx-link">
            <div className="ctx-link-t">关联到概念</div>
            {concepts.length ? (
              concepts.map((c) => (
                <button
                  key={c.id}
                  className={`ctx-i ${node.data.linkedConceptId === c.id ? 'on' : ''}`}
                  onClick={() => {
                    linkImageToConcept(node.id, c.id);
                    onClose();
                  }}
                >
                  <Icon name="target" size={13} />
                  {c.data.label}
                  {node.data.linkedConceptId === c.id ? <span className="ctx-link-cur">当前</span> : null}
                </button>
              ))
            ) : (
              <div className="ctx-link-empty">画布上还没有概念节点——先给一个词跑「一键出方案」</div>
            )}
            {node.data.linkedConceptId ? (
              <button
                className="ctx-i danger"
                onClick={() => {
                  unlinkImageFromConcept(node.id);
                  onClose();
                }}
              >
                <Icon name="x" size={13} />取消关联
              </button>
            ) : null}
          </div>
        ) : seeding ? (
          <div className="ctx-seed">
            <input
              className="pinput"
              autoFocus
              placeholder="种子词，回车创建"
              value={newSeed}
              onChange={(e) => setNewSeed(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') submitSeed();
                if (e.key === 'Escape') onClose();
              }}
            />
            <button className="btn xs pri" disabled={!newSeed.trim()} onClick={submitSeed}>
              创建
            </button>
          </div>
        ) : (
          items.map((it) => (
            <button
              key={it.key}
              className={`ctx-i ${it.danger ? 'danger' : ''}`}
              disabled={it.disabled}
              onClick={() => runItem(it)}
            >
              <Icon name={it.icon} size={13} />
              {it.label}
            </button>
          ))
        )}
      </div>

    </>
  );
}
