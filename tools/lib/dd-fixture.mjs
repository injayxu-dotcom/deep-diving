/* ============================================================
   共享测试夹具：播种状态 → 打开指定视图

   为什么抽出来：M3 的每一步（字号、光源、海拔、顶栏、工具条、状态栏）都要用
   "同一批视图 + 同一份内容"去取证。各脚本各抄一份的话，改一处忘另一处就会出现
   "A 步骤验过的东西，B 步骤其实测的是另一个界面"——这种偏差不会报错。

   两个工程细节（不看代码猜不到，踩过）：
   ① stage 不落盘。src/lib/storage.ts 的 Persisted 是显式白名单，没有 stage 字段，
      loadState() 会把它丢掉；stage 在 store 初始化时按 report / nodes / product
      推导（useStore.ts:791）。所以"空画布"用 localStorage 播种根本到不了——
      会被推到澄清对话（PRD 10.4 的故意设计）。只能在页面里 setState。
   ② showSettings / docOpen / showHelp / confirmClear 是 App 的 useState，
      不在 store 里，只能靠点击打开；store 侧的状态用 window.__dd（仅 DEV 暴露）。
   ============================================================ */

/* playwright 现在是本项目的 devDependency。
   以前这里用 createRequire 指向一个**外部** workspace 的绝对路径 —— 换台机器、
   或 `npm ci` 之后就找不到依赖了。浏览器二进制仍复用全局缓存
   （Windows 在 %LOCALAPPDATA%\ms-playwright），不进仓库、不随包分发。 */
export { chromium } from 'playwright';

export const URL = process.env.DD_URL || 'http://127.0.0.1:5199/';

export const SETTINGS = {
  baseUrl: 'http://localhost:8788', apiKey: 'mock-key', model: 'mock', temperature: 0.9,
};

/** 空数据：用来拿"全新用户"的空画布 / 空左栏 / 空态卡 */
export const EMPTY_DATA = { brief: '', product: '', mood: '', report: null, nodes: [], edges: [], intel: [] };

/** 情报卡墙（左栏 .icard 的三个变体各一张，含 confidence 徽章） */
export const INTEL = [
  {
    id: 'i-aud', kind: 'audience', title: '受众画像',
    summary: '25-34 独居青年，深夜下单为主，在意"这瓶是不是认真的"',
    points: [{ text: '对怀旧工业感有共鸣', confidence: '高' }, { text: '愿意为情绪付溢价', confidence: '中' }],
  },
  {
    id: 'i-cmp', kind: 'competitor', title: '竞品视觉共性',
    summary: '高饱和红 + 金色书法字 + 满版辣椒特写，货架上区分度很低',
    points: [{ text: '红金配色占七成', confidence: '高' }, { text: '几乎不做质感叙事', confidence: '中' }],
  },
  {
    id: 'i-opp', kind: 'opportunity', title: '机会空白点',
    summary: '没有人用"时间痕迹"讲可信度，做旧质感在品类里是空位',
    points: [{ text: '锈色/剥落质感无人使用', confidence: '中' }],
  },
];

/**
 * 足量参考资料，用来把左栏撑到**可滚动**。
 *
 * 为什么需要它：收起把手的"点图标 → 展开并滚到那一区"这条路径，
 * 在内容不高的夹具上验不了 —— .panel 的 scrollHeight 只比 clientHeight 大 153px，
 * 点完区块图标 scrollTop 一滚就到底，看起来"跳成功了"，
 * 其实只是滚了 153px，区块还差 900px 才到顶。这种"滚了一下"不等于"跳到了"。
 * 所以要造一份真能滚起来的内容，才能拿 scrollTop 和期望值对账。
 *
 * .ref-name 是 nowrap + ellipsis（styles.css:393），名字长了不会换行 ——
 * 每个 .refitem 高度是固定的，靠**条数**堆高度，不靠长文案。
 */
export function longRefs(n = 12) {
  const kinds = ['pdf', 'pptx', 'image', 'text', 'other'];
  const names = [
    '2026Q2 辣酱品类货架扫描报告_v3_终版.pdf',
    '竞品视觉资产盘点.pptx',
    '深夜下单场景用户访谈录音转写.txt',
    '电商详情页截图合集.zip',
    '工业风包装材质参考板.pdf',
    '怀旧营销案例汇编.pptx',
    '小红书辣椒酱相关笔记抓取.csv',
    '品牌色彩心理学摘要.md',
    '竞品短视频封面拼版.jpg',
    '线下商超灯光环境实拍.pdf',
    '食品包装法规要点备忘.txt',
    '做旧质感字体样张.pdf',
  ];
  const out = [];
  for (let i = 0; i < n; i++) {
    const kind = kinds[i % kinds.length];
    out.push({
      id: 'rf' + (i + 1),
      name: names[i % names.length],
      kind,
      size: 180000 + i * 47311,
      status: 'done',
      text: kind === 'image' ? undefined : '正'.repeat(1200 + i * 137),
      parseMode: 'fast',
    });
  }
  return out;
}

/** 足量运行日志，用来把右栏撑到可滚动（同 longRefs 的用途） */
export function longLogs(n = 26) {
  const levels = ['ok', 'info', 'warn'];
  const texts = [
    '组合节点已生成：锈住的甜',
    '评分完成，价值 7.6',
    '提示词超时，已退回本地模板',
    '情报卡已落到画布',
    '参考图已压缩至 1280 / 0.72',
    '种子词已展开 6 个维度',
  ];
  /* ts 用固定基准往后推，别用 Date.now() —— 否则今天跑和明天跑截图不一样 */
  const base = Date.parse('2026-10-10T21:34:56');
  return Array.from({ length: n }, (_, i) => ({
    id: 'lg' + (i + 1),
    ts: base - i * 17000,
    level: levels[i % levels.length],
    text: texts[i % texts.length],
  }));
}

