import type { KanoAttr, Quadrant, ScoreResult } from '../types';

/**
 * BS-KANO-AHP 综合评分的纯函数层。
 *
 * 单独成文件、不依赖任何 React / store，是为了能直接跑断言——
 * 这套公式一旦算错，UI 上只是「分数看着不太对」，没人能一眼发现。
 */

export const ATTRS: KanoAttr[] = ['A', 'O', 'M', 'I', 'R'];

export const ATTR_NAME: Record<KanoAttr, string> = {
  A: '魅力型',
  O: '期望型',
  M: '必备型',
  I: '无差异',
  R: '反向',
};

/** 主属性调节系数：承认「满意度对功能完备度是非线性的」 */
export const KANO_FACTOR: Record<KanoAttr, number> = {
  A: 1.2,
  O: 1.0,
  M: 0.8,
  I: 0.5,
  R: 0.2,
};

export const DEFAULT_WEIGHTS: [number, number, number, number] = [0.35, 0.25, 0.2, 0.2];

/** CR 阈值。Saaty 的经验值：超过 0.1 认为判断矩阵自相矛盾 */
export const CR_THRESHOLD = 0.1;
/** 象限与价值分的分界 */
export const QUADRANT_SPLIT = 5;
export const VALUE_HIGH = 7.5;
export const VALUE_LOW = 5;
/** ±0.5 分以内视为并列，不做精确排序（PRD 9.6.4 第 2 条） */
export const TIE_BAND = 0.5;

export const CRITERIA = [
  { key: 'c1', name: '需求契合', axis: '离简报里锁定的核心需求有多近' },
  { key: 'c2', name: '视觉差异', axis: '与竞品视觉共性拉开多远' },
  { key: 'c3', name: '可实现性', axis: '能不能被执行出来' },
  { key: 'c4', name: '情感激发', axis: '有没有让人「咦？」的一下' },
] as const;

export type CriterionKey = (typeof CRITERIA)[number]['key'];

/** 随机一致性指标 RI，n 为判断矩阵阶数 */
const RI: Record<number, number> = { 1: 0, 2: 0, 3: 0.52, 4: 0.89, 5: 1.12, 6: 1.26 };

/**
 * 由 6 次两两比较构建 4×4 判断矩阵。
 *
 * 输入顺序固定为 C(4,2)：(1,2) (1,3) (1,4) (2,3) (2,4) (3,4)，
 * 值为 i 相对 j 的 Saaty 标度。
 *
 * **下三角由代码取倒数，不让模型填**——模型自己填两遍极易填出自相矛盾的值，
 * 而互反性是 AHP 的前提，坏了后面全错。
 */
export function buildJudgmentMatrix(pairs: number[]): number[][] {
  const m: number[][] = [
    [1, 1, 1, 1],
    [1, 1, 1, 1],
    [1, 1, 1, 1],
    [1, 1, 1, 1],
  ];
  let k = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const v = Math.abs(Number(pairs[k]) || 1);
      // 标度取值 1/9 ~ 9，超出范围先夹住，避免极端值把权重压成 0 和 1
      const s = Math.min(9, Math.max(1 / 9, v));
      m[i][j] = s;
      m[j][i] = 1 / s;
      k++;
    }
  }
  return m;
}

export interface AhpResult {
  weights: [number, number, number, number];
  lambdaMax: number;
  ci: number;
  cr: number;
  passed: boolean;
}

/**
 * 几何平均法求权重 + 一致性检验。
 *
 * 用几何平均而不是列和归一化：前者在判断矩阵不完全一致时更稳健，
 * 也是 Saaty 本人推荐的特征向量近似法。
 */
