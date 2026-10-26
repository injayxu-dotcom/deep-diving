import fs from 'node:fs';
import path from 'node:path';

/**
 * 准备一个精简版 Electron 运行时给 electron-builder 用。
 *
 * 为什么不直接把 electronDist 指向 node_modules/electron/dist：
 * electron-builder 会先把整套运行时（含 50 多个语言包）复制到产物目录，
 * 再按 electronLanguages 逐个删掉多余的 .pak。在普通机器上这是无害的，
 * 但在带删除护栏的环境（单批上限 50 个）里，这一步会被直接拦下、整个打包失败。
 *
 * 这里用 cpSync 的 filter 在**复制阶段**就把多余语言包挡掉：没有文件需要删，
 * 打包也就不会再触发护栏。顺带产物复制也更快。
 *
 * 输出到 node_modules/.cache —— 不进 git，也不污染 dist。
 */

const root = process.cwd();
const src = path.join(root, 'node_modules', 'electron', 'dist');
const dst = path.join(root, 'node_modules', '.cache', 'dd-electron');
const stamp = path.join(dst, '.dd-ready');

/** 只保留界面用得到的语言包 */
const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);

if (!fs.existsSync(src)) {
  console.error(`[dd] 找不到 Electron 运行时：${src}\n先跑 npm install。`);
  process.exit(1);
}

if (fs.existsSync(stamp)) {
  console.log(`[dd] 精简运行时已就绪：${dst}`);
  process.exit(0);
}

fs.cpSync(src, dst, {
  recursive: true,
  filter: (sourcePath) => {
    const base = path.basename(sourcePath);
    // 语言包目录下只放行两个
    if (path.basename(path.dirname(sourcePath)) === 'locales') {
      return KEEP_LOCALES.has(base);
    }
    return true;
  },
});

fs.writeFileSync(stamp, new Date().toISOString(), 'utf8');
console.log(`[dd] 已生成精简运行时：${dst}`);
