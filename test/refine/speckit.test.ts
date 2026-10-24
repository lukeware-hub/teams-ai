import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandError, type CommandSpec, type Exec } from '../../server/exec/command.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import { createNewProject, draftPaths, writeDoc } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { ConflictError, RefineJournal, RefineSession, type RunAgent } from '../../server/refine/session.js';
import { speckitPack } from '../../server/refine/speckit-pack.js';
import { SPECKIT_NOT_INSTALLED } from '../../server/refine/speckit.js';
import { canStart } from '../../server/refine/state.js';
import { makeSpec } from '../fixtures/contracts.js';

let root = '';
let ws: Workspace;
let execCalls: CommandSpec[];
let agentCalls: Array<AgentStepRequest<'speckit'>>;
let exec: Exec;
let answer: (req: AgentStepRequest<'speckit'>) => unknown;

const draft = () => draftPaths(ws, 'hello-001');
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const summary = { usage, costUsd: 0, durationMs: 1, numTurns: 1, rateLimit: null };
const runAgent: RunAgent = (async (req: AgentStepRequest<'speckit'>, ctx: { specHash: string }) => {
  agentCalls.push(req);
  const out = answer(req);
  return out === null ? { ok: false, failure: 'schema', errors: ['bad json'], summary } : { ok: true, value: { specHash: ctx.specHash, ...(out as object) }, summary };
}) as never;
const deps = () => ({ ws, draft: draft(), runAgent, exec: (spec: CommandSpec) => exec(spec), secretsDir: `${root}/secrets`, retrieval: () => [] });
const item = (key: string, rank: number) => ({ key, title: `Item ${key}`, epic: 'core', priority: 'must', rank, size: 'S', scope: 's', rationale: 'r', dependsOn: [], sources: [] });

/** A wizard session whose backlog of two items is detailed. */
async function detailedSession(): Promise<RefineSession> {
  const created = await RefineSession.create(deps(), 'new-project');
  await created.enableBacklog();
  await created.close();
  const journal = await RefineJournal.open(draft().events, { projectId: 'hello-app', specId: 'hello-001' });
  await journal.fact(RefineEvent.BacklogDerived, { project: null, epics: [], items: [item('login', 1), item('cart', 2)], cycle: 1 });
  for (const key of ['cart', 'login']) {
    const spec = makeSpec({ specId: key });
    await fs.mkdir(`${draft().docs}/specs/${key}`, { recursive: true });
    await fs.writeFile(`${draft().docs}/specs/${key}/spec.json`, JSON.stringify(spec));
    await journal.fact(RefineEvent.SpecDerived, { key, specId: key, inputHash: 'i', rev: 'r', spec, issues: [], cycle: 1 });
  }
  await fs.writeFile(`${draft().docs}/specs/login/preplan.json`, '{"tasks":[]}');
  await journal.fact(RefineEvent.PreplanDerived, { key: 'login', inputHash: 'i', specRev: 'r', preplan: { tasks: [] }, issues: [], cycle: 1 });
  await journal.close();
  return RefineSession.open(deps());
}

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-speckit-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  execCalls = [];
  agentCalls = [];
  exec = async (spec) => {
    execCalls.push(spec);
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false };
  };
  answer = (req) => ({ status: 'done', summary: 'feito', files: [`out-${agentCalls.length}-${req.pack.kind}.md`] });
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('speckitPack', () => {
  const docs = '/w/refine/hello-001/docs';

  it('tells the agent to read the skill of its command and names the documents by absolute path', () => {
    const p = speckitPack({ command: 'constitution', specHash: 'sha256:x', docsDir: docs });
    expect(p).toMatchObject({ kind: 'speckit', role: 'dev' });
    expect(p.feedback).toContain('.claude/skills/speckit-constitution/SKILL.md');
    for (const file of ['project.md', 'stack.md', 'design.md']) expect(p.feedback).toContain(`${docs}/${file}`);
    expect(p.feedback).toContain('Quality rules');
  });

  it('points an item command at its spec, its pre-plan and its own feature directory', () => {
    const specify = speckitPack({ command: 'specify', specHash: 'sha256:x', docsDir: docs, item: { key: 'login', specId: 'login', title: 'Entrar' } });
    expect(specify.feedback).toContain(`${docs}/specs/login/spec.json`);
    expect(specify.feedback).toContain('SPECIFY_FEATURE_DIRECTORY=specs/login');
    expect(specify.feedback).toContain(`${docs}/flow.md`);
    const plan = speckitPack({ command: 'plan', specHash: 'sha256:x', docsDir: docs, item: { key: 'login', specId: 'login', title: 'Entrar' } });
    expect(plan.feedback).toContain(`${docs}/specs/login/preplan.json`);
    expect(plan.feedback).toContain('.claude/skills/speckit-plan/SKILL.md');
  });
});

