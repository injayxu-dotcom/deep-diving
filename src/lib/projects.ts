import { flushSave, type Persisted } from './storage';

/**
 * 项目库：每次深潜 / 画布 = 一个项目，存在浏览器 IndexedDB（容量远大于 localStorage 的 5MB）。
 *
 * 设计取舍：当前正在编辑的项目仍走原有的 localStorage 自动保存（零改动、不会丢），
 * 项目库只负责「归档 / 打开 / 导出 / 导入」。切换项目 = 把目标写回当前工作区 + 整页刷新，
 * 运行时状态（日志、撤销、展开、忙碌标记）因此天然全部重置。
 * API Key 等本机凭证不进项目库，也不随导出带走。
 */

const WORKSPACE_KEY = 'deepdiving.v1';
const CURRENT_ID_KEY = 'deepdiving.currentId';
const DB_NAME = 'deepdiving-projects';
const STORE = 'projects';

export interface ProjectMeta {
  id: string;
  title: string;
  updatedAt: number;
  nodeCount: number;
  seedCount: number;
  summary: string;
}

interface ProjectRecord extends ProjectMeta {
  data: Omit<Persisted, 'settings'>;
}

const uid = () => `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开本地项目库'));
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = run(t.objectStore(STORE));
    t.oncomplete = () => {
      db.close();
      resolve(r.result);
    };
    t.onerror = () => {
      db.close();
      reject(t.error ?? new Error('项目库读写失败'));
    };
  });
}

export function currentProjectId(): string | null {
  return localStorage.getItem(CURRENT_ID_KEY);
}

function readWorkspace(): Persisted | null {
  const raw = localStorage.getItem(WORKSPACE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Persisted;
  } catch {
    return null;
  }
}

function isEmptyWorkspace(p: Persisted | null): boolean {
  return !p || (!(p.nodes?.length) && !(p.product ?? '').trim() && !(p.brief ?? '').trim() && !p.report);
}

function toRecord(id: string, p: Persisted, titleOverride?: string, prev?: ProjectMeta): ProjectRecord {
  const { settings: _s, ...data } = p;
  const nodes = p.nodes ?? [];
  const title =
    titleOverride ??
    prev?.title ??
    ((p.product ?? '').trim().slice(0, 40) || `未命名项目 ${new Date().toLocaleDateString()}`);
  return {
    id,
    title,
    updatedAt: Date.now(),
    nodeCount: nodes.length,
    seedCount: nodes.filter((n) => (n.data as { kind?: string }).kind === 'seed').length,
    summary: (p.report?.summary || p.brief || p.product || '').slice(0, 120),
    data,
  };
}

/** 把当前工作区归档进项目库（有 id 则更新，没有则新建）。空工作区不归档。 */
export async function archiveCurrent(): Promise<string | null> {
  flushSave();
  const p = readWorkspace();
  if (isEmptyWorkspace(p)) return null;
  const id = currentProjectId() ?? uid();
  const prev = await tx<ProjectRecord | undefined>('readonly', (s) => s.get(id));
  await tx('readwrite', (s) => s.put(toRecord(id, p as Persisted, undefined, prev)));
  localStorage.setItem(CURRENT_ID_KEY, id);
  return id;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = await tx<ProjectRecord[]>('readonly', (s) => s.getAll());
  return all
    .map(({ data: _d, ...meta }) => meta)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 打开项目：先归档当前，再把目标写回工作区并刷新页面 */
export async function openProject(id: string): Promise<void> {
  if (id === currentProjectId()) {
    location.reload();
    return;
  }
  await archiveCurrent();
  const rec = await tx<ProjectRecord | undefined>('readonly', (s) => s.get(id));
  if (!rec) throw new Error('项目不存在或已被删除');
  const live = readWorkspace();
  const next = { ...rec.data, settings: live?.settings, savedAt: Date.now() };
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify(next));
  localStorage.setItem(CURRENT_ID_KEY, id);
  location.reload();
}

/** 新建空白项目：先归档当前，清空工作区（保留设置）并刷新 */
export async function newProject(): Promise<void> {
  await archiveCurrent();
  const live = readWorkspace();
  localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ settings: live?.settings }));
  localStorage.removeItem(CURRENT_ID_KEY);
  location.reload();
}

export async function renameProject(id: string, title: string): Promise<void> {
  const rec = await tx<ProjectRecord | undefined>('readonly', (s) => s.get(id));
  if (!rec) return;
  await tx('readwrite', (s) => s.put({ ...rec, title: title.trim() || rec.title }));
}

export async function deleteProject(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
  if (id === currentProjectId()) localStorage.removeItem(CURRENT_ID_KEY);
}

export async function duplicateProject(id: string): Promise<void> {
  const rec = await tx<ProjectRecord | undefined>('readonly', (s) => s.get(id));
  if (!rec) return;
  await tx('readwrite', (s) => s.put({ ...rec, id: uid(), title: `${rec.title}（副本）`, updatedAt: Date.now() }));
}

export async function exportProject(id: string): Promise<void> {
  if (id === currentProjectId()) await archiveCurrent();
  const rec = await tx<ProjectRecord | undefined>('readonly', (s) => s.get(id));
  if (!rec) return;
  const blob = new Blob([JSON.stringify({ app: 'deep-diving', version: 1, project: rec }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${rec.title.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

/** 导出整个项目库（备份用） */
export async function exportAll(): Promise<void> {
  await archiveCurrent();
  const all = await tx<ProjectRecord[]>('readonly', (s) => s.getAll());
  const blob = new Blob([JSON.stringify({ app: 'deep-diving', version: 1, projects: all }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deep-diving-项目库-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 0);
}

/** 导入：支持单个项目、整库备份，以及旧版「导出」出来的整份工作区 JSON */
export async function importFile(file: File): Promise<number> {
  const o = JSON.parse(await file.text());
  const recs: ProjectRecord[] = [];
  if (Array.isArray(o?.projects)) recs.push(...o.projects);
  else if (o?.project?.data) recs.push(o.project);
  else if (Array.isArray(o?.nodes)) recs.push(toRecord(uid(), o as Persisted, file.name.replace(/\.json$/i, '')));
  if (!recs.length) throw new Error('不是创意深潜导出的文件');
  for (const r of recs) {
    if (!r?.data || !Array.isArray(r.data.nodes)) continue;
    await tx('readwrite', (s) => s.put({ ...r, id: uid(), updatedAt: r.updatedAt ?? Date.now() }));
  }
  return recs.length;
}