import { estimateTokens } from '../knowledge/context-pack.js';
import { PACK_TOKEN_CAP } from './fit-pack.js';
import { docSections } from './sections.js';

/** How much of each section a digest keeps, from the most to the least; a digest of headings alone is the last resort. */
const EXCERPT_CHARS = [1500, 600, 250, 100, 0] as const;
/** Room left for what the pack carries besides the docs and for the contract and principles added around it. */
const MARGIN_TOKENS = 10_000;
/** A pack with a huge rest still shows the docs this much. */
const MIN_DOCS_TOKENS = 20_000;
/** Past this the docs become a digest even when they would fit the cap, since every step of every cycle pays for them. */
export const MAX_DOCS_TOKENS = 70_000;

export const DIGEST_NOTE = 'The documents below are a digest, because the whole text does not fit one evaluation: every heading as written, each followed by the start of its section and "[…]" where it was cut. Cite headings exactly as they appear; never assume what an excerpt does not show.';

/** Every heading of the doc as written, each with the first `chars` characters of the lines under it, up to the next heading. */
export function docDigest(doc: string, chars: number): string {
  const lines = doc.split(/\r?\n/);
  const starts = docSections(doc).map((s) => s.line);
  const part = (from: number, to: number, withHeading: boolean) => {
    const body = lines.slice(withHeading ? from + 1 : from, to).join('\n').trim();
    const excerpt = body.length > chars ? `${body.slice(0, chars).trimEnd()} […]` : body;
    return [...(withHeading ? [lines[from]!] : []), ...(chars > 0 && excerpt !== '' ? [excerpt] : [])].join('\n');
  };
  const blocks = starts.map((from, i) => part(from, starts[i + 1] ?? lines.length, true));
  if ((starts[0] ?? lines.length) > 0) blocks.unshift(part(0, starts[0] ?? lines.length, false));
  return blocks.filter((b) => b !== '').join('\n\n');
}

type Docs<K extends string> = Record<K, string | undefined>;

/** The docs whole when they fit `budgetTokens`, else each as the longest digest that makes all of them fit. */
export function viewDocs<K extends string>(docs: Docs<K>, budgetTokens: number): { docs: Docs<K>; digested: boolean } {
  const tokens = (d: Docs<K>) => Object.values<string | undefined>(d).reduce((sum, text) => sum + estimateTokens(text ?? ''), 0);
  if (tokens(docs) <= budgetTokens) return { docs, digested: false };
  let view = docs;
  for (const chars of EXCERPT_CHARS) {
    view = Object.fromEntries(Object.entries<string | undefined>(docs).map(([k, v]) => [k, v === undefined ? v : docDigest(v, chars)])) as Docs<K>;
    if (tokens(view) <= budgetTokens) break;
  }
  return { docs: view, digested: true };
}

/**
 * `build` writes a pack's feedback from the docs it is given and whether they are a digest. The docs get what the rest of
 * the feedback leaves under `cap`: whole when they fit, so a project that fits today reads the same text, else a digest.
 */
export function buildWithDocs<K extends string>(docs: Docs<K>, build: (docs: Docs<K>, digested: boolean) => string, cap = PACK_TOKEN_CAP): string {
  const blank = Object.fromEntries(Object.entries<string | undefined>(docs).map(([k, v]) => [k, v === undefined ? v : ''])) as Docs<K>;
  const rest = estimateTokens(build(blank, false));
  const view = viewDocs(docs, Math.min(MAX_DOCS_TOKENS, Math.max(MIN_DOCS_TOKENS, cap - MARGIN_TOKENS - rest)));
  return build(view.docs, view.digested);
}
