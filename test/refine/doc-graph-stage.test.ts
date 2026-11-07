import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, readDoc, writeDoc, type DocFile } from '../../server/refine/draft.js';
import { DOC_STAGES } from '../../server/refine/doc-stages.js';
import { RefineEvent } from '../../server/refine/events.js';
import { RefineSession } from '../../server/refine/session.js';
import { calls, makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';

let root = '';
let ws: Workspace;
let secretsDir = '';
let script: Script;

const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'];
const green = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
const refineOut = (checklist: unknown[], questions: unknown[] = [], docPatch: unknown[] = []) => ({ checklist, questions, docPatch });
const FLOW = '# Fluxo\n\n```mermaid\nflowchart TD\n  A[Início] --> B[Fim]\n```\n';

const draft = () => draftPaths(ws, 'hello-001');
const deps = () => ({ ws, draft: draft(), runAgent: makeFakeRunAgent(script), secretsDir, retrieval: () => [] });

/** A graphify stand-in: one node per document of the folder, with the tokens of a small extraction. */
async function extractDocs(dir: string, outDir: string): Promise<void> {
  const files = await fs.readdir(dir);
  await fs.mkdir(path.join(outDir, 'graphify-out'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: files.map((file) => ({ id: file, source_file: file })), edges: [], input_tokens: 2500, output_tokens: 90 }));
}

