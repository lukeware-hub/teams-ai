import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bind } from '../../server/docs/store.js';
import { draftPaths, type Draft } from '../../server/refine/draft.js';
import { boundaryLabel } from '../../server/refine/docs-boundary.js';
import { DocsSync } from '../../server/refine/docs-sync.js';
import { RefineEvent } from '../../server/refine/events.js';
import type { Exec, CommandResult } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { makeSpec } from '../fixtures/contracts.js';
import { FakeGhRepos } from '../fixtures/fake-gh-repos.js';

const target = { owner: 'acme', name: 'hello-app' };
const DOCS = ['project.md', 'flow.md', 'briefing.md', 'design.md', 'stack.md'];

let root = '';
let ws: Workspace;
let draft: Draft;
let gh: FakeGhRepos;
let offline = false;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-sync-'));
  ws = { projectId: 'hello-app', root, repo: path.join(root, 'repo'), worktrees: '', graph: '', knowledgeDb: '', secrets: '', runs: '' };
  draft = draftPaths(ws, 'hello-app-001');
  gh = new FakeGhRepos(root);
  offline = false;
  await fs.mkdir(draft.docs, { recursive: true });
  for (const doc of DOCS) await fs.writeFile(path.join(draft.docs, doc), `# ${doc}\n`);
  const documents = Object.fromEntries(DOCS.map((doc) => [`docs/${doc}`, `# ${doc}\n`]));
  await bind(ws, { style: 'monolith', target, draftId: 'hello-app-001', documents }, gh.exec);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const origin = (): string => gh.repos.get('acme/hello-app')!.origin;
const commitCount = (): Promise<number> => git(origin(), ['rev-list', '--count', 'main']).then(Number);
const subject = (): Promise<string> => git(origin(), ['log', '-1', '--format=%s', 'main']);

/** The exec of the store: the fake GitHub, and a push that finds no network while `offline` is set. */
const exec: Exec = async (spec): Promise<CommandResult> => {
  if (offline && spec.bin === 'git' && spec.args.includes('push')) {
    return { exitCode: 1, signal: null, stdout: '', stderr: 'Could not resolve host: github.com', timedOut: false, durationMs: 1, truncated: false };
  }
  return gh.exec(spec);
};

/** A documents sync of the bound hello-app project, with no specs of its own yet. */
function sync(): DocsSync {
  return new DocsSync({ ws, draft, style: 'monolith', exec, aliases: () => [] });
}

/** Changes one document of the draft on disk, as an owner save does. */
const edit = (doc: string, text: string): Promise<void> => fs.writeFile(path.join(draft.docs, doc), text);

describe('DocsSync commits at boundaries', () => {
  it('a boundary makes one commit at the tick, named by its label, with the edit it rides', async () => {
    const s = sync();
    await edit('project.md', 'changed\n');
    s.boundary('backlog enabled');
    await s.tick();
    expect(await commitCount()).toBe(2);
    expect(await subject()).toBe('docs(refine): backlog enabled [skip ci]');
    expect(await git(origin(), ['show', 'main:docs/project.md'])).toBe('changed');
  });

  it('a document edit alone makes no commit until the next boundary', async () => {
    const s = sync();
    await edit('stack.md', 'stack changed\n');
    s.edit();
    await s.tick();
    expect(await commitCount()).toBe(1);
    s.boundary('spec hello-app-001-login');
    await s.tick();
    expect(await commitCount()).toBe(2);
    expect(await subject()).toBe('docs(refine): spec hello-app-001-login [skip ci]');
    expect(await git(origin(), ['show', 'main:docs/stack.md'])).toBe('stack changed');
  });
});

describe('DocsSync coalesces a burst', () => {
  it('six spec facts delivered in one tick give one commit, with the six specs', async () => {
    const aliases = ['hello-app-login', 'hello-app-cart', 'hello-app-search', 'hello-app-profile', 'hello-app-orders', 'hello-app-help'];
    for (const alias of aliases) {
      await fs.mkdir(path.join(draft.docs, 'specs', alias), { recursive: true });
      await fs.writeFile(path.join(draft.docs, 'specs', alias, 'spec.json'), JSON.stringify(makeSpec({ specId: alias, repository: 'hello-app' })));
    }
    const s = new DocsSync({ ws, draft, style: 'monolith', exec, aliases: () => aliases.map((alias) => ({ alias })) });
    for (const alias of aliases) s.boundary(boundaryLabel({ type: RefineEvent.SpecDerived, data: { specId: alias } }, null)!);
    await s.tick();
    expect(await commitCount()).toBe(2);
    expect(await subject()).toBe(`docs(refine): ${aliases.map((alias) => `spec ${alias}`).join(', ')} [skip ci]`);
    expect((await git(origin(), ['ls-tree', '-r', '--name-only', 'main', 'docs/specify'])).split('\n')).toHaveLength(6);
  });
});

describe('DocsSync retries a failed flush', () => {
  it('a flush that fails once is retried by the tick and then commits, without a second commit', async () => {
    const s = sync();
    await edit('project.md', 'changed\n');
    s.boundary('backlog enabled');
    offline = true;
    await s.tick();
    expect(await commitCount()).toBe(1);
    offline = false;
    await s.tick();
    expect(await commitCount()).toBe(2);
    await s.tick();
    expect(await commitCount()).toBe(2);
  });
});
