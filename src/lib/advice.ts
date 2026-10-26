import type { FlowNode } from '../types';
import { linkedImageNodes } from './graph';
import { actionAdvice, adviceSummary, effectiveScore, type Advice } from './scoring';

/**
 * P3 行动建议的行数据。
 *
 * 右栏「行动建议」区与交付文档「五、行动建议」段共用这一份推导——
 * 规则只有一处定义，不会出现「面板说推进、文档说暂缓」。
 *
 * 全部输入都是已有字段：score.value / quadrant / crPassed / kano，
 * 加上 P2 新增的关联图数与留用图数。零 AI 调用。
 *
 * P4：价值分 / 象限 / 决策全部读 effectiveScore()——用户调整过准则时，
 * 建议跟着调整后的有效值走，并带「含用户调整」标记（否则调整后的分
 * 会被当成 AI 原生分传阅）。
 */
export interface AdviceRow {
  id: string;
  label: string;
  value: number;
  quadrant: string;
  decision: string;
  adv: Advice;
  /** 证据 chips，全部引用已有字段，不新造文字 */
  ev: string[];
  /** P4：该概念的评分含用户调整（文档据此标注） */
  adjusted: boolean;
  /** P4：四条准则的有效分（与 value 同源，右栏依据区显示用） */
  criteria: [number, number, number, number];
  score: NonNullable<FlowNode['data']['score']>;
}

/** 按价值分降序。不含 slice——右栏只要前 12，文档要全量 */
export function adviceRows(nodes: FlowNode[]): AdviceRow[] {
  const rows: AdviceRow[] = [];
  for (const n of nodes) {
    const s = n.data.score;
    // 旧版（V1）评分没有权重与 KANO，不出建议——硬凑的结论比没有更糟
    if (s?.v !== 2) continue;
    const linked = linkedImageNodes(nodes, n.id);
    const imgs = linked.length;
    const kept = linked.filter((x) => x.data.keep === true).length;
    const kanoAttr = s.kano?.manual ?? s.kano?.attr ?? null;
    const eff = effectiveScore(s);
    const adv = actionAdvice({
      value: eff.value,
      quadrant: eff.quadrant,
      crPassed: s.crPassed,
      kanoAttr,
      imageCount: imgs,
      keepCount: kept,
    });
    const ev: string[] = eff.adjusted ? ['含用户调整'] : [];
    ev.push(`价值分 ${eff.value.toFixed(1)}`);
    if (imgs) ev.push(`图 ${imgs}`);
    if (kept) ev.push(`留用 ${kept}`);
    if (s.crPassed === false) ev.push(`CR ${(s.cr ?? 0).toFixed(2)}`);
    if (kanoAttr === 'M') ev.push('KANO 缺口');
    rows.push({
      id: n.id,
      label: n.data.label,
      value: eff.value,
      quadrant: eff.quadrant,
      decision: eff.decision,
      adv,
      ev,
      adjusted: eff.adjusted,
      criteria: eff.criteria,
      score: s,
    });
  }
  return rows.sort((a, b) => b.value - a.value);
}

export { adviceSummary };
/* 规则函数也从这里出——advice.ts 是「行动建议」这一层的统一入口，
   调用方（右栏 / 文档 / 单测）不需要知道规则在 scoring.ts 里。 */
export { actionAdvice } from './scoring';
export type { Advice, AdviceKind } from './scoring';
