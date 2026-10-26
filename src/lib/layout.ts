import { DIMENSIONS, type DimKey } from '../types';

/**
 * 画布布局算法。
 *
 * 单独成文件的原因：F6（自主添加种子词）与 F4（裂变布局规整）都要用同一套
 * 避让逻辑，散落在 store 里会各写一份、互相打架。
 */

/** 节点默认尺寸，与 CSS 中 `.nd` 的 width/min-height 保持一致 */
export const NODE_W = 200;
export const NODE_H = 110;

/** 布局只关心位置与实测尺寸。用结构类型而不是 FlowNode，避免与 store 循环依赖 */
export interface Placed {
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
}

export interface XY {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 取节点外接矩形。节点首次渲染前没有 measured，用默认尺寸兜底 */
export function boxOf(n: Placed, pad = 0): Box {
  const w = (n.measured?.width ?? NODE_W) + pad * 2;
  const h = (n.measured?.height ?? NODE_H) + pad * 2;
  return { x: n.position.x - pad, y: n.position.y - pad, w, h };
}

/** 两矩形是否相交（AABB 判定） */
export function hits(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** 已有节点的整体包围盒。空画布返回 null */
export function boundsOf(existing: Placed[]): Box | null {
  if (!existing.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of existing) {
    const b = boxOf(n);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 黄金角。用无理数步长铺螺旋，点分布最均匀，不会排成十字或方阵 */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/**
 * 螺旋步长与最大圈数。
 *
 * 搜索半径 = SPIRAL_STEP * √SPIRAL_MAX ≈ 1200px。这个数字不是拍的：一次裂变
 * 最多把词推到第 6 环（半径约 1160），两个种子词挨在一起时，第二簇的词必须能
 * 逃出第一簇的覆盖范围。早期取 520（≈590px）时，「两父节点相距 300px 各裂变
 * 24 词」的极端用例会搜不到空位、退回首选点，实测产生 2 对重叠。
 *
 * 密度校核：r = c√k 的螺旋点阵近似间距 c√π ≈ 42px，一个 236×146 的候选框能
 * 覆盖约 19 个候选点，只要有空隙就一定找得到。代价是每节点约 2500 次 AABB 判定，
 * 48 节点全量约 12 万次，实测 <10ms。
 */
const SPIRAL_STEP = 24;
const SPIRAL_MAX = 2500;
/** 二阶段外推的上限。有限点集必然有界，这个范围内一定能逃出去 */
const ESCAPE_MAX = 12000;

/**
 * 从 preferred 出发向外螺旋找第一块不压住任何已有节点的位置。
 *
 * 首选点本身不冲突时原样返回——拖放场景要尊重用户手指落点，
 * 只有在真的压住了才推开。
 */
export function resolveOverlap(
  preferred: XY,
  existing: Placed[],
  size: { w: number; h: number } = { w: NODE_W, h: NODE_H },
  pad = 18,
): XY {
  const occupied = existing.map((n) => boxOf(n));
  if (!occupied.length) return preferred;

  const probe = (x: number, y: number): Box => ({
    x: x - pad,
    y: y - pad,
    w: size.w + pad * 2,
    h: size.h + pad * 2,
  });
  const free = (p: XY) => !occupied.some((b) => hits(probe(p.x, p.y), b));

  if (free(preferred)) return preferred;

  // 一阶段：黄金角螺旋，尽量贴着落点找空位
  for (let k = 1; k <= SPIRAL_MAX; k++) {
    const r = SPIRAL_STEP * Math.sqrt(k);
    const a = k * GOLDEN;
    const p = { x: Math.round(preferred.x + Math.cos(a) * r), y: Math.round(preferred.y + Math.sin(a) * r) };
    if (free(p)) return p;
  }

  // 二阶段：螺旋搜完仍无解，说明落点被整片占满。沿「已有内容质心 → 落点」方向
  // 直线外推，越过整个簇再落地。宁可放得远，也不要压在别人身上——重叠会让用户
  // 以为词丢了，放远至少还能靠「适应视图」找回来。
  const b = boundsOf(existing)!;
  const ox = b.x + b.w / 2;
  const oy = b.y + b.h / 2;
  let ux = preferred.x - ox;
  let uy = preferred.y - oy;
  const len = Math.hypot(ux, uy);
  // 落点恰好在质心上时方向退化，取正右方
  if (len < 1) {
    ux = 1;
    uy = 0;
  } else {
    ux /= len;
    uy /= len;
  }
  for (let d = SPIRAL_STEP * Math.sqrt(SPIRAL_MAX); d <= ESCAPE_MAX; d += 40) {
    const p = { x: Math.round(ox + ux * d), y: Math.round(oy + uy * d) };
    if (free(p)) return p;
  }
  // 理论上到不了这里（候选点无限延伸，而已有节点有限）
  return preferred;
}

/**
 * 新节点的默认落点：贴着已有内容右侧、垂直居中。
 * 从左侧面板连续添加时，节点会自左向右排开，不会在旧内容上打洞。
 */
export function clusterAnchor(existing: Placed[]): XY {
  const b = boundsOf(existing);
  if (!b) return { x: 0, y: 0 };
  return { x: Math.round(b.x + b.w + 72), y: Math.round(b.y + b.h / 2 - NODE_H / 2) };
}

/* ────────────────── 按组整理（存量画布重排） ────────────────── */

/** 整理只认 id、坐标、分组，不引入 FlowNode 类型以免循环依赖 */
export interface TidyNode {
  id: string;
  position: XY;
  data?: { groupId?: string };
}

const GROUP_GAP = 160;
const COL_GAP = 44;
const ROW_GAP = 80;
/**
 * 每层最多摆几列。实测教训：不设上限时，一个组裂变出 18 个词就会铺成
 * 4400px 宽的一行，fitView 之后每个节点只剩 17px 宽——「整理布局」反而
 * 把画布整成了不可读。限宽之后多余节点往下折行，宽度换高度，
 * 画布始终是一个能看清标签的矩形域。
 */
const MAX_COLS = 5;

/**
 * 一键整理：按分组分区、组内按层级分层。
 *
 * 与 `layoutChildren()` 的分工：
 * - `layoutChildren()` 管**新建**——一次裂变出来的词往哪儿放
 * - `tidyLayout()` 管**存量**——画布被拖乱之后怎么复位
 *
 * 三条设计取舍：
 * 1. **只认同组内的边当层级边**。跨组的共性/对立/递进是语义连线，不是父子关系，
 *    与 F5 `collectDescendants()` 的判定保持一致，否则跨组连线会把两组合并成一层
 * 2. **层内按当前 x 排序**。整理后同层节点的左右顺序不变，用户不会「认不出自己的画布」
 * 3. **组间按当前最左 x 排序**，整体左到右的顺序也保持
 */
export function tidyLayout(
  input: TidyNode[],
  edges: { source: string; target: string }[],
): Record<string, XY> {
  if (!input.length) return {};
  const byId = new Map(input.map((n) => [n.id, n]));
  const gid = (id: string) => byId.get(id)?.data?.groupId ?? id;

  // 组内父子边（双向索引），同组才认
  const kids = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    if (gid(e.source) !== gid(e.target)) continue;
    if (!kids.has(e.source)) kids.set(e.source, []);
    if (!kids.get(e.source)!.includes(e.target)) kids.get(e.source)!.push(e.target);
    if (!parents.has(e.target)) parents.set(e.target, []);
    if (!parents.get(e.target)!.includes(e.source)) parents.get(e.target)!.push(e.source);
  }

  // 分组，组之间按当前最左 x 排序
  const groups = new Map<string, TidyNode[]>();
  for (const n of input) {
    const g = gid(n.id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(n);
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => Math.min(...a[1].map((n) => n.position.x)) - Math.min(...b[1].map((n) => n.position.x)),
  );

  const out: Record<string, XY> = {};
  let cursorX = 0;

  for (const [, members] of ordered) {
    const member = new Set(members.map((m) => m.id));
    const byX = (a: string, b: string) =>
      (byId.get(a)!.position.x ?? 0) - (byId.get(b)!.position.x ?? 0);

    // BFS 分层。roots = 组内没有父的节点；整组成环时退回第一个成员，避免丢节点
    let roots = members.filter((m) => !(parents.get(m.id) ?? []).some((p) => member.has(p)));
    if (!roots.length) roots = [members[0]];

    const layers: string[][] = [];
    const seen = new Set<string>();
    let frontier = roots.map((r) => r.id);
    frontier.forEach((id) => seen.add(id));
    while (frontier.length) {
      layers.push([...frontier].sort(byX));
      const next: string[] = [];
      for (const id of frontier) {
        for (const k of (kids.get(id) ?? []).filter((c) => member.has(c))) {
          if (seen.has(k)) continue; // 防环：误连成环时不会无限展开
          seen.add(k);
          next.push(k);
        }
      }
      frontier = next;
    }
    // 组内成环、环上的节点没有父指向组内成员，会整组漏掉——兜底补进最后一层的下一层
    const missed = members.filter((m) => !seen.has(m.id));
    if (missed.length) layers.push(missed.map((m) => m.id).sort(byX));

    const maxCols = Math.min(MAX_COLS, Math.max(...layers.map((l) => l.length)));
    const groupW = maxCols * NODE_W + (maxCols - 1) * COL_GAP;

    // 层内超出 MAX_COLS 就往下折行。yCursor 逐层累加真实占用高度，
    // 不能再用 depth 直接乘行高——折行后一层的实际高度不止一行
    let yCursor = 0;
    layers.forEach((layer) => {
      const bands: string[][] = [];
      for (let i = 0; i < layer.length; i += MAX_COLS) bands.push(layer.slice(i, i + MAX_COLS));
      const bandW = (b: string[]) => b.length * NODE_W + (b.length - 1) * COL_GAP;
      bands.forEach((band, bi) => {
        const x0 = cursorX + (groupW - bandW(band)) / 2;
        band.forEach((id, i) => {
          out[id] = {
            x: Math.round(x0 + i * (NODE_W + COL_GAP)),
            y: Math.round(yCursor + bi * (NODE_H + ROW_GAP)),
          };
        });
      });
      yCursor += bands.length * (NODE_H + ROW_GAP);
    });

    cursorX += groupW + GROUP_GAP;
  }
  return out;
}

const DEG = Math.PI / 180;
/** 节点外接对角线长度：只要相邻间距大于它，任意朝向上都不会重叠 */
const MIN_CHORD = Math.hypot(NODE_W, NODE_H) + 34;
const MIN_RADIUS = 360;
/** 环间距。必须 > NODE_W：扇区朝正右时，相邻两环是水平错开，此时节点宽 200 才是约束边 */
const RING_GAP = NODE_W + 60;
/** 扇区两侧各留 4°，避免词压在维度边界上 */
const SECTOR_PAD = 8 * DEG;
const MAX_RINGS = 6;

/**
 * 径向分环布局（F4）。
 *
 * 相对旧实现（固定 300° 扇形均分）的三处改动：
 * 1. **扇区隔离**：六个维度各占 60° 扇区，词只在本扇区内分布，绝不侵入邻扇区。
 *    旧实现的扇区边界随词数漂移，两个维度各种 8 个词时必然互相压盖
 * 2. **多环填充**：词多时往外扩环，而不是把所有词挤在同一环上。
 *    每环能放几个词由该半径下的最小不重叠夹角反推（弦长 ≥ 节点对角线）
 * 3. **残差交给调用方**：本函数只保证初始摆位，最终由 `resolveOverlap()`
 *    对全部已有节点做一次避让（见 `runFission`），兜住跨父节点的历史重叠
 */
export function layoutChildren(parent: Placed, dim: DimKey, count: number): XY[] {
  const dimIndex = DIMENSIONS.findIndex((d) => d.key === dim);
  const sector = (Math.PI * 2) / DIMENSIONS.length;
  // 扇区中心（旧实现用的是扇区起始角，导致整个分布偏一侧）
  const center = (dimIndex + 0.5) * sector;
  const usable = sector - SECTOR_PAD;

  const cx = parent.position.x + NODE_W / 2;
  const cy = parent.position.y + NODE_H / 2;
  const at = (ang: number, r: number): XY => ({
    x: Math.round(cx + Math.cos(ang) * r - NODE_W / 2),
    y: Math.round(cy + Math.sin(ang) * r - NODE_H / 2),
  });

  const n = Math.max(1, count);
  if (n === 1) return [at(center, MIN_RADIUS)];

  // 逐环规划：环内角容量 = usable / 该半径下的最小夹角
  const plan: { r: number; k: number }[] = [];
  let r = MIN_RADIUS;
  let left = n;
  for (let ring = 0; ring < MAX_RINGS && left > 0; ring++) {
    const minStep = 2 * Math.asin(Math.min(1, MIN_CHORD / (2 * r)));
    const k = Math.max(1, Math.min(left, Math.floor(usable / minStep) + 1));
    plan.push({ r, k });
    left -= k;
    r += RING_GAP;
  }
  // 环数用尽还有剩余（词特别多）：全放最后一环，重叠由后面的避让兜底
  if (left > 0) plan.push({ r, k: left });

  const out: XY[] = [];
  for (const { r: rr, k } of plan) {
    // 单环内均匀铺满整个可用扇区；k=1 时落在扇区中心线上
    const span = k === 1 ? 0 : usable;
    const step = k === 1 ? 0 : span / (k - 1);
    for (let i = 0; i < k; i++) {
      out.push(at(center - span / 2 + step * i, rr));
    }
  }
  return out;
}
