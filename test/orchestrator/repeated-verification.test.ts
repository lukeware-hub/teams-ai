import { describe, expect, it } from 'vitest';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { repeatedVerificationFailure } from '../../server/orchestrator/phases/verify.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import type { StoredEvent } from '../../server/store/event-store.js';

const event = (type: string, data: Record<string, unknown>): StoredEvent => ({ seq: 1, at: '2026-11-05T00:00:00Z', runId: 'r', specHash: 'h', type, kind: 'fact', data });
const failed = (uncoveredAcs: string[], over: Record<string, unknown> = {}) => event(OrchEvent.VerificationFailed, { round: 2, failedTests: [], uncoveredAcs, gate: null, ...over });
const fixRound = event(RunEvent.FixTasksPlanned, { round: 1, tasks: [] });
const now = { failedTests: [] as string[], uncoveredAcs: ['AC-012', 'AC-014'], gate: null as string | null };

describe('repeatedVerificationFailure', () => {
  it('is true when an earlier run tried a fix round and left the same criteria uncovered', () => {
    expect(repeatedVerificationFailure([[fixRound, failed(['AC-014', 'AC-012'])]], now)).toBe(true);
  });

  it('is false when the earlier run never planned a fix, so the first fix round is still allowed', () => {
    expect(repeatedVerificationFailure([[failed(['AC-012', 'AC-014'])]], now)).toBe(false);
  });

  it('is false when the criteria, the failing tests or the gate differ', () => {
    expect(repeatedVerificationFailure([[fixRound, failed(['AC-012'])]], now)).toBe(false);
    expect(repeatedVerificationFailure([[fixRound, failed(['AC-012', 'AC-014'], { failedTests: ['t::x'] })]], now)).toBe(false);
    expect(repeatedVerificationFailure([[fixRound, failed(['AC-012', 'AC-014'], { gate: 'lint' })]], now)).toBe(false);
  });

  it('judges by the latest earlier run that failed verification, skipping runs that never reached it', () => {
    const earlier = [[fixRound, failed(['AC-012', 'AC-014'])], [event(OrchEvent.RunStarted, {})]];
    expect(repeatedVerificationFailure(earlier, now)).toBe(true);
    expect(repeatedVerificationFailure([[fixRound, failed(['AC-012', 'AC-014'])], [fixRound, failed(['AC-099'])]], now)).toBe(false);
  });

  it('is false with no earlier run, and when the current failure names nothing to compare', () => {
    expect(repeatedVerificationFailure([], now)).toBe(false);
    expect(repeatedVerificationFailure([[fixRound, failed([])]], { failedTests: [], uncoveredAcs: [], gate: null })).toBe(false);
  });
});
