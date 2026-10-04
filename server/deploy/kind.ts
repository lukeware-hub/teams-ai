import path from 'node:path';
import type { Exec } from '../exec/command.js';
import { archivePath, httpGet, imageName, imageRef, waitHealthy, type DeploymentIntent, type DeployTarget, type HttpGet } from './target.js';

const TIMEOUT = 600_000;

/** Registry build path: build with the in-namespace rootless BuildKit, push to the in-namespace registry, deploy by that reference. */
export interface RegistryBuild {
  /** buildkitd address, e.g. tcp://buildkitd:1234. */
  buildkitAddr: string;
  /** Registry host as buildkitd reaches it (the Service), e.g. registry:5000. */
  pushHost: string;
  /** Registry host in the deployed image reference; the node's containerd mirror maps it to the registry. */
  pullHost: string;
  namespace: string;
}

export interface KindDeps {
  exec: Exec;
  secrets: Record<string, string>;
  cluster: string;
  /** Namespace of the project's Service; when set, every kubectl call uses it and gate pods reach the Service by its DNS name. */
  namespace?: string;
  readFile: (absolutePath: string) => Promise<string>;
  /** Injected for tests; the probe waits between attempts while kube-proxy programs the Service. */
  sleep?: (ms: number) => Promise<void>;
  probeAttempts?: number;
  probeIntervalMs?: number;
  /** Unset keeps docker build + kind load, kubectl pinned to the kind context. */
  registry?: RegistryBuild;
  /** Injected for tests; used by the in-cluster HTTP probe of the registry mode. */
  httpGet?: HttpGet;
}

/**
 * kind adapter: every kubectl call is pinned to the kind context, the image is loaded into the
 * cluster node, manifests are rendered ({{IMAGE}}) and applied on stdin, secrets become one
 * Kubernetes Secret created from stdin (never on argv), and health is probed from inside the
 * cluster (retrying: right after `apply`, kube-proxy may not have programmed the Service yet).
 */
export class KindTarget implements DeployTarget {
  readonly name = 'kind' as const;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly attempts: number;
  private readonly interval: number;

  constructor(private readonly deps: KindDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.attempts = deps.probeAttempts ?? 12;
    this.interval = deps.probeIntervalMs ?? 5_000;
  }

  private secretName(intent: DeploymentIntent) {
    return `${intent.projectId}-secrets`;
  }

  /** Image reference the cluster pulls: the plain local reference, or <pullHost>/<name>:<tag> in registry mode. */
  private ref(intent: DeploymentIntent): string {
    const r = this.deps.registry;
    return r ? `${r.pullHost}/${this.registryPath(intent)}:${intent.tag}` : imageRef(intent);
  }

