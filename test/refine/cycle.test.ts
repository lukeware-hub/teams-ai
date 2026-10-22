import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Decider } from '../../server/decide/decider.js';
import { heldForOwner } from '../../server/refine/auto-floor.js';
import { buildContextPack } from '../../server/knowledge/context-pack.js';
import { failedGapQuestions, runCycle, type CycleDeps } from '../../server/refine/cycle.js';
import { PACK_TOKEN_CAP } from '../../server/refine/fit-pack.js';
import { draftPaths, createNewProject } from '../../server/refine/draft.js';
import { applyRefineEvent, emptyRefineState, type RefineState } from '../../server/refine/state.js';
import { summarizeJevChecks, type JevValidationResult, type ValidationDocs } from '../../server/refine/jev-validation.js';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';

describe('refinement cycle Jev advisory', () => {
  it('passes grave document findings to the agents without blocking derivation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'demo',
      specId: 'demo-001',
      root,
      docs,
      projectMd: path.join(docs, 'project.md'),
      projectJson: path.join(docs, 'project.json'),
      briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'),
      flowMd: path.join(docs, 'flow.md'),
      designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'),
      events: path.join(root, 'events.ndjson'),
      steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([
      writeFile(draft.projectMd, '# Project'),
      writeFile(draft.briefMd, '# Brief'),
      writeFile(draft.stackMd, '# Stack'),
      writeFile(draft.flowMd, '# Flow'),
      writeFile(draft.designMd, '# Design'),
    ]);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = {
      state: emptyRefineState(),
      allocStepSeq: () => 1,
      fact: async (type: string, data: Record<string, unknown>) => {
        events.push({ type, data });
        return { seq: events.length, at: '', runId: 'demo/demo-001', specHash: 'draft', type, kind: 'fact' as const, data };
      },
    };
    const runAgent = vi.fn().mockResolvedValue({ ok: false, failure: 'test', errors: [], summary: {}, sandboxDisabled: false });
    await runCycle({
      draft,
      journal,
      runAgent: runAgent as never,
      principles: () => [],
      retrieval: () => [],
      validateDocs: async () => ({ available: true, decision: 'blocked' as const, consistent: false, confidence: 0.99, model: 'jev', checks: { documents_consistent: 0.2 }, stateTruncated: false }),
    }, 1);
    expect(events.some((event) => event.type === 'REFINE_DOCS_VALIDATED')).toBe(true);
    expect(events.some((event) => event.type === 'REFINE_CYCLE_FAILED' && String(event.data.reason).startsWith('Jev bloqueou'))).toBe(false);
    expect(runAgent).toHaveBeenCalledOnce();
  });
});

describe('refinement cycle: moves, findings and template fills', () => {
  const MOVED = 'O cliente confirma o pedido antes do pagamento.';
  /** Runs one cycle of a new project whose project.md holds MOVED; flow.md is a diagram unless `blankFlow` keeps the blank template. */
  async function run(poOutput: { moves?: unknown[]; findings?: unknown[] }, smOutput: { moves?: unknown[]; docPatch?: unknown[] }, { blankFlow = false, projectMd = `# Shop\n\n## Visão\n\nLoja online.\n\n${MOVED}\n`, mode = null, scoreDocs }: { blankFlow?: boolean; projectMd?: string; mode?: RefineState['mode']; scoreDocs?: CycleDeps['scoreDocs'] } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const ws = { projectId: 'shop', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` } as Workspace;
    const draft = draftPaths(ws, 'shop-002');
    await createNewProject(draft, 'Shop');
    await writeFile(draft.projectMd, projectMd);
    if (!blankFlow) await writeFile(draft.flowMd, '# Fluxo\n\n```mermaid\nflowchart TD\n  A --> B\n```\n');
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: { ...emptyRefineState(), mode },allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'shop/shop-002', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const runAgent = vi.fn(async (req: { kind: string; role: string; pack?: { feedback?: string } }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...makeSpec(), specId: 'shop-002', acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't2', smoke: false }] } });
      if (String(req.pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [], ...poOutput });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [], ...smOutput });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], scoreDocs }, 1);
    return { events, draft };
  }
  const move = { from: 'docs/project.md', to: 'docs/flow.md', quote: MOVED, text: MOVED, reason: 'ordem de passos' };

  it('applies a move before the patches are checked, so a suggestion quoting the moved text is discarded', async () => {
    const { events, draft } = await run({ moves: [move] }, { docPatch: [{ file: 'docs/project.md', find: 'O cliente confirma o pedido', replace: 'O cliente paga', reason: 'r' }] });
    expect(events.find((e) => e.type === 'DOC_MOVED')?.data).toMatchObject({ moveId: 'move-po-c1-0', from: 'project.md', to: 'flow.md' });
    expect(await readFile(draft.projectMd, 'utf8')).not.toContain(MOVED);
    expect(await readFile(draft.flowMd, 'utf8')).toContain(MOVED);
    expect(events.some((e) => e.type === 'PATCH_PROPOSED' && e.data.role === 'sm')).toBe(false);
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    expect(evaluated.data.discardedPatches).toContainEqual({ role: 'sm', file: 'docs/project.md', reason: 'find not found in project.md' });
  });

  it('refuses a move a second role repeats, since its quote is already gone, so the text moves once', async () => {
    const { events, draft } = await run({ moves: [move] }, { moves: [move] });
    expect(events.filter((e) => e.type === 'DOC_MOVED').map((e) => e.data.moveId)).toEqual(['move-po-c1-0']);
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    expect(evaluated.data.discardedPatches).toContainEqual({ role: 'sm', file: 'docs/project.md', reason: 'o trecho deve ser linhas inteiras encontradas uma vez em project.md' });
    expect((await readFile(draft.flowMd, 'utf8')).split(MOVED).length - 1).toBe(1);
  });

  it('discards the fourth move of one role in a cycle, and the first three still apply', async () => {
    const quotes = ['Linha A.', 'Linha B.', 'Linha C.', 'Linha D.'];
    const moves = quotes.map((quote) => ({ from: 'docs/project.md', to: 'docs/flow.md', quote, text: quote, reason: 'r' }));
    const { events } = await run({ moves }, {}, { projectMd: `# Shop\n\n${quotes.join('\n\n')}\n` });
    expect(events.filter((e) => e.type === 'DOC_MOVED').map((e) => e.data.moveId)).toEqual(['move-po-c1-0', 'move-po-c1-1', 'move-po-c1-2']);
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    expect(evaluated.data.discardedPatches).toContainEqual({ role: 'po', file: 'docs/project.md', reason: 'mais de 3 movimentos em um ciclo' });
  });

  it('keeps a finding only when its quote is in the document it names', async () => {
    const shown = { doc: 'design.md', severity: 'advice', quote: '## Brand and direction', text: 'Falta a paleta.', fix: 'Defina as cores.' };
    const { events } = await run({ findings: [shown, { ...shown, quote: 'um trecho que não existe' }] }, {});
    expect(events.find((e) => e.type === 'FINDINGS_REPORTED')?.data.findings).toEqual([{ cycle: 1, role: 'po', doc: 'design.md', severity: 'advice', quote: '## Brand and direction', text: 'Falta a paleta.', fix: 'Defina as cores.' }]);
  });

  it('fills a blank stack.md only when it keeps the template headings; otherwise it is a patch for the human', async () => {
    const { events, draft } = await run({}, { docPatch: [{ file: 'docs/stack.md', find: '# Stack', replace: '# Stack\n\n- Node 22\n', reason: 'r' }] }, { blankFlow: true });
    expect(await readFile(draft.stackMd, 'utf8')).not.toContain('Node 22');
    expect(events.find((e) => e.type === 'PATCH_PROPOSED')?.data).toMatchObject({ role: 'sm', file: 'stack.md' });
  });

  it('fills a blank flow.md only with a diagram; any other text stays a patch for the human', async () => {
    const fill = (replace: string) => ({ file: 'docs/flow.md', find: '# Application flow', replace, reason: 'r' });
    const prose = await run({}, { docPatch: [fill('# Fluxo\n\nTexto sem diagrama.\n')] }, { blankFlow: true });
    expect(await readFile(prose.draft.flowMd, 'utf8')).not.toContain('Texto sem diagrama');
    expect(prose.events.find((e) => e.type === 'PATCH_PROPOSED')?.data).toMatchObject({ role: 'sm', file: 'flow.md' });
    const diagram = await run({}, { docPatch: [fill('# Fluxo\n\n```mermaid\nflowchart TD\n  A --> B\n```\n')] }, { blankFlow: true });
    expect(await readFile(diagram.draft.flowMd, 'utf8')).toContain('flowchart TD');
    expect(diagram.events.some((e) => e.type === 'PATCH_PROPOSED')).toBe(false);
  });

  it('journals the score of the documents after the moves, and before the evaluation', async () => {
    const scoreDocs = vi.fn(async (_docs: Record<string, string>) => ({ available: true, model: 'jev-1.13.0', average: 0.9, docs: null, usage: null }));
    const { events } = await run({ moves: [move] }, {}, { mode: 'new-project', scoreDocs });
    const types = events.map((e) => e.type);
    expect(types.indexOf('REFINE_DOCS_SCORED')).toBeGreaterThan(-1);
    expect(types.indexOf('REFINE_DOCS_SCORED')).toBeLessThan(types.indexOf('REFINE_EVALUATED'));
    expect(scoreDocs.mock.calls[0]![0]['flow.md']).toContain(MOVED);
  });

  it('scores nothing for a single spec, which is neither a new project nor a backlog', async () => {
    const scoreDocs = vi.fn(async (_docs: Record<string, string>) => ({ available: true, model: 'jev-1.13.0', average: 0.9, docs: null, usage: null }));
    const { events } = await run({}, {}, { mode: 'new-spec', scoreDocs });
    expect(scoreDocs).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'REFINE_DOCS_SCORED')).toBe(false);
  });

  it('a scorer that fails journals the score as unavailable and leaves the evaluation standing', async () => {
    const scoreDocs = vi.fn(async (_docs: Record<string, string>): Promise<never> => { throw new Error('jev down'); });
    const { events } = await run({}, {}, { mode: 'new-project', scoreDocs });
    expect(events.find((e) => e.type === 'REFINE_DOCS_SCORED')?.data).toMatchObject({ available: false, average: null });
    expect(events.some((e) => e.type === 'REFINE_EVALUATED')).toBe(true);
    expect(events.some((e) => e.type === 'REFINE_CYCLE_FAILED')).toBe(false);
  });
});

