import { promises as fs } from 'node:fs';
import path from 'node:path';
import { OUTPUT_SCHEMAS, toJsonSchema, type OutputOf, type StepKind } from '../agents/outputs.js';
import type { AgentDefinition } from '../agents/registry.js';
import { ALWAYS_DENIED } from '../agents/registry.js';
import type { Accounting } from '../budget/accounting.js';
import type { ProviderProfile, Role } from '../config/config.js';
import type { Effort } from '../decide/decisions/model-tier.js';
import type { CliErrorInput } from '../decide/decisions/cli-error.js';
import type { FailureKind } from '../scheduler/retry-policy.js';
import { validateAgentOutput } from '../validators/agent-output.js';
import type { RefContext, References } from '../validators/references.js';
import { buildInvocation, ensureTrusted } from './invocation.js';
import { preflightSandbox, runProcess, type ProcessCaps, type RawStepResult, type RunnerBinary } from './process-runner.js';
import { writeRoleSettings, type RoleSettingsInput } from './role-settings.js';
import { isRateLimitRejected, type ResultSummary } from './stream-events.js';
import { redactSecrets } from '../core/redact.js';

export interface StepRequest {
  kind: StepKind;
  role: Role;
  agent: AgentDefinition;
  profile: ProviderProfile;
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
  omniroute?: { baseUrl: string; token: string; compactWindow?: number };
  /** Extra allow rules for this step's role settings (from the plan's commands). */
  extraAllow?: readonly string[];
  effort?: Effort;
}

export type StepOutcome<T> =
  | { ok: true; value: T; summary: ResultSummary }
  | { ok: false; failure: FailureKind; errors: string[]; summary: ResultSummary; sandboxDisabled: boolean };

export interface StepDeps {
  binary: RunnerBinary;
  caps: ProcessCaps;
  accounting: Accounting;
  claudeJsonPath: string;
  /** Directory (outside any worktree) where per-role settings files are written. */
  settingsDir: string;
  /** Every step cwd must live under this directory; anything else is never trusted or run. */
  workspacesRoot: string;
  network: Pick<RoleSettingsInput, 'allowedDomains'>;
  /** Config `sandbox`; when disabled the bubblewrap/socat tool check is skipped as well. */
  sandbox?: { enabled: boolean };
  hostEnv?: NodeJS.ProcessEnv;
  onEvent?: (line: string) => void;
  clock?: () => Date;
  /** Spec 10A.5 decision 8: asked only when no deterministic rule matched (the `code` fallthrough). */
  classifyUnknown?: (input: CliErrorInput) => Promise<FailureKind>;
}

const QUOTA_TEXT = /usage limit|rate limit|out of .*quota/i;
const AUTH_TEXT = /not logged in|authentication|invalid api key|please run claude login/i;

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
  const hostEnv = deps.hostEnv ?? process.env;
  try {
    const stat = await fs.stat(req.cwd);
    if (!stat.isDirectory()) return environmentFailure(`cwd is not a directory: ${req.cwd}`);
  } catch {
    return environmentFailure(`cwd does not exist: ${req.cwd}`);
  }
  if (!(await isInside(deps.workspacesRoot, req.cwd))) {
    return environmentFailure(`cwd ${req.cwd} is outside the workspaces root ${deps.workspacesRoot}`);
  }
  if (deps.binary.requireSandboxTools && deps.sandbox?.enabled !== false) {
    const missing = await preflightSandbox(hostEnv);
    if (missing.length > 0) return environmentFailure(`sandbox tools missing on PATH: ${missing.join(', ')} (apt install bubblewrap socat)`);
  }

  await ensureTrusted(req.cwd, deps.claudeJsonPath);
  const settingsPath = await writeRoleSettings(deps.settingsDir, req.role, { allowedDomains: deps.network.allowedDomains, extraAllow: req.extraAllow, sandboxEnabled: deps.sandbox?.enabled });
  const invocation = buildInvocation(
    {
      role: req.role,
      model: req.model,
      profile: req.profile,
      cwd: req.cwd,
      prompt: req.prompt,
      jsonSchema: toJsonSchema(req.kind),
      tools: req.agent.tools,
      disallowedTools: ALWAYS_DENIED,
      settingsPath,
      sessionId: req.sessionId,
      resume: req.resume,
      omniroute: req.omniroute,
      agentDefinition: req.agent,
      effort: req.effort,
    },
    hostEnv,
  );

  let raw: RawStepResult;
  try {
    raw = await runProcess(deps.binary, invocation, deps.caps, deps.onEvent);
  } catch (err) {
    return environmentFailure(`spawn failed: ${(err as Error).message}`);
  }

  deps.accounting.record({
    role: req.role,
    phase: req.phase,
    taskId: req.taskId,
    attempt: req.attempt,
    stepKind: req.kind,
    provider: req.profile.provider,
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
    const known = req.omniroute ? [req.omniroute.token] : [];
    const message = redactSecrets(raw.summary.resultText ?? raw.stderr.slice(0, 500), known);
    if (failure === 'code' && deps.classifyUnknown) {
      const s = raw.summary;
      failure = await deps.classifyUnknown({
        resultText: s.resultText === null ? null : redactSecrets(s.resultText, known),
        stderr: redactSecrets(raw.stderr.slice(-2000), known),
        apiErrorStatus: s.apiErrorStatus,
        subtype: s.subtype,
        terminalReason: s.terminalReason,
      });
    }
    return { ok: false, failure, errors: [message], summary: raw.summary, sandboxDisabled: raw.sandboxDisabled };
  }

  const schema = OUTPUT_SCHEMAS[req.kind];
  const validation = validateAgentOutput(schema, raw.summary.structuredOutput, {
    expectedSpecHash: req.expectedSpecHash,
    refs: req.refs as ((value: { specHash: string }) => References) | undefined,
    refContext: typeof req.refContext === 'function' ? await req.refContext() : req.refContext,
    semantic: req.semantic as ReadonlyArray<(value: { specHash: string }) => string[]> | undefined,
  });
  if (!validation.ok) {
    return { ok: false, failure: 'schema', errors: validation.errors, summary: raw.summary, sandboxDisabled: false };
  }
  return { ok: true, value: validation.value as OutputOf<K>, summary: raw.summary };
}
