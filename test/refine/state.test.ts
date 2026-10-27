import { describe, expect, it } from 'vitest';
import { approvalPatch } from '../../server/refine/adjustments.js';
import { RefineEvent } from '../../server/refine/events.js';
import { canStart, reduceRefineEvents, speckitPending } from '../../server/refine/state.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';

const item = (id: string, passed: boolean) => ({ id, role: id.startsWith('po') ? 'po' : 'sm', passed, detail: '' });
const allGreen = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'].map((id) => item(id, true));
const q = (questionId: string, blocking: boolean) => ({ questionId, role: 'po', text: 't', blocking, relatedAcIds: [], cycle: 1 });
const patch = (patchId: string) => ({ patchId, role: 'sm', file: 'briefing.md', find: 'a', replace: 'b', reason: 'r', diff: '', cycle: 1 });
const derived = { project: makeProject(), spec: { ...makeSpec(), status: 'refining', specHash: null } };
const cycle = (n: number) => [{ type: RefineEvent.CycleStarted, data: { cycle: n, draftHash: 'h' } }, { type: RefineEvent.Derived, data: { cycle: n, ...derived } }];

describe('confidentiality answer and document stages', () => {
  it('a session created with the document stages is marked; an older one is not', () => {
    expect(reduceRefineEvents([{ type: RefineEvent.Created, data: { mode: 'new-project', stages: true } }]).stages).toBe(true);
    expect(reduceRefineEvents([{ type: RefineEvent.Created, data: { mode: 'new-project' } }]).stages).toBe(false);
    expect(reduceRefineEvents([{ type: RefineEvent.Created, data: {} }]).mode).toBeNull();
  });

  it('the owner answer on confidentiality is kept; without an answer it stays undefined', () => {
    expect(reduceRefineEvents([]).confidential).toBeUndefined();
    expect(reduceRefineEvents([{ type: RefineEvent.ConfidentialityAnswered, data: { confidential: true } }]).confidential).toBe(true);
    expect(reduceRefineEvents([{ type: RefineEvent.ConfidentialityAnswered, data: { confidential: false } }]).confidential).toBe(false);
  });
});

describe('reduceRefineEvents reshapes', () => {
  it('folds a reshape into the list with its status, and an undo marks it undone', () => {
    const row = { reshapeId: 'reshape-c1', file: 'briefing.md', cycle: 1, role: 'po', afterHash: 'h' };
    const s = reduceRefineEvents([{ type: RefineEvent.DocReshaped, data: row }, { type: RefineEvent.DocReshapeUndone, data: { reshapeId: 'reshape-c1' } }]);
    expect(s.reshapes).toEqual([{ ...row, status: 'undone' }]);
  });

  // Before the id named the document, every reshape of one cycle had the same id.
  const project = { reshapeId: 'reshape-c36', file: 'project.md', cycle: 36, role: 'po', afterHash: 'p' };
  const briefing = { ...project, file: 'briefing.md', afterHash: 'b' };
  const shared = [{ type: RefineEvent.DocReshaped, data: project }, { type: RefineEvent.DocReshaped, data: briefing }];

  it('a close of an id two reshapes share closes the newest, so the notice the page shows goes away', () => {
    const s = reduceRefineEvents([...shared, { type: RefineEvent.NoticeClosed, data: { noticeId: 'reshape-c36' } }]);
    expect(s.reshapes).toEqual([{ ...project, status: 'applied' }, { ...briefing, status: 'applied', closed: true }]);
    // The page shows the newest applied reshape, and only while it is not closed.
    expect([...s.reshapes].reverse().find((r) => r.status === 'applied')).toMatchObject({ file: 'briefing.md', closed: true });
  });

  it('an undo of an id two reshapes share marks the newest', () => {
    const s = reduceRefineEvents([...shared, { type: RefineEvent.DocReshapeUndone, data: { reshapeId: 'reshape-c36' } }]);
    expect(s.reshapes).toEqual([{ ...project, status: 'applied' }, { ...briefing, status: 'undone' }]);
  });
});

describe('reduceRefineEvents moves and findings', () => {
  it('folds a move into the list with its status, and an undo marks it undone', () => {
    const row = { moveId: 'move-po-c1-0', role: 'po', cycle: 1, from: 'project.md', to: 'flow.md', reason: 'r', quote: 'q', text: 't', removedAt: 0, removed: 'q\n', insertAt: 3, inserted: '\nt\n', fromHash: 'a', toHash: 'b' };
    const s = reduceRefineEvents([{ type: RefineEvent.DocMoved, data: row }, { type: RefineEvent.DocMoveUndone, data: { moveId: 'move-po-c1-0' } }]);
    expect(s.moves).toEqual([{ ...row, status: 'undone' }]);
  });

  it('a close hides the notice of a move or a reshape, and the change stays applied', () => {
    const move = { moveId: 'move-po-c1-0', role: 'po', cycle: 1, from: 'project.md', to: 'flow.md', reason: 'r', quote: 'q', text: 't', removedAt: 0, removed: 'q\n', insertAt: 3, inserted: '\nt\n', fromHash: 'a', toHash: 'b' };
    const reshape = { reshapeId: 'reshape-c1', file: 'briefing.md', cycle: 1, role: 'po', afterHash: 'h' };
    const s = reduceRefineEvents([
      { type: RefineEvent.DocMoved, data: move },
      { type: RefineEvent.DocReshaped, data: reshape },
      { type: RefineEvent.NoticeClosed, data: { noticeId: 'move-po-c1-0' } },
      { type: RefineEvent.NoticeClosed, data: { noticeId: 'reshape-c1' } },
    ]);
    expect(s.moves).toEqual([{ ...move, status: 'applied', closed: true }]);
    expect(s.reshapes).toEqual([{ ...reshape, status: 'applied', closed: true }]);
  });

  it('replaces the findings with those of each cycle, so a cycle without findings clears the list', () => {
    const finding = { cycle: 1, role: 'sm', doc: 'flow.md', severity: 'advice', quote: 'q', text: 't', fix: 'f' };
    const kept = reduceRefineEvents([{ type: RefineEvent.FindingsReported, data: { cycle: 1, findings: [finding] } }]);
    expect(kept.findings).toEqual([finding]);
    expect(reduceRefineEvents([{ type: RefineEvent.FindingsReported, data: { cycle: 1, findings: [finding] } }, { type: RefineEvent.FindingsReported, data: { cycle: 2, findings: [] } }]).findings).toEqual([]);
  });
});

