import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';
import { AC_ID, HASH_PATTERN } from './patterns.js';

/** Pre-plan task ids (P1, P2 ...) never look like the run plan's task ids (T0-scaffold ...). */
export const PREPLAN_TASK_ID = /^P\d+$/;

export const PreplanModule = z.object({ name: z.string().min(1), purpose: z.string().min(1) });

export const PreplanTask = z.object({
  id: z.string().regex(PREPLAN_TASK_ID),
  title: z.string().min(1),
  module: z.string().min(1),
  owner: z.enum(['dev', 'devops', 'front']),
  /** Every task exists for at least one acceptance criterion of its spec. */
  criteriaRefs: z.array(z.string().regex(AC_ID)).min(1),
  dependsOn: z.array(z.string().regex(PREPLAN_TASK_ID)),
});
export type PreplanTask = z.infer<typeof PreplanTask>;

export const PreplanRisk = z.object({ risk: z.string().min(1), mitigation: z.string().min(1) });

/**
 * The SM's pre-plan of one backlog spec, made during refinement and reviewed with it (`preplan.json`, never `plan.json`:
 * the run reuses a plan.json on main as its real plan). The real plan is still made at execution against the code.
 * Browser-safe: no node: imports, so the refinement screen parses it too.
 */
export const Preplan = z.object({
  specId: z.string().regex(ID_PATTERNS.SLUG),
  /** The hash of the spec it planned: once the spec changes, the pre-plan is stale. */
  specRev: z.string().regex(HASH_PATTERN),
  inputHash: z.string().regex(HASH_PATTERN),
  modules: z.array(PreplanModule).min(1).max(8),
  tasks: z.array(PreplanTask).min(1).max(12),
  risks: z.array(PreplanRisk).max(5),
});
export type Preplan = z.infer<typeof Preplan>;
