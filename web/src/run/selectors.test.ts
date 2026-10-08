import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../api.js';
import { blockedSummary, deployOutcome, evidence, explainPhase, explainStop, firstSentence, lastDeployFailure, liveBlocked, pausedUntil, phases, phaseTitle, runState, stopSummary, taskDetail, tokens } from './selectors.js';

// jsdom gives import.meta.url an http: scheme; vitest runs with cwd = web/
const events: StoredEvent[] = readFileSync(path.resolve('../test/fixtures/runs/hello-run.ndjson'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

describe('run selectors', () => {
  it('reduces task state with the orchestrator reducer', () => {
    const s = runState(events);
    expect(s.status).toBe('paused:quota');
    expect(s.order).toEqual(['T1', 'T2']);
    expect(s.tasks.get('T1')).toMatchObject({ state: 'merged', attempts: 1 });
    expect(s.tasks.get('T2')).toMatchObject({ state: 'ready', attempts: 0 });
  });
  it('phases 1 and 2 are done, 3 is running', () => {
    expect(phases(events).map((p) => [p.phase, p.result, p.attempt])).toEqual([
      [1, 'done', 1],
      [2, 'done', 1],
      [3, 'running', 1],
    ]);
  });
  it('paused until comes from the last quota pause', () => {
    expect(pausedUntil(events)).toBe('2026-09-24T10:30:00.000Z');
    expect(pausedUntil([...events, { ...events[0]!, seq: 999, type: 'RUN_RESUMED', data: {} }])).toBeNull();
  });
  it('task detail groups steps, gates and review by attempt and finds the PR', () => {
    const d = taskDetail(events, 'T1');
    expect(d.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(d.attempts[0]!.steps.map((s) => [s.stepId, s.kind, s.ok, s.tier])).toEqual([['s00003', 'dev', true, 'small']]);
    expect(d.attempts[0]!.gates.map((g) => [g.gate, g.passed])).toEqual([
      ['unit-test', true],
      ['lint', false],
    ]);
    expect(d.attempts[1]!.review).toEqual({ profile: 'standard', risk: 'low', drift: 'none', findings: [] });
    expect(d.pr).toEqual({ number: 3, url: 'https://github.com/o/r/pull/3' });
    expect(d.merged).toBe(true);
    expect(d.blockedReason).toBeNull();
    expect(taskDetail(events, 'T2').attempts).toEqual([]);
  });
  it('task detail carries the security findings of the attempt', () => {
    const sec = { file: 'src/a.ts', line: 3, severity: 'medium', category: 'cors', problem: 'open cors', fix: 'restrict origins' };
    const withSec = [...events, { ...events[0]!, seq: 9000, type: 'SECURITY_APPROVED', data: { taskId: 'T1', findings: [sec] } } as StoredEvent];
    const attempts = taskDetail(withSec, 'T1').attempts;
    expect(attempts.at(-1)!.security).toEqual({ findings: [sec] });
    expect(taskDetail(events, 'T1').attempts[0]!.security).toBeNull();
  });
  it('tokens by phase, by role, with system1 from decisions', () => {
    const t = tokens(events);
    expect(t.byRole.dev).toMatchObject({ inputTokens: 4100, outputTokens: 900, costUsd: 0.6, steps: 2 });
    expect(t.byRole.system1).toMatchObject({ inputTokens: 50, outputTokens: 5, steps: 1 });
    expect(t.byPhase.phase3.steps).toBe(3);
    expect(t.byPhase.decide.steps).toBe(1);
    expect(t.byPhase.phase.steps).toBe(2);
    expect(t.total.costUsd).toBeCloseTo(1.00001, 5);
  });
  it('evidence takes the latest gate round per task', () => {
    expect(evidence(events, ['AC-001', 'AC-002'])).toEqual([
      { acId: 'AC-001', tests: [{ id: 'sum::[AC-001] adds', status: 'passed', taskId: 'T1' }] },
      { acId: 'AC-002', tests: [] },
    ]);
  });
});

it('phases 4-6 end on their own events', () => {
  const evs = (list: Array<[string, Record<string, unknown>]>) => list.map(([type, data], i) => ({ seq: i + 1, at: '2026-09-24T10:00:00.000Z', runId: 'r', specHash: 'h', type, kind: 'fact' as const, data }));
  const out = phases(evs([['PHASE_STARTED', { phase: 4, round: 1 }], ['VERIFICATION_FAILED', { round: 1 }], ['PHASE_STARTED', { phase: 4, round: 2 }], ['VERIFICATION_PASSED', { round: 2 }], ['PHASE_STARTED', { phase: 5 }], ['DEPLOY_FAILED', { attempt: 1, stage: 'apply' }], ['DEPLOY_VERIFIED', { attempt: 2, url: 'http://x' }], ['PHASE_STARTED', { phase: 6 }], ['REPORT_READY', {}]]));
  expect(out.map((p) => [p.phase, p.result, p.attempt])).toEqual([[4, 'done', 2], [5, 'done', 1], [6, 'done', 1]]);
  expect(deployOutcome(evs([['DEPLOY_FAILED', { attempt: 1, stage: 'apply', detail: 'busy' }], ['DEPLOY_VERIFIED', { attempt: 2, url: 'http://x' }]]))).toEqual({ attempts: 2, verified: { url: 'http://x' }, lastFailure: null });
});

describe('stopped run explanations', () => {
  const evs = (list: Array<[string, Record<string, unknown>]>) => list.map(([type, data], i) => ({ seq: i + 1, at: '2026-09-24T10:00:00.000Z', runId: 'r', specHash: 'h', type, kind: 'fact' as const, data }));

  it('explainStop names the cause and the owner, and returns null for unknown reasons', () => {
    expect(explainStop('Dev reported done but produced no changes against origin/main. Implement the task or return spec-gap.')).toMatchObject({ owner: 'Sistema', title: expect.stringContaining('não alterou') });
    expect(explainStop('plan.commands.smoke missing')).toMatchObject({ owner: 'Plano', hint: expect.stringContaining('commands.smoke') });
    expect(explainStop('Review requested changes:\nuse a constant')).toMatchObject({ owner: 'Sistema' });
    expect(explainStop('spec-gap rounds exhausted (3); last question: which currency?')).toMatchObject({ owner: 'Você' });
    expect(explainStop('something nobody has seen before')).toBeNull();
  });

  it('lastDeployFailure is the latest failure unless a later deploy verified', () => {
    const failed = evs([['DEPLOY_FAILED', { attempt: 1, stage: 'smoke', detail: 'plan.commands.smoke missing', rolledBack: true, rollbackHealthy: true }]]);
    expect(lastDeployFailure(failed)).toMatchObject({ attempt: 1, stage: 'smoke', rolledBack: true, rollbackHealthy: true });
    const recovered = evs([['DEPLOY_FAILED', { attempt: 1, stage: 'apply', detail: 'busy' }], ['DEPLOY_VERIFIED', { attempt: 2, url: 'http://x' }]]);
    expect(lastDeployFailure(recovered)).toBeNull();
  });

  it('stopSummary explains a deploy-failed run with its stage, rollback and owner', () => {
    const failure = { attempt: 1, stage: 'smoke', detail: 'plan.commands.smoke missing', rolledBack: true, rollbackHealthy: true };
    const s = stopSummary({ status: 'deploy-failed', reason: 'deploy failed at smoke: plan.commands.smoke missing', causes: [], deployFailure: failure });
    expect(s).toMatchObject({ owner: 'Plano', action: 'redeploy' });
    expect(s!.what).toContain('smoke');
    expect(s!.rollback).toContain('saudável');
    expect(s!.raw).toContain('plan.commands.smoke missing');
  });

  it('stopSummary covers blocked runs and ignores healthy ones', () => {
    const blocked = stopSummary({ status: 'blocked', reason: null, causes: [{ taskId: 'T2', reason: 'Task token budget exceeded: 9 tokens used, cap 5. Finish with a smaller change set.' }, { taskId: 'T3', reason: 'Task token budget exceeded: 9 tokens used, cap 5. Finish with a smaller change set.' }], deployFailure: null });
    expect(blocked!.what).toContain('2 tarefas');
    expect(blocked!.owner).toBe('Sistema');
    expect(stopSummary({ status: 'awaiting-validation', reason: null, causes: [], deployFailure: null })).toBeNull();
    expect(stopSummary({ status: 'running', reason: null, causes: [], deployFailure: null })).toBeNull();
  });

  it('phase 5 is failed on the first DEPLOY_FAILED with no later verification', () => {
    const out = phases(evs([['PHASE_STARTED', { phase: 5 }], ['DEPLOY_FAILED', { attempt: 1, stage: 'smoke', detail: 'plan.commands.smoke missing' }], ['PHASE_STARTED', { phase: 6 }]]));
    expect(out.find((p) => p.phase === 5)).toMatchObject({ result: 'failed', reason: 'plan.commands.smoke missing' });
  });

  it('stopSummary names the phase a phase-failed run stopped at and explains its reason', () => {
    const reason = 'Phase 6 blocked: (root): Invalid input: expected object, received null; no JSON object in the agent result (subtype=success, terminal=completed, turns=1): ```json\n{"blocked":[{"reason":"The frozen \'security-tools\' gate exits 2"}]}';
    const s = stopSummary({ status: 'phase-failed', reason, causes: [], deployFailure: null, failedPhase: 6 });
    // The quoted agent text names the security gate, but the phase's own prefix wins.
    expect(s).toMatchObject({ what: 'A run parou na fase 6 · Relatório.', title: 'O relatório final não foi gerado', owner: 'Sistema', raw: reason });
    expect(s!.hint).toContain('Reprocesse');
    const unknown = stopSummary({ status: 'failed', reason: 'Something odd happened. More detail here.', causes: [], deployFailure: null, failedPhase: null });
    expect(unknown).toMatchObject({ what: 'A run falhou.', title: 'Something odd happened.' });
    expect(unknown!.hint).toContain('reprocesse');
  });

  it('stopSummary tells a missing delivery apart from failing tests', () => {
    const delivery = stopSummary({ status: 'verification-failed', reason: 'delivery contract not met on main, missing: compose: docker-compose.yml', causes: [], deployFailure: null });
    expect(delivery!.title).toBe('Faltam arquivos de entrega na main');
    const tests = stopSummary({ status: 'verification-failed', reason: 'verification failed in round 2: 2 failing tests, 0 uncovered criteria', causes: [], deployFailure: null });
    expect(tests!.title).toBe('Os testes de aceitação não passaram');
  });

  it('explains the security-tools gate failure an agent described, and the phases the orchestrator names', () => {
    expect(explainStop("The frozen 'security-tools' gate (`sh .tools/install.sh`, plan.json) exits 2 at its last step")).toMatchObject({ owner: 'Sistema', title: expect.stringContaining('ferramentas de segurança') });
    expect(explainStop('The security-tools gate fails while it installs gitleaks, before it scans any code.')).toMatchObject({ title: expect.stringContaining('ferramentas de segurança') });
    expect(explainStop('Phase 1 exhausted 3 attempts; uncovered: AC-002')).toMatchObject({ owner: 'Você' });
    expect(explainStop('gh repo view failed: HTTP 401')).toMatchObject({ owner: 'Você' });
    expect(explainPhase({ phase: 5, reason: 'container exited 137' })).toMatchObject({ title: 'container exited 137', hint: expect.stringContaining('deploy') });
    expect(explainPhase({ phase: 2, reason: null }).title).toBe('2 · Plano falhou');
  });

  it('blockedSummary ties a failure to the tasks that blocked on their own', () => {
    const cascade = (id: string) => ({ taskId: id, reason: 'a dependency is blocked' });
    expect(blockedSummary([{ taskId: 'T0-scaffold', reason: 'gate fails' }, cascade('T1'), cascade('T2')])).toMatch(/^T0-scaffold ficou bloqueada e travou outras 2 tarefas\. /);
    expect(blockedSummary([{ taskId: 'T1', reason: 'x' }, { taskId: 'T2', reason: 'y' }, cascade('T3')])).toMatch(/^2 tarefas ficaram bloqueadas e travaram outra tarefa\. /);
    expect(blockedSummary([cascade('T1')])).toBeNull();
    expect(blockedSummary([])).toBeNull();
  });

  it('liveBlocked reads each blocked task\'s own reason mid-run, with no RUN_FINISHED yet', () => {
    const evs = (list: Array<[string, Record<string, unknown>]>) => list.map(([type, data], i) => ({ seq: i + 1, at: '2026-10-08T10:00:00.000Z', runId: 'r', specHash: 'h', type, kind: 'fact' as const, data }));
    const running = evs([
      ['TASK_BLOCKED', { taskId: 'T6', reason: 'Scope violation:\nfrozen files modified: plan.json' }],
      ['TASK_BLOCKED', { taskId: 'T7', reason: 'a dependency is blocked' }],
    ]);
    expect(liveBlocked(running, ['T6', 'T7'])).toEqual([
      { taskId: 'T6', reason: 'Scope violation:\nfrozen files modified: plan.json' },
      { taskId: 'T7', reason: 'a dependency is blocked' },
    ]);
    // a task that never blocked, or one blocked but not in the requested id set, is left out
    expect(liveBlocked(running, ['T6'])).toEqual([{ taskId: 'T6', reason: 'Scope violation:\nfrozen files modified: plan.json' }]);
    expect(liveBlocked(running, ['T9'])).toEqual([]);
    // the latest TASK_BLOCKED for a task wins, in case it blocked, resumed and blocked again on a different cause
    const reblocked = evs([
      ['TASK_BLOCKED', { taskId: 'T6', reason: 'first reason' }],
      ['TASK_BLOCKED', { taskId: 'T6', reason: 'second reason' }],
    ]);
    expect(liveBlocked(reblocked, ['T6'])).toEqual([{ taskId: 'T6', reason: 'second reason' }]);
  });

  it('firstSentence gives a one-line title for a long explanation', () => {
    expect(firstSentence('It failed. Then it stopped.')).toBe('It failed.');
    expect(firstSentence('Runs `.tools/bin/semgrep --version` in plan.json and exits 2. Nobody can fix it.')).toBe('Runs `.tools/bin/semgrep --version` in plan.json and exits 2.');
    expect(firstSentence('no period here\nsecond line')).toBe('no period here');
    expect(firstSentence('x'.repeat(300))).toHaveLength(160);
    expect(firstSentence('x'.repeat(300)).endsWith('…')).toBe(true);
  });
});

describe('phase rows', () => {
  const evs = (list: Array<[string, Record<string, unknown>]>) => list.map(([type, data], i) => ({ seq: i + 1, at: `2026-10-05T10:00:${String(i).padStart(2, '0')}.000Z`, runId: 'r', specHash: 'h', type, kind: 'fact' as const, data }));

  it('a retried phase is one row: the latest attempt wins and the attempts are counted', () => {
    const out = phases(evs([['PHASE_STARTED', { phase: 1 }], ['PHASE_STARTED', { phase: 1 }], ['DOCS_MERGED', { phase: 1 }]]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ phase: 1, attempt: 2, result: 'done', startedAt: '2026-10-05T10:00:01.000Z' });
  });

  it('a phase followed by the start of another one counts as done', () => {
    const out = phases(evs([['PHASE_STARTED', { phase: 3 }], ['PHASE_STARTED', { phase: 4, round: 1 }]]));
    expect(out.map((p) => [p.phase, p.result])).toEqual([
      [3, 'done'],
      [4, 'running'],
    ]);
  });

  it('a run shaped like hello-001-r4 reads 1, 2, 3 done and 4 (second attempt) and 6 failed', () => {
    const out = phases(
      evs([
        ['PHASE_STARTED', { phase: 1 }],
        ['DOCS_MERGED', { phase: 1 }],
        ['PHASE_STARTED', { phase: 2 }],
        ['DOCS_MERGED', { phase: 2 }],
        ['PHASE_STARTED', { phase: 3 }],
        ['PHASE_STARTED', { phase: 4, round: 1 }],
        ['VERIFICATION_FAILED', { round: 1, missingDelivery: ['compose: docker-compose.yml'] }],
        ['PHASE_STARTED', { phase: 4, round: 2 }],
        ['VERIFICATION_FAILED', { round: 2, failedTests: [], uncoveredAcs: [], missingDelivery: ['compose: docker-compose.yml', 'e2eSuite: e2e/hello.e2e.mjs'] }],
        ['PHASE_STARTED', { phase: 6 }],
        ['PHASE_FAILED', { phase: 6, reason: 'Phase 6 blocked: no JSON object in the agent result' }],
        ['RUN_FINISHED', { result: 'phase-failed', reason: 'Phase 6 blocked: no JSON object in the agent result' }],
      ]),
    );
    expect(out.map((p) => [p.phase, p.result, p.attempt])).toEqual([
      [1, 'done', 1],
      [2, 'done', 1],
      [3, 'done', 1],
      [4, 'failed', 2],
      [6, 'failed', 1],
    ]);
    expect(out[3]!.reason).toBe('delivery contract not met on main, missing: compose: docker-compose.yml, e2eSuite: e2e/hello.e2e.mjs');
    expect(out[4]!.reason).toBe('Phase 6 blocked: no JSON object in the agent result');
  });

  it('a later event never turns a failed phase into a success', () => {
    const out = phases(evs([['PHASE_STARTED', { phase: 6 }], ['PHASE_FAILED', { phase: 6, reason: 'docs merge failed at push: denied' }], ['REPORT_READY', { merged: false }], ['RUN_FINISHED', { result: 'phase-failed', reason: 'x' }]]));
    expect(out[0]).toMatchObject({ result: 'failed', reason: 'docs merge failed at push: denied' });
  });

  it('the CI workflows fail without a start of their own and still get a row', () => {
    const out = phases(evs([['PHASE_STARTED', { phase: 2 }], ['DOCS_MERGED', { phase: 2 }], ['PHASE_FAILED', { phase: 7, reason: 'rendered .github/workflows/ci.yml is invalid: no jobs' }]]));
    expect(out.map((p) => [p.phase, p.result])).toEqual([
      [2, 'done'],
      [7, 'failed'],
    ]);
    expect(phaseTitle(7)).toBe('Workflows de CI');
    expect(phaseTitle(4)).toBe('4 · Verificação');
    expect(phaseTitle(9)).toBe('Fase 9');
  });

  it('a run stopped by the user leaves its phase interrupted, not failed', () => {
    const out = phases(evs([['PHASE_STARTED', { phase: 3 }], ['RUN_FINISHED', { result: 'drained', reason: null }]]));
    expect(out[0]).toMatchObject({ result: 'stopped', reason: null });
  });
});
