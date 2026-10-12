import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DockerLocalTarget, teardownProject } from '../../server/deploy/docker-local.js';
import type { DeploymentIntent, HttpGet } from '../../server/deploy/target.js';
import { dockerArgs } from '../../server/exec/gate-runner.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const intent: DeploymentIntent = { projectId: 'Todo-Api', image: 'todo-api', tag: 't1', port: 3000, healthcheckPath: '/health', manifests: [], secretNames: ['DATABASE_URL'], contextDir: '/ws/repo', compose: 'docker-compose.yml' };
const secrets = { DATABASE_URL: 'postgres://x' };
const okGet: HttpGet = async () => ({ status: 200 });
const mk = (fake: FakeExec) => new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
const P = 'compose -p teams-ai-todo-api -f /ws/repo/docker-compose.yml --project-directory /ws/repo';
/** What every compose call reads first: the service's name and its port mappings. */
const READ = [`${P} config --services`, `${P} config --format json`];

describe('DockerLocalTarget with a compose file', () => {
  it('validates with compose config', async () => {
    const fake = new FakeExec();
    expect(await mk(fake).validate(intent)).toEqual([]);
    expect(fake.lines('docker')).toEqual([...READ, `${P} config --quiet`]);
    const bad = new FakeExec().onArgs('docker', ['compose'], () => ({ exitCode: 1, stderr: 'yaml error' }));
    expect((await mk(bad).validate(intent))[0]).toContain('yaml error');
  });

  it('applies with up --build --wait, image tag and secrets via env only', async () => {
    const fake = new FakeExec().on((s) => s.args.includes('ps'), () => ({ stdout: 'abc\n' })).onArgs('docker', ['inspect'], () => ({ stdout: 'todo-api:old\n' }));
    const r = await mk(fake).apply(intent);
    expect(r.previous).toBe('todo-api:old');
    const up = fake.calls.find((c) => c.args.includes('up'))!;
    expect(up.args.join(' ')).toBe(`${P} up -d --build --wait`);
    expect(up.env).toEqual({ TEAMS_AI_IMAGE: 'todo-api:t1', DATABASE_URL: 'postgres://x' });
    expect(up.args.join(' ')).not.toContain('postgres://x');
    expect(fake.lines('docker').some((l) => l.startsWith('run '))).toBe(false);
  });

  it('throws when compose up fails', async () => {
    const fake = new FakeExec().on((s) => s.args.includes('up'), () => ({ exitCode: 1, stderr: 'unhealthy' }));
    await expect(mk(fake).apply(intent)).rejects.toThrow(/compose up failed: unhealthy/);
  });

  it('opens a docker failure with the last line of its stderr, where docker writes the cause', async () => {
    const stderr = '#0 building with "default" instance using docker driver\n#1 [internal] load build definition\nERROR: failed to solve: npm ci did not complete successfully\n';
    const fake = new FakeExec().on((s) => s.args.includes('up') || s.args[0] === 'build', () => ({ exitCode: 1, stderr }));
    const up = await mk(fake).apply(intent).catch((e: Error) => e.message);
    expect(String(up).split('\n')[0]).toBe('docker compose up failed: ERROR: failed to solve: npm ci did not complete successfully');
    expect(String(up)).toContain('#0 building with "default" instance');
    const build = await mk(fake).build({ ...intent, compose: undefined }).catch((e: Error) => e.message);
    expect(String(build).split('\n')[0]).toBe('docker build failed: ERROR: failed to solve: npm ci did not complete successfully');
  });

  it('rolls back to the previous tag, or takes the stack down when none', async () => {
    const fake = new FakeExec();
    await mk(fake).rollback(intent, 'todo-api:old');
    const up = fake.calls.find((c) => c.args.includes('up'))!;
    expect(up.args.join(' ')).toBe(`${P} up -d --no-build --wait`);
    expect(up.env?.TEAMS_AI_IMAGE).toBe('todo-api:old');
    const f2 = new FakeExec();
    await mk(f2).rollback(intent, '');
    expect(f2.lines('docker')).toEqual([...READ, `${P} down`]);
  });

  it('verify fails on an unhealthy compose healthcheck, passes when healthy plus HTTP ok', async () => {
    const f = (health: string) => new FakeExec().on((s) => s.args.includes('ps'), () => ({ stdout: 'abc\n' })).onArgs('docker', ['inspect'], () => ({ stdout: health }));
    expect(await mk(f('unhealthy')).verify(intent)).toMatchObject({ healthy: false });
    expect(await mk(f('healthy')).verify(intent)).toMatchObject({ healthy: true });
  });

  it('destroys with down -v', async () => {
    const fake = new FakeExec();
    await mk(fake).destroy(intent);
    expect(fake.lines('docker')).toEqual([...READ, `${P} down -v`]);
  });

  it('reports the service name URL and the project network for the smoke gate', async () => {
    const t = mk(new FakeExec());
    expect(await t.gateServiceUrl(intent)).toBe('http://Todo-Api:3000');
    expect(t.gateNetwork(intent)).toBe('teams-ai-todo-api_default');
    const { compose: _c, ...plain } = intent;
    expect(await t.gateServiceUrl(plain)).toBe('http://127.0.0.1:3000');
    expect(t.gateNetwork(plain)).toBeUndefined();
  });

  it('reaches the service on the container port compose maps to the published port', async () => {
    const config = JSON.stringify({ services: { 'Todo-Api': { ports: [{ target: 8080, published: '3000' }, { target: 9090, published: '9090' }] } } });
    const fake = new FakeExec().on((s) => s.args.includes('--format'), () => ({ stdout: config }));
    expect(await mk(fake).gateServiceUrl(intent)).toBe('http://Todo-Api:8080');
  });

  it('gate containers join the given network, else the default bridge', () => {
    const gate = { name: 'smoke', command: 'x', blocking: true, network: 'egress' as const, secrets: [] };
    const ctx = { worktree: '/w', image: 'img', junitPath: 'j', cpus: 1, memory: '1g', timeoutMs: 1, secrets: {}, containerName: 'c' };
    expect(dockerArgs(gate, { ...ctx, network: 'p_default' }).args).toContain('p_default');
    expect(dockerArgs(gate, ctx).args).toContain('bridge');
  });
});

