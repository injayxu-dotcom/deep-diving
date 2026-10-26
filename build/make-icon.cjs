/**
 * 从 DD logo.svg 生成应用图标：build/icon.png（512）+ 多尺寸 icon.ico。
 *
 * 不引 sharp / rsvg 之类：Electron 自己就是一个完整的渲染器，
 * 用它转一次省一个依赖，也省得在 Windows 上折腾原生模块编译。
 *
 * 跑法：`npm run icon`
 * （内部要清掉 ELECTRON_RUN_AS_NODE，否则 Electron 退化成纯 Node 直接报错）
 *
 * ⚠️ 为什么是「多尺寸 + 经典 BMP 帧」而不是「单帧 PNG 压缩」：
 * 之前只有一个 256 的 PNG 帧，rcedit 写进 exe 后 Windows 显示的还是 Electron 默认图标 ——
 * PNG 压缩帧要 Vista 以上才认，且 rcedit / 部分资源工具处理不好。
 * 桌面 48px、任务栏 32px、标题栏 16px 各取一帧才是 Windows 的常规做法。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const MASTER = 512; // 主渲染尺寸，其余尺寸由它等比缩放
const FRAMES = [16, 24, 32, 48, 64, 128, 256]; // ICO 内含的尺寸（256 是规范上限）

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svgPath = path.join(__dirname, '..', 'DD logo.svg');
  let svg = fs.readFileSync(svgPath, 'utf8');
  svg = svg.replace(/<\?xml[^>]*\?>/g, '').replace(/<!DOCTYPE[^>]*>/g, '');
  svg = svg
    .replace(/width="100%"/, `width="${MASTER}"`)
    .replace(/height="100%"/, `height="${MASTER}"`);

  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:${MASTER}px;height:${MASTER}px;overflow:hidden;background:transparent}svg{display:block}</style>
</head><body>${svg}</body></html>`;

  const tmpHtml = path.join(__dirname, '..', '.tmp', 'icon-render.html');
  fs.mkdirSync(path.dirname(tmpHtml), { recursive: true });
  fs.writeFileSync(tmpHtml, html, 'utf8');

  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false },
  });

  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 700)); // 等 SVG 画完

  const shot = await win.webContents.capturePage();
  const master =
    shot.getSize().width === MASTER
      ? shot
      : shot.resize({ width: MASTER, height: MASTER, quality: 'best' });

  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, 'icon.png'), master.toPNG());

  // 逐尺寸缩放，每帧都存成经典 32bpp BMP
  const frames = FRAMES.map((size) => ({
    size,
    bgra: master.resize({ width: size, height: size, quality: 'best' }).toBitmap(),
  }));

  fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(frames));
  fs.writeFileSync(
    path.join(outDir, 'icon-256.png'),
    master.resize({ width: 256, height: 256, quality: 'best' }).toPNG(),
  );

  // 顺手留一张小尺寸预览，方便肉眼确认 32px 下还认不认得出
  fs.writeFileSync(
    path.join(outDir, 'icon-32-preview.png'),
    master.resize({ width: 32, height: 32, quality: 'best' }).toPNG(),
  );

  const { width, height } = master.getSize();
  console.log(
    `icon.png ${width}x${height} / icon.ico (${FRAMES.join(', ')}) / icon-256.png / icon-32-preview.png`,
  );
  app.exit(0);
});

/**
 * 组一个多帧 ICO。
 * 每帧 = BITMAPINFOHEADER(40) + XOR 位图（BGRA，自下而上）+ AND 掩码（1bpp）。
 * 32bpp 下透明度由 alpha 通道表达，AND 掩码全 0 即可。
 */
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(frames.length, 4);

  const entries = [];
  const blobs = [];
  let offset = 6 + 16 * frames.length;

  for (const { size, bgra } of frames) {
    const xor = bgraToRows(bgra, size);
    const andStride = Math.ceil(size / 32) * 4; // 1bpp，行按 4 字节对齐
    const and = Buffer.alloc(andStride * size); // 全 0 = 全部不透明（真正的透明看 alpha）

    const dib = Buffer.alloc(40);
    dib.writeUInt32LE(40, 0); // biSize
    dib.writeInt32LE(size, 4); // biWidth
    dib.writeInt32LE(size * 2, 8); // biHeight = XOR + AND 两份
    dib.writeUInt16LE(1, 12); // biPlanes
    dib.writeUInt16LE(32, 14); // biBitCount
    dib.writeUInt32LE(0, 16); // biCompression = BI_RGB
    dib.writeUInt32LE(xor.length + and.length, 20); // biSizeImage

    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 256 在 1 字节里写 0
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // 调色板数
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // 位深
    entry.writeUInt32LE(40 + xor.length + and.length, 8);
    entry.writeUInt32LE(offset, 12);

    entries.push(entry);
    blobs.push(Buffer.concat([dib, xor, and]));
    offset += 40 + xor.length + and.length;
  }

  return Buffer.concat([header, ...entries, ...blobs]);
}

/** nativeImage.toBitmap() 是自上而下的 BGRA，BMP 要求自下而上逐行 */
function bgraToRows(bgra, size) {
  const stride = size * 4;
  const out = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * stride;
    bgra.copy(out, y * stride, src, src + stride);
  }
  return out;
}