  /** Repository path without tag or registry host ('localhost:5000/team/app:latest' -> 'team/app'). */
  private registryPath(intent: DeploymentIntent): string {
    const parts = imageName(intent.image).split('/');
    return parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!) ? parts.slice(1).join('/') : parts.join('/');
  }

  private async kubectl(args: readonly string[], stdin?: string) {
    const namespace = this.namespace();
    // Registry mode runs inside the cluster (no kind context); otherwise kubectl is pinned to the kind context.
    const scope = this.deps.registry ? ['-n', this.deps.registry.namespace] : ['--context', `kind-${this.deps.cluster}`, ...(namespace ? ['--namespace', namespace] : [])];
    return this.deps.exec({ bin: 'kubectl', args: [...scope, ...args], timeoutMs: TIMEOUT, stdin });
  }

  async validate(intent: DeploymentIntent): Promise<string[]> {
    const errors = intent.secretNames.filter((n) => this.deps.secrets[n] === undefined).map((n) => `missing secret ${n}`);
    if (intent.manifests.length === 0) errors.push('kind target requires at least one manifest');
    if (intent.secretNames.length === 0) {
      const rendered = await this.render(intent, this.ref(intent)).catch(() => '');
      const ref = new RegExp(`name:\\s*${this.secretName(intent)}\\b(?![\\s\\S]{0,80}optional:\\s*true)`);
      if (ref.test(rendered)) errors.push(`manifest references Secret ${this.secretName(intent)} but the intent declares no secrets`);
    }
    return errors;
  }

  async build(intent: DeploymentIntent): Promise<void> {
    const reg = this.deps.registry;
    const archive = archivePath(intent);
    if (archive) await this.deps.exec({ bin: 'mkdir', args: ['-p', archive.slice(0, archive.lastIndexOf('/'))], timeoutMs: 60_000 });
    if (reg) {
      const name = `${reg.pushHost}/${this.registryPath(intent)}:${intent.tag}`;
      const r = await this.deps.exec({
        bin: 'buildctl',
        args: [
          '--addr', reg.buildkitAddr, 'build', '--frontend', 'dockerfile.v0',
          '--local', `context=${intent.contextDir}`, '--local', `dockerfile=${intent.contextDir}`,
          '--output', `type=image,name=${name},push=true,registry.insecure=true`,
          ...(archive ? ['--output', `type=oci,dest=${archive}`] : []),
        ],
        timeoutMs: TIMEOUT,
      });
      if (r.exitCode !== 0) throw new Error(`buildctl build failed: ${r.stderr.slice(-2000)}`);
      return;
    }
    const build = await this.deps.exec({ bin: 'docker', args: ['build', '-t', this.ref(intent), intent.contextDir], timeoutMs: TIMEOUT });
    if (build.exitCode !== 0) throw new Error(`docker build failed: ${build.stderr.slice(-2000)}`);
    if (archive) {
      const save = await this.deps.exec({ bin: 'docker', args: ['save', '-o', archive, this.ref(intent)], timeoutMs: TIMEOUT });
      if (save.exitCode !== 0) throw new Error(`docker save failed: ${save.stderr.slice(-2000)}`);
    }
    const load = await this.deps.exec({ bin: 'kind', args: ['load', 'docker-image', this.ref(intent), '--name', this.deps.cluster], timeoutMs: TIMEOUT });
    if (load.exitCode !== 0) throw new Error(`kind load failed: ${load.stderr.slice(-2000)}`);
  }

  private async render(intent: DeploymentIntent, image: string): Promise<string> {
    const docs: string[] = [];
    for (const m of intent.manifests) docs.push((await this.deps.readFile(path.join(intent.contextDir, m))).replaceAll('{{IMAGE}}', image));
    return docs.join('\n---\n');
  }

  private async applySecret(intent: DeploymentIntent): Promise<void> {
    if (intent.secretNames.length === 0) return;
    for (const n of intent.secretNames) {
      if (/[\r\n]/.test(this.deps.secrets[n] ?? '')) throw new Error(`secret ${n} contains a line break, which the env-file format cannot carry`);
    }
    const env = intent.secretNames.map((n) => `${n}=${this.deps.secrets[n]}`).join('\n');
    // `--from-env-file=/dev/stdin` keeps values off the command line; --dry-run + apply makes it idempotent.
    const dry = await this.kubectl(['create', 'secret', 'generic', this.secretName(intent), '--from-env-file=/dev/stdin', '--dry-run=client', '-o', 'yaml'], env);
    if (dry.exitCode !== 0) throw new Error(`kubectl create secret failed: ${dry.stderr.slice(-2000)}`);
    const apply = await this.kubectl(['apply', '-f', '-'], dry.stdout);
    if (apply.exitCode !== 0) throw new Error(`kubectl apply secret failed: ${apply.stderr.slice(-2000)}`);
  }

  async currentImage(intent: DeploymentIntent): Promise<string | null> {
    const r = await this.kubectl(['get', 'deploy', intent.projectId, '-o', 'jsonpath={.spec.template.spec.containers[0].image}']);
    return r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  }

  async apply(intent: DeploymentIntent): Promise<{ previous: string | null }> {
    const previous = await this.currentImage(intent);
    await this.applySecret(intent);
    const r = await this.kubectl(['apply', '-f', '-'], await this.render(intent, this.ref(intent)));
    if (r.exitCode !== 0) throw new Error(`kubectl apply failed: ${r.stderr.slice(-2000)}`);
    return { previous: previous === this.ref(intent) ? null : previous };
  }

  async verify(intent: DeploymentIntent): Promise<{ healthy: boolean; detail: string }> {
    const rollout = await this.kubectl(['rollout', 'status', `deployment/${intent.projectId}`, '--timeout=120s']);
    if (rollout.exitCode !== 0) return { healthy: false, detail: `rollout: ${rollout.stderr.trim() || rollout.stdout.trim()}` };
    if (this.deps.registry) {
      // kubectl run needs pods/attach, which the backend Role does not grant: probe over HTTP from this pod instead.
      return waitHealthy(`${this.gateServiceUrl(intent)}${intent.healthcheckPath}`, this.deps.httpGet ?? httpGet, {
        timeoutMs: this.attempts * this.interval,
        intervalMs: this.interval,
      });
    }
    let last = '';
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const probe = await this.kubectl([
        'run',
        `probe-${intent.projectId}-${Date.now()}-${attempt}`,
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
      // `kubectl run --rm -i` prints the curl output first, then "pod ... deleted"; the code is the leading 3 digits.
      const code = Number(probe.stdout.trim().match(/^(\d{3})/)?.[1]);
      if (code >= 200 && code < 300) return { healthy: true, detail: `HTTP ${code} in-cluster after ${attempt} attempts` };
      last = `probe: ${probe.stdout.trim()} ${probe.stderr.trim()}`.trim().slice(0, 300);
      if (attempt < this.attempts) await this.sleep(this.interval);
    }
    return { healthy: false, detail: `${last} (${this.attempts} attempts)` };
  }

  async rollback(intent: DeploymentIntent, _previous: string): Promise<void> {
    const r = await this.kubectl(['rollout', 'undo', `deployment/${intent.projectId}`]);
    if (r.exitCode !== 0) throw new Error(`rollout undo failed: ${r.stderr.slice(-2000)}`);
    const wait = await this.kubectl(['rollout', 'status', `deployment/${intent.projectId}`, '--timeout=120s']);
    if (wait.exitCode !== 0) throw new Error(`rollback did not become ready: ${wait.stderr.slice(-2000)}`);
  }

  async destroy(intent: DeploymentIntent): Promise<void> {
    await this.kubectl(['delete', '-f', '-', '--ignore-not-found'], await this.render(intent, this.ref(intent)));
    await this.kubectl(['delete', 'secret', this.secretName(intent), '--ignore-not-found']);
  }

  /** Namespace of this target's resources: the explicit one, else the registry's. */
  private namespace(): string | undefined {
    return this.deps.namespace ?? this.deps.registry?.namespace;
  }

  /** The service URL as seen from a gate Job pod (in-cluster Service DNS). */
  gateServiceUrl(intent: DeploymentIntent): string {
    return `http://${intent.projectId}.${this.namespace() ?? 'default'}.svc.cluster.local:${intent.port}`;
  }

  async serviceUrl(intent: DeploymentIntent): Promise<string> {
    const r = await this.kubectl(['get', 'svc', intent.projectId, '-o', 'jsonpath={.spec.ports[0].nodePort}']);
    const port = r.stdout.trim();
    if (r.exitCode !== 0 || !/^\d+$/.test(port)) throw new Error(`service has no NodePort: ${r.stderr.trim() || port || 'empty output'}`);
    return `http://127.0.0.1:${port}`;
  }
}
