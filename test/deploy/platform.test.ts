import { describe, expect, it } from 'vitest';
import { platformComposeProject, renderPlatform, serviceComposeProject, sharedNetwork } from '../../server/deploy/docker-local.js';

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
          healthcheck: { test: ['CMD', 'wget', '-q', '--spider', 'http://localhost:8222/healthz'], interval: '2s', timeout: '5s', retries: 30 },
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
