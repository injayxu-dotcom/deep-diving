import type { RefPage, ReferenceFile } from '../types';
import { compressImage } from './color';

/**
 * 参考资料解析。
 *
 * pdfjs 与 jszip 都用动态导入，只在用户真的上传了对应格式时才加载，
 * 避免把几百 KB 打进首屏包（实测 pdf worker 1.3MB，独立 chunk）。
 *
 * F7（图片化提取）：设计稿里文字常被转曲成矢量路径或整页做成图片，
 * 文本层读不到。做法不是前端 OCR（中文包 15MB、艺术字效果差），
 * 而是把页面渲染成图 / 抠出内嵌大图，随文本一并交给视觉模型——
 * 项目里 runVision 已有多模态通道，零新增重型依赖。
 */

const MAX_TEXT = 12000;
const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * 自动升级阈值（PRD 7.3）：文本量 < 页数 × 50 字判定为图片为主。
 * 一页正文的文本层通常有几百字；转曲页/扫描页只有个位数到十几字。
 */
export const DEEP_TEXT_PER_PAGE = 50;
/** 图片页上限。再多 token 成本失控，也超出视觉模型的有效注意力 */
export const MAX_PAGES = 10;
/** 渲染参数：长边 1280 / 0.72。再高 localStorage 会爆（5MB 配额），再低小字辨认不清 */
const PAGE_MAX = 1280;
const PAGE_QUALITY = 0.72;
/** PPTX 内嵌图小于这个字节数的基本是项目符号、logo 小图标，没有阅读价值 */
const MEDIA_MIN_BYTES = 30 * 1024;

