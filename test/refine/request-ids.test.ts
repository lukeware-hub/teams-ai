import { describe, expect, it } from 'vitest';
import { requestDraftId } from '../../server/refine/registry.js';

describe('the id of a follow-on request', () => {
  it('is the project name and the request number', () => {
    expect(requestDraftId('hello-app', 1)).toBe('hello-app-pedido-1');
  });

  it('keeps at most 40 characters, cutting the project part and never leaving a dash behind', () => {
    const id = requestDraftId('projeto-com-um-nome-bem-mais-longo-que-quarenta', 12);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id.endsWith('-pedido-12')).toBe(true);
    expect(id).not.toContain('--');
  });
});
