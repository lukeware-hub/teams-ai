import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const taskfile = YAML.parse(await fs.readFile('Taskfile.yml', 'utf8')) as { tasks: Record<string, any> };
const compose = YAML.parse(await fs.readFile('docker-compose.yml', 'utf8')) as { services: Record<string, { ports?: string[] }> };
const tunnel = YAML.parse(await fs.readFile('cloudflared.yml', 'utf8')) as { ingress: { service: string }[] };

describe('Cloudflare tunnel tasks', () => {
  it('has the setup, start and stop tasks, and start and stop run on Windows only', () => {
    expect(taskfile.tasks['tunnel:setup']).toBeDefined();
    for (const name of ['tunnel:start', 'tunnel:stop']) expect(taskfile.tasks[name].platforms, name).toEqual(['windows']);
    expect(JSON.stringify(taskfile.tasks['tunnel:start'].cmds)).toContain('{{.TUNNEL_HOST}}');
  });

  it('forwards the tunnel to the port the UI publishes on the host', () => {
    expect(compose.services['teams-ai'].ports).toContain('${TEAMS_AI_UI_BIND:-127.0.0.1}:8787:8787');
    expect(tunnel.ingress[0].service).toBe('http://localhost:8787');
  });
});
