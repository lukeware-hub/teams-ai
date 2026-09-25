import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { refineApi, type ChecklistItem, type Snapshot } from '../api.js';
import { applyToSnapshot, type LiveSnapshot } from '../refine/reducer.js';
import { useJournal } from '../useSse.js';

type DocFile = 'project.md' | 'brief.md';
export interface ViewProps {
  snap: Snapshot;
  busy: boolean;
  onSaveDoc(file: DocFile, text: string): void;
  onEvaluate(): void;
  onAnswer(id: string, text: string): void;
  onSkip(id: string): void;
  onAccept(id: string): void;
  onReject(id: string, reason: string | null): void;
  onSecret(name: string, value: string): void;
  onStart(): void;
}

function Checklist({ items, role }: { items: ChecklistItem[]; role: 'po' | 'sm' }) {
  return (
    <ul className="checklist">
      {items
        .filter((i) => i.role === role)
        .map((i) => (
          <li key={i.id} className={i.passed ? 'pass' : 'fail'} title={i.detail}>
            {i.passed ? '✓' : '✗'} {i.id.slice(3)} <small>{i.detail}</small>
          </li>
        ))}
    </ul>
  );
}

export function RefinementView(p: ViewProps) {
  const { snap, busy } = p;
  const st = snap.state;
  const [tab, setTab] = useState<DocFile>('brief.md');
  const [docs, setDocs] = useState(snap.docs);
  const [answer, setAnswer] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  useEffect(() => setDocs(snap.docs), [snap.docs]);
  const locked = busy || st.status === 'evaluating' || st.status === 'started';
  const pending = [...st.questions.filter((q) => q.status === 'pending')].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const current = pending[0];
  const canStart = st.status === 'ready' && !st.stale && !busy;
  return (
    <div className="refine">
      <section className="docs panel-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Workspace</span>
            <h2>Project documents</h2>
          </div>
          <span className="doc-state">{locked ? 'Read-only' : 'Editable'}</span>
        </div>
        <div className="tabs" role="tablist" aria-label="Project documents">
          {(['project.md', 'brief.md'] as DocFile[]).map((f) => (
            <button key={f} className={tab === f ? 'active' : ''} onClick={() => setTab(f)}>
              {f}
            </button>
          ))}
        </div>
        <textarea
          aria-label={`${tab} editor`}
          data-testid={`doc-${tab}`}
          value={docs[tab]}
          readOnly={locked}
          onChange={(e) => setDocs({ ...docs, [tab]: e.target.value })}
          onBlur={() => {
            if (!locked && docs[tab] !== snap.docs[tab]) p.onSaveDoc(tab, docs[tab]);
          }}
        />
        {st.stale && (
          <p data-testid="stale" className="notice">
            Checklist out of date — re-evaluate
          </p>
        )}
        {st.status === 'error' && <p className="error">{st.error}</p>}
        <div className="doc-actions">
          <span className="save-hint">Changes save when you leave the editor.</span>
          <button data-testid="evaluate" className="secondary" disabled={locked} onClick={p.onEvaluate}>
          {st.cycle === 0 ? 'Evaluate' : 'Re-evaluate'}
          </button>
        </div>
        {st.status === 'evaluating' && <span className="spinner">evaluating…</span>}
      </section>
      <section className="conversation panel-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Refinement</span>
            <h2>Review workspace</h2>
          </div>
          <span className="count-pill">{pending.length} open</span>
        </div>
        {current ? (
          <div className="question card-inner">
            <span className={`badge ${current.role}`}>{current.role.toUpperCase()}</span>
            {current.blocking && <span className="tag">blocking</span>}
            <p>{current.text}</p>
            {current.relatedAcIds.length > 0 && <small>{current.relatedAcIds.join(', ')}</small>}
            <label className="field-label" htmlFor="refinement-answer">Your answer</label>
            <textarea id="refinement-answer" data-testid="answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <button
              data-testid={`answer-${current.questionId}`}
              disabled={locked || answer.trim() === ''}
              onClick={() => {
                p.onAnswer(current.questionId, answer);
                setAnswer('');
              }}
            >
              Answer
            </button>
            {!current.blocking && (
              <button data-testid={`skip-${current.questionId}`} disabled={locked} onClick={() => p.onSkip(current.questionId)}>
                Skip
              </button>
            )}
            <small>{pending.length - 1} more pending</small>
          </div>
        ) : (
          <p className="muted">No open question.</p>
        )}
        {st.patches
          .filter((x) => x.status === 'pending')
          .map((x) => (
            <div key={x.patchId} className="patch">
              <span className={`badge ${x.role}`}>{x.role.toUpperCase()}</span> <b>{x.file}</b> — {x.reason}
              <pre className="diff">{x.diff}</pre>
              <button data-testid={`accept-${x.patchId}`} disabled={locked} onClick={() => p.onAccept(x.patchId)}>
                Accept
              </button>
              <input
                data-testid={`reject-reason-${x.patchId}`}
                placeholder="reason (optional)"
                value={reasons[x.patchId] ?? ''}
                onChange={(e) => setReasons({ ...reasons, [x.patchId]: e.target.value })}
              />
              <button data-testid={`reject-${x.patchId}`} disabled={locked} onClick={() => p.onReject(x.patchId, reasons[x.patchId] || null)}>
                Reject
              </button>
            </div>
          ))}
        {st.discarded.map((d, i) => (
          <p key={i} className="warning">
            Discarded {d.role} patch on {d.file}: {d.reason}
          </p>
        ))}
        <h4>History</h4>
        <ul className="history">
          {[...st.questions]
            .filter((q) => q.status !== 'pending')
            .reverse()
            .map((q) => (
              <li key={q.questionId}>
                <span className={`badge ${q.role}`}>{q.role}</span> {q.text} → {q.status === 'skipped' ? <i>skipped</i> : q.answer}
              </li>
            ))}
          {[...st.patches]
            .filter((x) => x.status !== 'pending')
            .reverse()
            .map((x) => (
              <li key={x.patchId}>
                patch {x.file} ({x.reason}) → {x.status}
                {x.decision ? `: ${x.decision}` : ''}
              </li>
            ))}
        </ul>
      </section>
      <section className="panels panel-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Quality gate</span>
            <h2>Checklist</h2>
          </div>
          <span className={`status-dot ${st.stale ? 'warn' : 'ok'}`}>{st.stale ? 'Needs review' : 'Current'}</span>
        </div>
        <h5>PO</h5>
        <Checklist items={st.checklist} role="po" />
        <h5>SM</h5>
        <Checklist items={st.checklist} role="sm" />
        <h4>Derived</h4>
        <details>
          <summary>spec.json</summary>
          <pre>{JSON.stringify(st.derived?.spec ?? null, null, 2)}</pre>
        </details>
        <details>
          <summary>project.json</summary>
          <pre>{JSON.stringify(st.derived?.project ?? null, null, 2)}</pre>
        </details>
        <h5>Tasks</h5>
        <ul>
          {(st.derived?.spec.tasks ?? []).map((t, i) => (
            <li key={i}>
              <b>{t.title}</b>: {t.description}
            </li>
          ))}
        </ul>
        <h4>Secrets</h4>
        <ul>
          {snap.secrets.map((s) => (
            <li key={s.name}>
              {s.present ? '●' : '○'} {s.name} {s.hint && <code>…{s.hint}</code>}
              <input type="password" data-testid={`secret-${s.name}`} value={secretValues[s.name] ?? ''} onChange={(e) => setSecretValues({ ...secretValues, [s.name]: e.target.value })} />
              <button
                data-testid={`save-secret-${s.name}`}
                disabled={locked || !(secretValues[s.name] ?? '')}
                onClick={() => {
                  p.onSecret(s.name, secretValues[s.name]!);
                  setSecretValues({ ...secretValues, [s.name]: '' });
                }}
              >
                Save
              </button>
            </li>
          ))}
        </ul>
        <p className="tokens">
          {snap.tokens.steps} steps · {snap.tokens.inputTokens + snap.tokens.outputTokens} tokens · ${snap.tokens.costUsd.toFixed(2)}
        </p>
        <button data-testid="start" className="primary full-width" disabled={!canStart} onClick={p.onStart}>
          Start
        </button>
      </section>
    </div>
  );
}

