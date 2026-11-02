import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('live-check:converge script', () => {
  it('points to a script file that exists', async () => {
    const pkg = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')) as { scripts: Record<string, string> };
    const command = pkg.scripts['live-check:converge'];
    expect(command).toBe('node scripts/live-check/converge.mjs');
    await expect(fs.access(path.resolve('scripts/live-check/converge.mjs'))).resolves.toBeUndefined();
  });
});

describe('docs repository layout flag', () => {
  it('is listed in .env.example with the default on', async () => {
    const lines = (await fs.readFile(path.resolve('.env.example'), 'utf8')).split('\n');
    expect(lines).toContain('TEAMS_AI_DOCS_REPO_LAYOUT=1');
  });

  it('sets the compose default to 1, and the code default stays off when the variable is unset', async () => {
    const compose = await fs.readFile(path.resolve('docker-compose.yml'), 'utf8');
    expect(compose).toContain('TEAMS_AI_DOCS_REPO_LAYOUT: ${TEAMS_AI_DOCS_REPO_LAYOUT:-1}');
  });
});
