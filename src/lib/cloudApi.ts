import type { AhpCache, AppSettings, DeepDiveReport, IntelCard, ReferenceFile } from '../types';
import type { Edge, Node } from '@xyflow/react';
import type { DDNodeData } from '../types';

/**
 * 云端同步客户端（纯 HTTP，零 SDK）。
 *
 * 后端是 CloudBase 云函数 `deepdiving-api`，通过「HTTP 访问服务」暴露公网地址：
 *   GET  /ws?id=default   → 读工作区
 *   POST /ws              → 写工作区
 *   POST /ai/chat         → AI 代理（SSE）
 *
 * 为什么不用 @cloudbase/js-sdk：
 *   浏览器 SDK 的 callFunction 走内部鉴权协议，在本环境稳定报
 *   `unauthenticated | credentials not found`，且 SDK 3.x 与小程序适配器在
 *   浏览器端存在兼容问题。HTTP 访问服务由网关直接鉴权 + 自动回写 CORS 头，
 *   前端只需一次普通 fetch，链路最短、最稳。
 *
 * 未填 apiBase 时整层是哑的——本地模式完全不受影响。
 */

export const WORKSPACE_ID = 'default';

/** 归一化后端地址（去掉结尾斜杠） */
export function apiBaseOf(s: AppSettings): string {
  return (s.apiBase || '').trim().replace(/\/+$/, '');
}

export function cloudEnabled(s: AppSettings): boolean {
  return apiBaseOf(s).length > 0;
}

// ---- 错误可观测性 ----

function safeJSON(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s && s !== '{}' ? s : '';
  } catch {
    return '';
  }
}

function safeStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return safeJSON(v) || String(v);
  return String(v);
}

/**
 * 把任意异常转成可读字符串。
 *
 * 关键：CloudBase / fetch 抛出的往往不是 Error 实例，而是 { code, message, requestId }
 * 这类普通对象——直接 String(e) 只会得到 "[object Object]"，真实原因被完全掩盖。
 */
export function describeError(e: unknown): string {
  if (e === null || e === undefined) return '未知错误（空异常）';
  if (typeof e === 'string') return e;

  if (e instanceof Error) {
    const parts: string[] = [e.message || e.name || 'Error'];
    for (const [k, v] of Object.entries(e as unknown as Record<string, unknown>)) {
      if (['message', 'name', 'stack'].includes(k)) continue;
      parts.push(`${k}=${safeStr(v)}`);
    }
    return parts.join(' | ');
  }

  if (typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.message === 'string' && obj.message) parts.push(obj.message);
    if (typeof obj.msg === 'string' && obj.msg) parts.push(obj.msg);
    for (const [k, v] of Object.entries(obj)) {
      if (['message', 'msg'].includes(k)) continue;
      parts.push(`${k}=${safeStr(v)}`);
    }
    if (parts.length) return parts.join(' | ');
    return safeJSON(e) || String(e);
  }

  return String(e);
}

// ---- HTTP 请求封装 ----

interface ReqOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  /** 额外请求头（例如 SSE 场景需要覆盖 Accept） */
  headers?: Record<string, string>;
}

/**
 * 统一的后端请求。
 * 对两类"假成功"做防御：非 JSON 响应、静态托管回退的 index.html。
 */
async function req(s: AppSettings, path: string, opts: ReqOptions = {}): Promise<string> {
  const base = apiBaseOf(s);
  if (!base) throw new Error('未配置云端后端地址');

  let res: Response;
  try {
    res = await fetch(base + path, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(s.cloudToken.trim() ? { 'x-ws-token': s.cloudToken.trim() } : {}),
        ...(opts.headers || {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    const raw = describeError(e);
    const hint = /failed to fetch|networkerror|load failed/i.test(raw)
      ? '（网络不通或后端地址不可达）'
      : '';
    throw new Error(`连不上云端后端 ${base}${hint}：${raw}`);
  }

  const text = await res.text().catch(() => '');
  const ctype = (res.headers.get('content-type') || '').toLowerCase();

  // 静态托管 / 网关可能对未匹配路径回退 HTML（状态码仍是 200），
  // 不识别就会伪装成"成功"却拿到空内容。
  // 403 = 云函数令牌校验不通过。必须单独给出可执行的指引：
  // 泛化的「HTTP 403」用户看不懂，只会以为工具坏了。
  if (res.status === 403) {
    throw new Error(
      '云端拒绝了请求（HTTP 403）：令牌缺失或不匹配。' +
        '请在「AI 设置 → 云端同步令牌」填入与云函数环境变量 WS_TOKEN 一致的值。',
    );
  }
  if (ctype.includes('text/html')) {
    throw new Error(
      `云端后端返回了网页而非数据（HTTP ${res.status}）。请检查后端地址是否正确：${base}${path}`,
    );
  }
  if (!res.ok) {
    throw new Error(`云端返回 HTTP ${res.status}：${text.slice(0, 300) || res.statusText}`);
  }
  return text;
}

async function reqJSON<T>(s: AppSettings, path: string, opts: ReqOptions = {}): Promise<T> {
  const text = await req(s, path, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`云端返回的不是合法 JSON：${text.slice(0, 200)}`);
  }
}

export interface CloudWorkspace {
  brief: string;
  product: string;
  mood: string;
  /** 用户反馈 / 用研结论，KANO 判定的真实锚点 */
  feedback: string;
  references: ReferenceFile[];
  report: DeepDiveReport | null;
  nodes: Node<DDNodeData>[];
  edges: Edge[];
  intel: IntelCard[];
  settings: AppSettings;
  /** AHP 权重缓存，每个项目推导一次 */
  ahp: AhpCache | null;
}

/**
 * 拉取云端工作区；返回 null 表示云端没有数据或拉取失败（不阻断本地使用）
 */
export async function cloudLoad(s: AppSettings): Promise<CloudWorkspace | null> {
  if (!cloudEnabled(s)) return null;
  try {
    const data = await reqJSON<{ exists?: boolean; doc?: CloudWorkspace; error?: string }>(
      s,
      `/ws?id=${encodeURIComponent(WORKSPACE_ID)}`,
      { method: 'GET' },
    );
    if (data.error) throw new Error(data.error);
    return data.exists && data.doc ? data.doc : null;
  } catch (e) {
    console.warn('[cloud] load failed:', e);
    return null;
  }
}

/** 推送工作区到云端（best-effort，失败只告警） */
export async function cloudSave(s: AppSettings, ws: CloudWorkspace): Promise<void> {
  if (!cloudEnabled(s)) return;
  try {
    const data = await reqJSON<{ ok?: boolean; error?: string }>(s, '/ws', {
      method: 'POST',
      body: { _id: WORKSPACE_ID, ...ws },
    });
    if (data.error) throw new Error(data.error);
  } catch (e) {
    console.warn('[cloud] save failed:', e);
  }
}

/** 探测云端后端是否可达（用于「测试同步」按钮） */
export async function cloudPing(s: AppSettings): Promise<string> {
  if (!cloudEnabled(s)) throw new Error('未开启云端同步');
  const data = await reqJSON<{ exists?: boolean; savedAt?: number; error?: string }>(
    s,
    `/ws?id=${encodeURIComponent(WORKSPACE_ID)}`,
    { method: 'GET' },
  );
  if (data.error) throw new Error(data.error);
  if (!data.exists) return '云端后端连接正常（云端暂无存档）';
  const t = data.savedAt ? new Date(data.savedAt).toLocaleString('zh-CN') : '未知时间';
  return `云端后端连接正常，上次存档：${t}`;
}
