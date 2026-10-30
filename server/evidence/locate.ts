import { execCommand, type Exec } from '../exec/command.js';
import { OrchEvent } from '../orchestrator/events.js';
import type { StoredEvent } from '../store/event-store.js';

/** A test as the JUnit report names it; the id is `classname::name`. */
export interface TestRef {
  id: string;
  name: string;
  classname: string;
}

/** Where a test sits in its repository: the file and the line to link. */
export interface TestPlace {
  path: string;
  line: number;
}

/** What to search for in the code: the function or the tagged title, and the subtest title when the test is one. */
export interface Needles {
  anchor: string;
  leaf: string | null;
}

/** One match of `git grep -o`: its file, its line and the matched text. */
export interface Hit {
  path: string;
  line: number;
  text: string;
}

const NAME_LIMIT = 300;
const QUOTE = `["'\`]`;
const GO_TEST = /^(Test|Fuzz|Example|Benchmark)(?![a-z])\w*$/;
const CODE_TYPES = ['go', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'rs', 'java', 'kt', 'kts', 'scala', 'cs', 'rb', 'php', 'dart', 'swift'];
// Only source files: documents and vendored code name tests too.
const PATHSPEC = [...CODE_TYPES.map((t) => `*.${t}`), ':(exclude,glob)**/vendor/**', ':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/third_party/**', ':(exclude,glob)docs/**'];
const GREP_TIMEOUT_MS = 20_000;
const GREP_OUTPUT_LIMIT = 4 * 1024 * 1024;

const escapeRe = (s: string) => s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
const quoted = (body: string) => `${QUOTE}${body}${QUOTE}`;

/** What to search for in the code to find a test from its JUnit name; null when the name is not safe to search for. */
export function needlesOf(name: string): Needles | null {
  if (name.length === 0 || name.length > NAME_LIMIT || /[\u0000-\u001f\u007f]/.test(name)) return null;
  const slash = name.indexOf('/');
  const top = slash < 0 ? name : name.slice(0, slash);
  if (GO_TEST.test(top)) {
    // Go turns the spaces of a subtest name into underscores, so an underscore matches either one.
    const leaf = slash < 0 ? null : quoted(name.slice(slash + 1).split('_').map(escapeRe).join('[ _]'));
    return { anchor: `^func ${top}[(]`, leaf };
  }
  const ident = name.replace(/\(.*\)$/, '').replace(/\[.*\]$/, '').split(/::|\./).pop()!;
  if (/^[A-Za-z_]\w{2,}$/.test(ident)) return { anchor: `(^|[^A-Za-z0-9_])${ident}[(]`, leaf: null };
  const title = name.split(/ > | › /).pop()!;
  return title.includes('[AC-') ? { anchor: quoted(escapeRe(title)), leaf: null } : null;
}

/** Whether a JUnit classname names the file: a path ending in it, a Go package directory, or a dotted class holding the file name. */
export function fits(file: string, classname: string): boolean {
  if (classname === '' || classname === 'tap') return false;
  if (file === classname || file.endsWith(`/${classname}`)) return true;
  const slash = file.lastIndexOf('/');
  const dir = file.slice(0, Math.max(slash, 0));
  if (dir !== '' && (classname === dir || classname.endsWith(`/${dir}`))) return true;
  const stem = file.slice(slash + 1).replace(/\.[^.]*$/, '');
  return classname.replace(/\$.*$/, '').split('.').includes(stem);
}

/** The records of `git grep -n -z -o` for one commit: `<commit>:<path>`, NUL, line, NUL, match, newline. */
export function parseHits(stdout: string, sha: string): Hit[] {
  const prefix = `${sha}:`;
  const hits: Hit[] = [];
  for (const record of stdout.split('\n')) {
    if (!record.startsWith(prefix)) continue;
    const [path, line, text] = record.slice(prefix.length).split('\u0000');
    if (path === undefined || line === undefined || text === undefined) continue;
    hits.push({ path, line: Number(line), text });
  }
  return hits;
}