/** The given stages reviewed and continued in order, the agents approving each one. */
async function finishStages(s: RefineSession, files: readonly DocFile[] = DOC_STAGES): Promise<void> {
  script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO)), refineOut(green(PO))];
  script['refine/sm'] = [refineOut(green(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions', 'sm.flow-is-mermaid']))];
  script['refine/front'] = [refineOut([])];
  for (const file of files) {
    await s.evaluateStage(file);
    await s.continueStage();
    await s.settled();
  }
}

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-doc-graph-stage-'))).replace(/\\/g, '/');
  secretsDir = `${root}/secrets`;
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  script = {};
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('document graph in the stages', () => {
  it('answers at once, and the stage advances only when the graph has the document', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The review adds the document to the graph at once; only the extraction that Continuar starts waits for the gate.
    let calls = 0;
    const slow = async (dir: string, outDir: string) => {
      calls += 1;
      if (calls >= 1) await gate;
      await extractDocs(dir, outDir);
    };
    const s = await RefineSession.create({ ...deps(), extractDocs: slow }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.continueStage();
    expect(s.state.graphing).toBe('flow.md');
    expect(s.state.doneStages ?? []).toEqual([]);
    release();
    await s.settled();
    expect(s.state.graphing).toBeNull();
    expect(s.state.graphed).toEqual(['flow.md']);
    expect(s.state.doneStages).toEqual(['flow.md']);
    await s.close();
  });

  it('an extraction cut by a restart ends as failed, so the stage does not wait forever', async () => {
    const never = () => new Promise<void>(() => undefined);
    const s = await RefineSession.create({ ...deps(), extractDocs: never }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    void s.continueStage();
    for (let i = 0; i < 100 && s.state.graphing !== 'flow.md'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.state.graphing).toBe('flow.md');
    // The crash: the process is gone, so its lock goes with it.
    await fs.rm(`${draft().events}.lock`, { force: true });
    const reopened = await RefineSession.open({ ...deps(), extractDocs });
    expect(reopened.state.graphing).toBeNull();
    expect(reopened.state.graphError).toMatchObject({ file: 'flow.md' });
    await reopened.close();
  });

  it('the heal driver may retry a failed stage review, but leaves a healthy stage session alone', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    expect(s.healView().staged).toBe(true);
    await s.evaluateStage('flow.md');
    expect(s.state.status).toBe('error');
    expect(s.healView().staged).toBe(false);
    expect(s.healView().cycle).toBeDefined();
    await s.close();
  });

  it('scores the reviewed document with the Jev on its own, once, and not when the review failed', async () => {
    const scoreDocs = vi.fn(async (_docs: Record<string, string>, _files?: readonly string[]) => ({ available: true, model: 'jev-1.13.0', average: 0.9, docs: null, usage: null }));
    const s = await RefineSession.create({ ...deps(), extractDocs, scoreDocs: scoreDocs as never }, 'new-project', { repositories: true });
    await s.answerConfidentiality(false);
    await writeDoc(draft(), 'flow.md', FLOW);
    await s.evaluateStage('flow.md');
    expect(scoreDocs).not.toHaveBeenCalled();
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    expect(scoreDocs).toHaveBeenCalledTimes(1);
    expect(scoreDocs.mock.calls[0]![1]).toEqual(['flow.md']);
    await s.close();
  });

  it('an identical review is not asked of the agent again, and a new answer or an edit asks it again', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.settled();
    calls.length = 0;
    await s.evaluateStage('flow.md');
    await s.settled();
    expect(calls.filter((c) => c.kind === 'refine')).toHaveLength(0);
    expect(s.state.reviewedStages).toContain('flow.md');
    await s.saveDoc('flow.md', `${FLOW}
Editado.
`);
    await s.evaluateStage('flow.md');
    await s.settled();
    expect(calls.filter((c) => c.kind === 'refine')).toHaveLength(1);
    await s.close();
  });

  it('a failed review does not put the document in the graph', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    await s.evaluateStage('flow.md');
    expect(s.state.status).toBe('error');
    expect(s.state.graphed ?? []).not.toContain('flow.md');
    await s.close();
  });

  it('keeps the stage open when the extraction fails, names the reason, and advances on a retry', async () => {
    let fail = true;
    const flaky = async (dir: string, outDir: string) => {
      if (fail) throw new Error('limite de uso atingido');
      await extractDocs(dir, outDir);
    };
    const s = await RefineSession.create({ ...deps(), extractDocs: flaky }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.continueStage();
    await s.settled();
    expect(s.state.graphError).toMatchObject({ file: 'flow.md', reason: 'limite de uso atingido' });
    expect(s.state.doneStages ?? []).toEqual([]);
    fail = false;
    await s.continueStage();
    await s.settled();
    expect(s.state.graphError).toBeNull();
    expect(s.state.doneStages).toEqual(['flow.md']);
    await s.close();
  });

  it('refuses a graph with no content for the document, in plain words', async () => {
    const empty = async (_dir: string, outDir: string) => {
      await fs.mkdir(path.join(outDir, 'graphify-out'), { recursive: true });
      await fs.writeFile(path.join(outDir, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [], edges: [] }));
    };
    const s = await RefineSession.create({ ...deps(), extractDocs: empty }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.continueStage();
    await s.settled();
    expect(s.state.graphError).toMatchObject({ file: 'flow.md', reason: 'O Graphify não encontrou conteúdo neste documento.' });
    await s.close();
  });

  it('refuses the backlog while a finished document is out of the graph, since its last edit', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    await finishStages(s);
    expect(s.state.doneStages).toEqual([...DOC_STAGES]);
    await s.saveDoc('flow.md', `${FLOW}\nEditado depois da etapa.\n`);
    // The edit outdates the later stages first; their reviews also put the documents back in the graph.
    await expect(s.enableBacklog()).rejects.toThrow(/etapas desatualizadas antes: project\.md, briefing\.md, stack\.md, design\.md/);
    await s.close();
  });

  it('reviews an edited finished document again, and then puts it back in the graph', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    await finishStages(s);
    await s.saveDoc('flow.md', `${FLOW}\nEditado depois da etapa.\n`);
    expect(s.state.graphed).not.toContain('flow.md');
    calls.length = 0;
    script['refine/po'] = [refineOut(green(PO))];
    await s.addToGraph('flow.md');
    // The graph takes the document once its review has ended, so the test waits for that.
    for (let i = 0; i < 100 && !(s.state.graphed ?? []).includes('flow.md'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.kind === 'refine' && c.role === 'po')).toHaveLength(1);
    expect(s.state.graphed).toContain('flow.md');
    expect(s.state.doneStages).toEqual([...DOC_STAGES]);
    await s.close();
  });

  it('an accepted suggestion starts no extraction: it marks the graph outdated, and Continuar puts the document back in once', async () => {
    let runs = 0;
    const counting = async (dir: string, outDir: string) => {
      runs += 1;
      await extractDocs(dir, outDir);
    };
    const s = await RefineSession.create({ ...deps(), extractDocs: counting }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO), [], [{ file: 'docs/flow.md', find: 'A[Início] --> B[Fim]', replace: 'A[Início] --> B[Fim]\n  - passo novo', reason: 'novo passo' }])];
    await s.evaluateStage('flow.md');
    await s.settled();
    const before = runs;
    const patch = s.state.patches.find((p) => p.status === 'pending')!;
    await s.accept(patch.patchId);
    expect(s.busy).toBe(false);
    expect(runs).toBe(before);
    expect(s.state.graphed ?? []).not.toContain('flow.md');
    await s.continueStage();
    await s.settled();
    expect(runs).toBe(before + 1);
    expect(s.state.graphed).toContain('flow.md');
    await s.close();
  });

  it('a stage review puts nothing in the graph; only Continuar does', async () => {
    let runs = 0;
    const counting = async (dir: string, outDir: string) => {
      runs += 1;
      await extractDocs(dir, outDir);
    };
    const s = await RefineSession.create({ ...deps(), extractDocs: counting }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.settled();
    expect(runs).toBe(0);
    expect(s.events.some((e) => e.type === RefineEvent.DocGraphStarted)).toBe(false);
    await s.continueStage();
    await s.settled();
    expect(runs).toBe(1);
    await s.close();
  });

  it('refuses to add a document that is already in the graph', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    await finishStages(s);
    await expect(s.addToGraph('flow.md')).rejects.toThrow(/flow\.md já está no Graphify/);
    await s.close();
  });

  it('marks the design as not applicable: the mark is written, the document goes to the graph and the stage ends at once', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    await finishStages(s, DOC_STAGES.slice(0, 4));
    await s.markNotApplicable();
    await s.settled();
    expect(await readDoc(draft(), 'design.md')).toMatch(/^Não se aplica/);
    expect(s.state.graphed).toContain('design.md');
    expect(s.state.doneStages).toEqual([...DOC_STAGES]);
    await s.close();
  });

  it('reprocessing a not applicable design keeps the mark: the agents improve it and no reshape writes the template', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    await finishStages(s, DOC_STAGES.slice(0, 4));
    await s.markNotApplicable();
    await s.settled();
    calls.length = 0;
    script['refine/front'] = [refineOut([])];
    await s.reprocessStage('design.md');
    await s.settled();
    expect(calls.some((c) => c.kind === 'suggest')).toBe(false);
    expect(calls.some((c) => c.kind === 'refine')).toBe(true);
    expect(await readDoc(draft(), 'design.md')).toMatch(/^Não se aplica/);
    await s.close();
  });

  it('counts the tokens of the graph extraction in the snapshot, next to the steps', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    const before = (await s.snapshot()).tokens.inputTokens;
    await s.continueStage();
    await s.settled();
    const after = await s.snapshot();
    expect(after.tokens.inputTokens - before).toBe(2500);
    expect(after.tokens.outputTokens).toBeGreaterThanOrEqual(90);
    await s.close();
  });

  it('a reprocessed stage moves on without its mandatory question: the question is skipped and the document goes to the graph', async () => {
    const mandatory = [{ text: 'Qual o fluxo de pagamento?', blocking: true, relatedAcIds: [], options: [] }];
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO), mandatory)];
    await s.evaluateStage('flow.md');
    await s.settled();
    await expect(s.continueStage()).rejects.toThrow('Responda as perguntas obrigatórias da etapa flow.md.');
    script['refine/po'] = [refineOut(green(PO), mandatory)];
    await s.reprocessStage('flow.md');
    await s.settled();
    await s.continueStage();
    await s.settled();
    expect(s.state.doneStages).toEqual(['flow.md']);
    expect(s.state.graphed).toContain('flow.md');
    expect(s.state.reprocessedStages ?? []).toEqual([]);
    expect(s.state.questions.find((q) => q.text === 'Qual o fluxo de pagamento?')).toMatchObject({ status: 'skipped' });
    await s.close();
  });
});

