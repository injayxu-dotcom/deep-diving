# 部署与维护

> 这份文档面向**要自己部署云端版本**的人。只做本地使用的话不需要读它。
>
> 本文原为 README 的「云端同步」章节，2026-10-26 拆出，便于使用者与维护者各看各的。


## 云端同步（多设备 / 不丢失）

localStorage 是「按浏览器、按机器」存的，换设备必然丢。要「打开就有 + 其他设备能用」，需一个服务端。

方案：腾讯云开发（CloudBase）云函数 `cloud/functions/api`，一个函数同时承担 **AI 代理**与**工作区读写**：
- `/ai/chat` 代理 LLM —— 浏览器不再直连厂商、Key 也不落前端（优先用函数环境变量 `LLM_API_KEY`）
- `/ws` 读写工作区 —— 存进云数据库，单人用固定 `id=default` 即可多设备共享

前端在「AI 设置」面板里填**云端后端地址**即启用同步：改动自动推云，启动时自动拉取云端更新的版本。不填则完全本地，两种模式并存、互不干扰。**开源版本默认不预填地址**，需自己部署后填入。

详细部署步骤见 [`cloud/functions/api/README.md`](cloud/functions/api/README.md)。要点：
1. `cd cloud/functions/api && npm install`
2. 控制台新建云函数 `deepdiving-api`，上传该目录，环境变量配 `TCB_ENV` + `LLM_API_KEY`
3. 用 `tcb service create` 开 HTTP 访问服务（见下）
4. 把地址填进前端「AI 设置 → 云端同步 → 云端后端地址」

> 安全：公网部署**建议**设置函数环境变量 `WS_TOKEN`，并在前端填「同步令牌」。
> 另外，**API Key 永不上传云端**（`storage.ts` 上传前会清空 `apiKey`），换设备各填一次即可。
> 更完整的多用户方案应接入 CloudBase 登录、按 `uid` 隔离工作区。

### 调用方式：HTTP 访问服务（不走 JS SDK）

**这是踩过坑后的最终选择。** 前端对后端只有一次普通 `fetch`，没有任何 SDK、没有登录态。

```
GET    /ws?id=default   → 读工作区
POST   /ws              → 写工作区
DELETE /ws?id=default   → 删工作区
POST   /ai/chat         → AI 代理（SSE）
```

**为什么不用 CloudBase JS SDK 的 `callFunction`**（曾尝试，已放弃）：

| 尝试 | 结果 |
| --- | --- |
| CDN `cloudbase.full.js` 1.x | 服务端已禁用 1.x access_token 体系：`ACCESS_TOKEN_DISABLED: 请升级 js sdk 到 2.0 及以上` |
| npm `@cloudbase/js-sdk` 2.x | **不存在**，npm 版本线是 1.x → 3.x |
| 官方 CDN 2.x | 全部 404，只有 1.7.2 可用 |
| npm 3.9.2 打包进浏览器 | `signInAnonymously()` 能调通，但 `callFunction` 稳定报 `unauthenticated \| credentials not found`（`localCredentials.getCredentials()` 为空）。已排除 persistence、clientId、匿名登录开关（控制台确认已开）、函数本身 |

结论：换用 **HTTP 访问服务**——由 CloudBase 网关直接鉴权并自动回写 CORS 头，浏览器一次 fetch 直达，链路最短最稳。

```bash
# 创建（路径名与函数名一致，函数内会剥掉这个前缀做路由）
tcb service create -p deepdiving-api -f deepdiving-api -e <your-env-id>

# 会得到（注意是 ap-shanghai.app 域名，不是静态托管的 tcloudbaseapp 域名）
# https://<envId>-<uin>.ap-shanghai.app.tcloudbase.com/deepdiving-api
```

> **两个域名不要搞混**：
> - `https://<envId>-<uin>.tcloudbaseapp.com` = **静态托管域名**，站点在 `/deepdiving/`。在这个域名下访问 `/deepdiving-api/*` 会回退到静态托管的 index.html（**SPA fallback，状态码仍是 200** —— 所以任何 404 都会伪装成 200，验收资源时必须看 content-type）。
> - `https://<envId>-<uin>.ap-shanghai.app.tcloudbase.com` = **HTTP 访问服务域名**，后端端点在 `/deepdiving-api`。
> - ⚠️ 浏览器直接打开 `...tcloudbaseapp.com/deepdiving/` 会先看到腾讯云的**「风险提醒」测试域名拦截页**（curl 不会触发，所以「curl 通了」不等于「用户能直接打开」）。交付/分享请用已绑定的正式域名 `https://<your-domain>/deepdiving/`。
>
> 二者跨域，但网关会 echo `Origin` 回写 `Access-Control-Allow-Origin`，浏览器可正常调用。
> 因为 fallback 会返回 **200 + HTML**，前端必须靠 `content-type: text/html` 识别，否则会伪装成"成功"却拿到空内容——深潜 / 裂变会因此解析失败。

### AI 调用的双路径

生产构建（`import.meta.env.PROD`）下走这个优先级，兼顾流式体验与兼容性：

1. **浏览器直连厂商**（默认）——真流式输出，逐字吐字。DeepSeek / 智谱等已放开 CORS，实测可用。
2. **失败自动回落到云端代理** `POST /ai/chat`——厂商不放 CORS 时兜底，API Key 由服务端转发，可完全不落前端（配 `LLM_API_KEY` 环境变量）。

开发模式（`npm run dev`）走 Vite 本地代理中间件 `/api/ai/chat`，同上协议。

> 云函数受 SCF 限制无法真正流式返回，代理路径是一次性返回全文；直连路径才是逐字输出。

## 子路径部署（与同环境下的其他站点共存）

