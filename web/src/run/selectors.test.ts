import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../api.js';
import { blockedSummary, citedVariables, currentActivity, deployOutcome, evidence, explainPhase, explainStop, finishedEvent, firstSentence, groupCauses, lastDeployFailure, liveBlocked, mergedPrs, pausedUntil, phaseActivity, phases, phaseTitle, runState, stopSummary, taskDetail, tokens } from './selectors.js';

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
  it('tokens count each agent by the model and effort its steps ran on, and say when the effort was not recorded', () => {
    const step = (seq: number, stepId: string, model: string, effort?: string) => [
      { ...events[0]!, seq, type: 'STEP_STARTED', data: { stepId, kind: 'dev', role: 'dev', model, ...(effort ? { effort } : {}), attempt: 1 } } as StoredEvent,
      { ...events[0]!, seq: seq + 1, type: 'STEP_FINISHED', data: { stepId, kind: 'dev', attempt: 1, ok: true, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.1, model, ...(effort ? { effort } : {}) } } as StoredEvent,
    ];
    const t = tokens([...step(9001, 'sx1', 'claude-sonnet-5-5', 'medium'), ...step(9003, 'sx2', 'claude-sonnet-5-5', 'medium'), ...step(9005, 'sx3', 'claude-opus-5-5')]);
    expect(t.modelsByRole.dev).toEqual([
      { model: 'claude-sonnet-5-5', effort: 'medium', steps: 2 },
      { model: 'claude-opus-5-5', effort: null, steps: 1 },
    ]);
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

  it('explains a missing credential naming the variables the failure cites, but never the ones the platform provides', () => {
    const detail = 'e2e gate (exit 1)\nprivacy_test.go:123: SERVICE_URL_IDENTITY_SERVICE e PLATFORM_ADMIN_TOKEN não foram definidos; AC_054 TEAMS_AI_IMAGE';
    expect(citedVariables(detail)).toEqual(['PLATFORM_ADMIN_TOKEN']);
    const why = explainStop(detail)!;
    expect(why).toMatchObject({ owner: 'Você', title: 'Falta uma credencial ou variável de ambiente' });
    expect(why.hint).toContain('PLATFORM_ADMIN_TOKEN');
    expect(why.hint).toContain('environment.generatedSecrets');
    expect(explainStop('docker compose config failed: required variable POSTGRES_PASSWORD is missing a value')!.hint).toContain('POSTGRES_PASSWORD');
  });

  it('explains an unhealthy container, an unreachable service and a spec waiting for another one', () => {
    expect(explainStop('docker compose up failed: dependency failed to start: container x-postgres-1 is unhealthy')).toMatchObject({ owner: 'Sistema', title: 'Um container do deploy não ficou saudável' });
    expect(explainStop('dial tcp: lookup audit-service on 127.0.0.11:53: no such host')).toMatchObject({ title: 'Um serviço de outra spec não está acessível' });
    expect(explainStop('depends on privacy-engine, which failed')).toMatchObject({ owner: 'Você', title: 'Aguarda a spec privacy-engine', hint: expect.stringContaining('Tentar de novo') });
  });

  it('explainStop names the cause and the owner, and returns null for unknown reasons', () => {
    expect(explainStop('Dev reported done but produced no changes against origin/main. Implement the task or return spec-gap.')).toMatchObject({ owner: 'Sistema', title: expect.stringContaining('não alterou') });
    expect(explainStop('plan.commands.smoke missing')).toMatchObject({ owner: 'Plano', hint: expect.stringContaining('commands.smoke') });
    expect(explainStop('Review requested changes:\nuse a constant')).toMatchObject({ owner: 'Sistema' });
    // A round 2 failure that comes only from criteria left without evidence is no failing test.
    expect(explainStop('verification failed in round 2: 0 failing tests, 1 uncovered criteria')?.title).toBe('Critérios de aceitação ficaram sem evidência');
    expect(explainStop('verification failed in round 2: 2 failing tests, 0 uncovered criteria')?.title).toBe('Os testes de aceitação não passaram');
    // Every criterion passed and a gate such as lint failed: no criterion lacks evidence.
    expect(explainStop('verification failed in round 2: 0 failing tests, 0 uncovered criteria; gate lint failed')?.title).toBe('Uma verificação obrigatória falhou');
    expect(explainStop('spec-gap rounds exhausted (3); last question: which currency?')).toMatchObject({ owner: 'Você' });
    expect(explainStop('gen/** está em frozenPaths, e a verificação de escopo recusou esses arquivos')).toMatchObject({ owner: 'Plano', title: expect.stringContaining('protege') });
    expect(explainStop('something nobody has seen before')).toBeNull();
    // A service's workflows failing to land explain themselves like the project's.
    expect(explainStop('service inventory: docs merge failed: blocked')).toEqual(explainStop('docs merge failed: blocked'));
    // A repository without a GitHub remote gets its own explanation, not the permissions hint of a rejected merge.
    expect(explainStop('docs merge failed at rebase: gh pr list --head docs/greet-go failed (1): none of the git remotes configured for this repository point to a known GitHub host.')).toMatchObject({ title: 'O repositório não tem um remote do GitHub', owner: 'Você' });
    expect(explainStop('service inventory: rendered .github/workflows/ci.yml is invalid: x')).toEqual(explainStop('rendered .github/workflows/ci.yml is invalid: x'));
  });

  it('lastDeployFailure is the latest failure unless a later deploy verified', () => {
    const failed = evs([['DEPLOY_FAILED', { attempt: 1, stage: 'smoke', detail: 'plan.commands.smoke missing', rolledBack: true, rollbackHealthy: true }]]);
    expect(lastDeployFailure(failed)).toMatchObject({ attempt: 1, stage: 'smoke', rolledBack: true, rollbackHealthy: true });
    const recovered = evs([['DEPLOY_FAILED', { attempt: 1, stage: 'apply', detail: 'busy' }], ['DEPLOY_VERIFIED', { attempt: 2, url: 'http://x' }]]);
    expect(lastDeployFailure(recovered)).toBeNull();
  });

  it('a services deploy failure names its service in the outcome', () => {
    const failed = evs([['DEPLOY_FAILED', { attempt: 3, stage: 'smoke', detail: 'AC-001 failed', service: 'inventory', rolledBack: false, rollbackHealthy: null }]]);
    const f = lastDeployFailure(failed)!;
    expect(f.service).toBe('inventory');
    expect(stopSummary({ status: 'deploy-failed', reason: null, causes: [], deployFailure: f })!.what).toBe('O deploy falhou no estágio smoke do serviço inventory (tentativa 3).');
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

  it('stopSummary names a block it cannot classify by the first sentence of its reason', () => {
    const s = stopSummary({ status: 'blocked', reason: null, causes: [{ taskId: 'T1', reason: 'Go 1.27.2 is not in the gate image. Use another version.' }], deployFailure: null });
    expect(s!.title).toBe('Go 1.27.2 is not in the gate image.');
  });

  it('stopSummary asks no reprocess when the owner lets the agents decide', () => {
    expect(stopSummary({ status: 'phase-failed', reason: 'Phase 1 exhausted', causes: [], deployFailure: null, failedPhase: 1 })!.hint).toContain('reprocesse');
    expect(stopSummary({ status: 'phase-failed', reason: 'Phase 1 exhausted', causes: [], deployFailure: null, failedPhase: 1, autonomous: true })!.hint).toBe('Os agentes já tentaram resolver sozinhos. Veja o detalhe técnico.');
    expect(blockedSummary([{ taskId: 'T2', reason: 'x' }], true)).toBe('T2 ficou bloqueada. Os agentes já tentaram resolver sozinhos.');
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
    expect(firstSentence('x'.repeat(300))).toHaveLength(100);
    expect(firstSentence('x'.repeat(300)).endsWith('…')).toBe(true);
    expect(firstSentence('palavra '.repeat(30))).toMatch(/palavra…$/);
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

  const failedVerification: Array<[string, Record<string, unknown>]> =[['PHASE_STARTED', { phase: 3 }], ['PHASE_STARTED', { phase: 4, round: 1 }], ['VERIFICATION_FAILED', { round: 2 }], ['PHASE_STARTED', { phase: 6 }], ['REPORT_READY', {}], ['RUN_FINISHED', { result: 'verification-failed', reason: 'x' }]];

  it('a retry puts the implementation back to running and forgets the later phases until they start again', () => {
    const out = phases(evs([...failedVerification, ['RUN_REOPENED', { manual: true }]]));
    expect(out.map((p) => [p.phase, p.result])).toEqual([[3, 'running']]);
  });

  it('a retried run reads its phases from the retry onward', () => {
    const out = phases(evs([...failedVerification, ['RUN_REOPENED', { manual: true }], ['PHASE_STARTED', { phase: 4, round: 1 }]]));
    expect(out.map((p) => [p.phase, p.result])).toEqual([[3, 'done'], [4, 'running']]);
  });

  it('a RUN_FINISHED before the last RUN_REOPENED no longer ends the run', () => {
    expect(finishedEvent(evs([...failedVerification, ['RUN_REOPENED', { manual: true }]]))).toBeUndefined();
    const again = evs([...failedVerification, ['RUN_REOPENED', { manual: true }], ['RUN_FINISHED', { result: 'complete', reason: null }]]);
    expect(finishedEvent(again)?.data.result).toBe('complete');
  });
});

describe('phase activity', () => {
  type Ev = [type: string, data: Record<string, unknown>, kind?: 'fact' | 'intent' | 'confirm', intentId?: string];
  const evs = (list: Ev[]): StoredEvent[] => list.map(([type, data, kind = 'fact', intentId], i) => ({ seq: i + 1, at: `2026-10-05T10:00:${String(i).padStart(2, '0')}.000Z`, runId: 'r', specHash: 'h', type, kind, ...(intentId ? { intentId } : {}), data }));

  it('phase 0 reads as plain sentences in order', () => {
    const out = phaseActivity(
      evs([
        ['PHASE_STARTED', { phase: 0 }],
        ['WORKTREE_CREATE', { worktree: '/w', branch: 'docs/s-v1' }, 'intent', 'WORKTREE_CREATE:docs-docs/s-v1'],
        ['DOCS_COMMIT', { branch: 'docs/s-v1', message: 'docs(s): spec v1' }, 'intent', 'DOCS_COMMIT:s-0'],
        ['DOCS_COMMIT', { sha: 'abcdef123456', files: ['docs/a.md', 'docs/b.md'] }, 'confirm', 'DOCS_COMMIT:s-0'],
        ['PR_CREATED', { branch: 'docs/s-v1', number: 12, url: 'https://github.com/o/p/pull/12', created: true }],
        ['DOCS_MERGED', { phase: 0, pr: 12, branch: 'docs/s-v1' }],
      ]),
    ).get(0)!;
    expect(out.items.map((i) => i.text)).toEqual([
      'Branch docs/s-v1 preparada a partir da main',
      'Commit abcdef1 na branch docs/s-v1: docs(s): spec v1 (2 arquivos)',
      'Pull request #12 aberto para a branch docs/s-v1',
      'Documentação mesclada na main pelo pull request #12',
    ]);
    expect(out.items[2]!.url).toBe('https://github.com/o/p/pull/12');
    expect(out.steps).toEqual([]);
  });

  it('says what the agents decided to unblock a task: the answer, the gate command and the gate image', () => {
    const out = phaseActivity(
      evs([
        ['PHASE_STARTED', { phase: 3 }],
        ['SPEC_GAP_ANSWERED', { taskId: 'T0', question: 'q', answer: 'Use Go 1.27.3 nesta tarefa.', assumption: 'T0: Go patched' }],
        ['GATE_FIXED', { taskId: 'T0', service: 'web-bff-api', gate: 'coverage', before: 'a', after: 'b', reason: 'sed guloso' }],
        ['GATE_IMAGE_FIXED', { taskId: 'T0', service: 'web-bff-api', before: 'golang:1.27.2-bookworm', after: 'golang:1.27.3-bookworm', reason: 'Go corrigido' }],
      ]),
    ).get(3)!;
    expect(out.items.map((i) => i.text)).toEqual([
      'Tarefa T0: os agentes decidiram: Use Go 1.27.3 nesta tarefa.',
      'Tarefa T0: comando da verificação coverage corrigido (sed guloso)',
      'Tarefa T0: imagem das verificações trocada de golang:1.27.2-bookworm para golang:1.27.3-bookworm (Go corrigido)',
    ]);
  });

  it('a services deploy names the service of each step and lists the services verified or restored', () => {
    const out = phaseActivity(
      evs([
        ['PHASE_STARTED', { phase: 5 }],
        ['DEPLOY_APPLIED', { attempt: 1, service: 'orders', previous: null, tag: 't' }],
        ['DEPLOY_FAILED', { attempt: 1, stage: 'e2e', detail: 'AC-002 failed.', service: 'inventory', rolledBack: true, rollbackHealthy: null }],
        ['ROLLBACK_DONE', { attempt: 1, services: ['orders'] }],
        ['DEPLOY_VERIFIED', { attempt: 2, url: 'http://dind:20001', smoke: [], services: [{ service: 'orders', url: 'http://dind:20001' }, { service: 'inventory', url: 'http://dind:20002' }] }],
      ]),
    ).get(5)!;
    expect(out.items.map((i) => i.text)).toEqual([
      'Deploy aplicado em orders (tentativa 1)',
      'Deploy falhou em inventory na etapa e2e (tentativa 1): AC-002 failed.',
      'Versão anterior restaurada: orders',
      'Deploy verificado: orders, inventory',
    ]);
    expect(out.items.at(-1)!.url).toBeNull();
  });

  it('a task merged with nothing to merge names no pull request', () => {
    const out = phaseActivity(evs([['PHASE_STARTED', { phase: 3 }], ['PR_MERGED', { taskId: 'T1', pr: 0 }], ['PR_MERGED', { taskId: 'T2', pr: 7 }]])).get(3)!;
    expect(out.items.map((i) => i.text)).toEqual(['Tarefa T1 mesclada na main', 'Tarefa T2 mesclada na main (pull request #7)']);
  });

  it('a task moved onto the current main says whether conflicts are left to resolve', () => {
    const out = phaseActivity(
      evs([
        ['PHASE_STARTED', { phase: 3 }],
        ['REBASE_REPLAYED', { taskId: 'T2', previous: 'abc', files: ['src/a.ts', 'src/b.ts'] }],
        ['REBASE_REPLAYED', { taskId: 'T3', previous: 'def', files: [] }],
      ]),
    ).get(3)!;
    expect(out.items.map((i) => [i.text, i.tone])).toEqual([
      ['Tarefa T2 movida para a main atual, com conflitos a resolver em src/a.ts, src/b.ts', 'bad'],
      ['Tarefa T3 movida para a main atual, sem conflitos a resolver', ''],
    ]);
  });

  it('a failed step and an uncovered criterion are problems of their phase', () => {
    const out = phaseActivity(
      evs([
        ['PHASE_STARTED', { phase: 1 }],
        ['STEP_STARTED', { stepId: 's1', kind: 'tech-spec', role: 'dev', model: 'm', taskId: null, attempt: 1, phase: 'phase1' }],
        ['STEP_FINISHED', { stepId: 's1', kind: 'tech-spec', taskId: null, attempt: 1, ok: false, failure: 'schema', usage: null, costUsd: null, durationMs: 1000 }],
        ['COVERAGE_CHECKED', { attempt: 1, uncovered: ['AC-001', 'AC-002'] }],
      ]),
    ).get(1)!;
    expect(out.items.filter((i) => i.tone === 'bad').map((i) => i.text)).toEqual(['Etapa escrevendo a especificação técnica falhou (schema)', '2 critérios de aceite sem cobertura na especificação técnica: AC-001, AC-002']);
    expect(out.steps).toMatchObject([{ stepId: 's1', model: 'm', ok: false, failure: 'schema', durationMs: 1000 }]);
  });

  it('a step tagged with its phase wins over its position; an untagged one goes by position; task steps stay out', () => {
    const out = phaseActivity(
      evs([
        ['PHASE_STARTED', { phase: 1 }],
        ['PHASE_STARTED', { phase: 2 }],
        ['STEP_STARTED', { stepId: 'late', kind: 'coverage', role: 'po', taskId: null, attempt: 1, phase: 'phase1' }],
        ['STEP_STARTED', { stepId: 'old', kind: 'plan', role: 'sm', taskId: null, attempt: 1 }],
        ['STEP_STARTED', { stepId: 'task', kind: 'dev', role: 'dev', taskId: 'T1', attempt: 1, phase: 'phase3' }],
      ]),
    );
    expect(out.get(1)!.steps.map((s) => s.stepId)).toEqual(['late']);
    expect(out.get(2)!.steps.map((s) => s.stepId)).toEqual(['old']);
    expect(out.get(3)).toBeUndefined();
  });

  it('current activity is the open steps, then the last thing that happened', () => {
    const list = evs([
      ['PHASE_STARTED', { phase: 1 }],
      ['TECH_SPEC_WRITTEN', { path: 'docs/tech.md', adrs: ['ADR-1'], stack: 'node', attempt: 1 }],
      ['STEP_STARTED', { stepId: 's2', kind: 'coverage', role: 'po', model: 'm', taskId: null, attempt: 1 }],
    ]);
    expect(currentActivity(list)).toMatchObject({ running: [{ stepId: 's2', kind: 'coverage', role: 'po', model: 'm', startedAt: '2026-10-05T10:00:02.000Z' }], last: { text: 'Especificação técnica escrita em docs/tech.md, com 1 ADR' } });
    expect(currentActivity([...list, { ...list[2]!, seq: 9, type: 'STEP_FINISHED', data: { stepId: 's2', ok: true } }]).running).toEqual([]);
  });

  it('lists each task blocked in a phase under that phase, and a later block moves it', () => {
    const out = phaseActivity(
      evs([
        ['PHASE_STARTED', { phase: 3 }],
        ['TASK_BLOCKED', { taskId: 'T1', reason: 'x' }],
        ['TASK_BLOCKED', { taskId: 'T2', reason: 'a dependency is blocked' }],
        ['PHASE_STARTED', { phase: 4 }],
        ['TASK_BLOCKED', { taskId: 'T2', reason: 'y' }],
      ]),
    );
    expect(out.get(3)!.blockedTaskIds).toEqual(['T1']);
    expect(out.get(4)!.blockedTaskIds).toEqual(['T2']);
  });

  it('groups tasks with the same reason into one cause, in order', () => {
    expect(
      groupCauses([
        { taskId: 'T1', reason: 'x' },
        { taskId: 'T2', reason: 'y' },
        { taskId: 'T3', reason: 'x' },
      ]),
    ).toEqual([
      { reason: 'x', taskIds: ['T1', 'T3'] },
      { reason: 'y', taskIds: ['T2'] },
    ]);
  });
});

describe('pull requests of tasks', () => {
  const ev = (seq: number, type: string, data: Record<string, unknown>): StoredEvent => ({ seq, at: '2026-10-12T10:00:00.000Z', runId: 'r', specHash: 'h', type, kind: 'fact', data });
  const list = [
    ev(1, 'PR_CREATED', { branch: 'task/cancelar-pedido-T11', number: 13, url: 'https://github.com/o/r/pull/13', created: true }),
    ev(2, 'PR_CREATED', { branch: 'task/cancelar-pedido-T1', number: 14, url: 'https://github.com/o/r/pull/14', created: true }),
    ev(3, 'PR_MERGED', { taskId: 'T1', pr: 14 }),
  ];

  it('finds the pull request of a run before readable ids, and never joins T1 to T1-fix', () => {
    const old = [ev(1, 'PR_CREATED', { branch: 'task/hello-001/T1', number: 3, url: 'https://github.com/o/r/pull/3', created: true }), ev(2, 'PR_MERGED', { taskId: 'T1', pr: 3 })];
    expect(mergedPrs(old)).toEqual([{ taskId: 'T1', number: 3, url: 'https://github.com/o/r/pull/3' }]);
    const fix = [ev(1, 'PR_CREATED', { branch: 'task/spec-T1-fix', number: 8, url: 'https://github.com/o/r/pull/8', created: true })];
    expect(taskDetail(fix, 'T1').pr).toBeNull();
    expect(taskDetail(fix, 'T1-fix').pr).toEqual({ number: 8, url: 'https://github.com/o/r/pull/8' });
  });

  it('lists no merged pull request for an empty merge, which opened none', () => {
    const empty = [ev(1, 'PR_CREATED', { branch: 'task/spec-T1', number: 5, url: 'https://github.com/o/r/pull/5', created: true }), ev(2, 'PR_MERGED', { taskId: 'T1', pr: 0 })];
    expect(mergedPrs(empty)).toEqual([]);
  });

  it('joins a task to the pull request of its real branch, task/<specId>-<taskId>, and never to a longer id', () => {
    expect(taskDetail(list, 'T1').pr).toEqual({ number: 14, url: 'https://github.com/o/r/pull/14' });
    expect(mergedPrs(list)).toEqual([{ taskId: 'T1', number: 14, url: 'https://github.com/o/r/pull/14' }]);
  });
});
