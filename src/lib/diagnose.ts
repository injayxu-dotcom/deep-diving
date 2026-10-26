/**
 * AI / 运行时错误诊断。
 *
 * 目的：把「上游返回的原始报错」翻译成「用户下一步该做什么」。
 * 用户是设计师，不是 API 工程师——「Authentication Fails, Your api key is invalid」
 * 这种原文对他没有意义，但「API Key 无效，去 AI 设置里换一个」有。
 *
 * 匹配顺序即优先级：具体的排前面，宽泛的排后面。
 */
interface Rule {
  test: RegExp;
  hint: string;
}

const RULES: Rule[] = [
  // —— 配置类 ——
  {
    test: /未填写\s*api\s*key|api\s*key.*(?:为空|缺失|missing)|没有配置.*key/i,
    hint: '还没有填 API Key。点右上角「AI 设置」填入即可，Key 只存在你本机。',
  },
  {
    test: /authentication|auth.*fail|401|invalid\s*api[\s_-]?key|密钥|鉴权|unauthor/i,
    hint: 'API Key 无效或已过期。请到「AI 设置」检查是否复制完整，或换一个有效的 Key。',
  },
  {
    test: /insufficient|balance|quota|欠费|余额|402|额度/i,
    hint: '账号余额不足或额度已用完。请到服务商后台充值后重试。',
  },
  {
    test: /rate\s*limit|429|too\s*many|限速|频率/i,
    hint: '请求太频繁被限流了。等十几秒再试，或换一个服务商的 Key。',
  },

  // —— 模型类 ——
  {
    test: /model.*(?:not\s*found|does\s*not\s*exist|unknown)|unknown\s*model|模型不存在|404/i,
    hint: '模型名填错了。请到「AI 设置」核对模型标识（如 deepseek-chat），要与服务商文档完全一致。',
  },
  {
    test: /image|vision|视觉|图片|multi\s*modal|不支持图片/i,
    hint: '当前模型不支持读图。请换成带视觉能力的模型，如 qwen-vl-max、glm-4v、gpt-4o。',
  },
  {
    test: /context\s*length|too\s*long|max\s*tokens|超出.*长度|上下文.*过长/i,
    hint: '内容太长，超出了模型的上下文上限。可以减少上传的资料，或把大文件拆成几份。',
  },

  // —— 网络类 ——
  {
    test: /cors|failed\s*to\s*fetch|networkerror|load\s*failed|跨域|网络错误/i,
    hint: '浏览器无法直连该服务商（通常是对方未开放跨域）。可把 Key 填进云函数的 LLM_API_KEY 环境变量、前端留空，改由服务端转发。',
  },
  {
    test: /timeout|timed\s*out|超时|econnreset|socket\s*hang\s*up/i,
    hint: '请求超时了。可能是网络不稳或模型响应慢，稍后重试；持续出现可考虑换模型。',
  },
  {
    test: /连不上云端后端|后端地址|网络不通/i,
    hint: '云端后端不可达。请到「AI 设置 → 云端同步」检查后端地址，或暂时关闭云端同步（不影响本地使用）。',
  },

  // —— 存储类 ——
  {
    test: /quota|exceeded|存储.*已满|localstorage.*full|配额/i,
    hint: '本地存储满了（图片很占空间）。请先删掉部分参考图，或点「导出」备份后清空。',
  },

  // —— 解析类 ——
  {
    test: /json|解析失败|parse|不是合法|没有返回可解析/i,
    hint: '模型返回的格式不对，没能解析出结果。重试一次通常就好；反复出现可换个模型。',
  },
];

/**
 * 根据错误信息给出可操作建议；无法识别时返回 null（调用方应只展示原始错误）。
 */
export function diagnoseAIError(msg: string): string | null {
  if (!msg) return null;
  for (const r of RULES) {
    if (r.test.test(msg)) return r.hint;
  }
  return null;
}

/**
 * 从任意异常里取出可读的错误文本。
 * 复用 cloudApi 的 describeError 逻辑，避免 ai.ts 与 store 各写一份。
 */
export function errorMessage(e: unknown): string {
  if (e === null || e === undefined) return '未知错误';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || e.name || '未知错误';
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.message === 'string' && o.message) return o.message;
    if (typeof o.msg === 'string' && o.msg) return o.msg;
    try {
      const s = JSON.stringify(e);
      if (s && s !== '{}') return s;
    } catch {
      /* 循环引用，忽略 */
    }
  }
  return String(e);
}
