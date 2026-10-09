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
    expect(screen.getByTestId('security-findings').textContent).toContain('Gravidade alta');
    expect(screen.getByTestId('security-0').textContent).toContain('src/a.ts:3');
    unmount();
    render(<MemoryRouter><ValidationView detail={detail()} specStatus="awaiting-validation" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    expect(screen.queryByTestId('security-findings')).toBeNull();
  });


  it('shows service, script checkboxes, assumptions, blocked tasks and evidence; actions enabled when awaiting validation', () => {
    const on = { report: vi.fn(), complete: vi.fn() };
    render(<MemoryRouter><ValidationView detail={detail()} specStatus="awaiting-validation" onReport={on.report} onComplete={on.complete} /></MemoryRouter>);
    expect(screen.getByTestId('smoke-AC-001').textContent).toContain('Passou');
    expect(screen.getByTestId('e2e-AC-001').textContent).toBe('Passou');
    expect(screen.getByTestId('e2e-AC-002').textContent).toContain('Não se aplica (devops only)');
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
    expect(screen.getByTestId('deploy-failure').textContent).toContain('versão anterior restaurada');
    expect((screen.getByTestId('complete-spec') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('report-problem') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('actions-note').textContent).toContain('deploy falhou');
  });

  it('shows an action error next to the buttons without hiding them', () => {
    render(<MemoryRouter><ValidationView detail={detail()} specStatus="awaiting-validation" actionError="409 spec is not awaiting validation" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    expect(screen.getByTestId('action-error').textContent).toContain('409');
    expect((screen.getByTestId('complete-spec') as HTMLButtonElement).disabled).toBe(false);
  });

  it('without a report yet it says so', () => {
    render(<MemoryRouter><ValidationView detail={detail({ report: null, status: 'running', phase: 3 })} specStatus="running" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText(/ainda não há relatório/i)).toBeTruthy();
  });

  it('spells out the criterion under its script steps', () => {
    const criteria = [{ id: 'AC-001', given: 'a visitor', when: 'they open /', then: 'they see the list', smoke: true }];
    render(<MemoryRouter><ValidationView detail={detail({ acceptanceCriteria: criteria })} specStatus="awaiting-validation" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText('Dado a visitor, quando they open /, então they see the list')).toBeTruthy();
  });
});

