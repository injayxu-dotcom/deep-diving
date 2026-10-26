import { useStore } from '../store/useStore';
import { Icon } from './Icon';

/**
 * P2-bis：重新深潜语义框。
 *
 * 「开始深潜」实际是**追加式**的（新一批情报卡 + 种子词接在现有内容下方，
 * 调研洞察整体替换），但按钮上看不出这一点。画布已有内容时，点下去之前
 * 先把两种后果摆出来让用户选——这就是「语义显性化」，runDeepDive 本身
 * 零行为变更。
 *
 * 两个选项都写明项目名 / 简报 / AI 设置的去留，口径与顶栏「清空」确认框
 * 一致（清空重来 = 同一套清空范围 + 当场重跑）。
 */
export function RediveDialog() {
  const open = useStore((s) => s.rediveAsk);
  const cancelRedive = useStore((s) => s.cancelRedive);
  const confirmRedive = useStore((s) => s.confirmRedive);
  if (!open) return null;

  return (
    <div className="modal-mask" onClick={cancelRedive}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="alertdialog">
        <div className="modal-h">
          <span>重新深潜？</span>
          <button className="icon-btn" onClick={cancelRedive} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-b">
          <p>画布上已经有内容了。「开始深潜」会基于当前项目名重新跑一遍调研，先选一种方式：</p>
          <div className="redive-opts">
            <button className="redive-opt" onClick={() => confirmRedive('append')}>
              <span className="redive-opt-t">
                <Icon name="plus" size={13} />再挖一轮
              </span>
              <span className="redive-opt-d">
                保留画布上全部现有节点与产出，在下方追加新一批情报卡和种子词；调研洞察替换为最新结果。
              </span>
            </button>
            <button className="redive-opt danger" onClick={() => confirmRedive('fresh')}>
              <span className="redive-opt-t">
                <Icon name="trash" size={13} />清空重来
              </span>
              <span className="redive-opt-d">
                先清空画布、情报卡、参考资料与调研洞察，再从当前项目名重新深潜。
                <b>项目名与 AI 设置会保留</b>；此方式不可撤销，建议先「导出」备份。
              </span>
            </button>
          </div>
        </div>
        <div className="modal-f">
          <button className="btn ghost" onClick={cancelRedive}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
