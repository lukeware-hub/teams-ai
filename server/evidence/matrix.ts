import type { PlanTask } from '../contracts/plan.js';
import type { Spec } from '../contracts/spec.js';
import type { TaskState } from '../pipeline/task-state.js';
import type { TestResult } from './junit.js';

export type EvidenceStatus = 'passed' | 'failed' | 'missing' | 'blocked';

export interface EvidenceRow {
  criterion: string;
  tasks: string[];
  tests: string[];
  status: EvidenceStatus;
  /** Post-deploy e2e result for this criterion (roadmap R8.4); absent before deploy or for runs without e2e. */
  e2e?: 'passed' | 'failed' | 'missing' | 'not-applicable';
  /** Why the criterion has no e2e test (e2e: not-applicable). */
  e2eReason?: string;
}

export interface EvidenceTask {
  def: PlanTask;
  state: TaskState;
}

export function buildEvidenceMatrix(
  spec: Spec,
  tasks: Iterable<EvidenceTask>,
  results: readonly TestResult[],
): EvidenceRow[] {
  const live = [...tasks].filter((t) => t.state !== 'superseded');
  return spec.acceptanceCriteria.map((ac) => {
    const owners = live.filter((t) => t.def.criteriaRefs.includes(ac.id));
    const tests = results.filter((r) => r.status !== 'skipped' && r.acIds.includes(ac.id));
    let status: EvidenceStatus;
    if (tests.some((r) => r.status === 'failed')) status = 'failed';
    else if (tests.length > 0) status = 'passed';
    else if (owners.length > 0 && owners.every((t) => t.state === 'blocked')) status = 'blocked';
    else status = 'missing';
    return { criterion: ac.id, tasks: owners.map((t) => t.def.id), tests: tests.map((r) => r.id), status };
  });
}

/** Adds the Phase 5 e2e rows to the matrix per criterion (the matrix itself is built before deploy). */
export function attachE2e(rows: readonly EvidenceRow[], e2e: ReadonlyArray<{ acId: string; status: NonNullable<EvidenceRow['e2e']>; reason?: string }> | undefined): EvidenceRow[] {
  if (!e2e) return [...rows];
  return rows.map((r) => {
    const e = e2e.find((x) => x.acId === r.criterion);
    return e ? { ...r, e2e: e.status, ...(e.reason ? { e2eReason: e.reason } : {}) } : r;
  });
}

export function evidenceGate(results: readonly TestResult[]): string[] {
  if (results.length === 0) return ['JUnit report contains no test cases'];
  if (results.every((r) => r.status === 'skipped')) return ['JUnit report contains no executed tests'];
  return [];
}

export function readyForValidation(rows: readonly EvidenceRow[]): boolean {
  return rows.every((r) => r.status === 'passed' || r.status === 'blocked');
}

/** What the Test agent claims about one acceptance criterion in its review. */
export interface EvidenceClaim {
  id: string;
  status: 'passed' | 'failed' | 'not-covered';
  evidence: string[];
}

/**
 * Cross-checks the Test agent's claims against the real JUnit results. A claim of
 * `passed` needs at least one cited test, every cited test must exist, be tagged
 * with the criterion and have passed. Agents never mark evidence passed on their own.
 */
export function verifyClaimedEvidence(claims: readonly EvidenceClaim[], results: readonly TestResult[]): string[] {
  const byId = new Map<string, TestResult[]>();
  for (const r of results) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  const errors: string[] = [];
  for (const claim of claims) {
    for (const testId of claim.evidence) {
      const matches = byId.get(testId) ?? [];
      if (matches.length === 0) {
        errors.push(`${claim.id}: cited test not found in JUnit report: ${testId}`);
        continue;
      }
      if (matches.length > 1) errors.push(`${claim.id}: cited test id is ambiguous in the JUnit report: ${testId}`);
      const result = matches[0]!;
      if (!result.acIds.includes(claim.id)) errors.push(`${claim.id}: cited test is not tagged with this criterion: ${testId}`);
    }
    if (claim.status === 'passed') {
      if (claim.evidence.length === 0) errors.push(`${claim.id}: claimed passed without evidence`);
      // Any non-skipped test tagged with the criterion that failed contradicts the claim, cited or not.
      for (const r of results) {
        if (r.status === 'failed' && r.acIds.includes(claim.id)) errors.push(`${claim.id}: claimed passed but ${r.id} is ${r.status}`);
      }
    }
  }
  return errors;
}
