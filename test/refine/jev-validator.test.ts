import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../server/config/config.js';
import { createJevValidator } from '../../server/refine/jev-validation.js';

const evaluate = vi.hoisted(() => vi.fn(async (_request: unknown) => ({ ok: true, model: 'jev-test', answers: new Proxy({}, { get: () => ({ type: 'noul', value: 0.9 }) }) })));

vi.mock('../../server/decide/jev-openrouter.js', () => ({
  JevOpenRouterBackend: class {
    evaluate = evaluate;
  },
}));

const cfg = { decisions: { openrouter: { baseUrl: 'https://example.test', model: 'jev-test', timeoutMs: 1000, maxTries: 1, backoffMs: 1 } } } as unknown as Config;

describe('createJevValidator', () => {
  it('tells the Jev which documents exist yet, and reads the checks it answers', async () => {
    const validate = createJevValidator(cfg, async () => ({ OPENROUTER_API_KEY: 'test-key' }));
    const result = await validate({ project: '# Shop', briefing: '', stack: '', flow: '# Flow', design: '' });
    const request = evaluate.mock.calls[0]![0] as { questions: Record<string, { instructions: string }> };
    expect(Object.values(request.questions)[0]!.instructions).toContain('Only these documents exist yet: project.md, flow.md.');
    expect(result.available).toBe(true);
  });

  it('is unavailable without a key, and asks the Jev nothing', async () => {
    const calls = evaluate.mock.calls.length;
    const validate = createJevValidator(cfg, async () => ({}));
    expect((await validate({ project: '', briefing: '', stack: '', flow: '', design: '' })).available).toBe(false);
    expect(evaluate.mock.calls.length).toBe(calls);
  });
});
