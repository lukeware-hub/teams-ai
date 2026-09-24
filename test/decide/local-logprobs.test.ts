import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LocalLogprobsBackend, buildPrompt, fromCompletion, labelsFor, type LocalDeps } from '../../server/decide/local-logprobs.js';
import type { Questions } from '../../server/decide/types.js';

const choiceFixture = JSON.parse(readFileSync(new URL('../fixtures/local/completion-choice.json', import.meta.url), 'utf8'));

const questions: Questions = {
  kind: { type: 'choice', instructions: 'Why did the gate fail?', options: { code: 'a test failed', infra: 'docker broke', flaky: 'nondeterministic' } },
  risk: { type: 'score', instructions: 'How risky?', levels: ['trivial', 'moderate', 'high'] },
  drift: { type: 'noul', instructions: 'Outside scope?', criteria: { true: 'yes it is', false: 'no it is not' } },
};

type Call = { url: string; body: Record<string, unknown> };
function fakeFetch(handler: (body: Record<string, unknown>) => Response | Error): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    const r = handler(body);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { fetch: f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const completion = (top: Array<[string, number]>) => ({
  content: top[0]![0],
  model: 'm.gguf',
  tokens_evaluated: 100,
  tokens_predicted: 1,
  completion_probabilities: [{ id: 1, logprob: top[0]![1], token: top[0]![0], top_logprobs: top.map(([token, logprob], id) => ({ id, logprob, token })) }],
});

function backend(handler: (body: Record<string, unknown>) => Response | Error, over: Partial<LocalDeps> = {}) {
  const { fetch, calls } = fakeFetch(handler);
  const b = new LocalLogprobsBackend({ fetch, baseUrl: 'http://127.0.0.1:8080', timeoutMs: 1000, nProbs: 20, ...over });
  return { b, calls };
}

describe('local-logprobs labels and prompt', () => {
  it('choice options become A.., score levels 0.., noul yes/no', () => {
    expect(labelsFor(questions.kind!)).toEqual([['A', 'code'], ['B', 'infra'], ['C', 'flaky']]);
    expect(labelsFor(questions.risk!)).toEqual([['0', '0'], ['1', '1'], ['2', '2']]);
    expect(labelsFor(questions.drift!)).toEqual([['yes', 'yes'], ['no', 'no']]);
  });
  it('the prompt shares the state prefix and ends with the answer cue', () => {
    const p = buildPrompt('STATE', questions.kind!);
    expect(p.startsWith(buildPrompt('STATE', questions.risk!).slice(0, 40))).toBe(true);
    expect(p).toContain('A) code: a test failed');
    expect(p.trimEnd().endsWith('Answer:')).toBe(true);
  });
});

describe('fromCompletion', () => {
  it('choice: renormalizes over the option labels and picks the max', () => {
    const r = fromCompletion(choiceFixture, questions.kind!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answer.type).toBe('choice');
    if (r.answer.type !== 'choice') return;
    expect(r.answer.value).toBe('infra');
    const sum = Object.values(r.answer.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(r.answer.probabilities.infra).toBeGreaterThan(0.8);
    expect(r.answer.confidence).toBeCloseTo(r.answer.probabilities.infra!, 6);
    expect(r.usage).toEqual({ inputTokens: 412, outputTokens: 1, costUsd: 0 });
  });
  it('score: value is the probability-weighted level index', () => {
    const r = fromCompletion(completion([['2', Math.log(0.5)], ['1', Math.log(0.5)], ['0', -20]]), questions.risk!);
    if (!r.ok || r.answer.type !== 'score') throw new Error('expected score');
    expect(r.answer.value).toBeCloseTo(1.5, 3);
    expect(r.answer.probabilities['0']).toBeCloseTo(0, 6);
  });
  it('noul: P(yes) over yes+no, tokens may carry a leading space', () => {
    const r = fromCompletion(completion([[' no', Math.log(0.7)], [' yes', Math.log(0.3)]]), questions.drift!);
    if (!r.ok || r.answer.type !== 'noul') throw new Error('expected noul');
    expect(r.answer.value).toBeCloseTo(0.3, 6);
    expect(r.answer.confidence).toBeCloseTo(0.7, 6);
  });
  it('no valid label in the top tokens is invalid', () => {
    const r = fromCompletion(completion([['\n', -0.1], ['The', -2]]), questions.kind!);
    expect(r).toMatchObject({ ok: false });
  });
  it('a body that is not a completion is invalid', () => {
    expect(fromCompletion({ error: 'x' }, questions.kind!)).toMatchObject({ ok: false });
  });
});

describe('LocalLogprobsBackend', () => {
  it('sends one grammar-constrained single-token request per question with the cached prefix', async () => {
    const { b, calls } = backend((body) => {
      const grammar = String(body.grammar);
      if (grammar.includes('"A"')) return json(choiceFixture);
      if (grammar.includes('"0"')) return json(completion([['1', -0.1], ['0', -3], ['2', -3]]));
      return json(completion([['yes', -0.2], ['no', -1.7]]));
    });
    const r = await b.evaluate({ state: 'S', questions, escalateTo: 'test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.answers)).toEqual(['kind', 'risk', 'drift']);
    expect(r.model).toBe('/models/qwen2.5-7b-instruct-q4_k_m.gguf');
    expect(r.usage.inputTokens).toBe(612);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).toBe('http://127.0.0.1:8080/completion');
      expect(c.body).toMatchObject({ n_predict: 1, n_probs: 20, temperature: 0, cache_prompt: true });
      expect(typeof c.body.grammar).toBe('string');
    }
    expect(calls[0]!.body.grammar).toBe('root ::= "A" | "B" | "C"');
  });
  it('a connection error or non-2xx is unavailable; a bad body is invalid', async () => {
    const down = backend(() => new Error('ECONNREFUSED'));
    expect(await down.b.evaluate({ state: 'S', questions, escalateTo: 'test' })).toMatchObject({ ok: false, reason: 'unavailable' });
    const busy = backend(() => json({ error: 'loading' }, 503));
    expect(await busy.b.evaluate({ state: 'S', questions, escalateTo: 'test' })).toMatchObject({ ok: false, reason: 'unavailable' });
    const bad = backend(() => json({ nope: 1 }));
    expect(await bad.b.evaluate({ state: 'S', questions, escalateTo: 'test' })).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
