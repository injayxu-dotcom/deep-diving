import type { Edge, Node } from '@xyflow/react';

/** 节点类型：种子 / 裂变词 / 参考图 / 情报卡 / 概念卡 / 用户便签 */
export type NodeKind = 'seed' | 'word' | 'image' | 'intel' | 'concept' | 'note';

/** 画布节点统一类型 */
export type FlowNode = Node<DDNodeData>;

/** 竞品条目 */
export interface Competitor {
  name: string;
  feature: string;
  audience: string;
}

/** SWOT 四象限 */
export interface Swot {
  strengths: string[];
  weaknesses: string[];
  opportunities: string[];
  threats: string[];
}

/** 视觉元素：颜色 / 色调 / 字体 */
export interface VisualElements {
  colors: string;
  tone: string;
  font: string;
}

/** 深潜简报：一次调研的完整结构化产出 */
export interface DeepDiveReport {
  product: string;
  createdAt: string;
  industry: string;
  competitors: Competitor[];
  visual: VisualElements;
  swot: Swot;
  summary: string;
  /** C3：简报里还需要用户确认的事项，可逐项勾掉 */
  todos?: { text: string; done: boolean }[];
}

/** 上传的参考资料 */
export interface RefPage {
  /** 压缩后的 JPEG dataURL（长边 1280 / 0.72），随文本一并交给视觉模型 */
  dataUrl: string;
  /** 页码或来源标注，拼进提示词让模型知道图来自第几页 */
  label: string;
}

export interface ReferenceFile {
  id: string;
  name: string;
  /** text = Markdown / 纯文本类（.md .txt .csv .json），原文直读，零解析成本 */
  kind: 'pdf' | 'pptx' | 'image' | 'text' | 'other';
  size: number;
  status: 'parsing' | 'done' | 'error';
  /** pdf / pptx 提取出的文本 */
  text?: string;
  /** 图片的 base64，供多模态模型读取 */
  dataUrl?: string;
  /**
   * F7：图片化页面（扫描 PDF 的渲染页 / PPTX 内嵌大图）。
   * 有它不代表一定发给模型——parseMode='fast' 时只发文本层
   */
  pages?: RefPage[];
  /** fast=仅文本层；deep=文本 + 图片页（需要视觉模型） */
  parseMode?: 'fast' | 'deep';
  /** 文本层字数低于阈值、自动升级为图片识别时为 true，UI 据此显示提示与回退入口 */
  autoUpgraded?: boolean;
  error?: string;
}

/** 深潜一次返回的完整结果：简报 + 情报卡 + 种子词 */
export interface DeepDiveResult {
  report: Omit<DeepDiveReport, 'product' | 'createdAt'>;
  cards: IntelResponse;
  seeds: { word: string; why: string; source: string }[];
  todos?: string[];
}

/** 挂在节点上的参考图 */
export interface AssetImage {
  id: string;
  name: string;
  /** 压缩后的 JPEG data URL */
  dataUrl: string;
  w: number;
  h: number;
}

/* ─────────────── P6-3：参考图四维分析 ───────────────

   原来「AI 读图」一次问一坨（配色/字体/版式/材质/情绪/共性），问题是：
   用户往往只想问其中一件事，却要为六段输出付一次调用；而且本地取色
   （免费、确定）和模型推断（要钱、有幻觉）被混在同一个结果里，
   读的人分不清哪句是算出来的、哪句是猜的。

   所以拆成四个**按需**动作，各自一段结果 + 明确的来源标注：
   配色 = 本地算法；风格 / 构图 / 排版 = 各走一个 focused prompt。 */
export type VisionDim = 'palette' | 'style' | 'layout' | 'type';

export const VISION_DIMS: { key: VisionDim; label: string; hint: string }[] = [
  { key: 'palette', label: '配色', hint: '本地取色，图片不外传' },
  { key: 'style', label: '风格', hint: '情绪 / 流派 / 关键词' },
  { key: 'layout', label: '构图', hint: '布局 / 视线 / 留白' },
  { key: 'type', label: '排版', hint: '字体气质 / 信息层级' },
];

/** 单个维度的结果。from 必须标注：本地取色与模型推断的可信度不是一回事 */
export interface VisionSection {
  text: string;
  from: 'local' | 'ai';
  /** 生成时间。同一个维度可以重跑覆盖，时间戳让用户看出这是不是旧的结论 */
  at: number;
  /** 模型给的短关键词（配色维度没有，它是本地算出来的） */
  tags?: string[];
}

