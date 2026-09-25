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
  consistent: boolean | null;
  confidence: number | null;
  model: string | null;
}

/** Runs a lightweight Jev consistency check before Claude derives the specification. */
export function createJevValidator(cfg: Config, secrets: () => Promise<Record<string, string>>): (docs: ValidationDocs) => Promise<JevValidationResult> {
  return async (docs) => {
    const values = await secrets();
    const key = values.OPENROUTER_API_KEY;
    if (!key) return { available: false, consistent: null, confidence: null, model: null };
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
    const result = await jev.evaluate({
      state: `project.md:\n${docs.project}\n\nbriefing.md:\n${docs.briefing}\n\nstack.md:\n${docs.stack}\n\nflow.md:\n${docs.flow}`,
      questions: {
        consistent: {
          type: 'noul',
          instructions: 'Are these four Markdown documents mutually consistent and complete as a business and application specification? Check that the flow covers the requirements, validation, persistence, responses, errors, and health behavior described by the other documents.',
        },
      },
      escalateTo: 'po',
    });
    if (!result.ok) return { available: false, consistent: null, confidence: null, model: null };
    const answer = result.answers.consistent;
    return answer?.type === 'noul'
      ? { available: true, consistent: answer.value >= 0.8, confidence: answer.confidence, model: result.model }
      : { available: true, consistent: null, confidence: null, model: result.model };
  };
}
