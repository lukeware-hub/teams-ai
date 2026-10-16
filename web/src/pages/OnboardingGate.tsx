import { useEffect, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api.js';
import { Loading } from '../components/Loading.js';

/** Renders children only while the environment is incomplete; otherwise redirects. */
export function OnboardingGate({ children, completeTo = '/settings' }: { children: ReactNode; completeTo?: string }) {
  const [allOk, setAllOk] = useState<boolean | null>(null);
  useEffect(() => {
    void api.status().then((s) => setAllOk(s.allOk)).catch(() => setAllOk(false));
  }, []);
  if (allOk === null) return <main><Loading /></main>;
  if (allOk) return <Navigate to={completeTo} replace />;
  return children;
}

/** Manual /status: settings when complete, onboarding when not. */
export function StatusRedirect() {
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    void api.status().then((s) => setTo(s.allOk ? '/settings' : '/onboarding')).catch(() => setTo('/onboarding'));
  }, []);
  return to ? <Navigate to={to} replace /> : <main><Loading /></main>;
}