export function ahpWeights(m: number[][]): AhpResult {
  const n = m.length;
  const geo = m.map((row) => Math.pow(row.reduce((p, v) => p * (v > 0 ? v : 1), 1), 1 / n));
  const sum = geo.reduce((p, v) => p + v, 0);
  const weights = (sum > 0 ? geo.map((g) => g / sum) : DEFAULT_WEIGHTS.slice()) as unknown as number[];

  // λmax = (1/n)·Σ (A·w)_i / w_i
  let lambdaMax = 0;
  for (let i = 0; i < n; i++) {
    let dot = 0;
    for (let j = 0; j < n; j++) dot += m[i][j] * weights[j];
    if (weights[i] > 0) lambdaMax += dot / weights[i];
  }
  lambdaMax /= n;

  const ci = n > 1 ? (lambdaMax - n) / (n - 1) : 0;
  const ri = RI[n] ?? 1.26;
  const cr = ri > 0 ? ci / ri : 0;

  return {
    weights: weights as unknown as [number, number, number, number],
    lambdaMax,
    ci,
    cr,
    passed: cr < CR_THRESHOLD,
  };
}

/** 把模型给的属性分布清洗成合法分布：补齐缺失键、负数归零、归一化到 1 */
export function normalizeDist(raw: Partial<Record<KanoAttr, number>> | undefined): Record<KanoAttr, number> {
  const out = {} as Record<KanoAttr, number>;
  let total = 0;
  for (const a of ATTRS) {
    const v = Math.max(0, Number(raw?.[a]) || 0);
    out[a] = v;
    total += v;
  }
  if (total > 0) for (const a of ATTRS) out[a] = out[a] / total;
  else for (const a of ATTRS) out[a] = 0;
  return out;
}

export interface KanoCoefficients {
  primary: KanoAttr;
  better: number;
  worse: number;
}

/**
 * Berger 公式。
 *
 * 注意分母刻意不含 R——标准做法里 R 归入评价表但不进 Better/Worse 的分母，
 * 否则「反向属性」会同时抬高 Better 的分子又缩小分母，得出荒谬结论。
 */
export function kanoCoefficients(dist: Record<KanoAttr, number>): KanoCoefficients {
  const { A, O, M, I } = dist;
  let primary: KanoAttr = 'I';
  let best = -1;
  for (const a of ATTRS) {
    if (dist[a] > best) {
      best = dist[a];
      primary = a;
    }
  }
  // 全零分布：没有信息就不要假装测出了属性
  if (best <= 0) return { primary: 'I', better: 0, worse: 0 };

  const denom = A + O + M + I;
  // R 占满时 Better/Worse 无定义（分母为 0），但主属性仍然是 R——
  // 这时候退回 I 会把「做了反而扣分」误判成「无所谓」，调节系数从 0.2 变成 0.5
  if (denom <= 0) return { primary, better: 0, worse: 0 };
  return {
    primary,
    better: (A + O) / denom,
    worse: -(O + M) / denom,
  };
}

export function kanoFactor(attr: KanoAttr): number {
  return KANO_FACTOR[attr] ?? 1;
}

export function quadrantOf(c3: number, c4: number): Quadrant {
  // X 轴 = 原创性 = C4；Y 轴 = 可行性 = C3。两者都复用已有准则分，不重复打分
  const original = c4 >= QUADRANT_SPLIT;
  const feasible = c3 >= QUADRANT_SPLIT;
  if (original && feasible) return 'wow';
  if (original && !feasible) return 'how';
  if (!original && feasible) return 'now';
  return 'meh';
}

export const QUADRANT_NAME: Record<Quadrant, string> = {
  wow: 'Wow',
  how: 'How',
  now: 'Now',
  meh: 'Meh',
};

export const QUADRANT_HINT: Record<Quadrant, string> = {
  wow: '又新又能做',
  how: '突破性想法，现在做不了',
  now: '低垂果实',
  meh: '既不新又难做',
};

/** 价值分档位 */
export type ValueTier = 'high' | 'mid' | 'low';

export function valueTier(value: number): ValueTier {
  if (value >= VALUE_HIGH) return 'high';
  if (value >= VALUE_LOW) return 'mid';
  return 'low';
}

