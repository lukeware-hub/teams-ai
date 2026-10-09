import { describe, expect, it } from 'vitest';
import { RefineEvent } from '../../server/refine/events.js';
import { reduceRefineEvents } from '../../server/refine/state.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';

const item = (id: string, passed: boolean) => ({ id, role: id.startsWith('po') ? 'po' : 'sm', passed, detail: '' });
const allGreen = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions', 'sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'].map((id) => item(id, true));
const q = (questionId: string, blocking: boolean) => ({ questionId, role: 'po', text: 't', blocking, relatedAcIds: [], cycle: 1 });
const patch = (patchId: string) => ({ patchId, role: 'sm', file: 'brief.md', find: 'a', replace: 'b', reason: 'r', diff: '', cycle: 1 });
const derived = { project: makeProject(), spec: { ...makeSpec(), status: 'refining', specHash: null } };
const cycle = (n: number) => [{ type: RefineEvent.CycleStarted, data: { cycle: n, draftHash: 'h' } }, { type: RefineEvent.Derived, data: { cycle: n, ...derived } }];

describe('reduceRefineEvents', () => {
  it('evaluates into answering when questions or patches are pending', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.Created, data: { projectId: 'p', specId: 's', mode: 'new-project' } },
      ...cycle(1),
      { type: RefineEvent.PatchProposed, data: patch('sm-c1-0') },
      { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [q('po-c1-0', true)], discardedPatches: [] } },
    ]);
    expect(s.status).toBe('answering');
    expect(s.questions[0]).toMatchObject({ questionId: 'po-c1-0', status: 'pending' });
    expect(s.patches[0]).toMatchObject({ patchId: 'sm-c1-0', status: 'pending' });
  });
  it('is ready only with all green, no pending patch and no pending blocking question; a blocking question keeps answering', () => {
    const base = [...cycle(1), { type: RefineEvent.PatchProposed, data: patch('sm-c1-0') }, { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [q('po-c1-0', false)], discardedPatches: [] } }];
    expect(reduceRefineEvents(base).status).toBe('answering');
    const decided = reduceRefineEvents([...base, { type: RefineEvent.PatchRejected, data: { patchId: 'sm-c1-0', reason: null } }, { type: RefineEvent.QuestionSkipped, data: { questionId: 'po-c1-0' } }]);
    expect(decided).toMatchObject({ status: 'ready', stale: false });
    const blocking = reduceRefineEvents([...cycle(1), { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [q('po-c1-1', true)], discardedPatches: [] } }]);
    expect(blocking.status).toBe('answering');
    const accepted = reduceRefineEvents([...base, { type: RefineEvent.PatchAccepted, data: { patchId: 'sm-c1-0' } }]);
    expect(accepted.stale).toBe(true);
    const red = reduceRefineEvents([...cycle(1), { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [...allGreen.slice(0, 7), item('sm.no-open-questions', false)], questions: [], discardedPatches: [] } }]);
    expect(red.status).toBe('drafting');
  });
  it('reports a failed cycle, an interrupted cycle and a started run', () => {
    expect(reduceRefineEvents([...cycle(1), { type: RefineEvent.CycleFailed, data: { cycle: 1, reason: 'derive: spec.objectives: too small' } }])).toMatchObject({ status: 'error', error: 'derive: spec.objectives: too small' });
    expect(reduceRefineEvents(cycle(1)).status).toBe('evaluating');
    expect(reduceRefineEvents([{ type: RefineEvent.StartedRun, data: { runId: 's-r1' } }])).toMatchObject({ status: 'started', runId: 's-r1' });
  });
});

