import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { docsClosingPath, docsStoreDir } from '../../server/docs/project-state.js';
import type { CommandResult, Exec } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { RefineEvent } from '../../server/refine/events.js';
import { ConflictError, RefineJournal, type RefineSession } from '../../server/refine/session.js';
import { makeSpec } from '../fixtures/contracts.js';
import { completeStages, makeRig, MONOLITH, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';
import { FakeGhRepos } from '../fixtures/fake-gh-repos.js';

let rig: Rig | null = null;
let gh: FakeGhRepos | null = null;
let ghRoot = '';

afterEach(async () => {
  await rig?.close();
  rig = null;
  gh = null;
  if (ghRoot) await fs.rm(ghRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  ghRoot = '';
});

const answer = (stdout: string): CommandResult => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, durationMs: 1, truncated: false });

/** The fake GitHub with a signed-in account. */
function exec(fake: FakeGhRepos): Exec {
  return async (spec) => {
    if (spec.bin === 'gh' && spec.args[0] === 'api') return answer(JSON.stringify({ login: 'octo' }));
    return fake.exec(spec);
  };
}

/** A new project bound to a documentation repository, with its architecture decided and the session attached. */
async function bound(): Promise<RefineSession> {
  ghRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lane2-closing-gh-'));
  gh = new FakeGhRepos(ghRoot);
  rig = await makeRig({ docsRepoLayout: true, owner: 'acme', ghExec: exec(gh) });
  const s = await rig.registry.newProject(PROJECT, 'Hello');
  await completeStages(rig, s);
  rig.script['architecture/sm'] = [MONOLITH];
  await s.decideArchitecture();
  await s.settled();
  await s.enableBacklog();
  return s;
}

/** The spec, plan and task of one alias, so the closing projects its folder. */
async function writeAlias(alias: string): Promise<void> {
  const docs = rig!.draft.docs;
  await fs.mkdir(path.join(docs, 'specs', alias), { recursive: true });
  await fs.writeFile(path.join(docs, 'specs', alias, 'spec.json'), JSON.stringify(makeSpec({ specId: alias })));
  await fs.writeFile(path.join(rig!.draft.root, 'docs', 'specs', alias, 'implementation-plan.md'), `# ${alias} plan\n`);
  await fs.writeFile(path.join(rig!.draft.root, 'docs', 'specs', alias, 'task.md'), `# ${alias} tasks\n`);
}

/** Records the spec of an alias in the backlog; the session reopens on the new facts. */
async function recordSpec(alias: string): Promise<RefineSession> {
  await rig!.registry.close();
  const journal = await RefineJournal.open(rig!.draft.events, { projectId: PROJECT, specId: rig!.draft.specId });
  await journal.fact(RefineEvent.SpecDerived, { key: alias, specId: alias, inputHash: 'i', rev: 'r', spec: makeSpec({ specId: alias }), issues: [], cycle: 1 });
  await journal.close();
  return rig!.registry.get(PROJECT, rig!.draft.specId);
}

/** Sets the copy of stack.md the draft started from, and the store's and the draft's own versions after the start. */
async function seedStack(base: string, store: string, draft: string): Promise<void> {
  await fs.mkdir(rig!.draft.base!, { recursive: true });
  await fs.writeFile(path.join(rig!.draft.base!, 'stack.md'), base);
  await fs.writeFile(path.join(docsStoreDir(rig!.ws), 'docs', 'stack.md'), store);
  await git(docsStoreDir(rig!.ws), ['commit', '-qam', 'docs: stack changed on main']);
  await fs.writeFile(rig!.draft.stackMd, draft);
}

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

describe('closing merges the documents the store changed since the draft began', () => {
  it('merges a store change to stack.md that does not overlap the draft edits, and closes', async () => {
    await bound();
    await writeAlias('hello-001');
    const s = await recordSpec('hello-001');
    await seedStack('one\ntwo\nthree\n', 'A\ntwo\nthree\n', 'one\ntwo\nC\n');
    await s.closeDocs(['hello-001']);
    expect(await fs.readFile(rig!.draft.stackMd, 'utf8')).toBe('A\ntwo\nC\n');
    expect(await fs.readFile(path.join(docsStoreDir(rig!.ws), 'docs', 'stack.md'), 'utf8')).toBe('A\ntwo\nC\n');
    expect(await exists(docsClosingPath(rig!.ws, rig!.draft.specId))).toBe(true);
  });

  it('refuses the start naming stack.md when the store and the draft changed the same line, and the draft holds markers', async () => {
    await bound();
    await writeAlias('hello-001');
    const s = await recordSpec('hello-001');
    await seedStack('one\ntwo\nthree\n', 'X\ntwo\nthree\n', 'Y\ntwo\nthree\n');
    const refused = s.closeDocs(['hello-001']);
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(refused).rejects.toThrow(/stack\.md/);
    const draft = await fs.readFile(rig!.draft.stackMd, 'utf8');
    expect(draft).toMatch(/^<{7} /m);
    expect(draft).toMatch(/^>{7} /m);
    expect(await exists(docsClosingPath(rig!.ws, rig!.draft.specId))).toBe(false);
  });
});
