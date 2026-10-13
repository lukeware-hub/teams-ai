import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OUTPUT_SCHEMAS, toJsonSchema, type OutputOf, type StepKind } from '../agents/outputs.js';
import type { AgentDefinition } from '../agents/registry.js';
import { ALWAYS_DENIED, NESTED_DENIED } from '../agents/registry.js';
import type { Accounting } from '../budget/accounting.js';
import type { RoleProfile, Role } from '../config/config.js';
import type { Effort } from '../decide/decisions/model-tier.js';
import type { CliErrorInput } from '../decide/decisions/cli-error.js';
import type { FailureKind } from '../scheduler/retry-policy.js';
import { validateAgentOutput } from '../validators/agent-output.js';
import type { RefContext, References } from '../validators/references.js';
import { buildInvocation, ensureTrusted, PROMPT_CACHE_TTL } from './invocation.js';
import { sandboxPolicyViolation } from './sandbox-policy.js';
import { readTotals, restoreSession, saveSession, writeTotals } from './session-store.js';
import { API_KEY_ENV, createStepHome, hasStaticCredential, hostTokenExpiresAt, removeStepHome, syncBackCredentials } from './step-home.js';
import { preflightSandbox, runProcess, type ProcessCaps, type RawStepResult, type RunnerBinary } from './process-runner.js';
import { writeRoleSettings, type RoleSettingsInput } from './role-settings.js';
import { isRateLimitRejected, type ResultSummary } from './stream-events.js';
import { redactSecrets } from '../core/redact.js';

export interface StepRequest {
  kind: StepKind;
  role: Role;
  agent: AgentDefinition;
  profile: RoleProfile;
  model: string;
  cwd: string;
  prompt: string;
  expectedSpecHash: string;
  /** Reference context for output validation; a thunk is resolved after the process exits, so files the agent wrote count. */
  refContext?: RefContext | (() => Promise<RefContext>);
  refs?: (value: never) => References;
  semantic?: ReadonlyArray<(value: never) => string[]>;
  phase: string;
  taskId: string | null;
  attempt: number;
  sessionId?: string;
  resume?: boolean;
  /** Directory that keeps this session's transcript between steps (see session-store.ts); with `resume`, it is restored into the step HOME first. */
  sessionStore?: string;
  /** Extra allow rules for this step's role settings (from the plan's commands). */
  extraAllow?: readonly string[];
  effort?: Effort;
  /** Env entries the orchestrator provisioned for this one step (e.g. an ephemeral test database's DATABASE_URL). */
  extraEnv?: Readonly<Record<string, string>>;
}

export type StepOutcome<T> =
  | { ok: true; value: T; summary: ResultSummary }
  | { ok: false; failure: FailureKind; errors: string[]; summary: ResultSummary; sandboxDisabled: boolean };

export interface StepDeps {
  binary: RunnerBinary;
  caps: ProcessCaps;
  accounting: Accounting;
  /** Unused since agent steps get their own HOME (trust is recorded in the step home); kept for callers. */
  claudeJsonPath?: string;
  /** Directory (outside any worktree) where per-role settings files are written. */
  settingsDir: string;
  /** Every step cwd must live under this directory; anything else is never trusted or run. */
  workspacesRoot: string;
  network: Pick<RoleSettingsInput, 'allowedDomains'>;
  /** Config `sandbox`; when disabled the bubblewrap/socat tool check is skipped as well. */
  sandbox?: { enabled: boolean; unsafeNoSandbox?: boolean };
  hostEnv?: NodeJS.ProcessEnv;
  /** Claude Console key for `claude.auth: "api-key"`; steps then log in with it instead of the copied subscription login. */
  apiKey?: string;
  onEvent?: (line: string) => void;
  /** Aborting kills the agent process (and its process group). */
  signal?: AbortSignal;
  clock?: () => Date;
  /** Spec 10A.5 decision 8: asked only when no deterministic rule matched (the `code` fallthrough). */
  classifyUnknown?: (input: CliErrorInput) => Promise<FailureKind>;
}

