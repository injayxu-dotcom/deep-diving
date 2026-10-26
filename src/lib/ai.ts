import type { AppSettings } from '../types';
import { apiBaseOf, cloudEnabled, describeError } from './cloudApi';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** 传数组即启用多模态（视觉）输入 */
  content: string | ContentPart[];
}

export interface ChatOptions {
  messages: ChatMessage[];
  settings: AppSettings;
  maxTokens?: number;
  onToken?: (chunk: string) => void;
  signal?: AbortSignal;
}

export class AIError extends Error {}

/**
 * 调用超时守卫。
 *
 * 没有这个守卫时：SSE 流一旦挂起（代理网关吞了请求不回包、网络半开、
 * 模型排队不出首字节），readSSE 里的 reader.read() 会永远 await——
 * 上层的「一键出方案」就永远转圈在 1/2，节点 busy 卡死，所有按钮禁用，
 * 刷新也没用（busy 已被写进 localStorage）。
 *
 * 两条线都设：
 *  - IDLE：连续 N 秒一个字节都没收到 → 判定流挂起。注意这不惩罚"生成得慢"——
 *    边生成边吐字的流式模型每次收到分片都会重置计时；真正会被掐的是
 *    网关型非流式服务商（整段生成期间零字节，最后一口气给全量），
 *    所以这个值必须容得下"一分多钟不吐字"的合理静默，实测 60s 太紧已放宽到 180s。
 *  - OVERALL：单次调用总时长硬顶，防极端情况无限占用。
 *
 * 触发任意一条就 abort，并把 AbortError 转成可读的 AIError。
 * 三个值都可用 localStorage 的 dd.aiTimeout 覆盖（JSON：idleMs / overallMs / planCapMs），
 * 供测试与特殊网络环境自救，不必改代码重新构建。
 */
const TUNE = (() => {
  try {
    return JSON.parse(localStorage.getItem('dd.aiTimeout') ?? 'null') ?? {};
  } catch {
    return {};
  }
})();
const IDLE_TIMEOUT_MS = Number(TUNE.idleMs) || 180_000;
const OVERALL_TIMEOUT_MS = Number(TUNE.overallMs) || 600_000;
/** 一键出方案整段等待上限（评分链 AHP→四准则→KANO 串联，要容得下三段都慢） */
export const PLAN_WAIT_CAP_MS = Number(TUNE.planCapMs) || 360_000;

/** 给 chat() 内部用的超时控制句柄 */
interface TimeoutGuard {
  signal: AbortSignal;
  /** 收到任意字节时调用，重置空闲计时 */
  kick: () => void;
  /** 响应不是 SSE（整段缓冲）：空闲计时没有意义，只留总时长兜底 */
  asBulk: () => void;
  /** 包装 onToken：每个流式分片都算一次「还活着」 */
  wrapOnToken: (onToken?: (chunk: string) => void) => ((chunk: string) => void) | undefined;
  dispose: () => void;
  /** 返回 true 表示这次失败是超时导致的（用于把 AbortError 翻译成人话） */
  timedOut: () => boolean;
  /** 是哪条线掐断的：空闲（对端不出数据）还是总时长 */
  hitKind: () => 'idle' | 'overall' | null;
}

/**
 * 内部：超时守卫的活性信号。业务方不要传。
 *
 * 为什么需要单独一条通道：心跳必须由**收到任意字节**驱动。
 * 曾经只在 onToken（正文分片）里重置计时，而 chatJSON 这类调用根本不传 onToken，
 * 结果空闲守卫退化成了「从发请求起的硬时长上限」——流一直在动也会被掐。
 */
interface AliveHooks {
  kick: () => void;
  bulk: () => void;
}
type InternalOptions = ChatOptions & { _alive?: AliveHooks };