/** AI 多模态读图输出的视觉特征（P6-3：分段结构；旧的一坨结构仍可读） */
export interface VisualProfile {
  /** 版本：缺或 1 = 旧的一坨（palette/font/layout/material/mood/summary）；2 = 四维分段 */
  v?: number;
  dims?: Partial<Record<VisionDim, VisionSection>>;
  // ---- V1 旧字段：只为读老数据。UI 认出 v<2 时按旧版渲染并提示重新提取 ----
  palette?: string;
  font?: string;
  layout?: string;
  material?: string;
  mood?: string;
  summary?: string;
}

/** 跨枝连接类型：共性 / 对立 / 递进 */
export type LinkType = 'common' | 'opposite' | 'cascade';

/** 六大裂变维度 */
export type DimKey = 'ontic' | 'sensory' | 'cultural' | 'opposite' | 'phono' | 'visual';

export interface Dimension {
  key: DimKey;
  name: string;
  desc: string;
  example: string;
}

/**
 * 六大裂变维度。
 *
 * 2026-10-17 重写 desc：原来这六行只是"分类标签"（"地域、历史、亚文化关联"），
 * 提示词把它们原样喂给模型时，等于没给判定标准 ——「文化隐喻」于是输出
 * 「渔民打捞珍珠」这类有文化味道、却没有出处的场景。现在 desc 写的是
 * **这一维要什么**，与 prompts.ts 里 DIM_RULES 的 gate 一一对应：
 * 轮盘上看到的那行字，和模型拿到的硬门槛是同一件事。
 */
export const DIMENSIONS: Dimension[] = [
  { key: 'visual',   name: '视觉联想', desc: '轮廓 / 负形 / 密度 / 光学',    example: '从种子的可见特征出发，转成图形操作与画面结果' },
  { key: 'ontic',    name: '本体延伸', desc: '沿同一属性再挖一层',           example: '沿结构、材料、形成过程或状态变化，再追到可见结果' },
  { key: 'sensory',  name: '感官通感', desc: '非视觉感官 → 视觉转译',        example: '非视觉感受 → 对应理由 → 具体视觉处理' },
  { key: 'cultural', name: '文化隐喻', desc: '共同记忆里的故事与符号',       example: '来源要熟 → 交出一条关系（不是寓意）→ 与种子的同构点' },
  { key: 'opposite', name: '反义对冲', desc: '同一属性轴上的极端对立',       example: '明确属性轴 → 种子所在端与对立端 → 张力理由' },
  { key: 'phono',    name: '谐音字形', desc: '读音同近、字形拆解',           example: '选定的字 / 音节 / 部件 → 真实关系 → 可画物象' },
];

/**
 * 维度色。六个维度在轮盘、节点左边框、评分条里用的是同一套色，
 * 之前散落在 nodes.tsx / DimensionWheel.tsx 各抄一份（还一个大写一个小写），
 * 改一处忘另一处就会出现「同一个维度两种色」。统一从这里取。
 *
 * 2026-10-16 暖色迁移（UI 风格改版）：
 * 原视觉联想用的是旧品牌青 #00b8c4 —— 品牌色已让位给陶土，维度再占着它会造成
 * 「同一个色既是品牌又是维度」。整套换成暖谱：陶土/咖啡/蜂蜜/薰衣草/红/鼠尾草，
 * 六色仍保持可区分（色相 + 明度双维度拉开）。
 */
const DIM_COLOR: Record<DimKey, string> = {
  visual: '#d96f51',
  ontic: '#7a5c3f',
  sensory: '#d9a441',
  cultural: '#8b7ba8',
  opposite: '#d64545',
  phono: '#3e8e6e',
};

export function dimColor(key: string): string {
  return DIM_COLOR[key as DimKey] ?? '#2e5c8a';
}

/* 2026-10-16：递进从冷蓝 #2E5C8A 改深可可 #6B5A4E —— 「递进」读作结构性主干，
   与共性（琥珀）、对立（红）在暖谱里仍可分。线型/箭头/文字标签同时区分，
   不单靠颜色（风格指南 §4）。 */
export const LINK_META: Record<LinkType, { label: string; color: string }> = {
  common:   { label: '共性', color: '#E8A33D' },
  opposite: { label: '对立', color: '#D64545' },
  cascade:  { label: '递进', color: '#6B5A4E' },
};

