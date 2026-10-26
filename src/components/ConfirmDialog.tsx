interface Props {
  title: string;
  body: string;
  okText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 应用内确认弹窗。
 *
 * 不用 window.confirm —— 在沙箱 iframe（IDE 预览面板）里 confirm 会被静默拦截
 * 并直接返回 false，表现就是「点了按钮没反应」。
 */
export function ConfirmDialog({ title, body, okText = '确认', danger, onConfirm, onCancel }: Props) {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="alertdialog">
        <div className="modal-h">
          <span>{title}</span>
          <button className="icon-btn" onClick={onCancel} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-b">
          <p dangerouslySetInnerHTML={{ __html: body }} />
        </div>
        <div className="modal-f">
          <button className="btn ghost" onClick={onCancel}>
            取消
          </button>
          <button className={`btn ${danger ? 'danger' : 'pri'}`} onClick={onConfirm}>
            {okText}
          </button>
        </div>
      </div>
    </div>
  );
}