describe('DockerLocalTarget: the compose service name', () => {

  it('uses the only service of the compose file when it is not named like the project (live: hello for hello-d7)', async () => {
    const fake = new FakeExec().on((s) => s.args.includes('--services'), () => ({ stdout: 'hello\n' })).on((s) => s.args.includes('ps'), () => ({ stdout: 'abc\n' })).onArgs('docker', ['inspect'], () => ({ stdout: 'healthy\n' }));
    const target = mk(fake);
    expect(await target.gateServiceUrl!({ ...intent, projectId: 'hello-d7' })).toBe('http://hello:3000');
    expect((await target.verify({ ...intent, projectId: 'hello-d7' })).healthy).toBe(true);
    expect(fake.lines('docker').find((l) => l.includes(' ps '))).toContain('ps -q hello');
  });

  it('prefers the service named like the project and falls back to the project id', async () => {
    const both = new FakeExec().on((s) => s.args.includes('--services'), () => ({ stdout: 'db\nTodo-Api\n' }));
    expect(await mk(both).gateServiceUrl!(intent)).toBe('http://Todo-Api:3000');
    const several = new FakeExec().on((s) => s.args.includes('--services'), () => ({ stdout: 'db\nweb\n' }));
    expect(await mk(several).gateServiceUrl!(intent)).toBe('http://Todo-Api:3000');
  });
});

