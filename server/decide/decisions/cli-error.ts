import type { FailureKind } from '../../scheduler/retry-policy.js';
import type { DecideContext, Decider } from '../decider.js';
import type { Questions } from '../types.js';

/**
 * Spec 10A.5 decision 8, mapped onto the runner's taxonomy: usage-limit → quota, auth-expired → auth,
 * invalid-output → schema, other → code. `network` is left out: the retry policy only accepts
 * infra/environment for gates, so a network failure of an agent step stays `code`.
 */
export type CliErrorKind = Extract<FailureKind, 'quota' | 'auth' | 'schema' | 'code'>;

export const CLI_ERROR_OPTIONS: Record<CliErrorKind, string> = {
  quota: 'The account hit a usage, rate or quota limit (HTTP 429, "usage limit", "overloaded" with a reset time); retrying now would fail the same way.',
  auth: 'The CLI is not logged in or its credentials expired or were rejected (HTTP 401/403, "login", "invalid api key").',
  schema: 'The agent ran but its final output was missing, truncated or not the JSON the step asked for; running the step again may succeed.',
  code: 'Anything else: the agent failed while doing the work, or the cause cannot be told from the output.',
};

export const CLI_ERROR_DEFAULT: CliErrorKind = 'code';

export interface CliErrorInput {
  resultText: string | null;
  stderr: string;
  apiErrorStatus: number | null;
  subtype: string | null;
  terminalReason: string | null;
}

export function cliErrorQuestions(): Questions {
  return {
    kind: {
      type: 'choice',
      instructions: 'A `claude -p` agent step failed and no deterministic rule recognized the error. From the API status, subtype and output, classify why it failed.',
      options: CLI_ERROR_OPTIONS,
    },
  };
}

/** Texts are secret-redacted by the caller; the decider redacts again before sending. */
export function cliErrorState(input: CliErrorInput): string {
  return [
    `api error status: ${input.apiErrorStatus ?? 'none'}`,
    `subtype: ${input.subtype ?? 'none'}`,
    `terminal reason: ${input.terminalReason ?? 'none'}`,
    '',
    `result text:\n${input.resultText || '(empty)'}`,
    '',
    `stderr (tail):\n${input.stderr.slice(-2000) || '(empty)'}`,
  ].join('\n');
}

export async function classifyCliError(input: CliErrorInput, decider: Pick<Decider, 'decide'>, ctx: DecideContext): Promise<CliErrorKind> {
  const outcome = await decider.decide('cli-error', cliErrorState(input), cliErrorQuestions(), ctx);
  if (!outcome.answered) return CLI_ERROR_DEFAULT;
  const answer = outcome.answers.kind;
  if (!answer || answer.type !== 'choice' || !(answer.value in CLI_ERROR_OPTIONS)) return CLI_ERROR_DEFAULT;
  return answer.value as CliErrorKind;
}
