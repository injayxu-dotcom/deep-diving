import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * 本地 AI 代理中间件。
 *
 * 存在的原因：浏览器直连 LLM 厂商会被 CORS 拦截，且 API Key 暴露在前端不安全。
 * 这里在 Vite dev server 上挂一个 /api/ai/chat，转发到 OpenAI 兼容端点。
 *
 * 安全：baseUrl 由客户端传入，天然是 SSRF 入口。浏览器并不阻止第三方站点向
 * localhost 发请求，所以哪怕只监听 127.0.0.1，恶意网页也能借这个中间件去探测
 * 本机和内网服务（云元数据 169.254.169.254 尤其危险）。因此这里默认做三重收敛：
 * 协议 → 内网/回环地址 → 域名白名单。
 *
 * 接列表外的服务商：DD_ALLOWED_HOSTS=your.host.com npm run dev
 * 接本地 Ollama 等：DD_ALLOW_LOCALHOST=1 npm run dev
 */

const ENDPOINT = '/api/ai/chat';

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
/**
 * 回环地址（**前缀**匹配，与 PRIVATE_HOST 对齐）。
 *
 * 🔴 原来是 `/^(localhost|127\.|0\.0\.0\.0|::1)$/` —— `127\.` 后面紧跟 `$`，
 * 只匹配字面上等于 `"127."` 的字符串。真正的 `"127.0.0.1"` 匹配不上，
 * 于是落到下面那个**不看 `DD_ALLOW_LOCALHOST`** 的分支被直接拒。
 * 后果：插件注释里写的「本地模型请设 DD_ALLOW_LOCALHOST=1」对最常见的写法
 * 完全失效，且没有任何提示。实测踩过 —— 用 mock LLM 跑工具脚本时必现。
 *
 * 只影响 `127.x`：`0\.0\.0\.0$` 与 `::1$` 本来就匹配得上，
 * `localhost$` 也是。它们在修复前后行为一致，这里一并留在测试里钉住。
 */
const LOOPBACK = /^(localhost|127\.|0\.0\.0\.0|::1)/i;

function allowedHosts(): Set<string> {
  const extra = (process.env.DD_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_HOSTS, ...extra]);
}
/** 多模态请求会带 base64 图片，体积比纯文本大一到两个数量级 */
const MAX_BODY = 25 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

/** 导出为纯函数（无副作用），便于单独校验 baseUrl 的归一化规则 */
export function normalizeUrl(base: string): string {
  let b = (base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) throw new Error('baseUrl 必须是 http(s) 地址');
  if (!/\/v\d+$/.test(b)) b = b + '/v1';

  const u = new URL(b + '/chat/completions');
  // http://evil.com@real.host/ 这类混淆：hostname 看着没问题，仍一律拒绝
  if (u.username || u.password) throw new Error('baseUrl 不允许携带认证信息');

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK.test(host)) {
    // 本地 Ollama / LM Studio / mock LLM 场景，需显式开启
    if (process.env.DD_ALLOW_LOCALHOST !== '1') {
      throw new Error(`默认禁止访问本机地址（${host}）。本地模型请设 DD_ALLOW_LOCALHOST=1 后重启 dev`);
    }
  } else if (PRIVATE_HOST.test(host)) {
    /* 真正的内网 / 链路本地（10.x / 192.168.x / 169.254.x / fc00: / fe80: …）
       **不给开关**，一律拒绝 —— 云元数据（169.254.169.254）就在这一段，
       放开它等于把这台 dev server 变成现成的跳板。
       回环（127.x / localhost / ::1）与它们是两回事，走上面那个开关。 */
    throw new Error(`baseUrl 指向内网 / 保留地址（${host}），已拒绝`);
  } else if (process.env.DD_ALLOW_ANY_HOST !== '1' && !allowedHosts().has(host)) {
    throw new Error(
      `服务商域名 ${host} 不在允许列表。如需使用，请设环境变量：DD_ALLOWED_HOSTS=${host}`,
    );
  }
  return u.toString();
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  let payload: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    messages?: { role: string; content: unknown }[];
    stream?: boolean;
  };

  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: '请求体不是合法 JSON' });
  }

  const apiKey = payload.apiKey || process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) {
    return sendJson(res, 401, { error: '未配置 API Key。请点击右上角「设置」填入，或设置环境变量 DEEPSEEK_API_KEY。' });
  }
  if (!payload.messages?.length) {
    return sendJson(res, 400, { error: 'messages 不能为空' });
  }

  let url: string;
  try {
    url = normalizeUrl(payload.baseUrl || 'https://api.deepseek.com');
  } catch (e) {
    return sendJson(res, 400, { error: (e as Error).message });
  }

  // 不同模型对参数的要求不一：新模型（o 系列 / MiMo 等）要 max_completion_tokens，
  // 有的只接受默认 temperature。先按通用写法发，遇到参数类 400 就换写法重试。
  // 深潜要一次吐出简报 + 情报卡 + 种子词，默认 4096 会截断 JSON，所以默认 8192。
  const baseBody: Record<string, unknown> = {
    model: payload.model || 'deepseek-chat',
    messages: payload.messages,
    stream: true,
  };
  const maxTok = payload.maxTokens ?? 8192;
  const temp = payload.temperature ?? 0.9;
  const variants: Record<string, unknown>[] = [
    { ...baseBody, temperature: temp, max_tokens: maxTok },
    { ...baseBody, temperature: temp, max_completion_tokens: maxTok },
    { ...baseBody, max_completion_tokens: maxTok },
    { ...baseBody },
  ];

  let upstream: Response | undefined;
  try {
    for (const body of variants) {
      upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (upstream.status !== 400 && upstream.status !== 422) break;
      const peek = await upstream.clone().text().catch(() => '');
      if (!/max_tokens|max_completion_tokens|temperature|unsupported|not support|invalid.*param|unknown.*param/i.test(peek)) break;
    }
  } catch (e) {
    return sendJson(res, 502, { error: `无法连接 AI 服务：${(e as Error).message}` });
  }
  if (!upstream) return sendJson(res, 502, { error: '无法连接 AI 服务' });

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => '');
    let msg = `AI 服务返回 ${upstream.status}`;
    try {
      const j = JSON.parse(txt);
      msg = j?.error?.message || j?.message || msg;
    } catch {
      if (txt) msg += `：${txt.slice(0, 300)}`;
    }
    return sendJson(res, upstream.status === 401 ? 401 : 502, { error: msg });
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.write('data: [DONE]\n\n');
  } catch {
    /* 客户端断开 */
  } finally {
    res.end();
  }
}

export function aiProxy(): Plugin {
  return {
    name: 'deep-diving-ai-proxy',
    configureServer(server) {
      server.middlewares.use(ENDPOINT, (req, res, next) => {
        if (req.method !== 'POST') return next();
        handle(req, res).catch((e) => sendJson(res, 500, { error: (e as Error).message }));
      });
    },
  };
}
