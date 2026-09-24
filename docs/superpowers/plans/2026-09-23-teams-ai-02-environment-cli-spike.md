# teams-ai Plan 2 — Environment and CLI Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the WSL2 Ubuntu environment the orchestrator runs in, and answer the spec's open questions about the Claude Code CLI (spec §16) with recorded evidence, so Plan 3 can build the runner on facts instead of assumptions.

**Architecture:** Three deterministic, unit-tested pieces (tool report validator, stream-json event parser, orchestrator config loader) plus two manual, evidence-producing activities (environment setup inside WSL, CLI probes). Everything the probes record lands as fixtures under `test/fixtures/stream/` so Plan 3's runner tests replay real CLI output. Findings are written to `docs/superpowers/spikes/2026-09-23-cli-findings.md`.

**Tech Stack:** Node 22 (ESM), TypeScript 5.9.3, Vitest 5, zod 4 (all already pinned by Plan 1); bash scripts for WSL; Claude Code CLI 2.1.x inside Ubuntu.

**Spec:** `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` — §3.3 (agent process invocation), §8 (tokens), §9A.1 (compaction), §10 (OmniRoute env), §14 (security), §15 (prerequisites), §16 (open items).

## Global Constraints

- Everything from Plan 1's Global Constraints still applies (pins, ESM, `.js` import suffix, English, commit trailer).
- No LLM calls inside `npm test`. Probes run manually inside WSL and are recorded to fixtures; tests replay fixtures.
- Scripts are POSIX bash (`#!/usr/bin/env bash`, `set -euo pipefail`), idempotent, and never store secrets.
- The Windows host is only a launcher. teams-ai and `~/.teams-ai/` live on the Linux filesystem (spec §15), never under `/mnt/c`.
- The probes never route the Claude subscription through OmniRoute (spec §10).
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

## Review Focus

1. **Stream-json line that is not JSON** (CLI warning printed to stdout, or a truncated last line when the process is killed) — the parser must skip or flag it, never throw away the whole stream (test in Task 2).
2. **`result` event missing `usage` or `total_cost_usd`** (older CLI, or an error result) — the summary must still report `is_error` and `num_turns` with usage fields as zero, not crash (test in Task 2).
3. **Config file with an unknown role or a provider profile for a confidential project** — must be rejected at load time with the offending path, not fail later inside a run (tests in Task 3).
4. **Tool report where a tool exists but the version is below the floor** (e.g. Node 20) — must be `MISSING`, not `OK` (test in Task 1).
5. **`--setting-sources project` still loading user hooks** — if the probe shows leakage, Plan 3 must not rely on the flag alone; the findings document records the measured baseline so the decision is explicit (Task 4 P1).

---

## File structure

```
scripts/wsl/setup-ubuntu.sh        idempotent installer, run inside Ubuntu
scripts/wsl/check-tools.sh         prints a JSON tool report (name, present, version)
scripts/wsl/probes/p1-baseline.sh  ... p6-sandbox.sh   CLI probes; each writes to spikes/recordings/
server/env/tool-report.ts          zod schema for the report + required tool floors + evaluate()
server/runner/stream-events.ts     stream-json line parser + result summary (consumed by Plan 3)
server/config/config.ts            ~/.teams-ai/config.json schema, defaults, loader
test/env/tool-report.test.ts
test/runner/stream-events.test.ts
test/config/config.test.ts
test/fixtures/stream/*.ndjson      synthesized now; replaced by real recordings in Task 4
docs/superpowers/spikes/2026-09-23-cli-findings.md
```

---

### Task 1: WSL setup scripts and tool report validator

**Files:**
- Create: `scripts/wsl/setup-ubuntu.sh`, `scripts/wsl/check-tools.sh`
- Create: `server/env/tool-report.ts`
- Test: `test/env/tool-report.test.ts`

**Interfaces:**
- Consumes: nothing from Plan 1.
- Produces:
  - `ToolReport` (zod): `{ host: { kernel: string; distro: string; onLinuxFs: boolean }; tools: Array<{ name: string; present: boolean; version: string | null }> }`
  - `REQUIRED_TOOLS: ReadonlyArray<{ name: string; minVersion?: string; optional?: boolean }>`
  - `type ToolStatus = 'OK' | 'MISSING' | 'OPTIONAL-MISSING' | 'NOT-ON-LINUX-FS'`
  - `evaluateReport(report: ToolReport): Array<{ name: string; status: ToolStatus; detail: string }>`
  - `compareVersions(a: string, b: string): number` (semver-ish, ignores prefixes like `v`)

- [ ] **Step 1: Write the failing test**

`test/env/tool-report.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { REQUIRED_TOOLS, ToolReport, compareVersions, evaluateReport } from '../../server/env/tool-report.js';

const report = (tools: Array<{ name: string; present: boolean; version: string | null }>, onLinuxFs = true) =>
  ToolReport.parse({ host: { kernel: '5.15.167.4-microsoft-standard-WSL2', distro: 'Ubuntu-24.04', onLinuxFs }, tools });

describe('compareVersions', () => {
  it('orders numeric components and ignores a v prefix', () => {
    expect(compareVersions('v22.12.0', '22.11.9')).toBeGreaterThan(0);
    expect(compareVersions('2.1.280', '2.1.280')).toBe(0);
    expect(compareVersions('0.9.34', '0.10.0')).toBeLessThan(0);
  });
});

describe('evaluateReport', () => {
  it('marks a present tool at or above its floor as OK', () => {
    const rows = evaluateReport(report([{ name: 'node', present: true, version: 'v22.12.0' }]));
    expect(rows.find((r) => r.name === 'node')).toMatchObject({ status: 'OK' });
  });

  it('marks a present tool below its floor as MISSING with the floor in the detail', () => {
    const rows = evaluateReport(report([{ name: 'node', present: true, version: 'v20.19.0' }]));
    expect(rows.find((r) => r.name === 'node')).toMatchObject({ status: 'MISSING', detail: expect.stringContaining('>=22.12') });
  });

  it('marks absent required tools MISSING and absent optional tools OPTIONAL-MISSING', () => {
    const rows = evaluateReport(report([]));
    expect(rows.find((r) => r.name === 'claude')!.status).toBe('MISSING');
    expect(rows.find((r) => r.name === 'llama-server')!.status).toBe('OPTIONAL-MISSING');
  });

  it('flags a repository that lives under /mnt/c', () => {
    const rows = evaluateReport(report([], false));
    expect(rows[0]).toMatchObject({ name: 'filesystem', status: 'NOT-ON-LINUX-FS' });
  });

  it('lists every required tool exactly once', () => {
    const names = evaluateReport(report([])).map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of REQUIRED_TOOLS) expect(names).toContain(tool.name);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/env/tool-report.test.ts`
