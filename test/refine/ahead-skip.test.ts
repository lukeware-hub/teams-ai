import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bind, pushDocuments, storeOf } from '../../server/docs/store.js';
import { draftPaths, type Draft } from '../../server/refine/draft.js';
import { DocsSync } from '../../server/refine/docs-sync.js';
import type { CommandResult, Exec } from '../../server/exec/command.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { FakeGhRepos } from '../fixtures/fake-gh-repos.js';

const target = { owner: 'acme', name: 'hello-app' };
const DOCS = ['project.md', 'flow.md', 'briefing.md', 'design.md', 'stack.md'];

let root = '';
let ws: Workspace;
let draft: Draft;
let gh: FakeGhRepos;
let pushes = 0;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ahead-skip-'));
  ws = { projectId: 'hello-app', root, repo: path.join(root, 'repo'), worktrees: '', graph: '', knowledgeDb: '', secrets: '', runs: '' };
  draft = draftPaths(ws, 'hello-app-001');
  gh = new FakeGhRepos(root);
  pushes = 0;
  await fs.mkdir(draft.docs, { recursive: true });
  for (const doc of DOCS) await fs.writeFile(path.join(draft.docs, doc), `# ${doc}\n`);
  const documents = Object.fromEntries(DOCS.map((doc) => [`docs/${doc}`, `# ${doc}\n`]));
  await bind(ws, { style: 'monolith', target, draftId: 'hello-app-001', documents }, gh.exec);
  await pushDocuments(ws, storeOf(ws, 'monolith', gh.exec));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Counts the pushes the store makes, and passes every command on to the fake GitHub. */
const exec: Exec = async (spec): Promise<CommandResult> => {
  if (spec.bin === 'git' && spec.args.includes('push')) pushes += 1;
  return gh.exec(spec);
};

describe('DocsSync skips the push when nothing is ahead of origin main', () => {
  it('a tick with nothing ahead does not call the push', async () => {
    const sync = new DocsSync({ ws, draft, style: 'monolith', exec, aliases: () => [], timer: { set: () => 0, clear: () => undefined } });
    await sync.tick();
    await sync.publish();
    expect(pushes).toBe(0);
  });
});
