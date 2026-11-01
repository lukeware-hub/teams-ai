import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, writeDoc } from '../../server/refine/draft.js';
import { ConflictError, RefineSession } from '../../server/refine/session.js';
import { calls, makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';

let root = '';
let ws: Workspace;
let secretsDir = '';
let script: Script;

const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'];
const green = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
const refineOut = (checklist: unknown[], questions: unknown[] = [], docPatch: unknown[] = []) => ({ checklist, questions, docPatch });
/** A flow.md with one Mermaid diagram, the shape the first stage must reach before it can be continued. */
const FLOW = '# Fluxo\n\n```mermaid\nflowchart TD\n  A[Início] --> B[Fim]\n```\n';
/** The state an unstamped session of today reaches after a fixed script: written once, before the stage-order change. */
const FIXTURE = new URL('../fixtures/refine/stage-session.state.json', import.meta.url);

const draft = () => draftPaths(ws, 'hello-001');
const deps = () => ({ ws, draft: draft(), runAgent: makeFakeRunAgent(script), secretsDir, retrieval: () => [] });
const plain = () => RefineSession.create(deps(), 'new-project', { repositories: false });
/** A graphify stand-in for the stages: one node per document of the folder, so every document counts in the graph. */
const extractDocs = async (dir: string, outDir: string) => {
  const files = await fs.readdir(dir);
  await fs.mkdir(path.join(outDir, 'graphify-out'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: files.map((file) => ({ id: file, source_file: file })), edges: [], input_tokens: 1, output_tokens: 1 }));
};
const stamped = () => RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
/** The state without the timestamps of the evaluation clock, which differ on every run. */
const normalize = (state: unknown) => {
  const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  delete copy.evaluation;
  return copy;
};

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-stage-order-'))).replace(/\\/g, '/');
  secretsDir = `${root}/secrets`;
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  script = {};
  calls.length = 0;
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('stage order, unstamped sessions', () => {
  it('reaches the same state as before the change for a fixed script (fixture written before the change)', async () => {
    const s = await plain();
    await s.answerConfidentiality(false);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.continueStage();
    await s.saveDoc('project.md', '# Projeto\n\nTexto editado pelo dono.\n');
    await s.continueStage('project.md');
    const state = normalize(s.state);
    if (process.env.UPDATE_STATE_FIXTURE) {
      await fs.mkdir(new URL('.', FIXTURE), { recursive: true });
      await fs.writeFile(FIXTURE, `${JSON.stringify(state, null, 2)}\n`);
    } else {
      expect(state).toEqual(JSON.parse(await fs.readFile(FIXTURE, 'utf8')));
    }
    await s.close();
  });

  it('lets a stage be continued out of order, as before', async () => {
    const s = await plain();
    await expect(s.continueStage('project.md')).resolves.toBeUndefined();
    expect(s.state.doneStages).toEqual(['project.md']);
    await s.close();
  });

  it('writes no stamp, so an old session keeps its state', async () => {
    const s = await plain();
    expect(s.state.repositories).toBeUndefined();
    expect(s.events.find((e) => e.type === 'REFINE_CREATED')?.data).not.toHaveProperty('repositories');
    await s.close();
  });
});

describe('stage order, stamped sessions', () => {
  it('writes the stamp into the creation event and the state', async () => {
    const s = await stamped();
    expect(s.state.repositories).toBe(true);
    expect(s.events.find((e) => e.type === 'REFINE_CREATED')?.data).toMatchObject({ repositories: true });
    await s.close();
  });

  it('refuses to continue a stage that is not the first one undone, with the stage to do first named', async () => {
    const s = await stamped();
    await expect(s.continueStage('project.md')).rejects.toThrow(/Conclua a etapa flow\.md antes de trabalhar em project\.md/);
    await expect(s.continueStage('project.md')).rejects.toBeInstanceOf(ConflictError);
    expect(s.state.doneStages ?? []).toEqual([]);
    await s.close();
  });

  it('refuses to review a later stage before the earlier ones are done', async () => {
    const s = await stamped();
    expect(() => s.evaluateStage('briefing.md')).toThrow(/Conclua a etapa flow\.md/);
    await s.close();
  });

  it('refuses to suggest a later document before the earlier ones are done', async () => {
    const s = await stamped();
    await expect(s.suggest('briefing.md')).rejects.toThrow(/Conclua a etapa flow\.md antes de trabalhar em briefing\.md/);
    await s.close();
  });

  it('refuses to continue a stage nobody reviewed, and says what to do', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    await expect(s.continueStage()).rejects.toThrow(/Revise a etapa flow\.md antes de continuar/);
    await s.close();
  });

  it('continues a stage after its review, and the next stage becomes the current one', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.continueStage();
    await s.settled();
    expect(s.state.doneStages).toEqual(['flow.md']);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('project.md');
    await expect(s.continueStage('project.md')).resolves.toBeUndefined();
    await s.settled();
    expect(s.state.doneStages).toEqual(['flow.md', 'project.md']);
    await s.close();
  });

  it('sends a stage back for review when the owner edits its document after the review', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.saveDoc('flow.md', `${FLOW}\nNova etapa editada pelo dono.\n`);
    await expect(s.continueStage()).rejects.toThrow(/Revise a etapa flow\.md antes de continuar/);
    await s.close();
  });

  it('keeps the review valid when the owner accepts a patch of the review itself', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO), [], [{ file: 'docs/flow.md', find: 'A[Início] --> B[Fim]', replace: 'A[Início] --> C[Fim]', reason: 'nome do passo' }])];
    await s.evaluateStage('flow.md');
    const patch = s.state.patches.find((p) => p.file === 'flow.md' && p.status === 'pending');
    expect(patch).toBeDefined();
    await expect(s.continueStage()).rejects.toThrow(/Aceite ou rejeite as sugestões da etapa flow\.md/);
    await s.accept(patch!.patchId);
    await expect(s.continueStage()).resolves.toBeUndefined();
    await s.settled();
    expect(s.state.doneStages).toEqual(['flow.md']);
    await s.close();
  });

  it('holds the continuation while a blocking question of the stage is open, and frees it once answered', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q1', text: 'Qual é o primeiro passo?', blocking: true, relatedAcIds: [], options: [] }])];
    await s.evaluateStage('flow.md');
    await expect(s.continueStage()).rejects.toThrow(/Responda as perguntas obrigatórias da etapa flow\.md/);
    const question = s.state.questions.find((q) => q.file === 'flow.md' && q.status === 'pending');
    await s.answer(question!.questionId, 'O cliente.');
    await expect(s.continueStage()).resolves.toBeUndefined();
    await s.settled();
    await s.close();
  });

  it('lets a finished stage be reviewed again, while a later one still waits', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.continueStage();
    await s.settled();
    await s.evaluateStage('flow.md');
    expect(() => s.evaluateStage('briefing.md')).toThrow(/Conclua a etapa project\.md/);
    await s.close();
  });

  it('refuses to close the final review, to evaluate, to break the backlog or to plan before the five documents are done', async () => {
    const s = await stamped();
    await expect(s.closeReview()).rejects.toThrow(/Conclua as etapas dos documentos antes: falta flow\.md, project\.md, briefing\.md, stack\.md, design\.md/);
    await expect(s.evaluate()).rejects.toBeInstanceOf(ConflictError);
    await expect(s.enableBacklog()).rejects.toBeInstanceOf(ConflictError);
    expect(() => s.runPlans()).toThrow(ConflictError);
    await s.close();
  });
});
