import { describe, expect, it } from 'vitest';
import { stageViews } from './stage-view.js';

describe('stageViews outdated marks', () => {
  it('a stage is outdated when its own document changed, or when an earlier document changed after the stage was done', () => {
    const views = stageViews({ doneStages: ['flow.md', 'project.md'], graphed: [], staleBy: { 'project.md': 'flow.md' } });
    expect(views.map((v) => v.outdated)).toEqual([true, true, false, false, false]);
  });
});