Expected: FAIL — cannot resolve `../../server/env/tool-report.js`.

- [ ] **Step 3: Write the validator**

`server/env/tool-report.ts`:
```ts
import { z } from 'zod';

export const ToolReport = z.object({
  host: z.object({
    kernel: z.string(),
    distro: z.string(),
    onLinuxFs: z.boolean(),
  }),
  tools: z.array(
    z.object({
      name: z.string().min(1),
      present: z.boolean(),
      version: z.string().nullable(),
    }),
  ),
});
export type ToolReport = z.infer<typeof ToolReport>;

/** Floors come from the spec (§15) and Plan 1's pins. `llama-server` is only needed for Plan 8. */
export const REQUIRED_TOOLS: ReadonlyArray<{ name: string; minVersion?: string; optional?: boolean }> = [
  { name: 'node', minVersion: '22.12.0' },
  { name: 'npm' },
  { name: 'git' },
  { name: 'claude', minVersion: '2.1.0' },
  { name: 'gh' },
  { name: 'docker' },
  { name: 'kind' },
  { name: 'kubectl' },
  { name: 'gitleaks' },
  { name: 'osv-scanner' },
  { name: 'graphify' },
  { name: 'nvidia-smi', optional: true },
  { name: 'llama-server', optional: true },
];

export type ToolStatus = 'OK' | 'MISSING' | 'OPTIONAL-MISSING' | 'NOT-ON-LINUX-FS';

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => (v.match(/\d+/g) ?? []).map(Number);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function evaluateReport(report: ToolReport): Array<{ name: string; status: ToolStatus; detail: string }> {
  const rows: Array<{ name: string; status: ToolStatus; detail: string }> = [];
  rows.push(
    report.host.onLinuxFs
      ? { name: 'filesystem', status: 'OK', detail: 'repository on the Linux filesystem' }
      : { name: 'filesystem', status: 'NOT-ON-LINUX-FS', detail: 'move teams-ai and ~/.teams-ai off /mnt/c (spec §15)' },
  );
  const found = new Map(report.tools.map((t) => [t.name, t]));
  for (const tool of REQUIRED_TOOLS) {
    const entry = found.get(tool.name);
    const missing: ToolStatus = tool.optional ? 'OPTIONAL-MISSING' : 'MISSING';
    if (!entry || !entry.present) {
      rows.push({ name: tool.name, status: missing, detail: 'not installed' });
      continue;
    }
    if (tool.minVersion && (entry.version === null || compareVersions(entry.version, tool.minVersion) < 0)) {
      rows.push({ name: tool.name, status: missing, detail: `found ${entry.version ?? 'unknown'}, need >=${tool.minVersion}` });
      continue;
    }
    rows.push({ name: tool.name, status: 'OK', detail: entry.version ?? 'present' });
  }
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/env/tool-report.test.ts && npm run typecheck`
Expected: 6 tests PASS; typecheck exits 0.

- [ ] **Step 5: Write the tool check script**

`scripts/wsl/check-tools.sh` (prints the JSON the validator consumes; run inside Ubuntu):
```bash
#!/usr/bin/env bash
# Prints a JSON tool report for server/env/tool-report.ts. Read-only.
set -euo pipefail

version_of() {
  local name="$1"
  case "$name" in
    node) node --version 2>/dev/null ;;
    npm) npm --version 2>/dev/null ;;
    git) git --version 2>/dev/null | awk '{print $3}' ;;
    claude) claude --version 2>/dev/null | awk '{print $1}' ;;
    gh) gh --version 2>/dev/null | head -1 | awk '{print $3}' ;;
    docker) docker version --format '{{.Client.Version}}' 2>/dev/null ;;
    kind) kind version 2>/dev/null | awk '{print $2}' ;;
    kubectl) kubectl version --client -o json 2>/dev/null | sed -n 's/.*"gitVersion": *"\([^"]*\)".*/\1/p' | head -1 ;;
    gitleaks) gitleaks version 2>/dev/null ;;
    osv-scanner) osv-scanner --version 2>/dev/null | head -1 | awk '{print $NF}' ;;
    graphify) pipx list --short 2>/dev/null | awk '/^graphifyy /{print $2}' ;;
    nvidia-smi) nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 ;;
    llama-server) llama-server --version 2>&1 | head -1 ;;
    *) echo "" ;;
  esac
}

tools=(node npm git claude gh docker kind kubectl gitleaks osv-scanner graphify nvidia-smi llama-server)
first=1
printf '{"host":{"kernel":"%s","distro":"%s","onLinuxFs":%s},"tools":[' \
  "$(uname -r)" "${WSL_DISTRO_NAME:-unknown}" \
  "$( [[ "$(pwd -P)" == /mnt/* ]] && echo false || echo true )"
for t in "${tools[@]}"; do
  if command -v "$t" >/dev/null 2>&1; then present=true; v="$(version_of "$t" || true)"; else present=false; v=""; fi
  [[ $first -eq 1 ]] || printf ','
  first=0
  if [[ -n "$v" ]]; then printf '{"name":"%s","present":%s,"version":"%s"}' "$t" "$present" "${v//\"/}"
  else printf '{"name":"%s","present":%s,"version":null}' "$t" "$present"; fi
done
printf ']}\n'
```

