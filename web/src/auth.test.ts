import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authFetch, getToken } from './auth.js';

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

const auth = (f: { mock: { calls: unknown[][] } }, i: number) => new Headers((f.mock.calls[i]![1] as RequestInit | undefined)?.headers).get('authorization');

describe('authFetch', () => {
  it('sends no header without a token and does not prompt on success', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const p = vi.spyOn(globalThis, 'prompt').mockReturnValue(null);
    await authFetch('/api/x');
    expect(auth(f, 0)).toBeNull();
    expect(p).not.toHaveBeenCalled();
  });
  it('prompts once on 401, stores the token and retries with the bearer', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValue(new Response('{}', { status: 200 }));
    vi.spyOn(globalThis, 'prompt').mockReturnValue('tok');
    expect((await authFetch('/api/x')).status).toBe(200);
    expect(getToken()).toBe('tok');
    expect(auth(f, 1)).toBe('Bearer tok');
    await authFetch('/api/y');
    expect(auth(f, 2)).toBe('Bearer tok');
  });
  it('returns the 401 when the prompt is dismissed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    vi.spyOn(globalThis, 'prompt').mockReturnValue(null);
    expect((await authFetch('/api/x')).status).toBe(401);
    expect(getToken()).toBeNull();
  });
});