describe('backlog events', () => {
  const backlogItem = { key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S', rank: 1 };
  const derivedBacklog = { cycle: 1, project: makeProject(), epics: [{ key: 'core', title: 'Core' }], items: [backlogItem] };
  it('leaves a journal without backlog events with no backlog', () => {
    expect(reduceRefineEvents(cycle(1)).backlog).toBeNull();
  });
  it('enabling is idempotent and only makes an already evaluated session stale', () => {
    const fresh = reduceRefineEvents([{ type: RefineEvent.BacklogEnabled, data: {} }, { type: RefineEvent.BacklogEnabled, data: {} }]);
    expect(fresh.backlog).toMatchObject({ enabled: true, items: [], project: null });
    expect(fresh.stale).toBe(false);
    expect(fresh.backlog?.keyIds).toBeUndefined();
    expect(reduceRefineEvents([{ type: RefineEvent.BacklogEnabled, data: { keyIds: true } }]).backlog?.keyIds).toBe(true);
    // Re-enabling an older backlog never renames its specs.
    expect(reduceRefineEvents([{ type: RefineEvent.BacklogEnabled, data: {} }, { type: RefineEvent.BacklogEnabled, data: { keyIds: true } }]).backlog?.keyIds).toBeUndefined();
    const evaluated = reduceRefineEvents([...cycle(1), { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [], discardedPatches: [] } }, { type: RefineEvent.BacklogEnabled, data: {} }]);
    expect(evaluated).toMatchObject({ stale: true, status: 'ready' });
  });
  it('detailing: rows per item, the highest criterion number ever used, a merge that drops removed items, and ready only with full coverage', () => {
    const ac = (id: string) => ({ id, given: 'g', when: 'w', then: 't', smoke: false });
    const H = `sha256:${'1'.repeat(64)}`;
    const REV = `sha256:${'2'.repeat(64)}`;
    const spec = { ...makeSpec({ specId: 'p-001-base' }), acceptanceCriteria: [ac('AC-047')] };
    const preplan = { specId: 'p-001-base', specRev: REV, inputHash: H, modules: [{ name: 'm', purpose: 'p' }], tasks: [{ id: 'P1', title: 't', module: 'm', owner: 'dev', criteriaRefs: ['AC-047'], dependsOn: [] }], risks: [] };
    const evaluated = { type: RefineEvent.Evaluated, data: { cycle: 2, checklist: allGreen, questions: [], discardedPatches: [] } };
    const outline = [{ type: RefineEvent.BacklogEnabled, data: {} }, { type: RefineEvent.BacklogDerived, data: { ...derivedBacklog, flowHeadings: [], draftHash: 'h1' } }];
    const detailed = [
      ...outline,
      { type: RefineEvent.BacklogDetailEnabled, data: {} },
      { type: RefineEvent.CycleStarted, data: { cycle: 2, draftHash: 'h1' } },
      { type: RefineEvent.SpecDerived, data: { cycle: 2, key: 'base', specId: 'p-001-base', inputHash: H, rev: REV, spec, issues: [], highWater: 52 } },
    ];
    const waiting = reduceRefineEvents([...detailed, evaluated]);
    expect(waiting.backlog).toMatchObject({ detail: true, flowHeadings: [], draftHash: 'h1', acHighWater: 52, specs: { base: { specId: 'p-001-base', rev: REV } } });
    expect(waiting.status).toBe('drafting');
    const ready = reduceRefineEvents([...detailed, { type: RefineEvent.PreplanDerived, data: { cycle: 2, key: 'base', inputHash: H, specRev: REV, preplan, issues: [] } }, evaluated]);
    expect(ready.status).toBe('ready');
    expect(ready.backlog?.preplans?.base?.preplan?.tasks[0]?.id).toBe('P1');
    const reshaped = reduceRefineEvents([...detailed, { type: RefineEvent.BacklogDerived, data: { ...derivedBacklog, cycle: 3, items: [{ ...backlogItem, key: 'outro' }], flowHeadings: [], draftHash: 'h2' } }]);
    expect(reshaped.backlog?.specs).toEqual({});
    expect(reshaped.backlog).toMatchObject({ detail: true, acHighWater: 52, draftHash: 'h2' });
  });

  it('starts the criterion numbering at the floor recorded when backlog mode was turned on', () => {
    const s = reduceRefineEvents([{ type: RefineEvent.BacklogEnabled, data: { acFloor: 40 } }, { type: RefineEvent.BacklogDerived, data: derivedBacklog }]);
    expect(s.backlog?.acHighWater).toBe(40);
  });

  it('a doc edit or an accepted patch makes a derived backlog stale', () => {
    const outline = [{ type: RefineEvent.BacklogEnabled, data: {} }, { type: RefineEvent.BacklogDerived, data: derivedBacklog }, { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [], discardedPatches: [] } }];
    expect(reduceRefineEvents(outline).stale).toBe(false);
    expect(reduceRefineEvents([...outline, { type: RefineEvent.DocEdited, data: { file: 'flow.md', hash: 'x', source: 'human' } }]).stale).toBe(true);
    expect(reduceRefineEvents([...outline, { type: RefineEvent.PatchProposed, data: patch('po-c1-0') }, { type: RefineEvent.PatchAccepted, data: { patchId: 'po-c1-0' } }]).stale).toBe(true);
  });

  it('keeps the derived backlog and clears staleness when the cycle is evaluated', () => {
    const s = reduceRefineEvents([{ type: RefineEvent.BacklogEnabled, data: {} }, { type: RefineEvent.CycleStarted, data: { cycle: 1, draftHash: 'h' } }, { type: RefineEvent.BacklogDerived, data: derivedBacklog }, { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [], discardedPatches: [] } }]);
    expect(s.backlog).toMatchObject({ enabled: true, cycle: 1, epics: [{ key: 'core' }], items: [{ key: 'base', rank: 1 }] });
    expect(s.stale).toBe(false);
    expect(s.status).toBe('ready');
  });
});

describe('session mode', () => {
  it('keeps the mode the session was created in', () => {
    expect(reduceRefineEvents([]).mode).toBeNull();
    expect(reduceRefineEvents([{ type: RefineEvent.Created, data: { projectId: 'p', specId: 's', mode: 'new-spec' } }]).mode).toBe('new-spec');
  });
});