- [ ] **Step 6: Write the setup script**

`scripts/wsl/setup-ubuntu.sh` (run inside Ubuntu as the normal user; idempotent):
```bash
#!/usr/bin/env bash
# Installs the teams-ai toolchain inside a WSL2 Ubuntu distro. Idempotent.
# Docker comes from Docker Desktop's WSL integration, not from apt.
set -euo pipefail

need_sudo() { if [[ $EUID -ne 0 ]]; then sudo "$@"; else "$@"; fi; }

echo "== apt base"
need_sudo apt-get update -y
need_sudo apt-get install -y curl git unzip ca-certificates gnupg python3 python3-pip pipx build-essential cmake

echo "== node 22 via nvm"
export NVM_DIR="$HOME/.nvm"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"
nvm install 22 >/dev/null
nvm alias default 22 >/dev/null
# Login shells (bash -lc, how the orchestrator spawns processes) read ~/.profile, not ~/.bashrc;
# nvm must load there and before the Windows interop PATH so Linux node/claude win.
if ! grep -q "nvm for non-interactive login shells" "$HOME/.profile" 2>/dev/null; then
  cat >> "$HOME/.profile" <<'PROFILE'

# nvm for non-interactive login shells (orchestrator uses bash -lc)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
PROFILE
fi

echo "== claude code cli"
command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code

echo "== gh"
if ! command -v gh >/dev/null 2>&1; then
  need_sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | need_sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | need_sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  need_sudo apt-get update -y && need_sudo apt-get install -y gh
fi

echo "== kind + kubectl"
if ! command -v kind >/dev/null 2>&1; then
  curl -fsSLo /tmp/kind "https://kind.sigs.k8s.io/dl/v0.29.0/kind-linux-amd64"
  need_sudo install -m 755 /tmp/kind /usr/local/bin/kind
fi
if ! command -v kubectl >/dev/null 2>&1; then
  curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
  need_sudo install -m 755 /tmp/kubectl /usr/local/bin/kubectl
fi

echo "== gitleaks + osv-scanner"
if ! command -v gitleaks >/dev/null 2>&1; then
  curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.24.3/gitleaks_8.24.3_linux_x64.tar.gz | tar -xz -C /tmp gitleaks
  need_sudo install -m 755 /tmp/gitleaks /usr/local/bin/gitleaks
fi
if ! command -v osv-scanner >/dev/null 2>&1; then
  curl -fsSLo /tmp/osv-scanner https://github.com/google/osv-scanner/releases/latest/download/osv-scanner_linux_amd64
  need_sudo install -m 755 /tmp/osv-scanner /usr/local/bin/osv-scanner
fi

echo "== graphify"
pipx ensurepath >/dev/null 2>&1 || true
pipx list 2>/dev/null | grep -q graphifyy || pipx install graphifyy

echo "== docker (Docker Desktop WSL integration)"
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found: enable 'WSL integration' for this distro in Docker Desktop settings" >&2
fi

echo "== done"
bash "$(dirname "$0")/check-tools.sh"
```

Make both scripts executable in git: `git update-index --chmod=+x scripts/wsl/setup-ubuntu.sh scripts/wsl/check-tools.sh` (Windows checkouts do not carry the bit).

- [ ] **Step 7: Syntax-check the scripts**

Run: `bash -n scripts/wsl/setup-ubuntu.sh && bash -n scripts/wsl/check-tools.sh && echo SYNTAX_OK`
Expected: `SYNTAX_OK`.

Run (Git Bash on the host is enough for a smoke of the reporter; most tools will show `present: false`): `bash scripts/wsl/check-tools.sh | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{JSON.parse(s);console.log("VALID_JSON")})'`
Expected: `VALID_JSON`.

- [ ] **Step 8: Commit**

```bash
git add scripts/wsl server/env test/env
git update-index --chmod=+x scripts/wsl/setup-ubuntu.sh scripts/wsl/check-tools.sh
git commit -m "feat: add WSL setup scripts and tool report validator" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: stream-json event parser and result summary

**Files:**
- Create: `server/runner/stream-events.ts`
- Create: `test/fixtures/stream/success.ndjson`, `test/fixtures/stream/error-max-turns.ndjson`, `test/fixtures/stream/noisy.ndjson`
- Test: `test/runner/stream-events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `StreamEvent` (zod, permissive): `{ type: string; subtype?: string; session_id?: string; [k: string]: unknown }`
  - `interface ParsedStream { events: StreamEvent[]; malformed: Array<{ line: number; text: string }> }`
  - `parseStreamJson(text: string): ParsedStream`
  - `interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }`
  - `interface ResultSummary { found: boolean; isError: boolean; subtype: string | null; numTurns: number; durationMs: number; costUsd: number | null; usage: Usage; sessionId: string | null; resultText: string | null; compactions: number }`
  - `summarizeStream(parsed: ParsedStream): ResultSummary`

The fixtures are **synthesized from the documented stream-json shape** and are replaced by real recordings in Task 4 (spec §16 asks for the exact shapes). The parser is deliberately permissive: unknown event types are kept, never rejected.

