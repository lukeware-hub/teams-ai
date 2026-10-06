import { describe, expect, it } from 'vitest';
import { buildContextPack, type ContextPackInput } from '../../server/knowledge/context-pack.js';
import { fitPackBudget, PackTooLargeError, PACK_TOKEN_CAP } from '../../server/refine/fit-pack.js';

const pack = (feedback: string, budgetTokens = 20_000): ContextPackInput => ({
  kind: 'derive',
  role: 'po',
  specHash: 'a'.repeat(64),
  principles: ['p'],
  outputContract: 'contract',
  criteria: [],
  feedback,
  budgetTokens,
});

describe('fitPackBudget', () => {
  it('shows the defect it fixes: over budget, the unfitted pack drops all the docs', () => {
    const built = buildContextPack(pack('x'.repeat(100_000)));
    expect(built.dropped).toContain('feedback');
  });

  it('keeps the docs when the pack is bigger than the default budget', () => {
    const built = buildContextPack(fitPackBudget(pack('x'.repeat(100_000))));
    expect(built.dropped).toEqual([]);
    expect(built.sections).toContain('feedback');
  });

  it('keeps the original budget for a small pack', () => {
    expect(fitPackBudget(pack('small', 20_000)).budgetTokens).toBe(20_000);
  });

  it('refuses a pack above the cap, naming the size and the limit in pt-BR', () => {
    const huge = 'x'.repeat(PACK_TOKEN_CAP * 4 + 4_000);
    expect(() => fitPackBudget(pack(huge))).toThrow(PackTooLargeError);
    expect(() => fitPackBudget(pack(huge))).toThrow(/grandes demais/);
  });
});