在同一个 CloudBase 环境里已经托管了别的站点时，Deep Diving 可以走 **子路径 `/deepdiving/`**，两类资源完全独立，不会互相覆盖：

- **静态托管**按「目录」组织：部署时把产物写到子目录 `deepdiving`，根目录的其他站点文件一个字节都不会动。
- **云函数**是另一类资源，和静态托管平级，部署函数不影响任何静态文件。

### 部署步骤

```bash
# 1. 用带前缀的脚本构建（资源/入口自动带 /deepdiving/ 前缀）
#    前缀在 vite.config.ts 里按 --mode cloud 取，不在命令行传 --base —— 见下面坑 1
npm run build:cloud

# 2. 只把产物推到 /deepdiving 子目录，绝不会碰根目录
#    ⚠️ MSYS_NO_PATHCONV=1 不是可选项，是必需项 —— 见下面的坑
MSYS_NO_PATHCONV=1 tcb hosting deploy ./dist /deepdiving -e <your-env-id>
```

> **⚠️ 坑 1：`--base=/deepdiving/` 会被 Git Bash 翻译成磁盘路径（2026-10-17 修掉）**
>
> MSYS 把以 `/` 开头的命令行参数当 POSIX 绝对路径翻译。手动跑
> `npx vite build --base=/deepdiving/` 时，产物 index.html 里三条引用会变成
> `C:/Users/…/PortableGit/deepdiving/...`，而 **vite 照样构建成功、退出码 0、
> 终端一片绿**，只有打开产物才看得出。
>
> 现在 `build:cloud` 走 `vite build --mode cloud`，base 在 `vite.config.ts` 里
> 用 `mode === 'cloud'` 取 —— 纯字符串常量，不经过路径判断，也就不再要求
> 每台机器都记得先设环境变量。**但第 2 步的 `/deepdiving` 仍是 CLI 参数，
> `MSYS_NO_PATHCONV=1` 依然必需**（下面这条就是它）。

部署完成后访问 `https://<your-domain>/deepdiving/`（或环境域名 `https://<envId>-<uin>.tcloudbaseapp.com/deepdiving/`）即可打开创意深潜。

> **⚠️ 在 Windows Git Bash 里部署必须加 `MSYS_NO_PATHCONV=1`（2026-10-17 实测踩到）**
>
> MSYS 会把命令行里的 `/deepdiving` 当成 POSIX 绝对路径**自动翻译**成
> `C:/Users/<你>/AppData/Local/Programs/WorkBuddy/resources/vendor/PortableGit/deepdiving`，
> 于是 9 个文件被推到一堆垃圾键下，而真正的 `deepdiving/index.html` 一个字节没动。
> **这个失败是静默的**：`tcb hosting deploy` 照样打 9 个 √，退出码 0。
>
> 更坑的是**验收时也容易误判**：去 curl 新产物的 URL 会拿到 **200** —— 但那是
> SPA fallback 把根目录的 `index.html` 返回了（见下节）。**必须用
> `content-type` + `size_download` + 首字节来验真**，只看状态码会把假 200 当成成功。
> 本项目的验真命令：
>
> ```bash
> U=https://<your-domain>/deepdiving
> curl -s -o /dev/null -w "%{http_code} %{content_type} %{size_download}\n" "$U/assets/index-<hash>.js"
> # 期望：200  application/javascript  <五十万字节级>   ← 如果拿到 text/html + 1214B，就是 fallback
> ```
>
> 收尾（删掉误传的垃圾键；先 `--dry-run` 看清文件清单再删）：
>
> ```bash
> P="C:/Users/<你>/AppData/Local/Programs/WorkBuddy/resources/vendor/PortableGit/deepdiving"
> MSYS_NO_PATHCONV=1 tcb hosting delete "$P" --dir --dry-run -e <your-env-id>
> MSYS_NO_PATHCONV=1 tcb hosting delete "$P" --dir --yes     -e <your-env-id>
> ```

> 关键点：`MSYS_NO_PATHCONV=1 tcb hosting deploy ./dist /deepdiving` 的第二个参数 `deepdiving` 是**云端子目录**。它只往 `/deepdiving/*` 写文件，不会触达 `/`（其他站点所在位置）。如果你误写成 `tcb hosting deploy ./dist /` 才会覆盖根目录——**别带那个斜杠**。

### 访问与同步如何互不干扰

- 前端访问地址：`https://<envId>-<uin>.tcloudbaseapp.com/deepdiving/`
- 云端后端地址：HTTP 访问服务域名（形如 `https://<envId>-<uin>.ap-shanghai.app.tcloudbase.com/deepdiving-api`），与静态站点是两条平行线，互不影响。
- 即：静态站点走 `/deepdiving/` 子路径，数据读写走 `ap-shanghai.app` 域名的函数端点。

### 想换成独立域名 / 独立环境？

若以后不希望和其他站点共用一个环境，新建一个 CloudBase 环境、把函数与静态托管都建在新环境里即可；改 `types.ts` 的 `DEFAULT_API_BASE`（或前端「AI 设置 → 云端后端地址」）即可，无需改代码。


---

## 维护者须知

### 发布流程

1. `npm run typecheck` 与 `npm run build` 必须通过（CI 也会验）
2. 改版本号：`package.json` 的 `version`
3. 打 tag：`git tag v0.x.0 && git push --tags`

### 分支约定

- `main` 始终保持可构建
- 功能分支命名 `feat/xxx`、修复 `fix/xxx`
- PR 合并前 CI 必须绿

### Node 版本

以 `.nvmrc` 为准（当前 20.x）。`package.json` 的 `engines` 要求 `>=18.18`。

云函数运行时不跟随前端，固定 `Nodejs18.15`，见 `cloud/functions/api/cloudbaserc.example.json`。
