/**
 * 谐音维度的机械筛选。
 *
 * 为什么提示词已经写了五轮，还要在代码里再筛一遍：
 * 模型每次都能给违规找一句新说法——「放宽：韵母不同」「未换字，保持原句」
 * 「属常见文学搭配」「非谐音替换，而是自创词」。这些话本身就是不合格的证据：
 * 它出现在 why 里，说明模型自己知道这条没守住。
 *
 * 更麻烦的是另一种：它并不承认违规，而是**给一个假的合格理由**。
 * 实测「伞」那一批，6 条全写「第 2 项仅声调不同」，实际是国 guó→伞 sǎn、
 * 守 shǒu→伞 sǎn、钟 zhōng→伞 sǎn。要求模型自己报项号之后，它反而报得更自信。
 *
 * 所以这里做两件事：
 *   1. 措辞筛查 —— 命中「自证不合格」的说法就丢
 *   2. 拼音复核 —— 从 why 里抽出「被换字 + 拼音」和「种子字 + 拼音」，真比一次
 *
 * 原则：能验证且明显对不上才丢；抽不出拼音的放行（验不了不等于错）。
 * 宁可少给两条，也不要给用户一条需要自己解释才成立的谐音。
 */

export interface PhonoCandidate {
  word: string;
  why: string;
  dir?: string;
}

export interface PhonoScreenResult<T extends PhonoCandidate> {
  kept: T[];
  dropped: { word: string; reason: string }[];
}

/**
 * 自证不合格的措辞。
 * 每条都对应一种实测出现过的逃逸方式，不是凭想象列的：
 * - 「非固定成语 / 常见表达」→ 把编出来的"风至如流"说成常见表达
 * - 「未换字 / 保持原句」→ 茶余饭后、墨守成规整条没换字却混进来
 * - 「韵腹相近 / 整体听感」→ 披星戴伞（月→伞）、拨云见伞（日→伞）
 * - 「自创词 / 意象转译」→ 灯窗、出头之灯
 * - 「不成立 / 换备选」→ 一条 why 里先否掉再换，输出的是半成品
 */
const EXCUSES: { re: RegExp; reason: string }[] = [
  { re: /非固定成语|不是成语|非成语/, reason: '原句不是固定说法' },
  { re: /常见表达|常见文学搭配|常用搭配|常见用法|常见词组/, reason: '原句靠"常见表达"才成立，实为自造' },
  { re: /近音变体|语义变体|音义对转|近义变体/, reason: '自称原句是变体，实为自造' },
  { re: /自创词|自造|生造/, reason: '自认是自创词' },
  { re: /非谐音替换|并非谐音|不是谐音|意象转译/, reason: '自认不是谐音' },
  { re: /未换字|无需换字|不换字|保持原句|原句一字不动|直接使用原字/, reason: '原句没换字，不算谐音' },
  {
    re: /韵腹相近|整体听感|听感近似|意义相关|意思相近|语义相近|口语里常混|口音中常混|念快了差不多|广告语境可接受/,
    reason: '读音对不上，只靠感觉',
  },
  { re: /跨音节/, reason: '读音要跨音节重切才对得上' },
  // 清单外的放宽项：合法项会写「第 2 项，仅声调不同」，不会写成「放宽：韵母不同」
  { re: /放宽[:：]?\s*(韵母|声母|韵腹)(不同|相近)/, reason: '自批了一个清单外的放宽项' },
  { re: /不成立|非正式作品|换备选|重新选取|不合格/, reason: 'why 里自认这条不成立' },
];

/* ---------------------------------------------------------------- 拼音复核 */

const TONE_CHARS: Record<string, [string, number]> = {
  ā: ['a', 1], á: ['a', 2], ǎ: ['a', 3], à: ['a', 4],
  ē: ['e', 1], é: ['e', 2], ě: ['e', 3], è: ['e', 4],
  ī: ['i', 1], í: ['i', 2], ǐ: ['i', 3], ì: ['i', 4],
  ō: ['o', 1], ó: ['o', 2], ǒ: ['o', 3], ò: ['o', 4],
  ū: ['u', 1], ú: ['u', 2], ǔ: ['u', 3], ù: ['u', 4],
  ǖ: ['v', 1], ǘ: ['v', 2], ǚ: ['v', 3], ǜ: ['v', 4],
  ü: ['v', 0], ń: ['n', 2], ň: ['n', 3], ǹ: ['n', 4],
};

