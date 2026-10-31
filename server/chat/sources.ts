export interface WebSource {
  title: string;
  url: string;
}

const MAX_SOURCES = 5;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g;
const BARE_ADDRESS = /https?:\/\/[^\s)\]>]+/g;

/** A title that cannot break the link it sits in. */
const linkTitle = (title: string): string => title.replace(/[[\]()]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'fonte';

/**
 * The answer keeps only the addresses its web search returned, and ends with those as its sources: at most five,
 * secure addresses only. An answer with no search keeps its text as it is.
 */
export function withSources(answer: string, found: readonly WebSource[]): string {
  if (found.length === 0) return answer;
  const allowed = new Set(found.map((s) => s.url));
  const kept = answer.replace(MARKDOWN_LINK, (whole: string, text: string, url: string) => (allowed.has(url) ? whole : text)).replace(BARE_ADDRESS, (url) => (allowed.has(url) ? url : ''));
  const sources = [...new Map(found.filter((s) => s.url.startsWith('https://')).map((s) => [s.url, s])).values()].slice(0, MAX_SOURCES);
  if (sources.length === 0) return kept;
  const links = sources.map((s) => `- [${linkTitle(s.title)}](${s.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`);
  return `${kept.trimEnd()}\n\nFontes da pesquisa:\n${links.join('\n')}`;
}
