import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths } from '../../server/refine/draft.js';
import { postProcessDerived } from '../../server/refine/derive.js';
import { RefineSession, type RunAgent } from '../../server/refine/session.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';

let root = '';
let ws: Workspace;

const draft = () => draftPaths(ws, 'shop-002');
const deps = () => ({ ws, draft: draft(), runAgent: (async () => ({ ok: false, failure: 'schema', errors: [], summary: {} })) as unknown as RunAgent, secretsDir: `${root}/secrets`, retrieval: () => [] });

const ARCHITECTURE = {
  style: 'monolith',
  rationale: 'Uma aplicação só.',
  repositories: [{ name: 'shop', responsibility: 'Vende', evidence: { doc: 'project.md', quote: 'Projeto' } }],
  integrations: [],
};

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-follow-on-'))).replace(/\\/g, '/');
  ws = { projectId: 'shop', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Shop');
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('a follow-on draft of a project with an architecture', () => {
  it('takes the repository stamp and adopts the architecture its main copy holds, without any stage', async () => {
    await fs.writeFile(path.join(draft().root, 'docs', 'architecture.json'), JSON.stringify(ARCHITECTURE));
    const s = await RefineSession.create(deps(), 'new-spec', { repositories: true });
    expect(s.state.repositories).toBe(true);
    expect(s.state.stages).not.toBe(true);
    expect(s.state.architecture?.decision).toMatchObject({ style: 'monolith' });
    await s.enableBacklog();
    expect(s.state.backlog?.enabled).toBe(true);
    await s.close();
  });

  it.each(['continue', 'backlog'] as const)('stamps a %s draft from the architecture its main copy holds', async (mode) => {
    await fs.writeFile(path.join(draft().root, 'docs', 'architecture.json'), JSON.stringify(ARCHITECTURE));
    if (mode === 'continue') await fs.writeFile(draft().specJson, JSON.stringify(makeSpec()));
    const s = await RefineSession.create(deps(), mode, { repositories: true });
    expect(s.state.repositories).toBe(true);
    expect(s.state.architecture?.decision).toMatchObject({ style: 'monolith' });
    await s.close();
  });

  it('keeps an unstamped follow-on draft as it was when main has no architecture', async () => {
    const s = await RefineSession.create(deps(), 'new-spec');
    expect(s.state.repositories).not.toBe(true);
    expect(s.state.architecture ?? null).toBeNull();
    await s.close();
  });
});

describe('the derived spec names its repository', () => {
  const raw = (repository?: string) => ({ project: makeProject(), spec: { ...makeSpec(), repository } });

  it('refuses a spec that names a repository the architecture does not give', () => {
    const check = postProcessDerived(raw('billing') as never, null, 'shop-002', 0, undefined, ['shop']);
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.issues.join(' ')).toContain('the spec names its repository, one of shop');
  });

  it('accepts a spec that names one of the repositories', () => {
    expect(postProcessDerived(raw('shop') as never, null, 'shop-002', 0, undefined, ['shop']).ok).toBe(true);
  });

  it('asks nothing of a derivation of an unstamped draft', () => {
    expect(postProcessDerived(raw() as never, null, 'shop-002').ok).toBe(true);
  });
});