interface Syllable {
  initial: string;
  final: string;
}

function parsePinyin(raw: string): Syllable | null {
  let s = raw.replace(/[\s'’·]/g, '').toLowerCase();
  if (!s) return null;

  let tone = 0;
  if (/\d$/.test(s)) {
    tone = Number(s.slice(-1));
    s = s.slice(0, -1);
  }
  let out = '';
  for (const ch of s) {
    const m = TONE_CHARS[ch];
    if (m) {
      if (!tone && m[1]) tone = m[1];
      out += m[0];
    } else {
      out += ch;
    }
  }
  if (!/^[a-z]+$/.test(out)) return null;

  const ini = out.match(/^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])/);
  const initial = ini ? ini[1] : '';
  const final = out.slice(initial.length);
  if (!final) return null;
  return { initial, final };
}

/** 平翘舌、前后鼻音、n-l、f-h —— 与提示词里的闭合清单一一对应 */
function closeEnough(a: Syllable, b: Syllable): boolean {
  if (a.final === b.final) {
    if (a.initial === b.initial) return true;
    const pair = [a.initial, b.initial].sort().join('/');
    if (['s/sh', 'c/ch', 'z/zh', 'n/l', 'f/h'].includes(pair)) return true;
  }
  // 前后鼻音：a / ang、en / eng、in / ing
  const strip = (f: string) => f.replace(/ng$/, '');
  if (a.initial === b.initial && a.final !== b.final && strip(a.final) === strip(b.final)) {
    return true;
  }
  // 首字母相同、韵母仅差鼻音尾（z/z 之外的口语合并，如 an/ang 已覆盖，这里兜住 ang/ang）
  return false;
}

/** 从 why 里抓 「汉字 拼音」 配对。拼音可能被写成 "g uó"（字间带空格），一并兜住 */
function extractPairs(why: string): { char: string; pin: Syllable }[] {
  const out: { char: string; pin: Syllable }[] = [];
  const pinyinChars = 'a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüńňǹ ';
  const re = new RegExp(`[「『"“]?([\\u4e00-\\u9fa5])\\s*([${pinyinChars}]{1,18})[」』"”]?`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(why))) {
    const pin = parsePinyin(m[2]);
    if (pin) out.push({ char: m[1], pin });
  }
  return out;
}

/** why 里所有被引号括起来的片段（用来判断「原句」是否就是结果本身） */
function quotedPhrases(why: string): string[] {
  const out: string[] = [];
  const re = /[「『"“]([^」』"”]{1,20})[」』"”]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(why))) {
    const p = m[1].trim();
    if (/[\u4e00-\u9fa5]/.test(p)) out.push(p);
  }
  return out;
}

/**
 * word 里有多少个字是原句里没有的（即真正"换进来"的字）。
 *
 * 允许缩短：「让子弹飞一会儿 → 让茶飞」这种缩写是成立的，只要换进来的只有一个字。
 * 不允许改两处：「风狂雨骤 → 蜂狂蝶乱」换了两个位置，那不是换字，是改写。
 *
 * 用子序列贪心匹配：按顺序在原句里找 word 的字，找不到的算换进来的。
 * 贪心在重复字上会有偏差，但这里的原句都很短，偏差只会让判定偏宽松，不会误杀。
 */
function foreignChars(word: string, original: string): string[] {
  const o = [...original];
  let p = 0;
  const foreign: string[] = [];
  for (const ch of word) {
    const hit = o.indexOf(ch, p);
    if (hit >= 0) p = hit + 1;
    else foreign.push(ch);
  }
  return foreign;
}

/**
 * 模型自称的原句。「原句为成语「X」」「原句：俗语「X」」这类写法都能抓到。
 * 只看「原句」后面紧跟的那个引用，不看全篇 —— 后文还会引「坚守」「不洇纸」，
 * 那些是释义不是原句。
 */