export function detectKind(file: File): ReferenceFile['kind'] {
  const n = file.name.toLowerCase();
  if (file.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.pptx')) return 'pptx';
  if (n.endsWith('.ppt')) return 'other';
  if (/^image\//i.test(file.type)) return 'image';
  // Markdown 时代的文档大半是 .md——原文直读比任何解析都可靠。
  // 顺带把 csv/json 这类纯文本数据也收进来，反正是同一个通道
  if (/\.(md|markdown|mdown|txt|csv|tsv|json|jsonl|html?|rtf|docx|xlsx|odt|odp|ods)$/.test(n)) return 'text';
  if (/^text\//i.test(file.type) || file.type === 'application/json') return 'text';
  return 'other';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 文本层是否稀薄到需要图片通道 */
export function needsImageChannel(textLen: number, pageCount: number): boolean {
  return pageCount > 0 && textLen < pageCount * DEEP_TEXT_PER_PAGE;
}

/**
 * 启发式判断模型名是否支持视觉输入。只用于**提前提示**，不做硬拦截：
 * 误放行有 catch 里的换模型指引兜底，误拦截会把不按命名惯例的视觉模型挡在门外。
 * 注意不能匹配裸的 `-v`——deepseek-v3 会被误伤。
 */
export function looksLikeVisionModel(model: string): boolean {
  return /vl|vision|4o|omni|gemini|claude|glm-4v|gpt-4\.1|gpt-5|doubao.*vision|kimi-latest/i.test(model);
}

export function stub(file: File, kind: ReferenceFile['kind']): ReferenceFile {
  return {
    id: `f-${uid()}`,
    name: file.name,
    kind,
    size: file.size,
    status: 'parsing',
  };
}

/** 图片：转成 base64，交给多模态模型读 */
async function readImage(file: File): Promise<{ dataUrl: string }> {
  const { dataUrl } = await compressImage(file, 1400, 0.8);
  return { dataUrl };
}

/** 把任意 Blob 压成长边 PAGE_MAX 的 JPEG dataURL（canvas 手工缩放） */
async function compressBlob(blob: Blob, label: string): Promise<RefPage> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片解码失败'));
      im.src = url;
    });
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const scale = Math.min(1, PAGE_MAX / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 上下文');
    ctx.fillStyle = '#fff'; // 透明背景的 PNG 转 JPEG 会变黑底，先垫白
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { dataUrl: cv.toDataURL('image/jpeg', PAGE_QUALITY), label };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface ParseResult {
  text?: string;
  dataUrl?: string;
  pages?: RefPage[];
  autoUpgraded?: boolean;
}

/** PDF：pdfjs 逐页抽取文本；文本层稀薄时把页面渲染成图 */
async function readPdf(file: File, forcePages = false): Promise<ParseResult> {
  const pdfjs = await import('pdfjs-dist');
  // worker 走本地文件，避免依赖 CDN
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const parts: string[] = [];
  const maxPages = Math.min(doc.numPages, 30);

  const pageTexts: string[] = [];
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const txt = tc.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pageTexts.push(txt);
    if (txt) parts.push(`[第 ${i} 页] ${txt}`);
    if (parts.join('\n').length > MAX_TEXT) break;
  }

  const text = parts.join('\n').slice(0, MAX_TEXT);
  const textLen = pageTexts.join('').length;

  // 文本层够厚且未强制深度时直接返回，不付渲染成本（验收：纯文本 PDF 仍走快速通道）
  if (!forcePages && !needsImageChannel(textLen, doc.numPages)) {
    await doc.destroy();
    return { text: text || '（未能提取到文本，可能是扫描件）' };
  }

  // 图片型：渲染前 MAX_PAGES 页。渲染完才销毁 doc，页面对象依赖它
  const pages: RefPage[] = [];
  try {
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      // viewport 初值是 1.0 倍（72dpi），scale 按长边 PAGE_MAX 反推，封顶 2 倍防超大页
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, PAGE_MAX / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const cv = document.createElement('canvas');
      cv.width = Math.round(viewport.width);
      cv.height = Math.round(viewport.height);
      const ctx = cv.getContext('2d');
      if (!ctx) break;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      pages.push({ dataUrl: cv.toDataURL('image/jpeg', PAGE_QUALITY), label: `第 ${i} 页` });
    }
  } finally {
    await doc.destroy();
  }
  return { text: text || '（文本层为空，内容以图片为主）', pages, autoUpgraded: pages.length > 0 };
}

/**
 * PPTX：本质是 zip。文本从 slide XML 抠 <a:t>；图片层抠 ppt/media/*。
 * 转曲文字在 XML 里是 <a:custGeom> 路径，文本层读不到——这正是 F7 要补的洞。
 */
async function readPptx(file: File, forcePages = false): Promise<ParseResult> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/i)?.[1] ?? '0', 10);
      const nb = parseInt(b.match(/slide(\d+)/i)?.[1] ?? '0', 10);
      return na - nb;
    });

  const parts: string[] = [];
  for (const n of names) {
    const xml = await zip.files[n].async('string');
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1].trim()).filter(Boolean);
    if (texts.length) parts.push(`[第 ${parts.length + 1} 页] ${texts.join(' ')}`);
    if (parts.join('\n').length > MAX_TEXT) break;
  }

  const text = parts.join('\n').slice(0, MAX_TEXT);

  // PPTX 的「页数」就是 slide 数；转曲页的文本层同样会薄
  const pageCount = names.length;
  const textLen = text.replace(/\[第 \d+ 页\] /g, '').length;
  if (!forcePages && !needsImageChannel(textLen, pageCount)) {
    return { text: text || '（未提取到文字）' };
  }

  // 内嵌媒体：只留 png/jpeg/webp/gif 且 >30KB 的（小图标无阅读价值）。
  // emf/wmf 是 Windows 图元文件，浏览器不解码，直接跳过。
  const media = Object.keys(zip.files)
    .filter((n) => /^ppt\/media\/.+\.(png|jpe?g|webp|gif)$/i.test(n))
    .filter((n) => {
      const f = zip.files[n];
      const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      return size >= MEDIA_MIN_BYTES;
    })
    .slice(0, MAX_PAGES);

  const pages: RefPage[] = [];
  for (const n of media) {
    try {
      const blob = await zip.files[n].async('blob');
      pages.push(await compressBlob(blob, `内嵌图 ${pages.length + 1}`));
    } catch {
      // 单张图解不出来不影响整体，跳过
    }
  }
  return { text: text || '（文本层为空，内容以图片为主）', pages, autoUpgraded: pages.length > 0 };
}

/**
 * Markdown / 纯文本：原文直读。
 *
 * 不做任何「清洗」——标题层级、列表、代码块本身就是结构信息，
 * 砍掉只会让模型更难理解文档。只处理两件事：换行符统一、超长截断。
 */
async function readText(file: File): Promise<ParseResult> {
  const raw = await file.text();
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new Error('文件内容是空的');
  const truncated =
    text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n\n…（原文过长，超出部分已截断）' : text;
  return { text: truncated };
}


