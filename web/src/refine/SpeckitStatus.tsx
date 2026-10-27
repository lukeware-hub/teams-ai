import { stepKey } from '@server/refine/speckit-steps';
import type { Snapshot } from '../api.js';
import { Icon } from '../components/Icons.js';
import { formatDuration } from '../run/selectors.js';
import { ProcessBox } from './ProcessingBanner.js';

type Speckit = Snapshot['state']['speckit'];
type Command = { command: string; itemKey?: string; startedAt?: string; endedAt?: string; reused?: boolean };
type Row = { step: Command; state: 'done' | 'running' | 'pending' };

const COMMAND = { constitution: 'Constituição do projeto', specify: 'Spec', clarify: 'Esclarecimento', plan: 'Plano', tasks: 'Tarefas' } as Record<string, string>;

/** One Spec Kit command as the owner reads it: what it makes, and the backlog item it is about. */
function commandName(step: Command, titles: Map<string, string>): string {
  const what = COMMAND[step.command] ?? step.command;
  return step.itemKey ? `${what} de ${titles.get(step.itemKey) ?? step.itemKey}` : what;
}

/** How long a finished step took, or nothing when its times are missing. */
function durationOf(step: Command): string {
  if (!step.startedAt || !step.endedAt) return '';
  const ms = Date.parse(step.endedAt) - Date.parse(step.startedAt);
  return Number.isNaN(ms) ? '' : formatDuration(ms);
}

/** What a finished row says: a step kept from an earlier run, or how long it took. */
function doneLabel(step: Command): string {
  if (step.reused) return 'Reaproveitada';
  const time = durationOf(step);
  return `Feito${time ? ` · ${time}` : ''}`;
}

/** Every step of the preparation: the finished ones, the running ones, then the planned ones still to come. */
function rowsOf(speckit: NonNullable<Speckit>, plan: readonly Command[]): Row[] {
  const running = speckit.running ?? [];
  const started = new Set([...speckit.steps, ...running].map((step) => stepKey(step.command, step.itemKey)));
  return [
    ...speckit.steps.map((step): Row => ({ step, state: 'done' })),
    ...running.map((step): Row => ({ step, state: 'running' })),
    ...plan.filter((step) => !started.has(stepKey(step.command, step.itemKey))).map((step): Row => ({ step, state: 'pending' })),
  ];
}

const rowIcon = {
  done: <Icon name="check" size={14} />,
  running: <span className="button-spinner" aria-hidden="true" />,
  pending: <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />,
};

const line = 'm-0 flex items-start gap-2 text-[0.9375rem] leading-[1.5]';

