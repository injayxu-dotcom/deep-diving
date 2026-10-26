import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, MAX_IMAGES, type FlowNode } from '../store/useStore';
import { isLight } from '../lib/color';
import { useFocusSec } from '../lib/useFocusSec';
import { adviceRows, type AdviceRow } from '../lib/advice';
import {
  ADVICE_TONE,
  ATTRS,
  ATTR_NAME,
  CRITERIA,
  DEFAULT_WEIGHTS,
  QUADRANT_HINT,
  QUADRANT_NAME,
  adviceSummary,
  assumptions,
  effectiveScore,
  quadrantOf,
  valueTier,
  verifyQuestions,
} from '../lib/scoring';
import type { KanoAttr, UserAdj, VisionDim } from '../types';
import { VISION_DIMS } from '../types';
import { Icon } from './Icon';

export function useCopy() {
  const [copied, setCopied] = useState('');
  const timer = useRef<number | null>(null);
  // 连续复制 4 条提示词时，前一条的定时器会把后一条的"已复制"提前清掉
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async (text: string, tag: string) => {
    if (!text) return;
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
    } catch {
      setCopied('复制失败');
    }
    timer.current = window.setTimeout(() => setCopied(''), 1600);
  };
  return { copy, copied };
}

export function RightPanel({
  onCollapse,
  focusSec,
  onFocused,
}: {
  onCollapse?: () => void;
  /** 从收起把手的区块图标进来时带的锚点：展开后滚到那一区 */
  focusSec?: string | null;
  onFocused?: () => void;
}) {
  useFocusSec(focusSec, onFocused);
  const nodes = useStore((s) => s.nodes);
  const selectedId = useStore((s) => s.selectedId);
  const setSelected = useStore((s) => s.setSelected);
  const logs = useStore((s) => s.logs);

  /**
   * 节点级详情（评分依据 / 简报 / 提示词 / 参考图）全部搬到画布上的节点面板了。
   * 右栏只留「全局视角」：整体分布 + 谁更值得做 + 发生了什么。
   *
   * P3：「价值分排行」升级为「行动建议」——不只排序，还给每个概念一条
   * 「下一步做什么」（纯本地规则，零新增 AI 调用，规则见 lib/advice.ts）。
   * 证据 chips 全部引用已有字段（价值分 / 图 N / 留用 N / CR / KANO 缺口），
   * 展开的依据直接引用该概念的评分理由，不新造文字。
   */
  const advice = useMemo<AdviceRow[]>(() => adviceRows(nodes).slice(0, 12), [nodes]);

  const sum = useMemo(() => adviceSummary(advice.map((r) => r.adv.kind)), [advice]);

  // 只有 V2 评分才有 C3/C4，画不出象限的老数据不进图。
  // P4：坐标与气泡大小读 effectiveScore——用户调过 C3/C4 时，
  // 气泡该落在调整后的位置上（否则「分改了象限没动」自相矛盾）
  const quadPoints = useMemo(
    () =>
      nodes
        .filter((n) => n.data.score?.v === 2 && n.data.score.c3 && n.data.score.c4)
        .map((n) => {
          const eff = effectiveScore(n.data.score!);
          return {
            id: n.id,
            label: n.data.label,
            x: eff.criteria[3],
            y: eff.criteria[2],
            value: eff.value,
            active: n.id === selectedId,
          };
        }),
    [nodes, selectedId],
  );

  return (
    <aside className="panel panel-right">
      <div className="phead">
        <h2 className="phead-t">
          <Icon name="gauge" size={13} /> 评分 · 日志
        </h2>
        {onCollapse ? (
          <button className="icon-btn" onClick={onCollapse} title="收起面板" aria-label="收起面板">
            <Icon name="chevronRight" size={14} />
          </button>
        ) : null}
      </div>

      {/* data-sec 是收起把手的跳转锚点（见 App.tsx 的 RAIL_SECS）。
          ⚠️ 只看 RightPanel.tsx 这个文件会以为「视觉资产」(AssetSection) 也在右栏里 ——
          它确实定义在本文件，但挂载点是 NodeBody.tsx（节点详情卡的 tab），
          不在右栏。右栏的常驻区块只有三个：象限图 / 行动建议 / 运行日志。 */}
      <div className="psec" data-sec="quad">
        <h3 className="plabel">
          Now-How-Wow
          {quadPoints.length ? <span className="phint inline">气泡越大＝价值分越高</span> : null}
        </h3>
        <QuadrantChart points={quadPoints} onPick={setSelected} />
      </div>

      <div className="psec" data-sec="rank">
        <h3 className="plabel">
          行动建议
          {advice.length ? <span className="phint inline">点词定位</span> : null}
        </h3>
        {advice.length ? (
          <>
            <div className="adv-sum">
              {advice.length} 个概念：{sum.push} 建议推进 · {sum.verify} 待验证 · {sum.hold} 暂缓
              {sum.tbd ? ` · ${sum.tbd} 待定夺` : ''}
            </div>
            <ol className="rank">
              {advice.map((r, i) => (
                <li key={r.id} className={`adv-i ${r.id === selectedId ? 'on' : ''}`}>
                  <button
                    className={`rank-i ${r.id === selectedId ? 'on' : ''}`}
                    onClick={() => setSelected(r.id)}
                  >
                    <span className="rank-n">{i + 1}</span>
                    <span className="rank-l" title={r.label}>
                      {r.label}
                    </span>
                    <span className="rank-v">{r.value.toFixed(1)}</span>
                  </button>
                  <div className="adv-line">
                    <span className={`adv-badge t-${ADVICE_TONE[r.adv.kind]}`} title={r.adv.hint}>
                      {r.adv.label}
                    </span>
                    {r.ev.map((e) => (
                      <span key={e} className="adv-ev">
                        {e}
                      </span>
                    ))}
                  </div>
                  {/* 依据直接引用该概念的评分理由（decision + 四准则 why），
                      不新造文字——行动建议是「重新组织」，不是「再编一套说法」 */}
                  <details className="adv-why">
                    <summary>依据</summary>
                    {r.decision ? <div className="adv-dec">{r.decision}</div> : null}
                    <ul className="adv-crits">
                      {CRITERIA.map((c, ci) => {
                        const k = `c${ci + 1}` as 'c1' | 'c2' | 'c3' | 'c4';
                        const crit = r.score[k];
                        if (!crit) return null;
                        // 有效分（用户调整优先）；有调整时 AI 原始分并列显示，
                        // 「依据引用模型理由、读数取有效值」两件事都成立
                        const effV = r.criteria[ci];
                        return (
                          <li key={k}>
                            <b>
                              {c.name} {effV.toFixed(1)}
                              {r.adjusted && Math.abs(effV - crit.score) > 0.01 ? (
                                <s className="adv-ai">AI {crit.score.toFixed(1)}</s>
                              ) : null}
                            </b>
                            {crit.why || '（模型未给出依据）'}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <div className="pempty">还没有新版评分，先给概念词跑一次 AI 评分</div>
        )}
      </div>

      <div className="psec grow" data-sec="logs">
        <h3 className="plabel">运行日志</h3>
        {logs.length === 0 ? (
          <div className="pempty">暂无</div>
        ) : (
          <ul className="logs">
            {logs.map((l) => (
              <li key={l.id} className={`log ${l.level}`}>
                <span className="log-t">{new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                {l.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** 视觉资产区：参考图管理 + 色卡 + 读图入口 */
/** F8 组合评定详情：化学反应 + 四维 + 风险。只有组合节点走这里 */
export function ComboSection({ node }: { node: FlowNode }) {
  const nodes = useStore((s) => s.nodes);
  const combo = node.data.combo!;
  const dims = [
    { k: 'c1' as const, label: '相关性' },
    { k: 'c2' as const, label: '差异化' },
    { k: 'c3' as const, label: '可视化' },
    { k: 'c4' as const, label: '惊喜度' },
  ];
  const sourceNames = combo.sourceIds
    .map((id) => nodes.find((n) => n.id === id)?.data.label)
    .filter((x): x is string => !!x);

  const tone =
    (combo.synergy ?? 0) >= 7 ? 'hi' : (combo.synergy ?? 0) >= 5 ? 'mid' : 'lo';

  return (
    <div className="psec">
      <h3 className="plabel">组合评定</h3>
      {sourceNames.length ? <div className="phint">来源：{sourceNames.join(' + ')}</div> : null}
      {combo.logic ? <BriefBlock label="组合逻辑" value={combo.logic} /> : null}

      <div className="synergy-row">
        <div className={`synergy-big ${tone}`}>
          <span className="synergy-num">{(combo.synergy ?? 0).toFixed(1)}</span>
          <span className="synergy-cap">协同度</span>
        </div>
        {combo.advice ? <div className={`combo-advice ${tone}`}>{combo.advice}</div> : null}
      </div>

      <div className="bars">
        {dims.map((d) => {
          const v = combo[d.k] ?? 0;
          return (
            <div key={d.k} className="bar">
              <span className="bar-l">{d.label}</span>
              <span className="bar-track">
                <span
                  className={`bar-fill ${v >= 7 ? 'hi' : v >= 5 ? 'mid' : 'lo'}`}
                  style={{ width: `${Math.max(0, Math.min(10, v)) * 10}%` }}
                />
              </span>
              <span className="bar-v">{v.toFixed(1)}</span>
            </div>
          );
        })}
      </div>

      {combo.conflict ? <BriefBlock label="语义冲突" value={combo.conflict} /> : null}
      {combo.tension ? <BriefBlock label="张力判断" value={combo.tension} /> : null}
      {combo.risk ? <BriefBlock label="执行风险" value={combo.risk} /> : null}
    </div>
  );
}

/**
 * P6-3：参考图四维结果。
 *
 * 三条信息缺一不可，所以每一维都写成一行「维度名 + 来源徽标 + 结论」：
 *   1. 这一维是什么（配色/风格/构图/排版）；
 *   2. 结论是**算出来的**还是**模型推断的**（配色走本地算法，图片不外传）；
 *   3. 结论本身，以及能直接拿去写提示词的关键词。
 *
 * 老数据（v<2 的一次性读图结果）在这里照旧显示，只是标明来源未知——
 * 不做静默迁移，也不逼用户重跑（那会让已有的结论凭空消失）。
 */
export function VisionDims({ node, onAsk }: { node: FlowNode; onAsk: (dim: VisionDim) => void }) {
  const v = node.data.visual;
  const dims = v?.dims ?? {};
  const legacy = v && (v.v ?? 1) < 2 && (v.palette || v.font || v.layout || v.material || v.mood || v.summary);
  const any = VISION_DIMS.some((d) => dims[d.key]);
  if (!any && !legacy) return null;

  return (
    <div className="vdims">
      {VISION_DIMS.map((d) => {
        const s = dims[d.key];
        if (!s) return null;
        return (
          <div key={d.key} className="vdim">
            <div className="vdim-h">
              <span className="vdim-k">{d.label}</span>
              <span className={`vdim-from ${s.from}`} title={s.from === 'local' ? '本地算法算出，图片没有外传' : '视觉模型推断'}>
                {s.from === 'local' ? '本地算法' : '模型推断'}
              </span>
              <button className="vdim-again" title={`重新提取${d.label}`} onClick={() => onAsk(d.key)}>
                <Icon name="undo" size={10} />
              </button>
            </div>
            <div className="vdim-v">{s.text}</div>
            {s.tags?.length ? (
              <div className="vdim-tags">
                {s.tags.map((t) => (
                  <span key={t} className="vdim-tag">
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      {legacy ? (
        <div className="vdims-legacy">
          <div className="vdim-h">
            <span className="vdim-k">旧版读图结果</span>
            <span className="vdim-from">来源未知</span>
          </div>
          {v.palette ? <div className="vdim-v">配色：{v.palette}</div> : null}
          {v.font ? <div className="vdim-v">字体：{v.font}</div> : null}
          {v.layout ? <div className="vdim-v">版式：{v.layout}</div> : null}
          {v.material ? <div className="vdim-v">材质：{v.material}</div> : null}
          {v.mood ? <div className="vdim-v">情绪：{v.mood}</div> : null}
          {v.summary ? <div className="vdim-v">共性：{v.summary}</div> : null}
          <p className="vdim-tip">这是一次性读完的旧结果（分不清哪句是算的、哪句是猜的）。按上面四个按钮重提一次即可。</p>
        </div>
      ) : null}
    </div>
  );
}

export function AssetSection({ node }: { node: FlowNode }) {
  const attachImages = useStore((s) => s.attachImages);
  const removeImage = useStore((s) => s.removeImage);
  const runVision = useStore((s) => s.runVision);
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const imgs = node.data.images ?? [];
  const palette = node.data.palette ?? [];
  const { copy, copied } = useCopy();

  return (
    /* 这里**没有** data-sec：AssetSection 挂在 NodeBody.tsx:215（节点详情卡的 tab），
       不在左右面板里，因此不是收起把手的跳转目标。曾经这里带过 data-sec="assets"，
       于是 App.tsx 的 RAIL_SECS 顺手把它当成了右栏区块 → 点「视觉资产」图标毫无反应。
       那个死链已经修掉（改成真实存在的 quad），这里也一并去掉，别再留诱因。 */
    <div className="psec">
      <h3 className="plabel">
        视觉资产
        {imgs.length ? <span className="phint inline">{imgs.length}/{MAX_IMAGES} 张</span> : null}
      </h3>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void attachImages(node.id, files);
        }}
      />

      {imgs.length ? (
        <div className="gal">
          {imgs.map((img) => (
            <div key={img.id} className="gal-i">
              <img src={img.dataUrl} alt={img.name} onClick={() => setPreview(img.dataUrl)} />
              <button className="gal-x" onClick={() => removeImage(node.id, img.id)} title="移除">
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="pempty">把图片文件拖进画布，或点下面按钮挂载</div>
      )}

      <div className="btnrow" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => fileRef.current?.click()}>
          挂载图片
        </button>
      </div>

      {/* P6-3：四维按需提取。哪个维度现在有结论、是本地算的还是模型给的，
          全写在这一行里——用户按需点，不必为了一次只想看构图而付六段输出 */}
      <div className="vdims-ask">
        {VISION_DIMS.map((d) => {
          const done = node.data.visual?.dims?.[d.key];
          return (
            <button
              key={d.key}
              className={`btn xs vdim-btn ${done ? 'on' : ''}`}
              disabled={!imgs.length || node.data.busy}
              title={done ? `${d.hint} · 已有结果，点击重新提取` : d.hint}
              onClick={() => void runVision(node.id, d.key)}
            >
              {done ? <Icon name="check" size={11} /> : null}
              提取{d.label}
            </button>
          );
        })}
      </div>

      <VisionDims node={node} onAsk={(dim) => void runVision(node.id, dim)} />

      {palette.length ? (
        <div className="psec-sub">
          <div className="swatches">
            {palette.map((c) => (
              <button
                key={c}
                className="swatch"
                style={{ background: c, color: isLight(c) ? '#3A2418' : '#fff' }}
                onClick={() => copy(c, c)}
                title="点击复制色值"
              >
                {copied === c ? '已复制' : c}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="lightbox" onClick={() => setPreview(null)}>
          <img src={preview} alt="预览" onClick={(e) => e.stopPropagation()} />
          <span className="lightbox-tip">点击空白处关闭</span>
        </div>
      ) : null}
    </div>
  );
}

export function BriefBlock({ label, value }: { label: string; value: string }) {
  // 兜底：入库数据理论上已被 sanitize 归一成字符串，
  // 但用户浏览器里可能还留着历史坏数据——这里再挡一道，绝不让 React 因对象子节点白屏
  const v = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (!v) return null;
  return (
    <div className="bblock">
      <span className="bblock-l">{label}</span>
      <div className="bblock-v">{v}</div>
    </div>
  );
}

export function PromptBox({
  name,
  text,
  onCopy,
  copied,
}: {
  name: string;
  text: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div className="pbox">
      <div className="pbox-h">
        <span>{name}</span>
        <button className="btn xs" onClick={onCopy} disabled={!text}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <div className="pbox-x">{typeof text === 'string' ? text || '（尚未生成）' : '（数据格式异常，请重出提示词）'}</div>
    </div>
  );
}

interface QuadPt {
  id: string;
  label: string;
  /** C4 情感激发 = 原创性 */
  x: number;
  /** C3 可实现性 = 可行性 */
  y: number;
  value: number;
  active: boolean;
}

/* 2026-10-16 暖化：now（低垂果实）冷蓝 → 焦糖暖棕，meh 冷灰 → 暖灰。
   wow 绿 / how 紫是分类语义色，保留（风格指南：不借创作色表达系统状态，
   分类色按"暖化但保持可区分"处置）。 */
const QUAD_COLOR: Record<string, string> = {
  wow: '#0E9A6A',
  how: '#7A5AA8',
  now: '#8C6D4F',
  meh: '#A89A8C',
};

/**
 * Now-How-Wow 四象限图。
 *
 * 两个轴直接复用 C4 / C3，不重新打分——否则用户会看到
 * 「惊喜度 8 分却落在 Now 象限」这种自相矛盾的结论。
 *
 * 标签防重叠：272px 宽的图摊 0-10 分的标尺，分数接近的词落点本来就只差几像素，
 * 「气泡正上方居中」的死板标注必然叠成一坨。这里贪心排位——价值分高/选中的
 * 先占位，其余标签从气泡上方开始逐格（11px）找空位，上方放不下换下方，
 * 横向越界夹回画布；挪得离气泡远的画一条细引导线，防止张冠李戴。
 */
function QuadrantChart({ points, onPick }: { points: QuadPt[]; onPick: (id: string) => void }) {
  const W = 272;
  const H = 208;
  const PAD = 24;
  const sx = (v: number) => PAD + (v / 10) * (W - PAD - 12);
  const sy = (v: number) => H - PAD - (v / 10) * (H - PAD - 14);
  const rOf = (v: number) => 4 + (v / 10) * 6;

  type Placed = QuadPt & { cx: number; cy: number; r: number; lx: number; ly: number; text: string };
  const placed = useMemo<Placed[]>(() => {
    const boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
    // 象限角标也是压在画布上的文字，得先占位——否则高分概念（落点正好在右上角）
    // 的标签会骑着「Wow 又新又能做」印出来，两条字叠成一团
    const tw = (s: string) => {
      let w = 0;
      for (const ch of s) w += /[\u4e00-\u9fa5]/.test(ch) ? 9 : 5.6;
      return w;
    };
    const zone = (text: string, x: number, y: number, anchorEnd: boolean) =>
      boxes.push(
        anchorEnd
          ? { x1: x - tw(text), y1: y - 9, x2: x, y2: y + 3 }
          : { x1: x, y1: y - 9, x2: x + tw(text), y2: y + 3 },
      );
    zone('Wow 又新又能做', sx(10) - 5, sy(10) + 13, true);
    zone('How 做不了', sx(0) + 5, sy(10) + 13, false);
    zone('Now 低垂果实', sx(10) - 5, sy(5) - 5, true);
    zone('Meh 放弃', sx(0) + 5, sy(5) - 5, false);
    // 选中的、价值分高的先挑好位置；剩下的往空隙里塞
    const sorted = [...points].sort(
      (a, b) => Number(b.active) - Number(a.active) || b.value - a.value,
    );
    const hit = (x1: number, y1: number, x2: number, y2: number) =>
      boxes.some((b) => !(x2 < b.x1 - 2 || x1 > b.x2 + 2 || y2 < b.y1 - 2 || y1 > b.y2 + 2));
    const out: Placed[] = [];
    for (const p of sorted) {
      const r = rOf(p.value) + (p.active ? 2 : 0);
      const cx = sx(p.x);
      const cy = sy(p.y);
      const text = p.label.length > 6 ? p.label.slice(0, 6) + '…' : p.label;
      const lw = text.length * 9.6 + 6; // 中文 @9.5px 是方块字，字宽≈字号
      const clampX = (x: number) => Math.max(lw / 2 + 2, Math.min(x, W - lw / 2 - 2));
      // 候选槽位：上方 6 格 → 左右侧（与气泡同高）→ 下方 4 格，先做画布边界过滤
      const raw: { x: number; y: number }[] = [];
      for (let k = 0; k < 6; k++) raw.push({ x: clampX(cx), y: cy - r - 6 - k * 11 });
      raw.push({ x: clampX(cx - r - lw / 2 - 2), y: cy + 3 });
      raw.push({ x: clampX(cx + r + lw / 2 + 2), y: cy + 3 });
      for (let k = 0; k < 4; k++) raw.push({ x: clampX(cx), y: cy + r + 13 + k * 11 });
      const slots = raw.filter((s) => s.y >= 12 && s.y <= H - 12);
      const strike = (s: { x: number; y: number }) =>
        hit(s.x - lw / 2, s.y - 9, s.x + lw / 2, s.y + 3);
      const free = slots.find((s) => !strike(s));
      // 全冲突时退而求其次：选压盖面积最小的槽，好过随机叠死
      let best = free ?? slots[slots.length - 1] ?? { x: clampX(cx), y: cy - r - 6 };
      if (!free) {
        let bestArea = Infinity;
        for (const s of slots) {
          const x1 = Math.max(s.x - lw / 2, 2), y1 = Math.max(s.y - 9, 2);
          const x2 = Math.min(s.x + lw / 2, W - 2), y2 = Math.min(s.y + 3, H - 2);
          let area = 0;
          for (const b of boxes) {
            const ox = Math.min(x2, b.x2) - Math.max(x1, b.x1);
            const oy = Math.min(y2, b.y2) - Math.max(y1, b.y1);
            if (ox > 0 && oy > 0) area += ox * oy;
          }
          if (area < bestArea) {
            bestArea = area;
            best = s;
          }
        }
      }
      boxes.push({ x1: best.x - lw / 2, y1: best.y - 9, x2: best.x + lw / 2, y2: best.y + 3 });
      out.push({ ...p, cx, cy, r, lx: best.x, ly: best.y, text });
    }
    return out;
  }, [points]);

  return (
    <svg className="bubble" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Now-How-Wow 四象限图">
      {/* 右上 Wow 区高亮 */}
      <rect x={sx(5)} y={sy(10)} width={sx(10) - sx(5)} height={sy(5) - sy(10)} fill="#EAF7F1" />

      <line x1={PAD} y1={sy(0)} x2={W - 10} y2={sy(0)} style={{ stroke: 'var(--ink-100)' }} strokeWidth={1} />
      <line x1={PAD} y1={sy(0)} x2={PAD} y2={sy(10)} style={{ stroke: 'var(--ink-100)' }} strokeWidth={1} />
      <line x1={sx(5)} y1={sy(0)} x2={sx(5)} y2={sy(10)} style={{ stroke: 'var(--ink-100)' }} strokeWidth={1} strokeDasharray="3 3" />
      <line x1={PAD} y1={sy(5)} x2={W - 10} y2={sy(5)} style={{ stroke: 'var(--ink-100)' }} strokeWidth={1} strokeDasharray="3 3" />

      <text className="bub-ax" x={W - 10} y={H - 8} textAnchor="end">
        原创性 →
      </text>
      <text className="bub-ax" x={4} y={sy(10) - 6}>
        可行性 ↑
      </text>

      {placed.map((p) => {
        // 标签被挪远了（不是紧贴气泡上方的第一格）就画引导线，防对号入座错乱
        const displaced = Math.abs(p.cy - p.r - 6 - p.ly) > 8 && Math.abs(p.cy + p.r + 13 - p.ly) > 8;
        return (
          <g key={p.id} className="bub-g" onClick={() => onPick(p.id)}>
            <title>
              {`${p.label} · 原创性 ${p.x} / 可行性 ${p.y} / 价值 ${p.value.toFixed(1)}`}
            </title>
            {displaced ? (
              <line
                x1={p.cx}
                y1={p.ly > p.cy ? p.cy + p.r : p.cy - p.r}
                x2={p.lx}
                y2={p.ly + (p.ly > p.cy ? -3 : 4)}
                style={{ stroke: 'var(--ink-200)' }}
                strokeWidth={1}
              />
            ) : null}
            <circle
              cx={p.cx}
              cy={p.cy}
              r={p.r}
              fill={QUAD_COLOR[quadrantOf(p.y, p.x)] ?? '#8C6D4F'}
              fillOpacity={p.active ? 0.95 : 0.62}
              // 白描边让完全堆在一起的气泡仍能数出个数
              stroke={p.active ? '#493A33' : '#FFFCF6'}
              strokeWidth={p.active ? 1.5 : 1}
            />
            <text className="bub-lb" x={p.lx} y={p.ly} textAnchor="middle">
              {p.text}
            </text>
          </g>
        );
      })}
      {points.length === 0 ? (
        <text className="bub-ax" x={W / 2} y={H / 2} textAnchor="middle">
          还没有新版评分
        </text>
      ) : null}

      {/* 象限角标画在气泡之后：9 分档的概念落点就在右上角，先画角标必被圆点糊住。
          再配 styles.css 里的白描边（paint-order: stroke），压在气泡上也读得清 */}
      <text className="bub-zone" x={sx(10) - 5} y={sy(10) + 13} textAnchor="end">
        Wow 又新又能做
      </text>
      <text className="bub-zone" x={sx(0) + 5} y={sy(10) + 13}>
        How 做不了
      </text>
      <text className="bub-zone" x={sx(10) - 5} y={sy(5) - 5} textAnchor="end">
        Now 低垂果实
      </text>
      <text className="bub-zone" x={sx(0) + 5} y={sy(5) - 5}>
        Meh 放弃
      </text>
    </svg>
  );
}

/** 评分详情：价值分 → 四准则（带权重）→ KANO。画布节点面板与右栏共用 */
export function ScorePanel({ node }: { node: FlowNode }) {
  const s = node.data.score!;
  const setKanoManual = useStore((a) => a.setKanoManual);
  const setUserAdj = useStore((a) => a.setUserAdj);

  // 旧版数据没有权重与 KANO，不做静默换算——硬凑的分数会误导人
  if (s.v !== 2) {
    return (
      <div className="psec">
        <h3 className="plabel">评分依据</h3>
        <div className="score-row">
          <span>匹配度</span>
          <b>{(s.match ?? 0).toFixed(1)}</b>
          <span>差异度</span>
          <b>{(s.diff ?? 0).toFixed(1)}</b>
        </div>
        <ul className="reasons">
          {(s.reasons ?? []).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        {s.advice ? <div className="advice">{s.advice}</div> : null}
        <div className="legacy-note">
          旧版评分（只有匹配度 / 差异度），不含权重与 KANO，无法换算成新版价值分。建议重新评分。
        </div>
      </div>
    );
  }

  const w = s.weights ?? DEFAULT_WEIGHTS;
  const k = s.kano;
  const effective = k?.manual ?? k?.attr ?? 'O';
  // P4：有效分（用户调整优先）。界面全部读它，不读 s.value——
  // 右栏 / 象限 / 行动建议 / 文档与这里同源，不会各说各话
  const eff = effectiveScore(s);
  const adj = s.userAdj;
  const tier = valueTier(eff.value);
  const rows: { name: string; c?: { score: number; why: string }; weight: number }[] = [
    { name: '需求契合', c: s.c1, weight: w[0] },
    { name: '视觉差异', c: s.c2, weight: w[1] },
    { name: '可实现性', c: s.c3, weight: w[2] },
    { name: '情感激发', c: s.c4, weight: w[3] },
  ];
  const ADJ_KEYS = ['c1', 'c2', 'c3', 'c4'] as const;
  const assumes = assumptions(s);
  const questions = verifyQuestions(s);

  /** 写 userAdj。全清空时整字段移除（不留 {} 垃圾），还原入口共用 */
  const writeAdj = (patch: Partial<UserAdj>) => {
    const next: UserAdj = { ...(adj ?? {}), ...patch };
    for (const key of [...ADJ_KEYS, 'note'] as const) {
      if (next[key] == null || next[key] === '') delete next[key];
    }
    const hasAny = ADJ_KEYS.some((key) => next[key] != null) || !!next.note;
    setUserAdj(node.id, hasAny ? next : null);
  };

  return (
    <div className="psec">
      <h3 className="plabel">评分依据</h3>

      {/* 价值分头：有效分。有调整时 AI 原始分降级成幽灵数字，一眼看出
          「这个分被手动改过」——而不是把调整后的分当成模型结论传阅 */}
      <div className={`value-head ${tier}`}>
        <div className="value-num">{eff.value.toFixed(1)}</div>
        <div className="value-meta">
          <span className="value-lb">综合价值分{eff.adjusted ? ' · 含用户调整' : ''}</span>
          <span className={`quad-badge ${eff.quadrant}`}>
            {QUADRANT_NAME[eff.quadrant]} · {QUADRANT_HINT[eff.quadrant]}
          </span>
        </div>
      </div>
      {eff.adjusted ? (
        <div className="value-ghost">
          AI 原始分 {(s.value ?? 0).toFixed(1)}
          <button className="link-btn" onClick={() => setUserAdj(node.id, null)}>
            还原 AI 评分
          </button>
        </div>
      ) : null}
      <div className="advice">{eff.decision}</div>

      {/* 依据（置顶）：每条准则的 AI 理由 + 同意 / 我有不同看法 */}
      <div className="crit-list">
        {rows.map((r, i) => {
          const ai = r.c?.score ?? 0;
          const cur = eff.criteria[i];
          const mine = adj?.[ADJ_KEYS[i]];
          const disagree = mine != null;
          return (
            <details key={r.name} className="crit" open={disagree}>
              <summary>
                <span className="crit-n">{r.name}</span>
                <span className="crit-w">{Math.round(r.weight * 100)}%</span>
                <span className="crit-bar">
                  <i style={{ width: `${(cur / 10) * 100}%` }} />
                </span>
                <b className="crit-s">{cur.toFixed(1)}</b>
                {disagree ? <s className="crit-ai">AI {ai.toFixed(1)}</s> : null}
              </summary>
              <div className="crit-why">{r.c?.why || '（模型未给出依据）'}</div>
              <div className="crit-adj">
                <span className="crit-adj-q">这个分你认可吗？</span>
                <button
                  className={`adj-opt ${!disagree ? 'on' : ''}`}
                  onClick={() => writeAdj({ [ADJ_KEYS[i]]: undefined })}
                >
                  同意
                </button>
                <button
                  className={`adj-opt ${disagree ? 'on' : ''}`}
                  onClick={() => writeAdj({ [ADJ_KEYS[i]]: disagree ? (mine as number) : cur })}
                >
                  我有不同看法
                </button>
              </div>
              {disagree ? (
                <div className="crit-fix">
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={0.5}
                    value={mine as number}
                    aria-label={`${r.name}调整分`}
                    onChange={(e) => writeAdj({ [ADJ_KEYS[i]]: Number(e.target.value) })}
                  />
                  <b className="crit-fix-v">{(mine as number).toFixed(1)}</b>
                </div>
              ) : null}
              <div className="crit-foot">C{i + 1} 权重 {Math.round(r.weight * 100)}%（由本项目简报推导）</div>
            </details>
          );
        })}
      </div>

      {/* 调整说明：有任何调整时出现。这句话会写进交付文档——团队里
          看到这个分的人，需要知道为什么它不是 AI 给的那个数 */}
      {eff.adjusted ? (
        <input
          className="adj-note"
          placeholder="一句话说明你的调整（可选，会写进交付文档）"
          value={adj?.note ?? ''}
          onChange={(e) => writeAdj({ note: e.target.value })}
        />
      ) : null}

      {/* 假设：本判定依赖什么。模板化提取（零 AI），把「这分怎么来的」
          从模型黑盒变成可质疑的清单 */}
      <div className="talk-sec">
        <h4 className="talk-h">本判定依赖什么</h4>
        <ul className="talk-list">
          {assumes.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </div>

      {/* 待验证问题：接下来该验证什么。按低分准则 / CR / KANO 缺口生成 */}
      <div className="talk-sec">
        <h4 className="talk-h">接下来该验证什么</h4>
        <ol className="talk-list">
          {questions.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
      </div>

      {/* 进阶：权重 / CR / KANO / 版本说明。默认收起——主视线要给
          「依据 + 讨论」，模型细节留给要复核的人自己展开 */}
      <details className="score-adv">
        <summary className="fold-sum">
          <Icon name="chevronRight" size={11} className="fold-caret" />
          <span className="fold-t">进阶：权重表 · KANO · 版本说明</span>
        </summary>
        {s.crPassed === false ? (
          <div className="cr-warn">
            AHP 一致性检验未通过（CR {(s.cr ?? 0).toFixed(2)} ≥ 0.1），已使用默认权重。
          </div>
        ) : null}
        {k ? (
          <div className="kano">
            <div className="kano-h">
              <span className={`kano-badge a-${effective}`}>{ATTR_NAME[effective]}</span>
              <select
                className="kano-sel"
                value={effective}
                aria-label="KANO 主属性"
                onChange={(e) =>
                  // 判据是"当前是否已是人工值"，不能拿 AI 推断值比：
                  // 人工选了 A、AI 也推断 A 时，再点一次 A 会把人工标记清掉
                  setKanoManual(
                    node.id,
                    k.manual != null && e.target.value === k.manual ? null : (e.target.value as KanoAttr),
                  )
                }
              >
                {ATTRS.map((a) => (
                  <option key={a} value={a}>
                    {ATTR_NAME[a]}（{a}）
                  </option>
                ))}
              </select>
            </div>

            <div className="kano-src">
              {k.manual ? (
                <span className="tag manual">人工校准</span>
              ) : k.grounded ? (
                <span className="tag grounded">有用户反馈支撑</span>
              ) : (
                <span className="tag ai">AI 基于简报推断</span>
              )}
              {!k.anchored ? <span className="tag warn">简报信息不足，可信度低</span> : null}
              {k.manual ? (
                <button className="link-btn" onClick={() => setKanoManual(node.id, null)}>
                  恢复 AI 推断
                </button>
              ) : null}
            </div>

            <div className="kano-bw">
              <span>
                Better <b>{k.better.toFixed(2)}</b>
              </span>
              <span>
                Worse <b>{k.worse.toFixed(2)}</b>
              </span>
            </div>
            <p className="kano-tip">{KANO_TIP[effective]}</p>

            {k.persona ? (
              <div className="kano-line">
                <span className="kano-lb">代入画像</span>
                {k.persona}
              </div>
            ) : null}
            {k.basis ? (
              <div className="kano-line">
                <span className="kano-lb">判定依据</span>
                {k.basis}
              </div>
            ) : null}
          </div>
        ) : null}

        <p className="phint">
          价值分用于筛掉明显不靠谱的方向；±0.5 分以内应视为并列，不做精确排序。
        </p>
      </details>
    </div>
  );
}

const KANO_TIP: Record<KanoAttr, string> = {
  A: '做到能大幅提升满意度，做不到也不扣分——创意应该追求这里',
  O: '一分耕耘一分收获，做到加分、做不到扣分',
  M: '及格线，做到是本分不算亮点，做不到很致命',
  I: '用户根本不在乎，投入产出比低',
  R: '做了反而扣分，部分用户会反感',
};
