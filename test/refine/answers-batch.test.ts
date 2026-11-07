import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, readDoc, writeDoc } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { RefineSession } from '../../server/refine/session.js';
import { calls, makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';

let root = '';
let ws: Workspace;
let script: Script;

const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'];
const green = PO.map((id) => ({ id, passed: true, detail: 'ok' }));
const ask = (text: string) => ({ text, blocking: true, relatedAcIds: [], options: [] });
const out = (questions: unknown[] = []) => ({ checklist: green, questions, docPatch: [] });
const FLOW = '# Fluxo\n\n```mermaid\nflowchart TD\n  A[Início] --> B[Fim]\n```\n';
const draft = () => draftPaths(ws, 'hello-001');

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-answers-batch-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  await writeDoc(draft(), 'flow.md', FLOW);
  script = {};
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('answers wait for Reprocessar', () => {
  it('an answer runs no agent, and Reprocessar runs one review with every answer kept so far', async () => {
    const s = await RefineSession.create({ ws, draft: draft(), runAgent: makeFakeRunAgent(script), secretsDir: `${root}/secrets`, retrieval: () => [] }, 'new-project');
    script['refine/po'] = [out([ask('Quem usa?'), ask('Qual o prazo?')]), out(), out()];
    await s.evaluateStage('flow.md');
    calls.length = 0;
    const [q1, q2] = s.state.questions.filter((q) => q.status === 'pending');
    await s.answer(q1!.questionId, 'Clientes');
    await s.answer(q2!.questionId, '30 dias');
    expect(calls).toHaveLength(0);
    expect(s.state.questions.filter((q) => q.status === 'answered')).toHaveLength(2);
    await s.reprocessStage('flow.md');
    expect(calls.filter((c) => c.kind === 'refine' && c.role === 'po')).toHaveLength(1);
    expect(s.state.questions.filter((q) => q.status === 'answered')).toHaveLength(2);
    await s.close();
  });

  it('a decision on a question about flow.md changes no other document: its patch is dropped, with the reason', async () => {
    await writeDoc(draft(), 'project.md', '# Projeto\n\nTexto original.\n');
    const s = await RefineSession.create({ ws, draft: draft(), runAgent: makeFakeRunAgent(script), secretsDir: `${root}/secrets`, retrieval: () => [] }, 'new-project');
    script['refine/po'] = [out([ask('Quem usa?')]), { checklist: green, questions: [], docPatch: [{ file: 'project.md', find: 'Texto original.', replace: 'Texto novo.', reason: 'decisão' }] }, out()];
    await s.evaluateStage('flow.md');
    const question = s.state.questions.find((q) => q.status === 'pending');
    await s.decideAnswer(question!.questionId);
    expect(await readDoc(draft(), 'project.md')).toContain('Texto original.');
    expect(s.events.some((e) => e.type === RefineEvent.PatchDropped)).toBe(true);
    await s.close();
  });
});
