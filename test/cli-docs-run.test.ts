import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docsRunOf } from '../server/cli.js';
import { docsSnapshotDir, writeClosingRecord, writeDocsMarker } from '../server/docs/project-state.js';
import type { Workspace } from '../server/orchestrator/workspace.js';
import { refineRoot } from '../server/refine/draft.js';

let root = '';
let ws: Workspace;
const DRAFT = 'hello-app-001';
const draftDir = () => path.join(refineRoot(ws), DRAFT);
const HASH = 'a'.repeat(40);

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-docs-run-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await fs.mkdir(draftDir(), { recursive: true });
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('the documents a run reads', () => {
  it('a documentation-repository run receives the snapshot its draft closed with', async () => {
    await writeDocsMarker(ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'hello-app' }, firstSha: HASH });
    await writeClosingRecord(ws, DRAFT, { commit: HASH, aliases: ['hello-app-001'], pendingTags: [] });
    await fs.mkdir(docsSnapshotDir(ws, DRAFT), { recursive: true });
    expect(await docsRunOf(ws, draftDir())).toEqual({ style: 'monolith', snapshot: docsSnapshotDir(ws, DRAFT) });
  });

  it('a legacy run receives no documents of its own', async () => {
    expect(await docsRunOf(ws, draftDir())).toBeUndefined();
  });

  it('a documentation-repository run without a closing record receives none', async () => {
    await writeDocsMarker(ws, { layout: 'docs-repo', style: 'microservices', target: { owner: 'acme', name: 'artefacty' }, firstSha: HASH });
    expect(await docsRunOf(ws, draftDir())).toBeUndefined();
  });

  it('a run whose folder is not a draft of the project receives none', async () => {
    await writeDocsMarker(ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'hello-app' }, firstSha: HASH });
    await writeClosingRecord(ws, DRAFT, { commit: HASH, aliases: [], pendingTags: [] });
    await fs.mkdir(docsSnapshotDir(ws, DRAFT), { recursive: true });
    expect(await docsRunOf(ws, ws.repo)).toBeUndefined();
  });
});
