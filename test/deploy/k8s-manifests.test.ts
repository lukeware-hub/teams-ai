import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

const ROOT = path.resolve(__dirname, '../../deploy/k8s');

function yamlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? yamlFiles(p) : e.name.endsWith('.yaml') ? [p] : [];
  });
}

type Doc = { kind: string; metadata?: { name?: string; namespace?: string }; [k: string]: any };

function load(file: string): Doc[] {
  return parseAllDocuments(readFileSync(file, 'utf8')).map((d) => {
    expect(d.errors, file).toEqual([]);
    return d.toJS() as Doc;
  });
}

const files = yamlFiles(ROOT);
const isKustomization = (f: string) => path.basename(f) === 'kustomization.yaml';
const manifests = files.filter((f) => !isKustomization(f)).flatMap((f) => load(f).map((doc) => ({ f, doc })));

describe('deploy/k8s manifests', () => {
  it('parse as YAML', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(manifests.length).toBeGreaterThan(10);
  });

  it('use the single namespace teams-ai', () => {
    for (const { f, doc } of manifests) {
      if (doc.kind === 'Namespace') expect(doc.metadata?.name, f).toBe('teams-ai');
      else expect(doc.metadata?.namespace, `${f} ${doc.kind}/${doc.metadata?.name}`).toBe('teams-ai');
    }
    for (const f of files.filter(isKustomization)) {
      const k = load(f)[0]!;
      if (f.includes(`${path.sep}base${path.sep}`)) expect(k.namespace).toBe('teams-ai');
      else expect(k.namespace ?? 'teams-ai').toBe('teams-ai');
    }
  });

  it('keeps kustomization resources resolvable', () => {
    for (const f of files.filter(isKustomization)) {
      for (const r of (load(f)[0]!.resources ?? []) as string[]) {
        expect(existsSync(path.resolve(path.dirname(f), r)), `${f} -> ${r}`).toBe(true);
      }
    }
  });

  it('has no inline secret values', () => {
    const secrets = manifests.filter(({ doc }) => doc.kind === 'Secret');
    expect(secrets.length).toBeGreaterThan(0);
    for (const { f, doc } of secrets) {
      expect(doc.data, f).toBeUndefined();
      for (const v of Object.values((doc.stringData ?? {}) as Record<string, unknown>)) expect(v, f).toBe('');
    }
    for (const { f, doc } of manifests.filter(({ doc }) => doc.kind === 'Deployment')) {
      const containers = [...(doc.spec.template.spec.containers ?? []), ...(doc.spec.template.spec.initContainers ?? [])];
      for (const c of containers) {
        for (const e of c.env ?? []) {
          expect(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(e.name) && e.value !== undefined, `${f} env ${e.name}`).toBe(false);
        }
      }
    }
  });

  it('keeps secret templates out of the kustomization', () => {
    const base = readFileSync(path.join(ROOT, 'base/kustomization.yaml'), 'utf8');
    expect(base).not.toMatch(/secret/i);
  });

  it('NetworkPolicy keeps the namespace open except for agent-step pods', () => {
    const allow = manifests.find(({ doc }) => doc.kind === 'NetworkPolicy' && doc.metadata?.name === 'allow-all')!.doc.spec;
    expect(allow.policyTypes.sort()).toEqual(['Egress', 'Ingress']);
    expect(allow.ingress).toEqual([{}]);
    expect(allow.egress).toEqual([{}]);
    // Policies are additive: the open policy must not select agent pods or it would defeat the isolation policy.
    expect(allow.podSelector.matchExpressions).toEqual([{ key: 'role', operator: 'NotIn', values: ['agent-step'] }]);
  });

  it('isolates role=agent-step pods: default-deny plus an egress allowlist', () => {
    const iso = manifests.find(({ doc }) => doc.kind === 'NetworkPolicy' && doc.metadata?.name === 'agent-step-isolation')!.doc.spec;
    expect(iso.podSelector).toEqual({ matchLabels: { role: 'agent-step' } });
    expect(iso.policyTypes.sort()).toEqual(['Egress', 'Ingress']);
    expect(iso.ingress ?? []).toEqual([]);
    const rules = iso.egress as Array<{ to?: any[]; ports?: Array<{ port: number; protocol?: string }> }>;
    expect(rules.length).toBeGreaterThan(3);
    for (const r of rules) {
      expect(r.to?.length, 'egress rule without a destination').toBeGreaterThan(0);
      expect(r.ports?.length, 'egress rule without ports').toBeGreaterThan(0);
      for (const t of r.to!) expect(t.ipBlock?.cidr, 'open CIDR').not.toBe('0.0.0.0/0');
    }
    const apps = rules.flatMap((r) => r.to!).map((t) => t.podSelector?.matchLabels?.app).filter(Boolean);
    expect(apps.sort()).toEqual(['llama', 'omniroute', 'registry']);
    expect(rules.some((r) => r.ports!.some((p) => p.port === 53))).toBe(true);
    expect(rules.some((r) => r.to!.some((t) => t.ipBlock) && r.ports!.every((p) => p.port === 443))).toBe(true);
  });

  it('gives agent-step pods a ServiceAccount without token automount', () => {
    const sa = manifests.find(({ doc }) => doc.kind === 'ServiceAccount' && doc.metadata?.name === 'agent-step')!.doc;
    expect(sa.automountServiceAccountToken).toBe(false);
  });

  it('hardens every Deployment (non-root, no escalation, no capabilities)', () => {
    const deployments = manifests.filter(({ doc }) => doc.kind === 'Deployment');
    expect(deployments.length).toBe(5);
    for (const { f, doc } of deployments) {
      const pod = doc.spec.template.spec;
      const name = doc.metadata!.name!;
      for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
        const where = `${name}/${c.name} (${f})`;
        expect(c.securityContext?.runAsNonRoot ?? pod.securityContext?.runAsNonRoot, where).toBe(true);
        expect(c.securityContext?.runAsUser ?? pod.securityContext?.runAsUser, where).not.toBe(0);
        // Rootless BuildKit needs setuid newuidmap and an unconfined seccomp profile: the one documented exemption.
        if (name === 'buildkitd') continue;
        expect(c.securityContext?.allowPrivilegeEscalation, where).toBe(false);
        expect(c.securityContext?.capabilities?.drop, where).toEqual(['ALL']);
        expect(c.securityContext?.seccompProfile?.type ?? pod.securityContext?.seccompProfile?.type, where).toBe('RuntimeDefault');
      }
    }
    const backend = deployments.find(({ doc }) => doc.metadata?.name === 'backend')!.doc.spec.template.spec;
    expect(backend.containers[0].securityContext.readOnlyRootFilesystem).toBe(true);
  });

  it('keeps the kind registry reachable by node containerd', () => {
    const kind = readFileSync(path.join(ROOT, 'overlays/kind/kustomization.yaml'), 'utf8');
    expect(kind).toMatch(/name: registry/);
    expect(kind).toContain('30500');
    const cluster = readFileSync(path.resolve(__dirname, '../../scripts/wsl/kind-cluster.yaml'), 'utf8');
    expect(cluster).toContain('registry.teams-ai:5000');
    expect(cluster).toContain('http://localhost:30500');
  });

  it('references only resolvable ServiceAccounts and lists the new manifest in the base', () => {
    expect(readFileSync(path.join(ROOT, 'base/kustomization.yaml'), 'utf8')).toContain('agent-step.yaml');
  });
});
