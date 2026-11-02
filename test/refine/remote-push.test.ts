import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bind, storeOf } from '../../server/docs/store.js';
import { readDocsMarker, docsStoreDir } from '../../server/docs/project-state.js';
import { draftPaths, type Draft } from '../../server/refine/draft.js';
import { DocsSync, type PushTimer } from '../../server/refine/docs-sync.js';
import type { CommandResult, Exec } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { FakeGhRepos } from '../fixtures/fake-gh-repos.js';

const target = { owner: 'acme', name: 'hello-app' };
const DOCS = ['project.md', 'flow.md', 'briefing.md', 'design.md', 'stack.md'];

let root = '';
let ws: Workspace;
let draft: Draft;
let gh: FakeGhRepos;
let offline = false;
let pushes = 0;
let attempts = 0;

/** A push timer that runs the debounced push only when the test fires it. */
class ManualTimer implements PushTimer {
  private run: (() => void) | null = null;
  set(run: () => void): unknown {
    this.run = run;
    return 1;
  }
  clear(): void {
    this.run = null;
  }
  fire(): void {
    const run = this.run;
    this.run = null;
    run?.();
  }
}

let timer = new ManualTimer();

const failed = (stderr: string): CommandResult => ({ exitCode: 1, signal: null, stdout: '', stderr, timedOut: false, durationMs: 1, truncated: false });

/** The store's exec: the fake GitHub, with the create and the network git calls failing while `offline` is set; pushes are counted. */
const exec: Exec = async (spec): Promise<CommandResult> => {
  const create = spec.bin === 'gh' && spec.args[0] === 'repo' && spec.args[1] === 'create';
  const network = spec.bin === 'git' && (spec.args.includes('fetch') || spec.args.includes('push'));
  if (spec.bin === 'git' && spec.args.includes('push')) attempts += 1;
  if (offline && (create || network)) return failed('Could not resolve host: api.github.com');
  if (spec.bin === 'git' && spec.args.includes('push')) pushes += 1;
  return gh.exec(spec);
};

const origin = (): string => gh.repos.get('acme/hello-app')!.origin;
const documents = Object.fromEntries(DOCS.map((doc) => [`docs/${doc}`, `# ${doc}\n`]));

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lane1-remote-'));
  ws = { projectId: 'hello-app', root, repo: path.join(root, 'repo'), worktrees: '', graph: '', knowledgeDb: '', secrets: '', runs: '' };
  draft = draftPaths(ws, 'hello-app-001');
  gh = new FakeGhRepos(root);
  offline = false;
  pushes = 0;
  attempts = 0;
  timer = new ManualTimer();
  await fs.mkdir(draft.docs, { recursive: true });
  for (const doc of DOCS) await fs.writeFile(path.join(draft.docs, doc), `# ${doc}\n`);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const sync = (clock?: () => number): DocsSync => new DocsSync({ ws, draft, style: 'monolith', exec, aliases: () => [], timer, secretDirs: async () => [], clock });
const edit = (doc: string, text: string): Promise<void> => fs.writeFile(path.join(draft.docs, doc), text);

/** Another writer changes a file on origin main, from a clone, so the next push is not a fast-forward. */
async function divergeOrigin(file: string, text: string): Promise<void> {
  const clone = path.join(root, 'other-clone');
  await git(root, ['clone', '-q', origin(), clone]);
  await fs.writeFile(path.join(clone, file), text);
  await git(clone, ['-c', 'user.name=other', '-c', 'user.email=other@example.com', 'commit', '-q', '-am', 'other side']);
  await git(clone, ['push', '-q', 'origin', 'main']);
}

