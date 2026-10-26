/**
 * 从 DD logo.svg 生成 build/icon.png（512×512）。
 *
 * 不引 sharp / rsvg 之类：Electron 自己就是一个完整的渲染器，
 * 用它转一次省一个依赖，也省得在 Windows 上折腾原生模块编译。
 *
 * 跑法：node electron/launch.mjs 不支持指定脚本，所以直接
 *   env -u ELECTRON_RUN_AS_NODE <electron 路径> build/make-icon.cjs
 * 需要时用 `npm run icon`（见 package.json）。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 512;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svgPath = path.join(__dirname, '..', 'DD logo.svg');
  let svg = fs.readFileSync(svgPath, 'utf8');
  // 浏览器不需要 XML 声明与 DOCTYPE
  svg = svg.replace(/<\?xml[^>]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/g, '');
  // 原来写的是 100%，在固定尺寸窗口里会按 viewBox 撑满，直接给定像素更稳
  svg = svg.replace(/width="100%"/, `width="${SIZE}"`).replace(/height="100%"/, `height="${SIZE}"`);

  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden}svg{display:block}</style>
</head><body>${svg}</body></html>`;

  const tmpHtml = path.join(__dirname, '..', '.tmp', 'icon-render.html');
  fs.mkdirSync(path.dirname(tmpHtml), { recursive: true });
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    webPreferences: { offscreen: false },
  });

  await win.loadFile(tmpHtml);
  // 等一帧，确保 SVG 里的路径已经画完
  await new Promise((r) => setTimeout(r, 700));

  const img = await win.webContents.capturePage();
  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'icon.png');
  fs.writeFileSync(out, img.toPNG());

  const { width, height } = img.getSize();
  console.log(`icon.png ${width}x${height} -> ${out}`);
  if (width < 256) console.error('⚠️ 尺寸不足 256，electron-builder 会拒绝');
  app.exit(0);
});
