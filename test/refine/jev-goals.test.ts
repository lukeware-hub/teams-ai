import { describe, expect, it } from 'vitest';
import { reorganizePack } from '../../server/refine/packs.js';
import { jevGoals, type Readiness } from '../../server/refine/readiness.js';

const check = (complete: number, concrete: number, consistent: number, scoped: number) => ({ complete, concrete, consistent, scoped });
const readiness = (docs: Record<string, { score: number; checks: ReturnType<typeof check> }>): Readiness =>
  ({ available: true, model: 'm', average: 0.5, docs, usage: null, cycle: 1, outdated: false }) as unknown as Readiness;

describe('jevGoals', () => {
  it('lists only the checks below 80% for each document, with what the check needs', () => {
    const goals = jevGoals(readiness({
      'project.md': { score: 0.48, checks: check(0.19, 0.8, 0.64, 0.28) },
      'stack.md': { score: 0.9, checks: check(0.9, 0.9, 0.9, 0.9) },
    }));
    expect(goals).toEqual([
      '- project.md (48%): complete 19%, it must hold every part its purpose requires; consistent 64%, it must contain no two statements that contradict each other; scoped 28%, it must hold only what belongs in it; content that belongs in another document is moved there.',
    ]);
  });

  it('is empty before any score', () => {
    expect(jevGoals(undefined)).toEqual([]);
  });
});

describe('reorganizePack Jev goals', () => {
  const base = { specHash: 'h', principles: [], specId: 's', projectMd: '# P', briefMd: '# B', changed: ['project.md' as const] };

  it('puts the goals in the pack when there are any', () => {
    const pack = reorganizePack({ ...base, jevGoals: ['- project.md (48%): complete 19%, it must hold every part its purpose requires.'] });
    expect(pack.feedback).toContain('### Jev goals (checks below 80%)');
    expect(pack.feedback).toContain('JEV GOALS:');
  });

  it('adds no goal section when the Jev has no weak check', () => {
    expect(reorganizePack(base).feedback).not.toContain('### Jev goals');
  });
});
