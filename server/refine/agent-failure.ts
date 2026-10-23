import type { ContextPackInput } from '../knowledge/context-pack.js';
import { redactSecrets } from '../core/redact.js';
import type { StepOutcome } from '../runner/step.js';
import type { FailureKind } from '../scheduler/retry-policy.js';
import { PackTooLargeError } from './fit-pack.js';
import { OwnerError } from '../core/owner-error.js';

/** Longest raw error text the journal keeps; the screen never shows it. */
const DETAIL_CHARS = 1000;
/** Longest schema error quoted back to the agent in a retry note. */
const NOTE_CHARS = 300;
/** The last sentence of a refinement failure: the owner asks again from the evaluation. */
const REVALUATE = 'Clique em Reavaliar.';
/** The last sentence of a suggestion failure: a suggestion has no revaluate button. */
export const TRY_AGAIN = 'Tente de novo.';

const clip = (text: string, chars = DETAIL_CHARS): string => text.slice(0, chars);

/** The owner's reason for a failed agent step, in plain words, with the raw errors for the journal. */
export function failureMessage(stage: string, failure: FailureKind, errors: readonly string[], again = REVALUATE): { reason: string; detail: string } {
  return { reason: reasonOf(stage, failure, again), detail: clip(errors.join('; ')) };
}

/** The error for a failed agent step that the route shows to the owner in Portuguese. */
export function ownerFailure(stage: string, failure: FailureKind, errors: readonly string[], again = REVALUATE): OwnerError {
  const { reason, detail } = failureMessage(stage, failure, errors, again);
  return new OwnerError(reason, detail);
}

/** The reason for an error of this code; an oversized pack keeps its own message, which says what to do. */
export function internalErrorMessage(stage: string, err: unknown): { reason: string; detail: string } {
  if (err instanceof PackTooLargeError) return { reason: err.message, detail: err.message };
  const text = err instanceof Error ? err.message : String(err);
  return { reason: `${stage} parou por um erro interno. ${REVALUATE}`, detail: clip(redactSecrets(text)) };
}

/** Runs an agent call, and when its answer fails the output schema, runs it once more with a note on what was wrong. */
export async function retryOnSchema<T>(attempt: (note: string | null) => Promise<StepOutcome<T>>): Promise<StepOutcome<T>> {
  const first = await attempt(null);
  if (first.ok || first.failure !== 'schema') return first;
  return attempt(schemaNote(first.errors));
}

/** The pack with a note appended to its feedback, or the pack itself when there is no note. */
export function withNote(pack: ContextPackInput, note: string | null): ContextPackInput {
  return note === null ? pack : { ...pack, feedback: `${pack.feedback ?? ''}\n\n${note}` };
}

/** The note for a retry: the JSON sentence when no object was found, otherwise the first schema error. */
function schemaNote(errors: readonly string[]): string {
  if (errors.some((e) => e.startsWith('no JSON object'))) {
    return 'Your previous answer was not one complete JSON object. Answer with exactly one complete JSON object, and nothing before or after it.';
  }
  return `Your previous answer did not match the output schema: ${clip(errors[0] ?? 'unknown error', NOTE_CHARS)}. Answer with one complete JSON object that follows the schema exactly.`;
}

function reasonOf(stage: string, failure: FailureKind, again: string): string {
  switch (failure) {
    case 'quota':
      return 'O limite de uso do Claude foi atingido. Tente de novo quando ele for liberado.';
    case 'auth':
      return 'A sessão do Claude expirou. Entre de novo no Claude em Configurações e processe de novo.';
    case 'timeout':
      return `${stage} passou do tempo limite. ${again}`;
    case 'schema':
      return `${stage} não devolveu o resultado em formato válido. ${again}`;
    case 'compaction':
      return `${stage} parou por causa do tamanho da conversa ou do ritmo de uso. ${again}`;
    case 'environment':
      return `${stage} não conseguiu iniciar o agente. ${again}`;
    default:
      return `${stage} falhou por um erro do agente. ${again}`;
  }
}
