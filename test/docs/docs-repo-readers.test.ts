import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preconditions, startsAsDraft } from '../../server/cli.js';
import type { Exec } from '../../server/exec/command.js';
import { declaredService } from '../../server/orchestrator/phases/deploy.js';
import { readDocs } from '../../server/orchestrator/phases/shared.js';
import { writeDocsMarker, writeState } from '../../server/docs/project-state.js';
import { makeFrozenSpec, makeServicesPlan } from '../fixtures/contracts.js';

let root: string;
let ws: { root: string; repo: string };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-repo-readers-'));
  ws = { root, repo: path.join(root, 'repo') };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const exec = (exitCode: number): Exec => async () => ({ exitCode, stdout: '', stderr: '', timedOut: false, durationMs: 0, signal: null, truncated: false }) as Awaited<ReturnType<Exec>>;

const spec = makeFrozenSpec();
const plan = makeServicesPlan(spec);
const withLedger = { ...plan, services: { ...plan.services, 'ledger-api': plan.services['inventory-api']! } };

/** Marks the project as a docs-repo project, whose machine files live in the mirror. */
const bind = () => writeDocsMarker(ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'shop' }, firstSha: null });

describe('startsAsDraft of a docs-repo project', () => {
  const draftRoot = () => path.join(root, 'refine', 'list-users');

  it('starts a draft when the mirror lacks the spec, whatever main says', async () => {
    await bind();
    expect(await startsAsDraft(exec(0), draftRoot(), ws, 'list-users')).toBe(true);
  });

  it('does not start a draft when the mirror holds the spec', async () => {
    await bind();
    await writeState(ws, 'specs/list-users/spec.json', JSON.stringify(spec));
    expect(await startsAsDraft(exec(128), draftRoot(), ws, 'list-users')).toBe(false);
  });
});

describe('preconditions of a docs-repo project', () => {
  const run = () => preconditions(exec(0), ws, spec.specId, false, true);

  it('reports the machine files the mirror lacks', async () => {
    await bind();
    expect(await run()).toEqual(['main lacks docs/project.json', `main lacks docs/specs/${spec.specId}/spec.json`]);
  });

  it('passes when the mirror holds both machine files', async () => {
    await bind();
    await writeState(ws, 'project.json', '{}');
    await writeState(ws, `specs/${spec.specId}/spec.json`, JSON.stringify(spec));
    expect(await run()).toEqual([]);
  });

  it('keeps reading main for a legacy project', async () => {
    expect(await preconditions(exec(128), ws, spec.specId, false, true)).toEqual(['repo/ is not a git clone with origin', 'main lacks docs/project.json', `main lacks docs/specs/${spec.specId}/spec.json`]);
  });
});

describe('readDocs of a docs-repo project', () => {
  it('reads the plan and no technical text from the mirror', async () => {
    await writeState({ root }, `specs/${spec.specId}/plan.json`, JSON.stringify(plan));
    const docs = await readDocs(ws.repo, spec.specId, undefined, { root });
    expect(docs.techSpecText).toBeNull();
    expect(docs.plan !== null && 'services' in docs.plan && Object.keys(docs.plan.services)).toEqual(['orders-api', 'inventory-api']);
    expect(docs.preplan).toBeNull();
  });

  it('reads no plan when the mirror lacks it', async () => {
    expect((await readDocs(ws.repo, spec.specId, undefined, { root })).plan).toBeNull();
  });
});

describe('declaredService of a docs-repo project', () => {
  it('finds the service a spec of the mirror declares', async () => {
    await writeState({ root }, 'specs/earlier/plan.json', JSON.stringify(withLedger));
    const view = await declaredService(ws.repo, 'ledger-api', { root });
    expect(view?.service).toBe('ledger-api');
  });

  it('is null when the mirror declares no such service', async () => {
    await writeState({ root }, 'specs/earlier/plan.json', JSON.stringify(withLedger));
    expect(await declaredService(ws.repo, 'billing-api', { root })).toBeNull();
  });
});
