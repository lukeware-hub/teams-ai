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

/**
 * Extracts a single JSON object from agent text, tolerating markdown fences and surrounding prose.
 * The CLI does not always populate structured_output (observed with --agents + --json-schema),
 * so the runner falls back to the text; validation still runs on the parsed object.
 */
export function extractJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const value: unknown = JSON.parse(candidate.slice(start, end + 1));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * `allowed_warning` is still allowed: the CLI emits it on a successful step when a window is high.
 * Only a status that actually refused the request counts as rejected (spec §8.7).
 */
export function isRateLimitRejected(status: string): boolean {
  return status !== 'allowed' && status !== 'allowed_warning';
}

export interface RateLimitInfo {
  status: string;
  /** Top-level reset of the window the CLI is reporting on (epoch seconds). */
  resetsAt: number | null;
  fiveHourUtilization: number | null;
  fiveHourResetsAt: number | null;
  sevenDayUtilization: number | null;
  sevenDayResetsAt: number | null;
}

/**
 * What a step spent its time and tokens on, beyond the usage totals (R11.13 slice 8): the numbers to read before tuning
 * `--effort`, the per-step caps or the prompt cache TTL.
 */
export interface StepProfile {
  /** Part of `usage.outputTokens` the model spent thinking; the CLI chooses the effort per turn unless `--effort` is set. */
  thinkingTokens: number;
  /** Time inside API calls; `durationMs` minus this is tools, startup and waiting. */
  durationApiMs: number;
  /** Tool calls by tool name. */
  toolCalls: Record<string, number>;
  /** Skill calls by skill name; absent when the step called no skill. */
  skills?: Record<string, number>;
  /** Characters of tool results the agent read back, a proxy for the context a tool adds per turn. */
  toolResultChars: number;
  /** A tool result said the CLI's own sandbox could not start (the agent may report it in any language, the tool result does not). */
  sandboxInitFailed?: boolean;
  /** The resumed session reported lower totals than the attempt before it, so this step booked its reported numbers whole. */
  sessionTotalsReset?: boolean;
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
  /** Parsed --json-schema output (CLI 2.1.281 puts it in result.structured_output). */
  structuredOutput: unknown | null;
  /** Where structuredOutput came from; null when the result had neither. */
  structuredSource: 'structured_output' | 'text' | null;
  /** e.g. "completed", "rapid_refill_breaker"; the CLI may report is_error=true with subtype "success". */
  terminalReason: string | null;
  /** HTTP status of the failing API call when the CLI reports one (401 auth, 429 quota). */
  apiErrorStatus: number | null;
  /** Latest rate_limit_event in the stream (subscription usage windows). */
  rateLimit: RateLimitInfo | null;
  /** The addresses a web search of this run returned, in order: the only addresses a suggestion may cite. Kept in memory, never journaled. */
  webSearchUrls?: string[];
  compactions: number;
  profile?: StepProfile;
}

