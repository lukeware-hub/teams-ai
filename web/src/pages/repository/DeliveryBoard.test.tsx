import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { DashboardSpec } from '../../api.js';
import { DeliveryBoard } from './DeliveryBoard.js';

const spec = (over: Partial<DashboardSpec> = {}): DashboardSpec => ({
  specId: 'greeting-route', title: 'Rota GET de saudação', priority: 'P0', status: 'awaiting-validation', state: 'awaiting',
  total: 7, delivered: 7, running: 0, pending: 0, blocked: 0, failed: 0, validationRunId: null, deployFailed: false, ...over,
});

describe('DeliveryBoard validation shortcut', () => {
  it('links a spec that waits for validation to its validation page', () => {
    render(<MemoryRouter><DeliveryBoard specs={[spec({ validationRunId: 'live-skill--greeting-route--run-4' })]} tasks={[]} /></MemoryRouter>);
    expect(screen.getByTestId('delivery-validate-greeting-route').getAttribute('href')).toBe('/runs/live-skill--greeting-route--run-4/validation');
  });

  it('shows no validation link when no run of the spec waits for validation', () => {
    render(<MemoryRouter><DeliveryBoard specs={[spec({ state: 'delivered', status: 'done', validationRunId: null, deployFailed: false })]} tasks={[]} /></MemoryRouter>);
    expect(screen.queryByTestId('delivery-validate-greeting-route')).toBeNull();
  });

  it('says the deploy failed when every task is delivered', () => {
    render(<MemoryRouter><DeliveryBoard specs={[spec({ state: 'failed', status: 'running', deployFailed: true })]} tasks={[]} /></MemoryRouter>);
    expect(screen.getByTestId('delivery-spec-progress-greeting-route').textContent).toBe('7 de 7 tarefas entregues · deploy falhou');
  });
});
