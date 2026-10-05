import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { runApi, type Report, type RunDetail } from '../api.js';
import { ValidationPage, ValidationView } from './Validation.js';

const report: Report = {
  runId: 'hello-001-r1', specId: 'hello-001', specHash: 'h', result: 'awaiting-validation',
  service: { url: 'http://127.0.0.1:3000', healthcheck: 'HTTP 200 after 1 attempts', smoke: [{ acId: 'AC-001', testId: 's::[AC-001] home', status: 'passed' }] },
  deploy: { attempts: 1, lastFailure: null },
  evidence: [{ criterion: 'AC-001', tasks: ['T1'], tests: ['u::[AC-001] a'], status: 'passed', e2e: 'passed' }, { criterion: 'AC-002', tasks: ['T2'], tests: [], status: 'blocked', e2e: 'not-applicable', e2eReason: 'devops only' }],
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
    expect(screen.getByTestId('e2e-AC-001').textContent).toBe('passed');
    expect(screen.getByTestId('e2e-AC-002').textContent).toContain('not-applicable (devops only)');
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

const COMPLETION = 'hello-001-complete-r1';
const specs = (status: string) => [{ projectId: 'hello-app', specs: [{ specId: 'hello-001', status }] }] as never;
/** Moves the router to another run without leaving the page component, like a link between two runs does. */
function Jump({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button data-testid="jump" onClick={() => navigate(to)}>jump</button>;
}
const page = (path = '/validate/hello-001-r1') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Jump to="/validate/hello-001-r2" />
      <Routes><Route path="/validate/:runId" element={<ValidationPage />} /></Routes>
    </MemoryRouter>,
  );
/** Only the poll interval is faked: Testing Library's waits and the mocked promises keep running on real timers. */
const fakePollTimer = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** Clicks Complete spec, then lets React commit so the poll interval exists before the clock moves. */
const clickComplete = async () => {
  fireEvent.click(await screen.findByTestId('complete-spec'));
  await tick(0);
};

describe('ValidationPage', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends one complete request on a double click', async () => {
    vi.spyOn(runApi, 'run').mockResolvedValue(detail());
    vi.spyOn(runApi, 'projects').mockResolvedValue(specs('awaiting-validation'));
    const complete = vi.spyOn(runApi, 'complete').mockImplementation(() => new Promise((r) => setTimeout(() => r({ runId: COMPLETION }), 20)));
    page();
    const btn = await screen.findByTestId('complete-spec');
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  });

  describe('after Complete spec', () => {
    const completion = (over: Partial<RunDetail>) => detail({ runId: COMPLETION, report: null, phase: 6, ...over });

    it('follows the completion run itself and stops polling with its failure when it ends phase-failed', async () => {
      fakePollTimer();
      const run = vi.spyOn(runApi, 'run').mockImplementation(async (id) => (id === COMPLETION ? completion({ status: 'phase-failed', finished: { result: 'phase-failed', reason: 'the docs PR was refused' } }) : detail()));
      vi.spyOn(runApi, 'projects').mockResolvedValue(specs('awaiting-validation'));
      vi.spyOn(runApi, 'complete').mockResolvedValue({ runId: COMPLETION });
      page();
      await clickComplete();
      await tick(5000);
      const failure = await screen.findByTestId('action-error');
      expect(failure.textContent).toContain(COMPLETION);
      expect(failure.textContent).toContain('phase-failed');
      expect(failure.textContent).toContain('the docs PR was refused');
      // The buttons stay usable: the spec is still awaiting validation, so the user can try again.
      expect((screen.getByTestId('complete-spec') as HTMLButtonElement).disabled).toBe(false);
      const calls = run.mock.calls.length;
      await tick(60_000);
      expect(run.mock.calls.length).toBe(calls);
    });

    it('stops polling when the completion run was interrupted, says so, and leaves the buttons enabled for a retry', async () => {
      fakePollTimer();
      const run = vi.spyOn(runApi, 'run').mockImplementation(async (id) => (id === COMPLETION ? completion({ status: 'interrupted' }) : detail()));
      vi.spyOn(runApi, 'projects').mockResolvedValue(specs('awaiting-validation'));
      const complete = vi.spyOn(runApi, 'complete').mockResolvedValue({ runId: COMPLETION });
      page();
      await clickComplete();
      await tick(5000);
      const notice = await screen.findByTestId('action-error');
      expect(notice.textContent).toContain(`completion run ${COMPLETION} was interrupted`);
      expect(notice.textContent).not.toContain('ended');
      expect((screen.getByTestId('complete-spec') as HTMLButtonElement).disabled).toBe(false);
      const calls = run.mock.calls.length;
      await tick(60_000);
      expect(run.mock.calls.length).toBe(calls);
      // Retry: the click starts a new completion run, which is followed again.
      complete.mockResolvedValue({ runId: 'hello-001-complete-r2' });
      fireEvent.click(screen.getByTestId('complete-spec'));
      await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
      await tick(0);
      await tick(5000);
      expect(run).toHaveBeenCalledWith('hello-001-complete-r2');
    });

    it('keeps following a live completion run, then reloads the spec and stops once it is done', async () => {
      fakePollTimer();
      const now = { completion: 'running', spec: 'awaiting-validation' };
      const run = vi.spyOn(runApi, 'run').mockImplementation(async (id) => (id === COMPLETION ? completion({ status: now.completion }) : detail()));
      vi.spyOn(runApi, 'projects').mockImplementation(async () => specs(now.spec));
      vi.spyOn(runApi, 'complete').mockResolvedValue({ runId: COMPLETION });
      page();
      await clickComplete();
      await tick(5000);
      await tick(5000);
      expect(run).toHaveBeenCalledWith(COMPLETION);
      expect(screen.queryByTestId('action-error')).toBeNull();
      expect(screen.getByTestId('complete-spec')).toBeTruthy();
      now.completion = 'done';
      now.spec = 'done';
      await tick(5000);
      await waitFor(() => expect(screen.getByTestId('actions-note').textContent).toContain('already done'));
      const calls = run.mock.calls.length;
      await tick(60_000);
      expect(run.mock.calls.length).toBe(calls);
    });

    it('clears an action error left by a refused click once the reload after the completion succeeds', async () => {
      fakePollTimer();
      const now = { completion: 'running', spec: 'awaiting-validation' };
      vi.spyOn(runApi, 'run').mockImplementation(async (id) => (id === COMPLETION ? completion({ status: now.completion }) : detail()));
      vi.spyOn(runApi, 'projects').mockImplementation(async () => specs(now.spec));
      const complete = vi.spyOn(runApi, 'complete')
        .mockResolvedValueOnce({ runId: COMPLETION })
        .mockRejectedValueOnce(new Error('409 spec hello-001 already has run hello-001-complete-r1 (running)'));
      page();
      await clickComplete();
      expect(complete).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId('complete-spec'));
      expect((await screen.findByTestId('action-error')).textContent).toContain('409');
      now.completion = 'done';
      now.spec = 'done';
      await tick(5000);
      await waitFor(() => expect(screen.queryByTestId('action-error')).toBeNull());
      expect(screen.getByTestId('actions-note').textContent).toContain('already done');
    });

    it('retries the reload on the next tick when it fails after the completion run is done', async () => {
      fakePollTimer();
      let reloads = 0;
      vi.spyOn(runApi, 'run').mockImplementation(async (id) => (id === COMPLETION ? completion({ status: 'done' }) : detail()));
      vi.spyOn(runApi, 'projects').mockImplementation(async () => {
        reloads += 1;
        if (reloads === 2) throw new Error('network down');
        return specs(reloads === 1 ? 'awaiting-validation' : 'done');
      });
      vi.spyOn(runApi, 'complete').mockResolvedValue({ runId: COMPLETION });
      page();
      await clickComplete();
      await tick(5000);
      expect(screen.queryByTestId('actions-note')?.textContent ?? '').not.toContain('already done');
      await tick(5000);
      await waitFor(() => expect(screen.getByTestId('actions-note').textContent).toContain('already done'));
    });
  });

  describe('when the run in the address changes', () => {
    it('drops the previous load error', async () => {
      vi.spyOn(runApi, 'projects').mockResolvedValue(specs('awaiting-validation'));
      vi.spyOn(runApi, 'run').mockImplementation(async (id) => {
        if (id === 'broken') throw new Error('run broken is gone');
        return detail({ runId: id });
      });
      page('/validate/broken');
      expect(await screen.findByText('run broken is gone')).toBeTruthy();
      fireEvent.click(screen.getByTestId('jump'));
      expect(await screen.findByText('hello-001-r2')).toBeTruthy();
      expect(screen.queryByText('run broken is gone')).toBeNull();
    });

    it('shows loading instead of the previous run while the next one loads', async () => {
      vi.spyOn(runApi, 'projects').mockResolvedValue(specs('awaiting-validation'));
      vi.spyOn(runApi, 'run').mockImplementation((id) => (id === 'hello-001-r2' ? new Promise<RunDetail>(() => undefined) : Promise.resolve(detail({ runId: id }))));
      page();
      expect(await screen.findByText('hello-001-r1')).toBeTruthy();
      fireEvent.click(screen.getByTestId('jump'));
      expect(await screen.findByText(/loading/i)).toBeTruthy();
      expect(screen.queryByText('hello-001-r1')).toBeNull();
    });

    it('ignores a late answer for the run it left', async () => {
      let late!: (d: RunDetail) => void;
      vi.spyOn(runApi, 'projects').mockResolvedValue(specs('awaiting-validation'));
      vi.spyOn(runApi, 'run').mockImplementation((id) => (id === 'slow' ? new Promise<RunDetail>((r) => { late = r; }) : Promise.resolve(detail({ runId: id }))));
      page('/validate/slow');
      fireEvent.click(screen.getByTestId('jump'));
      expect(await screen.findByText('hello-001-r2')).toBeTruthy();
      await act(async () => { late(detail({ runId: 'slow' })); });
      expect(screen.queryByText('slow')).toBeNull();
      expect(screen.getByText('hello-001-r2')).toBeTruthy();
    });
  });
});
