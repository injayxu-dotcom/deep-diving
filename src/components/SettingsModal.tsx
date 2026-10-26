import { useState } from 'react';
import { useStore } from '../store/useStore';
import { chat } from '../lib/ai';
import { describeError } from '../lib/cloudApi';

/**
 * 常用服务商一键填入，省得手抄 Base URL 写错（少个 /v1 就会 404）。
 *
 * Agnes 排第一不是随手定的：它承诺长期免费、注册不绑银行卡、不验手机号，
 * 是「一个 Key 都没有」的人最短的一条路。有 Key 的人自然会跳过它选自己惯用的。
 */
const PROVIDERS = [
  { name: 'Agnes 免费', base: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.5-flash' },
  { name: 'DeepSeek', base: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: '千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '智谱', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
] as const;

const AGNES_SIGNUP = 'https://platform.agnes-ai.com';

/**
 * AIhubmix 的免费模型精选（完整名单 2026-09 共 56 个，见 aihubmix.com/models/free）。
 *
 * 关键：免费模型 ID **必须带 -free 后缀**。同名不带后缀的是按量计费版，
 * 余额为 0 时回报「balance is insufficient」——这正是"填了免费渠道却用不了"的头号原因。
 * vision=true 的才能读图，本项目的图片分析（视觉输入）依赖它。
 */
const FREE_MODELS = [
  { id: 'minimax-m3-free', note: '视觉 · 1M 上下文', vision: true },
  { id: 'gpt-5.5-free', note: '视觉 · 100/天', vision: true },
  { id: 'gemini-3.6-flash-free', note: '视觉 · 多模态', vision: true },
  { id: 'coding-kimi-k3-free', note: '视觉 · 1M 上下文', vision: true },
  { id: 'coding-glm-5.3-free', note: '纯文本 · 调用最多', vision: false },
  { id: 'hy3-free', note: '纯文本 · 256K', vision: false },
] as const;

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const t = await chat({
        settings,
        messages: [{ role: 'user', content: '回复两个字：可用' }],
      });
      setResult({ ok: true, text: `连接正常，模型回复：${t.trim().slice(0, 40)}` });
    } catch (e) {
      setResult({ ok: false, text: describeError(e) });
    } finally {
      setTesting(false);
    }
  };

  const isAihubmix = /aihubmix/i.test(settings.baseUrl);
  const isAgnes = /agnes/i.test(settings.baseUrl);
  const hasKey = !!settings.apiKey.trim();

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <span>{hasKey ? 'AI 接口设置' : '配置 AI 接口'}</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            &times;
          </button>
        </div>

        <div className="modal-b">
          {!hasKey ? (
            <p className="phint" style={{ margin: '0 0 14px' }}>
              深潜全程由 AI 驱动，需要一个能调模型的 API Key。四家任选其一，
              建议直接用下面第一个（免费、不用绑卡）。
            </p>
          ) : null}

          <label className="plabel">服务商 Base URL</label>
          <input
            className="pinput"
            value={settings.baseUrl}
            placeholder="https://apihub.agnes-ai.com/v1"
            onChange={(e) => setSettings({ baseUrl: e.target.value })}
          />
          <p className="phint">
            只要兼容 OpenAI 协议就能用：官方 API、第三方供应商、中转站、自建 OneAPI / NewAPI
            都可以，直接填它的 <code>/v1</code> 地址。
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="phint" style={{ margin: 0 }}>
              快捷填入：
            </span>
            {PROVIDERS.map((p) => (
              <button
                key={p.name}
                className={settings.baseUrl === p.base ? 'btn sm' : 'btn ghost sm'}
                onClick={() => setSettings({ baseUrl: p.base, model: p.model })}
              >
                {p.name}
              </button>
            ))}
          </div>

          {/* 快捷按钮只解决「填什么」，不解决「去哪拿」——
              而「一个 Key 都没有」才是新用户的真实状态。 */}
          <p className="phint" style={{ margin: '8px 0 0' }}>
            还没有 Key？Agnes 承诺长期免费，去{' '}
            <a href={AGNES_SIGNUP} target="_blank" rel="noreferrer">
              platform.agnes-ai.com
            </a>{' '}
            用邮箱注册（30 秒，不用绑卡），在「设置 → API 密钥」创建后复制粘贴到下面。
          </p>

          <label className="plabel" style={{ marginTop: 14 }}>
            API Key
          </label>
          <input
            className="pinput"
            type="password"
            value={settings.apiKey}
            placeholder="sk-..."
            onChange={(e) => setSettings({ apiKey: e.target.value })}
          />
          <p className="phint">只存本机，不会上传；换设备需各填一次。</p>

          <div className="prow" style={{ marginTop: 14 }}>
            <div style={{ flex: 1 }}>
              <label className="plabel">模型</label>
              <input
                className="pinput"
                value={settings.model}
                placeholder="agnes-2.5-flash"
                onChange={(e) => setSettings({ model: e.target.value })}
              />
            </div>
            <div style={{ width: 130 }}>
              <label className="plabel">温度 {settings.temperature.toFixed(1)}</label>
              <input
                className="pinput"
                type="range"
                min={0}
                max={1.4}
                step={0.1}
                value={settings.temperature}
                onChange={(e) => setSettings({ temperature: Number(e.target.value) })}
                style={{ padding: 0 }}
              />
            </div>
          </div>

          {isAihubmix && (
            <div style={{ marginTop: 12 }}>
              <p className="phint" style={{ margin: '0 0 6px' }}>
                <b style={{ color: 'var(--warn-text)' }}>
                  免费模型 ID 必须带 <code>-free</code> 后缀
                </b>
                ：不带后缀的是计费版，余额为 0 会报「balance is insufficient」。
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {FREE_MODELS.map((m) => (
                  <button
                    key={m.id}
                    className={settings.model === m.id ? 'btn sm' : 'btn ghost sm'}
                    title={m.note}
                    onClick={() => setSettings({ model: m.id })}
                  >
                    {m.vision ? '👁 ' : ''}
                    {m.id}
                  </button>
                ))}
              </div>
              {settings.model.trim() && !/-free$/i.test(settings.model.trim()) ? (
                <p
                  className="phint"
                  style={{ margin: '8px 0 0', color: 'var(--danger-text)', fontWeight: 600 }}
                >
                  ⚠️ 当前模型「{settings.model.trim()}」不带 -free 后缀，会直接扣余额。
                  点上面任意一个覆盖它。
                </p>
              ) : null}
              <p className="phint" style={{ margin: '6px 0 0' }}>
                👁 = 支持读图，「图片分析」要用带 👁 的。该渠道要求账户余额 &gt; 0，免费模型也一样。
              </p>
            </div>
          )}

          {isAgnes && (
            <div style={{ marginTop: 12 }}>
              <p className="phint" style={{ margin: '0 0 6px' }}>
                <b>Agnes 2.5 Flash</b>：512K 上下文，支持读图，OpenAI 兼容，当前免费。
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { id: 'agnes-2.5-flash', note: '最新一代，512K 上下文' },
                  { id: 'agnes-2.0-flash', note: '上一代，无灰度限制，可作回退' },
                ].map((m) => (
                  <button
                    key={m.id}
                    className={settings.model === m.id ? 'btn sm' : 'btn ghost sm'}
                    title={m.note}
                    onClick={() => setSettings({ model: m.id })}
                  >
                    {m.id}
                  </button>
                ))}
              </div>
              <p className="phint" style={{ margin: '6px 0 0' }}>
                2.5 报无权限是灰度未开，改 2.0 即可。该平台只收公网图片地址，本地图会回退为文本分析。
              </p>
            </div>
          )}

          {result ? <div className={`test-result ${result.ok ? 'ok' : 'err'}`}>{result.text}</div> : null}
        </div>

        <div className="modal-f">
          <button className="btn ghost" onClick={() => void test()} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn pri" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
