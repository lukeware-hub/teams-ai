import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { answerFloor } from '../../server/refine/auto-floor.js';

let dir: string;
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A refinement journal whose questions Jev routed `auto` at these confidences, each answered with the owner's mark when `docs` says so. */
async function draft(specId: string, routes: Array<{ confidence: number; docs: boolean }>): Promise<void> {
  const ids = routes.map((_, i) => `po-c1-${i}`);
  const lines = [
    { seq: 1, at: '', runId: 'x', specHash: 'draft', type: 'REFINE_EVALUATED', kind: 'fact', data: { cycle: 1, questionRouting: Object.fromEntries(routes.map((r, i) => [ids[i], { route: 'auto', confidence: r.confidence, source: 'jev' }])) } },
    ...routes.map((r, i) => ({ seq: i + 2, at: '', runId: 'x', specHash: 'draft', type: 'QUESTION_ANSWERED', kind: 'fact', data: { questionId: ids[i], text: 'a', ...(r.docs ? { docsAnswered: true } : {}) } })),
  ];
  await mkdir(path.join(dir, specId), { recursive: true });
  await writeFile(path.join(dir, specId, 'events.ndjson'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

describe('answerFloor', () => {
  it('measures the floor from the labelled answers of every draft of the project', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-floor-'));
    await draft('a', Array.from({ length: 12 }, (_, i) => ({ confidence: 0.99 - i * 0.005, docs: true })));
    await draft('b', Array.from({ length: 8 }, (_, i) => ({ confidence: 0.92 - i * 0.005, docs: true })));
    await mkdir(path.join(dir, 'empty'));
    expect(await answerFloor('measured', dir)).toBeCloseTo(0.885);
  });

  it('stays off without enough labels, or when the band right above the floor fails', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-floor-'));
    await draft('a', Array.from({ length: 19 }, (_, i) => ({ confidence: 0.99 - i * 0.005, docs: true })));
    expect(await answerFloor('measured', dir)).toBeUndefined();
    // 100 right and five wrong just below them: 95% overall, 50% near the floor.
    await draft('b', [...Array.from({ length: 81 }, () => ({ confidence: 0.99, docs: true })), ...[0.9, 0.89, 0.88, 0.87, 0.86].map((confidence) => ({ confidence, docs: false }))]);
    expect(await answerFloor('measured', dir)).toBeUndefined();
  });

  it('takes a fixed number or off from the config over the measurement, and survives a missing directory', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-floor-'));
    expect(await answerFloor(0.93, dir)).toBe(0.93);
    expect(await answerFloor('off', dir)).toBeUndefined();
    expect(await answerFloor('measured', path.join(dir, 'missing'))).toBeUndefined();
  });
});