describe('reduceRefineEvents', () => {
  it('a stage review adds its questions and leaves the checklist and the stuck count of the last full round alone', () => {
    const red = [...cycle(1), { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [...allGreen.slice(0, 7), item('sm.no-open-questions', false)], questions: [], discardedPatches: [] } }];
    const before = reduceRefineEvents(red);
    const after = reduceRefineEvents([...red, { type: RefineEvent.StageReviewed, data: { cycle: 2, file: 'project.md', questions: [q('po-s2-0', true)], divergences: [], discardedPatches: [] } }]);
    expect(after.checklist).toEqual(before.checklist);
    expect(after.stuck).toEqual(before.stuck);
    expect(after.questions).toEqual([expect.objectContaining({ questionId: 'po-s2-0', status: 'pending' })]);
  });

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
  // R11.10 (plan 89): once every checklist item is green, a reviewer's pending patch is a suggestion that holds nothing back.
  it('is ready with all green and no pending blocking question, a reviewer patch still pending; a blocking question keeps answering', () => {
    const base = [...cycle(1), { type: RefineEvent.PatchProposed, data: patch('sm-c1-0') }, { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [q('po-c1-0', false)], discardedPatches: [] } }];
    expect(reduceRefineEvents(base).status).toBe('ready');
    const decided = reduceRefineEvents([...base, { type: RefineEvent.PatchRejected, data: { patchId: 'sm-c1-0', reason: null } }, { type: RefineEvent.QuestionSkipped, data: { questionId: 'po-c1-0' } }]);
    expect(decided).toMatchObject({ status: 'ready', stale: false });
    const blocking = reduceRefineEvents([...cycle(1), { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [q('po-c1-1', true)], discardedPatches: [] } }]);
    expect(blocking.status).toBe('answering');
    const accepted = reduceRefineEvents([...base, { type: RefineEvent.PatchAccepted, data: { patchId: 'sm-c1-0' } }]);
    expect(accepted.stale).toBe(true);
    const red = reduceRefineEvents([...cycle(1), { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [...allGreen.slice(0, 7), item('sm.no-open-questions', false)], questions: [], discardedPatches: [] } }]);
    expect(red.status).toBe('drafting');
    // A failing item keeps a pending patch holding the session back.
    const redWithPatch = reduceRefineEvents([...cycle(1), { type: RefineEvent.PatchProposed, data: patch('sm-c1-0') }, { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [...allGreen.slice(0, 7), item('sm.no-open-questions', false)], questions: [], discardedPatches: [] } }]);
    expect(redWithPatch.status).toBe('answering');
    // An adjustment's approval is the owner's decision, never a suggestion.
    const approval = { ...patch('po-c1-0'), role: 'po', ...approvalPatch({ key: 'caso-ajuste-1', specId: 'big-001-caso', status: 'done', changed: ['flow.md › 1. Caso'] }) };
    const waiting = reduceRefineEvents([...cycle(1), { type: RefineEvent.PatchProposed, data: approval }, { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [], discardedPatches: [] } }]);
    expect(waiting.status).toBe('answering');
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
  // Plan 89 review: a suggestion is nothing the owner owes, so a green backlog waiting for its detailing reads drafting.
  it('reads a green backlog waiting for its detailing as drafting, a reviewer patch still pending', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.BacklogEnabled, data: {} },
      { type: RefineEvent.CycleStarted, data: { cycle: 1, draftHash: 'h' } },
      { type: RefineEvent.BacklogDerived, data: derivedBacklog },
      { type: RefineEvent.PatchProposed, data: patch('po-c1-0') },
      { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [], discardedPatches: [] } },
      { type: RefineEvent.BacklogDetailEnabled, data: {} },
    ]);
    expect(s.status).toBe('drafting');
  });
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

describe('answers a role gave from the docs', () => {
  it('keeps who answered a question when a role answered it from the docs', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [], questions: [{ questionId: 'po-c1-0', role: 'po', text: 'Port?', blocking: true, relatedAcIds: [], cycle: 1 }], discardedPatches: [] } },
      { type: RefineEvent.QuestionAnswered, data: { questionId: 'po-c1-0', text: '8080', by: 'po' } },
    ]);
    expect(s.questions[0]).toMatchObject({ status: 'answered', answer: '8080', answeredBy: 'po' });
  });
});

