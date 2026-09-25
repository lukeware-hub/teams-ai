import { redactSecrets } from '../core/redact.js';
import { JevOpenRouterBackend } from '../decide/jev-openrouter.js';
import type { Config } from '../config/config.js';

export interface ValidationDocs {
  project: string;
  briefing: string;
  stack: string;
  flow: string;
}

export interface JevValidationResult {
  available: boolean;
  decision: 'approved' | 'review' | 'blocked';
  consistent: boolean | null;
  confidence: number | null;
  model: string | null;
  checks: Record<string, number>;
  stateTruncated: boolean;
}

const MAX_STATE_CHARS = 24_000;
const CHECKS = {
  documents_consistent: {
    instructions: 'Do project.md, briefing.md, stack.md, and flow.md agree without a material contradiction?',
    yes: 'All four documents describe the same product, scope, constraints, and behavior.',
    no: 'At least one document contradicts another about a required product or behavior.',
  },
  flow_covers_scope: {
    instructions: 'Does flow.md cover every in-scope business and application flow required by project.md and briefing.md?',
    yes: 'The flow describes all required user and system paths, including the normal and failure paths.',
    no: 'One or more in-scope features or paths are missing from flow.md.',
  },
  validation_aligned: {
    instructions: 'Are the input validation rules in the four documents explicit and aligned?',
    yes: 'Required fields, formats, limits, uniqueness, and invalid-input behavior agree across the documents.',
    no: 'Validation rules are missing, ambiguous, or contradictory across the documents.',
  },
  persistence_aligned: {
    instructions: 'Is persistence behavior explicit and aligned across the four documents?',
    yes: 'Storage location, write behavior, error handling, and restart or recreation behavior agree.',
    no: 'Persistence or data-safety behavior is missing, ambiguous, or contradictory.',
  },
  responses_aligned: {
    instructions: 'Are success responses, errors, routes, and interface behavior explicit and aligned?',
    yes: 'The documents agree on operations, routes, status codes, returned data, and error behavior.',
    no: 'Routes, status codes, returned data, or error behavior are missing or contradictory.',
  },
  health_aligned: {
    instructions: 'Is the health check behavior explicit and aligned across the four documents?',
    yes: 'The health route, response, port, and deployment verification behavior agree.',
    no: 'Health or deployment verification behavior is missing, ambiguous, or contradictory.',
  },
} as const;

export function summarizeJevChecks(checks: Record<string, number>, model: string | null, stateTruncated = false): JevValidationResult {
  const values = Object.values(checks).filter((value) => Number.isFinite(value));
  if (values.length === 0) return { available: true, decision: 'review', consistent: null, confidence: null, model, checks, stateTruncated };
  const weakest = Math.min(...values);
  const decision = weakest < 0.5 ? 'blocked' : weakest < 0.8 ? 'review' : 'approved';
  return {
    available: true,
    decision,
    consistent: decision === 'approved',
    confidence: Math.min(...values.map((value) => Math.max(value, 1 - value))),
    model,
    checks,
    stateTruncated,
  };
}

const unavailable = (): JevValidationResult => ({ available: false, decision: 'review', consistent: null, confidence: null, model: null, checks: {}, stateTruncated: false });

/** Runs independent Jev consistency checks before Claude derives the specification. */
export function createJevValidator(cfg: Config, secrets: () => Promise<Record<string, string>>): (docs: ValidationDocs) => Promise<JevValidationResult> {
  return async (docs) => {
    const values = await secrets();
    const key = values.OPENROUTER_API_KEY;
    if (!key) return unavailable();
    const o = cfg.decisions.openrouter;
    const jev = new JevOpenRouterBackend({
      fetch: globalThis.fetch,
      apiKey: key,
      baseUrl: o.baseUrl,
      model: o.model,
      timeoutMs: o.timeoutMs,
      maxTries: o.maxTries,
      backoffMs: o.backoffMs,
      sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const rawState = `project.md:\n${docs.project}\n\nbriefing.md:\n${docs.briefing}\n\nstack.md:\n${docs.stack}\n\nflow.md:\n${docs.flow}`;
    const sanitizedState = redactSecrets(rawState, Object.values(values));
    const stateTruncated = sanitizedState.length > MAX_STATE_CHARS;
    const state = `${sanitizedState.slice(0, MAX_STATE_CHARS)}${stateTruncated ? '\n[... state truncated ...]' : ''}`;
    const questions = Object.fromEntries(Object.entries(CHECKS).map(([id, check]) => [id, {
      type: 'noul' as const,
      instructions: check.instructions,
      criteria: { true: check.yes, false: check.no },
    }]));
    const result = await jev.evaluate({ state, questions, escalateTo: 'po' });
    if (!result.ok) return unavailable();
    const checks: Record<string, number> = {};
    for (const id of Object.keys(CHECKS)) {
      const answer = result.answers[id];
      if (!answer || answer.type !== 'noul') return { ...unavailable(), model: result.model, stateTruncated };
      checks[id] = answer.value;
    }
    return summarizeJevChecks(checks, result.model, stateTruncated);
  };
}
