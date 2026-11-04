import { afterEach, describe, expect, it, vi } from 'vitest';
import { runApi } from '../../api.js';

afterEach(() => vi.restoreAllMocks());

describe('rebuildProjectGraph', () => {
  it('posts with the JSON content type the server requires', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await runApi.rebuildProjectGraph('hello-word');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/projects/hello-word/graph/rebuild');
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });
  });
});
