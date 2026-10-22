import { describe, expect, it } from 'vitest';
import { RefineEvent } from '../../server/refine/events.js';
import { reduceRefineEvents } from '../../server/refine/state.js';

const created = { type: RefineEvent.Created, data: { projectId: 'shop', specId: 'shop-002', mode: 'new-project', stages: true } };
const advanced = (doc: string) => ({ type: RefineEvent.StageAdvanced, data: { doc, cycle: 0 } });
const edited = (file: string) => ({ type: RefineEvent.DocEdited, data: { file, source: 'main', hash: 'h' } });
const reviewed = (file: string, divergences: string[]) => ({ type: RefineEvent.StageReviewed, data: { cycle: 1, file, questions: [], divergences } });

describe('stage alignment and stale stages', () => {
  it('a stage review records what it found against the documents before it, and an empty list is aligned', () => {
    expect(reduceRefineEvents([created, reviewed('project.md', ['o prazo diverge do fluxo'])]).stageAlignment).toEqual({ 'project.md': ['o prazo diverge do fluxo'] });
    expect(reduceRefineEvents([created, reviewed('project.md', [])]).stageAlignment).toEqual({ 'project.md': [] });
  });

  it('editing a document marks the later stages that are done, and a new review of such a stage clears its mark', () => {
    expect(reduceRefineEvents([created, advanced('flow.md'), advanced('project.md'), edited('flow.md')]).staleBy).toEqual({ 'project.md': 'flow.md' });
    expect(reduceRefineEvents([created, advanced('flow.md'), advanced('project.md'), edited('flow.md'), reviewed('project.md', [])]).staleBy).toEqual({});
  });

  it('editing the current stage, a stage not done yet, or a file that is not a stage marks nothing', () => {
    expect(reduceRefineEvents([created, advanced('flow.md'), edited('project.md')]).staleBy).toBeUndefined();
    expect(reduceRefineEvents([created, advanced('flow.md'), edited('design.md')]).staleBy).toBeUndefined();
    expect(reduceRefineEvents([created, advanced('flow.md'), edited('spec.json')]).staleBy).toBeUndefined();
  });

  it('replays a journal from before the briefing rename and a score without per-document files', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.Created, data: { projectId: 'shop', specId: 'shop-002', mode: 'new-project' } },
      { type: RefineEvent.DocsScored, data: { cycle: 1, available: true, model: 'jev', average: 0.6, docs: { 'brief.md': { score: 0.6, checks: { complete: 0.6, concrete: 0.6, consistent: 0.6, scoped: 0.6 } } }, usage: null } },
      { type: RefineEvent.PatchProposed, data: { patchId: 'sm-c1-0', role: 'sm', file: 'brief.md', find: 'a', replace: 'b', reason: 'r', diff: '', cycle: 1 } },
    ]);
    expect(s.readiness?.docs).toEqual({ 'briefing.md': expect.objectContaining({ score: 0.6 }) });
    expect(s.patches[0]).toMatchObject({ file: 'briefing.md', status: 'pending' });
  });
});
