import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyRefineEvent, emptyRefineState } from '../../server/refine/state.js';
import { createNewProject, draftPaths, readDoc, writeDoc } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { runStageCycle, stageReviewPack } from '../../server/refine/stage-cycle.js';
import { PackTooLargeError } from '../../server/refine/fit-pack.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { LOOSE_BRIEF, SHAPED_BRIEF } from '../fixtures/briefing-shape.js';

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

const REORGANIZE_FAILED = 'A reorganização de project.md não devolveu o resultado em formato válido. Clique em Reavaliar.';
const REVIEW_FAILED = 'A revisão de project.md não devolveu o resultado em formato válido. Clique em Reavaliar.';

/** A reshape answer: the whole document as the agent writes it back. */
const reshaped = (text: string) => ({ ...answer([]), value: { specHash: 'draft', text } });
/** The agent answers a reshape (kind suggest) with `suggest`, and every review (kind refine) with an empty answer. */
const agentFor = (suggest: () => unknown) => vi.fn(async (req: { kind: string }) => (req.kind === 'suggest' ? suggest() : answer([])));
type Agent = ReturnType<typeof agentFor>;
const suggestCalls = (runAgent: Agent) => runAgent.mock.calls.filter(([req]) => req.kind === 'suggest');
/** The feedback of the owner's review of the briefing, which carries the document as the stage now holds it. */
const reviewFeedback = (runAgent: Agent) => runAgent.mock.calls.map(([req]) => (req as { pack?: { feedback?: string } }).pack?.feedback ?? '').find((f) => f.includes('### briefing.md (this stage)')) ?? '';
const stageReviewed = (journal: ReturnType<typeof foldingJournal>) => journal.events.find((e) => e.type === RefineEvent.StageReviewed)?.data;

