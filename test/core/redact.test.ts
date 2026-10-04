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

describe('redactSecrets gaps (audit L5)', () => {
  it('masks short known values only as whole tokens', () => {
    expect(redactSecrets('pw=abc and abcd and xabcx', ['abc'])).toBe(`pw=${REDACTED} and abcd and xabcx`);
    expect(redactSecrets('a b ab', ['a', 'ab'])).toBe('a b ab');
  });
  it('masks URL-encoded and base64 forms of a known value, in any byte alignment', () => {
    const value = 'p@ss w0rd/s3cret+x';
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    expect(redactSecrets(`q=${encodeURIComponent(value)}`, [value])).toBe(`q=${REDACTED}`);
    expect(redactSecrets(`auth ${b64(value)}`, [value])).toBe(`auth ${REDACTED}`);
    for (const prefix of ['', 'u:', 'us:', 'usr:']) {
      const out = redactSecrets(`Authorization: Basic ${b64(prefix + value)}`, [value]);
      expect(out, prefix).not.toContain(b64(prefix + value));
    }
    expect(redactSecrets(b64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), [value])).toBe(REDACTED);
  });
  it('masks more generic key shapes without registration', () => {
    const samples = [
      'AIza' + 'A'.repeat(35),
      'xoxb-1234567890-abcdefghij',
      'sk_live_' + 'a1'.repeat(10),
      'npm_' + 'a'.repeat(36),
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIB\nabc\n-----END RSA PRIVATE KEY-----',
      'password: hunter2hunter',
      '{"api_key":"zzzzzzzzzzzz"}',
      'x-api-key=abcdef123456',
    ];
    for (const s of samples) {
      const out = redactSecrets(`log ${s} end`);
      expect(out, s).toContain(REDACTED);
      expect(out, s).not.toMatch(/AIzaAAAA|xoxb-123|sk_live_a1|npm_aaaa|eyJhbGci|MIIB|hunter2hunter|zzzzzz|abcdef123456/);
    }
  });
  it('does not mangle ordinary key-like prose', () => {
    expect(redactSecrets('token: 5 and secret=ok')).toBe('token: 5 and secret=ok');
  });
});
