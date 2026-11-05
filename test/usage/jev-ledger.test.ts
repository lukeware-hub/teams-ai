import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../../server/config/config.js';
import { openJev } from '../../server/refine/jev-validation.js';
import { jevTotalUsd, recordJevCost, seedJevLedger } from '../../server/usage/jev-ledger.js';

const line = (seq: number, type: string, data: unknown) => JSON.stringify({ seq, at: '2026-10-24T10:00:00.000Z', runId: 'r', specHash: 'h', type, kind: 'fact', data });
const score = (costUsd: number) => ({ usage: { inputTokens: 1, outputTokens: 1, costUsd } });

let root = '';
let cfg: Config;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-jev-ledger-'));
  cfg = loadConfig({ paths: { workspaces: path.join(root, 'workspaces'), runs: path.join(root, 'runs'), usage: path.join(root, 'usage') } });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function journal(file: string, lines: string[]) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.join('\n') + '\n');
}

describe('jev ledger', () => {
  it('adds every recorded charge to the total', async () => {
    await recordJevCost(cfg, 0.25);
    await recordJevCost(cfg, 0.125);
    expect(await jevTotalUsd(cfg)).toBeCloseTo(0.375, 9);
  });

  it('ignores zero, negative and non-finite charges', async () => {
    await recordJevCost(cfg, 0);
    await recordJevCost(cfg, -1);
    await recordJevCost(cfg, Number.NaN);
    expect(await jevTotalUsd(cfg)).toBe(0);
  });

  it('counts a damaged line as zero', async () => {
    await mkdir(path.join(root, 'usage'), { recursive: true });
    await writeFile(path.join(root, 'usage', 'jev-cost.ndjson'), '{not json\n{"costUsd":0.5}\n');
    expect(await jevTotalUsd(cfg)).toBe(0.5);
  });

  it('falls back to the journals sum while no ledger exists', async () => {
    await journal(path.join(root, 'workspaces', 'shop', 'refine', 'shop-001', 'events.ndjson'), [line(1, 'REFINE_DOCS_SCORED', score(0.25))]);
    expect(await jevTotalUsd(cfg)).toBeCloseTo(0.25, 9);
  });

  it('seeds the journals past cost once, then keeps only new charges', async () => {
    await journal(path.join(root, 'runs', 'run-1', 'events.ndjson'), [line(1, 'REFINE_DOCS_SCORED', score(0.5))]);
    await seedJevLedger(cfg);
    await recordJevCost(cfg, 0.25);
    await seedJevLedger(cfg);
    expect(await jevTotalUsd(cfg)).toBeCloseTo(0.75, 9);
    expect(await readFile(path.join(root, 'usage', 'jev-cost.ndjson'), 'utf8')).toContain('"seeded":true');
  });

  it('records the cost of a Jev call that returns unusable answers', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ model: 'm', answers: {}, usage: { input_tokens: 1, output_tokens: 1, cost: 0.4 } }), { status: 200 }));
    try {
      const r = await openJev(cfg, 'sk-test').evaluate({ state: 'S', questions: { q: { type: 'noul', instructions: 'Is it?' } }, escalateTo: 'po' });
      expect(r.ok).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    await vi.waitFor(async () => expect(await jevTotalUsd(cfg)).toBeCloseTo(0.4, 9));
  });

  it('counts a charge recorded before any seed without losing it', async () => {
    await recordJevCost(cfg, 0.1);
    await seedJevLedger(cfg);
    expect(await jevTotalUsd(cfg)).toBeCloseTo(0.1, 9);
  });
});
