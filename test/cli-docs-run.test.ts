import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docsRunOf, planFilesFor } from '../server/cli.js';
import { docsSnapshotDir, readDocsMarker, writeClosingRecord, writeDocsMarker } from '../server/docs/project-state.js';
import type { Workspace } from '../server/orchestrator/workspace.js';
import { refineRoot } from '../server/refine/draft.js';

let root = '';
let ws: Workspace;
const DRAFT = 'hello-app-001';
const draftDir = () => path.join(refineRoot(ws), DRAFT);
const HASH = 'a'.repeat(40);
const docsRun = async (dir: string) => docsRunOf(ws, dir, await readDocsMarker(ws));

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-docs-run-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await fs.mkdir(draftDir(), { recursive: true });
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('where a run finds the plan and the task list', () => {
  const snapshot = { snapshot: '/snap' };

  it('a monolith documentation repository keeps them in the specify folder of the snapshot', async () => {
    expect(await planFilesFor(draftDir(), 'hello-app-001', { repository: undefined }, { ...snapshot, style: 'monolith' })).toEqual({ planFile: 'docs/specify/hello-app-001/plan.md', taskFile: 'docs/specify/hello-app-001/task.md' });
  });

  it('a microservices documentation repository keeps them under the service folder', async () => {
    const files = await planFilesFor(draftDir(), 'register-user', { repository: 'register-user-api' }, { ...snapshot, style: 'microservices' });
    expect(files).toEqual({ planFile: 'docs/register-user-api/specify/register-user/plan.md', taskFile: 'docs/register-user-api/specify/register-user/task.md' });
  });

  it('a legacy project names the files its draft holds, and none when it holds none', async () => {
    expect(await planFilesFor(draftDir(), 'hello-app-001', { repository: undefined })).toEqual({ planFile: undefined, taskFile: undefined });
    await fs.mkdir(path.join(draftDir(), 'docs/specs/hello-app-001'), { recursive: true });
    await fs.writeFile(path.join(draftDir(), 'docs/specs/hello-app-001/implementation-plan.md'), '# plan');
    expect(await planFilesFor(draftDir(), 'hello-app-001', { repository: undefined })).toEqual({ planFile: 'docs/specs/hello-app-001/implementation-plan.md', taskFile: undefined });
  });
});

describe('the documents a run reads', () => {
  it('a documentation-repository run receives the snapshot its draft closed with', async () => {
    await writeDocsMarker(ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'hello-app' }, firstSha: HASH });
    await writeClosingRecord(ws, DRAFT, { commit: HASH, aliases: ['hello-app-001'], pendingTags: [] });
    await fs.mkdir(docsSnapshotDir(ws, DRAFT), { recursive: true });
    expect(await docsRun(draftDir())).toEqual({ style: 'monolith', snapshot: docsSnapshotDir(ws, DRAFT) });
  });

  it('a legacy run receives no documents of its own', async () => {
    expect(await docsRun(draftDir())).toBeUndefined();
  });

  it('a documentation-repository run without a closing record receives none', async () => {
    await writeDocsMarker(ws, { layout: 'docs-repo', style: 'microservices', target: { owner: 'acme', name: 'artefacty' }, firstSha: HASH });
    expect(await docsRun(draftDir())).toBeUndefined();
  });

  it('a run whose folder is not a draft of the project receives none', async () => {
    await writeDocsMarker(ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'hello-app' }, firstSha: HASH });
    await writeClosingRecord(ws, DRAFT, { commit: HASH, aliases: [], pendingTags: [] });
    await fs.mkdir(docsSnapshotDir(ws, DRAFT), { recursive: true });
    expect(await docsRun(ws.repo)).toBeUndefined();
  });
});
