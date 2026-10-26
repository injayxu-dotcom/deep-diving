/**
 * 本地 mock LLM 服务（仅用于端到端测试）。
 * 按请求内容里的标记词返回对应的 OpenAI 兼容 SSE 流，无需真实 API Key。
 * 用法：node tools/mock-ai.mjs  然后端口 8788
 */
import http from 'node:http';

const PORT = 8788;

function payloadFor(messages) {
  // 多模态请求：content 是数组，必须先判断，否则拼字符串会变成 [object Object]
  const imgCount = (messages || []).reduce((n, m) => {
    if (!Array.isArray(m.content)) return n;
    return n + m.content.filter((p) => p && p.type === 'image_url').length;
  }, 0);
  const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p && p.type === 'text').map((p) => p.text).join('\n'));

  if (imgCount > 0) {
    // P6-3：四维分开问，一次只答一件事。mock 按提问里的标记词回不同维度——
    // 全返回同一段的话，e2e 就验不出「提取构图不会把风格也写进去」
    const ask = (messages || []).map(textOf).join('\n');
    if (ask.includes('提取这批图的风格')) {
      return {
        text: '冷静克制的科技感，属于 2010 年代后期的极简主义延伸：大面积留白 + 单一强调色，没有手绘或有机质感的介入。',
        tags: ['极简', '硬边', '冷调科技'],
      };
    }
    if (ask.includes('提取这批图的构图')) {
      return {
        text: '上下分割构图，主体压在画面下三分之一处，视线自左上向右下走；留白集中在右侧，色块之间是硬边拼接，没有渐变过渡。',
        tags: ['上下分割', '硬边拼接'],
      };
    }
    if (ask.includes('提取这批图的排版')) {
      return {
        text: '无衬线体，字重偏粗，字面宽窄适中，笔画末端做平切处理；信息层级靠字重落差而非字号落差区分。',
        tags: ['无衬线', '平切笔端'],
      };
    }
    // 兜底：老版一次性读图（存量夹具还在用）
    return {
      palette: '主色为深海军蓝 #1B3A5C，点缀生物荧光青 #00B8C4，形成冷暖强对比',
      font: '无衬线体，字重偏粗，字面宽窄适中，笔画末端做平切处理',
      layout: '上下分割构图，色块硬边拼接，无渐变过渡，留白集中在右侧',
      material: '哑光覆膜，无烫金/UV 工艺，摄影为平光正面拍摄',
      mood: '冷静中带一丝科技感，情绪克制，不煽动',
      summary: '这批图共性在于硬边色块 + 冷暖双色对冲；空白在于完全没有手绘或有机质感的介入',
    };
  }

  const user = (messages || []).filter((m) => m.role === 'user').map(textOf).join('\n');

  if (user.includes('请完成三件事')) {
    return {
      report: {
        industry:
          '国内辣酱赛道目前由老干妈（份额领先，视觉三十年几乎未变，玻璃罐 + 红标 + 头像，靠国民认知度取胜）、虎邦（主打外卖小罐装，视觉年轻，用插画和网感文案切入一人食场景）、饭扫光（偏下饭菜品类，视觉走家常亲切路线）、川娃子（近年增长快，视觉更接近新消费品牌，用明快撞色和短文案）四家主导。做得比较好的是虎邦和川娃子：前者用"小罐 + 一人食"重新切分了场景，后者把辣酱从"调料"重新定位成"内容型零食"，包装在电商详情页里识别度明显高于传统竞品。整体痛点在于：绝大多数品牌仍在用"红 + 金 + 书法字"这套传统符号，视觉同质化严重。',
        competitors: [
          {
            name: '老干妈',
            feature: '红底白字 + 创始人头像，三十年不变的国民符号，强调正宗与信任',
            audience: '全年龄段家庭用户，厨房常备，价格敏感，复购靠习惯',
          },
          {
            name: '虎邦',
            feature: '小罐装 + 插画风 + 网感文案，视觉明快，主打一人食与外卖场景',
            audience: '18-30 岁独居青年，点外卖高频，愿意为便利与情绪付溢价',
          },
          {
            name: '川娃子',
            feature: '撞色块面 + 短促标语，视觉接近新消费品牌，社媒传播导向',
            audience: '20-32 岁内容消费者，容易被短视频种草，重视包装出片率',
          },
          {
            name: '饭扫光',
            feature: '家常摄影 + 暖橙色调，强调"下饭"的功能利益点',
            audience: '三四线城市家庭主妇，关注性价比与实用性',
          },
        ],
        visual: {
          colors: '主色高度集中：正红 #C8102E 或朱红 #D6453D 占绝大多数，辅以金色 #C9A227 描边点缀；新兴品牌开始尝试亮橙 #FF6B2C 与荧光绿 #B4FF3A',
          tone: '明度中等偏高、饱和度高、暖调占绝对主导，冷色几乎不出现',
          font: '传统品牌以书法体与粗宋体为主，字面饱满带飞白；新消费品牌转向粗黑无衬线，字重 700 以上，常用字间距压缩制造紧张感',
        },
        swot: {
          strengths: ['可以把"辣"从味觉跨模态转译成触觉痛感，这个位置目前无人占据', '深色底 + 荧光色的组合在同品类中几乎空白，小屏识别度优势明显'],
          weaknesses: ['缺少品牌资产积累，货架端辨识度弱于老干妈这类国民符号', '高饱和荧光色的印刷成本与色差控制难度高于常规四色'],
          opportunities: ['深夜手机下单场景成为主流，纯黑底 + 高对比配色在 OLED 屏上天然占优', 'Z 世代把辣酱当情绪消费品而非调味品，为"危险感""解压"这类表达留出空间'],
          threats: ['传统品牌一旦启动年轻化改造，会凭借渠道优势快速挤压差异化空间', '荧光色系与食品安全品类的"警示联想"存在冲突，处理不当会引发不适'],
        },
        summary:
          '这个品类的视觉高度固化在"红金 + 书法字"上，真正的空白不在于换个颜色，而在于换一套感官通道——把辣从味觉翻译成触觉痛感与危险警示，用深色底 + 荧光色建立小屏时代的识别度。',
      },
      cards: {
        audience: {
          title: '受众画像',
          summary: '25-34 岁独居青年，深夜下单，重包装颜值',
          points: [
            { text: '年龄集中在 25-34 岁，独居或合租，厨房使用频率低', confidence: '中' },
            { text: '习惯在 22 点后刷短视频下单，包装需在手机闪光灯下好看', confidence: '低' },
            { text: '对"下饭"的功能诉求弱于对"情绪发泄"的诉求', confidence: '中' },
          ],
        },
        competitor: {
          title: '竞品视觉共性',
          summary: '红色主导 + 书法字体 + 传统纹样',
          points: [
            { text: '约八成竞品使用正红或朱红作为主色', confidence: '高' },
            { text: '字体普遍为书法体或粗宋体，强调"手工""古法"', confidence: '高' },
            { text: '版式多为居中对称，配传统纹样边框', confidence: '中' },
          ],
        },
        opportunity: {
          title: '机会空白点',
          summary: '竞品均偏传统，缺乏年轻化与解压感',
          points: [
            { text: '尚无人占据"高警示度""危险感"的视觉位置', confidence: '中' },
            { text: '深色背景 + 荧光色的组合在同品类中几乎空白', confidence: '中' },
            { text: '可以把"辣"从味觉转译成触觉痛感，属于跨模态空白', confidence: '低' },
          ],
        },
      },
      seeds: [
        { word: '灼烧后的麻木感', why: '把味觉转译成触觉，是品类里没人做过的感官通道切换', source: '来自 SWOT 机会项：把辣从味觉翻译成触觉痛感' },
        { word: '警示条纹的斜切', why: '直接对应高警示度视觉位置，且是现成的可绘制图形语言', source: '来自机会空白点：尚无人占据高警示度的视觉位置' },
        { word: 'OLED 屏上的纯黑', why: '从使用场景反推视觉决策，深色底在小屏上识别度天然占优', source: '来自 SWOT 机会项：深夜手机下单场景' },
        { word: '荧光绿的食品禁忌', why: '荧光色与食品安全的冲突本身就是一个可玩的张力', source: '来自 SWOT 威胁项：荧光色与食品安全的警示联想冲突' },
      ],
    };
  }

  if (user.includes('请输出三张情报卡片')) {
    return {
      audience: {
        title: '受众画像',
        summary: '25-34 岁独居青年，深夜下单，重包装颜值',
        points: [{ text: '年龄集中在 25-34 岁，独居或合租', confidence: '中' }],
      },
      competitor: {
        title: '竞品视觉共性',
        summary: '红色主导 + 书法字体 + 传统纹样',
        points: [{ text: '约八成竞品使用正红或朱红作为主色', confidence: '高' }],
      },
      opportunity: {
        title: '机会空白点',
        summary: '竞品均偏传统，缺乏年轻化与解压感',
        points: [{ text: '尚无人占据高警示度的视觉位置', confidence: '中' }],
      },
    };
  }

  if (user.includes('裂变维度')) {
    const dim = (user.match(/裂变维度：(\S+?)（/) || [])[1] || '联想';
    const bank = {
      视觉联想: ['轮廓像字母 J', '辣椒籽的密集颗粒', '辣酱飞溅的放射状', '干辣椒的褶皱阴影', '剖面里的胎座脉络', '油光在表皮的高光条'],
      本体延伸: ['史高维尔指数的刻度', '灼烧后的麻木感', '籽与胎座的分离', '干燥后的脆裂', '发酵中的气泡上浮'],
      感官通感: ['滚烫金属贴近皮肤', '指甲划过黑板的锐响', '伤口结痂时的紧绷', '砂纸打磨木头的阻滞'],
      文化隐喻: ['川渝码头的纤夫号子', '江湖菜的大铁锅', '辣椒作为嫁妆的旧俗', '移民餐桌上的身份标识'],
      反义对冲: ['冰镇后的迟钝', '薄荷的冷感回冲', '手术台的无影灯', '利多卡因注射后的空白'],
      谐音字形: ['拉（拉伸）的橡皮筋', '辣与"落"的方言同音', '"辛"字形的刀口', '辣字左边"辛"的对称切割'],
    };
    const words = bank[dim] || ['锈蚀铁皮的锯齿断面', '瓦楞纸的平行沟槽', '显微镜下的孢子囊', '被踩扁的易拉罐', '干涸河床的龟裂', '荧光警示条的斜纹'];
    return {
      words: words.map((w) => ({ word: w, why: `「${w}」是可直接绘制的具象物象，避开了热情/火焰一类的套路表达` })),
    };
  }

  if (user.includes('判断关系类型')) {
    return { type: 'opposite', reason: '两者在感官温度上形成冷热对冲，适合做视觉反差' };
  }

  if (user.includes('请撰写创意概念简报')) {
    const name = (user.match(/创意概念：(\S+)/) || [])[1] || '未命名';
    return {
      name,
      imagery: '能量爆发、动态撕裂、荧光警示',
      color: '荧光绿 #B4FF3A（主色）+ 纯黑 #0A0A0A（背景）+ 亮橙 #FF6B2C（点缀）',
      font: '粗壮的无衬线体，字面带锐利切角，笔画末端做撕裂处理',
      shape: '放射状线条、飞溅粒子、抽象化的火焰轮廓',
      strategy: '用视觉上的不安定感与高警示度，击中 Z 世代追求刺激与独特性的心理机制——他们买的不是辣，是"敢不敢"',
    };
  }

  if (user.includes('按七要素生成三条')) {
    return {
      gpt: 'A brand key visual for a chili sauce, 16:9 horizontal. A single matte-black bottle stands dead centre on a slab of charcoal slate, its surface broken by a torn diagonal band of fluorescent green #B4FF3A that reads as a warning stripe rather than decoration. Around the base, a ring of fine orange #FF6B2C particles suspended mid-air, caught between falling and flying. Hard rim light from the upper left at roughly 40 degrees cuts a bright edge along the bottle shoulder; everything else falls into deep, nearly black shadow with a light ratio around 8:1. Shot straight on at eye level, 85mm, f/4 — the bottle sharp, the particle field gently soft. The palette holds three values only: #0A0A0A, #B4FF3A, #FF6B2C, with no fourth colour anywhere in frame. The upper third is deliberately empty; that negative space is where the wordmark sits, set in a heavy sans-serif with cut terminals, so nothing visual competes with it. Photorealistic product photography, ultra-detailed, 4K.',
      jimeng:
        '品牌 KV 主视觉，一瓶哑光黑辣酱立在深灰石板台面上，瓶身被一道荧光绿撕裂色带斜切而过，底部悬浮着一圈橙色飞溅粒子，硬光从左上 40 度打过来勾出瓶肩亮边，其余部分沉进接近纯黑的阴影里，光比约 8:1，正机位平视，85mm，f/4 浅景深，暗调高对比，颗粒质感，商业产品摄影，超高清，--ar 16:9',
      mj: 'abstract flame with torn edges, intense burning sensation, fluorescent green #B4FF3A and pure black high contrast, sharp angular sans-serif typography, radial burst lines, splash particles, minimalist modern packaging design, studio lighting --ar 16:9 --v 6.0 --style raw',
      negative: '文字错字、多余手指、过曝、塑料感、低清、水印、画面元素杂乱',
    };
  }

  if (user.includes('请评估')) {
    return {
      match: 8.5,
      diff: 9,
      reasons: [
        '简报目标人群为 25-34 岁独居青年，追求刺激与独特性，"灼烧感"的高警示度直接对位这一心理诉求',
        '竞品共性为"正红 + 书法体 + 对称版式"，本概念的荧光绿 + 撕裂边缘与之形成强反差，避开了同质化',
        '使用场景是深夜手机下单，纯黑底 + 荧光色在小屏高对比环境下识别度显著优于传统红金配色',
      ],
      advice: '强烈推荐作为核心视觉方向，差异度尤其突出，建议直接进入执行阶段',
    };
  }

  // V2 评分链路三段：AHP 权重 → C1-C4 锚点打分 → KANO 属性。
  // 标记词取自 src/lib/prompts.ts，别改 prompt 文案导致 mock 静默降级成 echo。
  if (user.includes('请为这个项目做 6 次两两比较')) {
    // 全填 1 = 等权，CR=0 必然通过一致性检验，且不给默认权重兜底路径添乱
    return { p12: 1, p13: 1, p14: 1, p23: 1, p24: 1, p34: 1, reason: '四个准则对本项目同等重要' };
  }

  if (user.includes('请按上面的锚点给 C1-C4 打分')) {
    return {
      c1: { score: 7, why: '命中简报里"危险感 + 解压并存"的核心诉求，但没覆盖家庭场景这个次人群，所以不到满分。' },
      c2: { score: 8.5, why: '荧光绿对绝大多数走"红金"的竞品是直接相反的主色选择，视觉差异足够；但深色底已被个别新消费品牌用过，独创性略打折。' },
      c3: { score: 6, why: '抽象撕裂形态可以靠后期合成实现，工艺成本都在可控范围；但要做成包装而不是海报，还缺一层可落地的结构翻译。' },
      c4: { score: 7.5, why: '"荧光色的食品禁忌"这个张力能让人多看一眼，有情绪记忆点；但整体意象仍偏视觉惯性，缺一个反直觉的锚。' },
    };
  }

  if (user.includes('请按上述步骤判定')) {
    return {
      persona: '25-34 岁独居青年，深夜手机下单为主（摘录自简报）',
      dist: { A: 0.62, O: 0.2, M: 0.08, I: 0.06, R: 0.04 },
      basis: '简报锁定的受众对"解压感"有强诉求，高警示度方向超出其预期但不反感，判为魅力属性。',
      anchored: true,
      grounded: false,
    };
  }

  // F10：苏格拉底式澄清 —— 每轮都返回问题（配合"够了，生成简报"与 5 轮上限两种路径）
  if (user.includes('请继续追问')) {
    const subject = (user.match(/设计对象：(.+)/) || [])[1]?.trim() || '未命名项目';
    const round = Number((user.match(/现在是第 (\d+)\/5 轮/) || [])[1] || 1);
    return {
      questions: [
        {
          text:
            round === 1
              ? '这个产品 / 品牌现在处于什么阶段？'
              : `再确认一点：做的时候，你最不希望它像谁？`,
          reason:
            round === 1
              ? '阶段决定提问方向：全新要从零定义，升级要先保留资产，子产品线要跟主品牌拉开距离。'
              : '先立边界再做设计，能避免发散到最后推翻重来。',
          options:
            round === 1
              ? ['全新产品', '已有品牌升级', '子产品线']
              : ['别像传统大牌', '别像网红过度营销', '没有特别反感'],
        },
        // 一轮两问：验证「逐题作答后一次性提交」而不是点一个就推进
        {
          text:
            round === 1
              ? '这批视觉主要给谁看、在哪儿看？'
              : '这次最想让人记住的一个词是什么？',
          reason:
            round === 1
              ? '受众与投放场景决定信息密度，货架上和手机里完全是两套做法。'
              : '一个词做锚点，后面所有判断都有参照，不容易发散。',
          options:
            round === 1
              ? ['货架·线下为主', '电商详情页为主', '社媒内容为主']
              : ['危险感', '解压', '手工感'],
        },
      ],
      summary: `我目前的理解是：围绕「${subject}」的一次视觉设计探索，详细信息还在收集中。`,
      ready: false,
    };
  }

  // F10：收束对话 → 项目简报草稿
  if (user.includes('"brief":"项目简报（≤300')) {
    const subject = (user.match(/设计对象：(.+)/) || [])[1]?.trim() || '未命名项目';
    return {
      product: subject,
      brief:
        '目标人群：25-34 岁独居青年，追求刺激与独特性，习惯深夜手机下单。使用场景：电商货架与短视频信息流。要解决的问题：传统包装在货架上识别度不足、气质老旧。边界：不做过度网感的营销腔。视觉预期：希望有危险感与解压感并存的张力。',
      mood: '危险感、冷冽、解压',
    };
  }

  return { echo: user.slice(0, 60) };
}