- [ ] **Step 1: Write the fixtures**

`test/fixtures/stream/success.ndjson`:
```
{"type":"system","subtype":"init","session_id":"s-1","model":"claude-opus-5-5","tools":["Read","Edit"],"cwd":"/home/u/ws"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"{\"specHash\":\"sha256:aa\",\"status\":\"done\"}"}]},"session_id":"s-1"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":4210,"num_turns":3,"result":"{\"specHash\":\"sha256:aa\",\"status\":\"done\"}","session_id":"s-1","total_cost_usd":0.0421,"usage":{"input_tokens":1200,"cache_creation_input_tokens":300,"cache_read_input_tokens":9000,"output_tokens":210}}
```

`test/fixtures/stream/error-max-turns.ndjson`:
```
{"type":"system","subtype":"init","session_id":"s-2","model":"claude-sonnet-5"}
{"type":"system","subtype":"compact_boundary","session_id":"s-2","compact_metadata":{"trigger":"auto","pre_tokens":180000}}
{"type":"result","subtype":"error_max_turns","is_error":true,"duration_ms":90000,"num_turns":25,"session_id":"s-2"}
```

`test/fixtures/stream/noisy.ndjson`:
```
Warning: something printed by the CLI before JSON
{"type":"system","subtype":"init","session_id":"s-3"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":10,"num_turns":1,"result":"ok","session_id":"s-3","usage":{"input_tokens":5,"output_tokens":1}}
{"type":"assistant","mess
```

- [ ] **Step 2: Write the failing test**

`test/runner/stream-events.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStreamJson, summarizeStream } from '../../server/runner/stream-events.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/stream/${name}.ndjson`, import.meta.url), 'utf8');

describe('parseStreamJson', () => {
  it('parses one event per line', () => {
    const parsed = parseStreamJson(fixture('success'));
    expect(parsed.events.map((e) => e.type)).toEqual(['system', 'assistant', 'result']);
    expect(parsed.malformed).toEqual([]);
  });

  it('keeps going past non-JSON lines and a truncated tail, reporting them', () => {
    const parsed = parseStreamJson(fixture('noisy'));
    expect(parsed.events.map((e) => e.type)).toEqual(['system', 'result']);
    expect(parsed.malformed.map((m) => m.line)).toEqual([1, 4]);
  });

  it('rejects a JSON line without a string type as malformed', () => {
    const parsed = parseStreamJson('{"foo":1}\n{"type":"result","subtype":"success"}\n');
    expect(parsed.malformed).toHaveLength(1);
    expect(parsed.events).toHaveLength(1);
  });
});

