import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exec, CommandResult } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import type { RefineSession } from '../../server/refine/session.js';
import { completeStages, makeRig, MONOLITH, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';
import { FakeGhRepos } from '../fixtures/fake-gh-repos.js';

let rig: Rig | null = null;
let gh: FakeGhRepos | null = null;
let ghRoot = '';
let offline = false;

afterEach(async () => {
  await rig?.close();
  rig = null;
  if (ghRoot) await fs.rm(ghRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  ghRoot = '';
  gh = null;
  offline = false;
});

/** The 3 second push debounce passes, so the pending push of the sync goes out. */
const debounced = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3100));

const answer = (stdout: string): CommandResult => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, durationMs: 1, truncated: false });

/** The fake GitHub with a signed-in account; a push finds no network while `offline` is set. */
function exec(fake: FakeGhRepos): Exec {
  return async (spec) => {
    if (spec.bin === 'gh' && spec.args[0] === 'api') return answer(JSON.stringify({ login: 'octo' }));
    if (offline && spec.bin === 'git' && spec.args.includes('push')) {
      return { exitCode: 1, signal: null, stdout: '', stderr: 'Could not resolve host: github.com', timedOut: false, durationMs: 1, truncated: false };
    }
    return fake.exec(spec);
  };
}

async function openRig(): Promise<Rig> {
  ghRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-sync-gh-'));
  gh = new FakeGhRepos(ghRoot);
  rig = await makeRig({ docsRepoLayout: true, owner: 'acme', ghExec: exec(gh) });
  return rig;
}

/** A new project whose five documents are graphed and whose architecture is decided, so only the Backlog step is left. */
async function decided(r: Rig): Promise<RefineSession> {
  const s = await r.registry.newProject(PROJECT, 'Hello');
  await completeStages(r, s);
  r.script['architecture/sm'] = [MONOLITH];
  await s.decideArchitecture();
  await s.settled();
  return s;
}

const origin = (): string => gh!.repos.get('acme/hello-app')!.origin;
const commitCount = (): Promise<number> => git(origin(), ['rev-list', '--count', 'main']).then(Number);
const subject = (): Promise<string> => git(origin(), ['log', '-1', '--format=%s', 'main']);

describe('a documentation repository session syncs its documents', () => {
  it('the Backlog step binds the store, and the next tick commits a saved document with the Backlog label', async () => {
    const r = await openRig();
    const s = await decided(r);
    await s.enableBacklog();
    await s.saveDoc('project.md', '# Projeto\n\nNova visão.\n');
    await s.tickDocs();
    await debounced();
    await s.tickDocs();
    expect(await commitCount()).toBe(2);
    expect(await subject()).toBe('docs(refine): backlog enabled [skip ci]');
  });

  it('attaching the documents again keeps the pending count and the last failure', async () => {
    const r = await openRig();
    const s = await decided(r);
    offline = true;
    await s.enableBacklog();
    await s.saveDoc('stack.md', '# Stack\n\nOutra linguagem.\n');
    await s.tickDocs();
    await debounced();
    await s.tickDocs();
    const before = (await s.snapshot()).docsSync;
    expect(before?.lastError).toMatch(/could not be reached/);
    await (s as unknown as { attachDocs(atOpen: boolean): Promise<void> }).attachDocs(true);
    expect((await s.snapshot()).docsSync).toEqual(before);
  });

  it('a document saved alone waits for the next boundary', async () => {
    const r = await openRig();
    const s = await decided(r);
    await s.enableBacklog();
    await s.tickDocs();
    expect(await commitCount()).toBe(1);
    await s.saveDoc('stack.md', '# Stack\n\nOutra linguagem.\n');
    await s.tickDocs();
    expect(await commitCount()).toBe(1);
  });

  it('opening a bound session flushes what the store lacks, once', async () => {
    const r = await openRig();
    const s = await decided(r);
    await s.enableBacklog();
    await s.tickDocs();
    await r.registry.close();
    await fs.writeFile(path.join(r.draft.docs, 'project.md'), '# Projeto\n\nFechado.\n');
    const reopened = await r.registry.get(PROJECT, `${PROJECT}-001`);
    await reopened.tickDocs();
    await debounced();
    await reopened.tickDocs();
    expect(await commitCount()).toBe(2);
    expect(await subject()).toBe('docs(refine): documents synced [skip ci]');
  });

  it('a flush that failed at open is retried by the registry tick, without a second commit', async () => {
    const r = await openRig();
    const s = await decided(r);
    await s.enableBacklog();
    await s.tickDocs();
    await r.registry.close();
    await fs.writeFile(path.join(r.draft.docs, 'project.md'), '# Projeto\n\nFechado.\n');
    offline = true;
    await r.registry.get(PROJECT, `${PROJECT}-001`);
    await r.registry.tickDocs();
    expect(await commitCount()).toBe(1);
    await debounced();
    offline = false;
    await r.registry.tickDocs();
    expect(await commitCount()).toBe(2);
    await r.registry.tickDocs();
    expect(await commitCount()).toBe(2);
  });

  it('the snapshot shows the changes waiting and the last failure, and a retry clears the failure without a journal fact', async () => {
    const r = await openRig();
    const s = await decided(r);
    await s.enableBacklog();
    expect((await s.snapshot()).docsSync).toEqual({ pending: 1, lastError: null, refused: false });
    const events = s.events.length;
    offline = true;
    await s.tickDocs();
    await debounced();
    await s.tickDocs();
    const failed = (await s.snapshot()).docsSync;
    expect(failed?.lastError).toMatch(/could not be reached/);
    expect(failed?.pending).toBe(0);
    offline = false;
    await s.tickDocs();
    expect((await s.snapshot()).docsSync).toEqual({ pending: 0, lastError: null, refused: false });
    expect(s.events.length).toBe(events);
  });

  it('a save counts as pending until the next boundary commits it', async () => {
    const r = await openRig();
    const s = await decided(r);
    await s.enableBacklog();
    await s.tickDocs();
    await s.saveDoc('stack.md', '# Stack\n\nOutra linguagem.\n');
    await s.tickDocs();
    expect((await s.snapshot()).docsSync).toEqual({ pending: 1, lastError: null, refused: false });
  });

  it('a session that is not a documentation repository has no docsSync', async () => {
    const r = await makeRig({ docsRepoLayout: false, owner: 'acme', ghExec: exec(new FakeGhRepos(os.tmpdir())) });
    rig = r;
    const s = await r.registry.newProject(PROJECT, 'Hello');
    expect((await s.snapshot()).docsSync).toBeUndefined();
  });
});