describe('refinement cycle acceptance criterion ids (R11.8)', () => {
  it('numbers a new spec above a sibling spec already copied into the draft, instead of restarting at AC-001', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const ws = { projectId: 'shop', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` } as Workspace;
    const draft = draftPaths(ws, 'shop-002');
    await createNewProject(draft, 'Shop');
    // A sibling spec of the same project, copied from main into the draft the way createFromRepo does for a new spec.
    const siblingDir = path.join(draft.docs, 'specs', 'shop-001');
    await mkdir(siblingDir, { recursive: true });
    await writeFile(path.join(siblingDir, 'spec.json'), JSON.stringify({ ...makeSpec(), specId: 'shop-001', acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: false }] }));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'shop/shop-002', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const runAgent = vi.fn(async (req: { kind: string; role: string; pack?: { feedback?: string } }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...makeSpec(), specId: 'shop-002', acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't2', smoke: false }] } });
      if (String(req.pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [] }, 1);
    const derived = events.find((e) => e.type === 'DERIVED')!;
    const ids = (derived.data.spec as { acceptanceCriteria: Array<{ id: string }> }).acceptanceCriteria.map((c) => c.id);
    expect(ids).toEqual(['AC-002']);
  });
});

describe('refinement cycle flow.md must be mermaid (R11.11)', () => {
  const evaluate = async (flow: string, validateDocs?: (docs: ValidationDocs) => Promise<JevValidationResult>, po: Record<string, unknown> = {}) => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    await writeFile(draft.flowMd, flow);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [], ...po });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions', 'sm.flow-is-mermaid']), questions: [], docPatch: [] });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], validateDocs }, 1);
    return events.find((e) => e.type === 'REFINE_EVALUATED')!.data;
  };
  const build = async (flow: string, validateDocs?: (docs: ValidationDocs) => Promise<JevValidationResult>, id = 'sm.flow-is-mermaid') =>
    ((await evaluate(flow, validateDocs)).checklist as Array<{ id: string; passed: boolean; detail: string }>).find((i) => i.id === id)!;
  type Item = { id: string; passed: boolean; detail: string; divergences?: Array<{ fact: string; a: { file: string }; b: { file: string } }> };
  const contradictionOf = (data: Record<string, unknown>) => (data.checklist as Item[]).find((i) => i.id === 'po.no-contradictions')!;

  it('fails deterministically, overriding the agent, when flow.md has no mermaid fence', async () => {
    const item = await build('# Flow\n\n## 1. Checkout\n\nUser pays.\n');
    expect(item).toMatchObject({ passed: false });
    expect(item.detail).toMatch(/mermaid/);
  });

  it('passes when flow.md has a mermaid fence', async () => {
    const item = await build('# Flow\n\n```mermaid\nflowchart TD\n  A --> B\n```\n');
    expect(item).toMatchObject({ passed: true });
  });

  it('never fails po.no-contradictions because of the Jev; a doubt only goes into the detail', async () => {
    const seen: ValidationDocs[] = [];
    const jev = (consistent: number) => async (docs: ValidationDocs) => {
      seen.push(docs);
      return summarizeJevChecks({ documents_consistent: consistent }, 'jev');
    };
    const doubtful = await build('# Flow', jev(0.2), 'po.no-contradictions');
    expect(doubtful).toMatchObject({ passed: true });
    expect(doubtful.detail).toMatch(/Aviso do Jev \(automático, pode errar, não bloqueia\): duvidou da consistência \(0,20\)/);
    expect(await build('# Flow', jev(0.9), 'po.no-contradictions')).toMatchObject({ passed: true });
    expect(Object.keys(seen[0]!).sort()).toEqual(['briefing', 'design', 'flow', 'project', 'stack']);
  });

  it('fails po.no-contradictions when the documents hold both quotes of a divergence, and locates it', async () => {
    const flow = '# Flow\n\n## 1. Checkout\n\nUser pays by card.\n\n## 2. Payment\n\nUser pays by cash.\n';
    const data = await evaluate(flow, undefined, {
      checklist: [{ id: 'po.no-contradictions', passed: true, detail: 'ok' }],
      contradictions: [{ fact: 'pagamento', a: { file: 'flow.md', quote: 'User pays by card' }, b: { file: 'flow.md', quote: 'User pays by cash' }, fix: 'Mantenha um meio de pagamento.' }],
    });
    expect(contradictionOf(data)).toMatchObject({ passed: false, detail: '1 divergência(s) comprovada(s) nos documentos.' });
    expect(contradictionOf(data).divergences?.[0]).toMatchObject({ fact: 'pagamento', a: { file: 'flow.md' }, b: { file: 'flow.md' } });
    expect(data.unverifiedContradictions).toEqual([]);
  });

  it('keeps po.no-contradictions failed when the PO fails it on quotes the documents do not hold, and journals them', async () => {
    const data = await evaluate('# Flow', undefined, {
      checklist: [{ id: 'po.no-contradictions', passed: false, detail: 'Porta divergente.' }],
      contradictions: [{ fact: 'porta', a: { file: 'flow.md', quote: 'porta 9999 do serviço' }, b: { file: 'stack.md', quote: 'porta 1111 do serviço' }, fix: 'Alinhe.' }],
    });
    expect(contradictionOf(data)).toMatchObject({ passed: false });
    expect(contradictionOf(data).detail).toMatch(/Afirmação sem trecho comprovado nos documentos: cite os dois trechos ou retire a afirmação\./);
    expect(data.unverifiedContradictions).toHaveLength(1);
  });

  it('fails po.no-contradictions when the PO passes it but lists a divergence the documents do not hold', async () => {
    const data = await evaluate('# Flow', undefined, {
      checklist: [{ id: 'po.no-contradictions', passed: true, detail: 'ok' }],
      contradictions: [{ fact: 'porta', a: { file: 'flow.md', quote: 'porta 9999 do serviço' }, b: { file: 'stack.md', quote: 'porta 1111 do serviço' }, fix: 'Alinhe.' }],
    });
    expect(contradictionOf(data)).toMatchObject({ passed: false });
    expect(contradictionOf(data).detail).toMatch(/Afirmação sem trecho comprovado nos documentos: cite os dois trechos ou retire a afirmação\./);
    expect(data.unverifiedContradictions).toHaveLength(1);
  });

  it('checks a quote against the documents the PO read, so a move of the same cycle does not drop it', async () => {
    const flow = '# Flow\n\n## 1. Checkout\n\nUser pays by card.\n\n## 2. Payment\n\nUser pays by cash.\n';
    const data = await evaluate(flow, undefined, {
      checklist: [{ id: 'po.no-contradictions', passed: true, detail: 'ok' }],
      contradictions: [{ fact: 'pagamento', a: { file: 'flow.md', quote: 'User pays by card' }, b: { file: 'flow.md', quote: 'User pays by cash' }, fix: 'Mantenha um meio de pagamento.' }],
      moves: [{ from: 'docs/flow.md', to: 'docs/design.md', quote: 'User pays by cash.', text: 'User pays by cash.', reason: 'teste' }],
    });
    expect(contradictionOf(data)).toMatchObject({ passed: false, detail: '1 divergência(s) comprovada(s) nos documentos.' });
    expect(data.unverifiedContradictions).toEqual([]);
  });

  it('keeps a question subject only once, so two questions never share a decision heading', async () => {
    const data = await evaluate('# Flow', undefined, {
      questions: [
        { id: 'a', text: 'Qual a porta?', blocking: false, relatedAcIds: [], subject: 'Porta da API' },
        { id: 'b', text: 'Qual a porta do painel?', blocking: false, relatedAcIds: [], subject: 'Porta da API' },
      ],
    });
    const questions = data.questions as Array<{ text: string; subject?: string }>;
    expect(questions.find((q) => q.text === 'Qual a porta?')?.subject).toBe('Porta da API');
    expect(questions.find((q) => q.text === 'Qual a porta do painel?')?.subject).toBeUndefined();
  });

  it('keeps po.no-contradictions failed when the PO did not report it', async () => {
    expect(contradictionOf(await evaluate('# Flow', undefined, { checklist: [] }))).toMatchObject({ passed: false, detail: 'not reported' });
  });
});

describe('refinement cycle patch dedup (R11.10)', () => {
  it('drops an SM patch byte-identical to one PO already proposed this cycle, keeping PO\'s', async () => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await writeFile(draft.briefMd, '# Brief\n\nTODO: port.\n');
    await Promise.all([draft.projectMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const samePatch = { file: 'docs/flow.md', find: '# doc', replace: 'Port: 8080.', reason: 'fill it in' };
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [samePatch] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [samePatch] });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [] }, 1);
    const proposed = events.filter((e) => e.type === 'PATCH_PROPOSED');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.data.role).toBe('po');
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    const discarded = evaluated.data.discardedPatches as Array<{ role: string; reason: string }>;
    expect(discarded).toContainEqual({ role: 'sm', file: samePatch.file, reason: 'the same change was already proposed this cycle' });
  });
});

describe('refinement cycle suggestions that still wait for the owner', () => {
  it('drops a patch an earlier cycle already suggested and shows the reviewers what is pending', async () => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await writeFile(draft.briefMd, '# Brief\n\nTODO: port.\nTODO: logs.\n');
    await Promise.all([draft.projectMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'r', specHash: 'h', type, kind: 'fact', data } as never; } } as never as Parameters<typeof runCycle>[0]['journal'];
    const file = `docs/specs/${spec.specId}/briefing.md`;
    const waiting = { patchId: 'po-c1-0', role: 'po', file: 'briefing.md', find: 'TODO: port.', replace: 'Port: 8080.', reason: 'fill in the port', diff: '', cycle: 1, status: 'pending', decision: null };
    journal.state.patches.push(waiting as never);
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const again = { file, find: 'TODO: port.', replace: 'Port: 8080.', reason: 'fill it in' };
    const other = { file, find: 'TODO: logs.', replace: 'Logs: stdout.', reason: 'fill in the logs' };
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [again, other] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [] }, 2);
    expect(events.filter((e) => e.type === 'PATCH_PROPOSED').map((e) => e.data.find)).toEqual(['TODO: logs.']);
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    expect(evaluated.data.discardedPatches as unknown[]).toContainEqual({ role: 'po', file, reason: 'the same change is already waiting for the owner' });
    const review = runAgent.mock.calls.find((c) => c[0].kind === 'refine' && !String((c[0] as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:'))![0] as unknown as { pack: { feedback: string } };
    expect(review.pack.feedback).toContain('### Pending suggestions');
    expect(review.pack.feedback).toContain('"TODO: port." → fill in the port');
  });
});

describe('refinement cycle repeated design.md headings', () => {
  const DESIGN = '# Design\n\n## 1. Médico\n\n### Navegação\n\nPainel do médico.\n\n## 2. Hospital\n\n### Navegação\n\nPainel do hospital.\n';
  const run = async (prepare?: (state: ReturnType<typeof emptyRefineState>) => void) => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd].map((f) => writeFile(f, '# doc')));
    await writeFile(draft.designMd, DESIGN);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'shop/shop-002', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    prepare?.(journal.state);
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [] }, 1);
    return events.filter((e) => e.type === 'PATCH_PROPOSED').map((e) => e.data);
  };

  it('proposes unique headings as front patches for the human to accept', async () => {
    const proposed = await run();
    expect(proposed.map((p) => p.patchId)).toEqual(['front-c1-0', 'front-c1-1']);
    expect(proposed.every((p) => p.role === 'front' && p.file === 'design.md')).toBe(true);
    expect(proposed.map((p) => String(p.replace).split('\n')[0])).toEqual(['### Navegação (1. Médico)', '### Navegação (2. Hospital)']);
  });

  it('does not propose again a patch the human rejected or one still pending', async () => {
    const first = await run();
    const row = (p: Record<string, unknown>, status: 'rejected' | 'pending') => ({ ...p, status, decision: null }) as never;
    expect(await run((state) => state.patches.push(row(first[0]!, 'rejected'), row(first[1]!, 'pending')))).toEqual([]);
  });
});

describe('refinement cycle confidentiality reaches the decider', () => {
  it('a project the owner marked confidential reaches the decider as confidential, even when its derived project says otherwise', async () => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await writeFile(draft.briefMd, '# Brief\n\nTODO: port.\n');
    await Promise.all([draft.projectMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const state = emptyRefineState();
    state.confidential = true;
    const journal = { state, allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const runAgent = vi.fn(async (req: { kind: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
    });
    const contexts: Array<{ confidential: boolean }> = [];
    const decider = {
      decide: async (_id: string, _state: string, _questions: unknown, ctx: { confidential: boolean }) => {
        contexts.push(ctx);
        return { answered: false as const, reason: 'disabled' as const };
      },
    };
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], decider }, 1);
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every((c) => c.confidential === true)).toBe(true);
  });
});

describe('refinement cycle patch dedup (R11.5a item 2)', () => {
  it('drops a paraphrased patch on the same file when the decision says it is the same change', async () => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await writeFile(draft.briefMd, '# Brief\n\nTODO: port.\n');
    await Promise.all([draft.projectMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const poPatch = { file: 'docs/flow.md', find: '# doc', replace: 'Port: 8080.', reason: 'fill it in' };
    const smPatch = { file: 'docs/flow.md', find: '# doc', replace: 'The service listens on port 8080.', reason: 'state the port' };
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [poPatch] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [smPatch] });
    });
    const decider = {
      decide: async (id: string, _state: string, questions: Record<string, unknown>) => {
        if (id !== 'patch-dedup') return { answered: false as const, reason: 'disabled' as const };
        return { answered: true as const, backend: 'jev' as const, escalated: false, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, value: 0.9, probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9 }])) };
      },
    };
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], decider }, 1);
    const proposed = events.filter((e) => e.type === 'PATCH_PROPOSED');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.data.role).toBe('po');
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    const discarded = evaluated.data.discardedPatches as Array<{ role: string; reason: string }>;
    expect(discarded).toContainEqual({ role: 'sm', file: smPatch.file, reason: 'a near-duplicate of a patch already proposed this cycle (same change in substance)' });
  });

  it('keeps both patches when the decision says they differ', async () => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await writeFile(draft.briefMd, '# Brief\n\nTODO: port.\nTODO: auth.\n');
    await Promise.all([draft.projectMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const poPatch = { file: 'docs/flow.md', find: '# doc', replace: 'Port: 8080.', reason: 'fill it in' };
    const smPatch = { file: 'docs/flow.md', find: '# doc', replace: 'No authentication required.', reason: 'state the auth' };
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [poPatch] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [smPatch] });
    });
    const decider = {
      decide: async (id: string, _state: string, questions: Record<string, unknown>) => {
        if (id !== 'patch-dedup') return { answered: false as const, reason: 'disabled' as const };
        return { answered: true as const, backend: 'jev' as const, escalated: false, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, value: 0.1, probabilities: { yes: 0.1, no: 0.9 }, confidence: 0.9 }])) };
      },
    };
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], decider }, 1);
    const proposed = events.filter((e) => e.type === 'PATCH_PROPOSED');
    expect(proposed).toHaveLength(2);
  });
});

describe('refinement cycle question routing (plan 53, R11.5a slice 1)', () => {
  it('journals a routing hint per blocking question without changing which questions reach the human', async () => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [{ text: 'How does the e2e suite reach MailHog?', blocking: true, relatedAcIds: ['AC-001'] }], docPatch: [] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    const decider = {
      decide: async (id: string, _state: string, questions: Record<string, unknown>) => {
        if (id !== 'question-routing') return { answered: false as const, reason: 'disabled' as const };
        return { answered: true as const, backend: 'jev' as const, escalated: false, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'choice' as const, value: 'auto', probabilities: { auto: 0.95 }, confidence: 0.95 }])) };
      },
    };
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], decider }, 1);
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    const questions = evaluated.data.questions as Array<{ questionId: string; text: string }>;
    expect(questions).toHaveLength(1); // the question still reaches the human: shadow mode changes nothing observable
    const routing = evaluated.data.questionRouting as Record<string, { route: string; confidence: number | null }>;
    expect(routing[questions[0]!.questionId]).toMatchObject({ route: 'auto' });
  });

  it('adds no hint without a decider', async () => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [{ text: 'Which port?', blocking: true, relatedAcIds: ['AC-001'] }], docPatch: [] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [] }, 1); // no decider at all
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    expect(evaluated.data.questionRouting).toEqual({});
  });

  /** A refinement draft whose PO asks the given blocking questions, and a decider that routes each one `auto` at its confidence. */
  async function autoRouted(questions: Record<string, number>, docText = '# doc\nA porta é 8080.', over: { answer?: string | null; ok?: boolean; backend?: 'jev' | 'local'; contradiction?: boolean; decider?: unknown; confidential?: boolean } = {}) {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, docText)));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const answered: string[] = [];
    const answerPacks: Array<Parameters<typeof buildContextPack>[0]> = [];
    const runAgent = vi.fn(async (req: { kind: string; role: string; pack: { feedback?: string } }) => {
      if (req.kind === 'derive') return ok({ project: { ...makeProject(), ...(over.confidential ? { confidential: true } : {}) }, spec: { ...spec, status: 'refining', specHash: null } });
      if (req.kind === 'answer') {
        // A marker in the journal order shows when the answer step ran against the evaluation fact.
        events.push({ type: 'ANSWER_STEP', data: {} });
        answerPacks.push(req.pack as never);
        answered.push(`${req.role}: ${Object.keys(questions).find((q) => String(req.pack.feedback).includes(q))}`);
        if (over.ok === false) return { ok: false, failure: 'schema', errors: ['bad'], summary: {} };
        return ok({ specHash: 'draft', answer: over.answer === undefined ? 'project.md diz 8080.' : over.answer });
      }
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: Object.keys(questions).map((text) => ({ text, blocking: true, relatedAcIds: [] })), docPatch: [] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    const decider = {
      decide: async (id: string, state: string) => {
        if (id === 'history-contradiction' && over.contradiction) return { answered: true as const, backend: 'jev' as const, escalated: false, answers: { q0: { type: 'noul' as const, value: 1, probabilities: { yes: 1, no: 0 }, confidence: 1 } } };
        if (id !== 'question-routing') return { answered: false as const, reason: 'disabled' as const };
        const confidence = Object.entries(questions).find(([q]) => state.includes(q))?.[1] ?? 0.99;
        return { answered: true as const, backend: over.backend ?? ('jev' as const), escalated: false, answers: { route: { type: 'choice' as const, value: 'auto', probabilities: { auto: confidence }, confidence } } };
      },
    };
    const history = [{ chunkId: 'c', docId: 'd', kind: 'spec', title: 'Spec 1', heading: 'Decisões', snippet: 'a porta é 9090', text: 'A porta é 9090.', score: 1 }];
    const run = (autoAnswerFloor?: number) => runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => (over.contradiction ? history : []), decider: over.decider ?? decider, autoAnswerFloor } as never, 1);
    return { events, answered, answerPacks, runAgent, run };
  }

  it('keeps about one question in ten above the floor for the owner, so labels keep coming once the floor is on', async () => {
    const questions = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Question ${String(i).padStart(2, '0')}?`, 0.99]));
    const r = await autoRouted(questions);
    await r.run(0.9);
    const ids = Array.from({ length: 20 }, (_, i) => `po-c1-${i}`);
    expect(ids.filter(heldForOwner).length).toBeGreaterThan(0);
    expect(r.events.filter((e) => e.type === 'QUESTION_ANSWERED').map((e) => e.data.questionId)).toEqual(ids.filter((id) => !heldForOwner(id)));
  });

  it('leaves the question with the human when the answer step returns null or fails', async () => {
    for (const over of [{ answer: null }, { ok: false }]) {
      const r = await autoRouted({ 'Which port?': 0.95 }, undefined, over);
      await r.run(0.9);
      expect(r.events.some((e) => e.type === 'QUESTION_ANSWERED')).toBe(false);
      expect(r.events.some((e) => e.type === 'REFINE_CYCLE_FAILED')).toBe(false);
    }
  });

  it('answers only what Jev routed: a route from the local model is no measured route', async () => {
    const r = await autoRouted({ 'Which port?': 0.99 }, undefined, { backend: 'local' });
    await r.run(0.9);
    expect(r.answered).toEqual([]);
  });

  it('never answers a history contradiction, which exists for the human to decide', async () => {
    const r = await autoRouted({ 'Which port?': 0.5 }, undefined, { contradiction: true });
    await r.run(0.9);
    const evaluated = r.events.find((e) => e.type === 'REFINE_EVALUATED')!.data;
    const contradiction = (evaluated.questions as Array<{ questionId: string; text: string }>).find((q) => q.text.startsWith('A spec nova parece contradizer o histórico do projeto'))!;
    expect(r.answered).toEqual([]);
    // Never answered on its own, so never routed either: no Jev call, and no sample the floor could count.
    expect(Object.keys(evaluated.questionRouting as object)).not.toContain(contradiction.questionId);
  });

  it('routes nothing on a confidential draft, where the decider skips Jev, so nothing is answered', async () => {
    const jev = { evaluate: async () => { throw new Error('a confidential draft never reaches Jev'); } };
    const decider = new Decider({ backends: { jev } as never, config: () => ({ enabled: true, chain: ['jev', 'local'], thresholds: { jev: 0.8, local: 0.9 }, escalateTo: 'po' }), onDecision: () => undefined, clock: () => new Date() });
    const r = await autoRouted({ 'Which port?': 0.99 }, undefined, { decider, confidential: true });
    await r.run(0.9);
    expect(r.events.find((e) => e.type === 'REFINE_EVALUATED')!.data.questionRouting).toEqual({});
    expect(r.answered).toEqual([]);
  });

  it('runs the answer steps before journaling the evaluation, so the page stays in evaluating until the answers land', async () => {
    const r = await autoRouted({ 'Which port?': 0.95 });
    await r.run(0.9);
    const types = r.events.map((e) => e.type);
    const evaluated = types.indexOf('REFINE_EVALUATED');
    expect(types.indexOf('ANSWER_STEP')).toBeLessThan(evaluated);
    expect(types[evaluated + 1]).toBe('QUESTION_ANSWERED');
  });

  it('fits the answer pack to the docs, so a large draft never loses the question', async () => {
    const r = await autoRouted({ 'Which port?': 0.95 }, `# doc\n${'x'.repeat(40_000)}`);
    await r.run(0.9);
    const pack = buildContextPack(r.answerPacks[0]!);
    expect(pack.dropped).not.toContain('feedback');
    expect(pack.text).toContain('Which port?');
  });

  it('answers a question routed auto at the floor or above from the docs, by its owner role, and leaves the others with the human', async () => {
    const r = await autoRouted({ 'Which port?': 0.95, 'Which name?': 0.85 });
    await r.run(0.9);
    expect(r.answered).toEqual(['po: Which port?']);
    const evaluated = r.events.findIndex((e) => e.type === 'REFINE_EVALUATED');
    const answers = r.events.filter((e) => e.type === 'QUESTION_ANSWERED');
    expect(answers.map((e) => e.data)).toEqual([{ questionId: 'po-c1-0', text: 'project.md diz 8080.', by: 'po' }]);
    // The floor the cycle answered at stays on record, so a later reader knows when and where it switched on.
    expect(r.events.find((e) => e.type === 'REFINE_EVALUATED')!.data.autoAnswerFloor).toBe(0.9);
    expect(r.events.indexOf(answers[0]!)).toBeGreaterThan(evaluated);
  });

  it('never answers a question by itself while the floor is unset, the default', async () => {
    const r = await autoRouted({ 'Which port?': 0.99 });
    await r.run();
    expect(r.runAgent.mock.calls.some(([req]) => req.kind === 'answer')).toBe(false);
    expect(r.events.some((e) => e.type === 'QUESTION_ANSWERED')).toBe(false);
  });
});

