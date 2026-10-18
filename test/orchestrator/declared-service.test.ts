import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { declaredService } from '../../server/orchestrator/phases/deploy.js';
import { makeFrozenSpec, makeServicesPlan } from '../fixtures/contracts.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function projectWith(specs: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-declared-'));
  dirs.push(root);
  for (const [spec, text] of Object.entries(specs)) {
    await fs.mkdir(path.join(root, 'docs', 'specs', spec), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'specs', spec, 'plan.json'), text);
  }
  return root;
}

describe('declaredService', () => {
  const spec = makeFrozenSpec();
  const plan = makeServicesPlan(spec);
  const withLedger = JSON.stringify({ ...plan, services: { ...plan.services, 'ledger-api': plan.services['inventory-api'] } });

  it('returns the view of the spec that declares the service, with its port', async () => {
    const dir = await projectWith({ earlier: withLedger });
    const view = await declaredService(dir, 'ledger-api');
    expect(view?.service).toBe('ledger-api');
    expect(view?.plan.deploy.port).toBe(plan.services['inventory-api']!.deploy.port);
  });

  it('is null when no spec declares it, and skips a plan that does not parse', async () => {
    const dir = await projectWith({ broken: '{not json', earlier: withLedger });
    expect(await declaredService(dir, 'billing-api')).toBeNull();
    expect((await declaredService(dir, 'ledger-api'))?.service).toBe('ledger-api');
  });

  it('is null for a project without a docs folder', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-declared-empty-'));
    dirs.push(dir);
    expect(await declaredService(dir, 'ledger-api')).toBeNull();
  });
});
