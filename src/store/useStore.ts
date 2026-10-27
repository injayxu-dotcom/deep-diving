import { create } from 'zustand';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import type {
  AhpCache,
  AppSettings,
  AssetImage,
  ClarifyMessage,
  DeepDiveReport,
  DeepDiveResult,
  DimKey,
  DDNodeData,
  FlowNode,
  HistoryFrame,
  IntelCard,
  IntelKind,
  KanoAttr,
  KanoResult,
  NoteTone,
  Prompts,
  ReferenceFile,
  Stage,
  StageSnapshot,
  UserAdj,
  VisionDim,
} from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { AIError, PLAN_WAIT_CAP_MS, chatJSON, type ContentPart } from '../lib/ai';
import {
  ahpPrompt,
  briefFromClarifyPrompt,
  briefPrompt,
  clarifyTurnPrompt,
  comboCreatePrompt,
  comboScorePrompt,
  culturalPoolPrompt,
  deepDivePrompt,
  fissionPrompt,
  kanoPrompt,
  linkPrompt,
  promptGenPrompt,
  scoreV2Prompt,
  visionDimPrompt,
} from '../lib/prompts';
import { DIMENSIONS, LINK_META, VISION_DIMS, NOTE_W } from '../types';
import { screenPhonoWords } from '../lib/fissionFilter';
import { loadState, saveState, type Persisted } from '../lib/storage';
import { loadSnaps, saveSnaps, SNAP_CAP } from '../lib/storage';
import { asNum, asText } from '../lib/sanitize';
import { compressImage, extractPalette } from '../lib/color';
import { buildReferenceContext, detectKind, looksLikeVisionModel, parseFile, stub } from '../lib/files';
import { cloudEnabled } from '../lib/cloudApi';
import { diagnoseAIError, errorMessage } from '../lib/diagnose';
import { clusterAnchor, boundsOf, layoutChildren, resolveOverlap, tidyLayout, NODE_W } from '../lib/layout';
import { collectDescendants } from '../lib/graph';
import {
  ATTR_NAME,
  DEFAULT_WEIGHTS,
  ahpWeights,
  buildJudgmentMatrix,
  clamp10,
  decide,
  kanoCoefficients,
  kanoFactor,
  normalizeDist,
  quadrantOf,
  valueScore,
  weightedBase,
} from '../lib/scoring';

export type { FlowNode };
export type LogLevel = 'info' | 'ok' | 'warn' | 'err';
export interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  text: string;
}

/**
 * 告警级别。
 *
 * fatal：操作彻底失败、结果拿不到 —— 用模态弹窗打断用户，必须让他看见。
 * warn ：操作没做但状态下没坏（缺参数、超上限）—— 用 Toast 轻提示，不打断。
 */
export type AlertLevel = 'fatal' | 'warn';

export interface AlertState {
  level: AlertLevel;
  /** 哪一步崩的，例如「深潜失败」「裂变失败」 */
  title: string;
  /** 原始错误，不二次包装，方便排查与反馈 */
  reason: string;
  /** 可操作建议（由 diagnoseAIError 推导，识别不出时为空） */
  hint?: string;
  /** 重试：失败的那一步可以原样再跑一次（弹窗里的「重试」按钮） */
  retry?: () => void;
}

export interface ToastState {
  id: string;
  text: string;
  tone: 'warn' | 'ok';
}

/** 删除带后代的节点时的待确认请求 */
export interface PendingDelete {
  /** 用户请求删除的节点 */
  ids: string[];
  /** 弹窗标题里显示的名字，如「锈蚀」或「3 个节点」 */
  label: string;
  /** 会受影响的后代数量 */
  descendantCount: number;
  /** 后代里已经出过简报 / 评分 / 提示词的数量（这些是花钱花时间跑出来的） */
  valuableCount: number;
  /** 后代里已收敛的数量 */
  convergedCount: number;
}

/** 删除方式：连后代一起删，还是只删本体、让后代原地脱离分组 */
export type DeleteMode = 'cascade' | 'orphan';

/** 「以后不再弹出」的落点。不进 store——它是跨会话的设备级偏好，不是工作区内容 */
const GUIDE_KEY = 'dd.guideDismissed';

export function guideDismissed(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) === '1';
  } catch {
    // 隐私模式下 localStorage 可能直接抛错，此时当作未勾选
    return false;
  }
}

/**
 * 空态判定。
 *
 * 四个条件必须**同时**成立才算全新用户：画布空、没出过简报、没填项目名、没传资料。
 * 只判画布空是不够的——用户填了项目名正在想、或者传了资料还没深潜，
 * 这时候弹引导属于打断。
 */
export function isEmptyWorkspace(s: {
  nodes: unknown[];
  report: unknown;
  product: string;
  references: unknown[];
}): boolean {
  return s.nodes.length === 0 && !s.report && !s.product.trim() && s.references.length === 0;
}

const uid = () => Math.random().toString(36).slice(2, 10);
/** 单节点图片上限。base64 很占 localStorage 配额，必须封顶 */
export const MAX_IMAGES = 6;

/** F10：苏格拉底提问的硬性轮次上限（PRD：最多 5 轮，不能无限追问）。UI 顶部进度点也要用它 */
export const MAX_CLARIFY_ROUNDS = 5;

/**
 * F10：把澄清对话序列化成发给模型的文本。
 * AI 消息带出问题与理由；用户消息带出对哪些问题的回答。只记信息，不记 UI 噪音。
 */
function transcriptText(msgs: ClarifyMessage[]): string {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.role === 'ai') {
      let t = m.round ? `AI（第 ${m.round} 轮）` : 'AI（总结）';
      if (m.summary) t += `：${m.summary}`;
      out.push(t);
      for (const q of m.questions ?? []) {
        out.push(`问题：${q.text}${q.reason ? `（为什么问：${q.reason}）` : ''}`);
      }
      if (m.ready) out.push('（AI 认为信息已足够，准备收束）');
    } else {
      const parts: string[] = [];
      for (const a of m.answers ?? []) parts.push(`「${a.text}」`);
      if (m.text) parts.push(`自由补充：${m.text}`);
      if (parts.length) out.push(`用户回答：${parts.join('；')}`);
    }
  }
  return out.join('\n');
}

/** F10：统计已发出的 AI 提问轮数（带问题的消息才算一轮） */
const questionRounds = (msgs: ClarifyMessage[]) =>
  msgs.filter((m) => m.role === 'ai' && (m.questions?.length ?? 0) > 0).length;

/** 深潜产物的落点：接在现有内容下方，避免叠在一起 */
function nextOrigin(nodes: FlowNode[]): { x: number; y: number } {
  if (!nodes.length) return { x: 0, y: 0 };
  let maxY = -Infinity;
  for (const n of nodes) {
    const h = n.measured?.height ?? 200;
    maxY = Math.max(maxY, n.position.y + h);
  }
  return { x: 0, y: maxY + 140 };
}

