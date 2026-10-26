import { chromium } from 'playwright';
import JSZip from 'jszip';
import { clickFloat, openMore } from './lib/dd-fixture.mjs';

/* 端口跟随夹具的约定：M3 取证脚本统一用 5199（--strictPort），
   覆盖 Vite 默认的 5173 —— 否则换个端口起 dev 就会全部连不上。 */
const URL = process.env.DD_URL || 'http://127.0.0.1:5199/';
const errs = [];
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m) => { console.log('  FAIL  ' + m); errs.push(m); };

/** 构造一个 pdfjs 能解析的最小合法 PDF */
function makePdf(text) {
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
  ];
  const content = `BT /F1 16 Tf 20 100 Td (${text}) Tj ET`;
  objs.push(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  objs.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** 构造一个最小 pptx（本质是 zip，含 slide1.xml） */
async function makePptx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/slides/slide1.xml',
    '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>竞品视觉调研 2026</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

/* ⚠️ --no-proxy-server：与 dd-fixture 保持一致。
   本机系统代理会拦截 127.0.0.1 的请求（服务没起时 curl 拿到的是代理的 502，
   不是连接拒绝），不带这个 flag 时浏览器走代理，页面整个加载失败。 */
const browser = await chromium.launch({ args: ['--no-proxy-server'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
/* ⚠️ 已知的云端 403 降级为告警，不算 e2e 失败：
   `.env.local` 配了 VITE_API_BASE（CloudBase HTTP 访问服务），应用启动即开启
   云端同步，e2e 注入的 settings 不带 cloudToken —— 网关按设计返 403，
   src/lib/cloudApi.ts:131 就是为这个场景写的可读报错，cloudLoad catch 后
   console.warn 并回退本地（55 项断言全过即是证据）。这是本地环境缺令牌的
   既有状态，与 UI 改版无关；但浏览器会把这条网络失败也记进 console
   （文本只有 "Failed to load resource … 403"，URL 在 m.location() 里），
   无差别收进 errs 会让 e2e 永远 exit 1。其余 console 错误照旧硬失败。 */
const KNOWN_CLOUD_403 = /\/deepdiving-api\/(ws|ai\/chat)/i;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const loc = m.location() || {};
  const t = m.text().slice(0, 160);
  if (/403/.test(t) && loc.url && KNOWN_CLOUD_403.test(loc.url)) {
    console.log('  WARN  ' + t + '（已知：本地无云端令牌，同步按设计回退本地）');
    return;
  }
  errs.push('CONSOLE: ' + t);
});

// 只在首次注入初始状态；reload 时必须保留应用自己写入的数据
const DD_LLM_BASE = process.env.DD_LLM_BASE;
const DD_LLM_KEY = process.env.DD_LLM_KEY;
const DD_LLM_MODEL = process.env.DD_LLM_MODEL;
if (DD_LLM_KEY) {
  console.log(`  ⚙️ 真实 LLM 模式：${DD_LLM_BASE} · ${DD_LLM_MODEL}（Key 不回显）`);
} else {
  console.log('  ⚙️ mock 模式（设 DD_LLM_KEY 可切到真实模型）');
}

/* ⚠️ addInitScript 的函数会被**序列化**后送进浏览器执行，闭包里的 Node 变量
   全部丢失（DD_LLM_BASE 在浏览器里是未定义标识符，整个脚本会当场抛
   ReferenceError，localStorage 一个键都写不进去 —— 应用退回全新状态，
   16 组断言全挂在"画布未渲染"上）。要传的值必须走第二个参数。 */
await page.addInitScript((llm) => {
  if (localStorage.getItem('deepdiving.v1')) return;
  localStorage.setItem('deepdiving.v1', JSON.stringify({
    brief: '目标人群 25-34 岁独居青年，追求刺激与独特性。使用场景：深夜手机下单。',
    product: '辣椒酱品牌升级',
    mood: '',
    references: [], report: null, nodes: [], edges: [], intel: [],
    /* ⚠️ 默认走 mock（零成本、可重复）。要**真跑一遍 LLM**就把环境变量设上：
         DD_LLM_BASE=https://api.deepseek.com
         DD_LLM_KEY=sk-xxxx
         DD_LLM_MODEL=deepseek-chat
       剩下的 17 组断言一个字都不用改 —— 它们本来就是在验真实交互。 */
    settings: {
      baseUrl: llm.base || 'http://localhost:8788',
      apiKey: llm.key || 'mock-key',
      model: llm.model || 'mock',
      temperature: 0.9,
    },
  }));
}, { base: DD_LLM_BASE, key: DD_LLM_KEY, model: DD_LLM_MODEL });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

console.log('\n[1] 首屏与画布');
// 示例种子是旧版行为，早已移除——空工作区就是干净的画布 + 引导
const seeds0 = await page.locator('.nd-seed').count();
seeds0 === 0 ? ok('空工作区：画布上无种子（示例种子已随旧版移除）') : bad('种子数 ' + seeds0);
(await page.locator('.react-flow').isVisible()) ? ok('画布已渲染') : bad('画布未渲染');
/* ⚠️ 第 7 步起 MiniMap 在 **0 节点时不渲染** —— 那个只剩边框和遮罩的白盒子
   在空画布上看着像渲染坏了。上一行刚断言「种子数 = 0」，所以这里必须断言"没有"，
   否则两条断言互相矛盾（旧版本这两条是一起写的，当时 minimap 无条件渲染）。
   有节点时照常渲染，由回归探针双向验证（空态无 / 有态 18 个色块）。 */
(await page.locator('.react-flow__minimap').count()) === 0
  ? ok('空画布不渲染缩略图（0 节点时的白盒子已隐藏）')
  : bad('0 节点仍渲染缩略图');

console.log('\n[2] 画布缩放与平移');
// 空工作区首次进画布会弹引导（guideDismissed 未注入），先关掉再测交互
if ((await page.locator('.modal-guide').count()) > 0) {
  await page.click('.modal-guide .icon-btn').catch(() => {});
  await page.waitForTimeout(400);
}
const vp = () => page.locator('.react-flow__viewport').getAttribute('style');
const v0 = await vp();
await page.click('.react-flow__controls-zoomin');
await page.waitForTimeout(400);
const v1 = await vp();
v0 !== v1 ? ok('缩放按钮生效') : bad('缩放无效');
// 空画布中央会浮着「输入一个词开始」卡片（pointer-events:auto），会吃掉滚轮；
// 交互测试移到画布角落，且拖拽平移用的是中键（左键被 selectionOnDrag 占用做框选）
const cw = await page.locator('.canvas-wrap').boundingBox();
await page.mouse.move(cw.x + 60, cw.y + 60);
await page.mouse.wheel(0, -500);
await page.waitForTimeout(350);
const v2 = await vp();
v2 !== v1 ? ok('滚轮缩放生效') : bad('滚轮缩放无效');
await page.mouse.move(cw.x + cw.width - 100, cw.y + 90);
await page.mouse.down({ button: 'middle' });
await page.mouse.move(cw.x + cw.width - 260, cw.y + 200, { steps: 10 });
await page.mouse.up({ button: 'middle' });
await page.waitForTimeout(300);
const v3 = await vp();
v3 !== v2 ? ok('拖拽平移生效') : bad('拖拽平移无效');

console.log('\n[3] 深潜：简报 + 情报卡上画布 + 自动种子词');
await page.fill('input[placeholder*="辣椒酱"]', '辣椒酱品牌升级');
/* 「补充方向」自第 9 步起收进折叠组、默认收起 —— 里面的输入框填不到，
   要先点 summary 展开（fold-open 视图验的就是这条路径）。 */
if ((await page.locator('.fold summary.fold-sum').count()) > 0
    && !(await page.locator('.fold[open]').count())) {
  await page.click('.fold summary.fold-sum');
  await page.waitForTimeout(250);
}
await page.fill('input[placeholder*="危险感"]', '危险感、冷冽、解压');
await page.click('button:has-text("开始深潜")');
await page.waitForTimeout(2600);

const intelNodes = await page.locator('.nd-intel').count();
intelNodes === 3 ? ok('3 张情报卡钉在画布上') : bad('情报卡节点 ' + intelNodes);
const seedNodes = await page.locator('.nd-seed').count();
seedNodes === 4 ? ok('画布共 4 颗种子（简报自动提取，不再预种示例）') : bad('种子数 ' + seedNodes);
const cardPts = await page.locator('.nd-intel .intel-pts li').count();
cardPts >= 8 ? ok('情报卡节点带 ' + cardPts + ' 条内容') : bad('卡片内容 ' + cardPts);

console.log('\n[4] 调研洞察抽屉：行业现状 / 竞品 / 视觉 / SWOT');
// 本轮改动：深潜完成后不再自动弹抽屉（刚跑完最想看画布），改为顶栏手动打开
const drawerOpen = (await page.locator('.drawer').count()) === 0;
drawerOpen ? ok('深潜完成后不自动弹调研抽屉') : bad('抽屉仍自动弹出（应已移除）');
/* 批次 1：「调研洞察」从阶段指示器挪回顶栏动作区（`.topbar-actions [data-act="insights"]`）——
   导航三段现在只回答"我在哪、能回哪"（需求澄清 / 项目简报 / 发散画布），
   内容入口归动作区。同时它改了名：原「深潜简报」与用户自写的「项目简报」撞名。 */
await page.click('.topbar-actions [data-act="insights"]');
await page.waitForSelector('.drawer', { timeout: 8000 });
ok('顶栏「调研洞察」可打开抽屉');
const industry = await page.locator('.rep-sec:has-text("行业现状") .rep-body').textContent();
industry.length > 80 ? ok('行业现状 ' + industry.length + ' 字：' + industry.slice(0, 40) + '…') : bad('行业现状过短');
const cmpCards = await page.locator('.cmp-card').count();
cmpCards >= 3 ? ok('竞品详情 ' + cmpCards + ' 家') : bad('竞品 ' + cmpCards);
const cmpName = await page.locator('.cmp-name').first().textContent();
ok('首个竞品：' + cmpName);
const visCells = await page.locator('.vis-cell').count();
visCells === 3 ? ok('视觉元素 3 项（颜色 / 色调 / 字体）') : bad('视觉元素 ' + visCells);
const swotCells = await page.locator('.swot-cell').count();
swotCells === 4 ? ok('SWOT 四象限已渲染') : bad('SWOT 象限 ' + swotCells);
const swotItems = await page.locator('.swot-l li').count();
swotItems >= 8 ? ok('SWOT 共 ' + swotItems + ' 条内容') : bad('SWOT 条目 ' + swotItems);
const colors = await page.locator('.vis-cell:has-text("颜色") .vis-v').textContent();
colors.includes('#') ? ok('颜色给出具体色值：' + colors.slice(0, 44) + '…') : bad('颜色过于笼统');
await page.click('button:has-text("回到画布")');
await page.waitForTimeout(400);

console.log('\n[5] 种子词来源可追溯（来自简报而非用户输入）');
await clickFloat(page, 'fit');
await page.waitForTimeout(700);
const seedLabels = await page.locator('.nd-seed .nd-label').allTextContents();
ok('画布种子：' + seedLabels.join(' / '));
// 第 1 颗是用户自己的项目起始种子（= 项目名），不算 AI 提取结果，剔除后再校验
const aiSeeds = seedLabels.filter((s) => s.trim() !== '辣椒酱品牌升级');
aiSeeds.length >= 3 && aiSeeds.length <= 4
  ? ok('AI 从简报提取 ' + aiSeeds.length + ' 个种子词') : bad('种子词数量 ' + aiSeeds.length);
const banned = ['辣椒酱品牌升级', '辣椒酱', '品牌升级', '危险感', '冷冽', '解压', '热情', '活力'];
const echo = aiSeeds.filter((s) => banned.includes(s.trim()));
echo.length === 0 ? ok('种子词不是用户原始输入的复述') : bad('种子词仍在复述用户输入：' + echo.join());
const srcs = await page.locator('.nd-seed .nd-src-t').allTextContents();
srcs.length === aiSeeds.length
  ? ok('每个种子词都标了简报来源：' + srcs.join(' / ')) : bad('来源标签 ' + srcs.length + ' 个');

console.log('\n[6] 六维裂变轮盘');
// 直接点最长的那颗种子，最容易触发中心文字挤压布局的问题
await page.locator('.nd-seed:has-text("灼烧后的麻木感")').first().dblclick();
await page.waitForTimeout(400);
const wheelItems = await page.locator('.wheel-item').count();
wheelItems === 6 ? ok('轮盘展开 6 个维度') : bad('轮盘维度 ' + wheelItems);
// 回归：绝对定位无宽度的中心块会被压成竖条，横穿轮盘挡住维度按钮
const geo = await page.evaluate(() => {
  // 用 offsetWidth 取未缩放的 CSS 尺寸，避免被当前 zoom 干扰阈值判断
  const ce = document.querySelector('.wheel-center');
  const c = ce.getBoundingClientRect();
  const items = [...document.querySelectorAll('.wheel-item')].map((el) => el.getBoundingClientRect());
  const overlap = items.filter((r) => !(r.right < c.left || r.left > c.right || r.bottom < c.top || r.top > c.bottom));
  return { w: ce.offsetWidth, h: ce.offsetHeight, n: overlap.length };
});
geo.n === 0 && geo.w >= 100
  ? ok(`轮盘中心 ${geo.w}×${geo.h}，不遮挡任何维度按钮`)
  : bad(`轮盘中心 ${geo.w}×${geo.h} 遮挡了 ${geo.n} 个维度按钮`);
await page.locator('.wheel-item:has-text("视觉联想")').click();
await page.waitForTimeout(2000);
const words = await page.locator('.nd-word').count();
words >= 5 ? ok('AI 裂变出 ' + words + ' 个节点') : bad('裂变节点 ' + words);
const firstWord = await page.locator('.nd-word .nd-label').first().textContent();
ok('首个裂变词：' + firstWord);

console.log('\n[7] 跨枝连接 → AI 判定关系');
await clickFloat(page, 'fit');
await page.waitForTimeout(700);
const e0 = await page.locator('.react-flow__edge').count();
const sh = await page.locator('.nd-word').nth(0).locator('.react-flow__handle.source').boundingBox();
const th = await page.locator('.nd-word').nth(2).locator('.react-flow__handle.target').boundingBox();
if (sh && th) {
  await page.mouse.move(sh.x + sh.width / 2, sh.y + sh.height / 2);
  await page.mouse.down();
  await page.mouse.move(th.x + th.width / 2, th.y + th.height / 2, { steps: 20 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(2200);
  const e1 = await page.locator('.react-flow__edge').count();
  e1 > e0 ? ok(`新建连线 ${e0} → ${e1}`) : bad(`连线未创建（${e0} → ${e1}）`);
  const labels = await page.locator('.react-flow__edge-textwrapper').allTextContents();
  labels.some((t) => ['共性', '对立', '递进'].includes(t.trim()))
    ? ok('AI 判定连接类型：' + labels.join('/')) : bad('无连接类型：' + JSON.stringify(labels));
} else bad('拿不到 handle 坐标');

console.log('\n[8] 创意概念简报 + 三套提示词');
await clickFloat(page, 'fit');
await page.waitForTimeout(700);
// 第二轮起右栏的「当前节点」操作区迁到了节点上；一键出方案 = 简报 → 评分‖提示词
await page.locator('.nd-word').first().click();
await page.waitForTimeout(300);
await page.click('.nact:has-text("一键出方案")');
// 出齐后自动展开详情，默认停在评分 tab（tab 顺序 = 评分在简报前）；
// mock 现在能回 V2 评分，所以先切到简报 tab 再数简报字段
await page.waitForSelector('.ndb-tab:has-text("简报")', { timeout: 20000 });
await page.click('.ndb-tab:has-text("简报")');
await page.waitForSelector('.nd-body .bblock', { timeout: 10000 });
await page.waitForTimeout(600);
const blocks = await page.locator('.bblock').count();
blocks >= 4 ? ok('简报输出 ' + blocks + ' 个字段') : bad('简报字段 ' + blocks);
const conceptN = await page.locator('.nd-concept').count();
conceptN >= 1 ? ok('节点转为概念形态') : bad('节点未转为概念');
await page.click('.ndb-tab:has-text("提示词")');
await page.waitForTimeout(800);
const pboxes = await page.locator('.pbox').count();
pboxes === 4 ? ok('输出 4 个提示词盒（3 通道 + 负向提示）') : bad('提示词 ' + pboxes);
const mj = await page.locator('.pbox:has-text("Midjourney") .pbox-x').textContent();
mj.includes('--ar') && mj.includes('--v') ? ok('MJ 含 --ar / --v') : bad('MJ 参数缺失');

console.log('\n[9] AI 评分与气泡图');
// 第 8 段的一键出方案已包含评分；评分详情在节点详情里（tab 在提示词旁）。
// 详情若已被收起（比如自动避让时误点到了别处），先重新选中并展开
if ((await page.locator('.nd-body').count()) === 0) {
  await page.locator('.nd-concept').first().click();
  await page.waitForTimeout(400);
  const badge = page.locator('.nd-concept').first().locator('.nd-detail');
  if (await badge.count()) {
    await badge.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}
console.log('[dbg] nd-body', await page.locator('.nd-body').count(), 'tabs', JSON.stringify(await page.locator('.ndb-tab').allTextContents()));
await page.click('.ndb-tab:has-text("评分")');
await page.waitForTimeout(600);
const scoreNum = await page.locator('.nd-body .value-num').textContent();
/\d/.test(scoreNum) ? ok('评分回显：' + scoreNum.trim()) : bad('无评分');
const crits = await page.locator('.nd-body .crit').count();
crits === 4 ? ok('4 条评分准则（权重 + 依据，可解释）') : bad('准则 ' + crits);
const hasKano = (await page.locator('.nd-body .kano').count()) === 1;
hasKano ? ok('KANO 校准区已渲染') : bad('KANO 缺失');
(await page.locator('.bubble circle').count()) >= 1 ? ok('右栏气泡图已渲染') : bad('气泡图为空');

console.log('\n[10] 参考资料上传：PDF / PPTX');
await page.locator('.panel-left input[type=file]').setInputFiles([
  { name: '行业报告.pdf', mimeType: 'application/pdf', buffer: makePdf('Spicy Sauce Brand Research 2026') },
  { name: '竞品调研.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: await makePptx() },
]);
await page.waitForTimeout(3500);
const refItems = await page.locator('.refitem').count();
refItems === 2 ? ok('2 份资料已挂载') : bad('资料 ' + refItems);
const refSubs = await page.locator('.ref-sub').allTextContents();
const pdfOk = refSubs.some((s) => s.includes('已提取') && /Brand Research/.test(s) === false);
const pdfChars = refSubs.find((s) => s.includes('已提取'));
pdfChars ? ok('PDF 提词：' + pdfChars) : bad('PDF 未提取文本');
const pptxChars = refSubs.filter((s) => s.includes('已提取'));
pptxChars.length === 2 ? ok('PPTX 也成功提取') : bad('PPTX 提取失败：' + JSON.stringify(refSubs));
const refErr = refSubs.some((s) => s.includes('不支持') || s.includes('失败'));
!refErr ? ok('无解析错误') : bad('存在解析错误：' + refSubs.join(' | '));

console.log('\n[11] 视觉资产层：图片拖入 + 本地取色');
await page.evaluate(() => {
  const cv = document.createElement('canvas');
  cv.width = 240; cv.height = 160;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#1B3A5C'; ctx.fillRect(0, 0, 240, 80);
  ctx.fillStyle = '#00B8C4'; ctx.fillRect(0, 80, 240, 80);
  return new Promise((res) => {
    cv.toBlob((b) => {
      const dt = new DataTransfer();
      dt.items.add(new File([b], '色卡测试.png', { type: 'image/png' }));
      const pane = document.querySelector('.react-flow__pane');
      const r = pane.getBoundingClientRect();
      pane.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, clientX: r.x + 300, clientY: r.y + 220, dataTransfer: dt,
      }));
      res(true);
    });
  });
});
await page.waitForTimeout(1600);
(await page.locator('.nd-image').count()) === 1 ? ok('图片拖入 → 建图节点') : bad('图节点未创建');
await page.locator('.nd-image').first().click();
await page.waitForTimeout(400);
// 本地取色不是自动跑的——点节点上的「提取色卡」，再展开详情到参考图 tab 看色卡列表
const pAct = page.locator('.nd-image .nact:has-text("提取色卡")');
if (await pAct.count()) await pAct.click();
await page.waitForTimeout(900);
await page.click('.nd-image .nd-detail').catch(() => {});
await page.waitForTimeout(500);
const astab = page.locator('.nd-image .ndb-tab:has-text("参考图")');
if (await astab.count()) await astab.click();
await page.waitForTimeout(300);
const swPanel = await page.locator('.nd-image .swatch').allTextContents();
const near = (hex, target) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [p(hex), p(target)];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 60;
};
swPanel.some((h) => near(h, '#1B3A5C')) && swPanel.some((h) => near(h, '#00B8C4'))
  ? ok('取色准确：' + swPanel.join(' ')) : bad('取色偏差：' + swPanel.join(' '));
await page.click('.nd-image .ndb-fold').catch(() => {}); // 收起详情，留给 [12] 干净状态

console.log('\n[12] P6-3 参考图四维分析（配色走本地，风格/构图/排版各走一次视觉调用）');
await page.locator('.nd-image').first().click();
await page.waitForTimeout(300);
// 四个按需动作必须同时在场——一次问一坨的旧「AI 读图」已经拆掉了
for (const dim of ['配色', '风格', '构图', '排版']) {
  (await page.locator(`.nd-image .nact:has-text("提取${dim}")`).count()) === 1
    ? ok(`图节点有「提取${dim}」动作`)
    : bad(`缺「提取${dim}」动作`);
}
await page.click('.nd-image .nact:has-text("提取风格")');
await page.waitForTimeout(2600);
const dimTag = (await page.locator('.nd-image .nd-dims').textContent().catch(() => '')).trim();
dimTag.includes('风格') ? ok('提取后卡面标出已提取的维度：' + dimTag) : bad('卡面维度标签缺失：' + dimTag);
// 展开详情 → 参考图 tab：四维分组 + 来源标注
if (await page.locator('.nd-image .nd-detail').count()) await page.click('.nd-image .nd-detail');
await page.waitForTimeout(500);
await page.click('.nd-image .ndb-tab:has-text("参考图")').catch(() => {});
await page.waitForTimeout(400);
const styleFrom = (await page.locator('.nd-image .vdim .vdim-from').first().textContent().catch(() => '')).trim();
['本地算法', '模型推断'].includes(styleFrom) ? ok('维度结果标了来源：' + styleFrom) : bad('来源标注缺失：' + styleFrom);
const styleText = (await page.locator('.nd-image .vdim-v').first().textContent().catch(() => '')).trim();
styleText.length > 8 ? ok('维度结论有内容：' + styleText.slice(0, 30) + '…') : bad('维度结论为空');
// 配色必须走本地（图不外传），所以它的来源标注只能是「本地算法」
await page.click('.nd-image .vdim-btn:has-text("提取配色")');
await page.waitForTimeout(900);
const palFrom = (await page.locator('.nd-image .vdim-from.local').first().textContent().catch(() => '')).trim();
palFrom === '本地算法' ? ok('配色维度来自本地算法（图片没有外传）') : bad('配色来源标注不是本地算法：' + palFrom);
await page.click('.nd-image .ndb-fold').catch(() => {});
await page.waitForTimeout(300);

console.log('\n[13] P2 闭环：图 → 概念关联 · 出图评价 · 重新深潜语义');
// 13.1 图节点右键 → 关联到概念（拖放是主路径，这里验菜单这条备用路径）
await page.locator('.nd-image').first().click({ button: 'right' });
await page.waitForTimeout(300);
await page.click('.ctx-i:has-text("关联到概念")');
await page.waitForTimeout(200);
const conceptOpts = await page.locator('.ctx-link .ctx-i').count();
conceptOpts >= 1 ? ok(`右键展开概念列表（${conceptOpts} 个概念）`) : bad('概念列表为空');
const conceptName = (await page.locator('.nd-concept .nd-label').first().textContent()).trim();
await page.locator('.ctx-link .ctx-i').first().click();
await page.waitForTimeout(400);
const chip = (await page.locator('.nd-image .nd-link-go').first().textContent().catch(() => ''));
chip.includes(conceptName) ? ok('图节点显示关联 chip：' + chip.trim()) : bad('关联 chip 缺失：' + chip);
const badge = (await page.locator('.nd-concept .nd-linked-badge').first().textContent().catch(() => ''));
/参考图\s*1/.test(badge) ? ok('概念卡面显示参考图徽标：' + badge.trim()) : bad('参考图徽标缺失：' + badge);

// 13.1b chip 上的 × 取消关联 → 徽标同步消失
await page.locator('.nd-image .nd-link-x').first().click();
await page.waitForTimeout(300);
(await page.locator('.nd-image .nd-link-go').count()) === 0 ? ok('chip 可取消关联') : bad('取消关联失败');
(await page.locator('.nd-concept .nd-linked-badge').count()) === 0 ? ok('取消后概念卡面徽标同步消失') : bad('徽标未消失');

// 13.1c 拖放关联（主路径）：图节点拖到概念上，拖拽中概念高亮，松手建立关联
await clickFloat(page, 'fit');
await page.waitForTimeout(700);
const imgBox = await page.locator('.nd-image').first().boundingBox();
const cBox = await page.locator('.nd-concept').first().boundingBox();
if (imgBox && cBox) {
  await page.mouse.move(imgBox.x + imgBox.width / 2, imgBox.y + imgBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cBox.x + cBox.width / 2, cBox.y + cBox.height / 2, { steps: 15 });
  await page.waitForTimeout(250);
  (await page.locator('.nd-concept.drop-hint').count()) === 1
    ? ok('拖拽中概念节点高亮（可落地预告）')
    : bad('拖拽高亮缺失');
  await page.mouse.up();
  await page.waitForTimeout(400);
  const chip2 = (await page.locator('.nd-image .nd-link-go').first().textContent().catch(() => ''));
  chip2.includes(conceptName) ? ok('拖放到概念上即建立关联：' + chip2.trim()) : bad('拖放关联失败：' + chip2);
  // 拖完把图节点挪到一旁：它此刻压在概念节点上（RF 给选中节点 z-index 1000），
  // 13.2 要点的「概念卡片 / 详情徽标」会被它 intercept，整段超时
  const ib2 = await page.locator('.nd-image').first().boundingBox();
  if (ib2) {
    await page.mouse.move(ib2.x + ib2.width / 2, ib2.y + ib2.height / 2);
    await page.mouse.down();
    await page.mouse.move(ib2.x + ib2.width / 2 + 420, ib2.y + ib2.height / 2 + 60, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
} else bad('拿不到节点坐标，拖放断言跳过');

// 13.2 概念详情「评分」tab 顶部的出图评价块 + 留用标记
await page.locator('.nd-concept').first().click();
await page.waitForTimeout(300);
if ((await page.locator('.nd-body').count()) === 0) {
  await page.locator('.nd-concept .nd-detail').first().click().catch(() => {});
  await page.waitForTimeout(400);
}
await page.click('.ndb-tab:has-text("评分")').catch(() => {});
await page.waitForTimeout(400);
const evalCount = await page.locator('.nd-body .eval-i').count();
evalCount >= 1 ? ok(`出图评价块渲染（${evalCount} 张关联图）`) : bad('出图评价块缺失');

// 13.2b P6 收口：详情卡不许被画布边界裁掉（裁了按钮就点不着）
//
// 曾经的坑：卡片的"带回可视区"只在展开时抢一次镜头，用户随后把画布一拖，
// 卡片就被画布左边缘裁掉半边——「留用」只剩十来个像素可见，点不到。
// 现在超界由 transform 补偿（只动卡片不动镜头），这里钉住不变量。
const cardInWrap = async (tag) => {
  const g = await page.evaluate(() => {
    const b = document.querySelector('.nd-body');
    const w = document.querySelector('.canvas-wrap');
    const n = b?.closest('.react-flow__node');
    if (!b || !w) return null;
    const br = b.getBoundingClientRect();
    const wr = w.getBoundingClientRect();
    const nr = n?.getBoundingClientRect();
    const k = b.querySelector('.eval-k');
    const kr = k?.getBoundingClientRect();
    const R = (x) => (x ? { l: Math.round(x.left), r: Math.round(x.right), t: Math.round(x.top), b: Math.round(x.bottom) } : null);
    return {
      over: Math.round(Math.max(0, wr.left - br.left) + Math.max(0, br.right - wr.right)),
      overL: Math.round(Math.max(0, wr.left - br.left)),
      overR: Math.round(Math.max(0, br.right - wr.right)),
      shift: getComputedStyle(b).transform,
      card: R(br),
      node: R(nr),
      wrap: R(wr),
      keyVisible: kr
        ? document.elementFromPoint(kr.left + kr.width / 2, kr.top + kr.height / 2)?.className ?? ''
        : '',
    };
  });
  return g ? { tag, ...g } : null;
};
const g1 = await cardInWrap('展开后');
g1 && g1.over <= 2 && /eval-k/.test(g1.keyVisible)
  ? ok(`详情卡完整落在画布内（越界 ${g1.over}px，「留用」按钮可达）`)
  : bad(`详情卡越出画布：${JSON.stringify(g1)}`);

// 取证：把画布左缘也框进来，能看出卡片是被"推回来贴着边界"的
const cardShot = async (name) => {
  const b = await page.locator('.nd-body').boundingBox();
  if (!b) return;
  await page
    .screenshot({
      path: `tools/shots-b4/${name}.png`,
      clip: {
        x: Math.max(0, b.x - 240),
        y: Math.max(0, b.y - 70),
        width: 620,
        height: 340,
      },
    })
    .catch(() => {});
};

// 把画布往左拖（内容跟着左移），卡片会被推出画布左缘——补偿应当把它推回来。
// 注意 App 里 selectionOnDrag + panOnDrag={[1,2]}：左键是框选，平移要用中键。
const panePt = await page.evaluate(() => {
  const w = document.querySelector('.canvas-wrap');
  const wr = w.getBoundingClientRect();
  for (const [fx, fy] of [[0.5, 0.9], [0.15, 0.92], [0.85, 0.9], [0.5, 0.08]]) {
    const x = wr.left + wr.width * fx;
    const y = wr.top + wr.height * fy;
    const el = document.elementFromPoint(x, y);
    if (el?.closest('.react-flow__pane') && !el.closest('.nd')) return { x, y };
  }
  return null;
});
if (panePt) {
  await page.mouse.move(panePt.x, panePt.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(panePt.x - 300, panePt.y, { steps: 12 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(900);
  const g2 = await cardInWrap('拖动后');
  g2 && g2.over <= 2
    ? ok(`画布拖走 300px 后卡片自己跟回来（越界 ${g2.over}px，补偿 ${g2.shift}）`)
    : bad(`拖动后卡片仍越界：${JSON.stringify(g2)}`);
  g2 && /eval-k/.test(g2.keyVisible)
    ? ok('补偿后卡片按钮依然可点（不是视觉糊弄）')
    : bad('补偿后按钮仍被挡：' + (g2?.keyVisible ?? ''));
  await cardShot('p6-clamp');
} else bad('找不到空白画布落点，拖动回边断言跳过');

await page.locator('.nd-body .eval-i').first().locator('.eval-k:has-text("留用")').click({ timeout: 8000 });
await page.waitForTimeout(300);
const keepBadge = (await page.locator('.nd-image .nd-keep').first().textContent().catch(() => ''));
keepBadge.includes('留用') ? ok('图节点显示留用标记') : bad('留用标记缺失：' + keepBadge);
await page.click('.ndb-fold').catch(() => {}); // 收起详情，别挡右栏断言

// 13.3 右栏「行动建议」：汇总行 + 徽标 + 证据 chips
const rtxt = await page.locator('.panel-right').textContent();
rtxt.includes('行动建议') ? ok('右栏区块改名「行动建议」') : bad('右栏未改名：' + rtxt.slice(0, 60));
/建议推进|待验证|暂缓/.test(rtxt) ? ok('汇总行渲染') : bad('汇总行缺失');
(await page.locator('.adv-badge').count()) >= 1 ? ok('建议徽标已渲染') : bad('建议徽标缺失');
(await page.locator('.adv-ev:has-text("图 1")').count()) >= 1 ? ok('证据 chips 含「图 1」') : bad('证据 chips 缺图数');

// 13.4 重新深潜语义框：画布有内容时先问「再挖一轮 / 清空重来」
const seedsBefore = await page.locator('.nd-seed').count();
await page.click('button:has-text("开始深潜")');
await page.waitForTimeout(400);
(await page.locator('.modal-mask').count()) >= 1
  ? ok('画布有内容时「开始深潜」先弹语义框（不闷头追加）')
  : bad('语义框未弹出');
const optTxt = await page.locator('.redive-opts').textContent();
optTxt.includes('再挖一轮') && optTxt.includes('清空重来') ? ok('两个选项齐全') : bad('选项缺失');
await page.click('.redive-opt:has-text("再挖一轮")');
await page.waitForTimeout(2800);
const seedsAfter = await page.locator('.nd-seed').count();
seedsAfter > seedsBefore
  ? ok(`再挖一轮：种子 ${seedsBefore} → ${seedsAfter}（旧节点保留，追加新一批）`)
  : bad(`追加失败：${seedsBefore} → ${seedsAfter}`);

console.log('\n[14] 持久化');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const nAfter = await page.locator('.nd').count();
const iAfter = await page.locator('.nd-intel').count();
const refAfter = await page.locator('.refitem').count();
/* 批次 2：[13.4] 的「再挖一轮」会追加第二批 3 张情报卡，所以这里是 3+3=6。
   断言跟着场景走——它验的是"刷新后数据不丢"，不是"只跑了一轮深潜"。 */
nAfter >= 10 && iAfter === 6 && refAfter === 2
  ? ok(`刷新后 ${nAfter} 节点 / ${iAfter} 情报卡 / ${refAfter} 资料`)
  : bad(`刷新后 ${nAfter} 节点 / ${iAfter} 卡 / ${refAfter} 资料`);

console.log('\n[15] 交付文档（Markdown 汇编）');
await openMore(page, 'doc');
await page.waitForTimeout(600);
const docTxt = await page.locator('.doc-pre').textContent();
const docNeeds = ['一、调研洞察', '二、情报卡片', '三、种子词', '四、收敛概念', '五、行动建议', 'SWOT 分析', '置信度', '来源：', 'Midjourney', '即梦', '生成于'];
const missingDoc = docNeeds.filter((k) => !docTxt.includes(k));
missingDoc.length === 0 ? ok('文档五要素齐全（简报/情报卡/种子词/概念/提示词）') : bad('文档缺：' + missingDoc.join('、'));
docTxt.includes('为什么：') ? ok('种子词带「为什么」与来源') : bad('种子词缺溯源');
const dl = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await page.click('button:has-text("下载 .md")');
const download = await dl;
download ? ok('下载触发：' + download.suggestedFilename()) : bad('下载未触发');
await page.click('.modal-f button:has-text("关闭")');
await page.waitForTimeout(300);
(await page.locator('.modal-doc').count()) === 0 ? ok('文档弹层可关闭') : bad('弹层未关闭');

console.log('\n[18] P4 评分成为讨论工具：依据置顶 + 人工调整 + 有效值贯通');
/* 展开一个有 V2 评分的概念节点。用 store 动作定位（setSelected + toggleExpand）
   而不是去画布上找坐标——21 个节点的画布上，节点在视口外的概率太高，
   用坐标点击会让这条断言变成"碰运气"。后面所有交互仍是真实点击。 */
const scoredId = await page.evaluate(() => {
  const s = window.__dd.getState();
  const n = s.nodes.find((x) => x.data.score?.v === 2);
  if (!n) return null;
  if (s.expandedId !== n.id) s.toggleExpand(n.id);
  s.setSelected(n.id);
  return n.id;
});
if (!scoredId) {
  bad('画布上没有 V2 评分的节点，P4 断言未跑');
} else {
  await page.waitForSelector('.nd-body', { timeout: 8000 });
  await page.click('.nd-body .ndb-tab:has-text("评分")').catch(() => {});
  await page.waitForTimeout(400);
  const vBefore = (await page.locator('.nd-body .value-num').textContent()).trim();

  // 18.1 置顶：假设 + 待验证问题（模板化，零 AI）
  const talk = await page.locator('.nd-body .talk-sec').count();
  talk === 2
    ? ok('评分 tab 置顶「本判定依赖什么 / 接下来该验证什么」')
    : bad('讨论区块 ' + talk);
  const advKano = await page.locator('.nd-body .score-adv .kano').count();
  const advOpen = await page.locator('.nd-body .score-adv[open]').count();
  advKano === 1 && advOpen === 0
    ? ok('KANO / 权重降级进「进阶」折叠（默认收起）')
    : bad(`进阶区 KANO ${advKano} / 展开态 ${advOpen}`);

  // 18.2 人工调整：点「我有不同看法」→ 出滑杆 + AI 幽灵分
  const crit0 = page.locator('.nd-body .crit').first();
  await crit0.locator('summary').click();
  await page.waitForTimeout(250);
  await crit0.locator('.adj-opt:has-text("我有不同看法")').click();
  await page.waitForTimeout(400);
  const hasSlider = await page.locator('.nd-body .crit-fix input[type="range"]').count();
  const ghost = await page.locator('.nd-body .crit-ai').count();
  hasSlider === 1 && ghost === 1
    ? ok('选「我有不同看法」后出现调分滑杆，AI 原始分保留为幽灵数字')
    : bad(`滑杆 ${hasSlider} / 幽灵分 ${ghost}`);

  // 18.3 拖动滑杆改分 → 有效值贯通到右栏
  await page.locator('.nd-body .crit-fix input[type="range"]').fill('9.5');
  await page.waitForTimeout(500);
  const adj = await page.evaluate((id) => {
    const n = window.__dd.getState().nodes.find((x) => x.id === id);
    return n?.data.score?.userAdj ?? null;
  }, scoredId);
  adj && adj.c1 === 9.5
    ? ok('调整写入 score.userAdj（AI 原始分未被覆盖）')
    : bad('userAdj：' + JSON.stringify(adj));
  const vAfter = (await page.locator('.nd-body .value-num').textContent()).trim();
  vAfter !== vBefore
    ? ok(`价值分跟随调整变化：${vBefore} → ${vAfter}`)
    : bad('调整后价值分没变：' + vAfter);
  (await page.locator('.nd-body .value-lb').textContent()).includes('含用户调整')
    ? ok('价值分标注「含用户调整」')
    : bad('缺含用户调整标注');
  const chip = await page.locator('.panel-right .adv-ev:has-text("含用户调整")').count();
  chip >= 1 ? ok('右栏行动建议证据带「含用户调整」') : bad('右栏无调整标记');

  // 18.4 调整说明写进交付文档
  await page.locator('.nd-body .adj-note').fill('可行性被低估了，产线打样过类似结构');
  await page.waitForTimeout(400);
  await openMore(page, 'doc');
  await page.waitForTimeout(600);
  const docTxt2 = (await page.locator('.doc-pre').textContent()) ?? '';
  docTxt2.includes('含用户调整') && docTxt2.includes('产线打样过类似结构')
    ? ok('交付文档标注「含用户调整」并带走调整说明')
    : bad('文档未反映用户调整');
  await page.click('.modal-f button:has-text("关闭")');
  await page.waitForTimeout(300);

  // 18.5 一键还原
  await page.click('.nd-body .value-ghost .link-btn');
  await page.waitForTimeout(500);
  const adjGone = await page.evaluate((id) => {
    const n = window.__dd.getState().nodes.find((x) => x.id === id);
    return n?.data.score?.userAdj ?? null;
  }, scoredId);
  const vBack = (await page.locator('.nd-body .value-num').textContent()).trim();
  !adjGone && vBack === vBefore
    ? ok(`一键还原 AI 评分：${vAfter} → ${vBack}`)
    : bad(`还原失败：userAdj ${JSON.stringify(adjGone)} / 分 ${vBack}`);
  await page.click('.ndb-fold').catch(() => {});
  await page.waitForTimeout(300);
}

console.log('\n[19] P5 撤销 / 重做与阶段快照');
const undoBtn = page.locator('.float-tool[data-act="undo"]');
(await undoBtn.isDisabled()) === false
  ? ok('撤销按钮可用（前期操作已入栈）')
  : bad('撤销按钮仍禁用——历史栈没记上');
const n19 = await page.locator('.nd').count();
await page.evaluate(() => window.__dd.getState().addSeed('撤销测试词'));
await page.waitForTimeout(500);
const n19a = await page.locator('.nd').count();
await undoBtn.click();
await page.waitForTimeout(500);
const n19b = await page.locator('.nd').count();
n19a === n19 + 1 && n19b === n19
  ? ok(`撤销一步：节点 ${n19} → ${n19a} → ${n19b}`)
  : bad(`撤销异常：${n19} → ${n19a} → ${n19b}`);
await page.locator('.float-tool[data-act="redo"]').click();
await page.waitForTimeout(500);
const n19c = await page.locator('.nd').count();
n19c === n19 + 1 ? ok(`重做一步：→ ${n19c}`) : bad('重做后 ' + n19c);

// 快捷键：Ctrl+Z / Ctrl+Shift+Z
await page.keyboard.press('Control+z');
await page.waitForTimeout(400);
const n19d = await page.locator('.nd').count();
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(400);
const n19e = await page.locator('.nd').count();
n19d === n19 && n19e === n19 + 1
  ? ok(`快捷键生效：Ctrl+Z → ${n19d}，Ctrl+Shift+Z → ${n19e}`)
  : bad(`快捷键异常：${n19d} / ${n19e}`);

// 快照：保存 → 列表 → 删除
await openMore(page, 'snap');
await page.waitForSelector('.modal-snap', { timeout: 5000 });
ok('⋯ 菜单「阶段快照」打开管理弹层');
await page.fill('.snap-name', '整理前存档');
await page.click('[data-act="snap-save"]');
await page.waitForTimeout(500);
const snaps1 = await page.locator('.snap-i').count();
snaps1 === 1 ? ok('保存快照后出现在列表') : bad('快照列表 ' + snaps1);
const strippedOk = await page.evaluate(() => {
  const raw = localStorage.getItem('deepdiving.snaps.v1') ?? '[]';
  return JSON.parse(raw).every((s) =>
    s.nodes.every((n) => !(n.data.images || []).some((im) => im.dataUrl)),
  );
});
strippedOk ? ok('快照按 D7 不含图片数据（localStorage 独立键）') : bad('快照里仍有图片数据');
await page.click('.snap-i [data-act="snap-del"]');
await page.waitForTimeout(400);
const snaps2 = await page.locator('.snap-i').count();
snaps2 === 0 ? ok('删除快照生效') : bad('删除后仍剩 ' + snaps2);
await page.click('.modal-f button:has-text("取消")').catch(() => {});
await page.click('.modal-snap .modal-h .icon-btn');
await page.waitForTimeout(300);
(await page.locator('.modal-snap').count()) === 0 ? ok('快照弹层可关闭') : bad('弹层未关闭');

console.log('\n[20] P6 节点对象语言与便签（D9 身份边界 · 错落 · 四维来源）');

// --- P6-1 对象语言：便签是「用户自己的声音」，只用 D9 五色板 ---
const n20 = await page.locator('.nd').count();
await page.click('.float-tool[data-act="create"]');
await page.waitForTimeout(350);
const popOpen = await page.locator('.create-pop').isVisible();
const popItems = await page.locator('.create-pop .create-i').count();
popOpen && popItems === 3
  ? ok('工具条「+ 新建」展开三项（便签 / 图片 / 种子词）')
  : bad(`新建 popover 异常：open=${popOpen} items=${popItems}`);
await page.click('.create-pop [data-act="create-note"]');
await page.waitForTimeout(700);
const n20a = await page.locator('.nd').count();
const noteCnt = await page.locator('.nd-note').count();
n20a === n20 + 1 && noteCnt === 1
  ? ok(`新建便签落到画布（节点 ${n20} → ${n20a}）`)
  : bad(`便签未创建：${n20} → ${n20a} / .nd-note ${noteCnt}`);
(await page.locator('.nd-note.editing .note-edit').count()) === 1
  ? ok('新便签直接进编辑态（光标已在里面，不用再双击）')
  : bad('便签没进编辑态');

// 写完按 ⌘/Ctrl+Enter 提交
await page.fill('.nd-note .note-edit', '这里先钉个想法：包装开合要像呼吸');
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(500);
const noteText = ((await page.locator('.nd-note .note-text').first().innerText()) ?? '').trim();
noteText === '这里先钉个想法：包装开合要像呼吸'
  ? ok(`便签文本落库：${noteText}`)
  : bad(`便签文本不对：${noteText}`);
(await page.locator('.nd-note.editing').count()) === 0
  ? ok('提交后退出编辑态')
  : bad('提交后仍在编辑态');

// 选中 → 五色板，逐色核对是不是 D9 那五个（不能混进 AI 产物色）
await page.click('.nd-note .note-text');
await page.waitForTimeout(400);
const toneBg = await page.$$eval('.nd-note .note-tone', (els) =>
  els.map((e) => getComputedStyle(e).backgroundColor),
);
const D9 = ['rgb(245, 217, 141)', 'rgb(214, 224, 206)', 'rgb(240, 213, 210)', 'rgb(220, 214, 232)', 'rgb(239, 216, 198)'];
const toneSetOk =
  toneBg.length === 5 && toneBg.every((c, i) => c === D9[i]) && new Set(toneBg).size === 5;
toneSetOk
  ? ok(`便签色板 = D9 五色且互不相同（${toneBg.length} 色）`)
  : bad(`色板不符：${toneBg.join(' | ')}`);
await page.locator('.nd-note .note-tone').nth(3).click();
await page.waitForTimeout(400);
const toneNow = await page.evaluate(() => {
  const n = window.__dd.getState().nodes.find((x) => x.type === 'note');
  return n?.data?.noteTone ?? '';
});
toneNow === 'lav' ? ok('换色写入 store：lav') : bad('换色未生效：' + toneNow);

// 错落角度：由 id 推导，必须稳定（每帧重渲染不许抖），且 ≤ 0.7°
const tiltA = await page.evaluate(() => {
  const el = document.querySelector('.nd-note');
  return el ? getComputedStyle(el).transform : '';
});
await page.waitForTimeout(500);
const tiltB = await page.evaluate(() => {
  const el = document.querySelector('.nd-note');
  return el ? getComputedStyle(el).transform : '';
});
let tiltDeg = 0;
if (tiltA.startsWith('matrix(')) {
  const p = tiltA.slice(7, -1).split(',').map(Number);
  tiltDeg = Math.abs((Math.atan2(p[1], p[0]) * 180) / Math.PI);
}
tiltA && tiltA === tiltB && tiltDeg <= 0.71
  ? ok(`便签轻微错落且稳定：${tiltDeg.toFixed(2)}°（两次读取一致）`)
  : bad(`错落异常：${tiltA} / ${tiltB} → ${tiltDeg.toFixed(2)}°`);

// --- P6-1 钉为便签：从来源节点派生，noteSource 有值，且位置贴来源 ---
const pinned = await page.evaluate(() => {
  const s = window.__dd.getState();
  const host = s.nodes.find((n) => n.type === 'seed');
  if (!host) return null;
  const before = s.nodes.length;
  const id = s.pinNote('配色要克制，别把陶土压成橙色', '简报 · 视觉基调', host.id);
  const st = window.__dd.getState();
  const node = st.nodes.find((n) => n.id === id);
  return {
    before,
    after: st.nodes.length,
    src: node?.data?.noteSource ?? '',
    kind: node?.type ?? '',
    dx: node ? node.position.x - host.position.x : 0,
    dy: node ? node.position.y - host.position.y : 0,
  };
});
pinned && pinned.after === pinned.before + 1 && pinned.kind === 'note'
  ? ok(`钉为便签：节点 ${pinned.before} → ${pinned.after}`)
  : bad('钉为便签失败：' + JSON.stringify(pinned));
pinned && pinned.src === '简报 · 视觉基调'
  ? ok('便签带来源标注（钉自何处一眼可见）')
  : bad('便签缺 noteSource：' + (pinned?.src ?? ''));
pinned && pinned.dx > 0 && Math.abs(pinned.dy) < 120
  ? ok('便签贴在来源节点右侧（不是随便落在空地）')
  : bad(`落点偏离来源：dx=${pinned?.dx} dy=${pinned?.dy}`);

// 双击就地编辑：改一句，Escape 取消不该写库
await page.evaluate(() => {
  const s = window.__dd.getState();
  const n = s.nodes.find((x) => x.type === 'note');
  s.setSelected(n.id);
});
await page.waitForTimeout(300);
await page.dblclick('.nd-note .note-text');
await page.waitForTimeout(400);
const editOpen = await page.locator('.nd-note.editing .note-edit').count();
editOpen === 1 ? ok('双击便签就地编辑（不弹窗、不跳页）') : bad('双击未进编辑态');
await page.fill('.nd-note .note-edit', '这句不要了');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const stillThere = await page.evaluate(() => {
  const n = window.__dd.getState().nodes.find((x) => x.id === window.__dd.getState().selectedId);
  return n?.data?.label ?? '';
});
stillThere !== '这句不要了' ? ok('Escape 取消编辑，原句没被覆盖') : bad('取消没生效，内容被改写');

// --- P6-1 来源徽标：种子卡按 seedSource 判「简报提取 / 手动添加」 ---
const seedSrcStat = await page.evaluate(() => {
  const s = window.__dd.getState();
  const seeds = s.nodes.filter((n) => n.type === 'seed');
  return {
    total: seeds.length,
    fromBrief: seeds.filter((n) => !!n.data.seedSource).length,
    manual: seeds.filter((n) => !n.data.seedSource).length,
  };
});
seedSrcStat.total > 0
  ? ok(`种子卡来源状态可判：简报提取 ${seedSrcStat.fromBrief} / 手动添加 ${seedSrcStat.manual}`)
  : bad('画布上没有种子卡');
const seedSrcDom = await page.$$eval('.nd-seed .nd-src-k', (els) => els.map((e) => e.textContent.trim()));
seedSrcDom.length === seedSrcStat.total && seedSrcDom.every((t) => t === '简报提取' || t === '手动添加')
  ? ok(`每张种子卡都标了来源（${seedSrcDom.length} 张，文本取自白名单）`)
  : bad(`种子徽标不全：${seedSrcDom.length}/${seedSrcStat.total} → ${seedSrcDom.join(',')}`);

// --- P6-1 情报卡便签化：来源条 + 纸白（不抢便签的黄） ---
const intelN = await page.locator('.nd-intel').count();
if (intelN > 0) {
  const srcBars = await page.locator('.nd-intel .intel-src').count();
  srcBars === intelN
    ? ok(`情报卡都有来源条（${intelN} 张，标「深潜提取」）`)
    : bad(`来源条缺失：${srcBars}/${intelN}`);
  const intelBg = await page.$$eval('.nd-intel', (els) => els.map((e) => getComputedStyle(e).backgroundColor));
  const noYellow = intelBg.every((c) => !D9.slice(0, 5).includes(c));
  noYellow
    ? ok('情报卡保持纸白，没有借用便签的 D9 色（AI 产物 ≠ 用户声音）')
    : bad('情报卡混进了便签色：' + intelBg.join(' | '));
}

// --- P6-2 简报浮层：句子可拖（拖画布 = 加种子），图钉可钉便签 ---
// 浮层可能被收起过，先展开——收起的浮层不渲染正文，断言会假失败
if ((await page.locator('.brief-dock.mini').count()) > 0) {
  await page.click('.brief-dock .bd-head .icon-btn');
  await page.waitForTimeout(400);
}
(await page.locator('.brief-dock .bd-body').count()) === 1
  ? ok('简报浮层可展开（正文可见才谈得上拖）')
  : bad('简报浮层展开失败');
const bdDraggable = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.brief-dock [draggable="true"]')];
  return { count: els.length, pins: document.querySelectorAll('.brief-dock .bd-pin').length };
});
bdDraggable.count > 0
  ? ok(`简报浮层有 ${bdDraggable.count} 段文字可拖（拖到画布即加种子）`)
  : bad('简报浮层没有可拖文字');
bdDraggable.pins > 0
  ? ok(`浮层每段文字都配了图钉（${bdDraggable.pins} 个，可钉成便签）`)
  : bad('浮层缺少图钉');
(await page.locator('.brief-dock .bd-tip').count()) === 1
  ? ok('浮层底部说明了拖拽 / 图钉两种用法')
  : bad('缺少 bd-tip 说明');

// P6-2 拖文字到画布：走 application/dd-text 载荷，落地成种子
const dragAdd = await page.evaluate(() => {
  const s = window.__dd.getState();
  const before = s.nodes.length;
  const dt = new DataTransfer();
  dt.setData('application/dd-text', '把开合做成一次呼吸');
  const wrap = document.querySelector('.canvas-wrap');
  const r = wrap.getBoundingClientRect();
  wrap.dispatchEvent(new DragEvent('drop', {
    bubbles: true, cancelable: true, dataTransfer: dt,
    clientX: r.left + r.width * 0.4, clientY: r.top + r.height * 0.6,
  }));
  const st = window.__dd.getState();
  const made = st.nodes.find((n) => n.type === 'seed' && n.data.label === '把开合做成一次呼吸');
  return { before, after: st.nodes.length, kind: made?.type ?? '', origin: made?.data?.seedOrigin ?? '' };
});
dragAdd.after === dragAdd.before + 1 && dragAdd.kind === 'seed'
  ? ok('简报句子拖进画布 → 长出种子卡（复用拖拽载荷，零新通道）')
  : bad('拖拽加种子失败：' + JSON.stringify(dragAdd));

// --- P6-3 四维分析：来源徽标在右栏可读，配色走本地 ---
const dimsState = await page.evaluate(() => {
  const s = window.__dd.getState();
  const img = s.nodes.find((n) => n.type === 'image');
  const v = img?.data?.visual;
  return { has: !!v, ver: v?.v ?? 0, dims: Object.keys(v?.dims ?? {}) };
});
dimsState.has && dimsState.ver === 2
  ? ok(`参考图档案已升到 v2（维度：${dimsState.dims.join(' / ') || '空'}）`)
  : bad('参考图档案仍是旧结构：' + JSON.stringify(dimsState));

// --- 删除路径：便签没有后代，按既有规则直接删、不弹确认（不打扰） ---
const delBefore = await page.locator('.nd').count();
await page.evaluate(() => {
  const s = window.__dd.getState();
  const n = s.nodes.find((x) => x.type === 'note');
  s.requestDelete([n.id]);
});
await page.waitForTimeout(600);
const delAfter = await page.locator('.nd').count();
const delModalShown = await page.locator('.modal-mask').isVisible().catch(() => false);
delAfter === delBefore - 1 && !delModalShown
  ? ok(`便签无后代 → 直接删除不弹窗（节点 ${delBefore} → ${delAfter}）`)
  : bad(`便签删除异常：${delBefore} → ${delAfter} / modal=${delModalShown}`);

// 撤销能不能把便签捡回来（便签也进历史栈）
await page.locator('.float-tool[data-act="undo"]').click();
await page.waitForTimeout(500);
const undone = await page.locator('.nd-note').count();
undone >= 1 ? ok(`撤销把便签捡回来了（.nd-note ${undone}）`) : bad('撤销没恢复便签');

console.log('\n[21] 画布鼠标快捷交互（弧线 / 右键便签 / 双击种子 / 浮层点外收起）');

// 找一个不被任何节点覆盖的空白点（client 坐标）
const blankPoint = () =>
  page.evaluate(() => {
    const wrap = document.querySelector('.canvas-wrap').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.react-flow__node')].map((n) => n.getBoundingClientRect());
    for (let y = wrap.top + 70; y < wrap.bottom - 70; y += 22) {
      for (let x = wrap.left + 70; x < wrap.right - 70; x += 22) {
        const hit = boxes.some((b) => x > b.left - 34 && x < b.right + 34 && y > b.top - 34 && y < b.bottom + 34);
        if (!hit) return { x, y };
      }
    }
    return null;
  });

/* ① 连线是弧线。判据分两层：
   store 层 —— 没有任何一条边还挂着 smoothstep（含从 localStorage 迁回来的旧边）；
   DOM 层 —— path 只含三次贝塞尔命令 C，没有折线的 L。 */
const edgeInfo = await page.evaluate(() => {
  const s = window.__dd.getState();
  const d = document.querySelector('.react-flow__edge-path')?.getAttribute('d') ?? '';
  return { types: [...new Set(s.edges.map((e) => e.type))], n: s.edges.length, d };
});
edgeInfo.n > 0 && !edgeInfo.types.includes('smoothstep')
  ? ok(`连线已全部改弧线（${edgeInfo.n} 条，类型 ${edgeInfo.types.join(' / ') || '默认'}）`)
  : bad('仍有折线边：' + JSON.stringify({ n: edgeInfo.n, types: edgeInfo.types }));
edgeInfo.d.includes('C') && !edgeInfo.d.includes('L')
  ? ok('边路径是贝塞尔曲线（含 C 命令、无直角 L）')
  : bad('边路径仍像折线：' + edgeInfo.d.slice(0, 60));

/* ② 空白右键有「在此新建便签」，且落地即进编辑态 */
const blank1 = await blankPoint();
blank1 ? null : bad('画布找不到空白点，后续交互无法验证');
await page.mouse.click(blank1.x, blank1.y, { button: 'right' });
await page.waitForSelector('.ctx-menu', { timeout: 4000 });
const paneItems = (await page.locator('.ctx-menu .ctx-i').allTextContents()).map((t) => t.trim());
paneItems.some((t) => t.includes('在此新建便签'))
  ? ok('空白右键菜单含「在此新建便签」：' + paneItems.join(' / '))
  : bad('右键菜单缺便签项：' + paneItems.join(' / '));

const noteBefore = await page.locator('.nd-note').count();
await page.click('.ctx-menu .ctx-i:has-text("在此新建便签")');
await page.waitForTimeout(700);
const noteAfter = await page.locator('.nd-note').count();
const noteEditing = await page.locator('.nd-note textarea.note-edit').count();
noteAfter === noteBefore + 1 && noteEditing >= 1
  ? ok(`右键就地长出便签并直接可写（${noteBefore} → ${noteAfter}，编辑态 ${noteEditing}）`)
  : bad(`右键便签异常：${noteBefore} → ${noteAfter} / 编辑态 ${noteEditing}`);

// 写点内容再提交（⌘/Ctrl+Enter 提交；裸 Enter 是换行）
await page.locator('.nd-note textarea.note-edit').last().fill('右键建的第一张便签');
await page.locator('.nd-note textarea.note-edit').last().press('Control+Enter');
await page.waitForTimeout(400);
(await page.locator('.nd-note:has-text("右键建的第一张便签")').count()) >= 1
  ? ok('便签内容写进去了（Ctrl+Enter 提交）')
  : bad('便签内容没写入');

/* ③ 双击空白 = 就地新建种子词（复用右键那套内联输入框） */
const blank2 = await blankPoint();
await page.mouse.dblclick(blank2.x, blank2.y);
await page.waitForSelector('.ctx-menu .ctx-seed input', { timeout: 4000 });
ok('双击空白直接弹出种子词输入框（不必先右键再点菜单项）');
const seedBefore = await page.locator('.nd-seed').count();
await page.fill('.ctx-menu .ctx-seed input', '双击长出来的种子');
await page.press('.ctx-menu .ctx-seed input', 'Enter');
await page.waitForTimeout(600);
const seedAfter = await page.locator('.nd-seed').count();
seedAfter === seedBefore + 1 && (await page.locator('.nd-seed:has-text("双击长出来的种子")').count()) >= 1
  ? ok(`双击建种子成功（${seedBefore} → ${seedAfter}）`)
  : bad(`双击建种子失败：${seedBefore} → ${seedAfter}`);
(await page.locator('.ctx-menu').count()) === 0 ? ok('创建后菜单自己收起') : bad('创建后菜单仍开着');

/* ④ 「+ 新建」浮层：点外部 / Esc 都要能收起
   （原来只有再点一次按钮才会关，而它就盖在画布上） */
await page.click('.float-tool[data-act="create"]');
await page.waitForSelector('.create-pop', { timeout: 3000 });
const blank3 = await blankPoint();
await page.mouse.click(blank3.x, blank3.y);
await page.waitForTimeout(350);
(await page.locator('.create-pop').count()) === 0
  ? ok('点浮层以外的地方 → 自动收起')
  : bad('点外部没关掉浮层');

await page.click('.float-tool[data-act="create"]');
await page.waitForSelector('.create-pop', { timeout: 3000 });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
(await page.locator('.create-pop').count()) === 0
  ? ok('Esc 也能收起浮层')
  : bad('Esc 没关掉浮层');

console.log('\n[16] 清空按钮（原 confirm 被 iframe 拦截导致失效）');
await openMore(page, 'clear');
await page.waitForTimeout(500);
const modalVisible = await page.locator('.modal-mask').isVisible();
modalVisible ? ok('弹出应用内确认框（不再用 window.confirm）') : bad('确认框未弹出');
await page.click('.modal-f button:has-text("取消")');
await page.waitForTimeout(400);
(await page.locator('.nd').count()) >= 10 ? ok('取消后数据保留') : bad('取消后数据被误删');
await openMore(page, 'clear');
await page.waitForTimeout(400);
await page.click('.modal-f button:has-text("确认清空")');
await page.waitForTimeout(700);
const afterClear = await page.locator('.nd').count();
const afterRef = await page.locator('.refitem').count();
afterClear === 0 && afterRef === 0
  ? ok('清空生效：画布与资料均已清除')
  : bad(`清空未生效：${afterClear} 节点 / ${afterRef} 资料`);
const keepProduct = await page.inputValue('input[placeholder*="辣椒酱"]').catch(() => '');
keepProduct.includes('辣椒酱') ? ok('项目名与 AI 设置按要求保留') : bad('项目名被误清：' + keepProduct);

console.log("\n[17] 移动端 390px");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
overflow ? bad('移动端横向溢出') : ok('无横向溢出');
const canvasH = await page.evaluate(() => {
  const el = document.querySelector('.canvas-wrap');
  return el ? Math.round(el.getBoundingClientRect().height) : 0;
});
canvasH > 200
  ? ok('画布保留 ' + canvasH + 'px 高度')
  : (await page.locator('.canvas-wrap').count()) === 0
    ? ok('清空后回到澄清页（画布让位给项目设置）')
    : bad('画布高度异常 ' + canvasH);

await browser.close();
console.log('\n' + '='.repeat(52));
if (errs.length) { console.log('存在 ' + errs.length + ' 个问题：'); [...new Set(errs)].forEach((e) => console.log('  - ' + e)); process.exit(1); }
console.log('端到端全部通过，无控制台错误');
