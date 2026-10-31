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
import { FULL_ACCESS_TOOLS, absoluteRule, writeRoleSettings, type RoleSettingsInput } from './role-settings.js';
import { buildDynamicPlugin, referenceDirs } from '../skills/plugins.js';
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
  /** The owner lets this step decide: it gets the web tools and the permissions of `FULL_ACCESS_ALLOW`. */
  fullAccess?: boolean;
  /** Extra allow rules for this step's role settings (from the plan's commands). */
  extraAllow?: readonly string[];
  /** The step may search the web: the WebSearch tool only, never a fetch. The chat asks for it about a project that allows it. */
  webSearch?: boolean;
  /** Directories this step must not read (see `RoleSettingsInput.extraDenyRead`). */
  denyRead?: readonly string[];
  /** Directories this step must not write, to its tools or to any command (see `RoleSettingsInput.protectedDirs`). */
  protectedDirs?: readonly string[];
  /** Text added to the agent's own prompt for this step. The API caches that part, so what repeats from one step to the next is read from the cache instead of paid for again. */
  systemExtra?: string;
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
  /** Root of the installed skill plugins, one folder per role; the agent loads its role's folder natively. */
  agentPluginsRoot?: string;
  /** Cache of pinned skills and the project scope: the SM's reuses and drafts of this project become this step's plugin. */
  skillsRoot?: string;
  skillScope?: string;
  network: Pick<RoleSettingsInput, 'allowedDomains'>;
  /** Stacks the run's steps work on; their toolchain commands go to the Front, Dev and Test roles. */
  stacks?: RoleSettingsInput['stacks'];
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
/** Steps that answer with JSON and edit no file: refinement changes reach the docs only as patches the owner accepts. */
const READ_ONLY_KINDS: readonly string[] = ['review', 'ui-check', 'refine', 'suggest', 'block-options'];
/** What the chat step may use: read files in its working directory and run the graphify queries its settings allow. */
export const CHAT_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Bash'];
/** A search or two and the answer: a chat that loops is cut short instead of spending the step budget. */
export const CHAT_MAX_TURNS = 6;
/** The tools a kind gets whatever its role allows. */
const KIND_TOOLS: Partial<Record<StepKind, readonly string[]>> = { chat: CHAT_TOOLS };
/** The turn cap a kind has below its role's. */
const KIND_TURNS: Partial<Record<StepKind, number>> = { chat: CHAT_MAX_TURNS };
/** The only folders of its working directory a kind's file tools may write: a plan step writes its plan file, never the inputs or a CLAUDE.md. */
const KIND_WRITE_DIRS: Partial<Record<StepKind, readonly string[]>> = { speckit: ['docs/specs'] };
export const stepCaps = (kind: StepKind, caps: ProcessCaps): ProcessCaps => {
  const turns = KIND_TURNS[kind];
  return turns === undefined ? caps : { ...caps, maxTurns: Math.min(caps.maxTurns, turns) };
};

/** Longest rejected answer quoted in an error: the journal keeps it, the screen never shows it. */
const ANSWER_CHARS = 300;
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
  // A stop is not a timeout: the heal driver retries timeouts, and a stopped run must stay stopped.
  if (raw.killedBy === 'aborted') return 'aborted';
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

export const EMPTY_SUMMARY: ResultSummary = {
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
  return withRefreshGate(hostEnv, clock, deps.caps.timeoutMs + REFRESH_WINDOW_MS, async () => {
    let home: string | undefined;
    try {
      // A short path: the sandbox socket in $HOME/tmp must fit the 108 characters of a Unix socket path.
      home = await createStepHome(path.join(os.tmpdir(), `th-${process.getuid?.() ?? 0}`), hostEnv);
      if (deps.skillsRoot && deps.skillScope) await buildDynamicPlugin(deps.skillsRoot, deps.skillScope, req.role, dynamicPluginDir(home));
      return await runStepIn(req, deps, hostEnv, home);
    } catch (err) {
      // A throw outside the agent process (trust, settings, session restore) still ends the step with an outcome.
      return environmentFailure(`step failed outside the agent process: ${(err as Error).message}`);
    } finally {
      if (home) {
        await syncBackCredentials(home, hostEnv);
        if (req.sessionStore) await saveSession(home, req.sessionStore, req.cwd);
        await removeStepHome(home);
        await fs.rm(dynamicPluginDir(home), { recursive: true, force: true });
      }
    }
  });
}

/**
 * The CLI leaves `structured_output` null when the agent answers in prose with the JSON in a fenced block (seen live in the
 * Phase 6 report). The JSON still goes through the same schema, specHash and reference validation, so taking it is safe;
 * text with no single JSON object stays a schema failure.
 */
/** The candidate JSON of an answer given in prose: its fenced block, else the text from its first brace to its last one. */
function resultJsonCandidate(text: string | null): string {
  if (!text) return '';
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  // Prose before or after the object is tolerated: the candidate is the text from its first brace to its last one.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return fenced ? fenced[1]!.trim() : start === -1 || end < start ? '' : text.slice(start, end + 1);
}

