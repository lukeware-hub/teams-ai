import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { absoluteRule } from '../../server/runner/role-settings.js';
import { runStep, writeDirsFor, type StepDeps, type StepRequest } from '../../server/runner/step.js';

const FAKE = path.resolve('test/fixtures/fake-claude/fake-claude.mjs');
const fixture = (name: string) => path.resolve(`test/fixtures/stream/${name}.ndjson`);
const HASH = `sha256:${'a'.repeat(64)}`;
const STORE_OWNED = ['docs/project.md', 'docs/flow.md', 'docs/briefing.md', 'docs/design.md', 'docs/stack.md'];

const devAgent = parseAgentFile(`---\nname: dev\ndescription: d\nmodel: opus\ntools: Read, Edit, Bash\n---\nEcho specHash.`, 'dev');

let dir: string;
let deps: StepDeps;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-writedirs-'));
  deps = {
    binary: { bin: process.execPath, prefixArgs: [FAKE], env: { FAKE_CLAUDE_FIXTURE: fixture('success'), FAKE_CLAUDE_CAPTURE: path.join(dir, 'capture.json') }, requireSandboxTools: false },
    caps: { timeoutMs: 5_000, maxTurns: 50, killGraceMs: 200 },
    accounting: new Accounting(),
    claudeJsonPath: path.join(dir, '.claude.json'),
    settingsDir: path.join(dir, 'settings'),
    workspacesRoot: dir,
    network: { allowedDomains: ['registry.npmjs.org'] },
    hostEnv: { HOME: dir, PATH: process.env.PATH ?? '' },
    clock: () => new Date('2026-09-24T10:00:00.000Z'),
  };
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const request = (over: Partial<StepRequest> = {}): StepRequest => ({
  kind: 'speckit',
  role: 'dev',
  agent: devAgent,
  profile: { model: 'opus' },
  model: 'opus',
  cwd: dir,
  prompt: 'Plan it',
  expectedSpecHash: HASH,
  phase: 'plan',
  taskId: null,
  attempt: 1,
  ...over,
});

/** The Edit and Write rules of the settings file the step's agent was started with. */
async function fileRules(): Promise<string[]> {
  const captured = JSON.parse(await fs.readFile(path.join(dir, 'capture.json'), 'utf8'));
  const settings = JSON.parse(await fs.readFile(captured.argv[captured.argv.indexOf('--settings') + 1], 'utf8'));
  return (settings.permissions.allow as string[]).filter((rule) => /^(Edit|Write|MultiEdit)\b/.test(rule));
}

describe('writeDirsFor', () => {
  it('keeps the legacy map unchanged', () => {
    expect(writeDirsFor(false)).toEqual({ speckit: ['docs/specs'], docs: ['docs'] });
  });

  it('never allows a store-owned document in the documentation-repository map, and keeps the spec folder', () => {
    const map = writeDirsFor(true);
    const allowed = Object.values(map).flat();
    for (const doc of STORE_OWNED) expect(allowed).not.toContain(doc);
    expect(map.speckit).toEqual(['docs/specs']);
  });
});

describe('step request layout', () => {
  it('a documentation-repository request gets the documentation-repository map', async () => {
    await runStep(request({ docsRepo: true }), deps);
    expect(await fileRules()).toEqual([`Edit(${absoluteRule(path.join(dir, 'docs', 'specs'))}/**)`]);
  });
});
