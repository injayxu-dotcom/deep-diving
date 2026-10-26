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

  const shot = await win.webContents.capturePage();
  // 高 DPI 下 capturePage 会返回 1.25 倍尺寸，缩回目标边长
  const big = shot.getSize().width === SIZE ? shot : shot.resize({ width: SIZE, height: SIZE, quality: 'best' });
  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, 'icon.png'), big.toPNG());

  /* 再出一份 256 和 .ico：
     - ICO 的宽高字段各只有 1 字节（0 代表 256），所以 256 就是上限
     - 本地打包时 electron-builder 走不了 rcedit（普通账户建不了符号链接），
       需要自己用 rcedit 写图标，而 rcedit 只吃 .ico */
  const small = big.resize({ width: 256, height: 256, quality: 'best' });
  const smallPng = small.toPNG();
  fs.writeFileSync(path.join(outDir, 'icon-256.png'), smallPng);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), pngToIco(smallPng));

  const { width, height } = big.getSize();
  console.log(`icon.png ${width}x${height} / icon-256.png 256x256 / icon.ico 已生成`);
  if (width < 256) console.error('⚠️ 尺寸不足 256，electron-builder 会拒绝');
  app.exit(0);
});

/** 把 PNG 包成单帧 ICO（Vista 起支持 PNG 压缩的图标） */
function pngToIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(1, 4); // 帧数

  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);      // width  256（0 表示 256）
  entry.writeUInt8(0, 1);      // height 256
  entry.writeUInt8(0, 2);      // 调色板数
  entry.writeUInt8(0, 3);      // reserved
  entry.writeUInt16LE(1, 4);   // color planes
  entry.writeUInt16LE(32, 6);  // 位深
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // 数据起点 = 6 + 16

  return Buffer.concat([header, entry, png]);
}
