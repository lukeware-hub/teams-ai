import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyRefineEvent, emptyRefineState } from '../../server/refine/state.js';
import { createNewProject, draftPaths, readDoc, writeDoc } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { runStageCycle, stageReviewPack } from '../../server/refine/stage-cycle.js';
import type { DocFile } from '../../server/refine/draft.js';
import { fileGraphDir } from '../../server/refine/stage-consult.js';
import { PackTooLargeError } from '../../server/refine/fit-pack.js';
import { reshapeBackup } from '../../server/refine/reshape.js';
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

const REVIEW_FAILED = 'A revisão de project.md não devolveu o resultado em formato válido. Clique em Processar com agentes.';

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

  it('refuses a long document the algorithm cannot lay out, and says why', async () => {
    const draft = await newDraft();
    const big = `${LOOSE_BRIEF}\n${'- Regra de negócio.\n'.repeat(4_000)}`;
    await writeDoc(draft, 'briefing.md', big);
    const journal = foldingJournal();
    const runAgent = agentFor(() => reshaped(SHAPED_BRIEF));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(suggestCalls(runAgent)).toHaveLength(0);
    expect(await readDoc(draft, 'briefing.md')).toBe(big);
    expect(stageReviewed(journal)).toMatchObject({ discardedPatches: [{ role: 'po', file: 'briefing.md', reason: expect.stringMatching(/texto do modelo: <item>/) }] });
  });

  it('lays out a long document by its template, with no agent answer', async () => {
    const draft = await newDraft();
    const doc = `# Loja\n\n## 1. Proposta de valor\n\nVender roupas online.\n\n## 2. Usuários e atores\n\n- Cliente: compra roupas.\n\n## 9. Registro\n\n${'Registro de fato, linha longa. '.repeat(3_000)}\n`;
    await writeDoc(draft, 'project.md', doc);
    const journal = foldingJournal();
    const runAgent = agentFor(() => reshaped(SHAPED_BRIEF));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(suggestCalls(runAgent)).toHaveLength(0);
    expect(journal.events.some((e) => e.type === RefineEvent.DocReshaped)).toBe(true);
    const laid = await readDoc(draft, 'project.md');
    expect(laid).toContain('## Vision\n\n#### 1. Proposta de valor');
    expect(laid.indexOf('## Vision')).toBeLessThan(laid.indexOf('## Personas'));
    expect(laid).toContain('Registro de fato, linha longa.');
  });

  it('refuses a reshape that drops most of the text, and keeps the file', async () => {
    const draft = await newDraft();
    const long = `${LOOSE_BRIEF}\n${'- Regra de negócio.\n'.repeat(200)}`;
    await writeDoc(draft, 'briefing.md', long);
    const journal = foldingJournal();
    const runAgent = agentFor(() => reshaped(SHAPED_BRIEF));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(suggestCalls(runAgent)).toHaveLength(2);
    expect(await readDoc(draft, 'briefing.md')).toBe(long);
    expect(stageReviewed(journal)).toMatchObject({ discardedPatches: [{ role: 'po', file: 'briefing.md', reason: expect.stringMatching(/perdeu conteúdo do documento/) }] });
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
    await journal.fact(RefineEvent.DocReshapeUndone, { reshapeId: 'reshape-c1-briefing' });
    await runStageCycle(deps, 2, 'briefing.md');
    expect(suggestCalls(runAgent)).toHaveLength(1);
    expect(await readDoc(draft, 'briefing.md')).toBe(LOOSE_BRIEF);
    await writeDoc(draft, 'briefing.md', '# Mudou\n\nTexto solto.\n');
    await runStageCycle(deps, 3, 'briefing.md');
    expect(suggestCalls(runAgent)).toHaveLength(2);
    expect(await readDoc(draft, 'briefing.md')).toBe(SHAPED_BRIEF);
  });

  it('reshapes the stage document only, with its own id and its own kept text', async () => {
    const draft = await newDraft();
    const looseStack = '# Stack\n\n## Notas\n\n- Node 22, React, SQLite e Vitest.\n';
    await writeDoc(draft, 'briefing.md', LOOSE_BRIEF);
    await writeDoc(draft, 'stack.md', looseStack);
    const journal = foldingJournal();
    await runStageCycle({ draft, journal, runAgent: agentFor(() => reshaped(SHAPED_BRIEF)) as never, principles: () => [] }, 1, 'briefing.md');
    expect(journal.state.reshapes.map((r) => [r.file, r.reshapeId])).toEqual([['briefing.md', 'reshape-c1-briefing']]);
    expect(await readFile(reshapeBackup(draft, 'reshape-c1-briefing'), 'utf8')).toBe(LOOSE_BRIEF);
    expect(await readDoc(draft, 'stack.md')).toBe(looseStack);
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
    // The heading of the shop changes its name: a change of structure, journaled with the flag; nothing applies it because of the flag.
    expect(proposed[0]!.data).toMatchObject({ file: 'project.md', role: 'po', cycle: 1, scopeChange: true });
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
    expect(frontAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 2, 'design.md');
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('a stack document is reviewed by the SM', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async (_req: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'stack.md');
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ role: 'sm' });
  });

  it('drops a suggestion that only cites a decision the stack document already states, and keeps a real one', async () => {
    const draft = await newDraft();
    const stack = '## Documentação\n\n- Swagger para documentar a API REST.\n\nSwagger\n';
    await writeDoc(draft, 'stack.md', stack);
    const journal = foldingJournal();
    const runAgent = vi.fn(async (req: { kind: string; pack: { feedback?: string } }) => {
      if (req.kind === 'suggest') return reshaped(stack);
      if ((req.pack.feedback ?? '').includes('(reorganize in full)')) return answer([]);
      return answer([
        { file: 'docs/stack.md', find: 'Swagger\n', replace: '- Swagger para documentar a API REST, conforme a decisão sm-s4-0.\n', reason: 'A decisão sm-s4-0 documenta a API.' },
        { file: 'docs/stack.md', find: '## Documentação', replace: '## Documentação e testes', reason: 'O título cobre também os testes.' },
      ]);
    });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'stack.md');
    expect(journal.events.filter((e) => e.type === RefineEvent.PatchProposed).map((e) => e.data.find)).toEqual(['## Documentação']);
  });

  it('tells the stage reviewer to propose only a change that says something new', () => {
    const docs = { 'project.md': '', 'briefing.md': '', 'stack.md': '## Stack\n', 'flow.md': '', 'design.md': '' };
    expect(stageReviewPack({ role: 'sm', specHash: 'h', principles: [], file: 'stack.md', docs, specId: 'shop-002', history: [], rejected: [] }).feedback).toContain('PATCH WORTH:');
  });

  it('a failed review fails the cycle with its reason, and changes nothing', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => ({ ok: false, failure: 'schema', errors: ['bad json'], summary: undefined, sandboxDisabled: false }));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: REVIEW_FAILED, detail: 'bad json' });
    expect(journal.events.some((e) => e.type === RefineEvent.PatchProposed)).toBe(false);
  });

  it('a review that cannot be read fails the cycle without throwing, and nothing is proposed', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => { throw new Error('agent down'); });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'A revisão de project.md parou por um erro interno. Clique em Processar com agentes.', detail: 'agent down' });
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

  it('a failed owner review fails the cycle with its reason', async () => {
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
    expect(runAgent).toHaveBeenCalledTimes(2);
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
    expect(data).toMatchObject({ cycle: 1, reason: REVIEW_FAILED });
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
    const runAgent = vi.fn(async (_req: { pack: { feedback?: string } }) => reviews.shift());
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.some((e) => e.type === RefineEvent.CycleFailed)).toBe(false);
    expect(journal.events.filter((e) => e.type === RefineEvent.PatchProposed)).toHaveLength(1);
    expect(journal.events.find((e) => e.type === RefineEvent.StageReviewed)?.data).toMatchObject({ questions: [expect.objectContaining({ text: 'Qual o prazo?' })] });
    expect(String(runAgent.mock.calls[1]?.[0]?.pack?.feedback)).toContain('did not match the output schema: bad json');
  });

  it('a pack that is too large fails the stage with its own message', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const message = 'Reduza ou divida o conteúdo dos documentos.';
    const runAgent = vi.fn(async () => { throw new PackTooLargeError(message); });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: message, detail: message });
  });

  it('a move never reaches another document: the stage changes its own document only', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const backward = { from: 'docs/project.md', to: 'docs/flow.md', quote: '# Shop', text: 'texto', reason: 'r' };
    const forward = { from: 'docs/project.md', to: 'docs/briefing.md', quote: '# Shop', text: 'texto', reason: 'r' };
    const otherDocument = { from: 'docs/flow.md', to: 'docs/briefing.md', quote: '# Flow', text: 'texto', reason: 'r' };
    await runStageCycle({ draft, journal, runAgent: passes(answer([], [], [], [], [backward, forward, otherDocument]), answer([])) as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.some((e) => e.type === RefineEvent.DocMoved)).toBe(false);
  });

  it('a move out of the stage document to an earlier one is one suggestion for both documents, and changes nothing before the owner accepts it', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const design = '# Design\n\n## Telas\n\nA junta tem prazo de 2 dias úteis.\n\n## Cores\n\nAzul.\n';
    const brief = '# Briefing\n\n## Regras de negócio\n\nPedido em até 30 dias.\n';
    await writeDoc(draft, 'design.md', design);
    await writeDoc(draft, 'briefing.md', brief);
    const move = { from: 'docs/design.md', to: `docs/specs/${draft.specId}/briefing.md`, quote: 'A junta tem prazo de 2 dias úteis.', text: 'A junta tem prazo de 2 dias úteis.', after: 'Pedido em até 30 dias.', keep: 'A tela mostra o prazo da junta.', reason: 'regra de negócio' };
    const runAgent = vi.fn(async (req: { kind: string }) => (req.kind === 'refine' ? answer([], [], [], [], [move]) : answer([])));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'design.md');
    expect(await readDoc(draft, 'design.md')).toBe(design);
    expect(await readDoc(draft, 'briefing.md')).toBe(brief);
    expect(journal.state.patches).toEqual([expect.objectContaining({ status: 'pending', file: 'design.md', find: move.quote, replace: move.keep, reason: 'Move para briefing.md: regra de negócio', also: { file: 'briefing.md', find: move.after, replace: expect.stringContaining(`${move.after}\n\n${move.text}`) } })]);
    expect(journal.state.patches[0]!.diff).toMatch(/design\.md[\s\S]*-A junta[\s\S]*briefing\.md[\s\S]*\+A junta/);
  });

  it('a move to a later document, out of another document, or that loses a number is discarded with its reason', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    await writeDoc(draft, 'project.md', '# Projeto\n\nO gestor aprova.\n');
    await writeDoc(draft, 'briefing.md', '# Briefing\n\nPrazo de 30 dias.\n\nUsa Postgres 16.\n');
    await writeDoc(draft, 'stack.md', '# Pilha\n\nNode.js.\n');
    const later = { from: 'briefing.md', to: 'docs/stack.md', quote: 'Usa Postgres 16.', text: 'Usa Postgres 16.', reason: 'r' };
    const other = { from: 'docs/project.md', to: 'docs/flow.md', quote: 'O gestor aprova.', text: 'O gestor aprova.', reason: 'r' };
    const lossy = { from: 'briefing.md', to: 'docs/project.md', quote: 'Prazo de 30 dias.', text: 'Prazo curto.', reason: 'r' };
    const runAgent = vi.fn(async (req: { kind: string }) => (req.kind === 'refine' ? answer([], [], [], [], [later, other, lossy]) : answer([])));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(journal.state.patches).toEqual([]);
    const reasons = (stageReviewed(journal)!.discardedPatches as Array<{ reason: string }>).map((d) => d.reason).filter((r) => r.startsWith('Movimento'));
    expect(reasons).toEqual([
      'Movimento descartado: Esta etapa só move trechos de briefing.md para um documento anterior.',
      'Movimento descartado: Esta etapa só move trechos de briefing.md para um documento anterior.',
      'Movimento descartado: o texto perde "30" do trecho',
    ]);
  });

  it('tells the reviewer it may move content only to the documents before its stage', () => {
    const pack = stageReviewPack({ role: 'front', specHash: 'h', principles: [], file: 'design.md', docs: { 'project.md': '', 'briefing.md': '', 'stack.md': '', 'flow.md': '', 'design.md': '# D' }, specId: 's', history: [], rejected: [] });
    expect(pack.feedback).toContain('a document before it (flow.md, project.md, briefing.md, stack.md) is a move');
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

  it('a move cited from the stage document in its spec folder is not applied to a later document', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    await writeDoc(draft, 'briefing.md', '# Briefing\n\nRegra de prazo: trinta dias.\n');
    await writeDoc(draft, 'stack.md', '# Pilha\n\nNode.js.\n');
    const move = { from: `docs/specs/${draft.specId}/briefing.md`, to: 'docs/stack.md', quote: 'Regra de prazo: trinta dias.', text: 'Regra de prazo: trinta dias.', reason: 'r' };
    await runStageCycle({ draft, journal, runAgent: passes(answer([], [], [], [], [move]), answer([])) as never, principles: () => [] }, 1, 'briefing.md');
    expect(journal.events.some((e) => e.type === RefineEvent.DocMoved)).toBe(false);
    expect(await readDoc(draft, 'stack.md')).toBe('# Pilha\n\nNode.js.\n');
  });

  it('the review names its document by the bare name, which a patch may cite', () => {
    const docs = { 'flow.md': '# Fluxo', 'project.md': '# Shop', 'briefing.md': '# Briefing', 'stack.md': '# Stack', 'design.md': '# Design' };
    const pack = stageReviewPack({ role: 'po', specHash: 'h', principles: [], file: 'briefing.md', docs, specId: 'shop-002', history: [], rejected: [] });
    expect(pack.feedback).toMatch(/^You review only briefing\.md,/);
  });

  it('a stage question that repeats a decision the owner gave is dropped and kept on record, not put to the owner', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const question = (questionId: string, role: 'po' | 'sm', text: string) => ({ questionId, role, text, blocking: false, relatedAcIds: [], cycle: 1 });
    await journal.fact(RefineEvent.StageReviewed, { cycle: 1, file: 'project.md', questions: [question('po-s1-0', 'po', 'Qual o prazo do link de recuperação?')], divergences: [], discardedPatches: [] });
    await journal.fact(RefineEvent.QuestionAnswered, { questionId: 'po-s1-0', text: 'Noventa dias' });
    const runAgent = passes(answer([]), answer([], [{ text: 'Até quando o link de recuperação vale?', blocking: false, relatedAcIds: [], options: [] }]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 2, 'briefing.md');
    const reviewed = journal.events.filter((e) => e.type === RefineEvent.StageReviewed).at(-1)!.data;
    expect(reviewed.questions).toEqual([]);
    expect(journal.events.find((e) => e.type === RefineEvent.QuestionDropped)!.data).toMatchObject({ text: 'Até quando o link de recuperação vale?', file: 'briefing.md', matchedQuestionId: 'po-s1-0', matchedAnswer: 'Noventa dias' });
  });

  it('a stage question that repeats a decision is kept when its distinctFrom names a real difference', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const question = (questionId: string, role: 'po' | 'sm', text: string) => ({ questionId, role, text, blocking: false, relatedAcIds: [], cycle: 1 });
    await journal.fact(RefineEvent.StageReviewed, { cycle: 1, file: 'project.md', questions: [question('po-s1-0', 'po', 'Qual o prazo do link de recuperação?')], divergences: [], discardedPatches: [] });
    await journal.fact(RefineEvent.QuestionAnswered, { questionId: 'po-s1-0', text: 'Noventa dias' });
    const distinctFrom = [{ questionId: 'po-s1-0', difference: 'Vale até o fim do prazo de envio, não por noventa dias corridos.' }];
    const runAgent = passes(answer([]), answer([], [{ text: 'Até quando o link de recuperação vale?', blocking: false, relatedAcIds: [], options: [], distinctFrom }]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 2, 'briefing.md');
    const reviewed = journal.events.filter((e) => e.type === RefineEvent.StageReviewed).at(-1)!.data;
    expect(reviewed.questions).toEqual([expect.objectContaining({ text: 'Até quando o link de recuperação vale?', distinctFrom })]);
    expect(journal.events.some((e) => e.type === RefineEvent.QuestionDropped)).toBe(false);
  });

  it('the review pack carries the answers, skips and open questions of the draft, and the patches it rejected', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const question = (questionId: string, role: 'po' | 'sm', text: string) => ({ questionId, role, text, blocking: false, relatedAcIds: [], cycle: 1 });
    await journal.fact(RefineEvent.StageReviewed, { cycle: 1, file: 'project.md', questions: [question('po-s1-0', 'po', 'Quem usa?'), question('sm-s1-0', 'sm', 'Qual porta?'), question('po-s1-1', 'po', 'Qual prazo?')], divergences: [], discardedPatches: [] });
    await journal.fact(RefineEvent.QuestionAnswered, { questionId: 'po-s1-0', text: 'Equipe interna' });
    await journal.fact(RefineEvent.QuestionSkipped, { questionId: 'sm-s1-0' });
    await journal.fact(RefineEvent.PatchProposed, { patchId: 'po-c1-0', role: 'po', file: 'briefing.md', find: 'velho', replace: 'novo', reason: 'r', diff: '', cycle: 1, scopeChange: false });
    await journal.fact(RefineEvent.PatchRejected, { patchId: 'po-c1-0', reason: 'não' });
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 2, 'briefing.md');
    const feedback = runAgent.mock.calls.map(([req]) => (req as { pack?: { feedback?: string } }).pack?.feedback ?? '').find((f) => f.includes('### briefing.md (this stage)')) ?? '';
    expect(feedback).toContain('### Answered questions (do not ask again)\n\n- [po] Quem usa?\n  id: po-s1-0\n  answer: Equipe interna');
    expect(feedback).toContain('### Skipped questions\n\n- [sm] Qual porta?');
    expect(feedback).toContain('### Open questions (waiting for the owner: do not ask again, not even reworded)\n\n- [po] Qual prazo?');
    expect(feedback).toContain('### Rejected patches (do not propose again)\n\n- docs/specs/shop-002/briefing.md: "velho" → rejected: não');
  });

  it('a stage review pack says none under each history heading when the draft has no history', () => {
    const docs = { 'flow.md': '# Fluxo', 'project.md': '# Shop', 'briefing.md': '# Briefing', 'stack.md': '# Stack', 'design.md': '# Design' };
    const feedback = stageReviewPack({ role: 'po', specHash: 'h', principles: [], file: 'briefing.md', docs, specId: 'shop-002', history: [], rejected: [] }).feedback ?? '';
    expect(feedback).toContain('### Answered questions (do not ask again)\n\n(none)');
    expect(feedback).toContain('### Rejected patches (do not propose again)\n\n(none)');
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

  it('a patch to a document outside the stage is discarded, with its reason, and never proposed', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    await writeDoc(draft, 'flow.md', '# Fluxo\n\nO cliente paga.\n');
    const patch = { file: 'flow.md', find: 'O cliente paga.', replace: 'O cliente paga agora.', reason: 'prazo' };
    await runStageCycle({ draft, journal, runAgent: vi.fn(async () => answer([patch])) as never, principles: () => [] }, 1, 'briefing.md');
    expect(journal.events.some((e) => e.type === RefineEvent.PatchProposed)).toBe(false);
    expect(journal.events.find((e) => e.type === RefineEvent.StageReviewed)?.data.discardedPatches).toEqual([{ role: 'po', file: 'flow.md', reason: 'Esta etapa só altera briefing.md: o ajuste a flow.md foi descartado.' }]);
  });

  it('a stage review is asked with no tools and no earlier-stage Jev check', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ kind: 'refine', review: true });
    expect(journal.events.some((e) => e.type === RefineEvent.DocsValidated)).toBe(false);
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
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('the other documents reach the review only as the excerpts that match the part, never whole', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    await writeDoc(draft, 'project.md', `# Shop\n\n## Entrega\n\nO briefing aprova cada entrega.\n\n## Outro\n\n${'palavra '.repeat(1000)}FIM-DO-PROJETO\n`);
    await writeDoc(draft, 'briefing.md', '# Briefing\n\nFIM-DO-BRIEFING');
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    const review = runAgent.mock.calls.map(([req]) => (req as { pack: { feedback: string } }).pack.feedback).find((f) => f.includes('### briefing.md (this stage)'))!;
    expect(review).toContain('O briefing aprova cada entrega.');
    expect(review).not.toContain('FIM-DO-PROJETO');
    expect(review).toContain('FIM-DO-BRIEFING');
    expect(review).not.toContain('a digest');
  });

  it('a long excerpt of another document that matches the part is cut at its limit', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    await writeDoc(draft, 'flow.md', `# Fluxo\n\n## Etapa\n\n${'palavra '.repeat(400)}FIM-DO-FLUXO\n`);
    await writeDoc(draft, 'project.md', '# Projeto\n\nA etapa do projeto.');
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    const review = runAgent.mock.calls.map(([req]) => (req as { pack: { feedback: string } }).pack.feedback).find((f) => f.includes('### project.md (this stage)'))!;
    expect(review).toContain('flow.md › Etapa');
    expect(review).not.toContain('FIM-DO-FLUXO');
    expect(review).toContain('[…]');
  });

  it('the other documents are asked of the graph of each one, in its own folder, and never of the stage document', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const graphNotes = vi.fn(async (dir: string) => `NOTA DE ${dir}`);
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], graphNotes }, 1, 'briefing.md');
    const asked = graphNotes.mock.calls.map(([dir]) => dir).sort();
    expect(asked).toEqual(['flow.md', 'project.md', 'stack.md', 'design.md'].map((f) => fileGraphDir(draft.root, f as DocFile)).sort());
    const review = (runAgent.mock.calls[0]![0] as { pack: { feedback: string } }).pack.feedback;
    expect(review).toContain(`NOTA DE ${fileGraphDir(draft.root, 'flow.md')}`);
  });

  it('the Jev scores set no goal for a stage: the review gets them only as an index', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: false, skipped: false, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.9 } } } } as never;
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    const review = (runAgent.mock.calls[0]![0] as { pack: { feedback: string } }).pack.feedback;
    for (const text of [review]) {
      expect(text).not.toContain('### Jev goals');
      expect(text).not.toContain('JEV GOALS');
    }
  });

  it('gives the review the Jev scores of the document as an index, with no goal and no verdict', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: false, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.9 } } } } as never;
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    const review = (runAgent.mock.calls[0]![0] as { pack: { feedback: string } }).pack.feedback;
    expect(review).toContain('### Jev index of this document (information only)\n\nScores of briefing.md, probability of yes: complete 0.50, concrete 0.90, consistent 0.90. They show where the Jev doubts the document; they are not a verdict and they can be wrong; a low score only means read the doubts below with care. Do not change the document only to raise a number.');
    expect(review).not.toContain('### Jev goals');
  });

  it('gives the review no index when the project is confidential, as no Jev finding reaches a confidential project', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.confidential = true;
    journal.state.readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: false, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.9 } } } } as never;
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect((runAgent.mock.calls[0]![0] as { pack: { feedback: string } }).pack.feedback).not.toContain('Jev index');
  });

  it('gives the review no index for a blank document, since its stored zeros were never answered by the Jev', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', '');
    const journal = foldingJournal();
    journal.state.readiness = { available: true, model: 'jev', average: 0, usage: null, outdated: false, docs: { 'briefing.md': { score: 0, checks: { complete: 0, concrete: 0, consistent: 0 } } } } as never;
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect((runAgent.mock.calls[0]![0] as { pack: { feedback: string } }).pack.feedback).not.toContain('Jev index');
  });

  it('gives the review no index when the score is older than the last edit of the document', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: true, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.9 } } } } as never;
    journal.state.outdatedDocs = ['briefing.md'];
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect((runAgent.mock.calls[0]![0] as { pack: { feedback: string } }).pack.feedback).not.toContain('Jev index');
  });

  it('gives the review one line per doubt, naming the place in the document', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    journal.state.readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: false, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.2 }, doubts: [
      { check: 'consistent', value: 0.2, part: { index: 2, of: 2, from: '## Escopo', to: null } },
      { check: 'complete', value: 0.5, part: null },
    ] } } } as never;
    const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    const review = (runAgent.mock.calls[0]![0] as { pack: { feedback: string } }).pack.feedback;
    expect(review).toContain('### Where the Jev doubts this document (information only)');
    expect(review).toContain('- consistent 0.20 in part 2 of 2, from "## Escopo": find two statements that disagree');
    expect(review).toContain('- complete 0.50 in the whole document: compare the document with the parts its purpose requires');
  });

  it('gives the review no doubt line for a confidential or an outdated score', async () => {
    const readiness = { available: true, model: 'jev', average: 0.5, usage: null, outdated: false, docs: { 'briefing.md': { score: 0.5, checks: { complete: 0.5, concrete: 0.9, consistent: 0.2 }, doubts: [{ check: 'consistent', value: 0.2, part: null }] } } };
    const confidential = foldingJournal();
    confidential.state.confidential = true;
    confidential.state.readiness = readiness as never;
    const outdated = foldingJournal();
    outdated.state.outdatedDocs = ['briefing.md'];
    outdated.state.readiness = { ...readiness, outdated: true } as never;
    for (const journal of [confidential, outdated]) {
      const runAgent = vi.fn(async (_req: unknown, _opts: unknown) => answer([]));
      await runStageCycle({ draft: await newDraft(), journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
      expect((runAgent.mock.calls[0]![0] as { pack: { feedback: string } }).pack.feedback).not.toContain('Where the Jev doubts');
    }
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
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'A revisão de project.md parou por um erro interno. Clique em Processar com agentes.', detail: 'agent stopped' });
  });
});