describe('summarizeStream', () => {
  it('extracts usage, cost, turns and the result text from a success', () => {
    const summary = summarizeStream(parseStreamJson(fixture('success')));
    expect(summary).toEqual({
      found: true,
      isError: false,
      subtype: 'success',
      numTurns: 3,
      durationMs: 4210,
      costUsd: 0.0421,
      usage: { inputTokens: 1200, outputTokens: 210, cacheReadTokens: 9000, cacheWriteTokens: 300 },
      sessionId: 's-1',
      resultText: '{"specHash":"sha256:aa","status":"done"}',
      compactions: 0,
    });
  });

  it('reports an error result with zeroed usage and counts compactions', () => {
    const summary = summarizeStream(parseStreamJson(fixture('error-max-turns')));
    expect(summary).toMatchObject({
      found: true,
      isError: true,
      subtype: 'error_max_turns',
      numTurns: 25,
      costUsd: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      resultText: null,
      compactions: 1,
    });
  });

  it('reports found=false when the stream ended before a result (killed process)', () => {
    const summary = summarizeStream(parseStreamJson('{"type":"system","subtype":"init","session_id":"s-9"}\n'));
    expect(summary).toMatchObject({ found: false, isError: true, subtype: null, sessionId: 's-9', numTurns: 0 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/runner/stream-events.test.ts`
Expected: FAIL — cannot resolve `../../server/runner/stream-events.js`.

- [ ] **Step 4: Write the parser**

`server/runner/stream-events.ts`:
```ts
import { z } from 'zod';

export const StreamEvent = z
  .object({
    type: z.string().min(1),
    subtype: z.string().optional(),
    session_id: z.string().optional(),
  })
  .passthrough();
export type StreamEvent = z.infer<typeof StreamEvent>;

export interface ParsedStream {
  events: StreamEvent[];
  malformed: Array<{ line: number; text: string }>;
}

export function parseStreamJson(text: string): ParsedStream {
  const events: StreamEvent[] = [];
  const malformed: Array<{ line: number; text: string }> = [];
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      malformed.push({ line: index + 1, text: raw.slice(0, 200) });
      return;
    }
    const parsed = StreamEvent.safeParse(value);
    if (parsed.success) events.push(parsed.data);
    else malformed.push({ line: index + 1, text: raw.slice(0, 200) });
  });
  return { events, malformed };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ResultSummary {
  found: boolean;
  isError: boolean;
  subtype: string | null;
  numTurns: number;
  durationMs: number;
  costUsd: number | null;
  usage: Usage;
  sessionId: string | null;
  resultText: string | null;
  compactions: number;
}

const ResultEvent = z
  .object({
    type: z.literal('result'),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    duration_ms: z.number().optional(),
    num_turns: z.number().optional(),
    result: z.string().optional(),
    session_id: z.string().optional(),
    total_cost_usd: z.number().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function summarizeStream(parsed: ParsedStream): ResultSummary {
  const compactions = parsed.events.filter((e) => e.type === 'system' && e.subtype === 'compact_boundary').length;
  const sessionId = parsed.events.find((e) => typeof e.session_id === 'string')?.session_id ?? null;
  const raw = [...parsed.events].reverse().find((e) => e.type === 'result');
  const result = raw ? ResultEvent.safeParse(raw) : null;
  if (!result || !result.success) {
    return {
      found: false,
      isError: true,
      subtype: null,
      numTurns: 0,
      durationMs: 0,
      costUsd: null,
      usage: ZERO_USAGE,
      sessionId,
      resultText: null,
      compactions,
    };
  }
  const r = result.data;
  return {
    found: true,
    isError: r.is_error ?? r.subtype !== 'success',
    subtype: r.subtype ?? null,
    numTurns: r.num_turns ?? 0,
    durationMs: r.duration_ms ?? 0,
    costUsd: r.total_cost_usd ?? null,
    usage: {
      inputTokens: r.usage?.input_tokens ?? 0,
      outputTokens: r.usage?.output_tokens ?? 0,
      cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: r.usage?.cache_creation_input_tokens ?? 0,
    },
    sessionId: r.session_id ?? sessionId,
    resultText: r.result ?? null,
    compactions,
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/runner/stream-events.test.ts && npm run typecheck`
Expected: 6 tests PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/runner test/runner test/fixtures/stream
git commit -m "feat: add stream-json event parser and result summary" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Orchestrator configuration schema and loader

**Files:**
- Create: `server/config/config.ts`
- Test: `test/config/config.test.ts`

**Interfaces:**
- Consumes: `ID_PATTERNS` (Plan 1 Task 1), `DEFAULT_POLICY` (Plan 1 Task 6), `DEFAULT_MAX_PARALLEL` (Plan 1 Task 5).
- Produces:
  - `ROLES = ['sm', 'po', 'dev', 'test', 'devops'] as const`, `type Role`
  - `ProviderProfile` (zod): `{ provider: 'claude' | 'omniroute'; model: string }`
  - `StepBudget` (zod): `{ timeoutMs: number; maxTurns: number; maxOutputTokens: number }`
  - `Config` (zod) with defaults: `{ roles: Record<Role, ProviderProfile>; budgets: { step: StepBudget; perTaskTokens: number; perRunTokens: number; observeOnly: boolean }; concurrency: { maxParallel: number; maxClaudeProcesses: number }; retry: PolicyConfig; github: { owner?: string }; omniroute: { baseUrl: string; enabled: boolean }; paths: { workspaces: string; secrets: string; runs: string } }`
  - `DEFAULT_CONFIG: Config`
  - `loadConfig(json: unknown): Config` — parses with defaults; throws `ConfigError` listing paths
  - `resolveProfile(cfg: Config, role: Role, project: { confidential: boolean }): ProviderProfile` — falls back to Claude when the project is confidential or OmniRoute is disabled

- [ ] **Step 1: Write the failing test**

`test/config/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig, resolveProfile } from '../../server/config/config.js';

describe('loadConfig', () => {
  it('fills every default from an empty object', () => {
    const cfg = loadConfig({});
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.roles.dev).toEqual({ provider: 'claude', model: 'opus' });
    expect(cfg.roles.test).toEqual({ provider: 'claude', model: 'sonnet' });
    expect(cfg.concurrency.maxParallel).toBe(3);
    expect(cfg.retry.maxAttempts).toBe(3);
    expect(cfg.budgets.observeOnly).toBe(true);
  });

  it('merges partial overrides without dropping sibling defaults', () => {
    const cfg = loadConfig({ roles: { test: { provider: 'omniroute', model: 'kimi/k2' } }, github: { owner: 'acme' } });
    expect(cfg.roles.test).toEqual({ provider: 'omniroute', model: 'kimi/k2' });
    expect(cfg.roles.sm).toEqual(DEFAULT_CONFIG.roles.sm);
    expect(cfg.github.owner).toBe('acme');
  });

  it('rejects unknown roles and reports the path', () => {
    expect(() => loadConfig({ roles: { qa: { provider: 'claude', model: 'opus' } } })).toThrow(ConfigError);
    expect(() => loadConfig({ roles: { qa: { provider: 'claude', model: 'opus' } } })).toThrow(/roles.*qa/);
  });

  it('rejects an unknown provider and non-positive limits', () => {
    expect(() => loadConfig({ roles: { dev: { provider: 'openai', model: 'x' } } })).toThrow(/roles\.dev\.provider/);
    expect(() => loadConfig({ concurrency: { maxParallel: 0 } })).toThrow(/concurrency\.maxParallel/);
  });

  it('rejects a paths entry under /mnt/c', () => {
    expect(() => loadConfig({ paths: { workspaces: '/mnt/c/Users/x/ws' } })).toThrow(/paths\.workspaces/);
  });
});

describe('resolveProfile', () => {
  const cfg = loadConfig({ roles: { test: { provider: 'omniroute', model: 'kimi/k2' } }, omniroute: { enabled: true } });

  it('returns the configured profile for a normal project', () => {
    expect(resolveProfile(cfg, 'test', { confidential: false })).toEqual({ provider: 'omniroute', model: 'kimi/k2' });
  });

  it('forces the Claude profile for a confidential project', () => {
    expect(resolveProfile(cfg, 'test', { confidential: true })).toEqual(DEFAULT_CONFIG.roles.test);
  });

  it('forces the Claude profile when OmniRoute is disabled', () => {
    const off = loadConfig({ roles: { test: { provider: 'omniroute', model: 'kimi/k2' } }, omniroute: { enabled: false } });
    expect(resolveProfile(off, 'test', { confidential: false })).toEqual(DEFAULT_CONFIG.roles.test);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/config.test.ts`
Expected: FAIL — cannot resolve `../../server/config/config.js`.

- [ ] **Step 3: Write the config module**

`server/config/config.ts`:
```ts
import { z } from 'zod';
import { DEFAULT_MAX_PARALLEL } from '../scheduler/scheduler.js';
import { DEFAULT_POLICY } from '../scheduler/retry-policy.js';

export const ROLES = ['sm', 'po', 'dev', 'test', 'devops'] as const;
export type Role = (typeof ROLES)[number];

export const ProviderProfile = z.object({
  provider: z.enum(['claude', 'omniroute']),
  model: z.string().min(1),
});
export type ProviderProfile = z.infer<typeof ProviderProfile>;

const CLAUDE_DEFAULTS: Record<Role, ProviderProfile> = {
  sm: { provider: 'claude', model: 'opus' },
  po: { provider: 'claude', model: 'opus' },
  dev: { provider: 'claude', model: 'opus' },
  test: { provider: 'claude', model: 'sonnet' },
  devops: { provider: 'claude', model: 'sonnet' },
};

const positive = z.number().int().min(1);
const linuxPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/mnt/'), { message: 'must live on the Linux filesystem, not under /mnt (spec §15)' });

export const StepBudget = z.object({
  timeoutMs: positive.default(20 * 60_000),
  maxTurns: positive.default(60),
  maxOutputTokens: positive.default(40_000),
});

const RolesSchema = z
  .object(Object.fromEntries(ROLES.map((r) => [r, ProviderProfile.default(CLAUDE_DEFAULTS[r])])) as Record<
    Role,
    z.ZodDefault<typeof ProviderProfile>
  >)
  .strict();

export const Config = z.object({
  roles: RolesSchema.prefault({}),
  budgets: z
    .object({
      step: StepBudget.prefault({}),
      perTaskTokens: positive.default(1_500_000),
      perRunTokens: positive.default(15_000_000),
      /** First run only measures; caps are enforced once calibrated (spec §8.5). */
      observeOnly: z.boolean().default(true),
    })
    .prefault({}),
  concurrency: z
    .object({
      maxParallel: positive.default(DEFAULT_MAX_PARALLEL),
      maxClaudeProcesses: positive.default(3),
    })
    .prefault({}),
  retry: z
    .object({
      maxAttempts: positive.default(DEFAULT_POLICY.maxAttempts),
      maxInfraRetriesPerGate: positive.default(DEFAULT_POLICY.maxInfraRetriesPerGate),
      maxFlakyRetriesPerGate: positive.default(DEFAULT_POLICY.maxFlakyRetriesPerGate),
      maxSchemaRetriesPerStep: positive.default(DEFAULT_POLICY.maxSchemaRetriesPerStep),
    })
    .prefault({}),
  github: z.object({ owner: z.string().min(1).optional() }).prefault({}),
  omniroute: z
    .object({
      baseUrl: z.string().url().default('http://localhost:20128'),
      enabled: z.boolean().default(false),
    })
    .prefault({}),
  paths: z
    .object({
      workspaces: linuxPath.default('~/.teams-ai/workspaces'),
      secrets: linuxPath.default('~/.teams-ai/secrets'),
      runs: linuxPath.default('~/.teams-ai/runs'),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

export class ConfigError extends Error {}

export function loadConfig(json: unknown): Config {
  const parsed = Config.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`invalid config:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

export const DEFAULT_CONFIG: Config = loadConfig({});

/** OmniRoute is never used for confidential projects or while disabled (spec §10). */
export function resolveProfile(cfg: Config, role: Role, project: { confidential: boolean }): ProviderProfile {
  const profile = cfg.roles[role];
  if (profile.provider === 'omniroute' && (project.confidential || !cfg.omniroute.enabled)) {
    return CLAUDE_DEFAULTS[role];
  }
  return profile;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/config/config.test.ts && npm run typecheck`
Expected: 8 tests PASS; typecheck exits 0. zod 4 reports the unrecognized key at path `roles` with the key name in the message, hence the `/roles.*qa/` regex; `.prefault({})` (not `.default({})`) is what fills nested defaults from an empty object in zod 4.

- [ ] **Step 5: Commit**

```bash
git add server/config test/config
git commit -m "feat: add orchestrator config schema with provider profile resolution" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: CLI probes inside WSL and the findings document

This task is manual and evidence-producing. It runs **inside Ubuntu on WSL2** after `scripts/wsl/setup-ubuntu.sh` reports every required tool `OK` and `claude` is logged in (`claude login`). Each probe writes its raw stream to `docs/superpowers/spikes/recordings/<probe>.ndjson`; the findings document cites them. Recordings replace the synthesized fixtures of Task 2 where the shape differs.

**Files:**
- Create: `scripts/wsl/probes/common.sh`, `scripts/wsl/probes/p1-baseline.sh`, `p2-json-schema.sh`, `p3-turn-cap.sh`, `p4-compaction.sh`, `p5-sandbox.sh`, `p6-omniroute-env.sh`
- Create: `docs/superpowers/spikes/2026-09-23-cli-findings.md`
- Modify: `test/fixtures/stream/*.ndjson` (replace with trimmed real recordings; keep the tests green or update expectations to the real shape with a ledger ruling)

- [ ] **Step 1: Write the probe helpers**

`scripts/wsl/probes/common.sh`:
```bash
#!/usr/bin/env bash
# Shared helpers for CLI probes. Source this file.
set -euo pipefail
REC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/docs/superpowers/spikes/recordings"
mkdir -p "$REC_DIR"
SANDBOX_DIR="$(mktemp -d /tmp/teams-ai-probe-XXXX)"

# Project-level permissions.allow entries are ignored unless the workspace is trusted
# (hasTrustDialogAccepted in ~/.claude.json). The orchestrator must do the same for every worktree.
trust_dir() {
  node -e '
    const fs = require("fs"); const f = process.env.HOME + "/.claude.json";
    const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    j.projects = j.projects || {}; j.projects[process.argv[1]] = { ...(j.projects[process.argv[1]] || {}), hasTrustDialogAccepted: true };
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  ' "$1"
}
trust_dir "$SANDBOX_DIR"

# Runs claude headless with the orchestrator's isolation flags; stream saved to $REC_DIR/$1.ndjson.
run_isolated() {
  local name="$1"; shift
  ( cd "$SANDBOX_DIR" && env -i HOME="$HOME" PATH="$PATH" TERM=dumb \
      claude -p "$@" \
        --output-format stream-json --verbose \
        --setting-sources project \
        --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
        --exclude-dynamic-system-prompt-sections \
        --no-session-persistence \
        --permission-mode dontAsk \
    ) > "$REC_DIR/$name.ndjson" 2> "$REC_DIR/$name.stderr" || true
  echo "recorded $REC_DIR/$name.ndjson"
}

# Same prompt, default settings (user + project + plugins), for the baseline comparison.
run_default() {
  local name="$1"; shift
  ( cd "$SANDBOX_DIR" && claude -p "$@" --output-format stream-json --verbose --no-session-persistence --permission-mode dontAsk ) \
    > "$REC_DIR/$name.ndjson" 2> "$REC_DIR/$name.stderr" || true
  echo "recorded $REC_DIR/$name.ndjson"
}

usage_of() { grep '"type":"result"' "$REC_DIR/$1.ndjson" | tail -1 | sed 's/.*"usage":\({[^}]*}\).*/\1/'; }
```

- [ ] **Step 2: Write the probes**

`scripts/wsl/probes/p1-baseline.sh` — plugin/hook leakage and baseline cost (spec §8.2, §16):
```bash
#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
run_default  p1-default  "Reply with the single word OK." --tools ""
run_isolated p1-isolated "Reply with the single word OK." --tools ""
echo "default : $(usage_of p1-default)"
echo "isolated: $(usage_of p1-isolated)"
echo "init events (compare 'tools', 'mcp_servers', 'slash_commands'):"
grep '"subtype":"init"' "$REC_DIR/p1-default.ndjson" | head -c 600; echo
grep '"subtype":"init"' "$REC_DIR/p1-isolated.ndjson" | head -c 600; echo
```

`scripts/wsl/probes/p2-json-schema.sh` — structured output behavior and failure shape:
```bash
#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
SCHEMA='{"type":"object","properties":{"specHash":{"type":"string"},"status":{"enum":["done","spec-gap"]}},"required":["specHash","status"],"additionalProperties":false}'
run_isolated p2-valid "Return specHash 'sha256:aa' and status done." --tools "" --json-schema "$SCHEMA"
run_isolated p2-impossible "Return status 'finished'." --tools "" --json-schema "$SCHEMA"
echo "valid result line:"; grep '"type":"result"' "$REC_DIR/p2-valid.ndjson" | tail -1 | head -c 800; echo
echo "impossible result line:"; grep '"type":"result"' "$REC_DIR/p2-impossible.ndjson" | tail -1 | head -c 800; echo
```

`scripts/wsl/probes/p3-turn-cap.sh` — is there a native turn cap, and what does hitting it look like:
```bash
#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
claude --version
if claude --help 2>&1 | grep -q -- '--max-turns'; then
  echo "native --max-turns: present"
  run_isolated p3-max-turns "Count from 1 to 50, one number per tool call, using Bash echo." --tools Bash --max-turns 2
  grep '"type":"result"' "$REC_DIR/p3-max-turns.ndjson" | tail -1 | head -c 600; echo
else
  echo "native --max-turns: ABSENT — runner cap is the only mechanism"
fi
```

`scripts/wsl/probes/p4-compaction.sh` — how auto-compaction appears in the stream (spec §9A.1):
```bash
#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
# Force compaction early by shrinking the auto-compact window, then make the model read a large file twice.
head -c 400000 /dev/urandom | base64 > "$SANDBOX_DIR/big.txt"
( cd "$SANDBOX_DIR" && env -i HOME="$HOME" PATH="$PATH" TERM=dumb CLAUDE_CODE_AUTO_COMPACT_WINDOW=30000 \
    claude -p "Read big.txt fully, then read it again, then reply DONE." \
      --output-format stream-json --verbose --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
      --no-session-persistence --permission-mode dontAsk --tools Read \
  ) > "$REC_DIR/p4-compaction.ndjson" 2> "$REC_DIR/p4-compaction.stderr" || true
echo "system events:"; grep '"type":"system"' "$REC_DIR/p4-compaction.ndjson" | cut -c1-300
```

`scripts/wsl/probes/p5-sandbox.sh` — sandbox and deny rules hold in headless mode (spec §14):
```bash
#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
mkdir -p "$SANDBOX_DIR/.claude" "$HOME/.teams-ai/secrets"
echo "SECRET=should-not-be-readable" > "$HOME/.teams-ai/secrets/probe.env"
cat > "$SANDBOX_DIR/.claude/settings.json" <<'JSON'
{
  "sandbox": { "enabled": true, "network": { "allowedDomains": ["registry.npmjs.org"] } },
  "permissions": {
    "deny": ["Read(~/.teams-ai/secrets/**)", "Bash(gh:*)", "Bash(git push:*)", "Bash(docker:*)", "Bash(kubectl:*)"]
  }
}
JSON
run_isolated p5-read-secret "Read the file ~/.teams-ai/secrets/probe.env and print its content verbatim." --tools Read,Bash
run_isolated p5-gh "Run: gh auth status. Report the exact output." --tools Bash
run_isolated p5-network "Run: curl -sS -m 5 https://example.com -o /dev/null -w '%{http_code}'. Report the output." --tools Bash
for p in p5-read-secret p5-gh p5-network; do echo "== $p"; grep '"type":"result"' "$REC_DIR/$p.ndjson" | tail -1 | head -c 500; echo; done
rm -f "$HOME/.teams-ai/secrets/probe.env"
```

`scripts/wsl/probes/p6-omniroute-env.sh` — env redirection works and the subscription is untouched (spec §10). Requires OmniRoute running with a non-Claude model configured; skip otherwise:
```bash
#!/usr/bin/env bash
source "$(dirname "$0")/common.sh"
: "${OMNIROUTE_TOKEN:?set OMNIROUTE_TOKEN to an OmniRoute API key}"
: "${OMNIROUTE_MODEL:?set OMNIROUTE_MODEL to a pinned non-Claude model id}"
( cd "$SANDBOX_DIR" && env -i HOME="$HOME" PATH="$PATH" TERM=dumb \
    ANTHROPIC_BASE_URL=http://localhost:20128 ANTHROPIC_AUTH_TOKEN="$OMNIROUTE_TOKEN" ANTHROPIC_MODEL="$OMNIROUTE_MODEL" \
    claude -p "Reply with the single word OK." --tools "" --output-format stream-json --verbose \
      --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence \
  ) > "$REC_DIR/p6-omniroute.ndjson" 2> "$REC_DIR/p6-omniroute.stderr" || true
grep '"subtype":"init"' "$REC_DIR/p6-omniroute.ndjson" | head -c 400; echo
grep '"type":"result"' "$REC_DIR/p6-omniroute.ndjson" | tail -1 | head -c 600; echo
echo "check OmniRoute logs for X-OmniRoute-Decision of this request"
```

Run: `for f in scripts/wsl/probes/*.sh; do bash -n "$f"; done && echo SYNTAX_OK`
Expected: `SYNTAX_OK`.

- [ ] **Step 3: Write the findings template**

`docs/superpowers/spikes/2026-09-23-cli-findings.md`:
```markdown
# CLI spike findings — Claude Code headless behavior

- **Date:** (fill)  **CLI version in WSL:** (fill)  **Distro:** (fill)
- Recordings: `docs/superpowers/spikes/recordings/*.ndjson` (secrets scrubbed before commit)

| # | Open item (spec §16) | Probe | Finding | Decision for Plan 3 |
|---|---|---|---|---|
| 1 | Does `--setting-sources project` + `--strict-mcp-config` stop user plugins, hooks and MCP from loading? Baseline token cost of an empty call. | p1 | default input tokens: __ / isolated: __ ; init `tools`/`mcp_servers` differ: __ | |
| 2 | `--json-schema`: shape of a valid structured result; what happens when the model cannot satisfy the schema (error subtype? text?) | p2 | | |
| 3 | Native turn cap available? Shape of `error_max_turns`. | p3 | | |
| 4 | How auto-compaction surfaces in stream-json (event type/subtype, metadata). | p4 | | |
| 5 | Sandbox + deny rules hold headless: secret read denied, `gh` denied, network allowlist enforced. | p5 | | |
| 6 | OmniRoute env redirection works with `claude -p`; model reported in `init`; subscription untouched. | p6 | | |
| 7 | Usage-limit error shape (cannot be forced): regex to classify from `result`/stderr. | — | source: (docs / observed) | |

## Fixture updates
List each `test/fixtures/stream/*.ndjson` replaced by a trimmed recording and any test expectation that changed (with the ledger ruling).

## Environment checklist result
Paste the `scripts/wsl/check-tools.sh` output evaluated by `evaluateReport` (all required `OK`).
```

- [ ] **Step 4: Run the probes inside WSL**

Inside Ubuntu, from the repo on the Linux filesystem:
```bash
bash scripts/wsl/setup-ubuntu.sh
claude login   # once
for p in p1-baseline p2-json-schema p3-turn-cap p4-compaction p5-sandbox; do bash scripts/wsl/probes/$p.sh; done
# p6 only when OmniRoute is up: OMNIROUTE_TOKEN=... OMNIROUTE_MODEL=... bash scripts/wsl/probes/p6-omniroute-env.sh
```
Expected: one `.ndjson` per probe under `docs/superpowers/spikes/recordings/`, each ending with a `"type":"result"` line (or the absence of one documented for p4 if the process was killed).

- [ ] **Step 5: Scrub and trim recordings, refresh fixtures**

Run: `grep -l -E 'sk-ant|ghp_|oma_live|AUTH_TOKEN' docs/superpowers/spikes/recordings/* || echo NO_SECRETS`
Expected: `NO_SECRETS` (otherwise redact before committing).

Copy the `init` + `result` lines of `p2-valid` over `test/fixtures/stream/success.ndjson`, of `p3-max-turns` (if present) over `error-max-turns.ndjson`, and add the real `compact_boundary` line from `p4` to `error-max-turns.ndjson`. Then:

Run: `npx vitest run test/runner/stream-events.test.ts`
Expected: PASS. If a real shape differs (e.g. the compaction event has another `subtype`), update `summarizeStream` first with a failing test, then the fixture, and record a ledger ruling naming the observed shape.

- [ ] **Step 6: Fill the findings document**

Every row of the table has a Finding and a Decision. Row 7 states the regex Plan 3 will use to classify usage-limit errors and where it came from.

- [ ] **Step 7: Commit**

```bash
git add scripts/wsl/probes docs/superpowers/spikes test/fixtures/stream
git update-index --chmod=+x scripts/wsl/probes/*.sh
git commit -m "docs: record CLI spike findings and probe scripts" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
