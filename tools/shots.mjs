import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { clickFloat, openMore } from './lib/dd-fixture.mjs';

/* playwright 改为项目 devDependency 之后，这里不再用 createRequire 指向
   **外部** workspace 的绝对路径 —— 换台机器、或 `npm ci` 之后就找不到依赖了。 */
const OUT = process.env.DD_OUT || 'tools/shots';
const URL = process.env.DD_URL || 'http://127.0.0.1:5199/';
mkdirSync(OUT, { recursive: true });

const init = () => {
  if (localStorage.getItem('deepdiving.v1')) return;
  localStorage.setItem('deepdiving.v1', JSON.stringify({
    brief: '目标人群 25-34 岁独居青年，追求刺激与独特性。使用场景：深夜手机下单。',
    product: '辣椒酱品牌升级', mood: '', references: [], report: null,
    nodes: [], edges: [], intel: [],
    settings: { baseUrl: 'http://localhost:8788', apiKey: 'mock-key', model: 'mock', temperature: 0.9 },
  }));
};

const browser = await chromium.launch();

// ---------- 1. 桌面：深潜后的简报抽屉 ----------
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.addInitScript(init);
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.fill('input[placeholder*="辣椒酱"]', '辣椒酱品牌升级');
await page.fill('input[placeholder*="危险感"]', '危险感、冷冽、解压');
await page.click('button:has-text("开始深潜")');
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/1-report.png` });

// ---------- 2. 桌面：画布全貌（情报卡 + 种子词） ----------
/* ⚠️ 这里**不再**点「回到画布」。F10 阶段机之前，「开始深潜」会跳到一个独立报告页、
   要点「回到画布」才进画布；现在「开始深潜」直接跑完并**留在画布上**，
   而「回到画布」只存在于调研洞察抽屉里（ReportDrawer.tsx:18）。
   照旧写法点它会一直等到 30s 超时。 */
await page.waitForTimeout(400);
/* 「适应视图」第 7 步已从顶栏 ⋯ 菜单搬到画布浮动工具条（.float-tool[data-act="fit"]）。
   直接写 `button:has-text("适应视图")` 会静默等到超时 —— 移进菜单时被搬走过一次，
   现在又搬了一次，所以走夹具导出的助手，别手写选择器。 */
await clickFloat(page, 'fit');
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/2-canvas.png` });

// ---------- 3. 交付文档弹层 ----------
/* 「交付文档」在 ⋯ 菜单里：菜单是点开的、有渲染延迟，少了 waitForSelector 会偶发点空。 */
await openMore(page, 'doc');
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/6-doc.png` });
await page.click('.modal-f button:has-text("关闭")');
await page.waitForTimeout(300);

// ---------- 4. 桌面：六维轮盘 ----------
await page.locator('.nd-seed:has-text("灼烧后的麻木感")').first().dblclick();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/3-wheel.png` });
await page.keyboard.press('Escape');

// ---------- 4. 桌面：左栏（含上传区）局部 ----------
await page.locator('.panel-left').screenshot({ path: `${OUT}/4-left.png` });

// ---------- 5. 移动端 ----------
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mp = await m.newPage();
await mp.addInitScript(init);
await mp.goto(URL, { waitUntil: 'networkidle' });
await mp.waitForTimeout(900);
await mp.screenshot({ path: `${OUT}/5-mobile.png` });

await browser.close();
console.log('截图完成 → ' + OUT);
