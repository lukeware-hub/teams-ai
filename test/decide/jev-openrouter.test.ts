import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  JevOpenRouterBackend,
  RETRYABLE_STATUS,
  fromJevResponse,
  toJevRequest,
  type JevDeps,
} from '../../server/decide/jev-openrouter.js';
import type { Questions } from '../../server/decide/types.js';

const choiceFixture = JSON.parse(readFileSync(new URL('../fixtures/jev/choice-response.json', import.meta.url), 'utf8'));
const mixedFixture = JSON.parse(readFileSync(new URL('../fixtures/jev/mixed-response.json', import.meta.url), 'utf8'));

const triageOptions = {
  code: 'a test or build step failed',
  'flaky-test': 'a test failed nondeterministically',
  infra: 'docker or host broke',
  environment: 'missing tool or image',
  dependency: 'registry or package resolution failed',
};
const triage: Questions = {
  kind: { type: 'choice', instructions: 'Why did the gate fail?', options: triageOptions },
};
const mixed: Questions = {
  risk: { type: 'score', instructions: 'How risky is this diff?', levels: ['trivial', 'moderate', 'high'] },
  drift: { type: 'noul', instructions: 'Does the diff change files outside its declared scope?' },
};

const KEY = 'sk-or-v1-' + 'ab'.repeat(32);

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<Response | Error>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unscripted fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function backend(responses: Array<Response | Error>, over: Partial<JevDeps> = {}) {
  const { fetch, calls } = fakeFetch(responses);
  const sleeps: number[] = [];
  const b = new JevOpenRouterBackend({
    fetch,
    apiKey: KEY,
    baseUrl: 'https://openrouter.ai/api',
    model: 'typesafe/jev-1.13',
    timeoutMs: 1000,
    maxTries: 3,
    backoffMs: 100,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
  });
  return { b, calls, sleeps };
}

describe('toJevRequest', () => {
  it('maps the three primitives onto the System One request shape', () => {
    expect(toJevRequest('typesafe/jev-1.13', 'S', { ...triage, ...mixed })).toEqual({
      model: 'typesafe/jev-1.13',
      state: 'S',
      questions: {
        kind: { type: 'choice', instructions: 'Why did the gate fail?', criteria: triageOptions },
        risk: { type: 'score', instructions: 'How risky is this diff?', criteria: ['trivial', 'moderate', 'high'] },
        drift: { type: 'noul', instructions: 'Does the diff change files outside its declared scope?' },
      },
    });
  });

  it('passes structured instructions and criteria through unchanged', () => {
    const q: Questions = {
      pii: { type: 'noul', instructions: { field: 'comment', check: 'contains personal data' }, criteria: { true: ['name', 'email'], false: 'none' } },
    };
    expect(toJevRequest('m', 'S', q).questions.pii).toEqual({
      type: 'noul',
      instructions: { field: 'comment', check: 'contains personal data' },
      criteria: { true: ['name', 'email'], false: 'none' },
    });
  });
});

