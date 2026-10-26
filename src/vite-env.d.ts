/// <reference types="vite/client" />

/**
 * 桌面运行时（Electron preload 注入）。
 * 网页里为 undefined —— 所有读取处都必须容忍这一点。
 */
interface DeepDivingRuntime {
  isDesktop: boolean;
  /** 带随机令牌的本地转发地址；代理没起来时为空串 */
  aiProxyUrl: string;
  version: string;
  platform: string;
}

interface Window {
  deepDiving?: DeepDivingRuntime;
}
