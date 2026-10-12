import { expect, it } from 'vitest';
import { cloneFailure } from '../../server/api/run-routes.js';

it('tells a private repository apart from a network failure', () => {
  expect(cloneFailure("fatal: could not read Username for 'https://github.com'")).toContain('GITHUB_TOKEN');
  expect(cloneFailure('fatal: Could not resolve host: github.com')).toContain('conexão');
  expect(cloneFailure('boom')).toBe('não foi possível clonar o repositório');
});
