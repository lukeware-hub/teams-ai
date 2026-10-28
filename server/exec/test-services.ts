import { randomBytes } from 'node:crypto';
import type { TestServiceName } from '../contracts/plan.js';
import type { Exec } from './command.js';

/** The gate whose command receives the test services' URLs. */
export const TEST_GATE = 'unit-test';

const DOCKER_TIMEOUT_MS = 600_000;
const HEALTH_POLLS = 90;
const POLL_MS = 2_000;

interface TestServiceSpec {
  /** Pinned tag: a service image never floats. */
  image: string;
  /** Container environment, built from the password generated for this run. */
  env: (password: string) => Record<string, string>;
  /** Container command, for an image that reads its password from the environment. */
  command?: string;
  /** Shell command run inside the container until it succeeds. */
  health: string;
  /** The conventional variable the test command reads. */
  urlName: string;
  url: (host: string, password: string) => string;
}

export const TEST_SERVICES: Record<TestServiceName, TestServiceSpec> = {
  redis: {
    image: 'redis:7.4.1-alpine',
    env: (password) => ({ REDIS_PASSWORD: password }),
    command: 'exec redis-server --requirepass "$REDIS_PASSWORD"',
    health: 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG',
    urlName: 'REDIS_URL',
    url: (host, password) => `redis://:${password}@${host}:6379`,
  },
  mysql: {
    image: 'mysql:8.4.3',
    env: (password) => ({ MYSQL_ROOT_PASSWORD: password, MYSQL_DATABASE: 'test', MYSQL_USER: 'test', MYSQL_PASSWORD: password }),
    health: 'mysqladmin ping -h 127.0.0.1 -u root -p"$MYSQL_ROOT_PASSWORD" --silent',
    urlName: 'MYSQL_URL',
    url: (host, password) => `mysql://test:${password}@${host}:3306/test`,
  },
  mongodb: {
    image: 'mongo:7.0.14',
    env: (password) => ({ MONGO_INITDB_ROOT_USERNAME: 'test', MONGO_INITDB_ROOT_PASSWORD: password }),
    health: 'mongosh --quiet -u test -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.runCommand({ping: 1}).ok" | grep -q 1',
    urlName: 'MONGODB_URL',
    url: (host, password) => `mongodb://test:${password}@${host}:27017/?authSource=admin`,
  },
  rabbitmq: {
    image: 'rabbitmq:3.13.7-alpine',
    env: (password) => ({ RABBITMQ_DEFAULT_USER: 'test', RABBITMQ_DEFAULT_PASS: password }),
    health: 'rabbitmq-diagnostics -q check_running',
    urlName: 'RABBITMQ_URL',
    url: (host, password) => `amqp://test:${password}@${host}:5672`,
  },
  postgresql: {
    image: 'postgres:16-bookworm',
    env: (password) => ({ POSTGRES_USER: 'test', POSTGRES_DB: 'test', POSTGRES_PASSWORD: password }),
    health: 'pg_isready -U test -d test',
    urlName: 'POSTGRES_URL',
    url: (host, password) => `postgres://test:${password}@${host}:5432/test`,
  },
};

export interface TestServicesRun {
  /** Private network the test gate joins; it has no route out. */
  network: string;
  /** Every value the services need, by name: the URLs and the generated passwords (never logged). */
  secrets: Record<string, string>;
  /** The URL variable names the test gate receives. */
  urlNames: string[];
}

export interface TestServicesDeps {
  exec: Exec;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Starts the services on a private network, waits until each is healthy, runs `use`, and removes the
 * services and the network afterwards, also when `use` fails. `prefix` names the containers and the network.
 */
export async function withTestServices<T>(names: readonly TestServiceName[], prefix: string, deps: TestServicesDeps, use: (run: TestServicesRun) => Promise<T>): Promise<T> {
  const network = `${prefix}-net`;
  const docker = async (args: string[], env?: Record<string, string>) => {
    const r = await deps.exec({ bin: 'docker', args, env, timeoutMs: DOCKER_TIMEOUT_MS });
    // Only the subcommand is reported: arguments and environment may hold generated passwords.
    if (r.exitCode !== 0) throw new Error(`docker ${args[0]} failed with exit code ${r.exitCode}`);
    return r;
  };
  const containers: string[] = [];
  const secrets: Record<string, string> = {};
  const urlNames: string[] = [];

  await docker(['network', 'create', '--internal', network]);
  try {
    for (const name of names) {
      const spec = TEST_SERVICES[name];
      const password = randomBytes(24).toString('hex');
      const container = `${prefix}-${name}`;
      const vars = spec.env(password);
      containers.push(container);
      await docker(
        [
          'run',
          '-d',
          '--name',
          container,
          '--network',
          network,
          '--network-alias',
          name,
          '--memory',
          '1g',
          '--health-cmd',
          spec.health,
          '--health-interval',
          '2s',
          '--health-retries',
          '60',
          ...Object.keys(vars).flatMap((key) => ['-e', key]),
          spec.image,
          ...(spec.command ? ['sh', '-c', spec.command] : []),
        ],
        vars,
      );
      await waitHealthy(container, docker, deps.sleep ?? wait);
      secrets[`TEST_${name.toUpperCase()}_PASSWORD`] = password;
      secrets[spec.urlName] = spec.url(name, password);
      urlNames.push(spec.urlName);
    }
    return await use({ network, secrets, urlNames });
  } finally {
    for (const container of containers) await docker(['rm', '-f', container]).catch(() => undefined);
    await docker(['network', 'rm', network]).catch(() => undefined);
  }
}

async function waitHealthy(container: string, docker: (args: string[]) => Promise<{ stdout: string }>, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let poll = 0; poll < HEALTH_POLLS; poll++) {
    const status = (await docker(['inspect', '--format', '{{.State.Health.Status}}', container]).catch(() => null))?.stdout.trim();
    if (status === 'healthy') return;
    await sleep(POLL_MS);
  }
  throw new Error(`test service ${container} did not become healthy`);
}
