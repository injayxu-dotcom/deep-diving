import type {
  DeepDiveReport,
  DDNodeData,
  IntelCard,
  FlowNode,
} from '../types';
import { linkedImageNodes, keptImageNodes } from './graph';
import { adviceRows, adviceSummary } from './advice';
import { CRITERIA, effectiveScore } from './scoring';

/**
 * 交付文档组装：把当前项目状态编成一份结构化 Markdown。
 * 纯字符串拼接，不调 AI —— 画布上已有的东西原样带出去。
 * 用户偏好纯文本格式，所以全部用标题 + 列表，不用表格。
 */

const KIND_NAME: Record<IntelCard['kind'], string> = {
  audience: '受众画像',
  competitor: '竞品视觉共性',
  opportunity: '机会空白点',
};

const DIM_NAME: Record<string, string> = {
  visual: '视觉联想',
  ontic: '本体结构',
  sensory: '感官气象',
  cultural: '文化图腾',
  opposite: '反义对冲',
  phono: '谐音字形',
};

function li(items: string[]): string {
  return items.filter(Boolean).map((t) => `- ${t}`).join('\n');
}

/** 调研洞察段（原「深潜简报」，与用户自写的「项目简报」区分） */
function reportSection(r: DeepDiveReport): string {
  const out: string[] = [];
  out.push(`## 一、调研洞察`, '');
  out.push(`> ${r.summary}`, '');
  out.push(`### 行业现状`, '', r.industry, '');
  if (r.competitors.length) {
    out.push(`### 竞品详情`, '');
    for (const c of r.competitors) {
      out.push(`**${c.name}**`, li([`特点：${c.feature}`, `受众：${c.audience}`]), '');
    }
  }
  out.push(
    `### 视觉元素`,
    '',
    li([`颜色：${r.visual.colors}`, `色调：${r.visual.tone}`, `字体：${r.visual.font}`]),
    '',
  );
  const sw = (label: string, items: string[]) =>
    items.length ? `**${label}**\n${li(items)}` : '';
  out.push(
    `### SWOT 分析`,
    '',
    sw('优势 S', r.swot.strengths),
    '',
    sw('劣势 W', r.swot.weaknesses),
    '',
    sw('机会 O', r.swot.opportunities),
    '',
    sw('威胁 T', r.swot.threats),
    '',
  );
  return out.join('\n');
}

/** 情报卡段 */
function intelSection(cards: IntelCard[]): string {
  if (!cards.length) return '';
  const out: string[] = [`## 二、情报卡片`, ''];
  for (const c of cards) {
    out.push(`### ${KIND_NAME[c.kind]}：${c.title}`, '', c.summary, '');
    out.push(
      c.points.map((p) => `- ${p.text}（置信度：${p.confidence}）`).join('\n'),
      '',
    );
  }
  return out.join('\n');
}

/** 种子词段（含来源，证明不是拍脑袋） */
function seedSection(nodes: FlowNode[]): string {
  const seeds = nodes.filter((n) => n.type === 'seed');
  if (!seeds.length) return '';
  const out: string[] = [`## 三、种子词`, ''];
  for (const n of seeds) {
    const d = n.data as DDNodeData;
    const src = d.seedSource ? ` —— 来源：${d.seedSource}` : '';
    const why = d.seedWhy ? `\n  为什么：${d.seedWhy}` : '';
    out.push(`- **${d.label}**${src}${why}`);
  }
  out.push('');
  return out.join('\n');
}

