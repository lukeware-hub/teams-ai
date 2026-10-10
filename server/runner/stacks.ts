import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Package registries per stack; npm stays open for every stack, as before stacks existed. */
const REGISTRIES: Record<StackKind, readonly string[]> = {
  node: [],
  python: ['pypi.org', 'files.pythonhosted.org'],
  go: ['proxy.golang.org', 'sum.golang.org'],
  rust: ['crates.io', 'index.crates.io', 'static.crates.io'],
  other: [],
};

/** The registries a step's sandbox may reach: only those of the run's stack (least privilege). */
export function stackDomains(kind: StackKind): string[] {
  return ['registry.npmjs.org', ...REGISTRIES[kind]];
}

/** Toolchain commands a Dev or Test may run besides npm and node (Python goes through the virtualenv in `.tools/venv`). */
export const STACK_BASH: readonly string[] = [
  'Bash(go:*)',
  'Bash(cargo:*)',
  'Bash(rustc:*)',
  'Bash(python3:*)',
  'Bash(python:*)',
  'Bash(.tools/venv/bin/python:*)',
  'Bash(.tools/venv/bin/python3:*)',
  'Bash(.tools/venv/bin/pip:*)',
  'Bash(.tools/venv/bin/pytest:*)',
];

/**
 * Every toolchain cache and build output lives in the worktree's `.tools` (never committed): the agent sandbox writes only inside the worktree,
 * and the gates run offline in another container, so the dependencies the install step fetched must travel with the worktree.
 * Python packages go to `.tools/py` (`pip install --target`), which `PYTHONPATH` exposes. The step env drops the host's Go and Rust variables, so they are set here.
 */
export function stackEnv(cwd: string): Record<string, string> {
  const tools = path.join(cwd, '.tools');
  return {
    GOPATH: path.join(tools, 'go'),
    GOCACHE: path.join(tools, 'go-build'),
    GOTOOLCHAIN: 'local',
    GOFLAGS: '-modcacherw', // the module cache stays writable, or the worktree cannot be deleted
    CARGO_HOME: path.join(tools, 'cargo'),
    RUSTUP_HOME: '/usr/local/rustup',
    PIP_CACHE_DIR: path.join(tools, 'pip-cache'),
    PYTHONPATH: path.join(tools, 'py'),
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONPYCACHEPREFIX: path.join(tools, 'pycache'),
    PYTEST_ADDOPTS: '-p no:cacheprovider',
  };
}

export type StackKind = 'node' | 'python' | 'go' | 'rust' | 'other';

const STACK_PATTERNS: Record<Exclude<StackKind, 'other'>, RegExp> = {
  node: /\b(node|nodejs|typescript|javascript|npm|pnpm|yarn|bun|deno|express)\b/i,
  python: /\b(python|pip|uv|django|flask|fastapi|poetry)\b/i,
  go: /\b(go|golang|gin|echo|fiber)\b/i,
  rust: /\b(rust|cargo|axum|actix|rocket)\b/i,
};

/** The stack a free text names (the plan's stack, optionally with the gate image); the earliest mention wins. */
export function stackKind(text: string): StackKind {
  let best: StackKind = 'other';
  let at = Infinity;
  for (const [kind, pattern] of Object.entries(STACK_PATTERNS) as Array<[Exclude<StackKind, 'other'>, RegExp]>) {
    const index = pattern.exec(text)?.index;
    if (index !== undefined && index < at) [best, at] = [kind, index];
  }
  return best;
}

/** Folders that dependencies or builds fill: gates own them and scanners skip them (a path regex source, matched at the start). */
export const BUILD_DIRS: readonly string[] = ['node_modules', 'vendor', 'target', '.venv', '__pycache__', '.pytest_cache'];

/** Build folders never committed; the secret scan may skip them. Go commits `vendor/`, so it is still scanned. */
export const UNCOMMITTED_BUILD_DIRS: readonly string[] = BUILD_DIRS.filter((d) => d !== 'vendor');

const CARGO_RECORDS = ['.crates.toml', '.crates2.json'];

const isRegularFile = (p: string) => fs.lstat(p).then((s) => s.isFile(), () => false);

/** Copies one regular file, first removing whatever is at the destination so a planted symlink is never written through. */
async function copyRegular(source: string, dest: string): Promise<void> {
  if (!(await isRegularFile(source))) return;
  await fs.rm(dest, { force: true, recursive: true });
  await fs.copyFile(source, dest, fs.constants.COPYFILE_EXCL);
}

/** A real directory at `dir`, replacing a symlink or file someone left there. */
async function realDir(dir: string): Promise<void> {
  if (!(await fs.lstat(dir).then((s) => s.isDirectory(), () => false))) await fs.rm(dir, { force: true, recursive: true });
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Copies what `cargo install --root` leaves (the binaries in bin/ and cargo's own records of them) from one root to another.
 * Seeding a worktree's .tools from a per-project cache makes cargo see the tools already installed and skip a rebuild that
 * a per-worktree CARGO_HOME would otherwise force (live: three Rust installs took over 20 minutes). Only regular files are
 * copied, never symlinks or nested folders: the worktree side is agent-writable.
 */
export async function copyCargoRoot(from: string, to: string): Promise<void> {
  const bins = await fs.readdir(path.join(from, 'bin'), { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(CARGO_RECORDS.map((name) => isRegularFile(path.join(from, name))));
  if (bins.length === 0 && !records.some(Boolean)) return;
  await realDir(to);
  await realDir(path.join(to, 'bin'));
  for (const entry of bins) if (entry.isFile()) await copyRegular(path.join(from, 'bin', entry.name), path.join(to, 'bin', entry.name));
  for (const name of CARGO_RECORDS) await copyRegular(path.join(from, name), path.join(to, name));
}
