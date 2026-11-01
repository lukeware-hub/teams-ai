import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths } from '../../server/refine/draft.js';
import { DOC_STAGES } from '../../server/refine/doc-stages.js';
import { RefineEvent } from '../../server/refine/events.js';
import { reduceRefineEvents } from '../../server/refine/state.js';
import { RefineJournal, RefineSession, type RunAgent } from '../../server/refine/session.js';
import { loadEvents } from '../../server/store/event-store.js';
import { makeSpec } from '../fixtures/contracts.js';

let root = '';
let ws: Workspace;
let answer: (req: AgentStepRequest<'speckit'>) => Promise<unknown>;

const draft = () => draftPaths(ws, 'hello-001');
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const summary = { usage, costUsd: 0, durationMs: 1, numTurns: 1, rateLimit: null };
const runAgent: RunAgent = (async (req: AgentStepRequest<'speckit'>, ctx: { specHash: string }) => {
  const out = await answer(req);
  return { ok: true, value: { specHash: ctx.specHash, questions: [], ...(out as object) }, summary };
}) as never;
const deps = () => ({ ws, draft: draft(), runAgent, exec: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false }), secretsDir: `${root}/secrets`, retrieval: () => [] });

const IDS = makeSpec().acceptanceCriteria.map((criterion) => criterion.id);
const REPOSITORY: Record<string, string> = { cart: 'shop-api', login: 'shop-web' };

/** A plan that passes the shape check for one item of one repository. */
const planFor = (key: string): string => `# ${key} Implementation Plan

**Goal:** Build ${key}.

**Architecture:** One module.

**Tech Stack:** TypeScript.

**Spec:** docs/specs/${key}/spec.md, section "## ${key}".

**Repository:** ${REPOSITORY[key]}

## Global Constraints

- The stack values of stack.md.

## Review Focus

- A repeated submit writes once.

### Task 1: ${key} core

**Files:**
- Create: \`src/${key}.ts\`

**Criteria:** ${IDS.join(', ')}

## Assumptions

- None.
`;

/** A task list that passes the check for one item: one entry for its only plan task, citing every criterion. */
const tasksFor = (key: string): string => `# ${key} tasks

## Task 1: ${key} core

**Spec:** docs/specs/${key}/spec.md
**Plan:** docs/specs/${key}/implementation-plan.md
**Repository:** ${REPOSITORY[key]}
**Objective:** Build ${key}.
**Criteria:** ${IDS.join(', ')}
**Success scenario:** The ${key} works.
**Error scenario:** A wrong ${key} input is refused.
**Done when:** The ${key} is visible.
`;

/** The item a step is about, named in its pack. */
const keyOf = (req: AgentStepRequest<'speckit'>): string => /backlog item "([\w-]+):/.exec(req.pack.feedback!)![1]!;

/** A finished step: it writes its file in the folder, as a working agent does. */
async function writeFile(req: AgentStepRequest<'speckit'>, file: (key: string) => string, text: (key: string) => string) {
  const key = keyOf(req);
  await fs.mkdir(path.dirname(path.join(req.cwd, file(key))), { recursive: true });
  await fs.writeFile(path.join(req.cwd, file(key)), text(key));
  return { status: 'done', summary: 'ok', files: [file(key)], questions: [] };
}

/** A stamped wizard session with its five documents graphed, its architecture decided and its backlog of two items detailed. */
async function stampedSession(): Promise<RefineSession> {
  const created = await RefineSession.create(deps(), 'new-project', { repositories: true });
  await created.close();
  const journal = await RefineJournal.open(draft().events, { projectId: 'hello-app', specId: 'hello-001' });
  for (const doc of DOC_STAGES) {
    await journal.fact(RefineEvent.StageAdvanced, { doc, cycle: 1 });
    await journal.fact(RefineEvent.DocGraphed, { file: doc, hash: 'h', nodes: 1, links: 0, inputTokens: 0, outputTokens: 0 });
  }
  await journal.fact(RefineEvent.ArchitectureDecided, {
    docsHash: 'd',
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
  const item = (key: string, rank: number) => ({ key, title: `Item ${key}`, epic: 'core', priority: 'P1', rank, size: 'S', scope: 's', rationale: 'r', dependsOn: [], sources: [], repository: REPOSITORY[key] });
  await journal.fact(RefineEvent.BacklogDerived, { project: null, epics: [{ key: 'core', title: 'Core' }], items: [item('login', 1), item('cart', 2)], cycle: 1 });
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

const events = () => loadEvents(draft().events);

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-plan-tasks-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  answer = (req) => (req.role === 'test' ? writeFile(req, (key) => `docs/specs/${key}/task.md`, tasksFor) : writeFile(req, (key) => `docs/specs/${key}/implementation-plan.md`, planFor));
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('runPlans of a stamped draft writes the task list after each plan', () => {
  it('writes a plan and a task list per item, publishes both into the docs, and counts two steps per item', async () => {
    const session = await stampedSession();
    await session.runPlans();
    for (const key of ['cart', 'login']) {
      expect(await fs.readFile(`${draft().docs}/specs/${key}/implementation-plan.md`, 'utf8')).toContain('**Repository:**');
      expect(await fs.readFile(`${draft().docs}/specs/${key}/task.md`, 'utf8')).toContain('## Task 1:');
    }
    const journal = await events();
    const started = journal.find((e) => e.type === RefineEvent.SpeckitStarted);
    expect(started?.data).toMatchObject({ total: 4 });
    const state = reduceRefineEvents(journal);
    expect(state.speckit?.steps?.filter((s) => s.command === 'tasks').map((s) => s.itemKey).sort()).toEqual(['cart', 'login']);
    expect(state.speckit?.status).toBe('done');
  });

  it('a task list that stays broken stops only its item, with the step that failed named in the failure', async () => {
    answer = (req) =>
      req.role === 'test'
        ? writeFile(req, (key) => `docs/specs/${key}/task.md`, (key) => (key === 'cart' ? tasksFor(key).replace(`**Criteria:** ${IDS.join(', ')}`, '**Criteria:** AC-999') : tasksFor(key)))
        : writeFile(req, (key) => `docs/specs/${key}/implementation-plan.md`, planFor);
    const session = await stampedSession();
    await session.runPlans();
    const state = reduceRefineEvents(await events());
    expect(state.speckit?.failures?.map((f) => `${f.command}:${f.itemKey}`)).toEqual(['tasks:cart']);
    expect(await fs.readFile(`${draft().docs}/specs/login/task.md`, 'utf8')).toContain('## Task 1:');
  });
});
