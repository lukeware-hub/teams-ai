import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, runApi, type RepoDashboard, type RepoDetailView, type ServiceStatus } from '../api.js';
import { queryPage, type PageRequest } from '@server/api/paging.js';
import { RepositoryPage } from './RepositoryPage.js';

const detail = (over: Partial<RepoDetailView> = {}): RepoDetailView => ({
  name: 'shop-api',
  kind: 'api',
  responsibility: 'Vende',
  status: 'running',
  specs: 2,
  plans: 1,
  tasks: 3,
  tasksDone: 1,
  blockers: 1,
  integrations: ['shop-web → shop-api: GET /cart'],
  rows: [],
  history: [],
  ...over,
});

const dashboard = (over: Partial<RepoDashboard> = {}): RepoDashboard => ({
  counts: { tasks: 3, delivered: 1, pending: 1, running: 0, blocked: 1, failed: 0, runs: 1, runsActive: 0, failures: 0, blockers: 1, specsDelivered: 1, specsAwaiting: 0, progress: 33, cost: 0.5 },
  specs: [
    { specId: 'cart', title: 'Carrinho', priority: 'P1', status: 'done', state: 'delivered', total: 1, delivered: 1, running: 0, pending: 0, blocked: 0, failed: 0, validationRunId: null, deployFailed: false },
    { specId: 'pay', title: 'Pagamento', priority: 'P2', status: 'running', state: 'blocked', total: 2, delivered: 0, running: 0, pending: 1, blocked: 1, failed: 0, validationRunId: null, deployFailed: false },
  ],
  tasks: {
    total: 3,
    list: [
      { specId: 'pay', runId: 'shop-api-pay-1', taskId: 'T2-pay', title: 'Cobrança', owner: 'dev', state: 'blocked', attempts: 1, reason: 'uma dependência desta tarefa está bloqueada', pr: null },
      { specId: 'cart', runId: 'shop-api-cart-1', taskId: 'T1-cart', title: 'Carrinho', owner: 'dev', state: 'delivered', attempts: 0, reason: null, pr: 12 },
    ],
  },
  files: { total: 0, list: [] },
  tests: { passed: 4, failed: 1, failures: { total: 0, list: [] } },
  retries: { attempts: 1, infra: 0, flaky: 0, replanned: 0, fixes: 0, reopened: 0 },
  lastDeploy: { runId: 'shop-api-cart-1', specId: 'cart', url: 'http://localhost:3001', kind: 'api', docsPath: '/docs', healthcheckPath: null, services: null },
  ...over,
});

// The specs the specs table pages through; a test sets them before it renders.
let SPEC_ROWS: RepoDetailView['rows'] = [];

// The dashboard's paged tables, served one page at a time the way the API serves them.
const TABLE_ROWS: Record<string, unknown[]> = {
  runs: [{ runId: 'shop-api-cart-1', specId: 'cart', kind: 'run', status: 'complete', at: '2026-11-01T10:00:00.000Z', merged: 1, cost: 0.5 }],
  failures: [],
  blockers: [{ kind: 'task', specId: 'pay', runId: 'shop-api-pay-1', taskId: 'T2-pay', text: 'Tarefa T2-pay: uma dependência desta tarefa está bloqueada' }],
  agents: [
    { role: 'dev', steps: 2, ok: 2, failed: 0, tokens: 100, costUsd: 0.5, durationMs: 1000, created: 2, started: 1, finished: 1, files: 3, tests: null, lastAt: '2026-11-01T10:00:00.000Z', lastDoing: 'implementando a tarefa' },
    { role: 'test', steps: 1, ok: 0, failed: 1, tokens: 10, costUsd: 0, durationMs: 200, created: null, started: null, finished: null, files: 0, tests: { passed: 4, failed: 1 }, lastAt: '2026-11-01T10:00:00.000Z', lastDoing: 'rodando as verificações' },
  ],
  timeline: [{ at: '2026-11-01T10:00:00.000Z', runId: 'shop-api-cart-1', specId: 'cart', text: 'Tarefa T1-cart mesclada na main (pull request #12)', tone: 'good', role: 'dev', taskId: 'T1-cart' }],
  tasks: [{ specId: 'pay', runId: 'shop-api-pay-1', taskId: 'T2-pay', title: 'Cobrança', owner: 'dev', state: 'blocked', attempts: 1, reason: 'uma dependência desta tarefa está bloqueada', rawReason: 'uma dependência desta tarefa está bloqueada', pr: null }],
};

