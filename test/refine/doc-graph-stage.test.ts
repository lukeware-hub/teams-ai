import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, writeDoc } from '../../server/refine/draft.js';
import { DOC_STAGES } from '../../server/refine/doc-stages.js';
import { RefineSession } from '../../server/refine/session.js';
import { makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';

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
async function extractDocs(dir: string, outDir: string, tokens = { input_tokens: 2500, output_tokens: 90 }): Promise<void> {
  const files = await fs.readdir(dir);
  await fs.mkdir(path.join(outDir, 'graphify-out'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: files.map((file) => ({ id: file, source_file: file })), edges: [], ...tokens }));
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
    const slow = async (dir: string, outDir: string) => {
      await gate;
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
    script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO)), refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions', 'sm.flow-is-mermaid']))];
    script['refine/front'] = [refineOut([])];
    for (const file of DOC_STAGES) {
      await s.evaluateStage(file);
      await s.continueStage();
      await s.settled();
    }
    expect(s.state.doneStages).toEqual([...DOC_STAGES]);
    await s.saveDoc('flow.md', `${FLOW}\nEditado depois da etapa.\n`);
    await expect(s.enableBacklog()).rejects.toThrow(/Adicione os cinco documentos ao Graphify antes: falta flow\.md/);
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
});
