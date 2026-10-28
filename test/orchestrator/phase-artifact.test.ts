import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFrozenSpec, makePlan } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import type { Plan } from '../../server/contracts/plan.js';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { runArtifact } from '../../server/orchestrator/phases/artifact.js';
import type { PhaseDeps } from '../../server/orchestrator/phases/shared.js';

const APK = 'android/app/build/outputs/apk/debug/app-debug.apk';
const spec = makeFrozenSpec({ specId: 'app-001' });
const { image: _image, port: _port, healthcheckPath: _path, ...container } = makePlan(spec).deploy;
const mobileDeploy = { ...container, kind: 'mobile', artifact: APK } as Plan['deploy'];
const expoPlan: Plan = makePlan(spec, {
  stack: 'Expo app, Android only',
  commands: { ...makePlan(spec).commands, install: 'npm ci && npx expo prebuild --platform android', build: 'cd android && ./gradlew assembleDebug' },
  deploy: mobileDeploy,
});

let root: string;
let repo: string;
let artifactsDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-artifact-'));
  repo = path.join(root, 'repo');
  artifactsDir = path.join(root, 'run', 'artifacts');
  await fs.mkdir(repo, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The phase's deps: a repo, a scripted exec and a journal that records the facts it writes. */
function depsFor(exec: FakeExec, facts: Array<[string, Record<string, unknown>]>): PhaseDeps {
  return {
    plan: expoPlan,
    artifactsDir,
    ws: { repo },
    exec: exec.exec,
    journal: { fact: async (type: string, data: Record<string, unknown>) => void facts.push([type, data]) },
  } as unknown as PhaseDeps;
}

describe('the mobile artifact phase', () => {
  it('keeps the debug APK of an Expo build with the run, and journals it as a mobile delivery', async () => {
    await fs.mkdir(path.join(repo, path.dirname(APK)), { recursive: true });
    await fs.writeFile(path.join(repo, APK), 'apk');
    const facts: Array<[string, Record<string, unknown>]> = [];
    const result = await runArtifact(depsFor(new FakeExec(), facts), 1);
    expect(result).toMatchObject({ ok: true, healthcheck: 'artifact' });
    expect(await fs.readFile(path.join(artifactsDir, 'app-debug.apk'), 'utf8')).toBe('apk');
    expect(facts).toEqual([[OrchEvent.DeployVerified, expect.objectContaining({ kind: 'mobile', artifact: 'app-debug.apk' })]]);
  });

  it('fails when the build does not write the APK at the plan artifact path', async () => {
    const facts: Array<[string, Record<string, unknown>]> = [];
    const result = await runArtifact(depsFor(new FakeExec(), facts), 1);
    expect(result).toEqual({ ok: false, reason: `the build did not write ${APK}` });
    expect(facts).toEqual([]);
  });

  it('builds the Expo gate image with the Android SDK and no Flutter', async () => {
    const exec = new FakeExec().onArgs('docker', ['image', 'inspect'], () => ({ exitCode: 1 }));
    await runArtifact(depsFor(exec, []), 1);
    const stdin = exec.calls.find((c) => c.args[0] === 'build')!.stdin!;
    expect(stdin).toContain('sdkmanager');
    expect(stdin).not.toContain('flutter');
    expect(exec.lines('docker').some((l) => l.endsWith('cd android && ./gradlew assembleDebug'))).toBe(true);
  });
});
