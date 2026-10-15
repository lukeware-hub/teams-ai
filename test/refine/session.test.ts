import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSecret } from '../../server/core/secrets.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, readDoc, renderBriefMd, writeDoc } from '../../server/refine/draft.js';
import { ConflictError, programEntries, RefineSession } from '../../server/refine/session.js';
import type { BacklogState } from '../../server/refine/state.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { calls, makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';

let root = '';
let ws: Workspace;
let secretsDir = '';
let script: Script;

const derived = { project: makeProject(), spec: { ...makeSpec(), status: 'refining', specHash: null, externalDependencies: [{ name: 'db', purpose: 'p', secretNames: ['DB_URL'] }] } };
const green = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'];
const SM = ['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'];
const refineOut = (checklist: unknown[], questions: unknown[] = [], docPatch: unknown[] = []) => ({ checklist, questions, docPatch });
const draft = () => draftPaths(ws, 'hello-001');
const deps = () => ({ ws, draft: draft(), runAgent: makeFakeRunAgent(script), secretsDir, retrieval: () => [] });

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'))).replace(/\\/g, '/');
  secretsDir = `${root}/secrets`;
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  script = {};
  calls.length = 0;
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('RefineSession', () => {
  it('backlog mode moves the brief to the target project docs/briefing.md, and a reopen finishes an interrupted move', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    const brief = await readDoc(draft(), 'brief.md');
    await s.enableBacklog();
    expect(await fs.readFile(`${draft().docs}/briefing.md`, 'utf8')).toBe(brief);
    await expect(fs.access(draft().briefMd)).rejects.toThrow();
    expect((await s.snapshot()).docs['brief.md']).toBe(brief);
    await s.close();
    // A crash between BACKLOG_ENABLED and the move leaves a brief behind; opening the session again finishes the move.
    await fs.mkdir(path.dirname(draft().briefMd), { recursive: true });
    await fs.writeFile(draft().briefMd, '## Description\n\nOutra demanda.\n');
    const again = await RefineSession.open(deps());
    expect(await fs.readFile(`${draft().docs}/briefing.md`, 'utf8')).toContain('## Nova demanda (hello-001)\n\n### Description\n\nOutra demanda.');
    await expect(fs.access(draft().briefMd)).rejects.toThrow();
    await again.close();
  });

  it('keeps the criterion ids of the spec it continues as the floor of the backlog numbering', async () => {
    const s = await RefineSession.create(deps(), 'continue');
    const continued = { ...makeSpec({ specId: 'hello-001' }), acceptanceCriteria: [{ id: 'AC-040', given: 'g', when: 'w', then: 't', smoke: true }] };
    await fs.writeFile(draft().specJson, JSON.stringify(continued));
    await s.enableBacklog();
    await expect(fs.access(draft().specJson)).rejects.toThrow();
    expect(s.state.backlog?.acHighWater).toBe(40);
    await s.close();
  });

  it('migrates an existing draft that predates design.md', async () => {
    const design = path.join(draft().docs, 'design.md');
    await fs.rm(design);
    const s = await RefineSession.open(deps());
    expect(await fs.readFile(design, 'utf8')).toContain('executable visual contract');
    await s.close();
  });

  it('evaluates: derive, PO and SM, questions merged blocking-first, patches proposed or discarded, no secrets item', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q1', text: 'Which DB?', blocking: false, relatedAcIds: [] }], [{ file: 'docs/project.md', find: '## Vision', replace: '## Product vision', reason: 'clearer' }, { file: 'docs/project.md', find: 'nope', replace: 'x', reason: 'r' }])];
    script['refine/sm'] = [refineOut(green(SM), [{ id: 'q2', text: 'which db?', blocking: true, relatedAcIds: [] }, { id: 'q3', text: 'Port?', blocking: true, relatedAcIds: [] }])];
    await s.evaluate();
    const st = s.state;
    expect(st.status).toBe('answering');
    expect(st.derived?.spec.specId).toBe('hello-001');
    expect(st.questions.map((q) => [q.questionId, q.blocking])).toEqual([['sm-c1-0', true], ['sm-c1-1', true]]);
    expect(st.patches.map((p) => p.status)).toEqual(['pending']);
    expect(st.patches[0]!.diff).toContain('+## Product vision');
    expect(st.discarded[0]).toMatchObject({ reason: 'find not found in project.md' });
    expect(st.checklist.map((i) => i.id)).not.toContain('sm.dependencies-and-secrets');
    expect(st.checklist.find((i) => i.id === 'sm.no-open-questions')).toMatchObject({ passed: false });
    expect(calls.map((c) => c.kind)).toEqual(['derive', 'refine', 'refine']);
    expect((await s.snapshot()).tokens.steps).toBe(3);
  });

  it('routes Front patches to design.md and keeps them reviewable', async () => {
    const base = deps();
    const s = await RefineSession.create({
      ...base,
      frontAgent: makeFakeRunAgent(script),
    }, 'new-project');
    script['derive/po'] = [derived];
    script['refine/front'] = [refineOut([], [], [{ file: 'docs/design.md', find: '# Design', replace: '# Product design', reason: 'define the visual contract' }])];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    expect(s.state.patches).toHaveLength(1);
    expect(s.state.patches[0]).toMatchObject({ role: 'front', file: 'design.md', status: 'pending' });
    expect(s.state.patches[0]!.diff).toContain('+# Product design');
  });

  const frontSchemaFailures = (times: number) => {
    const inner = makeFakeRunAgent(script);
    let left = times;
    return (async (req: Parameters<typeof inner>[0], ctx: Parameters<typeof inner>[1]) => {
      if (req.role === 'front' && left-- > 0) {
        const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
        return { ok: false, failure: 'schema', errors: ['docPatch.3.reason: Invalid input: expected string, received undefined'], summary: { usage, costUsd: 0, durationMs: 1, numTurns: 1, rateLimit: null }, sandboxDisabled: false } as never;
      }
      return inner(req, ctx);
    }) as typeof inner;
  };

  it('asks the Front again when it answers outside the format once, and keeps its suggestions', async () => {
    const s = await RefineSession.create({ ...deps(), frontAgent: frontSchemaFailures(1) }, 'new-project');
    script['derive/po'] = [derived];
    script['refine/front'] = [refineOut([], [], [{ file: 'docs/design.md', find: '# Design', replace: '# Product design', reason: 'define the visual contract' }])];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    expect(s.state.status).not.toBe('error');
    expect(s.state.patches[0]).toMatchObject({ role: 'front', file: 'design.md', status: 'pending' });
  });

  it('goes on without the Front suggestions, and says so, when it answers outside the format twice, instead of failing the evaluation', async () => {
    const s = await RefineSession.create({ ...deps(), frontAgent: frontSchemaFailures(2) }, 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    expect(s.state.status).not.toBe('error');
    expect(s.state.patches).toHaveLength(0);
    expect(s.state.discarded).toEqual([expect.objectContaining({ role: 'front', reason: expect.stringContaining('fora do formato duas vezes') })]);
  });

  it('continues after a Jev advisory without requiring a document edit', async () => {
    let validations = 0;
    const s = await RefineSession.create({
      ...deps(),
      validateDocs: async () => validations++ === 0
        ? { available: true, decision: 'blocked' as const, consistent: false, confidence: 0.2, model: 'jev', checks: { flow_covers_scope: 0.2 }, stateTruncated: false }
        : { available: true, decision: 'approved' as const, consistent: true, confidence: 0.95, model: 'jev', checks: { flow_covers_scope: 0.95 }, stateTruncated: false },
    }, 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    expect(s.state.cycle).toBe(1);
    expect(calls.map((call) => call.kind)).toEqual(['derive', 'refine', 'refine']);
  });

  it("journals the owner's mark that the documents already answered a question, the label the routing eval reads", async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: 'Port?', blocking: true, relatedAcIds: [] }])];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    await s.answer('po-c1-0', 'project.md › Execução: 8080', true);
    await s.close();
    const answered = (await fs.readFile(draft().events, 'utf8')).split('\n').filter((l) => l.includes('"QUESTION_ANSWERED"')).map((l) => JSON.parse(l).data);
    expect(answered).toEqual([{ questionId: 'po-c1-0', text: 'project.md › Execução: 8080', docsAnswered: true }]);
  });

  it('starts no cycle when the evaluation is aborted while the floor is read', async () => {
    let release!: (floor: number | undefined) => void;
    const reading = new Promise<number | undefined>((resolve) => { release = resolve; });
    const s = await RefineSession.create({ ...deps(), autoAnswerFloor: () => reading } as never, 'new-project');
    script['derive/po'] = [derived];
    const evaluating = s.evaluate();
    const aborting = s.abort();
    release(undefined);
    await aborting;
    await evaluating;
    await s.close();
    expect(await fs.readFile(draft().events, 'utf8')).not.toContain('REFINE_CYCLE_STARTED');
  });

  it('reads the auto answer floor at each evaluation, and the next cycle sees the answer a role gave from the docs', async () => {
    let floor: number | undefined = 0.9;
    const decider = { decide: async (id: string) => (id === 'question-routing' ? { answered: true as const, backend: 'jev' as const, escalated: false, answers: { route: { type: 'choice' as const, value: 'auto', probabilities: { auto: 0.95 }, confidence: 0.95 } } } : { answered: false as const, reason: 'disabled' as const }) };
    const s = await RefineSession.create({ ...deps(), decider: decider as never, autoAnswerFloor: async () => floor } as never, 'new-project');
    script['derive/po'] = [derived, derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: 'Port?', blocking: true, relatedAcIds: [] }]), refineOut(green(PO), [{ id: 'q2', text: 'Name?', blocking: true, relatedAcIds: [] }])];
    script['refine/sm'] = [refineOut(green(SM)), refineOut(green(SM))];
    script['answer/po'] = [{ answer: 'project.md › Execução: 8080.' }];
    await s.evaluate();
    expect(s.state.questions.find((q) => q.questionId === 'po-c1-0')).toMatchObject({ status: 'answered', answeredBy: 'po' });
    floor = undefined;
    await s.evaluate();
    expect(calls.filter((c) => c.kind === 'answer')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'refine').at(-1)!.prompt).toContain('project.md › Execução: 8080.');
    expect(s.state.questions.find((q) => q.questionId === 'po-c2-0')).toMatchObject({ status: 'pending' });
    await s.close();
  });

  // Plan 90 review: the answers given before the backlog was on reach the briefing too, since no agent records one now.
  it('writes into the briefing the answers given before the backlog was turned on, and nothing while it is a single spec', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: 'Port?', blocking: true, relatedAcIds: [] }])];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    const brief = await readDoc(draft(), 'brief.md');
    await s.answer('po-c1-0', '8080');
    expect(await readDoc(draft(), 'brief.md')).toBe(brief);
    await s.enableBacklog();
    expect(await fs.readFile(`${draft().docs}/briefing.md`, 'utf8')).toMatch(/\n## Decisões\n\n### Port\?\n\n> 8080\n$/);
    // Written before the backlog is journaled, in one edit, so a crash in between loses no answer and a second call adds nothing.
    const events = (await fs.readFile(draft().events, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string; data: { source?: string } });
    const written = events.findIndex((e) => e.type === 'DOC_EDITED' && e.data.source === 'decision');
    expect(written).toBeGreaterThan(-1);
    expect(written).toBeLessThan(events.findIndex((e) => e.type === 'BACKLOG_ENABLED'));
    expect(events.filter((e) => e.type === 'DOC_EDITED' && e.data.source === 'decision')).toHaveLength(1);
    await s.enableBacklog();
    expect((await fs.readFile(draft().events, 'utf8')).trim().split('\n')).toHaveLength(events.length);
    await s.close();
  });

  it('routes answers and rejections into the next cycle, refuses skipping a blocking question, and reaches ready', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived, derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: 'Port?', blocking: true, relatedAcIds: [] }], [{ file: 'docs/project.md', find: '## Vision', replace: '## V', reason: 'r' }]), refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM)), refineOut(green(SM))];
    await writeSecret(secretsDir, 'DB_URL', 'postgres://x');
    await s.evaluate();
    await expect(s.skip('po-c1-0')).rejects.toBeInstanceOf(ConflictError);
    await s.answer('po-c1-0', '8080');
    await s.reject('po-c1-0', 'keep heading');
    await s.evaluate();
    const prompt = calls.filter((c) => c.kind === 'refine').at(-1)!.prompt;
    expect(prompt).toContain('Port?');
    expect(prompt).toContain('8080');
    expect(prompt).toContain('keep heading');
    expect(s.state.status).toBe('ready');
    expect(s.state.stale).toBe(false);
  });

  // R11.7.1: ready allows a pending question that does not block, so an answer may come after the last evaluation.
  it('freezes the spec with every answer as a decision, also one given after the last evaluation', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: 'Port?', blocking: false, relatedAcIds: [] }])];
    script['refine/sm'] = [refineOut(green(SM))];
    await writeSecret(secretsDir, 'DB_URL', 'postgres://x');
    await s.evaluate();
    expect(s.state.status).toBe('ready');
    await s.answer('po-c1-0', '8080');
    const { spec } = await s.freeze();
    expect(spec.decisions).toEqual([{ question: 'Port?', answer: '8080' }]);
    expect(JSON.parse(await fs.readFile(draft().specJson, 'utf8')).decisions).toEqual([{ question: 'Port?', answer: '8080' }]);
  });

  // R11.7.1: seen live, a continued spec asked again the questions its last version had answered.
  it('drops a question the continued spec already answered', async () => {
    const s = await RefineSession.create(deps(), 'continue');
    await writeDoc(draft(), 'brief.md', renderBriefMd({ ...makeSpec({ specId: 'hello-001' }), decisions: [{ question: 'Port?', answer: '8080' }] }));
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: '  port?  ', blocking: true, relatedAcIds: [] }])];
    script['refine/sm'] = [refineOut(green(SM))];
    await writeSecret(secretsDir, 'DB_URL', 'postgres://x');
    await s.evaluate();
    expect(s.state.questions).toEqual([]);
  });

  it('accept applies the patch and marks stale; a stale find is dropped with a conflict; the file is untouched', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [], [{ file: 'docs/project.md', find: '## Vision', replace: '## V', reason: 'r' }, { file: 'docs/project.md', find: '## Personas', replace: '## People', reason: 'r' }])];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    await s.accept('po-c1-0');
    expect(await readDoc(draft(), 'project.md')).toContain('## V');
    expect(s.state.stale).toBe(true);
    await s.saveDoc('project.md', '# Hello\n\n## Folks\n');
    await expect(s.accept('po-c1-1')).rejects.toBeInstanceOf(ConflictError);
    expect(s.state.patches[1]).toMatchObject({ status: 'dropped' });
    expect(await readDoc(draft(), 'project.md')).toBe('# Hello\n\n## Folks\n');
  });

  it('accepting a patch drops the pending patches it made stale, with a message in Portuguese', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [], [{ file: 'docs/project.md', find: '## Vision', replace: '## Visão', reason: 'r' }])];
    script['refine/sm'] = [refineOut(green(SM), [], [{ file: 'docs/project.md', find: '## Vision', replace: '## Objetivo', reason: 'r' }, { file: 'docs/project.md', find: '## Personas', replace: '## Pessoas', reason: 'r' }])];
    await s.evaluate();
    await s.accept('po-c1-0');
    const byId = Object.fromEntries(s.state.patches.map((x) => [x.patchId, x.status]));
    expect(byId).toEqual({ 'po-c1-0': 'accepted', 'sm-c1-0': 'dropped', 'sm-c1-1': 'pending' });
    expect(s.state.patches.find((x) => x.patchId === 'sm-c1-0')?.decision).toMatch(/outra alteração/);
    await expect(s.accept('sm-c1-0')).rejects.toBeInstanceOf(ConflictError);
  });

  it('fills a stack.md or flow.md that is still the blank template, straight from the SM patch; an edited one is left to the usual patch flow', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM), [], [
      { file: 'docs/stack.md', find: '# Stack', replace: '# Stack\n\n- Runtime: Node 22\n', reason: 'preencher' },
      { file: 'docs/flow.md', find: '# Application flow', replace: '# Fluxo\n\n```mermaid\nflowchart TD\n  A --> B\n```\n', reason: 'preencher' },
    ])];
    await s.evaluate();
    expect(await readDoc(draft(), 'stack.md')).toBe('# Stack\n\n- Runtime: Node 22\n');
    expect(await readDoc(draft(), 'flow.md')).toContain('flowchart TD');
    expect(s.state.patches.filter((x) => x.status === 'pending')).toHaveLength(0);
    expect(s.state.discarded).toHaveLength(0);

    // the next cycle: stack.md is no longer the template, so a patch to it is an ordinary one for the human
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM), [], [{ file: 'docs/stack.md', find: 'Node 22', replace: 'Node 24', reason: 'r' }])];
    await s.evaluate();
    expect(await readDoc(draft(), 'stack.md')).toContain('Node 22');
    expect(s.state.patches.find((x) => x.file === 'stack.md')?.status).toBe('pending');
  });

  it('replays after a restart and turns an open cycle into an interrupted error', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: 'A?', blocking: false, relatedAcIds: [] }])];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    await s.answer('po-c1-0', 'yes');
    await s.close();
    const again = await RefineSession.open(deps());
    expect(again.state.questions[0]).toMatchObject({ status: 'answered', answer: 'yes' });
    await fs.appendFile(again.eventsFile, `${JSON.stringify({ seq: again.events.length + 1, at: new Date().toISOString(), runId: 'hello-app/hello-001', specHash: 'draft', type: 'REFINE_CYCLE_STARTED', kind: 'fact', data: { cycle: 2, draftHash: 'h' } })}\n`);
    await again.close();
    const third = await RefineSession.open(deps());
    expect(third.state).toMatchObject({ status: 'error', error: 'interrupted' });
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    await writeSecret(secretsDir, 'DB_URL', 'postgres://x');
    await third.evaluate();
    expect(third.state.status).toBe('ready');
    await third.close();
  });

  it('a start first brings in what main changed: a changed project doc makes the ready session stale and asks for a new evaluation', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [{ ...derived, spec: { ...derived.spec, externalDependencies: [] } }];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    expect(s.state).toMatchObject({ status: 'ready', stale: false });
    await s.syncWithMain(async () => []); // main did not change: the start goes on
    expect(s.state.stale).toBe(false);
    await expect(s.syncWithMain(async () => [{ file: 'project.md', hash: 'h' }])).rejects.toThrow(/Avalie de novo/);
    expect(s.state.stale).toBe(true);
    await expect(s.freeze()).rejects.toBeInstanceOf(ConflictError);
  });

  it('writes custom secret names without marking the spec stale', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    await s.writeSecret('CUSTOM_KEY', 'x');
    expect(await fs.readFile(path.join(secretsDir, 'CUSTOM_KEY'), 'utf8')).toBe('x');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    await s.writeSecret('DB_URL', 'postgres://x');
    expect(await fs.readFile(path.join(secretsDir, 'DB_URL'), 'utf8')).toBe('postgres://x');
    expect(s.state.stale).toBe(false);
    expect((await s.snapshot()).secrets).toEqual([
      { name: 'CUSTOM_KEY', present: true, hint: '****' },
      { name: 'DB_URL', present: true, hint: '****' },
    ]);
  });

  it('writes a secret while an evaluation runs', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    const running = s.evaluate();
    expect(s.busy).toBe(true);
    await s.writeSecret('DB_URL', 'postgres://x');
    await running;
    expect(await fs.readFile(path.join(secretsDir, 'DB_URL'), 'utf8')).toBe('postgres://x');
    expect(s.state.stale).toBe(false);
  });
});

