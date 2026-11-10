import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, writeDoc } from '../../server/refine/draft.js';
import { ConflictError, RefineSession } from '../../server/refine/session.js';
import { asTeamAlone } from '../../server/refine/team-rule.js';
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

  it('continues a stage the owner edited after its review, with no new review', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.saveDoc('flow.md', `${FLOW}\nNova etapa editada pelo dono.\n`);
    await expect(s.continueStage()).resolves.toBeUndefined();
    await s.settled();
    expect(s.state.doneStages).toEqual(['flow.md']);
    expect(s.state.graphed).toContain('flow.md');
    await s.close();
  });

  it('marks a later stage outdated by an edit of an earlier document as a notice, and keeps it done', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.continueStage();
    await s.settled();
    await s.evaluateStage('project.md');
    await s.continueStage('project.md');
    await s.settled();
    await s.saveDoc('flow.md', `${FLOW}\nEditado depois das etapas.\n`);
    expect(s.state.staleBy).toEqual({ 'project.md': 'flow.md' });
    expect(s.state.doneStages).toEqual(['flow.md', 'project.md']);
    await s.close();
  });

  it('leaves to the owner a rewording of a stage, even one that changes no scope, when the review ends', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO), [], [{ file: 'docs/flow.md', find: 'A[Início] --> B[Fim]', replace: 'A[Início] --> C[Fim]', reason: 'nome do passo' }])];
    await s.evaluateStage('flow.md');
    expect(s.state.patches.filter((p) => p.file === 'flow.md').map((p) => p.status)).toEqual(['pending']);
    await s.close();
  });

  it('accepts on its own an addition to a stage, when the review ends', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO), [], [{ file: 'docs/flow.md', find: 'A[Início] --> B[Fim]', replace: 'A[Início] --> B[Fim]\nB --> D[Log]', reason: 'passo novo' }])];
    await s.evaluateStage('flow.md');
    expect(s.state.patches.filter((p) => p.file === 'flow.md').map((p) => [p.status, p.auto])).toEqual([['accepted', true]]);
    await expect(s.continueStage()).resolves.toBeUndefined();
    await s.settled();
    await s.close();
  });

  it('the team alone accepts on its own a rewording of a stage that changes no scope, marked as automatic', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO), [], [{ file: 'docs/flow.md', find: 'A[Início] --> B[Fim]', replace: 'A[Início] --> C[Fim]', reason: 'nome do passo' }])];
    await asTeamAlone(true, () => s.evaluateStage('flow.md'));
    expect(s.state.patches.filter((p) => p.file === 'flow.md').map((p) => [p.status, p.auto])).toEqual([['accepted', true]]);
    await s.close();
  });

  it('the team alone leaves to the owner a rewording of a stage that cuts functionality', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO), [], [{ file: 'docs/flow.md', find: 'A[Início] --> B[Fim]', replace: '', reason: 'corte' }])];
    await asTeamAlone(true, () => s.evaluateStage('flow.md'));
    expect(s.state.patches.filter((p) => p.file === 'flow.md').map((p) => p.status)).toEqual(['pending']);
    await s.close();
  });

  it('the team alone accepts on its own an addition to a stage, marked as automatic', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO), [], [{ file: 'docs/flow.md', find: 'A[Início] --> B[Fim]', replace: 'A[Início] --> B[Fim]\n  B --> C[Extra]', reason: 'passo novo' }])];
    await asTeamAlone(true, () => s.evaluateStage('flow.md'));
    expect(s.state.patches.filter((p) => p.file === 'flow.md').map((p) => [p.status, p.auto])).toEqual([['accepted', true]]);
    await s.close();
  });

  it('a move waits for the owner even with the team alone; accepting it writes both documents, rejecting it writes none', async () => {
    const s = await plain();
    await writeDoc(draft(), 'project.md', '# Projeto\n\n## Regras\n\nO gestor aprova.\n');
    await writeDoc(draft(), 'briefing.md', '# Briefing\n\nQuem cancela: o gestor do contrato.\n\nPrazo de 30 dias.\n\nQuem paga: o titular.\n');
    const move = (quote: string) => ({ from: 'briefing.md', to: 'docs/project.md', quote, text: quote, after: 'O gestor aprova.', reason: 'quem pode agir' });
    script['refine/po'] = [{ ...refineOut(green(PO)), moves: [move('Quem cancela: o gestor do contrato.'), move('Quem paga: o titular.')] }];
    await asTeamAlone(true, () => s.evaluateStage('briefing.md'));
    const [kept, refused] = s.state.patches.filter((p) => p.also);
    expect([kept?.status, refused?.status]).toEqual(['pending', 'pending']);
    await s.reject(refused!.patchId, null);
    await s.accept(kept!.patchId);
    const project = await fs.readFile(`${draft().root}/docs/project.md`, 'utf8');
    const brief = await fs.readFile(`${draft().root}/docs/specs/hello-001/briefing.md`, 'utf8');
    expect(project).toContain('O gestor aprova.\n\nQuem cancela: o gestor do contrato.');
    expect(project).not.toContain('Quem paga');
    expect(brief).not.toContain('Quem cancela');
    expect(brief).toContain('Quem paga: o titular.');
    await s.close();
  });

  it('moves on with a suggestion still open: going on sets it aside, with the reason', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO), [], [{ file: 'docs/flow.md', find: 'A[Início] --> B[Fim]', replace: 'A[Início] --> C[Fim]', reason: 'nome do passo' }])];
    await s.evaluateStage('flow.md');
    const patch = s.state.patches.find((p) => p.file === 'flow.md' && p.status === 'pending');
    expect(patch).toBeDefined();
    await expect(s.continueStage()).resolves.toBeUndefined();
    await s.settled();
    expect(s.state.patches.find((p) => p.patchId === patch!.patchId)).toMatchObject({ status: 'rejected', decision: 'O dono seguiu sem alterações.' });
    expect(s.state.doneStages).toEqual(['flow.md']);
    await s.close();
  });

  it('moves on with a blocking question open: the PO answers it with the recommended choice', async () => {
    const s = await stamped();
    await writeDoc(draft(), 'flow.md', FLOW);
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q1', text: 'Qual é o primeiro passo?', blocking: true, relatedAcIds: [], options: [{ label: 'O cliente', detail: 'Começa pelo cliente.', recommended: true }, { label: 'A clínica', detail: 'Começa pela clínica.' }] }])];
    await s.evaluateStage('flow.md');
    const question = s.state.questions.find((q) => q.file === 'flow.md' && q.status === 'pending');
    await expect(s.continueStage()).resolves.toBeUndefined();
    await s.settled();
    expect(s.state.questions.find((q) => q.questionId === question!.questionId)).toMatchObject({ status: 'answered', answer: 'O cliente' });
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

  it('refuses to close the final review, to break the backlog or to plan before the five documents are done', async () => {
    const s = await stamped();
    await expect(s.closeReview()).rejects.toThrow(/Conclua as etapas dos documentos antes: falta flow\.md, project\.md, briefing\.md, stack\.md, design\.md/);
    await expect(s.enableBacklog()).rejects.toBeInstanceOf(ConflictError);
    expect(() => s.runPlans()).toThrow(ConflictError);
    await s.close();
  });
});
