import type { ArchitectureView } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icons.js';
import { ProcessBox } from './ProcessingBanner.js';

const KIND: Record<string, string> = { api: 'API', jobs: 'Workers', web: 'Web', mobile: 'Mobile', workflow: 'Workflow' };

/** The kind a repository shows: the suffix of a service, or Monólito for the one repository of a monolith. */
export function kindLabel(name: string, style: ArchitectureView['style']): string {
  if (style === 'monolith') return 'Monólito';
  const suffix = /-([a-z]+)$/.exec(name)?.[1] ?? '';
  return KIND[suffix] ?? 'sem tipo';
}

/**
 * The architecture step: the style and its reason, each repository with its quote, and each integration. Before a decision it
 * offers the one primary action. A decision that broke a rule lists each rule still open, so the owner corrects the documents
 * before deciding again.
 */
export function ArchitectureCard({ architecture, error, issues = [], busy, locked = false, stale = false, blocked = null, startedAt, onDecide }: { architecture: { docsHash: string; decision: ArchitectureView } | null | undefined; error: string | null | undefined; issues?: string[]; busy: boolean; locked?: boolean; /** The documents changed after the decision: the backlog decides again. */ stale?: boolean; /** Why the decision waits now, in plain words; null when it can run. */ blocked?: string | null; startedAt?: string | null; onDecide: () => unknown }) {
  const decision = architecture?.decision;
  return (
    <section className="card my-4 grid gap-3 p-4" aria-label="Arquitetura" data-testid="architecture-card">
      <div className="flex flex-wrap items-center gap-2" data-testid="architecture-card-header">
        <Icon name="code" size={18} />
        <h3 className="m-0 text-[1rem] font-semibold" data-testid="architecture-card-title">Arquitetura</h3>
        {decision && <span className="count-pill" data-testid="architecture-style">{decision.style === 'monolith' ? 'Monólito' : 'Microsserviços'}</span>}
      </div>
      {decision && stale && <p className="hint" data-testid="architecture-card-stale">A decisão está desatualizada, porque os documentos mudaram depois dela: o backlog decide a arquitetura de novo ao ser quebrado.</p>}
      {!decision && !busy && <p className="hint" data-testid="architecture-empty">Nenhuma arquitetura decidida ainda: decida-a a partir dos cinco documentos.</p>}
      {busy && (
        <ProcessBox title="Decidindo a arquitetura" since={startedAt ?? null} testId="architecture-progress">
          <span className="text-[0.75rem] leading-[1.35]" data-testid="architecture-card-progress-text">Lendo os cinco documentos do grafo e decidindo o estilo e os repositórios. Ao terminar, a decisão aparece aqui.</span>
        </ProcessBox>
      )}
      {error && <p className="text-warn" role="alert" data-testid="architecture-card-error">{error}</p>}
      {error && issues.length > 0 && (
        <div className="grid gap-1 text-[0.8125rem]" data-testid="architecture-issues">
          <span className="font-semibold" data-testid="architecture-card-issues-title">O que ainda não fecha:</span>
          <ul className="m-0 grid list-disc gap-1 pl-5 text-ink-soft" data-testid="architecture-card-issues-list">{issues.map((issue) => <li key={issue} data-testid={`architecture-card-issue-${issue}`}>{issue}</li>)}</ul>
          <span className="text-ink-soft" data-testid="architecture-card-issues-hint">Corrija o que falta nos documentos e decida a arquitetura de novo.</span>
        </div>
      )}
      {decision && (
        <>
          <p className="m-0 text-[0.875rem]" data-testid="architecture-card-rationale">{decision.rationale}</p>
          <ul className="m-0 grid list-none gap-2 p-0" aria-label="Repositórios da arquitetura" data-testid="architecture-card-repos">
            {decision.repositories.map((repo) => (
              <li key={repo.name} className="grid gap-1 text-[0.8125rem]" data-testid={`architecture-repo-${repo.name}`}>
                <span data-testid={`architecture-card-repo-heading-${repo.name}`}><strong data-testid={`architecture-card-repo-name-${repo.name}`}>{repo.name}</strong> <span className="count-pill" data-testid={`architecture-card-repo-kind-${repo.name}`}>{kindLabel(repo.name, decision.style)}</span></span>
                <span className="text-ink-soft" data-testid={`architecture-card-repo-responsibility-${repo.name}`}>{repo.responsibility}</span>
                <span className="text-ink-soft" data-testid={`architecture-card-repo-evidence-${repo.name}`}>{`Evidência (${repo.evidence.doc}): "${repo.evidence.quote}"`}</span>
              </li>
            ))}
          </ul>
          {decision.integrations.length > 0 && (
            <ul className="m-0 grid list-none gap-1 p-0 text-[0.8125rem]" aria-label="Integrações da arquitetura" data-testid="architecture-card-integrations">
              {decision.integrations.map((link) => <li key={`${link.consumer}-${link.provider}`} data-testid={`architecture-card-integration-${link.consumer}-${link.provider}`}>{`${link.consumer} → ${link.provider} · ${link.contract}`}</li>)}
            </ul>
          )}
        </>
      )}
      {blocked && <p className="hint" data-testid="architecture-card-blocked">{blocked}</p>}
      <div className="flex flex-wrap gap-2" data-testid="architecture-card-actions">
        <ActionButton data-testid="architecture-decide" className={decision ? 'secondary' : 'primary'} disabled={busy || locked || blocked !== null} title={locked ? 'O desenvolvimento já começou: a arquitetura não muda mais.' : (blocked ?? undefined)} onClick={onDecide} icon={<Icon name="refresh" size={16} />}>
          {decision ? 'Redefinir' : 'Decidir a arquitetura'}
        </ActionButton>
      </div>
    </section>
  );
}
