import { contextBridge, ipcRenderer } from 'electron';

/**
 * 只暴露渲染进程真正需要的东西。
 *
 * contextIsolation 开着，渲染进程拿不到 Node / fs / child_process——
 * 这里多暴露一个 API，网页里的任何脚本（包括将来可能引入的第三方内容）
 * 就多一条能碰你机器的路。所以只给一个地址和一个版本号。
 */

interface Runtime {
  isDesktop: boolean;
  aiProxyUrl: string;
  version: string;
  platform: string;
}

let runtime: Runtime = { isDesktop: true, aiProxyUrl: '', version: '', platform: '' };

try {
  // 同步取：preload 在文档开始阶段执行，必须在这时就把地址准备好，
  // 否则前端模块顶层读不到，会退回相对路径 /api/ai/chat（file:// 下必然失败）
  runtime = ipcRenderer.sendSync('dd:runtime') as Runtime;
} catch {
  /* 主进程还没注册 handler 时保持空值，AI 会退化为直连而不是整个应用崩掉 */
}

contextBridge.exposeInMainWorld('deepDiving', runtime);