/** 有内容的画布：1 颗种子 + 6 个维度共 13 个裂变词 + 2 个概念/组合节点 + 情报卡 + 参考图 */
export function richSeed() {
  const brief = {
    name: '锈色海报', imagery: '铁锈在潮湿空气里缓慢蔓延',
    color: '锈红 #7A3B2E（主色）+ 灰蓝 #4A5D6E（辅助）+ 做旧米白（底）',
    font: '工业黑体，字面带磨损缺口', shape: '剥落边缘、斑驳色块',
    strategy: '用时间痕迹对抗精致感',
  };
  const prompts = {
    gpt: 'A rusty metal poster, 16:9. Charcoal slate background, orange #FF6B2C particles, hard rim light 40deg, 85mm, f/4, 4K.',
    jimeng: '锈色海报，哑光黑立在深灰石板，荧光绿撕裂色带，橙色粒子，硬光 40 度，85mm，--ar 16:9',
    mj: 'rusty metal texture, orange particles, hard light --ar 16:9 --v 6 --style raw',
    negative: '水印、错字、塑料感、过曝',
  };
  const score = {
    v: 2, value: 7.6, quadrant: 'wow', weights: [0.3, 0.25, 0.25, 0.2], cr: 0.04, crPassed: true,
    c1: { score: 8, why: '直接呼应简报里的"时间痕迹"。' },
    c2: { score: 7, why: '锈色在辣酱品类里少见。' },
    c3: { score: 8, why: '实拍加做旧即可实现。' },
    c4: { score: 7, why: '有情绪但不够刺痛。' },
    kano: { attr: 'A', better: 0.62, worse: 0.28, grounded: false, anchored: true, persona: '25-34 独居青年，深夜下单为主', basis: '简报推断' },
    decision: '可作为主视觉方向推进。',
  };
  const dims = [
    { key: 'visual', words: ['氧化层', '金属剥落', '哑光质感'] },
    { key: 'ontic', words: ['时间痕迹', '缓慢腐蚀'] },
    { key: 'sensory', words: ['冰凉触感', '干燥的摩擦'] },
    { key: 'cultural', words: ['工业怀旧', '90年代厂房'] },
    { key: 'opposite', words: ['精致与破败', '脆弱的坚固'] },
    { key: 'phono', words: ['嘶嘶声', '低频共振'] },
  ];
  const nodes = [{ id: 's1', type: 'seed', position: { x: 0, y: 0 }, data: { label: '锈蚀', kind: 'seed', groupId: 's1' } }];
  const edges = [];
  let id = 0;
  for (const d of dims) {
    for (const w of d.words) {
      id++;
      const nid = 'w' + id;
      nodes.push({
        id: nid, type: 'word', position: { x: -300 + (id % 6) * 140, y: 200 + Math.floor(id / 6) * 130 },
        data: { label: w, kind: 'word', groupId: 's1', dim: d.key },
      });
      edges.push({ id: 'e' + id, source: 's1', target: nid });
    }
  }
  nodes.push({
    id: 'c1', type: 'concept', position: { x: 200, y: 500 },
    data: { label: '锈色海报', kind: 'concept', groupId: 's1', brief, score, prompts },
  });
  edges.push({ id: 'ec1-1', source: 'w1', target: 'c1' });
  edges.push({ id: 'ec1-2', source: 'w2', target: 'c1' });
  nodes.push({
    id: 'c2', type: 'concept', position: { x: 600, y: 500 },
    data: {
      label: '锈住的甜', kind: 'concept', groupId: 's1',
      combo: { sourceIds: ['w1', 'w2'], synergy: 7.4, logic: '甜与腐的对冲', advice: '有记忆点', c1: 8, c2: 7, c3: 6, c4: 8, risk: '甜度过高会失去粗粝' },
    },
  });
  edges.push({ id: 'ec2-1', source: 'w1', target: 'c2' });
  edges.push({ id: 'ec2-2', source: 'w2', target: 'c2' });
  nodes.push({
    id: 'i1', type: 'intel', position: { x: -300, y: 500 },
    data: {
      label: '受众画像', kind: 'intel',
      intel: { summary: '25-34 独居青年，深夜下单为主', points: [{ text: '对怀旧工业感有共鸣' }, { text: '愿意为情绪付溢价' }, { text: '短视频是触达主路径' }] },
    },
  });
  nodes.push({ id: 'im1', type: 'image', position: { x: -600, y: 200 }, data: { label: '视觉参考', kind: 'image', images: [] } });
  return {
    brief: '目标人群 25-34 岁独居青年，追求刺激与独特性。使用场景：深夜手机下单。',
    product: '辣椒酱品牌升级', mood: '危险感、冷冽、解压', references: [], nodes, edges, intel: [],
    settings: SETTINGS,
    report: {
      product: '辣椒酱品牌升级', createdAt: '2026-09-07', industry: '辣酱', competitors: [],
      visual: { colors: '锈红 #7A3B2E / 灰蓝 #4A5D6E', tone: '冷峻', font: '工业黑体' },
      swot: { strengths: ['工艺叙事强'], weaknesses: ['认知成本高'], opportunities: ['怀旧情绪上行'], threats: ['同质化'] },
      summary: '用时间痕迹对抗精致感，让"旧"成为可信度而不是缺陷。',
    },
  };
}

const CLICK = { settings: 'AI 设置' };

/**
 * 打开顶栏「⋯ 更多」并点其中一项（`data-act` 见 App.tsx 的 moreItems）。
 *
 * #63 把 交付文档 / 操作说明 / 整理布局 / 适应视图 / 清空 五项从 `.topbar-actions`
 * 收进了这个菜单。于是原来那些 `button:has-text("交付文档")` 的写法**全部失效**——
 * 而且失效得很隐蔽：locator 会一直等到 30s 超时，异常又被 openView 吞成软警告，
 * 探针只报「元素未渲染，跳过」并**照样 exit 0**（这一点已在回归探针里堵掉）。
 *
 * 别在调用点手写 `[data-act="more"]` 两步走：菜单是点开的、有渲染延迟，
 * 少了 waitForSelector 会偶发点空。
 */
