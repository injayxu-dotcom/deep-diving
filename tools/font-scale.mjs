#!/usr/bin/env node
/* ============================================================
   字号阶梯收敛与校验工具

   背景：src/styles.css 的 font-size 曾有 19 个不同取值、175 条声明，
   其中 9 个取值挤在 9.5–13.5px、步长仅 0.5px。0.5px 的差在屏幕上等于
   没有差别，但它让每个区块"看起来都不一样大" —— 结果是毛糙，不是层次。
   这个缺陷不报错、不告警，只让界面显得不精致，所以必须靠工具来守。

   目标阶梯（6 档 + 3 档展示级，全部有令牌）：
     10 / 11 / 12 / 13 / 15 / 17     →  --fs-xs … --fs-2xl
     20 / 24 / 34                    →  --fs-d1 … --fs-d3

   为什么全部令牌化而不是只改数字：
   只要还留着裸 px，将来手写一个 13.5px 就又会漂移。全部走令牌之后，
   "有没有绕过阶梯"这件事可以被 grep 和 CI 直接守住（--assert）。

   覆盖两处字号来源（缺一处 --assert 就会说谎）：
     1. src/styles.css        的 font-size 声明
     2. src 下所有 .ts / .tsx 的内联 fontSize（React 的 style 属性）

   校验的四条不变量（--assert）：
     ① 无裸 px 字号 —— 两处来源都算
     ② styles.css / TSX 用到的每个 --fs-* 都必须在 tokens.css 里有定义
        （没定义时 font-size 会静默回退成继承值 —— 不报错、只是"没生效"，
          本项目历史上出过 4 次这类问题，见 docs/审查报告 §10.8 R19）
     ③ tokens.css 里定义的每个 --fs-* 都必须登记在本文件的 TOKEN 表里
     ④ 令牌的值必须等于 TOKEN 表登记的像素值
        （这一条专门拦"稿子改了、令牌没同步"的档位漂移）

   用法：
     node tools/font-scale.mjs            # 只报告（默认，不改文件）
     node tools/font-scale.mjs --check    # 同上
     node tools/font-scale.mjs --json     # 机器可读
     node tools/font-scale.mjs --assert   # 四条不变量，全过 exit 0，否则 exit 1
     node tools/font-scale.mjs --write    # 实际改写文件（自动备份到临时目录）
   ============================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_FILE = path.join(ROOT, 'src', 'styles.css');
const TOKENS_FILE = path.join(ROOT, 'src', 'styles', 'tokens.css');
const SRC_DIR = path.join(ROOT, 'src');

/** 像素值 → 令牌名。这张表是唯一的映射定义，改档位只改这里。 */
const TOKEN = new Map([
  [10, '--fs-xs'],
  [11, '--fs-sm'],
  [12, '--fs-md'],
  [13, '--fs-lg'],
  [15, '--fs-xl'],
  [17, '--fs-2xl'],
  [20, '--fs-d1'],
  [24, '--fs-d2'],
  [34, '--fs-d3'],
]);

const BODY_TIERS = [10, 11, 12, 13, 15, 17];
const DISPLAY_TIERS = [20, 24, 34];
const ALL_TOKENS = new Set(TOKEN.values());

/** 原值 → 目标档位 */
function targetFor(px) {
  if (DISPLAY_TIERS.includes(px)) return px;   // 展示级：值不变，但同样令牌化
  if (px >= 20) return null;                   // 未登记的展示级：不动，但 --assert 会点出来
  if (px <= 10) return 10;
  if (px <= 11) return 11;
  if (px <= 12.5) return 12;
  if (px <= 13.5) return 13;
  if (px <= 15) return 15;
  return 17;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* ---------- 来源 1：styles.css ---------- */

const RE_PX = /font-size:\s*([0-9]*\.?[0-9]+)px(\s*!important)?/g;
const RE_VAR = /font-size:\s*var\((--fs-[a-z0-9-]+)\)/g;

function analyzeCss() {
  const src = fs.readFileSync(TARGET_FILE, 'utf8');
  const lines = src.split('\n');
  const decls = [];
  const byValue = new Map();
  const usedTokens = new Map();
  let selector = '';
  let pending = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const isComment = trimmed.startsWith('/*') || trimmed.startsWith('*');

    if (!isComment) {
      if (line.includes('{')) {
        const sel = (pending.join(' ') + ' ' + line.split('{')[0]).trim().replace(/\s+/g, ' ');
        if (!sel.startsWith('@')) selector = sel;
        pending = [];
      } else if (!line.includes(';') && !line.includes(':') && !line.includes('}') && trimmed) {
        pending.push(trimmed);
      } else if (line.includes('}')) {
        pending = [];
      }
    }
    if (isComment) continue;

    let m;
    RE_PX.lastIndex = 0;
    while ((m = RE_PX.exec(line))) {
      const px = parseFloat(m[1]);
      const t = targetFor(px);
      decls.push({
        file: rel(TARGET_FILE), line: i + 1, selector: selector || '(未能判定)',
        from: px, to: t, important: !!m[2], changes: t !== null && t !== px,
      });
      byValue.set(m[1], (byValue.get(m[1]) || 0) + 1);
    }
    RE_VAR.lastIndex = 0;
    while ((m = RE_VAR.exec(line))) {
      usedTokens.set(m[1], (usedTokens.get(m[1]) || 0) + 1);
    }
  }

  const distinct = [...byValue.keys()].sort((a, b) => parseFloat(a) - parseFloat(b));
  return {
    decls, byValue, distinct, usedTokens,
    needChange: decls.filter((d) => d.changes),
    unknownDisplay: decls.filter((d) => d.to === null),
  };
}

