import os from 'node:os';
import { z } from 'zod';
import type { Exec } from '../exec/command.js';
import { childEnv } from '../onboarding/pty.js';
import { hasOauthToken, hostRateLimitTier, hostTokenExpiresAt } from '../runner/step-home.js';
import { REFRESH_WINDOW_MS } from '../runner/step.js';

export interface UsageLimit {
  kind: string;
  /** The model or surface a scoped meter is for, e.g. "Fable". */
  label: string | null;
  percent: number;
  severity: 'normal' | 'warning' | 'critical';
  resetsAt: string | null;
  /** The share of the weekly limit a scoped meter may use, e.g. 50. */
  allowancePercent: number | null;
}

export type UnavailableReason = 'not-logged-in' | 'renewing' | 'no-plan' | 'api-key' | 'failed';

export type ClaudeUsage = { available: true; plan: string | null; limits: UsageLimit[] } | { available: false; reason: UnavailableReason };

export interface ClaudeUsageDeps {
  exec: Exec;
  hostEnv: NodeJS.ProcessEnv;
  authMode: () => Promise<'subscription' | 'api-key'>;
  now: () => number;
}

const REQUEST_ID = 'usage';
const REQUEST = JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'get_usage', skip_behaviors: true } });
const ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
const TIMEOUT_MS = 15_000;
const CACHE_MS = 60_000;
const PLAN_NAMES: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };

const Window = z.object({
  kind: z.string(),
  percent: z.number(),
  resets_at: z.string().nullish(),
  severity: z.enum(['normal', 'warning', 'critical']).catch('normal'),
  scope: z.object({ model: z.object({ display_name: z.string() }).nullish(), surface: z.object({ display_name: z.string() }).nullish() }).nullish(),
});
const ReplyShape = z.object({
  subscription_type: z.string().nullish(),
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      limits: z.array(Window).nullish(),
      weekly_scoped_shares: z.array(z.object({ limit_index: z.number(), allowance_percent_of_weekly: z.number() })).nullish(),
    })
    .nullish(),
});
const Envelope = z.object({
  type: z.literal('control_response'),
  response: z.object({ subtype: z.string(), request_id: z.string(), response: z.unknown() }),
});
type Reply = z.infer<typeof ReplyShape>;

const parseJson = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** The successful reply to our request in the CLI output, or null when there is none. */
function replyFrom(stdout: string): Reply | null {
  for (const line of stdout.split('\n')) {
    const message = Envelope.safeParse(parseJson(line));
    if (!message.success || message.data.response.request_id !== REQUEST_ID) continue;
    const reply = ReplyShape.safeParse(message.data.response.response);
    return message.data.response.subtype === 'success' && reply.success ? reply.data : null;
  }
  return null;
}

/** The plan as Claude Desktop names it, e.g. "Max (5x)" from the plan and a tier ending in its multiplier. */
function planLabel(subscription: string | null | undefined, tier: string | null): string | null {
  if (!subscription) return null;
  const name = PLAN_NAMES[subscription] ?? subscription;
  const multiplier = /_(\d+)x$/.exec(tier ?? '')?.[1];
  return multiplier ? `${name} (${multiplier}x)` : name;
}

function limitsFrom(reply: Reply): UsageLimit[] {
  const shares = reply.rate_limits?.weekly_scoped_shares ?? [];
  return (reply.rate_limits?.limits ?? []).map((row, index) => ({
    kind: row.kind,
    label: row.scope?.model?.display_name ?? row.scope?.surface?.display_name ?? null,
    percent: Math.round(Math.min(100, Math.max(0, row.percent))),
    severity: row.severity,
    resetsAt: row.resets_at ?? null,
    allowancePercent: shares.find((share) => share.limit_index === index)?.allowance_percent_of_weekly ?? null,
  }));
}

async function fetchUsage(deps: ClaudeUsageDeps): Promise<ClaudeUsage> {
  const result = await deps.exec({ bin: deps.hostEnv.CLAUDE_BIN ?? 'claude', args: ARGS, cwd: os.tmpdir(), env: childEnv(deps.hostEnv), stdin: `${REQUEST}\n`, timeoutMs: TIMEOUT_MS }).catch(() => null);
  const reply = result && result.exitCode === 0 && !result.timedOut ? replyFrom(result.stdout) : null;
  if (!reply) return { available: false, reason: 'failed' };
  if (!reply.rate_limits_available) return { available: false, reason: 'no-plan' };
  return { available: true, plan: planLabel(reply.subscription_type, await hostRateLimitTier(deps.hostEnv)), limits: limitsFrom(reply) };
}

/** Why the CLI must not run now, or null. A stored login that renews during the run would rotate the token that agent steps copy. */
async function blockedBy(deps: ClaudeUsageDeps): Promise<UnavailableReason | null> {
  if ((await deps.authMode()) === 'api-key') return 'api-key';
  if (hasOauthToken(deps.hostEnv)) return null;
  const expiresAt = await hostTokenExpiresAt(deps.hostEnv);
  if (expiresAt === null) return 'not-logged-in';
  return expiresAt - deps.now() < REFRESH_WINDOW_MS + TIMEOUT_MS ? 'renewing' : null;
}

/** Reads the plan usage through the CLI at most once a minute, and shares one run between concurrent reads. */
export function createClaudeUsage(deps: ClaudeUsageDeps): () => Promise<ClaudeUsage> {
  let last: { at: number; view: ClaudeUsage } | null = null;
  let running: Promise<ClaudeUsage> | null = null;
  return async () => {
    const reason = await blockedBy(deps);
    if (reason) return { available: false, reason };
    if (last && deps.now() - last.at < CACHE_MS) return last.view;
    running ??= fetchUsage(deps)
      .then((view) => {
        last = { at: deps.now(), view };
        return view;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
}