const ResultEvent = z
  .object({
    type: z.literal('result'),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    duration_ms: z.number().optional(),
    duration_api_ms: z.number().optional(),
    num_turns: z.number().optional(),
    result: z.string().optional(),
    session_id: z.string().optional(),
    total_cost_usd: z.number().optional(),
    structured_output: z.unknown().optional(),
    terminal_reason: z.string().nullable().optional(),
    api_error_status: z.number().nullable().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
        output_tokens_details: z.object({ thinking_tokens: z.number().optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const RateLimitEvent = z
  .object({
    type: z.literal('rate_limit_event'),
    rate_limit_info: z
      .object({
        status: z.string(),
        resetsAt: z.number().optional(),
        unifiedWindows: z
          .object({
            five_hour: z.object({ utilization: z.number().optional(), resetsAt: z.number().optional() }).optional(),
            seven_day: z.object({ utilization: z.number().optional(), resetsAt: z.number().optional() }).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

const AssistantUsage = z
  .object({
    type: z.literal('assistant'),
    message: z
      .object({
        id: z.string().optional(),
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
      .passthrough(),
  })
  .passthrough();

/** Usage of a killed step: assistant messages carry usage per message id (one entry per content block). */
function partialUsage(events: readonly StreamEvent[]): { usage: Usage; turns: number } {
  const seen = new Map<string, Usage>();
  let anonymous = 0;
  for (const e of events) {
    const parsed = AssistantUsage.safeParse(e);
    if (!parsed.success) continue;
    const id = parsed.data.message.id ?? `anon-${anonymous++}`;
    const u = parsed.data.message.usage;
    if (!u) {
      if (!seen.has(id)) seen.set(id, { ...ZERO_USAGE });
      continue;
    }
    seen.set(id, {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    });
  }
  const usage = { ...ZERO_USAGE };
  for (const u of seen.values()) {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cacheReadTokens += u.cacheReadTokens;
    usage.cacheWriteTokens += u.cacheWriteTokens;
  }
  return { usage, turns: seen.size };
}

function latestRateLimit(events: readonly StreamEvent[]): RateLimitInfo | null {
  const raw = [...events].reverse().find((e) => e.type === 'rate_limit_event');
  const parsed = raw ? RateLimitEvent.safeParse(raw) : null;
  if (!parsed || !parsed.success) return null;
  const info = parsed.data.rate_limit_info;
  return {
    status: info.status,
    resetsAt: info.resetsAt ?? null,
    fiveHourUtilization: info.unifiedWindows?.five_hour?.utilization ?? null,
    fiveHourResetsAt: info.unifiedWindows?.five_hour?.resetsAt ?? null,
    sevenDayUtilization: info.unifiedWindows?.seven_day?.utilization ?? null,
    sevenDayResetsAt: info.unifiedWindows?.seven_day?.resetsAt ?? null,
  };
}

const textLength = (content: unknown): number => {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((n: number, c: unknown) => n + (typeof (c as { text?: unknown })?.text === 'string' ? (c as { text: string }).text.length : 0), 0);
};

/** Tool calls and tool-result sizes, from the assistant and user messages of the stream. */
const SANDBOX_INIT_FAILURE = /failed to create bridge sockets/i;

function toolActivity(events: readonly StreamEvent[]): Pick<StepProfile, 'toolCalls' | 'skills' | 'toolResultChars' | 'sandboxInitFailed'> {
  const toolCalls: Record<string, number> = {};
  const skills: Record<string, number> = {};
  let toolResultChars = 0;
  let sandboxInitFailed = false;
  for (const e of events) {
    if (e.type !== 'assistant' && e.type !== 'user') continue;
    const content = (e as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; name?: string; input?: { skill?: unknown }; content?: unknown }>) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
        const skill = block.input?.skill;
        if (block.name === 'Skill' && typeof skill === 'string') skills[skill] = (skills[skill] ?? 0) + 1;
      } else if (block?.type === 'tool_result') {
        toolResultChars += textLength(block.content);
        if (SANDBOX_INIT_FAILURE.test(JSON.stringify(block.content ?? ''))) sandboxInitFailed = true;
      }
    }
  }
  return { toolCalls, ...(Object.keys(skills).length > 0 ? { skills } : {}), toolResultChars, ...(sandboxInitFailed ? { sandboxInitFailed } : {}) };
}

/** The text of a tool result: a string, or the text parts of a list. */
const resultText = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { text?: unknown }) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : '';

/** The addresses the web searches of the run returned, in order: the only addresses a suggestion may cite. */
function searchedUrls(events: readonly StreamEvent[]): string[] {
  const searches = new Set<string>();
  const urls = new Set<string>();
  for (const e of events) {
    if (e.type !== 'assistant' && e.type !== 'user') continue;
    const content = (e as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; id?: string; name?: string; tool_use_id?: string; content?: unknown }>) {
      if (block?.type === 'tool_use' && block.name === 'WebSearch' && typeof block.id === 'string') searches.add(block.id);
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && searches.has(block.tool_use_id)) {
        for (const m of resultText(block.content).matchAll(/https?:\/\/[^\s"'\\)\]>,<]+/g)) urls.add(m[0]);
      }
    }
  }
  return [...urls];
}

/** The searched addresses as a summary field: absent when the run searched nothing, like the skills it used. */
const searchField = (events: readonly StreamEvent[]): { webSearchUrls?: string[] } => {
  const urls = searchedUrls(events);
  return urls.length > 0 ? { webSearchUrls: urls } : {};
};

/** The text of every agent message in the run, in order: the final result can hold only the last part of an answer. */
function agentText(events: readonly StreamEvent[]): string {
  let text = '';
  for (const e of events) {
    const content = (e as { message?: { content?: unknown } }).message?.content;
    if (e.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: unknown }>) {
      if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    }
  }
  return text;
}

/** The answer across the agent's messages, for a run whose final result holds only its last part: a JSON object that ends the text, with nothing but whitespace and code fences after it. */
function answerAcrossMessages(events: readonly StreamEvent[]): Record<string, unknown> | null {
  const text = agentText(events);
  const end = text.lastIndexOf('}');
  if (end === -1 || text.slice(end + 1).replace(/```/g, '').trim() !== '') return null;
  for (let start = text.indexOf('{'); start !== -1 && start < end; start = text.indexOf('{', start + 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      // This brace does not open the answer; a later one may.
    }
  }
  return null;
}

export function summarizeStream(parsed: ParsedStream): ResultSummary {
  const compactions = parsed.events.filter((e) => e.type === 'system' && e.subtype === 'compact_boundary').length;
  const sessionId = parsed.events.find((e) => typeof e.session_id === 'string')?.session_id ?? null;
  const rateLimit = latestRateLimit(parsed.events);
  const raw = [...parsed.events].reverse().find((e) => e.type === 'result');
  const result = raw ? ResultEvent.safeParse(raw) : null;
  if (!result || !result.success) {
    const partial = partialUsage(parsed.events);
    return {
      found: false,
      isError: true,
      subtype: null,
      numTurns: partial.turns,
      durationMs: 0,
      costUsd: null,
      usage: partial.usage,
      sessionId,
      resultText: null,
      structuredOutput: null,
      structuredSource: null,
      terminalReason: null,
      apiErrorStatus: null,
      rateLimit,
      compactions,
      ...searchField(parsed.events),
      profile: { thinkingTokens: 0, durationApiMs: 0, ...toolActivity(parsed.events) },
    };
  }
  const r = result.data;
  const hasStructuredOutput = r.structured_output !== undefined && r.structured_output !== null;
  const fromText = hasStructuredOutput ? null : extractJsonObject(r.result ?? null) ?? answerAcrossMessages(parsed.events);
  const structuredOutput = r.structured_output ?? fromText;
  const structuredSource = hasStructuredOutput ? 'structured_output' : fromText ? 'text' : null;
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
    structuredOutput: structuredOutput ?? null,
    structuredSource,
    terminalReason: r.terminal_reason ?? null,
    apiErrorStatus: r.api_error_status ?? null,
    rateLimit,
    compactions,
    ...searchField(parsed.events),
    profile: {
      thinkingTokens: (r.usage?.output_tokens_details as { thinking_tokens?: number } | undefined)?.thinking_tokens ?? 0,
      durationApiMs: r.duration_api_ms ?? 0,
      ...toolActivity(parsed.events),
    },
  };
}
