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
    <ul data-testid="step-list">
      {steps.map((s) => {
        const art = open[s.stepId];
        return (
          <li data-testid={`step-list-item-${s.stepId}`} key={s.stepId}>
            <button className="min-w-[auto]" data-testid={`step-${s.stepId}`} onClick={() => void toggle(s.stepId)}>
              {s.stepId}
            </button>{' '}
            {s.kind} · {s.role}
            {s.tier ? ` · ${s.tier}` : ''}
            {s.model ? ` · ${s.model}` : ''}
            {s.effort ? ` · esforço ${EFFORT_NAME[s.effort] ?? s.effort}` : ''} · {s.ok === null ? stateLabel('running') : s.ok ? stateLabel('ok') : `${stateLabel('failed')} (${s.failure})`}
            {s.usage ? ` · ${s.usage.inputTokens + s.usage.outputTokens} tokens` : ''}
            {s.durationMs ? ` · ${formatDuration(s.durationMs)}` : ''}
            {art && art !== 'loading' ? (
              <pre data-testid={`step-list-output-${s.stepId}`} className="output">
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
