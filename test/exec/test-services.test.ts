import { describe, expect, it } from 'vitest';
import { Gate as GateSchema, Plan } from '../../server/contracts/plan.js';
import { dockerArgs, type GateContext } from '../../server/exec/gate-runner.js';
import { TEST_GATE, TEST_SERVICES, withTestServices } from '../../server/exec/test-services.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const noSleep = async () => undefined;

/** The docker subcommand and its first target, in call order. */
const steps = (fake: FakeExec) => fake.calls.map((c) => c.args.slice(0, 2).join(' '));

describe('withTestServices', () => {
  it('starts each service on a private network, waits for health, then removes the services and the network', async () => {
    const fake = new FakeExec().onArgs('docker', ['inspect'], () => ({ stdout: 'healthy\n' }));
    const result = await withTestServices(['redis', 'mysql'], 'teams-ai-run-branch', { exec: fake.exec, sleep: noSleep }, async (run) => {
      expect(run.network).toBe('teams-ai-run-branch-net');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(steps(fake)).toEqual(['network create', 'run -d', 'inspect --format', 'run -d', 'inspect --format', 'rm -f', 'rm -f', 'network rm']);
    expect(fake.lines('docker')[0]).toBe('network create --internal teams-ai-run-branch-net');
    expect(fake.lines('docker')[1]).toContain('--network-alias redis');
    expect(fake.lines('docker')[1]).toContain(`--health-cmd ${TEST_SERVICES.redis.health}`);
  });

  it('gives the test command the conventional URL variables, and passes the generated passwords only through the environment', async () => {
    const fake = new FakeExec().onArgs('docker', ['inspect'], () => ({ stdout: 'healthy' }));
    let secrets: Record<string, string> = {};
    await withTestServices(['mysql', 'mongodb', 'rabbitmq', 'redis', 'postgresql'], 'p', { exec: fake.exec, sleep: noSleep }, async (run) => {
      secrets = run.secrets;
      expect(run.urlNames).toEqual(['MYSQL_URL', 'MONGODB_URL', 'RABBITMQ_URL', 'REDIS_URL', 'POSTGRES_URL']);
      return null;
    });

    const values = Object.values(secrets);
    expect(values).toHaveLength(10);
    for (const call of fake.calls) {
      for (const arg of call.args) for (const value of values) expect(arg).not.toContain(value);
    }
    const runs = fake.calls.filter((c) => c.args[0] === 'run');
    for (const call of runs) {
      expect(call.env && Object.keys(call.env).length).toBeGreaterThan(0);
      // Each container receives its generated password, plus a fixed user name the image expects.
      for (const value of Object.values(call.env ?? {})) expect(value === 'test' || /^[0-9a-f]{48}$/.test(value)).toBe(true);
    }
  });

  it('removes the services and the network when the test command throws, and keeps its error', async () => {
    const fake = new FakeExec().onArgs('docker', ['inspect'], () => ({ stdout: 'healthy' }));
    await expect(withTestServices(['redis'], 'p', { exec: fake.exec, sleep: noSleep }, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(steps(fake).slice(-2)).toEqual(['rm -f', 'network rm']);
  });

  it('fails with a message that names no value when a service never becomes healthy, and still removes the services', async () => {
    const fake = new FakeExec().onArgs('docker', ['inspect'], () => ({ stdout: 'starting' }));
    const err = await withTestServices(['rabbitmq'], 'p', { exec: fake.exec, sleep: noSleep }, async () => 'unreached').catch((e: Error) => e);
    expect((err as Error).message).toBe('test service p-rabbitmq did not become healthy');
    expect(steps(fake).slice(-2)).toEqual(['rm -f', 'network rm']);
  });

  it('reports the docker subcommand and exit code when docker refuses to start a service, and still removes the services', async () => {
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ exitCode: 125 }));
    const err = await withTestServices(['redis'], 'p', { exec: fake.exec, sleep: noSleep }, async () => 'unreached').catch((e: Error) => e);
    expect((err as Error).message).toBe('docker run failed with exit code 125');
    expect(steps(fake).slice(-2)).toEqual(['rm -f', 'network rm']);
  });
});

describe('gate container network', () => {
  const ctx: GateContext = { worktree: '/w/t1', image: 'node:22-bookworm', junitPath: 'j.xml', cpus: 2, memory: '2g', timeoutMs: 1000, secrets: { REDIS_URL: 'redis://:s3cret@redis:6379' }, containerName: 'c' };
  const unit = GateSchema.parse({ name: TEST_GATE, command: 'npm test', blocking: true });
  const lint = GateSchema.parse({ name: 'lint', command: 'npm run lint', blocking: true });

  it('keeps the unit-test gate offline when the run has no test services', () => {
    expect(dockerArgs(unit, ctx).args).toContain('none');
  });

  it('joins only the unit-test gate to the private test network, and passes the URL by name', () => {
    const testCtx = { ...ctx, testNetwork: 'teams-ai-c-net', secrets: { ...ctx.secrets } };
    const withUrl = { ...unit, secrets: ['REDIS_URL'] };
    const inv = dockerArgs(withUrl, testCtx);
    expect(inv.args[inv.args.indexOf('--network') + 1]).toBe('teams-ai-c-net');
    expect(inv.args).toContain('REDIS_URL');
    expect(inv.env).toEqual({ REDIS_URL: 'redis://:s3cret@redis:6379' });
    expect(inv.args.join(' ')).not.toContain('s3cret');
    expect(dockerArgs(lint, testCtx).args[dockerArgs(lint, testCtx).args.indexOf('--network') + 1]).toBe('none');
  });
});

describe('TEST_SERVICES catalog', () => {
  it('pins every image to an explicit version tag, never latest', () => {
    for (const spec of Object.values(TEST_SERVICES)) expect(spec.image).toMatch(/:\d+/);
  });
});

describe('Plan.testServices', () => {
  const field = Plan.shape.testServices;
  it('is optional', () => {
    expect(field.safeParse(undefined).success).toBe(true);
  });
  it('accepts the four known names', () => {
    expect(field.safeParse(['redis', 'mysql', 'mongodb', 'rabbitmq', 'postgresql']).success).toBe(true);
  });
  it('refuses an unknown service name', () => {
    expect(field.safeParse(['postgres']).success).toBe(false);
  });
  it('refuses a duplicate name', () => {
    expect(field.safeParse(['redis', 'redis']).success).toBe(false);
  });
});
