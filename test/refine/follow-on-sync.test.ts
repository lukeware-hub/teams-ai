import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeState } from '../../server/docs/project-state.js';
import type { Store } from '../../server/docs/store.js';
import { execCommand } from '../../server/exec/command.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createFromRepo, draftPaths, MainConflict, readBase, readDoc, syncWithMain, writeDoc, type Draft } from '../../server/refine/draft.js';
import { docsRepoMain } from '../../server/refine/docs-main.js';
import { makeProject } from '../fixtures/contracts.js';
import { cloneStore, publish } from '../fixtures/docs-store-clone.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const PROJECT_JSON = `${JSON.stringify(makeProject(), null, 2)}\n`;
const STACK = '# Stack\n\n## Runtime\n\nNode 18.\n\n## Storage\n\nSQLite.\n';

let root = '';
let ws: Workspace;
let remote: Remote;
let store: Store;
let first: Draft;
let second: Draft;

const main = () => docsRepoMain(ws, store);

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-follow-sync-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root: `${root}/hello-app`, repo: `${root}/hello-app/repo`, worktrees: `${root}/hello-app/worktrees`, graph: `${root}/hello-app/graph`, knowledgeDb: `${root}/hello-app/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await fs.mkdir(ws.root, { recursive: true });
  remote = await makeRemote({ 'README.md': '# readme\n' });
  store = await cloneStore(ws, remote);
  await publish(store, {
    draftId: 'alpha-001',
    stepKey: 'close',
    scope: 'refine',
    label: 'documents',
    files: { 'docs/project.md': '# Projeto\n', 'docs/flow.md': '# Fluxo\n', 'docs/briefing.md': '# Briefing\n', 'docs/design.md': '# Design\n', 'docs/stack.md': STACK },
  });
  await writeState(ws, 'project.json', PROJECT_JSON);
  first = draftPaths(ws, 'beta-001');
  second = draftPaths(ws, 'gamma-001');
  await createFromRepo(first, store.dir, execCommand, { kind: 'new-spec' }, main());
  await createFromRepo(second, store.dir, execCommand, { kind: 'new-spec' }, main());
});
afterEach(async () => {
  await remote.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

/** The first draft edits stack.md and its edit reaches the store, as its own boundary does. */
async function firstDraftPublishes(stack: string): Promise<void> {
  await writeDoc(first, 'stack.md', stack);
  await publish(store, { draftId: first.specId, stepKey: 'docs', scope: 'refine', label: 'stack', files: { 'docs/stack.md': stack }, bases: { 'docs/stack.md': STACK } });
}

describe('the closing sync of a documentation repository merges without union', () => {
  it('refuses a start when the same line changed on both sides, names the document, and keeps the markers', async () => {
    await firstDraftPublishes(STACK.replace('Node 18.', 'Node 20.'));
    await writeDoc(second, 'stack.md', STACK.replace('Node 18.', 'Node 22.'));
    const refusal = syncWithMain(second, store.dir, execCommand, main());
    await expect(refusal).rejects.toBeInstanceOf(MainConflict);
    await expect(refusal).rejects.toThrow(/stack\.md/);
    const text = await readDoc(second, 'stack.md');
    expect(text).toContain('<<<<<<<');
    expect(text).toContain('>>>>>>>');
    expect(text.split('Node 20.').length - 1).toBe(1);
    expect(text.split('Node 22.').length - 1).toBe(1);
    expect(text).not.toContain('Node 18.');
  });

  it('moves the base copy to main, so the next sync still refuses while the markers stay in the draft', async () => {
    await firstDraftPublishes(STACK.replace('Node 18.', 'Node 20.'));
    await writeDoc(second, 'stack.md', STACK.replace('Node 18.', 'Node 22.'));
    await expect(syncWithMain(second, store.dir, execCommand, main())).rejects.toThrow(/stack\.md/);
    expect(await readBase(second, 'stack.md')).toBe(STACK.replace('Node 18.', 'Node 20.'));
    await expect(syncWithMain(second, store.dir, execCommand, main())).rejects.toThrow(/stack\.md/);
  });

  it('merges edits to different lines without markers and reports the project doc as changed', async () => {
    await firstDraftPublishes(STACK.replace('Node 18.', 'Node 20.'));
    await writeDoc(second, 'stack.md', STACK.replace('SQLite.', 'PostgreSQL.'));
    const changed = await syncWithMain(second, store.dir, execCommand, main());
    expect(changed.map((c) => c.file)).toEqual(['stack.md']);
    expect(await readDoc(second, 'stack.md')).toBe(STACK.replace('Node 18.', 'Node 20.').replace('SQLite.', 'PostgreSQL.'));
  });
});