describe('RefineSession.runSpeckit', () => {
  it('initializes Spec Kit in a fresh staging folder, then runs the constitution and each item in rank order', async () => {
    const s = await detailedSession();
    await fs.mkdir(`${draft().root}/speckit`, { recursive: true });
    await fs.writeFile(`${draft().root}/speckit/old.txt`, 'from an earlier run');
    await s.runSpeckit();
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({ bin: 'specify', cwd: `${draft().root}/speckit` });
    expect(execCalls[0]!.args).toEqual(expect.arrayContaining(['init', '--here', '--force', '--non-interactive', '--integration', 'claude', '--script', 'sh']));
    await expect(fs.access(`${draft().root}/speckit/old.txt`)).rejects.toThrow();
    const order = agentCalls.map((r) => `${r.pack.feedback!.match(/speckit-(\w+)\/SKILL/)![1]}:${r.pack.feedback!.match(/SPECIFY_FEATURE_DIRECTORY=specs\/(\w+)/)?.[1] ?? ''}`);
    expect(order).toEqual(['constitution:', 'specify:login', 'plan:login', 'tasks:login', 'specify:cart', 'plan:cart', 'tasks:cart']);
    expect(agentCalls.every((r) => r.kind === 'speckit' && r.role === 'dev' && r.cwd === `${draft().root}/speckit` && r.taskId === null)).toBe(true);
    expect(agentCalls[0]!.extraAllow).toEqual(expect.arrayContaining(['Bash(bash:*)', 'Bash(.specify/scripts/bash/*:*)', `Read(//${draft().docs.replace(/^\/+/, '')}/**)`]));
    const types = s.events.map((e) => e.type).filter((t) => t.startsWith('SPECKIT_'));
    expect(types).toEqual([RefineEvent.SpeckitStarted, ...Array(7).fill(RefineEvent.SpeckitStepDone), RefineEvent.SpeckitDone]);
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitStarted)!.data).toEqual({ total: 7 });
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitStepDone && e.data.command === 'plan')!.data).toEqual({ command: 'plan', itemKey: 'login', files: ['out-3-speckit.md'] });
    expect(s.state.speckit).toMatchObject({ status: 'done', stale: false, total: 7 });
    expect(s.state.speckit!.steps).toHaveLength(7);
    expect(canStart(s.state)).toBe(true);
    await s.close();
  });

  it('a document changed after the preparation shuts the start until it runs again', async () => {
    const s = await detailedSession();
    expect(canStart(s.state)).toBe(false);
    await s.runSpeckit();
    expect(canStart(s.state)).toBe(true);
    await s.saveDoc('stack.md', '# Stack\n\nNode 24\n');
    expect(s.state.speckit?.stale).toBe(true);
    expect(canStart(s.state)).toBe(false);
    await s.close();
  });

  it('says plainly when Spec Kit is not installed, and runs no agent', async () => {
    exec = async () => {
      throw new CommandError('cannot run specify: spawn specify ENOENT');
    };
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed', error: SPECKIT_NOT_INSTALLED });
    expect(agentCalls).toHaveLength(0);
    expect(s.busy).toBe(false);
    await s.close();
  });

  it('fails on an init that exits with an error', async () => {
    exec = async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1, truncated: false });
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit?.status).toBe('failed');
    expect(s.state.speckit?.error).toContain('Spec Kit');
    expect(agentCalls).toHaveLength(0);
    await s.close();
  });

  it('stops at the first step that fails or that the agent reports blocked', async () => {
    answer = (req) => (req.pack.feedback!.includes('speckit-plan/SKILL') ? { status: 'blocked', summary: 'parou', files: [], reason: 'o plano não fecha' } : { status: 'done', summary: 'ok', files: [] });
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.speckit?.error).toContain('o plano não fecha');
    expect(agentCalls).toHaveLength(3);
    answer = () => null;
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed', steps: [] });
    expect(s.state.speckit?.error).toContain('Spec Kit');
    await s.close();
  });

  it('refuses before the backlog is detailed and while a preparation runs', async () => {
    const plain = await RefineSession.create(deps(), 'new-project');
    expect(() => plain.runSpeckit()).toThrow(ConflictError);
    await plain.close();
    const s = await detailedSession();
    let release!: () => void;
    exec = (spec) => new Promise((resolve) => (release = () => resolve({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: spec.args.length < 0 })));
    const first = s.runSpeckit();
    expect(() => s.runSpeckit()).toThrow(ConflictError);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await first;
    await s.close();
  });

  it('a preparation cut by a restart reopens as failed', async () => {
    const s = await detailedSession();
    await s.close();
    const journal = await RefineJournal.open(draft().events, { projectId: 'hello-app', specId: 'hello-001' });
    await journal.fact(RefineEvent.SpeckitStarted, { total: 7 });
    await journal.close();
    const reopened = await RefineSession.open(deps());
    expect(reopened.state.speckit).toMatchObject({ status: 'failed', error: 'interrupted' });
    await reopened.close();
  });

  it('keeps the briefing in backlog mode readable to the pack', async () => {
    const s = await detailedSession();
    await writeDoc(draft(), 'briefing.md', '# Briefing\n');
    await s.runSpeckit();
    expect(agentCalls[1]!.pack.feedback).toContain(`${draft().docs}/briefing.md`);
    await s.close();
  });
});