describe('refinement cycle questions for failed gaps', () => {
  const item = (key: string) => ({ key, title: `Item ${key}`, epic: 'core', scope: 's', priority: 'P2', rationale: 'r', dependsOn: [], sources: [], size: 'M', rank: 1 });
  const backlog = (specs: Record<string, unknown>, preplans: Record<string, unknown> = {}, detail = true) =>
    ({ enabled: true, project: null, epics: [], items: [item('caso'), item('opme')], cycle: 2, detail, flowHeadings: [], specs, preplans }) as never;

  it('asks the human, as a blocking question, about a spec that failed to generate', () => {
    const questions = failedGapQuestions(backlog({ caso: { spec: null, issues: ['falta a regra do prazo'] } }), 3, []);
    expect(questions).toEqual([expect.objectContaining({ role: 'po', blocking: true, relatedAcIds: [], cycle: 3 })]);
    expect(questions[0]!.text).toContain('O item caso (Item caso) não conseguiu gerar a spec: "falta a regra do prazo".');
    expect(questions[0]!.options!.filter((o) => o.recommended)).toHaveLength(1);
  });

  it('asks about a pre-plan that failed when its spec is fine', () => {
    const questions = failedGapQuestions(backlog({}, { opme: { issues: ['tarefa sem módulo'] } }), 3, []);
    expect(questions).toEqual([expect.objectContaining({ role: 'sm', text: expect.stringContaining('não conseguiu gerar o pré-plano') })]);
  });

  it('adds nothing for a gap that only waits for generation, with no issue', () => {
    expect(failedGapQuestions(backlog({}), 3, [])).toEqual([]);
  });

  it('adds nothing when a question already names the item, so a gap is asked once', () => {
    const b = backlog({ caso: { spec: null, issues: ['falta a regra'] } });
    expect(failedGapQuestions(b, 3, ['Qual o prazo do caso?'])).toEqual([]);
    expect(failedGapQuestions(b, 3, ['O item caso precisa de regra'])).toEqual([]);
  });

  it('adds nothing outside detailed mode', () => {
    expect(failedGapQuestions(backlog({ caso: { spec: null, issues: ['x'] } }, {}, false), 3, [])).toEqual([]);
  });
});

