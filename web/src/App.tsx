import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api.js';
import { Loading } from './components/Loading.js';
import { AppShell } from './components/AppShell.js';
import { ChatPage } from './pages/Chat.js';
import { Onboarding } from './pages/Onboarding.js';
import { OnboardingGate, StatusRedirect } from './pages/OnboardingGate.js';
import { ProjectHub } from './pages/ProjectHub.js';
import { Projects } from './pages/Projects.js';
import { ProgramPage } from './pages/Program.js';
import { RefinementPage } from './pages/Refinement.js';
import { RunPage } from './pages/Run.js';
import { SettingsPage } from './pages/Settings.js';
import { ValidationPage } from './pages/Validation.js';

export function Home() {
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    void api.status()
      .then((s) => setTo(s.allOk ? '/projects' : '/onboarding'))
      .catch(() => setTo('/onboarding'));
  }, []);
  return to ? <Navigate to={to} replace /> : <main><Loading /></main>;
}

export function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/onboarding" element={<OnboardingGate><Onboarding /></OnboardingGate>} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/status" element={<StatusRedirect />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<ProjectHub />} />
          <Route path="/runs/:runId" element={<RunPage />} />
          <Route path="/refine/:projectId/:specId" element={<RefinementPage />} />
          <Route path="/refine/:projectId/:specId/program" element={<ProgramPage />} />
          <Route path="/runs/:runId/validation" element={<ValidationPage />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}