describe('ValidationView service card', () => {
  const withService = (svc: Partial<NonNullable<Report['service']>>) => detail({ report: { ...report, service: { ...report.service!, url: 'http://dind:3000', ...svc } } });
  const view = (d: RunDetail, extra: { serviceStatus?: { online: boolean; status: number | null; checkedAt: string } | null; specStatus?: string; onStartService?: () => void; onRecheck?: () => void; startingService?: boolean } = {}) =>
    render(<MemoryRouter><ValidationView detail={d} specStatus={extra.specStatus ?? 'awaiting-validation'} serviceStatus={extra.serviceStatus ?? null} onStartService={extra.onStartService ?? vi.fn()} onRecheckService={extra.onRecheck ?? vi.fn()} startingService={extra.startingService ?? false} onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
  const online = { online: true, status: 200, checkedAt: '2026-10-06T10:00:00.000Z' };
  const offline = { online: false, status: null, checkedAt: '2026-10-06T10:00:00.000Z' };

  it('an online api offers the Swagger button and no start button', () => {
    view(withService({ port: 3000, kind: 'api', docsPath: '/docs' }), { serviceStatus: online });
    expect(screen.getByTestId('service-online').textContent).toContain('No ar');
    expect(screen.getByTestId('open-docs').getAttribute('href')).toBe(`http://${window.location.hostname}:3000/docs`);
    // The buttons already open the service, so no separate url or past healthcheck line.
    expect(screen.queryByTestId('service-url')).toBeNull();
    expect(screen.queryByText(/Verificação de saúde/)).toBeNull();
    expect(screen.queryByTestId('open-app')).toBeNull();
    expect(screen.queryByTestId('start-service')).toBeNull();
  });

  it('an online front-end offers the app button', () => {
    view(withService({ port: 3001, kind: 'front' }), { serviceStatus: online });
    expect(screen.getByTestId('open-app').getAttribute('href')).toBe(`http://${window.location.hostname}:3001`);
    expect(screen.queryByTestId('open-docs')).toBeNull();
  });

  it('an offline service says so, hides the open buttons and offers to start it', () => {
    const start = vi.fn();
    view(withService({ port: 3000, kind: 'api', docsPath: '/docs' }), { serviceStatus: offline, onStartService: start });
    expect(screen.getByTestId('service-online').textContent).toContain('Fora do ar');
    expect(screen.queryByTestId('open-docs')).toBeNull();
    fireEvent.click(screen.getByTestId('start-service'));
    expect(start).toHaveBeenCalled();
  });

  it('start is disabled while a deploy runs, and while the spec is not delivered', () => {
    const { unmount } = view(withService({ port: 3000 }), { serviceStatus: offline, startingService: true });
    expect((screen.getByTestId('start-service') as HTMLButtonElement).disabled).toBe(true);
    unmount();
    const running = view(withService({ port: 3000 }), { serviceStatus: offline, specStatus: 'running' });
    expect((screen.getByTestId('start-service') as HTMLButtonElement).disabled).toBe(true);
    running.unmount();
    view(withService({ port: 3000 }), { serviceStatus: offline, specStatus: 'done' }); // a concluded spec is read-only
    expect((screen.getByTestId('start-service') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a port outside the published range gets no open button but says why', () => {
    view(withService({ port: 8080, url: 'http://dind:8080', kind: 'api', docsPath: '/docs' }), { serviceStatus: online });
    expect(screen.queryByTestId('open-docs')).toBeNull();
    expect(screen.getByTestId('service-unpublished').textContent).toContain('3000');
  });

  it('while the first check is pending it shows Verificando and no start button', () => {
    view(withService({ port: 3000 }), { serviceStatus: null });
    expect(screen.getByTestId('service-online').textContent).toContain('Verificando');
    expect(screen.queryByTestId('start-service')).toBeNull();
  });

  it('recheck asks for a new status', () => {
    const recheck = vi.fn();
    view(withService({ port: 3000 }), { serviceStatus: online, onRecheck: recheck });
    fireEvent.click(screen.getByTestId('recheck-service'));
    expect(recheck).toHaveBeenCalled();
  });
});

describe('ValidationView text', () => {
  it('shows text between backticks as code, without the backticks', () => {
    const r = { ...report, exploratoryScript: [{ acId: 'AC-001', steps: ['Rode `curl -i http://localhost:3000/health` e veja `{"ok":true}`.'] }] };
    render(<MemoryRouter><ValidationView detail={detail({ report: r })} specStatus="awaiting-validation" onReport={vi.fn()} onComplete={vi.fn()} /></MemoryRouter>);
    const li = screen.getByTestId('step-AC-001-0').closest('li')!;
    expect(li.querySelectorAll('code').length).toBe(2);
    expect(li.textContent).toBe('Rode curl -i http://localhost:3000/health e veja {"ok":true}.');
  });
});

const COMPLETION ='hello-001-complete-r1';
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

  describe('Subir serviço', () => {
    const DEPLOY = 'hello-001-deploy-r1';
    const status = (online: boolean) => ({ online, status: online ? 200 : null, checkedAt: '2026-10-06T10:00:00.000Z' });

    it('starts the deploy run, follows it to its end and asks again whether the service answers', async () => {
      fakePollTimer();
      vi.spyOn(runApi, 'run').mockImplementation(async (id) => (id === DEPLOY ? detail({ runId: DEPLOY, status: 'done', report: null }) : detail()));
      vi.spyOn(runApi, 'projects').mockResolvedValue(specs('awaiting-validation'));
      const check = vi.spyOn(runApi, 'serviceStatus').mockResolvedValueOnce(status(false)).mockResolvedValue(status(true));
      const deploy = vi.spyOn(runApi, 'deployAgain').mockResolvedValue({ runId: DEPLOY });
      page();
      fireEvent.click(await screen.findByTestId('start-service'));
      await tick(0);
      expect(deploy).toHaveBeenCalledWith('hello-app', 'hello-001');
      expect((screen.getByTestId('start-service') as HTMLButtonElement).disabled).toBe(true);
      await tick(4000);
      await waitFor(() => expect(screen.getByTestId('service-online').textContent).toContain('No ar'));
      expect(check).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('start-service')).toBeNull();
    });

    it('shows how the deploy run ended when it did not come up', async () => {
      fakePollTimer();
      vi.spyOn(runApi, 'run').mockImplementation(async (id) => (id === DEPLOY ? detail({ runId: DEPLOY, status: 'deploy-failed', report: null, finished: { result: 'deploy-failed', reason: 'smoke failed' } }) : detail()));
      vi.spyOn(runApi, 'projects').mockResolvedValue(specs('awaiting-validation'));
      vi.spyOn(runApi, 'serviceStatus').mockResolvedValue(status(false));
      vi.spyOn(runApi, 'deployAgain').mockResolvedValue({ runId: DEPLOY });
      page();
      fireEvent.click(await screen.findByTestId('start-service'));
      await tick(0);
      await tick(4000);
      const failure = await screen.findByTestId('action-error');
      expect(failure.textContent).toContain(DEPLOY);
      expect(failure.textContent).toContain('deploy falhou');
      expect(failure.textContent).toContain('smoke failed');
      expect((screen.getByTestId('start-service') as HTMLButtonElement).disabled).toBe(false);
    });
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
      expect(failure.textContent).toContain('fase falhou');
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
      expect(notice.textContent).toContain(`execução de conclusão ${COMPLETION} foi interrompida`);
      expect(notice.textContent).not.toContain('terminou');
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
      // While it goes the click shows it: both actions wait and the note links the run.
      expect((screen.getByTestId('complete-spec') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('complete-spec').textContent).toContain('Concluindo…');
      expect(screen.getByTestId('completing-note').querySelector('a')?.getAttribute('href')).toBe(`/runs/${COMPLETION}`);
      now.completion = 'done';
      now.spec = 'done';
      await tick(5000);
      await waitFor(() => expect(screen.getByTestId('actions-note').textContent).toContain('já foi concluída'));
      const calls = run.mock.calls.length;
      await tick(60_000);
      expect(run.mock.calls.length).toBe(calls);
    });

    it('clears an action error left by a refused click once the reload after the completion succeeds', async () => {
      fakePollTimer();
      const now = { completion: 'running', spec: 'awaiting-validation' };
      vi.spyOn(runApi, 'run').mockImplementation(async (id) => (id === COMPLETION ? completion({ status: now.completion }) : detail()));
      vi.spyOn(runApi, 'projects').mockImplementation(async () => specs(now.spec));
      vi.spyOn(runApi, 'complete')
        .mockRejectedValueOnce(new Error('409 spec hello-001 already has run hello-001-complete-r1 (running)'))
        .mockResolvedValueOnce({ runId: COMPLETION });
      page();
      await clickComplete();
      expect((await screen.findByTestId('action-error')).textContent).toContain('409');
      await clickComplete();
      now.completion = 'done';
      now.spec = 'done';
      await tick(5000);
      await waitFor(() => expect(screen.queryByTestId('action-error')).toBeNull());
      expect(screen.getByTestId('actions-note').textContent).toContain('já foi concluída');
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
      expect(screen.queryByTestId('actions-note')?.textContent ?? '').not.toContain('já foi concluída');
      await tick(5000);
      await waitFor(() => expect(screen.getByTestId('actions-note').textContent).toContain('já foi concluída'));
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
      expect(await screen.findByText(/carregando/i)).toBeTruthy();
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