describe('refinement cycle System 1 filters (decisions 2-4)', () => {
  it('hints not-ready criteria, drops a duplicate question and asks about a contradicted history chunk', async () => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const packs: Record<string, string> = {};
    const runAgent = vi.fn(async (req: { kind: string; role: string; pack: { feedback?: string } }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      packs[req.role] = String(req.pack.feedback);
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [{ text: 'Which port?', blocking: true, relatedAcIds: ['AC-001'] }, { text: 'What port does it listen on?', blocking: true, relatedAcIds: ['AC-001'] }], docPatch: [] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    const asked: string[] = [];
    const decider = {
      decide: async (id: string, _state: string, questions: Record<string, unknown>) => {
        asked.push(id);
        const value = id === 'gate1-readiness' ? 0.1 : 0.9;
        return { answered: true as const, backend: 'jev' as const, escalated: false, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, value, probabilities: { yes: value, no: 1 - value }, confidence: 0.9 }])) };
      },
    };
    const hit = { chunkId: 'c1', docId: 'd1', kind: 'spec' as never, title: 'spec-000', heading: 'Ports', snippet: 'the service listens on 8080', text: 'the service listens on 8080', score: 1 };
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [hit], decider }, 1);
    const order = [...new Set(asked)];
    expect(order).toEqual(['gate1-readiness', 'question-dedup', 'history-contradiction', 'question-routing']);
    expect(asked.filter((id) => id === 'gate1-readiness')).toHaveLength(spec.acceptanceCriteria.length); // one call per criterion
    expect(asked.filter((id) => id === 'history-contradiction')).toHaveLength(1); // one call per retrieved chunk
    // Every decision leaves a DECISION_MADE record the eval harness can read (spec 10A.4/10A.6).
    const made = events.filter((e) => e.type === 'DECISION_MADE').map((e) => e.data as { cycle: number; record: { decisionId: string; backend: string; escalated: boolean; durationMs: number; answers: Record<string, { probabilities: unknown }> } });
    expect(made.map((m) => m.record.decisionId)).toEqual(asked);
    expect(made[0]).toMatchObject({ cycle: 1, record: { backend: 'jev', escalated: false } });
    expect(typeof made[0]!.record.durationMs).toBe('number');
    expect(Object.keys(made[0]!.record.answers).length).toBeGreaterThan(0);
    expect(packs.po).toContain('Not ready: ' + spec.acceptanceCriteria.map((c) => c.id).join(', '));
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    const texts = (evaluated.data.questions as Array<{ text: string; blocking: boolean }>).map((q) => q.text);
    expect(texts).toContain('Which port?');
    expect(texts).not.toContain('What port does it listen on?');
    expect(texts.some((t) => t.includes('contradizer o histórico do projeto (spec-000 › Ports)'))).toBe(true);
  });
});