// R11.7.2: a program never runs again what an earlier one delivered, and never starts over work still in flight.
describe('programEntries', () => {
  const item = (key: string, rank: number, dependsOn: string[] = []) => ({ key, title: key, epic: 'e', priority: 'P1', rank, size: 'M', scope: 's', rationale: 'r', dependsOn, sources: [] });
  const backlog = (login: string, cart: string) =>
    ({ epics: [], keyIds: true, items: [item('login', 1), item('cart', 2, ['login'])], specs: { login: { spec: { status: login } }, cart: { spec: { status: cart } } } }) as unknown as BacklogState;

  it('starts an item main has done as done, and every other one pending', () => {
    expect(programEntries('shop', backlog('done', 'planned'), { login: 'done' })).toEqual([
      { specId: 'login', key: 'login', rank: 1, dependsOn: [], done: true },
      { specId: 'cart', key: 'cart', rank: 2, dependsOn: ['login'] },
    ]);
    // Plan 77 review: validated on main after this draft kept it awaiting validation, so it is done now.
    expect(programEntries('shop', backlog('awaiting-validation', 'planned'), { login: 'done' })[0]!.done).toBe(true);
  });

  // Plan 77 review: a run that died leaves running on main; the program runs it again from the same freeze.
  it('runs again an item main still shows running or paused', () => {
    expect(programEntries('shop', backlog('running', 'planned'), { login: 'running' })[0]).toEqual({ specId: 'login', key: 'login', rank: 1, dependsOn: [] });
    expect(programEntries('shop', backlog('paused:quota', 'planned'), { login: 'paused:quota' })[0]!.done).toBeUndefined();
  });

  it('gives each entry the specs the SM conflict map pairs it with, and none without a map', () => {
    const mapped = { ...backlog('planned', 'planned'), items: [item('login', 1), item('cart', 2), item('search', 3)], conflicts: { inputHash: 'h', pairs: [{ a: 'cart', b: 'login', reason: 'both change users' }] } } as unknown as BacklogState;
    expect(programEntries('shop', mapped, {}).map((e) => [e.key, e.conflictsWith])).toEqual([['login', ['cart']], ['cart', ['login']], ['search', []]]);
    expect('conflictsWith' in programEntries('shop', backlog('planned', 'planned'), {})[0]!).toBe(false);
  });

  it('refuses an item awaiting validation, one delivered while this draft refined, and a backlog with nothing left', () => {
    expect(() => programEntries('shop', backlog('awaiting-validation', 'planned'), { login: 'awaiting-validation' })).toThrow(/login aguarda validação/);
    expect(() => programEntries('shop', backlog('planned', 'planned'), { login: 'done' })).toThrow(/avalie de novo/);
    expect(() => programEntries('shop', backlog('done', 'done'), { login: 'done', cart: 'done' })).toThrow(ConflictError);
  });
});
