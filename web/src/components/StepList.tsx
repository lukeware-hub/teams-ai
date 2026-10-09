import { useState } from 'react';
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
    <ul>
      {steps.map((s) => {
        const art = open[s.stepId];
        return (
          <li key={s.stepId}>
            <button data-testid={`step-${s.stepId}`} onClick={() => void toggle(s.stepId)}>
              {s.stepId}
            </button>{' '}
            {s.kind} · {s.role}
            {s.tier ? ` · ${s.tier}` : ''}
            {s.model ? ` · ${s.model}` : ''} · {s.ok === null ? stateLabel('running') : s.ok ? stateLabel('ok') : `${stateLabel('failed')} (${s.failure})`}
            {s.usage ? ` · ${s.usage.inputTokens + s.usage.outputTokens} tokens` : ''}
            {s.durationMs ? ` · ${formatDuration(s.durationMs)}` : ''}
            {art && art !== 'loading' ? (
              <pre className="output">
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