function clip(text: string): ParseResult {
  const t = text.trim();
  if (!t) throw new Error('没有提取到文字');
  return { text: t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '\n\n…（原文过长，超出部分已截断）' : t };
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Word / Excel / OpenDocument：都是 zip + XML，复用 jszip，不新增依赖 */
async function readOffice(file: File): Promise<ParseResult> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const n = file.name.toLowerCase();

  if (n.endsWith('.docx')) {
    const xml = await zip.files['word/document.xml']?.async('string');
    if (!xml) throw new Error('不是有效的 Word 文件');
    const paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) =>
      [...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((x) => decodeXml(x[1])).join(''),
    );
    return clip(paras.filter((s) => s.trim()).join('\n'));
  }

  if (n.endsWith('.xlsx')) {
    const sst = await zip.files['xl/sharedStrings.xml']?.async('string');
    const shared = sst
      ? [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
          [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join(''),
        )
      : [];
    const sheets = Object.keys(zip.files)
      .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(f))
      .sort();
    const out: string[] = [];
    for (const [i, f] of sheets.entries()) {
      const xml = await zip.files[f].async('string');
      const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...r[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map((c) => {
            const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? c[2]?.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
            return /t="s"/.test(c[1]) ? (shared[Number(v)] ?? '') : decodeXml(v);
          })
          .join('\t'),
      );
      out.push(`[工作表 ${i + 1}]\n${rows.filter((r) => r.trim()).join('\n')}`);
      if (out.join('\n').length > MAX_TEXT) break;
    }
    return clip(out.join('\n\n'));
  }

  // odt / odp / ods
  const xml = await zip.files['content.xml']?.async('string');
  if (!xml) throw new Error('不是有效的 OpenDocument 文件');
  return clip(decodeXml(xml.replace(/<\/text:(p|h)>|<\/table:table-row>/g, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' '));
}

async function readHtml(file: File): Promise<ParseResult> {
  const raw = await file.text();
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach((e) => e.remove());
  return clip((doc.body?.innerText || doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n'));
}

async function readRtf(file: File): Promise<ParseResult> {
  const raw = await file.text();
  const text = raw
    .replace(/\\u(-?\d+)\??/g, (_, c) => String.fromCharCode(Number(c) < 0 ? Number(c) + 65536 : Number(c)))
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\'[0-9a-f]{2}/gi, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '');
  return clip(text);
}
/**
 * 解析一个文件。
 * @param forcePages 手动「改用深度解析」时为 true：跳过文本量阈值，
 *   图片层照常提取（自动判定只在首次上传时跑，手动覆盖是用户的显式决定）
 */
export async function parseFile(file: File, forcePages = false): Promise<ParseResult> {
  const kind = detectKind(file);
  if (kind === 'image') return readImage(file);
  if (kind === 'pdf') return readPdf(file, forcePages);
  if (kind === 'pptx') return readPptx(file, forcePages);
  if (kind === 'text') {
    const n = file.name.toLowerCase();
    if (/\.(docx|xlsx|odt|odp|ods)$/.test(n)) return readOffice(file);
    if (/\.html?$/.test(n)) return readHtml(file);
    if (n.endsWith('.rtf')) return readRtf(file);
    return readText(file);
  }
  throw new Error('暂不支持该格式');
}

/** 把已解析的资料压成一段给 LLM 看的上下文 */
export function buildReferenceContext(files: ReferenceFile[]): string {
  const chunks: string[] = [];
  for (const f of files) {
    if (f.status !== 'done') continue;
    if (f.kind === 'image') continue; // 图片走多模态通道，不塞进文本
    if (!f.text) continue;
    const imgNote =
      f.parseMode === 'deep' && f.pages?.length
        ? `（另有 ${f.pages.length} 页内容以图片附在本条消息里：${f.pages.map((p) => p.label).join('、')}。请补充图中可见但文本层缺失的文字与版面信息）`
        : '';
    chunks.push(`【${f.name}】${imgNote}\n${f.text}`);
  }
  if (!chunks.length) return '';
  return `以下是用户提供的参考资料原文：\n\n${chunks.join('\n\n')}\n\n`;
}

export const KIND_LABEL: Record<ReferenceFile['kind'], string> = {
  pdf: 'PDF',
  pptx: 'PPTX',
  image: '图片',
  text: '文本',
  other: '其他',
};
