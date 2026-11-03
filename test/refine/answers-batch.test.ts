import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, writeDoc } from '../../server/refine/draft.js';
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

describe('answers while a stage review runs', () => {
  it('records every answer and runs one more review for the whole batch', async () => {
    const s = await RefineSession.create({ ws, draft: draft(), runAgent: makeFakeRunAgent(script), secretsDir: `${root}/secrets`, retrieval: () => [] }, 'new-project');
    script['refine/po'] = [out([ask('Quem usa?'), ask('Qual o prazo?')]), out(), out()];
    await s.evaluateStage('flow.md');
    calls.length = 0;
    const [q1, q2] = s.state.questions.filter((q) => q.status === 'pending');
    const running = s.reprocessStage('flow.md').catch(() => s.evaluateStage('flow.md'));
    await s.answer(q1!.questionId, 'Clientes');
    await s.answer(q2!.questionId, '30 dias');
    const first = s.reviewAfterAnswers('flow.md');
    expect(s.reviewAfterAnswers('flow.md')).toBe(first);
    await running;
    await first;
    expect(s.state.questions.filter((q) => q.status === 'answered')).toHaveLength(2);
    expect(calls.filter((c) => c.kind === 'refine' && c.role === 'po')).toHaveLength(1);
    await s.close();
  });

  it('a review the round limit refuses rejects the promise, never throws at the caller', async () => {
    const s = await RefineSession.create({ ws, draft: draft(), runAgent: makeFakeRunAgent(script), secretsDir: `${root}/secrets`, retrieval: () => [] }, 'new-spec');
    let thrown = false;
    let p: Promise<void> | undefined;
    try {
      p = s.reviewAfterAnswers('flow.md');
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);
    await expect(p).rejects.toThrow();
    await s.close();
  });
});
