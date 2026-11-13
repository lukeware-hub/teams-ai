import { useCallback, useEffect, useState } from 'react';
import { runPath } from '../../routes.js';
import { useNavigate } from 'react-router-dom';
import { runApi, type LastDeploy, type RepoDetailView, type ServiceStatus } from '../../api.js';
import { usePolling } from '../../usePolling.js';
import { action, panel } from '../project-shared.js';
import { Icon } from '../../components/Icons.js';
import { KIND_LABEL } from './labels.js';
import { StatePill } from './StatePill.js';
import { shortcutsOf, systemHrefOf } from './shortcuts.js';

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
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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

  const grpc = detail.integrations.some((i) => /grpc|connectrpc/i.test(i));
  const shortcuts = shortcutsOf(detail.kind, detail.name, deploy, probe, window.location.hostname, probeFailed, grpc);
  const systemHref = systemHrefOf(detail.name, deploy, probe, window.location.hostname);
  const canToggle = deploy !== null && probe !== null;
  // The containers of the last deploy start or stop in place; a start with no containers left deploys again.
  const toggle = (action: 'start' | 'stop') => {
    if (!deploy) return;
    setConfirmingStop(false);
    setBusy(action);
    setActionError(null);
    runApi
      .setService(projectId, detail.name, action)
      .then(() => checkProbe())
      .catch(() => (action === 'start' ? runApi.deployAgain(projectId, deploy.specId).then((r) => navigate(runPath(r.runId))) : Promise.reject(new Error('stop failed'))))
      .catch(() => setActionError(action === 'start' ? 'Não foi possível iniciar o sistema. Tente de novo.' : 'Não foi possível parar o sistema. Tente de novo.'))
      .finally(() => setBusy(null));
  };

  return (
    <section className={`${panel} gap-4`} data-testid="repo-header">
      <div className="grid min-w-0 gap-2">
        <div data-testid="repo-header-title-row" className="flex flex-wrap items-center gap-2">
          <h1 data-testid="repo-header-name" className="m-0 text-[1.25rem] font-semibold wrap-anywhere">{detail.name}</h1>
          <span data-testid="repo-header-kind" className="count-pill">{KIND_LABEL[detail.kind ?? ''] ?? detail.kind ?? 'sem tipo'}</span>
          <span data-testid="repo-status">
            <StatePill label={STATUS_LABEL[detail.status]} tone={STATUS_TONE[detail.status]} />
          </span>
          {deploy && probe && (
            <span data-testid="repo-service-status" className={`status-pill tone-${probe.online ? 'good' : 'bad'} md:ml-auto`}>{probe.online ? 'Sistema no ar' : 'Sistema fora do ar'}</span>
          )}
        </div>
        <p data-testid="repo-header-responsibility" className="hint m-0 max-w-[65ch]">{detail.responsibility}</p>
        {shortcuts.map((s) =>
          s.reason ? (
            <p key={s.kind} data-testid={`repo-header-shortcut-reason-${s.kind}`} id={`why-${s.kind}`} className="hint m-0 text-[0.8125rem]">
              {s.reason}
            </p>
          ) : null,
        )}
      </div>
      <div className="flex items-start gap-3 border-t border-line pt-4 max-md:flex-col md:flex-wrap md:items-center md:justify-end" data-testid="repo-shortcuts">
        {canToggle && (
          probe.online ? (
            <button type="button" className={`${action.secondary} ${confirmingStop ? 'border-bad-line text-bad' : ''}`} onClick={() => (confirmingStop ? toggle('stop') : setConfirmingStop(true))} onBlur={() => setConfirmingStop(false)} disabled={busy !== null} data-testid="stop-system">
              <Icon name="stop" size={16} />
              {busy === 'stop' ? 'Parando…' : confirmingStop ? 'Confirmar parada' : 'Parar'}
            </button>
          ) : (
            <button type="button" className={action.primary} onClick={() => toggle('start')} disabled={busy !== null} data-testid="start-system">
              <Icon name="play" size={16} />
              {busy === 'start' ? 'Iniciando…' : 'Iniciar'}
            </button>
          )
        )}
        {shortcuts.map((s) => (
          <div data-testid={`repo-header-shortcut-${s.kind}`} key={s.kind} className="grid gap-1 max-md:w-full">
            {s.href ? (
              <a href={s.href} target="_blank" rel="noreferrer" className={action.secondary} data-testid={`shortcut-${s.kind}`}>
                <Icon name="external" size={16} />{SHORTCUT_LABEL[s.kind]}
                <span data-testid={`repo-header-shortcut-note-${s.kind}`} className="sr-only"> (abre em nova aba)</span>
              </a>
            ) : (
              // aria-disabled keeps the button in the tab order, so the reason it gives can be read where it is.
              <button type="button" className={`${action.secondary} cursor-not-allowed border-line bg-surface-muted text-ink-soft hover:bg-surface-muted`} aria-disabled="true" aria-describedby={`why-${s.kind}`} data-testid={`shortcut-${s.kind}`}>
                <Icon name="external" size={16} />{SHORTCUT_LABEL[s.kind]}
              </button>
            )}
          </div>
        ))}
        {systemHref && (
          <a href={systemHref} target="_blank" rel="noreferrer" className={action.secondary} data-testid="shortcut-system">
            <Icon name="external" size={16} />Abrir sistema
            <span className="sr-only"> (abre em nova aba)</span>
          </a>
        )}
        {actionError && (
          <span data-testid="repo-header-start-error" role="alert" className="text-[0.75rem] tone-bad rounded px-1">
            {actionError}
          </span>
        )}
      </div>
    </section>
  );
}