/**
 * 交叉决策矩阵（PRD 9.8）。
 *
 * 「高价值分 + Meh」刻意标为存疑而非照抄结论：一个既不新颖又不可执行的方案
 * 不该拿到高分，出现这种组合说明某一步评估有问题，要提示人复核。
 */
export function decide(value: number, quadrant: Quadrant): string {
  const tier = valueTier(value);
  if (tier === 'high') {
    if (quadrant === 'wow') return '首选方向，立即推进';
    if (quadrant === 'how') return '战略储备，值得投入研究';
    if (quadrant === 'now') return '保底方案，顺手落地';
    return '⚠ 数据存疑，建议人工复核';
  }
  if (tier === 'mid') {
    if (quadrant === 'wow') return '值得做，优先于多数方案';
    if (quadrant === 'how') return '观察，等技术/成本可行';
    if (quadrant === 'now') return '可做可不做';
    return '放弃';
  }
  if (quadrant === 'wow') return '再想想，可能有评估偏差';
  return '砍掉';
}

/** 加权基础分 */
export function weightedBase(
  scores: [number, number, number, number],
  weights: [number, number, number, number],
): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += (Number(scores[i]) || 0) * (Number(weights[i]) || 0);
  return s;
}

/** 综合价值分 = 加权基础分 × KANO 调节系数，夹在 0-10 */
export function valueScore(base: number, factor: number): number {
  return Math.max(0, Math.min(10, base * factor));
}

export const clamp10 = (v: unknown): number => Math.max(0, Math.min(10, Number(v) || 0));

/* ─────────────── P3 行动建议（批次 2） ─────────────── */

/**
 * 从「价值分排行」到「行动建议」。
 *
 * 原则：**不新增任何 AI 调用**，全部由已有字段本地推导——
 * score.value / quadrant / crPassed / kano，加上 P2 新增的关联图数与留用图数。
 * 输出的是「下一步做什么」，不是把分数换个说法再念一遍。
 *
 * 规则按顺序先中先得（与计划文档 §3 规则表一致）：
 *  1. value ≥ 7.5 且 Wow            → 优先推进（进入出图与落地）
 *  2. 有留用图且 value ≥ 6.5        → 优先推进（出图已验证）
 *  3. CR 未过 或 KANO 是必备型      → 补充验证（先复核假设）
 *  4. value 5.0-6.5 且没有图        → 小步验证（先出一张图试试）
 *  5. value < 5.0                   → 暂缓（与主目标相关性弱）
 *  6. 有图但 value < 6.0            → 复盘出图（图与概念不匹配，检查提示词）
 *  7. 其余（有图、分值中上但未表态）→ 待定夺（标记留用/淘汰后再定）
 */
export type AdviceKind = 'push' | 'verify' | 'step' | 'review' | 'hold' | 'tbd';

export interface AdviceMeta {
  label: string;
  /** 一句行动指引。右栏徽标的 title 与文档段都用它 */
  hint: string;
  /** 汇总行的分桶：推进 / 验证 / 暂缓 / 待定 */
  bucket: 'push' | 'verify' | 'hold' | 'tbd';
}

export const ADVICE_META: Record<AdviceKind, AdviceMeta> = {
  push:   { label: '优先推进', hint: '进入出图与落地', bucket: 'push' },
  verify: { label: '补充验证', hint: '先复核评分假设', bucket: 'verify' },
  step:   { label: '小步验证', hint: '先出一张图试试', bucket: 'verify' },
  review: { label: '复盘出图', hint: '图与概念不匹配，检查提示词', bucket: 'verify' },
  hold:   { label: '暂缓',     hint: '与主目标相关性弱', bucket: 'hold' },
  tbd:    { label: '待定夺',   hint: '标记留用/淘汰后再定', bucket: 'tbd' },
};

/** 行动建议徽标的色调（右栏 + 文档段共用） */
export const ADVICE_TONE: Record<AdviceKind, string> = {
  push: 'hi',
  verify: 'mid',
  step: 'mid',
  review: 'warn',
  hold: 'lo',
  tbd: 'flat',
};