/** Tools a review step does not get, whatever its role may use elsewhere. */
const REVIEW_DENIED_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit'];

const QUOTA_TEXT = /usage limit|rate limit|out of .*quota/i;
const AUTH_TEXT = /not logged in|authentication|failed to authenticate|oauth session expired|could not be refreshed|invalid api key|please run (claude login|\/login)/i;

/**
 * Order follows spec §12 and the CLI findings: environment → timeout → compaction → (only for a
 * failed step) quota → auth → code. A successful result is never reclassified by its rate-limit
 * reading; that reading goes to the breaker separately.
 */
export function classifyFailure(raw: RawStepResult): FailureKind | null {
  const s = raw.summary;
  if (raw.sandboxDisabled || raw.killedBy === 'environment') return 'environment';
  if (raw.killedBy) return 'timeout';
  if (s.compactions > 0 || s.terminalReason === 'rapid_refill_breaker') return 'compaction';
  // The CLI's own turn cap is the same condition as the runner's cap (spec §12): one taxonomy.
  if (s.subtype === 'error_max_turns') return 'timeout';
  if (s.found && !s.isError) return null;
  const text = s.resultText ?? '';
  if (s.apiErrorStatus === 429) return 'quota';
  if (s.apiErrorStatus === 401 || s.apiErrorStatus === 403) return 'auth';
  if (s.apiErrorStatus === null) {
    if ((s.rateLimit && isRateLimitRejected(s.rateLimit.status)) || QUOTA_TEXT.test(text)) return 'quota';
    if (AUTH_TEXT.test(text)) return 'auth';
  }
  return 'code';
}

const EMPTY_SUMMARY: ResultSummary = {
  found: false,
  isError: true,
  subtype: null,
  numTurns: 0,
  durationMs: 0,
  costUsd: null,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null,
  resultText: null,
  structuredOutput: null,
  structuredSource: null,
  terminalReason: null,
  apiErrorStatus: null,
  rateLimit: null,
  compactions: 0,
};

