/**
 * 本地色卡提取。
 * 纯 canvas 计算，不调用任何 AI —— 取色是确定性任务，没必要花 token。
 */

export interface Swatch {
  hex: string;
  /** 该色在图中的像素占比，0-1 */
  ratio: number;
}

const BUCKET_BITS = 5; // 每通道 32 级

function toHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/** YIQ 亮度，用于决定色块上叠什么颜色的文字 */
export function isLight(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 >= 150;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/**
 * 从图片提取主色。
 *
 * 做法：缩到 120px 采样 → 按 5bit/通道分桶计数 → 按占比降序 →
 * 合并色距过近的桶 → 输出前 n 个。
 */
export async function extractPalette(src: string, maxCount = 6): Promise<Swatch[]> {
  const img = await loadImage(src);
  const SAMPLE = 120;
  const scale = Math.min(1, SAMPLE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 上下文');
  ctx.drawImage(img, 0, 0, w, h);

  const { data } = ctx.getImageData(0, 0, w, h);
  const total = w * h;

  interface Bin {
    r: number;
    g: number;
    b: number;
    n: number;
  }
  const bins = new Map<number, Bin>();

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 125) continue; // 跳过透明像素
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key =
      ((r >> (8 - BUCKET_BITS)) << (BUCKET_BITS * 2)) |
      ((g >> (8 - BUCKET_BITS)) << BUCKET_BITS) |
      (b >> (8 - BUCKET_BITS));
    const bin = bins.get(key);
    if (bin) {
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bin.n++;
    } else {
      bins.set(key, { r, g, b, n: 1 });
    }
  }

  const sorted = [...bins.values()].sort((a, b) => b.n - a.n);
  const picked: Swatch[] = [];
  // 合并阈值：距离小于此值视为同一个色，避免输出六个深浅不同的蓝
  const MERGE = 46;

  for (const bin of sorted) {
    const avgR = bin.r / bin.n;
    const avgG = bin.g / bin.n;
    const avgB = bin.b / bin.n;
    const near = picked.some((p) => {
      const n = parseInt(p.hex.slice(1), 16);
      const pr = (n >> 16) & 255;
      const pg = (n >> 8) & 255;
      const pb = n & 255;
      return Math.hypot(pr - avgR, pg - avgG, pb - avgB) < MERGE;
    });
    if (near) continue;
    picked.push({ hex: toHex(avgR, avgG, avgB), ratio: bin.n / total });
    if (picked.length >= maxCount) break;
  }

  return picked;
}

/** 图片压缩：等比缩到 maxW，转 JPEG */
export function compressImage(file: File, maxW = 1000, quality = 0.75): Promise<{ dataUrl: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('不是有效的图片文件'));
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxW) {
          h = Math.round((h * maxW) / w);
          w = maxW;
        }
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d');
        if (!ctx) return reject(new Error('无法创建 canvas 上下文'));
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: cv.toDataURL('image/jpeg', quality), w, h });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
