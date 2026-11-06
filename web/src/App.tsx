import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { PROJECTS, executionPath } from './routes.js';
import { api } from './api.js';
import { Loading } from './components/Loading.js';
import { AppShell } from './components/AppShell.js';
import { ChatPage } from './pages/Chat.js';
import { CostsPage } from './pages/Costs.js';
import { CostsProjectPage } from './pages/CostsProject.js';
import { LicenseGuard } from './pages/LicenseGuard.js';
import { Onboarding } from './pages/Onboarding.js';
import { OnboardingGate, StatusRedirect } from './pages/OnboardingGate.js';
import { ProjectHub } from './pages/ProjectHub.js';
import { ProjectGraph } from './pages/ProjectGraph.js';
import { RepositoryPage } from './pages/RepositoryPage.js';
import { Projects } from './pages/Projects.js';
import { RefinementPage } from './pages/Refinement.js';
import { RunPage } from './pages/Run.js';
import { SettingsPage } from './pages/Settings.js';
import { ValidationPage } from './pages/Validation.js';

export function Home() {
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    void api.status()
      .then((s) => setTo(s.allOk ? PROJECTS : '/onboarding'))
      .catch(() => setTo('/onboarding'));
  }, []);
  return to ? <Navigate to={to} replace /> : <main data-testid="home-loading"><Loading /></main>;
}

/** The old execution address: the project follows the execution now. */
export function ExecutionRedirect() {
  const { projectId = '' } = useParams();
  return <Navigate to={executionPath(projectId)} replace />;
}

export function NotFound() {
  return (
    <main data-testid="not-found" className="grid gap-3">
      <h1>Página não encontrada</h1>
      <p>Esse endereço não existe.</p>
      <Link className="link-button justify-self-start" to={PROJECTS}>Voltar para projetos</Link>
    </main>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <LicenseGuard>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/onboarding" element={<OnboardingGate><Onboarding /></OnboardingGate>} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/costs" element={<CostsPage />} />
            <Route path="/costs/:projectId" element={<CostsProjectPage />} />
            <Route path="/status" element={<StatusRedirect />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:projectId" element={<ProjectHub />} />
            <Route path="/graph/:projectId" element={<ProjectGraph />} />
            <Route path="/projects/:projectId/:repoId" element={<RepositoryPage />} />
            <Route path="/runs/:runId" element={<RunPage />} />
            <Route path="/refine/:projectId/:specId" element={<RefinementPage />} />
            <Route path="/refine/:projectId/:specId/program" element={<ExecutionRedirect />} />
            <Route path="/runs/:runId/validation" element={<ValidationPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </LicenseGuard>
      </AppShell>
    </BrowserRouter>
  );
}
