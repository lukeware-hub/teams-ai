import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jevCostUsd } from '../../server/usage/jev-cost.js';

const line = (seq: number, type: string, data: unknown) => JSON.stringify({ seq, at: '2026-10-24T10:00:00.000Z', runId: 'r', specHash: 'h', type, kind: 'fact', data });
const score = (costUsd: number | null) => ({ usage: { inputTokens: 1, outputTokens: 1, costUsd } });
const decision = (attempts: Array<{ backend: string; costUsd: number | null }>) => ({ record: { attempts: attempts.map((a) => ({ backend: a.backend, usage: { inputTokens: 1, outputTokens: 1, costUsd: a.costUsd } })) } });

let root = '';
let workspaces = '';
let runs = '';

async function journal(file: string, lines: string[]) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.join('\n') + '\n');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-jev-cost-'));
  workspaces = path.join(root, 'workspaces');
  runs = path.join(root, 'runs');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('jevCostUsd', () => {
  it('is zero when no journal exists', async () => {
    expect(await jevCostUsd(workspaces, runs)).toBe(0);
  });

  it('adds the document scores of every spec of every project', async () => {
    await journal(path.join(workspaces, 'shop', 'refine', 'shop-001', 'events.ndjson'), [line(1, 'REFINE_DOCS_SCORED', score(0.25)), line(2, 'REFINE_DOCS_SCORED', score(0.5))]);
    await journal(path.join(workspaces, 'hub', 'refine', 'hub-001', 'events.ndjson'), [line(1, 'REFINE_DOCS_SCORED', score(0.125))]);
    expect(await jevCostUsd(workspaces, runs)).toBeCloseTo(0.875, 9);
  });

  it('adds only the Jev attempts of decisions, in refinements and in runs', async () => {
    await journal(path.join(workspaces, 'shop', 'refine', 'shop-001', 'events.ndjson'), [line(1, 'DECISION_MADE', decision([{ backend: 'local', costUsd: 0 }, { backend: 'jev', costUsd: 0.25 }]))]);
    await journal(path.join(runs, 'run-1', 'events.ndjson'), [line(1, 'DECISION_MADE', decision([{ backend: 'jev', costUsd: 0.5 }, { backend: 'claude', costUsd: 9 }]))]);
    expect(await jevCostUsd(workspaces, runs)).toBeCloseTo(0.75, 9);
  });

  it('skips scores without a cost and other events', async () => {
    await journal(path.join(workspaces, 'shop', 'refine', 'shop-001', 'events.ndjson'), [line(1, 'REFINE_DOCS_SCORED', score(null)), line(2, 'STEP_FINISHED', { costUsd: 4 }), line(3, 'REFINE_DOCS_SCORED', { skipped: 'confidential' })]);
    expect(await jevCostUsd(workspaces, runs)).toBe(0);
  });
});