function guard(): TimeoutGuard {
  const ctrl = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let hit: 'idle' | 'overall' | null = null;
  let isBulk = false;
  const armIdle = () => {
    if (isBulk) return;
    clearTimeout(idle);
    idle = setTimeout(() => {
      hit = 'idle';
      ctrl.abort();
    }, IDLE_TIMEOUT_MS);
  };
  const overall = setTimeout(() => {
    hit = 'overall';
    ctrl.abort();
  }, OVERALL_TIMEOUT_MS);
  armIdle();
  return {
    signal: ctrl.signal,
    kick: () => armIdle(),
    asBulk: () => {
      isBulk = true;
      clearTimeout(idle);
    },
    wrapOnToken: (onToken) =>
      onToken
        ? (chunk) => {
            armIdle();
            onToken(chunk);
          }
        : undefined,
    dispose: () => {
      clearTimeout(overall);
      clearTimeout(idle);
    },
    timedOut: () => hit !== null,
    hitKind: () => hit,
  };
}

/** 流式调用 LLM，返回完整文本 */
/** 读取 SSE 流并拼接完整文本（直连与代理两条路径共用） */
async function readSSE(
  res: Response,
  onToken?: (chunk: string) => void,
  onBytes?: () => void,
): Promise<string> {
  if (!res.body) throw new AIError('未返回数据流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // 心跳只看「有没有字节」，不看「字节里有没有正文」：
    // 思考型模型的 reasoning_content、网关的 keep-alive 注释，都证明连接还活着
    if (value?.length) onBytes?.();
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json: {
        choices?: { delta?: { content?: string } }[];
        error?: { message?: string };
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error?.message) throw new AIError(json.error.message);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onToken?.(delta);
      }
    }
  }
  return full;
}

/** 本地 dev 的 Vite 代理中间件（只在 npm run dev 时存在） */
const LOCAL_PROXY = '/api/ai/chat';

/**
 * 生产构建（已部署的静态站点）里，浏览器直连 LLM。
 *
 * 静态托管没有 /api/ai/chat 后端（Vite 代理只在 dev 时存在）。
 * DeepSeek / 智谱 / 通义等主流厂商均返回 CORS 头，浏览器可直连，
 * 好处是有真正的流式输出；失败时会自动回落到云端代理（见 chat()）。
 *
 * 代价：API Key 会出现在浏览器请求里（与本地模式存 localStorage 的暴露面一致，
 * 个人工具可接受）。若介意，可把 Key 放进云函数的 LLM_API_KEY 环境变量、
 * 前端留空，请求就会走云端代理，密钥不上前端。
 */
