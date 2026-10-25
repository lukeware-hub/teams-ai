import type { Snapshot } from '../api.js';
import { Icon } from '../components/Icons.js';
import { ProcessBox } from './ProcessingBanner.js';

type Speckit = Snapshot['state']['speckit'];
type Command = { command: string; itemKey?: string };

const COMMAND = { constitution: 'Constituição do projeto', specify: 'Spec', clarify: 'Esclarecimento', plan: 'Plano', tasks: 'Tarefas' } as Record<string, string>;

/** One Spec Kit command as the owner reads it: what it makes, and the backlog item it is about. */
function commandName(step: Command, titles: Map<string, string>): string {
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
    const current = speckit.current ? `: ${commandName(speckit.current, titles)}` : '';
    return (
      <ProcessBox title="Preparação do Spec Kit em andamento" since={speckit.startedAt} testId="speckit-running">
        <span className="text-[0.75rem] leading-[1.35]">Etapa {Math.min(done + 1, total)} de {total}{current}</span>
        <div role="progressbar" aria-label="Preparação do Spec Kit" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-1.5 overflow-hidden rounded-full bg-good-line">
          <div className="h-full rounded-full bg-good transition-[width] duration-300 ease-out" style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }} />
        </div>
        {done > 0 && (
          <ol className="m-0 grid max-h-56 list-none gap-1 overflow-y-auto p-0 text-[0.75rem] leading-[1.35]" data-testid="speckit-steps">
            {speckit.steps.map((step, i) => (
              <li key={i} className="flex items-start gap-1.5"><Icon name="check" size={14} />{commandName(step, titles)}</li>
            ))}
          </ol>
        )}
      </ProcessBox>
    );
  }
  if (speckit.stale) return <p className={`${line} text-warn`} data-testid="speckit-stale"><Icon name="alert" size={20} /><span>Os documentos ou o backlog mudaram depois da preparação. Prepare de novo antes de iniciar.</span></p>;
  if (waiting) return <p className={`${line} text-warn`} data-testid="speckit-waiting"><Icon name="alert" size={20} /><span>Responda à pergunta do Spec Kit abaixo para poder iniciar o desenvolvimento.</span></p>;
  return <p className={`${line} text-good`} data-testid="speckit-done"><Icon name="check" size={20} /><span>Tudo preparado: constituição, spec, plano e tarefas de cada item. Pode iniciar o desenvolvimento.</span></p>;
}
