import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOnViewportChange, useReactFlow } from '@xyflow/react';
import { useStore, type FlowNode } from '../store/useStore';
import { useLinkedImages } from '../lib/links';
import { VISION_DIMS } from '../types';
import { Icon } from './Icon';
import {
  AssetSection,
  BriefBlock,
  ComboSection,
  PromptBox,
  ScorePanel,
  useCopy,
} from './RightPanel';

/**
 * 节点内嵌详情。
 *
 * 上一版做成了浮在画布上的独立面板（NodeDock），实测两个致命问题：
 * 1. 内容一长就溢出画布底部（实测超出 564px），得在里面滚一个"窗中窗"
 * 2. 面板跟着视口走，一拖画布面板就漂，用户只好把它收起来——等于白做
 *
 * 所以详情直接长在节点卡片里：位置锚死、跟着节点一起平移缩放，
 * 且**同一时刻只允许一个节点展开**（store.expandedId），画布不会被撑散。
 *
 * 高度用 300px 封顶 + 内滚动，配 tab 切换。tab 是这里的关键：
 * 评分 + 简报 + 三条提示词 + 参考图纵向堆下来接近 2000px，
 * 任何一个"展开即全显"的方案都会变成一场无尽的滚动。
 */

type Tab = 'score' | 'brief' | 'prompts' | 'assets';

const TAB_META: { key: Tab; label: string; icon: 'gauge' | 'doc' | 'wand' | 'image' }[] = [
  { key: 'score', label: '评分', icon: 'gauge' },
  { key: 'brief', label: '简报', icon: 'doc' },
  { key: 'prompts', label: '提示词', icon: 'wand' },
  { key: 'assets', label: '参考图', icon: 'image' },
];

/** 判断一个节点有没有可展开的详情——没有就不给展开入口，避免空盒子 */
export function nodeHasDetail(d: FlowNode['data']): boolean {
  return (
    !!d.score || !!d.brief || !!d.prompts || !!d.visual || !!d.images?.length || !!d.combo
  );
}

/** 只有「词」能出创意简报。图片/情报卡节点出简报会把节点类型改成 concept，不可逆 */
function isWordLike(kind: FlowNode['data']['kind']): boolean {
  return kind === 'seed' || kind === 'word' || kind === 'concept';
}

/**
 * P2 出图评价：概念详情「评分」tab 顶部的块。
 *
 * 把「这个分是给哪套出图打的」显式化——关联图横排，每张图一个本地
 * 「留用 / 淘汰」标记（纯人工决策，不调 AI）。评分与象限就在这块下方，
 * 视线顺序 = 先看这一轮的图，再回头看分。
 *
 * 没有关联图时整块不渲染：空块只会把「评分」tab 变得更长。
 */
