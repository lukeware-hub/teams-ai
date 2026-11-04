import { describe, expect, it } from 'vitest';
import { phase6Resume, type PhaseEvent } from '../../server/orchestrator/phase6-resume.js';

const ev = (type: string, data: Record<string, unknown> = {}): PhaseEvent => ({ type, data });
/** Phases 4 and 5 passed: a verification and a deploy that was verified. */
const passed = [ev('VERIFICATION_PASSED', { round: 1 }), ev('DEPLOY_APPLY', { attempt: 1 }), ev('DEPLOY_VERIFIED', { attempt: 1 })];
/** Phase 6 failed and the run finished with it. */
const failedIn6 = [ev('PHASE_FAILED', { phase: 6, reason: 'Phase 6 blocked: readme: expected string' }), ev('RUN_FINISHED', { result: 'phase-failed', reason: 'Phase 6 blocked' })];

describe('a run that failed in phase 6 resumes there only after phases 4 and 5 passed', () => {
  it('resumes with awaiting-validation when the verification passed and the deploy was verified', () => {
    expect(phase6Resume([ev('RUN_STARTED'), ...passed, ...failedIn6])).toBe('awaiting-validation');
  });

  it('resumes a run that had no deploy, since phase 5 applied nothing', () => {
    expect(phase6Resume([ev('RUN_STARTED'), ev('VERIFICATION_PASSED', { round: 1 }), ...failedIn6])).toBe('awaiting-validation');
  });

  it('does not resume a run that failed in another phase', () => {
    expect(phase6Resume([ev('RUN_STARTED'), ...passed, ev('PHASE_FAILED', { phase: 5, reason: 'deploy' }), ev('RUN_FINISHED', { result: 'phase-failed' })])).toBeNull();
  });

  it('does not resume when the last verification failed', () => {
    expect(phase6Resume([ev('RUN_STARTED'), ev('VERIFICATION_PASSED', { round: 1 }), ev('VERIFICATION_FAILED', { round: 2 }), ...failedIn6])).toBeNull();
  });

  it('does not resume when no verification passed at all', () => {
    expect(phase6Resume([ev('RUN_STARTED'), ...failedIn6])).toBeNull();
  });

  it('does not resume when a deploy failed after its last apply', () => {
    expect(phase6Resume([ev('RUN_STARTED'), ...passed, ev('DEPLOY_APPLY', { attempt: 2 }), ev('DEPLOY_FAILED', { attempt: 2 }), ...failedIn6])).toBeNull();
  });

  it('does not resume a run whose phase 6 failure is not followed by the run finishing', () => {
    expect(phase6Resume([ev('RUN_STARTED'), ...passed, ev('PHASE_FAILED', { phase: 6, reason: 'x' })])).toBeNull();
  });

  it('resumes again a run that was reopened and failed in phase 6 once more', () => {
    expect(phase6Resume([ev('RUN_STARTED'), ...passed, ...failedIn6, ev('RUN_REOPENED', { manual: true }), ...failedIn6])).toBe('awaiting-validation');
  });
});