const setup = async (brief: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
  const docs = path.join(root, 'docs');
  await mkdir(docs, { recursive: true });
  const draft = {
    projectId: 'big', specId: 'big-001', root, docs,
    projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
    stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
    specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
  };
  await Promise.all([draft.projectMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
  await writeFile(draft.briefMd, brief);
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
  const runAgent = vi.fn().mockResolvedValue({ ok: false, failure: 'test', errors: [], summary: {}, sandboxDisabled: false });
  return { draft, journal, events, runAgent, root };
};

describe('refinement cycle with large documents', () => {
  it('never lets the derive pack drop the documents when they exceed the default budget', async () => {
    const { draft, journal, runAgent, root } = await setup(`# Brief\n${'x'.repeat(100_000)}`);
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [] }, 1);
    const built = buildContextPack(runAgent.mock.calls[0]![0].pack);
    expect(built.dropped).toEqual([]);
    expect(built.sections).toContain('feedback');
  });

  it('sends a digest of the documents, not a failed cycle, when they do not fit whole', async () => {
    const { draft, journal, events, runAgent, root } = await setup(`# Brief\n${'x'.repeat(700_000)}`);
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [] }, 1);
    expect(runAgent).toHaveBeenCalled();
    expect(String(events.find((e) => e.type === 'REFINE_CYCLE_FAILED')?.data.reason)).not.toMatch(/grandes demais/);
    const pack = runAgent.mock.calls[0]![0].pack;
    expect(pack.feedback).toContain('are a digest');
    expect(buildContextPack(pack).tokens).toBeLessThan(PACK_TOKEN_CAP);
  });
});