describe('runStageCycle reshapes the stage document to its template', () => {
  it('rewrites the document in the template shape, and the review reads the new text', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', LOOSE_BRIEF);
    const journal = foldingJournal();
    const runAgent = agentFor(() => reshaped(SHAPED_BRIEF));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(await readDoc(draft, 'briefing.md')).toBe(SHAPED_BRIEF);
    expect(journal.events.find((e) => e.type === RefineEvent.DocReshaped)?.data).toMatchObject({ file: 'briefing.md', cycle: 1, role: 'po' });
    expect(reviewFeedback(runAgent)).toContain(SHAPED_BRIEF);
    expect(reviewFeedback(runAgent)).not.toContain('Regras de negócio');
  });

  it('sends no document that already follows the template', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', SHAPED_BRIEF);
    const journal = foldingJournal();
    const runAgent = agentFor(() => reshaped(LOOSE_BRIEF));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(suggestCalls(runAgent)).toHaveLength(0);
    expect(await readDoc(draft, 'briefing.md')).toBe(SHAPED_BRIEF);
  });

  it('sends no document that is still the untouched template', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = agentFor(() => reshaped(SHAPED_BRIEF));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(suggestCalls(runAgent)).toHaveLength(0);
  });

  it('never reshapes the flow document', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'flow.md', '# Fluxo\n\nTexto solto.\n');
    const journal = foldingJournal();
    const runAgent = agentFor(() => reshaped('# Fluxo\n'));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'flow.md');
    expect(suggestCalls(runAgent)).toHaveLength(0);
    expect(await readDoc(draft, 'flow.md')).toBe('# Fluxo\n\nTexto solto.\n');
  });

  it('asks once more, with the reason, when the first reshape breaks the template', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', LOOSE_BRIEF);
    const journal = foldingJournal();
    const answers = [reshaped(LOOSE_BRIEF), reshaped(SHAPED_BRIEF)];
    const runAgent = agentFor(() => answers.shift());
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(suggestCalls(runAgent)).toHaveLength(2);
    expect(suggestCalls(runAgent)[1]![0]).toMatchObject({ pack: { feedback: expect.stringContaining('faltam seções do modelo ou elas estão fora de ordem') } });
    expect(await readDoc(draft, 'briefing.md')).toBe(SHAPED_BRIEF);
  });

  it('keeps the file as it was when the reshape is refused twice, and the review says why', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', LOOSE_BRIEF);
    const journal = foldingJournal();
    const runAgent = agentFor(() => reshaped(LOOSE_BRIEF));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(suggestCalls(runAgent)).toHaveLength(2);
    expect(await readDoc(draft, 'briefing.md')).toBe(LOOSE_BRIEF);
    expect(stageReviewed(journal)).toMatchObject({ discardedPatches: [{ role: 'po', file: 'briefing.md', reason: expect.stringMatching(/^Não reorganizei briefing\.md no modelo: faltam seções do modelo ou elas estão fora de ordem/) }] });
  });

  it('a reshape that fails does not stop the review, and changes nothing', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', LOOSE_BRIEF);
    const journal = foldingJournal();
    const runAgent = agentFor(() => { throw new Error('agent down'); });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(journal.events.some((e) => e.type === RefineEvent.CycleFailed)).toBe(false);
    expect(stageReviewed(journal)).toMatchObject({ discardedPatches: [{ role: 'po', file: 'briefing.md', reason: expect.stringMatching(/o agente parou/) }] });
    expect(await readDoc(draft, 'briefing.md')).toBe(LOOSE_BRIEF);
  });

  it('keeps the text a person wrote while the reshape was running', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', LOOSE_BRIEF);
    const journal = foldingJournal();
    const runAgent = agentFor(async () => {
      await writeDoc(draft, 'briefing.md', '# Mudou\n');
      return reshaped(SHAPED_BRIEF);
    });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(await readDoc(draft, 'briefing.md')).toBe('# Mudou\n');
    expect(journal.events.some((e) => e.type === RefineEvent.DocReshaped)).toBe(false);
    expect(stageReviewed(journal)).toMatchObject({ discardedPatches: [{ role: 'po', file: 'briefing.md', reason: expect.stringMatching(/mudou durante a reorganização/) }] });
  });

  it('drops a pending patch that the reshape takes away', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', LOOSE_BRIEF);
    const journal = foldingJournal();
    journal.state.patches.push({ patchId: 'po-c0-0', role: 'po', file: 'briefing.md', find: '- Pedido só com pagamento.', replace: '- Pedido pago.', reason: 'r', diff: '', cycle: 0, status: 'pending', decision: null } as never);
    const runAgent = agentFor(() => reshaped(SHAPED_BRIEF));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(journal.events.find((e) => e.type === RefineEvent.PatchDropped)?.data).toMatchObject({ patchId: 'po-c0-0' });
  });

  it('does not reshape again a document whose reshape the owner undid, until the owner changes the text', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', LOOSE_BRIEF);
    const journal = foldingJournal();
    const runAgent = agentFor(() => reshaped(SHAPED_BRIEF));
    const deps = { draft, journal, runAgent: runAgent as never, principles: () => [] };
    await runStageCycle(deps, 1, 'briefing.md');
    await writeDoc(draft, 'briefing.md', LOOSE_BRIEF);
    await journal.fact(RefineEvent.DocReshapeUndone, { reshapeId: 'reshape-c1' });
    await runStageCycle(deps, 2, 'briefing.md');
    expect(suggestCalls(runAgent)).toHaveLength(1);
    expect(await readDoc(draft, 'briefing.md')).toBe(LOOSE_BRIEF);
    await writeDoc(draft, 'briefing.md', '# Mudou\n\nTexto solto.\n');
    await runStageCycle(deps, 3, 'briefing.md');
    expect(suggestCalls(runAgent)).toHaveLength(2);
    expect(await readDoc(draft, 'briefing.md')).toBe(SHAPED_BRIEF);
  });
});