/** The feature folder Spec Kit made for each item, behind a summary that counts them. */
function FeatureFolders({ features, titles }: { features: Record<string, string>; titles: Map<string, string> }) {
  const rows = Object.entries(features);
  return (
    <details className="group text-[0.8125rem]" data-testid="speckit-features">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-[0.35rem] text-ink-soft [&::-webkit-details-marker]:hidden">
        <span className="transition-transform group-open:rotate-90"><Icon name="chevron-right" size={14} /></span>
        {rows.length === 1 ? '1 pasta de feature' : `${rows.length} pastas de feature`}
      </summary>
      <ul className="m-0 mt-2.5 grid list-none gap-2 p-0">
        {rows.map(([key, dir]) => (
          <li key={key} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md border border-line bg-surface px-3 py-2.5">
            <span className="flex-none text-accent"><Icon name="folder" size={16} /></span>
            <span className="wrap-anywhere min-w-0 grow basis-40 text-[0.875rem] font-semibold text-ink">{titles.get(key) ?? key}</span>
            <code className="ml-[1.625rem] max-w-full rounded-sm bg-surface-muted px-1.5 py-0.5 text-[0.75rem] text-ink-soft wrap-anywhere">{dir}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

type Props = { speckit: Speckit; titles: Map<string, string>; plan?: readonly Command[]; waiting?: boolean };

/** Where the Spec Kit preparation stands, with the feature folders it made so far. `plan` is every step in order. */
export function SpeckitStatus(props: Props) {
  const features = props.speckit?.features;
  return (
    <div className="grid gap-2">
      <Status {...props} />
      {features && <FeatureFolders features={features} titles={props.titles} />}
    </div>
  );
}

/** Where the Spec Kit preparation stands: not started, running, done, out of date or failed. */
function Status({ speckit, titles, plan = [], waiting = false }: Props) {
  if (!speckit) return <p className={`${line} text-ink-soft`} data-testid="speckit-idle">O Spec Kit ainda não preparou o desenvolvimento. Ele cria a constituição do projeto e a spec, o plano e as tarefas de cada item do backlog.</p>;
  if (speckit.status === 'failed') {
    return (
      <div role="alert" className={`${line} text-warn`} data-testid="speckit-failed">
        <Icon name="alert" size={20} />
        <div className="grid min-w-0 gap-1">
          <span>{speckit.error ?? 'A preparação falhou.'}</span>
          {speckit.detail && (
            <details className="text-ink-soft">
              <summary className="w-fit cursor-pointer text-[0.75rem]">Detalhe técnico</summary>
              <pre className="m-0 max-h-48 overflow-auto text-[0.75rem] whitespace-pre-wrap wrap-anywhere" data-testid="speckit-failed-detail">{speckit.detail}</pre>
            </details>
          )}
        </div>
      </div>
    );
  }
  if (speckit.status === 'running') {
    const done = speckit.steps.length;
    const total = speckit.total ?? done;
    const running = speckit.running?.length ?? 0;
    const reused = speckit.steps.filter((step) => step.reused).length;
    const summary = `${done} de ${total} etapas concluídas · ${running} em andamento${reused > 0 ? ` · ${reused} ${reused === 1 ? 'reaproveitada' : 'reaproveitadas'}` : ''}`;
    return (
      <ProcessBox title="Preparação do Spec Kit em andamento" since={speckit.startedAt} testId="speckit-running">
        <span className="text-[0.75rem] leading-[1.35]">{summary}</span>
        <div role="progressbar" aria-label="Preparação do Spec Kit" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-1.5 overflow-hidden rounded-full bg-accent-line">
          <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }} />
        </div>
        <details className="group" data-testid="speckit-log">
          <summary className="flex cursor-pointer list-none items-center gap-[0.35rem] text-[0.75rem] font-semibold [&::-webkit-details-marker]:hidden">
            <span className="transition-transform group-open:rotate-90"><Icon name="chevron-right" size={14} /></span>
            Ver as {total} etapas
          </summary>
          <ol className="m-0 mt-[0.35rem] grid max-h-96 list-none gap-1 overflow-y-auto p-0 text-[0.75rem] leading-[1.35]" data-testid="speckit-steps">
            {rowsOf(speckit, plan).map(({ step, state }, i) => (
              <li key={i} data-state={state} className={`flex items-center gap-2 ${state === 'pending' ? 'text-ink-soft' : ''}`}>
                <span className="grid size-4 flex-none place-items-center">{rowIcon[state]}</span>
                <span className="min-w-0 flex-1">{commandName(step, titles)}</span>
                <span className="flex-none tabular-nums">{state === 'running' ? 'em andamento' : state === 'done' ? doneLabel(step) : ''}</span>
              </li>
            ))}
          </ol>
        </details>
      </ProcessBox>
    );
  }
  if (speckit.stale) return <p className={`${line} text-warn`} data-testid="speckit-stale"><Icon name="alert" size={20} /><span>Os documentos ou o backlog mudaram depois da preparação. Prepare de novo antes de iniciar.</span></p>;
  if (waiting) return <p className={`${line} text-warn`} data-testid="speckit-waiting"><Icon name="alert" size={20} /><span>Responda à pergunta do Spec Kit abaixo para poder iniciar o desenvolvimento.</span></p>;
  return <p className={`${line} text-good`} data-testid="speckit-done"><Icon name="check" size={20} /><span>Tudo preparado: constituição, spec, plano e tarefas de cada item. Pode iniciar o desenvolvimento.</span></p>;
}