/** AI 评分结果（LLM 判断 + 显式依据，非 embedding 黑盒） */
/** KANO 属性：魅力 / 期望 / 必备 / 无差异 / 反向 */
export type KanoAttr = 'A' | 'O' | 'M' | 'I' | 'R';
/** Now-How-Wow 象限 */
export type Quadrant = 'wow' | 'how' | 'now' | 'meh';

/**
 * P4：用户对四准则分的人工调整。
 *
 * 评分从「客观测量」变成「讨论工具」的落点：每条准则都可以说
 * 「我有不同看法」，调成分写在这里，**AI 原始分留在 c1-c4 不动**
 * （界面上以幽灵数字保留可见）。展示分 = 用户调整优先、缺项回落 AI 分，
 * 由 lib/scoring.ts 的 effectiveScore() 一处推导，不写回 score.value——
 * 存一份又算一份，迟早两边漂移。
 *
 * 重新评分不清空它（同 KANO manual 的理由：用户手上的判断比模型推断可靠）。
 */
export interface UserAdj {
  c1?: number;
  c2?: number;
  c3?: number;
  c4?: number;
  /** 一句调整理由。会写进交付文档——团队里看到这个分的人需要知道为什么 */
  note?: string;
}

/* ─────────────── F10 产品流程：澄清 → 简报 → 画布 ─────────────── */

/** 画布前的前置阶段 */
export type PreStage = 'clarify' | 'report';
/** App 顶层阶段。canvas 即现有三栏工作台
 *
 *  `diving`（2026-10-17）：简报确认 → 画布之间的**过渡页**。
 *  深潜是一次 20-60 秒的等待，原来这段时间没有任何界面承接，用户点完按钮
 *  会"瞬间"出现在画布上、然后看着一块空地慢慢长出节点 —— 过程不可见，
 *  于是"深潜"这个产品隐喻也就落不了地。 */
export type Stage = PreStage | 'diving' | 'canvas';

/** AI 一轮里的单个苏格拉底问题（1-3 个/轮） */
export interface ClarifyQuestion {
  id: string;
  text: string;
  /** 为什么问这个——让用户看到提问的价值（苏格拉底式的关键） */
  reason: string;
  /** 快捷选项，点击即答 */
  options?: string[];
}

/** 澄清对话消息 */
export interface ClarifyMessage {
  id: string;
  role: 'ai' | 'user';
  /** AI 消息：本轮问题 + 可选的理解摘要 */
  questions?: ClarifyQuestion[];
  /** 「我目前的理解是…」滚动摘要，让用户感到在推进 */
  summary?: string;
  /** 轮次序号（1 起） */
  round?: number;
  /** AI 认为信息已足够，可提前结束 */
  ready?: boolean;
  /** 用户消息：对问题的回答（可多条） */
  answers?: { qid: string; text: string }[];
  /** 用户自由补充（不含在问题回答里） */
  text?: string;
}

/** 单条准则的锚点打分。why 必须解释「为什么不是满分」，这是可解释性的核心 */
export interface CriterionScore {
  score: number;
  why: string;
}

export interface KanoResult {
  /** AI 推断的主属性 */
  attr: KanoAttr;
  /** 属性分布，归一化到 1 */
  dist: Record<KanoAttr, number>;
  /** Berger 公式：做到能提升多少满意度，0~1 */
  better: number;
  /** Berger 公式：做不到会掉多少满意度，−1~0 */
  worse: number;
  /** 模型代入的用户画像，必须引自简报的目标人群/使用场景 */
  persona: string;
  /** 判定依据，必须引用简报里的具体信息 */
  basis: string;
  /** 是否成功锚定到简报。false 表示简报信息不足，可信度低 */
  anchored: boolean;
  /** 人工覆盖后的属性。有值时以它为准，且重新评分不被 AI 覆盖 */
  manual?: KanoAttr;
  /** 简报填了「用户反馈/用研结论」时以该字段为准，徽章变为「有用户反馈支撑」 */
  grounded?: boolean;
}

/**
 * 评分结果。
 *
 * V1（match/diff）与 V2（c1-c4 + AHP + KANO）并存：
 * 老数据只有 V1 字段，**不做静默换算**——旧数据没有权重与 KANO 信息，
 * 硬凑出来的分数会误导用户，UI 上直接提示重新评分。
 */
export interface ScoreResult {
  /** 数据版本：缺或 1 = V1 旧数据；2 = BS-KANO-AHP */
  v?: number;

  // ---- V1 字段（仅用于展示老数据，不再参与任何计算）----
  match?: number;
  diff?: number;
  reasons?: string[];
  advice?: string;

