import { refineApi, type ClosingSummary } from '../api.js';
import { Pagination, usePagedTable } from '../components/DataTable.js';
import { Dialog } from '../components/Dialog.js';

/** The summary a repository session shows before the owner authorizes the development; its repositories come one page at a time. */
export function ClosingDialog({ projectId, specId, summary, busy, onCancel, onAuthorize }: { projectId: string; specId: string; summary: ClosingSummary; busy: boolean; onCancel: () => void; onAuthorize: (summaryHash: string) => void }) {
  return (
    <Dialog title="Resumo do refinamento" onClose={onCancel}>
      <div className="grid gap-4" data-testid="closing-summary">
        <ol className="m-0 grid list-none gap-2 p-0" aria-label="Verificações do resumo" data-testid="closing-checks">
          {summary.checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2 text-[0.875rem]" data-testid={`close-${check.id}`} data-ok={check.ok}>
              <span aria-hidden="true" data-testid={`closing-check-mark-${check.id}`}>{check.ok ? '✓' : '•'}</span>
              <span data-testid={`closing-check-detail-${check.id}`}>{check.detail}</span>
            </li>
          ))}
        </ol>
        <ClosingRepositories projectId={projectId} specId={specId} />
        <details data-testid="closing-assumptions">
          <summary data-testid="closing-assumptions-summary">{`Premissas assumidas (${summary.assumptions.length})`}</summary>
          <ul className="m-0 grid gap-1 pl-5 text-[0.8125rem]" data-testid="closing-assumptions-list">
            {summary.assumptions.map((assumption, i) => (
              <li key={i} data-testid={`closing-assumption-${assumption}`}>{assumption}</li>
            ))}
          </ul>
        </details>
        <p className="m-0 text-[0.8125rem] text-ink-soft" data-testid="closing-hint">Até duas specs rodam ao mesmo tempo. Reparos e novas tentativas são automáticos; o custo aparece como alerta, sem parar o desenvolvimento.</p>
        {!summary.ok && <p role="status" className="m-0 text-[0.8125rem] text-ink-soft" data-testid="closing-unapproved-note">Itens reprovados não travam o início: cada um está na lista acima, com o que falta corrigir.</p>}
        <div className="flex flex-wrap justify-end gap-2" data-testid="closing-actions">
          <button type="button" data-testid="closing-cancel" onClick={onCancel}>Cancelar</button>
          <button type="button" data-testid="closing-authorize" className="primary" disabled={busy} onClick={() => onAuthorize(summary.summaryHash)}>
            Autorizo iniciar o desenvolvimento
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** The repositories the closing covers, with their specs, plans and tasks, one page at a time. */
function ClosingRepositories({ projectId, specId }: { projectId: string; specId: string }) {
  const view = usePagedTable(`${projectId}/${specId}/closing`, (req) => refineApi.closingRepositories(projectId, specId, req));
  if (!view.loaded) return <p data-testid="closing-repositories-loading" className="hint" role="status">Carregando os repositórios…</p>;
  return (
    <div>
      <table className="w-full text-[0.8125rem]" data-testid="closing-repositories">
        <thead data-testid="closing-repos-head">
          <tr className="text-left text-ink-soft" data-testid="closing-repos-head-row">
            <th scope="col" data-testid="closing-repos-col-name">Repositório</th>
            <th scope="col" data-testid="closing-repos-col-specs">Specs</th>
            <th scope="col" data-testid="closing-repos-col-plans">Planos</th>
            <th scope="col" data-testid="closing-repos-col-tasks">Tarefas</th>
          </tr>
        </thead>
        <tbody data-testid="closing-repos-body">
          {view.rows.map((repo) => (
            <tr key={repo.name} data-testid={`closing-repo-${repo.name}`}>
              <td data-testid={`closing-repo-name-${repo.name}`}>{repo.name}</td>
              <td data-testid={`closing-repo-specs-${repo.name}`}>{repo.specs}</td>
              <td data-testid={`closing-repo-plans-${repo.name}`}>{repo.plans}</td>
              <td data-testid={`closing-repo-tasks-${repo.name}`}>{repo.tasks}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination view={view} />
    </div>
  );
}
