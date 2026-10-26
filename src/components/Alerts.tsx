import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';

/**
 * 错误弹窗（fatal 级）。
 *
 * 存在的理由：所有错误原本只写进右侧「运行日志」，而日志区在右栏最底部、
 * 需要滚动才看得到。用户遇到失败时看到的是「点了没反应」——这是最糟的反馈，
 * 因为它不告诉你失败，也不告诉你怎么办。
 *
 * 三条硬性要求：
 * 1. 必须说清是哪一步崩的（title 由调用方传入，如「深潜失败」）
 * 2. 原始错误不做二次包装，便于排查与反馈
 * 3. 能识别的错误必须给出可操作建议（hint）
 */
export function AlertDialog() {
  const alert = useStore((s) => s.alert);
  const dismiss = useStore((s) => s.dismissAlert);
  const [copied, setCopied] = useState(false);

  // Esc 关闭；换一条新告警时重置复制态
  useEffect(() => {
    setCopied(false);
    if (!alert) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [alert, dismiss]);

  if (!alert) return null;

  const copy = async () => {
    const text = [
      `【创意深潜】${alert.title}`,
      `时间：${new Date().toLocaleString('zh-CN')}`,
      `错误：${alert.reason}`,
      alert.hint ? `建议：${alert.hint}` : '',
      `环境：${navigator.userAgent}`,
    ]
      .filter(Boolean)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 非安全上下文（http）或用户拒绝授权时剪贴板不可用，退回选中文本
      setCopied(false);
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand('copy');
      } catch {
        /* 复制不了就不复制，不阻断关闭弹窗 */
      }
      document.body.removeChild(el);
    }
  };

  return (
    <div className="modal-mask" onClick={dismiss}>
      <div
        className="modal modal-alert"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="alert-title"
      >
        <div className="modal-h">
          <span className="alert-h" id="alert-title">
            <span className={`alert-dot ${alert.level}`} aria-hidden="true" />
            {alert.title}
          </span>
          <button className="icon-btn" onClick={dismiss} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="modal-b">
          {alert.hint ? <div className="alert-hint alert-hint-top">{alert.hint}</div> : null}
          <details className="alert-raw" open={!alert.hint}>
            <summary className="plabel">出了什么问题（原始信息）</summary>
            <div className="alert-reason">{alert.reason || '（未提供错误信息）'}</div>
          </details>
        </div>

        <div className="modal-f">
          <button className="btn ghost" onClick={() => void copy()}>
            {copied ? '已复制' : '复制错误信息'}
          </button>
          {alert.retry ? (
            <button
              className="btn pri"
              onClick={() => {
                const r = alert.retry;
                dismiss();
                r?.();
              }}
            >
              重试
            </button>
          ) : null}
          <button className={alert.retry ? 'btn ghost' : 'btn pri'} onClick={dismiss}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 轻提示（warn 级）。
 * 不打断操作，默认 3.2 秒后自动消失；点击可立即关掉。
 */
export function ToastHost() {
  const toast = useStore((s) => s.toast);
  const dismiss = useStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(dismiss, 3200);
    return () => window.clearTimeout(t);
  }, [toast, dismiss]);

  if (!toast) return null;

  return (
    <div className={`toast ${toast.tone}`} role="status" aria-live="polite" onClick={dismiss}>
      <span className="toast-x">{toast.text}</span>
    </div>
  );
}
