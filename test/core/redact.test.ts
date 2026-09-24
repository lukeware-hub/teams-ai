import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../../server/core/redact.js';

describe('redactSecrets', () => {
  it('replaces every known value, longest first', () => {
    const out = redactSecrets('token=abc123xyz and short=abc123', ['abc123', 'abc123xyz']);
    expect(out).toBe(`token=${REDACTED} and short=${REDACTED}`);
  });

  it('ignores known values too short to be secrets', () => {
    expect(redactSecrets('port 80 open', ['80'])).toBe('port 80 open');
  });

  it('masks well-known credential shapes without registration', () => {
    const text = [
      'ANTHROPIC_AUTH_TOKEN=sk-ant-api03-abcdefghijklmnop',
      'export GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x',
      'DATABASE_URL=postgres://app:s3cr3tpass@db:5432/x',
      'aws AKIAIOSFODNN7EXAMPLE',
    ].join('\n');
    const out = redactSecrets(text);
    expect(out).not.toMatch(/sk-ant-|ghp_|eyJhbGci|s3cr3tpass|AKIAIOSFODNN7EXAMPLE/);
    expect(out).toContain(`ANTHROPIC_AUTH_TOKEN=${REDACTED}`);
    expect(out).toContain(`postgres://app:${REDACTED}@db:5432/x`);
    expect(out).toContain(`Bearer ${REDACTED}`);
  });

  it('leaves ordinary output untouched', () => {
    const text = 'FAIL src/a.test.ts\n  expected 1 to be 2\nnpm ERR! code ELIFECYCLE';
    expect(redactSecrets(text, [])).toBe(text);
  });
  it('masks an OpenRouter key even when it was not registered', () => {
    const key = 'sk-or-v1-' + 'a1'.repeat(32);
    expect(redactSecrets(`401 for ${key}`)).toBe('401 for [REDACTED]');
  });
});