/** True when `dir` is `root` or below it, comparing resolved real paths (symlinks, `..`, short names). */
async function isInside(root: string, dir: string): Promise<boolean> {
  let realRoot: string;
  let realDir: string;
  try {
    [realRoot, realDir] = await Promise.all([fs.realpath(root), fs.realpath(dir)]);
  } catch {
    return false;
  }
  const rel = path.relative(realRoot, realDir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function environmentFailure<T>(message: string): StepOutcome<T> {
  return { ok: false, failure: 'environment', errors: [message], summary: EMPTY_SUMMARY, sandboxDisabled: false };
}

export async function runStep<K extends StepKind>(req: StepRequest, deps: StepDeps): Promise<StepOutcome<OutputOf<K>>> {
  // An API key in the orchestrator's own environment is never forwarded: only the one the config chose (`deps.apiKey`) is.
  const { [API_KEY_ENV]: _stray, ...base } = deps.hostEnv ?? process.env;
  const hostEnv: NodeJS.ProcessEnv = deps.apiKey ? { ...base, [API_KEY_ENV]: deps.apiKey } : base;
  try {
    const stat = await fs.stat(req.cwd);
    if (!stat.isDirectory()) return environmentFailure(`cwd is not a directory: ${req.cwd}`);
  } catch {
    return environmentFailure(`cwd does not exist: ${req.cwd}`);
  }
  if (!(await isInside(deps.workspacesRoot, req.cwd))) {
    return environmentFailure(`cwd ${req.cwd} is outside the workspaces root ${deps.workspacesRoot}`);
  }
  const violation = sandboxPolicyViolation(deps.sandbox, hostEnv);
  if (violation) return environmentFailure(violation);
  if (deps.binary.requireSandboxTools && deps.sandbox?.enabled !== false) {
    const missing = await preflightSandbox(hostEnv);
    if (missing.length > 0) return environmentFailure(`sandbox tools missing on PATH: ${missing.join(', ')} (apt install bubblewrap socat)`);
  }

  const clock = deps.clock ?? (() => new Date());
  return withRefreshGate(hostEnv, clock, async () => {
    // A short path: the sandbox socket in $HOME/tmp must fit the 108 characters of a Unix socket path.
    const home = await createStepHome(path.join(os.tmpdir(), `th-${process.getuid?.() ?? 0}`), hostEnv);
    try {
      return await runStepIn(req, deps, hostEnv, home);
    } finally {
      await syncBackCredentials(home, hostEnv);
      if (req.sessionStore) await saveSession(home, req.sessionStore, req.cwd);
      await removeStepHome(home);
    }
  });
}

/**
 * The CLI leaves `structured_output` null when the agent answers in prose with the JSON in a fenced block (seen live in the
 * Phase 6 report). The JSON still goes through the same schema, specHash and reference validation, so taking it is safe;
 * text with no single JSON object stays a schema failure.
 */
export function jsonFromResultText(text: string | null): unknown {
  if (!text) return null;
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const candidate = (fenced ? fenced[1]! : text).trim();
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return null;
  try {
    const value: unknown = JSON.parse(candidate);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A stored token that expires within this window is refreshed by one step at a time. */
export const REFRESH_WINDOW_MS = 5 * 60_000;

let refreshTail: Promise<void> = Promise.resolve();

/**
 * Plan 38: the CLI refreshes an expired token inside its own step HOME and the server rotates the refresh token, so two steps that
 * start together on an expired token would each use the same (now stale) refresh token. While the host token is expired or within
 * REFRESH_WINDOW_MS of expiry, steps run one at a time through this per-process mutex (copy, run, write back); each waiter re-reads
 * the token after its turn, so once one step has refreshed it the rest run in parallel again. A fresh token (the normal case)
 * or CLAUDE_CODE_OAUTH_TOKEN never takes the lock.
 */
export async function withRefreshGate<T>(hostEnv: NodeJS.ProcessEnv, clock: () => Date, fn: () => Promise<T>): Promise<T> {
  if (hasStaticCredential(hostEnv)) return fn();
  const stale = async (): Promise<boolean> => {
    const at = await hostTokenExpiresAt(hostEnv);
    return at !== null && at - clock().getTime() < REFRESH_WINDOW_MS;
  };
  if (!(await stale())) return fn();
  const prev = refreshTail;
  let release: () => void = () => {};
  refreshTail = new Promise<void>((r) => (release = r));
  await prev;
  let released = false;
  try {
    if (!(await stale())) {
      release();
      released = true;
    }
    return await fn();
  } finally {
    if (!released) release();
  }
}

async function runStepIn<K extends StepKind>(req: StepRequest, deps: StepDeps, hostEnv: NodeJS.ProcessEnv, home: string): Promise<StepOutcome<OutputOf<K>>> {
  await ensureTrusted(req.cwd, path.join(home, '.claude.json'));
  const settingsPath = await writeRoleSettings(deps.settingsDir, req.role, { allowedDomains: deps.network.allowedDomains, extraAllow: req.extraAllow, sandboxEnabled: deps.sandbox?.enabled, hostHome: hostEnv.HOME });
  if (req.resume && req.sessionStore) await restoreSession(req.sessionStore, home);
  // A review judges a diff the gates already tested: it never edits the code under review (R11.13 slice 2).
  const agent = req.kind === 'review' ? { ...req.agent, tools: req.agent.tools.filter((t) => !REVIEW_DENIED_TOOLS.includes(t)) } : req.agent;
  const invocation = buildInvocation(
    {
      role: req.role,
      model: req.model,
      profile: req.profile,
      cwd: req.cwd,
      prompt: req.prompt,
      jsonSchema: toJsonSchema(req.kind),
      tools: agent.tools,
      disallowedTools: [...ALWAYS_DENIED, ...NESTED_DENIED],
      settingsPath,
      home,
      sessionId: req.sessionId,
      resume: req.resume,
      agentDefinition: agent,
      cacheTtl: PROMPT_CACHE_TTL,
      apiKey: deps.apiKey,
      effort: req.effort,
      extraEnv: req.extraEnv,
    },
    hostEnv,
  );

  let raw: RawStepResult;
  try {
    raw = await runProcess(deps.binary, invocation, deps.caps, deps.onEvent, deps.signal);
  } catch (err) {
    return environmentFailure(`spawn failed: ${(err as Error).message}`);
  }

  // `total_cost_usd` and `duration_api_ms` of a resumed session include the attempts before it: book only this step's share.
  if (req.sessionStore) {
    const before = req.resume ? await readTotals(req.sessionStore) : { costUsd: 0, durationApiMs: 0 };
    const s = raw.summary;
    await writeTotals(req.sessionStore, { costUsd: s.costUsd ?? before.costUsd, durationApiMs: s.profile?.durationApiMs ?? before.durationApiMs });
    if (s.costUsd !== null) s.costUsd = Math.max(0, Math.round((s.costUsd - before.costUsd) * 1e6) / 1e6);
    if (s.profile) s.profile = { ...s.profile, durationApiMs: Math.max(0, s.profile.durationApiMs - before.durationApiMs) };
  }

  deps.accounting.record({
    role: req.role,
    phase: req.phase,
    taskId: req.taskId,
    attempt: req.attempt,
    stepKind: req.kind,
    provider: 'claude',
    model: req.model,
    usage: raw.summary.usage,
    costUsd: raw.summary.costUsd,
    durationMs: raw.durationMs,
    numTurns: raw.summary.numTurns || raw.turns,
    at: (deps.clock ?? (() => new Date()))().toISOString(),
  });

  let failure = classifyFailure(raw);
  if (failure) {
    // Agent-controlled text and CLI stderr flow into the event store and UI: never with credentials.
    const message = redactSecrets(raw.summary.resultText ?? raw.stderr.slice(0, 500));
    if (failure === 'code' && deps.classifyUnknown) {
      const s = raw.summary;
      failure = await deps.classifyUnknown({
        resultText: s.resultText === null ? null : redactSecrets(s.resultText),
        stderr: redactSecrets(raw.stderr.slice(-2000)),
        apiErrorStatus: s.apiErrorStatus,
        subtype: s.subtype,
        terminalReason: s.terminalReason,
      });
    }
    return { ok: false, failure, errors: [message], summary: raw.summary, sandboxDisabled: raw.sandboxDisabled };
  }

  const schema = OUTPUT_SCHEMAS[req.kind];
  const validation = validateAgentOutput(schema, raw.summary.structuredOutput ?? jsonFromResultText(raw.summary.resultText), {
    expectedSpecHash: req.expectedSpecHash,
    refs: req.refs as ((value: { specHash: string }) => References) | undefined,
    refContext: typeof req.refContext === 'function' ? await req.refContext() : req.refContext,
    semantic: req.semantic as ReadonlyArray<(value: { specHash: string }) => string[]> | undefined,
  });
  if (!validation.ok) {
    const errors = [...validation.errors];
    if (raw.summary.structuredOutput === null) {
      // Without this the only trace of a prose-only answer is "expected object, received null".
        const text = redactSecrets((raw.summary.resultText ?? '').slice(0, 500));
      errors.push(`no JSON object in the agent result (subtype=${raw.summary.subtype ?? 'none'}, terminal=${raw.summary.terminalReason ?? 'none'}, turns=${raw.summary.numTurns}): ${text || '(empty)'}`);
    }
    return { ok: false, failure: 'schema', errors, summary: raw.summary, sandboxDisabled: false };
  }
  return { ok: true, value: validation.value as OutputOf<K>, summary: raw.summary };
}
