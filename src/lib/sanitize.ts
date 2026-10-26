/**
 * AI 返回值与持久化数据的形状消毒。
 *
 * 为什么要存在：真实模型不总是守约——`color` 可能返回 `{main:'#x'}` 对象、
 * `synergy` 可能返回 "9.0" 字符串。这些值一旦原样进 store：
 *  1. 渲染层 `{value}` 拿到对象 → React 抛 "Objects are not valid as a child"
 *     → 整棵 app 卸载 → 用户看到的就是「点了简报 tab 变白屏」；
 *  2. `synergy.toFixed` 之类对字符串调用 → 同样崩。
 * mock 测不出来（mock 永远返回正确形状），只有线上真实模型会踩。
 *
 * 消毒在三个入口做：
 *  - AI 输出写入 store 前（doBrief / doPrompts / doScore / runCombo / runVision）
 *  - localStorage 读出时（loadState，自愈已写坏的旧数据）
 *  - 云端工作区拉取合并时（pullCloud）
 */
import type { Node } from '@xyflow/react';
import type { DDNodeData, VisualProfile } from '../types';

/** 任意值 → 展示安全的字符串。对象/数组转 JSON（比 [object Object] 有用） */
export function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 任意值 → 有限数字或 undefined。"9.0" 这类数字字符串也收 */
export function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** 把一个节点的 data 里所有 AI 生成字段消毒成渲染安全形状 */
export function sanitizeNodeData(n: Node<DDNodeData>): Node<DDNodeData> {
  const d = n.data;
  if (!d || typeof d !== 'object') return n;
  const next: DDNodeData = { ...d };

  if (d.brief) {
    next.brief = {
      name: asText(d.brief.name),
      imagery: asText(d.brief.imagery),
      color: asText(d.brief.color),
      font: asText(d.brief.font),
      shape: asText(d.brief.shape),
      strategy: asText(d.brief.strategy),
    };
  }
  if (d.visual) {
    // P6-3：四维分段结构。逐维校验——模型或老存档里可能少了某一维、
    // 或某维的 text 不是字符串（被当成对象塞进来就会渲染成 [object Object]）
    const dimsIn = (d.visual as VisualProfile).dims ?? {};
    const dims: NonNullable<VisualProfile['dims']> = {};
    for (const k of ['palette', 'style', 'layout', 'type'] as const) {
      const s = dimsIn[k];
      if (!s) continue;
      const text = asText(s.text);
      if (!text) continue;
      dims[k] = {
        text,
        from: s.from === 'local' ? 'local' : 'ai',
        at: asNum(s.at) ?? Date.now(),
        tags: Array.isArray(s.tags) ? s.tags.map((t) => asText(t)).filter(Boolean).slice(0, 5) : undefined,
      };
    }
    next.visual = {
      v: asNum((d.visual as VisualProfile).v),
      dims: Object.keys(dims).length ? dims : undefined,
      // V1 旧字段原样留着：老存档要能继续显示，不需要用户重跑
      palette: asText(d.visual.palette),
      font: asText(d.visual.font),
      layout: asText(d.visual.layout),
      material: asText(d.visual.material),
      mood: asText(d.visual.mood),
      summary: asText(d.visual.summary),
    };
  }
  if (d.prompts) {
    next.prompts = {
      gpt: asText(d.prompts.gpt),
      jimeng: asText(d.prompts.jimeng),
      mj: asText(d.prompts.mj),
      negative: asText(d.prompts.negative),
    };
  }
  if (d.combo) {
    next.combo = {
      sourceIds: Array.isArray(d.combo.sourceIds) ? d.combo.sourceIds : [],
      logic: asText(d.combo.logic),
      synergy: asNum(d.combo.synergy),
      conflict: asText(d.combo.conflict),
      tension: asText(d.combo.tension),
      c1: asNum(d.combo.c1),
      c2: asNum(d.combo.c2),
      c3: asNum(d.combo.c3),
      c4: asNum(d.combo.c4),
      risk: asText(d.combo.risk),
      advice: asText(d.combo.advice),
    };
  }
  if (d.score && typeof d.score === 'object') {
    const s = d.score as unknown as Record<string, unknown>;
    const crit = (o: unknown) => {
      if (!o || typeof o !== 'object') return o;
      const c = o as { score?: unknown; why?: unknown };
      return { score: c.score, why: asText(c.why) };
    };
    next.score = {
      ...s,
      // 画布与评分面板会直接 toFixed：value/match/diff 必须是数字，
      // 旧数据或模型吐出的 "6.3" 字符串会让节点渲染当场崩掉
      value: asNum(s.value),
      match: asNum(s.match),
      diff: asNum(s.diff),
      c1: crit(s.c1),
      c2: crit(s.c2),
      c3: crit(s.c3),
      c4: crit(s.c4),
      decision: asText(s.decision),
    } as DDNodeData['score'];
  }

  // busy / plan 是瞬态：进程被关掉后残留的 true 会让节点永远转圈、
  // 且 runPlan 因 data.busy 直接 return——刷新也救不回来，必须在读取时就剪掉
  if ('busy' in next) delete (next as Partial<DDNodeData>).busy;
  if ('plan' in next) delete (next as Partial<DDNodeData>).plan;

  return { ...n, data: next };
}
