import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PlatformService } from '../contracts/project.js';
import type { Exec } from '../exec/command.js';
import { imageRef, waitHealthy, type DeploymentIntent, type DeployTarget, type HttpGet } from './target.js';

const TIMEOUT = 600_000;

/** Compose project name derived from the projectId (compose allows lowercase letters, digits, '-' and '_'). */
export const composeProject = (projectId: string) => `teams-ai-${projectId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
/** A service's own compose project; a slug never holds `--`, so no other project can take the name. */
export const serviceComposeProject = (projectId: string, service: string) => `${composeProject(projectId)}--${service}`;
/** The compose project of the platform containers; a slug never holds `_`. */
export const platformComposeProject = (projectId: string) => `${composeProject(projectId)}_platform`;
/** The network a project's services and platform containers share. */
export const sharedNetwork = (projectId: string) => `${composeProject(projectId)}_net`;

/** Compose reads `$` as one of its own variables; doubled, it reaches the container as written. */
const literal = (value: string) => value.replaceAll('$', () => '$$');

/** The platform containers as a compose file on the shared network, each under its own name (JSON is YAML). */
export function renderPlatform(platform: readonly PlatformService[], network: string): string {
  const services = Object.fromEntries(platform.map((p) => [p.name, {
    image: p.image,
    ...(p.command ? { command: p.command.map(literal) } : {}),
    ...(p.environment ? { environment: Object.fromEntries(Object.entries(p.environment).map(([k, v]) => [k, literal(v)])) } : {}),
    ...(p.healthcheck ? { healthcheck: { test: p.healthcheck.map(literal), interval: '2s', timeout: '5s', retries: 30 } } : {}),
    restart: 'unless-stopped',
    networks: { shared: { aliases: [p.name] } },
  }]));
  return JSON.stringify({ services, networks: { shared: { name: network, external: true } } }, null, 2);
}

/** Runs `run` on `text` written in a fresh private directory, removed afterwards: another user could swap a fixed name in a shared /tmp. */
async function withTempFile<T>(name: string, text: string, run: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-'));
  try {
    const file = path.join(dir, name);
    await fs.writeFile(file, text);
    return await run(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Takes down what a project deployed: its own compose project and, for a system of services, each service's, the platform's and the shared network. */
export async function teardownProject(exec: Exec, projectId: string, services: readonly string[]): Promise<void> {
  const down = (project: string) => exec({ bin: 'docker', args: ['compose', '-p', project, 'down', '-v'], timeoutMs: 120_000 }).catch(() => undefined);
  await down(composeProject(projectId));
  if (services.length === 0) return;
  // A service the project no longer lists still runs under the project's prefix.
  const listed = await exec({ bin: 'docker', args: ['compose', 'ls', '-a', '--format', 'json'], timeoutMs: 30_000 })
    .then((r) => (JSON.parse(r.stdout || '[]') as Array<{ Name: string }>).map((p) => p.Name))
    .catch(() => [] as string[]);
  const prefix = `${composeProject(projectId)}--`;
  for (const project of new Set([...services.map((s) => serviceComposeProject(projectId, s)), ...listed.filter((n) => n.startsWith(prefix))])) await down(project);
  await down(platformComposeProject(projectId));
  await exec({ bin: 'docker', args: ['network', 'rm', sharedNetwork(projectId)], timeoutMs: 30_000 }).catch(() => undefined);
}

/** A docker failure that opens with the last stderr line, where docker writes the cause, followed by the stderr's tail. */
function dockerFailure(what: string, stderr: string): string {
  const tail = stderr.slice(-2000);
  const cause = stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '').at(-1) ?? '';
  return cause === tail.trim() ? `${what} failed: ${tail}` : `${what} failed: ${cause}\n${tail}`;
}

export class DockerLocalTarget implements DeployTarget {
  readonly name = 'docker-local' as const;

  /** `serviceHost` is where the orchestrator (and the smoke gate) reach the service; `publishBind` is the
   * address the container port is published on. Both default to loopback; when the orchestrator itself
   * runs in a container the service lives on the host daemon, so it needs host.docker.internal / 0.0.0.0. */
  constructor(private readonly deps: { exec: Exec; get: HttpGet; secrets: Record<string, string>; serviceHost?: string; publishBind?: string }) {}

  private container(intent: DeploymentIntent) {
    return `teams-ai-${intent.projectId}`;
  }

  baseUrl(intent: DeploymentIntent) {
    return `http://${this.deps.serviceHost ?? '127.0.0.1'}:${intent.port}`;
  }

  serviceUrl(intent: DeploymentIntent) { return this.baseUrl(intent); }

  private project(intent: DeploymentIntent) {
    return intent.shared?.composeProject ?? composeProject(intent.projectId);
  }

  private readonly services = new Map<string, string>();

  /**
   * The app's compose service. devops.md asks for the project id, but an agent may name it otherwise (live: `hello` for project
   * `hello-d7`, which failed the first deploy at verify); the compose file is the truth: the project id (a service of a system: its
   * own name) if it is a service, else the only service; with several services and none named so, that name (so the failure names it).
   */
  private async service(intent: DeploymentIntent): Promise<string> {
    const key = `${intent.contextDir}/${intent.compose}`;
    const known = this.services.get(key);
    if (known) return known;
    const r = await this.compose(intent, ['config', '--services'], imageRef(intent), 60_000, false);
    const names = r.exitCode === 0 ? r.stdout.split(/\s+/).filter((n) => n !== '') : [];
    const own = intent.shared?.alias ?? intent.projectId;
    const chosen = names.includes(own) ? own : names.length === 1 ? names[0]! : own;
    this.services.set(key, chosen);
    return chosen;
  }

  /** Smoke gate runs on the compose project's default network (a service of a system: the shared one, where it goes by its alias) and reaches the app on its container port. */
  async gateServiceUrl(intent: DeploymentIntent) {
    if (!intent.compose) return this.baseUrl(intent);
    const service = await this.service(intent);
    return `http://${intent.shared?.alias ?? service}:${await this.containerPort(intent, service)}`;
  }

  /** The container port compose maps to the published port (live: `3000:8080`); the published port when none is mapped. */
  private async containerPort(intent: DeploymentIntent, service: string): Promise<number> {
    const r = await this.compose(intent, ['config', '--format', 'json'], imageRef(intent), 60_000);
    try {
      const ports = (JSON.parse(r.stdout).services?.[service]?.ports ?? []) as Array<{ target: number; published?: string }>;
      return ports.find((p) => Number(p.published) === intent.port)?.target ?? intent.port;
    } catch {
      return intent.port;
    }
  }

  gateNetwork(intent: DeploymentIntent) {
    return intent.shared?.network ?? (intent.compose ? `${this.project(intent)}_default` : undefined);
  }

  /** `shared` false reads the service's own compose file alone, as `service()` does to name the container the extra file joins. */
  private async compose(intent: DeploymentIntent, args: string[], image: string | null, timeoutMs = 120_000, shared = true) {
    const env: Record<string, string> = image ? { TEAMS_AI_IMAGE: image } : {};
    for (const n of intent.secretNames) env[n] = this.deps.secrets[n]!;
    const run = (extra: string[]) =>
      this.deps.exec({ bin: 'docker', args: ['compose', '-p', this.project(intent), '-f', `${intent.contextDir.replaceAll('\\', '/')}/${intent.compose}`, ...extra, '--project-directory', intent.contextDir, ...args], env, timeoutMs });
    const override = shared ? await this.override(intent) : null;
    if (!override) return run([]);
    return withTempFile('override.yaml', override, (file) => run(['-f', file]));
  }

  /**
   * The extra compose file: the main container is published on the port the orchestrator assigned, whatever the file says
   * (an import keeps the port of its origin, a variable or a taken port), and a service of a system joins the shared network under its name.
   */
  private async override(intent: DeploymentIntent): Promise<string | null> {
    const service = await this.service(intent);
    const ports = await this.publishedPorts(intent, service);
    const shared = intent.shared;
    if (!ports && !shared) return null;
    return [
      'services:',
      `  ${JSON.stringify(service)}:`,
      ...(ports ? [`    ports: !override ${JSON.stringify(ports)}`] : []),
      ...(shared ? [`    networks: ${JSON.stringify({ default: {}, shared: { aliases: [shared.alias] } })}`, `networks: ${JSON.stringify({ shared: { name: shared.network, external: true } })}`] : []),
    ].join('\n');
  }

  /**
   * The service's port mappings with the one the app listens on published as `intent.port`; the rest stay as the file has them.
   * That one is the mapping already published as `intent.port`, else the first (ponytail: first of several, the app's is usually first);
   * a file with no mapping gets `port:port` on the loopback, as `docker run` does. null when compose cannot read the file: its own `config` then reports why.
   */
  private async publishedPorts(intent: DeploymentIntent, service: string): Promise<string[] | null> {
    const r = await this.compose(intent, ['config', '--format', 'json'], imageRef(intent), 60_000, false);
    if (r.exitCode !== 0) return null;
    let mappings: Array<{ target: number; published?: string; host_ip?: string; protocol?: string }>;
    try {
      mappings = JSON.parse(r.stdout).services?.[service]?.ports ?? [];
    } catch {
      return null;
    }
    const main = mappings.find((m) => Number(m.published) === intent.port) ?? mappings[0];
    if (!main) return [`${this.deps.publishBind ?? '127.0.0.1'}:${intent.port}:${intent.port}`];
    return mappings.map((m) => `${m.host_ip ? `${m.host_ip}:` : ''}${m === main ? intent.port : m.published ?? ''}:${m.target}${m.protocol && m.protocol !== 'tcp' ? `/${m.protocol}` : ''}`);
  }

  async startPlatform(projectId: string, platform: readonly PlatformService[]): Promise<{ ok: boolean; detail: string }> {
    const network = sharedNetwork(projectId);
    if ((await this.docker(['network', 'inspect', network], undefined, 30_000)).exitCode !== 0) {
      const created = await this.docker(['network', 'create', network], undefined, 30_000);
      if (created.exitCode !== 0) return { ok: false, detail: `docker network create failed: ${created.stderr.slice(-1000)}` };
    }
    if (platform.length === 0) return { ok: true, detail: 'no platform' };
    const up = await withTempFile('platform.json', renderPlatform(platform, network), (file) => this.docker(['compose', '-p', platformComposeProject(projectId), '-f', file, 'up', '-d', '--wait', '--remove-orphans'], undefined, TIMEOUT));
    if (up.exitCode === 0) return { ok: true, detail: 'platform up' };
    // A platform that did not come up would restart forever, until the project is deleted.
    await this.docker(['compose', '-p', platformComposeProject(projectId), 'down'], undefined, 120_000);
    return { ok: false, detail: dockerFailure('docker compose up', up.stderr) };
  }

  private docker(args: string[], env?: Record<string, string>, timeoutMs = 120_000) {
    return this.deps.exec({ bin: 'docker', args, env, timeoutMs });
  }

  async validate(intent: DeploymentIntent): Promise<string[]> {
    const errors = intent.secretNames.filter((n) => this.deps.secrets[n] === undefined).map((n) => `missing secret ${n}`);
    if (intent.compose && errors.length === 0) {
      const r = await this.compose(intent, ['config', '--quiet'], imageRef(intent), 60_000);
      if (r.exitCode !== 0) errors.push(`docker compose config failed: ${r.stderr.slice(-1000)}`);
    }
    return errors;
  }

  async build(intent: DeploymentIntent): Promise<void> {
    if (intent.compose) return; // `compose up --build` builds in apply
    const r = await this.docker(['build', '-t', imageRef(intent), intent.contextDir], undefined, TIMEOUT);
    if (r.exitCode !== 0) throw new Error(dockerFailure('docker build', r.stderr));
  }

  async currentImage(intent: DeploymentIntent): Promise<string | null> {
    if (intent.compose) {
      const ps = await this.compose(intent, ['ps', '-q', await this.service(intent)], null, 60_000);
      const id = ps.stdout.trim().split(/\s+/)[0];
      if (ps.exitCode !== 0 || !id) return null;
      const r = await this.docker(['inspect', '--format', '{{.Config.Image}}', id], undefined, 60_000);
      return r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
    }
    const r = await this.docker(['inspect', '--format', '{{.Config.Image}}', this.container(intent)], undefined, 60_000);
    return r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  }

  /**
   * Starts `image` as the project container. The running container is parked under a `-prev` name
   * first and only removed once the new one is up; if `docker run` fails the parked one is put back,
   * so a failed apply never leaves the environment empty.
   */
  private async run(intent: DeploymentIntent, image: string): Promise<void> {
    const name = this.container(intent);
    const prev = `${name}-prev`;
    const exists = (await this.docker(['inspect', '--format', '{{.Id}}', name], undefined, 60_000)).exitCode === 0;
    let parked = false;
    if (exists) {
      await this.docker(['rm', '-f', prev], undefined, 60_000); // a stale park from an interrupted apply
      parked = (await this.docker(['rename', name, prev], undefined, 60_000)).exitCode === 0;
      // Parked but still running, it keeps the published port and the new container cannot bind it
      // ("port is already allocated", 1387253335-001-r13). Rollback starts it again after renaming it back.
      if (parked) await this.docker(['stop', prev], undefined, 60_000);
    }
    const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped', '-p', `${this.deps.publishBind ?? '127.0.0.1'}:${intent.port}:${intent.port}`];
    const env: Record<string, string> = {};
    for (const n of intent.secretNames) {
      args.push('-e', n);
      env[n] = this.deps.secrets[n]!;
    }
    args.push(image);
    const r = await this.docker(args, env);
    if (r.exitCode !== 0) {
      await this.docker(['rm', '-f', name], undefined, 60_000);
      if (parked) {
        await this.docker(['rename', prev, name], undefined, 60_000);
        await this.docker(['start', name], undefined, 60_000);
      }
      throw new Error(`docker run failed: ${r.stderr.slice(-2000)}`);
    }
    if (parked) await this.docker(['rm', '-f', prev], undefined, 60_000);
  }

  async apply(intent: DeploymentIntent): Promise<{ previous: string | null }> {
    const previous = await this.currentImage(intent);
    if (intent.compose) {
      const r = await this.compose(intent, ['up', '-d', '--build', '--wait'], imageRef(intent), TIMEOUT);
      if (r.exitCode !== 0) throw new Error(dockerFailure('docker compose up', r.stderr));
      // The image that ran before, even this very one: a failed redeploy restarts it and never tears it down with its data.
      return { previous };
    }
    await this.run(intent, imageRef(intent));
    return { previous };
  }

  async verify(intent: DeploymentIntent) {
    if (intent.compose) {
      // `up --wait` already gated on the compose healthcheck; re-read it so a later crash is not masked by the HTTP check.
      const ps = await this.compose(intent, ['ps', '-q', await this.service(intent)], null, 60_000);
      const id = ps.stdout.trim().split(/\s+/)[0];
      if (!id) return { healthy: false, detail: `compose service ${await this.service(intent)} is not running` };
      const h = await this.docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', id], undefined, 60_000);
      const status = h.stdout.trim();
      if (status === 'unhealthy' || status === 'starting') return { healthy: false, detail: `compose healthcheck ${status}` };
    }
    return waitHealthy(`${this.baseUrl(intent)}${intent.healthcheckPath}`, this.deps.get, { timeoutMs: 120_000, intervalMs: 2_000 });
  }

  async rollback(intent: DeploymentIntent, previous: string): Promise<void> {
    if (intent.compose) {
      // No previous image: nothing to go back to, take the failed stack down.
      const r = previous
        ? await this.compose(intent, ['up', '-d', '--no-build', '--wait'], previous, TIMEOUT)
        : await this.compose(intent, ['down'], null, 120_000);
      if (r.exitCode !== 0) throw new Error(`docker compose ${previous ? 'rollback up' : 'down'} failed: ${r.stderr.slice(-2000)}`);
      return;
    }
    return this.run(intent, previous);
  }

  async destroy(intent: DeploymentIntent): Promise<void> {
    if (intent.compose) {
      await this.compose(intent, ['down', '-v'], null, 120_000);
      return;
    }
    await this.docker(['rm', '-f', this.container(intent), `${this.container(intent)}-prev`], undefined, 60_000);
  }
}