describe('refinement cycle Jev requirement', () => {
  it('fails before any agent runs when Jev is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'demo', specId: 'demo-001', root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'demo/demo-001', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const runAgent = vi.fn();
    await runCycle({
      draft,
      journal,
      runAgent: runAgent as never,
      principles: () => [],
      retrieval: () => [],
      validateDocs: async () => ({ available: false, decision: 'review' as const, consistent: null, confidence: null, model: null, checks: {}, stateTruncated: false }),
    }, 1);
    expect(runAgent).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'REFINE_CYCLE_FAILED')?.data.reason).toBe('Jev indisponível: confira a chave do OpenRouter.');
  });
});

describe('refinement cycle of a confidential project', () => {
  it('never sends the docs to Jev, and lets the agents run without its findings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'demo', specId: 'demo-001', root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'briefing.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    await writeFile(draft.projectJson, JSON.stringify({ ...makeProject(), confidential: true }));
    await writeFile(draft.specJson, JSON.stringify({ ...makeSpec(), status: 'refining', specHash: null }));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'demo/demo-001', specHash: 'draft', type, kind: 'fact', data }; } } as never;
    const runAgent = vi.fn(async () => ({ ok: false, failure: 'schema', errors: ['stop here'], summary: {} }));
    const validateDocs = vi.fn();
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], validateDocs }, 1).catch(() => undefined);
    expect(validateDocs).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'REFINE_DOCS_VALIDATED')?.data).toMatchObject({ skipped: 'confidential', available: true });
    expect(events.find((e) => e.type === 'REFINE_CYCLE_FAILED')?.data.reason).not.toBe('Jev indisponível: confira a chave do OpenRouter.');
    expect(runAgent).toHaveBeenCalled();
  });
});

