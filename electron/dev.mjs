import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';

/**
 * 开发态：一条命令同时起 Vite 和 Electron。
 *
 * 两点刻意为之：
 *   - 直接 spawn `vite/bin/vite.js`（node 进程），而不是 `npm run dev`。
 *     Windows 上 npm 会再套一层 cmd，关窗口时子进程容易变成孤儿，占着 5173 不放，
 *     下次启动就报端口占用。直接管 node 进程 kill 得干净。
 *   - 加 --strictPort：端口被占就直接失败，而不是悄悄换到 5174
 *     然后 Electron 对着 5173 白屏等 30 秒。
 */

const require = createRequire(import.meta.url);
const DEV_URL = 'http://127.0.0.1:5173';
const viteBin = require.resolve('vite/bin/vite.js');
const electronPath = require('electron'); // 返回 electron 可执行文件路径

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode > 0);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping(url)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  stdio: 'inherit',
});

if (!(await waitForServer(DEV_URL))) {
  console.error(`\n[dd] Vite 没能在 ${DEV_URL} 起来，Electron 未启动。`);
  console.error('[dd] 常见原因：5173 端口被上次没退干净的进程占用。');
  vite.kill();
  process.exit(1);
}

const electron = spawn(electronPath, ['.', '--dd-dev'], {
  stdio: 'inherit',
  // 摘掉 ELECTRON_RUN_AS_NODE：带着它启动时 require('electron') 返回可执行文件路径，
  // 主进程会以「isPackaged of undefined」这种完全无关的报错崩掉（见 launch.mjs 注释）
  env: (() => {
    const e = { ...process.env };
    delete e.ELECTRON_RUN_AS_NODE;
    return e;
  })(),
});

let closed = false;
function shutdown(code = 0) {
  if (closed) return;
  closed = true;
  if (!electron.killed) electron.kill();
  vite.kill();
  process.exit(code);
}

electron.on('exit', (code) => shutdown(code ?? 0));
vite.on('exit', (code) => {
  if (!closed) shutdown(code ?? 1);
});
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
