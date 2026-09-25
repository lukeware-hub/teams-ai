import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSecret } from '../../server/core/secrets.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, readDoc } from '../../server/refine/draft.js';
import { ConflictError, RefineSession } from '../../server/refine/session.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { calls, makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';

let root = '';
let ws: Workspace;
let secretsDir = '';
let script: Script;

const derived = { project: makeProject(), spec: { ...makeSpec(), status: 'refining', specHash: null, externalDependencies: [{ name: 'db', purpose: 'p', secretNames: ['DB_URL'] }] } };
const green = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'];
const SM = ['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'];
const refineOut = (checklist: unknown[], questions: unknown[] = [], docPatch: unknown[] = []) => ({ checklist, questions, docPatch });
const draft = () => draftPaths(ws, 'hello-001');
const deps = () => ({ ws, draft: draft(), runAgent: makeFakeRunAgent(script), secretsDir, retrieval: () => [] });

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'))).replace(/\\/g, '/');
  secretsDir = `${root}/secrets`;
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  script = {};
  calls.length = 0;
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('RefineSession', () => {
  it('evaluates: derive, PO and SM, questions merged blocking-first, patches proposed or discarded, secrets item computed', async () => {
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
    expect(st.checklist.find((i) => i.id === 'sm.dependencies-and-secrets')).toMatchObject({ passed: false });
    expect(st.checklist.find((i) => i.id === 'sm.no-open-questions')).toMatchObject({ passed: false });
    expect(calls.map((c) => c.kind)).toEqual(['derive', 'refine', 'refine']);
    expect((await s.snapshot()).tokens.steps).toBe(3);
  });

  it('does not retry a blocked Jev cycle until a document changes', async () => {
    let validations = 0;
    const s = await RefineSession.create({
      ...deps(),
      validateDocs: async () => validations++ === 0
        ? { available: true, decision: 'blocked' as const, consistent: false, confidence: 0.2, model: 'jev', checks: { flow_covers_scope: 0.2 }, stateTruncated: false }
        : { available: true, decision: 'approved' as const, consistent: true, confidence: 0.95, model: 'jev', checks: { flow_covers_scope: 0.95 }, stateTruncated: false },
    }, 'new-project');
    await s.evaluate();
    await expect(s.evaluate()).rejects.toThrow('Edite project.md');
    expect(calls).toHaveLength(0);
    await s.saveDoc('flow.md', '# corrected flow\n');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    expect(s.state.cycle).toBe(2);
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

  it('writeSecret only accepts names the derived spec lists and marks the checklist stale', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    await expect(s.writeSecret('DB_URL', 'x')).rejects.toThrow(/not listed/);
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    await s.writeSecret('DB_URL', 'postgres://x');
    expect(await fs.readFile(path.join(secretsDir, 'DB_URL'), 'utf8')).toBe('postgres://x');
    expect(s.state.stale).toBe(true);
    expect((await s.snapshot()).secrets).toEqual([{ name: 'DB_URL', present: true, hint: '://x' }]);
  });
});
