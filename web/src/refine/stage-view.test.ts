import { describe, expect, it } from 'vitest';
import { currentStage, previousStage, stageViews } from './stage-view.js';

describe('stage views', () => {
  it('marks the stages the owner moved on from as done, the first one not done as current, and the rest as todo', () => {
    const views = stageViews({ doneStages: ['flow.md', 'project.md'] });
    expect(views.map((v) => [v.doc, v.state])).toEqual([
      ['flow.md', 'done'],
      ['project.md', 'done'],
      ['briefing.md', 'current'],
      ['stack.md', 'todo'],
      ['design.md', 'todo'],
    ]);
  });

  it('holds the score and the outdated mark of each document, and none when there is no score', () => {
    const views = stageViews({ doneStages: ['flow.md'], readiness: { docs: { 'flow.md': { score: 0.8 } } }, graphed: [] });
    expect(views[0]).toMatchObject({ doc: 'flow.md', score: 0.8, outdated: true });
    expect(views[1]).toMatchObject({ doc: 'project.md', score: null, outdated: false });
  });

  it('has no score when there is no readiness record, and no outdated mark when none is listed', () => {
    expect(stageViews({ readiness: null })[0]).toMatchObject({ score: null, outdated: false });
    expect(stageViews({})[0]).toMatchObject({ score: null, outdated: false });
  });

  it('has no current stage once every stage is done', () => {
    const all = ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'];
    expect(currentStage({ doneStages: all })).toBeNull();
    expect(currentStage({ doneStages: ['flow.md'] })).toBe('project.md');
    expect(currentStage({})).toBe('flow.md');
  });

  it('a document’s previous stage is the one before it, and the first document has none', () => {
    expect(previousStage('flow.md')).toBeNull();
    expect(previousStage('project.md')).toBe('flow.md');
    expect(previousStage('design.md')).toBe('stack.md');
  });
});
