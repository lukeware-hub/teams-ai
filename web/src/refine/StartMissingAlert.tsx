import { Icon } from '../components/Icons.js';

/** An alert at the top of the step: everything that still keeps the start closed, one line each. */
export function StartMissingAlert({ items }: { items: string[] }) {
  return (
    <section data-testid="start-missing" role="status" className="grid gap-2 rounded-lg border border-warn-line bg-warn-soft px-4 py-3 text-warn">
      <h3 className="m-0 flex items-center gap-2 text-[0.9375rem] font-semibold normal-case tracking-normal"><Icon name="alert" size={18} />Falta para iniciar o desenvolvimento</h3>
      <ul className="m-0 grid list-disc gap-1 pl-[1.9rem] text-[0.875rem] leading-[1.5] text-ink marker:text-warn">
        {items.map((text) => <li key={text}>{text}</li>)}
      </ul>
    </section>
  );
}