export async function openMore(page, act) {
  await page.click('[data-act="more"]');
  await page.waitForSelector(`.more-item[data-act="${act}"]`, { timeout: 5000 });
  await page.click(`.more-item[data-act="${act}"]`);
}

/**
 * 点画布浮动工具条上的一项（`data-act` 见 App.tsx 的 `.float-tools`）。
 *
 * 为什么也抽一个：这三项**第 6 步在 ⋯ 菜单里、第 7 步搬到了浮层**。搬运本身
 * 只是一次 `git mv` 级别的事，但所有"顺手写的选择器"都会跟着失效 —— 而且是
 * 静默失效（locator 一直等到超时）。集中在一处改，改错也只错一处。
 *
 * 与 openMore 的差别：浮层是常驻渲染的，没有"点开菜单"这一步；所以这里
 * 不需要 waitForSelector 去等渲染，只用来把选择器收进一处 + 早点报错。
 */
export async function clickFloat(page, act) {
  const sel = `.float-tool[data-act="${act}"]`;
  await page.waitForSelector(sel, { timeout: 5000 });
  await page.click(sel);
}

/**
 * 视图清单。
 *   seed  写进 localStorage 的数据（走 loadState 白名单）
 *   state 加载后用 store 打的补丁（DEV 下 window.__dd）
 *   after 加载后要做的交互
 */
