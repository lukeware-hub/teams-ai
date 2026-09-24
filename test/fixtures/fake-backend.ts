import type {
  Answers,
  BackendInput,
  BackendName,
  BackendResult,
  BackendUsage,
  ChoiceAnswer,
  DecisionBackend,
} from '../../server/decide/types.js';

/** Replays scripted results in order; throws on an unscripted call so a test sees every extra call. */
export class FakeBackend implements DecisionBackend {
  readonly calls: BackendInput[] = [];
  constructor(
    readonly name: BackendName,
    private readonly script: BackendResult[],
  ) {}

  async evaluate(input: BackendInput): Promise<BackendResult> {
    this.calls.push(input);
    const next = this.script.shift();
    if (!next) throw new Error(`${this.name}: unscripted call`);
    return next;
  }
}

export const choiceAnswer = (
  value: string,
  probabilities: Record<string, number>,
  confidence: number | null = probabilities[value] ?? null,
): ChoiceAnswer => ({ type: 'choice', value, probabilities, confidence });

export const ok = (
  answers: Answers,
  model = 'fake',
  usage: BackendUsage = { inputTokens: 100, outputTokens: 10, costUsd: 0.00001 },
): BackendResult => ({ ok: true, answers, model, usage });

export const unavailable = (message = 'down'): BackendResult => ({ ok: false, reason: 'unavailable', message });
export const invalid = (message = 'bad'): BackendResult => ({ ok: false, reason: 'invalid', message });
