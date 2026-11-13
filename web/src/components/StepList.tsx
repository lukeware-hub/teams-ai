import { useState } from 'react';
import { EFFORT_NAME } from '../refine/running-steps.js';
import { formatDuration, type StepRow } from '../run/selectors.js';

type Artifact = { prompt: string; output: unknown };
const stateLabel = (state: string) => ({ running: 'em execução', ok: 'ok', failed: 'falhou' } as Record<string, string>)[state] ?? state;

/** Agent steps; clicking one loads its prompt and output. */
export function StepList({ steps, loadStep }: { steps: StepRow[]; loadStep: (stepId: string) => Promise<Artifact> }) {
  const [open, setOpen] = useState<Record<string, Artifact | 'loading'>>({});
  const toggle = async (stepId: string) => {
    if (open[stepId]) {
      setOpen((o) => {
        const n = { ...o };
        delete n[stepId];
        return n;
      });
      return;
    }
    setOpen((o) => ({ ...o, [stepId]: 'loading' }));
    const art = await loadStep(stepId);
    setOpen((o) => ({ ...o, [stepId]: art }));
  };
  return (
    <ul data-testid="step-list" className="m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-2 p-0">
      {steps.map((s) => {
        const art = open[s.stepId];
        const parts = [
          s.tier,
          s.model,
          s.effort ? `esforço ${EFFORT_NAME[s.effort] ?? s.effort}` : '',
          s.ok === null ? stateLabel('running') : s.ok ? stateLabel('ok') : `${stateLabel('failed')} (${s.failure})`,
          s.usage ? `${s.usage.inputTokens + s.usage.outputTokens} tokens` : '',
          s.durationMs ? formatDuration(s.durationMs) : '',
        ].filter(Boolean);
        return (
          <li data-testid={`step-list-item-${s.stepId}`} key={s.stepId} className="grid min-w-0 grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-start gap-x-3 gap-y-1 rounded-md border border-line px-3 py-2 max-[30rem]:grid-cols-[minmax(0,1fr)]">
            <button className="min-h-0 w-auto min-w-0 max-w-full break-all px-2 py-0.5 text-left text-[0.8125rem] whitespace-normal" data-testid={`step-${s.stepId}`} onClick={() => void toggle(s.stepId)}>
              {s.stepId}
            </button>
            <div className="min-w-0">
              <p className="m-0 text-[0.875rem] font-semibold text-ink">
                {s.kind} · {s.role}
              </p>
              <p className="m-0 flex flex-wrap gap-x-2 text-[0.8125rem] text-ink-soft">
                {parts.map((part, i) => (
                  <span key={i} className="whitespace-nowrap">
                    {part}
                  </span>
                ))}
              </p>
            </div>
            {art && art !== 'loading' ? (
              <pre data-testid={`step-list-output-${s.stepId}`} className="output col-span-full m-0 min-w-0 max-w-full overflow-x-auto">
                {art.prompt}
                {'\n---\n'}
                {JSON.stringify(art.output, null, 2)}
              </pre>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
