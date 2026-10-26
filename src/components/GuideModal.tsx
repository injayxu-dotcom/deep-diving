import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import ddLogo from '../assets/DD-logo.svg';

const TITLES = ['这是什么', '怎么用', '几个提示'];

/**
 * 首次引导弹窗。
 *
 * 三屏而不是一屏塞满：一屏塞 800 字没人会读，分屏后每屏只有一个主张。
 *
 * 交互上刻意做了三件事：
 * 1. 点遮罩**不关闭**——引导最怕误触跳过
 * 2. 「以后不再弹出」默认不勾——默认值替用户做决定是耍流氓
 * 3. 「开始使用」只在最后一屏出现，前三屏只能「下一步」
 */
export function GuideModal() {
  const open = useStore((s) => s.guideOpen);
  const closeGuide = useStore((s) => s.closeGuide);
  const apiKey = useStore((s) => s.settings.apiKey);
  const openSettings = useStore((s) => s.openSettings);
  const [step, setStep] = useState(0);
  const [never, setNever] = useState(false);

  // 每次打开都从第一屏开始，否则二次唤起会停在上次离开的位置
  useEffect(() => {
    if (open) {
      setStep(0);
      setNever(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeGuide(never);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, never, closeGuide]);

  if (!open) return null;

  const last = step === TITLES.length - 1;

  return (
    <div className="modal-mask">
      <div className="modal modal-guide" role="dialog" aria-label="使用引导">
        <div className="modal-h">
          <span className="guide-h">
            <span className="guide-dot" />
            欢迎使用创意深潜
          </span>
          <button className="icon-btn" onClick={() => closeGuide(never)} aria-label="跳过引导">
            ×
          </button>
        </div>

        <div className="guide-body">
          {step === 0 ? (
            <>
              {/* P0-3：引导第一屏是"这个东西是什么"——放完整插画，别放字。
                  只有第一屏放：后面两屏是操作说明，插画会挤掉正文的注意力。 */}
              <img className="guide-mark" src={ddLogo} alt="" aria-hidden="true" />
              <ScreenWhat />
            </>
          ) : null}
          {step === 1 ? <ScreenHow /> : null}
          {step === 2 ? <ScreenTips never={never} onToggle={setNever} /> : null}
        </div>

        <div className="guide-f">
          <div className="guide-steps">
            {TITLES.map((t, i) => (
              <button
                key={t}
                className={`guide-step ${i === step ? 'on' : ''}`}
                onClick={() => setStep(i)}
                aria-label={`第 ${i + 1} 屏：${t}`}
                aria-current={i === step}
              />
            ))}
          </div>
          <span className="guide-step-t">{TITLES[step]}</span>
          <div className="guide-acts">
            {step > 0 ? (
              <button className="btn ghost" onClick={() => setStep(step - 1)}>
                上一屏
              </button>
            ) : null}
            {last ? (
              /* 没配 Key 时不要放人进空转的首屏：引导结束时正是「接下来该干什么」
                 最清楚的时刻，直接把这步做掉。配过了就还是原来的「开始使用」。 */
              <button
                className="btn pri"
                onClick={() => {
                  closeGuide(never);
                  if (!apiKey.trim()) openSettings();
                }}
              >
                {apiKey.trim() ? '开始使用' : '去配置 AI 接口'}
              </button>
            ) : (
              <button className="btn pri" onClick={() => setStep(step + 1)}>
                下一步
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ScreenWhat() {
  return (
    <>
      <p className="guide-lead">一个帮视觉设计师把「模糊需求」变成「可执行创意方向」的工作台。</p>
      <p className="guide-p">它不会替你做设计。它只做三件事：</p>
      <ol className="guide-list">
        <li>
          <b>问清楚</b>——用对话把你的需求挖到底，而不是让你填表单
        </li>
        <li>
          <b>发散开</b>——从一个词裂变出六个维度的联想，逼出你想不到的方向
        </li>
        <li>
          <b>收回来</b>——用可解释的评分帮你判断哪些方向值得推进
        </li>
      </ol>
      <p className="guide-foot">你的判断始终是最终决定。AI 只负责穷举和解释。</p>
    </>
  );
}

function ScreenHow() {
  return (
    <ol className="guide-steps-list">
      <li>
        <b>说清楚你要什么</b>
        <span>回答几个问题，不用写长文，选一选、填几个词就行。AI 会像甲方追问一样，把你的真实需求挖出来。</span>
      </li>
      <li>
        <b>确认项目简报</b>
        <span>
          AI 把对话整理成一份简报：行业现状、竞品是谁、视觉共性、你的机会在哪。
          <em>这份简报是后面所有发散的地基</em>，请务必看一眼、改一改。
        </span>
      </li>
      <li>
        <b>在画布上发散</b>
        <span>双击任意种子词 → 打开六维裂变轮盘 → 选一个维度 → 长出一批联想词。觉得哪个有意思就继续裂变它。</span>
      </li>
      <li>
        <b>收敛并转成可执行方案</b>
        <span>框选几个词 → 组合收敛 → 拿到评分 → 生成创意简报 → 一键得到 GPT Image 2 / 即梦 4.5 / Midjourney 三条提示词。</span>
      </li>
    </ol>
  );
}

function ScreenTips({ never, onToggle }: { never: boolean; onToggle: (v: boolean) => void }) {
  return (
    <>
      <ul className="guide-tips">
        <li>
          <b>要先去拿一个 AI Key</b>：深潜全程由 AI 驱动。点「去配置 AI 接口」，
          Agnes 承诺长期免费，邮箱注册 30 秒就能拿到，不用绑卡。
        </li>
        <li>在空白处拖一下框住几个词，或者 Shift+点击 逐个加选，就能一起组合收敛</li>
        <li>拖动种子词时，它的联想词会一起走，不用担心画布变乱</li>
        <li>上传的参考资料会作为 AI 的上下文：PDF / PPTX 提取文字和图，Markdown 原文直读，图片交给多模态模型</li>
        <li>出错了会有弹窗告诉你哪一步出了问题，不用去翻日志</li>
        <li>内容自动云端同步，换设备打开接着用</li>
      </ul>
      <label className="guide-never">
        <input type="checkbox" checked={never} onChange={(e) => onToggle(e.target.checked)} />
        <span>以后不再弹出</span>
      </label>
    </>
  );
}
