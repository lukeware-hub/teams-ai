import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const taskfile = YAML.parse(await fs.readFile('Taskfile.yml', 'utf8')) as { tasks: Record<string, any> };
const compose = YAML.parse(await fs.readFile('docker-compose.yml', 'utf8')) as { volumes: Record<string, unknown> };
const text = (name: string) => JSON.stringify(taskfile.tasks[name]);

describe('backup and restore tasks (R7.6)', () => {
  it('has both tasks, each refusing to run while the platform is up', () => {
    for (const name of ['backup', 'restore']) {
      expect(taskfile.tasks[name], name).toBeDefined();
      expect(JSON.stringify(taskfile.tasks[name].preconditions), name).toContain('docker compose ps -q');
    }
  });

  it('refuses to restore without an explicit FORCE=yes and without a folder', () => {
    const pre = JSON.stringify(taskfile.tasks.restore.preconditions);
    expect(pre).toContain('FORCE');
    expect(pre).toContain('DIR');
  });

  it('covers the volumes of the compose file that hold state', () => {
    expect(Object.keys(compose.volumes)).toEqual(['teams-ai-data', 'teams-ai-claude', 'teams-ai-gh', 'dind-data']);
    for (const volume of ['teams-ai-data', 'teams-ai-claude', 'teams-ai-gh']) {
      expect(text('backup'), volume).toContain(volume);
      expect(text('restore'), volume).toContain(volume);
    }
  });

  it('keeps backups out of git', async () => {
    expect(await fs.readFile('.gitignore', 'utf8')).toMatch(/^backups\/$/m);
  });
});
