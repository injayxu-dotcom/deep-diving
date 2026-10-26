import { useEffect } from 'react';
import { useStore } from '../store/useStore';

/**
 * 删除带后代节点时的三选一确认。
 *
 * 三个选项**无默认高亮、不自动聚焦**，也没有回车快捷键——
 * 删除不可逆，必须让用户手点一下想清楚，而不是连击回车把整枝带走。
 *
 * 无后代的节点根本不会走到这里（store 里直接删掉了），
 * 否则每删一个词都要多点一次确认，很快就会烦。
 */
export function DeleteDialog() {
  const req = useStore((s) => s.pendingDelete);
  const confirmDelete = useStore((s) => s.confirmDelete);
  const cancel = useStore((s) => s.cancelDelete);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req, cancel]);

  if (!req) return null;

  const n = req.descendantCount;
  const single = req.ids.length === 1;
  // 后代里带成果（简报/评分/提示词）与已收敛的数量——删这些等于把跑过的 AI 结果扔掉
  const valuable = req.valuableCount ?? 0;
  const converged = req.convergedCount ?? 0;

  return (
    <div className="modal-mask" onClick={cancel}>
      <div className="modal modal-del" onClick={(e) => e.stopPropagation()} role="alertdialog">
        <div className="modal-h">
          <span>删除{req.label}？</span>
          <button className="icon-btn" onClick={cancel} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-b">
          <p>
            它下面还有 <b>{n}</b> 个延伸词。
          </p>
          {valuable > 0 && (
            <p className="del-warn">
              其中 <b>{valuable}</b> 个已经出过创意简报 / 评分 / 提示词
              {converged > 0 && (
                <>
                  ，<b>{converged}</b> 个已收敛
                </>
              )}
              。删掉就得重新跑一遍 AI。
            </p>
          )}
          {valuable === 0 && converged > 0 && (
            <p className="del-warn">
              其中 <b>{converged}</b> 个已收敛。
            </p>
          )}
          <div className="del-opts">
            <div className="del-opt">
              <b>一并删除</b>
              <span>
                {single ? '种子词' : '选中的节点'}和它的 {n} 个延伸词一起删除
              </span>
            </div>
            <div className="del-opt">
              <b>{single ? '仅删除种子词' : '仅删除选中项'}</b>
              <span>延伸词保留，脱离分组留在画布上</span>
            </div>
          </div>
        </div>
        <div className="modal-f">
          <button className="btn ghost" onClick={cancel}>
            取消
          </button>
          <button className="btn" onClick={() => confirmDelete('orphan')}>
            {single ? '仅删除种子词' : '仅删除选中项'}
          </button>
          <button className="btn danger" onClick={() => confirmDelete('cascade')}>
            一并删除
          </button>
        </div>
      </div>
    </div>
  );
}
