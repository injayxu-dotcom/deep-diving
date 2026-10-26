import { useStore } from '../store/useStore';

export function ReportDrawer({ onClose }: { onClose: () => void }) {
  const report = useStore((s) => s.report);
  const toggleTodo = useStore((s) => s.toggleTodo);

  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <div className="drawer" role="dialog" aria-label="调研洞察">
        <div className="drawer-h">
          <div className="drawer-title">
            <h2>调研洞察</h2>
            <p>
              {report ? `${report.product} · ${report.createdAt}` : '尚未生成'}
            </p>
          </div>
          <button className="btn ghost sm" onClick={onClose}>
            回到画布
          </button>
        </div>

        <div className="drawer-b">
          {!report ? (
            <div className="pempty">先在左栏填项目名，点「开始深潜」</div>
          ) : (
            <>
              {report.summary ? <div className="rep-summary" style={{ marginBottom: 32 }}>{report.summary}</div> : null}

              {report.todos?.length ? (
                <section className="rep-sec rep-todo">
                  <div className="rep-h">待确认项 · {report.todos.filter((t) => t.done).length}/{report.todos.length}</div>
                  {report.todos.map((t, i) => (
                    <label key={i} className={`rep-todo-i ${t.done ? 'done' : ''}`}>
                      <input type="checkbox" checked={t.done} onChange={() => toggleTodo(i)} />
                      <span>{t.text}</span>
                    </label>
                  ))}
                </section>
              ) : null}

              <section className="rep-sec">
                <div className="rep-h">
                  <span className="rep-n">1</span>行业现状
                </div>
                <div className="rep-body">{report.industry || '—'}</div>
              </section>

              <section className="rep-sec">
                <div className="rep-h">
                  <span className="rep-n">2</span>竞品详情
                </div>
                {report.competitors.length ? (
                  <div className="cmp-grid">
                    {report.competitors.map((c, i) => (
                      <div key={i} className="cmp-card">
                        <div className="cmp-name">{c.name}</div>
                        <div className="cmp-row">
                          <span className="cmp-k">特点</span>
                          <span className="cmp-v">{c.feature || '—'}</span>
                        </div>
                        <div className="cmp-row">
                          <span className="cmp-k">受众</span>
                          <span className="cmp-v">{c.audience || '—'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rep-body">—</div>
                )}
              </section>

              <section className="rep-sec">
                <div className="rep-h">
                  <span className="rep-n">3</span>视觉元素
                </div>
                <div className="vis-grid">
                  <div className="vis-cell">
                    <div className="vis-k">颜色</div>
                    <div className="vis-v">{report.visual.colors || '—'}</div>
                  </div>
                  <div className="vis-cell">
                    <div className="vis-k">色调</div>
                    <div className="vis-v">{report.visual.tone || '—'}</div>
                  </div>
                  <div className="vis-cell">
                    <div className="vis-k">字体</div>
                    <div className="vis-v">{report.visual.font || '—'}</div>
                  </div>
                </div>
              </section>

              <section className="rep-sec">
                <div className="rep-h">
                  <span className="rep-n">4</span>SWOT 分析
                </div>
                <div className="swot">
                  <SwotCell cls="s" tag="S" title="优势" items={report.swot.strengths} />
                  <SwotCell cls="w" tag="W" title="劣势" items={report.swot.weaknesses} />
                  <SwotCell cls="o" tag="O" title="机会" items={report.swot.opportunities} />
                  <SwotCell cls="t" tag="T" title="威胁" items={report.swot.threats} />
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function SwotCell({
  cls,
  tag,
  title,
  items,
}: {
  cls: string;
  tag: string;
  title: string;
  items: string[];
}) {
  return (
    <div className={`swot-cell ${cls}`}>
      <div className="swot-h">
        <span className="swot-tag">{tag}</span>
        {title}
      </div>
      {items.length ? (
        <ul className="swot-l">
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : (
        <div style={{ fontSize: 'var(--fs-md)', opacity: 0.6 }}>—</div>
      )}
    </div>
  );
}
