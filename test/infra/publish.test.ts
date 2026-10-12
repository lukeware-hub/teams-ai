import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const read = (file: string) => fs.readFile(file, 'utf8');
const taskfile = YAML.parse(await read('Taskfile.yml')) as { tasks: Record<string, any> };
const ci = YAML.parse(await read('.github/workflows/ci.yml')) as { permissions: unknown; on: any; jobs: Record<string, any> };
const publish = ci.jobs.publish ?? { steps: [] };
const stepNames: string[] = publish.steps.map((s: { name: string }) => s.name);
const step = (name: string) => publish.steps.find((s: { name: string }) => s.name === name);

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

describe('.github/workflows/ci.yml publish job (R9.4)', () => {
  it('frees disk space before the build, since the image and its scan fill the runner', () => {
    expect(stepNames.indexOf('Free disk space')).toBeGreaterThan(-1);
    expect(stepNames.indexOf('Free disk space')).toBeLessThan(stepNames.indexOf('Build and push the commit tag'));
    expect(step('Free disk space').run).toContain('/usr/local/lib/android');
  });

  it('runs only on a push, after quality, and is the only job that can write packages', () => {
    expect(ci.on.push.tags).toEqual(['v*']);
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(publish.needs).toBe('quality');
    expect(publish.if).toBe("github.event_name == 'push'");
    expect(publish.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(ci.jobs.quality.permissions).toBeUndefined();
  });

  it('builds the amd64 image, scans, and only then moves latest or the version', () => {
    expect(step('Build and push the commit tag').with.platforms).toBe('linux/amd64');
    expect(step('Build and push the commit tag').with.tags).toBe('${{ env.IMAGE }}:${{ github.sha }}');
    expect(step('Scan for critical vulnerabilities').run).toContain('--severity CRITICAL --ignore-unfixed --exit-code 1');
    expect(stepNames.indexOf('Build and push the commit tag')).toBeLessThan(stepNames.indexOf('Scan for critical vulnerabilities'));
    expect(stepNames.indexOf('Scan for critical vulnerabilities')).toBeLessThan(stepNames.indexOf('Publish latest, or the version on a v* tag'));
    expect(step('Publish latest, or the version on a v* tag').run).toContain('docker buildx imagetools create');
  });

  it('pins every action by major tag', () => {
    for (const s of publish.steps.filter((x: { uses?: string }) => x.uses)) expect(s.uses, s.name).toMatch(/@v\d+$/);
  });
});

describe('the image carries no secret (R9.4)', () => {
  it('keeps the env files and the user config out of the build context', async () => {
    const ignored = (await read('.dockerignore')).split('\n');
    expect(ignored).toContain('.env*');
    expect(ignored).toContain('config.json');
  });

  it('never bakes a token, secret, password or key through ARG or ENV', async () => {
    expect(await read('Dockerfile')).not.toMatch(/^\s*(ARG|ENV)\s+\S*(TOKEN|SECRET|PASSWORD|KEY)/im);
  });
});
