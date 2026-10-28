import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '../../server/refine/agreement.js';
import { askCapLines, askedRuns, capCounts } from '../../server/refine/ask-caps.js';

const q = (questionId: string, blocking: boolean) => ({ questionId, blocking });
const step = (command: string, questions: Array<{ questionId: string; blocking: boolean }>, itemKey = 'login'): JournalEvent => ({ type: 'PLANS_STEP_DONE', data: { command, itemKey, files: [], questions } });
const stage = (file: string, cycle: number, questions: Array<{ questionId: string; blocking: boolean }>): JournalEvent => ({ type: 'REFINE_STAGE_REVIEWED', data: { file, cycle, questions } });
const round = (cycle: number, questions: Array<{ questionId: string; blocking: boolean }>): JournalEvent => ({ type: 'REFINE_EVALUATED', data: { cycle, questions } });
const overCap = (events: JournalEvent[]) => capCounts(askedRuns(events)).map((c) => [c.scope, c.excess]);

describe('ask caps, measured in shadow', () => {
  it('counts the non-blocking questions of a specify run beyond its cap of three', () => {
    const events = [step('specify', [q('a', false), q('b', false), q('c', false), q('d', false)])];
    expect(overCap(events)).toEqual([['specify', 1]]);
  });

  it('caps a constitution at zero: any non-blocking question goes beyond it', () => {
    expect(overCap([step('constitution', [q('a', false)])])).toEqual([['constitution', 1]]);
  });

  it('never caps a blocking question, and counts only the non-blocking ones against the cap', () => {
    expect(overCap([step('specify', [q('a', true), q('b', true), q('c', false), q('d', false), q('e', false)])])).toEqual([['specify', 0]]);
  });

  it('counts a plan question once, on its first id, as the owner sees one card per id', () => {
    const events = [step('specify', [q('a', false)]), step('specify', [q('a', false), q('b', false)])];
    expect(askedRuns(events).map((r) => r.questions.map((x) => x.questionId))).toEqual([['a'], ['b']]);
  });

  it('caps a stage review at three per document and cycle, and a full round at five', () => {
    const events = [
      stage('project.md', 2, [q('s1', false), q('s2', false), q('s3', false), q('s4', false), q('s5', false)]),
      round(1, Array.from({ length: 7 }, (_, i) => q(`r${i}`, false))),
    ];
    expect(overCap(events)).toEqual([['stageReview', 2], ['round', 2]]);
  });

  it('ignores the preparation commands it does not cap', () => {
    expect(askedRuns([step('converge', [q('a', false)])])).toEqual([]);
  });

  it('prints one line per scope, and an empty journal gives zero runs without a throw', () => {
    const lines = askCapLines([]);
    expect(lines[0]).toContain('shadow, not enforced');
    expect(lines).toHaveLength(1 + 7);
    expect(lines.slice(1).every((l) => / runs +0 /.test(l))).toBe(true);
  });
});
