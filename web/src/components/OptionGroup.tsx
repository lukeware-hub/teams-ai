/** One answer out of a question's options: a radio group, each option with its detail and an optional "Recomendada" tag. */
export function OptionGroup({ lead, options, value, onChange, disabled = false }: { lead?: string; options: ReadonlyArray<{ label: string; detail: string; recommended?: boolean }>; value: string; onChange: (label: string) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Opções de resposta" className="mt-4 grid gap-2">
      {lead ? <p className="m-0 text-[0.8125rem] text-ink-soft">{lead}</p> : null}
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          role="radio"
          aria-checked={value === o.label}
          disabled={disabled}
          onClick={() => onChange(o.label)}
          className={`h-auto grid gap-[0.15rem] rounded-lg border px-3 py-2 text-left ${value === o.label ? 'border-accent-line bg-accent-soft' : 'border-line bg-surface'}`}
        >
          <b className="text-[0.875rem]">
            {o.label}
            {o.recommended && <span className="ml-2 text-[0.75rem] font-semibold text-accent-text">Recomendada</span>}
          </b>
          <span className="text-[0.8125rem] text-ink-soft">{o.detail}</span>
        </button>
      ))}
    </div>
  );
}
