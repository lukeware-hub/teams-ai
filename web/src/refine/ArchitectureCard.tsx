import type { ArchitectureView } from '../api.js';
import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icons.js';

const KIND: Record<string, string> = { api: 'API', jobs: 'Workers', web: 'Web', mobile: 'Mobile', workflow: 'Workflow' };

/** The kind a repository shows: the suffix of a service, or Monólito for the one repository of a monolith. */
export function kindLabel(name: string, style: ArchitectureView['style']): string {
  if (style === 'monolith') return 'Monólito';
  const suffix = /-([a-z]+)$/.exec(name)?.[1] ?? '';
  return KIND[suffix] ?? 'sem tipo';
}

/**
 * The architecture step: the style and its reason, each repository with its quote, and each integration. Before a decision it
 * offers the one primary action; a decision made on documents that changed since says so and asks for a new one.
 */
export function ArchitectureCard({ architecture, error, stale, busy, onDecide }: { architecture: { docsHash: string; decision: ArchitectureView } | null | undefined; error: string | null | undefined; stale: boolean; busy: boolean; onDecide: () => void }) {
  const decision = architecture?.decision;
  return (
    <section className="card my-4 grid gap-3 p-4" aria-label="Arquitetura" data-testid="architecture-card">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="code" size={18} />
        <h3 className="m-0 text-[1rem] font-semibold">Arquitetura</h3>
        {decision && <span className="count-pill" data-testid="architecture-style">{decision.style === 'monolith' ? 'Monólito' : 'Microsserviços'}</span>}
      </div>
      {!decision && !busy && <p className="hint" data-testid="architecture-empty">Nenhuma arquitetura decidida ainda: decida-a a partir dos cinco documentos.</p>}
      {busy && <p className="hint" role="status">Decidindo a arquitetura…</p>}
      {error && <p className="text-warn" role="alert">{error}</p>}
      {decision && stale && <p className="text-warn" data-testid="architecture-stale">Os documentos mudaram: decida a arquitetura de novo.</p>}
      {decision && (
        <>
          <p className="m-0 text-[0.875rem]">{decision.rationale}</p>
          <ul className="m-0 grid list-none gap-2 p-0" aria-label="Repositórios da arquitetura">
            {decision.repositories.map((repo) => (
              <li key={repo.name} className="grid gap-1 text-[0.8125rem]" data-testid={`architecture-repo-${repo.name}`}>
                <span><strong>{repo.name}</strong> <span className="count-pill">{kindLabel(repo.name, decision.style)}</span></span>
                <span className="text-ink-soft">{repo.responsibility}</span>
                <span className="text-ink-soft">{`Evidência (${repo.evidence.doc}): "${repo.evidence.quote}"`}</span>
              </li>
            ))}
          </ul>
          {decision.integrations.length > 0 && (
            <ul className="m-0 grid list-none gap-1 p-0 text-[0.8125rem]" aria-label="Integrações da arquitetura">
              {decision.integrations.map((link) => <li key={`${link.consumer}-${link.provider}`}>{`${link.consumer} → ${link.provider} · ${link.contract}`}</li>)}
            </ul>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <ActionButton data-testid="architecture-decide" className={decision ? 'secondary' : 'primary'} disabled={busy} onClick={onDecide} icon={<Icon name="refresh" size={16} />}>
          {decision ? 'Redefinir' : 'Decidir a arquitetura'}
        </ActionButton>
      </div>
    </section>
  );
}