function ImageEval({ node }: { node: FlowNode }) {
  const linked = useLinkedImages(node.id);
  const setImageKeep = useStore((s) => s.setImageKeep);
  const setSelected = useStore((s) => s.setSelected);
  const toggleExpand = useStore((s) => s.toggleExpand);
  const expandedId = useStore((s) => s.expandedId);
  if (!linked.length) return null;
  return (
    <div className="psec">
      <h3 className="plabel">
        出图评价
        <span className="phint inline">分是给这套出图打的</span>
      </h3>
      <div className="eval-row">
        {linked.map((img) => {
          const first = img.data.images?.[0];
          const keep = img.data.keep;
          // P6-3：这套图提取过哪些维度，就摊在这张图下面——评价一张图时
          // 「它的风格是什么」和「留不留」是同一个判断的两半。
          // 点一下就跳到那张图的参考图 tab（不是另开面板，画布不许再飘窗）
          const dims = img.data.visual?.dims ?? {};
          const have = VISION_DIMS.filter((d) => dims[d.key]);
          return (
            <div key={img.id} className={`eval-i ${keep === true ? 'keep' : keep === false ? 'drop' : ''}`}>
              {first ? (
                <img src={first.dataUrl} alt={img.data.label} title={img.data.label} />
              ) : (
                <div className="eval-noimg">无图</div>
              )}
              <div className="eval-name" title={img.data.label}>
                {img.data.label}
              </div>
              {have.length ? (
                <div className="eval-dims">
                  {have.map((d) => (
                    <button
                      key={d.key}
                      className="eval-dim"
                      title={`${d.label}：${dims[d.key]!.text}`}
                      onClick={() => {
                        setSelected(img.id);
                        if (expandedId !== img.id) toggleExpand(img.id);
                      }}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="eval-acts">
                <button
                  className={`eval-k ${keep === true ? 'on' : ''}`}
                  onClick={() => setImageKeep(img.id, true)}
                >
                  留用
                </button>
                <button
                  className={`eval-k ${keep === false ? 'on' : ''}`}
                  onClick={() => setImageKeep(img.id, false)}
                >
                  淘汰
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function NodeBody({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  if (!node) return null;
  return <NodeBodyInner node={node} />;
}

function NodeBodyInner({ node }: { node: FlowNode }) {
  const d = node.data;
  const ref = useRef<HTMLDivElement>(null);
  const { copy, copied } = useCopy();
  const runScore = useStore((s) => s.runScore);
  const runPrompts = useStore((s) => s.runPrompts);
  const runBrief = useStore((s) => s.runBrief);
  const runPlan = useStore((s) => s.runPlan);
  const toggleExpand = useStore((s) => s.toggleExpand);
  const { getViewport, setViewport } = useReactFlow();

  // 详情是一张从节点侧面伸出的卡片（见 styles.css 的 .nd-body），伸左还是伸右
  // 由画布上哪边更空决定；下方放不下就改成向上长。
  //
  // 上一版让节点自己变宽变高，详情直接长在右邻和下邻头上——实测展开一个词会
  // 压住两个邻居，连自己的色卡都被顶掉。现在节点尺寸不变，只把卡片挪到空地上。
  const [place, setPlace] = useState<{ side: 'l' | 'r'; up: boolean }>({ side: 'r', up: false });

  /**
   * 卡片自身的"回边"补偿（P6 收口）。
   *
   * 上面的平移只在展开时抢一次镜头——它解决的是"点开的这一刻卡片在画布外"。
   * 但镜头之后还会动（适应视图、拖节点、拖画布），卡片就被画布边界裁掉一条：
   * e2e 里实测「留用」只剩 13px 可见、点不着（30s 超时）。
   * 这时候再抢镜头就成了"我拖画布它跟我抢"，很烦。
   * 所以改成只动卡片：用 transform 把自己推回画布内，镜头一动不动。
   *
   * 算法是**绝对量**而不是增量：getBoundingClientRect 里已经含了上一次的补偿，
   * 先减掉它还原出"没有补偿时卡片长在哪"，再据此算这一次该补多少。
   * 增量式（在当前位置上再加需要的量）会因为"补过头→判定不超界→不补"而收敛到错的位置；
   * 而且量到的是过渡/动画中的中间值时会一路累加跑飞（实测补出 2000px+）。
   * 所以顺带定了一条：.nd-body 上**不许加 transform 过渡**（见 styles.css）。
   *
   * 单位要除 zoom：transform 写在节点的局部坐标里，会被视口缩放再乘一遍。
   */
  const [shift, setShift] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const shiftRef = useRef(shift);
  shiftRef.current = shift;

  const reclamp = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const wrap = el.closest('.canvas-wrap');
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const z = getViewport().zoom || 1;
    const s = shiftRef.current;
    // 还原出"没有补偿时的卡片位置"：补偿是纯平移，屏幕上就是 s × zoom
    const l = r.left - s.x * z;
    const rt = r.right - s.x * z;
    const t = r.top - s.y * z;
    const b = r.bottom - s.y * z;
    const m = 12; // 离边留一点，别贴着画布边缘
    // 先按"右边超了往左推"，再按"左边超了往右推"——两边不可能同时成立，
    // 后者优先，保证卡片左边缘（标题、按钮那一侧）一定看得见
    let dx = Math.max(0, wr.right - m - rt);
    dx = Math.max(dx, wr.left + m - l);
    let dy = Math.max(0, wr.bottom - m - b);
    dy = Math.max(dy, wr.top + m - t);
    const nx = Math.round((dx / z) * 100) / 100;
    const ny = Math.round((dy / z) * 100) / 100;
    // 差得太小就别 setState：0.01px 的抖动会变成每帧一次重渲染
    if (Math.abs(nx - s.x) > 0.05 || Math.abs(ny - s.y) > 0.05) setShift({ x: nx, y: ny });
  }, [getViewport]);

  // 镜头每次停稳后回头看一眼：还超界就把卡片推回来（不动镜头）
  useOnViewportChange({ onEnd: () => reclamp() });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nodeEl = el.closest('.react-flow__node');
    const wrap = el.closest('.canvas-wrap');
    if (!nodeEl || !wrap) return;

    const nr = nodeEl.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const m = 24;
    // 右侧空得多就往右伸，否则往左
    const side = wr.right - nr.right >= nr.left - wr.left ? 'r' : 'l';
    // 下方要放不下、而上方更宽敞 → 向上长。
    // 判据必须只跟节点/画布有关：用卡片当前 bottom 去判会自己推翻自己
    // （伸下去→出界→改成向上→不出界→又伸下去），React 直接报 update depth 爆栈。
    const h = el.getBoundingClientRect().height;
    const spaceDown = wr.bottom - nr.top;
    const spaceUp = nr.bottom - wr.top;
    const up = spaceDown < h + m && spaceUp > spaceDown;

    if (side !== place.side || up !== place.up) {
      setPlace({ side, up });
      return; // 换边了，等下一轮拿到新位置再算平移
    }

    // 节点 + 卡片整体还在可视区外 → 平移一点把它带进来。
    // 用户点开详情是来看内容的，不是来玩"拖画布找内容"的。只在真溢出时才动。
    //
    // 这次平移把镜头挪走之前先把补偿清零：两者都在干"让卡片可见"这件事，
    // 叠加起来会一次推两倍距离。
    const raf = requestAnimationFrame(() => {
      const s = shiftRef.current;
      const z = getViewport().zoom || 1;
      setShift({ x: 0, y: 0 });
      const raw = el.getBoundingClientRect();
      // 量到的位置含上一次的回边补偿，先减掉——不然会拿"已经被推开的位置"
      // 去算镜头该挪多少，算出个不需要挪的结果
      const r = {
        left: raw.left - s.x * z,
        right: raw.right - s.x * z,
        top: raw.top - s.y * z,
        bottom: raw.bottom - s.y * z,
      };
      const left = Math.min(nr.left, r.left);
      const right = Math.max(nr.right, r.right);
      const top = Math.min(nr.top, r.top);
      const bottom = Math.max(nr.bottom, r.bottom);
      const dy = Math.max(0, bottom - (wr.bottom - m)) - Math.min(0, top - (wr.top + m));
      const dx = Math.max(0, right - (wr.right - m)) - Math.min(0, left - (wr.left + m));
      if (!dy && !dx) return;
      const vp = getViewport();
      setViewport({ x: vp.x - dx, y: vp.y - dy, zoom: vp.zoom }, { duration: 320 });
    });
    // 平移是 320ms 的动画，落定之后再兜一次底：画布窄的时候一次平移未必够
    const settle = setTimeout(() => reclamp(), 420);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settle);
    };
    // 只在挂载与换边时做，不要在内容变化时反复抢镜头
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place.side, place.up]);


  const tabs = useMemo(() => {
    const out: Tab[] = [];
    if (d.score || d.combo?.synergy != null) out.push('score');
    if (d.brief || d.visual) out.push('brief');
    if (d.prompts) out.push('prompts');
    out.push('assets'); // 参考图 tab 兼作「挂载图片」入口，永远保留
    return out;
  }, [!!d.score, !!d.brief, !!d.prompts, !!d.visual, d.combo?.synergy != null, !!d.images?.length]);

  const [tab, setTab] = useState<Tab>(tabs[0] ?? 'assets');
  const active = tabs.includes(tab) ? tab : tabs[0];

  // 换 tab 会换高度（评分 tab 比参考图 tab 长得多），换完重算一次回边补偿。
  // 跳过首次：挂载那一刻位置还没定，紧接着的"带回可视区"会重新摆一次，不该抢跑
  const firstTab = useRef(true);
  useLayoutEffect(() => {
    if (firstTab.current) {
      firstTab.current = false;
      return;
    }
    reclamp();
  }, [active, reclamp]);

  return (
    <div
      ref={ref}
      className={`nd-body nodrag nowheel side-${place.side} ${place.up ? 'up' : ''}`}
      style={shift.x || shift.y ? { transform: `translate(${shift.x}px, ${shift.y}px)` } : undefined}
    >
      <div className="ndb-tabs">
        {TAB_META.filter((t) => tabs.includes(t.key)).map((t) => (
          <button
            key={t.key}
            className={`ndb-tab ${active === t.key ? 'on' : ''}`}
            onClick={() => setTab(t.key)}
          >
            <Icon name={t.icon} size={11} />
            {t.label}
            {t.key === 'assets' && d.images?.length ? <i className="ndb-n">{d.images.length}</i> : null}
          </button>
        ))}
      </div>

      <div className="ndb-scroll">
        {active === 'score' ? (
          <>
            {d.kind === 'concept' ? <ImageEval node={node} /> : null}
            {d.combo?.synergy != null ? <ComboSection node={node} /> : null}
            {d.score ? <ScorePanel node={node} /> : null}
          </>
        ) : null}

        {active === 'brief' ? (
          <>
            {d.brief ? (
              <>
                <BriefBlock label="核心意象" value={d.brief.imagery} />
                <BriefBlock label="色彩建议" value={d.brief.color} />
                <BriefBlock label="字体气质" value={d.brief.font} />
                <BriefBlock label="图形语言" value={d.brief.shape} />
                <BriefBlock label="设计策略" value={d.brief.strategy} />
              </>
            ) : null}
            {/* P6-3：参考图结论搬到「参考图」tab 按四维分组了（那里有来源标注与
                按需重提）。这里只留一句去处提示，不再把六段文字再抄一遍 */}
            {d.visual ? (
              <p className="phint inline">参考图特征见「参考图」tab（按配色 / 风格 / 构图 / 排版分组）</p>
            ) : null}
            {!d.brief && !d.visual ? (
              <div className="pempty">还没有简报，点「一键出方案」生成</div>
            ) : null}
          </>
        ) : null}

        {active === 'prompts' ? (
          d.prompts ? (
            <>
              <PromptBox
                name="GPT Image 2"
                text={d.prompts.gpt}
                onCopy={() => copy(d.prompts!.gpt, 'gpt')}
                copied={copied === 'gpt'}
              />
              <PromptBox
                name="即梦 4.5"
                text={d.prompts.jimeng}
                onCopy={() => copy(d.prompts!.jimeng, 'jm')}
                copied={copied === 'jm'}
              />
              <PromptBox
                name="Midjourney"
                text={d.prompts.mj}
                onCopy={() => copy(d.prompts!.mj, 'mj')}
                copied={copied === 'mj'}
              />
              {d.prompts.negative ? (
                <PromptBox
                  name="负向提示"
                  text={d.prompts.negative}
                  onCopy={() => copy(d.prompts!.negative ?? '', 'neg')}
                  copied={copied === 'neg'}
                />
              ) : null}
            </>
          ) : (
            <div className="pempty">还没有提示词，点「一键出方案」生成</div>
          )
        ) : null}

        {active === 'assets' ? <AssetSection node={node} /> : null}
      </div>

      {/* 单步重跑放在对应 tab 里：想只重出提示词的时候不必把评分也重跑一遍。
          收起按钮也放这里——展开后卡片变大，右下角的悬浮徽标会压到底栏 */}
      <div className="ndb-foot">
        <button className="btn xs ghost ndb-fold" onClick={() => toggleExpand(node.id)}>
          <Icon name="chevronDown" size={11} /> 收起详情
        </button>
        {active === 'score' ? (
          <button className="btn xs" disabled={d.busy} onClick={() => void runScore(node.id)}>
            <Icon name="gauge" size={11} /> 重新评分
          </button>
        ) : null}
        {active === 'brief' && isWordLike(d.kind) ? (
          <button className="btn xs" disabled={d.busy} onClick={() => void runBrief(node.id)}>
            <Icon name="doc" size={11} /> 重出简报
          </button>
        ) : null}
        {active === 'prompts' ? (
          <button className="btn xs" disabled={d.busy} onClick={() => void runPrompts(node.id)}>
            <Icon name="wand" size={11} /> 重出提示词
          </button>
        ) : null}
        {/* 图片 / 情报卡节点不给「出方案」——它们的价值是「被看见」，不是长成一个概念 */}
        {isWordLike(d.kind) ? (
          <button className="btn xs aqua" disabled={d.busy} onClick={() => void runPlan(node.id)}>
            <Icon name="sparkles" size={11} /> 一键出方案
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 展开/收起按钮。常驻在节点右下角——
 * 只在选中时才给入口的话，用户得先点中再点开，多一步。
 */
export function DetailToggle({ id, open }: { id: string; open: boolean }) {
  const toggleExpand = useStore((s) => s.toggleExpand);
  return (
    <button
      className={`nd-detail ${open ? 'on' : ''}`}
      title={open ? '收起详情' : '展开详情'}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        toggleExpand(id);
      }}
    >
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
      {open ? '收起' : '详情'}
    </button>
  );
}
