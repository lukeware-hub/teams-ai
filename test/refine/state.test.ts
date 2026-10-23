import { describe, expect, it } from 'vitest';
import { approvalPatch } from '../../server/refine/adjustments.js';
import { RefineEvent } from '../../server/refine/events.js';
import { canStart, reduceRefineEvents } from '../../server/refine/state.js';
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

describe('reduceRefineEvents moves and findings', () => {
  it('folds a move into the list with its status, and an undo marks it undone', () => {
    const row = { moveId: 'move-po-c1-0', role: 'po', cycle: 1, from: 'project.md', to: 'flow.md', reason: 'r', quote: 'q', text: 't', removedAt: 0, removed: 'q\n', insertAt: 3, inserted: '\nt\n', fromHash: 'a', toHash: 'b' };
    const s = reduceRefineEvents([{ type: RefineEvent.DocMoved, data: row }, { type: RefineEvent.DocMoveUndone, data: { moveId: 'move-po-c1-0' } }]);
    expect(s.moves).toEqual([{ ...row, status: 'undone' }]);
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
});

describe('canStart', () => {
  type Input = Parameters<typeof canStart>[0];
  const base: Input = { status: 'answering', mode: 'new-spec', derived: {}, backlog: null };

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
    expect(canStart({ ...base, backlog: { enabled: true, detail: true, items: [item] } })).toBe(true);
    expect(canStart({ ...base, backlog: { enabled: true, detail: true, items: [] } })).toBe(false);
    expect(canStart({ ...base, backlog: { enabled: true, detail: true } })).toBe(false);
    expect(canStart({ ...base, backlog: { enabled: true, detail: false, items: [item] } })).toBe(false);
    expect(canStart({ ...base, backlog: { enabled: true, detail: null, items: [item] } })).toBe(false);
  });
});
