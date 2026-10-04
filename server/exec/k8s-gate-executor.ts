import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Gate } from '../contracts/plan.js';
import type { Exec } from './command.js';
import type { GateContext, GateExecutor, GateRunOutcome } from './gate-runner.js';

export interface K8sExecutorConfig {
  namespace: string;
  serviceAccount: string;
  workspacePvc: string;
  /** Where the orchestrator sees the workspace volume (its mount path). */
  workspaceRoot: string;
  /** The PVC subPath that `workspaceRoot` corresponds to. */
  workspaceSubPath: string;
  runAsUser: number;
  runAsGroup: number;
}

export interface K8sExecutorDeps {
  exec: Exec;
  config: K8sExecutorConfig;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
}

export const NETWORK_LABEL = 'teams-ai.dev/network';
const KUBECTL_TIMEOUT = 60_000;
/** The Job deadline starts when the Job does; the client waits this much longer before giving up on its own. */
const CLIENT_GRACE_MS = 60_000;
const STUCK_REASONS = new Set(['ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError']);
const STREAM_TAIL_LINES = 500;
/** Delimiter lines the in-pod wrapper prints between the two captured streams (`kubectl logs` merges them). */
export const STDOUT_MARK = '--teams-ai-gate-stdout--';
export const STDERR_MARK = '--teams-ai-gate-stderr--';
// The gate command is `$1`: it never gets interpolated into the script. Each stream goes to its own file in /tmp.
export const GATE_WRAPPER = `sh -lc "$1" >/tmp/gate.out 2>/tmp/gate.err; rc=$?; printf '\\n%s\\n' ${STDOUT_MARK}; tail -n ${STREAM_TAIL_LINES} /tmp/gate.out; printf '\\n%s\\n' ${STDERR_MARK}; tail -n ${STREAM_TAIL_LINES} /tmp/gate.err; exit $rc`;

/** Splits the wrapper's log into the gate's stdout and stderr; a log without the markers (a killed pod) is all stdout. */
export function splitGateLogs(log: string): { stdout: string; stderr: string } {
  const e = log.lastIndexOf('\n' + STDERR_MARK + '\n');
  const o = log.lastIndexOf('\n' + STDOUT_MARK + '\n', e < 0 ? undefined : e);
  if (e < 0 || o < 0) return { stdout: log, stderr: '' };
  return { stdout: log.slice(o + STDOUT_MARK.length + 2, e), stderr: log.slice(e + STDERR_MARK.length + 2) };
}

/** DNS-1123 label of at most 63 characters (it becomes the `job-name` label value); long names keep a hash suffix. */
export function jobName(containerName: string, gateName: string): string {
  const raw = `${containerName}-${gateName}`;
  const clean = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'gate';
  if (clean.length <= 63) return clean;
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return `${clean.slice(0, 54).replace(/-+$/, '')}-${hash}`;
}

/** Maps a path in the orchestrator's filesystem to the subPath of the shared workspace PVC. */
export function workspaceSubPath(absolute: string, cfg: Pick<K8sExecutorConfig, 'workspaceRoot' | 'workspaceSubPath'>): string {
  const root = path.posix.normalize(cfg.workspaceRoot.replace(/\\/g, '/')).replace(/\/+$/, '');
  const target = path.posix.normalize(absolute.replace(/\\/g, '/'));
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error(`${absolute} is not under the workspace volume ${cfg.workspaceRoot}`);
  return path.posix.join(cfg.workspaceSubPath, target.slice(root.length));
}

export interface GateManifests {
  name: string;
  secret: Record<string, unknown> | null;
  job: Record<string, unknown>;
}

export function buildGateManifests(gate: Gate, ctx: GateContext, cfg: K8sExecutorConfig): GateManifests {
  const name = jobName(ctx.containerName, gate.name);
  const workdir = ctx.containerWorkdir ?? '/work';
  const sub = workspaceSubPath(ctx.worktree, cfg);
  const labels = { 'app.kubernetes.io/managed-by': 'teams-ai', 'teams-ai.dev/gate': gate.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 63), [NETWORK_LABEL]: gate.network === 'egress' ? 'egress' : 'deny' };
  const stringData: Record<string, string> = {};
  for (const n of gate.secrets) {
    const value = ctx.secrets[n];
    if (value === undefined) throw new Error(`gate ${gate.name} declares secret ${n} but it is not available`);
    stringData[n] = value;
  }
  const secret = gate.secrets.length === 0 ? null : { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: cfg.namespace, labels }, type: 'Opaque', stringData };
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: cfg.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: Math.max(1, Math.ceil(ctx.timeoutMs / 1000)),
      // Safety net only; the executor deletes the Job itself.
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: cfg.serviceAccount,
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: cfg.runAsUser, runAsGroup: cfg.runAsGroup, fsGroup: cfg.runAsGroup },
          containers: [
            {
              name: 'gate',
              image: ctx.image,
              command: ['sh', '-c', GATE_WRAPPER, 'gate', gate.command],
              workingDir: workdir,
              env: [
                { name: 'HOME', value: '/tmp' },
                ...gate.secrets.map((n) => ({ name: n, valueFrom: { secretKeyRef: { name, key: n } } })),
              ],
              resources: { limits: { cpu: String(ctx.cpus), memory: toK8sMemory(ctx.memory) } },
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
              volumeMounts: [
                { name: 'workspace', mountPath: workdir, subPath: sub },
                // Same rule as the docker bind: a rewritten gitdir/hooks path must never be writable from the gate.
                { name: 'workspace', mountPath: `${workdir}/.git`, subPath: `${sub}/.git`, readOnly: true },
              ],
            },
          ],
          volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: cfg.workspacePvc } }],
        },
      },
    },
  };
  return { name, secret, job };
}