describe('staleness of an evaluation', () => {
  const evaluated = (n: number) => ({ type: RefineEvent.Evaluated, data: { cycle: n, checklist: allGreen, questions: [], discardedPatches: [] } });
  const edit = (file: string, source: string) => ({ type: RefineEvent.DocEdited, data: { file, hash: 'x', source } });
  it('stays stale when a doc was edited while the cycle ran, and clears when nothing changed', () => {
    expect(reduceRefineEvents([...cycle(1), evaluated(1)]).stale).toBe(false);
    expect(reduceRefineEvents([...cycle(1), edit('stack.md', 'autofill'), evaluated(1)])).toMatchObject({ stale: true, status: 'ready' });
    // An edit before the first derivation of the session still makes it stale.
    const early = [{ type: RefineEvent.CycleStarted, data: { cycle: 1, draftHash: 'h' } }, edit('briefing.md', 'decision'), { type: RefineEvent.Derived, data: { cycle: 1, ...derived } }, evaluated(1)];
    expect(reduceRefineEvents(early).stale).toBe(true);
    // The next cycle without edits clears it.
    expect(reduceRefineEvents([...cycle(1), edit('stack.md', 'autofill'), evaluated(1), ...cycle(2), evaluated(2)]).stale).toBe(false);
  });
});

describe('reduceRefineEvents document score', () => {
  const score = (cycle: number, average: number) => ({ type: RefineEvent.DocsScored, data: { cycle, available: true, model: 'jev-1.13.0', average, docs: null, usage: null } });
  const docEdit = { type: RefineEvent.DocEdited, data: { file: 'flow.md', hash: 'x', source: 'human' } };

  it('has no score until one is journaled, and a document change before any score leaves none', () => {
    expect(reduceRefineEvents([]).readiness).toBeUndefined();
    expect(reduceRefineEvents([docEdit]).readiness).toBeUndefined();
  });

  it('keeps the latest score with the cycle that journaled it, current until a document changes', () => {
    expect(reduceRefineEvents([score(1, 0.7), score(2, 0.85)]).readiness).toMatchObject({ cycle: 2, available: true, average: 0.85, outdated: false });
  });

  it('marks the score outdated when a document changes, and the next score clears the mark', () => {
    expect(reduceRefineEvents([score(1, 0.85), docEdit]).readiness).toMatchObject({ average: 0.85, outdated: true });
    expect(reduceRefineEvents([score(1, 0.85), docEdit, score(2, 0.9)]).readiness).toMatchObject({ average: 0.9, outdated: false });
  });

  it('keeps a confidential project as skipped, with no average', () => {
    const skipped = { type: RefineEvent.DocsScored, data: { cycle: 1, available: false, model: null, average: null, docs: null, usage: null, skipped: 'confidential' } };
    expect(reduceRefineEvents([skipped]).readiness).toMatchObject({ skipped: 'confidential', available: false, average: null });
  });

  it('keeps the doubts of each document with its score, and a score journaled before doubts has none', () => {
    const doubt = { check: 'consistent', value: 0.2, part: { index: 2, of: 2, from: '## Meio', to: null } };
    const withDoubts = { type: RefineEvent.DocsScored, data: { cycle: 1, files: ['flow.md'], available: true, model: 'jev', average: 0.5, usage: null, docs: { 'flow.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.5, consistent: 0.2, scoped: 0.5 }, doubts: [doubt] } } } };
    const before = { type: RefineEvent.DocsScored, data: { cycle: 1, files: ['flow.md'], available: true, model: 'jev', average: 0.5, usage: null, docs: { 'flow.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.5, consistent: 0.2, scoped: 0.5 } } } } };
    expect(reduceRefineEvents([withDoubts]).readiness!.docs!['flow.md']!.doubts).toEqual([doubt]);
    expect(reduceRefineEvents([before]).readiness!.docs!['flow.md']!.doubts).toBeUndefined();
  });
});

describe('reduceRefineEvents legacy brief.md', () => {
  it('reads a journal written before the rename: its score, patch and move name the briefing briefing.md', () => {
    const score = { available: true, model: 'm', average: 0.5, docs: { 'brief.md': { score: 0.5, checks: { complete: 1, concrete: 0, consistent: 0, scoped: 0 } } }, usage: null, cycle: 1 };
    const s = reduceRefineEvents([
      { type: RefineEvent.DocsScored, data: score },
      { type: RefineEvent.PatchProposed, data: { patchId: 'po-c1-0', role: 'po', file: 'brief.md', find: 'a', replace: 'b', reason: 'r', diff: '', cycle: 1 } },
      { type: RefineEvent.DocMoved, data: { moveId: 'm1', role: 'po', cycle: 1, from: 'brief.md', to: 'stack.md', quote: 'q', text: 't', after: null, reason: 'r' } },
    ]);
    expect(Object.keys(s.readiness!.docs!)).toEqual(['briefing.md']);
    expect(s.patches[0]!.file).toBe('briefing.md');
    expect(s.moves[0]).toMatchObject({ from: 'briefing.md', to: 'stack.md' });
  });

  it('normalizes the reorganized hashes and the discarded patches of a legacy journal too', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.DocsReorganized, data: { hashes: { 'brief.md': 'h1' } } },
      { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [], questions: [], discardedPatches: [{ role: 'po', file: 'brief.md', reason: 'stale' }], unverifiedContradictions: [] } },
    ]);
    expect(s.reorganized).toEqual({ 'briefing.md': 'h1' });
    expect(s.discarded[0]).toMatchObject({ file: 'briefing.md' });
  });
});

describe('reduceRefineEvents passed stages', () => {
  it('records the documents whose passed text is kept, once each, with the legacy name read as the briefing', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.StagePassed, data: { file: 'project.md', hash: 'h1' } },
      { type: RefineEvent.StagePassed, data: { file: 'project.md', hash: 'h2' } },
      { type: RefineEvent.StagePassed, data: { file: 'brief.md', hash: 'h3' } },
    ]);
    expect(s.passedStages).toEqual(['project.md', 'briefing.md']);
  });
});