describe('refinement cycle in backlog mode', () => {
  const item = (key: string, over: Partial<BacklogItem> = {}): BacklogItem => ({ key, title: `Item ${key}`, epic: 'core', scope: `Entrega ${key}`, priority: 'P1', rationale: 'valor', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'M', ...over });
  const raw = (items: BacklogItem[]) => ({ project: makeProject(), backlog: { epics: [{ key: 'core', title: 'Core' }], items } });
  const ok = (value: unknown) => ({ ok: true, value, summary: {} });
  const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
  const agent = (backlogAnswers: unknown[]) => {
    const answers = [...backlogAnswers];
    const packs: Array<{ kind: string; role: string; feedback: string }> = [];
    const fn = vi.fn(async (req: { kind: string; role: string; pack: { feedback?: string } }) => {
      packs.push({ kind: req.kind, role: req.role, feedback: String(req.pack.feedback) });
      if (req.kind === 'backlog') return ok(answers.shift());
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    return { fn, packs };
  };
  const on = (journal: { state: { backlog: unknown } }) => { journal.state.backlog = { enabled: true, project: null, epics: [], items: [], cycle: 0 }; };

  it('runs the backlog step instead of derive, journals the ranked backlog and writes project.json and backlog.md', async () => {
    const { draft, journal, events, root } = await setup('# Briefing');
    on(journal);
    const { fn, packs } = agent([raw([item('casos', { dependsOn: ['base'] }), item('base', { priority: 'P0' })])]);
    await runCycle({ draft, journal, runAgent: fn as never, principles: () => [], retrieval: () => [] }, 1);
    expect(packs.map((p) => p.kind)).toEqual(['backlog', 'refine', 'refine', 'refine']);
    const derived = events.find((e) => e.type === 'BACKLOG_DERIVED')!.data as { items: Array<{ key: string; rank: number }> };
    expect(derived.items.map((i) => [i.key, i.rank])).toEqual([['base', 1], ['casos', 2]]);
    expect(events.some((e) => e.type === 'DERIVED')).toBe(false);
    expect(events.some((e) => e.type === 'REFINE_EVALUATED')).toBe(true);
    expect(JSON.parse(await readFile(draft.projectJson, 'utf8')).projectId).toBe(makeProject().projectId);
    expect(await readFile(path.join(draft.docs, 'backlog.md'), 'utf8')).toContain('Item base');
    const index = JSON.parse(await readFile(path.join(draft.docs, 'specs.json'), 'utf8')) as { specs: Array<{ specId: string; rank: number; dependsOn: string[] }> };
    expect(index.specs.map((x) => [x.rank, x.specId, x.dependsOn])).toEqual([[1, 'big-001-base', []], [2, 'big-001-casos', ['big-001-base']]]);
    const po = packs.find((p) => p.role === 'po' && p.kind === 'refine' && !p.feedback.startsWith('REORGANIZE:'))!;
    expect(po.feedback).toContain('### derived backlog');
    expect(po.feedback).not.toContain('### derived spec.json');
  });

  it('writes docs/specs.json with the spec ids a draft with readable ids really has', async () => {
    const { draft, journal, root } = await setup('# Briefing');
    journal.state.backlog = { enabled: true, project: null, epics: [], items: [], cycle: 0, keyIds: true };
    const { fn } = agent([raw([item('casos', { dependsOn: ['base'] }), item('base', { priority: 'P0' })])]);
    await runCycle({ draft, journal, runAgent: fn as never, principles: () => [], retrieval: () => [] }, 1);
    const index = JSON.parse(await readFile(path.join(draft.docs, 'specs.json'), 'utf8')) as { specs: Array<{ specId: string; dependsOn: string[] }> };
    expect(index.specs.map((x) => [x.specId, x.dependsOn])).toEqual([['base', []], ['casos', ['base']]]);
  });

  it('asks once more with the rejection when the first backlog breaks a rule', async () => {
    const { draft, journal, events, root } = await setup('# Briefing');
    on(journal);
    const { fn, packs } = agent([raw([item('a', { dependsOn: ['zzz'] })]), raw([item('a')])]);
    await runCycle({ draft, journal, runAgent: fn as never, principles: () => [], retrieval: () => [] }, 1);
    const asks = packs.filter((p) => p.kind === 'backlog');
    expect(asks).toHaveLength(2);
    expect(asks[0]!.feedback).not.toContain('zzz');
    expect(asks[1]!.feedback).toMatch(/dependência desconhecida zzz/);
    expect(events.some((e) => e.type === 'BACKLOG_DERIVED')).toBe(true);
  });

  it('asks the owner each rule the second backlog still breaks, runs no review, and does not fail the cycle', async () => {
    const { draft, journal, events, root } = await setup('# Briefing');
    on(journal);
    const { fn, packs } = agent([raw([item('a', { dependsOn: ['zzz'] })]), raw([item('a', { dependsOn: ['zzz'] })])]);
    await runCycle({ draft, journal, runAgent: fn as never, principles: () => [], retrieval: () => [] }, 1);
    expect(packs.map((p) => p.kind)).toEqual(['backlog', 'backlog']);
    expect(events.some((e) => e.type === 'REFINE_CYCLE_FAILED')).toBe(false);
    expect(events.some((e) => e.type === 'BACKLOG_DERIVED')).toBe(false);
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    expect(evaluated.data.questions).toEqual([expect.objectContaining({ role: 'po', blocking: true, text: expect.stringContaining('zzz') })]);
  });
});

describe('refinement cycle unexpected errors', () => {
  it('journals any unexpected error as a failed cycle and rethrows it, so the session never stays evaluating', async () => {
    const { draft, journal, events, runAgent, root } = await setup('# Brief\n');
    runAgent.mockRejectedValue(new Error('disk full'));
    await expect(runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [] }, 1)).rejects.toThrow('disk full');
    expect(events.find((e) => e.type === 'REFINE_CYCLE_FAILED')?.data).toEqual({ cycle: 1, reason: 'disk full' });
  });
});

