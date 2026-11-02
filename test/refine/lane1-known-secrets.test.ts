import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSecret } from '../../server/core/secrets.js';
import { bind } from '../../server/docs/store.js';
import { draftPaths, type Draft } from '../../server/refine/draft.js';
import { DocsSync } from '../../server/refine/docs-sync.js';
import type { Exec, CommandResult } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { FakeGhRepos } from '../fixtures/fake-gh-repos.js';

const target = { owner: 'acme', name: 'hello-app' };
const DOCS = ['project.md', 'flow.md', 'briefing.md', 'design.md', 'stack.md'];
const SECRET = 'k3y-value-0123456789';

let root = '';
let ws: Workspace;
let draft: Draft;
let gh: FakeGhRepos;
let secretsDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lane1-secrets-'));
  secretsDir = path.join(root, 'secrets');
  ws = { projectId: 'hello-app', root, repo: path.join(root, 'repo'), worktrees: '', graph: '', knowledgeDb: '', secrets: secretsDir, runs: '' };
  draft = draftPaths(ws, 'hello-app-001');
  gh = new FakeGhRepos(root);
  await fs.mkdir(draft.docs, { recursive: true });
  for (const doc of DOCS) await fs.writeFile(path.join(draft.docs, doc), `# ${doc}\n`);
  const documents = Object.fromEntries(DOCS.map((doc) => [`docs/${doc}`, `# ${doc}\n`]));
  await bind(ws, { style: 'monolith', target, draftId: 'hello-app-001', documents }, gh.exec);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const origin = (): string => gh.repos.get('acme/hello-app')!.origin;
const exec: Exec = (spec): Promise<CommandResult> => gh.exec(spec);

/** A documents sync that reads the test's secrets directory as its only one. */
function sync(): DocsSync {
  return new DocsSync({ ws, draft, style: 'monolith', exec, aliases: () => [], secretDirs: async () => [secretsDir] });
}

/** Changes one document of the draft on disk, as an owner save does. */
const edit = (doc: string, text: string): Promise<void> => fs.writeFile(path.join(draft.docs, doc), text);

describe('DocsSync refuses a flush that holds a known secret value', () => {
  it('a document with a known secret value refuses the whole flush, names the file, and never prints the value', async () => {
    await writeSecret(secretsDir, 'API_KEY', SECRET);
    await edit('project.md', `token ${SECRET}\n`);
    const s = sync();
    s.edit();
    await s.flush();
    expect(s.view.lastError).toContain('docs/project.md');
    expect(JSON.stringify(s.view)).not.toContain(SECRET);
    expect(await git(origin(), ['show', 'main:docs/project.md'])).toBe('# project.md');
  });

  it('a URL-encoded secret value in a document refuses the flush too', async () => {
    const value = 'tok en/with+chars 1234';
    await writeSecret(secretsDir, 'API_KEY', value);
    await edit('stack.md', `url ${encodeURIComponent(value)}\n`);
    const s = sync();
    s.edit();
    await s.flush();
    expect(s.view.lastError).toContain('docs/stack.md');
    expect(JSON.stringify(s.view)).not.toContain(encodeURIComponent(value));
  });

  it('a short secret value below 12 characters does not refuse a document', async () => {
    await writeSecret(secretsDir, 'SHORT_KEY', 'abc123');
    await edit('project.md', 'mentions abc123 in plain words\n');
    const s = sync();
    s.edit();
    await s.flush();
    expect(s.view.lastError).toBeNull();
    expect(await git(origin(), ['show', 'main:docs/project.md'])).toBe('mentions abc123 in plain words');
  });
});
