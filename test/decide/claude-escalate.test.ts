import { describe, expect, it } from 'vitest';
import { DecideOutput } from '../../server/agents/outputs.js';
import {
  ClaudeEscalateBackend,
  buildEscalationPrompt,
  fromEscalation,
  type EscalationRequest,
} from '../../server/decide/claude-escalate.js';
import type { Questions } from '../../server/decide/types.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';

const HASH = 'sha256:' + 'a'.repeat(64);
const questions: Questions = {
  kind: { type: 'choice', instructions: 'Why did the gate fail?', options: { code: 'test failed', infra: 'docker broke' } },
  risk: { type: 'score', instructions: 'How risky?', levels: ['trivial', 'moderate', 'high'] },
  drift: { type: 'noul', instructions: 'Out of scope changes?' },
};
const summary: ResultSummary = {
  found: true,
  isError: false,
  subtype: 'success',
  numTurns: 1,
  durationMs: 1200,
  costUsd: 0.012,
  usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null,
  resultText: null,
  structuredOutput: null,
  structuredSource: null,
  terminalReason: null,
  apiErrorStatus: null,
  rateLimit: null,
  compactions: 0,
};

describe('buildEscalationPrompt', () => {
  it('carries the state, every question with its options or levels, and the answer rules', () => {
    const p = buildEscalationPrompt('docker: Cannot connect', questions);
    expect(p).toContain('docker: Cannot connect');
    expect(p).toContain('"kind"');
    expect(p).toContain('infra');
    expect(p).toContain('"levels"');
    expect(p).toContain('moderate');
    expect(p).toMatch(/choice.*one of the option names/i);
    expect(p).toMatch(/score.*index/i);
    expect(p).toMatch(/noul.*probability/i);
  });
});

describe('fromEscalation', () => {
  it('maps typed values to answers without calibrated confidence', () => {
    const out = DecideOutput.parse({
      specHash: HASH,
      answers: { kind: { type: 'choice', value: 'infra' }, risk: { type: 'score', value: 1.4 }, drift: { type: 'noul', value: 0.2 } },
    });
    expect(fromEscalation(out, questions)).toEqual({
      ok: true,
      answers: {
        kind: { type: 'choice', value: 'infra', probabilities: { code: 0, infra: 1 }, confidence: null },
        risk: { type: 'score', value: 1.4, probabilities: { '0': 0, '1': 1, '2': 0 }, confidence: null },
        drift: { type: 'noul', value: 0.2, probabilities: { yes: 0.2, no: 0.8 }, confidence: null },
      },
    });
  });

  it('rejects a choice value outside the options, a score outside the levels, a type mismatch and a missing answer', () => {
    const base = { specHash: HASH };
    expect(
      fromEscalation(
        { ...base, answers: { kind: { type: 'choice', value: 'network' }, risk: { type: 'score', value: 1 }, drift: { type: 'noul', value: 0.5 } } },
        questions,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining('network') });
    expect(
      fromEscalation(
        { ...base, answers: { kind: { type: 'choice', value: 'code' }, risk: { type: 'score', value: 2.6 }, drift: { type: 'noul', value: 0.5 } } },
        questions,
      ),
    ).toMatchObject({ ok: false, message: expect.stringContaining('risk') });
    expect(
      fromEscalation(
        { ...base, answers: { kind: { type: 'noul', value: 0.5 }, risk: { type: 'score', value: 1 }, drift: { type: 'noul', value: 0.5 } } },
        questions,
      ),
    ).toMatchObject({ ok: false });
    expect(fromEscalation({ ...base, answers: { kind: { type: 'choice', value: 'code' } } }, questions)).toMatchObject({
      ok: false,
      message: expect.stringContaining('risk'),
    });
  });
});

describe('ClaudeEscalateBackend', () => {
  it('runs a decide step for the escalation role and maps the result and usage', async () => {
    const calls: EscalationRequest[] = [];
    const b = new ClaudeEscalateBackend(async (req) => {
      calls.push(req);
      return {
        ok: true,
        value: { specHash: HASH, answers: { kind: { type: 'choice', value: 'code' }, risk: { type: 'score', value: 0 }, drift: { type: 'noul', value: 0.1 } } },
        summary,
      };
    });
    const r = await b.evaluate({ state: 'S', questions, escalateTo: 'test' });
    expect(calls[0]!.role).toBe('test');
    expect(calls[0]!.prompt).toContain('S');
    expect(r).toMatchObject({ ok: true, model: 'claude', usage: { inputTokens: 900, outputTokens: 60, costUsd: 0.012 } });
  });

  it('reports unavailable when the step fails and invalid when the step answers outside the type', async () => {
    const failing = new ClaudeEscalateBackend(async () => ({
      ok: false,
      failure: 'timeout',
      errors: ['killed after 20m'],
      summary,
      sandboxDisabled: false,
    }));
    expect(await failing.evaluate({ state: 'S', questions, escalateTo: 'test' })).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'timeout: killed after 20m',
    });
    const wrong = new ClaudeEscalateBackend(async () => ({
      ok: true,
      value: { specHash: HASH, answers: { kind: { type: 'choice', value: 'nope' }, risk: { type: 'score', value: 0 }, drift: { type: 'noul', value: 0.1 } } },
      summary,
    }));
    expect(await wrong.evaluate({ state: 'S', questions, escalateTo: 'test' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
