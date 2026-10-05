import path from 'node:path';
import { SecurityOutput } from '../../server/agents/outputs.js';

/** The part of a runStep outcome the verdict reads. */
type Outcome = { ok: true; value: unknown } | { ok: false; failure: string; errors: readonly string[] };

/**
 * What the live sec smoke run must show: a reply that passes the SecurityOutput schema and flags the file that was
 * seeded with a flaw. Empty when it does. Kept apart from sec-step.ts so it can be tested without the Claude CLI.
 */
export function secSmokeProblems(outcome: Outcome, vulnerableFile: string): string[] {
  if (!outcome.ok) return [`the sec step failed (${outcome.failure}): ${outcome.errors.slice(0, 3).join('; ') || 'no detail'}`];
  const reply = SecurityOutput.safeParse(outcome.value);
  if (!reply.success) {
    return [`the sec reply does not match SecurityOutput: ${reply.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`];
  }
  const files = reply.data.findings.map((f) => f.file);
  // The agent may write the path relative, with ./ or absolute; the temp directory holds only the seeded file.
  if (files.some((f) => path.basename(f) === vulnerableFile)) return [];
  return [files.length === 0 ? `the sec reply has no findings, yet ${vulnerableFile} is vulnerable on purpose` : `no finding on ${vulnerableFile} (findings are on: ${files.join(', ')})`];
}
