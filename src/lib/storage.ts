import type { Edge, Node } from '@xyflow/react';
import type {
  AhpCache,
  AppSettings,
  DDNodeData,
  DeepDiveReport,
  IntelCard,
  ReferenceFile,
  StageSnapshot,
} from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { cloudEnabled, cloudLoad, cloudSave, type CloudWorkspace } from './cloudApi';
import { sanitizeNodeData } from './sanitize';

const KEY = 'deepdiving.v1';

export interface Persisted {
  brief: string;
  product: string;
  mood: string;
  /** 用户反馈 / 用研结论。KANO 判定的真实锚点，比模型推断优先 */
  feedback: string;
  references: ReferenceFile[];
  report: DeepDiveReport | null;
  nodes: Node<DDNodeData>[];
  edges: Edge[];
  intel: IntelCard[];
  settings: AppSettings;
  /** AHP 权重缓存，每个项目推导一次 */
  ahp: AhpCache | null;
  /** 最后保存时间戳，用于云端/本地冲突判断 */
  savedAt?: number;
}

const EMPTY: Persisted = {
  brief: '',
  product: '',
  mood: '',
  feedback: '',
  references: [],
  report: null,
  nodes: [],
  edges: [],
  intel: [],
  settings: DEFAULT_SETTINGS,
  ahp: null,
};

/**
 * 连线样式迁移（2026-10-17，smoothstep → simplebezier）。
 * 边是持久化数据：只改 `defaultEdgeOptions` 影响的是"新建的边"，老工作区打开后
 * 仍然是那条带 `type: 'smoothstep'` 的记录，于是用户看到的是"你说改了、没改"。
 * 读取两条入口（本地 localStorage / 云端拉取）都要过一遍，且必须是 idempotent 的。
 */
function migrateEdges(list: unknown): Edge[] {
  if (!Array.isArray(list)) return [];
  return list.map((e) => (e?.type === 'smoothstep' ? { ...e, type: 'simplebezier' } : e));
}

function toCloudWorkspace(p: Persisted): CloudWorkspace {
  return {
    brief: p.brief,
    product: p.product,
    mood: p.mood,
    feedback: p.feedback,
    ahp: p.ahp,
    references: p.references,
    report: p.report,
    nodes: p.nodes,
    edges: p.edges,
    intel: p.intel,
    // apiKey 与 cloudToken 都是本机凭证，永不上行：
    // 落到云库等于把凭据公开（云库一旦可读，令牌就失效了，等于没设）。
    // 代价是换设备要各填一次（一次性设置），换来凭据不离开本机。
    settings: { ...p.settings, apiKey: '', cloudToken: '' },
  };
}

export function loadState(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const o = JSON.parse(raw) as Partial<Persisted>;
    return {
      brief: o.brief ?? '',
      product: o.product ?? '',
      mood: o.mood ?? '',
      feedback: o.feedback ?? '',
      references: Array.isArray(o.references) ? o.references : [],
      report: o.report ?? null,
      // sanitizeNodeData：把旧版本/坏模型写出的畸形字段（对象当字符串、字符串数字）
      // 修成渲染安全形状，并剪掉残留的 busy/plan（生成中关页面 → 刷新后僵尸转圈）
      nodes: (Array.isArray(o.nodes) ? (o.nodes as Node<DDNodeData>[]) : []).map(sanitizeNodeData),
      edges: migrateEdges(o.edges),
      intel: Array.isArray(o.intel) ? o.intel : [],
      settings: { ...DEFAULT_SETTINGS, ...(o.settings ?? {}) },
      ahp: o.ahp ?? null,
      savedAt: o.savedAt,
    };
  } catch {
    return EMPTY;
  }
}

let timer: number | null = null;
/** 待执行的写入动作。抽出来是为了让 flushSave() 能立刻执行它——导出前必须落盘，
 *  否则导出的还是上一次的快照（400ms 防抖足以让"改完立刻导出"拿到旧内容）。 */
let pending: (() => void) | null = null;

export function flushSave() {
  if (timer == null) return;
  clearTimeout(timer);
  timer = null;
  const fn = pending;
  pending = null;
  fn?.();
}

/**
 * 防抖写入，避免拖拽时每帧都序列化整棵树。
 * 配额溢出时必须上报——挂了图的节点很容易撑爆 5MB，静默失败会让用户以为数据存住了。
 * 写入本地后，若已开启云端同步，再异步推一份到云（best-effort，失败只告警）。
 */
export function saveState(
  s: {
    brief: string;
    product: string;
    mood: string;
    feedback: string;
    references: ReferenceFile[];
    report: DeepDiveReport | null;
    nodes: Node<DDNodeData>[];
    edges: Edge[];
    intel: IntelCard[];
    settings: AppSettings;
    ahp: AhpCache | null;
  },
  onError?: (msg: string) => void,
) {
  if (timer) clearTimeout(timer);
  pending = () => {
    const savedAt = Date.now();
    // 显式白名单而不是 {...s}：调用方传进来的是整个 store state，
    // 展开会把 logs（最多 60 条长文本）、alert、toast、selection、clarify、
    // stage、expandedId 全塞进 payload。本项目最大的实际风险就是 5MB 配额，
    // 这几 KB 到几十 KB 是白扔的。
    const payload: Persisted = {
      brief: s.brief,
      product: s.product,
      mood: s.mood,
      feedback: s.feedback,
      references: s.references,
      report: s.report,
      // selected / busy / plan 都是瞬态交互或运行态标记，落盘只会在刷新后
      // 残留假象（高亮、永远转圈的「出方案 1/2」），必须在写入前剥掉
      nodes: s.nodes
        .map(({ selected: _sel, ...rest }) => {
          const { busy: _busy, plan: _plan, fissionDim: _fd, ...data } = rest.data;
          return { ...rest, data } as typeof rest;
        })
        // 再过一遍消毒：防止这一轮 AI 刚写入的畸形字段（对象/字符串数字）落盘
        .map(sanitizeNodeData),
      edges: s.edges.map(({ selected: _eSel, ...rest }) => rest),
      intel: s.intel,
      settings: s.settings,
      ahp: s.ahp,
      savedAt,
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(payload));
    } catch {
      onError?.('本地存储已满（图片占用过大），本次修改没能保存。请删掉部分图片，或先「导出」备份再清空。');
    }
    if (cloudEnabled(s.settings)) {
      cloudSave(s.settings, toCloudWorkspace(payload)).catch((e) => {
        onError?.(`云端同步失败（已保留本地）： ${(e as Error).message}`);
      });
    }
  };
  timer = window.setTimeout(() => {
    timer = null;
    const fn = pending;
    pending = null;
    fn?.();
  }, 400);
}

