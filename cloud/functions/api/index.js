/**
 * 深度潜水 · CloudBase 云函数（双模式：HTTP 触发 + SDK callFunction）
 *
 * 两种调用方式：
 *   A. HTTP 触发（若控制台/网关开启了 HTTP 访问）：
 *      POST /ai/chat   → AI 代理
 *      GET  /ws?id=xx  → 读工作区
 *      POST /ws        → 写工作区
 *
 *   B. SDK callFunction（部分环境的主用方式）：
 *      { action: 'ai_chat', ... }     → AI 代理
 *      { action: 'ws_load', id }      → 读工作区
 *      { action: 'ws_save', ...data } → 写工作区
 *
 * 部署：tcb fn deploy deepdiving-api --dir . --runtime Nodejs18.15 -e <envId>
 */
const tcb = require('@cloudbase/node-sdk');

const app = tcb.init({ env: process.env.TCB_ENV || process.env.SCF_NAMESPACE || 'your-env-id' });
const db = app.database();
const COLLECTION = 'workspaces';
const WS_TOKEN = process.env.WS_TOKEN || '';

// ---- 响应构造 ----
// 注意：CORS 由 CloudBase「HTTP 访问服务」网关统一处理（会覆盖函数自带头，
// 实测返回的是 echo Origin 而非 *），这里不要再发 Access-Control-*，避免重复头
// 导致浏览器拒绝响应。OPTIONS 预检同样由网关直接应答。
const json = (body, status = 200, extra = {}) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    ...extra,
  },
  body: JSON.stringify(body),
});

