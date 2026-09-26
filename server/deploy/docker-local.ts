import type { Exec } from '../exec/command.js';
import { imageRef, waitHealthy, type DeploymentIntent, type DeployTarget, type HttpGet } from './target.js';

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

  private docker(args: string[], env?: Record<string, string>, timeoutMs = 120_000) {
    return this.deps.exec({ bin: 'docker', args, env, timeoutMs });
  }

  async validate(intent: DeploymentIntent): Promise<string[]> {
    return intent.secretNames.filter((n) => this.deps.secrets[n] === undefined).map((n) => `missing secret ${n}`);
  }

  async build(intent: DeploymentIntent): Promise<void> {
    const r = await this.docker(['build', '-t', imageRef(intent), intent.contextDir], undefined, TIMEOUT);
    if (r.exitCode !== 0) throw new Error(`docker build failed: ${r.stderr.slice(-2000)}`);
  }

  async currentImage(intent: DeploymentIntent): Promise<string | null> {
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
    await this.run(intent, imageRef(intent));
    return { previous: previous === imageRef(intent) ? null : previous };
  }

  verify(intent: DeploymentIntent) {
    return waitHealthy(`${this.baseUrl(intent)}${intent.healthcheckPath}`, this.deps.get, { timeoutMs: 120_000, intervalMs: 2_000 });
  }

  rollback(intent: DeploymentIntent, previous: string): Promise<void> {
    return this.run(intent, previous);
  }

  async destroy(intent: DeploymentIntent): Promise<void> {
    await this.docker(['rm', '-f', this.container(intent), `${this.container(intent)}-prev`], undefined, 60_000);
  }
}
