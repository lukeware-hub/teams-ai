# teams-ai Plan 8 — Web UI Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human get the orchestrator host authenticated and configured from the browser alone: Claude login, GitHub owner, `gh` login, GitHub token and OpenRouter key, each verified by a live probe, each redoable from a status screen.

**Architecture:** A `node:http` API on `127.0.0.1` exposes five onboarding items and two CLI login sessions. A login session is a state machine fed by a pseudo-terminal (`script -qfec`) so `claude auth login` and `gh auth login --web` behave as in a terminal; the server extracts the URL and one-time code from the transcript, streams redacted output over SSE, and only a probe (`claude auth status --json`, `gh auth status`, `gh api`, one Jev call) turns an item green. Secrets are written atomically with mode 0600 and never echoed. The web app (React + Vite) is a thin view over the API.

**Tech Stack:** Node 22 (ESM), TypeScript 5.9.3, Vitest 5, zod 4, `node:http`, util-linux `script`. Web: Vite 8.3.1, React 19.3.0, react-router-dom 7.18.4, Testing Library 16.3.3, jsdom 30.1.1. No new server dependency.

**Spec:** `docs/superpowers/specs/2026-09-24-web-ui-onboarding-design.md` (all sections); POC spec `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` §3 (config, secrets layout), §10 (confidential rule, key placement), §11 (React + Vite), §14 (redaction), §15 (host).

## Global Constraints

- Everything from Plan 1's Global Constraints (pins, ESM, `.js` import suffix, English, commit trailer).
- No new server dependency: the API is `node:http`, SSE is a chunked `text/event-stream` response, the pty is util-linux `script`. `node-pty` is the documented fallback only (spec §3.3) and is not installed here.
- Web dependencies pinned exactly: `vite 8.3.1`, `react 19.3.0`, `react-dom 19.3.0`, `@vitejs/plugin-react 6.1.1`, `react-router-dom 7.18.4`, `@types/react 19.3.0`, `@types/react-dom 19.3.0`, `@testing-library/react 16.3.3`, `@testing-library/dom 10.4.2`, `jsdom 30.1.1`, `vitest 5.0.1`, `typescript 5.9.3`. They live in `web/package.json`; the root `npm test` is unchanged and `npm run test:web` runs the web tests.
- `npm test` never spawns `claude`, `gh`, `docker` or the network. Login flows are tested against `test/fixtures/fake-cli/*.sh`; pty tests are skipped when `script` is not on `PATH` (Windows), and the WSL run exercises them.
- The API binds `127.0.0.1` only and refuses `Host` headers other than `localhost`/`127.0.0.1` (with optional port).
- A secret value never appears in a response body, an SSE event, a log line or an error message: responses carry `{ set, hint }` with the last 4 characters only; every pty chunk and probe output passes `redactSecrets(text, knownValues)` before it is stored or streamed; one-time codes and pasted codes are never persisted.
- Child processes run with `sanitizeEnv(process.env)` plus `HOME`; `GH_TOKEN` is set only for the token probe.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

## Review Focus

1. **A pasted code that contains characters `script` or the shell would interpret.** The Claude callback code has the form `<code>#<state>`; it must reach the CLI byte for byte through the pty, and never appear in a log or SSE event (Task 4 test "writes the pasted code plus newline to the pty and never emits it").
2. **A secret typed into the wrong field.** A GitHub token pasted as the OpenRouter key must not be echoed back by the failing probe's error message (Task 6 test "a rejected secret value never appears in the response body or the log").
3. **Browser page on another origin calling the API.** DNS rebinding sends a request with a foreign `Host`; the server must answer 403 before any handler runs (Task 6 test "refuses a foreign Host header").
4. **Two "Login" clicks in a row.** The second must kill the first session's process, not leave two `claude` processes competing for the credentials file (Task 4 test "starting a new session kills the live one").
5. **The CLI finishes without ever printing a URL** (already logged in, or a changed transcript). The session must still reach `verifying` and let the probe decide, not hang in `starting` until the timeout (Task 4 test "a process that exits before printing a URL goes straight to verifying").

## File structure

```
server/core/secrets.ts                 + writeSecret(dir, name, value): 0700 dir, 0600 file, atomic rename
server/onboarding/config-store.ts      readUserConfig(home) / setGithubOwner(home, owner) on ~/.teams-ai/config.json
server/onboarding/transcripts.ts       extractUrl, extractOneTimeCode, isPasteCodePrompt, isSuccessLine, TranscriptReader
server/onboarding/pty.ts               Pty interface, hasScript(), spawnScriptPty()
server/onboarding/login-session.ts     LoginSession: idle → starting → awaiting-browser → [awaiting-code] → verifying → done | failed
server/onboarding/probes.ts            claudeStatus, ghStatus, ghOwner, ghToken, openrouterKey (all injected Exec/fetch)
server/onboarding/status.ts            computeStatus(): the five items, secret hints
server/api/server.ts                   startApi(): node:http, 127.0.0.1, Host check, JSON helpers, SSE helper, static web/dist
server/api/onboarding-routes.ts        route table of spec §5
server/cli.ts                          + `teams-ai ui [--port N]`
web/                                   Vite + React app: /onboarding, /status; ItemCard, LoginCard, SecretCard, OwnerCard, useSse
test/fixtures/fake-cli/claude.sh       fake `claude auth login`: URL, "paste the code" prompt, reads stdin, exits per FAKE_CLI_SCENARIO
test/fixtures/fake-cli/gh.sh           fake `gh auth login --web`: one-time code + device URL, waits for Enter, success line
test/onboarding/*.test.ts, test/api/*.test.ts, web/src/**/*.test.tsx
```

Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Task 4 consumes Tasks 2 and 3; Task 5 consumes Task 1; Task 6 consumes 1, 4 and 5; Task 7 consumes the API shapes of Task 6; Task 8 wires 6 and 7.

---

### Task 1: `writeSecret` and the user config store

**Files:**
- Modify: `server/core/secrets.ts` (add `writeSecret`)
- Create: `server/onboarding/config-store.ts`
- Test: extend `test/core/secrets.test.ts`; create `test/onboarding/config-store.test.ts`

**Interfaces:**
- Consumes: `loadSecrets` (same file), `loadConfig`, `Config` (`server/config/config.ts`), `expandHome` (`server/orchestrator/workspace.ts`).
- Produces:
  ```ts
  // secrets.ts
  export const SECRET_NAME: RegExp;                                            // ^[A-Z][A-Z0-9_]*$ (already used by loadSecrets)
  export async function writeSecret(dir: string, name: string, value: string): Promise<void>;
  // config-store.ts
  export function userConfigFile(home?: string): string;                        // <home>/.teams-ai/config.json
  export async function readUserConfig(home?: string): Promise<{ raw: Record<string, unknown>; cfg: Config }>;
  export async function setGithubOwner(owner: string, home?: string): Promise<Config>;  // merges into raw json, validates, writes atomically
  export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;   // GitHub login rules
  ```
- `writeSecret`: `name` must match `SECRET_NAME` (else throws `RangeError`); `value` is trimmed and must be non-empty and single-line (no `\r`/`\n`, else throws `RangeError`); `mkdir -p dir` then `chmod 0o700`; write `<dir>/.<name>.<pid>.tmp` with mode `0o600`; `rename` over the target.

- [ ] **Step 1: Write the failing tests**

Append to `test/core/secrets.test.ts` inside `describe('loadSecrets', …)` (or a new `describe('writeSecret')` in the same file):
```ts
describe('writeSecret', () => {
  it('writes the trimmed value with mode 0600 into a 0700 directory and loadSecrets reads it back', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-secrets-'));
    const target = path.join(dir, 'nested');
    await writeSecret(target, 'GITHUB_TOKEN', ' ghp_' + 'x'.repeat(36) + '\n');
    expect(await loadSecrets(target)).toEqual({ GITHUB_TOKEN: 'ghp_' + 'x'.repeat(36) });
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(target, 'GITHUB_TOKEN'))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
    }
    expect((await fs.readdir(target)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces an existing value atomically and rejects bad names and multi-line values', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-secrets-'));
    await writeSecret(dir, 'OPENROUTER_API_KEY', 'sk-or-v1-old');
    await writeSecret(dir, 'OPENROUTER_API_KEY', 'sk-or-v1-new');
    expect(await loadSecrets(dir)).toEqual({ OPENROUTER_API_KEY: 'sk-or-v1-new' });
    await expect(writeSecret(dir, 'lowercase', 'x')).rejects.toThrow(RangeError);
    await expect(writeSecret(dir, 'TWO_LINES', 'a\nb')).rejects.toThrow(RangeError);
    await expect(writeSecret(dir, 'EMPTY', '   ')).rejects.toThrow(RangeError);
  });
});
```
Add `writeSecret` to the import from `../../server/core/secrets.js`.

`test/onboarding/config-store.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GITHUB_OWNER, readUserConfig, setGithubOwner, userConfigFile } from '../../server/onboarding/config-store.js';

let home = '';
afterEach(async () => {
  if (home) await fs.rm(home, { recursive: true, force: true });
  home = '';
});

describe('config store', () => {
  it('reads defaults when the file is missing and writes the owner without touching other keys', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    expect(userConfigFile(home)).toBe(path.join(home, '.teams-ai', 'config.json'));
    expect((await readUserConfig(home)).cfg.github.owner).toBeUndefined();
    await fs.mkdir(path.join(home, '.teams-ai'), { recursive: true });
    await fs.writeFile(userConfigFile(home), JSON.stringify({ omniroute: { enabled: true }, github: { owner: 'old' } }));
    const cfg = await setGithubOwner('diego-dm-morais', home);
    expect(cfg.github.owner).toBe('diego-dm-morais');
    const raw = JSON.parse(await fs.readFile(userConfigFile(home), 'utf8'));
    expect(raw).toEqual({ omniroute: { enabled: true }, github: { owner: 'diego-dm-morais' } });
  });

  it('rejects an owner that is not a GitHub login', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    for (const bad of ['', '-lead', 'trail-', 'has space', 'a'.repeat(40), 'x/y']) {
      expect(GITHUB_OWNER.test(bad)).toBe(false);
      await expect(setGithubOwner(bad, home)).rejects.toThrow(RangeError);
    }
    expect(GITHUB_OWNER.test('lukeware70X7')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/core/secrets.test.ts test/onboarding/config-store.test.ts`
Expected: FAIL — `writeSecret` is not exported; `../../server/onboarding/config-store.js` cannot be resolved.

- [ ] **Step 3: Implement writeSecret**

Replace the top of `server/core/secrets.ts` so the name pattern is exported, and append `writeSecret`:
```ts
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
```
(remove the former `const SECRET_NAME` line) and at the end of the file:
```ts
/**
 * Spec (onboarding) §4: one file per secret, mode 0600 in a 0700 directory, written through a temp
 * file and rename so a crash never leaves a half-written token. The value is trimmed (editors add a
 * newline) and must be a single line; `loadSecrets` reads it back unchanged.
 */
export async function writeSecret(dir: string, name: string, value: string): Promise<void> {
  if (!SECRET_NAME.test(name)) throw new RangeError(`secret name must match ${SECRET_NAME}: ${name}`);
  const trimmed = value.trim();
  if (trimmed === '') throw new RangeError(`secret ${name} is empty`);
  if (/[\r\n]/.test(trimmed)) throw new RangeError(`secret ${name} must be a single line`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const target = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  await fs.writeFile(tmp, trimmed, { mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => undefined);
  await fs.rename(tmp, target);
}
```

- [ ] **Step 4: Implement the config store**

`server/onboarding/config-store.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from '../config/config.js';
import { expandHome } from '../orchestrator/workspace.js';

/** GitHub login: 1–39 alphanumerics or single hyphens, no leading/trailing hyphen. */
export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function userConfigFile(home?: string): string {
  return path.join(expandHome('~/.teams-ai', home), 'config.json');
}

/** The CLI reads this file with `loadConfig(JSON.parse(...))`; the UI writes only the keys it owns. */
export async function readUserConfig(home?: string): Promise<{ raw: Record<string, unknown>; cfg: Config }> {
  const raw = await fs
    .readFile(userConfigFile(home), 'utf8')
    .then((t) => JSON.parse(t) as Record<string, unknown>)
    .catch(() => ({}) as Record<string, unknown>);
  return { raw, cfg: loadConfig(raw) };
}

export async function setGithubOwner(owner: string, home?: string): Promise<Config> {
  if (!GITHUB_OWNER.test(owner)) throw new RangeError(`not a GitHub login: ${JSON.stringify(owner)}`);
  const { raw } = await readUserConfig(home);
  const github = typeof raw.github === 'object' && raw.github !== null ? (raw.github as Record<string, unknown>) : {};
  const next = { ...raw, github: { ...github, owner } };
  const cfg = loadConfig(next); // validate before writing
  const file = userConfigFile(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await fs.rename(tmp, file);
  return cfg;
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run test/core test/onboarding && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/core/secrets.ts server/onboarding/config-store.ts test/core/secrets.test.ts test/onboarding/config-store.test.ts
git commit -m "feat(onboarding): atomic secret writes and the user config store

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Transcript parser

**Files:**
- Create: `server/onboarding/transcripts.ts`
- Test: `test/onboarding/transcripts.test.ts`

**Interfaces:**
- Consumes: `redactSecrets` (`server/core/redact.ts`).
- Produces:
  ```ts
  export type Cli = 'claude' | 'gh';
  export function stripAnsi(text: string): string;
  export function extractUrl(text: string): string | null;            // first https://… token, trailing punctuation removed
  export function extractOneTimeCode(text: string): string | null;    // gh: "One-time code: XXXX-XXXX" / "(XXXX-XXXX)"
  export function isPasteCodePrompt(text: string): boolean;           // claude: /paste.*code|enter.*code|authorization code/i
  export function isSuccessLine(cli: Cli, text: string): boolean;     // gh: /Logged in as/ ; claude: /logged in|login successful|success/i
  export interface TranscriptState { url: string | null; code: string | null; pasteCodePrompt: boolean; success: boolean }
  export class TranscriptReader {
    constructor(cli: Cli, known: () => readonly string[]);
    /** Feeds a raw pty chunk; returns the redacted chunk for storage/streaming and updates state. */
    push(chunk: string): string;
    readonly state: TranscriptState;
    readonly tail: string;                                             // last 4096 redacted chars
  }
  ```
- The one-time code and every pasted code are added to the `known` values by the session (Task 4), so `push` redacts them once seen; the reader itself never logs.

- [ ] **Step 1: Write the failing test**

`test/onboarding/transcripts.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TranscriptReader, extractOneTimeCode, extractUrl, isPasteCodePrompt, isSuccessLine, stripAnsi } from '../../server/onboarding/transcripts.js';

