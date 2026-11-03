import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { runApi, type LastDeploy, type RepoDetailView, type ServiceStatus } from '../../api.js';
import { usePolling } from '../../usePolling.js';
import { action, panel } from '../project-shared.js';
import { KIND_LABEL } from './labels.js';
import { StatePill } from './StatePill.js';
import { isOffline, shortcutsOf } from './shortcuts.js';

const STATUS_LABEL: Record<RepoDetailView['status'], string> = {
  blocked: 'Bloqueado',
  running: 'Em execução',
  waiting: 'Aguardando você',
  refining: 'Em refinamento',
  done: 'Concluído',
  empty: 'Sem specs',
};

const STATUS_TONE: Record<RepoDetailView['status'], string> = {
  blocked: 'warn',
  running: '',
  waiting: 'neutral',
  refining: '',
  done: 'good',
  empty: '',
};

const SHORTCUT_LABEL = { swagger: 'Abrir Swagger', app: 'Abrir aplicação' } as const;
const PROBE_MS = 5000;

/** The repository's name, kind and state, with the links to its running service and the start action when it is down. */
export function RepoHeader({ detail, projectId, deploy }: { detail: RepoDetailView; projectId: string; deploy: LastDeploy | null }) {
  const navigate = useNavigate();
  const [probe, setProbe] = useState<ServiceStatus | null>(null);
  const [probeFailed, setProbeFailed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const runId = deploy?.runId ?? null;

  // The system can stop after the page opened, so the probe runs again on the page's interval.
  const checkProbe = useCallback(
    () =>
      runId
        ? runApi.serviceStatus(runId).then(
            (p) => {
              setProbe(p);
              setProbeFailed(false);
            },
            () => setProbeFailed(true),
          )
        : Promise.resolve(),
    [runId],
  );
  useEffect(() => {
    setProbe(null);
    setProbeFailed(false);
    void checkProbe();
  }, [checkProbe]);
  usePolling(checkProbe, PROBE_MS);

  const shortcuts = shortcutsOf(detail.kind, detail.name, deploy, probe, window.location.hostname, probeFailed);
  const start = () => {
    if (!deploy) return;
    setStarting(true);
    setStartFailed(false);
    runApi.deployAgain(projectId, deploy.specId).then(
      (r) => navigate(`/runs/${encodeURIComponent(r.runId)}`),
      () => {
        setStarting(false);
        setStartFailed(true);
      },
    );
  };

  return (
    <section className={panel} data-testid="repo-header">
      <div data-testid="repo-header-title-row" className="flex flex-wrap items-center gap-2">
        <h1 data-testid="repo-header-name" className="m-0 text-[1.25rem] font-semibold wrap-anywhere">{detail.name}</h1>
        <span data-testid="repo-header-kind" className="count-pill">{KIND_LABEL[detail.kind ?? ''] ?? detail.kind ?? 'sem tipo'}</span>
        <span data-testid="repo-status">
          <StatePill label={STATUS_LABEL[detail.status]} tone={STATUS_TONE[detail.status]} />
        </span>
      </div>
      <p data-testid="repo-header-responsibility" className="hint">{detail.responsibility}</p>
      <div className="flex flex-wrap items-start gap-3" data-testid="repo-shortcuts">
        {shortcuts.map((s) => (
          <div data-testid={`repo-header-shortcut-${s.kind}`} key={s.kind} className="grid gap-1">
            {s.href ? (
              <a href={s.href} target="_blank" rel="noreferrer" className={action.secondary} data-testid={`shortcut-${s.kind}`}>
                {SHORTCUT_LABEL[s.kind]}
                <span data-testid={`repo-header-shortcut-note-${s.kind}`} className="sr-only"> (abre em nova aba)</span>
              </a>
            ) : (
              // aria-disabled keeps the button in the tab order, so the reason it gives can be read where it is.
              <button type="button" className={`${action.secondary} cursor-not-allowed opacity-60`} aria-disabled="true" aria-describedby={`why-${s.kind}`} data-testid={`shortcut-${s.kind}`}>
                {SHORTCUT_LABEL[s.kind]}
              </button>
            )}
            {s.reason && (
              <span data-testid={`repo-header-shortcut-reason-${s.kind}`} id={`why-${s.kind}`} className="hint text-[0.75rem]">
                {s.reason}
              </span>
            )}
          </div>
        ))}
        {deploy && probe && (
          <span data-testid="repo-service-status" className={`status-pill tone-${probe.online ? 'good' : 'bad'}`}>{probe.online ? 'Sistema no ar' : 'Sistema fora do ar'}</span>
        )}
        {isOffline(deploy, probe) && (
          <button type="button" className={action.primary} onClick={start} disabled={starting} data-testid="start-system">
            Iniciar
          </button>
        )}
        {startFailed && (
          <span data-testid="repo-header-start-error" role="alert" className="text-[0.75rem] tone-bad rounded px-1">
            Não foi possível iniciar o sistema. Tente de novo.
          </span>
        )}
      </div>
    </section>
  );
}
