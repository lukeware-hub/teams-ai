import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Onboarding } from './pages/Onboarding.js';
import { StatusPage } from './pages/StatusPage.js';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/onboarding" replace />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/status" element={<StatusPage />} />
      </Routes>
    </BrowserRouter>
  );
}
