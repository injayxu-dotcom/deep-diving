import { useState } from 'react';
import { useStore } from '../store/useStore';
import { exportSnapshotJSON } from '../lib/storage';
import { Icon } from './Icon';

/**
 * P5：阶段快照管理弹层（⋯ 菜单「保存快照」进入）。
 *
 * 一个弹层同时干两件事，因为它们是同一件事的两半：
 * 上半「保存当前画布为新快照」（命名，默认「时间戳 · N 节点」），
 * 下半「已有快照」列表（恢复 / 导出 / 删除）。分成两个入口的话，
 * 用户存完一份想看看存了什么的路径就断了。
 *
 * 恢复用**行内二次确认**而不是再套一层模态：确认内容就一句话
 * （替换当前画布、可撤销），行内确认足够，且不会叠出第三个弹层。
 *
 * 图片按 D7 不进快照（配额原因见 storage.ts），恢复后的空壳
 * 在列表 meta 与恢复提示里都写明——不静默。
 */
export function SnapshotModal() {
  const open = useStore((s) => s.snapshotOpen);
  const snaps = useStore((s) => s.snaps);
  const nodeCount = useStore((s) => s.nodes.length);
  const saveSnapshot = useStore((s) => s.saveSnapshot);
  const deleteSnapshot = useStore((s) => s.deleteSnapshot);
  const restoreSnapshot = useStore((s) => s.restoreSnapshot);
  const close = useStore((s) => s.closeSnapshots);
  const [name, setName] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (!open) return null;

  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const defName = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} · ${nodeCount} 节点`;

  const onSave = () => {
    saveSnapshot(name.trim() || defName);
    setName('');
  };

  return (
    <div className="modal-mask" onClick={close}>
      <div className="modal modal-snap" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="阶段快照">
        <div className="modal-h">
          <span>阶段快照</span>
          <button className="icon-btn" onClick={close} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="modal-b">
          <div className="snap-save">
            <input
              className="snap-name"
              value={name}
              placeholder={defName}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSave();
              }}
              aria-label="快照名称"
              data-act="snap-name"
            />
            <button className="btn sm" onClick={onSave} data-act="snap-save" disabled={!nodeCount}>
              <Icon name="layers" /> 保存当前画布
            </button>
          </div>
          <p className="snap-tip">
            快照<b>不保存图片</b>（本地存储配额所限）：恢复后图节点只剩名字与占位。上限 10 份，存满后自动汰换最旧的一份。
          </p>

          {snaps.length ? (
            <ul className="snap-list">
              {snaps.map((s) => (
                <li key={s.id} className="snap-i">
                  <div className="snap-i-main">
                    <div className="snap-i-name" title={s.name}>
                      {s.name}
                    </div>
                    <div className="snap-i-meta">
                      {new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false })} · {s.nodes.length} 节点
                      {s.stripped ? ` · ${s.stripped} 个图节点无图` : ''}
                    </div>
                  </div>
                  {confirmId === s.id ? (
                    <div className="snap-i-confirm">
                      <span className="snap-confirm-t">替换当前画布（可用撤销退回）</span>
                      <button
                        className="btn xs danger"
                        data-act="snap-restore-ok"
                        onClick={() => {
                          restoreSnapshot(s.id);
                          setConfirmId(null);
                        }}
                      >
                        确认恢复
                      </button>
                      <button className="btn xs ghost" onClick={() => setConfirmId(null)}>
                        取消
                      </button>
                    </div>
                  ) : (
                    <div className="snap-i-acts">
                      <button className="btn xs ghost" onClick={() => setConfirmId(s.id)} data-act="snap-restore">
                        恢复
                      </button>
                      <button className="btn xs ghost" onClick={() => exportSnapshotJSON(s)} data-act="snap-export">
                        导出
                      </button>
                      <button className="btn xs ghost danger" onClick={() => deleteSnapshot(s.id)} data-act="snap-del">
                        删除
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="pempty">还没有快照。整理画布前存一份，改坏了能回来。</div>
          )}
        </div>
      </div>
    </div>
  );
}
