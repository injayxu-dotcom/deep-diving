import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { aiProxy } from './server/viteAiProxy';

/**
 * 子路径部署：`npm run build:cloud`（内部是 `vite build --mode cloud`）。
 *
 * ⚠️ 为什么不用 `--base=/deepdiving/`，而是走 mode：
 * Git Bash（MSYS）会把**以 / 开头的命令行参数**当成路径，翻译成
 * `C:/…/PortableGit/deepdiving/`。于是产物 index.html 里
 * `<script src>` / `<link href>` / `<link rel="icon">` 三条全部指向一个
 * 不存在的本地路径，而 **vite 照样构建成功、退出码 0、终端一片绿**。
 * 上一轮部署就吃过这个亏（见 README「部署三坑」第 1 条），当时的解法是
 * 每条命令前加 `MSYS_NO_PATHCONV=1` —— 能work，但要求每个人每次都记得。
 * `--mode cloud` 是纯字符串，不经过路径判断，从源头上没有这个坑。
 */
export default defineConfig(({ mode }) => ({
  base: mode === 'cloud' ? '/deepdiving/' : '/',
  plugins: [react(), aiProxy()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
}));
