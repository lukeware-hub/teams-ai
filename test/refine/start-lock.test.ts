import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths } from '../../server/refine/draft.js';
import { BusyError, RefineSession } from '../../server/refine/session.js';
import { makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';

let root = '';
let ws: Workspace;
let script: Script;

const draft = () => draftPaths(ws, 'hello-001');
const deps = () => ({ ws, draft: draft(), runAgent: makeFakeRunAgent(script), secretsDir: `${root}/secrets`, retrieval: () => [] });

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-start-lock-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  script = {};
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('the start lock', () => {
  it('a discard during a start is refused until the start fails', async () => {
    const s = await RefineSession.create(deps(), 'new-spec');
    s.beginStart();
    expect(() => s.beginDiscard()).toThrow(BusyError);
    s.failStart();
    expect(() => s.beginDiscard()).not.toThrow();
    await s.close();
  });

  it('a second start during a start gets BusyError and does not clear the first start\'s lock', async () => {
    const s = await RefineSession.create(deps(), 'new-spec');
    s.beginStart();
    expect(() => s.beginStart()).toThrow(BusyError);
    expect(() => s.beginDiscard()).toThrow(BusyError);
    await s.close();
  });

  it('a main sync during a start is refused and does not release the start', async () => {
    const s = await RefineSession.create(deps(), 'new-spec');
    s.beginStart();
    await expect(s.syncWithMain(async () => [])).rejects.toBeInstanceOf(BusyError);
    expect(() => s.beginStart()).toThrow(BusyError);
    await s.close();
  });

  it('a main sync during a start is refused and does not release the start', async () => {
    const s = await RefineSession.create(deps(), 'new-spec');
    s.beginStart();
    await expect(s.syncWithMain(async () => [])).rejects.toBeInstanceOf(BusyError);
    expect(() => s.beginStart()).toThrow(BusyError);
    await s.close();
  });

  it('a start that failed before its run released the lock, so the draft can start again', async () => {
    const s = await RefineSession.create(deps(), 'new-spec');
    s.beginStart();
    s.failStart();
    s.beginStart();
    s.failStart();
    await s.close();
  });
});
