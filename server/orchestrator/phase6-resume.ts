import { Intent, OrchEvent } from './events.js';

/** An event as the check reads it: its type and its data. */
export interface PhaseEvent {
  type: string;
  data?: Record<string, unknown>;
}

/**
 * The result phase 6 gets, when a run failed in phase 6 and phases 4 and 5 passed; null for any other run. Phases 0 to 5 are not run
 * again: their outcome is in the journal, and the report is written from it.
 */
export function phase6Resume(events: readonly PhaseEvent[]): 'awaiting-validation' | null {
  const last = (types: readonly string[]): number => events.findLastIndex((e) => types.includes(e.type));
  const failed = last([OrchEvent.PhaseFailed]);
  const finished = last([OrchEvent.RunFinished]);
  if (failed < 0 || finished < failed) return null;
  if (events[failed]!.data?.phase !== 6 || events[finished]!.data?.result !== 'phase-failed') return null;
  // Phase 4 passed: its last verification is a pass.
  const verified = last([OrchEvent.VerificationPassed, OrchEvent.VerificationFailed]);
  if (verified < 0 || events[verified]!.type !== OrchEvent.VerificationPassed) return null;
  // Phase 5 passed: a deploy that applied was verified after its last apply, and nothing failed after that apply.
  const applied = last([Intent.DeployApply]);
  if (applied >= 0 && (last([OrchEvent.DeployVerified]) < applied || last([OrchEvent.DeployFailed]) > applied)) return null;
  return 'awaiting-validation';
}
