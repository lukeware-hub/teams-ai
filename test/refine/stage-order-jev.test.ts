import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, writeDoc } from '../../server/refine/draft.js';
import { RefineSession } from '../../server/refine/session.js';
import { makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';

let root = '';
let ws: Workspace;
let script: Script;
const draft = () => draftPaths(ws, 'hello-001');

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-jev-order-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  script = {};
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('the Jev reads the stage document as the reshape left it', () => {
  it('reshapes first, so the Jev never validates text that is about to change', async () => {
    const order: string[] = [];
    const base = makeFakeRunAgent(script);
    const runAgent = ((req: { kind: string }, ctx: unknown) => {
      order.push(req.kind);
      return (base as never as (r: unknown, c: unknown) => unknown)(req, ctx);
    }) as never;
    const validateDocs = (async () => {
      order.push('jev');
      return { available: true, decision: 'ok', docs: null } as never;
    }) as never;
    const s = await RefineSession.create({ ws, draft: draft(), runAgent, secretsDir: `${root}/secrets`, retrieval: () => [], validateDocs }, 'new-project', { repositories: false });
    await s.answerConfidentiality(false);
    await writeDoc(draft(), 'flow.md', '# Fluxo\n');
    await writeDoc(draft(), 'project.md', 'texto solto sem o modelo do documento\n');
    script['suggest/po'] = [{ text: '# Project\n\nTexto.\n' }];
    script['refine/po'] = [{ checklist: [], questions: [], docPatch: [] }];
    await s.evaluateStage('project.md');
    const reshape = order.indexOf('suggest');
    const jev = order.indexOf('jev');
    expect(jev).toBeGreaterThan(-1);
    expect(reshape).toBeGreaterThan(-1);
    expect(reshape).toBeLessThan(jev);
    await s.close();
  });
});