export interface AdviceInput {
  value: number;
  quadrant: Quadrant;
  /** AHP 一致性检验是否通过。false = 权重不可信，结论要先复核 */
  crPassed?: boolean;
  /** KANO 主属性（人工校准后的有效值） */
  kanoAttr?: KanoAttr | null;
  /** 关联到该概念的图节点数 */
  imageCount: number;
  /** 其中标记了「留用」的图节点数 */
  keepCount: number;
}

export interface Advice {
  kind: AdviceKind;
  label: string;
  hint: string;
}

export function actionAdvice(i: AdviceInput): Advice {
  const v = Number(i.value) || 0;
  const imgs = Math.max(0, Math.floor(Number(i.imageCount) || 0));
  const keep = Math.max(0, Math.floor(Number(i.keepCount) || 0));
  const pick = (kind: AdviceKind): Advice => {
    const m = ADVICE_META[kind];
    return { kind, label: m.label, hint: m.hint };
  };
  if (v >= VALUE_HIGH && i.quadrant === 'wow') return pick('push');
  if (keep > 0 && v >= 6.5) return pick('push');
  if (i.crPassed === false || i.kanoAttr === 'M') return pick('verify');
  if (v >= VALUE_LOW && v <= 6.5 && imgs === 0) return pick('step');
  if (v < VALUE_LOW) return pick('hold');
  if (imgs > 0 && v < 6) return pick('review');
  return pick('tbd');
}

/** 汇总行分桶计数：「5 个概念：2 建议推进 · 2 待验证 · 1 暂缓」 */
export function adviceSummary(kinds: AdviceKind[]): { push: number; verify: number; hold: number; tbd: number } {
  const out = { push: 0, verify: 0, hold: 0, tbd: 0 };
  for (const k of kinds) out[ADVICE_META[k].bucket] += 1;
  return out;
}

/* ─────────────── P4 评分成为讨论工具（批次 3） ─────────────── */

/**
 * 有效分：用户调整优先，缺项回落 AI 原始分。
 *
 * **一处定义、全局使用**——右栏排行 / 象限气泡 / 行动建议 / 节点详情 /
 * 交付文档全部读它。不写回 score.value：存一份又算一份，迟早两边漂移
 * （面板显示调整后、文档还是 AI 分那种事故）。
 *
 * 象限也由有效分重推：用户把 C3/C4 调了，象限还挂着 AI 的判定，
 * 就会出现「高分 + Meh → 数据存疑」这种自相矛盾的展示。
 */
export interface EffectiveScore {
  /** 四条准则的有效分（用户调整后） */
  criteria: [number, number, number, number];
  value: number;
  quadrant: Quadrant;
  decision: string;
  /** 是否有用户调整（UI 显示「含用户调整」标记与还原入口） */
  adjusted: boolean;
}

export function effectiveScore(s: ScoreResult): EffectiveScore {
  const adj = s.userAdj;
  const criteria: [number, number, number, number] = [
    clamp10(adj?.c1 ?? s.c1?.score),
    clamp10(adj?.c2 ?? s.c2?.score),
    clamp10(adj?.c3 ?? s.c3?.score),
    clamp10(adj?.c4 ?? s.c4?.score),
  ];
  const base = weightedBase(criteria, s.weights ?? DEFAULT_WEIGHTS);
  const factor = kanoFactor(s.kano?.manual ?? s.kano?.attr ?? 'O');
  const value = valueScore(base, factor);
  const quadrant = quadrantOf(criteria[2], criteria[3]);
  return {
    criteria,
    value,
    quadrant,
    decision: decide(value, quadrant),
    adjusted:
      !!adj &&
      (adj.c1 != null || adj.c2 != null || adj.c3 != null || adj.c4 != null),
  };
}

