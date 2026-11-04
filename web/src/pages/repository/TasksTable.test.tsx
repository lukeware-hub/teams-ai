import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryPage, type PageRequest, type TableSpec } from '@server/api/paging.js';
import { runApi, type DashboardTaskRow, type TaskState } from '../../api.js';
import { TasksTable } from './TasksTable.js';

const row = (taskId: string, state: TaskState, extra: Partial<DashboardTaskRow> = {}): DashboardTaskRow => ({
  specId: 'pay',
  runId: 'shop-api-pay-1',
  taskId,
  title: `Tarefa ${taskId}`,
  owner: 'dev',
  state,
  attempts: 1,
  reason: null,
  rawReason: null,
  pr: null,
  ...extra,
});

const ROWS: DashboardTaskRow[] = [
  row('T1-cart', 'delivered'),
  row('T2-pay', 'blocked', { reason: 'uma dependência desta tarefa está bloqueada', rawReason: 'uma dependência desta tarefa está bloqueada' }),
  row('T3-pay', 'failed', { reason: 'o banco recusou a conexão', rawReason: 'o banco recusou a conexão' }),
  row('T4-pay', 'pending'),
];

const TASK_SPEC: TableSpec<DashboardTaskRow> = { text: (t) => [t.title, t.taskId, t.specId], facet: (t) => t.state };

const serve = (rows: DashboardTaskRow[]) =>
  vi.spyOn(runApi, 'repositoryDashboardTable').mockImplementation(((_p: string, _r: string, _t: string, req: PageRequest) => Promise.resolve(queryPage(rows, TASK_SPEC, req))) as never);

const renderTable = () =>
  render(
    <MemoryRouter>
      <TasksTable projectId="shop" repo="shop-api" />
    </MemoryRouter>,
  );

const listed = () => within(screen.getByTestId('repo-tasks-list')).queryAllByRole('listitem');

afterEach(() => vi.restoreAllMocks());

describe('TasksTable', () => {
  it('lists every task with its status, and a Detalhe button only for a task that did not finish', async () => {
    serve(ROWS);
    renderTable();
    await waitFor(() => expect(listed()).toHaveLength(4));
    expect(screen.getByTestId('repo-task-detail-T2-pay')).toBeTruthy();
    expect(screen.getByTestId('repo-task-detail-T3-pay')).toBeTruthy();
    expect(screen.queryByTestId('repo-task-detail-T1-cart')).toBeNull();
    expect(screen.queryByTestId('repo-task-detail-T4-pay')).toBeNull();
  });

  it('opens the reason of a task that did not finish in a dialog, with the reviewer text folded away', async () => {
    serve(ROWS);
    renderTable();
    fireEvent.click(await screen.findByTestId('repo-task-detail-T3-pay'));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByTestId('block-reason-raw-text').textContent).toContain('o banco recusou a conexão');
    expect(dialog.getByRole('link', { name: 'Abrir run' }).getAttribute('href')).toBe('/runs/shop-api-pay-1?task=T3-pay');
  });

  it('shows the next page of tasks when Carregar mais is pressed, and not once every page is listed', async () => {
    const many = Array.from({ length: 12 }, (_, i) => row(`P${i + 1}`, 'pending'));
    serve(many);
    renderTable();
    await waitFor(() => expect(listed()).toHaveLength(10));
    expect(screen.getByTestId('repo-tasks-count').textContent).toBe('10 de 12');
    fireEvent.click(screen.getByTestId('repo-tasks-load-more'));
    await waitFor(() => expect(listed()).toHaveLength(12));
    expect(screen.queryByTestId('repo-tasks-load-more')).toBeNull();
  });

  it('filters the list by status and counts the matches', async () => {
    serve(ROWS);
    renderTable();
    await waitFor(() => expect(listed()).toHaveLength(4));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    await waitFor(() => expect(listed()).toHaveLength(1));
    expect(screen.getByText('1 de 4')).toBeTruthy();
    expect(screen.getByTestId('repo-task-title-T3-pay')).toBeTruthy();
  });
});
