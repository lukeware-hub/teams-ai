import { describe, expect, it } from 'vitest';
import { DockerLocalTarget, platformComposeProject, renderPlatform, serviceComposeProject, sharedNetwork } from '../../server/deploy/docker-local.js';

describe('names of a project of services', () => {
  it('gives every service, the platform and the network a name no other project can take', () => {
    expect(serviceComposeProject('shop', 'orders')).toBe('teams-ai-shop--orders');
    expect(platformComposeProject('shop')).toBe('teams-ai-shop_platform');
    expect(sharedNetwork('shop')).toBe('teams-ai-shop_net');
  });
});

describe('renderPlatform', () => {
  it('renders each container on the shared network under its own name, with its healthcheck', () => {
    const file = JSON.parse(renderPlatform([{ name: 'nats', image: 'nats:2.10.22-alpine', command: ['-js', '-m', '8222'], healthcheck: ['CMD', 'wget', '-q', '--spider', 'http://localhost:8222/healthz'] }], 'teams-ai-shop_net'));
    expect(file).toEqual({
      services: {
        nats: {
          image: 'nats:2.10.22-alpine',
          command: ['-js', '-m', '8222'],
          healthcheck: { test: ['CMD', 'wget', '-q', '--spider', 'http://localhost:8222/healthz'], interval: '2s', timeout: '5s', retries: 60, start_period: '20s' },
          restart: 'unless-stopped',
          networks: { shared: { aliases: ['nats'] } },
        },
      },
      networks: { shared: { name: 'teams-ai-shop_net', external: true } },
    });
  });

  it('keeps every value literal: compose would read a $ as a variable of the orchestrator', () => {
    const file = JSON.parse(renderPlatform([{ name: 'db', image: 'postgres:16.4', command: ['postgres', '-c', 'log_line_prefix=$x'], environment: { POSTGRES_PASSWORD: 'pa$word' }, healthcheck: ['CMD-SHELL', 'pg_isready -U $POSTGRES_USER'] }], 'net'));
    expect(file.services.db.command).toEqual(['postgres', '-c', 'log_line_prefix=$$x']);
    expect(file.services.db.environment).toEqual({ POSTGRES_PASSWORD: 'pa$$word' });
    expect(file.services.db.healthcheck.test).toEqual(['CMD-SHELL', 'pg_isready -U $$POSTGRES_USER']);
  });
});

describe('platformRequest', () => {
  it('runs curl on the shared network and sends the headers and the body through stdin, never the command line', async () => {
    const seen: Array<{ args: string[]; stdin?: string }> = [];
    const exec = (async (spec: { args: string[]; stdin?: string }) => { seen.push(spec); return { exitCode: 0, stdout: '{"ok":true}\n201', stderr: '' }; }) as never;
    const target = new DockerLocalTarget({ exec, get: async () => null, secrets: {} });
    const res = await target.platformRequest('shop', { method: 'POST', url: 'http://platform-keycloak:8080/x', headers: { authorization: 'Bearer s3cret' }, body: 'a="b"' });
    expect(res).toEqual({ status: 201, body: '{"ok":true}' });
    expect(seen[0]!.args.join(' ')).toContain('--network teams-ai-shop_net');
    expect(seen[0]!.args.join(' ')).not.toContain('s3cret');
    expect(seen[0]!.stdin).toContain('header = "authorization: Bearer s3cret"');
    expect(seen[0]!.stdin).toContain('data-binary = "a=\\"b\\""');
  });

  it('says why when docker or curl fails', async () => {
    const exec = (async () => ({ exitCode: 6, stdout: '', stderr: 'curl: (6) Could not resolve host' })) as never;
    const target = new DockerLocalTarget({ exec, get: async () => null, secrets: {} });
    await expect(target.platformRequest('shop', { method: 'GET', url: 'http://platform-keycloak:8080/x' })).rejects.toThrow('Could not resolve host');
  });
});

describe('startPlatform', () => {
  const db = { name: 'db', image: 'postgres:16.4' };
  const run = (upExits: number[]) => {
    const seen: string[] = [];
    const exec = (async (spec: { args: string[] }) => {
      const verb = spec.args.includes('up') ? 'up' : spec.args.includes('down') ? 'down' : spec.args[0];
      seen.push(verb!);
      return { exitCode: verb === 'up' ? upExits.shift()! : 0, stdout: '', stderr: 'unhealthy' };
    }) as never;
    return { seen, target: new DockerLocalTarget({ exec, get: async () => null, secrets: {} }) };
  };

  it('starts the platform again once after an unhealthy start', async () => {
    const { seen, target } = run([1, 0]);
    expect((await target.startPlatform('shop', [db])).ok).toBe(true);
    expect(seen.filter((v) => v === 'up')).toHaveLength(2);
    expect(seen.filter((v) => v === 'down')).toHaveLength(1);
  });

  it('gives up after the second unhealthy start and tears the platform down', async () => {
    const { seen, target } = run([1, 1]);
    expect((await target.startPlatform('shop', [db])).ok).toBe(false);
    expect(seen.filter((v) => v === 'down')).toHaveLength(2);
  });
});