/* ---------- 来源 2：TSX / TS 内联 fontSize ---------- */

const RE_TSX_NUM = /fontSize:\s*([0-9]*\.?[0-9]+)(?![0-9.])/g;
const RE_TSX_VAR = /fontSize:\s*['"]var\((--fs-[a-z0-9-]+)\)['"]/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function analyzeTsx() {
  const decls = [];
  const usedTokens = new Map();
  const files = [];

  for (const file of walk(SRC_DIR)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let touched = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

      let m;
      RE_TSX_NUM.lastIndex = 0;
      while ((m = RE_TSX_NUM.exec(line))) {
        const px = parseFloat(m[1]);
        const t = targetFor(px);
        decls.push({
          file: rel(file), line: i + 1, selector: '(内联 style)',
          from: px, to: t, changes: t !== null && t !== px,
        });
        touched = true;
      }
      RE_TSX_VAR.lastIndex = 0;
      while ((m = RE_TSX_VAR.exec(line))) {
        usedTokens.set(m[1], (usedTokens.get(m[1]) || 0) + 1);
        touched = true;
      }
    }
    if (touched) files.push(rel(file));
  }

  return {
    decls, usedTokens, files,
    needChange: decls.filter((d) => d.changes),
    unknownDisplay: decls.filter((d) => d.to === null),
  };
}

/* ---------- 令牌定义（tokens.css） ---------- */

function readDefinedTokens() {
  const src = fs.readFileSync(TOKENS_FILE, 'utf8');
  const defined = new Map();   // 令牌名 → 像素值
  const re = /(--fs-[a-z0-9-]+)\s*:\s*([0-9]*\.?[0-9]+)px/g;
  let m;
  while ((m = re.exec(src))) {
    if (!defined.has(m[1])) defined.set(m[1], parseFloat(m[2]));
  }
  return defined;
}

/* ---------- 汇总 ---------- */

const css = analyzeCss();
const tsx = analyzeTsx();
const defined = readDefinedTokens();

const allBare = [...css.decls, ...tsx.decls];
const allNeedChange = [...css.needChange, ...tsx.needChange];
const allUnknownDisplay = [...css.unknownDisplay, ...tsx.unknownDisplay];
const allUsedTokens = new Map([...css.usedTokens]);
for (const [k, v] of tsx.usedTokens) allUsedTokens.set(k, (allUsedTokens.get(k) || 0) + v);

const args = process.argv.slice(2);
const mode = args.includes('--write') ? 'write'
  : args.includes('--assert') ? 'assert'
    : args.includes('--json') ? 'json' : 'check';