/**
 * 启动时拉取云端工作区。返回 null 表示：云端未开启 / 没有数据 / 云端不比本地新。
 * 调用方据此决定是否用云端覆盖本地。
 */
export async function pullCloud(settings: AppSettings): Promise<Persisted | null> {
  if (!cloudEnabled(settings)) return null;
  try {
    const ws = await cloudLoad(settings);
    if (!ws) return null;
    const local = loadState();
    const cloudAt = (ws as unknown as { savedAt?: number }).savedAt ?? 0;
    if (cloudAt <= (local.savedAt ?? 0)) return null;

    // 云端不存 API Key / 后端地址（见 toCloudWorkspace），
    // 合并时以本机已填的为准，避免被云端空值覆盖掉。
    const cloudSettings = { ...DEFAULT_SETTINGS, ...(ws.settings ?? {}) };
    const localSettings = local.settings;
    return {
      brief: ws.brief ?? '',
      product: ws.product ?? '',
      mood: ws.mood ?? '',
      feedback: ws.feedback ?? '',
      ahp: ws.ahp ?? null,
      references: Array.isArray(ws.references) ? ws.references : [],
      report: ws.report ?? null,
      nodes: (Array.isArray(ws.nodes) ? (ws.nodes as Node<DDNodeData>[]) : []).map(sanitizeNodeData),
      edges: migrateEdges(ws.edges),
      intel: Array.isArray(ws.intel) ? ws.intel : [],
      settings: {
        ...cloudSettings,
        apiKey: localSettings.apiKey || cloudSettings.apiKey,
        apiBase: localSettings.apiBase || cloudSettings.apiBase,
        cloudToken: localSettings.cloudToken || cloudSettings.cloudToken,
      },
      savedAt: cloudAt,
    };
  } catch {
    return null;
  }
}

export function exportJSON() {
  // 先落盘再读：saveState 有 400ms 防抖，"改完立刻导出"原本会拿到上一次的快照
  flushSave();
  const raw = localStorage.getItem(KEY) ?? '{}';
  // 导出文件是给人分享 / 备份用的，里面不能躺着明文凭据——
  // 上云那条路径已经做了同样的脱敏（toCloudWorkspace），这里不能漏。
  // apiKey 与 cloudToken 同属本机凭证，一并清掉。
  let safe = raw;
  try {
    const o = JSON.parse(raw) as Partial<Persisted>;
    if (o.settings) o.settings = { ...o.settings, apiKey: '', cloudToken: '' };
    safe = JSON.stringify(o);
  } catch {
    /* 解析不了就按原样导出，至少保住数据 */
  }
  const blob = new Blob([safe], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deep-diving-${new Date().toISOString().slice(0, 10)}.json`;
  // 必须挂进文档再点：Firefox 不认游离的 anchor；revode 也要等下一帧
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

/* ============================================================
   P5 阶段快照（独立键）

   为什么不并进主工作区（KEY）：主工作区已经扛着图片 base64，5MB 配额
   随时可能告急；快照再叠上去，一次「保存快照」就能把整个工作区的
   持久化搞挂（saveState 的溢出是 fatal 告警）。分键存储，配额爆了
   只丢快照，主数据毫发无伤。

   不同步云端：快照是「这个设备上的存档点」，跨设备恢复用导出 JSON。
   ============================================================ */
const SNAP_KEY = 'deepdiving.snaps.v1';

/** 快照上限。再多用户就会陷入「管理存档比干活还累」的境地 */
export const SNAP_CAP = 10;

export function loadSnaps(): StageSnapshot[] {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return [];
    const o = JSON.parse(raw);
    if (!Array.isArray(o)) return [];
    // 形状校验到「能渲染」的程度：nodes 不是数组的快照进了列表也点不动
    return o
      .filter((s): s is StageSnapshot => !!s && typeof s.id === 'string' && Array.isArray(s.nodes))
      .slice(0, SNAP_CAP);
  } catch {
    return [];
  }
}

/** 写入并封顶。返回 false = 配额满了（调用方提示，不致命） */
export function saveSnaps(list: StageSnapshot[]): boolean {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(list.slice(0, SNAP_CAP)));
    return true;
  } catch {
    return false;
  }
}

/** 单个快照导出为 JSON 文件（跨设备迁移用） */
export function exportSnapshotJSON(snap: StageSnapshot) {
  const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deep-diving-snapshot-${snap.createdAt ? new Date(snap.createdAt).toISOString().slice(0, 10) : 'x'}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}
