import { OUTPUT_SCHEMAS, toJsonSchema, type OutputOf, type StepKind } from '../agents/outputs.js';
import type { AgentDefinition } from '../agents/registry.js';
import { ALWAYS_DENIED } from '../agents/registry.js';
import type { Accounting } from '../budget/accounting.js';
import type { ProviderProfile, Role } from '../config/config.js';
import type { FailureKind } from '../scheduler/retry-policy.js';
import { validateAgentOutput } from '../validators/agent-output.js';
import type { RefContext, References } from '../validators/references.js';
import { buildInvocation, ensureTrusted } from './invocation.js';
import { runProcess, type ProcessCaps, type RawStepResult, type RunnerBinary } from './process-runner.js';
import type { ResultSummary } from './stream-events.js';

export interface StepRequest {
  kind: StepKind;
  role: Role;
  agent: AgentDefinition;
  profile: ProviderProfile;
  model: string;
  cwd: string;
  prompt: string;
  expectedSpecHash: string;
  refContext?: RefContext;
  refs?: (value: never) => References;
  semantic?: ReadonlyArray<(value: never) => string[]>;
  phase: string;
  taskId: string | null;
  attempt: number;
  sessionId?: string;
  resume?: boolean;
  omniroute?: { baseUrl: string; token: string; compactWindow?: number };
}

export type StepOutcome<T> =
  | { ok: true; value: T; summary: ResultSummary }
  | { ok: false; failure: FailureKind; errors: string[]; summary: ResultSummary; sandboxDisabled: boolean };

export interface StepDeps {
  binary: RunnerBinary;
  caps: ProcessCaps;
  accounting: Accounting;
  claudeJsonPath: string;
  hostEnv?: NodeJS.ProcessEnv;
  onEvent?: (line: string) => void;
  clock?: () => Date;
}

const QUOTA_TEXT = /usage limit|rate limit|out of .*quota/i;
const AUTH_TEXT = /not logged in|authentication|invalid api key|please run claude login/i;

/** Order follows spec §12 and the CLI findings: environment → timeout → compaction → quota → auth → code. */
export function classifyFailure(raw: RawStepResult): FailureKind | null {
  const s = raw.summary;
  if (raw.sandboxDisabled) return 'environment';
  if (raw.killedBy) return 'timeout';
  if (s.compactions > 0 || s.terminalReason === 'rapid_refill_breaker') return 'compaction';
  const text = s.resultText ?? '';
  if ((s.rateLimit && s.rateLimit.status !== 'allowed') || (s.isError && QUOTA_TEXT.test(text))) return 'quota';
  if (s.isError && AUTH_TEXT.test(text)) return 'auth';
  if (!s.found || s.isError) return 'code';
  return null;
}

export async function runStep<K extends StepKind>(req: StepRequest, deps: StepDeps): Promise<StepOutcome<OutputOf<K>>> {
  await ensureTrusted(req.cwd, deps.claudeJsonPath);
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
      sessionId: req.sessionId,
      resume: req.resume,
      omniroute: req.omniroute,
    },
    deps.hostEnv ?? process.env,
  );
  // Test scaffolding: the fake binary reads FAKE_CLAUDE_* from the host env; they are harmless for the real CLI.
  for (const [k, v] of Object.entries(deps.hostEnv ?? {})) {
    if (k.startsWith('FAKE_CLAUDE_') && typeof v === 'string') invocation.env[k] = v;
  }

  const raw = await runProcess(deps.binary, invocation, deps.caps, deps.onEvent);
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
    numTurns: raw.summary.numTurns,
    at: (deps.clock ?? (() => new Date()))().toISOString(),
  });

  const failure = classifyFailure(raw);
  if (failure) {
    return { ok: false, failure, errors: [raw.summary.resultText ?? raw.stderr.slice(0, 500)], summary: raw.summary, sandboxDisabled: raw.sandboxDisabled };
  }

  const schema = OUTPUT_SCHEMAS[req.kind];
  const validation = validateAgentOutput(schema, raw.summary.structuredOutput, {
    expectedSpecHash: req.expectedSpecHash,
    refs: req.refs as ((value: { specHash: string }) => References) | undefined,
    refContext: req.refContext,
    semantic: req.semantic as ReadonlyArray<(value: { specHash: string }) => string[]> | undefined,
  });
  if (!validation.ok) {
    return { ok: false, failure: 'schema', errors: validation.errors, summary: raw.summary, sandboxDisabled: false };
  }
  return { ok: true, value: validation.value as OutputOf<K>, summary: raw.summary };
}
