import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('theme before first paint', () => {
  it('has no inline script in index.html, since the server allows only script files from itself', () => {
    const html = readFileSync(path.resolve('index.html'), 'utf8');
    expect(html.match(/<script(?![^>]*\ssrc=)/g)).toBeNull();
  });

  it('applies the saved theme from its own script file in public', () => {
    const script = readFileSync(path.resolve('public/theme-init.js'), 'utf8');
    expect(script).toContain("localStorage.getItem('teams-ai.theme')");
    expect(script).toContain('document.documentElement.dataset.theme');
  });
});
