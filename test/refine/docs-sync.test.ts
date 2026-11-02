import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readClosingRecord } from '../../server/docs/project-state.js';
import { bind, commitProjection, storeOf } from '../../server/docs/store.js';
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

const storeDir = (): string => storeOf(ws, 'monolith').dir;
const localHead = (): Promise<string> => git(storeDir(), ['rev-parse', 'HEAD']);

describe('DocsSync keeps a refused flush out of history', () => {
  it('a flush with one diverged document publishes the accepted documents and names the refused one; the next flush after the divergence is resolved commits and pushes the refused document', async () => {
    await commitProjection(storeOf(ws, 'monolith', exec), {
      draftId: 'other-draft', stepKey: 'other', scope: 'refine', label: 'other side',
      files: { 'docs/project.md': 'theirs\n' }, bases: { 'docs/project.md': '# project.md\n' },
    });
    const s = sync();
    await edit('project.md', 'mine\n');
    await edit('stack.md', 'stack changed\n');
    s.boundary('backlog enabled');
    await s.tick();
    expect(s.view).toEqual({ pending: 1, lastError: expect.stringContaining('docs/project.md') });
    expect(await subject()).toBe('docs(refine): backlog enabled [skip ci]');
    expect(await git(origin(), ['show', 'main:docs/stack.md'])).toBe('stack changed');
    expect(await git(storeDir(), ['status', '--porcelain'])).toBe('');
    await commitProjection(storeOf(ws, 'monolith', exec), {
      draftId: 'other-draft', stepKey: 'other', scope: 'refine', label: 'other side undone',
      files: { 'docs/project.md': '# project.md\n' },
    });
    await s.tick();
    expect(s.view).toEqual({ pending: 0, lastError: null });
    expect(await subject()).toBe('docs(refine): backlog enabled [skip ci]');
    expect(await git(origin(), ['show', 'main:docs/project.md'])).toBe('mine');
  });

  it('a retry that only pushes keeps the refusal until the refused document is committed', async () => {
    await commitProjection(storeOf(ws, 'monolith', exec), {
      draftId: 'other-draft', stepKey: 'other', scope: 'refine', label: 'other side',
      files: { 'docs/project.md': 'theirs\n' }, bases: { 'docs/project.md': '# project.md\n' },
    });
    const s = sync();
    await edit('project.md', 'mine\n');
    s.edit();
    await edit('stack.md', 'stack changed\n');
    s.edit();
    await s.flush();
    const refusal = s.view.lastError;
    expect(refusal).toContain('docs/project.md');
    await s.tick();
    expect(s.view).toEqual({ pending: 2, lastError: refusal });
    await commitProjection(storeOf(ws, 'monolith', exec), {
      draftId: 'other-draft', stepKey: 'other', scope: 'refine', label: 'other side undone',
      files: { 'docs/project.md': '# project.md\n' },
    });
    await s.flush();
    expect(s.view).toEqual({ pending: 0, lastError: null });
    expect(await git(origin(), ['show', 'main:docs/project.md'])).toBe('mine');
  });
});

describe('DocsSync retries only a pending boundary', () => {
  it('after a failed flush, a document edit alone waits for a boundary, and the retry pushes only what is local', async () => {
    const s = sync();
    await edit('stack.md', 'stack changed\n');
    s.edit();
    offline = true;
    await s.flush();
    expect(s.view.lastError).not.toBeNull();
    expect(await commitCount()).toBe(1);
    offline = false;
    await edit('project.md', 'changed\n');
    s.edit();
    const local = await localHead();
    await s.tick();
    expect(await localHead()).toBe(local);
    expect(await commitCount()).toBe(2);
    expect(await git(origin(), ['show', 'main:docs/project.md'])).toBe('# project.md');
    s.boundary('backlog enabled');
    await s.tick();
    expect(await commitCount()).toBe(3);
    expect(await subject()).toBe('docs(refine): backlog enabled [skip ci]');
    expect(await git(origin(), ['show', 'main:docs/project.md'])).toBe('changed');
  });
});

describe('DocsSync counts a change by the flush that projects it', () => {
  it('an edit that arrives while the store opens is pushed by that flush, not left pending', async () => {
    let s: DocsSync | null = null;
    let armed = true;
    const racing: Exec = async (spec): Promise<CommandResult> => {
      if (armed) {
        armed = false;
        await edit('stack.md', 'arrived\n');
        s!.edit();
      }
      return exec(spec);
    };
    s = new DocsSync({ ws, draft, style: 'monolith', exec: racing, aliases: () => [] });
    s.boundary('backlog enabled');
    await s.tick();
    expect(s.view).toEqual({ pending: 0, lastError: null });
    expect(await git(origin(), ['show', 'main:docs/stack.md'])).toBe('arrived');
  });
});

describe('DocsSync publishes the start tags in turn with the closings', () => {
  it('a tag publish that overlaps a new closing keeps the new closing record', async () => {
    const calls: string[] = [];
    let tagPush = -1;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const recording: Exec = async (spec) => {
      calls.push(spec.args.join(' '));
      if (spec.args.includes('--atomic')) {
        tagPush = calls.length - 1;
        await held;
      }
      return exec(spec);
    };
    const s = new DocsSync({ ws, draft, style: 'monolith', exec: recording, aliases: () => [] });
    await s.close(['hello-app-001']);
    const tagging = s.publishTags();
    while (tagPush < 0) await new Promise((r) => setTimeout(r, 10));
    const closing = s.close(['hello-app-002']);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.slice(tagPush + 1)).toEqual([]);
    release();
    await Promise.all([tagging, closing]);
    expect(await readClosingRecord(ws, draft.specId)).toMatchObject({ aliases: ['hello-app-002'], pendingTags: ['dev-start/hello-app-002'] });
  });
});

describe('DocsSync keeps a refusal at open when no change is pending', () => {
  it('a tick that pushes accepted commits keeps the refusal, and a run without a refusal clears it', async () => {
    await commitProjection(storeOf(ws, 'monolith', exec), {
      draftId: 'other-draft', stepKey: 'other', scope: 'refine', label: 'other side',
      files: { 'docs/project.md': 'theirs\n' }, bases: { 'docs/project.md': '# project.md\n' },
    });
    const s = sync();
    await edit('project.md', 'mine\n');
    await edit('stack.md', 'stack changed\n');
    await s.flush();
    expect(s.view).toEqual({ pending: 0, lastError: expect.stringContaining('docs/project.md') });
    expect(await git(origin(), ['show', 'main:docs/stack.md'])).toBe('stack changed');
    await s.tick();
    expect(s.view).toEqual({ pending: 0, lastError: expect.stringContaining('docs/project.md') });
    await commitProjection(storeOf(ws, 'monolith', exec), {
      draftId: 'other-draft', stepKey: 'other', scope: 'refine', label: 'other side undone',
      files: { 'docs/project.md': '# project.md\n' },
    });
    await s.flush();
    expect(s.view).toEqual({ pending: 0, lastError: null });
    expect(await git(origin(), ['show', 'main:docs/project.md'])).toBe('mine');
  });
});
