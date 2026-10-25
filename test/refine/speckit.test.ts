import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandError, type CommandSpec, type Exec } from '../../server/exec/command.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import { createNewProject, draftPaths, writeDoc } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { ConflictError, RefineJournal, RefineSession, type RunAgent } from '../../server/refine/session.js';
import { speckitPack } from '../../server/refine/speckit-pack.js';
import { SPECKIT_NOT_INSTALLED, speckitFeatureOf } from '../../server/refine/speckit.js';
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
  const out = await answer(req);
  return out === null ? { ok: false, failure: 'schema', errors: ['bad json'], summary } : { ok: true, value: { specHash: ctx.specHash, questions: [], ...(out as object) }, summary };
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
  const inputs = '/w/refine/hello-001/speckit-input';
  const item = { key: 'login', specId: 'login', title: 'Entrar' };

  it('tells the agent to read the skill of its command and names the six markdown inputs by absolute path', () => {
    const p = speckitPack({ command: 'constitution', specHash: 'sha256:x', inputDir: inputs });
    expect(p).toMatchObject({ kind: 'speckit', role: 'dev' });
    expect(p.feedback).toContain('.claude/skills/speckit-constitution/SKILL.md');
    for (const file of ['project.md', 'flow.md', 'briefing.md', 'stack.md', 'design.md', 'specs.md']) expect(p.feedback).toContain(`${inputs}/${file}`);
    expect(p.feedback).not.toContain('.json');
    expect(p.feedback).toContain('derived from these six files');
    expect(p.feedback).toContain('Quality rules');
  });

  it('points an item command at its section of specs.md and its own feature directory', () => {
    for (const command of ['specify', 'clarify', 'plan', 'tasks'] as const) {
      const p = speckitPack({ command, specHash: 'sha256:x', inputDir: inputs, item });
      expect(p.feedback, command).toContain(`${inputs}/specs.md`);
      expect(p.feedback, command).toContain('"## login: Entrar"');
      expect(p.feedback, command).not.toContain('SPECIFY_FEATURE_DIRECTORY');
      expect(p.feedback, command).toContain(`.claude/skills/speckit-${command}/SKILL.md`);
    }
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
    const order = agentCalls.map((r) => `${r.pack.feedback!.match(/speckit-(\w+)\/SKILL/)![1]}:${r.pack.feedback!.match(/"## (\w+):/)?.[1] ?? ''}`);
    expect(order).toEqual(['constitution:', 'specify:login', 'clarify:login', 'plan:login', 'tasks:login', 'specify:cart', 'clarify:cart', 'plan:cart', 'tasks:cart']);
    expect(agentCalls.every((r) => r.kind === 'speckit' && r.role === 'dev' && r.cwd === `${draft().root}/speckit` && r.taskId === null)).toBe(true);
    expect(agentCalls[0]!.extraAllow).toEqual(expect.arrayContaining(['Bash(bash:*)', 'Bash(.specify/scripts/bash/*:*)', `Read(//${`${draft().root}/speckit-input`.replace(/^\/+/, '')}/**)`]));
    const types = s.events.map((e) => e.type).filter((t) => t.startsWith('SPECKIT_'));
    expect(types).toEqual([RefineEvent.SpeckitStarted, ...Array.from({ length: 9 }, () => [RefineEvent.SpeckitStepStarted, RefineEvent.SpeckitStepDone]).flat(), RefineEvent.SpeckitDone]);
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitStarted)!.data).toEqual({ total: 9 });
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitStepStarted && e.data.command === 'plan')!.data).toEqual({ command: 'plan', itemKey: 'login' });
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitStepDone && e.data.command === 'plan')!.data).toEqual({ command: 'plan', itemKey: 'login', files: ['out-4-speckit.md'] });
    expect(s.state.speckit).toMatchObject({ status: 'done', stale: false, total: 9 });
    expect(s.state.speckit!.steps).toHaveLength(9);
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

  it('keeps the questions of a blocked step on record, so the owner can answer them before a re-run', async () => {
    answer = (req) => (req.pack.feedback!.includes('speckit-plan/SKILL') ? { status: 'blocked', summary: 'parou', files: [], reason: 'o plano não fecha', questions: [{ text: 'Qual o prazo de retenção?', blocking: true }] } : { status: 'done', summary: 'ok', files: [] });
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.questions).toEqual([expect.objectContaining({ text: 'Qual o prazo de retenção?', blocking: true, status: 'pending', origin: 'speckit' })]);
    expect(s.state.speckit?.steps.at(-1)).toMatchObject({ command: 'plan' });
    await s.close();
  });

  it('stops at the first step that fails or that the agent reports blocked', async () => {
    answer = (req) => (req.pack.feedback!.includes('speckit-plan/SKILL') ? { status: 'blocked', summary: 'parou', files: [], reason: 'o plano não fecha' } : { status: 'done', summary: 'ok', files: [] });
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.speckit?.error).toContain('o plano não fecha');
    expect(agentCalls).toHaveLength(4);
    answer = () => null;
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed', steps: [] });
    expect(s.state.speckit?.error).toContain('Spec Kit');
    await s.close();
  });

  it('asks the owner the questions Spec Kit leaves open, once each, and a blocking one holds the start until answered', async () => {
    const choice = { label: 'Real', detail: '', recommended: true };
    answer = (req) => {
      if (req.pack.feedback!.includes('speckit-specify/SKILL') && req.pack.feedback!.includes('"## login:')) {
        return { status: 'done', summary: 'ok', files: [], questions: [{ text: 'Qual moeda?', blocking: true, options: [choice] }, { text: '  qual   MOEDA? ', blocking: false }, { text: 'Precisa de 2FA?', blocking: false }] };
      }
      return { status: 'done', summary: 'ok', files: [] };
    };
    const s = await detailedSession();
    await s.runSpeckit();
    const asked = s.state.questions.filter((q) => q.origin === 'speckit');
    expect(asked.map((q) => [q.text, q.blocking, q.itemKey, q.status])).toEqual([['Qual moeda?', true, 'login', 'pending'], ['Precisa de 2FA?', false, 'login', 'pending']]);
    expect(asked[0]!.options).toEqual([choice]);
    expect(new Set(asked.map((q) => q.questionId)).size).toBe(2);
    expect(s.state.speckit?.status).toBe('done');
    expect(canStart(s.state)).toBe(false);
    // The answer goes into briefing.md, which makes the preparation stale until the owner runs it again.
    await s.answer(asked[0]!.questionId, 'Real');
    expect(await fs.readFile(`${draft().docs}/briefing.md`, 'utf8')).toContain('Real');
    expect(s.state.speckit?.stale).toBe(true);
    expect(canStart(s.state)).toBe(false);
    // A re-run that asks the same questions again adds none.
    await s.runSpeckit();
    expect(s.state.questions.filter((q) => q.origin === 'speckit')).toHaveLength(2);
    expect(canStart(s.state)).toBe(true);
    await s.close();
  });

  it('tells the agent to list open points as questions instead of asking, and to follow the decisions in briefing.md', () => {
    const p = speckitPack({ command: 'plan', specHash: 'sha256:x', inputDir: '/w/in', item: { key: 'login', specId: 'login', title: 'Entrar' } });
    expect(p.feedback).toContain('`questions`');
    expect(p.feedback).toContain('[NEEDS CLARIFICATION]');
    expect(p.feedback).toContain('## Decisões');
    expect(p.feedback).toContain('/w/in/briefing.md');
  });

  it('keeps the feature directory Spec Kit numbered for each item, from the files or else from .specify/feature.json', async () => {
    answer = (req) => {
      const fb = req.pack.feedback!;
      if (!fb.includes('speckit-specify/SKILL')) return { status: 'done', summary: 'ok', files: [] };
      if (fb.includes('"## login:')) return { status: 'done', summary: 'ok', files: ['specs/001-login-page/spec.md', 'specs/001-login-page/checklists/requirements.md'] };
      return fs.writeFile(`${req.cwd}/.specify/feature.json`, '{"feature_directory":"specs/002-cart"}').then(() => ({ status: 'done', summary: 'ok', files: [] }));
    };
    exec = async (spec) => {
      await fs.mkdir(`${spec.cwd}/.specify`, { recursive: true });
      return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false };
    };
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit?.features).toEqual({ login: 'specs/001-login-page', cart: 'specs/002-cart' });
    await s.close();
    expect(await speckitFeatureOf(draft().root, 'cart')).toBe('specs/002-cart');
    expect(await speckitFeatureOf(draft().root, 'other')).toBeUndefined();
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
    // The preparation first writes its inputs, so the command starts a little after the call: wait for it rather than a fixed time.
    await vi.waitFor(() => expect(release).toBeDefined());
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
    expect(reopened.state.speckit).toMatchObject({ status: 'failed', error: 'A preparação foi interrompida quando o servidor reiniciou.' });
    await reopened.close();
  });

  it('copies the five documents and writes specs.md outside the published folder, fresh on each run, and hashes them', async () => {
    const s = await detailedSession();
    const dir = `${draft().root}/speckit-input`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/old.md`, 'x');
    await writeDoc(draft(), 'briefing.md', '# Briefing\n\n## Objetivo\n\nVender\n');
    await s.runSpeckit();
    expect((await fs.readdir(dir)).sort()).toEqual(['briefing.md', 'design.md', 'flow.md', 'project.md', 'specs.md', 'stack.md']);
    const read = (file: string) => fs.readFile(`${dir}/${file}`, 'utf8');
    expect(await read('briefing.md')).toBe('# Briefing\n\n## Objetivo\n\nVender\n');
    expect(await read('stack.md')).toBe(await fs.readFile(draft().stackMd, 'utf8'));
    const specs = await read('specs.md');
    expect(specs.indexOf('## login: Item login')).toBeLessThan(specs.indexOf('## cart: Item cart'));
    await expect(fs.access(`${draft().root}/speckit/specs.md`)).rejects.toThrow();
    const first = s.events.find((e) => e.type === RefineEvent.SpeckitDone)!.data.inputHash;
    await s.saveDoc('stack.md', '# Stack\n\nGo\n');
    await s.runSpeckit();
    expect(s.events.filter((e) => e.type === RefineEvent.SpeckitDone).at(-1)!.data.inputHash).not.toBe(first);
    await s.close();
  });
});
