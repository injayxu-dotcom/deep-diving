import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * 启动 Electron。
 *
 * 为什么不直接写 `electron .`：某些 AI / 脚手架终端会预设
 * `ELECTRON_RUN_AS_NODE=1`（让 Electron 退化成纯 Node 用）。带着它启动时
 * `require('electron')` 返回的是可执行文件路径字符串而不是 API，
 * 主进程第一行就报 `Cannot read properties of undefined (reading 'isPackaged')`，
 * 而且错误信息完全指不到真正原因。这里显式摘掉它，与外部环境解耦。
 */

const require = createRequire(import.meta.url);

const electronPath = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });

child.on('exit', (code, signal) => {
  if (signal) process.exit(0);
  process.exit(code ?? 0);
});