function claimedOriginal(why: string): string | null {
  const m = why.match(/原句[^「『"“]{0,10}[「『"“]([^」』"”]{2,20})/);
  return m ? m[1].trim() : null;
}

/**
 * 找「被换掉的那个字」与种子字的拼音，比一次。
 * 找不到成对的信息就返回 null —— 验不了不等于错，放行。
 */
function phoneticMismatch(seed: string, why: string): string | null {
  if ([...seed].length !== 1) return null;
  const pairs = extractPairs(why);
  if (pairs.length < 2) return null;

  const seedPin = pairs.find((p) => p.char === seed)?.pin;
  if (!seedPin) return null;

  // 被换掉的字：why 里除种子字以外的第一个能解析出拼音的字
  const other = pairs.find((p) => p.char !== seed);
  if (!other) return null;

  if (closeEnough(seedPin, other.pin)) return null;
  const show = (p: Syllable) => `${p.initial}${p.final}`;
  return `读音对不上：${other.char} ${show(other.pin)} ≠ ${seed} ${show(seedPin)}`;
}

/* ------------------------------------------------------------------ 主函数 */

const MAX_LEN = 16;

export function screenPhonoWords<T extends PhonoCandidate>(
  seed: string,
  words: T[],
): PhonoScreenResult<T> {
  const kept: T[] = [];
  const dropped: { word: string; reason: string }[] = [];

  // 种子是多字词时不做「必须含种子字」这条：取其中哪个字本来就要模型说明，
  // 硬查会误杀。单字种子才适用——这也是绝大多数情况。
  const single = seed.trim();
  const checkSeedChar = [...single].length === 1;

  for (const w of words) {
    const word = (w.word ?? '').trim();
    const why = w.why ?? '';

    if (!word) {
      dropped.push({ word: '(空)', reason: '词为空' });
      continue;
    }

    const len = [...word].length;
    if (len < 2 || len > MAX_LEN) {
      dropped.push({ word, reason: `长度 ${len} 字，超出 ${MAX_LEN} 字` });
      continue;
    }

    if (checkSeedChar && !word.includes(single)) {
      dropped.push({ word, reason: '词里没有种子字' });
      continue;
    }

    // 原句就是结果本身 —— 一个字都没改，那是直接使用，不是谐音。
    // 不做编辑距离判定：「让子弹飞一会儿 → 让茶飞」这种多字替换是合法的，
    // 按距离筛会把好的也筛掉。
    const claimed = claimedOriginal(why);
    if (claimed === word) {
      dropped.push({ word, reason: '原句就是结果本身，没有换字' });
      continue;
    }
    if (claimed) {
      const foreign = foreignChars(word, claimed);
      const distinct = [...new Set(foreign)];
      if ([...word].length > [...claimed].length) {
        dropped.push({ word, reason: '比原句还长，不是替换' });
        continue;
      }
      if (!foreign.length) {
        dropped.push({ word, reason: '只是删字，没有换进新字' });
        continue;
      }
      // 「默默无闻 → 墨墨无闻」把同一个字换了两处，仍算一次替换；
      // 「风狂雨骤 → 蜂狂蝶乱」换的是两个不同的字，那是改写
      if (distinct.length > 1) {
        dropped.push({ word, reason: `换了 ${distinct.length} 个不同的字（原句「${claimed}」），不是换字` });
        continue;
      }
    }
    if (!claimed) {
      const quoted = quotedPhrases(why).filter((p) => [...p].length >= 2);
      if (quoted.length && quoted.every((p) => p === word)) {
        dropped.push({ word, reason: '引用的原句就是结果本身，没有换字' });
        continue;
      }
    }

    const excuse = EXCUSES.find((e) => e.re.test(why));
    if (excuse) {
      dropped.push({ word, reason: excuse.reason });
      continue;
    }

    const mismatch = phoneticMismatch(single, why);
    if (mismatch) {
      dropped.push({ word, reason: mismatch });
      continue;
    }

    kept.push({ ...w, word });
  }

  return { kept, dropped };
}
