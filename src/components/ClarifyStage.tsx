import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, MAX_CLARIFY_ROUNDS } from '../store/useStore';
import { KIND_LABEL } from '../lib/files';
import type { ClarifyQuestion } from '../types';
import ddLogo from '../assets/DD-logo.svg';
import { Icon } from './Icon';

/**
 * F10 Stage 1：苏格拉底式需求澄清对话（PRD 10.2 / 10.2b）。
 *
 * 视觉规格要点：全屏居中 720px、AI 气泡左(浅底) / 用户气泡右(主色)、
 * 提问带"为什么问"小字、快捷选项点击即答、顶部进度点、三点思考指示器。
 *
 * 会话为空时先收主题（全新项目），之后每一轮由 store 驱动 AI 提问 → 用户回答。
 */
export function ClarifyStage() {
  const clarify = useStore((s) => s.clarify);
  const busy = useStore((s) => s.clarifyBusy);
  const product = useStore((s) => s.product);
  const apiKey = useStore((s) => s.settings.apiKey);
  const model = useStore((s) => s.settings.model);
  const references = useStore((s) => s.references);
  const closingAsk = useStore((s) => s.closingAsk);
  const confirmFinish = useStore((s) => s.confirmFinish);
  const cancelFinish = useStore((s) => s.cancelFinish);
  const beginClarify = useStore((s) => s.beginClarify);
  const sendClarify = useStore((s) => s.sendClarify);
  const finishClarify = useStore((s) => s.finishClarify);
  const skipClarify = useStore((s) => s.skipClarify);
  const addReferences = useStore((s) => s.addReferences);
  const removeReference = useStore((s) => s.removeReference);

  // 全部在下方「输入回答」或点击选项时发送，与 busy 状态联动防连点
  const [value, setValue] = useState('');
  const openSettings = useStore((s) => s.openSettings);
  const endRef = useRef<HTMLDivElement>(null);

  /**
   * 本轮各题的作答草稿：qid → 答案。
   * 一轮通常有 2-3 个问题，点选项只写入草稿、不再立刻发送——
   * 否则答完第一题就被推进到下一轮，剩下的题永远答不上。
   */
  const [draft, setDraft] = useState<Record<string, string>>({});

  /** 已作答的问题 id：历史里所有用户回答过的，旧问题 chip 一律置灰防重复答 */
  const answered = useMemo(() => {
    const set = new Set<string>();
    for (const m of clarify) {
      if (m.role === 'user') for (const a of m.answers ?? []) set.add(a.qid);
    }
    return set;
  }, [clarify]);

  /** 最新一轮 AI 提问里还没答过的全部问题 → 本轮要一次收齐的答案 */
  const pendingQuestions = useMemo(() => {
    for (let i = clarify.length - 1; i >= 0; i--) {
      const m = clarify[i];
      if (m.role !== 'ai' || !m.questions?.length) continue;
      const rest = m.questions.filter((q) => !answered.has(q.id));
      return rest;
    }
    return [] as ClarifyQuestion[];
  }, [clarify, answered]);

  /** 本轮已作答的题数（草稿里填了就算） */
  const answeredCount = pendingQuestions.filter((q) => (draft[q.id] ?? '').trim()).length;

  const aiRounds = clarify.filter((m) => m.role === 'ai' && (m.questions?.length ?? 0) > 0).length;

  // 新消息 / 思考指示器出现时滚到底部
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [clarify.length, busy]);

  /** 点选项 = 选中/取消，不发送；再点一次同一个选项则取消 */
  const pick = (q: ClarifyQuestion, option: string) => {
    if (busy || answered.has(q.id)) return;
    setDraft((d) => ({ ...d, [q.id]: d[q.id] === option ? '' : option }));
  };

  /** 某一题手写答案 */
  const typeAnswer = (qid: string, text: string) => {
    setDraft((d) => ({ ...d, [qid]: text }));
  };

  /** 一次性提交本轮所有已作答的问题；底部输入框内容作为补充说明一起带走 */
  const submit = () => {
    if (busy) return;
    const answers = pendingQuestions
      .map((q) => ({ qid: q.id, text: (draft[q.id] ?? '').trim() }))
      .filter((a) => a.text);
    const extra = value.trim();
    if (!answers.length && !extra) return;
    setValue('');
    setDraft({});
    void sendClarify(answers, extra || undefined);
  };

  return (
    <div className="stage stage-clarify">
      <header className="stage-top">
        <span className="brand">
          <span className="brand-mark">
            <img src={ddLogo} alt="" aria-hidden="true" />
          </span>
          <span className="brand-txt">
            {/* ⚠️ 这里**故意不是 h1**，尽管映射表写的是「.brand-name → h1」。
                澄清页自己有一个真正的 h1（`.cl-intro-t`「这次想探索什么？」），
                两个平级 h1 会让文档大纲出现两个并列的根节点，读屏也会把品牌名
                当成与页面主标题同级的标题念一遍。
                App.tsx（画布）与 ReportStage 没有别的 h1，那两处才用 h1。 */}
            <div className="brand-name">创意深潜</div>
            <span className="brand-sub">Deep Diving</span>
          </span>
        </span>

        {clarify.length > 0 ? (
          <div className="stage-progress">
            {Array.from({ length: MAX_CLARIFY_ROUNDS }, (_, i) => (
              <span
                key={i}
                className={
                  i < aiRounds ? 'dot on' : i === aiRounds && busy ? 'dot active' : 'dot'
                }
              />
            ))}
            <span className="stage-progress-t">
              {busy
                ? 'AI 思考中…'
                : aiRounds >= MAX_CLARIFY_ROUNDS
                  ? `已完成 ${MAX_CLARIFY_ROUNDS} 轮`
                  : `第 ${Math.max(aiRounds, 1)}/${MAX_CLARIFY_ROUNDS} 轮`}
            </span>
          </div>
        ) : null}

        <div className="stage-top-acts">
          {/* 配好之后仍然要留一个入口。原来这里只有「没配 Key」时才显示按钮，
              配过的人在这张首屏上找不到任何设置入口 —— 想换模型、Key 过期了想重填，
              都只能靠猜（设置弹窗本来只有画布顶栏能打开，而首屏不是画布阶段）。
              所以做成两态：没配是主行动点，配了退成幽灵按钮，位置不变。 */}
          {!apiKey ? (
            <button className="btn aqua sm" onClick={openSettings}>
              配置 API Key
            </button>
          ) : (
            <button
              className="btn ghost sm"
              onClick={openSettings}
              title={`当前模型：${model || '未填写'}（点击可更换服务商或替换 Key）`}
            >
              <Icon name="settings" /> AI 设置
            </button>
          )}
          {clarify.length > 0 && !busy ? (
            <button className={`btn sm ${aiRounds >= 2 ? 'pri' : 'ghost'}`} onClick={() => void finishClarify()}>
              够了，生成简报
            </button>
          ) : null}
        </div>
      </header>

      <div className="stage-body">
        {clarify.length === 0 ? (
          <Intro
            defaultSubject={product}
            busy={busy}
            hasKey={!!apiKey}
            onConfig={openSettings}
            onStart={(subject) => void beginClarify(subject)}
            onSkip={skipClarify}
          />
        ) : (
          <div className="cl-list">
            {clarify.map((m) =>
              m.role === 'ai' ? (
                <AiBubble
                  key={m.id}
                  summary={m.summary}
                  questions={m.questions}
                  ready={m.ready}
                  answered={answered}
                  draft={draft}
                  onPick={pick}
                  onType={typeAnswer}
                  onSubmit={submit}
                />
              ) : (
                <UserBubble key={m.id} answers={m.answers} text={m.text} />
              ),
            )}
            {busy ? (
              <div className="cl-msg ai">
                <div className="cl-bubble thinking" aria-label="AI 思考中">
                  <span className="spin" />
                </div>
              </div>
            ) : null}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <footer className="stage-foot">
        {clarify.length > 0 ? (
          <>
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
            <div className="cl-composer">
              <label className="cl-attach" title="上传参考资料（PDF / PPTX / Word / Excel / Markdown / 图片）">
                <input
                  type="file"
                  multiple
                  accept=".pdf,.pptx,.ppt,.docx,.xlsx,.odt,.html,.htm,.rtf,.md,.markdown,.txt,.csv,.tsv,.json,image/*"
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    if (files.length) void addReferences(files);
                  }}
                />
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </label>
              <textarea
                className="cl-input"
                rows={1}
                placeholder={
                  pendingQuestions.length
                    ? '补充说明（可选），会和上面的回答一起提交…'
                    : '补充任何想法…（Enter 发送，Shift+Enter 换行）'
                }
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  submit();
                }}
              />
              <button
                className="btn pri"
                disabled={busy || (!answeredCount && !value.trim())}
                onClick={submit}
              >
                {pendingQuestions.length
                  ? `提交本轮回答 ${answeredCount}/${pendingQuestions.length}`
                  : '发送'}
              </button>
            </div>
            <div className="cl-foot-row">
              {pendingQuestions.length > 1 ? (
                <span className="cl-foot-hint">
                  这一轮有 {pendingQuestions.length} 个问题，可以逐题选/写，再一次性提交；只答其中几题也可以。
                </span>
              ) : null}
              <button className="cl-skip" onClick={skipClarify}>
                跳过提问，直接开始 →
              </button>
            </div>
          </>
        ) : null}
      </footer>

      {closingAsk ? (
        <FinishCheck
          busy={busy}
          onConfirm={() => void confirmFinish()}
          onCancel={cancelFinish}
        />
      ) : null}
    </div>
  );
}