describe('runStageCycle', () => {
  it('proposes changes to the stage document only and records the questions, with no score taken', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = passes(answer([]), answer(
      [
        { file: 'docs/project.md', find: '# Shop', replace: '# Shop Online', reason: 'nome' },
        { file: 'docs/flow.md', find: '# Flow', replace: '# Flow 2', reason: 'outro documento' },
      ],
      [{ id: 'q1', text: 'Qual o prazo?', blocking: true, relatedAcIds: [], options: [{ label: 'Trinta dias', detail: 'prazo curto', recommended: true }, { label: 'Sessenta dias', detail: 'prazo longo' }], subject: 'Prazo de entrega' }],
    ));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    const proposed = journal.events.filter((e) => e.type === RefineEvent.PatchProposed);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.data).toMatchObject({ file: 'project.md', role: 'po', cycle: 1 });
    expect(journal.state.questions).toEqual([expect.objectContaining({ questionId: 'po-s1-0', text: 'Qual o prazo?', blocking: true, status: 'pending' })]);
    expect(journal.events.some((e) => e.type === RefineEvent.DocsScored)).toBe(false);
    expect(journal.state.readiness).toBeUndefined();
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
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: REORGANIZE_FAILED, detail: 'bad json' });
    expect(journal.events.some((e) => e.type === RefineEvent.PatchProposed)).toBe(false);
  });

  it('a review that cannot be read fails the cycle without throwing, and nothing is proposed', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => { throw new Error('agent down'); });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'A revisão de project.md parou por um erro interno. Clique em Reavaliar.', detail: 'agent down' });
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
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: REVIEW_FAILED, detail: 'bad json' });
  });

  it('a schema failure is tried once more, and the stage goes on when the retry answers', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const failed = { ok: false, failure: 'schema', errors: ['bad json'], summary: undefined, sandboxDisabled: false };
    const runAgent = vi.fn().mockResolvedValueOnce(failed).mockResolvedValue(answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(journal.events.some((e) => e.type === RefineEvent.CycleFailed)).toBe(false);
  });

  it('a stage that fails twice on the schema stops with a plain reason, and the raw answer stays out of it', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const failed = { ok: false, failure: 'schema', errors: ['no JSON object in the agent result: from":"docs/flow.md"'], summary: undefined, sandboxDisabled: false };
    const runAgent = vi.fn(async () => failed);
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(runAgent).toHaveBeenCalledTimes(2);
    const data = journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data;
    expect(data).toMatchObject({ cycle: 1, reason: REORGANIZE_FAILED });
    expect(String(data?.reason)).not.toContain('from":');
  });

  it('a review that fails the schema is tried once more, and the retried answer is the one recorded', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const failed = { ok: false, failure: 'schema', errors: ['bad json'], summary: undefined, sandboxDisabled: false };
    const retried = answer(
      [{ file: 'docs/project.md', find: '# Shop', replace: '# Shop Online', reason: 'nome' }],
      [{ id: 'q1', text: 'Qual o prazo?', blocking: true, relatedAcIds: [], options: [], subject: 'Prazo de entrega' }],
    );
    const reviews = [failed, retried];
    const runAgent = vi.fn(async (req: { pack: { feedback?: string } }) => ((req.pack.feedback ?? '').includes('(reorganize in full)') ? answer([]) : reviews.shift()));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.some((e) => e.type === RefineEvent.CycleFailed)).toBe(false);
    expect(journal.events.filter((e) => e.type === RefineEvent.PatchProposed)).toHaveLength(1);
    expect(journal.events.find((e) => e.type === RefineEvent.StageReviewed)?.data).toMatchObject({ questions: [expect.objectContaining({ text: 'Qual o prazo?' })] });
    expect(String(runAgent.mock.calls[2]?.[0]?.pack?.feedback)).toContain('did not match the output schema: bad json');
  });

  it('a pack that is too large fails the stage with its own message', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const message = 'Reduza ou divida o conteúdo dos documentos.';
    const runAgent = vi.fn(async () => { throw new PackTooLargeError(message); });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: message, detail: message });
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

  it('a finding that cites a document by its spec folder path is kept under the document name', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    await writeDoc(draft, 'briefing.md', '# Briefing\n\nO pedido fecha em dois dias.\n');
    const finding = { doc: `docs/specs/${draft.specId}/briefing.md`, severity: 'advice', quote: 'O pedido fecha em dois dias.', text: 'texto', fix: 'corrigir' };
    await runStageCycle({ draft, journal, runAgent: vi.fn(async () => answer([], [], [], [finding])) as never, principles: () => [] }, 1, 'stack.md');
    expect(journal.state.findings).toEqual([expect.objectContaining({ doc: 'briefing.md', quote: 'O pedido fecha em dois dias.' })]);
  });

  it('a forward move cited from the briefing in its spec folder is applied', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    await writeDoc(draft, 'briefing.md', '# Briefing\n\nRegra de prazo: trinta dias.\n');
    await writeDoc(draft, 'stack.md', '# Pilha\n\nNode.js.\n');
    const move = { from: `docs/specs/${draft.specId}/briefing.md`, to: 'docs/stack.md', quote: 'Regra de prazo: trinta dias.', text: 'Regra de prazo: trinta dias.', reason: 'r' };
    await runStageCycle({ draft, journal, runAgent: passes(answer([], [], [], [], [move]), answer([])) as never, principles: () => [] }, 1, 'briefing.md');
    expect(journal.events.some((e) => e.type === RefineEvent.DocMoved)).toBe(true);
  });

  it('the review names its document by the bare name, which a patch may cite', () => {
    const docs = { 'flow.md': '# Fluxo', 'project.md': '# Shop', 'briefing.md': '# Briefing', 'stack.md': '# Stack', 'design.md': '# Design' };
    const pack = stageReviewPack({ role: 'po', specHash: 'h', principles: [], file: 'briefing.md', docs });
    expect(pack.feedback).toMatch(/^You review only briefing\.md,/);
  });

  it('a patch that cites the stage document by its bare name is proposed', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    await writeDoc(draft, 'briefing.md', '# Briefing\n\nO pedido fecha em dois dias.\n');
    const patch = { file: 'briefing.md', find: 'O pedido fecha em dois dias.', replace: 'O pedido fecha em três dias.', reason: 'prazo' };
    await runStageCycle({ draft, journal, runAgent: passes(answer([]), answer([patch])) as never, principles: () => [] }, 1, 'briefing.md');
    expect(journal.events.find((e) => e.type === RefineEvent.PatchProposed)?.data).toMatchObject({ file: 'briefing.md' });
  });

  it('a stage review keeps the findings of the documents it does not cover, and replaces those of the documents it covers', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    await writeDoc(draft, 'flow.md', '# Fluxo\n\nO cliente paga.\n');
    const finding = (doc: string, quote: string, text: string) => ({ doc, severity: 'advice', quote, text, fix: 'corrigir' });
    await runStageCycle({ draft, journal, runAgent: vi.fn(async () => answer([], [], [], [finding('project.md', '# Shop', 'do projeto')])) as never, principles: () => [] }, 1, 'briefing.md');
    await runStageCycle({ draft, journal, runAgent: vi.fn(async () => answer([], [], [], [finding('flow.md', 'O cliente paga.', 'do fluxo')])) as never, principles: () => [] }, 2, 'flow.md');
    expect(journal.state.findings.map((f) => f.text).sort()).toEqual(['do fluxo', 'do projeto']);
  });

  it('the Jev reads the stage with the documents before it, and the first stage is not sent to it', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const validate = vi.fn(async (_docs: unknown) => ({ available: true, decision: 'review', consistent: true, confidence: 0.9, model: 'jev', checks: {}, stateTruncated: false }));
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, validateDocs: validate as never, principles: () => [] }, 1, 'briefing.md');
    expect(validate).toHaveBeenCalledTimes(1);
    const sent = validate.mock.calls[0]![0] as unknown as Record<string, string>;
    expect(validate).toHaveBeenCalledWith(expect.anything(), 'briefing.md');
    expect(sent.project).toContain('# Shop');
    expect(sent).toMatchObject({ stack: '', design: '' });
    expect(journal.events.find((e) => e.type === RefineEvent.DocsValidated)?.data).toMatchObject({ stage: 'briefing.md' });
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
    const review = runAgent.mock.calls.map(([req]) => (req as { pack: { feedback: string } }).pack.feedback).find((f) => f.includes('### briefing.md (this stage)'))!;
    expect(review).not.toContain('FIM-DO-PROJETO');
    expect(review).toContain('FIM-DO-BRIEFING');
    expect(review).toContain('(context only, a digest)');
  });

  it('the Jev scores set no goal for a stage: the review gets them only as an index', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: false, skipped: false, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.9, scoped: 0.9 } } } } as never;
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    const reorganization = (runAgent.mock.calls[0]![0] as { pack: { feedback: string } }).pack.feedback;
    const review = (runAgent.mock.calls[1]![0] as { pack: { feedback: string } }).pack.feedback;
    for (const text of [reorganization, review]) {
      expect(text).not.toContain('### Jev goals');
      expect(text).not.toContain('JEV GOALS');
    }
  });

  it('gives the review the Jev scores of the document as an index, with no goal and no verdict', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: false, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.9, scoped: 0.9 } } } } as never;
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    const reorganization = (runAgent.mock.calls[0]![0] as { pack: { feedback: string } }).pack.feedback;
    const review = (runAgent.mock.calls[1]![0] as { pack: { feedback: string } }).pack.feedback;
    expect(review).toContain('### Jev index of this document (information only)\n\nScores of briefing.md, probability of yes: complete 0.50, concrete 0.90, consistent 0.90, scoped 0.90. They show where the Jev doubts the document; they are not a goal, a minimum or a verdict, and they can be wrong. Do not change the document only to raise a number.');
    expect(review).not.toContain('### Jev goals');
    expect(reorganization).not.toContain('Jev index');
    expect(reorganization).not.toContain('probability of yes');
  });

  it('gives the review no index when the project is confidential, as no Jev finding reaches a confidential project', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.confidential = true;
    journal.state.readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: false, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.9, scoped: 0.9 } } } } as never;
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect((runAgent.mock.calls[1]![0] as { pack: { feedback: string } }).pack.feedback).not.toContain('Jev index');
  });

  it('gives the review no index for a blank document, since its stored zeros were never answered by the Jev', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', '');
    const journal = foldingJournal();
    journal.state.readiness = { available: true, model: 'jev', average: 0, usage: null, outdated: false, docs: { 'briefing.md': { score: 0, checks: { complete: 0, concrete: 0, consistent: 0, scoped: 0 } } } } as never;
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect((runAgent.mock.calls[1]![0] as { pack: { feedback: string } }).pack.feedback).not.toContain('Jev index');
  });

  it('gives the review no index when the score is older than the last edit of the document', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: true, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.9, scoped: 0.9 } } } } as never;
    journal.state.outdatedDocs = ['briefing.md'];
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect((runAgent.mock.calls[1]![0] as { pack: { feedback: string } }).pack.feedback).not.toContain('Jev index');
  });

  it('gives the review one line per doubt, naming the place in the document', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: false, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.2, scoped: 0.4 }, doubts: [
      { check: 'consistent', value: 0.2, part: { index: 2, of: 2, from: '## Escopo', to: null } },
      { check: 'scoped', value: 0.4, part: null },
    ] } } } as never;
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    const review = (runAgent.mock.calls[1]![0] as { pack: { feedback: string } }).pack.feedback;
    expect(review).toContain('### Where the Jev doubts this document (information only)');
    expect(review).toContain('- consistent 0.20 in part 2 of 2, from "## Escopo": find two statements that disagree');
    expect(review).toContain('- scoped 0.40 in the whole document: find content the charter gives to another document');
  });

  it('gives the review no doubt line for a confidential or an outdated score', async () => {
    const readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: false, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.2, scoped: 0.4 }, doubts: [{ check: 'scoped', value: 0.4, part: null }] } } };
    const confidential = foldingJournal();
    confidential.state.confidential = true;
    confidential.state.readiness = readiness as never;
    const outdated = foldingJournal();
    outdated.state.outdatedDocs = ['briefing.md'];
    outdated.state.readiness = { ...readiness, outdated: true } as never;
    for (const journal of [confidential, outdated]) {
      const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
      await runStageCycle({ draft: await newDraft(), journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
      expect((runAgent.mock.calls[1]![0] as { pack: { feedback: string } }).pack.feedback).not.toContain('Where the Jev doubts');
    }
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
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'A revisão de project.md parou por um erro interno. Clique em Reavaliar.', detail: 'agent stopped' });
  });
});
