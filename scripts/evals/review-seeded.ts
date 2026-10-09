/**
 * Manual, live (costs real tokens): does the Test review still catch defects now that its pack carries the diff and the
 * gate results (R11.13 slice 2)? Replays real review steps of a finished run against seeded defects, in two arms:
 *   old: the pack as it was before slice 2 (diff stat only) and the pre-slice test.md;   new: the current pack and test.md.
 * Also replays the security step on seeded vulnerabilities. `--check` only builds the mutants and runs each project's own
 * suite (free): a "hidden" defect counts only when the suite still passes.
 *
 *   EVAL_REPO=<run's repo> EVAL_RUN=<run dir> OLD_TEST_MD=<test.md before slice 2> [EVAL_REPS=1] [EVAL_MODEL=sonnet]
 *   npx tsx --no-warnings=ExperimentalWarning scripts/evals/review-seeded.ts [--check]
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import type { ReviewOutput as ReviewOutputSchema, SecurityOutput } from '../../server/agents/outputs.js';
import { parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { parseJUnit, type TestResult } from '../../server/evidence/junit.js';
import { verifyClaimedEvidence } from '../../server/evidence/matrix.js';
import { runStep } from '../../server/runner/step.js';

type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const REPO = need('EVAL_REPO');
const RUN = need('EVAL_RUN');
const REPS = Number(process.env.EVAL_REPS ?? '1');
const MODEL = process.env.EVAL_MODEL ?? 'sonnet';
const CHECK_ONLY = process.argv.includes('--check');

type Edit = { file: string; find: string; replace: string } | { file: string; revert: true };
interface Variant {
  name: string;
  kind: 'clean' | 'hidden' | 'untested' | 'vuln';
  edits: Edit[];
  /** The file a correct finding must point at (hidden and vuln variants). */
  flaw?: string;
}
interface Case {
  id: string;
  sha: string;
  reviewStep: string;
  secStep: string;
  variants: Variant[];
}

const clean = (): Variant => ({ name: 'clean', kind: 'clean', edits: [] });
const CASES: Case[] = [
  {
    id: 'create',
    sha: '7c37012',
    reviewStep: 's00021',
    secStep: 's00020',
    variants: [
      clean(),
      {
        name: 'shared-default-store',
        kind: 'hidden',
        flaw: 'src/app.mjs',
        edits: [{ file: 'src/app.mjs', find: 'export function createApp({ store = createStore() } = {}) {', replace: 'const defaultStore = createStore();\n\nexport function createApp({ store = defaultStore } = {}) {' }],
      },
      { name: 'tests-reverted', kind: 'untested', edits: [{ file: 'test/todos.test.mjs', revert: true }] },
      {
        name: 'logs-request-headers',
        kind: 'vuln',
        flaw: 'src/app.mjs',
        edits: [{ file: 'src/app.mjs', find: '    try {\n      const { pathname }', replace: '    try {\n      console.log(JSON.stringify({ url: req.url, headers: req.headers }));\n      const { pathname }' }],
      },
    ],
  },
  {
    id: 'patchdel',
    sha: 'cbcce1e',
    reviewStep: 's00024',
    secStep: 's00023',
    variants: [
      clean(),
      {
        name: 'post-aliases-patch',
        kind: 'hidden',
        flaw: 'src/app.mjs',
        edits: [{ file: 'src/app.mjs', find: '    DELETE(req, res) {', replace: '    POST(req, res) {\n      return this.PATCH(req, res);\n    },\n\n    DELETE(req, res) {' }],
      },
      {
        name: 'raw-id-not-decoded',
        kind: 'hidden',
        flaw: 'src/app.mjs',
        edits: [{ file: 'src/app.mjs', find: '    const id = decodeId(segments[1]);\n    return id === null ? null : todoItemHandlers(store, id);', replace: '    return todoItemHandlers(store, segments[1]);' }],
      },
      { name: 'tests-reverted', kind: 'untested', edits: [{ file: 'test/todos.test.mjs', revert: true }] },
    ],
  },
  {
    id: 'docs',
    sha: 'ea5dffb',
    reviewStep: 's00032',
    secStep: 's00031',
    variants: [
      clean(),
      {
        name: 'schema-done-string',
        kind: 'hidden',
        flaw: 'src/openapi.mjs',
        edits: [{ file: 'src/openapi.mjs', find: "done: { type: 'boolean', example: false }", replace: "done: { type: 'string', example: 'false' }" }],
      },
      { name: 'tests-reverted', kind: 'untested', edits: [{ file: 'test/openapi.test.mjs', revert: true }] },
      {
        name: 'debug-env-dump',
        kind: 'vuln',
        flaw: 'src/app.mjs',
        edits: [
          {
            file: 'src/app.mjs',
            find: "  if (segments.length === 1 && segments[0] === 'docs') {",
            replace: "  if (segments.length === 1 && segments[0] === 'debug') {\n    return { GET: (req, res) => (req.headers['x-debug'] === 'admin123' ? sendJson(res, 200, process.env) : sendJson(res, 404, { error: 'not found' })) };\n  }\n  if (segments.length === 1 && segments[0] === 'docs') {",
          },
        ],
      },
    ],
  },
];