export function jsonFromResultText(text: string | null): unknown {
  try {
    const value: unknown = JSON.parse(resultJsonCandidate(text));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Why the JSON of an answer given in prose does not parse; null when it parses. */
export function jsonParseError(text: string | null): string | null {
  try {
    JSON.parse(resultJsonCandidate(text));
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Margin on top of the step timeout: a stored token that expires within both is refreshed by one step at a time. */
export const REFRESH_WINDOW_MS = 5 * 60_000;

let refreshTail: Promise<void> = Promise.resolve();

/**
 * Plan 38: the CLI refreshes an expired token inside its own step HOME and the server rotates the refresh token, so two steps that
 * start together on an expired token would each use the same (now stale) refresh token. While the host token is expired or within
 * `windowMs` of expiry (the step timeout plus REFRESH_WINDOW_MS, since a step can refresh at any point of its run), steps run one at
 * a time through this per-process mutex (copy, run, write back); each waiter re-reads the token after its turn, so once one step has
 * refreshed it the rest run in parallel again. A fresh token (the normal case) or CLAUDE_CODE_OAUTH_TOKEN never takes the lock.
 */
export async function withRefreshGate<T>(hostEnv: NodeJS.ProcessEnv, clock: () => Date, windowMs: number, fn: () => Promise<T>): Promise<T> {
  if (hasStaticCredential(hostEnv)) return fn();
  const stale = async (): Promise<boolean> => {
    const at = await hostTokenExpiresAt(hostEnv);
    return at !== null && at - clock().getTime() < windowMs;
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

/**
 * `<workspaces>/<project>/secrets` of every project: a step reads no project's secrets, neither its own nor another's.
 * The wildcard covers a project created while the step runs; the listed ones cover a sandbox that expands paths when it starts.
 * A listing that fails ends the step: it never runs without the rule.
 */
async function projectSecretsDirs(workspacesRoot: string): Promise<string[]> {
  const projects = await fs.readdir(workspacesRoot);
  return [path.join(workspacesRoot, '*', 'secrets'), ...projects.map((project) => path.join(workspacesRoot, project, 'secrets'))];
}

/** `total_cost_usd` and `duration_api_ms` of a resumed session include the attempts before it: book only this step's share. Its `usage` is already this step's own. */
async function bookSessionShare(s: ResultSummary, store: string, resume: boolean): Promise<void> {
  // Without a result event the step reports only its own stream, never the session totals.
  if (!s.found) return;
  const before = resume ? await readTotals(store) : null;
  const apiMs = s.profile?.durationApiMs ?? 0;
  await writeTotals(store, { costUsd: s.costUsd ?? before?.costUsd ?? 0, durationApiMs: apiMs, usage: s.usage });
  if (!before) return;
  const costUsd = s.costUsd === null ? null : Math.round((s.costUsd - before.costUsd) * 1e6) / 1e6;
  if ((costUsd ?? 0) < 0 || apiMs < before.durationApiMs) {
    // The CLI started its totals over: the reported numbers are this step's own, and the journal says so.
    if (s.profile) s.profile = { ...s.profile, sessionTotalsReset: true };
    return;
  }
  s.costUsd = costUsd;
  if (s.profile) s.profile = { ...s.profile, durationApiMs: apiMs - before.durationApiMs };
}

/** This step's own plugin folder for the SM's reuses and drafts; a sibling of the step HOME, never inside it. */
const dynamicPluginDir = (home: string): string => `${home}-plugins`;

/** The plugin folders the step loads: the role's installed skills and, when the SM gave any, this step's own. */
async function stepPluginDirs(deps: StepDeps, role: Role, home: string): Promise<string[]> {
  const candidates = [deps.agentPluginsRoot ? path.join(deps.agentPluginsRoot, role) : undefined, dynamicPluginDir(home)];
  const present: string[] = [];
  for (const dir of candidates) if (dir && (await fs.access(dir).then(() => true, () => false))) present.push(dir);
  return present;
}

async function runStepIn<K extends StepKind>(req: StepRequest, deps: StepDeps, hostEnv: NodeJS.ProcessEnv, home: string): Promise<StepOutcome<OutputOf<K>>> {
  // The reference catalogs of the role are searched with Grep, never installed: the agent is told where they are.
  const refs = deps.skillsRoot ? referenceDirs(deps.skillsRoot, req.role) : [];
  await ensureTrusted(req.cwd, path.join(home, '.claude.json'));
  const writeDirs = KIND_WRITE_DIRS[req.kind]?.map((dir) => path.join(req.cwd, dir));
  // dontAsk denies a Read no rule allows, so a skill reads its own plugin files only through these rules.
  const pluginDirs = await stepPluginDirs(deps, req.role, home);
  const settingsPath = await writeRoleSettings(deps.settingsDir, req.role, { allowedDomains: deps.network.allowedDomains, stacks: deps.stacks, extraAllow: [...(req.extraAllow ?? []), ...(req.webSearch === true ? ['WebSearch'] : []), ...[...refs, ...pluginDirs].map((dir) => `Read(${absoluteRule(dir)}/**)`)], extraDenyRead: req.denyRead, protectedDirs: [deps.agentPluginsRoot, dynamicPluginDir(home), ...(req.protectedDirs ?? [])].filter((dir): dir is string => dir !== undefined), writeDirs, sandboxEnabled: deps.sandbox?.enabled, fullAccess: req.fullAccess, hostHome: hostEnv.HOME, stepHome: home, projectSecretsDirs: await projectSecretsDirs(deps.workspacesRoot) });
  if (req.resume && req.sessionStore) await restoreSession(req.sessionStore, home);
  // A review, a UI check and a refinement never edit the files they judge (R11.13 slice 2).
  // The chat searches its own guide and history with the tools of CHAT_TOOLS only; its Bash rules allow graphify queries and nothing else.
  const kindTools = KIND_TOOLS[req.kind];
  const scoped = READ_ONLY_KINDS.includes(req.kind) ? { ...req.agent, tools: req.agent.tools.filter((t) => !REVIEW_DENIED_TOOLS.includes(t)) } : kindTools ? { ...req.agent, tools: [...kindTools] } : req.agent;
  const searching = req.webSearch === true ? { ...scoped, tools: [...scoped.tools, 'WebSearch'] } : scoped;
  const agent = req.fullAccess ? { ...searching, tools: [...new Set([...searching.tools, ...FULL_ACCESS_TOOLS])] } : searching;
  const catalogNote = refs.length > 0 ? `Reference catalog (search it with Grep; never load it whole): ${refs.join(', ')}` : '';
  const systemExtra = [req.systemExtra, catalogNote].filter(Boolean).join('\n\n');
  const agentWithExtra = systemExtra ? { ...agent, body: `${agent.body}\n\n${systemExtra}` } : agent;
  const invocation = buildInvocation(
    {
      role: req.role,
      model: req.model,
      profile: req.profile,
      cwd: req.cwd,
      prompt: req.prompt,
      jsonSchema: toJsonSchema(req.kind),
      tools: agent.tools,
      pluginDirs,
      disallowedTools: [...ALWAYS_DENIED, ...NESTED_DENIED],
      settingsPath,
      home,
      sessionId: req.sessionId,
      resume: req.resume,
      agentDefinition: agentWithExtra,
      // Beside the role settings file, in the step's own folder outside the worktree (writeRoleSettings uses the same folder).
      agentsPath: path.join(deps.settingsDir, path.basename(home), `${req.role}.agents.json`),
      cacheTtl: PROMPT_CACHE_TTL,
      apiKey: deps.apiKey,
      effort: req.effort,
      extraEnv: req.extraEnv,
    },
    hostEnv,
  );

  await fs.writeFile(invocation.agentsFile.path, invocation.agentsFile.content);
  let raw: RawStepResult;
  try {
    raw = await runProcess(deps.binary, invocation, stepCaps(req.kind, deps.caps), deps.onEvent, deps.signal);
  } catch (err) {
    return environmentFailure(`spawn failed: ${(err as Error).message}`);
  }

  if (req.sessionStore) await bookSessionShare(raw.summary, req.sessionStore, req.resume === true);

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
  const answer = raw.summary.structuredOutput ?? jsonFromResultText(raw.summary.resultText);
  const validation = validateAgentOutput(schema, answer, {
    expectedSpecHash: req.expectedSpecHash,
    refs: req.refs as ((value: { specHash: string }) => References) | undefined,
    refContext: typeof req.refContext === 'function' ? await req.refContext() : req.refContext,
    semantic: req.semantic as ReadonlyArray<(value: { specHash: string }) => string[]> | undefined,
  });
  if (!validation.ok) {
    const errors = [...validation.errors];
    if (raw.summary.structuredOutput === null && jsonFromResultText(raw.summary.resultText) === null) {
      // Without this the only trace of a prose-only answer is "expected object, received null".
      const text = redactSecrets((raw.summary.resultText ?? '').slice(0, 4000));
      // The parse error can quote part of the answer, so it is redacted like the answer.
      const parse = jsonParseError(raw.summary.resultText);
      errors.push(`no JSON object in the agent result (subtype=${raw.summary.subtype ?? 'none'}, terminal=${raw.summary.terminalReason ?? 'none'}, turns=${raw.summary.numTurns}${parse ? `, JSON.parse: ${redactSecrets(parse)}` : ''}): ${text || '(empty)'}`);
    } else {
      errors.push(`answer: ${redactSecrets(JSON.stringify(answer).slice(0, ANSWER_CHARS))}`);
    }
    return { ok: false, failure: 'schema', errors, summary: raw.summary, sandboxDisabled: false };
  }
  return { ok: true, value: validation.value as OutputOf<K>, summary: raw.summary };
}
