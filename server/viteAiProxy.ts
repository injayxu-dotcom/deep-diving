import type { Plugin } from 'vite';
import { AI_ENDPOINT, handleAiProxy, sendJson } from './aiProxyCore';

/**
 * 把 AI 转发挂到 Vite dev server 上。
 *
 * 转发与安全收敛的实现全在 `aiProxyCore.ts`，Electron 主进程用的是同一份 —
 * 两处各写一遍的话，白名单和 SSRF 规则迟早会漂移，而这类漂移不会有任何报错。
 *
 * 接列表外的服务商：DD_ALLOWED_HOSTS=your.host.com npm run dev
 * 接本地 Ollama 等：DD_ALLOW_LOCALHOST=1 npm run dev
 */
export function aiProxy(): Plugin {
  return {
    name: 'deep-diving-ai-proxy',
    configureServer(server) {
      server.middlewares.use(AI_ENDPOINT, (req, res, next) => {
        handleAiProxy(req, res)
          .then((handled) => {
            if (!handled) next();
          })
          .catch((e) => sendJson(res, 500, { error: (e as Error).message }));
      });
    },
  };
}

export { normalizeUrl } from './aiProxyCore';
