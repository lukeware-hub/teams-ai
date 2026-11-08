import { DEFAULT_EFFORT_CAPS, type EffortCaps } from '../config/config.js';
import { EFFORT_LEVELS, type Effort } from '../decide/decisions/model-tier.js';

/**
 * Model rules (human, 2026-10-13), as the defaults: Haiku only for terminal commands and small simple code, at low effort; Sonnet for
 * text and ordinary code, with effort up to high; Opus only for architecture decisions, at low effort. Settings sets the caps.
 */
const family = (model: string): 'opus' | 'sonnet' | 'haiku' | null => /opus/i.test(model) ? 'opus' : /sonnet/i.test(model) ? 'sonnet' : /haiku/i.test(model) ? 'haiku' : null;

/** The effort a step may use on this model: what was asked, or the fallback when nothing was, held to the family's cap, which Settings sets. */
export function effortFor(model: string, effort: Effort | undefined, fallback: Effort, caps: EffortCaps = DEFAULT_EFFORT_CAPS): Effort {
  const asked = effort ?? fallback;
  const fam = family(model);
  if (fam === null) return asked;
  const cap = caps[fam];
  return EFFORT_LEVELS.indexOf(asked) <= EFFORT_LEVELS.indexOf(cap) ? asked : cap;
}
