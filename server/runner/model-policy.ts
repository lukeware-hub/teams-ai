import { MODELS } from '../config/config.js';
import type { Effort } from '../decide/decisions/model-tier.js';

/**
 * Model rules (human, 2026-10-13): Haiku only for terminal commands and small simple code, always at low effort; Sonnet for
 * text and ordinary code, with effort up to high; Opus only for architecture decisions, always at low effort.
 */
const family = (model: string): 'opus' | 'sonnet' | 'haiku' | null => /opus/i.test(model) ? 'opus' : /sonnet/i.test(model) ? 'sonnet' : /haiku/i.test(model) ? 'haiku' : null;

/** The effort a step may use on this model; low when nothing was asked. */
export function effortFor(model: string, effort: Effort | undefined): Effort {
  const asked = effort ?? 'low';
  switch (family(model)) {
    case 'opus':
      return 'low';
    case 'sonnet':
      return asked === 'max' ? 'high' : asked;
    case 'haiku':
      return 'low';
    default:
      return asked;
  }
}

/** Where a step goes when its model has no quota left: only Opus has a lower model that may do its work. */
export const fallbackModel = (model: string): string | undefined => (family(model) === 'opus' ? MODELS.sonnet : undefined);
