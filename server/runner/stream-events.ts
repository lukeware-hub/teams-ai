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
