import { describe, expect, it } from 'vitest';
import { LocalStubBackend } from '../../server/decide/local-stub.js';

describe('LocalStubBackend', () => {
  it('is named local and always reports unavailable', async () => {
    const b = new LocalStubBackend();
    expect(b.name).toBe('local');
    const r = await b.evaluate({ state: 's', questions: {}, escalateTo: 'test' });
    expect(r).toEqual({ ok: false, reason: 'unavailable', message: expect.stringContaining('phase 2') });
  });
});
