import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { runApi } from './api.js';
import { Onboarding } from './pages/Onboarding.js';
import { Projects } from './pages/Projects.js';
import { RefinementPage } from './pages/Refinement.js';
import { RunPage } from './pages/Run.js';
import { StatusPage } from './pages/StatusPage.js';

export function Home() {
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    runApi
      .projects()
      .then((p) => setTo(p.length ? '/projects' : '/onboarding'))
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
      </Routes>
    </BrowserRouter>
  );
}