describe('fromJevResponse', () => {
  it('maps a choice answer and the usage', () => {
    const r = fromJevResponse(choiceFixture, triage);
    expect(r).toEqual({
      ok: true,
      model: 'typesafe/jev-1.13-20260917',
      usage: { inputTokens: 412, outputTokens: 34, costUsd: 0.0000173 },
      answers: { kind: { type: 'choice', value: 'infra', probabilities: choiceFixture.answers.kind.probabilities, confidence: 0.86 } },
    });
  });

  it('maps score and noul answers; noul confidence is the certainty of either side', () => {
    const r = fromJevResponse(mixedFixture, mixed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers.risk).toEqual({ type: 'score', value: 1.05, probabilities: { '0': 0, '1': 0.95, '2': 0.05 }, confidence: 0.92 });
    expect(r.answers.drift).toEqual({ type: 'noul', value: 0.98, probabilities: { yes: 0.98, no: 0.02 }, confidence: 0.98 });
  });

  it('rejects a choice outside the options', () => {
    const body = structuredClone(choiceFixture);
    body.answers.kind.choice = 'network';
    expect(fromJevResponse(body, triage)).toMatchObject({ ok: false, message: expect.stringContaining('network') });
  });

  it('rejects probabilities that do not sum to 1 or that miss an option', () => {
    const low = structuredClone(choiceFixture);
    low.answers.kind.probabilities = { code: 0.1, 'flaky-test': 0.1, infra: 0.1, environment: 0.1, dependency: 0.1 };
    expect(fromJevResponse(low, triage)).toMatchObject({ ok: false, message: expect.stringContaining('sum') });
    const missing = structuredClone(choiceFixture);
    delete missing.answers.kind.probabilities.dependency;
    missing.answers.kind.probabilities.infra = 0.89;
    expect(fromJevResponse(missing, triage)).toMatchObject({ ok: false, message: expect.stringContaining('dependency') });
  });

  it('rejects a score outside the level range', () => {
    const body = structuredClone(mixedFixture);
    body.answers.risk.score = 7;
    expect(fromJevResponse(body, mixed)).toMatchObject({ ok: false, message: expect.stringContaining('risk') });
    body.answers.risk.score = -0.5;
    expect(fromJevResponse(body, mixed)).toMatchObject({ ok: false, message: expect.stringContaining('risk') });
  });

  it('rejects a missing answer, a type mismatch and a malformed body', () => {
    expect(fromJevResponse({ model: 'm', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }, triage)).toMatchObject({
      ok: false,
      message: expect.stringContaining('kind'),
    });
    const swapped = structuredClone(choiceFixture);
    swapped.answers.kind = { type: 'noul', noul: 0.5 };
    expect(fromJevResponse(swapped, triage)).toMatchObject({ ok: false });
    expect(fromJevResponse('<html>bad gateway</html>', triage)).toMatchObject({ ok: false });
  });
});

describe('JevOpenRouterBackend', () => {
  it('posts to /v1/systemone with the bearer key and returns the mapped answers', async () => {
    const { b, calls } = backend([json(choiceFixture)]);
    const r = await b.evaluate({ state: 'S', questions: triage, escalateTo: 'test' });
    expect(r).toMatchObject({ ok: true, model: 'typesafe/jev-1.13-20260917' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(toJevRequest('typesafe/jev-1.13', 'S', triage));
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries 429 and 529 with exponential backoff, then reports unavailable', async () => {
    const { b, calls, sleeps } = backend([json({ error: 'busy' }, 429), json({ error: 'overloaded' }, 529), json({ error: 'busy' }, 429)]);
    const r = await b.evaluate({ state: 'S', questions: triage, escalateTo: 'test' });
    expect(r).toMatchObject({ ok: false, reason: 'unavailable', message: expect.stringContaining('429') });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
    expect([...RETRYABLE_STATUS].sort((a, b) => a - b)).toEqual([408, 429, 500, 502, 503, 504, 529]);
  });

  it('retries a network error and a timeout, and succeeds on a later try', async () => {
    const abort = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { b, calls } = backend([new TypeError('fetch failed'), abort, json(choiceFixture)]);
    const r = await b.evaluate({ state: 'S', questions: triage, escalateTo: 'test' });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('does not retry 401 or 422 and never echoes the key in the message', async () => {
    const { b, calls } = backend([new Response(`invalid key ${KEY}`, { status: 401 })]);
    const r = await b.evaluate({ state: 'S', questions: triage, escalateTo: 'test' });
    expect(r).toMatchObject({ ok: false, reason: 'unavailable', message: expect.stringContaining('401') });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('treats a 200 with an unparsable body as invalid', async () => {
    const { b } = backend([new Response('<html>proxy error</html>', { status: 200 })]);
    const r = await b.evaluate({ state: 'S', questions: triage, escalateTo: 'test' });
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses to start with an empty key', () => {
    expect(() => backend([], { apiKey: '  ' })).toThrow(/OPENROUTER_API_KEY/);
  });
});
