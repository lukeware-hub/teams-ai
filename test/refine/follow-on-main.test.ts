import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeState } from '../../server/docs/project-state.js';
import type { Store } from '../../server/docs/store.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { execCommand } from '../../server/exec/command.js';
import { createFromRepo, draftPaths, readBase, readDoc, type Draft } from '../../server/refine/draft.js';
import { docsRepoMain } from '../../server/refine/docs-main.js';
import { makeProject } from '../fixtures/contracts.js';
import { cloneStore, publish } from '../fixtures/docs-store-clone.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const PROJECT_JSON = `${JSON.stringify(makeProject(), null, 2)}\n`;
const FIVE: Record<string, string> = {
  'docs/project.md': '# Projeto\n\nVisão do produto.\n',
  'docs/flow.md': '# Fluxo\n\nAbre e fecha.\n',
  'docs/briefing.md': '# Briefing\n\nO pedido do projeto.\n',
  'docs/design.md': '# Design\n\nTela simples.\n',
  'docs/stack.md': '# Stack\n\nNode 18.\n',
};

let root = '';
let ws: Workspace;
let remote: Remote;
let store: Store;
let draft: Draft;

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-follow-on-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root: `${root}/hello-app`, repo: `${root}/hello-app/repo`, worktrees: `${root}/hello-app/worktrees`, graph: `${root}/hello-app/graph`, knowledgeDb: `${root}/hello-app/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await fs.mkdir(ws.root, { recursive: true });
  remote = await makeRemote({ 'README.md': '# readme\n' });
  store = await cloneStore(ws, remote);
  await publish(store, { draftId: 'alpha-001', stepKey: 'close', scope: 'refine', label: 'documents', files: { ...FIVE, 'docs/specify/alpha/spec.md': '# Alpha\n' } });
  await writeState(ws, 'project.json', PROJECT_JSON);
  draft = draftPaths(ws, 'beta-001');
});
afterEach(async () => {
  await remote.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

describe('a follow-on draft of a documentation repository reads main from the store', () => {
  it('gets the five documents and the briefing from the store, and the JSON from the mirror', async () => {
    await createFromRepo(draft, store.dir, execCommand, { kind: 'new-spec', description: 'Listar usuários' }, docsRepoMain(ws, store));
    expect(await readDoc(draft, 'project.md')).toBe(FIVE['docs/project.md']);
    expect(await readDoc(draft, 'stack.md')).toBe(FIVE['docs/stack.md']);
    expect(await readBase(draft, 'briefing.md')).toBe(FIVE['docs/briefing.md']);
    expect(await readBase(draft, 'flow.md')).toBe(FIVE['docs/flow.md']);
    expect(await fs.readFile(draft.projectJson, 'utf8')).toBe(PROJECT_JSON);
  });

  it('does not copy the markdown of another draft into the draft', async () => {
    await createFromRepo(draft, store.dir, execCommand, { kind: 'new-spec' }, docsRepoMain(ws, store));
    await expect(fs.access(path.join(draft.docs, 'specify'))).rejects.toThrow();
    await expect(fs.access(path.join(draft.docs, 'specs', 'alpha-001'))).rejects.toThrow();
  });

  it('a legacy project keeps copying the files of main under docs/ with the same bytes', async () => {
    await remote.cleanup();
    remote = await makeRemote({ 'docs/project.json': PROJECT_JSON, 'docs/project.md': '# P\n', 'docs/specs/old-001/spec.json': '{}\n' });
    const legacy = draftPaths(ws, 'hello-001');
    await createFromRepo(legacy, remote.repo, execCommand, { kind: 'new-spec' });
    expect(await fs.readFile(legacy.projectJson, 'utf8')).toBe(PROJECT_JSON);
    expect(await fs.readFile(path.join(legacy.docs, 'specs', 'old-001', 'spec.json'), 'utf8')).toBe('{}\n');
  });
});
