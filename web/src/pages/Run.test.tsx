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
  it('renders header, phases, tasks grouped by state, tokens and evidence from the journal', () => {
    render(view());
    expect(screen.getByTestId('status').textContent).toContain('paused:quota');
    expect(screen.getByTestId('paused-until').textContent).toMatch(/até \d{2}:\d{2}/);
    expect(screen.getAllByTestId('phase').map((p) => p.textContent)).toEqual(['1 concluído', '2 concluído', '3 em execução']);
    expect(screen.getByTestId('group-merged').textContent).toContain('T1');
    expect(screen.getByTestId('group-ready').textContent).toContain('T2');
    expect(screen.getByTestId('tokens-dev').textContent).toContain('4100');
    expect(screen.getByTestId('evidence-AC-001').textContent).toContain('sum::[AC-001] adds');
    expect(screen.getByTestId('evidence-AC-002').textContent).toContain('nenhum teste');
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
    render(view());
    expect(screen.getByTestId('github-link').getAttribute('href')).toBe('https://github.com/o/r');
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

    it('groups tasks blocked for the same reason into one translated cause', () => {
      const reason = 'Dev reported done but produced no changes against origin/main. Implement the task or return spec-gap.';
      const blocked = [{ taskId: 'T950-deploy-fix-1-r2', reason }, { taskId: 'T950-deploy-fix-4-r1', reason }];
      render(view({ events: [ev(1, 'RUN_FINISHED', { result: 'blocked', reason: null, merged: [], blocked, tokens: {} })], ended: true, detail: { ...detail, status: 'blocked' } }));
      const groups = screen.getAllByTestId('cause-group');
      expect(groups).toHaveLength(1);
      expect(groups[0]!.textContent).toContain('T950-deploy-fix-1-r2');
      expect(groups[0]!.textContent).toContain('T950-deploy-fix-4-r1');
      expect(groups[0]!.textContent).toContain('não alterou nada');
      expect(groups[0]!.textContent).toContain(reason);
    });

    it('shows no banner for a healthy run', () => {
      render(view());
      expect(screen.queryByTestId('outcome-banner')).toBeNull();
    });
  });
});
