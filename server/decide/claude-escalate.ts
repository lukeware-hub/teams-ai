import type { DecideOutput } from '../agents/outputs.js';
import type { Role } from '../config/config.js';
import type { StepOutcome } from '../runner/step.js';
import type { Answers, BackendInput, BackendResult, DecisionBackend, Questions } from './types.js';

export interface EscalationRequest {
  role: Role;
  prompt: string;
}

/** Runs one `decide` agent step (`claude -p --json-schema`); wired by createDecider's caller from runStep. */
export type EscalationRunner = (req: EscalationRequest) => Promise<StepOutcome<DecideOutput>>;

export function buildEscalationPrompt(state: string, questions: Questions): string {
  const shaped = Object.fromEntries(
    Object.entries(questions).map(([id, q]) => {
      if (q.type === 'choice') return [id, { type: q.type, instructions: q.instructions, options: q.options }];
      if (q.type === 'score') return [id, { type: q.type, instructions: q.instructions, levels: q.levels }];
      return [id, { type: q.type, instructions: q.instructions, criteria: q.criteria ?? null }];
    }),
  );
  return [
    'You are answering typed decision questions about the STATE below. Return only the JSON output the schema requires.',
    'Rules:',
    '- For a "choice" question, `value` is exactly one of the option names.',
    '- For a "score" question, `value` is the level index (0 = first level); use a fraction between two indexes only when the state sits between them.',
    '- For a "noul" question, `value` is the probability (0 to 1) that the statement is true.',
    '- Answer every question id. Do not add ids.',
    '',
    'STATE:',
    state,
    '',
    'QUESTIONS (JSON):',
    JSON.stringify(shaped, null, 2),
  ].join('\n');
}

export function fromEscalation(output: DecideOutput, questions: Questions): { ok: true; answers: Answers } | { ok: false; message: string } {
  const answers: Answers = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = output.answers[id];
    if (!a) return { ok: false, message: `answer for "${id}" missing` };
    if (a.type !== q.type) return { ok: false, message: `${id}: answer type ${a.type} does not match question type ${q.type}` };
    if (a.type === 'choice' && q.type === 'choice') {
      const options = Object.keys(q.options);
      if (!options.includes(a.value)) return { ok: false, message: `${id}: choice "${a.value}" is not an option` };
      answers[id] = {
        type: 'choice',
        value: a.value,
        probabilities: Object.fromEntries(options.map((o) => [o, o === a.value ? 1 : 0])),
        confidence: null,
      };
    } else if (a.type === 'score' && q.type === 'score') {
      const max = q.levels.length - 1;
      if (a.value > max) return { ok: false, message: `${id}: score ${a.value} exceeds the last level index ${max}` };
      const nearest = String(Math.round(a.value));
      answers[id] = {
        type: 'score',
        value: a.value,
        probabilities: Object.fromEntries(q.levels.map((_, i) => [String(i), String(i) === nearest ? 1 : 0])),
        confidence: null,
      };
    } else if (a.type === 'noul') {
      answers[id] = { type: 'noul', value: a.value, probabilities: { yes: a.value, no: Math.round((1 - a.value) * 1e6) / 1e6 }, confidence: null };
    }
  }
  return { ok: true, answers };
}

/** Spec 10A.3: System 2 answers are final and carry `confidence: null`. */
export class ClaudeEscalateBackend implements DecisionBackend {
  readonly name = 'claude' as const;

  constructor(private readonly run: EscalationRunner) {}

  async evaluate(input: BackendInput): Promise<BackendResult> {
    const outcome = await this.run({ role: input.escalateTo, prompt: buildEscalationPrompt(input.state, input.questions) });
    if (!outcome.ok) return { ok: false, reason: 'unavailable', message: `${outcome.failure}: ${outcome.errors.join('; ')}` };
    const mapped = fromEscalation(outcome.value, input.questions);
    if (!mapped.ok) return { ok: false, reason: 'invalid', message: mapped.message };
    const u = outcome.summary.usage;
    return {
      ok: true,
      answers: mapped.answers,
      model: 'claude',
      usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: outcome.summary.costUsd },
    };
  }
}