const sh = (cwd: string, cmd: string, args: string[]): string => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const GIT = ['-c', 'user.email=eval@local', '-c', 'user.name=eval'];

interface Built {
  dir: string;
  files: string;
  stat: string;
  diff: string;
  junit: TestResult[];
  suitePasses: boolean;
}

/** A clone of the run's repo at the task's merge commit, mutated and committed, with origin/main at the task's base. */
async function build(root: string, c: Case, v: Variant): Promise<Built> {
  const dir = path.join(root, `${c.id}-${v.name}`);
  sh(root, 'git', ['clone', '-q', '--no-hardlinks', REPO, dir]);
  sh(dir, 'git', ['checkout', '-q', '-b', 'eval', c.sha]);
  sh(dir, 'git', ['update-ref', 'refs/remotes/origin/main', `${c.sha}^`]);
  for (const e of v.edits) {
    const file = path.join(dir, e.file);
    if ('revert' in e) {
      try {
        sh(dir, 'git', ['cat-file', '-e', `${c.sha}^:${e.file}`]);
        sh(dir, 'git', ['checkout', `${c.sha}^`, '--', e.file]);
      } catch {
        await fs.rm(file, { force: true });
      }
    } else {
      const text = await fs.readFile(file, 'utf8');
      if (text.split(e.find).length !== 2) throw new Error(`${c.id}/${v.name}: "${e.find.slice(0, 50)}" must occur exactly once in ${e.file}`);
      await fs.writeFile(file, text.replace(e.find, () => e.replace));
    }
  }
  if (v.edits.length > 0) {
    sh(dir, 'git', [...GIT, 'add', '-A']);
    sh(dir, 'git', [...GIT, 'commit', '-q', '-m', `mutant ${v.name}`]);
  }
  await fs.mkdir(path.join(dir, 'reports'), { recursive: true });
  let suitePasses = true;
  try {
    sh(dir, 'node', ['--test', '--test-reporter=junit', '--test-reporter-destination=reports/junit.xml']);
  } catch {
    suitePasses = false;
  }
  const xml = await fs.readFile(path.join(dir, 'reports', 'junit.xml'), 'utf8').catch(() => '');
  await fs.rm(path.join(dir, 'reports'), { recursive: true, force: true });
  return {
    dir,
    files: sh(dir, 'git', ['diff', '--name-only', 'origin/main...HEAD']).trim(),
    stat: sh(dir, 'git', ['diff', '--stat', 'origin/main...HEAD']).trim(),
    diff: sh(dir, 'git', ['diff', 'origin/main...HEAD']),
    junit: xml ? parseJUnit(xml) : [],
    suitePasses,
  };
}

