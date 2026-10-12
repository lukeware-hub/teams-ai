import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const read = (file: string) => fs.readFile(file, 'utf8');
const taskfile = YAML.parse(await read('Taskfile.yml')) as { tasks: Record<string, any> };

describe('Taskfile.yml (R9.4)', () => {
  it('pulls the prebuilt image before `up` and `start`, and never forces a build', () => {
    expect(taskfile.tasks.pull.cmds).toEqual(['docker compose pull --ignore-pull-failures']);
    for (const name of ['up', 'start']) {
      const cmds = JSON.stringify(taskfile.tasks[name].cmds);
      expect(cmds, name).toContain('"task":"pull"');
      expect(cmds, name).not.toContain('--build');
    }
  });

  it('builds from source under the local tag with `up:source`', () => {
    expect(taskfile.tasks['up:source'].env).toEqual({ TEAMS_AI_IMAGE: 'teams-ai:local' });
    expect(taskfile.tasks['up:source'].cmds).toEqual(['docker compose up -d --build']);
  });
});
