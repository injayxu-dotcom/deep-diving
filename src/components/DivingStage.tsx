import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import ddLogo from '../assets/DD-logo.svg';

/**
 * 简报确认 → 画布之间的过渡页（stage = 'diving'）。
 *
 * 原来点「确认，进入画布」是**瞬间**切过去的：用户看到一块空地，然后节点一个个
 * 冒出来，中间那 20-60 秒 AI 在干什么完全不可见。产品叫「深潜」，可最深的那一段
 * 用户什么也没看见 —— 这个页面就是把那一段补上。
 *
 * 三件事：
 * 1. **让等待有形状**：下潜深度 + 四步清单。深度用渐近函数逼近 10900m，永远不到顶
 *    （任务没完成就显示 100% 是撒谎）；清单只陈述"正在做哪一件事"，不报百分比。
 * 2. **让用户能插手**：右侧可以随手记种子词。深潜是 AI 的事，但这个项目的判断
 *    不该只有 AI 有份 —— 而且等待时人最容易冒出想法，不给入口就流失了。
 * 3. **不困住人**：可以跳过等待直接进画布，深潜在后台照常跑完。
 *
 * 失败时不退回简报页：那会让人以为白干了一场。留在这里，把"你记的词还在"
 * 和"重试"都摆在明面上。
 */

const STEPS = ['行业现状与主要品牌', '竞品视觉与调性', '色彩 / 字体 / 色调', 'SWOT 与机会空白'];

/** 挑战者深渊深度。作为"深度"的参考系，不是进度条刻度 */
const FLOOR = 10900;

export function DivingStage() {
  const deepDiving = useStore((s) => s.deepDiving);
  const product = useStore((s) => s.product);
  const diveSeeds = useStore((s) => s.diveSeeds);
  const addDiveSeed = useStore((s) => s.addDiveSeed);
  const removeDiveSeed = useStore((s) => s.removeDiveSeed);
  const runDeepDive = useStore((s) => s.runDeepDive);
  const goReport = useStore((s) => s.goReport);
  const skipDiving = useStore((s) => s.skipDiving);

  const [depth, setDepth] = useState(0);
  const [step, setStep] = useState(0);
  const [v, setV] = useState('');

  // 深度：1 - e^(-t/14)，14 秒走到约六成，之后越走越慢
  useEffect(() => {
    if (!deepDiving) return;
    const t0 = Date.now();
    const id = window.setInterval(() => {
      const el = (Date.now() - t0) / 1000;
      setDepth(Math.round(FLOOR * (1 - Math.exp(-el / 14))));
    }, 160);
    return () => window.clearInterval(id);
  }, [deepDiving]);

  // 清单：每 5.2 秒前进一格，停在最后一条等接口返回。
  // 不循环回第一条 —— 转第二圈会让人以为卡住了在重跑。
  useEffect(() => {
    if (!deepDiving) return;
    setStep(0);
    const id = window.setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 5200);
    return () => window.clearInterval(id);
  }, [deepDiving]);

  const submit = () => {
    if (!v.trim()) return;
    addDiveSeed(v);
    setV('');
  };

  return (
    <div className="stage stage-diving">
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
          <span className="crumb done">项目简报</span>
          <span className="crumb-sep">→</span>
          <span className={deepDiving ? 'crumb on' : 'crumb'}>
            {deepDiving ? '正在深潜' : '深潜中断'}
          </span>
          <span className="crumb-sep">→</span>
          <span className="crumb">发散画布</span>
        </div>

        <div className="stage-top-acts" />
      </header>

      <div className="dive-body">
        {deepDiving ? (
          <>
            <div className="dive-core">
              <div className="dive-mark-wrap">
                <img className="dive-mark" src={ddLogo} alt="" aria-hidden="true" />
              </div>

              <div className="dive-depth" aria-live="off">
                −{depth.toLocaleString()} <span className="dive-depth-u">m</span>
              </div>

              <h2 className="dive-title">正在深潜</h2>
              <p className="dive-sub">
                {product.trim() || '这个项目'}的行业、竞品、视觉与机会空白，一次潜到底。
              </p>

              <ol className="dive-steps">
                {STEPS.map((s, i) => (
                  <li key={s} className={i < step ? 'done' : i === step ? 'on' : ''}>
                    <i className="dive-dot" aria-hidden="true" />
                    {s}
                  </li>
                ))}
              </ol>
            </div>

            <aside className="dive-side">
              <div className="dive-side-h">你想到的，先记下来</div>
              <p className="dive-side-s">
                盯着进度条等是最浪费的三十秒。想到什么就写什么，不用管它属于哪个维度 ——
                深潜结束后会和你一起上画布。
              </p>

              <div className="dive-add">
                <input
                  className="pinput"
                  value={v}
                  placeholder="一个词，例如：锈蚀"
                  maxLength={40}
                  aria-label="记一个种子词"
                  onChange={(e) => setV(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    // 输入法组词时的回车是选词，不是提交
                    if (e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    submit();
                  }}
                />
                <button className="btn aqua" disabled={!v.trim()} onClick={submit}>
                  记下
                </button>
              </div>

              {diveSeeds.length ? (
                <ul className="dive-chips">
                  {diveSeeds.map((w) => (
                    <li key={w}>
                      <span>{w}</span>
                      <button
                        className="icon-btn"
                        onClick={() => removeDiveSeed(w)}
                        aria-label={`移除 ${w}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="dive-empty">还没有。这里记的词会直接长成画布上的种子。</p>
              )}
            </aside>
          </>
        ) : (
          <div className="dive-fail">
            <div className="dive-fail-mark" aria-hidden="true">
              !
            </div>
            <h2 className="dive-fail-t">深潜中断了</h2>
            <p className="dive-fail-s">
              具体原因见弹出的提示。简报和参考资料都还在，不用重来。
              <br />
              多半是网络、额度，或当前模型不支持读图。
            </p>
            {diveSeeds.length ? (
              <p className="dive-fail-note">
                你记下的 {diveSeeds.length} 个种子词还留着：{diveSeeds.join('、')}
              </p>
            ) : null}
            <div className="dive-fail-acts">
              <button className="btn ghost" onClick={goReport}>
                ← 回到简报
              </button>
              <button className="btn pri" onClick={() => void runDeepDive()}>
                重试深潜
              </button>
            </div>
          </div>
        )}
      </div>

      {deepDiving ? (
        <div className="dive-foot">
          <span className="dive-foot-note">通常 20–60 秒，取决于模型与参考资料的数量</span>
          <button className="link-btn" onClick={skipDiving}>
            跳过等待，先进画布 →
          </button>
        </div>
      ) : null}
    </div>
  );
}
