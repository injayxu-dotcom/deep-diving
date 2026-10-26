#!/usr/bin/env node
/**
 * 云端配置生成 / 推送
 *
 * 背景：云函数的环境变量（尤其 WS_TOKEN、LLM_API_KEY）是密钥，
 * 不能写进被 git 跟踪的 cloudbaserc.json —— 一旦开源就等于把
 * 你云端工作区的读写权限公开送人。
 *
 * 所以拆成两份：
 *   cloudbaserc.example.json  模板，入库，只有变量名没有值
 *   cloudbaserc.json          真实配置，由本脚本生成，已被 .gitignore 排除
 *
 * 本脚本从 `.env.local` 取值（该文件同样不入库），生成 cloudbaserc.json；
 * 加 --push 则顺带推送到云函数。
 *
 * 用法：
 *   node tools/cloud-config.mjs            # 只生成 cloudbaserc.json
 *   node tools/cloud-config.mjs --push     # 生成并推送到云端（合并模式，不动其它变量）
 *   node tools/cloud-config.mjs --new-token  # 重新生成令牌后写入 .env.local（再配合 --push）
 *
 * .env.local 里认识的键：
 *   VITE_API_BASE     云端后端地址，用于反推 envId / 区域
 *   DD_ENV_ID         直接指定环境 ID（覆盖上面的反推结果）
 *   DD_CLOUD_TOKEN    云函数 WS_TOKEN，即前端「云端同步令牌」
 *   DD_LLM_API_KEY    服务端持有的模型 Key（可选，填了前端就不用带 Key）
 *   DD_LLM_BASE_URL   服务端锁定的模型地址（可选）
 *   DD_LLM_LOCK_KEY   置 1 则完全忽略前端传来的 Key（可选，最安全）
 */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_LOCAL = resolve(ROOT, '.env.local');
const FN_NAME = 'deepdiving-api';
const FN_DIR = resolve(ROOT, 'cloud/functions/api');
const RC_PATH = resolve(FN_DIR, 'cloudbaserc.json');

/** 极简 .env 解析：只处理 KEY=VALUE 与 # 注释，足够本项目使用 */
function readEnvLocal(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

/** 原地更新 .env.local 的某个键：有则替换，无则追加 */
function upsertEnvLocal(file, key, value) {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) {
    text = text.replace(re, `${key}=${value}`);
  } else {
    if (text && !text.endsWith('\n')) text += '\n';
    text += `${key}=${value}\n`;
  }
  writeFileSync(file, text, 'utf8');
}

/** 从 HTTP 访问服务地址反推 envId 与区域 */
function parseApiBase(apiBase) {
  const m = /^https?:\/\/([a-z0-9-]+?)-(\d+)\.([a-z0-9-]+)\.app\.tcloudbase\.com/i.exec(
    apiBase || '',
  );
  if (!m) return { envId: '', region: '' };
  return { envId: m[1], region: m[3] };
}

// ---- 取值 ----

const args = process.argv.slice(2);
const PUSH = args.includes('--push');
const NEW_TOKEN = args.includes('--new-token');

if (NEW_TOKEN) {
  upsertEnvLocal(ENV_LOCAL, 'DD_CLOUD_TOKEN', randomBytes(20).toString('hex'));
  console.log('已生成新的 40 位令牌并写入 .env.local（DD_CLOUD_TOKEN）');
  console.log('注意：换令牌后，前端「AI 设置 → 云端同步令牌」也要同步更新。');
}

const env = readEnvLocal(ENV_LOCAL);
const derived = parseApiBase(env.VITE_API_BASE);
const envId = env.DD_ENV_ID || derived.envId;
const token = env.DD_CLOUD_TOKEN || '';

if (!existsSync(ENV_LOCAL)) {
  console.error('找不到 .env.local。请先复制 .env.example 为 .env.local，或运行 --new-token 生成。');
  process.exit(1);
}
if (!envId) {
  console.error('无法确定环境 ID：请在 .env.local 里填 VITE_API_BASE 或 DD_ENV_ID。');
  process.exit(1);
}
if (!token) {
  console.error('尚无令牌。先运行：node tools/cloud-config.mjs --new-token');
  process.exit(1);
}

// ---- 组装环境变量 ----

const envVariables = {
  TCB_ENV: envId,
  WS_TOKEN: token,
  // 要求前端带令牌，否则云函数会被人当免费 AI 网关白嫖，账单算你头上
  LLM_REQUIRE_TOKEN: '1',
};
if (env.DD_LLM_API_KEY) envVariables.LLM_API_KEY = env.DD_LLM_API_KEY;
if (env.DD_LLM_BASE_URL) envVariables.LLM_BASE_URL = env.DD_LLM_BASE_URL;
if (env.DD_LLM_LOCK_KEY === '1') envVariables.LLM_LOCK_KEY = '1';

const rc = {
  envId,
  functions: [
    {
      name: FN_NAME,
      runtime: 'Nodejs18.15',
      handler: 'index.main',
      memorySize: 256,
      timeout: 30,
      installDependency: true,
      envVariables,
    },
  ],
};

writeFileSync(RC_PATH, JSON.stringify(rc, null, 2) + '\n', 'utf8');
console.log(`已生成 ${RC_PATH.replace(ROOT + '\\', '')}`);
console.log('  环境变量：' + Object.keys(envVariables).join(', '));
console.log('  WS_TOKEN：' + token.slice(0, 4) + '…' + token.slice(-4) + `（${token.length} 位）`);

if (!PUSH) {
  console.log('\n下一步：node tools/cloud-config.mjs --push  （推送到云端）');
  process.exit(0);
}

// ---- 推送 ----
// tcb config update 会交互询问「覆盖 / 合并」：默认回车是**覆盖**，
// 会把云端未在本文件声明的变量全部删掉。所以这里显式下移一格选「合并」。
try {
  const out = execFileSync(
    'tcb',
    ['config', 'update', 'fn', FN_NAME, '-e', envId],
    { cwd: FN_DIR, input: '\x1b[B\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  console.log('\n' + out.trim());
} catch (e) {
  console.error('\n推送失败：');
  console.error(String((e && e.stdout) || '') + String((e && e.stderr) || e));
  console.error(`\n可手动执行：cd cloud/functions/api && tcb config update fn ${FN_NAME} -e ${envId}`);
  console.error('在弹出的选择里用方向键选「Merge update（合并）」，不要选覆盖。');
  process.exit(1);
}
