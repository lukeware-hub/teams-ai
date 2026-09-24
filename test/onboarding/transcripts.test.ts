import { describe, expect, it } from 'vitest';
import { TranscriptReader, extractOneTimeCode, extractUrl, isPasteCodePrompt, isSuccessLine, stripAnsi } from '../../server/onboarding/transcripts.js';

const GH = `! First copy your one-time code: A1EB-D4E0\nPress Enter to open https://github.com/login/device in your browser...\n`;
const GH_OLD = `! One-time code (A1EB-D4E0) copied to clipboard\nPress Enter to open https://github.com/login/device in your browser... `;
const CLAUDE = `Opening browser to sign in…\n\x1b[1mhttps://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=Uf52\x1b[0m\n\nPaste code here if prompted > `;

describe('transcript helpers', () => {
  it('strips ANSI and extracts the first https URL without trailing punctuation', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[0m')).toBe('bold');
    expect(extractUrl(GH)).toBe('https://github.com/login/device');
    expect(extractUrl(CLAUDE)).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=Uf52');
    expect(extractUrl('no links here')).toBeNull();
  });

  it('extracts the gh one-time code in both wordings and detects the claude paste prompt and success lines', () => {
    expect(extractOneTimeCode(GH)).toBe('A1EB-D4E0');
    expect(extractOneTimeCode(GH_OLD)).toBe('A1EB-D4E0');
    expect(extractOneTimeCode(CLAUDE)).toBeNull();
    expect(isPasteCodePrompt(CLAUDE)).toBe(true);
    expect(isPasteCodePrompt(GH)).toBe(false);
    expect(isSuccessLine('gh', '✓ Logged in as lukeware70X7')).toBe(true);
    expect(isSuccessLine('claude', 'Login successful. Welcome back!')).toBe(true);
    expect(isSuccessLine('claude', 'Press Enter')).toBe(false);
  });
});

describe('TranscriptReader', () => {
  it('accumulates state across chunks split mid-line and redacts known values in the returned chunk and tail', () => {
    const known = ['s3cr3t-token-value'];
    const r = new TranscriptReader('gh', () => known);
    expect(r.push('! First copy your one-time co')).toBe('! First copy your one-time co');
    r.push('de: A1EB-D4E0\nPress Enter to open https://github.com/login/dev');
    r.push('ice in your browser...\n');
    expect(r.state).toEqual({ url: 'https://github.com/login/device', code: 'A1EB-D4E0', pasteCodePrompt: false, success: false });
    expect(r.push('token s3cr3t-token-value rejected\n')).toBe('token [REDACTED] rejected\n');
    expect(r.tail).not.toContain('s3cr3t-token-value');
    r.push('✓ Logged in as lukeware70X7\n');
    expect(r.state.success).toBe(true);
  });

  it('keeps only the last 4096 characters in the tail', () => {
    const r = new TranscriptReader('claude', () => []);
    r.push('x'.repeat(5000));
    expect(r.tail).toHaveLength(4096);
  });
});
