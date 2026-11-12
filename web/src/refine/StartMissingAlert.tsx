import { ActionButton } from '../components/ActionButton.js';
import { Icon } from '../components/Icons.js';

type Props = { items: string[]; agentsDecide?: boolean; busy?: boolean; onResolve?(): void };

/** An alert at the top of the step: everything that still keeps the start closed, one line each, and who settles it. */
export function StartMissingAlert({ items, agentsDecide, busy, onResolve }: Props) {
  return (
    <section data-testid="start-missing" role="status" className="grid gap-2 rounded-lg border border-warn-line bg-warn-soft px-4 py-3 text-warn">
      <h3 className="m-0 flex items-center gap-2 text-[0.9375rem] font-semibold normal-case tracking-normal"><Icon name="alert" size={18} />Falta para iniciar o desenvolvimento</h3>
      <ul className="m-0 grid list-disc gap-1 pl-[1.9rem] text-[0.875rem] leading-[1.5] text-ink marker:text-warn">
        {items.map((text) => <li key={text}>{text}</li>)}
      </ul>
      {agentsDecide === true && onResolve ? (
        <div data-testid="start-missing-agents" className="grid gap-2 text-[0.875rem] text-ink">
          <p className="m-0"><b>Quem resolve:</b> os agentes. Você não precisa fazer nada além de clicar.</p>
          <ActionButton data-testid="start-missing-resolve" className="primary h-10 w-full sm:w-auto" busy={busy} disabled={busy} onClick={onResolve} icon={<Icon name="refresh" size={16} />}>Deixar os agentes resolverem</ActionButton>
        </div>
      ) : null}
      {agentsDecide === false ? (
        <p data-testid="start-missing-owner" className="m-0 text-[0.875rem] text-ink"><b>Quem resolve:</b> você. Responda em Precisa de você; ou, em Configurações, autorize os agentes a tomar decisões.</p>
      ) : null}
    </section>
  );
}