/** A stage document of `count` sections, each about 99 thousand characters: one part of the review each. */
const bigSections = (count: number) => Array.from({ length: count }, (_, i) => `## Parte ${i + 1}\n${`${'x'.repeat(999)}\n`.repeat(99)}`).join('');

describe('runStageCycle reviews a document too big for one part in parts', () => {
  it('reads each part in its own review, and merges what the parts propose', async () => {
    const draft = await newDraft();
    const doc = bigSections(3);
    await writeDoc(draft, 'briefing.md', doc);
    const journal = foldingJournal();
    const runAgent = vi.fn(async (req: { kind: string; pack: { feedback?: string } }) => {
      if (req.kind !== 'refine') return answer([]);
      const index = /part (\d) of 3/.exec(req.pack.feedback ?? '')?.[1];
      return answer(index ? [{ file: 'briefing.md', find: `## Parte ${index}`, replace: `## Parte ${index} revisada`, reason: 'r' }] : []);
    });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(runAgent.mock.calls.filter(([req]) => req.kind === 'refine')).toHaveLength(3);
    expect(journal.events.some((e) => e.type === RefineEvent.CycleFailed)).toBe(false);
    expect(journal.events.filter((e) => e.type === RefineEvent.PatchProposed)).toHaveLength(3);
    expect(journal.events.some((e) => e.type === RefineEvent.StageReviewed)).toBe(true);
    // The template's layout comes first, so the document is laid out; its three parts are all still in it.
    expect(await readDoc(draft, 'briefing.md')).toContain('## Parte 3');
  });

  it('asks again a part that ran past its time limit, and keeps the parts already read', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', bigSections(3));
    const journal = foldingJournal();
    let slowOnce = true;
    const runAgent = vi.fn(async (req: { kind: string; pack: { feedback?: string } }) => {
      if (req.kind !== 'refine') return answer([]);
      const index = /part (\d) of 3/.exec(req.pack.feedback ?? '')?.[1];
      if (index === '2' && slowOnce) {
        slowOnce = false;
        return { ok: false, failure: 'timeout', errors: [], summary: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, durationMs: 0, numTurns: 0, rateLimit: null }, sandboxDisabled: false };
      }
      return answer(index ? [{ file: 'briefing.md', find: `## Parte ${index}`, replace: `## Parte ${index} revisada`, reason: 'r' }] : []);
    });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(journal.events.some((e) => e.type === RefineEvent.CycleFailed)).toBe(false);
    expect(runAgent.mock.calls.filter(([req]) => req.kind === 'refine')).toHaveLength(4);
    expect(journal.events.filter((e) => e.type === RefineEvent.PatchProposed)).toHaveLength(3);
    expect(journal.events.some((e) => e.type === RefineEvent.StageReviewed)).toBe(true);
  });

  it('ends the round after its tries when a part keeps running past its time limit, and names the part', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', bigSections(3));
    const journal = foldingJournal();
    const timeout = { ok: false, failure: 'timeout', errors: [], summary: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, durationMs: 0, numTurns: 0, rateLimit: null }, sandboxDisabled: false };
    const runAgent = vi.fn(async (req: { kind: string; pack: { feedback?: string } }) => {
      if (req.kind !== 'refine') return answer([]);
      return /part 2 of 3/.test(req.pack.feedback ?? '') ? timeout : answer([]);
    });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    const failed = journal.events.find((e) => e.type === RefineEvent.CycleFailed);
    expect(failed?.data).toMatchObject({ cycle: 1, reason: expect.stringMatching(/parte 2 de 3 de briefing\.md passou do tempo limite/) });
    expect(runAgent.mock.calls.filter(([req]) => req.kind === 'refine' && /part 2 of 3/.test((req as { pack: { feedback?: string } }).pack.feedback ?? ''))).toHaveLength(3);
    expect(runAgent.mock.calls.some(([req]) => /part 3 of 3/.test((req as { pack: { feedback?: string } }).pack.feedback ?? ''))).toBe(false);
  });

  it('a stage review that times out names the Processar com agentes button, which the stage wizard shows', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const timeout = { ok: false, failure: 'timeout', errors: [], summary: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, durationMs: 0, numTurns: 0, rateLimit: null }, sandboxDisabled: false };
    const runAgent = vi.fn(async (req: { kind: string; pack: { feedback?: string } }) => (req.kind === 'refine' && !(req.pack.feedback ?? '').includes('(reorganize in full)') ? timeout : answer([])));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'A revisão de project.md passou do tempo limite. Clique em Processar com agentes.' });
  });

  it('does not ask a part again once the session is aborted', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', bigSections(3));
    const journal = foldingJournal();
    const ctl = new AbortController();
    const timeout = { ok: false, failure: 'timeout', errors: [], summary: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, durationMs: 0, numTurns: 0, rateLimit: null }, sandboxDisabled: false };
    const runAgent = vi.fn(async (req: { kind: string; pack: { feedback?: string } }) => {
      if (req.kind !== 'refine') return answer([]);
      if (!/part 2 of 3/.test(req.pack.feedback ?? '')) return answer([]);
      ctl.abort();
      return timeout;
    });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], signal: ctl.signal }, 1, 'briefing.md');
    expect(runAgent.mock.calls.filter(([req]) => req.kind === 'refine' && /part 2 of 3/.test((req as { pack: { feedback?: string } }).pack.feedback ?? ''))).toHaveLength(1);
  });

  it('refuses a document with more parts than one review may read, and says how many', async () => {
    const draft = await newDraft();
    await writeDoc(draft, 'briefing.md', bigSections(41));
    const journal = foldingJournal();
    const runAgent = agentFor(() => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'briefing.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: expect.stringMatching(/tem 41 partes; o limite é 40/) });
  });
});
