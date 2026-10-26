# 深度潜水 · 云函数

一个 CloudBase 云函数同时提供两件事（HTTP 触发）：

| 路由 | 方法 | 作用 |
| :--- | :--- | :--- |
| `/ai/chat` | POST | 代理 LLM。浏览器不再直连厂商、Key 不落前端。 |
| `/ws` | GET / POST | 读取 / 保存工作区（云数据库集合 `workspaces`） |

## 部署步骤

0. 已有腾讯云开发环境（环境 ID 形如 `deep-diving-1g2h3k4j`），拿到 **envId**。
1. 在 `cloud/functions/api/` 目录安装依赖：
   ```bash
   cd cloud/functions/api && npm install
   ```
2. 在 CloudBase 控制台「云函数」里新建函数 `deepdiving-api`，
   - 运行环境 Node 18+，上传该目录（含 `index.js` + `package.json` + `node_modules`）。
   - 或通过 CLI：`tcb fn deploy deepdiving-api --dir .`
3. 给函数配置**环境变量**：
   推荐用脚本生成，避免把密钥手写进会被 git 跟踪的文件：

   ```bash
   # 首次：生成 40 位随机令牌并写入 .env.local（该文件不入库）
   node tools/cloud-config.mjs --new-token
   # 生成 cloudbaserc.json（不入库），随后推送到云端
   node tools/cloud-config.mjs --push
   ```

   变量清单：

   | 变量 | 必填 | 说明 |
   | :--- | :--- | :--- |
   | `TCB_ENV` | 是 | 你的环境 ID |
   | `WS_TOKEN` | 公网部署时必填 | 开启后前端必须带 `x-ws-token` 才能读写工作区与调 AI |
   | `LLM_REQUIRE_TOKEN` | 建议 `1` | 置 1 后 `/ai/chat` 也要求令牌，防止云函数被白嫖 |
   | `LLM_API_KEY` | 二选一 | **推荐放这里**，前端就无需再填 Key |
   | `LLM_BASE_URL` | 可选 | 默认 `https://api.deepseek.com` |
   | `LLM_LOCK_KEY` | 可选 | 置 1 则完全忽略前端传来的 Key，Key 永不上行 |
   | `LLM_ALLOWED_HOSTS` | 可选 | 追加自定义模型域名（英文逗号分隔），源码内有默认白名单 |

   脚本会自动把 `DD_LLM_API_KEY` / `DD_LLM_BASE_URL` / `DD_LLM_LOCK_KEY` 转成上表对应变量，
   所以密钥统一写进 `.env.local` 即可。

   > **推送时务必选「Merge update（合并）」**。`tcb config update` 默认项是「Override（覆盖）」，
   > 会把云端未在本文件声明的变量全部删除。脚本已自动代选合并。
4. 给该函数开启 **HTTP 触发**（云接入 / HTTP 触发），拿到函数访问地址，形如：
   `https://deep-diving-1g2h3k4j.service.tcloudbase.com/deepdiving-api`
   这个地址就是要填进前端「云端同步 → 云函数地址」的那串。

## 文件说明

| 文件 | 入库 | 说明 |
| :--- | :--- | :--- |
| `index.js` | 是 | 函数实现 |
| `cloudbaserc.example.json` | 是 | 配置模板，只有变量名 |
| `cloudbaserc.json` | **否** | 真实配置，含密钥，由 `tools/cloud-config.mjs` 生成 |

## 已修复缺陷

**`POST /ws` 首次保存会落到随机 `_id` 的文档上，导致工作区读不回来。**（2026-10-10 修复）

原实现把请求体里的 `_id` 剥掉后调用 `db.collection().add()`，
而 CloudBase 的 `add()` 会自动生成 `_id`——于是客户端固定发 `_id: 'default'`、
云端却永远写进随机 `_id` 的新文档；下次 `GET /ws?id=default` 依旧 `{exists:false}`，
再保存又新建一条。表现为：**云端同步看起来成功，实际永远读不回，且文档无限增长**。

实测证据（2026-10-10）：集合 `workspaces` 共 961 条文档，`_id` 全为随机串，
**没有 `default`**；真实 `savedAt` 区间 2026-09-04T19:25:10Z ~ 2026-09-09T08:22:15Z。
已全部导出备份后清空（备份位置见项目根目录 `docs/审查报告-2026-10-10.md` §10.7）。

修法：改用 `doc(id).set()` —— 不存在则按该 `_id` 创建、存在则整体替换的 upsert。

```js
await db.collection(COLLECTION).doc(id).set(payload);
```

已用 `_id='__verify__'` 独立文档做「保存 → 读回 → 再保存 → 再读回 → 删除」闭环验证，
五步全部符合预期（第二次读回时旧字段消失，证明是整体替换而非追加）。

> 为什么不用 `update()`：`doc(id).update()` 在文档不存在时不会创建。
> 为什么不用 `add({ _id: id, ... })`：`_id` 是系统字段，放进写入 payload 不可靠。

## 安全说明

- 单人用、仅自己访问时，`WS_TOKEN` 可留空；一旦公网部署，请务必设置 `WS_TOKEN`，
  否则任何人拿到函数地址都能读写你的默认工作区。
- 实测（2026-10-10）：`WS_TOKEN` 为空时，`checkToken` 恒返回 `true`，`/ws` 完全裸奔。
  现已设为 40 位随机令牌并置 `LLM_REQUIRE_TOKEN=1`。
- 更完整的多用户方案应接入 CloudBase 登录（微信 / 邮箱），按 `uid` 隔离工作区。
