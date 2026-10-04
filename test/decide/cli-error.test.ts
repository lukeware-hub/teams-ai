import { describe, expect, it } from 'vitest';
import { CLI_ERROR_OPTIONS, classifyCliError, cliErrorQuestions, cliErrorState } from '../../server/decide/decisions/cli-error.js';
import type { DecisionOutcome } from '../../server/decide/types.js';
import { choiceAnswer } from '../fixtures/fake-backend.js';

const input = { resultText: 'Error: something odd', stderr: 'boom', apiErrorStatus: 529, subtype: 'error_during_execution', terminalReason: null };
function fakeDecider(outcome: DecisionOutcome) {
  const calls: unknown[][] = [];
  return {
    calls,
    decide: async (...args: unknown[]) => {
      calls.push(args);
      return outcome;
    },
  };
}

describe('cli error classification', () => {
  it('offers only failure kinds the retry policy handles for an agent step', () => {
    expect(Object.keys(CLI_ERROR_OPTIONS).sort()).toEqual(['auth', 'code', 'quota', 'schema']);
    expect(cliErrorQuestions().kind).toMatchObject({ type: 'choice', options: CLI_ERROR_OPTIONS });
  });

  it('builds a state with the API status, subtype and both texts', () => {
    const s = cliErrorState(input);
    expect(s).toContain('api error status: 529');
    expect(s).toContain('subtype: error_during_execution');
    expect(s).toContain('result text:\nError: something odd');
    expect(s).toContain('stderr (tail):\nboom');
  });

  it('uses the decider answer and asks decision cli-error', async () => {
    const d = fakeDecider({ answered: true, backend: 'jev', escalated: false, answers: { kind: choiceAnswer('quota', { quota: 0.95, code: 0.05 }) } });
    expect(await classifyCliError(input, d, { confidential: false })).toBe('quota');
    expect(d.calls[0]![0]).toBe('cli-error');
  });

  it('falls back to code when unanswered or the answer is not an option', async () => {
    expect(await classifyCliError(input, fakeDecider({ answered: false, reason: 'disabled' }), { confidential: false })).toBe('code');
    const odd = fakeDecider({ answered: true, backend: 'local', escalated: false, answers: { kind: choiceAnswer('network', { network: 1 }) } });
    expect(await classifyCliError(input, odd, { confidential: false })).toBe('code');
  });
});
