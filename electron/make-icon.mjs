import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * 用 Electron 渲染 DD logo.svg，产出 build/icon.png。
 *
 * 包装一层的理由同 launch.mjs：必须摘掉 ELECTRON_RUN_AS_NODE，
 * 否则 Electron 退化成纯 Node，脚本里 require('electron').app 是 undefined。
 */

const require = createRequire(import.meta.url);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(require('electron'), ['build/make-icon.cjs'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
