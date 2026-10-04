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

  it('NetworkPolicy allows all ingress and egress', () => {
    const policies = manifests.filter(({ doc }) => doc.kind === 'NetworkPolicy');
    expect(policies.length).toBe(1);
    const spec = policies[0]!.doc.spec;
    expect(spec.podSelector).toEqual({});
    expect(spec.policyTypes.sort()).toEqual(['Egress', 'Ingress']);
    expect(spec.ingress).toEqual([{}]);
    expect(spec.egress).toEqual([{}]);
  });
});
