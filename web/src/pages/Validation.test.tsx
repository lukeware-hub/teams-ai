import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { runApi, type Report, type RunDetail } from '../api.js';
import { ValidationPage, ValidationView } from './Validation.js';

const report: Report = {
  runId: 'hello-001-r1', specId: 'hello-001', specHash: 'h', result: 'awaiting-validation',
  service: { url: 'http://127.0.0.1:3000', healthcheck: 'HTTP 200 after 1 attempts', smoke: [{ acId: 'AC-001', testId: 's::[AC-001] home', status: 'passed' }] },
  deploy: { attempts: 1, lastFailure: null },
  evidence: [{ criterion: 'AC-001', tasks: ['T1'], tests: ['u::[AC-001] a'], status: 'passed' }, { criterion: 'AC-002', tasks: ['T2'], tests: [], status: 'blocked' }],
  delivered: ['T1'], blocked: [{ taskId: 'T2', reason: 'attempts exhausted' }], assumptions: ['T1: assumed X'],
  exploratoryScript: [{ acId: 'AC-001', steps: ['open /', 'see the list'] }],
  tokens: { byRole: {}, total: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } }, summary: 'All good.',
};
const detail = (over: Partial<RunDetail> = {}): RunDetail => ({ runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app', status: 'awaiting-validation', phase: 6, report, state: { status: 'running', order: [], tasks: [] }, finished: null, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 }, acceptanceCriteria: [], plan: null, ...over });

describe('ValidationView', () => {
  it('lists the security findings and hides the section when there are none', () => {
    const sec = { taskId: 'T1', file: 'src/a.ts', line: 3, severity: 'high' as const, category: 'injection', problem: 'user input reaches a shell', fix: 'use execFile' };
    const withSec = { ...detail(), report: { ...report, securityFindings: [sec] } };
    const { unmount } = render(<MemoryRouter><ValidationView detail={withSec} specStatus="awaiting-validation" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    expect(screen.getByTestId('security-findings').textContent).toContain('[high]');
    expect(screen.getByTestId('security-0').textContent).toContain('src/a.ts:3');
    unmount();
    render(<MemoryRouter><ValidationView detail={detail()} specStatus="awaiting-validation" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByTestId('security-findings')).toBeNull();
  });


  it('shows service, script checkboxes, assumptions, blocked tasks and evidence; actions enabled when awaiting validation', () => {
    const on = { report: vi.fn(), complete: vi.fn() };
    render(<MemoryRouter><ValidationView detail={detail()} specStatus="awaiting-validation" onReport={on.report} onComplete={on.complete} /></MemoryRouter>);
    expect(screen.getByTestId('service-url').getAttribute('href')).toBe('http://127.0.0.1:3000');
    expect(screen.getByTestId('smoke-AC-001').textContent).toContain('passed');
    const step = screen.getByTestId('step-AC-001-0') as HTMLInputElement;
    fireEvent.click(step);
    expect(step.checked).toBe(true);
    expect(screen.getByTestId('assumptions').textContent).toContain('T1: assumed X');
    expect(screen.getByTestId('blocked-T2').textContent).toContain('attempts exhausted');
    expect(screen.getByTestId('evidence-AC-002').className).toContain('blocked');
    fireEvent.change(screen.getByTestId('problem-text'), { target: { value: 'GET / returns 500' } });
    fireEvent.click(screen.getByTestId('report-problem'));
    expect(on.report).toHaveBeenCalledWith('GET / returns 500');
    fireEvent.click(screen.getByTestId('complete-spec'));
    expect(on.complete).toHaveBeenCalled();
  });

  it('deploy-failed shows the failure and disables both actions with a reason', () => {
    const failed: Report = { ...report, result: 'deploy-failed', service: null, deploy: { attempts: 3, lastFailure: { attempt: 3, stage: 'smoke', detail: 'AC-001: no smoke test', rolledBack: true, rollbackHealthy: true } } };
    render(<MemoryRouter><ValidationView detail={detail({ status: 'deploy-failed', report: failed })} specStatus="running" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    expect(screen.getByTestId('deploy-failure').textContent).toContain('smoke');
    expect(screen.getByTestId('deploy-failure').textContent).toContain('rolled back');
    expect((screen.getByTestId('complete-spec') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('report-problem') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('actions-note').textContent).toContain('deploy-failed');
  });

  it('shows an action error next to the buttons without hiding them', () => {
    render(<MemoryRouter><ValidationView detail={detail()} specStatus="awaiting-validation" actionError="409 spec is not awaiting validation" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    expect(screen.getByTestId('action-error').textContent).toContain('409');
    expect((screen.getByTestId('complete-spec') as HTMLButtonElement).disabled).toBe(false);
  });

  it('without a report yet it says so', () => {
    render(<MemoryRouter><ValidationView detail={detail({ report: null, status: 'running', phase: 3 })} specStatus="running" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText(/no report yet/i)).toBeTruthy();
  });
});

describe('ValidationPage', () => {
  it('sends one complete request on a double click', async () => {
    vi.spyOn(runApi, 'run').mockResolvedValue(detail());
    vi.spyOn(runApi, 'projects').mockResolvedValue([{ projectId: 'hello-app', specs: [{ specId: 'hello-001', status: 'awaiting-validation' }] }] as never);
    const complete = vi.spyOn(runApi, 'complete').mockImplementation(() => new Promise((r) => setTimeout(() => r(undefined as never), 20)));
    render(<MemoryRouter initialEntries={['/validate/hello-001-r1']}><Routes><Route path="/validate/:runId" element={<ValidationPage />} /></Routes></MemoryRouter>);
    const btn = await screen.findByTestId('complete-spec');
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  });
});