  // ---- V2 字段 ----
  c1?: CriterionScore;
  c2?: CriterionScore;
  c3?: CriterionScore;
  c4?: CriterionScore;
  /** AHP 权重，由项目简报推导，每个项目不同 */
  weights?: [number, number, number, number];
  /** 一致性比率 */
  cr?: number;
  /** CR < 0.1 为通过；未通过时权重回退默认值 */
  crPassed?: boolean;
  kano?: KanoResult;
  /** 综合价值分 0-10（AI 评分的落点值；有 userAdj 时展示值以 effectiveScore 推导为准） */
  value?: number;
  quadrant?: Quadrant;
  decision?: string;
  /** P4：用户对四准则的人工调整。有它时界面展示「含用户调整」与还原入口 */
  userAdj?: UserAdj;
}

/** AHP 权重推导结果，按项目缓存 */
export interface AhpCache {
  weights: [number, number, number, number];
  cr: number;
  crPassed: boolean;
  /** 推导时依据的简报快照，简报变了就重算 */
  briefHash: string;
}

/**
 * P5：撤销栈的单帧。
 *
 * **只存引用、不深拷**——store 全程 immutable 更新（map / spread 出新对象），
 * 旧帧引用的节点对象不会被后续修改碰到，所以栈里放引用就够，零拷贝成本。
 *
 * **不持久化**：50 帧全量节点（含图片 base64）会把 localStorage 5MB 配额
 * 撑爆。撤销是会话内的安全网，刷新即清是可接受的代价（阶段快照才是跨会话的）。
 */
export interface HistoryFrame {
  nodes: FlowNode[];
  edges: Edge[];
  selectedId: string | null;
  selection: string[];
  expandedId: string | null;
}

/**
 * P5：阶段快照——画布的某个时间点，用户显式保存的存档。
 *
 * 按 D7 **不携带图片 dataUrl**：base64 很占配额，10 份快照带图必爆。
 * 代价是恢复后图节点只剩占位（名字 / 尺寸还在），恢复弹窗会明说这件事。
 * 存在独立 localStorage 键里（见 lib/storage.ts），配额爆了只丢快照，
 * 不牵连主工作区的保存。
 */
export interface StageSnapshot {
  id: string;
  name: string;
  createdAt: number;
  nodes: FlowNode[];
  edges: Edge[];
  /** 被剥掉图片的节点数（恢复提示用） */
  stripped: number;
}

/**
 * F8 组合收敛（Combo）。组合的价值在「化学反应」，与单词评分的标尺不同：
 * 单词评分走 BS-KANO-AHP，组合评定是 化学反应 + 四维 + 命名 + 风险 的一次性产出
 */
export interface ComboData {
  /** 来源节点 id（顺序与选中时一致） */
  sourceIds: string[];
  /** AI 给出的组合逻辑：为什么这几个能产生化学反应 */
  logic?: string;
  /** 协同度 0-10：是否产生了单个词没有的新意义 */
  synergy?: number;
  /** 语义冲突点（若有）。冲突不一定是坏事 */
  conflict?: string;
  /** 冲突是否有张力：成立才算好创意 */
  tension?: string;
  /** 四维评分（与单词评分同一 0-10 标尺，见 F9 的 CRITERIA 锚点） */
  c1?: number; // 相关性
  c2?: number; // 差异化
  c3?: number; // 可视化度
  c4?: number; // 惊喜度
  /** 执行风险：工艺成本 / 撞车 / 过度复杂 */
  risk?: string;
  /** 一句话建议 */
  advice?: string;
}

export interface CreativeBrief {
  name: string;
  imagery: string;
  color: string;
  font: string;
  shape: string;
  strategy: string;
}

export interface Prompts {
  /** GPT Image 2：英文长文，规格书体 */
  gpt: string;
  /** 即梦 4.5：中文，画面长句 + 美学短词 + --ar */
  jimeng: string;
  mj: string;
  /** 共用负向提示：这张图最该避免的东西 */
  negative?: string;
  /** 已废弃：H3 视频提示词（本产品只做草图，不做视频）。保留字段只为读老数据 */
  h3?: string;
}