describe('refinement cycle pending questions', () => {
  it('does not ask again a question still pending from an earlier cycle', async () => {
    const { draft, journal, events, runAgent, root } = await setup('# Brief\n');
    journal.state.questions.push({ questionId: 'po-c1-0', role: 'po', text: 'Which port?', blocking: true, relatedAcIds: [], cycle: 1, status: 'pending', answer: null } as never);
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    runAgent.mockImplementation(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...makeSpec(), specId: draft.specId, status: 'refining', specHash: null } });
      if (String((req as { pack?: { feedback?: string } }).pack?.feedback).startsWith('REORGANIZE:')) return ok({ checklist: [], questions: [], docPatch: [], moves: [] });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [{ text: 'Which port?', blocking: true, relatedAcIds: [] }], docPatch: [] });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [] }, 2);
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    expect(evaluated.data.questions).toEqual([]);
    const open = (evaluated.data.checklist as Array<{ id: string; detail: string }>).find((i) => i.id === 'sm.no-open-questions')!;
    expect(open.detail).toBe('1 blocking question(s) open');
  });
});

describe('refinement cycle reorganization pass', () => {
  const TECH = 'Usamos React no front.';
  const ok = (value: unknown) => ({ ok: true, value, summary: {} });
  const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
  const REORG_EMPTY = { checklist: [], questions: [], docPatch: [], moves: [] };

  /** A new project whose project.md holds TECH; the journal applies its events to the state, as the real one does. */
  async function setup(reorg: Record<string, unknown> = REORG_EMPTY, po: Record<string, unknown> = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const ws = { projectId: 'shop', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` } as Workspace;
    const draft = draftPaths(ws, 'shop-003');
    await createNewProject(draft, 'Shop');
    await writeFile(draft.projectMd, `# Shop\n\n## Visão\n\nLoja online.\n\n${TECH}\n`);
    await writeFile(draft.flowMd, '# Fluxo\n\n```mermaid\nflowchart TD\n  A --> B\n```\n');
    // A filled stack.md: a blank template is never a move's destination.
    await writeFile(draft.stackMd, '# Stack\n\n## Tecnologias\n\nNode 22.\n');
    await writeFile(draft.designMd!, '# Design\n\n## Contrato da API para quem faz a tela\n\nFormato de datas.\n');
    const state = emptyRefineState();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = {
      state,
      allocStepSeq: () => 1,
      fact: async (type: string, data: Record<string, unknown>) => {
        events.push({ type, data });
        applyRefineEvent(state, { type, data });
        return { seq: events.length, at: '', runId: 'shop/shop-003', specHash: 'draft', type, kind: 'fact' as const, data };
      },
    };
    const packs: Array<{ role: string; kind: string; feedback: string }> = [];
    const runAgent = vi.fn(async (req: { kind: string; role: string; pack: { feedback?: string } }) => {
      const feedback = String(req.pack.feedback);
      packs.push({ kind: req.kind, role: req.role, feedback });
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...makeSpec(), specId: 'shop-003', acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't2', smoke: false }] } });
      if (feedback.startsWith('REORGANIZE:')) return ok(reorg);
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [], moves: [], ...po });
      return ok({ checklist: check(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    const cycle = (n: number) => runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [] }, n);
    return { draft, events, packs, cycle };
  }

  it('reads every document in full on the first pass, and moves the misplaced line to the document that holds it', async () => {
    const { draft, events, packs, cycle } = await setup({ ...REORG_EMPTY, moves: [{ from: 'docs/project.md', to: 'docs/stack.md', quote: TECH, text: TECH, reason: 'tecnologia' }] });
    await cycle(1);
    const pass = packs.find((p) => p.feedback.startsWith('REORGANIZE:'))!;
    expect(pass.feedback).toContain('### docs/project.md (reorganize in full)');
    expect(events.some((e) => e.type === 'DOCS_REORGANIZED')).toBe(true);
    expect(events.find((e) => e.type === 'DOC_MOVED')?.data).toMatchObject({ moveId: 'move-po-c1-0', from: 'project.md', to: 'stack.md' });
    expect(await readFile(draft.projectMd, 'utf8')).not.toContain(TECH);
  });

  it('skips the pass when no document changed since the last one', async () => {
    const { packs, cycle } = await setup();
    await cycle(1);
    packs.length = 0;
    await cycle(2);
    expect(packs.some((p) => p.feedback.startsWith('REORGANIZE:'))).toBe(false);
  });

  it('asks an ambiguous piece as a question with its choices, and never moves it', async () => {
    const question = { id: 'q1', text: 'Onde fica o prazo de entrega?', blocking: false, relatedAcIds: [], subject: 'Prazo de entrega', options: [{ label: 'Briefing', detail: 'Regra de negócio.', recommended: true }, { label: 'Fluxo', detail: 'Ordem de passos.' }] };
    const { events, cycle } = await setup({ ...REORG_EMPTY, questions: [question] });
    await cycle(1);
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    expect(evaluated.data.questions).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Onde fica o prazo de entrega?', subject: 'Prazo de entrega' })]));
    expect(events.some((e) => e.type === 'DOC_MOVED')).toBe(false);
  });

  it('refuses a move of a section a pending question is about, so the owner decides it first', async () => {
    const question = { id: 'q1', text: 'Onde fica a seção "Contrato da API para quem faz a tela"?', blocking: false, relatedAcIds: [], options: [{ label: 'Briefing', detail: 'Regra.' }] };
    const move = { from: 'docs/design.md', to: 'docs/stack.md', quote: '## Contrato da API para quem faz a tela', text: '## Contrato da API para quem faz a tela', reason: 'API' };
    const { events, cycle } = await setup({ ...REORG_EMPTY, questions: [question] }, { moves: [move] });
    await cycle(1);
    expect(events.some((e) => e.type === 'DOC_MOVED')).toBe(false);
    expect(events.find((e) => e.type === 'REFINE_EVALUATED')!.data.discardedPatches).toContainEqual(expect.objectContaining({ role: 'po', reason: 'a pergunta pendente cita este trecho: "contrato da api para quem faz a tela"' }));
  });

  it('drops a reworded question about a section a pending question already asks', async () => {
    const question = { id: 'q1', text: 'Onde fica a seção "Contrato da API para quem faz a tela"?', blocking: false, relatedAcIds: [], options: [{ label: 'Briefing', detail: 'Regra.' }] };
    const reworded = { id: 'q2', text: 'Qual documento deve ter a "Contrato da API para quem faz a tela"?', blocking: false, relatedAcIds: [], options: [{ label: 'Briefing', detail: 'Regra.' }] };
    // The PO asks the reworded question in the second cycle, after the first cycle left the first one pending.
    const po: Record<string, unknown> = {};
    const { events, cycle } = await setup({ ...REORG_EMPTY, questions: [question] }, po);
    await cycle(1);
    po.questions = [reworded];
    await cycle(2);
    const evaluated = events.filter((e) => e.type === 'REFINE_EVALUATED').at(-1)!;
    expect((evaluated.data.questions as Array<{ text: string }>).map((q) => q.text)).toEqual([]);
  });
});