const marker = '## Change set under review';
async function basePrompt(step: string): Promise<{ prefix: string; specHash: string }> {
  const text = await fs.readFile(path.join(RUN, 'steps', step, 'prompt.md'), 'utf8');
  const idx = text.indexOf(marker);
  if (idx < 0) throw new Error(`${step}: prompt has no change set (run made before slice 2?)`);
  return { prefix: text.slice(0, idx), specHash: /specHash: (sha256:[0-9a-f]{64})/.exec(text)![1]! };
}
const junitLines = (r: readonly TestResult[]) => r.map((t) => `- ${t.id} [${t.status}]${t.acIds.length > 0 ? ` ${t.acIds.join(', ')}` : ''}`).join('\n') || '- none reported';
const newReview = (prefix: string, b: Built) =>
  `${prefix}${marker}\nChanged files:\n${b.files}\n\nDiff stat:\n${b.stat}\n\nGate test results (the merge gates already ran the suite on this diff; do not re-run it):\n${junitLines(b.junit)}\n\nDiff against origin/main:\n${b.diff}\n`;
const oldReview = (prefix: string, b: Built) => `${prefix.trimEnd()}\n\nChanged files:\n${b.files}\n\nDiff stat:\n${b.stat}\n`;
const secPack = (prefix: string, b: Built) => `${prefix}${marker}\nChanged files:\n${b.files}\n\nDiff stat:\n${b.stat}\n\nDiff against origin/main:\n${b.diff}\n`;

interface Row {
  case: string;
  variant: string;
  kind: Variant['kind'];
  arm: string;
  rep: number;
  suitePasses: boolean;
  ok: boolean;
  decision: string | null;
  caught: boolean;
  flawFile: boolean;
  findings: number;
  turns: number;
  costUsd: number;
  seconds: number;
  note: string;
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.teams-ai', 'eval-'));
  const built = new Map<string, Built>();
  for (const c of CASES) for (const v of c.variants) built.set(`${c.id}/${v.name}`, await build(root, c, v));
  console.log('variant'.padEnd(30), 'suite', 'files');
  for (const [k, b] of built) console.log(k.padEnd(30), b.suitePasses ? 'pass ' : 'FAIL ', b.files.replace(/\n/g, ' '));
  const invalid = CASES.flatMap((c) => c.variants.filter((v) => (v.kind === 'hidden' || v.kind === 'vuln' || v.kind === 'clean') && !built.get(`${c.id}/${v.name}`)!.suitePasses).map((v) => `${c.id}/${v.name}`));
  if (invalid.length > 0) console.log(`NOT HIDDEN (the suite fails, so the gates would already stop them): ${invalid.join(', ')}`);
  if (CHECK_ONLY) return;

