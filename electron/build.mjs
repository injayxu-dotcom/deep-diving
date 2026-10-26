import { build } from 'esbuild';

/**
 * 用 esbuild 把主进程 / preload 打成 CJS。
 *
 * 不引 vite-plugin-electron 之类的封装：主进程只有两个文件，直接调 esbuild
 * 更透明，也少一个依赖。esbuild 本身随 Vite 一起装了，不算新增体积。
 *
 * 产物到 electron-dist/，与 dist/ 平级 —— 打包后 main.js 里
 * `path.join(__dirname, '..', 'dist', 'index.html')` 正好指到前端产物。
 *
 * 用 .cjs 而不是 .js：package.json 里是 `"type": "module"`，同目录的 .js
 * 会被当成 ESM 解析，而 Electron 主进程需要 CJS（`__dirname`、`require`）。
 */

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  minify: true,
  logLevel: 'info',
};

await Promise.all([
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'electron-dist/main.cjs' }),
  build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'electron-dist/preload.cjs' }),
]);
