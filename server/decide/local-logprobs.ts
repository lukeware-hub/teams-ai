import { z } from 'zod';
import {
  noulConfidence,
  scoreConfidence,
  type Answer,
  type Answers,
  type BackendInput,
  type BackendResult,
  type BackendUsage,
  type DecisionBackend,
  type Entry,
  type Question,
} from './types.js';

/**
 * Spec 10A.2a: a llama.cpp server answers each question with one grammar-constrained token; the
 * distribution is read from that token's logprobs, so a single forward pass per question gives
 * calibrated-enough probabilities and the output can never fall outside the labels.
 */
export interface LocalDeps {
  fetch: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
  /** Top-k logprobs requested per token; must cover every label (at most 10 options plus noise). */
  nProbs: number;
}

const CHOICE_LABELS = 'ABCDEFGHIJ';
const NOUL_LABELS = ['yes', 'no'] as const;

const text = (e: Entry): string => (typeof e === 'string' ? e : JSON.stringify(e));

/** [label token, option key] pairs in prompt order. */
export function labelsFor(q: Question): Array<[string, string]> {
  switch (q.type) {
    case 'choice':
      return Object.keys(q.options).map((key, i) => [CHOICE_LABELS[i]!, key]);
    case 'score':
      return q.levels.map((_, i) => [String(i), String(i)]);
    case 'noul':
      return NOUL_LABELS.map((l) => [l, l]);
  }
}

export function grammarFor(q: Question): string {
  return `root ::= ${labelsFor(q)
    .map(([label]) => `"${label}"`)
    .join(' | ')}`;
}

/** The state is the shared prefix so llama.cpp's prompt cache serves every question of a decision. */
export function buildPrompt(state: string, q: Question): string {
  const head = ['You are a calibrated classifier inside a software delivery orchestrator. Read the state, then answer the question with exactly one label.', '', '### State', state, '', '### Question', text(q.instructions), ''];
  let body: string[];
  switch (q.type) {
    case 'choice':
      body = ['Options:', ...Object.entries(q.options).map(([key, desc], i) => `${CHOICE_LABELS[i]}) ${key}: ${text(desc)}`), '', 'Answer with the option letter only.'];
      break;
    case 'score':
      body = ['Levels (low to high):', ...q.levels.map((l, i) => `${i}) ${text(l)}`), '', 'Answer with the level number only.'];
      break;
    case 'noul':
      body = q.criteria ? [`yes: ${text(q.criteria.true)}`, `no: ${text(q.criteria.false)}`, '', 'Answer yes or no.'] : ['Answer yes or no.'];
      break;
  }
  return [...head, ...body, '', 'Answer:'].join('\n');
}

const Completion = z.object({
  model: z.string().optional(),
  tokens_evaluated: z.number().int().nonnegative().optional(),
  tokens_predicted: z.number().int().nonnegative().optional(),
  completion_probabilities: z
    .array(z.object({ top_logprobs: z.array(z.object({ token: z.string(), logprob: z.number() })) }))
    .min(1),
});

function probsByLabel(top: Array<{ token: string; logprob: number }>, labels: Array<[string, string]>): Record<string, number> | null {
  const raw: Record<string, number> = {};
  for (const [label, key] of labels) {
    const hit = top.find((t) => t.token.trim().toLowerCase() === label.toLowerCase());
    raw[key] = hit ? Math.exp(hit.logprob) : 0;
  }
  const sum = Object.values(raw).reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  for (const k of Object.keys(raw)) raw[k] = raw[k]! / sum;
  return raw;
}

export function fromCompletion(body: unknown, q: Question): { ok: true; answer: Answer; model: string | null; usage: BackendUsage } | { ok: false; message: string } {
  const parsed = Completion.safeParse(body);
  if (!parsed.success) return { ok: false, message: `response is not a llama.cpp completion: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  const probs = probsByLabel(parsed.data.completion_probabilities[0]!.top_logprobs, labelsFor(q));
  if (!probs) return { ok: false, message: 'no label among the top tokens' };
  let answer: Answer;
  switch (q.type) {
    case 'choice': {
      const [value, best] = Object.entries(probs).reduce((a, b) => (b[1] > a[1] ? b : a));
      answer = { type: 'choice', value, probabilities: probs, confidence: best };
      break;
    }
    case 'score': {
      const value = Object.entries(probs).reduce((acc, [i, p]) => acc + Number(i) * p, 0);
      answer = { type: 'score', value, probabilities: probs, confidence: scoreConfidence(probs) };
      break;
    }
    case 'noul': {
      const yes = probs.yes!;
      answer = { type: 'noul', value: yes, probabilities: { yes, no: probs.no! }, confidence: noulConfidence(yes) };
      break;
    }
  }
  return {
    ok: true,
    answer,
    model: parsed.data.model ?? null,
    usage: { inputTokens: parsed.data.tokens_evaluated ?? 0, outputTokens: parsed.data.tokens_predicted ?? 0, costUsd: 0 },
  };
}

export class LocalLogprobsBackend implements DecisionBackend {
  readonly name = 'local' as const;

  constructor(private readonly deps: LocalDeps) {}

  async evaluate(input: BackendInput): Promise<BackendResult> {
    const url = `${this.deps.baseUrl.replace(/\/+$/, '')}/completion`;
    const results = await Promise.all(Object.entries(input.questions).map(async ([id, q]) => ({ id, result: await this.ask(url, input.state, q) })));
    const answers: Answers = {};
    let usage: BackendUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let model: string | null = null;
    for (const { id, result } of results) {
      if (!result.ok) return { ok: false, reason: result.reason, message: `${id}: ${result.message}` };
      answers[id] = result.answer;
      model ??= result.model;
      usage = { inputTokens: usage.inputTokens + result.usage.inputTokens, outputTokens: usage.outputTokens + result.usage.outputTokens, costUsd: 0 };
    }
    return { ok: true, answers, model: model ?? 'local', usage };
  }

  private async ask(url: string, state: string, q: Question): Promise<{ ok: true; answer: Answer; model: string | null; usage: BackendUsage } | { ok: false; reason: 'unavailable' | 'invalid'; message: string }> {
    const body = JSON.stringify({ prompt: buildPrompt(state, q), grammar: grammarFor(q), n_predict: 1, n_probs: this.deps.nProbs, temperature: 0, cache_prompt: true });
    let res: Response;
    try {
      res = await this.deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(this.deps.timeoutMs) });
    } catch (err) {
      return { ok: false, reason: 'unavailable', message: `request failed: ${(err as Error).name}: ${(err as Error).message}` };
    }
    if (!res.ok) return { ok: false, reason: 'unavailable', message: `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, reason: 'invalid', message: 'body is not JSON' };
    }
    const mapped = fromCompletion(json, q);
    return mapped.ok ? mapped : { ok: false, reason: 'invalid', message: mapped.message };
  }
}
