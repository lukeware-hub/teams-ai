import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { docsMarkerPath, readDocsMarker } from '../../server/docs/project-state.js';
import { execCommand, type CommandResult, type Exec } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { writeDoc, type DocFile } from '../../server/refine/draft.js';
import { ConflictError, type RefineSession } from '../../server/refine/session.js';
import { completeStages, DERIVED, makeRig, MICROSERVICES, MONOLITH, type Rig } from '../fixtures/docs-repo-rig.js';
import { FakeGhRepos } from '../fixtures/fake-gh-repos.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'];
const green = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
const refineOut = (checklist: unknown[]) => ({ checklist, questions: [], docPatch: [] });

let rig: Rig | null = null;
let ghRoot = '';
let remotes: Remote[] = [];
let gh: FakeGhRepos;
let ghCalls: (readonly string[])[];

afterEach(async () => {
  await Promise.all(remotes.map((r) => r.cleanup()));
  remotes = [];
  await rig?.close();
  rig = null;
  if (ghRoot) await fs.rm(ghRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  ghRoot = '';
});

const answer = (stdout: string, exitCode = 0): CommandResult => ({ exitCode, signal: null, stdout, stderr: exitCode === 0 ? '' : 'You are not logged in', timedOut: false, durationMs: 1, truncated: false });

/** The fake GitHub with a signed-in account (or none): `gh api user` answers the login, every other gh call goes to the fake. */
function signedIn(login: string | null): Exec {
  return async (spec) => {
    if (spec.bin === 'gh') ghCalls.push(spec.args);
    if (spec.bin === 'gh' && spec.args[0] === 'api') return login ? answer(JSON.stringify({ login })) : answer('', 1);
    return gh.exec(spec);
  };
}

/** A rig whose GitHub is the fake one; `login` is the signed-in account, null for none. */
async function openRig(opts: { docsRepoLayout?: boolean; owner?: string; login?: string | null } = {}): Promise<Rig> {
  ghRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-bind-gh-'));
  gh = new FakeGhRepos(ghRoot);
  ghCalls = [];
  const owner = 'owner' in opts ? opts.owner : 'acme';
  rig = await makeRig({ docsRepoLayout: opts.docsRepoLayout ?? true, owner, ghExec: signedIn(opts.login === undefined ? 'octo' : opts.login) });
  return rig;
}

/** A bare origin that exists on the fake GitHub: empty, or with unrelated history. */
async function origin(kind: 'empty' | 'history'): Promise<string> {
  if (kind === 'history') {
    const remote = await makeRemote({ 'README.md': 'unrelated\n' });
    remotes.push(remote);
    return remote.origin;
  }
  const dir = path.join(ghRoot, `empty-${remotes.length}-${Date.now()}.git`);
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ['init', '--bare', '-b', 'main']);
  return dir;
}

/** A new project whose five documents are graphed and whose architecture is decided: only the backlog step is left. */
async function decided(r: Rig, style: 'monolith' | 'microservices' = 'monolith', docs: Partial<Record<DocFile, string>> = {}): Promise<RefineSession> {
  const s = await r.registry.newProject('hello-app', 'Hello');
  await completeStages(r, s);
  for (const [file, text] of Object.entries(docs)) await writeDoc(r.draft, file as DocFile, text);
  r.script['architecture/sm'] = [style === 'monolith' ? MONOLITH : MICROSERVICES];
  await s.decideArchitecture();
  await s.settled();
  return s;
}

