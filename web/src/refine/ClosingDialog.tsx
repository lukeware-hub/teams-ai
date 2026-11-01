import { Dialog } from '../components/Dialog.js';
import type { ClosingSummary } from '../api.js';

/** The summary a repository session shows before the owner authorizes the development. */
export function ClosingDialog({ summary, busy, onCancel, onAuthorize }: { summary: ClosingSummary; busy: boolean; onCancel: () => void; onAuthorize: (summaryHash: string) => void }) {
  const failing = summary.checks.find((check) => !check.ok);
  return (
    <Dialog title="Resumo do refinamento" onClose={onCancel}>
      <div className="grid gap-4" data-testid="closing-summary">
        <ol className="m-0 grid list-none gap-2 p-0" aria-label="Verificações do resumo">
          {summary.checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2 text-[0.875rem]" data-testid={`close-${check.id}`} data-ok={check.ok}>
              <span aria-hidden="true">{check.ok ? '✓' : '•'}</span>
              <span>{check.detail}</span>
            </li>
          ))}
        </ol>
        <table className="w-full text-[0.8125rem]" data-testid="closing-repositories">
          <thead>
            <tr className="text-left text-ink-soft">
              <th scope="col">Repositório</th>
              <th scope="col">Specs</th>
              <th scope="col">Planos</th>
              <th scope="col">Tarefas</th>
            </tr>
          </thead>
          <tbody>
            {summary.repositories.map((repo) => (
              <tr key={repo.name}>
                <td>{repo.name}</td>
                <td>{repo.specs}</td>
                <td>{repo.plans}</td>
                <td>{repo.tasks}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <details>
          <summary>{`Premissas assumidas (${summary.assumptions.length})`}</summary>
          <ul className="m-0 grid gap-1 pl-5 text-[0.8125rem]">
            {summary.assumptions.map((assumption, i) => (
              <li key={i}>{assumption}</li>
            ))}
          </ul>
        </details>
        <p className="m-0 text-[0.8125rem] text-ink-soft">Até duas specs rodam ao mesmo tempo. Reparos e novas tentativas são automáticos; o custo aparece como alerta, sem parar o desenvolvimento.</p>
        {failing && <p role="alert" className="m-0 text-[0.8125rem] text-warn">{failing.detail}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" data-testid="closing-cancel" onClick={onCancel}>Cancelar</button>
          <button type="button" data-testid="closing-authorize" className="primary" disabled={!summary.ok || busy} onClick={() => onAuthorize(summary.summaryHash)}>
            Autorizo iniciar o desenvolvimento
          </button>
        </div>
      </div>
    </Dialog>
  );
}
