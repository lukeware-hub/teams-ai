import type { Exec } from '../exec/command.js';
import { archivePath, imageRef, waitHealthy, type DeploymentIntent, type DeployTarget, type HttpGet } from './target.js';

const TIMEOUT = 600_000;

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

  /** Compose project name derived from the projectId (compose allows lowercase letters, digits, '-' and '_'). */
  private project(intent: DeploymentIntent) {
    return `teams-ai-${intent.projectId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  }

  private readonly services = new Map<string, string>();

  /**
   * The app's compose service. devops.md asks for the project id, but an agent may name it otherwise (live: `hello` for project
   * `hello-d7`, which failed the first deploy at verify); the compose file is the truth: the project id if it is a service, else the
   * only service; with several services and none named like the project, the project id (so the failure names it).
   */
  private async service(intent: DeploymentIntent): Promise<string> {
    const key = `${intent.contextDir}/${intent.compose}`;
    const known = this.services.get(key);
    if (known) return known;
    const r = await this.compose(intent, ['config', '--services'], imageRef(intent), 60_000);
    const names = r.exitCode === 0 ? r.stdout.split(/\s+/).filter((n) => n !== '') : [];
    const chosen = names.includes(intent.projectId) ? intent.projectId : names.length === 1 ? names[0]! : intent.projectId;
    this.services.set(key, chosen);
    return chosen;
  }

  /** Smoke gate runs on the compose project's default network and reaches the app by its service name. */
  async gateServiceUrl(intent: DeploymentIntent) {
    return intent.compose ? `http://${await this.service(intent)}:${intent.port}` : this.baseUrl(intent);
  }

  gateNetwork(intent: DeploymentIntent) {
    return intent.compose ? `${this.project(intent)}_default` : undefined;
  }

  private compose(intent: DeploymentIntent, args: string[], image: string | null, timeoutMs = 120_000) {
    const env: Record<string, string> = image ? { TEAMS_AI_IMAGE: image } : {};
    for (const n of intent.secretNames) env[n] = this.deps.secrets[n]!;
    const base = ['compose', '-p', this.project(intent), '-f', `${intent.contextDir.replaceAll('\\', '/')}/${intent.compose}`, '--project-directory', intent.contextDir];
    return this.deps.exec({ bin: 'docker', args: [...base, ...args], env, timeoutMs });
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
    if (r.exitCode !== 0) throw new Error(`docker build failed: ${r.stderr.slice(-2000)}`);
    const archive = archivePath(intent);
    if (archive) {
      await this.deps.exec({ bin: 'mkdir', args: ['-p', archive.slice(0, archive.lastIndexOf('/'))], timeoutMs: 60_000 });
      const save = await this.docker(['save', '-o', archive, imageRef(intent)], undefined, TIMEOUT);
      if (save.exitCode !== 0) throw new Error(`docker save failed: ${save.stderr.slice(-2000)}`);
    }
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
      if (r.exitCode !== 0) throw new Error(`docker compose up failed: ${r.stderr.slice(-2000)}`);
      return { previous: previous === imageRef(intent) ? null : previous };
    }
    await this.run(intent, imageRef(intent));
    return { previous: previous === imageRef(intent) ? null : previous };
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