describe('the documentation repository is bound only by the Backlog step', () => {
  it('an evaluation of a ready architecture never calls gh', async () => {
    const r = await openRig();
    const s = await decided(r);
    r.script['derive/po'] = [DERIVED, DERIVED, DERIVED];
    r.script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO)), refineOut(green(PO))];
    r.script['refine/sm'] = [refineOut(green(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions', 'sm.flow-is-mermaid']))];
    r.script['refine/front'] = [refineOut([])];
    await s.evaluate();
    await s.settled();
    expect(s.state.status).toBe('ready');
    expect(s.state.backlog?.enabled).toBeFalsy();
    expect(ghCalls).toEqual([]);
    expect(await readDocsMarker(r.ws)).toBeNull();
  });

  it('the Backlog step binds once, through the registry\'s gh, and enables the backlog', async () => {
    const r = await openRig();
    const s = await decided(r);
    await s.enableBacklog();
    expect(s.state.backlog?.enabled).toBe(true);
    expect(gh.creates).toEqual(['acme/hello-app']);
    expect(ghCalls[0]).toEqual(['api', 'user']);
    expect(ghCalls.some((args) => args[0] === 'repo' && args[1] === 'view' && args[2] === 'acme/hello-app')).toBe(true);
    const marker = await readDocsMarker(r.ws);
    expect(marker).toMatchObject({ layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'hello-app' } });
    expect(marker?.firstSha).toBe(await git(gh.repos.get('acme/hello-app')!.origin, ['rev-parse', 'main']));
  });

  it('a second click does not bind again', async () => {
    const r = await openRig();
    const s = await decided(r);
    await s.enableBacklog();
    const before = ghCalls.length;
    await s.enableBacklog();
    expect(ghCalls).toHaveLength(before);
    expect(gh.creates).toEqual(['acme/hello-app']);
  });

  it('the owner named in the project document wins over the configured owner', async () => {
    const r = await openRig({ owner: 'acme' });
    const s = await decided(r, 'monolith', { 'project.md': '# Projeto\n\n## GitHub owner\n\nmyorg\n\n## Visão\n\nO hello-app entrega uma saudação ao usuário.\n' });
    await s.enableBacklog();
    expect((await readDocsMarker(r.ws))?.target).toEqual({ owner: 'myorg', name: 'hello-app' });
  });

  it('the signed-in login is the owner when neither the document nor the configuration names one', async () => {
    const r = await openRig({ owner: undefined, login: 'octo' });
    const s = await decided(r);
    await s.enableBacklog();
    expect((await readDocsMarker(r.ws))?.target).toEqual({ owner: 'octo', name: 'hello-app' });
  });

  it('refuses without a signed-in account, and binds nothing', async () => {
    const r = await openRig({ login: null });
    const s = await decided(r);
    await expect(s.enableBacklog()).rejects.toThrow('Entre no GitHub');
    expect(gh.creates).toEqual([]);
    expect(await readDocsMarker(r.ws)).toBeNull();
    expect(s.state.backlog?.enabled).toBeFalsy();
  });

  it('refuses a public repository with a plain conflict, before any marker is written', async () => {
    const r = await openRig();
    gh.register('acme/hello-app', await origin('empty'), { isPrivate: false });
    const s = await decided(r);
    await expect(s.enableBacklog()).rejects.toThrow(ConflictError);
    await expect(s.enableBacklog()).rejects.toThrow('é público');
    expect(await readDocsMarker(r.ws)).toBeNull();
    expect(s.state.backlog?.enabled).toBeFalsy();
  });

  it('refuses an archived repository', async () => {
    const r = await openRig();
    gh.register('acme/hello-app', await origin('empty'), { archived: true });
    const s = await decided(r);
    await expect(s.enableBacklog()).rejects.toThrow('está arquivado');
    expect(await readDocsMarker(r.ws)).toBeNull();
  });

  it('refuses a repository the signed-in account cannot write', async () => {
    const r = await openRig();
    gh.register('acme/hello-app', await origin('empty'), { viewerPermission: 'READ' });
    const s = await decided(r);
    await expect(s.enableBacklog()).rejects.toThrow('permissão de escrita');
    expect(await readDocsMarker(r.ws)).toBeNull();
  });

  it('refuses a non-empty repository that is not the one this project bound', async () => {
    const r = await openRig();
    gh.register('acme/hello-app', await origin('history'));
    const s = await decided(r);
    await expect(s.enableBacklog()).rejects.toThrow('já tem histórico');
    expect(await readDocsMarker(r.ws)).toBeNull();
  });

  it('a session without the gh exec refuses the Backlog step in plain words', async () => {
    rig = await makeRig({ docsRepoLayout: true, owner: 'acme' });
    const s = await decided(rig);
    await expect(s.enableBacklog()).rejects.toThrow('O GitHub não está configurado');
    expect(await readDocsMarker(rig.ws)).toBeNull();
  });

  it('a session without the stamp stays legacy and never binds', async () => {
    const r = await openRig({ docsRepoLayout: false });
    const s = await decided(r);
    await s.enableBacklog();
    expect(s.state.backlog?.enabled).toBe(true);
    expect(ghCalls).toEqual([]);
    expect(await readDocsMarker(r.ws)).toBeNull();
  });
});

describe('one bind at a time, and a legacy session reads no marker', () => {
  it('two overlapping Backlog calls make one repository, and both resolve', async () => {
    const r = await openRig();
    const s = await decided(r);
    await Promise.all([s.enableBacklog(), s.enableBacklog()]);
    expect(gh.creates).toEqual(['acme/hello-app']);
    expect(s.state.backlog?.enabled).toBe(true);
  });

  it('a legacy new project does not read a corrupt marker', async () => {
    const r = await openRig({ docsRepoLayout: false });
    await fs.mkdir(path.dirname(docsMarkerPath(r.ws)), { recursive: true });
    await fs.writeFile(docsMarkerPath(r.ws), '{ not json');
    const s = await r.registry.newProject('hello-app', 'Hello');
    expect(s.state.docsRepo).toBeUndefined();
    await s.close();
  });

  it('a legacy architecture decision does not read a corrupt marker', async () => {
    const r = await openRig({ docsRepoLayout: false });
    const s = await r.registry.newProject('hello-app', 'Hello');
    await completeStages(r, s);
    await fs.mkdir(path.dirname(docsMarkerPath(r.ws)), { recursive: true });
    await fs.writeFile(docsMarkerPath(r.ws), '{ not json');
    r.script['architecture/sm'] = [MONOLITH];
    await s.decideArchitecture();
    await s.settled();
    expect(s.state.architecture).toBeDefined();
  });
});