describe('reduceRefineEvents stage questions', () => {
  const question = (questionId: string, text: string) => ({ questionId, role: 'po', text, blocking: false, relatedAcIds: [], cycle: 1, options: [] });

  it('stamps each question of a stage review with its document', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.StageReviewed, data: { cycle: 1, file: 'project.md', questions: [question('po-s1-0', 'Quem usa?')], divergences: [], discardedPatches: [] } },
    ]);
    expect(s.questions).toEqual([expect.objectContaining({ questionId: 'po-s1-0', file: 'project.md' })]);
  });

  it('names a legacy brief.md question as the briefing', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.StageReviewed, data: { cycle: 1, file: 'brief.md', questions: [question('po-s1-0', 'Qual o prazo?')], divergences: [], discardedPatches: [] } },
    ]);
    expect(s.questions[0]!.file).toBe('briefing.md');
  });

  it('leaves a question of a full round unfiled, as a general question', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [], questions: [question('po-c1-0', 'Quem aprova?')], discardedPatches: [], unverifiedContradictions: [] } },
    ]);
    expect(s.questions[0]).not.toHaveProperty('file');
  });
});

describe('reduceRefineEvents findings of a stage', () => {
  const finding = (doc: string, text: string) => ({ cycle: 1, role: 'po', doc, severity: 'advice', quote: 'q', text, fix: 'f' });

  it('a review replaces the findings of the documents it names, and keeps the findings of the others', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.FindingsReported, data: { cycle: 1, findings: [finding('project.md', 'do projeto'), finding('stack.md', 'da pilha')] } },
      { type: RefineEvent.FindingsReported, data: { cycle: 2, files: ['flow.md'], findings: [finding('flow.md', 'do fluxo')] } },
    ]);
    expect(s.findings.map((f) => f.text).sort()).toEqual(['da pilha', 'do fluxo', 'do projeto']);
  });

  it('a review without a list of documents replaces all the findings, as a full round does', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.FindingsReported, data: { cycle: 1, findings: [finding('project.md', 'do projeto')] } },
      { type: RefineEvent.FindingsReported, data: { cycle: 2, findings: [finding('stack.md', 'da pilha')] } },
    ]);
    expect(s.findings.map((f) => f.text)).toEqual(['da pilha']);
  });
});

describe('document scores per document', () => {
  const docScore = (score: number) => ({ score, checks: { complete: score, concrete: score, consistent: score, scoped: score } });
  const scoredDocs = (docs: Record<string, number>, files?: string[]) => ({
    type: RefineEvent.DocsScored,
    data: { cycle: 1, ...(files ? { files } : {}), available: true, model: 'jev-1.13.0', usage: null, average: null, docs: Object.fromEntries(Object.entries(docs).map(([file, score]) => [file, docScore(score)])) },
  });
  const edited = (file: string) => ({ type: RefineEvent.DocEdited, data: { file, hash: 'h', source: 'human' } });

  it('a partial score keeps the scores of the other documents and averages the ones it holds', () => {
    const s = reduceRefineEvents([scoredDocs({ 'flow.md': 0.5, 'project.md': 0.9 }, ['flow.md', 'project.md']), scoredDocs({ 'stack.md': 0.7 }, ['stack.md'])]);
    expect(Object.keys(s.readiness!.docs!).sort()).toEqual(['flow.md', 'project.md', 'stack.md']);
    expect(s.readiness!.average).toBeCloseTo((0.5 + 0.9 + 0.7) / 3);
  });

  it('a failed score keeps the scores of the other documents, and leaves the edited document outdated', () => {
    const failed = { type: RefineEvent.DocsScored, data: { cycle: 2, files: ['stack.md'], available: false, model: null, average: null, docs: null, usage: null } };
    const s = reduceRefineEvents([scoredDocs({ 'flow.md': 0.5, 'stack.md': 0.7 }, ['flow.md', 'stack.md']), edited('stack.md'), failed]);
    expect(Object.keys(s.readiness!.docs!).sort()).toEqual(['flow.md', 'stack.md']);
    expect(s.outdatedDocs).toEqual(['stack.md']);
    expect(s.readiness).toMatchObject({ available: false, average: null, outdated: true });
  });

  it('an edit marks only that document outdated, and its own score clears the mark', () => {
    const before = [scoredDocs({ 'flow.md': 0.5, 'stack.md': 0.7 }, ['flow.md', 'stack.md']), edited('stack.md')];
    const outdated = reduceRefineEvents(before);
    expect(outdated.outdatedDocs).toEqual(['stack.md']);
    expect(outdated.readiness!.outdated).toBe(true);
    const rescored = reduceRefineEvents([...before, scoredDocs({ 'stack.md': 0.8 }, ['stack.md'])]);
    expect(rescored.outdatedDocs).toEqual([]);
    expect(rescored.readiness!.outdated).toBe(false);
  });

  it('a score without a file list covers all five documents, as older journals do', () => {
    const all = Object.fromEntries(['project.md', 'briefing.md', 'stack.md', 'flow.md', 'design.md'].map((file) => [file, 0.9]));
    expect(reduceRefineEvents([edited('flow.md'), scoredDocs(all)]).outdatedDocs).toEqual([]);
  });
});

