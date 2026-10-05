import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const compose = YAML.parse(await fs.readFile('docker-compose.yml', 'utf8')) as { services: Record<string, any> };
const platform = compose.services['teams-ai'];
const dind = compose.services.dind;

describe('docker-compose.yml (audit H4)', () => {
  it('never mounts the host docker socket nor runs privileged', () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      expect((svc.volumes ?? []).join(' '), name).not.toMatch(/docker\.sock/);
      expect(svc.privileged, name).not.toBe(true);
    }
    expect(platform.group_add).toBeUndefined();
  });

  it('points the orchestrator at the nested rootless daemon, reachable only inside the compose network', () => {
    expect(platform.environment.DOCKER_HOST).toBe('tcp://dind:2375');
    expect(dind.image).toMatch(/dind-rootless/);
    expect(dind.ports).toBeUndefined();
    expect(platform.depends_on.dind.condition).toBe('service_healthy');
  });

  it('shares the data volume at the same path, so bind sources need no rewrite', () => {
    expect(platform.volumes).toContain('teams-ai-data:/home/node/.teams-ai');
    expect(dind.volumes).toContain('teams-ai-data:/home/node/.teams-ai');
  });

  it('publishes the UI on the host loopback only and drops every capability', () => {
    expect(platform.ports).toEqual(['127.0.0.1:8787:8787']);
    expect(platform.cap_drop).toEqual(['ALL']);
  });

  it('seeds a config that reaches the service through dind without a bind rewrite', async () => {
    const seed = JSON.parse(await fs.readFile('docker/config.json', 'utf8'));
    expect(seed.docker.serviceHost).toBe('dind');
    expect(seed.docker.bindRewrite).toBeUndefined();
  });
});
