import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NameOutput } from '../../server/agents/outputs.js';
import { namePack, suggestName, uniqueId } from '../../server/refine/naming.js';

const ok = (value: unknown) => ({ ok: true, value, summary: {} });

describe('uniqueId', () => {
  it('keeps a free id and suffixes a taken one', () => {
    expect(uniqueId('order-service', ['team-wiki'])).toBe('order-service');
    expect(uniqueId('order-service', ['order-service', 'order-service-2'])).toBe('order-service-3');
  });
  it('stays within 40 characters', () => {
    const long = 'a'.repeat(20) + '-' + 'b'.repeat(19);
    const id = uniqueId(long, [long]);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id.endsWith('-2')).toBe(true);
  });
});

describe('NameOutput', () => {
  it('accepts kebab-case English ids and rejects the rest', () => {
    const h = `sha256:${'a'.repeat(64)}`;
    expect(NameOutput.safeParse({ specHash: h, id: 'add-health-check' }).success).toBe(true);
    expect(NameOutput.safeParse({ specHash: h, id: 'Add Health' }).success).toBe(false);
    expect(NameOutput.safeParse({ specHash: h, id: 'x'.repeat(41) }).success).toBe(false);
  });
});

describe('namePack', () => {
  it('asks for a first spec only for projects and lists the taken ids', () => {
    const base = { name: 'Portal interno', description: 'Portal para RH', taken: ['team-wiki'], specHash: `sha256:${'a'.repeat(64)}` };
    expect(namePack({ ...base, kind: 'project' }).feedback).toContain('firstSpecId');
    const spec = namePack({ ...base, kind: 'spec', projectId: 'hr-portal' }).feedback!;
    expect(spec).toContain('Omit `firstSpecId`');
    expect(spec).toContain('hr-portal');
    expect(spec).toContain('team-wiki');
  });
});

describe('suggestName', () => {
  it('runs one PO name step in a throwaway dir under the workspaces root and dedups the id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'naming-'));
    const runAgent = vi.fn(async (req: { kind: string; role: string; cwd: string; model?: string }) => {
      expect(req.cwd.startsWith(path.join(root, '_naming'))).toBe(true);
      return ok({ specHash: 'x', id: 'order-service', firstSpecId: 'place-order' });
    });
    const out = await suggestName({ runAgent: runAgent as never, workspacesRoot: root, model: 'haiku' }, { kind: 'project', name: 'Pedidos', description: 'Serviço de pedidos', taken: ['order-service'] });
    expect(out).toEqual({ id: 'order-service-2', firstSpecId: 'place-order' });
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ kind: 'name', role: 'po', model: 'haiku' });
    expect(await readdir(path.join(root, '_naming'))).toEqual([]);
  });
  it('fails with the step errors when the agent fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'naming-'));
    const runAgent = async () => ({ ok: false, failure: 'quota', errors: ['5-hour window'], summary: {}, sandboxDisabled: false });
    await expect(suggestName({ runAgent: runAgent as never, workspacesRoot: root }, { kind: 'spec', name: '', description: 'login', projectId: 'p', taken: [] })).rejects.toThrow('quota: 5-hour window');
  });
});
