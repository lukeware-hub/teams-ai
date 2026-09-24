import { describe, expect, it } from 'vitest';
import { Accounting } from '../../server/budget/accounting.js';
import { loadConfig } from '../../server/config/config.js';
import { createDecider } from '../../server/decide/create-decider.js';
import type { DecisionRecord, Questions } from '../../server/decide/types.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';

const HASH = 'sha256:' + 'b'.repeat(64);
const questions: Questions = { kind: { type: 'choice', instructions: 'why?', options: { code: 'c', infra: 'i' } } };
const summary: ResultSummary = {
  found: true,
  isError: false,
  subtype: 'success',
  numTurns: 1,
  durationMs: 800,
  costUsd: 0.01,
  usage: { inputTokens: 500, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null,
  resultText: null,
  structuredOutput: null,
  structuredSource: null,
  terminalReason: null,
  apiErrorStatus: null,
  rateLimit: null,
  compactions: 0,
};
const jevBody = {
  model: 'typesafe/jev-1.13-20260917',
  answers: { kind: { type: 'choice', choice: 'infra', probabilities: { code: 0.1, infra: 0.9 }, confidence: 0.88 } },
  usage: { input_tokens: 300, output_tokens: 20, cost: 0.0000126 },
};
const okFetch = (async () => new Response(JSON.stringify(jevBody), { status: 200 })) as typeof fetch;
const KEY = 'sk-or-v1-' + 'cd'.repeat(32);

describe('createDecider', () => {
  it('answers from Jev with the key from secrets and books the cost under system1/openrouter', async () => {
    const accounting = new Accounting();
    const records: DecisionRecord[] = [];
    const d = createDecider({
      cfg: loadConfig({ decisions: { enabled: true } }),
      secrets: { OPENROUTER_API_KEY: KEY },
      accounting,
      runEscalation: async () => {
        throw new Error('must not escalate');
      },
      fetch: okFetch,
      sleep: async () => {},
      onDecision: (r) => records.push(r),
    });
    const out = await d.decide('gate-triage', 'S', questions, { confidential: false });
    expect(out).toMatchObject({ answered: true, backend: 'jev' });
    expect(accounting.records()).toHaveLength(1);
    expect(accounting.records()[0]).toMatchObject({
      role: 'system1',
      provider: 'openrouter',
      stepKind: 'decide',
      model: 'typesafe/jev-1.13-20260917',
      costUsd: 0.0000126,
    });
    expect(accounting.total({ provider: 'openrouter' })).toMatchObject({ inputTokens: 300, outputTokens: 20, steps: 1 });
    expect(records).toHaveLength(1);
  });

  it('without a key the chain skips jev as missing and escalates to Claude; the Claude step books its own usage, so nothing is added here', async () => {
    const accounting = new Accounting();
    const d = createDecider({
      cfg: loadConfig({ decisions: { enabled: true } }),
      secrets: {},
      accounting,
      runEscalation: async (req) => {
        expect(req.role).toBe('test');
        return { ok: true, value: { specHash: HASH, answers: { kind: { type: 'choice', value: 'code' } } }, summary };
      },
      fetch: okFetch,
    });
    const out = await d.decide('gate-triage', 'S', questions, { confidential: false });
    expect(out).toMatchObject({ answered: true, backend: 'claude', escalated: true });
    expect(accounting.records()).toHaveLength(0);
  });

  it('books a low-confidence Jev answer under openrouter even when Claude gives the final answer', async () => {
    const accounting = new Accounting();
    const lowBody = { ...jevBody, answers: { kind: { type: 'choice', choice: 'infra', probabilities: { code: 0.45, infra: 0.55 }, confidence: 0.55 } } };
    const d = createDecider({
      cfg: loadConfig({ decisions: { enabled: true } }),
      secrets: { OPENROUTER_API_KEY: KEY },
      accounting,
      runEscalation: async () => ({ ok: true, value: { specHash: HASH, answers: { kind: { type: 'choice', value: 'code' } } }, summary }),
      fetch: (async () => new Response(JSON.stringify(lowBody), { status: 200 })) as typeof fetch,
      sleep: async () => {},
    });
    const out = await d.decide('gate-triage', 'S', questions, { confidential: false });
    expect(out).toMatchObject({ answered: true, backend: 'claude' });
    expect(accounting.records()).toHaveLength(1);
    expect(accounting.records()[0]).toMatchObject({ provider: 'openrouter', model: 'typesafe/jev-1.13-20260917', costUsd: 0.0000126, usage: { inputTokens: 300, outputTokens: 20 } });
  });

  it('with local enabled a confidential project skips Jev, answers from llama.cpp and books it under local at zero cost', async () => {
    const accounting = new Accounting();
    const completion = {
      model: 'q.gguf',
      tokens_evaluated: 200,
      tokens_predicted: 1,
      completion_probabilities: [{ id: 1, logprob: -0.05, token: 'B', top_logprobs: [{ id: 1, logprob: -0.05, token: 'B' }, { id: 2, logprob: -3.0, token: 'A' }] }],
    };
    const urls: string[] = [];
    const d = createDecider({
      cfg: loadConfig({ decisions: { enabled: true, local: { enabled: true, baseUrl: 'http://127.0.0.1:9999' } } }),
      secrets: { OPENROUTER_API_KEY: KEY },
      accounting,
      runEscalation: async () => {
        throw new Error('must not escalate');
      },
      fetch: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify(completion), { status: 200 });
      }) as typeof fetch,
    });
    const out = await d.decide('gate-triage', 'S', questions, { confidential: true });
    expect(out).toMatchObject({ answered: true, backend: 'local', answers: { kind: { type: 'choice', value: 'infra' } } });
    expect(urls).toEqual(['http://127.0.0.1:9999/completion']);
    expect(accounting.records()).toHaveLength(1);
    expect(accounting.records()[0]).toMatchObject({ provider: 'local', model: 'q.gguf', costUsd: 0, usage: { inputTokens: 200, outputTokens: 1 } });
  });

  it('books nothing when the layer is disabled', async () => {
    const accounting = new Accounting();
    const d = createDecider({
      cfg: loadConfig({}),
      secrets: { OPENROUTER_API_KEY: KEY },
      accounting,
      runEscalation: async () => {
        throw new Error('no');
      },
      fetch: okFetch,
    });
    expect(await d.decide('gate-triage', 'S', questions, { confidential: false })).toEqual({ answered: false, reason: 'disabled' });
    expect(accounting.records()).toHaveLength(0);
  });
});