async function chatDirect({
  messages,
  settings,
  maxTokens,
  onToken,
  signal,
  _alive,
}: InternalOptions): Promise<string> {
  const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  if (!settings.apiKey.trim()) {
    throw new AIError('未填写 API Key（云端直连模式需要 Key）');
  }

  let res: Response;
  try {
    // 不同模型的参数要求不一（MiMo / o 系列要 max_completion_tokens，有的不收 temperature）：
    // 遇到参数类 400 就换写法重试，这样用户填任意模型名都能调用。
    const base = { model: settings.model, messages, stream: true };
    const variants: Record<string, unknown>[] = [
      { ...base, temperature: settings.temperature, max_tokens: maxTokens },
      { ...base, temperature: settings.temperature, max_completion_tokens: maxTokens },
      { ...base, max_completion_tokens: maxTokens },
      { ...base },
    ];
    res = undefined as unknown as Response;
    for (const body of variants) {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (res.status !== 400 && res.status !== 422) break;
      const peek = await res.clone().text().catch(() => '');
      if (!/max_tokens|max_completion_tokens|temperature|unsupported|not support|invalid.*param|unknown.*param/i.test(peek)) break;
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // 最常见：厂商未放开 CORS，浏览器请求被拦（报错里 message 为空）
    const hint = /failed to fetch|networkerror|load failed/i.test(String((e as Error).message))
      ? '（通常是该厂商未允许跨域 CORS，浏览器无法直连。可换 DeepSeek / 智谱等支持 CORS 的服务商）'
      : '';
    throw new AIError(`直连模型失败：${(e as Error).message || '网络错误'}${hint}`);
  }

  if (!res.ok) {
    // 保留 HTTP 状态码：402（余额）/ 401（Key）/ 429（限流）在响应体文案里
    // 常常看不出来，而状态码是判断"要不要走代理"最直接的依据。
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error?.message || (typeof j?.message === 'string' ? j.message : '');
    } catch {
      /* 非 JSON 响应 */
    }
    throw new AIError(detail ? `${detail}（HTTP ${res.status}）` : `请求失败（HTTP ${res.status}）`);
  }

  // 静态托管可能对未匹配路径回退 index.html（200 + HTML），必须识别，
  // 否则会伪装成"成功"却拿不到内容，深潜 / 裂变因解析空内容而失败。
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('text/html')) {
    throw new AIError('接口返回了网页而非数据流，请检查 Base URL 是否正确（应以 /v1 或厂商域名结尾）');
  }

  // 服务商无视 stream:true、整段缓冲回一个 JSON：这段等待期间一个字节都不会有，
  // 空闲计时在这里没有意义，改由总时长兜底（见 readPlainJSON 注释）
  if (ctype.includes('application/json')) {
    _alive?.bulk();
    return readPlainJSON(await res.text());
  }

  return readSSE(res, onToken, _alive?.kick);
}

/**
 * 经服务端代理调用 LLM（本地 dev 的 Vite 中间件 / 云端云函数，同一份协议）。
 * 响应统一是 SSE，用 readSSE 解析。
 */
async function chatViaProxy(
  url: string,
  { settings, maxTokens, onToken, messages, signal, _alive }: InternalOptions,
): Promise<string> {
  const body: Record<string, unknown> = {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens,
    messages,
    stream: true,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.cloudToken.trim() ? { 'x-ws-token': settings.cloudToken.trim() } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new AIError(`连不上代理 ${url}。${describeError(e)}`);
  }

  if (!res.ok) {
    let msg = `代理请求失败（${res.status}）`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* 非 JSON 响应 */
    }
    throw new AIError(msg);
  }

  // 静态托管 / 网关可能对未匹配路径回退 index.html（状态码仍是 200），
  // 不识别就会伪装成"成功"却拿不到内容 —— 深潜、裂变都会因空内容而失败。
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('text/html')) {
    throw new AIError(`代理 ${url} 返回了网页，请检查地址是否正确`);
  }

  if (ctype.includes('application/json')) {
    _alive?.bulk();
    return readPlainJSON(await res.text());
  }

  return readSSE(res, onToken, _alive?.kick);
}

/**
 * 非流式响应体的解析。
 *
 * 有些中转渠道不认 `stream:true`，把整段结果憋完再一次性返回
 * （content-type 是 application/json）。原先一律走 readSSE，
 * 这种响应里没有 `data:` 行，会被解析成空串，最终报「没有返回可解析的 JSON」——
 * 看起来像模型没输出，其实是读取方式不对。
 */
function readPlainJSON(raw: string): string {
  try {
    const j = JSON.parse(raw) as {
      error?: { message?: string };
      choices?: { message?: { content?: unknown }; text?: string }[];
    };
    if (j?.error?.message) throw new AIError(j.error.message);
    const c = j?.choices?.[0]?.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .map((p) => (typeof p === 'string' ? p : ((p as { text?: string })?.text ?? '')))
        .join('');
    }
    if (typeof j?.choices?.[0]?.text === 'string') return j.choices[0].text;
  } catch (e) {
    if (e instanceof AIError) throw e;
    /* 不是合法 JSON，交给上层的 extractJSON 兜 */
  }
  return raw;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 遇限流（429 / rate limit）自动重试的次数与退避间隔。
 *
 * 为什么需要：AIhubmix 这类补贴型免费档限流极紧——10 次/分钟、100 次/天，
 * 而「一键出方案」是 doBrief + doScore（AHP→四准则→KANO 三段）+ doPrompts 并行发出，
 * 一次点击就是 5~6 个请求，连点两次必然撞上限流。没有重试的话，
 * 用户看到的就是随机的、时好时坏的失败，很难归因。
 */
