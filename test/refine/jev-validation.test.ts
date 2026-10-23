import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { createJevValidator, splitWindows, summarizeJevChecks } from '../../server/refine/jev-validation.js';

describe('Jev refinement validation', () => {
  it('reports the lowest check as confidence, with no verdict of its own', () => {
    const result = summarizeJevChecks({ flow: 0.91, validation: 0.84, persistence: 0.88 }, 'typesafe/jev-1.13');
    expect(result).toMatchObject({ available: true, confidence: 0.84, checks: { flow: 0.91, validation: 0.84, persistence: 0.88 } });
    expect(result).not.toHaveProperty('decision');
  });

  it('keeps every check as it is, with no verdict at any level', () => {
    expect(summarizeJevChecks({ flow: 0.72, validation: 0.86 }, 'jev')).not.toHaveProperty('decision');
    expect(summarizeJevChecks({ flow: 0.49, validation: 0.95 }, 'jev')).not.toHaveProperty('decision');
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
      expect(result).not.toHaveProperty('decision');
      expect(Object.keys(request!.questions)).toHaveLength(6);
      expect((request!.questions.documents_consistent as { criteria: { true: string; false: string } }).criteria.true).toContain('All five');
      expect(request!.state).toContain('design.md:\nD');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('splits documents too big for one request into windows that lose no text', () => {
    const docs = { project: 'P', briefing: 'B', stack: 'line\n'.repeat(400), flow: 'F'.repeat(900), design: 'D' };
    const windows = splitWindows(docs, 1000);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((w) => w.length <= 1000)).toBe(true);
    expect(windows[1]).toContain('stack.md (continued):');
    expect(windows.join('').match(/line/g)).toHaveLength(400);
    expect(windows.join('').match(/F/g)).toHaveLength(900);
  });

  it('keeps one window when the documents fit', () => {
    expect(splitWindows({ project: 'P', briefing: 'B', stack: 'S', flow: 'F', design: 'D' }, 1000)).toHaveLength(1);
  });

  it('asks once per window and takes the weakest consistency score and the best score of each topic check', async () => {
    const originalFetch = globalThis.fetch;
    const states: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state: string };
      states.push(body.state);
      const noul = states.length === 1 ? 0.3 : 0.9;
      const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul }]));
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 6 } }), { status: 200 });
    }) as typeof fetch;
    try {
      const big = 'x'.repeat(40_000);
      const result = await createJevValidator(loadConfig({}), async () => ({ OPENROUTER_API_KEY: 'secret-key' }))({ project: 'P', briefing: 'B', stack: big, flow: 'F', design: 'D' });
      expect(states).toHaveLength(2);
      expect(result).toMatchObject({ stateTruncated: false });
      expect(result.checks).toMatchObject({ documents_consistent: 0.3, flow_covers_scope: 0.9, health_aligned: 0.9 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