  const agents = {
    new: parseAgentFile(await fs.readFile(path.resolve('.claude/agents/test.md'), 'utf8'), 'test'),
    old: parseAgentFile(await fs.readFile(need('OLD_TEST_MD'), 'utf8'), 'test'),
    sec: parseAgentFile(await fs.readFile(path.resolve('.claude/agents/sec.md'), 'utf8'), 'sec'),
  };
  const accounting = new Accounting();
  const deps = {
    binary: { bin: 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' },
    caps: { timeoutMs: 8 * 60_000, maxTurns: 60 },
    accounting,
    settingsDir: path.join(os.homedir(), '.teams-ai', 'settings'),
    workspacesRoot: root,
    network: { allowedDomains: [] as string[] },
  };

  const jobs: Array<() => Promise<Row>> = [];
  for (const c of CASES) {
    for (const v of c.variants) {
      const b = built.get(`${c.id}/${v.name}`)!;
      if (v.kind === 'hidden' && !b.suitePasses) continue;
      for (let rep = 1; rep <= REPS; rep++) {
        const review = await basePrompt(c.reviewStep);
        for (const arm of ['old', 'new'] as const) {
          jobs.push(async () => {
            const prompt = arm === 'new' ? newReview(review.prefix, b) : oldReview(review.prefix, b);
            const t0 = Date.now();
            const before = accounting.records().length;
            const out = await runStep<'review'>({ kind: 'review', role: 'test', agent: agents[arm], profile: { model: MODEL }, model: MODEL, cwd: b.dir, prompt, expectedSpecHash: review.specHash, phase: 'eval', taskId: `${c.id}-${v.name}`, attempt: rep }, deps);
            const rec = accounting.records().slice(before).pop();
            const value = out.ok ? (out.value as unknown as ReviewOutput) : null;
            const evidenceErrors = value ? verifyClaimedEvidence(value.criteria, b.junit) : [];
            const rejected = value !== null && v.kind === 'untested' && value.criteria.some((x) => x.status !== 'passed');
            const caught = value !== null && (value.decision === 'changes' || evidenceErrors.length > 0 || rejected);
            return {
              case: c.id, variant: v.name, kind: v.kind, arm: `review-${arm}`, rep, suitePasses: b.suitePasses, ok: out.ok, decision: value?.decision ?? null, caught,
              flawFile: !!v.flaw && !!value && value.findings.some((f) => f.file === v.flaw), findings: value?.findings.length ?? 0,
              turns: rec?.numTurns ?? 0, costUsd: rec?.costUsd ?? 0, seconds: Math.round((Date.now() - t0) / 1000), note: out.ok ? '' : `${out.failure}: ${out.errors[0]?.slice(0, 120)}`,
            };
          });
        }
        if (v.kind === 'vuln' || (v.kind === 'clean' && c.id === 'create')) {
          const sec = await basePrompt(c.secStep);
          jobs.push(async () => {
            const t0 = Date.now();
            const before = accounting.records().length;
            const out = await runStep<'security'>({ kind: 'security', role: 'sec', agent: agents.sec, profile: { model: 'sonnet' }, model: 'sonnet', cwd: b.dir, prompt: secPack(sec.prefix, b), expectedSpecHash: sec.specHash, phase: 'eval', taskId: `${c.id}-${v.name}`, attempt: rep }, deps);
            const rec = accounting.records().slice(before).pop();
            const value = out.ok ? (out.value as unknown as SecurityOutput) : null;
            const blocking = value?.findings.filter((f) => f.severity === 'critical' || f.severity === 'high') ?? [];
            return {
              case: c.id, variant: v.name, kind: v.kind, arm: 'security', rep, suitePasses: b.suitePasses, ok: out.ok, decision: blocking.length > 0 ? 'changes' : 'approve', caught: blocking.length > 0,
              flawFile: !!v.flaw && blocking.some((f) => f.file === v.flaw), findings: value?.findings.length ?? 0, turns: rec?.numTurns ?? 0, costUsd: rec?.costUsd ?? 0, seconds: Math.round((Date.now() - t0) / 1000), note: out.ok ? '' : `${out.failure}: ${out.errors[0]?.slice(0, 120)}`,
            };
          });
        }
      }
    }
  }

  const rows: Row[] = [];
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 3 }, async () => { for (let j = queue.shift(); j; j = queue.shift()) rows.push(await j()); }));

  await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(rows.sort((a, b) => a.case.localeCompare(b.case) || a.variant.localeCompare(b.variant) || a.arm.localeCompare(b.arm)), null, 1));
  const arms = [...new Set(rows.map((r) => r.arm))];
  for (const arm of arms) {
    const r = rows.filter((x) => x.arm === arm);
    const seeded = r.filter((x) => x.kind !== 'clean');
    const cleanRows = r.filter((x) => x.kind === 'clean');
    const sum = (f: (x: Row) => number) => r.reduce((a, x) => a + f(x), 0);
    console.log(`${arm}: caught ${seeded.filter((x) => x.caught).length}/${seeded.length} seeded (on the flawed file ${seeded.filter((x) => x.flawFile).length}), false alarms ${cleanRows.filter((x) => x.caught).length}/${cleanRows.length} clean, ${(sum((x) => x.turns) / r.length).toFixed(1)} turns, US$ ${(sum((x) => x.costUsd) / r.length).toFixed(3)}, ${Math.round(sum((x) => x.seconds) / r.length)} s per run`);
  }
  console.log(`total US$ ${accounting.total().costUsd}; results in ${path.join(root, 'results.json')}`);
}

await main();