const GH = `! First copy your one-time code: A1EB-D4E0\nPress Enter to open https://github.com/login/device in your browser...\n`;
const GH_OLD = `! One-time code (A1EB-D4E0) copied to clipboard\nPress Enter to open https://github.com/login/device in your browser... `;
const CLAUDE = `Opening browser to sign in…\n\x1b[1mhttps://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=Uf52\x1b[0m\n\nPaste code here if prompted > `;

describe('transcript helpers', () => {
  it('strips ANSI and extracts the first https URL without trailing punctuation', () => {
    expect(stripAnsi('\x1b[1mbold\x1b[0m')).toBe('bold');
    expect(extractUrl(GH)).toBe('https://github.com/login/device');
    expect(extractUrl(CLAUDE)).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=Uf52');
    expect(extractUrl('no links here')).toBeNull();
  });

  it('extracts the gh one-time code in both wordings and detects the claude paste prompt and success lines', () => {
    expect(extractOneTimeCode(GH)).toBe('A1EB-D4E0');
    expect(extractOneTimeCode(GH_OLD)).toBe('A1EB-D4E0');
    expect(extractOneTimeCode(CLAUDE)).toBeNull();
    expect(isPasteCodePrompt(CLAUDE)).toBe(true);
    expect(isPasteCodePrompt(GH)).toBe(false);
    expect(isSuccessLine('gh', '✓ Logged in as lukeware70X7')).toBe(true);
    expect(isSuccessLine('claude', 'Login successful. Welcome back!')).toBe(true);
    expect(isSuccessLine('claude', 'Press Enter')).toBe(false);
  });
});