const sse = (text) => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
  },
  body: `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
        `data: [DONE]\n\n`,
});

const sseError = (msg) => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
  },
  body: `data: ${JSON.stringify({ error: { message: msg } })}\n\n`,
});

// ---- 上游地址安全校验（SSRF 防护）----
// 云函数跑在云厂商内网，若允许调用方任意指定 baseUrl，它就成了现成的跳板：
// 攻击者可以借它去打内网服务、甚至实例元数据（169.254.169.254）。
// 所以这里做三重收敛：协议 → 私有地址 → 域名白名单。
const DEFAULT_ALLOWED_HOSTS = [
  'api.deepseek.com',
  'api.openai.com',
  'open.bigmodel.cn',
  'api.zhipuai.cn',
  'apihub.agnes-ai.com',
  'aihubmix.com',
  'dashscope.aliyuncs.com',
  'api.moonshot.cn',
  'api.siliconflow.cn',
  'generativelanguage.googleapis.com',
  'api.anthropic.com',
];

const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc00:|fd[0-9a-f]{2}:|fe80:)/i;

function allowedHostSet() {
  const extra = (process.env.LLM_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_HOSTS, ...extra]);
}

function assertSafeUpstream(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: '不是合法 URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: `不支持的协议 ${u.protocol}` };
  }
  // http://evil.com@api.deepseek.com/ 这类混淆：hostname 虽对，但仍拒绝带凭据的地址
  if (u.username || u.password) {
    return { ok: false, reason: '不允许在地址中携带认证信息' };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST.test(host)) {
    return { ok: false, reason: '禁止访问内网 / 本机 / 链路本地等保留地址' };
  }
  // 调试用后门，默认关闭
  if (process.env.LLM_ALLOW_ANY_HOST === '1') return { ok: true, url: u.toString() };
  if (!allowedHostSet().has(host)) {
    return {
      ok: false,
      reason: `域名 ${host} 不在允许列表。请在云函数环境变量 LLM_ALLOWED_HOSTS 追加（英文逗号分隔）后重试`,
    };
  }
  return { ok: true, url: u.toString() };
}

// ---- 工具 ----
function checkToken(headers) {
  if (!WS_TOKEN) return true;
  const t = headers['x-ws-token'] || headers['X-WS-Token'];
  return t === WS_TOKEN;
}

function parseQuery(str) {
  const out = {};
  for (const pair of str.split('&')) {
    const [k, v] = pair.split('=');
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return out;
}

// 归一化 HTTP 触发事件
function normalizeHttp(event) {
  const method = (event.httpMethod || 'GET').toUpperCase();
  let query = event.queryString || event.queryStringParameters || {};
  if (typeof query === 'string') query = parseQuery(query);
  let body = event.body;
  if (body && typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* raw string */ }
  }
  return { method, query, body, headers: event.headers || {} };
}

// ---- 业务逻辑（纯函数，两种模式共用）----

async function handleChat(body) {
  const {
    baseUrl = 'https://api.deepseek.com',
    apiKey = '',
    model = 'deepseek-chat',
    temperature = 0.9,
    maxTokens = 4096,
    messages = [],
  } = body || {};

  // 前端传来的 baseUrl 一律不可信，先过白名单，否则本函数就是 SSRF 跳板
  const raw = (process.env.LLM_BASE_URL || baseUrl).replace(/\/$/, '');
  const safe = assertSafeUpstream(raw + '/chat/completions');
  if (!safe.ok) return sseError('上游地址被拒绝：' + safe.reason);

  // LLM_LOCK_KEY=1 → 忽略前端传入的 Key，只认服务端环境变量，Key 永不上行
  const key =
    process.env.LLM_LOCK_KEY === '1'
      ? process.env.LLM_API_KEY
      : process.env.LLM_API_KEY || apiKey;

  if (!key) return sseError('云函数未配置 LLM_API_KEY（在函数环境变量里设置）');

  try {
    const upstream = await fetch(safe.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model, temperature, max_tokens: maxTokens,
        messages, stream: false,
      }),
    });

    if (!upstream.ok) {
      const txt = await upstream.text();
      return sseError(`上游 LLM 错误（${upstream.status}）：${txt.slice(0, 200)}`);
    }
    const data = await upstream.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    return sse(text);
  } catch (e) {
    return sseError('云函数调用上游失败：' + (e && e.message ? e.message : String(e)));
  }
}

async function handleWsLoad(id) {
  const docId = id || 'default';
  const res = await db.collection(COLLECTION).doc(docId).get();
  const doc = res.data && res.data[0];
  if (!doc) return { exists: false };
  const { _id, _createTime, _updateTime, ...rest } = doc;
  return { exists: true, savedAt: doc.savedAt || 0, doc: rest };
}

async function handleWsDelete(id) {
  const docId = id || 'default';
  await db.collection(COLLECTION).doc(docId).remove();
  return { ok: true, deleted: docId };
}

async function handleWsSave(data) {
  const id = (data && data._id) || 'default';
  // _id 是系统字段，不能出现在写入 payload 中——由 doc(id) 指定
  const { _id, ...rest } = data || {};
  const payload = { ...rest, savedAt: Date.now() };
  // 必须用 doc(id).set()：它是不存在则按该 _id 创建、存在则整体替换的 upsert。
  //
  // 这里原先写的是 collection().add()，而 add() 会自动生成随机 _id ——
  // 客户端固定发 _id='default'，于是首次保存落进一条随机文档，
  // 下次 GET /ws?id=default 依旧 {exists:false}，再保存又新建一条。
  // 表现为"同步成功但永远读不回"，且文档无限增长（实测曾累积 961 条孤儿文档）。
  await db.collection(COLLECTION).doc(id).set(payload);
  return { ok: true, id, savedAt: payload.savedAt };
}

// ---- 主入口（双模式路由）----
exports.main = async (event) => {
  // ── 模式 B：SDK callFunction（event 是普通对象，无 httpMethod）──
  if (!event.httpMethod && !event.headers) {
    const action = event.action;

    // 令牌校验（SDK 模式下 token 放在 event 里）
    if (action === 'ws_load' || action === 'ws_save') {
      if (WS_TOKEN && event.token !== WS_TOKEN) {
        return { error: '令牌无效' };
      }
    }

    try {
      if (action === 'ai_chat') {
        if (process.env.LLM_REQUIRE_TOKEN === '1' && event.token !== WS_TOKEN) {
          return { error: '令牌无效' };
        }
        return await handleChat(event);
      }
      if (action === 'ws_load') return await handleWsLoad(event.id);
      if (action === 'ws_save') return await handleWsSave(event);
      if (action === 'ws_delete') return await handleWsDelete(event.id);
      return { error: '未知动作：' + action };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  // ── 模式 A：HTTP 触发 ──
  const { method, query, body, headers } = normalizeHttp(event);
  if (method === 'OPTIONS') return json({ ok: true });

  const rawPath = (query.__path || event.path || (event.requestContext && event.requestContext.path) || '/').split('?')[0];
  const path = (rawPath.replace(/^(\/release)?\/deepdiving-api/, '') || '/').replace(/^\/?/, '/');

  if (path === '/ai/chat' && method === 'POST') {
    // 默认开放（前端带自己的 Key 走厂商），但设了 LLM_REQUIRE_TOKEN 就必须带令牌，
    // 免得云函数被别人当免费 AI 网关白嫖，账单算在你头上
    if (process.env.LLM_REQUIRE_TOKEN === '1' && !checkToken(headers)) {
      return json({ error: '令牌无效' }, 403);
    }
    return handleChat(body);
  }
  if (path === '/ws') {
    if (!checkToken(headers)) return json({ error: '令牌无效' }, 403);
    if (method === 'GET') return handleWsLoad(query.id);
    if (method === 'POST') return handleWsSave(body);
    if (method === 'DELETE') return handleWsDelete(query.id);
  }
  return json({ error: '未知路径：' + path }, 404);
};
