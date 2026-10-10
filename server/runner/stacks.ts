import path from 'node:path';

/** Package registries the agent sandbox may reach, per supported stack: Node.js, Python, Go and Rust. */
export const STACK_DOMAINS: readonly string[] = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'sum.golang.org',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
];

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
    CARGO_TARGET_DIR: path.join(tools, 'cargo-target'),
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
