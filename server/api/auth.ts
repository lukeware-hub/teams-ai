import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const TOKEN_ENV = 'TEAMS_AI_UI_TOKEN';
export const SESSION_COOKIE = 'teams_ai_session';
export const SESSION_PATH = '/api/auth/session';

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Constant-time comparison: both sides are hashed so the lengths always match. */
export function tokenEquals(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Returns the effective token (null = auth disabled) or throws when the configuration is unsafe. */
export function resolveAuth(token: string | undefined, host: string, warn: (line: string) => void): string | null {
  if (token) return token;
  if (!isLoopbackHost(host)) throw new Error(`refusing to listen on ${host} without ${TOKEN_ENV}: set a bearer token or bind to loopback`);
  warn(`warning: ${TOKEN_ENV} is not set; the API is unauthenticated (loopback only)`);
  return null;
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function bearerOk(req: IncomingMessage, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return m !== null && tokenEquals(m[1]!, token);
}

/** The cookie is accepted on GET only (SSE); it is SameSite=Strict, so it is never a CSRF vector for mutations. */
export function requestAuthorized(req: IncomingMessage, token: string): boolean {
  if (bearerOk(req, token)) return true;
  if (req.method !== 'GET') return false;
  const c = cookieValue(req, SESSION_COOKIE);
  if (c === null) return false;
  try {
    return tokenEquals(decodeURIComponent(c), token);
  } catch {
    return false;
  }
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}
