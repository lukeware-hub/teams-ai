import { describe, expect, it } from 'vitest';
import { DockerLocalTarget } from '../../server/deploy/docker-local.js';
import type { DeploymentIntent, HttpGet } from '../../server/deploy/target.js';
import { dockerArgs } from '../../server/exec/gate-runner.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const intent: DeploymentIntent = { projectId: 'Todo-Api', image: 'todo-api', tag: 't1', port: 3000, healthcheckPath: '/health', manifests: [], secretNames: ['DATABASE_URL'], contextDir: '/ws/repo', compose: 'docker-compose.yml' };
const secrets = { DATABASE_URL: 'postgres://x' };
const okGet: HttpGet = async () => ({ status: 200 });
const mk = (fake: FakeExec) => new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
const P = 'compose -p teams-ai-todo-api -f /ws/repo/docker-compose.yml --project-directory /ws/repo';

describe('DockerLocalTarget with a compose file', () => {
  it('validates with compose config', async () => {
    const fake = new FakeExec();
    expect(await mk(fake).validate(intent)).toEqual([]);
    expect(fake.lines('docker')).toEqual([`${P} config --quiet`]);
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

  it('rolls back to the previous tag, or takes the stack down when none', async () => {
    const fake = new FakeExec();
    await mk(fake).rollback(intent, 'todo-api:old');
    const up = fake.calls.find((c) => c.args.includes('up'))!;
    expect(up.args.join(' ')).toBe(`${P} up -d --no-build --wait`);
    expect(up.env?.TEAMS_AI_IMAGE).toBe('todo-api:old');
    const f2 = new FakeExec();
    await mk(f2).rollback(intent, '');
    expect(f2.lines('docker')).toEqual([`${P} down`]);
  });

  it('verify fails on an unhealthy compose healthcheck, passes when healthy plus HTTP ok', async () => {
    const f = (health: string) => new FakeExec().on((s) => s.args.includes('ps'), () => ({ stdout: 'abc\n' })).onArgs('docker', ['inspect'], () => ({ stdout: health }));
    expect(await mk(f('unhealthy')).verify(intent)).toMatchObject({ healthy: false });
    expect(await mk(f('healthy')).verify(intent)).toMatchObject({ healthy: true });
  });

  it('destroys with down -v', async () => {
    const fake = new FakeExec();
    await mk(fake).destroy(intent);
    expect(fake.lines('docker')).toEqual([`${P} down -v`]);
  });

  it('reports the service name URL and the project network for the smoke gate', async () => {
    const t = mk(new FakeExec());
    expect(await t.gateServiceUrl(intent)).toBe('http://Todo-Api:3000');
    expect(t.gateNetwork(intent)).toBe('teams-ai-todo-api_default');
    const { compose: _c, ...plain } = intent;
    expect(await t.gateServiceUrl(plain)).toBe('http://127.0.0.1:3000');
    expect(t.gateNetwork(plain)).toBeUndefined();
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
