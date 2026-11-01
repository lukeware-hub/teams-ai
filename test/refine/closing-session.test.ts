import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { docsHashOf } from '../../server/refine/architecture-step.js';
import { createNewProject, draftPaths, readDoc, type DocFile } from '../../server/refine/draft.js';
import { DOC_STAGES } from '../../server/refine/doc-stages.js';
import { RefineEvent } from '../../server/refine/events.js';
import { planInputHash } from '../../server/refine/plan-inputs.js';
import { ConflictError, RefineJournal, RefineSession, type RunAgent } from '../../server/refine/session.js';
import { makeSpec } from '../fixtures/contracts.js';

let root = '';
let ws: Workspace;

const draft = () => draftPaths(ws, 'hello-001');
const deps = () => ({ ws, draft: draft(), runAgent: (async () => ({ ok: false, failure: 'schema', errors: [], summary: {} })) as unknown as RunAgent, secretsDir: `${root}/secrets`, retrieval: () => [] });

/** Every fact a repository session holds before its summary: five documents graphed, an architecture, a backlog of two items, their specs, plans and task lists. */
async function readyWizard(): Promise<RefineSession> {
  await createNewProject(draft(), 'Hello');
  const docs = Object.fromEntries(await Promise.all(DOC_STAGES.map(async (f) => [f, await readDoc(draft(), f)]))) as Record<DocFile, string>;
  const created = await RefineSession.create(deps(), 'new-project', { repositories: true });
  await created.close();
  const journal = await RefineJournal.open(draft().events, { projectId: 'hello-app', specId: 'hello-001' });
  for (const doc of DOC_STAGES) {
    await journal.fact(RefineEvent.StageAdvanced, { doc, cycle: 1 });
    await journal.fact(RefineEvent.DocGraphed, { file: doc, hash: 'h', nodes: 1, links: 0, inputTokens: 0, outputTokens: 0 });
  }
  await journal.fact(RefineEvent.Evaluated, { cycle: 1, checklist: [{ id: 'po.objectives-verifiable', passed: true, detail: 'ok' }], questions: [], discardedPatches: [] });
  await journal.fact(RefineEvent.ArchitectureDecided, {
    docsHash: docsHashOf(docs),
    architecture: {
      style: 'microservices',
      rationale: 'Two parts.',
      repositories: [
        { name: 'shop-api', responsibility: 'Sells', evidence: { doc: 'project.md', quote: 'sells' } },
        { name: 'shop-web', responsibility: 'Shows', evidence: { doc: 'design.md', quote: 'shows' } },
      ],
      integrations: [{ consumer: 'shop-web', provider: 'shop-api', contract: 'GET /cart' }],
    },
    questions: [],
  });
  await journal.fact(RefineEvent.BacklogEnabled, { acFloor: 0, keyIds: true });
  await journal.fact(RefineEvent.BacklogDetailEnabled, {});
  const item = (key: string, rank: number, repository: string, dependsOn: string[] = []) => ({ key, title: `Item ${key}`, epic: 'core', priority: 'P1', rank, size: 'S', scope: 's', rationale: 'r', dependsOn, sources: [], repository });
  await journal.fact(RefineEvent.BacklogDerived, { project: null, epics: [{ key: 'core', title: 'Core' }], items: [item('cart', 1, 'shop-api'), item('catalog', 2, 'shop-web', ['cart'])], cycle: 1 });
  for (const key of ['cart', 'catalog']) {
    const spec = makeSpec({ specId: key });
    await fs.mkdir(`${draft().docs}/specs/${key}`, { recursive: true });
    await fs.writeFile(`${draft().docs}/specs/${key}/spec.json`, JSON.stringify(spec));
    await journal.fact(RefineEvent.SpecDerived, { key, specId: key, inputHash: 'i', rev: 'r', spec, issues: [], cycle: 1 });
    const tasks = [{ id: 'T1-core', title: 'Core', module: 'core', owner: 'dev', criteriaRefs: ['AC-001', 'AC-002'], dependsOn: [] }];
    await journal.fact(RefineEvent.PreplanDerived, { key, inputHash: 'i', specRev: 'r', preplan: { tasks }, issues: [], cycle: 1 });
  }
  await journal.close();
  const probe = await RefineSession.open(deps());
  const inputHash = await planInputHash(draft(), probe.state);
  await probe.close();
  const again = await RefineJournal.open(draft().events, { projectId: 'hello-app', specId: 'hello-001' });
  await again.fact(RefineEvent.SpeckitStarted, { total: 4, inputHash });
  for (const key of ['cart', 'catalog']) {
    await again.fact(RefineEvent.SpeckitStepDone, { command: 'plan', itemKey: key, files: [], basis: 'b' });
    await again.fact(RefineEvent.SpeckitStepDone, { command: 'tasks', itemKey: key, files: [], basis: 'b' });
  }
  await again.fact(RefineEvent.PlansPrepared, { inputHash });
  await again.close();
  return RefineSession.open(deps());
}

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-closing-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('closing summary and the owner\'s authorization', () => {
  it('summarizes the seven checks, each repository\'s counts, and hashes the summary the owner reads', async () => {
    const session = await readyWizard();
    const summary = await session.closingSummary();
    expect(summary.ok).toBe(true);
    expect(summary.repositories).toEqual([
      { name: 'shop-api', specs: 1, plans: 1, tasks: 1 },
      { name: 'shop-web', specs: 1, plans: 1, tasks: 1 },
    ]);
    expect(summary.summaryHash).toMatch(/^sha256:/);
    expect((await session.closingSummary()).summaryHash).toBe(summary.summaryHash);
    await session.close();
  });

  it('refuses to start without the hash of the summary, and with a stale one', async () => {
    const session = await readyWizard();
    await expect(session.freezeProgram()).rejects.toThrow(ConflictError);
    await expect(session.freezeProgram()).rejects.toThrow('Abra o resumo do refinamento');
    await expect(session.freezeProgram('sha256:' + '0'.repeat(64))).rejects.toThrow('O resumo mudou desde que você o abriu');
    await session.close();
  });

  it('starts with the summary\'s hash, and journals the authorization before the program starts', async () => {
    const session = await readyWizard();
    const { summaryHash } = await session.closingSummary();
    const entries = await session.freezeProgram(summaryHash);
    expect(entries.map((e) => e.specId).sort()).toEqual(['cart', 'catalog']);
    const { loadEvents } = await import('../../server/store/event-store.js');
    const events = await loadEvents(draft().events);
    expect(events.find((e) => e.type === RefineEvent.DevelopmentAuthorized)?.data).toEqual({ summaryHash });
    await session.close();
  });
});
