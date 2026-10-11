import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { createJevValidator, summarizeJevChecks } from '../../server/refine/jev-validation.js';

describe('Jev refinement validation', () => {
  it('approves only when every independent check clears the threshold', () => {
    const result = summarizeJevChecks({ flow: 0.91, validation: 0.84, persistence: 0.88 }, 'typesafe/jev-1.13');
    expect(result).toMatchObject({ available: true, decision: 'approved', consistent: true, confidence: 0.84 });
  });

  it('routes an uncertain result to review and a clear contradiction to blocked', () => {
    expect(summarizeJevChecks({ flow: 0.72, validation: 0.86 }, 'jev').decision).toBe('review');
    expect(summarizeJevChecks({ flow: 0.49, validation: 0.95 }, 'jev').decision).toBe('blocked');
  });

  it('sends independent Noul checks with explicit criteria in one request', async () => {
    const originalFetch = globalThis.fetch;
    let request: { questions: Record<string, unknown>; state: string } | null = null;
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state: string };
      request = body;
      const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.9 }]));
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 6 } }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await createJevValidator(loadConfig({}), async () => ({ OPENROUTER_API_KEY: 'secret-key' }))({ project: 'P', briefing: 'B', stack: 'S', flow: 'F', design: 'D' });
      expect(result.decision).toBe('approved');
      expect(Object.keys(request!.questions)).toHaveLength(6);
      expect((request!.questions.documents_consistent as { criteria: { true: string; false: string } }).criteria.true).toContain('All five');
      expect(request!.state).toContain('design.md:\nD');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