describe('stage progress', () => {
  it('a step records the document it leaves and the round it leaves from; the same document is recorded once', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.StageAdvanced, data: { doc: 'flow.md', cycle: 2 } },
      { type: RefineEvent.StageAdvanced, data: { doc: 'flow.md', cycle: 2 } },
      { type: RefineEvent.StageAdvanced, data: { doc: 'project.md', cycle: 3 } },
    ]);
    expect(s.doneStages).toEqual(['flow.md', 'project.md']);
    expect(s.stageStartCycle).toBe(3);
  });

  it('the final review is closed once the owner moves on to the backlog', () => {
    expect(reduceRefineEvents([]).reviewClosed).toBeUndefined();
    expect(reduceRefineEvents([{ type: RefineEvent.ReviewClosed, data: {} }]).reviewClosed).toBe(true);
  });
});

describe('canStart', () => {
  type Input = Parameters<typeof canStart>[0];
  /** A current Spec Kit preparation, which every start needs. */
  const prepared = { status: 'done', stale: false };
  const base: Input = { status: 'answering', mode: 'new-spec', derived: {}, backlog: null, speckit: prepared };
  /** A detailed backlog of one item with its pre-plan. */
  const planned = { enabled: true, detail: true, items: [{ key: 'base' }], preplans: { base: { preplan: {} } } };

  it('opens with checks failing, a low Jev score, a blocking question, a pending approval or a stale list', () => {
    const waiting = { ...base, stale: true, cycle: 2, questions: [{ status: 'pending', blocking: true }], patches: [{ status: 'pending', replace: '## Decisões' }] };
    expect(canStart(waiting)).toBe(true);
  });

  it('stays shut while the agents evaluate or a run started', () => {
    expect(canStart({ ...base, status: 'evaluating' })).toBe(false);
    expect(canStart({ ...base, status: 'started' })).toBe(false);
  });

  it('needs something derived to start from', () => {
    expect(canStart({ ...base, derived: null })).toBe(false);
    expect(canStart({ ...base, mode: 'new-project' })).toBe(false);
  });

  it('opens a backlog only once it is detailed and has at least one item', () => {
    const item = { key: 'base' };
    expect(canStart({ ...base, backlog: planned })).toBe(true);
    expect(canStart({ ...base, backlog: { enabled: true, detail: true, items: [] } })).toBe(false);
    expect(canStart({ ...base, backlog: { enabled: true, detail: true } })).toBe(false);
    expect(canStart({ ...base, backlog: { enabled: true, detail: false, items: [item] } })).toBe(false);
    expect(canStart({ ...base, backlog: { enabled: true, detail: null, items: [item] } })).toBe(false);
  });

  it('a wizard backlog, an imported backlog, a new spec, a continued spec and an older draft start only once their Spec Kit preparation is done and current', () => {
    const sessions: Input[] = [{ ...base, mode: 'new-project', backlog: planned }, { ...base, mode: 'backlog', backlog: planned }, base, { ...base, mode: 'continue' }, { ...base, mode: null }];
    for (const session of sessions) {
      expect(canStart({ ...session, speckit: undefined }), String(session.mode)).toBe(false);
      expect(canStart({ ...session, speckit: { status: 'running', stale: false } }), String(session.mode)).toBe(false);
      expect(canStart({ ...session, speckit: { status: 'failed', stale: false } }), String(session.mode)).toBe(false);
      expect(canStart({ ...session, speckit: { status: 'done', stale: true } }), String(session.mode)).toBe(false);
      expect(canStart(session), String(session.mode)).toBe(true);
    }
  });

  it('a pending blocking question of Spec Kit keeps the start shut; an answered or advisory one does not', () => {
    const q = (over: Record<string, unknown>) => ({ status: 'pending', blocking: true, origin: 'speckit', ...over });
    for (const ready of [{ ...base, mode: 'new-project', backlog: planned }, base]) {
      expect(canStart({ ...ready, questions: [q({})] })).toBe(false);
      expect(canStart({ ...ready, questions: [q({ status: 'answered' })] })).toBe(true);
      expect(canStart({ ...ready, questions: [q({ blocking: false })] })).toBe(true);
      expect(canStart({ ...ready, questions: [q({ origin: undefined })] })).toBe(true);
    }
  });

  it('the inputs changed since the preparation began shut the start, as the hash taken at the start says', () => {
    const recorded = { ...base, speckit: { ...prepared, inputHash: 'h1' } };
    expect(speckitPending(recorded, 'h1')).toBe(false);
    expect(speckitPending(recorded, 'h2')).toBe(true);
  });

  it('a backlog with an item still without a pre-plan stays shut', () => {
    const items = [{ key: 'login' }, { key: 'cart' }];
    expect(canStart({ ...base, backlog: { enabled: true, detail: true, items, preplans: { login: { preplan: {} } } } })).toBe(false);
    expect(canStart({ ...base, backlog: { enabled: true, detail: true, items, preplans: { login: { preplan: {} }, cart: { preplan: null } } } })).toBe(false);
  });

  it('a backlog opens once every item has its pre-plan, and a started or delivered spec needs none', () => {
    const backlog = { enabled: true, detail: true, items: [{ key: 'login' }, { key: 'cart' }], preplans: { login: { preplan: {} } } };
    expect(canStart({ ...base, backlog: { ...backlog, preplans: { ...backlog.preplans, cart: { preplan: {} } } } })).toBe(true);
    expect(canStart({ ...base, backlog: { ...backlog, specs: { cart: { spec: { status: 'done' } } } } })).toBe(true);
    expect(canStart({ ...base, backlog: { ...backlog, specs: { cart: { spec: { status: 'planned' } } } } })).toBe(false);
  });

  it('a single spec needs no pre-plan', () => {
    expect(canStart(base)).toBe(true);
    expect(canStart({ ...base, mode: 'continue' })).toBe(true);
  });
});

