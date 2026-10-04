import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { runApi, type RunDetail, type StoredEvent } from '../api.js';
import { Icon } from '../components/Icons.js';
import { Markdown } from '../components/Markdown.js';
import { TaskDetail } from '../components/TaskDetail.js';
import { evidence, explainBlockReason, mergedPrs, pausedUntil, phases, rootBlockers, runState, tokens } from '../run/selectors.js';
import { useJournal } from '../useSse.js';

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const money = (n: number) => `US$ ${n.toFixed(4)}`;
const ORDER = ['implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'ready', 'planned', 'merged', 'blocked', 'superseded'];
const statusLabel = (status: string) => ({ done: 'concluído', complete: 'concluído', failed: 'falhou', implementing: 'implementando', validating: 'validando', reviewing: 'revisando', rebasing: 'rebaseando', merging: 'mesclando', ready: 'pronta', planned: 'planejada', merged: 'mesclada', blocked: 'bloqueada', superseded: 'substituída', running: 'em execução' } as Record<string, string>)[status] ?? status;
const statusTone = (status: string) => (['done', 'complete', 'merged'].includes(status) ? 'good' : ['blocked', 'failed'].includes(status) ? 'bad' : status.startsWith('paused') ? 'warn' : status === 'running' ? 'neutral' : 'neutral');

export function RunView({ detail, events, ended, error, loadStep }: { detail: RunDetail; events: StoredEvent[]; ended: boolean; error: string | null; loadStep: (stepId: string) => Promise<{ prompt: string; output: unknown }> }) {
  const unique = events.filter((e, i) => events.findIndex((x) => x.seq === e.seq) === i);
  const state = runState(unique);
  const finished = [...unique].reverse().find((e) => e.type === 'RUN_FINISHED');
  // The journal wins while it streams; before the first event and after the stream ends the server's snapshot is authoritative.
  const status = finished ? String(finished.data.result) : ended || unique.length === 0 ? detail.status : state.status;
  const until = pausedUntil(unique);
  const t = tokens(unique);
  const [selected, setSelected] = useState<string | null>(null);
  const groups = ORDER.map((s) => [s, state.order.filter((id) => state.tasks.get(id)!.state === s)] as const).filter(([, ids]) => ids.length);
  const blocked = (finished?.data.blocked as Array<{ taskId: string; reason: string }> | undefined) ?? [];
  const causes = rootBlockers(blocked);
  const prs = mergedPrs(unique);
  const totalTasks = state.order.length;
  const doneTasks = [...state.tasks.values()].filter((t) => t.state === 'merged').length;
  // Older servers do not send repoUrl; a merged PR URL still names the repository.
  const repoUrl = detail.repoUrl ?? prs.find((p) => p.url)?.url?.replace(/\/pull\/\d+.*$/, '') ?? null;
  return (
    <main className="run-page">
      <nav className="refine-breadcrumb" aria-label="Navegação">
        <Link to="/projects" aria-label="Voltar para projetos">
          <Icon name="home" size={18} />
          <span>Projetos</span>
        </Link>
        <span aria-hidden="true">›</span>
        <strong>{detail.projectId}</strong>
        <span aria-hidden="true">›</span>
        <span>{detail.runId}</span>
      </nav>
      <header className="card run-head">
        <div className="run-head-main">
          <h1>{detail.runId}</h1>
          <div className="run-meta">
            <span data-testid="status" className={`status-pill tone-${statusTone(status)}`}>
              {statusLabel(status)}
              {ended ? ' (encerrada)' : ''}
            </span>
            <span className="hint">
              {detail.projectId} / {detail.specId}
            </span>
            {until ? <span data-testid="paused-until" className="hint">pausada até {hhmm(until)}</span> : null}
          </div>
        </div>
        <div className="run-actions">
          {detail.report ? (
            <Link className="link-button run-action" data-testid="validation-link" to={`/runs/${detail.runId}/validation`}>
              Validação
              <Icon name="chevron" size={16} />
            </Link>
          ) : null}
          {repoUrl ? (
            <a className="primary-button run-action" data-testid="github-link" href={repoUrl} target="_blank" rel="noreferrer">
              <Icon name="github" size={18} />
              Abrir no GitHub
              <Icon name="external" size={16} />
            </a>
          ) : null}
        </div>
        {totalTasks ? (
          <div className="run-progress">
            <div className="run-progress-bar" role="progressbar" aria-label="Tarefas mescladas" aria-valuemin={0} aria-valuemax={totalTasks} aria-valuenow={doneTasks}>
              <span style={{ width: `${(doneTasks / totalTasks) * 100}%` }} />
            </div>
            <span data-testid="task-progress" className="hint">
              {doneTasks} de {totalTasks} tarefas mescladas
            </span>
          </div>
        ) : null}
      </header>
      <section className="card run-readme" data-testid="readme">
        <header>
          <span className="run-readme-tile">
            <Icon name="file" size={20} />
          </span>
          <h2>README do projeto</h2>
          <span className="run-readme-path">docs/README.md</span>
        </header>
        {detail.readme ? (
          <Markdown source={detail.readme} />
        ) : (
          <p className="hint" data-testid="readme-empty">
            Nenhum README gerado ainda. O Scrum Master (sm) escreve o resumo do projeto na fase de relatório, ao fim da run.
          </p>
        )}
      </section>
      {prs.length ? (
        <section className="card">
          <h2>Pull requests mesclados</h2>
          <ul className="pr-list">
            {prs.map((p) => (
              <li key={p.taskId}>
                <span className="task-id">{p.taskId}</span>
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noreferrer">
                    PR #{p.number}
                    <Icon name="external" size={14} />
                  </a>
                ) : (
                  <span>PR #{p.number}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {causes.length ? (
        <section className="card card-cause" data-testid="block-cause">
          <h2>Por que parou</h2>
          <ul className="cause-list">
            {causes.map((c) => (
              <li key={c.taskId}>
                <button className="task-id" onClick={() => setSelected(c.taskId)}>
                  {c.taskId}
                </button>
                <span>{explainBlockReason(c.reason)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="card">
        <h2>Fases</h2>
        <div className="run-phases">
          {phases(unique).map((p) => (
            <span key={p.phase} data-testid="phase" className={`phase phase-${p.result}`}>
              {p.phase} {statusLabel(p.result)}
            </span>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>Tarefas</h2>
        {groups.map(([s, ids]) => (
          <div key={s} className="task-group" data-testid={`group-${s}`}>
            <h3>{statusLabel(s)}</h3>
            <ul>
              {ids.map((id) => {
                const tk = state.tasks.get(id)!;
                return (
                  <li key={id} className="task-row">
                    <button className="task-id" data-testid={`task-${id}`} onClick={() => setSelected(id)}>
                      {id}
                    </button>
                    <span className="task-title">{tk.def.title}</span>
                    <span className="task-meta">
                      tentativas {tk.attempts}
                      {tk.replanned ? ' · replanejada' : ''}
                      {tk.def.origin && tk.def.origin !== 'plan' ? <span className={`tag tag-${tk.def.origin}`}> · {tk.def.origin}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>
      {detail.plan ? (
        <section className="card" data-testid="plan-artifact">
          <h2>Plano executável</h2>
          <p className="hint">Stack: {detail.plan.stack} · specHash: {detail.plan.specHash}</p>
          <ul>
            {detail.plan.tasks.map((task) => (
              <li key={task.id} data-testid={`plan-task-${task.id}`}>
                <strong>{task.id}</strong> — {task.title} · {task.owner} · origem {task.origin}
                <div className="hint">AC: {task.criteriaRefs.join(', ') || 'nenhum'} · caminhos: {task.affectedPaths.join(', ')}</div>
              </li>
            ))}
          </ul>
          <details>
            <summary>Ver plan.json</summary>
            <pre>{JSON.stringify(detail.plan, null, 2)}</pre>
          </details>
        </section>
      ) : null}
      {selected ? <TaskDetail events={unique} taskId={selected} loadStep={loadStep} /> : null}
      <section className="card">
        <h2>Tokens</h2>
        <h3 className="tokens-subhead">Por papel</h3>
        <table>
          <thead>
            <tr>
              <th>Papel</th>
              <th className="num">Entrada</th>
              <th className="num">Saída</th>
              <th className="num">Custo</th>
              <th className="num">Etapas</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(t.byRole).map(([r, u]) => (
              <tr key={r} data-testid={`tokens-${r}`}>
                <td>{r}</td>
                <td className="num">{u.inputTokens}</td>
                <td className="num">{u.outputTokens}</td>
                <td className="num">{money(u.costUsd)}</td>
                <td className="num">{u.steps}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="tokens-subhead">Por fase</h3>
        <table>
          <thead>
            <tr>
              <th>Fase</th>
              <th className="num">Entrada</th>
              <th className="num">Saída</th>
              <th className="num">Custo</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(t.byPhase).map(([p, u]) => (
              <tr key={p}>
                <td>{p}</td>
                <td className="num">{u.inputTokens}</td>
                <td className="num">{u.outputTokens}</td>
                <td className="num">{money(u.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="tokens-total">
          Total de <strong>{money(t.total.costUsd)}</strong> em {t.total.steps} etapas
        </p>
      </section>
      <section className="card">
        <h2>Evidências</h2>
        <table>
          <thead>
            <tr>
              <th>AC</th>
              <th>Testes</th>
            </tr>
          </thead>
          <tbody>
            {evidence(
              unique,
              detail.acceptanceCriteria.map((a) => a.id),
            ).map((row) => (
              <tr key={row.acId} data-testid={`evidence-${row.acId}`}>
                <td>{row.acId}</td>
                <td>
                  {row.tests.length ? (
                    row.tests.map((x) => (
                      <span key={x.id} className={`test test-${x.status}`}>
                        {x.id} ({x.status}, {x.taskId})
                      </span>
                    ))
                  ) : (
                    <span className="hint">nenhum teste</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

export function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (runId)
      runApi
        .run(runId)
        .then(setDetail)
        .catch((e: Error) => setLoadError(e.message));
  }, [runId]);
  const { events, ended, error } = useJournal(runId && detail ? runApi.runEvents(runId) : null);
  if (loadError)
    return (
      <main>
        <p className="error">{loadError}</p>
      </main>
    );
  if (!detail || !runId)
    return (
      <main>
        <p>Carregando…</p>
      </main>
    );
  return <RunView detail={detail} events={events} ended={ended} error={error} loadStep={(stepId) => runApi.step(runId, stepId)} />;
}
