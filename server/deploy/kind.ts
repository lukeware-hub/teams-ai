import path from 'node:path';
import type { Exec } from '../exec/command.js';
import { imageRef, type DeploymentIntent, type DeployTarget } from './target.js';

const TIMEOUT = 600_000;

/**
 * kind adapter: the image is loaded into the cluster node, manifests are rendered ({{IMAGE}}) and
 * applied on stdin, secrets become one Kubernetes Secret created from stdin (never on argv), and
 * health is probed from inside the cluster so no port mapping is required.
 */
export class KindTarget implements DeployTarget {
  readonly name = 'kind' as const;

  constructor(
    private readonly deps: { exec: Exec; secrets: Record<string, string>; cluster: string; readFile: (absolutePath: string) => Promise<string> },
  ) {}

  private async kubectl(args: readonly string[], stdin?: string) {
    return this.deps.exec({ bin: 'kubectl', args, timeoutMs: TIMEOUT, stdin });
  }

  async validate(intent: DeploymentIntent): Promise<string[]> {
    const errors = intent.secretNames.filter((n) => this.deps.secrets[n] === undefined).map((n) => `missing secret ${n}`);
    if (intent.manifests.length === 0) errors.push('kind target requires at least one manifest');
    return errors;
  }

  async build(intent: DeploymentIntent): Promise<void> {
    const build = await this.deps.exec({ bin: 'docker', args: ['build', '-t', imageRef(intent), intent.contextDir], timeoutMs: TIMEOUT });
    if (build.exitCode !== 0) throw new Error(`docker build failed: ${build.stderr.slice(-2000)}`);
    const load = await this.deps.exec({ bin: 'kind', args: ['load', 'docker-image', imageRef(intent), '--name', this.deps.cluster], timeoutMs: TIMEOUT });
    if (load.exitCode !== 0) throw new Error(`kind load failed: ${load.stderr.slice(-2000)}`);
  }

  private async render(intent: DeploymentIntent, image: string): Promise<string> {
    const docs: string[] = [];
    for (const m of intent.manifests) docs.push((await this.deps.readFile(path.join(intent.contextDir, m))).replaceAll('{{IMAGE}}', image));
    return docs.join('\n---\n');
  }

  private async applySecret(intent: DeploymentIntent): Promise<void> {
    if (intent.secretNames.length === 0) return;
    const env = intent.secretNames.map((n) => `${n}=${this.deps.secrets[n]}`).join('\n');
    // `--from-env-file=/dev/stdin` keeps values off the command line; --dry-run + apply makes it idempotent.
    const dry = await this.kubectl(['create', 'secret', 'generic', `${intent.projectId}-secrets`, '--from-env-file=/dev/stdin', '--dry-run=client', '-o', 'yaml'], env);
    if (dry.exitCode !== 0) throw new Error(`kubectl create secret failed: ${dry.stderr.slice(-2000)}`);
    const apply = await this.kubectl(['apply', '-f', '-'], dry.stdout);
    if (apply.exitCode !== 0) throw new Error(`kubectl apply secret failed: ${apply.stderr.slice(-2000)}`);
  }

  async apply(intent: DeploymentIntent): Promise<{ previous: string | null }> {
    const current = await this.kubectl(['get', 'deploy', intent.projectId, '-o', 'jsonpath={.spec.template.spec.containers[0].image}']);
    const previous = current.exitCode === 0 && current.stdout.trim() !== '' ? current.stdout.trim() : null;
    await this.applySecret(intent);
    const r = await this.kubectl(['apply', '-f', '-'], await this.render(intent, imageRef(intent)));
    if (r.exitCode !== 0) throw new Error(`kubectl apply failed: ${r.stderr.slice(-2000)}`);
    return { previous: previous === imageRef(intent) ? null : previous };
  }

  async verify(intent: DeploymentIntent): Promise<{ healthy: boolean; detail: string }> {
    const rollout = await this.kubectl(['rollout', 'status', `deployment/${intent.projectId}`, '--timeout=120s']);
    if (rollout.exitCode !== 0) return { healthy: false, detail: `rollout: ${rollout.stderr.trim() || rollout.stdout.trim()}` };
    const probe = await this.kubectl([
      'run',
      `probe-${Date.now()}`,
      '--rm',
      '-i',
      '--restart=Never',
      '--image=curlimages/curl:8.10.1',
      '--',
      'curl',
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      `http://${intent.projectId}:${intent.port}${intent.healthcheckPath}`,
    ]);
    const code = Number(probe.stdout.trim().match(/\d{3}$/)?.[0]);
    return code >= 200 && code < 300 ? { healthy: true, detail: `HTTP ${code} in-cluster` } : { healthy: false, detail: `probe: ${probe.stdout.trim()} ${probe.stderr.trim()}`.trim() };
  }

  async rollback(intent: DeploymentIntent, _previous: string): Promise<void> {
    const r = await this.kubectl(['rollout', 'undo', `deployment/${intent.projectId}`]);
    if (r.exitCode !== 0) throw new Error(`rollout undo failed: ${r.stderr.slice(-2000)}`);
  }

  async destroy(intent: DeploymentIntent): Promise<void> {
    await this.kubectl(['delete', '-f', '-', '--ignore-not-found'], await this.render(intent, imageRef(intent)));
  }
}