const RETRY_ON_RATELIMIT = 3;
const RETRY_DELAY_MS = [4000, 9000, 18000];
const RATELIMIT_RE = /429|rate limit|too many requests|qps|concurrency|请求过快/i;

export async function chat(opts: ChatOptions): Promise<string> {
  let retried = 0;

  for (;;) {
    // 每次调用套一层超时守卫：流挂起不再等于永远转圈（见 guard 上方注释）
    const g = guard();
    // 已经吐过字就不再重试：否则前端会把同一段内容渲染两遍
    let gotToken = false;
    const inner: InternalOptions = {
      ...opts,
      signal: g.signal,
      // 心跳挂到守卫上：任何字节到达都算活着，不依赖业务方传 onToken
      _alive: { kick: g.kick, bulk: g.asBulk },
      onToken: opts.onToken
        ? g.wrapOnToken((chunk: string) => {
            gotToken = true;
            opts.onToken?.(chunk);
          })
        : undefined,
    };

    try {
      return await chatAttempt(inner);
    } catch (e) {
      if (g.timedOut()) {
        const idleS = Math.round(IDLE_TIMEOUT_MS / 1000);
        const allS = Math.round(OVERALL_TIMEOUT_MS / 1000);
        throw new AIError(
          g.hitKind() === 'idle'
            ? `模型连续 ${idleS} 秒没有返回任何数据，连接可能被网关挂起，或该模型排队太久。请重试；若反复出现，说明这个模型在当前渠道确实太慢，换一个更快的。`
            : `单次调用超过 ${allS} 秒仍未结束，已中断。这种情况多半是模型在长任务上卡住了，建议重试或换更快的模型。`,
        );
      }

      const msg = e instanceof AIError ? e.message : describeError(e);

      if (!gotToken && retried < RETRY_ON_RATELIMIT && RATELIMIT_RE.test(msg)) {
        await sleep(RETRY_DELAY_MS[retried]);
        retried++;
        continue;
      }

      // 重试过还是被限流：把"已经自动重试过几次"说出来，
      // 否则用户只看到一句 429，会以为是配置错了而不是额度/频率问题
      if (retried > 0 && RATELIMIT_RE.test(msg)) {
        throw new AIError(`已自动重试 ${retried} 次仍被限流（${msg}）`);
      }
      throw e;
    } finally {
      g.dispose();
    }
  }
}

/**
 * 直连失败的原因分类。
 *
 * 背景（真实踩坑）：曾经对**所有**直连失败都追加同一句
 * 「可在『AI 设置 → 云端后端地址』填入服务端代理地址，改由服务器转发以避开跨域限制」。
 * 结果把「余额不足」「Key 无效」「模型名写错」这些**与跨域无关**的错误也误导成跨域问题，
 * 用户被指引去配代理——可代理只是换个地方发同一个请求、用同一个 Key，
 * 余额不足照样报余额不足，白折腾一圈。所以这里按语义分流，各给各的建议。
 */
export type FailKind = 'network' | 'balance' | 'auth' | 'permission' | 'ratelimit' | 'model' | 'unknown';

