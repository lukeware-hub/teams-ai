import type { AcceptanceCriterion } from './api.js';

// Agents often write the keyword inside the part ("Dado que ..."); drop it so the sentence never repeats it.
const part = (text: string, keyword: string) => text.replace(new RegExp(`^${keyword}\\s+`, 'i'), '').trim();

/** One criterion as a sentence: "dado ..., quando ..., então ...". */
export const criterionSentence = (c: AcceptanceCriterion) => `dado ${part(c.given, 'dado')}, quando ${part(c.when, 'quando')}, então ${part(c.then, 'então')}`;
