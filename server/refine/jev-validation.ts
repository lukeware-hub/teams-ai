import { redactSecrets } from '../core/redact.js';
import { splitSections } from '../decide/windows.js';
import { JevOpenRouterBackend } from '../decide/jev-openrouter.js';
import type { Config } from '../config/config.js';

export interface ValidationDocs {
  project: string;
  briefing: string;
  stack: string;
  flow: string;
  design: string;
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

export const MAX_STATE_CHARS = 32_000;
const CHECKS = {
  documents_consistent: {
    instructions: 'Do project.md, briefing.md, stack.md, flow.md, and design.md agree without a material contradiction?',
    yes: 'All five documents describe the same product, scope, constraints, and behavior.',
    no: 'At least one document contradicts another about a required product or behavior.',
  },
  flow_covers_scope: {
    instructions: 'Does flow.md cover every in-scope business and application flow required by project.md and briefing.md?',
    yes: 'The flow describes all required user and system paths, including the normal and failure paths.',
    no: 'One or more in-scope features or paths are missing from flow.md.',
  },
  validation_aligned: {
    instructions: 'Are the input validation rules in the five documents explicit and aligned?',
    yes: 'Required fields, formats, limits, uniqueness, and invalid-input behavior agree across the documents.',
    no: 'Validation rules are missing, ambiguous, or contradictory across the documents.',
  },
  persistence_aligned: {
    instructions: 'Is persistence behavior explicit and aligned across the five documents?',
    yes: 'Storage location, write behavior, error handling, and restart or recreation behavior agree.',
    no: 'Persistence or data-safety behavior is missing, ambiguous, or contradictory.',
  },
  responses_aligned: {
    instructions: 'Are success responses, errors, routes, and interface behavior explicit and aligned?',
    yes: 'The documents agree on operations, routes, status codes, returned data, and error behavior.',
    no: 'Routes, status codes, returned data, or error behavior are missing or contradictory.',
  },
  health_aligned: {
    instructions: 'Is the health check behavior explicit and aligned across the five documents?',
    yes: 'The health route, response, port, and deployment verification behavior agree.',
    no: 'Health or deployment verification behavior is missing, ambiguous, or contradictory.',
  },
} as const;

/** The checks of a stage's preflight: the documents agree, and the stage document covers what the documents before it require of it. */
export const stageChecks = (stage: string): Record<string, { instructions: string; yes: string; no: string }> => ({
  documents_consistent: CHECKS.documents_consistent,
  covers_earlier: {
    instructions: `Does ${stage} cover everything the documents before it require of it?`,
    yes: `${stage} holds every part the documents before it require of it.`,
    no: `${stage} misses a part the documents before it require of it.`,
  },
});

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

/** The documents cut at line breaks into windows of at most `max` characters; a window that starts mid-document says which one. */
export const splitWindows = (docs: ValidationDocs, max: number): string[] =>
  splitSections((['project', 'briefing', 'stack', 'flow', 'design'] as const).map((name) => ({ title: `${name}.md`, text: docs[name] })), max);

/** What the reviewers read of the Jev: its scores as a hint, never a verdict. */
export function jevHint(validation?: JevValidationResult): string {
  const scores = Object.entries(validation?.checks ?? {}).map(([id, score]) => `${id} ${score.toFixed(2)}`);
  return scores.length ? `Automatic and often wrong, never a verdict. Scores (probability of yes): ${scores.join(', ')}.` : '(not available)';
}

export const unavailable = (): JevValidationResult => ({ available: false, decision: 'review', consistent: null, confidence: null, model: null, checks: {}, stateTruncated: false });

/** The Jev over OpenRouter, configured as the decisions are. */
export function openJev(cfg: Config, apiKey: string): JevOpenRouterBackend {
  const o = cfg.decisions.openrouter;
  return new JevOpenRouterBackend({
    fetch: globalThis.fetch,
    apiKey,
    baseUrl: o.baseUrl,
    model: o.model,
    timeoutMs: o.timeoutMs,
    maxTries: o.maxTries,
    backoffMs: o.backoffMs,
    sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

/** Tells the Jev which part of the documents it sees, when they come in more than one window; empty for a single window. */
export function windowNote(part: number, parts: number): string {
  return parts > 1 ? `You see part ${part} of ${parts} of the documents. Judge only what is in this part and do not penalize what lies outside it. ` : '';
}

/** Tells the Jev which documents exist yet when some are still empty; empty when all five are written. */
export function absentDocsNote(docs: ValidationDocs): string {
  const names = ['project', 'briefing', 'stack', 'flow', 'design'] as const;
  const present = names.filter((n) => docs[n].trim() !== '');
  if (present.length === names.length) return '';
  return `Only these documents exist yet: ${present.map((n) => `${n}.md`).join(', ') || 'none'}. Judge only them and do not penalize a document that does not exist yet. `;
}

/** Runs independent Jev consistency checks before Claude derives the specification. */
export function createJevValidator(cfg: Config, secrets: () => Promise<Record<string, string>>): (docs: ValidationDocs, stage?: string) => Promise<JevValidationResult> {
  return async (docs, stage) => {
    const values = await secrets();
    const key = values.OPENROUTER_API_KEY;
    if (!key) return unavailable();
    const jev = openJev(cfg, key);
    const secretValues = Object.values(values);
    const clean = Object.fromEntries(Object.entries(docs).map(([name, text]) => [name, redactSecrets(text, secretValues)])) as unknown as ValidationDocs;
    const windows = splitWindows(clean, MAX_STATE_CHARS);
    // Each window sees only part of the documents, so a check must not fail for what lies outside it.
    const scope = (part: number) => `${windowNote(part, windows.length)}${absentDocsNote(clean)}`;
    const definitions: Record<string, { instructions: string; yes: string; no: string }> = stage ? stageChecks(stage) : CHECKS;
    const results = await Promise.all(windows.map((state, i) => jev.evaluate({
      state,
      questions: Object.fromEntries(Object.entries(definitions).map(([id, check]) => [id, {
        type: 'noul' as const,
        instructions: scope(i + 1) + check.instructions,
        criteria: { true: check.yes, false: check.no },
      }])),
      escalateTo: 'po',
    })));
    const answered = results.flatMap((r) => (r.ok ? [r] : []));
    if (answered.length < results.length) return unavailable();
    const model = answered[0]!.model;
    const checks: Record<string, number> = {};
    for (const id of Object.keys(definitions)) {
      const scores = answered.map((r) => r.answers[id]);
      if (scores.some((a) => a?.type !== 'noul')) return { ...unavailable(), model };
      // A contradiction in any window fails the consistency check; a topic check passes when some window covers it.
      const pick = id === 'documents_consistent' ? Math.min : Math.max;
      checks[id] = pick(...scores.map((a) => (a as { value: number }).value));
    }
    return summarizeJevChecks(checks, model);
  };
}