describe('the Jev pass line', () => {
  const low = { available: true, model: 'jev-1.13.0', average: 0.4, docs: { 'flow.md': { score: 0.4, checks: { complete: 0.4, concrete: 0.4, consistent: 0.4, scoped: 0.4 } } }, usage: null };
  const high = { ...low, average: 0.9, docs: { 'flow.md': { score: 0.9, checks: { complete: 0.9, concrete: 0.9, consistent: 0.9, scoped: 0.9 } } } };
  const session = async (scoreDocs: unknown) => {
    const s = await RefineSession.create({ ...deps(), extractDocs, scoreDocs: scoreDocs as never }, 'new-project', { repositories: true });
    await s.answerConfidentiality(false);
    await writeDoc(draft(), 'flow.md', FLOW);
    return s;
  };

  it('has the agents review a low-scored document once more, and not a third time', async () => {
    const s = await session(async () => low);
    script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO)), refineOut(green(PO))];
    calls.length = 0;
    await s.evaluateStage('flow.md');
    expect(calls.filter((c) => c.kind === 'refine' && c.role === 'po')).toHaveLength(2);
    await s.evaluateStage('flow.md');
    expect(calls.filter((c) => c.kind === 'refine' && c.role === 'po')).toHaveLength(2);
    await s.close();
  });

  it('a review that ran past a minute is not repeated, and the journal says why', async () => {
    // Every clock read is two minutes after the one before, so the first review seems to have run for two minutes.
    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 120_000));
    try {
      const s = await session(async () => low);
      script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO))];
      calls.length = 0;
      await s.evaluateStage('flow.md');
      expect(calls.filter((c) => c.kind === 'refine' && c.role === 'po')).toHaveLength(1);
      expect(s.events.some((e) => e.type === RefineEvent.AutoReviewSkipped)).toBe(true);
      await s.close();
    } finally {
      now.mockRestore();
    }
  });

  it('joins the graph of each document into one staging graph, in the order of the stages', async () => {
    const merge = vi.fn(async (_graphs: ReadonlyArray<{ dir: string; name: string }>, _outDir: string) => true);
    const s = await RefineSession.create({ ...deps(), extractDocs, mergeDocGraphs: merge }, 'new-project', { repositories: true });
    await s.graphDocs();
    expect(merge).toHaveBeenCalledTimes(DOC_STAGES.length);
    const joined = merge.mock.calls.at(-1)![0];
    expect(joined.map((g) => g.name)).toEqual([...DOC_STAGES]);
    await s.close();
  });

  it('does not review a good document twice', async () => {
    const s = await session(async () => high);
    script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO))];
    calls.length = 0;
    await s.evaluateStage('flow.md');
    expect(calls.filter((c) => c.kind === 'refine' && c.role === 'po')).toHaveLength(1);
    await s.close();
  });

  it('asks the owner to confirm before moving on from a low-scored stage, and moves on once confirmed', async () => {
    const s = await session(async () => low);
    script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.settled();
    await expect(s.continueStage('flow.md')).rejects.toThrow(/nota do Jev de flow\.md está em 40%, abaixo de 50%/);
    await s.continueStage('flow.md', true);
    await s.settled();
    expect(s.state.doneStages).toEqual(['flow.md']);
    await s.close();
  });
});

