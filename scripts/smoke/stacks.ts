import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseJUnit, type TestResult } from '../../server/evidence/junit.js';
import { stackEnv } from '../../server/runner/stacks.js';

/**
 * No-model check of one stack, the way the pipeline runs it: the install runs on the host image with network, then the test command
 * runs in the gate image with NO network, so everything install fetched must travel in the worktree. Fixtures live in
 * test/fixtures/hello-<stack>/ with a smoke.json next to the project files.
 *   npx tsx scripts/smoke/stacks.ts go python rust node
 */
export interface StackSmoke {
  gateImage: string;
  install: string;
  test: string;
  /** Repository-relative JUnit file the test command writes. */
  junit: string;
  /** Criteria that must appear passed in the JUnit file. */
  acIds: string[];
}

/** What the run must show: every listed criterion present in the JUnit file and passed. Empty when it does. */
export function stackSmokeProblems(results: readonly TestResult[], acIds: readonly string[]): string[] {
  return acIds.flatMap((id) => {
    const rows = results.filter((r) => r.acIds.includes(id));
    if (rows.length === 0) return [`no test names ${id}`];
    return rows.every((r) => r.status === 'passed') ? [] : [`${id} did not pass (${rows.map((r) => r.status).join(', ')})`];
  });
}

const HOST_IMAGE = process.env.TEAMS_AI_HOST_IMAGE ?? 'teams-ai-stacks:test';
const WORK = '/work';

const docker = (image: string, worktree: string, command: string, network: 'bridge' | 'none'): void => {
  const env = Object.entries(stackEnv(WORK)).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  execFileSync(
    'docker',
    ['run', '--rm', '--network', network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '-e', 'HOME=/tmp', ...env, '--mount', `type=bind,source=${worktree},target=${WORK}`, '-w', WORK, image, 'sh', '-c', command],
    { stdio: 'inherit', timeout: 20 * 60_000 },
  );
};

function run(stack: string): string[] {
  const fixture = path.resolve('test/fixtures', `hello-${stack}`);
  const spec = JSON.parse(readFileSync(path.join(fixture, 'smoke.json'), 'utf8')) as StackSmoke;
  const worktree = mkdtempSync(path.join(tmpdir(), `stack-${stack}-`));
  try {
    for (const name of readdirSync(fixture)) if (name !== 'smoke.json') cpSync(path.join(fixture, name), path.join(worktree, name), { recursive: true });
    docker(HOST_IMAGE, worktree, spec.install, 'bridge');
    docker(spec.gateImage, worktree, spec.test, 'none');
    const report = path.join(worktree, spec.junit);
    return existsSync(report) ? stackSmokeProblems(parseJUnit(readFileSync(report, 'utf8')), spec.acIds) : [`${spec.junit} was not written`];
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('stacks.ts')) {
  let failed = false;
  for (const stack of process.argv.slice(2)) {
    let problems: string[];
    try {
      problems = run(stack);
    } catch (err) {
      problems = [(err as Error).message];
    }
    console.log(`${problems.length === 0 ? 'PASS' : 'FAIL'} ${stack}${problems.map((p) => `\n  - ${p}`).join('')}`);
    failed ||= problems.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
