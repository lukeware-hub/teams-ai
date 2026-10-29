import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { RunDetail, StoredEvent } from '../api.js';
import { RunView } from './Run.js';

// jsdom gives import.meta.url an http: scheme; vitest runs with cwd = web/
const events: StoredEvent[] = readFileSync(path.resolve('../test/fixtures/runs/hello-run.ndjson'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const detail: RunDetail = {
  runId: 'hello-001-r1',
  specId: 'hello-001',
  projectId: 'hello-app',
  status: 'paused:quota',
  phase: 3,
  report: null,
  state: { status: 'paused:quota', order: [], tasks: [] },
  finished: null,
  tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 },
  acceptanceCriteria: [
    { id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: true },
    { id: 'AC-002', given: 'g', when: 'w', then: 't', smoke: false },
  ],
  plan: {
    specId: 'hello-001',
    specHash: 'sha256:' + 'a'.repeat(64),
    stack: 'node',
    adrRefs: [],
    commands: {},
    gateImage: 'node:22',
    junitPath: 'reports/junit.xml',
    gates: [],
    frozenPaths: [],
    tasks: [{ id: 'T1', title: 'Create endpoint', description: 'Implement endpoint', criteriaRefs: ['AC-001'], dependsOn: [], affectedPaths: ['src/**'], owner: 'dev', origin: 'plan' }],
    deploy: { image: 'hello', port: 3000, healthcheckPath: '/health', manifests: [] },
  },
};
const view = (props: Partial<Parameters<typeof RunView>[0]> = {}) => (
  <MemoryRouter>
    <RunView detail={detail} events={events} ended={false} error={null} loadStep={vi.fn(async () => ({ prompt: '# p', output: { ok: true } }))} {...props} />
  </MemoryRouter>
);

describe('RunView', () => {
  it("shows a services plan with each service's stack and each task's service", () => {
    const tasks = [{ ...detail.plan!.tasks[0]!, id: 'T1', service: 'orders' }, { ...detail.plan!.tasks[0]!, id: 'T2', service: 'inventory' }];
    render(view({ detail: { ...detail, plan: { specId: 'hello-001', specHash: detail.plan!.specHash, adrRefs: [], tasks, services: { orders: { stack: 'node' }, inventory: { stack: 'go' } } } } }));
    expect(screen.getByTestId('plan-artifact').textContent).toContain('orders: node · inventory: go');
    expect(screen.getByTestId('plan-task-T2').textContent).toContain('inventory');
    expect(screen.getByTestId('plan-task-T2').querySelector('.tag')!.getAttribute('title')).toBe('Serviço');
  });

  it('renders header, phases, tasks grouped by state, tokens and evidence from the journal', () => {
    render(view());
    expect(screen.getByTestId('status').textContent).toContain('paused:quota');
    expect(screen.getByTestId('paused-until').textContent).toMatch(/até \d{2}:\d{2}/);
    // The fixture ends paused for quota, so the phase the journal still has running reads as paused.
    expect(screen.getAllByTestId('phase').map((p) => p.textContent)).toEqual(['1 · Especificação técnica concluída', '2 · Plano concluída', '3 · Implementação pausada1 problema registrado']);
    expect(screen.getByTestId('group-merged').textContent).toContain('T1');
    expect(screen.getByTestId('group-ready').textContent).toContain('T2');
    expect(screen.getByTestId('tokens-dev').textContent).toContain('4100');
    expect(screen.getByTestId('evidence-AC-001').textContent).toContain('adds');
    expect(screen.getByTestId('evidence-AC-001').querySelector('[title="sum::[AC-001] adds"]')).not.toBeNull();
    expect(screen.getByTestId('evidence-AC-002').textContent).toContain('nenhum teste');
  });
  it('breadcrumb links the project id to its project hub', () => {
    render(view());
    const nav = screen.getByRole('navigation', { name: 'Navegação' });
    expect(screen.getByRole('link', { name: 'hello-app' }).getAttribute('href')).toBe('/projects/hello-app');
    expect(nav.contains(screen.getByRole('link', { name: 'hello-app' }))).toBe(true);
    expect(nav.textContent).toContain('hello-001');
    expect(nav.querySelector('strong')?.textContent).toBe('run-1');
  });
  it('selecting a task shows attempts, gates, review and the PR; a step expands to its artifacts', async () => {
    const loadStep = vi.fn(async () => ({ prompt: '# the prompt', output: { ok: true, value: { summary: 'did T1' } } }));
    render(view({ loadStep }));
    fireEvent.click(screen.getByTestId('task-T1'));
    expect(screen.getByTestId('attempt-1').textContent).toContain('lint');
    expect(screen.getByTestId('attempt-2').textContent).toContain('standard');
    expect(screen.getByTestId('detail-T1').querySelector('a')!.getAttribute('href')).toBe('https://github.com/o/r/pull/3');
    fireEvent.click(screen.getByTestId('step-s00003'));
    await screen.findByText(/# the prompt/);
    expect(loadStep).toHaveBeenCalledWith('s00003');
  });
  it('ignores a duplicate seq and shows the end state', () => {
    const dup = [...events, { ...events[3]! }];
    render(view({ detail: { ...detail, status: 'complete' }, events: dup, ended: true }));
    expect(screen.getByTestId('tokens-sm').textContent).toContain('1800'); // 1000 + 800, the duplicate STEP_FINISHED not double counted
    expect(screen.getByTestId('status').textContent).toContain('concluído');
  });
  it('shows the persisted plan and task traceability', () => {
    render(view());
    expect(screen.getByTestId('plan-artifact').textContent).toContain('node');
    expect(screen.getByTestId('plan-task-T1').textContent).toContain('AC-001');
    expect(screen.getByTestId('plan-task-T1').textContent).toContain('src/**');
  });
  it('tags fix tasks with their origin and links to validation once a report exists', () => {
    const fix = [...events, { seq: 9999, at: '2026-09-24T12:00:00.000Z', runId: 'hello-001-r1', specHash: 'h', type: 'FIX_TASKS_PLANNED', kind: 'fact' as const, data: { tasks: [{ id: 'T900-fix-1', title: 'fix', description: 'd', criteriaRefs: [], dependsOn: [], affectedPaths: ['src'], owner: 'dev', origin: 'fix' }] } }];
    render(view({ events: fix, detail: { ...detail, phase: 6, report: { summary: 's' } as never } }));
    expect(screen.getByTestId('task-T900-fix-1').parentElement!.textContent).toContain('fix');
    expect(screen.getByTestId('validation-link').getAttribute('href')).toBe('/runs/hello-001-r1/validation');
  });
  it('links to the project repository on GitHub, falling back to a merged PR URL', () => {
    const { unmount } = render(view({ detail: { ...detail, repoUrl: 'https://github.com/acme/hello-app' } }));
    expect(screen.getByTestId('github-link').getAttribute('href')).toBe('https://github.com/acme/hello-app');
    unmount();
    const fallback = render(view());
    expect(screen.getByTestId('github-link').getAttribute('href')).toBe('https://github.com/o/r');
    fallback.unmount();
    // A server that knows the repository has no GitHub address: no link to a service's repository instead.
    render(view({ detail: { ...detail, repoUrl: null } }));
    expect(screen.queryByTestId('github-link')).toBeNull();
  });
  it('prints docs/README.md, or explains who writes it when there is none yet', () => {
    const { unmount } = render(view());
    expect(screen.getByTestId('readme-empty').textContent).toContain('sm');
    unmount();
    render(view({ detail: { ...detail, readme: '# Hello App\n\n- GET /hello' } }));
    expect(screen.getByTestId('readme').querySelector('h3')!.textContent).toBe('Hello App');
  });
  it('offers the sm README action, disabled while the writer run is going', () => {
    const onGenerate = vi.fn();
    const { unmount } = render(view({ readmeAction: { onGenerate, busy: false, error: null } }));
    fireEvent.click(screen.getByTestId('readme-generate'));
    expect(onGenerate).toHaveBeenCalledOnce();
    expect(screen.getByTestId('readme-generate').textContent).toBe('Gerar README com o sm');
    unmount();
    render(view({ readmeAction: { onGenerate, busy: true, error: 'x falhou' } }));
    expect((screen.getByTestId('readme-generate') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('readme-error').textContent).toBe('x falhou');
  });

  describe('stopped runs', () => {
    const ev = (seq: number, type: string, data: Record<string, unknown>): StoredEvent => ({ seq: 10_000 + seq, at: '2026-10-04T10:00:00.000Z', runId: 'hello-001-r9', specHash: 'h', type, kind: 'fact' as const, data });
    const deployFailed = [
      ev(1, 'DEPLOY_FAILED', { attempt: 1, stage: 'smoke', detail: 'plan.commands.smoke missing', rolledBack: true, rollbackHealthy: true }),
      ev(2, 'RUN_FINISHED', { result: 'deploy-failed', reason: 'deploy failed at smoke: plan.commands.smoke missing', merged: [], blocked: [], tokens: {} }),
    ];

    it('explains a deploy-failed run: what, why, rollback, owner and next step', () => {
      render(view({ events: deployFailed, ended: true, detail: { ...detail, status: 'deploy-failed' } }));
      expect(screen.getByTestId('status').textContent).toContain('deploy falhou');
      const banner = screen.getByTestId('outcome-banner').textContent!;
      expect(banner).toContain('smoke');
      expect(banner).toContain('O plano não define commands.smoke');
      expect(screen.getByTestId('outcome-rollback').textContent).toContain('saudável');
      expect(screen.getByTestId('outcome-owner').textContent).toBe('Plano');
      expect(screen.getByTestId('outcome-hint').textContent).toContain('commands.smoke');
    });

    it('a run of a concluded spec is read-only: no retry deploy, Reprocessar or Retomar, and the notice says why', () => {
      const actions = { readmeAction: { onGenerate: vi.fn(), busy: false, error: null }, redeployAction: { onRedeploy: vi.fn(), busy: false, error: null }, reprocessAction: { onReprocess: vi.fn(), busy: false, error: null }, resumeAction: { onResume: vi.fn(), busy: false, error: null } };
      const { rerender } = render(view({ events: deployFailed, ended: true, detail: { ...detail, status: 'deploy-failed', locked: true }, ...actions }));
      expect(screen.queryByTestId('redeploy')).toBeNull();
      expect(screen.queryByTestId('reprocess')).toBeNull();
      expect(screen.getByTestId('locked-notice').textContent).toContain('somente leitura');
      expect(screen.getByRole('link', { name: 'nova spec no projeto' }).getAttribute('href')).toBe(`/projects/${detail.projectId}?novaSpec=1`);
      expect(screen.queryByTestId('readme-generate')).toBeNull();
      rerender(view({ events: [], ended: false, detail: { ...detail, status: 'interrupted', locked: true }, ...actions }));
      expect(screen.queryByTestId('resume')).toBeNull();
    });

    it('shows the delivering run as concluded once the server says its spec is, though its journal ended awaiting validation', () => {
      const delivered = [ev(1, 'RUN_FINISHED', { result: 'awaiting-validation', reason: null, merged: [], blocked: [], tokens: {} })];
      const { rerender } = render(view({ events: delivered, ended: true, detail: { ...detail, status: 'awaiting-validation' } }));
      expect(screen.getByTestId('status').textContent).toContain('aguardando validação');
      rerender(view({ events: delivered, ended: true, detail: { ...detail, status: 'done', locked: true } }));
      expect(screen.getByTestId('status').textContent).toContain('concluído');
    });

    it('offers retry deploy only when an action is wired, disabled while it starts', () => {
      const onRedeploy = vi.fn();
      const { rerender } = render(view({ events: deployFailed, ended: true, detail: { ...detail, status: 'deploy-failed' } }));
      expect(screen.queryByTestId('redeploy')).toBeNull();
      rerender(view({ events: deployFailed, ended: true, detail: { ...detail, status: 'deploy-failed' }, redeployAction: { onRedeploy, busy: false, error: null } }));
      fireEvent.click(screen.getByTestId('redeploy'));
      expect(onRedeploy).toHaveBeenCalledTimes(1);
      rerender(view({ events: deployFailed, ended: true, detail: { ...detail, status: 'deploy-failed' }, redeployAction: { onRedeploy, busy: true, error: 'boom' } }));
      expect((screen.getByTestId('redeploy') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('redeploy-error').textContent).toBe('boom');
    });

    it('groups tasks blocked for the same reason into one translated cause, with the reason in a dialog', () => {
      const reason = 'Dev reported done but produced no changes against origin/main. Implement the task or return spec-gap.';
      const blocked = [{ taskId: 'T950-deploy-fix-1-r2', reason }, { taskId: 'T950-deploy-fix-4-r1', reason }];
      render(view({ events: [ev(1, 'RUN_FINISHED', { result: 'blocked', reason: null, merged: [], blocked, tokens: {} })], ended: true, detail: { ...detail, status: 'blocked' } }));
      const groups = screen.getAllByTestId('cause-group');
      expect(groups).toHaveLength(1);
      expect(groups[0]!.textContent).toContain('T950-deploy-fix-1-r2');
      expect(groups[0]!.textContent).toContain('T950-deploy-fix-4-r1');
      expect(groups[0]!.textContent).toContain('não alterou nada');
      // The row stays one line; the full reason is read in the dialog.
      expect(groups[0]!.textContent).not.toContain(reason);
      const trigger = screen.getByRole('button', { name: 'Ver detalhe do bloqueio de T950-deploy-fix-1-r2, T950-deploy-fix-4-r1' });
      fireEvent.click(trigger);
      const dialog = screen.getByRole('dialog', { name: 'Por que 2 tarefas ficaram bloqueadas' });
      expect(dialog.textContent).toContain(reason);
      expect(dialog.textContent).toContain('Sistema');
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fechar' }));
      fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      fireEvent.click(trigger);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('shows a translated scope violation and keeps the raw text apart', () => {
      const reason = 'Scope violation:\nfrozen files modified: package.json';
      render(view({ events: [ev(1, 'RUN_FINISHED', { result: 'blocked', reason: null, merged: [], blocked: [{ taskId: 'T3', reason }], tokens: {} })], ended: true, detail: { ...detail, status: 'blocked' } }));
      fireEvent.click(screen.getByRole('button', { name: 'Ver detalhe do bloqueio de T3' }));
      const dialog = screen.getByRole('dialog', { name: 'Por que T3 ficou bloqueada' });
      expect(dialog.textContent).toContain('arquivos protegidos foram alterados: package.json');
      expect(dialog.querySelector('pre')!.textContent).toBe(reason);
    });

    it('moves the task counters and the bar segments as live events arrive', () => {
      const progress = () => ({
        merged: screen.getByTestId('task-progress').textContent,
        active: screen.queryByTestId('task-active')?.textContent ?? null,
        blocked: screen.queryByTestId('task-blocked')?.textContent ?? null,
        segments: [...document.querySelectorAll('.run-progress-bar span')].map((s) => s.className),
      });
      const planned = (seq: number, id: string) => ev(seq, 'TASK_PLANNED', { task: { id, title: id, description: 'd', criteriaRefs: ['AC-001'], dependsOn: [], affectedPaths: ['src'], owner: 'dev', origin: 'plan' }, replan: false });
      const start = [planned(1, 'T11'), planned(2, 'T12'), planned(3, 'T13'), ev(4, 'TASK_STATE_CHANGED', { taskId: 'T11', to: 'ready' }), ev(5, 'TASK_STATE_CHANGED', { taskId: 'T11', to: 'implementing' })];
      const { rerender } = render(view({ events: start, ended: false, detail: { ...detail, status: 'running' } }));
      expect(progress()).toMatchObject({ merged: '0 de 3 tarefas mescladas', active: '1 em andamento', blocked: null, segments: ['seg-active'] });
      const merged = [...start, ev(6, 'TASK_STATE_CHANGED', { taskId: 'T11', to: 'validating' }), ev(7, 'TASK_STATE_CHANGED', { taskId: 'T11', to: 'reviewing' }), ev(8, 'TASK_STATE_CHANGED', { taskId: 'T11', to: 'rebasing' }), ev(9, 'TASK_STATE_CHANGED', { taskId: 'T11', to: 'merging' }), ev(10, 'TASK_STATE_CHANGED', { taskId: 'T11', to: 'merged' }), ev(11, 'TASK_STATE_CHANGED', { taskId: 'T12', to: 'blocked' })];
      rerender(view({ events: merged, ended: false, detail: { ...detail, status: 'running' } }));
      expect(progress()).toMatchObject({ merged: '1 de 3 tarefas mescladas', active: null, blocked: '1 bloqueada', segments: ['seg-merged', 'seg-blocked'] });
    });

    it("names each task's service in the tasks card", () => {
      const planned = ev(1, 'TASK_PLANNED', { task: { id: 'T1', title: 'T1', description: 'd', criteriaRefs: ['AC-001'], dependsOn: [], affectedPaths: ['src'], owner: 'dev', origin: 'plan', service: 'orders-api' }, replan: false });
      render(view({ events: [planned], ended: false, detail: { ...detail, status: 'running' } }));
      expect(screen.getByTestId('task-T1').closest('li')!.textContent).toContain('orders-api');
    });

    it('shows no banner for a healthy run', () => {
      render(view());
      expect(screen.queryByTestId('outcome-banner')).toBeNull();
    });

    // hello-001-r4: T2 blocked on the security gate, verification failed twice on missing files, then the report agent failed.
    const gateReason = "The frozen 'security-tools' gate (`sh .tools/install.sh`) exits 2 at its last step.";
    const reportReason = 'Phase 6 blocked: (root): Invalid input: expected object, received null; no JSON object in the agent result';
    const phaseFailed: StoredEvent[] = [
      ...events,
      ev(1, 'RUN_RESUMED', {}),
      ev(2, 'TASK_STATE_CHANGED', { taskId: 'T2', to: 'blocked' }),
      ev(3, 'TASK_BLOCKED', { taskId: 'T2', reason: gateReason }),
      ev(4, 'PHASE_STARTED', { phase: 4, round: 1 }),
      ev(5, 'VERIFICATION_FAILED', { round: 1, failedTests: [], uncoveredAcs: [], matrix: [], missingDelivery: ['compose: docker-compose.yml'] }),
      ev(6, 'PHASE_STARTED', { phase: 4, round: 2 }),
      ev(7, 'VERIFICATION_FAILED', { round: 2, failedTests: [], uncoveredAcs: [], matrix: [], missingDelivery: ['compose: docker-compose.yml'] }),
      ev(8, 'PHASE_STARTED', { phase: 6 }),
      ev(9, 'PHASE_FAILED', { phase: 6, reason: reportReason }),
      ev(10, 'RUN_FINISHED', { result: 'phase-failed', reason: reportReason, merged: ['T1'], blocked: [{ taskId: 'T2', reason: gateReason }], tokens: {} }),
    ];
    const failedView = (props: Partial<Parameters<typeof RunView>[0]> = {}) => view({ events: phaseFailed, ended: true, detail: { ...detail, status: 'phase-failed' }, ...props });

    it('lists each phase once, retried and implicitly finished phases included, with no duplicate keys', () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      render(failedView());
      expect(logged.mock.calls.flat().join(' ')).not.toMatch(/same key/);
      logged.mockRestore();
      const rows = screen.getAllByTestId('phase');
      expect(rows.map((r) => r.querySelector('.phase-name')!.textContent)).toEqual(['1 · Especificação técnica', '2 · Plano', '3 · Implementação', '4 · Verificação', '6 · Relatório']);
      expect(rows[2]!.textContent).toContain('com bloqueios');
      expect(rows[3]!.textContent).toContain('falhou');
      expect(rows[3]!.textContent).toContain('2ª tentativa');
      expect(rows[3]!.textContent).toContain('O que fazer:');
      expect(rows[3]!.textContent).toContain('resolva os bloqueios');
    });

    it('opens a failed phase in a dialog with what happened, who resolves it and the raw reason', () => {
      render(failedView());
      const trigger = screen.getByRole('button', { name: 'Ver detalhe da falha em 6 · Relatório' });
      fireEvent.click(trigger);
      const dialog = screen.getByRole('dialog', { name: '6 · Relatório falhou' });
      expect(dialog.textContent).toContain('O relatório final não foi gerado');
      expect(dialog.querySelector('pre')!.textContent).toBe(reportReason);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      fireEvent.click(screen.getByRole('button', { name: 'Ver detalhe da falha em 4 · Verificação' }));
      expect(screen.getByRole('dialog').textContent).toContain('delivery contract not met on main, missing: compose: docker-compose.yml');
      fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('says at the top what stopped the run, why, what came before and what to do', () => {
      render(failedView());
      const banner = screen.getByTestId('outcome-banner');
      expect(banner.querySelector('h2')!.textContent).toBe('A run parou na fase 6 · Relatório.');
      expect(banner.textContent).toContain('O relatório final não foi gerado');
      expect(screen.getByTestId('outcome-before').textContent).toContain('T2 ficou bloqueada');
      expect(screen.getByTestId('outcome-owner').textContent).toBe('Sistema');
      expect(screen.getByTestId('outcome-hint').textContent).toContain('Reprocesse');
      expect(screen.getByTestId('cause-group').textContent).toContain('As ferramentas de segurança não rodam no ambiente do gate');
      fireEvent.click(screen.getByTestId('outcome-detail'));
      expect(screen.getByRole('dialog', { name: 'Detalhe técnico' }).querySelector('pre')!.textContent).toBe(reportReason);
    });

    it('an owner who lets the agents decide gets no Reprocessar, and the banner asks for none', () => {
      render(failedView({ detail: { ...detail, status: 'phase-failed', agentsDecide: true }, reprocessAction: { onReprocess: vi.fn(), busy: false, error: null } }));
      expect(screen.queryByTestId('reprocess')).toBeNull();
      expect(screen.getByTestId('outcome-hint').textContent).not.toContain('reprocesse');
    });

    it('offers Reprocessar only when wired, disabled while the new run starts, with its error inline', () => {
      const onReprocess = vi.fn();
      const { rerender } = render(failedView());
      expect(screen.queryByTestId('reprocess')).toBeNull();
      rerender(failedView({ reprocessAction: { onReprocess, busy: false, error: null } }));
      expect(screen.getByTestId('reprocess').textContent).toBe('Reprocessar');
      fireEvent.click(screen.getByTestId('reprocess'));
      expect(onReprocess).toHaveBeenCalledTimes(1);
      rerender(failedView({ reprocessAction: { onReprocess, busy: true, error: 'Esta spec já tem a run hello-001-r5 (em execução).' } }));
      expect((screen.getByTestId('reprocess') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('reprocess').textContent).toBe('Iniciando nova run…');
      expect(screen.getByTestId('reprocess-error').textContent).toContain('hello-001-r5');
    });

    it('names the usage panel and every metric plainly, with the raw role id kept beside the name', () => {
      render(view());
      expect(screen.getByRole('heading', { name: 'Consumo dos modelos' })).toBeTruthy();
      expect(screen.getByTestId('tokens-dev').textContent).toContain('Desenvolvimento');
      expect(screen.getByTestId('tokens-dev').querySelector('.usage-id')!.textContent).toBe('dev');
      expect(screen.getByTestId('tokens-system1').textContent).toContain('Decisões automáticas');
      for (const label of ['Tarefas mescladas', 'Custo estimado', 'Tokens de entrada', 'Contexto em cache', 'Tokens de saída', 'Etapas', 'Por agente', 'Por fase']) {
        expect(screen.getAllByRole('button', { name: new RegExp(`^${label}: `) }).length).toBeGreaterThan(0);
      }
      expect(screen.getByTestId('task-progress').textContent).toBe('1 de 2 tarefas mescladas');
    });
  });

  describe('blocked mid-run (no RUN_FINISHED yet)', () => {
    const ev = (seq: number, type: string, data: Record<string, unknown>): StoredEvent => ({ seq: 20_000 + seq, at: '2026-10-08T10:00:00.000Z', runId: 'hello-001-r9', specHash: 'h', type, kind: 'fact' as const, data });
    const planned = (seq: number, id: string) => ev(seq, 'TASK_PLANNED', { task: { id, title: id, description: 'd', criteriaRefs: ['AC-001'], dependsOn: [], affectedPaths: ['src'], owner: 'dev', origin: 'plan' }, replan: false });
    const reason = 'Scope violation:\nfrozen files modified: plan.json';
    const stuck = [
      planned(1, 'T6'),
      planned(2, 'T7'),
      ev(3, 'TASK_STATE_CHANGED', { taskId: 'T6', to: 'blocked' }),
      ev(4, 'TASK_BLOCKED', { taskId: 'T6', reason }),
      ev(5, 'TASK_STATE_CHANGED', { taskId: 'T7', to: 'ready' }),
      ev(6, 'TASK_STATE_CHANGED', { taskId: 'T7', to: 'implementing' }),
    ];

    it('shows the cause of a task blocked mid-run, before the run itself ever stops', () => {
      render(view({ events: stuck, ended: false, detail: { ...detail, status: 'running' } }));
      expect(screen.queryByTestId('outcome-banner')).toBeNull();
      const group = screen.getByTestId('cause-group');
      expect(group.textContent).toContain('T6');
      expect(group.textContent).toContain('O Dev mexeu em arquivos fora do escopo da tarefa');
      fireEvent.click(screen.getByRole('button', { name: 'Ver detalhe do bloqueio de T6' }));
      expect(screen.getByRole('dialog').textContent).toContain('arquivos protegidos foram alterados: plan.json');
    });

    it('points at Parar execução while other tasks keep going, and drops the hint once the run actually stops', () => {
      const { rerender } = render(view({ events: stuck, ended: false, detail: { ...detail, status: 'running' }, stopAction: { onStop: vi.fn(), busy: false, error: null } }));
      expect(screen.getByTestId('block-cause-live-hint').textContent).toContain('pare a execução');
      rerender(view({ events: [...stuck, ev(7, 'RUN_FINISHED', { result: 'blocked', reason: null, merged: [], blocked: [{ taskId: 'T6', reason }], tokens: {} })], ended: true, detail: { ...detail, status: 'blocked' }, stopAction: { onStop: vi.fn(), busy: false, error: null } }));
      expect(screen.queryByTestId('block-cause-live-hint')).toBeNull();
    });

    it('offers Parar execução only while the run is actually stoppable, wired to the action', () => {
      const onStop = vi.fn();
      const { rerender } = render(view({ events: stuck, ended: false, detail: { ...detail, status: 'running' } }));
      expect(screen.queryByTestId('stop')).toBeNull();
      rerender(view({ events: stuck, ended: false, detail: { ...detail, status: 'running' }, stopAction: { onStop, busy: false, error: null } }));
      expect(screen.getByTestId('stop').textContent).toBe('Parar execução');
      fireEvent.click(screen.getByTestId('stop'));
      expect(onStop).toHaveBeenCalledTimes(1);
      rerender(view({ events: stuck, ended: false, detail: { ...detail, status: 'running' }, stopAction: { onStop, busy: true, error: null } }));
      expect((screen.getByTestId('stop') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('stop').textContent).toBe('Parando…');
      rerender(view({ events: stuck, ended: false, detail: { ...detail, status: 'running' }, stopAction: { onStop, busy: false, error: 'falhou' } }));
      expect(screen.getByTestId('stop-error').textContent).toBe('falhou');
      // a draining run (the stop already requested) has nothing left to stop
      rerender(view({ events: [...stuck, ev(7, 'RUN_STOP_REQUESTED', {})], ended: false, detail: { ...detail, status: 'draining' }, stopAction: { onStop, busy: false, error: null } }));
      expect(screen.queryByTestId('stop')).toBeNull();
    });
  });

  describe('a dead process the journal alone would still read as running', () => {
    // The process died without writing RUN_FINISHED: events keep arriving via the SSE tail replay, the stream never
    // "ends", and the reducer's own state.status stays whatever it was last ('running') - only the server's pid
    // check (detail.status) knows the run is actually dead.
    const ghost = [...events]; // the hello-run fixture: no RUN_FINISHED, state.status reads 'paused:quota' from its own events

    it('trusts the server over the live journal once it says interrupted, even with events still arriving and the stream not ended', () => {
      render(view({ events: ghost, ended: false, detail: { ...detail, status: 'interrupted' } }));
      expect(screen.getByTestId('status').textContent).toContain('interrompida');
      expect(screen.getByTestId('interrupted-hint')).toBeTruthy();
    });

    it('offers Retomar for an interrupted run, wired to the action', () => {
      const onResume = vi.fn();
      const { rerender } = render(view({ events: ghost, ended: false, detail: { ...detail, status: 'running' }, resumeAction: { onResume, busy: false, error: null } }));
      expect(screen.queryByTestId('resume')).toBeNull();
      rerender(view({ events: ghost, ended: false, detail: { ...detail, status: 'interrupted' }, resumeAction: { onResume, busy: false, error: null } }));
      expect(screen.getByTestId('resume').textContent).toBe('Retomar');
      fireEvent.click(screen.getByTestId('resume'));
      expect(onResume).toHaveBeenCalledTimes(1);
      rerender(view({ events: ghost, ended: false, detail: { ...detail, status: 'interrupted' }, resumeAction: { onResume, busy: true, error: null } }));
      expect((screen.getByTestId('resume') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('resume').textContent).toBe('Retomando…');
      rerender(view({ events: ghost, ended: false, detail: { ...detail, status: 'interrupted' }, resumeAction: { onResume, busy: false, error: 'falhou' } }));
      expect(screen.getByTestId('resume-error').textContent).toBe('falhou');
    });

    it('also offers Retomar once a RUN_PAUSED(auth) event expires the Claude session, but not for a quota pause (that lifts on its own)', () => {
      const ev2 = (seq: number, type: string, data: Record<string, unknown>): StoredEvent => ({ seq: 30_000 + seq, at: '2026-10-08T10:00:00.000Z', runId: 'hello-001-r9', specHash: 'h', type, kind: 'fact' as const, data });
      const onResume = vi.fn();
      const auth = [ev2(1, 'RUN_PAUSED', { reason: 'auth' })];
      const { rerender } = render(view({ events: auth, ended: false, detail: { ...detail, status: 'paused:auth' }, resumeAction: { onResume, busy: false, error: null } }));
      expect(screen.getByTestId('status').textContent).toContain('paused:auth');
      expect(screen.getByTestId('resume')).toBeTruthy();
      const quota = [ev2(1, 'RUN_PAUSED', { reason: 'quota', until: '2026-10-08T12:00:00.000Z' })];
      rerender(view({ events: quota, ended: false, detail: { ...detail, status: 'paused:quota' }, resumeAction: { onResume, busy: false, error: null } }));
      expect(screen.queryByTestId('resume')).toBeNull();
    });
  });
});

describe('RunView phase activity', () => {
  it('clicking a finished phase shows what was done and its agent steps', () => {
    render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Ver o que aconteceu em 1 · Especificação técnica' }));
    const dialog = screen.getByRole('dialog');
    expect(screen.getByTestId('phase-timeline').textContent).toContain('Especificação técnica escrita em docs/specs/hello-001/tech-spec.md');
    expect(screen.getByTestId('phase-timeline').textContent).toContain('Documentação mesclada na main pelo pull request #1');
    expect(dialog.textContent).toContain('Etapas dos agentes');
    expect(screen.getByTestId('step-s00001')).toBeTruthy();
    expect(screen.queryByTestId('phase-problems')).toBeNull();
  });

  it('the paused phase lists the pause as a problem', () => {
    render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Ver o que aconteceu em 3 · Implementação' }));
    expect(screen.getByTestId('phase-problems').textContent).toContain('Execução pausada pelo limite de uso dos modelos');
  });

  it('the Agora card shows the agent at work, or the last thing that happened', () => {
    const { unmount } = render(view({ detail: { ...detail, status: 'running' }, events: events.slice(0, 3) }));
    expect(screen.getByTestId('now-step').textContent).toContain('Scrum Master escrevendo a especificação técnica');
    unmount();
    render(view());
    expect(screen.getByTestId('now').textContent).toContain('Nenhum agente trabalhando neste momento.');
    expect(screen.getByTestId('now-last').textContent).toContain('Execução pausada pelo limite de uso dos modelos');
  });
});
