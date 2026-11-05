import type { PlanTask } from '../contracts/plan.js';
import type { Spec } from '../contracts/spec.js';
import type { TaskState } from '../pipeline/task-state.js';
import type { TestResult } from './junit.js';

/** `deferred`: the criterion's tests are post-deploy suites (e2e, smoke), merged but not run before deploy. */
export type EvidenceStatus = 'passed' | 'failed' | 'missing' | 'blocked' | 'deferred';

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
  /** True for a task that only writes post-deploy suites; its criteria get their evidence in Phase 5. */
  postDeploy?: (task: PlanTask) => boolean,
): EvidenceRow[] {
  const live = [...tasks].filter((t) => t.state !== 'superseded');
  return spec.acceptanceCriteria.map((ac) => {
    const owners = live.filter((t) => t.def.criteriaRefs.includes(ac.id));
    const tests = results.filter((r) => r.status !== 'skipped' && r.acIds.includes(ac.id));
    let status: EvidenceStatus;
    if (tests.some((r) => r.status === 'failed')) status = 'failed';
    else if (tests.length > 0) status = 'passed';
    else if (owners.length > 0 && owners.every((t) => t.state === 'blocked')) status = 'blocked';
    else if (postDeploy && owners.length > 0 && owners.every((t) => t.state === 'merged' && postDeploy(t.def))) status = 'deferred';
    else status = 'missing';
    return { criterion: ac.id, tasks: owners.map((t) => t.def.id), tests: tests.map((r) => r.id), status };
  });
}

/** Adds the Phase 5 e2e rows to the matrix per criterion (the matrix itself is built before deploy). */
export function attachE2e(rows: readonly EvidenceRow[], e2e: ReadonlyArray<{ acId: string; status: NonNullable<EvidenceRow['e2e']>; reason?: string }> | undefined): EvidenceRow[] {
  return rows.map((r) => {
    const e = e2e?.find((x) => x.acId === r.criterion);
    // The e2e run is the evidence of a deferred row; without it, or with an exemption, the criterion has none.
    const status = r.status === 'deferred' ? (e && e.status !== 'not-applicable' ? e.status : 'missing') : r.status;
    return e ? { ...r, status, e2e: e.status, ...(e.reason ? { e2eReason: e.reason } : {}) } : { ...r, status };
  });
}

export function evidenceGate(results: readonly TestResult[]): string[] {
  if (results.length === 0) return ['JUnit report contains no test cases'];
  if (results.every((r) => r.status === 'skipped')) return ['JUnit report contains no executed tests'];
  return [];
}

/** Every criterion passed or waits for the post-deploy suites; a blocked one is not ready, since the code it needs never reached main. */
export function readyForValidation(rows: readonly EvidenceRow[]): boolean {
  return rows.every((r) => r.status === 'passed' || r.status === 'deferred');
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
