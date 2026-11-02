import { describe, expect, it } from 'vitest';
import { findCredential } from '../../server/core/redact.js';

const SHAPES: Array<[kind: string, text: string]> = [
  ['GitHub token', `ghp_${'a1'.repeat(18)}`],
  ['GitHub fine-grained token', `github_pat_${'A'.repeat(22)}`],
  ['Anthropic key', `sk-ant-${'x'.repeat(20)}`],
  ['OpenRouter key', `sk-or-v1-${'b'.repeat(32)}`],
  ['AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
  ['Slack token', 'xoxb-1234567890-abcdef'],
  ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'],
];

describe('findCredential shapes', () => {
  it.each(SHAPES)('finds a %s and names it', (kind, text) => {
    expect(findCredential(`value ${text} end`)).toEqual({ kind });
  });

  it('does not flag a GitHub prefix with too few characters', () => {
    expect(findCredential('ghp_short')).toBeNull();
  });

  it('does not flag ordinary security prose', () => {
    expect(findCredential('password: argon2id is the default hash for stored passwords')).toBeNull();
  });
});

describe('findCredential known values', () => {
  it('finds a known value of 12 characters, plain and encoded', () => {
    const value = 'abc def/ghi1';
    expect(findCredential(`x ${value} y`, [value])).toEqual({ kind: 'known value' });
    expect(findCredential(`x ${encodeURIComponent(value)} y`, [value])).toEqual({ kind: 'known value' });
  });

  it('ignores a known value of 11 characters', () => {
    expect(findCredential('x abcdefghijk y', ['abcdefghijk'])).toBeNull();
  });
});

describe('findCredential result', () => {
  it('never contains the matched text', () => {
    const [, shape] = SHAPES[0]!;
    expect(JSON.stringify(findCredential(`leak ${shape}`))).not.toContain(shape);
    const value = 'abc def/ghi1';
    expect(JSON.stringify(findCredential(`x ${value}`, [value]))).not.toContain(value);
  });
});