const serveTable = (_projectId: string, _repo: string, table: string, req: PageRequest) => Promise.resolve(queryPage(TABLE_ROWS[table] ?? [], {}, req));

const probe = (over: Partial<ServiceStatus> = {}): ServiceStatus => ({ online: true, status: 200, ui: false, docs: true, checkedAt: '2026-11-01T10:00:00.000Z', ...over });

const renderAt = () =>
  render(
    <MemoryRouter initialEntries={['/projects/shop/shop-api']}>
      <Routes>
        <Route path="/projects/:projectId/:repoId" element={<RepositoryPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.spyOn(runApi, 'repositoryDashboardTable').mockImplementation(serveTable as never);
  vi.spyOn(runApi, 'repositorySpecsPage').mockImplementation((_p, _r, req) => Promise.resolve(queryPage(SPEC_ROWS, { text: (r) => [r.specId, r.title ?? ''] }, req)));
  vi.spyOn(runApi, 'serviceStatus').mockResolvedValue(probe());
});
afterEach(() => vi.restoreAllMocks());

describe('RepositoryPage', () => {
  it('shows the indicator cards, the cost among them, with the counts of the journals', async () => {
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(dashboard());
    renderAt();
    const tasks = within(await screen.findByTestId('card-tasks'));
    expect(tasks.getByText('3')).toBeTruthy();
    expect(tasks.getByText('1 concluída · 1 pendente · 0 em execução')).toBeTruthy();
    expect(within(screen.getByTestId('card-progress')).getByText('33%')).toBeTruthy();
    expect(within(screen.getByTestId('card-blockers')).getByText('1')).toBeTruthy();
  });

  it('reads "sem dados" for the progress when the repository has no task', async () => {
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(dashboard({ counts: { ...dashboard().counts, tasks: 0, progress: null } }));
    renderAt();
    expect(within(await screen.findByTestId('card-progress')).getByText('sem dados')).toBeTruthy();
  });

  it('links each blocked task to its run, opening that task', async () => {
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(dashboard());
    renderAt();
    const pay = within(await screen.findByTestId('tasks-pay'));
    expect(pay.getByRole('link', { name: 'Abrir run' }).getAttribute('href')).toBe('/runs/shop-api-pay-1?task=T2-pay');
  });

  it('places the tasks table between the indicator cards and the delivery board', async () => {
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(dashboard());
    renderAt();
    const cards = await screen.findByTestId('repo-cards');
    const tasks = screen.getByTestId('repo-tasks');
    const board = screen.getByTestId('repo-board');
    expect(cards.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tasks.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers the Swagger shortcut when the probe answers for the deployed address', async () => {
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(dashboard());
    renderAt();
    await waitFor(() => expect(screen.getByTestId('shortcut-swagger').tagName).toBe('A'));
    expect(screen.getByTestId('shortcut-swagger').getAttribute('href')).toBe('http://localhost:3001/docs');
    expect(screen.queryByTestId('start-system')).toBeNull();
  });

  it('says the system is down and starts it on the owner\'s click when the probe does not answer', async () => {
    vi.spyOn(runApi, 'serviceStatus').mockResolvedValue(probe({ online: false, status: null, docs: false }));
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(dashboard());
    const deploy = vi.spyOn(runApi, 'deployAgain').mockResolvedValue({ runId: 'shop-api-cart-2' });
    renderAt();
    fireEvent.click(await screen.findByTestId('start-system'));
    expect(deploy).toHaveBeenCalledWith('shop', 'cart');
    expect(screen.getByTestId('shortcut-swagger').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('sistema desligado')).toBeTruthy();
  });

  it('says "sem dados" for the indicators when the dashboard cannot be read, and keeps the repository', async () => {
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockRejectedValue(new Error('500'));
    renderAt();
    expect(await screen.findByText('sem dados: os indicadores deste repositório não puderam ser lidos.')).toBeTruthy();
    expect(screen.getByTestId('repo-header')).toBeTruthy();
  });

  it('shows what each agent did: tasks for the roles that own tasks, tests for the test role', async () => {
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(dashboard());
    renderAt();
    expect(within(await screen.findByTestId('agent-dev')).getByText('2 criadas · 1 iniciadas · 1 concluídas')).toBeTruthy();
    expect(within(screen.getByTestId('agent-test')).getByText('4 passaram · 1 falharam')).toBeTruthy();
  });

  it('says it could not check the system when the probe fails, instead of checking forever', async () => {
    vi.spyOn(runApi, 'serviceStatus').mockRejectedValue(new Error('500'));
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(dashboard());
    renderAt();
    expect(await screen.findByText('não foi possível verificar o sistema')).toBeTruthy();
    expect(screen.queryByText('verificando se o sistema responde')).toBeNull();
  });

  it('says the repository is missing when the server answers 404', async () => {
    vi.spyOn(runApi, 'repository').mockRejectedValue(new ApiError('unknown repository shop-api', 404));
    vi.spyOn(runApi, 'repositoryDashboard').mockRejectedValue(new ApiError('unknown repository shop-api', 404));
    renderAt();
    await waitFor(() => expect(screen.getByTestId('repo-missing')).toBeTruthy());
  });

  it('says the request failed, not that the repository is missing, and tries again on the owner\'s click', async () => {
    const load = vi.spyOn(runApi, 'repository').mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(dashboard());
    renderAt();
    expect(await screen.findByTestId('repo-error')).toBeTruthy();
    expect(screen.queryByTestId('repo-missing')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByTestId('repo-page')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lists each spec in the collapsed specs table with its state and its tasks done', async () => {
    const rows: RepoDetailView['rows'] = [
      { specId: 'cart', status: 'done', activeRunId: null, repository: 'shop-api', title: 'Carrinho', priority: 'P1', dependsOn: [], plan: true, tasks: 3, blocked: false },
      { specId: 'pay', status: 'running', activeRunId: 'run-1', repository: 'shop-api', title: 'Pagamento', priority: 'P2', dependsOn: ['cart'], plan: false, tasks: 2, blocked: true },
    ];
    SPEC_ROWS = rows;
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(dashboard());
    renderAt();
    const specs = await screen.findByTestId('repo-specs');
    expect((specs as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(within(specs).getByText('Especificações'));
    expect((specs as HTMLDetailsElement).open).toBe(true);
    const cart = within(await screen.findByTestId('repo-spec-cart'));
    expect(cart.getByText('3 de 3')).toBeTruthy();
    const pay = within(screen.getByTestId('repo-spec-pay'));
    expect(pay.getByText('Bloqueada')).toBeTruthy();
    expect(pay.getByText('0 de 2')).toBeTruthy();
    expect(pay.getByText('cart')).toBeTruthy();
  });

  it('says "sem dados" for the timeline when the repository has no event', async () => {
    vi.spyOn(runApi, 'repositoryDashboardTable').mockImplementation((_p, _r, table, req) => Promise.resolve(queryPage(table === 'timeline' ? [] : TABLE_ROWS[table] ?? [], {}, req)) as never);
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(dashboard());
    renderAt();
    await waitFor(() => expect(screen.getByText('sem dados: nenhum evento registrado.')).toBeTruthy());
  });
});
