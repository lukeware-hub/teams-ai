import { useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

// index.html applies the saved theme before the first paint; keep its key and rules in step with these.
const KEY = 'teams-ai.theme';

export function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'dark' || saved === 'system' ? saved : 'light';
  } catch {
    return 'light';
  }
}

const systemQuery = () => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);

function applyTheme(preference: ThemePreference) {
  const dark = preference === 'dark' || (preference === 'system' && systemQuery()?.matches === true);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function useThemePreference() {
  const [preference, setPreference] = useState(readThemePreference);
  useEffect(() => {
    applyTheme(preference);
    try {
      localStorage.setItem(KEY, preference);
    } catch {
      // Storage can be blocked (private window, cleared site data); the choice then lasts for this page only.
    }
    const query = preference === 'system' ? systemQuery() : null;
    if (!query) return;
    const follow = () => applyTheme('system');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [preference]);
  return [preference, setPreference] as const;
}
