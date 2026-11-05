import { Link } from 'react-router-dom';
import { action } from '../pages/project-shared.js';
import { refinePath } from '../routes.js';

/** Where the project's open request stands: the agents still prepare it, or they finished and only the start is left. */
export function RequestNotice({ projectId, specId, ready }: { projectId: string; specId: string; ready: boolean }) {
  return (
    <div role="status" data-testid="request-notice" data-ready={ready || undefined} className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-[0.875rem] text-ink ${ready ? 'border-good-line bg-good-soft' : 'border-accent-line bg-accent-soft'}`}>
      <span>{ready ? 'Pedido concluído: os agentes adicionaram e prepararam as specs. Falta só iniciar o desenvolvimento.' : 'Os agentes estão adicionando e preparando as specs do seu pedido.'}</span>
      <Link className={ready ? action.primary : action.secondary} data-testid="request-notice-link" to={refinePath(projectId, specId)}>
        {ready ? 'Ver e iniciar' : 'Acompanhar'}
      </Link>
    </div>
  );
}
