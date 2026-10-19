import { describe, expect, it } from 'vitest';
import { stuckQuestion } from '../../server/refine/cycle.js';
import type { ChecklistItem } from '../../server/refine/checklist.js';
import { nextStuck, STUCK_ROUNDS } from '../../server/refine/state.js';

const check = (id: string, passed: boolean) => ({ id: id as ChecklistItem['id'], role: id.startsWith('po') ? ('po' as const) : ('sm' as const), passed, detail: `${id} detail` });

describe('nextStuck', () => {
  it('counts rounds in a row with the same checks failing, and asks at the limit', () => {
    const failing = [check('po.no-contradictions', false), check('po.personas', true)];
    let run = nextStuck(undefined, failing).run;
    expect(run).toEqual({ key: 'po.no-contradictions', count: 1 });
    run = nextStuck(run, failing).run;
    expect(run.count).toBe(2);
    const third = nextStuck(run, failing);
    expect(third.ask).toBe(true);
    expect(third.run).toEqual({ key: 'po.no-contradictions', count: 0 });
  });

  it('starts over when the failing checks change or everything passes', () => {
    const first = nextStuck(undefined, [check('po.personas', false)]).run;
    expect(nextStuck(first, [check('sm.tasks-feasible', false)]).run).toEqual({ key: 'sm.tasks-feasible', count: 1 });
    expect(nextStuck(first, [check('po.personas', true)]).run).toEqual({ key: '', count: 0 });
    expect(STUCK_ROUNDS).toBe(3);
  });
});

describe('stuckQuestion', () => {
  it('is one blocking question for the human that names the checks and their detail', () => {
    const q = stuckQuestion([check('po.no-contradictions', false)], 27);
    expect(q).toMatchObject({ questionId: 'stuck-c27', role: 'po', blocking: true, relatedAcIds: [], cycle: 27, rule: 'stuck:po.no-contradictions' });
    expect(q.text).toContain('po.no-contradictions');
    expect(q.text).toContain('po.no-contradictions detail');
  });
});
