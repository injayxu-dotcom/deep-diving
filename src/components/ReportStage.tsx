import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import { KIND_LABEL } from '../lib/files';
import ddLogo from '../assets/DD-logo.svg';

/**
 * F10 Stage 2：项目简报确认（PRD 10.3）。
 *
 * AI 已把澄清对话整理成简报草稿，这里以**可编辑表单**呈现——这是后续所有发散的地基，
 * 必须能改。确认后写入字段、进入画布并触发深潜（一次产出简报 + 情报卡 + 种子词）。
 */
export function ReportStage() {
  const product = useStore((s) => s.product);
  const brief = useStore((s) => s.brief);
  const mood = useStore((s) => s.mood);
  const feedback = useStore((s) => s.feedback);
  const references = useStore((s) => s.references);
  const clarify = useStore((s) => s.clarify);
  const removeReference = useStore((s) => s.removeReference);
  const setProduct = useStore((s) => s.setProduct);
  const setBrief = useStore((s) => s.setBrief);
  const setMood = useStore((s) => s.setMood);
  const setFeedback = useStore((s) => s.setFeedback);
  const goClarify = useStore((s) => s.goClarify);
  const enterCanvasFromReport = useStore((s) => s.enterCanvasFromReport);
  const hasKey = useStore((s) => !!s.settings.apiKey.trim());

  const ctx = useMemo(() => {
    const rounds = clarify.filter((m) => m.role === 'ai' && (m.questions?.length ?? 0) > 0).length;
    const lastSummary = [...clarify].reverse().find((m) => m.role === 'ai' && m.summary)?.summary;
    return { rounds, lastSummary };
  }, [clarify]);

  return (
    <div className="stage stage-report">
      <header className="stage-top">
        <span className="brand">
          <span className="brand-mark">
            <img src={ddLogo} alt="" aria-hidden="true" />
          </span>
          <span className="brand-txt">
            <h1 className="brand-name">创意深潜</h1>
            <span className="brand-sub">Deep Diving</span>
          </span>
        </span>

        <div className="rp-crumbs" aria-label="流程步骤">
          <span className="crumb done">需求澄清</span>
          <span className="crumb-sep">→</span>
          <span className="crumb on">项目简报</span>
          <span className="crumb-sep">→</span>
          <span className="crumb">发散画布</span>
        </div>

        <div className="stage-top-acts" />
      </header>

      <div className="stage-body">
        <div className="rp-card">
          {/* P0-3：简报页 hero。这是"进画布前的最后一道闸"，用插画收一下视线，
              别让人一上来就面对一整页表单。 */}
          <img className="rp-mark" src={ddLogo} alt="" aria-hidden="true" />
          <h2 className="rp-title">项目简报</h2>
          <p className="rp-sub">
            这是后面所有发散的地基，请务必过一遍。AI 草稿来自 {Math.max(ctx.rounds, 1)} 轮澄清对话；
            行业 / 竞品 / 视觉共性等深度分析将在进入画布后由「深潜」一次生成。
          </p>

          {ctx.lastSummary ? (
            <div className="rp-ctx">
              <span className="rp-ctx-label">对话摘要</span>
              {ctx.lastSummary}
            </div>
          ) : null}

          <div className="rp-field">
            <label className="plabel">
              项目 / 产品
              <span className="hint">必填 · 画布与简报都以它命名</span>
            </label>
            <input className="pinput" value={product} onChange={(e) => setProduct(e.target.value)} placeholder="例如：辣椒酱品牌升级" />
          </div>

          <div className="rp-field">
            <label className="plabel">
              项目简报
              <span className="hint">目标人群 / 使用场景 / 要解决的问题 / 边界 / 视觉预期</span>
            </label>
            <textarea
              className="parea"
              rows={7}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="AI 会基于对话整理，你也可以直接改写…"
            />
          </div>

          <div className="rp-row">
            <div className="rp-field">
              <label className="plabel">
                补充方向
                <span className="hint">可选</span>
              </label>
              <input className="pinput" value={mood} onChange={(e) => setMood(e.target.value)} placeholder="情绪氛围，如：危险感、冷冽、解压" />
            </div>
            <div className="rp-field">
              <label className="plabel">
                用户反馈 / 用研结论
                <span className="hint">可选 · KANO 判定以此为准</span>
              </label>
              <textarea
                className="parea"
                rows={2}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="真实用户原话、问卷结论、甲方反馈…"
              />
            </div>
          </div>

          {references.length ? (
            <div className="rp-field">
              <label className="plabel">
                参考资料
                <span className="hint">{references.length} 份 · 深潜时作为上下文</span>
              </label>
              <div className="cl-refs">
                {references.map((r) => (
                  <span key={r.id} className="cl-ref">
                    <span className={`ref-badge ${r.kind}`}>{KIND_LABEL[r.kind]}</span>
                    <span className="ref-name" title={r.name}>
                      {r.name}
                    </span>
                    <button className="icon-btn" onClick={() => removeReference(r.id)} aria-label="移除资料">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="rp-acts">
            <button className="btn ghost" onClick={goClarify}>
              ← 返回继续补充
            </button>
            <button
              className="btn pri"
              disabled={!product.trim()}
              onClick={() => void enterCanvasFromReport()}
            >
              确认，进入画布 →
            </button>
          </div>

          {!hasKey ? (
            <p className="rp-keyhint">
              尚未配置 API Key：确认后仍可进入画布手动输入种子词；配置 Key 后再点「开始深潜」可让 AI 补齐简报与种子词。
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
