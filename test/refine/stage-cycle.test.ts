import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyRefineEvent, emptyRefineState } from '../../server/refine/state.js';
import { createNewProject, draftPaths, readDoc, writeDoc } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { runStageCycle } from '../../server/refine/stage-cycle.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';

/** A journal that folds each fact into its state, as the session's journal does. */
function foldingJournal() {
  const state = emptyRefineState();
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    state,
    events,
    allocStepSeq: () => 1,
    fact: async (type: string, data: Record<string, unknown> = {}) => {
      events.push({ type, data });
      applyRefineEvent(state, { type, data });
      return { seq: events.length, at: '', runId: 'shop/shop-002', specHash: 'draft', type, kind: 'fact' as const, data };
    },
  };
}

async function newDraft() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-stage-'));
  const ws = { projectId: 'shop', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` } as Workspace;
  const draft = draftPaths(ws, 'shop-002');
  await createNewProject(draft, 'Shop');
  return draft;
}

/** The owner's answer for one stage: a change to the project document, a change to another document, and a question. */
const answer = (docPatch: unknown[], questions: unknown[] = [], contradictions: unknown[] = [], findings: unknown[] = [], moves: unknown[] = []) => ({
  ok: true,
  value: { specHash: 'draft', checklist: [], questions, docPatch, contradictions, findings, moves },
  summary: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, durationMs: 0, numTurns: 0, rateLimit: null },
  sandboxDisabled: false,
});

/** The reorganization pass gets its answer; the owner's review gets the other. */
const passes = (reorg: unknown, review: unknown) => vi.fn(async (req: { pack: { feedback?: string } }, _opts: unknown) => ((req.pack.feedback ?? '').includes('(reorganize in full)') ? reorg : review));

describe('runStageCycle', () => {
  it('proposes changes to the stage document only, records the questions, and takes that document’s score', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = passes(answer([]), answer(
      [
        { file: 'docs/project.md', find: '# Shop', replace: '# Shop Online', reason: 'nome' },
        { file: 'docs/flow.md', find: '# Flow', replace: '# Flow 2', reason: 'outro documento' },
      ],
      [{ id: 'q1', text: 'Qual o prazo?', blocking: true, relatedAcIds: [], options: [{ label: 'Trinta dias', detail: 'prazo curto', recommended: true }, { label: 'Sessenta dias', detail: 'prazo longo' }], subject: 'Prazo de entrega' }],
    ));
    const scoreDocs = vi.fn(async (_docs: Record<string, string>, files?: readonly string[]) => ({ available: true, model: 'jev', average: 0.8, docs: Object.fromEntries((files ?? []).map((f) => [f, { score: 0.8, checks: { complete: 0.8, concrete: 0.8, consistent: 0.8, scoped: 0.8 } }])), usage: null }));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], scoreDocs }, 1, 'project.md');
    const proposed = journal.events.filter((e) => e.type === RefineEvent.PatchProposed);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.data).toMatchObject({ file: 'project.md', role: 'po', cycle: 1 });
    expect(journal.state.questions).toEqual([expect.objectContaining({ questionId: 'po-s1-0', text: 'Qual o prazo?', blocking: true, status: 'pending' })]);
    expect(scoreDocs.mock.calls[0]![1]).toEqual(['project.md']);
    expect(journal.state.readiness).toMatchObject({ available: true });
  });

  it('a design document is reviewed by Front, and only when Front is wired; the other documents by their owner', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => answer([]));
    const frontAgent = vi.fn(async () => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, frontAgent: frontAgent as never, principles: () => [] }, 1, 'design.md');
    expect(frontAgent).toHaveBeenCalledTimes(2);
    expect(runAgent).not.toHaveBeenCalled();
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 2, 'design.md');
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it('a stack document is reviewed by the SM', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async (_req: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'stack.md');
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ role: 'sm' });
  });

  it('a failed review fails the cycle with its reason, and changes nothing', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => ({ ok: false, failure: 'schema', errors: ['bad json'], summary: undefined, sandboxDisabled: false }));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'stage review failed: schema: bad json' });
    expect(journal.events.some((e) => e.type === RefineEvent.PatchProposed)).toBe(false);
  });

  it('a review that cannot be read fails the cycle without throwing, and nothing is proposed', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => { throw new Error('agent down'); });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'agent down' });
    expect(await readDoc(draft, 'project.md')).toContain('# Shop');
  });

  it('a stage review leaves the checklist of the last full round as it was, and journals no full evaluation', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const checked = { id: 'po.personas' as const, role: 'po' as const, passed: true, detail: 'ok' };
    journal.state.checklist = [checked];
    const runAgent = vi.fn(async () => answer([], [{ id: 'q1', text: 'Quem usa?', blocking: false, relatedAcIds: [], options: [] }]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.state.checklist).toEqual([checked]);
    expect(journal.events.some((e) => e.type === RefineEvent.Evaluated)).toBe(false);
  });

  it('a stage review journals only the contradictions between its document and the documents before it', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const contradiction = (fact: string, a: string, b: string) => ({ fact, a: { file: a, quote: 'x' }, b: { file: b, quote: 'y' }, fix: 'z' });
    const runAgent = vi.fn(async () => answer([], [], [contradiction('o prazo diverge', 'docs/project.md', 'flow.md'), contradiction('a pilha diverge', 'docs/stack.md', 'docs/flow.md')]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.state.stageAlignment).toEqual({ 'project.md': ['o prazo diverge'] });
  });

  it('a review without a contradictions list is aligned', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => ({ ...answer([], []), value: { specHash: 'draft', checklist: [], questions: [], docPatch: [] } }));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.state.stageAlignment).toEqual({ 'project.md': [] });
  });

  it('a failed owner review after the reorganization fails the cycle with its reason', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const failed = { ok: false, failure: 'schema', errors: ['bad json'], summary: undefined, sandboxDisabled: false };
    await runStageCycle({ draft, journal, runAgent: passes(answer([]), failed) as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'stage review failed: schema: bad json' });
  });

  it('a move out of the stage document into a later one is never applied backward: only forward moves of the stage are passed on', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const backward = { from: 'docs/project.md', to: 'docs/flow.md', quote: '# Shop', text: 'texto', reason: 'r' };
    const otherDocument = { from: 'docs/flow.md', to: 'docs/briefing.md', quote: '# Flow', text: 'texto', reason: 'r' };
    await runStageCycle({ draft, journal, runAgent: passes(answer([], [], [], [], [backward, otherDocument]), answer([])) as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.some((e) => e.type === RefineEvent.DocMoved)).toBe(false);
  });

  it('a forward move whose quote the stage document does not hold is discarded with its reason, and the review goes on', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const forward = { from: 'docs/project.md', to: 'docs/briefing.md', quote: 'trecho que não existe', text: 'texto', reason: 'r' };
    await runStageCycle({ draft, journal, runAgent: passes(answer([], [], [], [], [forward]), answer([])) as never, principles: () => [] }, 1, 'project.md');
    expect(journal.state.discarded).toEqual([expect.objectContaining({ role: 'po', file: 'docs/project.md', cycle: 1 })]);
    expect(journal.events.some((e) => e.type === RefineEvent.StageReviewed)).toBe(true);
  });

  it('a finding or a contradiction outside the stage and the documents before it is dropped', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const finding = (doc: string, quote: string) => ({ doc, severity: 'advice', quote, text: 'texto', fix: 'corrigir' });
    const contradiction = { fact: 'prazo', a: { file: 'docs/project.md', quote: 'x' }, b: { file: 'docs/briefing.md', quote: 'y' }, fix: 'z' };
    const review = answer([], [], [contradiction], [finding('project.md', '# Shop'), finding('design.md', '# Shop'), finding('flow.md', 'trecho ausente')]);
    await runStageCycle({ draft, journal, runAgent: passes(answer([]), review) as never, principles: () => [] }, 1, 'project.md');
    expect(journal.state.findings).toEqual([expect.objectContaining({ doc: 'project.md', quote: '# Shop' })]);
    expect(journal.state.stageAlignment).toEqual({ 'project.md': [] });
  });

  it('the Jev reads the stage with the documents before it, and the first stage is not sent to it', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const validate = vi.fn(async (_docs: unknown) => ({ available: true, decision: 'review', consistent: true, confidence: 0.9, model: 'jev', checks: {}, stateTruncated: false }));
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, validateDocs: validate as never, principles: () => [] }, 1, 'briefing.md');
    expect(validate).toHaveBeenCalledTimes(1);
    const sent = validate.mock.calls[0]![0] as unknown as Record<string, string>;
    expect(sent.project).toContain('# Shop');
    expect(sent).toMatchObject({ stack: '', design: '' });
    expect(journal.events.some((e) => e.type === RefineEvent.DocsValidated)).toBe(true);
    await runStageCycle({ draft, journal, runAgent: runAgent as never, validateDocs: validate as never, principles: () => [] }, 2, 'flow.md');
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('a confidential project sends no document to the Jev', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.confidential = true;
    const validate = vi.fn(async (_docs: unknown) => ({ available: true, decision: 'review', consistent: true, confidence: 0.9, model: 'jev', checks: {}, stateTruncated: false }));
    await runStageCycle({ draft, journal, runAgent: vi.fn(async () => answer([])) as never, validateDocs: validate as never, principles: () => [] }, 1, 'briefing.md');
    expect(validate).not.toHaveBeenCalled();
  });

  it('a Jev that fails is recorded as unavailable, and the review goes on', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const validate = vi.fn(async (_docs: unknown) => { throw new Error('openrouter down'); });
    await runStageCycle({ draft, journal, runAgent: vi.fn(async () => answer([])) as never, validateDocs: validate as never, principles: () => [] }, 1, 'briefing.md');
    expect(journal.events.find((e) => e.type === RefineEvent.DocsValidated)?.data).toMatchObject({ available: false });
    expect(journal.events.some((e) => e.type === RefineEvent.StageReviewed)).toBe(true);
  });

  it('a stage review is keyed by the documents of its stage, so a later document leaves its key as it was', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    const deps = { draft, journal, runAgent: runAgent as never, principles: () => [] };
    await runStageCycle(deps, 1, 'briefing.md');
    await writeDoc(draft, 'design.md', '# Design mudou');
    await runStageCycle(deps, 2, 'briefing.md');
    await writeDoc(draft, 'project.md', '# Shop mudou');
    await runStageCycle(deps, 3, 'briefing.md');
    const keys = runAgent.mock.calls.map((c) => (c[1] as { specHash: string }).specHash);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[4]).not.toBe(keys[2]);
  });

  it('an earlier document reaches the review as a digest, and the stage document in full', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    await writeDoc(draft, 'project.md', `# Shop\n\n${'palavra '.repeat(1000)}\nFIM-DO-PROJETO`);
    await writeDoc(draft, 'briefing.md', '# Briefing\n\nFIM-DO-BRIEFING');
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    const review = (runAgent.mock.calls[1]![0] as { pack: { feedback: string } }).pack.feedback;
    expect(review).not.toContain('FIM-DO-PROJETO');
    expect(review).toContain('FIM-DO-BRIEFING');
    expect(review).toContain('(context only, a digest)');
  });

  it('the Jev goals of this document reach its review', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: false, skipped: false, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.9, scoped: 0.9 } } } } as never;
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    const review = (runAgent.mock.calls[1]![0] as { pack: { feedback: string } }).pack.feedback;
    expect(review).toContain('### Jev goals for this document');
    expect(review).toContain('- briefing.md (50%)');
  });

  it('a move that cuts a passage a pending question asks about is refused, whatever its target', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.questions = [{ questionId: 'po-c0-0', role: 'po', text: 'Qual é o "Prazo de entrega"?', blocking: true, relatedAcIds: [], cycle: 0, status: 'pending', answer: null }] as never;
    const forward = { from: 'docs/project.md', to: 'docs/briefing.md', quote: 'Prazo de entrega', text: 'texto', reason: 'r' };
    await runStageCycle({ draft, journal, runAgent: passes(answer([], [], [], [], [forward]), answer([])) as never, principles: () => [] }, 1, 'project.md');
    expect(journal.state.discarded).toEqual([expect.objectContaining({ role: 'po', cycle: 1, reason: expect.stringContaining('a pergunta pendente cita este trecho') })]);
    expect(journal.events.some((e) => e.type === RefineEvent.DocMoved)).toBe(false);
  });

  it('a question without choices or subject is recorded without them', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => answer([], [{ id: 'q2', text: 'Quem aprova?', blocking: false, relatedAcIds: [], options: [] }]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    const [question] = journal.state.questions;
    expect(question).toMatchObject({ questionId: 'po-s1-0', text: 'Quem aprova?', blocking: false });
    expect(question).not.toHaveProperty('options');
    expect(question).not.toHaveProperty('subject');
  });

  it('a review that throws a text, not an error, fails the cycle with that text', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => { throw 'agent stopped'; });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'agent stopped' });
  });
});