/** 概念与提示词段 */
function conceptSection(nodes: FlowNode[]): string {
  const concepts = nodes.filter((n) => n.type === 'concept');
  if (!concepts.length) return '';
  const out: string[] = [`## 四、收敛概念与生图提示词`, ''];
  let i = 0;
  for (const n of concepts) {
    i += 1;
    const d = n.data as DDNodeData;
    out.push(`### 概念 ${i}：${d.label}`);
    if (d.dim) out.push(`（裂变维度：${DIM_NAME[d.dim] ?? d.dim}）`);
    out.push('');
    const b = d.brief;
    if (b) {
      out.push(
        li([
          `创意概念名称：${b.name}`,
          `核心意象：${b.imagery}`,
          `色彩建议：${b.color}`,
          `字体气质建议：${b.font}`,
          `图形语言建议：${b.shape}`,
          `设计策略：${b.strategy}`,
        ]),
        '',
      );
    }
    const p = d.prompts;
    if (p) {
      // 老数据（h3 时代生成的）没有 gpt 字段，直接 push 会输出字面量 undefined
      const chans: [string, string | undefined][] = [
        ['GPT Image 2', p.gpt],
        ['即梦 4.5', p.jimeng],
        ['Midjourney', p.mj],
        ['负向提示', p.negative],
      ];
      for (const [name, text] of chans) {
        if (!text) continue;
        out.push(`**${name}**`, '```', text, '```', '');
      }
    }
    // P2：闭环的文档侧收口——这个概念关联了几张出图、留用几张
    const linked = linkedImageNodes(nodes, n.id);
    if (linked.length) {
      const kept = keptImageNodes(nodes, n.id).length;
      out.push(li([`关联图 ${linked.length} 张${kept ? `（留用 ${kept}）` : ''}`]), '');
    }
    // P4：评分进文档。有用户调整时**双值并列**（有效分 + AI 原始分）
    // 并带调整说明——拿走这份文档的人需要知道哪个数是模型给的、
    // 哪个数是团队改过的，否则讨论会建立在错的前提上
    const sc = d.score;
    if (sc && sc.v === 2) {
      const eff = effectiveScore(sc);
      const adjLines: string[] = [];
      if (eff.adjusted) {
        adjLines.push(`综合价值分 ${eff.value.toFixed(1)}（AI 原始 ${(sc.value ?? 0).toFixed(1)}，含用户调整）`);
        CRITERIA.forEach((c, i) => {
          const ai = sc[`c${i + 1}` as 'c1' | 'c2' | 'c3' | 'c4']?.score ?? 0;
          const mine = eff.criteria[i];
          if (Math.abs(mine - ai) > 0.01) {
            adjLines.push(`${c.name} ${mine.toFixed(1)}（AI ${ai.toFixed(1)}）`);
          }
        });
        if (sc.userAdj?.note) adjLines.push(`调整说明：${sc.userAdj.note}`);
      } else {
        adjLines.push(`综合价值分 ${eff.value.toFixed(1)}（AI 评分，未调整）`);
        adjLines.push(`四准则：${CRITERIA.map((c, i) => `${c.name} ${eff.criteria[i].toFixed(1)}`).join(' · ')}`);
      }
      out.push(li(adjLines), '');
    }
    if (!b && !p && !linked.length && !(d.score && d.score.v === 2)) {
      out.push('_尚未生成创意简报_', '');
    }
  }
  return out.join('\n');
}

/**
 * 行动建议段（P3）。
 * 与右栏「行动建议」区同一份推导（lib/advice.ts），零 AI 调用——
 * 文档带走的不只是分数，还有「接下来做什么」。
 */
function adviceSection(nodes: FlowNode[]): string {
  const rows = adviceRows(nodes);
  if (!rows.length) return '';
  const sum = adviceSummary(rows.map((r) => r.adv.kind));
  const out: string[] = [`## 五、行动建议`, ''];
  out.push(
    `> ${rows.length} 个概念：${sum.push} 建议推进 · ${sum.verify} 待验证 · ${sum.hold} 暂缓`
    + (sum.tbd ? ` · ${sum.tbd} 待定夺` : ''),
    '',
  );
  for (const r of rows) {
    // P4：调整过的概念在文档里带标记——价值分不是 AI 原生分
    const mark = r.adjusted ? '（含用户调整）' : '';
    out.push(`- **${r.label}**${mark} → ${r.adv.label}（${r.ev.join(' · ')}）`);
  }
  out.push('');
  return out.join('\n');
}

/** 组装完整文档 */
export function buildDoc(state: {
  product: string;
  mood: string;
  brief: string;
  report: DeepDiveReport | null;
  intel: IntelCard[];
  nodes: FlowNode[];
  edges: unknown[];
}): string {
  const { product, mood, brief, report, intel, nodes } = state;
  const today = new Date().toISOString().slice(0, 10);
  const parts: string[] = [];

  parts.push(`# ${product || '未命名项目'} · 创意深潜交付文档`, '');
  parts.push(`> 生成于 ${today} · 创意深潜 Deep Diving`, '');

  if (brief) parts.push(`**项目简报**：${brief}`, '');
  if (mood) parts.push(`**补充方向**：${mood}`, '');

  if (report) parts.push(reportSection(report));
  parts.push(intelSection(intel));
  parts.push(seedSection(nodes));
  parts.push(conceptSection(nodes));
  parts.push(adviceSection(nodes));

  const hasBody = report || intel.length || nodes.some((n) => n.type !== 'intel');
  if (!hasBody) {
    parts.push('_画布还是空的：先在左栏填项目名，点「开始深潜」。_', '');
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
