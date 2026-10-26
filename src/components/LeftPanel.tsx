import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { formatSize, KIND_LABEL } from '../lib/files';
import { useFocusSec } from '../lib/useFocusSec';
import { SeedComposer } from './SeedComposer';
import { useCopy } from './RightPanel';
import { Icon } from './Icon';

const KIND_META = {
  audience: { name: '受众画像', cls: 'k-aud' },
  competitor: { name: '竞品视觉共性', cls: 'k-cmp' },
  opportunity: { name: '机会空白点', cls: 'k-opp' },
} as const;

const CONF_CLS: Record<string, string> = { 高: 'c-hi', 中: 'c-mid', 低: 'c-lo' };

export function LeftPanel({
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
  const product = useStore((s) => s.product);
  const brief = useStore((s) => s.brief);
  const mood = useStore((s) => s.mood);
  const intel = useStore((s) => s.intel);
  const references = useStore((s) => s.references);
  const setRefParseMode = useStore((s) => s.setRefParseMode);
  const deepDiving = useStore((s) => s.deepDiving);
  const setProduct = useStore((s) => s.setProduct);
  const setBrief = useStore((s) => s.setBrief);
  const setMood = useStore((s) => s.setMood);
  const feedback = useStore((s) => s.feedback);
  const setFeedback = useStore((s) => s.setFeedback);
  const addReferences = useStore((s) => s.addReferences);
  const removeReference = useStore((s) => s.removeReference);
  /* P2-bis：统一走 startDeepDive 而不是直接 runDeepDive——画布已有内容时
     它会先弹「再挖一轮 / 清空重来」语义框，空画布才直接跑（行为不变）。 */
  const startDeepDive = useStore((s) => s.startDeepDive);
  /* ⚠️ 不能直接 `useStore((s) => s.nodes.filter(...))`：选择器每次调用都返回
     新数组，useSyncExternalStore 会判定快照不稳定 → "Maximum update depth
     exceeded" 无限循环（整棵画布树白屏，探针全挂）。先取稳定引用再派生。 */
  const allNodes = useStore((s) => s.nodes);
  const seedNodes = useMemo(() => allNodes.filter((n) => n.data.kind === 'seed' || n.data.wasSeed), [allNodes]);
  const seeds = seedNodes.length;
  const selectedId = useStore((s) => s.selectedId);
  const setSelected = useStore((s) => s.setSelected);
  const requestDelete = useStore((s) => s.requestDelete);
  const { copy, copied } = useCopy();
  // 「+ 添加种子词」的展开态：默认收起，把"第一眼"让给空画布中央卡
  const [adding, setAdding] = useState(false);

  return (
    <aside className="panel panel-left">
      <div className="phead">
        <h2 className="phead-t">
          <Icon name="seed" size={13} /> 项目 · 深潜
        </h2>
        {onCollapse ? (
          <button className="icon-btn" onClick={onCollapse} title="收起面板" aria-label="收起面板">
            <Icon name="chevronLeft" size={14} />
          </button>
        ) : null}
      </div>

      <div className="psec">
        <h3 className="plabel">项目 / 产品</h3>
        <input
          className="pinput"
          value={product}
          placeholder="例如：辣椒酱品牌升级"
          onChange={(e) => setProduct(e.target.value)}
        />
      </div>

      {/* 补充信息折叠组（第 9 步）。用原生 <details> 而不是自造折叠器：
          它自带 disclosure 语义、`<summary>` 天然可 Tab/Enter、展开状态由
          UA 维护 aria-expanded —— 自造的话这三样都得手写，写漏一处就是缺陷。
          ⚠️ 为什么「项目简报」**不**并进来：它里面包着左栏唯一的青色主按钮
          「开始深潜」。收进默认收起的折叠组等于把主行动点埋掉，而左栏顶部的
          引导、`.hintbar` 的「去澄清」、e2e 脚本的点按全都指向它。
          四个方案见 M3 实施记录 §12.8，已按方案 B 裁决。 */}
      <details className="fold">
        <summary className="fold-sum">
          <Icon name="chevronRight" size={13} className="fold-caret" />
          <h3 className="plabel fold-t">
            补充信息
            <span className="hint">可选</span>
          </h3>
        </summary>

        <div className="psec">
          <h3 className="plabel">补充方向</h3>
          <input
            className="pinput"
            value={mood}
            placeholder="想要的情绪氛围，如：危险感、冷冽、解压"
            onChange={(e) => setMood(e.target.value)}
          />
          <p className="phint">
            作为筛选镜头：AI 会优先挑简报中与它共振的内容，但不会为了迎合而编造简报里没有的东西。
          </p>
        </div>

        <div className="psec">
          <h3 className="plabel">用户反馈 / 用研结论</h3>
          <textarea
            className="parea"
            rows={2}
            value={feedback}
            placeholder="真实用户原话、问卷结论、甲方反馈…"
            onChange={(e) => setFeedback(e.target.value)}
          />
          <p className="phint">
            填了它，KANO 判定就以此为据，AI 推断降级为补充。这是把「推断」升级为「实测」成本最低的路径。
          </p>
        </div>
      </details>

      <div className="psec" data-sec="refs">
        <h3 className="plabel">
          参考资料
          <span className="hint">PDF / PPT / Word / Excel / MD / 图片</span>
        </h3>
        <Dropzone onFiles={(fs) => void addReferences(fs)} />
        {references.length ? (
          <div className="reflist">
            {references.map((r) => {
              const hasPages = (r.pages?.length ?? 0) > 0;
              // pdf/pptx 都给切换入口：没提过图片层的文件点「深度」会重解析补提，
              // PRD 要求手动覆盖是「随时可用的」，不能只在自动升级命中后才有入口
              const canToggle = r.status === 'done' && (r.kind === 'pdf' || r.kind === 'pptx');
              return (
                <div key={r.id} className="refitem">
                  <span className={`ref-badge ${r.kind}`}>{KIND_LABEL[r.kind]}</span>
                  <div className="ref-meta">
                    <div className="ref-name" title={r.name}>
                      {r.name}
                    </div>
                    <div className={`ref-sub ${r.status === 'error' ? 'err' : ''}`}>
                      {r.status === 'parsing' && `解析中 · ${formatSize(r.size)}`}
                      {r.status === 'done' &&
                        (r.kind === 'image'
                          ? `已压缩 · ${formatSize(r.size)} · 供多模态读取`
          // 文本字数与图片页数分开显示（PRD 验收：资料列表能区分两者）
                          : `已提取 ${(r.text?.length ?? 0).toLocaleString()} 字${hasPages && r.parseMode === 'deep' ? ` · 含 ${r.pages!.length} 页图片识别` : ''}`)}
                      {r.status === 'error' && (r.error ?? '解析失败')}
                    </div>
                    {r.status === 'done' && r.autoUpgraded && r.parseMode === 'deep' ? (
                      <div className="ref-notice">
                        检测到内容以图片为主，已自动启用图片识别，本次深潜将消耗较多 token
                      </div>
                    ) : null}
                    {canToggle ? (
                      <div className="ref-toggle">
                        <button
                          className={r.parseMode === 'deep' ? 'on' : ''}
                          onClick={() => void setRefParseMode(r.id, 'deep')}
                        >
                          深度解析
                        </button>
                        <button
                          className={r.parseMode === 'fast' ? 'on' : ''}
                          onClick={() => void setRefParseMode(r.id, 'fast')}
                        >
                          快速解析
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <button className="icon-btn" onClick={() => removeReference(r.id)} aria-label="移除">
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="psec" data-sec="brief">
        <h3 className="plabel">
          项目简报
          <span className="hint">可选</span>
        </h3>
        <textarea
          className="parea"
          rows={3}
          value={brief}
          placeholder="目标人群、品牌气质、使用场景…"
          onChange={(e) => setBrief(e.target.value)}
        />
        <button
          className="btn pri block"
          style={{ marginTop: 12 }}
          disabled={deepDiving || !product.trim()}
          onClick={() => startDeepDive()}
        >
          {deepDiving ? '深潜中…' : '开始深潜'}
        </button>
        <p className="phint" style={{ textAlign: 'center' }}>
          一次产出：简报 + 情报卡 + 3-4 个种子词，全部自动落到画布
        </p>
      </div>

      {/* 批次 1：种子词入口去重。首入口是空画布中央那张卡（CanvasEmpty 的
          SeedComposer size="lg"），左栏这里改为**列表与管理区**——列示、复制、
          定位、删除。输入器藏进「+ 添加」toggle：非首次添加走这里，但不再和
          中央卡抢"第一眼"（用户体验反馈：两处都能输，用户犹豫从哪开始）。 */}
      <div className="psec" data-sec="seeds">
        <h3 className="plabel">
          种子词
          {seeds ? <span className="hint">画布上已有 {seeds} 颗</span> : null}
        </h3>
        {seedNodes.length === 0 ? (
          <div className="pempty">在画布中央输入第一个词开始；「开始深潜」产出的种子也会落在这里</div>
        ) : (
          <ul className="seed-list">
            {seedNodes.map((n) => (
              <li key={n.id} className={`seed-row ${n.id === selectedId ? 'on' : ''}`}>
                <button
                  className="seed-row-l"
                  title="定位到画布（选中并平移过去）"
                  onClick={() => setSelected(n.id)}
                >
                  {n.data.label}
                </button>
                <span className={`seed-src ${n.data.seedSource ? 'ai' : 'user'}`}>
                  {n.data.seedSource ? '简报提取' : '手动添加'}
                </span>
                <div className="seed-row-acts">
                  <button
                    className="icon-btn"
                    title="复制这个词"
                    aria-label={`复制种子词 ${n.data.label}`}
                    onClick={() => void copy(n.data.label, n.id)}
                  >
                    {copied === n.id ? <Icon name="check" size={13} /> : <Icon name="copy" size={13} />}
                  </button>
                  <button
                    className="icon-btn"
                    title="删除（含它的联想词）"
                    aria-label={`删除种子词 ${n.data.label}`}
                    onClick={() => requestDelete([n.id])}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <div className="seed-add-toggle">
            <SeedComposer placeholder="再添加一颗，回车连续添加" />
          </div>
        ) : (
          <button className="btn ghost sm block seed-add-toggle" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} /> 添加种子词
          </button>
        )}
      </div>

      <div className="psec grow" data-sec="intel">
        <h3 className="plabel">
          情报卡片墙
          {intel.length ? <span className="hint">拖到画布成为种子</span> : null}
        </h3>
        {intel.length === 0 ? (
          <div className="pempty">填好项目名，点「开始深潜」生成</div>
        ) : (
          <div className="icards">
            {intel.map((c) => (
              <div key={c.id} className={`icard ${KIND_META[c.kind].cls}`}>
                <div className="icard-h">
                  <span className="icard-t">{c.title}</span>
                  <span className="icard-k">{KIND_META[c.kind].name}</span>
                </div>
                {c.summary ? (
                  <div className="icard-s">
                    {c.summary}
                    <PinNote text={c.summary} what={`情报卡 · ${c.title}`} />
                  </div>
                ) : null}
                <ul className="icard-l">
                  {c.points.map((p, i) => (
                    <li
                      key={i}
                      className="ipoint"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('application/dd-text', p.text);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                    >
                      <span className="ipoint-x">{p.text}</span>
                      <span className={`conf ${CONF_CLS[p.confidence] ?? 'c-mid'}`}>{p.confidence}</span>
                      <PinNote text={p.text} what={`情报卡 · ${c.title}`} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * P6-1「钉为便签」：把情报卡上的一句话复制成画布便签。
 *
 * 与相邻的拖动是两件事，必须并存且说得清：
 *   拖 = 把这句话**当种子**丢进画布去裂变（它会被当作一个词展开）；
 *   钉 = 把这句话**当批注**贴到画布上（原样保留，不改写）。
 * 前者是输入，后者是旁注。
 */
function PinNote({ text, what }: { text: string; what: string }) {
  const pinNote = useStore((s) => s.pinNote);
  return (
    <button
      className="icard-pin"
      title="钉成便签（原样贴到画布，不参与裂变）"
      aria-label={`把这条钉成便签`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void pinNote(text, what);
      }}
    >
      <Icon name="pin" size={10} />
    </button>
  );
}

function Dropzone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onClick={() => ref.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length) onFiles(files);
        }}
      >
        <div className="dropzone-t">点击选择，或把文件拖到这里</div>
        <div className="dropzone-s">PDF 提取全文 · PPTX / Word / Excel 提取文字 · Markdown / TXT / HTML 直读 · 图片交给多模态模型读</div>
      </div>
      <input
        ref={ref}
        type="file"
        multiple
        accept=".pdf,.pptx,.ppt,.docx,.xlsx,.odt,.html,.htm,.rtf,.md,.markdown,.txt,.csv,.tsv,.json,image/*"
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

