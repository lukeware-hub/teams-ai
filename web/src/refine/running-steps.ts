import type { StoredEvent } from '../api.js';

/** A Claude step of the round that started and has not finished yet. */
export interface RunningStep {
  stepId: string;
  kind: string;
  role: string;
  model: string;
  effort?: string;
}

const MODEL_NAME: Record<string, string> = { 'claude-haiku-5-5': 'Haiku 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-5-5': 'Opus 5.5' };
const EFFORT_NAME: Record<string, string> = { low: 'baixo', medium: 'médio', high: 'alto', max: 'máximo' };
const ROLE_NAME: Record<string, string> = { po: 'PO', sm: 'SM', front: 'Front' };

/** The steps of the round that started and have no finish event, oldest first. */
export function runningSteps(events: StoredEvent[], cycle: number): RunningStep[] {
  const cycleEvents = events.filter((e) => Number(e.data.attempt) === cycle || Number(e.data.cycle) === cycle);
  const open = new Map<string, RunningStep>();
  for (const event of cycleEvents) {
    if (event.type === 'STEP_STARTED') {
      const stepId = String(event.data.stepId);
      open.set(stepId, { stepId, kind: String(event.data.kind), role: String(event.data.role), model: String(event.data.model), ...(event.data.effort ? { effort: String(event.data.effort) } : {}) });
    }
    if (event.type === 'STEP_FINISHED') open.delete(String(event.data.stepId));
  }
  return [...open.values()];
}

/** One step as the banner shows it: role, model and effort in use. */
export function runningStepLabel(step: RunningStep): string {
  const role = ROLE_NAME[step.role] ?? step.role;
  const model = MODEL_NAME[step.model] ?? step.model;
  const effort = step.effort ? `esforço ${EFFORT_NAME[step.effort] ?? step.effort}` : 'esforço não registrado';
  return `${role} · ${model} · ${effort}`;
}
