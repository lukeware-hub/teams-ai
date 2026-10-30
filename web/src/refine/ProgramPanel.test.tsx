import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ProgramView } from '../api.js';
import { canStartRun, ProgramPanel, ProgramStatus } from './ProgramPanel.js';

const item = (key: string, over: Partial<ProgramView['items'][number]> = {}): ProgramView['items'][number] => ({
  specId: `d-${key}`, key, rank: 1, dependsOn: [], status: 'pending', runId: null, completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0, costUsd: null, ...over,
});
const program = (items: ProgramView['items'], status: ProgramView['status'] = 'running'): ProgramView => ({ version: 1, draftId: 'd', status, items, updatedAt: '2026-10-07T12:00:00Z' });
const titles = { a: 'Cadastro de livros', b: 'Empréstimos', c: 'Relatórios' };
const renderPanel = (p: ProgramView) => render(<MemoryRouter><ProgramPanel program={p} titles={titles} /></MemoryRouter>);

describe('ProgramPanel', () => {
  it('lists each spec in rank order with its status, the run to follow and why it failed or is blocked', () => {
    renderPanel(program([
      item('a', { rank: 1, status: 'done', runId: 'd-a-r1', completeRunId: 'd-a-complete-r1' }),
      item('b', { rank: 2, status: 'running', runId: 'd-b-r1' }),
      item('c', { rank: 3, status: 'blocked', reason: 'depends on b, which failed' }),
    ]));
    const a = within(screen.getByTestId('program-item-a'));
    expect(a.getByText('Cadastro de livros')).toBeTruthy();
    expect(a.getByText('concluída')).toBeTruthy();
    expect((a.getByRole('link', { name: /d-a-r1/ }) as HTMLAnchorElement).getAttribute('href')).toBe('/runs/d-a-r1');
    const b = within(screen.getByTestId('program-item-b'));
    expect(b.getByText('em execução')).toBeTruthy();
    expect((b.getByRole('link', { name: /d-b-r1/ }) as HTMLAnchorElement).getAttribute('href')).toBe('/runs/d-b-r1');
    expect(within(screen.getByTestId('program-item-c')).getByText('bloqueada')).toBeTruthy();
    expect(within(screen.getByTestId('program-item-c')).getByText(/depends on b, which failed/)).toBeTruthy();
  });

  it('shows a spec whose code is on main but whose deploy failed as partly done, with the reason and no retry', () => {
    renderPanel(program([
      item('a', { rank: 1, status: 'partial', runId: 'd-a-r1', reason: 'deploy-failed: smoke 500' }),
    ], 'finished'));
    const a = within(screen.getByTestId('program-item-a'));
    expect(a.getByText('concluída parcialmente')).toBeTruthy();
    expect(a.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    expect(screen.getByText(/há specs concluídas parcialmente/)).toBeTruthy();
  });

  it('links the pull requests of a spec and says why and until when a run waits', () => {
    renderPanel(program([
      item('a', { status: 'running', runId: 'd-a-r1', prs: [{ number: 7, url: 'https://github.com/o/audit-service/pull/7' }, { number: 7, url: 'https://github.com/o/identity-service/pull/7' }], pause: { reason: 'quota', until: '2026-10-13T18:30:00.000Z' } }),
      item('b', { status: 'running', runId: 'd-b-r1', pause: { reason: 'auth' } }),
      item('c', { status: 'pending' }),
    ]));
    const prs = within(screen.getByTestId('program-item-prs-a'));
    expect(prs.getByText('2 pull requests')).toBeTruthy();
    const link = prs.getByRole('link', { name: 'identity-service#7' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://github.com/o/identity-service/pull/7');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(prs.getByRole('link', { name: 'audit-service#7' })).toBeTruthy();
    expect(screen.getByTestId('program-item-pause-a').textContent).toMatch(/^Pausada pela cota do Claude até \d{2}:\d{2}\.$/);
    expect(screen.getByTestId('program-item-pause-b').textContent).toMatch(/login/);
    expect(screen.queryByTestId('program-item-prs-c')).toBeNull();
    expect(screen.queryByTestId('program-item-pause-c')).toBeNull();
  });

  it('counts what is done and says when the program finished with failures', () => {
    renderPanel(program([item('a', { status: 'done' }), item('b', { status: 'failed', reason: 'verification-failed: AC-004' }), item('c', { status: 'blocked' })], 'finished'));
    expect(screen.getByText(/1 de 3 concluídas/)).toBeTruthy();
    expect(screen.getByText(/Programa encerrado/)).toBeTruthy();
    expect(within(screen.getByTestId('program-item-b')).getByText('falhou')).toBeTruthy();
    expect(within(screen.getByTestId('program-item-b')).getByText(/verification-failed: AC-004/)).toBeTruthy();
  });

  it('explains an interrupted row with its own tip, not with a Retomar button the row does not have', () => {
    renderPanel(program([item('a', { status: 'running', runId: 'd-a-r1', interrupted: { runId: 'd-a-r1' } })]));
    const row = within(screen.getByTestId('program-item-a'));
    expect(row.getByRole('button', { name: 'O processo parou antes do fim. Abra a run para retomar.' })).toBeTruthy();
    expect(row.queryByRole('button', { name: /Use Retomar/ })).toBeNull();
  });

  it('offers to run a queued spec now, and marks one already prioritized', () => {
    const onPrioritize = vi.fn();
    render(<MemoryRouter><ProgramPanel program={program([item('a', { status: 'running', runId: 'd-a-r1' }), item('b', { rank: 2 }), item('c', { rank: 3, priority: true })])} titles={titles} onPrioritize={onPrioritize} /></MemoryRouter>);
    expect(within(screen.getByTestId('program-item-a')).queryAllByRole('button').filter((b) => !b.classList.contains('info-tip'))).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId('program-item-b')).getByRole('button', { name: 'Executar agora' }));
    expect(onPrioritize).toHaveBeenCalledWith('d-b');
    expect(within(screen.getByTestId('program-item-c')).getByText('prioritária')).toBeTruthy();
    expect(within(screen.getByTestId('program-item-c')).queryAllByRole('button').filter((b) => !b.classList.contains('info-tip'))).toHaveLength(0);
  });

  it('offers to try a failed spec again', () => {
    const onPrioritize = vi.fn();
    render(<MemoryRouter><ProgramPanel program={program([item('a', { status: 'failed', reason: 'verification-failed' })])} titles={titles} onPrioritize={onPrioritize} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(onPrioritize).toHaveBeenCalledWith('d-a');
  });

  it('shows a completing spec as being marked done', () => {
    renderPanel(program([item('a', { status: 'completing', runId: 'd-a-r1', completeRunId: 'd-a-complete-r1' })]));
    expect(screen.getByText('concluindo')).toBeTruthy();
  });

  it('shows an interrupted spec with the hub pill, and a running one as before', () => {
    renderPanel(program([item('a', { status: 'running', runId: 'd-a-r1', interrupted: { runId: 'd-a-r1' } }), item('b', { rank: 2, status: 'running', runId: 'd-b-r1' })]));
    const pill = within(screen.getByTestId('program-item-a')).getByText('interrompida');
    expect(pill.className).toContain('tone-warn');
    expect(within(screen.getByTestId('program-item-a')).queryByText('em execução')).toBeNull();
    expect(within(screen.getByTestId('program-item-b')).getByText('em execução')).toBeTruthy();
  });
});

describe('ProgramStatus', () => {
  const renderStatus = (p: ProgramView | null, phases: Record<string, number> = {}) => render(<MemoryRouter><ProgramStatus program={p} titles={titles} phases={phases} /></MemoryRouter>);

  it('says the run is being prepared before the first program arrives', () => {
    renderStatus(null);
    expect(screen.getByRole('status').textContent).toContain('Preparando a execução do backlog…');
  });

  it('shows the progress, the spec running now, its phase and the run to follow', () => {
    renderStatus(program([item('a', { status: 'done' }), item('b', { rank: 2, status: 'running', runId: 'd-b-r1' }), item('c', { rank: 3 })]), { 'd-b-r1': 3 });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Executando o backlog · 1 de 3 concluídas');
    expect(status.textContent).toContain('Agora: Empréstimos · 3 · Implementação');
    expect((within(status).getByRole('link', { name: 'Acompanhar a run' }) as HTMLAnchorElement).getAttribute('href')).toBe('/runs/d-b-r1');
    expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(1);
  });

  it('lists every spec running at once, each with its phase and run', () => {
    renderStatus(program([item('a', { status: 'done' }), item('b', { rank: 2, status: 'running', runId: 'd-b-r1' }), item('c', { rank: 3, status: 'running', runId: 'd-c-r1' })]), { 'd-b-r1': 3, 'd-c-r1': 1 });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Empréstimos · 3 · Implementação');
    expect(status.textContent).toContain('Relatórios · 1 · Especificação técnica');
    expect(within(status).getAllByRole('link', { name: 'Acompanhar a run' }).map((l) => l.getAttribute('href'))).toEqual(['/runs/d-b-r1', '/runs/d-c-r1']);
  });

  it('stops the spinner once the program finished', () => {
    renderStatus(program([item('a', { status: 'done' })], 'finished'));
    expect(screen.getByRole('status').textContent).toContain('Backlog executado · 1 de 1 concluída');
    expect(screen.getByRole('status').querySelector('.loading-spinner')).toBeNull();
  });

  it('says the backlog is interrupted when every spec in flight has lost its process', () => {
    renderStatus(program([item('a', { status: 'done' }), item('b', { rank: 2, status: 'running', runId: 'd-b-r1', interrupted: { runId: 'd-b-r1' } }), item('c', { rank: 3 })]), { 'd-b-r1': 4 });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Backlog interrompido · 1 de 3 concluídas');
    expect(status.textContent).toContain('Interrompida: Empréstimos · 4 · Verificação');
    expect(status.textContent).not.toContain('Agora:');
    expect(status.querySelector('.loading-spinner')).toBeNull();
    expect(status.querySelector('.bg-warn')).not.toBeNull();
    expect(status.querySelector('.text-warn svg')).not.toBeNull();
    expect(status.querySelector('.motion-safe\\:animate-pulse')).toBeNull();
    expect((within(status).getByRole('link', { name: 'Acompanhar a run' }) as HTMLAnchorElement).getAttribute('href')).toBe('/runs/d-b-r1');
  });

  it('keeps Executando o backlog while another spec still has its process', () => {
    renderStatus(program([item('b', { status: 'running', runId: 'd-b-r1', interrupted: { runId: 'd-b-r1' } }), item('c', { rank: 2, status: 'running', runId: 'd-c-r1' })]), { 'd-b-r1': 3, 'd-c-r1': 1 });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Executando o backlog · 0 de 2 concluídas');
    expect(status.textContent).toContain('Interrompida: Empréstimos · 3 · Implementação');
    expect(status.textContent).toContain('Agora: Relatórios · 1 · Especificação técnica');
    expect(status.querySelector('.loading-spinner')).not.toBeNull();
  });

  it('does not read a program with nothing in flight as interrupted', () => {
    renderStatus(program([item('a', { status: 'pending' }), item('b', { rank: 2 })]));
    expect(screen.getByRole('status').textContent).toContain('Executando o backlog · 0 de 2 concluídas');
    expect(screen.getByRole('status').textContent).not.toContain('interrompid');
  });

  it('goes back to Executando the moment the run has its process again', () => {
    const { rerender } = render(<MemoryRouter><ProgramStatus program={program([item('b', { status: 'running', runId: 'd-b-r1', interrupted: { runId: 'd-b-r1' } })])} titles={titles} phases={{}} /></MemoryRouter>);
    expect(screen.getByRole('status').textContent).toContain('Backlog interrompido');
    rerender(<MemoryRouter><ProgramStatus program={program([item('b', { status: 'running', runId: 'd-b-r1' })])} titles={titles} phases={{}} /></MemoryRouter>);
    expect(screen.getByRole('status').textContent).toContain('Executando o backlog · 0 de 1 concluída');
    expect(screen.getByRole('status').querySelector('.loading-spinner')).not.toBeNull();
  });

  it('does not title a finished program as interrupted', () => {
    renderStatus(program([item('a', { status: 'done' }), item('b', { rank: 2, status: 'running', runId: 'd-b-r1', interrupted: { runId: 'd-b-r1' } })], 'finished'));
    expect(screen.getByRole('status').textContent).toContain('Backlog executado · 1 de 2 concluídas');
    expect(screen.getByRole('status').textContent).not.toContain('Backlog interrompido');
  });

  it('links an interrupted spec that was completing to its completion run', () => {
    renderStatus(program([item('a', { status: 'completing', runId: 'd-a-r1', completeRunId: 'd-a-complete-r1', interrupted: { runId: 'd-a-complete-r1' } })]));
    expect((screen.getByRole('link', { name: 'Acompanhar a run' }) as HTMLAnchorElement).getAttribute('href')).toBe('/runs/d-a-complete-r1');
  });
});

describe('canStartRun', () => {
  /** A current plan preparation, which every start needs. */
  const prepared = { status: 'done', steps: [], stale: false };
  const state = (over: Record<string, unknown> = {}) => ({ status: 'ready', mode: 'new-spec', derived: {}, backlog: undefined, speckit: prepared, ...over }) as never;
  it('is never locked by a check, a question, a suggestion, a stale list or the Jev', () => {
    const waiting = { status: 'answering', stale: true, cycle: 2, questions: [{ status: 'pending', blocking: true }], patches: [{ status: 'pending' }], readiness: { average: 0.5 } };
    expect(canStartRun(state(waiting), false)).toBe(true);
  });
  it('stays shut while a request is busy, while the agents evaluate, after a start, or with nothing derived', () => {
    expect(canStartRun(state(), true)).toBe(false);
    expect(canStartRun(state({ status: 'evaluating' }), false)).toBe(false);
    expect(canStartRun(state({ status: 'started' }), false)).toBe(false);
    expect(canStartRun(state({ derived: null }), false)).toBe(false);
  });
  it('a new project starts only with its backlog, and a backlog only once detailed and with items', () => {
    const item = { key: 'base' };
    expect(canStartRun(state({ mode: 'new-project' }), false)).toBe(false);
    expect(canStartRun(state({ mode: 'new-project', backlog: { enabled: true, detail: true, items: [item], preplans: { base: { preplan: {} } } } }), false)).toBe(true);
    expect(canStartRun(state({ backlog: { enabled: true, detail: false, items: [item] } }), false)).toBe(false);
    expect(canStartRun(state({ backlog: { enabled: true, detail: true, items: [] } }), false)).toBe(false);
  });
  it('a wizard backlog, an imported backlog, a new spec and a continued spec start only after a current plan preparation', () => {
    const backlog = { enabled: true, detail: true, items: [{ key: 'base' }], preplans: { base: { preplan: {} } } };
    for (const session of [{ mode: 'new-project', backlog }, { mode: 'backlog', backlog }, { mode: 'new-spec' }, { mode: 'continue' }]) {
      expect(canStartRun(state({ ...session, speckit: undefined }), false), session.mode).toBe(false);
      expect(canStartRun(state({ ...session, speckit: { ...prepared, stale: true } }), false), session.mode).toBe(false);
      expect(canStartRun(state(session), false), session.mode).toBe(true);
      expect(canStartRun(state({ ...session, questions: [{ status: 'pending', blocking: true, origin: 'speckit' }] }), false), session.mode).toBe(false);
    }
  });
});
