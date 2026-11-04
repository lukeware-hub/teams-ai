import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { refineApi, runApi, type ProgramView } from '../api.js';
import { ProgramPage } from './Program.js';

const program: ProgramView = {
  version: 1, draftId: 'd', status: 'running', updatedAt: '',
  items: [{ specId: 'd-base', key: 'base', rank: 1, dependsOn: [], status: 'running', runId: 'd-base-r1', completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0, costUsd: null }],
};

describe('ProgramPage', () => {
  it('follows the started backlog: progress, the spec and phase running now, and every spec of the program', async () => {
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ state: { backlog: { items: [{ key: 'base', title: 'Fundação' }] } } } as never);
    vi.spyOn(refineApi, 'program').mockResolvedValue({ program });
    vi.spyOn(refineApi, 'programDecisions').mockResolvedValue({ unanswered: 3, decisions: [{ at: '2026-10-13T12:00:00.000Z', key: 'base', runId: 'd-base-r1', decisionId: 'model-tier', backend: 'jev', escalated: false, answers: [{ question: 'tier', value: 'large', confidence: 0.91 }] }] });
    vi.spyOn(runApi, 'run').mockResolvedValue({ phase: 2 } as never);
    render(<MemoryRouter initialEntries={['/refine/p/d/program']}><Routes><Route path="/refine/:projectId/:specId/program" element={<ProgramPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Agora: Fundação · 2 · Plano'));
    expect(within(screen.getByTestId('program-item-base')).getByText('em execução')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'd' }).getAttribute('href')).toBe('/refine/p/d');
    const timeline = await screen.findByText('model-tier');
    expect(screen.getByText(/3 consultas ficaram sem resposta/)).toBeTruthy();
    expect(timeline.closest('li')!.textContent).toMatch(/Jev.*Fundação.*tier: large \(91%\)/);
  });
  it('says in words why a spec failed or waits, who has to act and what to do, keeping the raw reason in a detail', async () => {
    const reason = 'deploy-failed: deploy failed on attempt 3 at e2e (privacy-service): privacy_test.go:123: SERVICE_URL_IDENTITY_SERVICE e PLATFORM_ADMIN_TOKEN não foram definidos';
    const failing: ProgramView = { ...program, items: [
      { ...program.items[0]!, specId: 'd-privacy', key: 'privacy', status: 'failed', runId: null, reason },
      { ...program.items[0]!, specId: 'd-gateway', key: 'gateway', rank: 2, status: 'blocked', runId: null, reason: 'depends on privacy, which failed' },
    ] };
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ state: { backlog: { items: [{ key: 'privacy', title: 'Privacidade' }, { key: 'gateway', title: 'Gateway' }] } } } as never);
    vi.spyOn(refineApi, 'program').mockResolvedValue({ program: failing });
    vi.spyOn(refineApi, 'programDecisions').mockResolvedValue({ unanswered: 0, decisions: [] });
    vi.spyOn(runApi, 'run').mockResolvedValue({ phase: 2 } as never);
    render(<MemoryRouter initialEntries={['/refine/p/d/program']}><Routes><Route path="/refine/:projectId/:specId/program" element={<ProgramPage />} /></Routes></MemoryRouter>);
    const failed = await screen.findByTestId('program-item-privacy');
    expect(within(failed).getByText(/Falta uma credencial ou variável de ambiente/)).toBeTruthy();
    expect(within(failed).getByText(/PLATFORM_ADMIN_TOKEN, que não existem/)).toBeTruthy();
    expect(within(failed).getByText('Detalhe técnico')).toBeTruthy();
    expect(within(screen.getByTestId('program-item-gateway')).getByText(/Aguarda a spec privacy/)).toBeTruthy();
  });
  it('shows a spec the environment made wait, why, and at what time it tries again', async () => {
    const retryAt = '2026-10-13T15:07:00.000Z';
    const waiting: ProgramView = { ...program, items: [{ ...program.items[0]!, status: 'waiting', reason: 'deploy-failed: docker daemon down', retryAt }] };
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ state: { backlog: { items: [{ key: 'base', title: 'Fundação' }] } } } as never);
    vi.spyOn(refineApi, 'program').mockResolvedValue({ program: waiting });
    vi.spyOn(refineApi, 'programDecisions').mockResolvedValue({ unanswered: 0, decisions: [] });
    render(<MemoryRouter initialEntries={['/refine/p/d/program']}><Routes><Route path="/refine/:projectId/:specId/program" element={<ProgramPage />} /></Routes></MemoryRouter>);
    const row = await screen.findByTestId('program-item-base');
    expect(within(row).getByText('aguardando')).toBeTruthy();
    expect(within(row).getByText(`tenta de novo às ${new Date(retryAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`)).toBeTruthy();
    expect(within(row).getByText('deploy-failed: docker daemon down')).toBeTruthy();
  });
  it('shows a stopped run as interrupted on the card and in the list', async () => {
    const stopped: ProgramView = { ...program, items: [{ ...program.items[0]!, interrupted: { runId: 'd-base-r1' } }] };
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ state: { backlog: { items: [{ key: 'base', title: 'Fundação' }] } } } as never);
    vi.spyOn(refineApi, 'program').mockResolvedValue({ program: stopped });
    vi.spyOn(refineApi, 'programDecisions').mockResolvedValue({ unanswered: 0, decisions: [] });
    vi.spyOn(runApi, 'run').mockResolvedValue({ phase: 2 } as never);
    render(<MemoryRouter initialEntries={['/refine/p/d/program']}><Routes><Route path="/refine/:projectId/:specId/program" element={<ProgramPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Backlog interrompido · 0 de 1 concluída'));
    expect(screen.getByRole('status').textContent).toContain('Interrompida: Fundação · 2 · Plano');
    expect(within(screen.getByTestId('program-item-base')).getByText('interrompida')).toBeTruthy();
  });
});
