import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { answerFloor, heldForOwner } from '../../server/refine/auto-floor.js';

let dir: string;
afterEach(() => rm(dir, { recursive: true, force: true }));

/** Decisions on, with the floor setting given. */
const cfg = (autoAnswerFloor: number | 'measured' | 'off' = 'measured', enabled = true) => loadConfig({ decisions: { enabled, autoAnswerFloor } });

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

/** 27 right answers over two drafts: 27 of 27 bounds above 0.9, down to 0.86. */
async function measuring(): Promise<void> {
  await draft('a', Array.from({ length: 15 }, (_, i) => ({ confidence: 0.99 - i * 0.005, docs: true })));
  await draft('b', Array.from({ length: 12 }, (_, i) => ({ confidence: 0.915 - i * 0.005, docs: true })));
}

describe('answerFloor', () => {
  it('measures the floor from the labelled answers of every draft, and a broken journal counts for nothing', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-floor-'));
    await measuring();
    await mkdir(path.join(dir, 'empty'));
    await mkdir(path.join(dir, 'torn'));
    await writeFile(path.join(dir, 'torn', 'events.ndjson'), '{"seq":\n{"seq":2,"type":"QUESTION_ANSWERED"}\n');
    expect(await answerFloor(cfg(), dir)).toBeCloseTo(0.86);
  });

  it('stays off without enough labels, or for a Jev right only 86% of the time', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-floor-'));
    await draft('a', Array.from({ length: 24 }, (_, i) => ({ confidence: 0.99 - i * 0.005, docs: true })));
    expect(await answerFloor(cfg(), dir)).toBeUndefined();
    await rm(path.join(dir, 'a'), { recursive: true });
    await draft('b', Array.from({ length: 100 }, (_, i) => ({ confidence: 0.99 - i * 0.001, docs: i % 7 !== 6 })));
    expect(await answerFloor(cfg(), dir)).toBeUndefined();
  });

  it('takes a fixed number or off over the measurement, answers nothing with the decision layer off, and survives a missing directory', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-floor-'));
    await measuring();
    expect(await answerFloor(cfg(0.93), dir)).toBe(0.93);
    expect(await answerFloor(cfg('off'), dir)).toBeUndefined();
    expect(await answerFloor(cfg('measured', false), dir)).toBeUndefined();
    expect(await answerFloor(cfg(), path.join(dir, 'missing'))).toBeUndefined();
  });
});

describe('heldForOwner', () => {
  it('keeps about one question in ten above the floor for the owner, always the same ones, so labels keep coming', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `po-c${Math.floor(i / 20) + 1}-${i % 20}`);
    const held = ids.filter(heldForOwner).length;
    expect(held).toBeGreaterThan(70);
    expect(held).toBeLessThan(130);
    expect(ids.filter(heldForOwner)).toEqual(ids.filter(heldForOwner));
  });
});
