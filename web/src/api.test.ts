import { afterEach, describe, expect, it, vi } from 'vitest';
import { refineApi } from './api.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refineApi.scoreDoc', () => {
  it('posts the score of one named document of a refinement', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(refineApi.scoreDoc('shop', 'shop-002', 'stack.md')).resolves.toEqual({ ok: true });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/refine/shop/shop-002/docs/stack.md/score');
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });
});