export function classifyDirectFailure(err: string, s?: AppSettings): { kind: FailKind; tip: string } {
  const e = err.toLowerCase();
  const model = (s?.model || '').trim();
  // 补贴型渠道（AIhubmix 等）用 -free 后缀区分免费档与按量计费版，
  // 这是"明明有免费渠道却一直报余额不足"最常见的根因，值得单独判断
  const looksFreeTier = /-free$/i.test(model);
  const where = model ? `当前模型名「${model}」` : '（未填模型名）';

  // 浏览器 fetch 被 CORS / 网络层拦掉时，Error.message 往往为空或固定几种说法
  if (
    /failed to fetch|networkerror|load failed|network request failed|cors|err_network|err_connection|preflight/i.test(
      e,
    ) ||
    !e.trim()
  ) {
    return {
      kind: 'network',
      tip: '（多半是该服务商未开放浏览器跨域 CORS，请求根本没到对方服务器。可在「AI 设置 → 云端后端地址」填入服务端代理地址，改由服务器转发）',
    };
  }

  if (/balance|insufficient|recharge|quota|余额|额度|欠费|arrears|out of credit/i.test(e)) {
    return {
      kind: 'balance',
      tip: looksFreeTier
        ? `（服务商回复「账户余额不足」，与跨域、网络、代理都无关。${where}已是免费档后缀，那多半是**该渠道要求账户余额 > 0 才允许调用**——连免费模型也一样。请到控制台确认充值已到账、余额确实大于 0；若确认有钱仍报此错，是额度池未刷新，需找渠道客服核查）`
        : `（服务商回复「账户余额不足」。${where}不以 \`-free\` 结尾——这基本可以确定你调的是**按量计费版**，会直接扣账户余额，跟"免费渠道"没关系。请从渠道的免费模型名单里复制**带 -free 后缀**的 ID，例如 \`minimax-m3-free\`；另外这类渠道通常还要求账户余额 > 0 才放行）`,
    };
  }

  if (/401|unauthorized|invalid api key|incorrect api key|invalid token|authentication/i.test(e)) {
    return {
      kind: 'auth',
      tip: '（API Key 被拒绝。检查 Key 是否复制完整、是否过期、是否属于当前填的这个 Base URL 渠道——不同渠道的 Key 不通用）',
    };
  }

  if (/403|forbidden|permission denied|not authorized/i.test(e)) {
    return {
      kind: 'permission',
      tip: '（该 Key 没有调用此模型的权限。中转渠道常按分组/模型授权，需要在渠道后台开通对应模型）',
    };
  }

  if (/429|rate limit|too many requests|qps|concurrency/i.test(e)) {
    return {
      kind: 'ratelimit',
      tip: '（触发限流。稍等重试即可；注意「一键出方案」会并行发起多个请求，比单步操作更容易撞上限流）',
    };
  }

  if (/no such model|model_not_found|model.{0,24}(not found|does not exist|unsupported)|(not found|does not exist).{0,24}model/i.test(e)) {
    return {
      kind: 'model',
      tip: '（模型名不被识别。请核对渠道的模型列表，名字要与渠道文档完全一致，包括大小写和 :free 之类后缀）',
    };
  }

  return { kind: 'unknown', tip: '' };
}

