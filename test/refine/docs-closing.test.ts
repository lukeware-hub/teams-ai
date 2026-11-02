import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { docsClosingPath, docsSnapshotDir } from '../../server/docs/project-state.js';
import type { Exec, CommandResult } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { RefineEvent } from '../../server/refine/events.js';
import { ConflictError, RefineJournal, type RefineSession } from '../../server/refine/session.js';
import { makeSpec } from '../fixtures/contracts.js';
import { completeStages, makeRig, MONOLITH, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';
import { FakeGhRepos } from '../fixtures/fake-gh-repos.js';

let rig: Rig | null = null;
let ghRoot = '';
let offline = false;

afterEach(async () => {
  await rig?.close();
  rig = null;
  if (ghRoot) await fs.rm(ghRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  ghRoot = '';
  offline = false;
});

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

/** A new project with its architecture decided and its Backlog step done, so the store is bound and the session attached. */
async function bound(): Promise<RefineSession> {
  ghRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-closing-gh-'));
  const gh = new FakeGhRepos(ghRoot);
  rig = await makeRig({ docsRepoLayout: true, owner: 'acme', ghExec: exec(gh) });
  const s = await rig.registry.newProject(PROJECT, 'Hello');
  await completeStages(rig, s);
  rig.script['architecture/sm'] = [MONOLITH];
  await s.decideArchitecture();
  await s.settled();
  await s.enableBacklog();
  return s;
}

/** The spec, plan and task of one alias, as the draft holds them once its plan step ran. */
async function writeAlias(alias: string): Promise<void> {
  const docs = rig!.draft.docs;
  await fs.mkdir(path.join(docs, 'specs', alias), { recursive: true });
  await fs.writeFile(path.join(docs, 'specs', alias, 'spec.json'), JSON.stringify(makeSpec({ specId: alias })));
  await fs.writeFile(path.join(rig!.draft.root, 'docs', 'specs', alias, 'implementation-plan.md'), `# ${alias} plan\n`);
  await fs.writeFile(path.join(rig!.draft.root, 'docs', 'specs', alias, 'task.md'), `# ${alias} tasks\n`);
}

/** Records the spec of an alias in the backlog, so the store projects its folder; the session reopens on the new facts. */
async function recordSpec(alias: string): Promise<RefineSession> {
  await rig!.registry.close();
  const journal = await RefineJournal.open(rig!.draft.events, { projectId: PROJECT, specId: rig!.draft.specId });
  await journal.fact(RefineEvent.SpecDerived, { key: alias, specId: alias, inputHash: 'i', rev: 'r', spec: makeSpec({ specId: alias }), issues: [], cycle: 1 });
  await journal.close();
  return rig!.registry.get(PROJECT, rig!.draft.specId);
}

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

describe('closing a documentation repository session before its launch', () => {
  it('launches nothing when the push fails: no closing record and no snapshot', async () => {
    await bound();
    await writeAlias('hello-001');
    const s = await recordSpec('hello-001');
    offline = true;
    await expect(s.closeDocs(['hello-001'])).rejects.toBeInstanceOf(ConflictError);
    expect(await exists(docsClosingPath(rig!.ws, rig!.draft.specId))).toBe(false);
    expect(await exists(docsSnapshotDir(rig!.ws, rig!.draft.specId))).toBe(false);
  });

  it('writes the snapshot of the five documents and the alias files, and the closing record with its pending tag', async () => {
    await bound();
    await writeAlias('hello-001');
    const s = await recordSpec('hello-001');
    await s.closeDocs(['hello-001']);
    const snapshot = docsSnapshotDir(rig!.ws, rig!.draft.specId);
    for (const doc of ['project.md', 'flow.md', 'briefing.md', 'design.md', 'stack.md']) {
      expect(await exists(path.join(snapshot, 'docs', doc))).toBe(true);
    }
    expect(await fs.readFile(path.join(snapshot, 'docs', 'specify', 'hello-001', 'spec.md'), 'utf8')).toContain('hello-001');
    expect(await exists(path.join(snapshot, 'docs', 'specify', 'hello-001', 'plan.md'))).toBe(true);
    expect(await exists(path.join(snapshot, 'docs', 'specify', 'hello-001', 'task.md'))).toBe(true);
    const record = JSON.parse(await fs.readFile(docsClosingPath(rig!.ws, rig!.draft.specId), 'utf8'));
    expect(record).toMatchObject({ aliases: ['hello-001'], pendingTags: ['dev-start/hello-001'] });
    expect(record.commit).toBe(await git(snapshot, ['rev-parse', 'HEAD']));
  });

  it('leaves a legacy session alone: nothing is closed when it is not a documentation repository', async () => {
    rig = await makeRig({ docsRepoLayout: false });
    const s = await rig.registry.newProject(PROJECT, 'Hello');
    await expect(s.closeDocs(['hello-001'])).resolves.toBeUndefined();
    expect(await exists(docsClosingPath(rig.ws, rig.draft.specId))).toBe(false);
  });
});