/** Docker takes `2g`/`512m`; Kubernetes quantities spell them `Gi`/`Mi`. */
function toK8sMemory(memory: string): string {
  const m = /^(\d+(?:\.\d+)?)([kmg])b?$/i.exec(memory.trim());
  if (!m) return memory;
  return `${m[1]}${{ k: 'Ki', m: 'Mi', g: 'Gi' }[m[2]!.toLowerCase() as 'k' | 'm' | 'g']}`;
}

interface Condition { type?: string; status?: string; reason?: string }
interface PodStatus {
  items?: Array<{
    status?: {
      containerStatuses?: Array<{ state?: { terminated?: { exitCode?: number; reason?: string }; waiting?: { reason?: string; message?: string } } }>;
    };
  }>;
}

export class K8sGateExecutor implements GateExecutor {
  readonly kind = 'k8s' as const;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly interval: number;

  constructor(private readonly deps: K8sExecutorDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.interval = deps.pollIntervalMs ?? 2_000;
  }

  private kubectl(args: readonly string[], stdin?: string) {
    return this.deps.exec({ bin: 'kubectl', args: ['-n', this.deps.config.namespace, ...args], timeoutMs: KUBECTL_TIMEOUT, stdin });
  }

  private async cleanup(name: string, wait: boolean): Promise<void> {
    await this.kubectl(['delete', `job/${name}`, `secret/${name}`, '--ignore-not-found', `--wait=${wait}`]).catch(() => undefined);
  }

  async run(gate: Gate, ctx: GateContext): Promise<GateRunOutcome> {
    const started = this.now();
    const { name, secret, job } = buildGateManifests(gate, ctx, this.deps.config);
    try {
      // A resumed run may have left a Job or Secret of the same deterministic name behind.
      await this.cleanup(name, true);
      // Secret values travel on stdin only, never on argv.
      const applied = await this.kubectl(['apply', '-f', '-'], JSON.stringify({ apiVersion: 'v1', kind: 'List', items: secret ? [secret, job] : [job] }));
      if (applied.exitCode !== 0) throw new Error(`kubectl apply failed: ${(applied.stderr || applied.stdout).slice(-2000)}`);

      const end = await this.wait(name, started + ctx.timeoutMs + CLIENT_GRACE_MS);
      const exit = end.state === 'complete' ? { exitCode: 0, reason: '' } : end.state === 'failed' ? await this.exitOf(name) : { exitCode: null, reason: '' };
      const logs = await this.kubectl(['logs', `job/${name}`, `--tail=${STREAM_TAIL_LINES * 2 + 10}`]);
      const streams = logs.exitCode === 0 ? splitGateLogs(logs.stdout) : { stdout: '', stderr: '' };
      return {
        exitCode: exit.exitCode,
        timedOut: end.state === 'deadline',
        durationMs: this.now() - started,
        stdout: streams.stdout,
        stderr: [streams.stderr, exit.reason].filter(Boolean).join('\n'),
      };
    } finally {
      await this.cleanup(name, false);
    }
  }

  private async wait(name: string, deadlineAt: number): Promise<{ state: 'complete' | 'failed' | 'deadline' }> {
    let failures = 0;
    for (;;) {
      const r = await this.kubectl(['get', `job/${name}`, '-o', 'json']);
      if (r.exitCode !== 0) {
        if (++failures >= 3) throw new Error(`kubectl get job failed: ${r.stderr.slice(-500)}`);
      } else {
        failures = 0;
        const conditions: Condition[] = (JSON.parse(r.stdout) as { status?: { conditions?: Condition[] } }).status?.conditions ?? [];
        if (conditions.some((c) => c.type === 'Complete' && c.status === 'True')) return { state: 'complete' };
        const failed = conditions.find((c) => c.type === 'Failed' && c.status === 'True');
        if (failed) return { state: failed.reason === 'DeadlineExceeded' ? 'deadline' : 'failed' };
        await this.assertStartable(name);
      }
      if (this.now() >= deadlineAt) return { state: 'deadline' };
      await this.sleep(this.interval);
    }
  }

  private async pods(name: string): Promise<PodStatus> {
    const r = await this.kubectl(['get', 'pods', '-l', `job-name=${name}`, '-o', 'json']);
    if (r.exitCode !== 0) return {};
    try {
      return JSON.parse(r.stdout) as PodStatus;
    } catch {
      return {};
    }
  }

  /** A pod that can never start (bad image) would otherwise hold the gate until the deadline. */
  private async assertStartable(name: string): Promise<void> {
    for (const pod of (await this.pods(name)).items ?? []) {
      for (const c of pod.status?.containerStatuses ?? []) {
        const w = c.state?.waiting;
        if (w?.reason && STUCK_REASONS.has(w.reason)) throw new Error(`gate pod cannot start: ${w.reason}${w.message ? ` (${w.message.slice(0, 300)})` : ''}`);
      }
    }
  }

  private async exitOf(name: string): Promise<{ exitCode: number | null; reason: string }> {
    for (const pod of (await this.pods(name)).items ?? []) {
      const t = pod.status?.containerStatuses?.[0]?.state?.terminated;
      if (t) return { exitCode: t.exitCode ?? 1, reason: t.reason === 'OOMKilled' ? 'OOMKilled' : '' };
    }
    return { exitCode: 1, reason: '' };
  }
}
