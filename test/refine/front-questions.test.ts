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
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-front-questions-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  script = {};
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('design stage questions', () => {
  it('a visual scope gap Front finds reaches the owner through the PO', async () => {
    const s = await RefineSession.create({ ws, draft: draft(), runAgent: makeFakeRunAgent(script), secretsDir: `${root}/secrets`, retrieval: () => [] }, 'new-project', { repositories: false });
    await writeDoc(draft(), 'design.md', '# Design\n');
    script['refine/front'] = [{ checklist: [], questions: [{ text: 'O produto tem modo escuro?', blocking: false, relatedAcIds: [], options: [] }], docPatch: [] }];
    await s.evaluateStage('design.md');
    expect(s.state.questions.filter((q) => q.file === 'design.md')).toMatchObject([{ role: 'po', text: 'O produto tem modo escuro?' }]);
    await s.close();
  });
});