describe('a service of a system of services', () => {
  const shared = { composeProject: 'teams-ai-shop--orders', network: 'teams-ai-shop_net', alias: 'orders' };
  const intent = { projectId: 'shop', image: 'orders', tag: 't1', port: 20001, healthcheckPath: '/health', manifests: [], secretNames: [], contextDir: '/ws/orders', compose: 'docker-compose.yml', shared };

  it("runs in its own compose project and joins only its main container to the shared network, under the service's name", async () => {
    // The main container is the compose service named like the service (the devops rule of R12.6); its database stays private.
    const seen: { file?: string; mode?: number; override?: unknown } = {};
    const fake = new FakeExec()
      .on((s) => s.args.includes('--services'), () => ({ stdout: 'orders\ndb\n' }))
      .on((s) => s.args.includes('up'), async (s) => {
        seen.file = s.args[s.args.lastIndexOf('-f') + 1]!;
        seen.mode = (await fs.stat(path.dirname(seen.file))).mode & 0o777;
        seen.override = parse(await fs.readFile(seen.file, 'utf8'), { logLevel: 'silent' });
        return { exitCode: 0 };
      });
    const target = new DockerLocalTarget({ exec: fake.exec, get: async () => ({ status: 200 }), secrets: {} });
    await target.apply(intent);
    const up = fake.calls.find((c) => c.args.includes('up'))!;
    expect(up.args.slice(0, 3)).toEqual(['compose', '-p', 'teams-ai-shop--orders']);
    expect(seen.override).toEqual({
      services: { orders: { networks: { default: {}, shared: { aliases: ['orders'] } } } },
      networks: { shared: { name: 'teams-ai-shop_net', external: true } },
    });
    // A private directory of its own, gone once compose read it: another user could swap a fixed name in a shared /tmp.
    expect(path.dirname(seen.file!)).not.toBe(os.tmpdir());
    expect(seen.mode).toBe(0o700);
    await expect(fs.access(seen.file!)).rejects.toThrow();
    expect(target.gateNetwork(intent)).toBe('teams-ai-shop_net');
    expect(await target.gateServiceUrl(intent)).toBe('http://orders:20001');
  });

  it('creates the shared network when it is missing and starts the platform before the services', async () => {
    const seen: { file?: string; mode?: number } = {};
    const fake = new FakeExec()
      .onArgs('docker', ['network', 'inspect'], () => ({ exitCode: 1 }))
      .onArgs('docker', ['compose'], async (s) => {
        seen.file = s.args[s.args.indexOf('-f') + 1]!;
        seen.mode = (await fs.stat(path.dirname(seen.file))).mode & 0o777;
        return { exitCode: 0 };
      });
    const target = new DockerLocalTarget({ exec: fake.exec, get: async () => ({ status: 200 }), secrets: {} });
    expect(await target.startPlatform('shop', [{ name: 'nats', image: 'nats:2.10.22-alpine' }])).toEqual({ ok: true, detail: 'platform up' });
    const lines = fake.lines('docker');
    expect(lines[1]).toBe('network create teams-ai-shop_net');
    expect(lines[2]).toMatch(/^compose -p teams-ai-shop_platform -f \S+ up -d --wait --remove-orphans$/);
    expect(path.dirname(seen.file!)).not.toBe(os.tmpdir());
    expect(seen.mode).toBe(0o700);
    await expect(fs.access(seen.file!)).rejects.toThrow();
  });

  it('starts the platform without leftovers, and takes a platform that did not come up down again', async () => {
    const fake = new FakeExec().onArgs('docker', ['compose'], (s) => (s.args.includes('up') ? { exitCode: 1, stderr: 'nats unhealthy' } : { exitCode: 0 }));
    const target = new DockerLocalTarget({ exec: fake.exec, get: async () => ({ status: 200 }), secrets: {} });
    expect(await target.startPlatform('shop', [{ name: 'nats', image: 'nats:2.10.22-alpine' }])).toEqual({ ok: false, detail: 'docker compose up failed: nats unhealthy' });
    expect(fake.lines('docker').at(-1)).toBe('compose -p teams-ai-shop_platform down');
  });

  it('also takes down a service the project no longer lists, found by the prefix of its compose project', async () => {
    const fake = new FakeExec().onArgs('docker', ['compose', 'ls'], () => ({ stdout: JSON.stringify([{ Name: 'teams-ai-shop--orders' }, { Name: 'teams-ai-shop--legacy' }, { Name: 'teams-ai-shopx--orders' }, { Name: 'teams-ai-shop_platform' }]) }));
    await teardownProject(fake.exec, 'shop', ['orders']);
    expect(fake.lines('docker')).toEqual([
      'compose -p teams-ai-shop down -v',
      'compose ls -a --format json',
      'compose -p teams-ai-shop--orders down -v',
      'compose -p teams-ai-shop--legacy down -v',
      'compose -p teams-ai-shop_platform down -v',
      'network rm teams-ai-shop_net',
    ]);
  });

  it('takes down every compose project and the network of a project of services, and only its own project otherwise', async () => {
    const fake = new FakeExec();
    await teardownProject(fake.exec, 'shop', ['orders', 'inventory']);
    expect(fake.lines('docker')).toEqual([
      'compose -p teams-ai-shop down -v',
      'compose ls -a --format json',
      'compose -p teams-ai-shop--orders down -v',
      'compose -p teams-ai-shop--inventory down -v',
      'compose -p teams-ai-shop_platform down -v',
      'network rm teams-ai-shop_net',
    ]);
    const single = new FakeExec();
    await teardownProject(single.exec, 'todo-api', []);
    expect(single.lines('docker')).toEqual(['compose -p teams-ai-todo-api down -v']);
  });
});