/** 快照默认名：「10-17 01:52 · 21 节点」——一眼看出是什么时候、多大的画布 */
function defaultSnapName(count: number): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} · ${count} 节点`;
}

/** 压缩并转成可存储的图片对象，跳过非图片文件与损坏文件 */
async function ingest(files: File[]): Promise<AssetImage[]> {
  const out: AssetImage[] = [];
  for (const f of files) {
    if (!/^image\//i.test(f.type)) continue;
    try {
      const { dataUrl, w, h } = await compressImage(f);
      out.push({ id: `img-${uid()}`, name: f.name, dataUrl, w, h });
    } catch {
      /* 单个文件失败不阻断其余文件 */
    }
  }
  return out;
}

interface State {
  brief: string;
  product: string;
  /** 用户补充的情绪氛围 / 倾向，作为种子词的筛选镜头 */
  mood: string;
  /** 用户反馈 / 用研结论。KANO 判定的真实锚点，优先级高于模型推断 */
  feedback: string;
  /** AHP 权重缓存：每个项目推导一次，简报变了才重算 */
  ahp: AhpCache | null;
  /** 上传的参考资料 */
  references: ReferenceFile[];
  /** 调研洞察（AI 深潜的结构化产出：行业/竞品/视觉/SWOT）。原「深潜简报」，
    改名原因：和用户自己写的「项目简报」撞名，用户分不清哪个是哪个 */
  report: DeepDiveReport | null;
  reportOpen: boolean;
  deepDiving: boolean;
  /** 深潜等待期用户先记下的种子词（DivingStage）。深潜落盘时一起上画布，
   *  不立即建节点是因为此刻画布还没生成、坐标无从谈起。 */
  diveSeeds: string[];
  nodes: FlowNode[];
  edges: Edge[];
  intel: IntelCard[];
  settings: AppSettings;
  selectedId: string | null;
  logs: LogEntry[];
  panelTab: 'brief' | 'output';
  wheelId: string | null;
  /** 当前告警（fatal 弹窗 / warn toast），同时写一份进日志 */
  alert: AlertState | null;
  toast: ToastState | null;
  /** 非空时展示三选一删除弹窗 */
  pendingDelete: PendingDelete | null;
  /** 首次引导弹窗 */
  guideOpen: boolean;
  /**
   * AI 设置弹窗。
   *
   * 提到 store 是因为有四个入口要打开它：顶栏按钮 / 首屏配置卡 / 引导结尾 /
   * 状态栏同步提示。各自 useState 的话，两次触发就会叠出两个一模一样的弹窗 ——
   * 这种 bug 在截图里看不出来，只有真点两下才会发现。
   */
  settingsOpen: boolean;
  /** F8：当前选中的节点 id（框选 / Shift 多选）。驱动右下角批量操作条 */
  selection: string[];
  /** F8：组合收敛进行中（两个 AI 调用串联，需要禁用按钮防连点） */
  converging: boolean;
  /** F10：产品顶层阶段。canvas 之外是前置的澄清对话 / 简报确认 */
  stage: Stage;
  /** F10：澄清对话记录（Stage 1 的消息列表） */
  clarify: ClarifyMessage[];
  /** F10：澄清轮次中的 AI 生成中标记（打字指示器） */
  clarifyBusy: boolean;
  /**
   * F10：收尾确认卡是否打开。生成简报前强制补问「参考资料 + 特殊要求」——
   * 这两样要进简报和深潜的 prompt，等生成完了再到画布上补就白问了。
   * 不持久化：纯属会话内的一个 UI 停靠点。
   */
  closingAsk: boolean;
  /**
   * 画布上「展开详情」的节点 id，同一时刻只允许一个。
   * 详情（评分 / 简报 / 提示词 / 参考图）直接长在节点卡片里，
   * 不用浮层——浮层会跟着画布漂移，一拖就收起来了。
   */
  expandedId: string | null;
  /**
   * P2-bis：重新深潜语义框。画布已有内容时点「开始深潜」先弹它——
   * 让「再挖一轮（追加）」与「清空重来」的差异在点下去之前就可见，
   * 而不是让用户猜这个按钮到底是哪一种。
   */
  rediveAsk: boolean;
  /**
   * P2：拖拽会话中「可落地」的概念节点 id（图节点被拖着经过它时高亮）。
   * 瞬态，不持久化——刷新后没有拖拽会话，留着只会误亮。
   */
  linkHintId: string | null;
  /**
   * P5：撤销栈。**只放会话内、不落盘**——50 帧全量节点（含图片 base64）
   * 会把 localStorage 5MB 配额撑爆，而刷新丢失撤销是用户可理解的代价
   * （跨会话的存档用阶段快照 snaps，那个才是持久化的）。
   */
  past: HistoryFrame[];
  future: HistoryFrame[];
  /**
   * P5：阶段快照。独立 localStorage 键存储（storage.ts），配额爆了只丢快照、
   * 不牵连主工作区。按 D7 不含图片 dataUrl，恢复时弹窗说明图位是空壳。
   */
  snaps: StageSnapshot[];
  /** P5：快照管理弹层（⋯ 菜单「保存快照」进入） */
  snapshotOpen: boolean;

  openWheel(id: string): void;
  openGuide(): void;
  /** remember=true 时写入「以后不再弹出」，后续不再自动唤起 */
  closeGuide(remember: boolean): void;

  openSettings(): void;
  closeSettings(): void;

  /* ---------- F10 流程 ---------- */
  /** 输入主题并开始澄清（清空旧对话，AI 问第一轮） */
  beginClarify(subject: string): Promise<void>;
  /** 提交本轮回答 → 追加用户消息 → AI 追问下一轮（或自动收束） */
  sendClarify(answers: { qid: string; text: string }[], extra?: string): Promise<void>;
  /**
   * 收尾确认门：无论是用户点「够了」还是 AI 判定 ready / 轮次到顶，
   * 生成简报前都先停下来问两件事——还有没有参考资料要交、有没有氛围情绪类的特殊要求。
   * 这两样进了简报和深潜的 prompt 才有用了，等上了画布再补就晚了。
   */
  finishClarify(): Promise<void>;
  /** 收尾确认卡上点「就这些，生成简报」→ 真正开始生成 */
  confirmFinish(): Promise<void>;
  /** 收尾确认卡上点「返回继续回答」 */
  cancelFinish(): void;
  /** 用户点「跳过提问，直接开始」→ 逃生舱进画布（保留对话，便于之后回来） */
  skipClarify(): void;
  /** 从画布/简报返回澄清（保留对话；对话清空过则新起） */
  goClarify(): void;
  /** 从画布回简报确认页（改需求；没有简报时也可当场写一份） */
  goReport(): void;
  /** 简报确认页 → 跑深潜并进入画布 */
  enterCanvasFromReport(): Promise<void>;
  closeWheel(): void;
  setBrief(v: string): void;
  setProduct(v: string): void;
  setMood(v: string): void;
  setFeedback(v: string): void;
  setReportOpen(v: boolean): void;
  toggleTodo(i: number): void;
  setPanelTab(t: 'brief' | 'output'): void;
  setSettings(p: Partial<AppSettings>): void;
  /** 用云端拉取的工作区整体覆盖本地（启动同步时调用） */
  hydrateFromCloud(p: Persisted): void;
  setSelected(id: string | null): void;
  clearLogs(): void;
  /** 弹告警：fatal 走模态弹窗，warn 走 Toast；两者都写入日志 */
  raiseAlert(level: AlertLevel, title: string, e: unknown, hint?: string, retry?: () => void): void;
  dismissAlert(): void;
  dismissToast(): void;
  addReferences(files: File[]): Promise<void>;
  removeReference(id: string): void;
  /** 手动切换解析模式：fast=仅文本层；deep=文本+图片页（覆盖 F7 的自动判定） */
  setRefParseMode(id: string, mode: 'fast' | 'deep'): Promise<void>;

  onNodesChange(c: NodeChange<FlowNode>[]): void;
  onEdgesChange(c: EdgeChange[]): void;
  onConnect(c: Connection): void;

  /** 手动种一颗种子。返回新节点 id，空词返回 null（调用方据此决定是否清空输入框） */
  addSeed(word: string): string | null;
  addNodeAt(word: string, position: { x: number; y: number }): void;

  /* ---------- P6：用户便签 ---------- */
  /**
   * 新建便签。position 缺省时落在画布内容之外的空位上。
   * 空文本返回 null——空便签落下去只会变成一张谁也读不懂的白纸。
   */
  addNote(text: string, position?: { x: number; y: number }, draft?: boolean): string | null;
  /** 双击编辑提交（同值早退，不占历史栈） */
  setNoteText(id: string, text: string): void;
  /** 换配色（D9 五色板） */
  setNoteTone(id: string, tone: NoteTone): void;
  /**
   * 「钉为便签」：把简报浮层或情报卡上的一段话钉到画布上。
   * 来源写进 noteSource——便签可以漂走，出处必须跟着走。
   * nearId 给出来时贴在那个节点旁边，否则落空位。
   */
  pinNote(text: string, source: string, nearId?: string): string | null;
  runDeepDive(): Promise<void>;
  /**
   * 深潜等待页（stage = diving）：先记下一个自己想到的种子词。
   * 不立刻建节点——深潜结束前画布坐标系还没落定；等 runDeepDive 成功时
   * 与 AI 的种子词一起上画布。
   */
  addDiveSeed(word: string): void;
  removeDiveSeed(word: string): void;
  /** 深潜等待页：先跳到画布，深潜在后台照常跑完并把结果追加进去 */
  skipDiving(): void;

  createImageNode(files: File[], position: { x: number; y: number }): Promise<void>;
  attachImages(nodeId: string, files: File[]): Promise<void>;
  removeImage(nodeId: string, imageId: string): void;
  runPalette(nodeId: string): Promise<void>;
  /**
   * P6-3：按维度提取参考图特征。配色走本地（等价于 runPalette），
   * 风格 / 构图 / 排版各走一个 focused 视觉调用——一次只问一件事。
   */
  runVision(nodeId: string, dim: VisionDim): Promise<void>;
  runFission(nodeId: string, dim: DimKey): Promise<void>;
  runLinkAnalysis(edgeId: string): Promise<void>;
  runBrief(nodeId: string): Promise<void>;
  runPrompts(nodeId: string): Promise<void>;
  runScore(nodeId: string): Promise<void>;
  /**
   * 一键出方案：一次点击串起 简报 →（评分 ‖ 提示词）。
   * 顺序不能反也不能全并行——V2 评分的 AHP 权重与 KANO 判定都要拿简报当锚点，
   * 提示词更是直接由简报的意象/色彩/字体长出来的。
   * 所以只有后两步能并行，UI 上仍是一次点击、一次等待、一次出齐。
   */
  runPlan(nodeId: string): Promise<void>;
  /** 展开/收起节点详情。同一时刻只允许一个展开（再点别的会顶掉上一个） */
  toggleExpand(nodeId: string): void;
  /** 人工覆盖 KANO 主属性；传 null 恢复 AI 推断。覆盖结果不会被重新评分冲掉 */
  setKanoManual(nodeId: string, attr: KanoAttr | null): void;
  toggleConverge(nodeId: string): void;
  /** 折叠/展开：把一颗词的延伸词收进自身（或展开还原）。无延伸词时静默 */
  toggleCollapse(nodeId: string): void;
  /** 渲染期用：被折叠收起的节点 id 集合（含多层级联） */
  hiddenNodeIds(): string[];
  /**
   * 请求删除。无后代时直接删；有后代时弹三选一确认。
   * 不弹窗的背后原因：每删一个词都要多点一次会让人烦。
   */
  requestDelete(nodeIds: string[]): void;
  /** 确认删除。mode='cascade' 连后代一起删，'orphan' 只删本体 */
  confirmDelete(mode: DeleteMode): void;
  cancelDelete(): void;
  /** F8：框选/多选同步。ids 长度 1 时兼作右侧栏的聚焦节点 */
  setSelection(ids: string[]): void;
  /** F8：取消多选（清掉 React Flow 内部与镜像两处） */
  clearSelection(): void;
  /** F8：组合收敛。2-6 个节点 → 生成组合概念节点并自动评定 */
  runCombo(ids: string[]): Promise<void>;
  /** F8：对多个可评分节点依次跑 F9 评分（有 AI Key 时才有意义） */
  runBatchScore(ids: string[]): Promise<void>;
  /** 一键整理：按分组分区、组内按层级分层。返回是否真的动了节点 */
  tidy(): boolean;
  resetCanvas(): void;
  /** P2：图节点关联到概念节点（拖到概念上 / 右键「关联到概念…」）。一张图只属于一个概念 */
  linkImageToConcept(imageId: string, conceptId: string): void;
  /** P2：取消图节点的概念关联 */
  unlinkImageFromConcept(imageId: string): void;
  /** P2：出图评价的本地标记。keep=true 留用，false 淘汰（无 AI，纯人工决策） */
  setImageKeep(imageId: string, keep: boolean): void;
  /**
   * P4：人工调整四准则分。adj=null 一键还原 AI 评分。
   * 只写 userAdj，价值分/象限/决策由 effectiveScore() 现场推导（不写回
   * score.value——存一份算一份必漂移）。AI 原始分留在 c1-c4 作幽灵数字。
   * 重新评分不清空 userAdj：用户手上的判断比模型推断可靠（同 KANO manual）。
   */
  setUserAdj(nodeId: string, adj: UserAdj | null): void;
  /** P2-bis：「开始深潜」统一入口。画布已有内容先弹语义框，空画布直接跑 */
  startDeepDive(): void;
  /** P2-bis：关掉重新深潜语义框，什么都不做 */
  cancelRedive(): void;
  /** P2-bis：确认重新深潜。append=再挖一轮（现行追加行为）；fresh=清空后重来 */
  confirmRedive(mode: 'append' | 'fresh'): void;

  /* ---------- P5 撤销 / 重做与阶段快照 ---------- */
  /** 撤销一步。拖拽合并为一步；AI 结果写入也可撤销 */
  undo(): void;
  /** 重做一步（撤销的反向） */
  redo(): void;
  /** 保存阶段快照（默认名「时间戳 · N 节点」）。按 D7 剥掉图片 dataUrl */
  saveSnapshot(name?: string): void;
  deleteSnapshot(id: string): void;
  /** 用快照替换当前画布（本身可被撤销退回） */
  restoreSnapshot(id: string): void;
  openSnapshots(): void;
  closeSnapshots(): void;
}

const persisted = loadState();

/** 原始上传文件的内存缓存（id → File）。不持久化，刷新即失；
 *  只为「改用深度解析」重跑解析用，丢了就提示重新上传 */
const refFiles = new Map<string, File>();

/** P6 便签的最大字数。便签短句优先（指南 §4），200 字已是一小段话；
 *  再长就该开概念卡，而不是把自己的批注写成第二份简报 */
const NOTE_MAX = 200;

/**
 * P6 便签的默认落点：整块内容左侧的空位。
 * 便签是旁注，不该挤进节点堆（resolveOverlap 会把邻居推开，等于新建一张便签
 * 就动一次布局）；没有内容时给一个离原点半屏的起点，别压在原点的手柄上。
 */
function noteSpot(nodes: FlowNode[]): { x: number; y: number } {
  const b = boundsOf(nodes);
  if (!b) return { x: 120, y: 120 };
  return { x: b.x - NOTE_W - 60, y: b.y };
}


export const useStore = create<State>((rawSet, get) => {
  /** 持久化，配额溢出时打到日志里让用户看见 */
  // 配额溢出必须让用户看见——静默失败会让人以为数据存住了
  const persist = () =>
    saveState(get(), (msg) => raiseAlert('fatal', '本地存储写入失败', new Error(msg)));

  /** 统一的节点数据补丁 */
  const patchNode = (id: string, patch: Partial<DDNodeData>) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
    }));

  const patchEdge = (id: string, patch: Record<string, unknown>) =>
    set((s) => ({ edges: s.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));

  /** 连节点本身的结构一起改（例如把 word 节点升级成 concept 节点） */
  const patchNodeFull = (id: string, patch: Partial<FlowNode>) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));

  const log = (level: LogLevel, text: string) =>
    set((s) => ({
      logs: [{ id: uid(), ts: Date.now(), level, text }, ...s.logs].slice(0, 60),
    }));

  /* ============================================================
     P5 历史栈（撤销 / 重做）

     为什么包一层 set 而不是在每个 action 里手动记：action 有二十多个
     （节点增删 / 连线增删 / 拖拽 / 种子派生 / 各路 AI 写入），靠自觉必漏，
     而漏一处的表现是「改了却撤不回来」——用户不敢整理画布，正是这个产品
     要解决的问题。包住 set，结构性变更一处都漏不掉。

     三个设计约束：
     ① 拖拽合并为一步。拖动时每帧一个 position 变更，不合并会把 50 步栈
        一口气耗在一帧拖动上。用「拖拽会话标记 + 800ms 时间窗」双重判据。
     ② 瞬态不入栈。busy / plan / selected / measured / dragging 的变动
        不产生历史步——否则点一次「重新评分」能连着弹两步 undo。
     ③ undo/redo/云端覆盖自身不记录（suspended）。
     ============================================================ */
  const HIST_CAP = 50;
  const HIST_MERGE_MS = 800;

  const past: HistoryFrame[] = [];
  const future: HistoryFrame[] = [];
  let lastKind: 'pos' | 'data' = 'data';
  let lastAt = 0;
  /** 拖拽会话的后续帧 / 时间窗内的连续位置变更 → 合并进上一笔 */
  let posMerge = false;
  /** 由 onNodesChange 在每次 set 前写入：本次位置变更是否已是合并中的后续帧 */
  let mergeHint = false;
  /** setUserAdj 置位：紧接着的那次数据变更合并进上一笔（滑杆连续拖动不刷栈） */
  let mergeNext = false;
  /** 组写入深度 > 0 时完全不记录，endGroup 时合成一笔（runPlan / runCombo 等） */
  let groupDepth = 0;
  let groupBase: HistoryFrame | null = null;
  /** undo/redo/恢复快照自身不记录 */
  let suspended = false;

  const frameOf = (s: State): HistoryFrame => ({
    nodes: s.nodes,
    edges: s.edges,
    selectedId: s.selectedId,
    selection: s.selection,
    expandedId: s.expandedId,
  });

  /**
   * 序列化时剥瞬态 + 折长串。
   *
   * 折长串是性能硬约束：base64 图片动辄上百 KB，拖拽每帧都全量 stringify
   * 会把画布卡死。对历史判定来说「长度 + 抽样指纹变了」就等于「内容变了」，
   * 不需要逐字节——同长度同指纹的不同图，是理论上才有的边界。
   */
  const dropT = (_k: string, v: unknown) => {
    if (typeof v !== 'string') return v;
    if (v.length <= 240) return v;
    let h = 0;
    for (let i = 0; i < v.length; i += 97) h = (h * 31 + v.charCodeAt(i)) | 0;
    return `#${v.length}:${h}`;
  };

  /** 结构签名：节点 id 序列 + 边 id 序列（增删判定） */
  const shapeSig = (f: HistoryFrame) =>
    f.nodes.map((n) => n.id).join(',') + '|' + f.edges.map((e) => e.id).join(',');
  /** 内容签名：全部 data / 边数据（新增字段自动纳入，不靠人工枚举） */
  const dataSig = (f: HistoryFrame) =>
    f.nodes.map((n) => n.id + ':' + JSON.stringify(n.data, dropT)).join(';') +
    '|' +
    f.edges.map((e) => e.id + ':' + JSON.stringify(e, dropT)).join(';');

  /** 把内部栈镜像进 state（UI 订阅它做禁用态）。自身不记录 */
  const syncHistory = () => {
    suspended = true;
    rawSet({ past: [...past], future: [...future] });
    suspended = false;
  };

  const pushFrame = (f: HistoryFrame, kind: 'pos' | 'data') => {
    past.push(f);
    if (past.length > HIST_CAP) past.shift();
    future.length = 0;
    lastKind = kind;
    lastAt = Date.now();
    syncHistory();
  };

  /**
   * 组写入：多步流程（一键出方案 = 简报 + 评分 + 提示词三次写入）
   * 合成一笔历史。begin/end 必须严格配对——用 try/finally 包。
   */
  const beginGroup = () => {
    if (groupDepth === 0) groupBase = frameOf(get());
    groupDepth += 1;
  };
  const endGroup = () => {
    if (groupDepth === 0) return;
    groupDepth -= 1;
    if (groupDepth > 0) return;
    const base = groupBase;
    groupBase = null;
    if (!base || suspended) return;
    const after = frameOf(get());
    if (shapeSig(base) !== shapeSig(after) || dataSig(base) !== dataSig(after)) {
      pushFrame(base, 'data');
    }
  };

  const set = ((partial: Partial<State> | ((s: State) => Partial<State>)) => {
    const before = frameOf(get());
    rawSet(partial);
    // 组内 / 回放中不记录：组结束时会统一记一笔，回放（undo）自己递归
    if (suspended || groupDepth > 0) return;
    const after = frameOf(get());
    const shapeChanged = shapeSig(before) !== shapeSig(after);
    const dataChanged = dataSig(before) !== dataSig(after);
    if (!shapeChanged && !dataChanged) {
      // 只剩位置（或纯瞬态）变动。位置没动就不入栈——selected/busy 的
      // 每次跳动都记一笔的话，按一次 Ctrl+Z 只撤掉一个高亮
      const posChanged =
        before.nodes.length !== after.nodes.length ||
        before.nodes.some((n, i) => {
          const m = after.nodes[i];
          return !m || n.position.x !== m.position.x || n.position.y !== m.position.y;
        });
      if (!posChanged) return;
      // 拖拽中途帧 / 800ms 内的连续位置变更 → 合并进上一笔
      if (mergeHint || (lastKind === 'pos' && Date.now() - lastAt < HIST_MERGE_MS)) return;
      pushFrame(before, 'pos');
      return;
    }
    // 滑杆 / 微调的连续数据变更 → 合并进上一笔（一次性消费）
    if (mergeNext) {
      mergeNext = false;
      if (lastKind === 'data' && Date.now() - lastAt < HIST_MERGE_MS) return;
    }
    pushFrame(before, 'data');
    // 结构 / 内容变更打断位置合并：否则一次异常的拖拽会话（没等到
    // dragging:false 就被别的操作打断）会让下一段拖动整段漏记
    posMerge = false;
    mergeHint = false;
  }) as typeof rawSet;

  /** 把某一帧写回 state，并推平 RF 内部选中态。自身不记录历史 */
  const applyFrame = (f: HistoryFrame) => {
    suspended = true;
    rawSet({
      nodes: f.nodes,
      edges: f.edges,
      selectedId: f.selectedId,
      selection: f.selection,
      expandedId: f.expandedId,
    });
    /* 只改 store 镜像不够：RF 内部选中态不同步的话，它稍后一次空选中回调
       （onSelectionChange → setSelection([])）就把 selectedId 打回 null。
       与 setSelected 同一道处理——推 select 变更让两边一致。 */
    const sel = new Set(f.selection);
    const changes = f.nodes
      .filter((n) => !!n.selected !== sel.has(n.id))
      .map((n) => ({ id: n.id, type: 'select' as const, selected: sel.has(n.id) }));
    if (changes.length) get().onNodesChange(changes);
    persist();
    suspended = false;
  };

  const undo = () => {
    if (!past.length) return;
    const cur = frameOf(get());
    const prev = past.pop()!;
    future.push(cur);
    if (future.length > HIST_CAP) future.shift();
    applyFrame(prev);
    syncHistory();
    log('info', '已撤销一步');
  };

  const redo = () => {
    if (!future.length) return;
    const cur = frameOf(get());
    const next = future.pop()!;
    past.push(cur);
    if (past.length > HIST_CAP) past.shift();
    applyFrame(next);
    syncHistory();
    log('info', '已重做一步');
  };

  /**
   * 真正执行删除。
   * - cascade：连同后代一起删，关联 edge 同步清理
   * - orphan：只删本体，后代原地留下但 groupId 置空，不再跟随任何分组
   */
  const deleteNodes = (ids: string[], mode: DeleteMode) => {
    const { nodes, edges } = get();
    const removing = new Set(ids);
    if (mode === 'cascade') {
      for (const id of ids) {
        for (const d of collectDescendants(id, nodes, edges)) removing.add(d);
      }
    }
    const kept: FlowNode[] = [];
    let orphans = 0;
    for (const n of nodes) {
      if (removing.has(n.id)) continue;
      if (mode === 'orphan' && n.data.groupId && removing.has(n.data.groupId)) {
        kept.push({ ...n, data: { ...n.data, groupId: undefined } });
        orphans++;
        continue;
      }
      kept.push(n);
    }
    set((s) => ({
      // P2：概念被删时，挂在它上面的图节点要解除关联——否则图节点上的
      // 「→ 概念：X」chip 会指向一个不存在的节点，点了定位没有任何反应
      nodes: kept.map((n) =>
        n.data.linkedConceptId && removing.has(n.data.linkedConceptId)
          ? { ...n, data: { ...n.data, linkedConceptId: undefined } }
          : n,
      ),
      edges: edges.filter((e) => !removing.has(e.source) && !removing.has(e.target)),
      selectedId: s.selectedId && removing.has(s.selectedId) ? null : s.selectedId,
      expandedId: s.expandedId && removing.has(s.expandedId) ? null : s.expandedId,
      selection: s.selection.filter((id) => !removing.has(id)),
      wheelId: s.wheelId && removing.has(s.wheelId) ? null : s.wheelId,
      pendingDelete: null,
    }));
    persist();
    log(
      'ok',
      mode === 'cascade'
        ? `已删除 ${removing.size} 个节点`
        : `已删除 ${removing.size} 个节点，${orphans} 个延伸词脱离分组保留`,
    );
  };

  /** 竞品视觉共性，评分与权重推导都要读它 */
  const competitorLine = () =>
    get().intel.find((i) => i.kind === 'competitor')?.points.map((p) => p.text).join('；') ?? '';

  /**
   * AHP 权重：每个项目（每份简报）只推导一次，结果缓存。
   *
   * 简报变了才重算——否则同一个项目里评五个方向就要问模型五遍，
   * 既慢又可能得出五套互相打架的权重。
   */
  const ensureAhp = async (): Promise<AhpCache> => {
    const { product, brief } = get();
    const comp = competitorLine();
    const hash = `${product}||${brief}||${comp}`;
    const cached = get().ahp;
    if (cached && cached.briefHash === hash) return cached;

    const { settings } = get();
    const r = await chatJSON<{
      p12?: number; p13?: number; p14?: number;
      p23?: number; p24?: number; p34?: number;
    }>({
      settings,
      messages: [
        { role: 'system', content: ahpPrompt(product, brief, comp).system },
        { role: 'user', content: ahpPrompt(product, brief, comp).user },
      ],
    });
    const pairs = [r?.p12, r?.p13, r?.p14, r?.p23, r?.p24, r?.p34].map((v) => Number(v) || 1);
    const a = ahpWeights(buildJudgmentMatrix(pairs));
    const next: AhpCache = {
      // 一致性检验不通过 = 模型的比较自相矛盾（A>B, B>C, C>A），权重不可信
      weights: a.passed ? a.weights : DEFAULT_WEIGHTS,
      cr: a.cr,
      crPassed: a.passed,
      briefHash: hash,
    };
    set({ ahp: next });
    persist();
    log(
      'info',
      a.passed
        ? `AHP 权重已推导（CR=${a.cr.toFixed(3)}）：${next.weights.map((w) => (w * 100).toFixed(0) + '%').join(' / ')}`
        : `AHP 一致性检验未通过（CR=${a.cr.toFixed(3)}），已回退默认权重`,
    );
    return next;
  };

  /**
   * 弹告警并写入日志。
   * hint 未显式给出时，尝试从错误信息里诊断出一条可操作建议。
   */
  const raiseAlert = (level: AlertLevel, title: string, e: unknown, hint?: string, retry?: () => void) => {
    const reason = errorMessage(e);
    set({
      alert: {
        level,
        title,
        reason,
        hint: hint ?? diagnoseAIError(reason) ?? undefined,
        retry,
      },
    });
    log('err', `${title}：${reason}`);
  };

  /** 轻提示：不打断操作，3 秒后自动消失 */
  const toast = (text: string, tone: 'warn' | 'ok' = 'warn') => {
    set({ toast: { id: uid(), text, tone } });
    log(tone === 'warn' ? 'warn' : 'ok', text);
  };

  /**
   * 包装 AI 调用：统一处理 busy 态与错误上报。
   * 失败一律走 fatal 弹窗——日志区太不显眼，用户会以为「点了没反应」。
   */
  async function withBusy<T>(nodeId: string, label: string, fn: () => Promise<T>, retry?: () => void): Promise<T | null> {
    patchNode(nodeId, { busy: true });
    log('info', `${label}…`);
    try {
      const r = await fn();
      log('ok', `${label}完成`);
      return r;
    } catch (e) {
      raiseAlert('fatal', `${label}失败`, e, undefined, retry);
      return null;
    } finally {
      patchNode(nodeId, { busy: false });
    }
  }

  /**
   * F10：让 AI 出一轮苏格拉底式提问，并把回复规整成 ClarifyMessage。
   * 只做网络 + 结构规整，不碰 store —— 由 beginClarify / sendClarify 决定何时落盘。
   */
  const askClarifyRound = async (msgs: ClarifyMessage[], round: number): Promise<ClarifyMessage> => {
    const { product, brief, mood, settings } = get();
    const history = transcriptText(msgs);
    const { system, user } = clarifyTurnPrompt(product, brief, mood, history, round, MAX_CLARIFY_ROUNDS);
    const r = await chatJSON<{
      questions?: { text?: string; reason?: string; options?: string[] }[];
      summary?: string;
      ready?: boolean;
    }>({
      settings,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const questions = (r?.questions ?? [])
      .filter((q) => q && (q.text ?? '').trim())
      .slice(0, 3)
      .map((q) => {
        const text = (q.text ?? '').trim();
  return {
          id: `q-${uid()}`,
          text,
          reason: q.reason ?? '',
          options: (q.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 4),
        };
      });
    if (!questions.length && !r?.ready) {
      throw new AIError('模型没有返回有效问题，请重试');
    }
    // ready 即收束信号：即使模型同时给了问题也不再追问（PRD：ready → 进 Stage 2）
    return {
      id: `m-${uid()}`,
      role: 'ai',
      questions: r?.ready ? undefined : questions,
      summary: (r?.summary ?? '').trim() || undefined,
      round,
      ready: !!r?.ready,
    };
  };

  /**
   * 生成创意简报（内部步骤，不包 busy 态，供 runBrief / runPlan 复用）。
   * 组合节点会把 combo.logic 当附加上下文传进去——否则组合词的简报
   * 跟单词没区别，「为什么要组合」就白想了。
   */
    const doBrief = async (nodeId: string): Promise<void> => {
      const { brief, settings } = get();
      const node = get().nodes.find((n) => n.id === nodeId);
      if (!node) return;
      // 简报只属于「词」。图片节点跑过 AI 读图后也会进详情面板，
      // 若在这里放行，doBrief 会把 image 节点改成 concept —— 提取色卡 / AI 读图入口
      // 就再也回不来了（不可逆，没有转回去的入口）。
      if (node.data.kind !== 'seed' && node.data.kind !== 'word' && node.data.kind !== 'concept') {
        throw new Error('这个节点不是词，出不了创意简报');
      }

    // 回溯联想链：让简报知道这个词是从哪一路长出来的
    const chain: string[] = [];
    let cur = nodeId;
    for (let i = 0; i < 6; i++) {
      const e = get().edges.find((x) => x.target === cur);
      if (!e) break;
      const p = get().nodes.find((n) => n.id === e.source);
      if (!p) break;
      chain.unshift(p.data.label);
      cur = p.id;
    }

    const extra = node.data.combo?.logic || '';
    const { system, user } = briefPrompt(node.data.label, chain, brief, extra);
    const b = await chatJSON<{
      name?: string; imagery?: string; color?: string;
      font?: string; shape?: string; strategy?: string;
    }>({
      settings,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const fresh = get().nodes.find((n) => n.id === nodeId);
    if (!fresh) return;
    // type 也必须跟着改，否则 React Flow 仍按 word 组件渲染
    patchNodeFull(nodeId, {
      type: 'concept',
      data: {
        ...fresh.data,
        kind: 'concept',
        // 从种子词升格而来：左栏种子词列表据此继续保留它，不让用户以为词丢了
        wasSeed: fresh.data.kind === 'seed' || fresh.data.wasSeed ? true : undefined,
        // asText：真实模型可能把 color 返回成 {main:'#x'} 对象——原样入库，
        // 渲染简报 tab 时 React 直接崩成白屏（mock 永远返回正确形状，测不出来）
        brief: {
          name: asText(b?.name) || fresh.data.label,
          imagery: asText(b?.imagery),
          color: asText(b?.color),
          font: asText(b?.font),
          shape: asText(b?.shape),
          strategy: asText(b?.strategy),
        },
      },
    });
    persist();
  };

  /** 生成生图提示词（内部步骤）。没有简报就抛错，由调用方决定怎么提示 */
  const doPrompts = async (nodeId: string): Promise<void> => {
    const { settings } = get();
    const node = get().nodes.find((n) => n.id === nodeId);
    const b = node?.data.brief;
    if (!node) return;
    if (!b?.imagery && !b?.shape) {
      throw new Error('还没有创意简报，先出简报再出提示词');
    }
    const { system, user } = promptGenPrompt(b, { product: get().product, brief: get().brief, mood: get().mood });
    const p = await chatJSON<Partial<Prompts>>({
      settings,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    patchNode(nodeId, {
      prompts: {
        gpt: asText(p?.gpt),
        jimeng: asText(p?.jimeng),
        mj: asText(p?.mj),
        negative: asText(p?.negative),
      },
    });
    persist();
  };

  /** 评分（内部步骤）。AHP → 四准则 → KANO 三步串联，见 runScore 注释 */
  const doScore = async (nodeId: string): Promise<void> => {
    const { brief, settings, feedback } = get();
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const comp = competitorLine();

    // 步骤 1：AHP 权重。失败不阻断评分，退回默认权重继续
    let ahp: AhpCache;
    try {
      ahp = await ensureAhp();
    } catch (e) {
      toast(`AHP 权重推导失败，已使用默认权重（${errorMessage(e)}）`);
      ahp = { weights: DEFAULT_WEIGHTS, cr: 1, crPassed: false, briefHash: '' };
    }

    // 步骤 2：四准则锚点打分
    const sc = await chatJSON<{
      c1?: { score?: number; why?: string };
      c2?: { score?: number; why?: string };
      c3?: { score?: number; why?: string };
      c4?: { score?: number; why?: string };
    }>({
      settings,
      messages: [
        { role: 'system', content: scoreV2Prompt(node.data.label, brief, comp, feedback).system },
        { role: 'user', content: scoreV2Prompt(node.data.label, brief, comp, feedback).user },
      ],
    });
    // 模型可能返回一个合法但空的对象（{}）。那不是"全部 0 分"，而是这次评分没跑出来——
    // 静默写成 0 分会给出「砍掉」的结论，用户会以为自己的方向真的不行
    const any = [sc?.c1?.score, sc?.c2?.score, sc?.c3?.score, sc?.c4?.score].some(
      (v) => typeof v === 'number' && Number.isFinite(v),
    );
    if (!any) throw new AIError('模型没有返回有效评分，请重试');
    const pick = (o?: { score?: number; why?: string }) => ({
      score: clamp10(o?.score),
      why: asText(o?.why).trim(),
    });
    const c1 = pick(sc.c1);
    const c2 = pick(sc.c2);
    const c3 = pick(sc.c3);
    const c4 = pick(sc.c4);

    // 步骤 3：KANO 属性判定
    const kr = await chatJSON<{
      persona?: string;
      dist?: Record<string, number>;
      basis?: string;
      anchored?: boolean;
      grounded?: boolean;
    }>({
      settings,
      messages: [
        { role: 'system', content: kanoPrompt(node.data.label, brief, feedback).system },
        { role: 'user', content: kanoPrompt(node.data.label, brief, feedback).user },
      ],
    });
    const dist = normalizeDist(kr?.dist);
    const kc = kanoCoefficients(dist);
    // 人工校准不能被 AI 覆盖——用户手上的用研结论比模型推断可靠。
    // 必须重取：两次 await 期间用户可能刚改过 KANO 下拉，用开头那份快照会把他改的值冲掉。
    // P4：userAdj 同理——用户对四准则的调整也不被重跑评分清空。
    const freshScore = get().nodes.find((n) => n.id === nodeId)?.data.score;
    const manual = freshScore?.kano?.manual;
    const userAdj = freshScore?.userAdj;
    const effective = manual ?? kc.primary;
    const kano: KanoResult = {
      attr: kc.primary,
      dist,
      better: kc.better,
      worse: kc.worse,
      persona: asText(kr?.persona).trim(),
      basis: asText(kr?.basis).trim(),
      anchored: kr?.anchored !== false && !!brief.trim(),
      manual,
      // 简报里填了真实用户反馈，或模型自述采用了该反馈
      grounded: !!feedback.trim() || kr?.grounded === true,
    };

    const base = weightedBase([c1.score, c2.score, c3.score, c4.score], ahp.weights);
    const value = valueScore(base, kanoFactor(effective));
    const quadrant = quadrantOf(c3.score, c4.score);

    patchNode(nodeId, {
      score: {
        v: 2,
        c1,
        c2,
        c3,
        c4,
        weights: ahp.weights,
        cr: ahp.cr,
        crPassed: ahp.crPassed,
        kano,
        value,
        quadrant,
        decision: decide(value, quadrant),
        userAdj,
      },
    });
    persist();
  };

  return {
    brief: persisted.brief ?? '',
    product: persisted.product ?? '',
    mood: persisted.mood ?? '',
    feedback: persisted.feedback ?? '',
    ahp: persisted.ahp ?? null,
    references: persisted.references ?? [],
    report: persisted.report ?? null,
    reportOpen: false,
    deepDiving: false,
    diveSeeds: [],
    nodes: persisted.nodes ?? [],
    edges: persisted.edges ?? [],
    intel: persisted.intel ?? [],
    settings: persisted.settings ?? DEFAULT_SETTINGS,
    selectedId: null,
    logs: [],
    panelTab: 'brief',
    wheelId: null,
    alert: null,
    toast: null,
    pendingDelete: null,
    guideOpen: false,
    settingsOpen: false,
    selection: [],
    converging: false,
    // 老用户（有 report / 有节点 / 只填了项目名）直接进画布，不打断（PRD 10.4）；
    // 全新 / 清空过的人走澄清
    stage: persisted.report || (persisted.nodes ?? []).length || (persisted.product ?? '').trim()
      ? 'canvas'
      : 'clarify',
    clarify: [],
    clarifyBusy: false,
    closingAsk: false,
    expandedId: null,
    rediveAsk: false,
    linkHintId: null,
    // P5：历史栈会话内有效（不落盘的理由见 HistoryFrame 注释）；
    // 快照从独立键读入（storage.ts），按 D7 不含图片
    past: [],
    future: [],
    snaps: loadSnaps(),
    snapshotOpen: false,

    openWheel(id) { set({ wheelId: id, selectedId: id }); },
    closeWheel() { set({ wheelId: null }); },

    openGuide() { set({ guideOpen: true }); },
    closeGuide(remember) {
      if (remember) {
        try {
          localStorage.setItem(GUIDE_KEY, '1');
        } catch {
          // 隐私模式下写不进去，退化成「本次会话不再弹」
        }
      }
      set({ guideOpen: false });
    },

    openSettings() { set({ settingsOpen: true }); },
    closeSettings() { set({ settingsOpen: false }); },

    setBrief(v) { set({ brief: v }); },
    setProduct(v) { set({ product: v }); },
    setMood(v) { set({ mood: v }); },
    setFeedback(v) { set({ feedback: v }); persist(); },
    setReportOpen(v) { set({ reportOpen: v }); },
    toggleTodo(i) {
      const r = get().report;
      if (!r?.todos?.[i]) return;
      const todos = r.todos.map((t, k) => (k === i ? { ...t, done: !t.done } : t));
      set({ report: { ...r, todos } });
      persist();
    },

    /* ---------- F10 流程：澄清 → 简报 → 画布 ---------- */

    /**
     * 输入主题并开始澄清。
     * 全新项目：清空旧对话从第 1 轮问起；已填过 product 再回来（从画布/简报返回）不清空画布。
     */
    async beginClarify(subject) {
      const s = (subject ?? '').trim();
      if (!s) {
        toast('先说说这次要探索什么');
        return;
      }
      set({ product: s, stage: 'clarify', clarify: [], clarifyBusy: true, reportOpen: false });
      log('info', `开始澄清：「${s}」`);
      try {
        const ai = await askClarifyRound([], 1);
        set((st) => ({ clarify: [...st.clarify, ai], clarifyBusy: false }));
        if (ai.ready) await get().finishClarify();
      } catch (e) {
        set({ clarifyBusy: false });
        raiseAlert('fatal', '澄清对话失败', e);
      }
    },

    /** 提交回答 → 追加用户消息 → AI 追问下一轮（或就绪后自动收束） */
    async sendClarify(answers, extra) {
      const { clarifyBusy } = get();
      if (clarifyBusy) return;
      const clean = (answers ?? [])
        .filter((a) => a && a.qid && (a.text ?? '').trim())
        .map((a) => ({ qid: a.qid, text: a.text.trim().slice(0, 200) }));
      const extraText = (extra ?? '').trim().slice(0, 500);
      if (!clean.length && !extraText) return;

      const userMsg: ClarifyMessage = {
        id: `m-${uid()}`,
        role: 'user',
        answers: clean.length ? clean : undefined,
        text: extraText || undefined,
      };
      set((s) => ({ clarify: [...s.clarify, userMsg], clarifyBusy: true }));

      try {
        // 下一轮若超过硬性上限就不再问，直接收束（PRD：不能无限追问）
        const nextRound = questionRounds(get().clarify) + 1;
        if (nextRound > MAX_CLARIFY_ROUNDS) {
          set({ clarifyBusy: false });
          log('warn', `已达 ${MAX_CLARIFY_ROUNDS} 轮上限，自动整理简报`);
          await get().finishClarify();
          return;
        }
        const ai = await askClarifyRound(get().clarify, nextRound);
        set((s) => ({ clarify: [...s.clarify, ai], clarifyBusy: false }));
        // AI 判断信息已足够 → 按 PRD 终止条件自动进入简报页
        if (ai.ready) await get().finishClarify();
      } catch (e) {
        set({ clarifyBusy: false });
        raiseAlert('fatal', '澄清对话失败', e);
      }
    },

    /**
     * 收尾确认门。三条路都会走到这里：用户点「够了」、AI 判 ready、轮次到顶。
     * 不直接生成——先把「还有没有资料要交、有没有特殊要求」问完再说，
     * 否则用户只能等简报出来后对着画布干瞪眼补信息。
     */
    async finishClarify() {
      const { clarify, clarifyBusy, stage } = get();
      if (clarifyBusy) return;
      if (!clarify.length) {
        toast('还没有对话内容，先在对话里回答几轮');
        return;
      }
      if (stage === 'report') return;
      log('info', '生成简报前，最后确认一遍参考资料和特殊要求');
      set({ closingAsk: true });
    },

    /** 收尾确认卡上点「就这些，生成简报」→ 真正开始生成 */
    async confirmFinish() {
      const { stage } = get();
      set({ closingAsk: false });
      if (stage === 'report') return;
      set({ clarifyBusy: true });
      log('info', '正在把对话整理成项目简报…');
      try {
        const { product, brief, mood, settings } = get();
        const history = transcriptText(get().clarify);
        const { system, user } = briefFromClarifyPrompt(product, brief, mood, history);
        const r = await chatJSON<{ product?: string; brief?: string; mood?: string }>({
          settings,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        });
        set({
          product: (r?.product ?? '').trim() || product,
          brief: (r?.brief ?? '').trim() || brief,
          mood: (r?.mood ?? '').trim() || mood,
          clarifyBusy: false,
          stage: 'report',
        });
        persist();
        log('ok', '简报草稿已生成，请在确认页修改后进入画布');
      } catch (e) {
        set({ clarifyBusy: false });
        raiseAlert('fatal', '生成简报失败', e);
      }
    },

    cancelFinish() {
      set({ closingAsk: false });
    },

    /** 逃生舱：跳过提问直接进画布（保留对话，之后可回来继续） */
    skipClarify() {
      const { product } = get();
      set({ stage: 'canvas', clarifyBusy: false, reportOpen: false });
      persist();
      if (!product.trim()) {
        log('info', '已跳过澄清，进入画布：可直接输入种子词，或填项目名后开始深潜');
      } else {
        log('ok', `已跳过澄清，围绕「${product.trim()}」直接进入画布`);
      }
    },

    /** 从画布/简报返回澄清（保留对话；对话清空过则新起） */
    goClarify() {
      const { stage, clarify } = get();
      if (stage === 'clarify') return;
      set({ stage: 'clarify', reportOpen: false });
      if (!clarify.length) {
        log('info', '回到需求澄清——先说说这次想探索什么');
      } else {
        log('info', '回到需求澄清——对话已保留，可继续补充');
      }
    },

    /** 从画布回简报确认页。和 goClarify 的分工：改"要什么"去澄清对话，
     *  改"写下来的结论"来简报页。两条都能随时回，F10 阶段机不是单行道。 */
    goReport() {
      const { stage, report } = get();
      if (stage === 'report') return;
      set({ stage: 'report', reportOpen: false });
      log('info', report ? '回到项目简报——改完确认后重新进入画布' : '还没有项目简报——在这里写一份，确认后进入画布');
    },

    /** 简报确认页 → 写入字段、进入画布并触发深潜（无 Key 也能进，只是跳过 AI） */
    async enterCanvasFromReport() {
      const { product, settings, nodes } = get();
      if (!product.trim()) {
        toast('先填「项目 / 产品」名称');
        return;
      }
      persist();

      // 没有 Key：没有可等的东西，别拿加载页糊人
      if (!settings.apiKey.trim()) {
        set({ stage: 'canvas', reportOpen: false });
        log('ok', '简报已确认，进入画布');
        toast('未配置 API Key，已直接进入画布：可输入种子词，或点「AI 设置」配置后点「开始深潜」');
        return;
      }

      /* 首次深潜（空画布）：先停在「正在深潜」过渡页。
         这一页做三件事——把 20-60 秒的等待变成可见的过程、让用户先把想到的词记下来、
         完成后自动把他送到画布上。原来这里是"点完瞬间到画布"，用户只看到一块空地
         慢慢长出节点，既不知道 AI 在干什么，也没有机会插手。 */
      if (!nodes.length) {
        set({ stage: 'diving', reportOpen: false, diveSeeds: [] });
        log('ok', '简报已确认，开始深潜：行业 → 竞品 → 视觉 → SWOT…');
        void get().runDeepDive();
        return;
      }

      // 画布已有内容：要走「重新深潜」语义框，而那个框得在看得见画布的地方弹，
      // 所以跳过过渡页，保持原路径。
      set({ stage: 'canvas', reportOpen: false });
      log('ok', '简报已确认，开始深潜：行业 → 竞品 → 视觉 → SWOT…');
      get().startDeepDive();
    },

    hydrateFromCloud(p) {
      // 云端覆盖是「同步」不是「用户操作」：不为它记历史步——
      // 覆盖后按一次撤销把整个工作区换回去，比不记更吓人
      suspended = true;
      set({
        brief: p.brief,
        product: p.product,
        mood: p.mood,
        references: p.references,
        report: p.report,
        nodes: p.nodes,
        edges: p.edges,
        intel: p.intel,
        settings: p.settings,
        // 云端有内容就把 stage 顶到画布（10.4：老用户不打断）；
        // 两边都空则保持当前 stage（引导弹完自然进入澄清）
        stage: p.report || (p.nodes ?? []).length ? 'canvas' : get().stage,
      });
      suspended = false;
      persist();
      log('ok', '已从云端同步最新工作区');
    },
    setPanelTab(t) { set({ panelTab: t }); },

    async addReferences(files) {
      const stubs = files.map((f) => ({ file: f, ref: stub(f, detectKind(f)) }));
      set((s) => ({ references: [...s.references, ...stubs.map((x) => x.ref)] }));
      // 原始文件留在内存里（不持久化）：手动「改用深度解析」要重跑解析才有图片层
      for (const { file, ref } of stubs) refFiles.set(ref.id, file);

      for (const { file, ref } of stubs) {
        if (ref.kind === 'other') {
          set((s) => ({
            references: s.references.map((r) =>
              r.id === ref.id ? { ...r, status: 'error', error: '暂不支持该格式（.ppt 请先转 .pptx 或 PDF）' } : r,
            ),
          }));
          continue;
        }
        try {
          const out = await parseFile(file);
          const upgraded = out.pages?.length ?? 0;
          set((s) => ({
            references: s.references.map((r) =>
              r.id === ref.id
                ? { ...r, ...out, parseMode: upgraded ? 'deep' : 'fast', status: 'done' }
                : r,
            ),
          }));
          if (upgraded) {
            // 自动升级要让用户知道两件事：为什么升级、要多花 token
            log('info', `「${ref.name}」文本层稀薄，已自动启用图片识别（${upgraded} 页）`);
            toast(`「${ref.name}」以图片内容为主，已启用图片识别，本次深潜将消耗较多 token`);
          } else {
            log('ok', `已解析「${ref.name}」`);
          }
        } catch (e) {
          set((s) => ({
            references: s.references.map((r) =>
              r.id === ref.id ? { ...r, status: 'error', error: (e as Error).message } : r,
            ),
          }));
          raiseAlert('fatal', `「${ref.name}」解析失败`, e);
        }
      }
      persist();
    },

    /**
     * 手动切换解析模式（覆盖自动判定）。
     * fast→deep 需要图片层，原始文件还留着就重解析；刷新过后 File 没了，
     * 只能提示重新上传——不能静默假装切换成功。
     */
    async setRefParseMode(id, mode) {
      const ref = get().references.find((r) => r.id === id);
      if (!ref || ref.parseMode === mode) return;

      if (mode === 'fast') {
        // fast 只是「发的时候不带图」，图片层留着不删，切回 deep 零成本
        set((s) => ({
          references: s.references.map((r) => (r.id === id ? { ...r, parseMode: 'fast' } : r)),
        }));
        persist();
        return;
      }

      const file = refFiles.get(id);
      if (!file) {
        raiseAlert(
          'warn',
          `「${ref.name}」需要重新解析才能提取图片`,
          new Error('页面刷新后原始文件已不在内存'),
          '请删除该项后重新上传同一文件，会自动完成图片识别。',
        );
        return;
      }
      set((s) => ({
        references: s.references.map((r) => (r.id === id ? { ...r, status: 'parsing' } : r)),
      }));
      try {
        const out = await parseFile(file, true);
        set((s) => ({
          references: s.references.map((r) =>
            r.id === id ? { ...r, ...out, parseMode: 'deep', status: 'done' } : r,
          ),
        }));
        log('ok', `「${ref.name}」已切换为深度解析（${out.pages?.length ?? 0} 页图片）`);
      } catch (e) {
        set((s) => ({
          references: s.references.map((r) =>
            r.id === id ? { ...r, status: 'error', error: (e as Error).message } : r,
          ),
        }));
        raiseAlert('fatal', `「${ref.name}」解析失败`, e);
      }
      persist();
    },

    removeReference(id) {
      refFiles.delete(id);
      set((s) => ({ references: s.references.filter((r) => r.id !== id) }));
      persist();
    },
    setSettings(p) {
      set((s) => ({ settings: { ...s.settings, ...p } }));
      // API Key / 模型 / 云端开关必须落盘：这是全项目唯一一个"用户以为存住了"的路径，
      // 漏掉 persist 的表现是填完 Key 刷新就回到默认值（saveState 有防抖，连续输入不会打爆）
      persist();
    },
    setSelected(id) {
      set({ selectedId: id });
      // 必须把 RF 内部选中态一起推平：排行/象限图点词不经过 RF 的选中事件，
      // 若只改镜像，RF 稍后用它的空选中回调 onSelectionChange → setSelection([]),
      // 一眨眼就把 selectedId 冲回 null（实测设上去几百毫秒内必被打回）。
      // 推 select 变更让 RF 与镜像一致，顺带画布上也会出现选中环，点词定位名实相符。
      const { nodes } = get();
      const changes = nodes
        .filter((n) => !!n.selected !== (n.id === id))
        .map((n) => ({ id: n.id, type: 'select' as const, selected: n.id === id }));
      if (changes.length) get().onNodesChange(changes);
    },
    clearLogs() { set({ logs: [] }); },
    raiseAlert,
    dismissAlert() { set({ alert: null }); },
    dismissToast() { set({ toast: null }); },

    onNodesChange(changes) {
      const { nodes, edges } = get();
      /* P5：拖拽会话标记（见历史栈注释 ①）。第一帧照常入栈、记下拖动前的
         位置；后续帧全部合并进那一笔；松手那一下（dragging:false）也算
         同一笔——它若单独入栈，撤销会退到「松手前最后一帧」而非「拖动前」。
         mergeHint 必须在 set 之前算好：它回答的是「这次变更是不是合并中的
         后续帧」，用的是进入本次变更之前的状态。 */
      const dragOn = changes.some((c) => c.type === 'position' && c.dragging === true);
      const dragOff = changes.some((c) => c.type === 'position' && c.dragging === false);
      mergeHint = posMerge;
      if (dragOn) posMerge = true;
      else if (dragOff) posMerge = false;
      // 拖动时把位移传播给同组后代——否则只有种子词动，延伸词留在原地，
      // 几颗种子的词就混作一团分不清归属了。
      const dragged = new Set<string>();
      const delta = new Map<string, { dx: number; dy: number }>();
      for (const c of changes) {
        if (c.type !== 'position' || !c.position) continue;
        dragged.add(c.id);
        if (!c.dragging) continue;
        const before = nodes.find((n) => n.id === c.id);
        if (!before) continue;
        const dx = c.position.x - before.position.x;
        const dy = c.position.y - before.position.y;
        if (!dx && !dy) continue;
        for (const d of collectDescendants(c.id, nodes, edges)) {
          if (!delta.has(d)) delta.set(d, { dx, dy });
        }
      }

      set((s) => ({
        nodes: applyNodeChanges(changes, s.nodes).map((n) => {
          // 自己也在被拖（多选场景）：applyNodeChanges 已经处理过，不能再叠加
          if (dragged.has(n.id)) return n;
          const d = delta.get(n.id);
          return d ? { ...n, position: { x: n.position.x + d.dx, y: n.position.y + d.dy } } : n;
        }),
      }));
      persist();
    },
    onEdgesChange(changes) {
      set((s) => ({ edges: applyEdgeChanges(changes, s.edges) }));
      persist();
    },

    onConnect(c) {
      if (!c.source || !c.target || c.source === c.target) return;
      const id = `e-${uid()}`;
      set((s) => ({
        edges: addEdge(
          { ...c, id, type: 'simplebezier', data: { analyzing: true }, style: { stroke: '#A99B8A', strokeWidth: 2 } },
          s.edges,
        ),
      }));
      persist();
      void get().runLinkAnalysis(id);
    },

    addSeed(word) {
      const w = word.trim().slice(0, 40);
      if (!w) return null;
      const { nodes } = get();
      const position = resolveOverlap(clusterAnchor(nodes), nodes);
      const id = `n-${uid()}`;
      const n: FlowNode = {
        id,
        type: 'seed',
        position,
        // 种子自己就是组根：整枝后代共用这个 id
        data: { label: w, kind: 'seed', groupId: id },
      };
      set((s) => ({ nodes: [...s.nodes, n], selectedId: n.id }));
      persist();
      log('ok', `种下种子「${w}」`);
      return n.id;
    },

    addNodeAt(word, position) {
      const w = word.trim();
      if (!w) return;
      const { nodes } = get();
      // 落点压住已有节点时才推开，否则尊重用户拖放的位置
      const spot = resolveOverlap(position, nodes);
      const id = `n-${uid()}`;
      const n: FlowNode = {
        id,
        type: 'seed',
        position: spot,
        data: { label: w.slice(0, 40), kind: 'seed', groupId: id },
      };
      set((s) => ({ nodes: [...s.nodes, n], selectedId: n.id }));
      persist();
      log('ok', `拖入种子「${n.data.label}」`);
    },

    /* ─────────── P6：便签 ─────────── */

    addNote(text, position, draft) {
      const t = text.trim().slice(0, NOTE_MAX);
      if (!t) return null;
      const { nodes } = get();
      // 没给落点时落在整块内容的左侧空位：便签是「贴在思考现场旁边」的旁注，
      // 挤进节点堆里会把已有布局顶开（resolveOverlap 会推开邻居）
      const spot = resolveOverlap(position ?? noteSpot(nodes), nodes);
      const id = `n-${uid()}`;
      const n: FlowNode = {
        id,
        type: 'note',
        position: spot,
        data: { label: t, kind: 'note', noteTone: 'sun', noteDraft: draft || undefined },
      };
      set((s) => ({ nodes: [...s.nodes, n], selectedId: n.id }));
      persist();
      log('ok', '新增便签');
      return id;
    },

    setNoteText(id, text) {
      const node = get().nodes.find((n) => n.id === id);
      if (!node || node.data.kind !== 'note') return;
      const t = text.trim().slice(0, NOTE_MAX);
      // 编辑成空等于删除意图，但先不删——用户可能只是全选后还没输入。
      // 留一张空便签比悄悄删掉一个节点可预期（删除有专门的动作）
      if (t === node.data.label && !node.data.noteDraft) return;
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, label: t, noteDraft: undefined } } : n,
        ),
      }));
      persist();
    },

    setNoteTone(id, tone) {
      const node = get().nodes.find((n) => n.id === id);
      if (!node || node.data.kind !== 'note' || node.data.noteTone === tone) return;
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, noteTone: tone } } : n)),
      }));
      persist();
    },

    pinNote(text, source, nearId) {
      const t = text.trim().slice(0, NOTE_MAX);
      if (!t) return null;
      const { nodes } = get();
      const host = nearId ? nodes.find((n) => n.id === nearId) : undefined;
      // 贴来源节点右边；「钉」这个动作的直觉就是钉子钉在原件旁边。
      // 便签宽 190，留 34 的缝够看清是两件东西
      const spot = resolveOverlap(
        host
          ? { x: host.position.x + NODE_W + 34, y: host.position.y }
          : noteSpot(nodes),
        nodes,
      );
      const id = `n-${uid()}`;
      const n: FlowNode = {
        id,
        type: 'note',
        position: spot,
        data: { label: t, kind: 'note', noteTone: 'sun', noteSource: source },
      };
      set((s) => ({ nodes: [...s.nodes, n], selectedId: n.id }));
      persist();
      log('ok', `已钉为便签：${source}`);
      return id;
    },

    async createImageNode(files, position) {
      // 与 attachImages 同一道封顶：不拦的话一次拖 15 张就撑爆 localStorage 配额，
      // 连带之前所有未落盘的改动一起丢（写入失败时丢的不只是图片）
      const imgs = (await ingest(files)).slice(0, MAX_IMAGES);
      if (files.length > MAX_IMAGES) toast(`一次最多建 ${MAX_IMAGES} 张，已取前 ${MAX_IMAGES} 张`);
      if (!imgs.length) return;
      const n: FlowNode = {
        id: `n-${uid()}`,
        type: 'image',
        position,
        data: { label: imgs[0].name.replace(/\.[^.]+$/, '').slice(0, 24) || '参考图', kind: 'image', images: imgs },
      };
      set((s) => ({ nodes: [...s.nodes, n], selectedId: n.id }));
      persist();
      log('ok', `创建图节点，含 ${imgs.length} 张参考图`);
      void get().runPalette(n.id);
    },

    async attachImages(nodeId, files) {
      const node = get().nodes.find((n) => n.id === nodeId);
      const room = MAX_IMAGES - (node?.data.images?.length ?? 0);
      if (room <= 0) {
        toast(`单个节点最多 ${MAX_IMAGES} 张图，请先删除一些`);
        return;
      }
      const imgs = (await ingest(files)).slice(0, room);
      if (!imgs.length) {
        toast('没有识别到有效的图片文件');
        return;
      }
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, images: [...(n.data.images ?? []), ...imgs] } } : n,
        ),
      }));
      persist();
      log('ok', `挂载 ${imgs.length} 张参考图`);
    },

    removeImage(nodeId, imageId) {
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, images: (n.data.images ?? []).filter((i) => i.id !== imageId) } }
            : n,
        ),
      }));
      persist();
    },

    /**
     * P2：图节点 → 概念节点的关联。一张图同一时刻只属于一个概念——
     * 重新关联就是改挂，不叠加。「这图到底算谁的出图」必须唯一，
     * 否则概念卡面的缩略图条和留用计数都会重复计算。
     */
    linkImageToConcept(imageId, conceptId) {
      const { nodes } = get();
      const img = nodes.find((n) => n.id === imageId);
      const concept = nodes.find((n) => n.id === conceptId);
      if (!img || !concept) return;
      if (img.data.kind !== 'image' || concept.data.kind !== 'concept') {
        toast('只有参考图节点可以关联到概念');
        return;
      }
      if (img.data.linkedConceptId === conceptId) return;
      patchNode(imageId, { linkedConceptId: conceptId });
      persist();
      log('ok', `「${img.data.label}」已关联到概念「${concept.data.label}」`);
    },

    unlinkImageFromConcept(imageId) {
      const img = get().nodes.find((n) => n.id === imageId);
      if (!img?.data.linkedConceptId) return;
      patchNode(imageId, { linkedConceptId: undefined });
      persist();
      log('info', `「${img.data.label}」已取消概念关联`);
    },

    /** P2：留用 / 淘汰是人工决策，不调 AI；同一个值重复点不写盘不刷日志 */
    setImageKeep(imageId, keep) {
      const img = get().nodes.find((n) => n.id === imageId);
      if (!img || img.data.keep === keep) return;
      patchNode(imageId, { keep });
      persist();
    },

    async runPalette(nodeId) {
      const node = get().nodes.find((n) => n.id === nodeId);
      const first = node?.data.images?.[0];
      if (!first) {
        toast('这个节点还没有图片');
        return;
      }
      try {
        const sw = await extractPalette(first.dataUrl, 6);
        const hex = sw.map((s) => s.hex);
        // P6-3：色卡同时也是「配色」这一维的结论。本地算出来的东西要标明来源——
        // 它和模型推断的另外三维摆在同一个面板里，不标就分不清可信度
        patchNode(nodeId, {
          palette: hex,
          visual: {
            ...(node?.data.visual ?? {}),
            v: 2,
            dims: {
              ...(node?.data.visual?.dims ?? {}),
              palette: { text: hex.join(' · '), from: 'local', at: Date.now() },
            },
          },
        });
        persist();
        log('ok', `提取色卡 ${sw.length} 色（本地算法，未上传图片）：${hex.join(' ')}`);
      } catch (e) {
        raiseAlert('fatal', '色卡提取失败', e);
      }
    },

    async runVision(nodeId, dim) {
      const { nodes, brief, settings } = get();
      const node = nodes.find((n) => n.id === nodeId);
      const imgs = node?.data.images ?? [];
      if (!imgs.length) {
        toast('先给这个节点挂一张图');
        return;
      }
      // 配色走本地：不要为了问颜色把图发出去（免费 + 确定 + 不泄露素材）
      if (dim === 'palette') {
        await get().runPalette(nodeId);
        return;
      }

      patchNode(nodeId, { busy: true });
      const label = VISION_DIMS.find((d) => d.key === dim)?.label ?? dim;
      log('info', `AI 正在提取${label}（${imgs.length} 张）…`);
      try {
        const { system, user } = visionDimPrompt(dim, brief, imgs.length);
        const content: ContentPart[] = [
          ...imgs.slice(0, 4).map((img) => ({ type: 'image_url' as const, image_url: { url: img.dataUrl } })),
          { type: 'text' as const, text: user },
        ];
        const r = await chatJSON<{ text?: string; tags?: unknown }>({
          settings,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content },
          ],
        });
        const text = asText(r?.text);
        if (!text) throw new Error('模型没有返回可用的内容');
        const tags = Array.isArray(r?.tags) ? r.tags.map((t) => asText(t)).filter(Boolean).slice(0, 5) : [];
        const prev = node?.data.visual;
        patchNode(nodeId, {
          visual: {
            ...(prev ?? {}),
            v: 2,
            dims: {
              ...(prev?.dims ?? {}),
              [dim]: { text, from: 'ai', at: Date.now(), tags: tags.length ? tags : undefined },
            },
          },
        });
        persist();
        log('ok', `${label}提取完成`);
      } catch (e) {
        const raw = (e as Error).message;
        // 大多数文本模型不支持视觉输入，给出可操作的指引而不是干巴巴的报错
        // 视觉模型不支持是最常见的失败原因，给出可直接执行的换模型指引
        const hint = /image|vision|视觉|图片|multi ?modal/i.test(raw)
          ? '当前模型不支持视觉输入，请在「AI 设置」里换成支持图片的模型（如 qwen-vl-max、glm-4v、gpt-4o）。'
          : undefined;
        raiseAlert('fatal', `提取${label}失败`, e, hint);
      } finally {
        patchNode(nodeId, { busy: false });
      }
    },

    addDiveSeed(word) {
      const w = word.trim().slice(0, 40);
      if (!w) return;
      // 去重：等待期人容易重复记同一个词，重复落位只会叠出两张一样的卡
      set((s) => (s.diveSeeds.includes(w) ? s : { diveSeeds: [...s.diveSeeds, w] }));
    },

    removeDiveSeed(word) {
      set((s) => ({ diveSeeds: s.diveSeeds.filter((x) => x !== word) }));
    },

    skipDiving() {
      if (get().stage !== 'diving') return;
      // 不取消请求：深潜照常跑，完成后节点会自己长出来。
      // 取消反而浪费已经花掉的 token 和时间。
      set({ stage: 'canvas' });
      log('info', '先进入画布，深潜仍在后台继续');
    },

    async runDeepDive() {
      const { product, brief, mood, references, settings, nodes } = get();
      if (!product.trim()) {
        toast('先填「项目 / 产品」名称，再开始深潜');
        return;
      }
      set({ deepDiving: true });
      log('info', 'AI 正在深潜：行业 → 竞品 → 视觉 → SWOT…');

      try {
        const ready = references.filter((r) => r.status === 'done');
        const textCtx = buildReferenceContext(ready);
        const refImgs = ready.filter((r) => r.kind === 'image' && r.dataUrl).slice(0, 4);

        // F7：深度解析的资料把图片页一并交给视觉模型（转曲文字/扫描件只有图里有）
        const visionOK = looksLikeVisionModel(settings.model);
        const deepRefs = ready.filter((r) => r.parseMode === 'deep' && r.pages?.length);
        let skippedPages = 0;
        const pageImgs: ContentPart[] = [];
        for (const r of deepRefs) {
          if (!visionOK) {
            skippedPages += r.pages!.length;
            continue;
          }
          for (const p of r.pages!) {
            if (pageImgs.length >= 16) break; // 总量封顶，防 token 失控
            pageImgs.push({ type: 'image_url' as const, image_url: { url: p.dataUrl } });
          }
        }
        if (skippedPages) {
          log(
            'warn',
            `「当前模型可能不支持视觉输入，${skippedPages} 页图片内容未参与分析（已回退文本层）。建议在「AI 设置」换成 qwen-vl-max / glm-4v / gpt-4o 等视觉模型后重试`,
          );
          toast('当前模型可能不支持读图，图片内容未参与本次分析');
        } else if (pageImgs.length) {
          log('info', `已附加 ${pageImgs.length} 页参考图片（视觉识别）`);
        }

        const { system, user } = deepDivePrompt(product, brief, mood, textCtx);
        const content: ContentPart[] = [
          ...refImgs.map((r) => ({ type: 'image_url' as const, image_url: { url: r.dataUrl! } })),
          ...pageImgs,
          { type: 'text' as const, text: user },
        ];
        const r = await chatJSON<DeepDiveResult>({
          settings,
          maxTokens: 8192,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content },
          ],
        });

        const report: DeepDiveReport = {
          product,
          createdAt: new Date().toISOString().slice(0, 10),
          industry: r?.report?.industry ?? '',
          competitors: (r?.report?.competitors ?? []).filter((c) => c?.name),
          visual: r?.report?.visual ?? { colors: '', tone: '', font: '' },
          swot: r?.report?.swot ?? { strengths: [], weaknesses: [], opportunities: [], threats: [] },
          summary: r?.report?.summary ?? '',
          todos: (r?.todos ?? []).filter((t) => typeof t === 'string' && t.trim()).slice(0, 4).map((t) => ({ text: t.trim(), done: false })),
        };

        const keys: IntelKind[] = ['audience', 'competitor', 'opportunity'];
        const cards: IntelCard[] = keys
          .filter((k) => r?.cards?.[k]?.points?.length)
          .map((k) => ({ ...r.cards[k]!, id: `i-${uid()}`, kind: k }));

        const seeds = (r?.seeds ?? []).filter((s) => s?.word).slice(0, 4);
        if (!cards.length && !seeds.length) throw new AIError('模型没有返回可用的卡片或种子词');

        // 等待期用户抢记的种子词一起落位：接在 AI 种子下面，不抢它们的前四位。
        // 先读一次 stage —— set 之后就读不到"是从哪个阶段过来的"了。
        const { diveSeeds, stage: stageBefore } = get();
        const origin = nextOrigin(nodes);
        const cardNodes: FlowNode[] = cards.map((c, i) => ({
          id: `n-${uid()}`,
          type: 'intel',
          position: { x: origin.x, y: origin.y + i * 280 },
          data: { label: c.title, kind: 'intel', intel: c },
        }));
        const seedNodes: FlowNode[] = seeds.map((s, i) => {
          const id = `n-${uid()}`;
          return {
            id,
            type: 'seed',
            position: { x: origin.x + 660, y: origin.y + i * 210 + 30 },
            data: {
              label: s.word.trim(),
              kind: 'seed',
              detail: s.why ?? '',
              seedWhy: s.why ?? '',
              seedSource: s.source ?? '',
              groupId: id,
            },
          };
        });
        const mineNodes: FlowNode[] = diveSeeds.map((w, i) => {
          const id = `n-${uid()}`;
          return {
            id,
            type: 'seed',
            position: { x: origin.x + 660, y: origin.y + (seeds.length + i) * 210 + 30 },
            data: { label: w, kind: 'seed', groupId: id },
          };
        });

        set((s) => ({
          report,
          intel: cards,
          nodes: [...s.nodes, ...cardNodes, ...seedNodes, ...mineNodes],
          // 不自动弹简报抽屉：它宽 460px，深潜一完就糊住画布，
          // 而用户此刻最想看的恰恰是刚长出来的种子词。要看完整简报点顶栏即可
          reportOpen: false,
          deepDiving: false,
          diveSeeds: [],
          /* 只有从「正在深潜」页过来的才自动落回画布。在画布里重跑深潜时
             stage 本来就是 canvas，不能被这一行影响。 */
          stage: stageBefore === 'diving' ? 'canvas' : s.stage,
          selectedId: (mineNodes[0] ?? seedNodes[0])?.id ?? s.selectedId,
        }));
        persist();
        log('ok', `深潜完成：简报 + ${cards.length} 张情报卡 + ${seeds.length + mineNodes.length} 个种子词已上画布（完整调研在顶栏「调研洞察」）`);
        if (stageBefore === 'diving') {
          toast(
            `深潜完成：${cards.length} 张情报卡 + ${seeds.length + mineNodes.length} 个种子词已就位` +
              (mineNodes.length ? `（含你记下的 ${mineNodes.length} 个）` : ''),
          );
        }
      } catch (e) {
        set({ deepDiving: false });
        raiseAlert('fatal', '深潜失败', e);
      }
    },

    /**
     * P2-bis：「开始深潜」的统一入口。
     *
     * runDeepDive 是**追加式**的（新一批情报卡 + 种子词接在现有内容下方，
     * 调研洞察整体替换）。画布上已有内容时，用户无法预期这个按钮是
     * 「重新来一遍」还是「再挖一轮」——先弹语义框让两种后果在点下去之前
     * 就可见。空画布（首次深潜）直接跑，老用户体验不变。
     */
    startDeepDive() {
      const { nodes } = get();
      if (!nodes.length) {
        void get().runDeepDive();
        return;
      }
      set({ rediveAsk: true });
    },

    cancelRedive() {
      set({ rediveAsk: false });
    },

    /**
     * P2-bis：确认重新深潜。
     * append = 现行追加行为（runDeepDive 本身零变更）；
     * fresh   = 先清空再深潜。
     *
     * fresh 为什么不直接调 resetCanvas：它会把 stage 打回 'clarify'、
     * 还可能弹引导模态，而这里要的是「留在画布、当场重跑」。
     * 清空范围与顶栏「清空」一致（简报/情报卡/参考资料/补充方向），
     * 项目名与 AI 设置保留——口径和清空确认框里写的一样。
     */
    confirmRedive(mode) {
      set({ rediveAsk: false });
      if (mode === 'append') {
        void get().runDeepDive();
        return;
      }
      set({
        nodes: [],
        edges: [],
        intel: [],
        references: [],
        report: null,
        reportOpen: false,
        mood: '',
        brief: '',
        feedback: '',
        ahp: null,
        selectedId: null,
        wheelId: null,
        expandedId: null,
        pendingDelete: null,
        selection: [],
        converging: false,
        linkHintId: null,
        stage: 'canvas',
      });
      persist();
      log('ok', '已清空画布与既有产出，围绕当前项目名重新深潜');
      void get().runDeepDive();
    },

    async runFission(nodeId, dim) {
      const { nodes, edges, brief, settings } = get();
      const parent = nodes.find((n) => n.id === nodeId);
      if (!parent) return;
      const parentLabel = parent.data.label;
      const childIds = new Set(edges.filter((e) => e.source === nodeId).map((e) => e.target));
      const existing = nodes
        .filter((n) => childIds.has(n.id) && n.data.kind === 'word')
        .map((n) => ({ word: n.data.label, dim: n.data.dim, why: n.data.detail }));

      const dimName = DIMENSIONS.find((d) => d.key === dim)!.name;
      patchNode(nodeId, { fissionDim: dim });
      const res = await withBusy(
        nodeId,
        `「${parentLabel}」× ${dimName} 裂变`,
        async () => {
        // 文化隐喻走两步：先把候选池收窄到共同记忆里，再从池子里挑同构最强的。
        // 直接让模型「找个和种子同构的典故」，等于放它去整个典籍库里做最优匹配，
        // 而越冷门的典故语义颗粒度越细、越容易刚好贴上某个属性，结果必然一路往偏里走。
        // 先摆池子再挑，是机制上的修复。
        let pool: { source: string; type?: string; story?: string; shared?: string[] }[] = [];
        if (dim === 'cultural') {
          try {
            const pp = culturalPoolPrompt(parentLabel, brief);
            const p = await chatJSON<{
              pool?: { source?: string; type?: string; story?: string; shared?: string[] }[];
            }>({
              settings,
              maxTokens: 4096,
              messages: [
                { role: 'system', content: pp.system },
                { role: 'user', content: pp.user },
              ],
            });
            pool = (p?.pool ?? [])
              .filter((x) => x?.source?.trim())
              .slice(0, 14)
              .map((x) => ({
                source: (x.source ?? '').trim(),
                type: x.type,
                story: x.story,
                shared: x.shared,
              }));
            log('info', `候选池 ${pool.length} 条：${pool.map((x) => x.source).join('、')}`);
          } catch (e) {
            // 池子拿不到就退回单步。宁可这次更容易跑偏，也别让整次裂变失败。
            log('warn', `候选池生成失败，本次跳过收窄：${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const { system, user } = fissionPrompt(parentLabel, dim, brief, {
          parentDim: parent.data.dim,
          parentWhy: parent.data.detail || parent.data.seedWhy,
          existing,
          pool,
        });
        return chatJSON<{ words: { word: string; why: string; dir?: string }[] }>({
          settings,
          // 谐音维度的判据最多（换字、还原、读音、出处、双读），推理型模型光想就要
          // 上万 token，8192 会整段空回。给足预算，别让用户拿到空白。
          maxTokens: 16384,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        });
        },
        () => void get().runFission(nodeId, dim),
      );
      patchNode(nodeId, { fissionDim: undefined });
      if (!res?.words?.length) return;

      let picked = res.words.filter((w) => w.word && w.word.trim());
      // 谐音维度多一道机械筛选：模型会把自己的违规写进 why，命中就丢弃。
      // 其余五个维度不筛——那几条判据（必须换字、原句要有出处）是谐音特有的。
      if (dim === 'phono') {
        const { kept, dropped } = screenPhonoWords(parentLabel, picked);
        picked = kept;
        if (dropped.length) {
          const sample = dropped
            .slice(0, 3)
            .map((d) => `「${d.word}」${d.reason}`)
            .join('；');
          const rest = dropped.length > 3 ? ` 等 ${dropped.length} 条` : '';
          log(
            'warn',
            picked.length
              ? `谐音维度筛掉 ${dropped.length} 条站不住的结果（${sample}${rest}）。这不是出错——它们在读音或原句上确实不成立。要更多可以再点一次裂变`
              : `谐音维度这一批 ${dropped.length} 条全部不成立，没有留下结果（${sample}${rest}）。这不是出错，是这一批确实没凑出合格的换字——再点一次裂变会重新生成`,
          );
        }
      }

      const words = picked.slice(0, 8);
      if (!words.length) return;
      // 重新取一次状态：await 期间用户可能拖动了父节点或新增了别的节点，
      // 用旧快照算出的扇区会歪，也会漏掉期间新增的障碍。
      const fresh = get().nodes;
      const anchor = fresh.find((n) => n.id === nodeId) ?? parent;
      const spots = layoutChildren(anchor, dim, words.length);
      // 逐个落位：每放一个就把它算进障碍，否则同一批词之间会互相压。
      // layoutChildren 只保证初始摆位不跨扇区，历史重叠靠这一步兜住。
      const placed: FlowNode[] = [];
      const newNodes: FlowNode[] = words.map((w, i) => {
        const position = resolveOverlap(spots[i], [...fresh, ...placed]);
        const n: FlowNode = {
          id: `n-${uid()}`,
          type: 'word',
          position,
          data: {
            label: w.word.trim(),
            kind: 'word',
            dim,
            detail: w.why ?? '',
            direction: w.dir?.trim().slice(0, 8) || undefined,
            // 继承父节点所属分组，拖动种子词时这一整枝才会跟着走
            groupId: anchor.data.groupId ?? anchor.id,
          },
        };
        placed.push(n);
        return n;
      });
      const newEdges: Edge[] = newNodes.map((n) => ({
        id: `e-${uid()}`,
        source: nodeId,
        target: n.id,
        type: 'simplebezier',
        style: { stroke: '#BFAE99', strokeWidth: 1.8 },
      }));

      set((s) => ({ nodes: [...s.nodes, ...newNodes], edges: [...s.edges, ...newEdges] }));
      persist();
    },

    async runLinkAnalysis(edgeId) {
      const { edges, nodes, brief, settings } = get();
      const edge = edges.find((e) => e.id === edgeId);
      if (!edge) return;
      const a = nodes.find((n) => n.id === edge.source)?.data.label ?? '';
      const b = nodes.find((n) => n.id === edge.target)?.data.label ?? '';
      if (!a || !b) return;

      log('info', `分析「${a}」↔「${b}」的关系…`);
      try {
        const { system, user } = linkPrompt(a, b, brief);
        const r = await chatJSON<{ type?: string; reason?: string }>({
          settings,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        });
        const t = (r?.type === 'opposite' || r?.type === 'cascade' ? r.type : 'common') as keyof typeof LINK_META;
        patchEdge(edgeId, {
          data: { linkType: t, reason: r?.reason ?? '' },
          style: { stroke: LINK_META[t].color, strokeWidth: 2.4 },
          animated: t === 'cascade',
          label: LINK_META[t].label,
          labelStyle: { fill: LINK_META[t].color, fontSize: 'var(--fs-sm)', fontWeight: 600 },
          labelBgStyle: { fill: '#FFFCF6' },
          labelBgPadding: [5, 3] as [number, number],
          labelBgBorderRadius: 4,
        });
        set((s) => ({ edges: [...s.edges] }));
        persist();
        log('ok', `「${a}」↔「${b}」判定为${LINK_META[t].label}`);
      } catch (e) {
        // 连线关系分析是附加能力，失败不影响连线本身，只降级为默认样式 + 轻提示
        patchEdge(edgeId, { data: {}, style: { stroke: '#A99B8A', strokeWidth: 2 } });
        toast(`关系分析未完成：${errorMessage(e)}`);
      }
    },

    async runBrief(nodeId) {
      const node = get().nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const had = !!node.data.brief;
      await withBusy(nodeId, `「${node.data.label}」创意简报`, () => doBrief(nodeId));
      // 只在真的出简报了才展开：withBusy 会把失败吞成 null，
      // 无条件展开的话，一次失败就会顶掉用户正在看的那个节点的详情
      if (!had && get().nodes.find((n) => n.id === nodeId)?.data.brief) set({ expandedId: nodeId });
    },

    async runPrompts(nodeId) {
      const node = get().nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const had = !!node.data.prompts;
      await withBusy(nodeId, `「${node.data.label}」提示词`, () => doPrompts(nodeId));
      if (!had && get().nodes.find((n) => n.id === nodeId)?.data.prompts) set({ expandedId: nodeId });
    },

    async runScore(nodeId) {
      const node = get().nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const had = !!node.data.score;
      await withBusy(nodeId, `「${node.data.label}」评分`, () => doScore(nodeId));
      // 批量评分会连着调 N 次，只在「从无到有」时展开，不会一路把镜头拽到最后个词上
      if (!had && get().nodes.find((n) => n.id === nodeId)?.data.score) set({ expandedId: nodeId });
    },

    async runPlan(nodeId) {
      const n0 = get().nodes.find((n) => n.id === nodeId);
      if (!n0 || n0.data.busy) return;
      const label = n0.data.label;
      // 简报已有就不重出：用户可能是只想补评分和提示词
      const needBrief = !n0.data.brief?.imagery && !n0.data.brief?.strategy;
      // 已经有简报时就两步，别让进度条从 2/3 起跳——第一步凭空消失比不显示更让人迷惑
      const total = needBrief ? 3 : 2;

      patchNode(nodeId, { busy: true, plan: { step: 1, total } });
      log('info', `「${label}」一键出方案…`);
      /* P5：整段流程合成一笔历史。三步写入（简报 / 评分 / 提示词）不分组的话，
         撤销要把三次 AI 调用逐个退回，用户看到的不是「撤销出方案」而是
         「撤销提示词 → 撤销评分 → 撤销简报」——步骤数对不上心智模型。 */
      beginGroup();
      // 整段等待的兜底上限：doScore 内部 AHP→评分→KANO 三段串联，全挂的话
      // 加起来要很久——徽标转那么久用户还是会当死机。到点先撤徽标把控制权
      // 还给用户，迟到的结果到了照样写回节点（不丢数据）。可用 dd.aiTimeout.planCapMs 调。
      const PLAN_WAIT_CAP = PLAN_WAIT_CAP_MS;
      try {
        if (needBrief) {
          await doBrief(nodeId);
          log('info', `「${label}」简报完成，正在评分并生成提示词…`);
          // 简报失败就没法往下走——评分与提示词都锚在它身上
          patchNode(nodeId, { plan: { step: 2, total } });
        }
        // 评分与提示词互不依赖（都只读简报），并行跑省一半等待
        const errs: string[] = [];
        const all = Promise.all([
          doScore(nodeId).catch((e) => void errs.push(`评分：${errorMessage(e)}`)),
          doPrompts(nodeId).catch((e) => void errs.push(`提示词：${errorMessage(e)}`)),
        ]);
        const capped = new Promise<{ late: boolean }>((res) =>
          setTimeout(() => res({ late: true }), PLAN_WAIT_CAP),
        );
        const r = await Promise.race([all.then(() => ({ late: false })), capped]);
        patchNode(nodeId, { plan: { step: total, total } });
        // 出齐了就把详情展开——用户要的就是这一屏结果
        set({ expandedId: nodeId });
        if (r.late) {
          const capMin = Math.round(PLAN_WAIT_CAP / 60_000);
          toast(`「${label}」等了 ${capMin} 分钟还没出齐，已停止等待；模型响应后结果会自动补上`);
          log('warn', `「${label}」一键出方案超时放行（评分/提示词可能稍后陆续到达）`);
        } else if (errs.length) {
          // 部分失败比全失败更该说清楚：哪一项没出、为什么
          toast(errs.join('；'));
        } else {
          log('ok', `「${label}」方案已出齐（简报 + 评分 + 提示词）`);
        }
      } catch (e) {
        raiseAlert('fatal', '一键出方案失败', e);
      } finally {
        patchNode(nodeId, { busy: false, plan: undefined });
        persist();
        endGroup();
      }
    },

    toggleExpand(nodeId) {
      set((s) => ({ expandedId: s.expandedId === nodeId ? null : nodeId }));
    },

    /**
     * P4：人工调整四准则分。adj=null 一键还原 AI 评分。
     *
     * 只写 userAdj 一个字段：价值分 / 象限 / 决策全部由 effectiveScore()
     * 现场推导（节点详情、右栏、行动建议、文档读的是同一份推导），
     * 不写回 score.value——存一份又算一份，迟早两边漂移。
     */
    setUserAdj(nodeId, adj) {
      const node = get().nodes.find((n) => n.id === nodeId);
      const s = node?.data.score;
      if (!s || s.v !== 2) return;
      // 同值不写盘：还原点两次、或拖动滑杆回到原值，不该各记一笔持久化
      const same =
        (s.userAdj?.c1 ?? null) === (adj?.c1 ?? null) &&
        (s.userAdj?.c2 ?? null) === (adj?.c2 ?? null) &&
        (s.userAdj?.c3 ?? null) === (adj?.c3 ?? null) &&
        (s.userAdj?.c4 ?? null) === (adj?.c4 ?? null) &&
        (s.userAdj?.note ?? '') === (adj?.note ?? '');
      if (same) return;
      // 滑杆一次拖动会连续触发十几次 onChange：不合并的话一步调整能吃掉
      // 半个历史栈。mergeNext 让「紧接着的这次数据变更」并进上一笔
      // （上一笔还是本次调整的起点），一次拖动 = 一步撤销。
      mergeNext = true;
      patchNode(nodeId, { score: { ...s, userAdj: adj ?? undefined } });
      persist();
      log('ok', adj ? '已记录评分调整（AI 原始分仍保留在依据里）' : '已还原为 AI 评分');
    },

    setKanoManual(nodeId, attr) {
      const node = get().nodes.find((n) => n.id === nodeId);
      const s = node?.data.score;
      if (!s || s.v !== 2 || !s.kano) return;
      const kano: KanoResult = { ...s.kano, manual: attr ?? undefined };
      const effective = attr ?? s.kano.attr;
      const base = weightedBase(
        [s.c1?.score ?? 0, s.c2?.score ?? 0, s.c3?.score ?? 0, s.c4?.score ?? 0],
        s.weights ?? DEFAULT_WEIGHTS,
      );
      const value = valueScore(base, kanoFactor(effective));
      // 象限只由 C3/C4 决定，人工改 KANO 不影响它
      patchNode(nodeId, {
        score: { ...s, kano, value, decision: decide(value, s.quadrant ?? 'meh') },
      });
      persist();
      log('ok', attr ? `KANO 已人工校准为 ${ATTR_NAME[attr]}` : 'KANO 已恢复 AI 推断');
    },

    toggleConverge(nodeId) {
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, converged: !n.data.converged } } : n,
        ),
      }));
      persist();
    },

    /**
     * 折叠的语义是「收进父节点」，所以只折叠有延伸词的节点；
     * 叶子节点点了没反应，比弹一句「没有可折叠内容」更安静。
     */
    toggleCollapse(nodeId) {
      const { nodes, edges } = get();
      const target = nodes.find((n) => n.id === nodeId);
      if (!target) return;
      const kids = collectDescendants(nodeId, nodes, edges);
      if (!kids.length) return;
      const next = !target.data.collapsed;
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, collapsed: next } } : n,
        ),
      }));
      persist();
      log('info', next ? `已收起 ${kids.length} 个延伸词` : `已展开 ${kids.length} 个延伸词`);
    },

    /** 折叠态推导：所有折叠节点的后代都隐藏，嵌套折叠自然级联 */
    hiddenNodeIds() {
      const { nodes, edges } = get();
      const hidden = new Set<string>();
      for (const n of nodes) {
        if (!n.data.collapsed) continue;
        for (const d of collectDescendants(n.id, nodes, edges)) hidden.add(d);
      }
      return [...hidden];
    },

    requestDelete(nodeIds) {
      const { nodes, edges } = get();
      const ids = nodeIds.filter((id) => nodes.some((n) => n.id === id));
      if (!ids.length) return;

      // 受影响后代 = 各节点后代的并集，扣掉本来就要删的
      const picked = new Set(ids);
      const desc = new Set<string>();
      for (const id of ids) {
        for (const d of collectDescendants(id, nodes, edges)) {
          if (!picked.has(d)) desc.add(d);
        }
      }
      // 没有后代就直接删——每删一个词都要多点一次确认，会烦
      if (!desc.size) {
        deleteNodes(ids, 'cascade');
        return;
      }
      const label =
        ids.length === 1 ? `「${nodes.find((n) => n.id === ids[0])?.data.label ?? ''}」` : `${ids.length} 个节点`;
      let valuableCount = 0;
      let convergedCount = 0;
      for (const id of desc) {
        const d = nodes.find((n) => n.id === id)?.data;
        if (!d) continue;
        // combo 也是跑过 AI 才有的产物，删掉同样要重跑
        if (d.brief || d.score || d.prompts || d.combo) valuableCount++;
        if (d.converged) convergedCount++;
      }
      set({ pendingDelete: { ids, label, descendantCount: desc.size, valuableCount, convergedCount } });
    },

    confirmDelete(mode) {
      const req = get().pendingDelete;
      if (!req) return;
      deleteNodes(req.ids, mode);
    },

    cancelDelete() {
      set({ pendingDelete: null });
    },

    setSelection(ids) {
      set({ selection: ids, selectedId: ids.length === 1 ? ids[0] : null });
    },

    clearSelection() {
      const { selection } = get();
      if (!selection.length) return;
      // 先清镜像，再走 onNodesChange 派发 select=false——让 RF 内部一致。
      // 顺序不能反：镜像先清，RF 的 onSelectionChange 回调即使随后触发也只是空集。
      set({ selection: [], selectedId: null });
      get().onNodesChange(selection.map((id) => ({ id, type: 'select' as const, selected: false })));
    },

    async runCombo(ids) {
      const { nodes, brief, settings } = get();
      const picked = ids
        .map((id) => nodes.find((n) => n.id === id))
        .filter((n): n is FlowNode => !!n);
      if (picked.length < 2 || picked.length > 6) {
        toast('组合需要 2-6 个节点');
        return;
      }
      if (picked.some((n) => n.data.busy)) {
        toast('有节点正在生成中，稍等再组合');
        return;
      }
      const words = picked.map((n) => n.data.label);
      const comboId = `n-${uid()}`;
      set({ converging: true });
      // 选中的来源节点保持原样直到组合节点生成（生成后镜像换成 [comboId]）。
      // 注意：不要在这里手动改 node.selected——RF 内部选中态与 store 镜像
      // 靠 onSelectionChange 单向同步，手动双向改会互相覆盖（实测复现过）。
      log('info', `AI 正在组合：${words.join(' + ')}…`);
      /* P5：两轮 AI + 节点创建 + 选中收敛合成一笔——组合是一个完整动作，
         撤销应该一步回到「没有这个组合节点」，而不是分三次撤。 */
      beginGroup();
      try {
        // 第一步：命名 + 组合逻辑（必须重新命名，不能是原词拼接）
        const createP = comboCreatePrompt(words, brief);
        const r1 = await chatJSON<{ name?: string; logic?: string }>({
          settings,
          messages: [
            { role: 'system', content: createP.system },
            { role: 'user', content: createP.user },
          ],
        });
        const name = (r1?.name ?? '').trim() || words.join('·');

        // 落点：所选节点整体包围盒正下方（几何中心偏下，PRD 8.2）。
        // picked.length ≥ 2 已在上方校验，boundsOf 不会返回 null
        const b = boundsOf(picked)!;
        const preferred = {
          x: Math.round((b.x + b.w / 2) - NODE_W / 2),
          y: Math.round(b.y + b.h + 90),
        };
        const position = resolveOverlap(preferred, nodes);
        const comboNode: FlowNode = {
          id: comboId,
          type: 'concept',
          position,
          data: {
            label: name,
            kind: 'concept',
            // 组合跨枝，不继承任何来源的 groupId——拖动某颗种子词不应带走组合
            combo: { sourceIds: picked.map((n) => n.id), logic: r1?.logic ?? '' },
            detail: r1?.logic ?? '',
          },
        };
        const comboEdges: Edge[] = picked.map((n) => ({
          id: `e-${uid()}`,
          source: n.id,
          target: comboId,
          type: 'simplebezier',
          // 虚线：区别于裂变/层级的实线，一眼看出「这是收敛出来的」
          // 2026-10-16 暖化：青 → 陶土（收敛结果是提案卡，用品牌色强调）
          style: { stroke: '#F2B987', strokeWidth: 1.6, strokeDasharray: '6 4' },
        }));
        set((s) => ({
          nodes: [...s.nodes, comboNode],
          edges: [...s.edges, ...comboEdges],
          // 中间态先把镜像清空（RF 内部仍高亮来源节点），等评定完统一收敛
          selection: [],
          selectedId: null,
        }));
        log('ok', `组合生成：「${name}」`);

        // 第二步：组合评定（化学反应 + 四维 + 风险）。
        // 这轮是附加产出，失败不应让整个组合作废——节点已建好，评定补不上只影响展示
        patchNode(comboId, { busy: true });
        const scoreP = comboScorePrompt(words, name, brief);
        const r2 = await chatJSON<{
          synergy?: number;
          conflict?: string;
          tension?: string;
          c1?: number;
          c2?: number;
          c3?: number;
          c4?: number;
          risk?: string;
          advice?: string;
        }>({
          settings,
          messages: [
            { role: 'system', content: scoreP.system },
            { role: 'user', content: scoreP.user },
          ],
        });
        const cur = get().nodes.find((n) => n.id === comboId);
        // 两轮 AI 之间用户完全可能把这个节点删掉（删除入口一直可用），
        // 非空断言会抛 TypeError 并弹「组合失败」，用户根本不知道发生了什么
        if (!cur) {
          log('warn', '组合节点已被删除，评定结果丢弃');
          return;
        }
        patchNodeFull(comboId, {
          data: {
            ...cur.data,
            busy: false,
            // asText / asNum：模型可能把协同度返回成 "9.0" 字符串、把建议返回成对象，
            // 原样入库会让 synergy.toFixed 抛 TypeError 或简报 tab 渲染对象时白屏
            combo: {
              sourceIds: picked.map((n) => n.id),
              logic: asText(r1?.logic),
              synergy: asNum(r2?.synergy),
              conflict: asText(r2?.conflict),
              tension: asText(r2?.tension),
              c1: asNum(r2?.c1),
              c2: asNum(r2?.c2),
              c3: asNum(r2?.c3),
              c4: asNum(r2?.c4),
              risk: asText(r2?.risk),
              advice: asText(r2?.advice),
            },
          },
        });
        log('ok', `组合评定完成：协同 ${r2?.synergy?.toFixed?.(1) ?? '—'}`);

        // 结果态：把 RF 选中收敛到新组合节点（来源取消选中）。
        // 必须在所有 nodes 替换结束后 dispatch——中途做会被 RF 用旧内部态覆盖镜像
        get().onNodesChange([
          ...picked.map((n) => ({ id: n.id, type: 'select' as const, selected: false })),
          { id: comboId, type: 'select' as const, selected: true },
        ]);
        set({ selection: [comboId], selectedId: comboId });
        persist();
      } catch (e) {
        // 若失败时组合节点已生成，先解除其 busy 态再告警
        patchNode(comboId, { busy: false });
        raiseAlert('fatal', '组合失败', e);
      } finally {
        set({ converging: false });
        endGroup();
      }
    },

    async runBatchScore(ids) {
      const { nodes, settings } = get();
      if (!settings.apiKey.trim() && !cloudEnabled(settings)) {
        toast('先在「AI 设置」里配置模型');
        return;
      }
      const targets = ids
        .map((id) => nodes.find((n) => n.id === id))
        .filter(
          (n): n is FlowNode =>
            !!n && (n.data.kind === 'seed' || n.data.kind === 'word' || n.data.kind === 'concept'),
        );
      if (!targets.length) {
        toast('选中项里没有可评分的词');
        return;
      }
      log('info', `开始批量评分（${targets.length} 个节点，逐个调用 AI）…`);
      // P5：整批合成一笔——「批量评分」在用户心智里是一个动作
      beginGroup();
      try {
        for (const n of targets) {
          // runScore 内部自带 busy 态与错误弹窗，逐个 await 即可
          await get().runScore(n.id);
        }
      } finally {
        endGroup();
      }
      log('ok', '批量评分完成');
    },

    tidy() {
      const { nodes, edges } = get();
      if (nodes.length < 2) return false;
      const pos = tidyLayout(nodes, edges);
      let moved = 0;
      const next = nodes.map((n) => {
        const p = pos[n.id];
        if (!p) return n;
        if (n.position.x === p.x && n.position.y === p.y) return n;
        moved++;
        return { ...n, position: p };
      });
      if (!moved) return false;
      set({ nodes: next });
      persist();
      log('info', `已整理 ${moved} 个节点的位置`);
      return true;
    },

    /* ---------- P5 撤销 / 重做 ---------- */
    undo,
    redo,

    /* ---------- P5 阶段快照 ---------- */
    openSnapshots() { set({ snapshotOpen: true }); },
    closeSnapshots() { set({ snapshotOpen: false }); },

    /**
     * 保存阶段快照。按 D7 **剥掉图片 dataUrl**：base64 很占配额，
     * 10 份快照带图必爆 5MB。名字与尺寸留着，恢复后图节点是「有名字的
     * 空壳」——恢复弹窗会明说这件事，不静默。
     *
     * 快照写独立 localStorage 键：配额爆了只丢快照，不牵连主工作区
     * （saveState 的配额溢出是 fatal 告警，不能因为存快照把主数据搞挂）。
     */
    saveSnapshot(name) {
      const { nodes, edges, snaps } = get();
      if (!nodes.length) {
        toast('画布是空的，没有可保存的快照');
        return;
      }
      let stripped = 0;
      const snapNodes = nodes.map((n) => {
        const imgs = n.data.images;
        if (!imgs?.length) return { ...n, data: { ...n.data } };
        stripped += 1;
        return { ...n, data: { ...n.data, images: imgs.map((im) => ({ ...im, dataUrl: '' })) } };
      });
      const snap: StageSnapshot = {
        id: `snap-${uid()}`,
        name: (name ?? '').trim() || defaultSnapName(nodes.length),
        createdAt: Date.now(),
        nodes: snapNodes,
        edges: edges.map((e) => ({ ...e })),
        stripped,
      };
      const next = [snap, ...snaps].slice(0, SNAP_CAP);
      set({ snaps: next });
      if (saveSnaps(next)) {
        log('ok', `已保存快照「${snap.name}」${stripped ? `（${stripped} 个图节点未含图片）` : ''}`);
      } else {
        toast('本地存储已满，快照没能保存（主工作区不受影响）');
      }
    },

    deleteSnapshot(id) {
      const next = get().snaps.filter((s) => s.id !== id);
      set({ snaps: next });
      saveSnaps(next);
      log('info', '已删除快照');
    },

    /** 用快照替换当前画布。走 set（不绕过）——恢复本身记一笔历史，反悔按撤销即可 */
    restoreSnapshot(id) {
      const snap = get().snaps.find((s) => s.id === id);
      if (!snap) return;
      set({
        nodes: snap.nodes.map((n) => ({ ...n, data: { ...n.data } })),
        edges: snap.edges.map((e) => ({ ...e })),
        selectedId: null,
        selection: [],
        expandedId: null,
        wheelId: null,
        snapshotOpen: false,
      });
      persist();
      log(
        'ok',
        `已恢复快照「${snap.name}」${snap.stripped ? `（${snap.stripped} 个图节点的图片未随快照保存，只剩占位）` : ''}（可按撤销退回）`,
      );
    },

    /** 清空范围：画布 + 简报 + 情报卡 + 资料 + 补充方向，项目名与 AI 设置保留 */
    resetCanvas() {
      set({
        nodes: [],
        edges: [],
        intel: [],
        references: [],
        report: null,
        reportOpen: false,
        mood: '',
        brief: '',
        feedback: '',
        ahp: null,
        selectedId: null,
        wheelId: null,
        expandedId: null,
        pendingDelete: null,
        selection: [],
        converging: false,
        // 清空等于回到空态，引导重新弹一次——重新构思时正好需要它。
        // 勾了「以后不再弹出」的用户除外。清空后流程回到澄清起点
        clarify: [],
        closingAsk: false,
        stage: 'clarify',
        guideOpen: !guideDismissed(),
        rediveAsk: false,
        linkHintId: null,
      });
      // 清空 = 开始新项目：断开与项目库里旧项目的关联，旧项目原样保留
      localStorage.removeItem('deepdiving.currentId');
      persist();
      log('ok', '已清空（画布 / 简报 / 情报卡 / 资料）');
    },
  };
});

// dev 环境暴露给浏览器 E2E / 控制台调试用（生产构建无此全局）
if (import.meta.env.DEV) {
  (window as unknown as { __dd: typeof useStore }).__dd = useStore;
}