describe('Spec Kit triage state', () => {
  const started = { type: RefineEvent.SpeckitStarted, data: { total: 4 } };
  const asked = { questionId: 'speckit-1', role: 'po', text: 'Qual o prazo?', blocking: true, relatedAcIds: [], cycle: 2, origin: 'speckit', itemKey: 'login' };
  const planDone = { type: RefineEvent.SpeckitStepDone, data: { command: 'plan', itemKey: 'login', files: [], questions: [asked] } };
  const evidence = [{ file: 'briefing.md', heading: 'Regras', quote: 'O link vale por 90 dias depois do envio.' }];
  const result = (over: Record<string, unknown> = {}) => ({ questionId: 'speckit-1', subject: 'Prazo', context: 'Item Entrar.', text: 'Por quanto tempo vale o link?', options: [], ...over });
  const triaged = (results: object[], extra: Record<string, unknown> = {}) => ({ type: RefineEvent.SpeckitTriaged, data: { results, ...extra } });

  it('fills in the card of a pending question, and records the answer the documents settle with who gave it and its evidence', () => {
    const s = reduceRefineEvents([started, planDone, triaged([result({ answer: { text: '90 dias', by: 'sm', evidence } })])]);
    expect(s.questions).toEqual([expect.objectContaining({ questionId: 'speckit-1', text: 'Por quanto tempo vale o link?', subject: 'Prazo', context: 'Item Entrar.', status: 'answered', answer: '90 dias', answeredBy: 'sm', evidence })]);
  });

  it('keeps a question without an answer pending, with its card and no options when the card has none', () => {
    const s = reduceRefineEvents([started, planDone, triaged([result()])]);
    expect(s.questions[0]).toMatchObject({ status: 'pending', text: 'Por quanto tempo vale o link?', context: 'Item Entrar.' });
    expect(s.questions[0]!.options).toBeUndefined();
  });

  it('never changes a question the owner has already answered', () => {
    const s = reduceRefineEvents([started, planDone, { type: RefineEvent.QuestionAnswered, data: { questionId: 'speckit-1', text: 'Um dia' } }, triaged([result({ answer: { text: '90 dias', by: 'po', evidence } })])]);
    expect(s.questions[0]).toMatchObject({ status: 'answered', answer: 'Um dia', answeredBy: null, text: 'Qual o prazo?' });
  });

  it('removes the finished entry of the step when an answer came with its rework, so a resume runs the step again', () => {
    const rework = { command: 'plan', itemKey: 'login' };
    const answered = reduceRefineEvents([started, planDone, triaged([result({ answer: { text: '90 dias', by: 'sm', evidence } })], { rework })]);
    expect(answered.speckit!.steps).toEqual([]);
    const cardOnly = reduceRefineEvents([started, planDone, triaged([result()], { rework })]);
    expect(cardOnly.speckit!.steps).toEqual([{ command: 'plan', itemKey: 'login' }]);
  });

  it('flags the PO and the SM answering from its start until its end', () => {
    const answering = { type: RefineEvent.SpeckitAnswersStarted, data: {} };
    expect(reduceRefineEvents([started, answering]).speckitAnswering).toBe(true);
    expect(reduceRefineEvents([started, answering, { type: RefineEvent.SpeckitAnswersDone, data: {} }]).speckitAnswering).toBe(false);
  });

  it('a stale mark keeps a finished preparation from standing, until it runs again', () => {
    const s = reduceRefineEvents([started, { type: RefineEvent.SpeckitDone, data: { inputHash: 'h' } }, { type: RefineEvent.SpeckitStale, data: {} }]);
    expect(s.speckit).toMatchObject({ status: 'done', stale: true });
  });

  it('an answer the owner gives later has no one who answered it from the documents, and no evidence', () => {
    const s = reduceRefineEvents([started, planDone, triaged([result({ answer: { text: '90 dias', by: 'sm', evidence } })]), { type: RefineEvent.QuestionAnswered, data: { questionId: 'speckit-1', text: 'Outro prazo' } }]);
    expect(s.questions[0]).toMatchObject({ status: 'answered', answer: 'Outro prazo', answeredBy: null });
    expect(s.questions[0]!.evidence).toBeUndefined();
  });
});