/* ─────────────── P6：用户便签（D9 五色板） ───────────────

   便签是**用户自己的声音**，和 AI 产物在视觉上必须一眼分开（指南 §4：
   "视觉上区分用户自己的想法与 AI 生成内容"）。所以：
   - 便签只用这五个暖色，AI 生成的卡（情报卡 / 概念卡）**永远不用便签黄**；
   - 色值直接取自指南色板，不新造色——批次 5 的令牌调整会同步到这里
     （所以这里写的是字面量而不是 var()，方便与指南逐条对照）。

   五色的语义不是装饰：黄=想法、鼠尾草=结论、灰粉=待办、
   薰衣草=疑问、柔陶土=素材。颜色给用户用，不强制。 */
export type NoteTone = 'sun' | 'sage' | 'rose' | 'lav' | 'clay';

export interface NoteToneMeta {
  key: NoteTone;
  label: string;
  /** 便签底色 */
  bg: string;
  /** 同色系深一档的描边，避免纯色块糊成一片 */
  line: string;
}

export const NOTE_TONES: NoteToneMeta[] = [
  { key: 'sun', label: '想法', bg: '#F5D98D', line: '#e3c473' },
  { key: 'sage', label: '结论', bg: '#D6E0CE', line: '#bccdb0' },
  { key: 'rose', label: '待办', bg: '#F0D5D2', line: '#ddbab6' },
  { key: 'lav', label: '疑问', bg: '#DCD6E8', line: '#c3bad6' },
  { key: 'clay', label: '素材', bg: '#EFD8C6', line: '#dcbea6' },
];

export function noteTone(key?: NoteTone): NoteToneMeta {
  return NOTE_TONES.find((t) => t.key === key) ?? NOTE_TONES[0];
}

/**
 * P6：便签与情报卡的轻微错落角度。
 *
 * 指南 §4 允许「便签可在非关键场景轻微倾斜（约 ±1°），但标题、长文本和操作
 * 控件保持正向」。节点整体旋转一个极小角度（≤0.7°）既能破掉「一张张贴纸
 * 排成表格」的僵硬感，又不会让文字明显歪斜。
 *
 * 角度由 id 决定（同一个节点每帧都一样），不能用随机数——
 * 每次重渲染都抖一下会让人以为画布在动。
 */
export function tiltOf(id: string, max = 0.7): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
  const t = (h / 1000) * 2 - 1; // −1 ~ 1
  return `${(t * max).toFixed(2)}deg`;
}

/**
 * 种子词的来源。
 * 「简报提取」与「手动添加」必须分开——指南 §4 说来源与模型推断不要混为一谈，
 * 用户得知道哪些词是自己放进来的。
 */
export function seedOrigin(data: { seedSource?: string }): 'dive' | 'manual' {
  return data.seedSource ? 'dive' : 'manual';
}

/** 便签宽度：与 styles.css 的 .nd-note 保持一致（落点计算要用真实宽度） */
export const NOTE_W = 190;

/**
 * 从工具条新建便签时的占位文本。
 *
 * 便签的用法是「随手写一句」，所以新建之后应该**光标已在里面**，
 * 而不是让用户先双击一次。NoteNode 认出这个占位（或 noteDraft 标记）
 * 就直接进编辑态，用户一提交就换掉它。
 */
export const NOTE_NEW = '写一句…';

export type IntelKind = 'audience' | 'competitor' | 'opportunity';
export type Confidence = '高' | '中' | '低';

/** 情报卡的类型标签。便签化之后卡面要写明来源（指南 §4：来源与模型推断不要混为一谈） */
export const INTEL_LABEL: Record<IntelKind, string> = {
  audience: '目标人群',
  competitor: '竞品动向',
  opportunity: '机会点',
};

export interface IntelPoint {
  text: string;
  confidence: Confidence;
}

export interface IntelPayload {
  title: string;
  summary: string;
  points: IntelPoint[];
}

/** 模型返回的情报卡片原始结构 */
export interface IntelResponse {
  audience?: IntelPayload;
  competitor?: IntelPayload;
  opportunity?: IntelPayload;
}

export interface IntelCard extends IntelPayload {
  id: string;
  kind: IntelKind;
}