export function RefinementPage() {
  const { projectId = '', specId = '' } = useParams();
  const navigate = useNavigate();
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const applied = useRef(0);
  const { events } = useJournal(snap ? refineApi.events(projectId, specId) : null);
  const load = () =>
    refineApi
      .snapshot(projectId, specId)
      .then((s) => setSnap({ ...s, docsDirty: false }))
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [projectId, specId]);
  useEffect(() => {
    if (!snap) return;
    let next: LiveSnapshot = snap;
    for (const e of events) {
      if (e.seq <= applied.current) continue;
      applied.current = e.seq;
      next = applyToSnapshot(next, e);
      if (e.type === 'REFINE_STARTED_RUN') navigate(`/runs/${String(e.data.runId)}`);
    }
    if (next !== snap) {
      if (next.docsDirty) void load();
      else setSnap(next);
    }
  }, [events]);
  if (!snap) return (
    <main>
      <p>{error ?? 'loading…'}</p>
    </main>
  );
  const act = (f: () => Promise<unknown>) => () => {
    setError(null);
    f().catch((e: Error) => setError(e.message));
  };
  return (
    <main>
      <header>
        <a href="/projects">Projects</a> › {projectId} / {specId} <span className={`status ${snap.state.status}`}>{snap.state.status}</span>
      </header>
      {error && <p className="error">{error}</p>}
      <RefinementView
        snap={snap}
        busy={snap.state.status === 'evaluating'}
        onSaveDoc={(f, t) => act(() => refineApi.saveDoc(projectId, specId, f, t))()}
        onEvaluate={act(() => refineApi.evaluate(projectId, specId))}
        onAnswer={(id, t) => act(() => refineApi.answer(projectId, specId, id, t))()}
        onSkip={(id) => act(() => refineApi.skip(projectId, specId, id))()}
        onAccept={(id) => act(() => refineApi.accept(projectId, specId, id))()}
        onReject={(id, r) => act(() => refineApi.reject(projectId, specId, id, r))()}
        onSecret={(n, v) => act(() => refineApi.secret(projectId, specId, n, v).then(load))()}
        onStart={act(() => refineApi.start(projectId, specId).then(({ runId }) => navigate(`/runs/${runId}`)))}
      />
    </main>
  );
}