function sse(obj) {
  const text = JSON.stringify(obj);
  const step = 24;
  let out = '';
  for (let i = 0; i < text.length; i += step) {
    const delta = text.slice(i, i + step);
    out += `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
  }
  out += 'data: [DONE]\n\n';
  return out;
}

/** 请求处理逻辑。两个 server 实例共用（见下方 listen 说明）。 */
function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* ignore */
    }
    const model = parsed.model || 'mock';

    // 挂起模式：model 传 "hang" 就只建立连接不吐任何字节也不关闭——
    // 用于验证前端超时守卫（ai.ts 的 IDLE/OVERALL timeout）能救场
    if (model === 'hang') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Mock-Model': model,
      });
      return; // 故意不 end
    }

    const out = sse(payloadFor(parsed.messages));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Mock-Model': model,
    });
    res.end(out);
  });
}

/* ⚠️ 为什么是**两个** server 实例，而不是 `.listen(PORT)` 一次绑 `::`：
 *
 *   1. 工具脚本的 baseUrl 必须写 `http://localhost:8788` 而不是 `127.0.0.1:8788`。
 *      `server/viteAiProxy.ts` 的 SSRF 防护里，`DD_ALLOW_LOCALHOST=1` 这个开关
 *      只能放行**能匹配 LOOPBACK 正则**的主机名，而那条正则有 `$` 锚：
 *        LOOPBACK = /^(localhost|127\.|0\.0\.0\.0|::1)$/
 *      `127\.` 后面紧跟 `$`，所以它只匹配字面上等于 `"127."` 的主机名 ——
 *      真正的 `"127.0.0.1"` 匹配不上，会落到没有 `$` 的 PRIVATE_HOST 被直接拒。
 *      （这是那个插件的一个 bug，已单独报告，不在本轮擅自改安全逻辑。）
 *      `localhost` 能匹配，所以脚本统一用它。
 *   2. Node 的 fetch 对 `localhost` 可能解析到 IPv6 的 `::1`。只绑 IPv4 回环时，
 *      请求会连不上，报 `fetch failed`。
 *
 * 折中：v4 与 v6 **两个实例都只绑回环**。不是绑 `::`/0.0.0.0 —— 那会让局域网
 * 内其他设备访问到 mock，暴露面就变了。绑回环则对外没有任何变化。
 */
const v4 = http.createServer(handler);
const v6 = http.createServer(handler);
v4.listen(PORT, '127.0.0.1', () => console.log(`mock LLM on http://127.0.0.1:${PORT}`));
v6.listen(PORT, '::1', () => console.log(`mock LLM on http://[::1]:${PORT}`));