/** 不带守卫的一次调用尝试：dev 走本地代理；生产直连失败自动回落云端代理 */
async function chatAttempt(opts: InternalOptions): Promise<string> {
  // 开发模式：npm run dev 有 Vite 代理中间件，Key 不落浏览器网络面板之外
  if (!import.meta.env.PROD) {
    return chatViaProxy(LOCAL_PROXY, opts);
  }

  // 生产构建（已部署的静态站点）：优先浏览器直连（真流式输出）
  try {
    return await chatDirect(opts);
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    const directErr = e instanceof AIError ? e.message : describeError(e);

    // 直连失败 → 有云端后端就自动回落；没有就按真实原因给针对性建议
    // （不再无差别提示「填代理地址避开跨域」：余额/Key/模型名问题与跨域无关）
    const { kind, tip } = classifyDirectFailure(directErr, opts.settings);

    if (!cloudEnabled(opts.settings)) {
      throw new AIError(tip ? `直连模型失败：${directErr}。${tip}` : `直连模型失败：${directErr}`);
    }

    try {
      return await chatViaProxy(`${apiBaseOf(opts.settings)}/ai/chat`, opts);
    } catch (e2) {
      if ((e2 as Error)?.name === 'AbortError') throw e2;
      // 两条路都失败时补上根因判断，避免只留下一句「两边都失败」让人无从下手
      const proxyMsg = (e2 as Error).message || '';
      let tail: string;
      if (kind === 'unknown') {
        tail = '';
      } else if (kind === 'network') {
        // 浏览器直连连不上、云函数（国内机房）转发也连不上 —— 两侧网络都不通，
        // 换代理是没用的，因为代理那台机器同样出不去
        tail = /fetch failed|econnrefused|getaddrinfo|timeout|enotfound/i.test(proxyMsg)
          ? '\n（浏览器与云端服务器**两侧都连不上**这个地址：说明该域名在服务器所在网络不可达，常见于境外服务商在国内机房访问不到。换代理地址解决不了——代理机器同样出不去。请改用国内可直连的服务商，或给云函数配出网代理）'
          : '';
      } else {
        tail = `\n${tip}`;
      }
      throw new AIError(`直连失败：${directErr}\n云端代理也失败：${proxyMsg}${tail}`);
    }
  }
}

/**
 * 调用 LLM 并解析 JSON。
 * 模型常在 JSON 外面包 ```json 代码块或前后加解释文字，这里做容错提取。
 */
export async function chatJSON<T>(opts: ChatOptions): Promise<T> {
  // 模型偶尔会在 JSON 中途截断或夹带格式错误。解析失败时整体重试一次，
  // 仍失败才把错误抛给调用方（弹窗）。可用 localStorage dd.jsonRetry = "0" 关闭，省一次调用费用。
  const maxRetry = jsonRetryCount();
  let lastErr: unknown;
  for (let i = 0; i <= maxRetry; i++) {
    const text = await chat(opts);
    try {
      // 最后一次尝试才启用截断修复：前面还有重试机会时，宁可重来也不收半截结果
      return extractJSON<T>(text, i === maxRetry);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function jsonRetryCount(): number {
  try {
    const v = localStorage.getItem('dd.jsonRetry');
    if (v === null) return 1;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(2, Math.floor(n)) : 1;
  } catch {
    return 1;
  }
}

/**
 * 截断修复：模型输出在 JSON 中途被截断时，保留已经完整的部分。
 * 做法：沿着文本扫描，记录最后一个「位于数组/对象内部、已闭合」的位置，
 * 然后截到那里并按栈补齐括号。只保留结构完整的项，不猜测半截内容。
 */
function repairTruncatedJSON(s: string): string | null {
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  // 最近一次「一个值完整结束」时的位置与当时的栈
  let safeEnd = -1;
  let safeStack: string[] = [];
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
      // 只在「某个数组元素/对象成员」闭合后记录安全点
      safeEnd = i + 1;
      safeStack = stack.slice();
      if (stack.length === 0) return s.slice(start, i + 1);
    }
  }
  if (safeEnd < 0) return null;
  return s.slice(start, safeEnd).replace(/[,\s]+$/, '') + safeStack.slice().reverse().join('');
}

export function extractJSON<T>(raw: string, allowRepair = false): T {
  let s = raw.trim();

  // 去掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // 尝试直接解析
  try {
    return JSON.parse(s) as T;
  } catch {
    /* 继续尝试截断提取 */
  }

  // 提取第一个完整的 {...} 或 [...]
  const start = s.search(/[[{]/);
  if (start >= 0) {
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  if (allowRepair) {
    const fixed = repairTruncatedJSON(s);
    if (fixed) {
      try {
        return JSON.parse(fixed) as T;
      } catch {
        /* 修复失败，走下面的报错 */
      }
    }
  }
  throw new AIError(`模型没有返回可解析的 JSON。原始输出前 200 字：\n${raw.slice(0, 200)}`);
}

