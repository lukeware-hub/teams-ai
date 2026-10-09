import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ProgramView } from '../api.js';
import { canStartRun, ProgramPanel } from './ProgramPanel.js';

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

  it('counts what is done and says when the program finished with failures', () => {
    renderPanel(program([item('a', { status: 'done' }), item('b', { status: 'failed', reason: 'verification-failed: AC-004' }), item('c', { status: 'blocked' })], 'finished'));
    expect(screen.getByText(/1 de 3 concluídas/)).toBeTruthy();
    expect(screen.getByText(/Programa encerrado/)).toBeTruthy();
    expect(within(screen.getByTestId('program-item-b')).getByText('falhou')).toBeTruthy();
    expect(within(screen.getByTestId('program-item-b')).getByText(/verification-failed: AC-004/)).toBeTruthy();
  });

  it('shows a completing spec as being marked done', () => {
    renderPanel(program([item('a', { status: 'completing', runId: 'd-a-r1', completeRunId: 'd-a-complete-r1' })]));
    expect(screen.getByText('concluindo')).toBeTruthy();
  });
});

describe('canStartRun', () => {
  const state = (over: Record<string, unknown> = {}) => ({ status: 'ready', stale: false, backlog: undefined, ...over }) as never;
  it('a single spec starts when ready and not stale', () => {
    expect(canStartRun(state(), false)).toBe(true);
    expect(canStartRun(state({ stale: true }), false)).toBe(false);
    expect(canStartRun(state({ status: 'answering' }), false)).toBe(false);
    expect(canStartRun(state(), true)).toBe(false);
  });
  it('a backlog starts only once detailed, ready and current', () => {
    expect(canStartRun(state({ backlog: { enabled: true, detail: false } }), false)).toBe(false);
    expect(canStartRun(state({ backlog: { enabled: true, detail: true } }), false)).toBe(true);
    expect(canStartRun(state({ backlog: { enabled: true, detail: true }, stale: true }), false)).toBe(false);
    expect(canStartRun(state({ backlog: { enabled: true, detail: true }, status: 'started' }), false)).toBe(false);
  });
});