/** The place of a test among the hits: its file, then its line; null when the hits cannot tell which one is the test. */
export function pickPlace(hits: readonly Hit[], n: Needles, classname: string): TestPlace | null {
  const anchor = new RegExp(n.anchor);
  const found = hits.filter((h) => anchor.test(h.text));
  const files = [...new Set(found.map((h) => h.path))];
  const near = files.filter((f) => fits(f, classname));
  const file = near.length === 1 ? near[0]! : near.length === 0 && files.length === 1 ? files[0]! : null;
  if (file === null) return null;
  const heads = [...new Set(found.filter((h) => h.path === file).map((h) => h.line))];
  if (heads.length !== 1) return null;
  const head = heads[0]!;
  if (n.leaf === null) return { path: file, line: head };
  // A subtest counts only inside its own function: the next Go function in the same file ends that search.
  const next = hits.reduce((min, h) => (h.path === file && h.line > head && h.text.startsWith('func ') ? Math.min(min, h.line) : min), Infinity);
  const leaf = new RegExp(n.leaf);
  const lines = [...new Set(hits.filter((h) => h.path === file && h.line > head && h.line < next && leaf.test(h.text)).map((h) => h.line))];
  return { path: file, line: lines.length === 1 ? lines[0]! : head };
}

/** A JUnit row as the gate recorded it. */
interface JunitRow {
  id: string;
  name: string;
  classname: string;
  acIds: string[];
}

/**
 * The acceptance-criterion tests of each repository of a run, keyed by service ('' for the project's own repository).
 * A test id seen under two repositories is left out, since its link could point to the wrong one.
 */
export function testsByRepo(events: readonly StoredEvent[], serviceOfTask: (taskId: string) => string | undefined): Map<string, TestRef[]> {
  const refs = new Map<string, TestRef>();
  const repos = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type !== OrchEvent.GatePassed && e.type !== OrchEvent.GateFailed) continue;
    const { taskId } = e.data;
    const service = typeof e.data.service === 'string' ? e.data.service : typeof taskId === 'string' ? (serviceOfTask(taskId) ?? '') : '';
    for (const row of (e.data.junit as JunitRow[] | undefined) ?? []) {
      if (row.acIds.length === 0) continue;
      refs.set(row.id, { id: row.id, name: row.name, classname: row.classname });
      repos.set(row.id, (repos.get(row.id) ?? new Set<string>()).add(service));
    }
  }
  const byRepo = new Map<string, TestRef[]>();
  for (const ref of refs.values()) {
    const keys = [...repos.get(ref.id)!];
    if (keys.length !== 1) continue;
    byRepo.set(keys[0]!, [...(byRepo.get(keys[0]!) ?? []), ref]);
  }
  return byRepo;
}

async function commitOf(repoDir: string, exec: Exec): Promise<string | null> {
  const r = await exec({ bin: 'git', args: ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], cwd: repoDir, timeoutMs: 10_000 });
  const sha = r.stdout.trim();
  return r.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * Finds each test in the commit of origin/main of one repository, with one `git grep` for all of them.
 * Null when the repository has no origin/main; throws when git fails, so a failure never becomes a guessed link.
 */
export async function locateTests(repoDir: string, tests: readonly TestRef[], exec: Exec = execCommand): Promise<{ sha: string; places: Map<string, TestPlace> } | null> {
  const sha = await commitOf(repoDir, exec);
  if (sha === null) return null;
  const wanted = tests.flatMap((test) => {
    const needles = needlesOf(test.name);
    return needles === null ? [] : [{ test, needles }];
  });
  const places = new Map<string, TestPlace>();
  if (wanted.length === 0) return { sha, places };
  const patterns = [...new Set(wanted.flatMap(({ needles }) => (needles.leaf === null ? [needles.anchor] : [needles.anchor, needles.leaf])))];
  const r = await exec({
    bin: 'git',
    args: ['grep', '-n', '-I', '-z', '-o', '-E', '--no-color', '-f', '-', sha, '--', ...PATHSPEC],
    cwd: repoDir,
    env: { LC_ALL: 'C' },
    stdin: `${patterns.join('\n')}\n`,
    timeoutMs: GREP_TIMEOUT_MS,
    outputLimit: GREP_OUTPUT_LIMIT,
  });
  if (r.timedOut || r.truncated || (r.exitCode !== 0 && r.exitCode !== 1)) throw new Error(`git grep failed (${r.exitCode}): ${r.stderr.trim()}`);
  const hits = r.exitCode === 0 ? parseHits(r.stdout, sha) : [];
  for (const { test, needles } of wanted) {
    const place = pickPlace(hits, needles, test.classname);
    if (place !== null) places.set(test.id, place);
  }
  return { sha, places };
}
