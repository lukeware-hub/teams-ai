import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { runApi, type LastDeploy, type RepoDetailView, type ServiceStatus } from '../../api.js';
import { action, panel } from '../project-shared.js';
import { KIND_LABEL } from './labels.js';
import { isOffline, shortcutsOf } from './shortcuts.js';

const STATUS_LABEL: Record<RepoDetailView['status'], string> = {
  blocked: 'Bloqueado',
  running: 'Em execução',
  waiting: 'Aguardando você',
  refining: 'Em refinamento',
  done: 'Concluído',
  empty: 'Sem specs',
};

const SHORTCUT_LABEL = { swagger: 'Abrir Swagger', app: 'Abrir aplicação' } as const;

/** The repository's name, kind and state, with the links to its running service and the start action when it is down. */
export function RepoHeader({ detail, projectId, deploy }: { detail: RepoDetailView; projectId: string; deploy: LastDeploy | null }) {
  const navigate = useNavigate();
  const [probe, setProbe] = useState<ServiceStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const runId = deploy?.runId ?? null;

  useEffect(() => {
    let alive = true;
    setProbe(null);
    if (runId) runApi.serviceStatus(runId).then((p) => alive && setProbe(p), () => undefined);
    return () => {
      alive = false;
    };
  }, [runId]);

  const shortcuts = shortcutsOf(detail.kind, detail.name, deploy, probe, window.location.hostname);
  const start = () => {
    if (!deploy) return;
    setStarting(true);
    runApi.deployAgain(projectId, deploy.specId).then(
      (r) => navigate(`/runs/${encodeURIComponent(r.runId)}`),
      () => setStarting(false),
    );
  };

  return (
    <section className={panel} data-testid="repo-header">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="m-0 text-[1.25rem] font-semibold wrap-anywhere">{detail.name}</h1>
        <span className="count-pill">{KIND_LABEL[detail.kind ?? ''] ?? detail.kind ?? 'sem tipo'}</span>
        <span className="count-pill" data-testid="repo-status">{STATUS_LABEL[detail.status]}</span>
      </div>
      <p className="hint">{detail.responsibility}</p>
      <div className="flex flex-wrap items-start gap-3" data-testid="repo-shortcuts">
        {shortcuts.map((s) => (
          <div key={s.kind} className="grid gap-1">
            {s.href ? (
              <a href={s.href} target="_blank" rel="noreferrer" className={action.secondary} data-testid={`shortcut-${s.kind}`}>
                {SHORTCUT_LABEL[s.kind]}
              </a>
            ) : (
              <button type="button" className={action.secondary} disabled aria-describedby={`why-${s.kind}`} data-testid={`shortcut-${s.kind}`}>
                {SHORTCUT_LABEL[s.kind]}
              </button>
            )}
            {s.reason && (
              <span id={`why-${s.kind}`} className="hint text-[0.75rem]">
                {s.reason}
              </span>
            )}
          </div>
        ))}
        {isOffline(deploy, probe) && (
          <button type="button" className={action.primary} onClick={start} disabled={starting} data-testid="start-system">
            Iniciar
          </button>
        )}
      </div>
    </section>
  );
}