describe('the host port of a compose service', () => {
  /** The `-f` override file the `up` call received, parsed; the `config` call answers with the given mappings. */
  const upOverride = async (mappings: unknown[] | null, port = 3000) => {
    let seen: unknown;
    const fake = new FakeExec()
      .on((s) => s.args.includes('--services'), () => ({ stdout: 'Todo-Api\n' }))
      .on((s) => s.args.includes('--format'), () => (mappings ? { stdout: JSON.stringify({ services: { 'Todo-Api': { ports: mappings } } }) } : { exitCode: 1, stderr: 'bad file' }))
      .on((s) => s.args.includes('up'), async (s) => {
        const i = s.args.lastIndexOf('-f');
        seen = s.args[i + 1] !== '/ws/repo/docker-compose.yml' ? parse(await fs.readFile(s.args[i + 1]!, 'utf8'), { logLevel: 'silent' }) : null;
        return { exitCode: 0 };
      });
    await new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets }).apply({ ...intent, port });
    return seen;
  };
  const ports = (o: unknown) => (o as { services: Record<string, { ports: string[] }> }).services['Todo-Api']!.ports;

  it('is the assigned port, whatever port the imported file publishes', async () => {
    expect(ports(await upOverride([{ target: 8000, published: '8000' }]))).toEqual(['3000:8000']);
  });
  it('keeps the container port of the mapping already published as the assigned port, and the other mappings as they are', async () => {
    expect(ports(await upOverride([{ target: 9090, published: '9090', host_ip: '127.0.0.1' }, { target: 8080, published: '3000' }]))).toEqual(['127.0.0.1:9090:9090', '3000:8080']);
  });
  it('takes the first of several mappings when none is the assigned port', async () => {
    expect(ports(await upOverride([{ target: 8000, published: '8000' }, { target: 9000, published: '9000', protocol: 'udp' }]))).toEqual(['3000:8000', '9000:9000/udp']);
  });
  it('publishes port:port on the loopback when the file publishes nothing', async () => {
    expect(ports(await upOverride([]))).toEqual(['127.0.0.1:3000:3000']);
  });
  it('leaves the file alone when compose cannot read it, so its own error shows', async () => {
    expect(await upOverride(null)).toBeNull();
  });
});
