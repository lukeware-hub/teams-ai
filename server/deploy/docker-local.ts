import type { Exec } from '../exec/command.js';
import { imageRef, waitHealthy, type DeploymentIntent, type DeployTarget, type HttpGet } from './target.js';

const TIMEOUT = 600_000;

export class DockerLocalTarget implements DeployTarget {
  readonly name = 'docker-local' as const;

  constructor(private readonly deps: { exec: Exec; get: HttpGet; secrets: Record<string, string> }) {}

  private container(intent: DeploymentIntent) {
    return `teams-ai-${intent.projectId}`;
  }

  baseUrl(intent: DeploymentIntent) {
    return `http://127.0.0.1:${intent.port}`;
  }

  async validate(intent: DeploymentIntent): Promise<string[]> {
    return intent.secretNames.filter((n) => this.deps.secrets[n] === undefined).map((n) => `missing secret ${n}`);
  }

  async build(intent: DeploymentIntent): Promise<void> {
    const r = await this.deps.exec({ bin: 'docker', args: ['build', '-t', imageRef(intent), intent.contextDir], timeoutMs: TIMEOUT });
    if (r.exitCode !== 0) throw new Error(`docker build failed: ${r.stderr.slice(-2000)}`);
  }

  private async run(intent: DeploymentIntent, image: string): Promise<void> {
    await this.deps.exec({ bin: 'docker', args: ['rm', '-f', this.container(intent)], timeoutMs: 60_000 });
    const args = ['run', '-d', '--name', this.container(intent), '--restart', 'unless-stopped', '-p', `${intent.port}:${intent.port}`];
    for (const n of intent.secretNames) args.push('-e', `${n}=${this.deps.secrets[n]}`);
    args.push(image);
    const r = await this.deps.exec({ bin: 'docker', args, timeoutMs: 120_000 });
    if (r.exitCode !== 0) throw new Error(`docker run failed: ${r.stderr.slice(-2000)}`);
  }

  async apply(intent: DeploymentIntent): Promise<{ previous: string | null }> {
    const inspect = await this.deps.exec({ bin: 'docker', args: ['inspect', '--format', '{{.Config.Image}}', this.container(intent)], timeoutMs: 60_000 });
    const previous = inspect.exitCode === 0 && inspect.stdout.trim() !== '' ? inspect.stdout.trim() : null;
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
    await this.deps.exec({ bin: 'docker', args: ['rm', '-f', this.container(intent)], timeoutMs: 60_000 });
  }
}