/* ---- assert：四条不变量 ---- */
if (mode === 'assert') {
  const problems = [];

  // ① 无裸 px
  if (allBare.length) {
    problems.push(`有 ${allBare.length} 条裸 px 的 font-size（未走令牌）`);
  }
  // ② 用到的令牌必须已定义
  const undef = [...allUsedTokens.keys()].filter((t) => !defined.has(t));
  if (undef.length) {
    problems.push(`引用了 tokens.css 里不存在的令牌：${undef.join(' ')}（font-size 会静默回退成继承值）`);
  }
  // ③ 定义的令牌必须登记在 TOKEN 表
  const unregistered = [...defined.keys()].filter((t) => !ALL_TOKENS.has(t));
  if (unregistered.length) {
    problems.push(`tokens.css 定义了未登记在阶梯表里的令牌：${unregistered.join(' ')}`);
  }
  // ④ 令牌值必须与阶梯表一致
  const drift = [];
  for (const [px, tok] of TOKEN) {
    if (!defined.has(tok)) { drift.push(`${tok} 未定义（应为 ${px}px）`); continue; }
    if (defined.get(tok) !== px) drift.push(`${tok} = ${defined.get(tok)}px，应为 ${px}px`);
  }
  if (drift.length) problems.push(`令牌值与阶梯表不一致：${drift.join('；')}`);

  // 未登记的展示级
  if (allUnknownDisplay.length) {
    problems.push(`${allUnknownDisplay.length} 条 ≥20px 的值未登记在 TOKEN 表里`);
  }

  console.log('字号阶梯校验');
  console.log(`  styles.css        ${rel(TARGET_FILE)}`);
  console.log(`  tokens.css        ${rel(TOKENS_FILE)}`);
  console.log(`  内联字号文件      ${tsx.files.length} 个${tsx.files.length ? '（' + tsx.files.join('、') + '）' : ''}`);
  console.log();

  if (problems.length) {
    for (const p of problems) console.log(`  ❌ ${p}`);
    if (allBare.length) {
      console.log(`\n  裸 px 明细（前 30 条）：`);
      for (const d of allBare.slice(0, 30)) {
        console.log(`     ${d.file}:${String(d.line).padEnd(5)} ${String(d.from + 'px').padEnd(8)} ${d.selector}`);
      }
      if (allBare.length > 30) console.log(`     … 另有 ${allBare.length - 30} 条`);
    }
    if (allUnknownDisplay.length) {
      for (const d of allUnknownDisplay) console.log(`     ${d.file}:${d.line}  ${d.from}px  ${d.selector}`);
    }
    console.log('\n  ❌ 未通过');
    process.exit(1);
  }

  console.log('  ✅ ① 无裸 px 字号（styles.css 0 条 / 内联 0 处）');
  console.log(`  ✅ ② 用到的 ${allUsedTokens.size} 个令牌全部已在 tokens.css 定义`);
  console.log(`  ✅ ③ tokens.css 定义的 ${defined.size} 个 --fs-* 全部登记在阶梯表`);
  console.log('  ✅ ④ 令牌值与阶梯表逐项一致');
  console.log(`\n  阶梯      正文档 ${BODY_TIERS.join(' / ')} px · 展示级 ${DISPLAY_TIERS.join(' / ')} px`);
  console.log(`  令牌      ${[...ALL_TOKENS].join(' ')}`);
  process.exit(0);
}

/* ---- json ---- */
if (mode === 'json') {
  console.log(JSON.stringify({
    sources: {
      css: { file: rel(TARGET_FILE), barePxDeclarations: css.decls.length, distinctPxValues: css.distinct.length, alreadyTokenized: Object.fromEntries(css.usedTokens) },
      tsx: { files: tsx.files, barePxDeclarations: tsx.decls.length, alreadyTokenized: Object.fromEntries(tsx.usedTokens) },
    },
    totals: { barePxDeclarations: allBare.length, needChange: allNeedChange.length },
    tokenMap: Object.fromEntries([...TOKEN].map(([k, v]) => [k, v])),
    definedTokens: Object.fromEntries(defined),
    bodyTiers: BODY_TIERS,
    displayTiers: DISPLAY_TIERS,
    needChange: allNeedChange.map((d) => ({ file: d.file, line: d.line, selector: d.selector, from: d.from, to: d.to })),
  }, null, 2));
  process.exit(0);
}

/* ---- check / write ---- */
console.log('字号阶梯收敛' + (mode === 'write' ? '（写入模式）' : '（只报告，不改文件）'));
console.log(`  styles.css  ${rel(TARGET_FILE)}`);
console.log(`  内联字号    ${tsx.files.length} 个文件 / ${tsx.decls.length} 处\n`);

if (!allBare.length && !allNeedChange.length) {
  console.log(`  已无裸 px 的 font-size。当前使用令牌 ${[...allUsedTokens.keys()].sort().join(' ')}`);
  console.log('  ✅ 无需改动');
  process.exit(0);
}

console.log('  【styles.css】原值  条数   目标令牌');
console.log('  ' + '-'.repeat(38));
for (const k of css.distinct) {
  const px = parseFloat(k);
  const t = targetFor(px);
  const label = t === null ? '未登记（不动）' : `var(${TOKEN.get(t)})`;
  console.log(`  ${k.padEnd(14)} ${String(css.byValue.get(k)).padEnd(6)} ${label}`);
}
console.log(`  → 合计 ${css.decls.length} 条 · 不同取值 ${css.distinct.length} 个 · 需改值 ${css.needChange.length} 条`);

if (tsx.decls.length) {
  console.log('\n  【内联 fontSize】');
  for (const d of tsx.decls) {
    const label = d.to === null ? '未登记（不动）' : `var(${TOKEN.get(d.to)})`;
    const mark = d.changes ? '改值' : '换令牌';
    console.log(`    ${d.file}:${String(d.line).padEnd(5)} ${String(d.from + 'px').padEnd(7)} → ${String(d.to + 'px').padEnd(6)} [${mark}] ${label}`);
  }
}