describe('a bind publishes its remote part in the background, and a failed remote is retried', () => {
  it('a remote failure leaves the bind successful, shows the error in the sync view, and the retry publishes once the remote recovers', async () => {
    offline = true;
    await bind(ws, { style: 'monolith', target, draftId: 'hello-app-001', documents }, exec);
    expect(await readDocsMarker(ws)).toEqual({ layout: 'docs-repo', style: 'monolith', target, firstSha: null });

    const s = sync();
    await s.publish();
    expect(s.view.lastError).not.toBeNull();
    expect(s.view.lastError).not.toContain('Could not resolve host');

    offline = false;
    await s.tick();
    expect(s.view.lastError).toBeNull();
    expect(await git(origin(), ['rev-parse', 'main'])).toBe(await git(docsStoreDir(ws), ['rev-parse', 'HEAD']));
    expect((await readDocsMarker(ws))?.firstSha).toBe(await git(docsStoreDir(ws), ['rev-parse', 'HEAD']));
  });

  it('a preflight refusal still throws from the bind, before any remote effect', async () => {
    const origin = path.join(root, 'public.git');
    await fs.mkdir(origin, { recursive: true });
    await git(origin, ['init', '--bare', '-b', 'main']);
    gh.register('acme/hello-app', origin, { isPrivate: false });
    await expect(bind(ws, { style: 'monolith', target, draftId: 'hello-app-001', documents }, exec)).rejects.toThrow(/é público/);
    expect(await readDocsMarker(ws)).toBeNull();
  });
});

describe('normal flushes push after a trailing debounce', () => {
  it('two flushes inside the debounce time produce one push', async () => {
    await bind(ws, { style: 'monolith', target, draftId: 'hello-app-001', documents }, exec);
    const s = sync();
    await s.publish();
    pushes = 0;

    await edit('project.md', 'first\n');
    s.edit();
    await s.flush();
    await edit('stack.md', 'second\n');
    s.edit();
    await s.flush();
    expect(pushes).toBe(0);

    await settle(s);
    expect(pushes).toBe(1);
    expect(await git(origin(), ['show', 'main:docs/stack.md'])).toBe('second');
  });

  it('a debounced commit stays counted in pending until its push succeeds', async () => {
    await bind(ws, { style: 'monolith', target, draftId: 'hello-app-001', documents }, exec);
    const s = sync();
    await s.publish();

    await edit('project.md', 'counted\n');
    s.boundary('spec hello-app-001-login');
    await s.tick();
    expect(s.view.pending).toBe(1);

    await settle(s);
    expect(s.view.pending).toBe(0);
  });

  it('a debounced commit reset by a non-fast-forward push is projected again on the next tick, and the other documents are not lost', async () => {
    await bind(ws, { style: 'monolith', target, draftId: 'hello-app-001', documents }, exec);
    const s = sync();
    await s.publish();

    await edit('project.md', 'counted\n');
    await edit('stack.md', 'stack kept\n');
    s.boundary('spec hello-app-001-login');
    await s.tick();
    await divergeOrigin('docs/project.md', 'theirs\n');
    timer.fire();
    await s.publish();
    expect(s.view.lastError).toMatch(/Another change reached main first/);
    expect(s.view.pending).toBe(1);

    await s.tick();
    await settle(s);
    expect(await git(origin(), ['show', 'main:docs/stack.md'])).toBe('stack kept');
    expect(await git(origin(), ['show', 'main:docs/project.md'])).toBe('theirs');
    expect(s.view).toEqual({ pending: 1, lastError: expect.stringContaining('docs/project.md'), refused: true });
  });

  it('a failed sync is retried at most once a minute: two ticks inside a minute run one retry, and a tick after a minute runs another', async () => {
    await bind(ws, { style: 'monolith', target, draftId: 'hello-app-001', documents }, exec);
    let now = 0;
    const s = sync(() => now);
    await s.publish();

    await edit('project.md', 'retried\n');
    s.edit();
    await s.flush();
    offline = true;
    timer.fire();
    await s.publish();
    expect(s.view.lastError).not.toBeNull();

    attempts = 0;
    now = 0;
    await s.tick();
    expect(attempts).toBe(1);
    now = 10_000;
    await s.tick();
    expect(attempts).toBe(1);
    now = 60_000;
    await s.tick();
    expect(attempts).toBe(2);
  });

  it('a PlansPrepared boundary pushes at once, without waiting for the debounce', async () => {
    await bind(ws, { style: 'monolith', target, draftId: 'hello-app-001', documents }, exec);
    const s = sync();
    await s.publish();

    await edit('flow.md', 'plans\n');
    s.boundary('plans prepared');
    await s.tick();
    expect(await git(origin(), ['show', 'main:docs/flow.md'])).toBe('plans');
  });
});

/** The debounce time passes, then the pending push finishes. */
async function settle(s: DocsSync): Promise<void> {
  timer.fire();
  await s.tick();
}
