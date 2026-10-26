import type { Edge } from '@xyflow/react';
import type { FlowNode } from '../types';

/**
 * 节点图关系。
 *
 * 关键设计：**跨组连线不能当父子关系用**。
 * 用户会在两颗种子词之间拉「共性 / 对立 / 递进」关系线，这些边是语义关系，
 * 不是层级。所以找后代时必须同时判定 groupId 相同，
 * 否则拖动 A 种子会把 B 种子的整枝词一起拖走。
 */

/** 沿出边收集同组的全部可达后代（不含自身）。有环时靠 visited 兜住 */
export function collectDescendants(id: string, nodes: FlowNode[], edges: Edge[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const self = byId.get(id);
  const gid = self?.data.groupId;
  // 自己都不在任何组里（图片节点、情报卡），就谈不上后代
  if (!gid) return [];

  const out = new Map<string, string[]>();
  for (const e of edges) {
    const arr = out.get(e.source);
    if (arr) arr.push(e.target);
    else out.set(e.source, [e.target]);
  }

  const seen = new Set<string>();
  const stack = [...(out.get(id) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    // 只在同一分组内传播：跨组的语义连线不算层级
    if (byId.get(cur)?.data.groupId !== gid) continue;
    seen.add(cur);
    for (const nx of out.get(cur) ?? []) if (!seen.has(nx)) stack.push(nx);
  }
  // 误连成环时，起点会顺着环回到自己——后代不该包含自身
  seen.delete(id);
  return [...seen];
}

/** 组配色板：与维度色、语义色都拉开，避免"这个色到底是维度还是分组"。
    2026-10-16 暖色迁移：原板里有 teal/蓝/冷灰三个冷色，留在暖画布上像脏点，
    整套换暖谱（陶土/琥珀/紫/森绿/玫红/焦糖/橄榄/可可灰），八色仍可区分。 */
const GROUP_COLORS = [
  '#B85A3C',
  '#B07E1E',
  '#7A6A9E',
  '#2E7D52',
  '#C2415A',
  '#8C5A2B',
  '#7A6B1F',
  '#6B5A4E',
];

/** 同一分组恒定取到同一颜色：按 id 做字符串哈希取模 */
export function groupColor(groupId?: string): string | undefined {
  if (!groupId) return undefined;
  let h = 0;
  for (let i = 0; i < groupId.length; i++) h = (h * 31 + groupId.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

/* ─────────────── P2 图 → 概念关联（批次 2） ─────────────── */

/**
 * 关联到某概念的全部图节点。
 *
 * 「一次出图 = 一个图节点」是这里的计数单位：用户拿着提示词去外部工具
 * 出图，拖回画布时建的是一个图节点。所以「参考图 N」数的是节点数，
 * 不是节点内图片数——一个节点里塞 3 张备选，决策上仍然是「这一轮出图」。
 */
export function linkedImageNodes(nodes: FlowNode[], conceptId: string | undefined): FlowNode[] {
  if (!conceptId) return [];
  return nodes.filter((n) => n.data.kind === 'image' && n.data.linkedConceptId === conceptId);
}

/** 其中标记了「留用」的图节点数——行动建议「出图已验证」的判据 */
export function keptImageNodes(nodes: FlowNode[], conceptId: string | undefined): FlowNode[] {
  return linkedImageNodes(nodes, conceptId).filter((n) => n.data.keep === true);
}