console.log(`\n  总计 裸 px ${allBare.length} 处 · 需改值 ${allNeedChange.length} 处`);
console.log(`  执行后：全部走令牌，取值集合 = ${ALL_TOKENS.size} 个令牌`);

if (mode === 'check') {
  console.log(`\n  需改值的声明（前 20 条，完整见 --json）：`);
  for (const d of allNeedChange.slice(0, 20)) {
    console.log(`    ${d.file}:${String(d.line).padEnd(5)} ${String(d.from + 'px').padEnd(7)} → ${String(d.to + 'px').padEnd(5)} ${d.selector}`);
  }
  if (allNeedChange.length > 20) console.log(`    … 另有 ${allNeedChange.length - 20} 条`);
  console.log('  （未改动任何文件。要执行请加 --write）');
  process.exit(0);
}

/* ---- write ---- */

// 写之前先确认所有目标令牌都已定义，否则会写出引用空令牌的代码
const missing = [...new Set(allBare.filter((d) => d.to !== null).map((d) => TOKEN.get(d.to)))]
  .filter((t) => !defined.has(t));
if (missing.length) {
  console.log(`\n  ❌ 目标令牌尚未在 tokens.css 定义：${missing.join(' ')}`);
  console.log('  已中止，未写入任何文件。请先补 tokens.css。');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backups = [];
let replaced = 0;

/** 逐文件改写；按行聚合、同行从后往前替换，避免下标错位 */
function rewrite(file, items, makeRe, makeRep) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const bak = path.join(os.tmpdir(), `${path.basename(file)}.${stamp}.bak`);
  fs.writeFileSync(bak, lines.join('\n'), 'utf8');
  backups.push(bak);

  const perLine = new Map();
  for (const d of items) {
    if (d.to === null) continue;
    perLine.set(d.line, [...(perLine.get(d.line) || []), d]);
  }

  let n = 0;
  for (const [lineNo, ds] of perLine) {
    const idx = lineNo - 1;
    let line = lines[idx];
    for (const d of ds) {
      const token = TOKEN.get(d.to);
      const before = line;
      line = line.replace(makeRe(d), makeRep(token, d));
      if (line !== before) n++;
      else console.warn(`  ⚠️ ${rel(file)}:${lineNo} 未能替换 ${d.from}px（原行：${before.trim()}）`);
    }
    lines[idx] = line;
  }

  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { n, expected: items.filter((d) => d.to !== null).length };
}

// 来源 1：styles.css
const cssRes = rewrite(
  TARGET_FILE, css.decls,
  (d) => new RegExp(`(font-size:\\s*)${String(d.from).replace('.', '\\.')}px`),
  (token) => `$1var(${token})`,
);
replaced += cssRes.n;
console.log(`\n  styles.css  替换 ${cssRes.n}/${cssRes.expected}`);
if (cssRes.n !== cssRes.expected) {
  console.log('  ❌ 替换数与预期不符，已中止（请用备份还原后排查）');
  console.log(`  备份：${backups.join('\n        ')}`);
  process.exit(1);
}

// 来源 2：TSX 内联
const tsxByFile = new Map();
for (const d of tsx.decls) tsxByFile.set(d.file, [...(tsxByFile.get(d.file) || []), d]);
for (const [file, items] of tsxByFile) {
  const abs = path.join(ROOT, file);
  const res = rewrite(
    abs, items,
    (d) => new RegExp(`(fontSize:\\s*)${String(d.from).replace('.', '\\.')}(?![0-9.])`),
    (token) => `$1'var(${token})'`,
  );
  replaced += res.n;
  console.log(`  ${file}  替换 ${res.n}/${res.expected}`);
  if (res.n !== res.expected) {
    console.log('  ❌ 替换数与预期不符，已中止（请用备份还原后排查）');
    console.log(`  备份：${backups.join('\n        ')}`);
    process.exit(1);
  }
}

console.log(`\n  ✅ 共替换 ${replaced} 处`);
console.log(`  备份  ${backups.join('\n        ')}`);

const after = { css: analyzeCss(), tsx: analyzeTsx() };
const left = after.css.decls.length + after.tsx.decls.length;
console.log(`  复检  剩余裸 px ${left} 处 · 使用令牌 ${new Set([...after.css.usedTokens.keys(), ...after.tsx.usedTokens.keys()]).size} 种`);
if (left) {
  console.log('  ⚠️ 仍有裸 px，请检查：');
  for (const d of after.css.decls.slice(0, 10)) console.log(`     ${d.file}:${d.line} ${d.from}px ${d.selector}`);
  for (const d of after.tsx.decls.slice(0, 10)) console.log(`     ${d.file}:${d.line} ${d.from}px ${d.selector}`);
}
console.log('\n  下一步：node tools/font-scale.mjs --assert  应输出 ✅');
