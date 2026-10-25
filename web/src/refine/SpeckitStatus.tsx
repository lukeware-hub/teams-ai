import type { Snapshot } from '../api.js';
import { Icon } from '../components/Icons.js';

type Speckit = Snapshot['state']['speckit'];

const COMMAND = { constitution: 'Constituição do projeto', specify: 'Spec', clarify: 'Esclarecimento', plan: 'Plano', tasks: 'Tarefas' } as Record<string, string>;

/** The step the Spec Kit finished last, as the owner reads it. */
function lastStep(speckit: NonNullable<Speckit>, titles: Map<string, string>): string | null {
  const step = speckit.steps.at(-1);
  if (!step) return null;
  const what = COMMAND[step.command] ?? step.command;
  return step.itemKey ? `${what} de ${titles.get(step.itemKey) ?? step.itemKey}` : what;
}

const line = 'm-0 flex items-start gap-2 text-[0.9375rem] leading-[1.5]';

/** Where the Spec Kit preparation stands: not started, running, done, out of date or failed. */
export function SpeckitStatus({ speckit, titles, waiting = false }: { speckit: Speckit; titles: Map<string, string>; waiting?: boolean }) {
  if (!speckit) return <p className={`${line} text-ink-soft`} data-testid="speckit-idle">O Spec Kit ainda não preparou o desenvolvimento. Ele cria a constituição do projeto e a spec, o plano e as tarefas de cada item do backlog.</p>;
  if (speckit.status === 'failed') return <p role="alert" className={`${line} text-bad`} data-testid="speckit-failed"><Icon name="alert" size={20} /><span>{speckit.error ?? 'A preparação falhou.'}</span></p>;
  if (speckit.status === 'running') {
    const done = speckit.steps.length;
    const total = speckit.total ?? done;
    const last = lastStep(speckit, titles);
    return (
      <div className="grid gap-2" data-testid="speckit-running" aria-live="polite">
        <p className={`${line} text-ink`}>Preparando: {done} de {total} etapas{last ? `. Última: ${last}.` : '.'}</p>
        <div role="progressbar" aria-label="Preparação do Spec Kit" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }} />
        </div>
      </div>
    );
  }
  if (speckit.stale) return <p className={`${line} text-warn`} data-testid="speckit-stale"><Icon name="alert" size={20} /><span>Os documentos ou o backlog mudaram depois da preparação. Prepare de novo antes de iniciar.</span></p>;
  if (waiting) return <p className={`${line} text-warn`} data-testid="speckit-waiting"><Icon name="alert" size={20} /><span>Responda à pergunta do Spec Kit abaixo para poder iniciar o desenvolvimento.</span></p>;
  return <p className={`${line} text-good`} data-testid="speckit-done"><Icon name="check" size={20} /><span>Tudo preparado: constituição, spec, plano e tarefas de cada item. Pode iniciar o desenvolvimento.</span></p>;
}
