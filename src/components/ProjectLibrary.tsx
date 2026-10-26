import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import {
  currentProjectId,
  deleteProject,
  duplicateProject,
  exportAll,
  exportProject,
  importFile,
  listProjects,
  newProject,
  openProject,
  renameProject,
  archiveCurrent,
  type ProjectMeta,
} from '../lib/projects';

const fmt = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 项目库：列出所有做过的项目，可打开、新建、重命名、复制、导出、删除、导入。
 * 数据存在本机 IndexedDB，不上传任何服务器。
 */
export function ProjectLibrary({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ProjectMeta[] | null>(null);
  const [msg, setMsg] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const curId = currentProjectId();

  const refresh = async () => {
    try {
      await archiveCurrent();
      setList(await listProjects());
    } catch (e) {
      setMsg((e as Error).message);
      setList([]);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const run = (fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-projects" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="项目库">
        <div className="modal-h">
          <span>我的项目</span>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            &times;
          </button>
        </div>
        <div className="modal-b">
          <div className="pl-bar">
            <button className="btn pri sm" onClick={run(newProject)}>
              + 新建项目
            </button>
            <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>
              导入
            </button>
            <button className="btn ghost sm" onClick={run(exportAll)}>
              备份全部
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                try {
                  const n = await importFile(f);
                  setMsg(`已导入 ${n} 个项目`);
                  setList(await listProjects());
                } catch (err) {
                  setMsg((err as Error).message);
                }
              }}
            />
          </div>
          <p className="phint">项目保存在这台电脑的浏览器里，不上传。换设备或清理浏览器数据前，请先「备份全部」。</p>
          {msg ? <p className="phint pl-msg">{msg}</p> : null}

          {list === null ? <p className="phint">读取中…</p> : null}
          {list && !list.length ? (
            <div className="pl-empty">还没有项目。开始一次深潜，它会自动出现在这里。</div>
          ) : null}

          <div className="pl-grid">
            {(list ?? []).map((p) => (
              <div key={p.id} className={`pl-card ${p.id === curId ? 'cur' : ''}`}>
                {editing === p.id ? (
                  <input
                    className="pinput"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={async () => {
                      await renameProject(p.id, draft);
                      setEditing(null);
                      setList(await listProjects());
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  />
                ) : (
                  <div className="pl-title" title="双击重命名" onDoubleClick={() => { setEditing(p.id); setDraft(p.title); }}>
                    {p.title}
                    {p.id === curId ? <span className="pl-now">当前</span> : null}
                  </div>
                )}
                <div className="pl-meta">
                  {fmt(p.updatedAt)} · {p.nodeCount} 节点 · {p.seedCount} 种子词
                </div>
                {p.summary ? <div className="pl-sum">{p.summary}</div> : null}
                <div className="pl-acts">
                  <button className="btn pri sm" onClick={run(() => openProject(p.id))}>
                    {p.id === curId ? '回到画布' : '打开'}
                  </button>
                  <button className="btn ghost sm" onClick={run(async () => { await duplicateProject(p.id); setList(await listProjects()); })}>
                    复制
                  </button>
                  <button className="btn ghost sm" onClick={run(() => exportProject(p.id))}>
                    导出
                  </button>
                  {confirmDel === p.id ? (
                    <button
                      className="btn sm danger"
                      onClick={run(async () => { await deleteProject(p.id); setConfirmDel(null); setList(await listProjects()); })}
                    >
                      确认删除
                    </button>
                  ) : (
                    <button className="btn ghost sm" aria-label="删除" onClick={() => setConfirmDel(p.id)}>
                      <Icon name="trash" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}