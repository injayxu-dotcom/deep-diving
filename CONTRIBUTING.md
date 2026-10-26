# 参与贡献

先说最重要的一句：**这个项目零配置就能跑起来**，不需要云环境、不需要 API Key。

```bash
git clone <your-repo-url> deep-diving
cd deep-diving
npm install
npm run dev
```

打开 `http://127.0.0.1:5173`，就能用。数据存在浏览器 localStorage 里，不联网。

---

## 可选：接入真实 AI

默认走本地 mock，只能看流程。要真的调用模型：

```bash
cp .env.example .env.local
```

然后按 `.env.local` 里的注释填。三种模式：

| 模式 | 配置 | 说明 |
| --- | --- | --- |
| 纯本地（默认） | 什么都不填 | 数据只存本机，不联网 |
| 本地代理 | 填模型服务商地址和 Key | 由 `server/viteAiProxy.ts` 转发，绕过浏览器 CORS |
| 云端同步 | 填 CloudBase HTTP 访问服务地址 | 多设备同步，需要自己部署云函数 |

云端部署见 `docs/MAINTAINING.md`。**开源用户不需要部署云端也能完整使用本地功能。**

---

## 目录结构

```
src/           前端（浏览器环境）
  components/    界面组件（按阶段划分：Canvas / Clarify / Report）
  store/         状态管理，单 store（useStore.ts）
  lib/           纯逻辑：AI 调用、评分、提示词、导出、存储
  styles/        样式与设计令牌
electron/      桌面外壳：主进程、preload、打包脚本（Node 环境）
server/        AI 转发核心，dev 与桌面端共用同一份
cloud/functions/ 可选的 CloudBase 云函数
tools/           开发期脚本（截图、e2e），不参与构建
docs/            部署维护说明与界面截图
```

`src/lib/` 里是纯函数，改动时优先配合单测或自检脚本。
`src/store/useStore.ts` 是唯一的状态源。改动核心逻辑前，先读 `src/lib/scoring.ts` 与 `src/lib/prompts.ts` 的注释——六维评分、反平庸机制的设计意图都写在那里，有些看起来奇怪的地方是刻意的。

### 两套运行环境，分开检查

前端跑在浏览器里，主进程跑在 Node 里，所以有两个 tsconfig：

```bash
npm run typecheck        # src/，DOM 环境
npm run typecheck:node   # electron/ + server/，Node 环境
npm run check            # 两个都跑（CI 用的就是这条）
```

主进程那套**必须单独检查**：esbuild 只转译不报类型错，漏检的话错误会静默潜伏到运行时。

### 桌面端开发

```bash
npm run desktop:dev      # 热更新：同时起 Vite 和窗口
npm run desktop          # 跑构建产物（更接近用户实际看到的样子）
```

`desktop:dev` 用独立的数据目录（`deep-diving-dev`），不会碰正式使用时的项目数据。

关于环境变量 `ELECTRON_RUN_AS_NODE`：某些 AI / 脚手架终端会预设它，让 Electron 退化成纯 Node。带着它启动时 `require('electron')` 返回的是可执行文件路径而不是 API，主进程会以「Cannot read properties of undefined (reading 'isPackaged')」这种完全指不到原因的错崩掉。仓库里的 `electron/launch.mjs` 已经显式摘掉它，但如果你在别处直接敲 `electron .`，记得先清掉。

---

## 提交前

```bash
npm run typecheck
npm run build
```

两条都过再提 PR。CI 会再验一遍（`ubuntu-latest` + Node 20）。

---

## Pull Request

- 一个 PR 只做一件事。混着改视觉和改逻辑的 PR 会被要求拆开
- 描述里说清「为什么改」，不只是「改了什么」
- 涉及界面的改动附截图（改前 / 改后）
- 不要提交 `package-lock.json` 之外由工具生成的产物

---

## 千万别提交这些

`.gitignore` 已经挡住，但请自己再确认一遍：

- `.env.local` —— 含你的 Key
- `cloud-env.local.md` —— 含云环境信息
- `cloud/functions/api/cloudbaserc.json` —— 由脚本从 `.env.local` 生成，含令牌
- `shots-*/`、`tools/shots/` —— 体积大

提交前跑一次 `git status`，看到 `??` 的新文件先想一下它该不该进仓库。

---

## 代码风格

没有强制 lint，但请跟随现有风格：

- TypeScript strict，不用 `any` 兜底
- 组件文件用 `.tsx`，纯逻辑放 `src/lib/`
- 注释写「为什么」，不写「是什么」
- 中文注释可以，变量名和 API 用英文

---

## 协议

提交即表示同意以 [MIT](./LICENSE) 协议授权你的贡献。
