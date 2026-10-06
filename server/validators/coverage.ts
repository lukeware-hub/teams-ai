import type { Plan } from '../contracts/plan.js';
import { COVERAGE_GATE } from '../exec/coverage.js';

/** An exemption names a real path once, with a reason, so excluding it from coverage is a reviewable decision. */
function validateCoverageExemptions(plan: Plan): string[] {
  const exemptions = plan.coverageExemptions ?? [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const x of exemptions) {
    if (seen.has(x.path)) errors.push(`coverageExemptions: duplicate ${x.path}`);
    seen.add(x.path);
    if (x.reason.trim().length < 10) errors.push(`coverageExemptions: ${x.path} needs a reason of at least 10 characters`);
  }
  return errors;
}

/** R10.2: the coverage gate exists and blocks, and coveragePath is set so the orchestrator can check the floor
 * at run time (`server/exec/gate-runner.ts`); no tool or command is prescribed, any stack's own coverage tool
 * qualifies as long as it leaves the normalized signal behind. */
export function validateCoverage(plan: Plan): string[] {
  const errors: string[] = [];
  const gate = plan.gates.find((g) => g.name === COVERAGE_GATE);
  if (!gate) errors.push(`missing blocking gate ${COVERAGE_GATE} (runs the test suite with coverage and writes coveragePath)`);
  else if (!gate.blocking) errors.push(`gate ${COVERAGE_GATE} must be blocking`);
  if (!plan.coveragePath) errors.push('coveragePath is required when coverage is required (the path the coverage gate writes {"linesPct": N} to)');
  errors.push(...validateCoverageExemptions(plan));
  return errors;
}
