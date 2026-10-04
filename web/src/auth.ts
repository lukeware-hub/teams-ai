const KEY = 'teams-ai-ui-token';

function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  return store()?.getItem(KEY) ?? null;
}

export function clearToken(): void {
  store()?.removeItem(KEY);
}

/** Asks for the token once; the answer is kept in sessionStorage for the tab's lifetime. */
function promptToken(): string | null {
  const given = typeof globalThis.prompt === 'function' ? globalThis.prompt('Access token for the teams-ai UI (TEAMS_AI_UI_TOKEN)') : null;
  if (!given) return null;
  store()?.setItem(KEY, given);
  return given;
}

function withToken(init: RequestInit | undefined, token: string | null): RequestInit | undefined {
  if (!token) return init;
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/** fetch + bearer token; on 401 the token is dropped, asked again once and the request retried. */
export async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, withToken(init, getToken()));
  if (res.status !== 401) return res;
  clearToken();
  const token = promptToken();
  return token ? fetch(input, withToken(init, token)) : res;
}

/** EventSource cannot set headers: trade the token for an HttpOnly SameSite=Strict cookie before opening one. */
export async function ensureSession(): Promise<void> {
  await authFetch('/api/auth/session', { method: 'POST' }).catch(() => undefined);
}
