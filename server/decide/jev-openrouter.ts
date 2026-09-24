import { z } from 'zod';
import { redactSecrets } from '../core/redact.js';
import {
  noulConfidence,
  type Answers,
  type BackendInput,
  type BackendResult,
  type BackendUsage,
  type DecisionBackend,
  type Entry,
  type Question,
  type Questions,
} from './types.js';

/**
 * Spec 10A.2: Jev through OpenRouter's System One API. Same request/response shapes as TypeSafe's
 * own API; not an OpenAI-compatible chat endpoint, so it is called directly, never through
 * OmniRoute or a Claude Code process.
 */
export interface JevDeps {
  fetch: typeof fetch;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxTries: number;
  backoffMs: number;
  sleep: (ms: number) => Promise<void>;
}

export type JevQuestion =
  | { type: 'choice'; instructions: Entry; criteria: Record<string, Entry> }
  | { type: 'score'; instructions: Entry; criteria: Entry[] }
  | { type: 'noul'; instructions: Entry; criteria?: { true: Entry; false: Entry } };

export interface JevRequest {
  model: string;
  state: string;
  questions: Record<string, JevQuestion>;
}

export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504, 529]);

const SUM_TOLERANCE = 0.02;

function toJevQuestion(q: Question): JevQuestion {
  switch (q.type) {
    case 'choice':
      return { type: 'choice', instructions: q.instructions, criteria: q.options };
    case 'score':
      return { type: 'score', instructions: q.instructions, criteria: q.levels };
    case 'noul':
      return q.criteria
        ? { type: 'noul', instructions: q.instructions, criteria: q.criteria }
        : { type: 'noul', instructions: q.instructions };
  }
}

export function toJevRequest(model: string, state: string, questions: Questions): JevRequest {
  return { model, state, questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, toJevQuestion(q)])) };
}

const probabilities = z.record(z.string(), z.number().min(0).max(1));
const ChoiceAnswerWire = z.object({ type: z.literal('choice'), choice: z.string(), probabilities, confidence: z.number().min(0).max(1) });
const ScoreAnswerWire = z.object({ type: z.literal('score'), score: z.number(), probabilities, confidence: z.number().min(0).max(1) });
const NoulAnswerWire = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const ResponseWire = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.discriminatedUnion('type', [ChoiceAnswerWire, ScoreAnswerWire, NoulAnswerWire])),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost: z.number().nonnegative().optional(),
  }),
});

function checkDistribution(id: string, probs: Record<string, number>, expectedKeys: readonly string[]): string | null {
  for (const k of Object.keys(probs)) if (!expectedKeys.includes(k)) return `${id}: probability for unknown key "${k}"`;
  for (const k of expectedKeys) if (!(k in probs)) return `${id}: probability for "${k}" missing`;
  const sum = Object.values(probs).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return `${id}: probabilities sum to ${sum.toFixed(3)}, expected 1`;
  return null;
}

export function fromJevResponse(
  body: unknown,
  questions: Questions,
): { ok: true; answers: Answers; model: string; usage: BackendUsage } | { ok: false; message: string } {
  const parsed = ResponseWire.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: `response does not match the System One shape: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  const answers: Answers = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = parsed.data.answers[id];
    if (!a) return { ok: false, message: `answer for "${id}" missing` };
    if (a.type !== q.type) return { ok: false, message: `${id}: answer type ${a.type} does not match question type ${q.type}` };
    if (a.type === 'choice' && q.type === 'choice') {
      const options = Object.keys(q.options);
      if (!options.includes(a.choice)) return { ok: false, message: `${id}: choice "${a.choice}" is not an option` };
      const bad = checkDistribution(id, a.probabilities, options);
      if (bad) return { ok: false, message: bad };
      answers[id] = { type: 'choice', value: a.choice, probabilities: a.probabilities, confidence: a.confidence };
    } else if (a.type === 'score' && q.type === 'score') {
      const keys = q.levels.map((_, i) => String(i));
      const bad = checkDistribution(id, a.probabilities, keys);
      if (bad) return { ok: false, message: bad };
      answers[id] = { type: 'score', value: a.score, probabilities: a.probabilities, confidence: a.confidence };
    } else if (a.type === 'noul') {
      const yes = a.noul;
      answers[id] = { type: 'noul', value: yes, probabilities: { yes, no: Math.round((1 - yes) * 1e6) / 1e6 }, confidence: noulConfidence(yes) };
    }
  }
  const u = parsed.data.usage;
  return {
    ok: true,
    answers,
    model: parsed.data.model,
    usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, costUsd: u.cost ?? null },
  };
}

export class JevOpenRouterBackend implements DecisionBackend {
  readonly name = 'jev' as const;

  constructor(private readonly deps: JevDeps) {
    if (deps.apiKey.trim() === '') throw new Error('OPENROUTER_API_KEY is empty; the jev backend cannot start');
  }

  async evaluate(input: BackendInput): Promise<BackendResult> {
    const url = `${this.deps.baseUrl.replace(/\/+$/, '')}/v1/systemone`;
    const body = JSON.stringify(toJevRequest(this.deps.model, input.state, input.questions));
    const clean = (s: string) => redactSecrets(s, [this.deps.apiKey]);
    let lastMessage = 'no attempt made';
    for (let attempt = 0; attempt < this.deps.maxTries; attempt++) {
      if (attempt > 0) await this.deps.sleep(this.deps.backoffMs * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await this.deps.fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.deps.apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.deps.timeoutMs),
        });
      } catch (err) {
        // Network failure or timeout: retryable.
        lastMessage = clean(`request failed: ${(err as Error).name}: ${(err as Error).message}`);
        continue;
      }
      if (res.ok) {
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          return { ok: false, reason: 'invalid', message: `HTTP ${res.status} with a body that is not JSON` };
        }
        const mapped = fromJevResponse(json, input.questions);
        if (!mapped.ok) return { ok: false, reason: 'invalid', message: mapped.message };
        return { ok: true, answers: mapped.answers, model: mapped.model, usage: mapped.usage };
      }
      const text = clean((await res.text().catch(() => '')).slice(0, 300));
      lastMessage = `HTTP ${res.status}: ${text}`;
      if (!RETRYABLE_STATUS.has(res.status)) return { ok: false, reason: 'unavailable', message: lastMessage };
    }
    return { ok: false, reason: 'unavailable', message: `${lastMessage} (after ${this.deps.maxTries} tries)` };
  }
}