/** React Flow 节点数据 */
export interface DDNodeData extends Record<string, unknown> {
  label: string;
  kind: NodeKind;
  dim?: DimKey;
  detail?: string;
  /** 可转译方向标签（工艺 / 材料 / 版式…），来自模型输出 */
  direction?: string;
  score?: ScoreResult;
  brief?: CreativeBrief;
  prompts?: Prompts;
  busy?: boolean;
  /** 正在被裂变的维度：节点上显示「正在发散 · 维度名」，裂变结束即清除（瞬态） */
  fissionDim?: DimKey;
  /** 由种子词升格为方案节点（kind 已变 concept），左栏种子词列表仍展示它 */
  wasSeed?: boolean;
  converged?: boolean;
  /** 参考图（视觉资产层） */
  images?: AssetImage[];
  /** 本地提取的色卡 */
  palette?: string[];
  /** AI 多模态读图结果 */
  visual?: VisualProfile;
  /** 情报卡节点挂载的卡片内容 */
  intel?: IntelCard;
  /** 种子词为什么被挑中（追溯到简报的具体信息） */
  seedWhy?: string;
  /** 种子词来源，如「竞品详情 · 虎邦辣酱」 */
  seedSource?: string;
  /**
   * P6：便签的来源标注（「钉自：项目简报」/「钉自：竞品动向」）。
   * 用户从简报浮层或情报卡上「钉为便签」时写入——便签可以脱离出处漂在画布上，
   * 但出处必须留在卡面，否则一周后没人记得这句话是谁说的。
   * 手动新建的便签没有它。
   */
  noteSource?: string;
  /** P6：便签配色（D9 五色板）。缺省为便签黄 */
  noteTone?: NoteTone;
  /**
   * P6：这张便签还等着用户写第一句话（从工具条新建时置 true）。
   * 卡面据此直接进编辑态；用户提交或取消后清掉，不会每次重渲染又弹编辑器。
   */
  noteDraft?: boolean;
  /**
   * 所属分组：取该组种子词节点的 id，整枝后代共用。
   * 拖动种子词时按它筛后代做位移传播，避免把别的组的词一起带走。
   */
  groupId?: string;
  /** F8：组合收敛记录（concept 节点专有） */
  combo?: ComboData;
  /**
   * 折叠态：true 时该节点的延伸词收进自身，画布上只留它一个 + 「N 个延伸词」徽标。
   * 隐藏是渲染期按它推导的（不写进 hidden），折叠/展开不会污染节点坐标。
   */
  collapsed?: boolean;
  /**
   * 「一键出方案」的进度：step/total。
   * 跑一次要串起 简报 →（评分 ‖ 提示词）三步，没有进度条用户会以为卡死了。
   * 跑完清成 undefined，不留在持久化里。
   */
  plan?: { step: number; total: number };
  /**
   * P2 闭环：图节点关联到的概念节点 id。
   * 「概念 →（拿提示词去外部出图）→ 拖回 → 关联 → 评价」这条链的数据落点——
   * 把图节点拖到概念节点上、或图节点右键「关联到概念…」建立。
   * 概念被删时由 store 负责置空（不留悬空引用）。
   */
  linkedConceptId?: string;
  /**
   * P2 出图评价的本地标记（无 AI，纯人工决策）：true=留用，false=淘汰。
   * 落在**图节点**上——一次出图通常就是一个图节点；概念详情「出图评价」
   * 与右栏行动建议的「留用图数」都读它。
   */
  keep?: boolean;
}

export interface AppSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /**
   * 云端后端地址（CloudBase「HTTP 访问服务」公网 URL）。
   * 留空 = 仅本地模式（数据只存本机 localStorage）。
   */
  apiBase: string;
  /** 云端同步可选令牌（云函数开启 WS_TOKEN 时必填） */
  cloudToken: string;
}

/**
 * 已部署的 CloudBase HTTP 访问服务地址（云函数 deepdiving-api）。
 *
 * 走环境变量而不是硬编码：这个域名里含环境 ID，写死在源码里等于把云资源地址公开，
 * 别人可以直接拿去刷你的云函数。本地在 `.env.local` 配置（已被 git 排除），
 * 仓库里默认为空 = 不启用云端同步，克隆后各自填自己的即可。
 */
export const DEFAULT_API_BASE = (import.meta.env.VITE_API_BASE as string) || '';

/**
 * 默认接口用 Agnes 而不是 DeepSeek：一个刚下载应用的人手上通常一个 Key 都没有，
 * 给他一个「要先充值才能用」的默认值，等于把第一步变成了一道收费门槛。
 * Agnes 承诺长期免费、注册不绑卡，默认指向它，用户只需要粘一个 Key 进来。
 * （已配置过的用户不会被这个默认值影响 —— settings 存在本机，读取时整份覆盖。）
 */
export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: 'https://apihub.agnes-ai.com/v1',
  apiKey: '',
  model: 'agnes-2.5-flash',
  temperature: 0.9,
  apiBase: DEFAULT_API_BASE,
  cloudToken: '',
};

