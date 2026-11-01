import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { PLAN_STEP } from '../../server/refine/plan-prepare.js';
import { reduceRefineEvents } from '../../server/refine/state.js';
import { RefineJournal, RefineSession, type RunAgent } from '../../server/refine/session.js';
import { loadEvents } from '../../server/store/event-store.js';
import { makeSpec } from '../fixtures/contracts.js';

let root = '';
let ws: Workspace;
let agentCalls: Array<AgentStepRequest<'speckit'>>;
/** What the agent answers for one plan step; the default writes a valid plan. */
let answer: (req: AgentStepRequest<'speckit'>) => Promise<unknown>;

const draft = () => draftPaths(ws, 'hello-001');
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const summary = { usage, costUsd: 0, durationMs: 1, numTurns: 1, rateLimit: null };
const runAgent: RunAgent = (async (req: AgentStepRequest<'speckit'>, ctx: { specHash: string }) => {
  agentCalls.push(req);
  const out = await answer(req);
  return { ok: true, value: { specHash: ctx.specHash, questions: [], ...(out as object) }, summary };
}) as never;
const deps = () => ({ ws, draft: draft(), runAgent, exec: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false }), secretsDir: `${root}/secrets`, retrieval: () => [] });

/** The criterion ids of the spec fixture, which every plan names in its tasks. */
const IDS = makeSpec().acceptanceCriteria.map((criterion) => criterion.id);

/** A plan that passes the shape check for one item. */
const planFor = (key: string, ids: string[] = IDS): string => `# ${key} Implementation Plan

**Goal:** Build ${key}.

**Architecture:** One module.

**Tech Stack:** TypeScript.

**Spec:** docs/specs/${key}/spec.md, section "## ${key}".

## Global Constraints

- The stack values of stack.md.

## Review Focus

- A repeated submit writes once.

### Task 1: ${key} core

**Files:**
- Create: \`src/${key}.ts\`

**Criteria:** ${ids.join(', ')}

## Assumptions

- None.
`;

/** The item a plan step is about, named in its pack. */
const keyOf = (req: AgentStepRequest<'speckit'>): string => /backlog item "([\w-]+):/.exec(req.pack.feedback!)![1]!;

/** A finished plan step: it writes the plan in its folder, as a working agent does. */
async function writePlan(req: AgentStepRequest<'speckit'>, text: (key: string) => string = (key) => planFor(key)) {
  const file = `docs/specs/${keyOf(req)}/implementation-plan.md`;
  await fs.mkdir(path.dirname(path.join(req.cwd, file)), { recursive: true });
  await fs.writeFile(path.join(req.cwd, file), text(keyOf(req)));
  return { status: 'done', summary: 'ok', files: [file], questions: [] };
}

/** A wizard session whose backlog of two items is detailed, with each item's spec and pre-plan. */
async function detailedSession(): Promise<RefineSession> {
  const created = await RefineSession.create(deps(), 'new-project', { repositories: false });
  await created.enableBacklog();
  await created.close();
  const journal = await RefineJournal.open(draft().events, { projectId: 'hello-app', specId: 'hello-001' });
  const item = (key: string, rank: number) => ({ key, title: `Item ${key}`, epic: 'core', priority: 'must', rank, size: 'S', scope: 's', rationale: 'r', dependsOn: [], sources: [] });
  await journal.fact(RefineEvent.BacklogDerived, { project: null, epics: [], items: [item('login', 1), item('cart', 2)], cycle: 1 });
  for (const key of ['cart', 'login']) {
    const spec = makeSpec({ specId: key });
    await fs.mkdir(`${draft().docs}/specs/${key}`, { recursive: true });
    await fs.writeFile(`${draft().docs}/specs/${key}/spec.json`, JSON.stringify(spec));
    await journal.fact(RefineEvent.SpecDerived, { key, specId: key, inputHash: 'i', rev: 'r', spec, issues: [], cycle: 1 });
    await fs.writeFile(`${draft().docs}/specs/${key}/preplan.json`, '{"tasks":[]}');
    await journal.fact(RefineEvent.PreplanDerived, { key, inputHash: 'i', specRev: 'r', preplan: { tasks: [] }, issues: [], cycle: 1 });
  }
  await journal.close();
  return RefineSession.open(deps());
}

/** The events of the journal, reduced to the plan state the preparation leaves. */
const events = () => loadEvents(draft().events);

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-plan-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  agentCalls = [];
  answer = writePlan;
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('RefineSession.runPlans with the plan step', () => {
  it('writes one plan per item, publishes each into the draft docs, and marks the preparation done', async () => {
    const session = await detailedSession();
    await session.runPlans();
    expect(agentCalls.map(keyOf).sort()).toEqual(['cart', 'login']);
    expect(agentCalls.every((req) => req.kind === 'speckit' && req.model === PLAN_STEP.model && req.effort === PLAN_STEP.effort)).toBe(true);
    for (const key of ['cart', 'login']) expect(await fs.readFile(`${draft().docs}/specs/${key}/implementation-plan.md`, 'utf8')).toContain('## Assumptions');
    const journal = await events();
    expect(journal.some((e) => e.type === RefineEvent.PlansPrepared)).toBe(true);
    expect(reduceRefineEvents(journal).speckit?.status).toBe('done');
  });

  it('keeps the plans of an unchanged preparation, so a second run writes none', async () => {
    const session = await detailedSession();
    await session.runPlans();
    agentCalls = [];
    await session.runPlans();
    expect(agentCalls).toEqual([]);
    expect(reduceRefineEvents(await events()).speckit?.status).toBe('done');
  });

  it('a plan that stays broken after its two repairs stops only its own item, and the owner sees which item and which check failed', async () => {
    answer = (req) => writePlan(req, (key) => (key === 'cart' ? planFor(key, ['AC-999']) : planFor(key)));
    const session = await detailedSession();
    await session.runPlans();
    expect(agentCalls.filter((req) => keyOf(req) === 'cart')).toHaveLength(3);
    expect(agentCalls.filter((req) => keyOf(req) === 'login')).toHaveLength(1);
    expect(await fs.readFile(`${draft().docs}/specs/login/implementation-plan.md`, 'utf8')).toContain('## Assumptions');
    const failed = (await events()).find((e) => e.type === RefineEvent.SpeckitFailed);
    expect(failed).toBeDefined();
    expect(failed!.data.failures).toEqual([expect.objectContaining({ command: 'plan', itemKey: 'cart', kind: 'plan-shape' })]);
  });

  it('a plan step that says it cannot write its plan is stopped at once, without a repair', async () => {
    answer = async (req) => (keyOf(req) === 'cart' ? { status: 'blocked', reason: 'O trecho da spec está vazio.', summary: 'sem spec', files: [] } : writePlan(req));
    const session = await detailedSession();
    await session.runPlans();
    expect(agentCalls.filter((req) => keyOf(req) === 'cart')).toHaveLength(1);
    const failed = (await events()).find((e) => e.type === RefineEvent.SpeckitFailed);
    expect(failed!.data.failures).toEqual([expect.objectContaining({ itemKey: 'cart', kind: 'blocked' })]);
  });
});
