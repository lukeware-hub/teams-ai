import { buildSpecsIndex } from './specs-index.js';
import { requestHeading, type RefineState } from './state.js';

/** The trail of a follow-on request: each spec, whether its sources cite the request section, and whether it has a plan and a task list. */
export interface RequestTrace {
  heading: string;
  specs: Array<{ key: string; specId: string; citesRequest: boolean; planned: boolean; tasked: boolean; verdict: 'ok' | 'failed' | 'pending' }>;
}

/** Browser-safe: the screen draws the trail of a request from the state the session holds. Null for a session that is not a request. */
export function requestTrace(state: RefineState): RequestTrace | null {
  if (!state.extension || !state.backlog) return null;
  const heading = requestHeading(state.extension.requestId);
  const steps = state.speckit?.steps ?? [];
  const done = (command: string, key: string): boolean => steps.some((step) => step.command === command && step.itemKey === key && step.basis !== undefined);
  const sources = new Map(state.backlog.items.map((i) => [i.key, i.sources]));
  const failed = (key: string): boolean => (state.speckit?.failures ?? []).some((f) => f.itemKey === key);
  return {
    heading,
    specs: buildSpecsIndex(state.extension.requestId, state.backlog).specs.map((s) => {
      const planned = done('plan', s.key);
      const tasked = done('tasks', s.key);
      // A spec has a verdict once its plan and task list exist (ok), or once its plan failed (failed); before that it is pending.
      const verdict = planned && tasked ? 'ok' : failed(s.key) ? 'failed' : 'pending';
      return { key: s.key, specId: s.specId, citesRequest: (sources.get(s.key) ?? []).some((src) => src.doc === 'briefing.md' && src.heading === heading), planned, tasked, verdict };
    }),
  };
}