/** 评分讨论化：「本判定依赖什么」——从已有字段模板化提取，零 AI 调用 */
export function assumptions(s: ScoreResult): string[] {
  const out: string[] = [];
  const w = s.weights ?? DEFAULT_WEIGHTS;
  out.push(
    `四准则的相对重要性取 ${w.map((x) => Math.round(x * 100) + '%').join(' / ')}（由本项目简报推导）`,
  );
  if (s.crPassed === false) {
    out.push(`但权重矩阵自相矛盾（CR ${(s.cr ?? 0).toFixed(2)} ≥ 0.1），已回退默认权重——价值分里对权重不敏感的部分才可信`);
  }
  const k = s.kano;
  if (k) {
    if (k.persona) out.push(`KANO 代入的人群画像是「${k.persona}」——换一群人，属性判定可能翻面`);
    if (k.basis) out.push(`属性判定依据：${k.basis}`);
    if (!k.anchored) out.push('KANO 没有锚定到简报（缺目标人群 / 使用场景），属性推断可信度低');
    if (!k.grounded && !k.manual) out.push('没有用户反馈兜底，KANO 与四准则全部是模型基于简报的推断');
  }
  // 最大不确定性：给分最低的那条准则（理由原样引用，不新造文字）
  const crits: [string, number, string][] = [
    ['需求契合', s.c1?.score ?? 0, s.c1?.why ?? ''],
    ['视觉差异', s.c2?.score ?? 0, s.c2?.why ?? ''],
    ['可实现性', s.c3?.score ?? 0, s.c3?.why ?? ''],
    ['情感激发', s.c4?.score ?? 0, s.c4?.why ?? ''],
  ];
  const low = crits.reduce((a, b) => (b[1] < a[1] ? b : a));
  if (low[1] < 6.5 && low[2]) {
    // 这一段讲的是「AI 原判的依据」，所以取的是 AI 原始分而不是有效分。
    // 但用户可能已经把这条调高了——那时屏幕上会同时出现「AI 原始分 6.4」和「价值分 9.5」,
    // 不加这半句限定，读起来就像数据打错了。所以只在真的调过时补一句。
    const key = (['c1', 'c2', 'c3', 'c4'] as const)[crits.indexOf(low)];
    const adj = s.userAdj?.[key];
    const tail =
      adj != null ? `（你已把这条调到 ${clamp10(adj).toFixed(1)}，它只是 AI 原判里的短板）` : '';
    out.push(`最弱一环是「${low[0]}」${low[1].toFixed(1)} 分：${low[2]}${tail}`);
  }
  return out;
}

/** 评分讨论化：「接下来该验证什么」——按低分准则 / CR / KANO 缺口模板化生成 */
export function verifyQuestions(s: ScoreResult): string[] {
  const out: string[] = [];
  const eff = effectiveScore(s);
  const names = ['需求契合', '视觉差异', '可实现性', '情感激发'];
  const keys: ('c1' | 'c2' | 'c3' | 'c4')[] = ['c1', 'c2', 'c3', 'c4'];
  keys.forEach((key, i) => {
    const c = s[key];
    // 用有效分判断低分——用户调高过的准则不再逼问
    if (eff.criteria[i] < 6 && c?.why) {
      out.push(`「${names[i]}」${eff.criteria[i].toFixed(1)} 分：${c.why}。换一种执行方式（降成本 / 换材质 / 收窄场景），这条扣分还成立吗？`);
    }
  });
  if (s.crPassed === false) {
    out.push(`和团队把四准则的重要性重新排一遍，看排序是否稳定（当前 CR ${(s.cr ?? 0).toFixed(2)} ≥ 0.1，权重本身存疑）`);
  }
  const kanoAttr = s.kano?.manual ?? s.kano?.attr ?? null;
  if (kanoAttr === 'M') {
    out.push('KANO 判定为必备型（不做会扣分）：找 3 个目标用户问一句「没有它会怎样」，确认是不是及格线');
  }
  if (s.kano && !s.kano.anchored) {
    out.push('把目标人群与使用场景补进项目简报，重新评分后再看结论');
  }
  if (!out.length) {
    out.push('各准则都站得住、权重也一致：先出一张图验证直觉，比继续改分数更有信息量');
  }
  return out;
}
