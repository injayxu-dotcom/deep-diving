import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { AI_ENDPOINT, handleAiProxy, sendJson } from '../server/aiProxyCore';

/**
 * Electron 主进程。
 *
 * 这里做两件事：
 *   1. 开一个原生窗口，加载同一套前端产物（dist/）
 *   2. 在 127.0.0.1 起一个 AI 转发口 —— 打包后没有 Vite dev server，
 *      而浏览器直连厂商会被 CORS 拦、Key 也会落在渲染进程的网络层。
 *
 * 为什么要随机端口 + 随机令牌：本机的任何进程（包括浏览器里的任意网页）
 * 都能连 127.0.0.1 的任意端口。不设防的话，这个转发口就成了公开的免费 AI
 * 网关，还能被当成探测内网的跳板。令牌只存在于 preload 注入的 URL 里。
 */

/**
 * 是否连 Vite dev server（热更新）。
 *
 * 不能用 `app.isPackaged` 判断：未打包直接跑 `electron .` 时它也是 false，
 * 于是 `npm run desktop`（本意是跑构建产物）会去连 5173，
 * 没开 dev server 就白屏 + ERR_CONNECTION_REFUSED。
 * 改成显式参数：只有 `npm run desktop:dev` 会传 --dd-dev。
 */
const useDevServer = process.argv.includes('--dd-dev');
const DEV_URL = 'http://127.0.0.1:5173';

if (useDevServer) {
  // 开发态用独立的数据目录：否则调试时随手建的项目、改的 Key 会写进
  // 正式使用的 localStorage，两者互相污染
  app.setPath('userData', path.join(app.getPath('appData'), 'deep-diving-dev'));
}

let mainWindow: BrowserWindow | null = null;
let aiProxyUrl = '';

/** 启动本地转发服务，返回带令牌的完整端点 */
function startAiProxy(): Promise<string> {
  const token = crypto.randomBytes(24).toString('hex');

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url || '/';

      // CORS 预检：浏览器的 OPTIONS 不进入转发逻辑
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.statusCode = 204;
        res.end();
        return;
      }

      if (!url.startsWith(AI_ENDPOINT)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      handleAiProxy(req, res, {
        cors: true,
        token,
        // 桌面端允许连本机模型：用户跑 Ollama / LM Studio 是正常需求，
        // 且这个端口已有令牌保护，不构成对外开放的跳板
        allowLocalhost: true,
      })
        .then((handled) => {
          if (!handled) {
            res.statusCode = 405;
            res.end('method not allowed');
          }
        })
        .catch((e) => sendJson(res, 500, { error: (e as Error).message }));
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('本地端口分配失败'));
        return;
      }
      resolve(`http://127.0.0.1:${addr.port}${AI_ENDPOINT}?t=${token}`);
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1080,
    minHeight: 680,
    // 与 --ink-50 一致：窗口先画出来、页面还没渲染时不会闪一下白
    backgroundColor: '#f4efe6',
    title: '创意深潜 Deep Diving',
    /* 打包后任务栏/标题栏取 exe 内嵌的图标（electron-builder 用 build/icon.ico 写入），
       但开发态跑的是 node_modules 里那个 stock Electron exe —— 不指定就显示原子图标。 */
    icon: app.isPackaged ? undefined : path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 首屏渲染完成再显示，避免白底闪一帧
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 外链一律交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (useDevServer) {
    mainWindow.loadURL(DEV_URL);
  } else {
    // electron-dist/main.js → ../dist/index.html
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** preload 在文档开始阶段同步取运行时信息，拿不到就等于没有代理 */
ipcMain.on('dd:runtime', (event) => {
  event.returnValue = {
    isDesktop: true,
    aiProxyUrl,
    version: app.getVersion(),
    platform: process.platform,
  };
});

// 同一时间只允许一个实例，否则两个窗口会抢 localStorage
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      aiProxyUrl = await startAiProxy();
    } catch (e) {
      // 代理起不来也让应用能开——只是 AI 功能不可用，本地画布仍然能用
      console.error('[dd] AI 代理启动失败：', e);
    }
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
