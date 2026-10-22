import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { createJevScorer } from '../../server/refine/jev-scoring.js';
import type { DocFile } from '../../server/refine/draft.js';
import { UNSCORED } from '../../server/refine/readiness.js';

const TEXTS = { 'project.md': 'P', 'briefing.md': 'B', 'stack.md': 'S', 'flow.md': 'F', 'design.md': 'D' } as Record<DocFile, string>;
const KEY = async () => ({ OPENROUTER_API_KEY: 'test-key' });
const scorer = () => createJevScorer(loadConfig({}), KEY);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answers every check of every request with `answer(check)`, and reports the given usage. */
function stubJev(answer: (id: string) => Record<string, unknown>, usage: Record<string, unknown>): void {
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, answer(id)]));
    return new Response(JSON.stringify({ model: 'jev-test', answers, usage }), { status: 200 });
  }) as typeof fetch;
}

describe('createJevScorer answers', () => {
  it('a check the Jev does not answer with a value leaves the whole scoring unscored', async () => {
    stubJev((id) => (id === 'scoped' ? { type: 'skip' } : { type: 'noul', noul: 0.9 }), { input_tokens: 1, output_tokens: 1, cost: 0.001 });
    expect(await scorer()(TEXTS)).toEqual(UNSCORED);
  });

  it('the cost is unknown when no answer reports one', async () => {
    stubJev(() => ({ type: 'noul', noul: 0.9 }), { input_tokens: 1, output_tokens: 1 });
    const result = await scorer()(TEXTS);
    expect(result.usage).toMatchObject({ inputTokens: expect.any(Number), costUsd: null });
  });
});