describe('TranscriptReader', () => {
  it('accumulates state across chunks split mid-line and redacts known values in the returned chunk and tail', () => {
    const known = ['s3cr3t-token-value'];
    const r = new TranscriptReader('gh', () => known);
    expect(r.push('! First copy your one-time co')).toBe('! First copy your one-time co');
    r.push('de: A1EB-D4E0\nPress Enter to open https://github.com/login/dev');
    r.push('ice in your browser...\n');
    expect(r.state).toEqual({ url: 'https://github.com/login/device', code: 'A1EB-D4E0', pasteCodePrompt: false, success: false });
    expect(r.push('token s3cr3t-token-value rejected\n')).toBe('token [REDACTED] rejected\n');
    expect(r.tail).not.toContain('s3cr3t-token-value');
    r.push('✓ Logged in as lukeware70X7\n');
    expect(r.state.success).toBe(true);
  });

  it('keeps only the last 4096 characters in the tail', () => {
    const r = new TranscriptReader('claude', () => []);
    r.push('x'.repeat(5000));
    expect(r.tail).toHaveLength(4096);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/onboarding/transcripts.test.ts`
Expected: FAIL, cannot resolve `../../server/onboarding/transcripts.js`.

- [ ] **Step 3: Implement**

`server/onboarding/transcripts.ts`:
```ts
import { redactSecrets } from '../core/redact.js';

export type Cli = 'claude' | 'gh';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const URL = /https:\/\/[^\s"'<>\x1b]+/;
const ONE_TIME_CODE = /one-time code(?:[^A-Z0-9]{1,20})([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const PASTE_CODE = /paste[^\n]{0,40}code|enter[^\n]{0,40}code|authorization code|code here/i;
const SUCCESS: Record<Cli, RegExp> = {
  gh: /logged in as/i,
  claude: /login successful|logged in|successfully (?:logged in|authenticated)/i,
};
export const TAIL_CHARS = 4096;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function extractUrl(text: string): string | null {
  const m = URL.exec(stripAnsi(text));
  return m ? m[0].replace(/[.,;:)\]]+$/, '') : null;
}

export function extractOneTimeCode(text: string): string | null {
  const m = ONE_TIME_CODE.exec(stripAnsi(text));
  return m ? m[1]!.toUpperCase() : null;
}

export function isPasteCodePrompt(text: string): boolean {
  return PASTE_CODE.test(stripAnsi(text));
}

export function isSuccessLine(cli: Cli, text: string): boolean {
  return SUCCESS[cli].test(stripAnsi(text));
}

export interface TranscriptState {
  url: string | null;
  code: string | null;
  pasteCodePrompt: boolean;
  success: boolean;
}

/**
 * Spec (onboarding) §3: the pty output is redacted before it is stored or streamed; the raw text is
 * never kept. State is derived from the whole (redacted) transcript so a URL split across chunks
 * is still found.
 */
export class TranscriptReader {
  readonly state: TranscriptState = { url: null, code: null, pasteCodePrompt: false, success: false };
  private buffer = '';

  constructor(
    private readonly cli: Cli,
    private readonly known: () => readonly string[],
  ) {}

  get tail(): string {
    return this.buffer.length > TAIL_CHARS ? this.buffer.slice(-TAIL_CHARS) : this.buffer;
  }

  push(chunk: string): string {
    const clean = redactSecrets(stripAnsi(chunk), this.known());
    this.buffer = (this.buffer + clean).slice(-TAIL_CHARS * 2);
    if (this.state.url === null) this.state.url = extractUrl(this.buffer);
    if (this.state.code === null) this.state.code = extractOneTimeCode(this.buffer);
    if (!this.state.pasteCodePrompt && this.cli === 'claude') this.state.pasteCodePrompt = isPasteCodePrompt(this.buffer);
    if (!this.state.success) this.state.success = isSuccessLine(this.cli, this.buffer);
    return clean;
  }
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `npx vitest run test/onboarding/transcripts.test.ts && npm run typecheck`
Expected: 4 tests PASS; typecheck clean. If the gh code regex misses one wording, widen `ONE_TIME_CODE`'s middle gap, not the code shape.

- [ ] **Step 5: Commit**

```bash
git add server/onboarding/transcripts.ts test/onboarding/transcripts.test.ts
git commit -m "feat(onboarding): transcript parser for CLI login flows with redaction

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Pty driver and the fake CLIs

**Files:**
- Create: `server/onboarding/pty.ts`, `test/fixtures/fake-cli/claude.sh`, `test/fixtures/fake-cli/gh.sh`
- Test: `test/onboarding/pty.test.ts`

**Interfaces:**
- Consumes: `sanitizeEnv` (`server/runner/invocation.ts`), `node:child_process`.
- Produces:
  ```ts
  export interface PtySpec { bin: string; args: readonly string[]; env?: Record<string, string>; cwd?: string }
  export interface Pty {
    write(data: string): void;
    kill(): void;
    onData(cb: (chunk: string) => void): void;
    onExit(cb: (code: number | null) => void): void;
  }
  export type SpawnPty = (spec: PtySpec) => Pty;
  export async function hasScript(env?: NodeJS.ProcessEnv): Promise<boolean>;   // `script --version` exits 0
  export const spawnScriptPty: SpawnPty;                                          // script -qfec "<quoted command>" /dev/null
  export function shellQuote(arg: string): string;                                // single-quote POSIX quoting
  export function childEnv(hostEnv?: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string>; // sanitizeEnv + HOME + extra
  ```
- Fake CLIs (bash; executable bit set with `git update-index --chmod=+x`):
  - `claude.sh auth login --claudeai`: prints `Opening browser…`, the URL `https://claude.example/oauth/authorize?state=FAKE`, then `Paste code here if prompted > `, reads one line from stdin; `FAKE_CLI_SCENARIO=success` (default) → prints `Login successful` and exits 0; `bad-code` → prints `Invalid code` and exits 1; `no-url` → exits 0 immediately without printing anything; `timeout` → sleeps 60 s.
  - `gh.sh auth login …`: prints `! First copy your one-time code: FAKE-CODE`, then `Press Enter to open https://github.com/login/device in your browser...`, waits for a line on stdin, sleeps 0.2 s, prints `✓ Logged in as fake-user`, exits 0; `bad-code` → prints `error: The code is invalid` and exits 1.

- [ ] **Step 1: Write the fake CLIs**

`test/fixtures/fake-cli/claude.sh`:
```bash
#!/usr/bin/env bash
# Fake `claude auth login` for the onboarding tests. Scenario via FAKE_CLI_SCENARIO (default: success).
set -u
scenario="${FAKE_CLI_SCENARIO:-success}"
case "$scenario" in
  no-url) exit 0 ;;
  timeout) sleep 60; exit 1 ;;
esac
echo "Opening browser to sign in…"
sleep 0.05
printf '\033[1mhttps://claude.example/oauth/authorize?code=true&state=FAKE\033[0m\n'
sleep 0.05
printf 'Paste code here if prompted > '
IFS= read -r code || code=""
case "$scenario" in
  bad-code) echo "Invalid code: ${code}"; exit 1 ;;
  *) echo "Login successful. Welcome back!"; exit 0 ;;
esac
```

`test/fixtures/fake-cli/gh.sh`:
```bash
#!/usr/bin/env bash
# Fake `gh auth login --web` for the onboarding tests. Scenario via FAKE_CLI_SCENARIO (default: success).
set -u
scenario="${FAKE_CLI_SCENARIO:-success}"
echo "! First copy your one-time code: FAKE-CODE"
echo "Press Enter to open https://github.com/login/device in your browser..."
IFS= read -r _ || true
sleep 0.2
case "$scenario" in
  bad-code) echo "error: The code is invalid"; exit 1 ;;
  *) echo "✓ Logged in as fake-user"; exit 0 ;;
esac
```

Run: `git add test/fixtures/fake-cli/claude.sh test/fixtures/fake-cli/gh.sh && git update-index --chmod=+x test/fixtures/fake-cli/claude.sh test/fixtures/fake-cli/gh.sh`
Expected: `git ls-files -s test/fixtures/fake-cli` shows mode `100755` for both.

- [ ] **Step 2: Write the failing test**

`test/onboarding/pty.test.ts`:
```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnv, hasScript, shellQuote, spawnScriptPty } from '../../server/onboarding/pty.js';

const FAKE = path.resolve('test/fixtures/fake-cli/gh.sh');

describe('pty helpers', () => {
  it('quotes arguments for a POSIX shell', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
  });

  it('builds a sanitized child environment with HOME and the extras', () => {
    const env = childEnv({ HOME: '/home/u', PATH: '/bin', GITHUB_TOKEN: 'leak', TERM: 'xterm' }, { FAKE_CLI_SCENARIO: 'success' });
    expect(env).toEqual({ HOME: '/home/u', PATH: '/bin', TERM: 'xterm', FAKE_CLI_SCENARIO: 'success' });
  });
});

describe('spawnScriptPty', async () => {
  const available = await hasScript();
  it.skipIf(!available)('streams the child output, delivers stdin writes and reports the exit code', async () => {
    const pty = spawnScriptPty({ bin: 'bash', args: [FAKE, 'auth', 'login', '--web'], env: childEnv(process.env) });
    const chunks: string[] = [];
    const exit = new Promise<number | null>((resolve) => pty.onExit(resolve));
    pty.onData((c) => {
      chunks.push(c);
      if (chunks.join('').includes('Press Enter')) pty.write('\n');
    });
    expect(await exit).toBe(0);
    const all = chunks.join('');
    expect(all).toContain('one-time code: FAKE-CODE');
    expect(all).toContain('Logged in as fake-user');
  });

  it.skipIf(!available)('kill ends the process', async () => {
    const pty = spawnScriptPty({ bin: 'bash', args: [FAKE, 'auth', 'login'], env: childEnv(process.env, { FAKE_CLI_SCENARIO: 'timeout' }) });
    const exit = new Promise<number | null>((resolve) => pty.onExit(resolve));
    setTimeout(() => pty.kill(), 200);
    expect(await exit).not.toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/onboarding/pty.test.ts`
Expected: FAIL, cannot resolve `../../server/onboarding/pty.js`.

- [ ] **Step 4: Implement**

`server/onboarding/pty.ts`:
```ts
import { spawn } from 'node:child_process';
import { sanitizeEnv } from '../runner/invocation.js';

export interface PtySpec {
  bin: string;
  args: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface Pty {
  write(data: string): void;
  kill(): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export type SpawnPty = (spec: PtySpec) => Pty;

/** POSIX single-quote quoting: safe for any byte except NUL. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The runner's allowlist plus HOME: CLIs need their config dirs; nothing else from the host (spec §7). */
export function childEnv(hostEnv: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env = sanitizeEnv(hostEnv);
  if (typeof hostEnv.HOME === 'string') env.HOME = hostEnv.HOME;
  return { ...env, ...extra };
}

export async function hasScript(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (process.platform === 'win32') return false;
  return new Promise((resolve) => {
    const p = spawn('script', ['--version'], { env: childEnv(env), stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * Spec (onboarding) §3.3: util-linux `script` allocates a real pty so `claude` and `gh` behave as in a
 * terminal; we read its stdout and write its stdin. `-q` quiet, `-f` flush per write, `-e` return the
 * child's exit code, `-c` the command; the typescript file goes to /dev/null.
 */
export const spawnScriptPty: SpawnPty = (spec) => {
  const command = [spec.bin, ...spec.args].map(shellQuote).join(' ');
  const child = spawn('script', ['-qfec', command, '/dev/null'], { cwd: spec.cwd, env: spec.env ?? childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const dataCbs: Array<(chunk: string) => void> = [];
  const exitCbs: Array<(code: number | null) => void> = [];
  let exited = false;
  const emitData = (buf: Buffer) => {
    const text = buf.toString('utf8');
    for (const cb of dataCbs) cb(text);
  };
  child.stdout.on('data', emitData);
  child.stderr.on('data', emitData);
  child.on('error', () => {
    if (!exited) {
      exited = true;
      for (const cb of exitCbs) cb(null);
    }
  });
  child.on('exit', (code) => {
    if (!exited) {
      exited = true;
      for (const cb of exitCbs) cb(code);
    }
  });
  return {
    write: (data) => {
      if (!exited) child.stdin.write(data);
    },
    kill: () => {
      if (!exited) child.kill('SIGTERM');
    },
    onData: (cb) => void dataCbs.push(cb),
    onExit: (cb) => void exitCbs.push(cb),
  };
};
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run test/onboarding/pty.test.ts && npm run typecheck`
Expected: on Windows 2 PASS + 2 skipped; in WSL 4 PASS. Typecheck clean. In WSL also run once by hand `bash test/fixtures/fake-cli/claude.sh auth login <<< 'abc#def'` and confirm it prints `Login successful`.

- [ ] **Step 6: Commit**

```bash
git add server/onboarding/pty.ts test/onboarding/pty.test.ts test/fixtures/fake-cli/claude.sh test/fixtures/fake-cli/gh.sh
git commit -m "feat(onboarding): script-based pty driver and fake claude/gh login CLIs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Login session state machine

**Files:**
- Create: `server/onboarding/login-session.ts`
- Test: `test/onboarding/login-session.test.ts`

**Interfaces:**
- Consumes: `TranscriptReader`, `Cli` (Task 2); `Pty`, `PtySpec`, `SpawnPty` (Task 3).
- Produces:
  ```ts
  export type SessionState =
    | { name: 'idle' }
    | { name: 'starting' }
    | { name: 'awaiting-browser'; url: string; code: string | null }
    | { name: 'awaiting-code'; url: string | null }
    | { name: 'verifying' }
    | { name: 'done'; detail: string }
    | { name: 'failed'; reason: string };
  export interface SessionEvent { type: 'state'; state: SessionState } | { type: 'output'; chunk: string }
  export interface LoginSessionDeps {
    cli: Cli;
    spawn: SpawnPty;
    command: PtySpec;                                  // e.g. { bin: 'claude', args: ['auth','login','--claudeai'], env }
    probe: () => Promise<{ ok: boolean; detail: string }>;
    clock?: () => number;                              // ms; default Date.now
    timeoutMs?: number;                                // default 600_000
    schedule?: (fn: () => void, ms: number) => () => void;  // default setTimeout/clearTimeout; tests use a manual scheduler
    knownSecrets?: () => readonly string[];
    autoEnter?: boolean;                               // gh: write "\n" once the code and URL are seen (default: cli === 'gh')
  }
  export class LoginSession {
    constructor(deps: LoginSessionDeps);
    readonly state: SessionState;
    readonly output: string;                           // redacted tail
    start(): void;                                     // kills a live process first
    sendCode(code: string): boolean;                   // false unless state is awaiting-code
    cancel(): void;
    on(listener: (e: SessionEvent) => void): () => void;
    get live(): boolean;
  }
  ```
- Transitions: `start` → `starting`; first `url` → `awaiting-browser`; `pasteCodePrompt` (claude) → `awaiting-code`; `sendCode` writes `code + "\n"` and moves to `verifying`; process exit → `verifying` (unless already `done`/`failed`) → `probe()` → `done` or `failed`; exit code ≠ 0 without success line → still probe (the probe is the truth), but the failure reason includes the exit code and the redacted tail when the probe is red; timeout → kill, `failed { reason: 'timeout' }`; `cancel` → kill, `failed { reason: 'cancelled' }`. The pasted code and the one-time code join `knownSecrets` for redaction.

- [ ] **Step 1: Write the failing test**

`test/onboarding/login-session.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { LoginSession, type LoginSessionDeps, type SessionEvent } from '../../server/onboarding/login-session.js';
import type { Pty, PtySpec } from '../../server/onboarding/pty.js';

/** A scripted pty: the test pushes chunks and exit codes; writes are recorded. */
class FakePty implements Pty {
  writes: string[] = [];
  killed = false;
  private data: Array<(c: string) => void> = [];
  private exit: Array<(c: number | null) => void> = [];
  write(d: string) { this.writes.push(d); }
  kill() { this.killed = true; this.emitExit(143); }
  onData(cb: (c: string) => void) { this.data.push(cb); }
  onExit(cb: (c: number | null) => void) { this.exit.push(cb); }
  emit(chunk: string) { for (const cb of this.data) cb(chunk); }
  emitExit(code: number | null) { for (const cb of this.exit) cb(code); }
}

function harness(over: Partial<LoginSessionDeps> = {}) {
  const ptys: FakePty[] = [];
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const events: SessionEvent[] = [];
  const probeResults: Array<{ ok: boolean; detail: string }> = [{ ok: true, detail: 'ada@example.com (max)' }];
  const deps: LoginSessionDeps = {
    cli: 'claude',
    spawn: (_spec: PtySpec) => { const p = new FakePty(); ptys.push(p); return p; },
    command: { bin: 'claude', args: ['auth', 'login', '--claudeai'] },
    probe: async () => probeResults.shift() ?? { ok: false, detail: 'no probe result' },
    clock: () => now,
    schedule: (fn, ms) => { const t = { at: now + ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    knownSecrets: () => ['host-secret'],
    ...over,
  };
  const s = new LoginSession(deps);
  s.on((e) => events.push(e));
  const advance = (ms: number) => { now += ms; for (const t of timers) if (!t.cancelled && t.at <= now) { t.cancelled = true; t.fn(); } };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { s, ptys, events, advance, tick, probeResults };
}
const names = (events: SessionEvent[]) => events.filter((e) => e.type === 'state').map((e) => (e as { state: { name: string } }).state.name);

describe('LoginSession (claude flow)', () => {
  it('goes starting → awaiting-browser → awaiting-code → verifying → done and never emits the pasted code', async () => {
    const h = harness();
    h.s.start();
    const p = h.ptys[0]!;
    p.emit('Opening browser…\nhttps://claude.example/oauth/authorize?state=X\n');
    expect(h.s.state).toEqual({ name: 'awaiting-browser', url: 'https://claude.example/oauth/authorize?state=X', code: null });
    p.emit('Paste code here if prompted > ');
    expect(h.s.state.name).toBe('awaiting-code');
    expect(h.s.sendCode('p0SAAx#Uf52_state')).toBe(true);
    expect(p.writes).toEqual(['p0SAAx#Uf52_state\n']);
    expect(h.s.state.name).toBe('verifying');
    p.emit('Login successful\n');
    p.emitExit(0);
    await h.tick();
    expect(h.s.state).toEqual({ name: 'done', detail: 'ada@example.com (max)' });
    expect(names(h.events)).toEqual(['starting', 'awaiting-browser', 'awaiting-code', 'verifying', 'done']);
    expect(JSON.stringify(h.events)).not.toContain('p0SAAx');
    expect(h.s.output).not.toContain('p0SAAx');
  });

  it('writes the pasted code plus newline to the pty and never emits it, even when the CLI echoes it back', async () => {
    const h = harness();
    h.s.start();
    const p = h.ptys[0]!;
    p.emit('https://claude.example/a\nPaste code here if prompted > ');
    h.s.sendCode('c0de#st4te');
    p.emit('you typed c0de#st4te\n');
    expect(JSON.stringify(h.events)).not.toContain('c0de#st4te');
    expect(h.s.output).toContain('[REDACTED]');
  });

  it('a process that exits before printing a URL goes straight to verifying and lets the probe decide', async () => {
    const h = harness();
    h.s.start();
    h.ptys[0]!.emitExit(0);
    await h.tick();
    expect(names(h.events)).toEqual(['starting', 'verifying', 'done']);
  });

  it('fails with the exit code and the redacted tail when the probe stays red', async () => {
    const h = harness();
    h.probeResults.splice(0, 1, { ok: false, detail: 'not logged in' });
    h.s.start();
    const p = h.ptys[0]!;
    p.emit('https://claude.example/a\nPaste code here > ');
    h.s.sendCode('bad');
    p.emit('Invalid code, host-secret leaked\n');
    p.emitExit(1);
    await h.tick();
    expect(h.s.state.name).toBe('failed');
    const reason = (h.s.state as { reason: string }).reason;
    expect(reason).toContain('exit 1');
    expect(reason).toContain('not logged in');
    expect(reason).toContain('[REDACTED]');
    expect(reason).not.toContain('host-secret');
  });

  it('times out after ten minutes, killing the process', async () => {
    const h = harness();
    h.s.start();
    h.advance(600_000);
    await h.tick();
    expect(h.ptys[0]!.killed).toBe(true);
    expect(h.s.state).toEqual({ name: 'failed', reason: 'timeout' });
  });

  it('cancel kills the process and starting a new session kills the live one', async () => {
    const h = harness();
    h.s.start();
    h.s.cancel();
    expect(h.ptys[0]!.killed).toBe(true);
    expect(h.s.state).toEqual({ name: 'failed', reason: 'cancelled' });
    h.s.start();
    h.s.start();
    expect(h.ptys).toHaveLength(3);
    expect(h.ptys[1]!.killed).toBe(true);
    expect(h.ptys[2]!.killed).toBe(false);
    expect(h.s.live).toBe(true);
  });

  it('sendCode is refused outside awaiting-code', () => {
    const h = harness();
    expect(h.s.sendCode('x')).toBe(false);
    h.s.start();
    expect(h.s.sendCode('x')).toBe(false);
    expect(h.ptys[0]!.writes).toEqual([]);
  });
});

describe('LoginSession (gh flow)', () => {
  it('shows the one-time code with the URL, presses Enter itself, and finishes on the success line', async () => {
    const h = harness({ cli: 'gh', command: { bin: 'gh', args: ['auth', 'login', '--web'] } });
    h.probeResults.splice(0, 1, { ok: true, detail: 'lukeware70X7' });
    h.s.start();
    const p = h.ptys[0]!;
    p.emit('! First copy your one-time code: A1EB-D4E0\n');
    p.emit('Press Enter to open https://github.com/login/device in your browser...');
    expect(h.s.state).toEqual({ name: 'awaiting-browser', url: 'https://github.com/login/device', code: 'A1EB-D4E0' });
    expect(p.writes).toEqual(['\n']);
    p.emit('\n✓ Logged in as lukeware70X7\n');
    p.emitExit(0);
    await h.tick();
    expect(h.s.state).toEqual({ name: 'done', detail: 'lukeware70X7' });
    expect(names(h.events)).toEqual(['starting', 'awaiting-browser', 'verifying', 'done']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/onboarding/login-session.test.ts`
Expected: FAIL, cannot resolve `../../server/onboarding/login-session.js`.

- [ ] **Step 3: Implement**

`server/onboarding/login-session.ts`:
```ts
import type { Pty, PtySpec, SpawnPty } from './pty.js';
import { TranscriptReader, type Cli } from './transcripts.js';

export type SessionState =
  | { name: 'idle' }
  | { name: 'starting' }
  | { name: 'awaiting-browser'; url: string; code: string | null }
  | { name: 'awaiting-code'; url: string | null }
  | { name: 'verifying' }
  | { name: 'done'; detail: string }
  | { name: 'failed'; reason: string };

export type SessionEvent = { type: 'state'; state: SessionState } | { type: 'output'; chunk: string };

export interface LoginSessionDeps {
  cli: Cli;
  spawn: SpawnPty;
  command: PtySpec;
  probe: () => Promise<{ ok: boolean; detail: string }>;
  clock?: () => number;
  timeoutMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
  knownSecrets?: () => readonly string[];
  autoEnter?: boolean;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/**
 * Spec (onboarding) §3. One CLI login behind a pty. Every transition is an event; the transcript is
 * redacted before anything is stored or emitted; only the probe makes the session `done`.
 */
export class LoginSession {
  private current: SessionState = { name: 'idle' };
  private pty: Pty | null = null;
  private reader: TranscriptReader | null = null;
  private cancelTimeout: (() => void) | null = null;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  /** Codes seen or pasted in this process; redacted from every chunk (spec §3 "never persisted or logged"). */
  private readonly codes: string[] = [];
  private generation = 0;

  constructor(private readonly deps: LoginSessionDeps) {}

  get state(): SessionState {
    return this.current;
  }

  get output(): string {
    return this.reader?.tail ?? '';
  }

  get live(): boolean {
    return this.pty !== null;
  }

  on(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.pty) this.killProcess();
    const gen = ++this.generation;
    this.codes.length = 0;
    this.reader = new TranscriptReader(this.deps.cli, () => [...(this.deps.knownSecrets?.() ?? []), ...this.codes]);
    this.set({ name: 'starting' });
    const pty = this.deps.spawn(this.deps.command);
    this.pty = pty;
    let enterSent = false;
    pty.onData((raw) => {
      if (gen !== this.generation || !this.reader) return;
      const clean = this.reader.push(raw);
      if (clean !== '') this.emit({ type: 'output', chunk: clean });
      const st = this.reader.state;
      if (st.code && !this.codes.includes(st.code)) this.codes.push(st.code);
      if (this.current.name === 'starting' && st.url) this.set({ name: 'awaiting-browser', url: st.url, code: st.code });
      else if (this.current.name === 'awaiting-browser' && st.code && this.current.code === null) this.set({ ...this.current, code: st.code });
      if (this.current.name === 'awaiting-browser' && st.pasteCodePrompt && this.deps.cli === 'claude') this.set({ name: 'awaiting-code', url: st.url });
      const autoEnter = this.deps.autoEnter ?? this.deps.cli === 'gh';
      if (autoEnter && !enterSent && st.url && st.code) {
        enterSent = true;
        pty.write('\n');
      }
      if (st.success && (this.current.name === 'awaiting-browser' || this.current.name === 'awaiting-code')) this.set({ name: 'verifying' });
    });
    pty.onExit((code) => {
      if (gen !== this.generation) return;
      this.pty = null;
      this.cancelTimeout?.();
      this.cancelTimeout = null;
      if (this.current.name === 'failed' || this.current.name === 'done') return;
      if (this.current.name !== 'verifying') this.set({ name: 'verifying' });
      void this.verify(gen, code);
    });
    this.cancelTimeout = (this.deps.schedule ?? defaultSchedule)(() => {
      if (gen !== this.generation || !this.pty) return;
      this.killProcess();
      this.set({ name: 'failed', reason: 'timeout' });
    }, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  sendCode(code: string): boolean {
    if (this.current.name !== 'awaiting-code' || !this.pty) return false;
    const trimmed = code.trim();
    if (trimmed === '') return false;
    this.codes.push(trimmed);
    this.pty.write(`${trimmed}\n`);
    this.set({ name: 'verifying' });
    return true;
  }

  cancel(): void {
    if (!this.pty) return;
    this.generation += 1; // the exit callback of the killed process must not run verify()
    this.killProcess();
    this.set({ name: 'failed', reason: 'cancelled' });
  }

  private async verify(gen: number, exitCode: number | null): Promise<void> {
    const result = await this.deps.probe().catch((err: Error) => ({ ok: false, detail: err.message }));
    if (gen !== this.generation) return;
    if (result.ok) this.set({ name: 'done', detail: result.detail });
    else {
      const tail = this.output.trim().split('\n').slice(-5).join('\n');
      this.set({ name: 'failed', reason: `${result.detail} (exit ${exitCode ?? 'null'})${tail ? `\n${tail}` : ''}` });
    }
  }

  private killProcess(): void {
    const p = this.pty;
    this.pty = null;
    this.cancelTimeout?.();
    this.cancelTimeout = null;
    p?.kill();
  }

  private set(state: SessionState): void {
    this.current = state;
    this.emit({ type: 'state', state });
  }

  private emit(e: SessionEvent): void {
    for (const l of this.listeners) l(e);
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/onboarding/login-session.test.ts && npm run typecheck`
Expected: 8 tests PASS; typecheck clean. Sharp edges: `cancel()` bumps the generation before killing so the fake pty's synchronous exit callback is ignored; the `FakePty.kill()` in the test emits exit 143 synchronously, which is why `start()` must kill the old pty before bumping its own generation is observable (the kill happens under the previous generation and is ignored by the new one).

- [ ] **Step 5: Commit**

```bash
git add server/onboarding/login-session.ts test/onboarding/login-session.test.ts
git commit -m "feat(onboarding): CLI login session state machine over a pty

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Probes and status

**Files:**
- Create: `server/onboarding/probes.ts`, `server/onboarding/status.ts`
- Test: `test/onboarding/probes.test.ts`, `test/onboarding/status.test.ts`

**Interfaces:**
- Consumes: `Exec` (`server/exec/command.ts`); `childEnv` (Task 3); `JevOpenRouterBackend` (`server/decide/jev-openrouter.ts`); `loadSecrets` (`server/core/secrets.ts`); `readUserConfig` (Task 1); `redactSecrets`.
- Produces:
  ```ts
  // probes.ts
  export interface ProbeResult { ok: boolean; detail: string }
  export interface ProbeDeps { exec: Exec; fetch: typeof fetch; hostEnv?: NodeJS.ProcessEnv; timeoutMs?: number }
  export async function claudeStatus(d: ProbeDeps): Promise<ProbeResult>;                    // claude auth status --json → loggedIn
  export async function ghStatus(d: ProbeDeps): Promise<ProbeResult>;                        // gh auth status (exit 0, "Logged in to github.com account X")
  export async function ghOwner(d: ProbeDeps, owner: string, token: string | null): Promise<ProbeResult>;   // gh api users/<o> then orgs/<o>
  export async function ghToken(d: ProbeDeps, token: string): Promise<ProbeResult>;          // GH_TOKEN=… gh api user -i (login + X-OAuth-Scopes)
  export async function openrouterKey(d: ProbeDeps, key: string, model?: string): Promise<ProbeResult>;   // one noul via JevOpenRouterBackend
  // status.ts
  export type ItemName = 'claude' | 'githubOwner' | 'ghLogin' | 'githubToken' | 'openrouterKey';
  export interface Item { ok: boolean; detail: string; secret?: { set: boolean; hint: string } }
  export type Status = { items: Record<ItemName, Item>; allOk: boolean };
  export interface StatusDeps extends ProbeDeps { home?: string; secretsDir: string }
  export function hint(value: string): string;                                             // last 4 chars, '****' if shorter
  export async function computeStatus(d: StatusDeps): Promise<Status>;
  export async function computeItem(d: StatusDeps, name: ItemName): Promise<Item>;
  ```
- All probe output goes through `redactSecrets(text, [token/key])` before it lands in `detail`. `ghToken` passes `GH_TOKEN` only in that call's env. `openrouterKey` uses `JevOpenRouterBackend` with `maxTries: 1`, `timeoutMs`, the Noul question `"Is this sentence in English?"` on state `"The onboarding probe checks the key."`; `detail` = `${model} · $${costUsd}`.

- [ ] **Step 1: Write the failing tests**

`test/onboarding/probes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { claudeStatus, ghOwner, ghStatus, ghToken, openrouterKey } from '../../server/onboarding/probes.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const KEY = 'sk-or-v1-' + 'ab'.repeat(32);
const TOKEN = 'ghp_' + 'c'.repeat(36);
const noFetch = (async () => { throw new Error('no network'); }) as typeof fetch;

describe('probes', () => {
  it('claude: loggedIn true → ok with email and plan; false or bad json → red', async () => {
    const good = new FakeExec().onArgs('claude', ['auth', 'status'], () => ({ stdout: JSON.stringify({ loggedIn: true, email: 'a@b.c', subscriptionType: 'max' }) }));
    expect(await claudeStatus({ exec: good.exec, fetch: noFetch })).toEqual({ ok: true, detail: 'a@b.c (max)' });
    expect(good.calls[0]!.args).toEqual(['auth', 'status', '--json']);
    const out = new FakeExec().onArgs('claude', ['auth', 'status'], () => ({ stdout: JSON.stringify({ loggedIn: false }) }));
    expect((await claudeStatus({ exec: out.exec, fetch: noFetch })).ok).toBe(false);
    const missing = new FakeExec().on((s) => s.bin === 'claude', () => ({ exitCode: 127, stderr: 'claude: not found' }));
    expect(await claudeStatus({ exec: missing.exec, fetch: noFetch })).toMatchObject({ ok: false, detail: expect.stringContaining('not found') });
  });

  it('gh: parses the logged-in account from auth status', async () => {
    const good = new FakeExec().onArgs('gh', ['auth', 'status'], () => ({ stderr: 'github.com\n  ✓ Logged in to github.com account lukeware70X7 (/home/u/.config/gh/hosts.yml)\n' }));
    expect(await ghStatus({ exec: good.exec, fetch: noFetch })).toEqual({ ok: true, detail: 'lukeware70X7' });
    const bad = new FakeExec().onArgs('gh', ['auth', 'status'], () => ({ exitCode: 1, stderr: 'You are not logged into any GitHub hosts.' }));
    expect(await ghStatus({ exec: bad.exec, fetch: noFetch })).toMatchObject({ ok: false, detail: expect.stringContaining('not logged') });
  });

  it('owner: tries users/<owner> then orgs/<owner>, with GH_TOKEN only when given', async () => {
    const org = new FakeExec()
      .onArgs('gh', ['api', 'users/labsitio'], () => ({ exitCode: 1, stderr: 'Not Found (HTTP 404)' }))
      .onArgs('gh', ['api', 'orgs/labsitio'], () => ({ stdout: JSON.stringify({ login: 'labsitio', type: 'Organization' }) }));
    expect(await ghOwner({ exec: org.exec, fetch: noFetch }, 'labsitio', TOKEN)).toEqual({ ok: true, detail: 'labsitio (Organization)' });
    expect(org.calls.every((c) => c.env?.GH_TOKEN === TOKEN)).toBe(true);
    const user = new FakeExec().onArgs('gh', ['api', 'users/diego'], () => ({ stdout: JSON.stringify({ login: 'diego', type: 'User' }) }));
    expect(await ghOwner({ exec: user.exec, fetch: noFetch }, 'diego', null)).toEqual({ ok: true, detail: 'diego (User)' });
    expect(user.calls[0]!.env?.GH_TOKEN).toBeUndefined();
  });

  it('token: reports the login and scopes, passes the token only through GH_TOKEN, redacts it from errors', async () => {
    const good = new FakeExec().onArgs('gh', ['api', 'user'], () => ({ stdout: `HTTP/2.0 200 OK\nX-Oauth-Scopes: repo, read:org\n\n${JSON.stringify({ login: 'diego-dm-morais' })}` }));
    expect(await ghToken({ exec: good.exec, fetch: noFetch }, TOKEN)).toEqual({ ok: true, detail: 'diego-dm-morais · scopes: repo, read:org' });
    expect(good.calls[0]!.env).toMatchObject({ GH_TOKEN: TOKEN });
    expect(good.calls[0]!.args).not.toContain(TOKEN);
    const bad = new FakeExec().onArgs('gh', ['api', 'user'], () => ({ exitCode: 1, stderr: `HTTP 401: Bad credentials for ${TOKEN}` }));
    const r = await ghToken({ exec: bad.exec, fetch: noFetch }, TOKEN);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
    expect(r.detail).not.toContain(TOKEN);
  });

  it('openrouter: one noul through Jev; ok reports model and cost, a 401 is red without the key', async () => {
    const ok = (async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.13-20260917', answers: { probe: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 40, output_tokens: 2, cost: 0.0000017 } }), { status: 200 })) as typeof fetch;
    expect(await openrouterKey({ exec: new FakeExec().exec, fetch: ok }, KEY)).toEqual({ ok: true, detail: 'typesafe/jev-1.13-20260917 · $0.0000017' });
    const unauthorized = (async () => new Response(`invalid key ${KEY}`, { status: 401 })) as typeof fetch;
    const r = await openrouterKey({ exec: new FakeExec().exec, fetch: unauthorized }, KEY);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
    expect(r.detail).not.toContain(KEY);
  });
});
```

`test/onboarding/status.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeSecret } from '../../server/core/secrets.js';
import { setGithubOwner } from '../../server/onboarding/config-store.js';
import { computeStatus, hint } from '../../server/onboarding/status.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const KEY = 'sk-or-v1-' + 'ab'.repeat(32);
const TOKEN = 'ghp_' + 'c'.repeat(36);
let home = '';
afterEach(async () => {
  if (home) await fs.rm(home, { recursive: true, force: true });
  home = '';
});

describe('status', () => {
  it('hint shows only the last four characters', () => {
    expect(hint(KEY)).toBe(KEY.slice(-4));
    expect(hint('ab')).toBe('****');
  });

  it('is all red on a fresh host and never carries a secret value', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    const exec = new FakeExec().on(() => true, () => ({ exitCode: 1, stderr: 'not configured' }));
    const s = await computeStatus({ exec: exec.exec, fetch: (async () => new Response('', { status: 500 })) as typeof fetch, home, secretsDir: path.join(home, 'secrets') });
    expect(s.allOk).toBe(false);
    expect(Object.values(s.items).every((i) => i.ok === false)).toBe(true);
    expect(s.items.githubToken.secret).toEqual({ set: false, hint: '' });
    expect(s.items.githubOwner.detail).toContain('not set');
  });

  it('turns green when every probe answers and exposes hints, not values', async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-home-'));
    const secretsDir = path.join(home, 'secrets');
    await writeSecret(secretsDir, 'GITHUB_TOKEN', TOKEN);
    await writeSecret(secretsDir, 'OPENROUTER_API_KEY', KEY);
    await setGithubOwner('diego-dm-morais', home);
    const exec = new FakeExec()
      .onArgs('claude', ['auth', 'status'], () => ({ stdout: JSON.stringify({ loggedIn: true, email: 'a@b.c', subscriptionType: 'max' }) }))
      .onArgs('gh', ['auth', 'status'], () => ({ stderr: '✓ Logged in to github.com account lukeware70X7' }))
      .onArgs('gh', ['api', 'users/diego-dm-morais'], () => ({ stdout: JSON.stringify({ login: 'diego-dm-morais', type: 'User' }) }))
      .onArgs('gh', ['api', 'user'], () => ({ stdout: `HTTP/2.0 200 OK\nX-Oauth-Scopes: repo\n\n${JSON.stringify({ login: 'diego-dm-morais' })}` }));
    const fetch = (async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { probe: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0.000001 } }), { status: 200 })) as typeof fetch;
    const s = await computeStatus({ exec: exec.exec, fetch, home, secretsDir });
    expect(s.allOk).toBe(true);
    expect(s.items.githubToken.secret).toEqual({ set: true, hint: TOKEN.slice(-4) });
    expect(s.items.openrouterKey.secret).toEqual({ set: true, hint: KEY.slice(-4) });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(JSON.stringify(s)).not.toContain(KEY);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/onboarding/probes.test.ts test/onboarding/status.test.ts`
Expected: FAIL, both modules cannot be resolved.

- [ ] **Step 3: Implement probes**

`server/onboarding/probes.ts`:
```ts
import { redactSecrets } from '../core/redact.js';
import { JevOpenRouterBackend } from '../decide/jev-openrouter.js';
import type { Exec } from '../exec/command.js';
import { childEnv } from './pty.js';

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export interface ProbeDeps {
  exec: Exec;
  fetch: typeof fetch;
  hostEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const TIMEOUT = 30_000;
const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

export async function claudeStatus(d: ProbeDeps): Promise<ProbeResult> {
  const r = await d.exec({ bin: 'claude', args: ['auth', 'status', '--json'], env: childEnv(d.hostEnv), timeoutMs: d.timeoutMs ?? TIMEOUT }).catch((e: Error) => ({ exitCode: 127, stdout: '', stderr: e.message }));
  if (r.exitCode !== 0) return { ok: false, detail: `claude auth status failed: ${firstLine(r.stderr || r.stdout) || `exit ${r.exitCode}`}` };
  try {
    const j = JSON.parse(r.stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
    if (j.loggedIn !== true) return { ok: false, detail: 'not logged in' };
    return { ok: true, detail: `${j.email ?? 'unknown account'} (${j.subscriptionType ?? 'unknown plan'})` };
  } catch {
    return { ok: false, detail: 'claude auth status returned no JSON' };
  }
}

export async function ghStatus(d: ProbeDeps): Promise<ProbeResult> {
  const r = await d.exec({ bin: 'gh', args: ['auth', 'status'], env: childEnv(d.hostEnv), timeoutMs: d.timeoutMs ?? TIMEOUT }).catch((e: Error) => ({ exitCode: 127, stdout: '', stderr: e.message }));
  const text = `${r.stdout}\n${r.stderr}`;
  const m = /Logged in to github\.com account (\S+)/.exec(text);
  if (r.exitCode === 0 && m) return { ok: true, detail: m[1]! };
  return { ok: false, detail: firstLine(r.stderr || r.stdout) || 'gh is not logged in' };
}

function ghEnv(d: ProbeDeps, token: string | null): Record<string, string> {
  return childEnv(d.hostEnv, token ? { GH_TOKEN: token } : {});
}

export async function ghOwner(d: ProbeDeps, owner: string, token: string | null): Promise<ProbeResult> {
  for (const kind of ['users', 'orgs'] as const) {
    const r = await d.exec({ bin: 'gh', args: ['api', `${kind}/${owner}`], env: ghEnv(d, token), timeoutMs: d.timeoutMs ?? TIMEOUT }).catch((e: Error) => ({ exitCode: 1, stdout: '', stderr: e.message }));
    if (r.exitCode === 0) {
      try {
        const j = JSON.parse(r.stdout) as { login?: string; type?: string };
        return { ok: true, detail: `${j.login ?? owner} (${j.type ?? kind})` };
      } catch {
        return { ok: true, detail: owner };
      }
    }
  }
  return { ok: false, detail: `GitHub knows no user or organization named ${owner}` };
}

export async function ghToken(d: ProbeDeps, token: string): Promise<ProbeResult> {
  const r = await d.exec({ bin: 'gh', args: ['api', 'user', '-i'], env: ghEnv(d, token), timeoutMs: d.timeoutMs ?? TIMEOUT }).catch((e: Error) => ({ exitCode: 1, stdout: '', stderr: e.message }));
  const clean = (s: string) => redactSecrets(s, [token]);
  if (r.exitCode !== 0) return { ok: false, detail: clean(firstLine(r.stderr || r.stdout) || `gh api user failed (exit ${r.exitCode})`) };
  const [head, ...rest] = r.stdout.split(/\r?\n\r?\n/);
  const scopes = /^X-Oauth-Scopes:\s*(.*)$/im.exec(head ?? '')?.[1]?.trim() ?? 'none';
  try {
    const j = JSON.parse(rest.join('\n\n') || head || '{}') as { login?: string };
    return { ok: true, detail: `${j.login ?? 'unknown'} · scopes: ${scopes}` };
  } catch {
    return { ok: false, detail: 'gh api user returned no JSON' };
  }
}

export async function openrouterKey(d: ProbeDeps, key: string, model = 'typesafe/jev-1.13'): Promise<ProbeResult> {
  const jev = new JevOpenRouterBackend({ fetch: d.fetch, apiKey: key, baseUrl: 'https://openrouter.ai/api', model, timeoutMs: d.timeoutMs ?? TIMEOUT, maxTries: 1, backoffMs: 0, sleep: async () => {} });
  const r = await jev.evaluate({ state: 'The onboarding probe checks the key.', questions: { probe: { type: 'noul', instructions: 'Is this sentence in English?' } }, escalateTo: 'test' });
  if (r.ok) return { ok: true, detail: `${r.model} · $${r.usage.costUsd ?? 0}` };
  return { ok: false, detail: redactSecrets(r.message, [key]) };
}
```

- [ ] **Step 4: Implement status**

`server/onboarding/status.ts`:
```ts
import { loadSecrets } from '../core/secrets.js';
import { readUserConfig } from './config-store.js';
import { claudeStatus, ghOwner, ghStatus, ghToken, openrouterKey, type ProbeDeps } from './probes.js';

export type ItemName = 'claude' | 'githubOwner' | 'ghLogin' | 'githubToken' | 'openrouterKey';
export const ITEM_NAMES: readonly ItemName[] = ['claude', 'githubOwner', 'ghLogin', 'githubToken', 'openrouterKey'];

export interface Item {
  ok: boolean;
  detail: string;
  secret?: { set: boolean; hint: string };
}

export interface Status {
  items: Record<ItemName, Item>;
  allOk: boolean;
}

export interface StatusDeps extends ProbeDeps {
  home?: string;
  secretsDir: string;
}

export function hint(value: string): string {
  return value.length >= 8 ? value.slice(-4) : '****';
}

/** Spec (onboarding) §4: every item is recomputed live; nothing is cached as "onboarded". */
export async function computeItem(d: StatusDeps, name: ItemName): Promise<Item> {
  const secrets = await loadSecrets(d.secretsDir);
  switch (name) {
    case 'claude':
      return claudeStatus(d);
    case 'ghLogin':
      return ghStatus(d);
    case 'githubOwner': {
      const owner = (await readUserConfig(d.home)).cfg.github.owner;
      if (!owner) return { ok: false, detail: 'GitHub owner not set' };
      return ghOwner(d, owner, secrets.GITHUB_TOKEN ?? null);
    }
    case 'githubToken': {
      const token = secrets.GITHUB_TOKEN;
      if (!token) return { ok: false, detail: 'GITHUB_TOKEN not set', secret: { set: false, hint: '' } };
      return { ...(await ghToken(d, token)), secret: { set: true, hint: hint(token) } };
    }
    case 'openrouterKey': {
      const key = secrets.OPENROUTER_API_KEY;
      if (!key) return { ok: false, detail: 'OPENROUTER_API_KEY not set', secret: { set: false, hint: '' } };
      return { ...(await openrouterKey(d, key)), secret: { set: true, hint: hint(key) } };
    }
  }
}

export async function computeStatus(d: StatusDeps): Promise<Status> {
  const entries = await Promise.all(ITEM_NAMES.map(async (name) => [name, await computeItem(d, name)] as const));
  const items = Object.fromEntries(entries) as Record<ItemName, Item>;
  return { items, allOk: ITEM_NAMES.every((n) => items[n].ok) };
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run test/onboarding && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add server/onboarding/probes.ts server/onboarding/status.ts test/onboarding/probes.test.ts test/onboarding/status.test.ts
git commit -m "feat(onboarding): live probes for claude, gh, owner, token and Jev key, and the five-item status

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: HTTP API with SSE

**Files:**
- Create: `server/api/server.ts`, `server/api/onboarding-routes.ts`
- Test: `test/api/onboarding-api.test.ts`

**Interfaces:**
- Consumes: `computeStatus`, `computeItem`, `StatusDeps`, `ItemName` (Task 5); `LoginSession`, `SessionEvent` (Task 4); `spawnScriptPty`, `childEnv`, `SpawnPty` (Task 3); `writeSecret`, `SECRET_NAME` (Task 1); `setGithubOwner`, `GITHUB_OWNER` (Task 1); `claudeStatus`, `ghStatus` (Task 5); `redactSecrets`.
- Produces:
  ```ts
  // server.ts
  export interface ApiDeps { routes: Route[]; staticDir?: string | null; log?: (line: string) => void }
  export interface Route { method: 'GET' | 'POST' | 'PUT'; path: string; handler: (ctx: RouteContext) => Promise<void> }
  export interface RouteContext { req: IncomingMessage; res: ServerResponse; body: () => Promise<unknown>; json: (status: number, value: unknown) => void; sse: () => SseWriter }
  export interface SseWriter { send(event: string, data: unknown): void; close(): void; onClose(cb: () => void): void }
  export function isAllowedHost(host: string | undefined): boolean;                   // localhost / 127.0.0.1 with optional :port
  export async function startApi(deps: ApiDeps, port: number): Promise<{ port: number; close(): Promise<void> }>;  // binds 127.0.0.1
  // onboarding-routes.ts
  export interface OnboardingDeps extends StatusDeps { spawn: SpawnPty; commands?: { claude: PtySpec; gh: PtySpec }; log?: (line: string) => void }
  export function onboardingRoutes(deps: OnboardingDeps): Route[];
  export class Onboarding { /* holds one LoginSession per CLI; exposes sessions for tests */ }
  ```
- Behaviour per spec §5: bodies are JSON (max 64 kB, else 413); a `Host` outside the allowlist → 403 before routing; unknown route → 404 `{ error }`; `PUT /secrets/<NAME>` accepts only `GITHUB_TOKEN` and `OPENROUTER_API_KEY` (else 404), validates `value` as a non-empty single-line string (else 400), writes, probes that one item, responds `{ item }`; `PUT /github-owner` validates with `GITHUB_OWNER` (400), stores, probes `githubOwner`; `POST /<cli>/login` starts the session and answers `202 { state }`; `POST /<cli>/code` answers 409 unless `awaiting-code`; `GET /<cli>/events` is SSE: on connect one `state` event with the current state, then every session event; the session's probe is `claudeStatus`/`ghStatus`. Logs carry `method path status ms` only.

- [ ] **Step 1: Write the failing test**

`test/api/onboarding-api.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAllowedHost, startApi } from '../../server/api/server.js';
import { onboardingRoutes } from '../../server/api/onboarding-routes.js';
import type { Pty, PtySpec } from '../../server/onboarding/pty.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const KEY = 'sk-or-v1-' + 'ab'.repeat(32);
const TOKEN = 'ghp_' + 'c'.repeat(36);

class FakePty implements Pty {
  writes: string[] = [];
  private data: Array<(c: string) => void> = [];
  private exit: Array<(c: number | null) => void> = [];
  write(d: string) { this.writes.push(d); }
  kill() { this.emitExit(143); }
  onData(cb: (c: string) => void) { this.data.push(cb); }
  onExit(cb: (c: number | null) => void) { this.exit.push(cb); }
  emit(c: string) { for (const cb of this.data) cb(c); }
  emitExit(code: number | null) { for (const cb of this.exit) cb(code); }
}

let home = '';
let api: { port: number; close(): Promise<void> };
let ptys: FakePty[];
let exec: FakeExec;
let logs: string[];
const base = () => `http://127.0.0.1:${api.port}`;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-api-'));
  ptys = [];
  logs = [];
  exec = new FakeExec()
    .onArgs('claude', ['auth', 'status'], () => ({ stdout: JSON.stringify({ loggedIn: true, email: 'a@b.c', subscriptionType: 'max' }) }))
    .onArgs('gh', ['auth', 'status'], () => ({ exitCode: 1, stderr: 'not logged in' }))
    .onArgs('gh', ['api', 'user'], (s) => (s.env?.GH_TOKEN === TOKEN ? { stdout: `HTTP/2.0 200 OK\nX-Oauth-Scopes: repo\n\n{"login":"diego"}` } : { exitCode: 1, stderr: `HTTP 401 for ${s.env?.GH_TOKEN ?? ''}` }));
  const fetch = (async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { probe: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0.000001 } }), { status: 200 })) as typeof fetch;
  api = await startApi(
    { routes: onboardingRoutes({ exec: exec.exec, fetch, home, secretsDir: path.join(home, 'secrets'), spawn: (_s: PtySpec) => { const p = new FakePty(); ptys.push(p); return p; } }), log: (l) => logs.push(l) },
    0,
  );
});
afterEach(async () => {
  await api.close();
  await fs.rm(home, { recursive: true, force: true });
});

describe('api server', () => {
  it('binds 127.0.0.1 and refuses a foreign Host header', async () => {
    expect(isAllowedHost('localhost:3000')).toBe(true);
    expect(isAllowedHost('127.0.0.1')).toBe(true);
    expect(isAllowedHost('evil.example')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
    const r = await fetch(`${base()}/api/onboarding/status`, { headers: { Host: 'evil.example' } });
    expect(r.status).toBe(403);
    expect(logs.some((l) => l.includes('403'))).toBe(true);
  });

  it('GET /status reports the five items, unknown routes are 404', async () => {
    const r = await fetch(`${base()}/api/onboarding/status`);
    expect(r.status).toBe(200);
    const s = (await r.json()) as { items: Record<string, { ok: boolean }>; allOk: boolean };
    expect(Object.keys(s.items).sort()).toEqual(['claude', 'ghLogin', 'githubOwner', 'githubToken', 'openrouterKey']);
    expect(s.items.claude!.ok).toBe(true);
    expect(s.allOk).toBe(false);
    expect((await fetch(`${base()}/api/onboarding/nope`)).status).toBe(404);
  });

  it('PUT /secrets/<NAME> writes the secret, probes it and never echoes the value; other names are 404', async () => {
    const r = await fetch(`${base()}/api/onboarding/secrets/GITHUB_TOKEN`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: TOKEN }) });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).not.toContain(TOKEN);
    expect(JSON.parse(body)).toMatchObject({ item: { ok: true, detail: 'diego · scopes: repo', secret: { set: true, hint: TOKEN.slice(-4) } } });
    expect(await fs.readFile(path.join(home, 'secrets', 'GITHUB_TOKEN'), 'utf8')).toBe(TOKEN);
    expect((await fetch(`${base()}/api/onboarding/secrets/OTHER`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x' }) })).status).toBe(404);
    expect((await fetch(`${base()}/api/onboarding/secrets/GITHUB_TOKEN`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'two\nlines' }) })).status).toBe(400);
  });

  it('a rejected secret value never appears in the response body or the log', async () => {
    const wrong = 'ghp_' + 'w'.repeat(36);
    const r = await fetch(`${base()}/api/onboarding/secrets/GITHUB_TOKEN`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: wrong }) });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(JSON.parse(body).item.ok).toBe(false);
    expect(body).not.toContain(wrong);
    expect(logs.join('\n')).not.toContain(wrong);
  });

  it('PUT /github-owner validates and probes', async () => {
    exec.onArgs('gh', ['api', 'users/diego-dm-morais'], () => ({ stdout: JSON.stringify({ login: 'diego-dm-morais', type: 'User' }) }));
    const bad = await fetch(`${base()}/api/onboarding/github-owner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'has space' }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base()}/api/onboarding/github-owner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'diego-dm-morais' }) });
    expect(await ok.json()).toEqual({ item: { ok: true, detail: 'diego-dm-morais (User)' } });
    expect(JSON.parse(await fs.readFile(path.join(home, '.teams-ai', 'config.json'), 'utf8'))).toEqual({ github: { owner: 'diego-dm-morais' } });
  });

  it('login session over SSE: state events, code posting, 409 outside awaiting-code, replay on connect', async () => {
    expect((await fetch(`${base()}/api/onboarding/claude/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x' }) })).status).toBe(409);
    const started = await fetch(`${base()}/api/onboarding/claude/login`, { method: 'POST' });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ state: { name: 'starting' } });
    const es = await fetch(`${base()}/api/onboarding/claude/events`);
    expect(es.headers.get('content-type')).toContain('text/event-stream');
    const reader = es.body!.getReader();
    const read = async (): Promise<string> => new TextDecoder().decode((await reader.read()).value);
    expect(await read()).toContain('event: state\ndata: {"name":"starting"}');
    ptys[0]!.emit('https://claude.example/a\nPaste code here if prompted > ');
    const chunk = await read();
    expect(chunk).toContain('awaiting-browser');
    expect(chunk).toContain('event: output');
    const posted = await fetch(`${base()}/api/onboarding/claude/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'c0de#st' }) });
    expect(posted.status).toBe(202);
    expect(ptys[0]!.writes).toEqual(['c0de#st\n']);
    ptys[0]!.emitExit(0);
    let all = '';
    for (let i = 0; i < 5 && !all.includes('"done"'); i++) all += await read();
    expect(all).toContain('"name":"done"');
    expect(all).not.toContain('c0de#st');
    await reader.cancel();
    const cancel = await fetch(`${base()}/api/onboarding/claude/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(200);
  });

  it('rejects oversized bodies with 413', async () => {
    const r = await fetch(`${base()}/api/onboarding/github-owner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'x'.repeat(70_000) }) });
    expect(r.status).toBe(413);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/api/onboarding-api.test.ts`
Expected: FAIL, cannot resolve `../../server/api/server.js`.

- [ ] **Step 3: Implement the server**

`server/api/server.ts`:
```ts
import { promises as fs } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

export interface SseWriter {
  send(event: string, data: unknown): void;
  close(): void;
  onClose(cb: () => void): void;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  body: () => Promise<unknown>;
  json: (status: number, value: unknown) => void;
  sse: () => SseWriter;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  handler: (ctx: RouteContext) => Promise<void>;
}

export interface ApiDeps {
  routes: Route[];
  staticDir?: string | null;
  log?: (line: string) => void;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 64 * 1024;

/** Spec (onboarding) §7: only the local browser may talk to the API; a foreign Host is DNS rebinding. */
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

async function serveStatic(dir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const rel = urlPath === '/' || !path.extname(urlPath) ? 'index.html' : urlPath.slice(1);
  const file = path.resolve(dir, rel);
  if (!file.startsWith(path.resolve(dir))) return false;
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export async function startApi(deps: ApiDeps, port: number): Promise<{ port: number; close(): Promise<void> }> {
  const log = deps.log ?? (() => undefined);
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const done = (status: number) => log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
      done(status);
    };
    if (!isAllowedHost(req.headers.host)) return json(403, { error: 'forbidden host' });
    const route = deps.routes.find((r) => r.method === req.method && r.path === url.pathname);
    if (!route) {
      if (req.method === 'GET' && deps.staticDir && (await serveStatic(deps.staticDir, url.pathname, res))) return done(200);
      return json(404, { error: 'not found' });
    }
    const sse = (): SseWriter => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders();
      done(200);
      return {
        send: (event, data) => void res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        close: () => res.end(),
        onClose: (cb) => void res.on('close', cb),
      };
    };
    try {
      await route.handler({ req, res, body: () => readBody(req), json, sse });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) json(status, { error: err instanceof HttpError ? err.message : 'internal error' });
      else done(status);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  return {
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 4: Implement the routes**

`server/api/onboarding-routes.ts`:
```ts
import { SECRET_NAME, writeSecret } from '../core/secrets.js';
import { redactSecrets } from '../core/redact.js';
import { GITHUB_OWNER, setGithubOwner } from '../onboarding/config-store.js';
import { LoginSession } from '../onboarding/login-session.js';
import { claudeStatus, ghStatus } from '../onboarding/probes.js';
import { childEnv, type PtySpec, type SpawnPty } from '../onboarding/pty.js';
import { computeItem, computeStatus, type ItemName, type StatusDeps } from '../onboarding/status.js';
import type { Cli } from '../onboarding/transcripts.js';
import { HttpError, type Route } from './server.js';

export interface OnboardingDeps extends StatusDeps {
  spawn: SpawnPty;
  commands?: { claude: PtySpec; gh: PtySpec };
  log?: (line: string) => void;
}

const SECRETS: Record<string, ItemName> = { GITHUB_TOKEN: 'githubToken', OPENROUTER_API_KEY: 'openrouterKey' };

/** Spec (onboarding) §3: one live session per CLI, kept for the process lifetime. */
export class Onboarding {
  readonly sessions: Record<Cli, LoginSession>;

  constructor(private readonly deps: OnboardingDeps) {
    const env = childEnv(deps.hostEnv);
    const commands = deps.commands ?? {
      claude: { bin: 'claude', args: ['auth', 'login', '--claudeai'], env },
      gh: { bin: 'gh', args: ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key'], env },
    };
    const known = async () => Object.values(await import('../core/secrets.js').then((m) => m.loadSecrets(deps.secretsDir)));
    let knownCache: readonly string[] = [];
    void known().then((v) => (knownCache = v));
    this.sessions = {
      claude: new LoginSession({ cli: 'claude', spawn: deps.spawn, command: commands.claude, probe: () => claudeStatus(deps), knownSecrets: () => knownCache }),
      gh: new LoginSession({ cli: 'gh', spawn: deps.spawn, command: commands.gh, probe: () => ghStatus(deps), knownSecrets: () => knownCache }),
    };
  }
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>)[field] !== 'string') throw new HttpError(400, `${field} must be a string`);
  return (v as Record<string, string>)[field]!;
};

export function onboardingRoutes(deps: OnboardingDeps): Route[] {
  const ob = new Onboarding(deps);
  const P = '/api/onboarding';
  const routes: Route[] = [
    { method: 'GET', path: `${P}/status`, handler: async ({ json }) => json(200, await computeStatus(deps)) },
    {
      method: 'PUT',
      path: `${P}/github-owner`,
      handler: async ({ body, json }) => {
        const owner = str(await body(), 'owner');
        if (!GITHUB_OWNER.test(owner)) throw new HttpError(400, 'owner is not a GitHub login');
        await setGithubOwner(owner, deps.home);
        json(200, { item: await computeItem(deps, 'githubOwner') });
      },
    },
  ];
  for (const [name, item] of Object.entries(SECRETS)) {
    routes.push({
      method: 'PUT',
      path: `${P}/secrets/${name}`,
      handler: async ({ body, json }) => {
        const value = str(await body(), 'value').trim();
        if (!SECRET_NAME.test(name) || value === '' || /[\r\n]/.test(value)) throw new HttpError(400, 'value must be a single non-empty line');
        await writeSecret(deps.secretsDir, name, value);
        const result = await computeItem(deps, item);
        // Belt and braces: the probes redact already; nothing that leaves this handler may carry the value.
        json(200, { item: { ...result, detail: redactSecrets(result.detail, [value]) } });
      },
    });
  }
  for (const cli of ['claude', 'gh'] as const) {
    const s = ob.sessions[cli];
    routes.push(
      { method: 'POST', path: `${P}/${cli}/login`, handler: async ({ json }) => { s.start(); json(202, { state: s.state }); } },
      { method: 'POST', path: `${P}/${cli}/cancel`, handler: async ({ json }) => { s.cancel(); json(200, { state: s.state }); } },
      {
        method: 'POST',
        path: `${P}/${cli}/code`,
        handler: async ({ body, json }) => {
          const code = str(await body(), 'code');
          if (!s.sendCode(code)) return json(409, { error: `session is ${s.state.name}, not awaiting-code`, state: s.state });
          json(202, { state: s.state });
        },
      },
      {
        method: 'GET',
        path: `${P}/${cli}/events`,
        handler: async ({ sse }) => {
          const w = sse();
          w.send('state', s.state);
          if (s.output) w.send('output', s.output);
          const off = s.on((e) => (e.type === 'state' ? w.send('state', e.state) : w.send('output', e.chunk)));
          w.onClose(off);
        },
      },
    );
  }
  return routes;
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run test/api test/onboarding && npm run typecheck`
Expected: PASS; typecheck clean. If the SSE test's first `read()` returns only headers-less empty data, keep reading until the buffer contains `event: state` (the server flushes the first event right after `flushHeaders`).

- [ ] **Step 6: Commit**

```bash
git add server/api/server.ts server/api/onboarding-routes.ts test/api/onboarding-api.test.ts
git commit -m "feat(api): local onboarding API with SSE login sessions and secret writes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Web app

**Files:**
- Create: `web/package.json`, `web/index.html`, `web/vite.config.ts`, `web/tsconfig.json`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/useSse.ts`, `web/src/components/ItemCard.tsx`, `web/src/components/LoginCard.tsx`, `web/src/components/SecretCard.tsx`, `web/src/components/OwnerCard.tsx`, `web/src/pages/Onboarding.tsx`, `web/src/pages/StatusPage.tsx`, `web/src/styles.css`, `web/src/test-setup.ts`
- Test: `web/src/components/ItemCard.test.tsx`, `web/src/components/LoginCard.test.tsx`
- Modify: root `package.json` (scripts `web:install`, `web:dev`, `web:build`, `test:web`), `.gitignore` (`web/node_modules`, `web/dist`)

**Interfaces:**
- Consumes: the API shapes of Task 6 (`Status`, `Item`, `SessionState`, `SessionEvent`), copied as TypeScript types into `web/src/api.ts` (the web app has its own tsconfig and does not import server code).
- Produces: `web/dist/` (served by the API in production), `npm run test:web`.

- [ ] **Step 1: Scaffold files**

`web/package.json`:
```json
{
  "name": "teams-ai-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit -p tsconfig.json && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "react-router-dom": "7.18.4"
  },
  "devDependencies": {
    "@testing-library/dom": "10.4.2",
    "@testing-library/react": "16.3.3",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.1",
    "jsdom": "30.1.1",
    "typescript": "5.9.3",
    "vite": "8.3.1",
    "vitest": "5.0.1"
  }
}
```

`web/vite.config.ts`:
```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: `http://127.0.0.1:${process.env.TEAMS_AI_API_PORT ?? '8787'}`, changeOrigin: false } } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.tsx'] },
});
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>teams-ai</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/test-setup.ts`:
```ts
import '@testing-library/dom';
```

`web/src/api.ts`:
```ts
export type ItemName = 'claude' | 'githubOwner' | 'ghLogin' | 'githubToken' | 'openrouterKey';
export interface Item { ok: boolean; detail: string; secret?: { set: boolean; hint: string } }
export interface Status { items: Record<ItemName, Item>; allOk: boolean }
export type SessionState =
  | { name: 'idle' }
  | { name: 'starting' }
  | { name: 'awaiting-browser'; url: string; code: string | null }
  | { name: 'awaiting-code'; url: string | null }
  | { name: 'verifying' }
  | { name: 'done'; detail: string }
  | { name: 'failed'; reason: string };
export type Cli = 'claude' | 'gh';

const P = '/api/onboarding';
async function json<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
export const api = {
  status: () => fetch(`${P}/status`).then((r) => json<Status>(r)),
  login: (cli: Cli) => fetch(`${P}/${cli}/login`, { method: 'POST' }).then((r) => json<{ state: SessionState }>(r)),
  cancel: (cli: Cli) => fetch(`${P}/${cli}/cancel`, { method: 'POST' }).then((r) => json<{ state: SessionState }>(r)),
  code: (cli: Cli, code: string) => fetch(`${P}/${cli}/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).then((r) => json<{ state: SessionState }>(r)),
  owner: (owner: string) => fetch(`${P}/github-owner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner }) }).then((r) => json<{ item: Item }>(r)),
  secret: (name: 'GITHUB_TOKEN' | 'OPENROUTER_API_KEY', value: string) => fetch(`${P}/secrets/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) }).then((r) => json<{ item: Item }>(r)),
  events: (cli: Cli) => `${P}/${cli}/events`,
};
```

`web/src/useSse.ts`:
```ts
import { useEffect, useState } from 'react';
import type { SessionState } from './api.js';

export function useSse(url: string | null, initial: SessionState = { name: 'idle' }) {
  const [state, setState] = useState<SessionState>(initial);
  const [output, setOutput] = useState('');
  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    es.addEventListener('state', (e) => setState(JSON.parse((e as MessageEvent).data) as SessionState));
    es.addEventListener('output', (e) => setOutput((o) => (o + (JSON.parse((e as MessageEvent).data) as string)).slice(-4096)));
    return () => es.close();
  }, [url]);
  return { state, output, setState };
}
```

`web/src/components/ItemCard.tsx`:
```tsx
import type { ReactNode } from 'react';
import type { Item } from '../api.js';

export function ItemCard({ title, item, children }: { title: string; item: Item | null; children?: ReactNode }) {
  const status = item === null ? 'checking' : item.ok ? 'ok' : 'todo';
  return (
    <section className={`card card-${status}`} data-testid={`card-${title}`}>
      <header>
        <span className="dot" aria-label={status} />
        <h2>{title}</h2>
        {item?.secret?.set ? <code className="hint">…{item.secret.hint}</code> : null}
      </header>
      <p className="detail">{item === null ? 'Checking…' : item.detail}</p>
      {children}
    </section>
  );
}
```

`web/src/components/LoginCard.tsx`:
```tsx
import { useState } from 'react';
import { api, type Cli, type Item, type SessionState } from '../api.js';
import { ItemCard } from './ItemCard.js';
import { useSse } from '../useSse.js';

export function LoginCard({ cli, title, item, onDone }: { cli: Cli; title: string; item: Item | null; onDone: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const { state, output, setState } = useSse(url);
  const [code, setCode] = useState('');
  const [showOutput, setShowOutput] = useState(false);
  const start = async () => {
    const r = await api.login(cli);
    setState(r.state);
    setUrl(api.events(cli));
  };
  const send = async () => {
    await api.code(cli, code);
    setCode('');
  };
  if (state.name === 'done' && url) {
    setUrl(null);
    onDone();
  }
  return (
    <ItemCard title={title} item={item}>
      <LoginControls state={state} code={code} onCode={setCode} onStart={start} onSend={send} onCancel={() => api.cancel(cli)} />
      {url ? (
        <button type="button" className="link" onClick={() => setShowOutput((v) => !v)}>
          {showOutput ? 'Hide CLI output' : 'Show CLI output'}
        </button>
      ) : null}
      {showOutput ? <pre className="output">{output}</pre> : null}
    </ItemCard>
  );
}

export function LoginControls({ state, code, onCode, onStart, onSend, onCancel }: { state: SessionState; code: string; onCode: (v: string) => void; onStart: () => void; onSend: () => void; onCancel: () => void }) {
  const live = state.name === 'starting' || state.name === 'awaiting-browser' || state.name === 'awaiting-code' || state.name === 'verifying';
  return (
    <div className="controls">
      {!live ? (
        <button type="button" onClick={onStart}>
          {state.name === 'failed' ? 'Retry' : 'Sign in'}
        </button>
      ) : null}
      {state.name === 'starting' || state.name === 'verifying' ? <span className="spinner">{state.name === 'starting' ? 'Starting…' : 'Verifying…'}</span> : null}
      {state.name === 'awaiting-browser' || state.name === 'awaiting-code' ? (
        <>
          {state.url ? (
            <a href={state.url} target="_blank" rel="noreferrer">
              Open link
            </a>
          ) : null}
          {state.name === 'awaiting-browser' && state.code ? (
            <p>
              Enter this code on the page: <code data-testid="one-time-code">{state.code}</code>
            </p>
          ) : null}
        </>
      ) : null}
      {state.name === 'awaiting-code' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSend();
          }}
        >
          <label>
            Paste the code shown by the page
            <input data-testid="code-input" value={code} onChange={(e) => onCode(e.target.value)} autoComplete="off" />
          </label>
          <button type="submit" disabled={code.trim() === ''}>
            Send
          </button>
        </form>
      ) : null}
      {live ? (
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
      {state.name === 'failed' ? <p className="error">{state.reason}</p> : null}
    </div>
  );
}
```

`web/src/components/SecretCard.tsx`:
```tsx
import { useState } from 'react';
import { api, type Item } from '../api.js';
import { ItemCard } from './ItemCard.js';

export function SecretCard({ name, title, item, onSaved }: { name: 'GITHUB_TOKEN' | 'OPENROUTER_API_KEY'; title: string; item: Item | null; onSaved: (item: Item) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.secret(name, value);
      setValue('');
      onSaved(r.item);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ItemCard title={title} item={item}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={item?.secret?.set ? 'Replace the stored value' : 'Paste the value'} autoComplete="off" />
        <button type="submit" disabled={busy || value.trim() === ''}>
          {busy ? 'Checking…' : 'Save and verify'}
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </ItemCard>
  );
}
```

`web/src/components/OwnerCard.tsx`:
```tsx
import { useState } from 'react';
import { api, type Item } from '../api.js';
import { ItemCard } from './ItemCard.js';

export function OwnerCard({ item, onSaved }: { item: Item | null; onSaved: (item: Item) => void }) {
  const [owner, setOwner] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      onSaved((await api.owner(owner)).item);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <ItemCard title="GitHub owner" item={item}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="user or organization" />
        <button type="submit" disabled={owner.trim() === ''}>
          Save and verify
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </ItemCard>
  );
}
```

`web/src/pages/Onboarding.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Item, type ItemName, type Status } from '../api.js';
import { LoginCard } from '../components/LoginCard.js';
import { OwnerCard } from '../components/OwnerCard.js';
import { SecretCard } from '../components/SecretCard.js';

export function Onboarding({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = useCallback(() => void api.status().then(setStatus), []);
  useEffect(refresh, [refresh]);
  const item = (n: ItemName): Item | null => status?.items[n] ?? null;
  const patch = (n: ItemName) => (it: Item) => setStatus((s) => (s ? { ...s, items: { ...s.items, [n]: it }, allOk: Object.entries({ ...s.items, [n]: it }).every(([, v]) => v.ok) } : s));
  return (
    <main className={compact ? 'compact' : ''}>
      <h1>{compact ? 'Host status' : 'Set up this host'}</h1>
      <LoginCard cli="claude" title="Claude login" item={item('claude')} onDone={refresh} />
      <OwnerCard item={item('githubOwner')} onSaved={patch('githubOwner')} />
      <LoginCard cli="gh" title="GitHub CLI login" item={item('ghLogin')} onDone={refresh} />
      <SecretCard name="GITHUB_TOKEN" title="GitHub token" item={item('githubToken')} onSaved={patch('githubToken')} />
      <SecretCard name="OPENROUTER_API_KEY" title="OpenRouter key (Jev)" item={item('openrouterKey')} onSaved={patch('openrouterKey')} />
      {status?.allOk ? (
        <p className="all-ok">
          Everything is set. <Link to="/status">Continue</Link>
        </p>
      ) : null}
    </main>
  );
}
```

`web/src/pages/StatusPage.tsx`:
```tsx
import { Onboarding } from './Onboarding.js';

export function StatusPage() {
  return <Onboarding compact />;
}
```

`web/src/App.tsx`:
```tsx
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Onboarding } from './pages/Onboarding.js';
import { StatusPage } from './pages/StatusPage.js';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/onboarding" replace />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/status" element={<StatusPage />} />
      </Routes>
    </BrowserRouter>
  );
}
```

`web/src/main.tsx`:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`web/src/styles.css`:
```css
:root { font-family: system-ui, sans-serif; color: #1a1a1a; background: #fafafa; }
main { max-width: 720px; margin: 2rem auto; padding: 0 1rem; display: grid; gap: 1rem; }
.card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; background: #fff; }
.card header { display: flex; align-items: center; gap: 0.5rem; }
.card h2 { font-size: 1.1rem; margin: 0; flex: 1; }
.dot { width: 0.75rem; height: 0.75rem; border-radius: 50%; background: #999; }
.card-ok .dot { background: #2e9e4f; }
.card-todo .dot { background: #d33; }
.detail { color: #555; margin: 0.5rem 0; }
.controls, form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
input { flex: 1; min-width: 12rem; padding: 0.4rem; }
button { padding: 0.4rem 0.8rem; }
.error { color: #b00; }
.output { background: #111; color: #ddd; padding: 0.5rem; max-height: 12rem; overflow: auto; font-size: 0.8rem; }
.hint { color: #777; }
.compact .card { padding: 0.5rem 1rem; }
```

- [ ] **Step 2: Write the failing component tests**

`web/src/components/ItemCard.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ItemCard } from './ItemCard.js';

describe('ItemCard', () => {
  it('renders checking, green and red states from the status payload and shows only the hint of a secret', () => {
    const { rerender } = render(<ItemCard title="Claude login" item={null} />);
    expect(screen.getByText('Checking…')).toBeTruthy();
    expect(screen.getByLabelText('checking')).toBeTruthy();
    rerender(<ItemCard title="Claude login" item={{ ok: true, detail: 'a@b.c (max)' }} />);
    expect(screen.getByLabelText('ok')).toBeTruthy();
    expect(screen.getByText('a@b.c (max)')).toBeTruthy();
    rerender(<ItemCard title="GitHub token" item={{ ok: false, detail: 'HTTP 401', secret: { set: true, hint: 'c9Zk' } }} />);
    expect(screen.getByLabelText('todo')).toBeTruthy();
    expect(screen.getByText('…c9Zk')).toBeTruthy();
    expect(document.body.textContent).not.toContain('ghp_');
  });
});
```

`web/src/components/LoginCard.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoginControls } from './LoginCard.js';

const noop = () => undefined;

describe('LoginControls', () => {
  it('shows the code field only in awaiting-code and sends the pasted code', () => {
    const onSend = vi.fn();
    const { rerender } = render(<LoginControls state={{ name: 'idle' }} code="" onCode={noop} onStart={noop} onSend={onSend} onCancel={noop} />);
    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(screen.queryByTestId('code-input')).toBeNull();
    rerender(<LoginControls state={{ name: 'awaiting-browser', url: 'https://github.com/login/device', code: 'A1EB-D4E0' }} code="" onCode={noop} onStart={noop} onSend={onSend} onCancel={noop} />);
    expect(screen.getByText('Open link').getAttribute('href')).toBe('https://github.com/login/device');
    expect(screen.getByTestId('one-time-code').textContent).toBe('A1EB-D4E0');
    expect(screen.queryByTestId('code-input')).toBeNull();
    rerender(<LoginControls state={{ name: 'awaiting-code', url: 'https://claude.example/a' }} code="c0de#st" onCode={noop} onStart={noop} onSend={onSend} onCancel={noop} />);
    expect(screen.getByTestId('code-input')).toBeTruthy();
    fireEvent.click(screen.getByText('Send'));
    expect(onSend).toHaveBeenCalledTimes(1);
    rerender(<LoginControls state={{ name: 'failed', reason: 'timeout' }} code="" onCode={noop} onStart={noop} onSend={onSend} onCancel={noop} />);
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(screen.getByText('timeout')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Install and run the web tests to see them fail, then pass**

Run:
```bash
cd web && npm install --no-audit --no-fund && npx vitest run
```
Expected: with the components already written, both test files PASS (the RED step for this task is the missing `web/node_modules`: run `npx vitest run` once before `npm install` to see "Cannot find module 'react'"). Then `npm run build` in `web/` produces `web/dist/index.html`.

- [ ] **Step 4: Root scripts and ignores**

Add to root `package.json` `scripts`:
```json
"web:install": "cd web && npm install --no-audit --no-fund",
"web:dev": "cd web && npm run dev",
"web:build": "cd web && npm run build",
"test:web": "cd web && npm test"
```
Append to `.gitignore`:
```
web/node_modules/
web/dist/
```
Root `npm test` stays unchanged (Vitest's `include` is `test/**/*.test.ts`, so web tests do not run there). Commit `web/package-lock.json`.

- [ ] **Step 5: Verify**

Run: `npm run test:web && npm run web:build && npm test && npm run typecheck`
Expected: web tests PASS, `web/dist` built, root suite unchanged and green, typecheck clean (the root tsconfig does not include `web/`).

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/index.html web/vite.config.ts web/tsconfig.json web/src .gitignore package.json
git commit -m "feat(web): onboarding and status pages over the local API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `teams-ai ui` command and the live checklist

**Files:**
- Modify: `server/cli.ts` (add `ui` command), `test/cli.test.ts` (usage lists `ui`; `ui` starts and stops the API with an injected factory)
- Create: `docs/superpowers/plans/2026-09-24-teams-ai-08-web-ui-onboarding.md` `## Findings` section (this plan; appended after the live run)

**Interfaces:**
- Consumes: `startApi` (Task 6), `onboardingRoutes` (Task 6), `spawnScriptPty`, `hasScript` (Task 3), `expandHome`, `loadConfig`.
- Produces: `teams-ai ui [--port N] [--no-open]` → starts the API on `127.0.0.1:<port>` (default 8787), serves `web/dist` when it exists, prints `Open http://localhost:<port>/onboarding`, refuses to start when `script` is missing (exit 2, message names `bsdutils`/`util-linux`), runs until SIGINT.

- [ ] **Step 1: Write the failing test**

Append to `test/cli.test.ts`:
```ts
  it('ui starts the API on the requested port and serves the status route', async () => {
    const a = io(['ui', '--port', '0', '--project', '/tmp/p']);
    let closed = false;
    const code = await main(a.io, undefined, {
      startUi: async (port) => ({ port: port === 0 ? 45678 : port, close: async () => { closed = true; } }),
      waitForSignal: async () => undefined,
    });
    expect(code).toBe(0);
    expect(a.err.join('\n')).toContain('http://localhost:45678/onboarding');
    expect(closed).toBe(true);
  });
```
and in the first test assert the usage mentions `ui`: `expect(a.err.join('\n')).toContain('teams-ai ui');`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `main` does not accept a third argument / usage lacks `ui`.

- [ ] **Step 3: Implement**

In `server/cli.ts`:
- Extend `USAGE` with `  teams-ai ui     [--port N]            start the local web UI (onboarding, status)`.
- Add:
```ts
import { startApi } from './api/server.js';
import { onboardingRoutes } from './api/onboarding-routes.js';
import { hasScript, spawnScriptPty } from './onboarding/pty.js';

export interface UiHooks {
  startUi?: (port: number) => Promise<{ port: number; close(): Promise<void> }>;
  waitForSignal?: () => Promise<void>;
}

async function startUiReal(port: number, io: CliIo): Promise<{ port: number; close(): Promise<void> }> {
  if (!(await hasScript(io.env))) throw new Error('the web UI needs util-linux `script` on PATH (apt install bsdutils)');
  const cfg = loadConfig(await fs.readFile(path.join(expandHome('~/.teams-ai'), 'config.json'), 'utf8').then(JSON.parse).catch(() => ({})));
  const staticDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'web', 'dist');
  const hasDist = await fs.access(path.join(staticDir, 'index.html')).then(() => true, () => false);
  if (!hasDist) io.stderr('web/dist not found: run `npm run web:build` (or `npm run web:dev` for the Vite dev server with /api proxied)');
  return startApi(
    { routes: onboardingRoutes({ exec: execCommand, fetch: globalThis.fetch, hostEnv: io.env, secretsDir: expandHome(cfg.paths.secrets), spawn: spawnScriptPty, log: io.stderr }), staticDir: hasDist ? staticDir : null, log: io.stderr },
    port,
  );
}
```
- In `main(io, factory, hooks: UiHooks = {})`: allow `command === 'ui'` without `--project` (adjust the guard: `!projectDir && command !== 'ui'`); handle it before the `status` branch:
```ts
    if (command === 'ui') {
      const port = typeof f.port === 'string' ? Number(f.port) : 8787;
      const server = await (hooks.startUi ?? ((p) => startUiReal(p, io)))(port);
      io.stderr(`Open http://localhost:${server.port}/onboarding`);
      await (hooks.waitForSignal ?? (() => new Promise<void>((resolve) => { process.once('SIGINT', () => resolve()); process.once('SIGTERM', () => resolve()); })))();
      await server.close();
      return 0;
    }
```
- Add root script `"ui": "tsx --no-warnings=ExperimentalWarning server/cli.ts ui"`.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/cli.test.ts && npm run typecheck && npm test`
Expected: PASS; typecheck clean; whole suite green.

- [ ] **Step 5: Live checklist (WSL, manual, real tools)**

Run in WSL from the repository root, with `web/dist` built:
```bash
npm run web:build && npm run ui
```
Then in the Windows browser open `http://localhost:8787/onboarding` and walk the five cards. Record in `## Findings` of this plan, one line each:
1. Claude card: the exact URL line and the exact "paste code" prompt text the real CLI printed (spec §10 item 1); whether the pasted `code#state` was accepted; how many seconds until `claude auth status --json` reported `loggedIn: true` after the process exited (spec §10 item 4).
2. gh card: whether pressing Enter automatically kept `gh` polling (spec §10 item 3); the account shown.
3. Owner card: the response for a user and for an organization.
4. Token card: the scopes line; confirm `GITHUB_TOKEN` in `~/.teams-ai/secrets/` has mode 0600.
5. Key card: model and cost reported by the Jev probe.
6. Any transcript regex that had to change, any need for `node-pty` (spec §10 item 2), and the total wall time.
If a card cannot go green, fix the code with a test and note the fix here before committing.

- [ ] **Step 6: Commit**

```bash
git add server/cli.ts test/cli.test.ts package.json docs/superpowers/plans/2026-09-24-teams-ai-08-web-ui-onboarding.md
git commit -m "feat(cli): teams-ai ui serves the onboarding web app over the local API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** §2 layout → Tasks 1–8 create every listed file (`transcripts`, `pty`, `login-session`, `probes`, `status`, `server`, `onboarding-routes`, `writeSecret`, `web/`). §3 states, one live session per CLI, 10-minute timeout, redacted 4 kB tail, codes never persisted, probe decides → Task 4 (tests for each rule) and Task 6 (`Onboarding` holds one session per CLI). §3.1/§3.2 flows → Task 2 regexes + Task 4 gh test (auto Enter) and claude test. §3.3 `script -qfec`, node-pty fallback documented only → Task 3. §4 items, storage, probes, hints, live recomputation → Tasks 1, 5. §5 routes, status codes, hint, replay on connect, no body logging → Task 6. §6 UI cards, `/status`, code field only in awaiting-code, cleared inputs → Task 7. §7 Host check, sanitized env, `GH_TOKEN` only in the token probe, 0700/0600, redaction → Tasks 3, 5, 6, 1. §8 errors: missing binary (probe detail), missing `script` (Task 8 exit 2), timeout, rejected code, probe failure keeps the file, second login kills the first → Tasks 4, 5, 6, 8. §9 tests → each task; live e2e → Task 8 checklist. §10 open items → recorded by the Task 8 checklist.

**Placeholder scan.** No TBD/TODO. The only "record here" text is the deliberate Findings instruction of Task 8, which names exactly what to write.

**Type consistency.** `SessionState`/`SessionEvent` (Task 4) are used by Task 6 routes and copied verbatim into `web/src/api.ts`; `Item`/`Status`/`ItemName` (Task 5) match the API JSON and the web types; `Pty`/`PtySpec`/`SpawnPty` (Task 3) are what Tasks 4 and 6 consume; `ProbeDeps`/`StatusDeps`/`OnboardingDeps` extend each other in that order; `HttpError`, `Route`, `RouteContext` come from Task 6's `server.ts`.

**Review Focus mapping.** 1 → Task 4 "writes the pasted code plus newline to the pty and never emits it". 2 → Task 6 "a rejected secret value never appears in the response body or the log". 3 → Task 6 "binds 127.0.0.1 and refuses a foreign Host header". 4 → Task 4 "cancel kills the process and starting a new session kills the live one". 5 → Task 4 "a process that exits before printing a URL goes straight to verifying".

**Ambiguities resolved.** The spec's "success line" for Claude is unknown (spec §10 item 1); the session does not depend on it: process exit always leads to `verifying` and the probe decides. `sendCode` moves the session to `verifying` immediately (the CLI gives no further prompt to wait for). The gh auto-Enter is sent once both the code and the URL were seen, as the CLI prints them in that order. Web tests live in `web/` with their own Vitest so the root suite keeps its `node` environment.

## Findings (live run, 2026-09-24, WSL Ubuntu, util-linux 2.39.3)

Run: `npm run web:build && npm run ui -- --port 8787` in WSL, page opened from the Windows browser at `http://localhost:8787/onboarding`.

1. Claude card: the host was already logged in (`claude auth status --json` → `loggedIn: true`), so the probe went green without a login session. The live `claude auth login` transcript (URL line, paste prompt wording, seconds until `loggedIn`) is still to be recorded on a fresh host or after `claude auth logout`.
2. gh card: green from the existing login (`gh auth status` → account `lukeware70X7`). The auto-Enter behaviour of the device flow is covered by the fake CLI test only; the real flow is still to be walked once.
3. Owner card: `PUT /github-owner` answered `diego-dm-morais (User)` and `github (Organization)`; `-bad` → 400 `owner is not a GitHub login`. The file `~/.teams-ai/config.json` was created with only `github.owner`.
4. Token card: green, `diego-dm-morais · scopes: admin:enterprise, …, repo, user, workflow, …`; `~/.teams-ai/secrets` is `700`, both files `600`. `PUT /secrets/FOO` → 404, empty value → 400.
5. Key card: green, `typesafe/jev-1.13-20260917 · $0.000011844` (one Noul).
6. No transcript regex changed; no `node-pty` needed (the fake-CLI pty tests pass in WSL with `script -qfec`). Status endpoint took 666 ms for all five probes. Foreign `Host` → 403. Fixes made on the way: `kill` must SIGKILL the detached process group (`script` exits 0 on SIGTERM); the timeout path bumps the session generation before killing (a green probe otherwise turned a timeout into `done`); Node `fetch` drops the `Host` header, so that test uses `node:http`; `vite.config.ts` needs `defineConfig` from `vitest/config`; the server must be started detached (`setsid`) when launched from a non-interactive WSL shell.
