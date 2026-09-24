import type { Gate } from '../../contracts/plan.js';
import type { GateResult } from '../../exec/gate-runner.js';
import type { DecideContext, Decider } from '../decider.js';
import type { BackendName, Questions } from '../types.js';

/** Spec 10A.5 decision 1. Every option is a FailureKind the retry policy already understands. */
export type GateTriage = 'code' | 'flaky-test' | 'infra' | 'environment' | 'dependency';

export const GATE_TRIAGE_OPTIONS: Record<GateTriage, string> = {
  code: 'A test, compile or lint step failed because of the code under test; running again without changes would fail the same way.',
  'flaky-test': 'A test failed for a nondeterministic reason (timing, ordering, random data, port in use) and would likely pass on a re-run.',
  infra: 'The container runtime or host broke: Docker daemon errors, out of memory kill, disk full, container killed; the code was not exercised.',
  environment: 'A tool, binary, image or environment variable the command needs is missing or misconfigured inside the gate image.',
  dependency: 'Package installation or resolution failed: registry unreachable, lockfile mismatch, version not found, checksum error.',
};

export const GATE_TRIAGE_DEFAULT: GateTriage = 'code';

export function gateTriageQuestions(): Questions {
  return {
    kind: {
      type: 'choice',
      instructions:
        'A quality gate ran inside a container and failed. From the command, exit status, JUnit summary and output tails, classify why it failed.',
      options: GATE_TRIAGE_OPTIONS,
    },
  };
}

function junitSummary(result: GateResult): string {
  if (!result.junit) return 'junit: no report';
  const count = (status: string) => result.junit!.filter((t) => t.status === status).length;
  const failedIds = result.junit
    .filter((t) => t.status === 'failed')
    .slice(0, 5)
    .map((t) => t.id);
  const head = `junit: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped`;
  return failedIds.length > 0 ? `${head}\nfailed tests: ${failedIds.join(', ')}` : head;
}

/** Tails are already secret-redacted by the gate runner; the decider redacts again before sending. */
export function gateTriageState(gate: Gate, result: GateResult): string {
  return [
    `gate: ${gate.name}`,
    `command: ${gate.command}`,
    `network: ${gate.network}`,
    `exit code: ${result.exitCode ?? 'none (process did not start)'}`,
    `timed out: ${result.timedOut ? 'yes' : 'no'}`,
    `duration: ${result.durationMs} ms`,
    junitSummary(result),
    '',
    `stderr (tail):\n${result.stderrTail || '(empty)'}`,
    '',
    `stdout (tail):\n${result.stdoutTail || '(empty)'}`,
  ].join('\n');
}

export interface TriageResult {
  kind: GateTriage;
  source: 'rule' | 'default' | BackendName;
}

/**
 * Spec 10A.0/10A.5: deterministic rules first (the gate runner's own infra classification), System 1
 * second, and `code` as the default so an unanswered triage still consumes an attempt (spec §12).
 */
export async function triageGateFailure(
  gate: Gate,
  result: GateResult,
  decider: Pick<Decider, 'decide'>,
  ctx: DecideContext,
): Promise<TriageResult> {
  if (result.passed) throw new Error(`gate ${gate.name} passed; nothing to triage`);
  if (result.failure === 'infra') return { kind: 'infra', source: 'rule' };
  const outcome = await decider.decide('gate-triage', gateTriageState(gate, result), gateTriageQuestions(), ctx);
  if (!outcome.answered) return { kind: GATE_TRIAGE_DEFAULT, source: 'default' };
  const answer = outcome.answers.kind;
  if (!answer || answer.type !== 'choice' || !(answer.value in GATE_TRIAGE_OPTIONS)) return { kind: GATE_TRIAGE_DEFAULT, source: 'default' };
  return { kind: answer.value as GateTriage, source: outcome.backend };
}