describe('Spec Kit preparation state', () => {
  const started = { type: RefineEvent.SpeckitStarted, data: { total: 4 } };

  it('follows a run from its start through each step to its end', () => {
    const s = reduceRefineEvents([
      started,
      { type: RefineEvent.SpeckitStepDone, data: { command: 'constitution', files: ['.specify/memory/constitution.md'] } },
      { type: RefineEvent.SpeckitStepDone, data: { command: 'specify', itemKey: 'login', files: ['specs/login/spec.md'] } },
    ]);
    expect(s.speckit).toEqual({ status: 'running', steps: [{ command: 'constitution' }, { command: 'specify', itemKey: 'login' }], total: 4, stale: false });
    const done = reduceRefineEvents([started, { type: RefineEvent.SpeckitDone, data: { inputHash: 'h' } }]);
    expect(done.speckit).toMatchObject({ status: 'done', stale: false });
  });

  it('records the questions of a Spec Kit step as pending questions marked with their origin and item', () => {
    const asked = { questionId: 'speckit-1', role: 'po', text: 'Qual moeda?', blocking: true, relatedAcIds: [], cycle: 2, origin: 'speckit', itemKey: 'cart' };
    const s = reduceRefineEvents([started, { type: RefineEvent.SpeckitStepDone, data: { command: 'specify', itemKey: 'cart', files: [], questions: [asked] } }]);
    expect(s.questions).toEqual([{ ...asked, status: 'pending', answer: null }]);
    expect(s.status).toBe('answering');
  });

  it('keeps the feature directory of each item a specify step reports', () => {
    const s = reduceRefineEvents([started, { type: RefineEvent.SpeckitStepDone, data: { command: 'specify', itemKey: 'cart', files: [], featureDir: 'specs/002-cart' } }]);
    expect(s.speckit?.features).toEqual({ cart: 'specs/002-cart' });
    expect(reduceRefineEvents([started]).speckit?.features).toBeUndefined();
  });

  it('keeps the reason of a failed run, and a new run starts clean', () => {
    const failed = reduceRefineEvents([started, { type: RefineEvent.SpeckitFailed, data: { reason: 'interrupted' } }]);
    expect(failed.speckit).toMatchObject({ status: 'failed', error: 'interrupted' });
    const again = reduceRefineEvents([started, { type: RefineEvent.SpeckitFailed, data: { reason: 'x' } }, started]);
    expect(again.speckit).toEqual({ status: 'running', steps: [], total: 4, stale: false });
  });

  it('keeps the detail of a failed run, and marks the steps a resumed run of the same inputs reuses', () => {
    const begun = { type: RefineEvent.SpeckitStarted, data: { total: 4, inputHash: 'h' } };
    const specify = { type: RefineEvent.SpeckitStepDone, data: { command: 'specify', itemKey: 'cart', files: [], featureDir: 'specs/001-cart' } };
    const failed = { type: RefineEvent.SpeckitFailed, data: { reason: 'stopped', detail: 'specs/001-cart/plan.md' } };
    expect(reduceRefineEvents([begun, specify, failed]).speckit).toMatchObject({ status: 'failed', error: 'stopped', detail: 'specs/001-cart/plan.md' });
    const reused = { type: RefineEvent.SpeckitReused, data: { steps: [{ command: 'specify', itemKey: 'cart' }] } };
    const resumed = reduceRefineEvents([begun, specify, failed, begun, reused]).speckit;
    expect(resumed).toEqual({ status: 'running', steps: [{ command: 'specify', itemKey: 'cart', reused: true }], features: { cart: 'specs/001-cart' }, inputHash: 'h', total: 4, stale: false });
  });

  it('shows the command running now, and when the run began', () => {
    const begun = { type: RefineEvent.SpeckitStarted, at: '2026-10-25T10:00:00Z', data: { total: 4 } };
    const running = reduceRefineEvents([begun, { type: RefineEvent.SpeckitStepStarted, data: { command: 'specify', itemKey: 'login' } }]);
    expect(running.speckit).toMatchObject({ startedAt: '2026-10-25T10:00:00Z', running: [{ command: 'specify', itemKey: 'login' }] });
    const finished = reduceRefineEvents([begun, { type: RefineEvent.SpeckitStepStarted, data: { command: 'specify', itemKey: 'login' } }, { type: RefineEvent.SpeckitStepDone, data: { command: 'specify', itemKey: 'login', files: [] } }]);
    expect(finished.speckit?.running).toEqual([]);
  });

  it('keeps the start and the end of each finished step', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.SpeckitStarted, at: '2026-10-25T10:00:00Z', data: { total: 4 } },
      { type: RefineEvent.SpeckitStepStarted, at: '2026-10-25T10:00:01Z', data: { command: 'constitution' } },
      { type: RefineEvent.SpeckitStepDone, at: '2026-10-25T10:02:06Z', data: { command: 'constitution', files: [] } },
    ]);
    expect(s.speckit?.steps).toEqual([{ command: 'constitution', startedAt: '2026-10-25T10:00:01Z', endedAt: '2026-10-25T10:02:06Z' }]);
  });

  it('goes stale when a document or a backlog derivation changes after it', () => {
    const done = [started, { type: RefineEvent.SpeckitDone, data: { inputHash: 'h' } }];
    for (const e of [
      { type: RefineEvent.DocEdited, data: { file: 'stack.md', hash: 'x', source: 'human' } },
      { type: RefineEvent.BacklogDerived, data: { project: null, epics: [], items: [], cycle: 2 } },
      { type: RefineEvent.SpecDerived, data: { key: 'login', specId: 'login', inputHash: 'i', rev: null, spec: null, issues: [], cycle: 2 } },
      { type: RefineEvent.PreplanDerived, data: { key: 'login', inputHash: 'i', specRev: 'r', preplan: null, issues: [], cycle: 2 } },
    ]) {
      expect(reduceRefineEvents([{ type: RefineEvent.BacklogEnabled, data: {} }, ...done, e]).speckit?.stale, e.type).toBe(true);
    }
    expect(reduceRefineEvents([{ type: RefineEvent.DocEdited, data: { file: 'stack.md', hash: 'x' } }]).speckit).toBeUndefined();
  });

  it("goes stale when a single spec is derived again or the owner answers a question, but not on an answer the PO or the SM took from the documents", () => {
    const done = [started, { type: RefineEvent.SpeckitDone, data: { inputHash: 'h' } }];
    expect(reduceRefineEvents([...done, ...cycle(2)]).speckit?.stale).toBe(true);
    expect(reduceRefineEvents([...done, { type: RefineEvent.QuestionAnswered, data: { questionId: 'q', text: 'Real' } }]).speckit?.stale).toBe(true);
    expect(reduceRefineEvents([...done, { type: RefineEvent.QuestionAnswered, data: { questionId: 'q', text: 'Real', by: 'po' } }]).speckit?.stale).toBe(false);
  });

  it('keeps the backlog key a continued spec came from, which names its feature folder', () => {
    expect(reduceRefineEvents([{ type: RefineEvent.Created, data: { mode: 'continue', featureKey: 'login' } }]).featureKey).toBe('login');
    expect(reduceRefineEvents([{ type: RefineEvent.Created, data: { mode: 'new-spec' } }]).featureKey).toBeUndefined();
  });

  it('a new preparation keeps only the steps it reuses, marked as reused, and drops the rest', () => {
    const earlier = [
      { type: RefineEvent.SpeckitStarted, data: { total: 4 } },
      { type: RefineEvent.SpeckitStepDone, data: { command: 'constitution', files: [], basis: 'b0' } },
      { type: RefineEvent.SpeckitStepDone, data: { command: 'specify', itemKey: 'login', files: [], basis: 'b1' } },
      { type: RefineEvent.SpeckitFailed, data: { reason: 'x' } },
    ];
    const s = reduceRefineEvents([...earlier, { type: RefineEvent.SpeckitStarted, data: { total: 4, inputHash: 'h2' } }, { type: RefineEvent.SpeckitReused, data: { steps: [{ command: 'constitution', basis: 'b0' }] } }]);
    expect(s.speckit).toEqual({ status: 'running', steps: [{ command: 'constitution', basis: 'b0', reused: true }], total: 4, inputHash: 'h2', stale: false });
  });

  it('a new preparation that names no reused step, as an earlier journal starts, keeps no step', () => {
    const s = reduceRefineEvents([{ type: RefineEvent.SpeckitStarted, data: { total: 4 } }, { type: RefineEvent.SpeckitStepDone, data: { command: 'constitution', files: [], basis: 'b0' } }, { type: RefineEvent.SpeckitFailed, data: { reason: 'x' } }, { type: RefineEvent.SpeckitStarted, data: { total: 4 } }]);
    expect(s.speckit?.steps).toEqual([]);
  });

  it('shows every step that runs at once, and removes each one when it finishes', () => {
    const begun = [
      { type: RefineEvent.SpeckitStarted, at: '2026-10-25T10:00:00Z', data: { total: 4 } },
      { type: RefineEvent.SpeckitStepStarted, at: '2026-10-25T10:00:01Z', data: { command: 'specify', itemKey: 'login' } },
      { type: RefineEvent.SpeckitStepStarted, at: '2026-10-25T10:00:02Z', data: { command: 'specify', itemKey: 'cart' } },
    ];
    const running = reduceRefineEvents(begun);
    expect(running.speckit?.running).toEqual([
      { command: 'specify', itemKey: 'login', startedAt: '2026-10-25T10:00:01Z' },
      { command: 'specify', itemKey: 'cart', startedAt: '2026-10-25T10:00:02Z' },
    ]);
    const one = reduceRefineEvents([...begun, { type: RefineEvent.SpeckitStepDone, at: '2026-10-25T10:01:00Z', data: { command: 'specify', itemKey: 'login', files: [] } }]);
    expect(one.speckit?.running).toEqual([{ command: 'specify', itemKey: 'cart', startedAt: '2026-10-25T10:00:02Z' }]);
    expect(one.speckit?.steps).toEqual([{ command: 'specify', itemKey: 'login', startedAt: '2026-10-25T10:00:01Z', endedAt: '2026-10-25T10:01:00Z' }]);
  });

  it('records a question that two steps asked at once only once', () => {
    const asked = { questionId: 'speckit-1', role: 'po', text: 'Qual moeda?', blocking: false, relatedAcIds: [], cycle: 2, origin: 'speckit' };
    const s = reduceRefineEvents([
      { type: RefineEvent.SpeckitStarted, data: { total: 4 } },
      { type: RefineEvent.SpeckitStepDone, data: { command: 'specify', itemKey: 'login', files: [], questions: [{ ...asked, itemKey: 'login' }] } },
      { type: RefineEvent.SpeckitStepDone, data: { command: 'specify', itemKey: 'cart', files: [], questions: [{ ...asked, itemKey: 'cart' }] } },
    ]);
    expect(s.questions.map((q) => q.questionId)).toEqual(['speckit-1']);
  });
});
