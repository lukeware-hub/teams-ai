import { promises as fs } from 'node:fs';
import path from 'node:path';

const NAME = '[A-Z][A-Z0-9_]*';
/** Names the platform or the container provide, which no recipe has to create. */
const PROVIDED = /^(SERVICE_URL(_[A-Z0-9_]+)?|TEAMS_AI_IMAGE|PORT|HOME|PATH|HOSTNAME|USER|PWD|TZ|LANG|CI|NODE_ENV|GOFLAGS|GOPATH|GOCACHE|DEBUG|TMPDIR|SHELL)$/;
const SOURCE_EXT = new Set(['.go', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.rs']);
const SUITE_DIRS = ['e2e', 'smoke', 'test/e2e', 'test/smoke', 'tests/e2e', 'tests/smoke'];
const MAX_FILE_CHARS = 200_000;
const MAX_FILES = 40;

export interface ScannedFile {
  path: string;
  text: string;
}

/** Names a compose file reads from the environment of its caller: `${X}`, `$X` and a pass-through list item `- X`, without a default. */
function composeReads(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(`\\$\\{(${NAME})(:?[-?+=][^}]*)?\\}`, 'g'))) if (!/^:?[-+=]/.test(m[2] ?? '')) out.push(m[1]!);
  for (const m of text.matchAll(new RegExp(`\\$(${NAME})\\b`, 'g'))) out.push(m[1]!);
  for (const m of text.matchAll(new RegExp(`^\\s*-\\s*(${NAME})\\s*$`, 'gm'))) out.push(m[1]!);
  return out;
}

/** What the compose file itself sets (`- X=value`, `X: value`), so the variable exists inside the container; a value that is only the same name read from the caller does not count. */
function composeSets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(`^\\s*-?\\s*(${NAME})(?:=|:\\s+)(\\S.*)$`, 'gm'))) {
    const name = m[1]!;
    if (!new RegExp(`\\$\\{?${name}\\b`).test(m[2]!)) out.push(name);
  }
  return out;
}

/** An empty assignment in a template: the author says the value is for the environment to give. */
function envTemplateReads(text: string): string[] {
  return [...text.matchAll(new RegExp(`^(${NAME})=\\s*$`, 'gm'))].map((m) => m[1]!);
}

const CODE_READS: RegExp[] = [
  new RegExp(`process\\.env\\.(${NAME})`, 'g'),
  new RegExp(`process\\.env\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g'),
  new RegExp(`os\\.(?:Getenv|LookupEnv)\\(\\s*"(${NAME})"`, 'g'),
  new RegExp(`os\\.environ(?:\\.get)?[\\[(]\\s*['"](${NAME})['"]`, 'g'),
  new RegExp(`os\\.getenv\\(\\s*['"](${NAME})['"]`, 'g'),
  new RegExp(`env::var\\(\\s*"(${NAME})"`, 'g'),
  // A project's own helper: envOr("NAME", ...), getEnv("NAME"), requireEnv("NAME").
  new RegExp(`[Ee]nv\\w*\\(\\s*["'](${NAME})["']`, 'g'),
];

function codeReads(text: string): string[] {
  return CODE_READS.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]!));
}

/** Variables the files read from the environment that nothing in `known` or the files themselves provides, in order of appearance. */
export function unknownVariables(files: readonly ScannedFile[], known: Iterable<string>): string[] {
  const have = new Set(known);
  const reads: string[] = [];
  for (const f of files) {
    const base = path.basename(f.path);
    if (/^docker-compose.*\.ya?ml$/i.test(base) || /compose.*\.ya?ml$/i.test(base)) {
      reads.push(...composeReads(f.text));
      for (const n of composeSets(f.text)) have.add(n);
    } else if (/^\.env(\.\w+)?$/.test(base) || base === '.env.example') reads.push(...envTemplateReads(f.text));
    else if (SOURCE_EXT.has(path.extname(base))) reads.push(...codeReads(f.text));
  }
  return [...new Set(reads)].filter((n) => !have.has(n) && !PROVIDED.test(n));
}

async function readText(file: string): Promise<string | null> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_FILE_CHARS) return null;
  return fs.readFile(file, 'utf8').catch(() => null);
}

async function suiteFiles(root: string, rel: string, out: ScannedFile[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const next = path.join(rel, e.name);
    if (e.isDirectory()) await suiteFiles(root, next, out);
    else if (SOURCE_EXT.has(path.extname(e.name))) {
      const text = await readText(path.join(root, next));
      if (text !== null) out.push({ path: next, text });
    }
  }
}

/** The compose file, the env template and the smoke and e2e suites of a repository checkout. */
export async function scanRepository(root: string, opts: { compose?: string; e2eSuite?: string }): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  for (const rel of [opts.compose, '.env.example'].filter((f): f is string => !!f)) {
    const text = await readText(path.join(root, rel));
    if (text !== null) files.push({ path: rel, text });
  }
  const dirs = new Set(SUITE_DIRS);
  if (opts.e2eSuite) dirs.add(opts.e2eSuite.endsWith('/') ? opts.e2eSuite.slice(0, -1) : path.dirname(opts.e2eSuite));
  for (const d of dirs) if (d !== '.') await suiteFiles(root, d, files);
  return files;
}
