import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { refineApi, runApi } from './api.js';
import { Onboarding } from './pages/Onboarding.js';
import { Projects } from './pages/Projects.js';
import { RefinementPage } from './pages/Refinement.js';
import { RunPage } from './pages/Run.js';
import { StatusPage } from './pages/StatusPage.js';
import { ValidationPage } from './pages/Validation.js';

export function Home() {
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([runApi.projects(), refineApi.list().catch(() => [])])
      .then(([p, d]) => setTo(p.length > 0 || d.length > 0 ? '/projects' : '/onboarding'))
      .catch(() => setTo('/onboarding'));
  }, []);
  return to ? <Navigate to={to} replace /> : <p>Loading…</p>;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/runs/:runId" element={<RunPage />} />
        <Route path="/refine/:projectId/:specId" element={<RefinementPage />} />
        <Route path="/runs/:runId/validation" element={<ValidationPage />} />
      </Routes>
    </BrowserRouter>
  );
}