export const VIEWS = {
  'canvas-empty': { seed: EMPTY_DATA, state: { stage: 'canvas' } },
  /* 真·没配 API Key 的全新用户。
     ⚠️ `canvas-empty` 其实**不是**这种状态：openView 会先铺 richSeed() 再覆盖 view.seed，
     而 richSeed() 带着 `settings: SETTINGS`（apiKey 'mock-key'），EMPTY_DATA 里没有
     settings 这一项，所以键被保留了下来。于是顶栏「配置 API Key」这个分支
     一直没有视图能走到 —— #63 才需要它。 */
  'canvas-nokey': { seed: { ...EMPTY_DATA, settings: { ...SETTINGS, apiKey: '' } }, state: { stage: 'canvas' } },
  'guide-modal': { seed: EMPTY_DATA, state: { stage: 'canvas', guideOpen: true } },
  'canvas-rich': { seed: 'rich' },
  /* 深潜过渡页（2026-10-17）。deepDiving 不在持久化白名单里，只能 setState 注入；
     product 给值，否则副标题会退化成"这个项目"——那是另一种状态，但不是要拍的那张。
     三个视图对应三种真实状态：正常等待 / 已经记了几个词 / 中断。 */
  'diving': {
    seed: { ...EMPTY_DATA, product: '辣椒酱品牌升级', brief: '目标人群 25-34 岁独居青年。' },
    state: { stage: 'diving', deepDiving: true, diveSeeds: [] },
  },
  'diving-notes': {
    seed: { ...EMPTY_DATA, product: '辣椒酱品牌升级', brief: '目标人群 25-34 岁独居青年。' },
    state: { stage: 'diving', deepDiving: true, diveSeeds: ['锈蚀', '开合呼吸', '被压扁的同心圆'] },
  },
  'diving-fail': {
    seed: { ...EMPTY_DATA, product: '辣椒酱品牌升级', brief: '目标人群 25-34 岁独居青年。' },
    state: { stage: 'diving', deepDiving: false, diveSeeds: ['锈蚀'] },
  },
  // 两侧面板都收起：收起把手的宽度、图标、可点性都在这里验。
  // panels 单独播种（见 openView 里的说明），不在 seed 里。
  'panels-collapsed': { seed: 'rich', panels: { left: false, right: false } },
  /* 收起把手「点图标 → 展开并滚到那一区」。
     为什么单开一个视图而不是复用 panels-collapsed：这条路径只有在内容**真的能滚动**
     时才验得动（见 longRefs 的注释），而长内容会让 panels-collapsed 的几何基线跟着变。
     两个视图两个用途，互不牵连。
     六次跳转的结果挂到 window.__railJump，由回归探针的 custom 断言读走。 */
  'rail-jump': {
    seed: 'rich',
    panels: { left: false, right: false },
    data: { references: longRefs(12), intel: INTEL },
    /* logs 在 store 顶层、且不在 saveState 白名单里，播种放不进 localStorage，
       只能 setState 注入（同 log-panel 视图）。这里要的是**长**，不是好看。 */
    state: { logs: longLogs(60) },
    after: async (p) => {
      const rows = [];
      for (const side of ['left', 'right']) {
        /* 把手上的目标直接从 DOM 读，不在这里抄一份 RAIL_SECS。
           抄一份的话，改了 App.tsx 的清单而忘了改夹具，"验的就不是那个界面"——
           而且不会报错。 */
        const ids = await p.$$eval(
          `.side-rail.${side} .side-rail-sec`,
          (els) => els.map((e) => e.dataset.railSec),
        );
        for (const secId of ids) {
          await p.locator(`.side-rail.${side} .side-rail-sec[data-rail-sec="${secId}"]`).click();

          /* smooth 滚动是异步的：等它稳定再读数。比死等一个固定时长稳，
             也比"等到某个足够大的延迟"快。 */
          let prev = null;
          let cur = null;
          for (let i = 0; i < 15; i++) {
            cur = await p.evaluate(({ side, secId }) => {
              const panel = document.querySelector(`.panel-${side}`);
              const sec = panel && panel.querySelector(`[data-sec="${secId}"]`);
              if (!panel || !sec) return { side, secId, err: '面板或区块未渲染' };
              /* .panel 没有 padding-top / border-top，所以"区块在内容坐标系里的位置"
                 就是「相对面板顶的偏移 + 当前 scrollTop」—— 与滚动位置无关，恒等于 S0。 */
              const s0 = (sec.getBoundingClientRect().top - panel.getBoundingClientRect().top)
                + panel.scrollTop;
              const max = panel.scrollHeight - panel.clientHeight;
              /* scroll-padding-top 把滚动口的有效顶部让开 sticky 的 .phead，
                 所以期望落点是 min(S0 - pad, max)，下限 0。 */
              const pad = parseFloat(getComputedStyle(panel).scrollPaddingTop) || 0;
              const head = panel.querySelector('.phead');
              const label = sec.querySelector('.plabel') || sec.firstElementChild;
              return {
                side, secId,
                scrollTop: Math.round(panel.scrollTop),
                s0: Math.round(s0),
                max: Math.round(max),
                pad: Math.round(pad),
                want: Math.round(Math.min(Math.max(0, s0 - pad), max)),
                secTop: Math.round(sec.getBoundingClientRect().top - panel.getBoundingClientRect().top),
                /* 跳完标题有没有被 sticky 头压住 —— 这一条是看图才想起来的：
                   几何上"区块顶对齐到了滚动口顶"是对的，但头盖在上面，标题就没了 */
                labelTop: label ? Math.round(label.getBoundingClientRect().top - panel.getBoundingClientRect().top) : null,
                headH: head ? Math.round(head.getBoundingClientRect().height) : 0,
                panelH: Math.round(panel.clientHeight),
                secH: Math.round(sec.getBoundingClientRect().height),
              };
            }, { side, secId });
            if (cur && prev && Math.abs(cur.scrollTop - prev.scrollTop) < 1) break;
            prev = cur;
            await p.waitForTimeout(120);
          }
          rows.push(cur);
          await p.locator(`.panel-${side} button[title="收起面板"]`).click();
          await p.waitForTimeout(350);
        }
      }
      await p.evaluate((r) => { window.__railJump = r; }, rows);
    },
  },
  // 真实情报卡（左栏 .icard / .ipoint / .conf）——夹具默认 intel 为空，
  // 所以单开一个视图，免得动到其它视图的基线
  'intel-cards': { seed: 'rich', data: { intel: INTEL } },
  /* P6-1（批次 4）：用户便签 + 情报卡便签化。
     为什么单开视图而不是往 rich 里塞两张便签：rich 的节点序列被十几条几何/颜色
     断言当作基线（节点数、坐标、分组色都量过），加两个节点会把那些断言全部惊动。
     新对象类型用新视图，是这套探针一直的做法。
     这里刻意放一黄一鼠尾草：五色板不是装饰，断言要能证明"底色真的来自 D9 那套色值"。 */
  notes: {
    seed: 'rich',
    data: {
      nodes: [
        /* 两个种子各走一条来源分支：带 seedSource（深潜挖的）与不带的（手动加的）。
           徽标必须把两者写得不一样，否则用户回头分不清哪些词是自己放进去的。 */
        ...richSeed().nodes.map((n) =>
          n.data.kind === 'seed'
            ? { ...n, data: { ...n.data, seedSource: '竞品视觉共性 · 红色主导', seedWhy: '简报锁定的刺激感，只有这个词同时勾住感官与痛感' } }
            : n,
        ),
        {
          id: 's-manual', type: 'seed', position: { x: -600, y: 620 },
          data: { label: '橡皮筋', kind: 'seed', groupId: 's-manual' },
        },
        {
          id: 'note-sun', type: 'note', position: { x: 40, y: 760 },
          data: {
            label: '辣不是味道，是痛觉——包装要让手先有感觉。',
            kind: 'note', noteTone: 'sun', noteSource: '项目简报 · 调性',
          },
        },
        {
          id: 'note-sage', type: 'note', position: { x: 300, y: 760 },
          data: { label: '结论：条纹方向改成斜切，别做成规则竖条', kind: 'note', noteTone: 'sage' },
        },
      ],
    },
  },
  /* 帮助条。第 7 步它从**流内全宽条**改成了**画布浮层卡片** —— 这个改动最要紧的
     后果不是颜色或位置，而是"打开它不再把画布整体往下推"。所以这里读**前后**两次
     画布高度：只有"打开前 = 打开后"才证明它真的不占版面。
     单看一张快照是证不出来的（浮层和流内条在静止画面里可能长得一样）。 */
  helpbar: {
    seed: 'rich',
    after: async (p) => {
      const geo = () => p.evaluate(() => {
        const wrap = document.querySelector('.canvas-wrap');
        const rf = document.querySelector('.react-flow');
        return {
          rfH: Math.round(rf.getBoundingClientRect().height),
          wrapH: Math.round(wrap.getBoundingClientRect().height),
          bodyH: Math.round(document.querySelector('.body').getBoundingClientRect().height),
        };
      });
      const before = await geo();
      await clickFloat(p, 'help');
      await p.waitForTimeout(400);
      const after = await geo();
      await p.evaluate((v) => { window.__helpbar = v; }, { before, after });
    },
  },
  /* 画布浮动工具条（#64 新增）。
     hover 态只能在真 hover 里读 —— computed style 读不出 :hover，也没办法在
     evaluate 里强制一个伪类。这里跟 `topbar-hover` 是同一个模式。
     为什么要单验一遍：`.float-tool:hover:not(:disabled)` 的特异度是 (0,3,0)，
     和 `.btn.pri.sm` 同级 —— #63 就在这个层级上栽过一次（`.more-trigger` 的
     padding 被 `.btn.sm` 吃掉，规则写了但从未生效）。所以不能只看"规则写没写"。 */
  'float-tools': {
    seed: 'rich',
    after: async (p) => {
      await p.hover('.float-tool[data-act="fit"]');
      await p.waitForTimeout(300);
      await p.evaluate(() => {
        const el = document.querySelector('.float-tool[data-act="fit"]');
        const cs = getComputedStyle(el);
        window.__floatHover = {
          bg: cs.backgroundColor, color: cs.color,
          /* 规则里写的是 background（简写）—— 它会把没写的 background-image
             重置成 none。这条读出来是为了确认 hover 没顺手把别的东西清掉。 */
          bgImage: cs.backgroundImage,
        };
      });
    },
  },
  /* 底部提示条（staleProduct：记了项目名、但还没跑澄清、画布也空）。
     条件见 App.tsx：stage==='canvas' && product 非空 && !report && clarify 空 && 0 节点。
     EMPTY_DATA 自带 report:null / nodes:[]，只差一个非空 product。 */
  hintbar: { seed: { ...EMPTY_DATA, product: '辣椒酱品牌升级' }, state: { stage: 'canvas' } },
  'node-dock': { seed: 'rich', after: async (p) => { await p.locator('.nd-seed').first().click({ button: 'left' }); await p.waitForTimeout(500); } },
  // 节点详情卡（.nd-body）：由 store.expandedId 驱动，且卡片挂在节点内部
  'node-expanded': {
    seed: 'rich',
    state: { expandedId: 'c1' },
    after: async (p) => {
      /* 「适应视图」在画布浮动工具条上（第 7 步从 ⋯ 菜单搬来）；这里**故意不加
         .catch()** —— 它一旦点不中，这一屏的取景就不是我们要验的那一屏，
         静默吞掉等于拿一个"没摆好"的画面去验详情卡。 */
      await clickFloat(p, 'fit');
      await p.waitForTimeout(900);
    },
  },
  'ctx-menu': { seed: 'rich', after: async (p) => { await p.locator('.react-flow__pane').click({ button: 'right', position: { x: 500, y: 300 } }); await p.waitForTimeout(400); } },
  /* #101 收口：详情卡滚窗**随视口长**（那一档见 node-expanded），这里取矮视口验反方向。
     为什么必须两档：只测一档证明不了"随视口变"——300px 死值在高视口下也能凑巧通过。
     1600×700 → 画布 610px，52vh = 364px；卡总高要留在画布内，滚窗就得跟着缩。 */
  'node-expanded-short': {
    seed: 'rich',
    state: { expandedId: 'c1' },
    after: async (p) => {
      await p.setViewportSize({ width: 1600, height: 700 });
      await p.waitForTimeout(400);
      await clickFloat(p, 'fit');
      await p.waitForTimeout(900);
    },
  },
  /* #101 收口：窄画布下的工具条。
     为什么要单独一屏：坏区间是**视口 901–1082px**（画布 = 视口 − 面板 568），
     1920 档下画布 1248px，怎么测都是 ✓ —— 这正是这个 bug 活了这么久的原因。
     1024×768 是真实在用的最小笔电档，画布只剩 456px。
     夹具负责把视口摆到位（同 float-stack 的做法），探针只读结果。 */
  'narrow-canvas': {
    seed: 'rich',
    after: async (p) => {
      await p.setViewportSize({ width: 1024, height: 768 });
      await p.waitForTimeout(700);
      /* 顺手把「+ 新建」浮层点开：窄画布下它探不探出左缘，只有真开一次才知道。
         刻意用 DOM click 而不是 page.click —— 万一这一档真有遮挡，
         page.click 会 30s 超时并把 after 打挂，那样两条断言都会"读不到"，
         而不是"报出越界尺寸"。 */
      await p.evaluate(() => document.querySelector('.float-tool[data-act="create"]')?.click());
      await p.waitForTimeout(400);
    },
  },
  /* 节点右键菜单：与画布右键是**两套 items**（nodeItems / paneItems）。
     单开一个视图，是为了钉住「加了画布右键的『添加参考图』之后，
     节点右键的『挂载参考图』没被改错」—— 两者的语义不同：
     前者在原地建 image 节点，后者把图挂到已有节点上。 */
  'ctx-menu-node': {
    seed: 'rich',
    after: async (p) => {
      await p.locator('.nd-seed').first().click({ button: 'right', position: { x: 20, y: 10 } });
      await p.waitForTimeout(400);
    },
  },
  /* 画布右键 →「添加参考图」的**端到端**：真的选一个文件进去，
     验证在右键位置生成了 image 节点。只断言菜单里有这一项是不够的 ——
     菜单项可能根本没接上（点了没反应），那种情况属性断言查不出来。 */
  'ctx-menu-img': {
    seed: 'rich',
    after: async (p) => {
      /* ⚠️ `rich` 种子**自带一个** image 节点（im1「视觉参考」，images 为空），
         所以断言不能只数"画布上有几个 image 节点" —— 那个数从一开始就是 1。
         先把已有的 id 记下来，之后才能算出"新建了哪几个"。 */
      const before = await p.evaluate(() =>
        window.__dd.getState().nodes.filter((n) => n.data.kind === 'image').map((n) => n.id),
      );
      await p.locator('.react-flow__pane').click({ button: 'right', position: { x: 500, y: 300 } });
      await p.waitForTimeout(400);
      await p.click('.ctx-i:has-text("添加参考图")');
      /* ⚠️ 必须用 data-act 精确定位，不能写 `input[type=file]`：
         节点内部（nodes.tsx 的「加参考图」）也有 file input，
         宽泛选择器会设到那一个上去，于是本视图测的其实是"节点上传"，
         画布层那个 input 根本没被触发 —— 而这正是第一版报"没新增节点"的原因。 */
      await p.waitForSelector('[data-act="canvas-img-pick"]', { state: 'attached', timeout: 5000 });
      /* 1×1 的合法 PNG。应用会用 canvas 把它压到 1280，所以必须是真的 PNG
         而不是伪造的后缀 —— 否则 ingest 会在解码时失败，而那正是我们要抓的。 */
      await p.setInputFiles('[data-act="canvas-img-pick"]', {
        name: '参考图.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
      await p.waitForTimeout(2000);
      await p.evaluate((ids) => { window.__imgBefore = ids; }, before);
    },
  },
  // 主行动点 hover：④ 的渐变会不会被 `.btn:hover` 的 background **简写**重置掉。
  // 这条只能真去 hover —— computed style 读不出 :hover 态，也没有办法在 evaluate 里
  // 强制一个伪类。所以 hover 放在 after 钩子里，结果挂 window 给 custom 断言读。
  'topbar-hover': {
    seed: 'rich',
    after: async (p) => {
      await p.hover('.topbar-actions .btn.pri');
      await p.waitForTimeout(300);
      await p.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('.topbar-actions .btn.pri'));
        window.__priHover = { bgImage: cs.backgroundImage, color: cs.color, boxShadow: cs.boxShadow };
      });
    },
  },
  // ⋯ 菜单展开（结构 + 危险项 + 禁用态）
  'more-menu': { seed: 'rich', after: async (p) => { await p.click('[data-act="more"]'); await p.waitForTimeout(300); } },
  /* 没简报时「交付文档」应当是禁用的 —— 单开一个视图，因为 rich 种子自带 report。 */
  'more-menu-nodoc': { seed: 'rich', data: { report: null }, state: { stage: 'canvas' }, after: async (p) => { await p.click('[data-act="more"]'); await p.waitForTimeout(300); } },
  /* 硬验收：「各按钮功能仍可达（逐个点一遍）」。
     收进菜单、再搬到浮层，都不等于功能还在 —— 菜单项/浮层按钮可能根本没接上、
     或被 disabled 卡死。所以真的一项一项点，每一项都要有**可见后果**，
     结果挂 window.__moreReach。

     #63 时这里点的是菜单里的 5 项；#64 把 视图操作 三项搬到 `.float-tools` 浮层后，
     这里变成 **菜单 2 项 + 浮层 3 项**。判据不变（点得动 + 有后果），
     只是入口分了两处 —— 这本身就是这一步要验的东西。 */
  'more-reach': {
    seed: 'rich',
    after: async (p) => {
      const r = {};
      const openMenu = async () => { await p.click('[data-act="more"]'); await p.waitForTimeout(220); };
      const pos = () => p.evaluate(() => window.__dd.getState().nodes.map((n) => `${Math.round(n.position.x)},${Math.round(n.position.y)}`).join('|'));
      /* 视口读成 {x, y, s}。computed transform 在 Chrome 里会被解析成
         matrix(a, b, c, d, e, f)：位移在 e/f，无旋转时缩放就是 a。 */
      const vp = () => p.evaluate(() => {
        const m = getComputedStyle(document.querySelector('.react-flow__viewport')).transform;
        const n = (m.match(/-?[0-9.]+/g) || []).map(Number);
        return n.length === 6 ? { raw: m, x: n[4], y: n[5], s: n[0] } : { raw: m, x: NaN, y: NaN, s: NaN };
      });
      const near = (a, b) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2 && Math.abs(a.s - b.s) < 0.02;

      /* 顺手记一下菜单里到底剩几项：这是本步的核心事实（5 → 2），
         后续任何"又往菜单里塞东西"的改动都会在这里露出来。 */
      await openMenu();
      r.menuItems = await p.locator('.more-item').count();
      r.menuActs = await p.$$eval('.more-item', (els) => els.map((e) => e.dataset.act));
      await p.keyboard.press('Escape');
      await p.waitForTimeout(250);

      // ① 操作说明（浮层）→ .helpbar 出现
      await clickFloat(p, 'help');
      await p.waitForTimeout(350);
      r.help = await p.locator('.helpbar').count();
      await p.click('.helpbar .icon-btn').catch(() => {});
      await p.waitForTimeout(300);

      // ② 交付文档（菜单）→ .modal-doc 出现
      await openMenu();
      await p.click('.more-item[data-act="doc"]');
      await p.waitForTimeout(800);
      r.doc = await p.locator('.modal-doc').count();
      await p.click('.modal-doc .modal-h .icon-btn').catch(() => {});
      await p.waitForTimeout(350);

      // ③ 整理布局（浮层）：节点坐标应当真的被重排
      const p0 = await pos();
      await clickFloat(p, 'tidy');
      await p.waitForTimeout(1000);
      r.tidyMoved = (await pos()) !== p0;

      /* ④ 适应视图（浮层）。
         ⚠️ 这里**不能**写成「记下当前 transform → 点一下 → 断言变了」：
         useTidy 整理完自己会跟一次 fitView（src/lib/useTidy.ts:18），
         所以 ③ 之后视口恰好就停在 fit 态，此时点「适应视图」本来就是个
         no-op。第一版就是这么写的，断言恒假（实测 fitMoved=false）。
         正确做法：先用**真实滚轮**把视口挪开，把前置条件建立起来，再点；
         并同时断言「点了真的动」+「动完回到 fit 态」——只证"动了"是不够的。 */
      const tFit = await vp();                        // ③ 整理后 = 真实 fit 态
      const box = await p.locator('.react-flow').boundingBox();
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      /* 向上滚 = 放大。刻意取中段的 200/次 ×2：minZoom 0.15 / maxZoom 2.2
         两边都留余量，扰动值不会被钳住 —— 否则判据会退化成"从钳位值恢复"，
         中段的常规情形反而没被覆盖。 */
      for (let i = 0; i < 2; i++) { await p.mouse.wheel(0, -200); await p.waitForTimeout(150); }
      await p.waitForTimeout(500);
      const tOff = await vp();
      r.fitPerturbed = !near(tOff, tFit);             // 前置条件是否真的成立
      r.fitZoom = [tFit.s, tOff.s].map((v) => Number(v.toFixed(3)));

      await clickFloat(p, 'fit');
      await p.waitForTimeout(1400);
      const tBack = await vp();
      r.fitMoved = !near(tBack, tOff);                // 真的动了
      r.fitRestored = near(tBack, tFit);              // 而且回到了 fit 态
      r.fitBackZoom = Number(tBack.s.toFixed(3));

      // ⑤ 清空（菜单，危险键）→ ConfirmDialog → 取消后内容还在
      await openMenu();
      await p.click('.more-item[data-act="clear"]');
      await p.waitForTimeout(450);
      r.confirm = await p.locator('.modal[role="alertdialog"]').count();
      r.danger = await p.locator('.modal[role="alertdialog"] .modal-f .btn.danger').count();
      await p.click('.modal[role="alertdialog"] .modal-f .btn.ghost');
      await p.waitForTimeout(400);
      r.confirmGone = (await p.locator('.modal[role="alertdialog"]').count()) === 0;
      r.nodesKept = await p.evaluate(() => window.__dd.getState().nodes.length);

      await p.evaluate((v) => { window.__moreReach = v; }, r);
    },
  },
  settings: { seed: 'rich', after: async (p) => { await p.click(`button:has-text("${CLICK.settings}")`); await p.waitForTimeout(400); } },
  'report-drawer': { seed: 'rich', state: { reportOpen: true } },
  /* 交付文档 / 清空 都已收进 ⋯ 菜单 —— 必须走 openMore 打开菜单再点，
     直接 `button:has-text(...)` 会 30s 超时且被吞成软警告（见 openMore 的说明）。 */
  'doc-modal': { seed: 'rich', after: async (p) => { await openMore(p, 'doc'); await p.waitForTimeout(600); } },
  'confirm-dialog': { seed: 'rich', after: async (p) => { await openMore(p, 'clear'); await p.waitForTimeout(400); } },
  'stage-clarify': { seed: 'rich', state: { stage: 'clarify' } },
  'stage-report': { seed: 'rich', state: { stage: 'report' } },
  // 组合节点展开 → ComboSection（协同度大数 + 四维条）。
  // 现夹具默认展开的是概念节点 c1，够不到这一屏，所以单开一个视图。
  'combo-expanded': {
    seed: 'rich',
    state: { expandedId: 'c2' },
    after: async (p) => {
      await clickFloat(p, 'fit');
      await p.waitForTimeout(900);
    },
  },
  // 运行日志：logs 在 store 顶层（useStore.ts:231），初始为空数组，
  // 且 saveState 不持久化它——所以只能 setState 注入。
  // ts 用固定值，避免"今天跑和明天跑截图不一样"。
  'log-panel': {
    seed: 'rich',
    state: {
      logs: [
        { id: 'lg1', ts: Date.parse('2026-10-10T21:34:56'), level: 'ok', text: '组合节点已生成：锈住的甜' },
        { id: 'lg2', ts: Date.parse('2026-10-10T21:34:41'), level: 'info', text: '评分完成，价值 7.6' },
        { id: 'lg3', ts: Date.parse('2026-10-10T21:33:08'), level: 'warn', text: '提示词超时，已退回本地模板' },
      ],
    },
  },
  // 让画布上出现 NodesSelection（F8 组合收敛条需要它）
  'canvas-selected': {
    seed: 'rich',
    after: async (p) => {
      await p.evaluate(() => {
        window.__dd.setState((s) => ({
          nodes: s.nodes.map((n) => ({ ...n, selected: ['w1', 'w2', 'w3'].includes(n.id) })),
          selection: ['w1', 'w2', 'w3'],
        }));
      });
      await p.waitForTimeout(700);
    },
  },
  /* 状态栏**随设置实时更新**：在页面里改 settings.cloudToken，状态应当自己变。
     原来 sync 只在启动那一次 pullCloud 之后写，用户填好令牌必须刷新页面才看到变化
     （第 8 步 §11.7 记过这个限制）。这一屏是那条限制的解药。 */
  'statusbar-live': {
    seed: 'rich',
    after: async (p) => {
      const read = () => p.evaluate(() => document.querySelector('.statusbar')?.dataset.sync ?? null);
      const before = await read();
      /* 只改令牌、别的都不动：判定顺序里「没填令牌」在探测之前，
         所以改完应该从 no-token 走到 error（真去 ping，被 403 拒）。 */
      await p.evaluate(() => {
        window.__dd.setState((st) => ({ settings: { ...st.settings, cloudToken: 'probe-token' } }));
      });
      await p.waitForTimeout(2500);
      const after = await read();
      await p.evaluate((v) => { window.__syncFlip = v; }, { before, after });
    },
  },
  /* 折叠组的三种状态各一个视图。分开是因为「打开后」这件事没法在 custom 里验 ——
     React/DOM 的交互要么在夹具里做完等稳定，要么在 custom 里点完立刻读
     （那是"还没渲染"不是"没打开"，第 8 步已经吃过一次这个亏）。 */
  'fold-open': {
    seed: 'rich',
    after: async (p) => {
      await p.click('.fold-sum');
      await p.waitForTimeout(400);
    },
  },
  'fold-key': {
    seed: 'rich',
    after: async (p) => {
      /* 键盘路径：focus 到 summary 再 Enter。单独一个视图是因为它要断言的是
         「Tab 得到、Enter 能开」这条无障碍底线，与鼠标路径是两回事。 */
      await p.evaluate(() => document.querySelector('.fold-sum').focus());
      await p.keyboard.press('Enter');
      await p.waitForTimeout(400);
    },
  },
  /* 节点右键「挂载参考图」的端到端。
     它与画布的「添加参考图」共用同一个 input，而**修复之前这一侧也是坏的**
     （input 随菜单卸载）。所以要单独验一次：同一个节点挂上去了，
     而且**没有**多出 image 节点 —— 挂载与新建是两种语义，不能串。 */
  'ctx-menu-mount-img': {
    seed: 'rich',
    after: async (p) => {
      const before = await p.evaluate(() => {
        const n = window.__dd.getState().nodes.find((x) => x.data.kind === 'seed');
        return { id: n.id, imgs: (n.data.images || []).length, nodes: window.__dd.getState().nodes.length };
      });
      await p.locator('.nd-seed').first().click({ button: 'right', position: { x: 20, y: 10 } });
      await p.waitForTimeout(400);
      await p.click('.ctx-i:has-text("挂载参考图")');
      await p.waitForSelector('[data-act="canvas-img-pick"]', { state: 'attached', timeout: 5000 });
      await p.setInputFiles('[data-act="canvas-img-pick"]', {
        name: 'mount.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
      await p.waitForTimeout(2000);
      await p.evaluate((b) => { window.__mountBefore = b; }, before);
    },
  },
  /* 点状态栏的同步项 → 应打开 AI 设置。
     ⚠️ 必须在**夹具**里点、探针里读：React 的 setState 是异步批处理的，
     在 page.evaluate 里 click 完立刻查 .modal 必然拿到 null —— 那是"还没渲染"，
     不是"没打开"。第一版把这条写进 custom，结果稳定假失败。 */
  'statusbar-click': {
    seed: 'rich',
    after: async (p) => {
      await p.click('.sb-sync.act');
      await p.waitForTimeout(700);
    },
  },
  /* 画布浮层：.float-tools + .combo-bar + .helpbar 同屏（第 7 步）。
     单看任何一块的截图都发现不了 —— 必须让它们同屏。所以这一屏刻意把
     底部工具条（常驻）+ 选区批量条（多选浮现）+ 顶部帮助卡（手动开）摆在一起，
     一条断言覆盖全部三对组合。
     ⚠️ 这三块在真实使用里都能同时出现：选中 ≥2 个节点、再点「操作说明」。 */
  'float-stack': {
    seed: 'rich',
    after: async (p) => {
      /* ⚠️ 必须先**把视口调窄**。
         探针默认 1920×1080，画布 1248px 宽 —— 391px 的选区条（靠右 18）和
         294px 的工具条（居中）各自都有地方站，**重叠根本测不出来**（实测：三对全"分离 ✓"）。
         而 1600 档下它们重叠 92px。这个视图存在的唯一理由就是窄画布下的这条风险，
         所以它自己负责把视口摆到位，不指望调用方传。
         1440 → 画布 768px，两个底部条的重叠 172px，怎么改都藏不住。 */
      await p.setViewportSize({ width: 1440, height: 900 });
      await p.waitForTimeout(500);
      await p.evaluate(() => {
        window.__dd.setState((s) => ({
          nodes: s.nodes.map((n) => ({ ...n, selected: ['w1', 'w2', 'w3'].includes(n.id) })),
          selection: ['w1', 'w2', 'w3'],
        }));
      });
      await p.waitForTimeout(600);
      /* ⚠️ 这里**刻意绕过 Playwright 的可点性检查**（直接派发 DOM click），不用 clickFloat。
         被 `.combo-bar` 盖住时 `page.click()` 会一直等"元素可接收点击"→ 30s 超时 →
         after 抛异常 → .helpbar 根本没出现 → "重叠"那条断言只能报「未渲染」，
         报不出真实的重叠尺寸（实测就是这么丢了一次证据）。
         "点得到还是点不到"由探针的 elementFromPoint 那条负责，夹具不该重复一遍、
         更不该因此打断取证。 */
      await p.evaluate(() => document.querySelector('.float-tool[data-act="help"]').click());
      await p.waitForTimeout(400);
    },
  },
};

/**
 * 打开一个视图。
 * @returns {{ ctx, page, errors, close }}
 */
export async function openView(browser, name, opts = {}) {
  const view = VIEWS[name];
  if (!view) throw new Error(`未知视图：${name}`);
  const viewport = opts.viewport || { width: 1600, height: 950 };
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: opts.deviceScaleFactor || 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));

  const base = view.seed === 'rich' ? richSeed() : { ...richSeed(), ...view.seed };
  const seeded = view.data ? { ...base, ...view.data } : base;
  await page.addInitScript((s) => {
    localStorage.setItem('deepdiving.v1', s.data);
    localStorage.setItem('dd.guideDismissed', '1');
    localStorage.setItem('dd.briefDock', JSON.stringify({ x: null, y: null, collapsed: true }));
    /* 侧栏开合是**设备级偏好**（App.tsx 的 PANEL_KEY = 'dd.panels'），
       不在 deepdiving.v1 的持久化白名单里 —— 想拿"收起态"必须单独播种这个键，
       指望它跟着 seed 走是拿不到的。 */
    if (s.panels) localStorage.setItem('dd.panels', JSON.stringify(s.panels));
  }, { data: JSON.stringify(seeded), panels: view.panels || null });

  await page.goto(opts.url || URL, { waitUntil: 'load' });
  await page.waitForSelector('.app', { timeout: 15000 });
  await page.waitForTimeout(1200);

  if (view.state) {
    const msg = await page.evaluate((patch) => {
      if (!window.__dd) return 'window.__dd 不存在（不在 DEV 模式？）';
      window.__dd.setState(patch);
      return null;
    }, view.state);
    if (msg) errors.push(msg);
    await page.waitForTimeout(400);
  }

  if (view.after) {
    try { await view.after(page); } catch (e) { errors.push('after: ' + e.message); }
  }
  await page.waitForTimeout(300);

  return { ctx, page, errors, close: () => ctx.close() };
}