describe('the owner keeps working while the graph extraction runs', () => {
  it('rejects a suggestion, skips a question and edits while a document goes to the graph', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const slow = async (dir: string, outDir: string) => {
      calls += 1;
      if (calls >= 1) await gate;
      await extractDocs(dir, outDir);
    };
    const s = await RefineSession.create({ ...deps(), extractDocs: slow }, 'new-project', { repositories: true });
    await writeDoc(draft(), 'flow.md', FLOW);
    const ask = { text: 'Qual o prazo?', blocking: false, relatedAcIds: [], options: [] };
    script['refine/po'] = [refineOut(green(PO), [ask], [{ file: 'docs/flow.md', find: 'A[Início] --> B[Fim]', replace: 'A[Início] --> B[Fim]\n  - passo novo', reason: 'novo passo' }])];
    await s.evaluateStage('flow.md');
    await s.settled();
    const patch = s.state.patches.find((p) => p.status === 'pending')!;
    const question = s.state.questions.find((q) => q.status === 'pending')!;
    await s.reject(patch.patchId, null);
    await s.continueStage();
    expect(s.state.graphing).toBe('flow.md');
    await s.skip(question.questionId);
    expect(s.state.questions.find((q) => q.questionId === question.questionId)?.status).toBe('skipped');
    // An edit during the extraction is allowed, and leaves the graph marked outdated once the extraction ends.
    await s.saveDoc('flow.md', `${FLOW}\nEditado.\n`);
    release();
    await s.settled();
    expect(s.state.graphed ?? []).not.toContain('flow.md');
    await s.close();
  });
});

describe('the five documents of a request in the graph', () => {
  it('extracts each document alone, once, and extracts nothing again once they are there', async () => {
    const extract = vi.fn(extractDocs);
    const s = await RefineSession.create({ ...deps(), extractDocs: extract }, 'new-project', { repositories: true });
    await s.graphDocs();
    expect(extract).toHaveBeenCalledTimes(DOC_STAGES.length);
    // Each extraction reads one folder, which holds only its own document.
    expect(extract.mock.calls.map((call) => call[0] as string).every((dir, i) => dir.endsWith(`/files/${DOC_STAGES[i]}/docs`))).toBe(true);
    expect([...(s.state.graphed ?? [])].sort()).toEqual([...DOC_STAGES].sort());
    await s.graphDocs();
    expect(extract).toHaveBeenCalledTimes(DOC_STAGES.length);
  });

  it('journals a failed extraction in plain words and leaves the documents out of the graph', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs: async () => { throw new Error('O Graphify caiu.'); } }, 'new-project', { repositories: true });
    await s.graphDocs();
    expect(s.state.graphed ?? []).toEqual([]);
    expect(JSON.stringify(s.state.graphError)).toContain('O Graphify caiu.');
  });
});
