import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { runApi, type RepoDashboard } from '../api.js';
import { GrpcPage } from './GrpcPage.js';

const withDeploy = (lastDeploy: RepoDashboard['lastDeploy']) => ({ lastDeploy }) as RepoDashboard;
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/projects/kayron-hub/policy-registry-api/grpc']}>
      <Routes>
        <Route path="/projects/:projectId/:repoId/grpc" element={<GrpcPage />} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GrpcPage', () => {
  it('shows the endpoints of the deployed service with its address as the target', async () => {
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(withDeploy({ runId: 'r', specId: 's', url: 'http://dind:20059', kind: 'api', docsPath: null, healthcheckPath: null, services: null }));
    vi.spyOn(runApi, 'serviceStatus').mockResolvedValue({ online: true, status: 200, ui: false, docs: false, checkedAt: '2026-11-13T00:00:00.000Z' });
    vi.spyOn(runApi, 'grpcCatalog').mockResolvedValue({ source: 'reflection', services: [{ service: 'a.B', methods: [{ name: 'Get', requestType: 'a.Req', responseType: 'a.Res', template: '{}', streaming: false }] }] });
    renderPage();
    fireEvent.click(await screen.findByTestId('repo-grpc-method-Get'));
    expect(screen.getByTestId('repo-grpc-bar').textContent).toContain('dind:20059 / ');
    expect(screen.getByTestId('grpc-target').textContent).toBe('dind:20059');
    expect((await screen.findByTestId('grpc-status')).textContent).toBe('No ar');
    expect(screen.getByTestId('grpc-breadcrumb-repo').getAttribute('href')).toBe('/projects/kayron-hub/policy-registry-api');
  });

  it('says there is no deploy and links back to the repository', async () => {
    vi.spyOn(runApi, 'repositoryDashboard').mockResolvedValue(withDeploy(null));
    const catalog = vi.spyOn(runApi, 'grpcCatalog');
    renderPage();
    expect(await screen.findByTestId('grpc-no-deploy')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar ao repositório' }).getAttribute('href')).toBe('/projects/kayron-hub/policy-registry-api');
    expect(catalog).not.toHaveBeenCalled();
  });

  it('says the repository could not be read', async () => {
    vi.spyOn(runApi, 'repositoryDashboard').mockRejectedValue(new Error('500'));
    renderPage();
    expect((await screen.findByTestId('grpc-no-deploy')).textContent).toContain('sem dados');
  });
});