/**
 * 收尾确认卡：生成简报前的最后一道关卡。
 *
 * 为什么拦在这里：参考资料和「要什么氛围」这两样东西，只有进了简报和深潜的
 * prompt 才真正起作用——等生成完了、人都站在画布上了再补，AI 早就按空假设跑完了。
 * 所以不管用户是主动点「够了」，还是 AI 判定 ready / 轮次到顶，都要先过这一关。
 *
 * 两问都不强制：没资料可以直接下一步，特殊要求留空就是「没有」。
 */
function FinishCheck({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const references = useStore((s) => s.references);
  const addReferences = useStore((s) => s.addReferences);
  const removeReference = useStore((s) => s.removeReference);
  const mood = useStore((s) => s.mood);
  const setMood = useStore((s) => s.setMood);
  const [moodDraft, setMoodDraft] = useState(mood);

  const confirm = () => {
    setMood(moodDraft.trim());
    onConfirm();
  };

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal modal-finish" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="生成简报前确认">
        <div className="modal-h">
          <span>生成简报前，最后确认两件事</span>
          <button className="icon-btn" onClick={onCancel} aria-label="返回对话">
            ×
          </button>
        </div>
        <div className="modal-b">
          <div className="fc-block">
            <div className="fc-label">
              <b>① 还有没有参考资料或报告要一起交？</b>
            </div>
            <div className="fc-hint">
              PDF / PPTX / Word / Excel / Markdown / 图片都行。深潜会把里面的文字和图读进上下文，简报也会引用它们——这是它们唯一能被 AI「看到」的时机。
            </div>
            {references.length ? (
              <div className="cl-refs" style={{ marginTop: 8 }}>
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
            ) : null}
            <label className="btn ghost sm" style={{ marginTop: 8, display: 'inline-flex' }}>
              <input
                type="file"
                multiple
                accept=".pdf,.pptx,.ppt,.docx,.xlsx,.odt,.html,.htm,.rtf,.md,.markdown,.txt,.csv,.tsv,.json,image/*"
                hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  if (files.length) void addReferences(files);
                }}
              />
              {references.length ? '再传一份' : '上传参考资料'}
            </label>
            {!references.length ? <span className="fc-none">没有也没关系，跳过即可。</span> : null}
          </div>

          <div className="fc-block">
            <div className="fc-label">
              <b>② 有没有特殊要求？</b>
              <span className="fc-label-sub">比如要带上什么样的氛围或情绪</span>
            </div>
            <textarea
              className="pinput"
              style={{ width: '100%', minHeight: 72, resize: 'vertical', lineHeight: 1.7, marginTop: 8 }}
              placeholder="例如：整体要冷冽、克制的氛围，带一点危险感；避开大红大金的喜庆联想；目标人群深夜刷手机，画面要在小屏上够抓人…"
              value={moodDraft}
              onChange={(e) => setMoodDraft(e.target.value)}
            />
            <div className="fc-hint">留空就是「没有」。写在这里的东西会直接进简报的「氛围」栏和深潜的提示词。</div>
          </div>
        </div>
        <div className="modal-f">
          <button className="btn ghost" onClick={onCancel}>
            返回继续回答
          </button>
          <button className="btn pri" disabled={busy} onClick={confirm}>
            {busy ? '正在生成…' : '就这些，生成简报'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 会话还没开始时的双入口（Stage 0 → 1 的桥）。
 *
 * v2（2026-10-16 批次 1）：原来这里只有一条主路径（输入主题 → AI 追问 → 简报），
 * "跳过提问，直接进入画布"是页脚一枚 ghost 小按钮——两类用户被逼进同一条路。
 * 用户体验反馈的原话："有人需要 AI 帮忙澄清需求，有人已经带着简报或种子词来做发散"。
 * 现在两张**对等**入口卡，没有主次：
 *   ① 引导梳理——AI 像甲方一样追问 3-5 轮，把需求挖出来再整理成简报；
 *   ② 直接探索——已经想好了/带着素材来的，直奔画布（种子词、便签、参考图随你放）。
 * 两条路不是分叉，是同一工作台的两种开瓶方式：直接探索落地后，
 * 左栏随时能补简报，顶栏也能随时回来引导梳理。
 *
 * ⚠️ `.cl-intro-form` 类名刻意保留：e2e 夹具脚本按它填主题、
 * 点主按钮，重构布局不等于要它们陪跑（但直接探索卡是新的，脚本已同步）。
 */
function Intro({
  defaultSubject,
  busy,
  hasKey,
  onConfig,
  onStart,
  onSkip,
}: {
  defaultSubject: string;
  busy: boolean;
  hasKey: boolean;
  onConfig: () => void;
  onStart: (subject: string) => void;
  onSkip: () => void;
}) {
  const [subject, setSubject] = useState(defaultSubject);
  return (
    <div className="cl-intro">
      {/* P0-3：首屏 hero 换成完整插画（水中手托灯泡）。
          之前的 30px 向量标放大后是一根线，插画才有「潜入」的叙事。
          120px 是实测的可读下限——62px 已经糊，32px 是墨团。 */}
      <div className="cl-intro-mark">
        <img src={ddLogo} alt="" aria-hidden="true" />
      </div>
      <h1 className="cl-intro-t">这次想探索什么？</h1>
      <p className="cl-intro-s">
        两条路，选一条顺手。拿不准就先让 AI 问几句——它像甲方一样追问，把真实需求挖出来。
      </p>
      {!hasKey ? (
        /* 原来这里是一行黄色提示条（「澄清由 AI 驱动，需要先配置模型接口 + 小按钮」），
           实测新用户会直接看下一行入口卡、根本不读它 —— 于是停在首屏不知道从哪开始。
           这是新用户第一个必须完成的动作，值得占一块正式的位置。 */
        <div className="cl-keycard">
          <span className="cl-keycard-ico" aria-hidden="true">
            <Icon name="key" />
          </span>
          <div className="cl-keycard-main">
            <b>先配一个 AI 接口，再开始深潜</b>
            <span>深潜全程由 AI 驱动。没配也能浏览界面，但走不完流程。</span>
            <span className="cl-keycard-hint">
              没有 Key？Agnes 长期免费，邮箱注册 30 秒即可拿到
              <a href="https://platform.agnes-ai.com" target="_blank" rel="noreferrer">
                去申请
                <Icon name="link" />
              </a>
            </span>
          </div>
          <button className="btn pri sm" onClick={onConfig}>
            配置
          </button>
        </div>
      ) : null}

      <div className="cl-entries">
        <section className="cl-entry">
          <div className="cl-entry-h">
            <span className="cl-entry-t">引导梳理</span>
            <span className="cl-entry-k">推荐 · 需求还不清晰时</span>
          </div>
          <p className="cl-entry-d">
            AI 用 3-5 轮提问把真实需求挖出来，再整理成一份可编辑的项目简报。
          </p>
          <div className="cl-intro-form">
            <input
              className="pinput"
              style={{ fontSize: 'var(--fs-xl)', padding: '11px 14px' }}
              placeholder="例如：辣椒酱品牌升级、给旧书店做一套新视觉…"
              value={subject}
              autoFocus
              onChange={(e) => setSubject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                if (subject.trim()) onStart(subject);
              }}
            />
            <button className="btn pri" disabled={busy || !subject.trim()} onClick={() => onStart(subject)}>
              {busy ? 'AI 正在提问…' : '开始对话'}
            </button>
          </div>
        </section>

        <section className="cl-entry">
          <div className="cl-entry-h">
            <span className="cl-entry-t">直接探索</span>
            <span className="cl-entry-k">带着简报或种子词来的</span>
          </div>
          <p className="cl-entry-d">
            直奔画布：第一个词从中央输入，简报、情报、参考图、便签随你放，随时能回来补引导。
          </p>
          <div className="cl-intro-alt">
            <button className="btn ghost" onClick={onSkip} data-act="skip-to-canvas">
              跳过提问，进入画布 →
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function AiBubble({
  summary,
  questions,
  ready,
  answered,
  draft,
  onPick,
  onType,
  onSubmit,
}: {
  summary?: string;
  questions?: ClarifyQuestion[];
  ready?: boolean;
  answered: Set<string>;
  draft: Record<string, string>;
  onPick: (q: ClarifyQuestion, option: string) => void;
  onType: (qid: string, text: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="cl-msg ai">
      <div className="cl-role">深潜顾问</div>
      <div className="cl-bubble">
        {summary ? (
          <div className="cl-summary">
            <span className="cl-summary-label">我目前的理解</span>
            {summary}
          </div>
        ) : null}

        {ready ? (
          <div className="cl-ready">信息足够了，正在把对话整理成项目简报…</div>
        ) : null}

        {questions?.length ? (
          <div className="cl-questions">
            {questions.map((q, qi) => {
              const done = answered.has(q.id);
              const picked = draft[q.id] ?? '';
              return (
                <div key={q.id} className={`cl-q ${done ? 'done' : ''}`}>
                  <div className="cl-q-t">
                    {questions.length > 1 ? <span className="cl-q-idx">{qi + 1}</span> : null}
                    {q.text}
                  </div>
                  {q.reason ? (
                    <div className="cl-q-why" title={q.reason}>
                      {q.reason}
                    </div>
                  ) : null}
                  {q.options?.length ? (
                    <div className="cl-opts">
                      {q.options.map((o) => (
                        <button
                          key={o}
                          className={`chip ${done ? 'done' : ''} ${picked === o ? 'on' : ''}`}
                          disabled={done}
                          onClick={() => onPick(q, o)}
                        >
                          {done ? '✓ ' : ''}
                          {o}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {!done ? (
                    <input
                      className="cl-q-input"
                      placeholder={q.options?.length ? '都不合适？自己写一句…' : '写下你的回答…'}
                      value={picked}
                      onChange={(e) => onType(q.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                        e.preventDefault();
                        onSubmit();
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UserBubble({
  answers,
  text,
}: {
  answers?: { qid: string; text: string }[];
  text?: string;
}) {
  const items = [...(answers ?? []).map((a) => a.text), ...(text ? [text] : [])];
  if (!items.length) return null;
  return (
    <div className="cl-msg user">
      <div className="cl-bubble">
        {items.map((t, i) => (
          <div key={i} className="cl-answer">
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}
