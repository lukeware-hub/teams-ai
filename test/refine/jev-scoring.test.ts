import { afterEach, describe, expect, it } from 'vitest';
import { DOCUMENT_PURPOSE } from '../../server/agents/document-charter.js';
import { loadConfig } from '../../server/config/config.js';
import { splitSections } from '../../server/decide/windows.js';
import { createJevScorer } from '../../server/refine/jev-scoring.js';
import type { DocFile } from '../../server/refine/draft.js';
import { SCORE_CHECKS, UNSCORED } from '../../server/refine/readiness.js';

interface Sent {
  state: string;
  questions: Record<string, { instructions: string; criteria: { true: string; false: string } }>;
}

const TEXTS = { 'project.md': 'P', 'brief.md': 'B', 'stack.md': 'S', 'flow.md': 'F', 'design.md': 'D' } as Record<DocFile, string>;
const KEY = async () => ({ OPENROUTER_API_KEY: 'secret-key' });
const scorer = () => createJevScorer(loadConfig({}), KEY);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answers every request with `value(state, check)` and returns what the Jev was asked, one entry per request. */
function stubJev(value: (state: string, check: string) => number): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: value(body.state, id) }]));
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 4, cost: 0.001 } }), { status: 200 });
  }) as typeof fetch;
  return sent;
}

describe('createJevScorer', () => {
  it('asks once per document, with the four checks naming the document and its purpose', async () => {
    const sent = stubJev(() => 0.9);
    await scorer()(TEXTS);
    expect(sent).toHaveLength(5);
    const flow = sent.find((s) => s.state.startsWith('flow.md:'))!;
    expect(Object.keys(flow.questions)).toEqual([...SCORE_CHECKS]);
    for (const question of Object.values(flow.questions)) expect(question.instructions).toContain(DOCUMENT_PURPOSE['flow.md']);
    expect(flow.questions.complete!.criteria.true).toContain('flow.md');
  });

  it('scores a document as the mean of its four checks, and the average as the mean of the five documents', async () => {
    const values: Record<string, number> = { complete: 0.8, concrete: 0.6, consistent: 1, scoped: 0.4 };
    stubJev((_state, check) => values[check]!);
    const result = await scorer()(TEXTS);
    expect(result).toMatchObject({ available: true, model: 'jev-1.13.0' });
    for (const id of SCORE_CHECKS) expect(result.docs!['flow.md'].checks[id]).toBeCloseTo(values[id]!);
    expect(result.docs!['flow.md'].score).toBeCloseTo(0.7);
    expect(result.average).toBeCloseTo(0.7);
  });

  it('weights the windows of a long document by their length, for the share of concrete statements', async () => {
    const long = 'x'.repeat(40_000);
    const [first, second] = splitSections([{ title: 'flow.md', text: long }], 32_000).map((w) => w.length);
    stubJev((state) => (state.includes('(continued)') ? 0.2 : 0.9));
    const result = await scorer()({ ...TEXTS, 'flow.md': long });
    expect(result.docs!['flow.md'].checks.concrete).toBeCloseTo((0.9 * first! + 0.2 * second!) / (first! + second!));
  });

  it('takes the best window for completeness, and the worst for contradictions and foreign content, since one window can show a gap or a fault', async () => {
    const long = 'x'.repeat(40_000);
    stubJev((state) => (state.includes('(continued)') ? 0.2 : 0.9));
    const result = await scorer()({ ...TEXTS, 'flow.md': long });
    expect(result.docs!['flow.md'].checks.complete).toBeCloseTo(0.9);
    expect(result.docs!['flow.md'].checks.consistent).toBeCloseTo(0.2);
    expect(result.docs!['flow.md'].checks.scoped).toBeCloseTo(0.2);
  });

  it('gives an empty document a zero score without asking the Jev about it', async () => {
    const sent = stubJev(() => 0.9);
    const result = await scorer()({ ...TEXTS, 'design.md': '' });
    expect(sent).toHaveLength(4);
    expect(result.docs!['design.md']).toEqual({ score: 0, checks: { complete: 0, concrete: 0, consistent: 0, scoped: 0 } });
    expect(result.average).toBeCloseTo((4 * 0.9) / 5);
  });

  it('reports no score when a request fails, with no partial numbers', async () => {
    globalThis.fetch = (async () => new Response('bad request', { status: 400 })) as typeof fetch;
    expect(await scorer()(TEXTS)).toEqual(UNSCORED);
  });

  it('reports no score when one window fails and the others answer, with no partial numbers', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 2) return new Response('bad request', { status: 400 });
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(SCORE_CHECKS.map((id) => [id, { type: 'noul', noul: 0.9 }])), usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;
    expect(await scorer()(TEXTS)).toEqual(UNSCORED);
  });

  it('reports no score without an OpenRouter key, and sends nothing', async () => {
    const sent = stubJev(() => 0.9);
    const result = await createJevScorer(loadConfig({}), async () => ({}))(TEXTS);
    expect(sent).toHaveLength(0);
    expect(result).toEqual(UNSCORED);
  });

  it('redacts the project secrets before the documents leave', async () => {
    const sent = stubJev(() => 0.9);
    await createJevScorer(loadConfig({}), async () => ({ OPENROUTER_API_KEY: 'secret-key', DB_PASSWORD: 'hunter2' }))({ ...TEXTS, 'flow.md': 'the password is hunter2' });
    expect(sent.map((s) => s.state).join('\n')).not.toContain('hunter2');
  });

  it('adds up the tokens and the cost of every request', async () => {
    stubJev(() => 0.9);
    const result = await scorer()(TEXTS);
    expect(result.usage).toMatchObject({ inputTokens: 50, outputTokens: 20 });
    expect(result.usage!.costUsd).toBeCloseTo(0.005);
  });
});
