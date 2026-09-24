export interface Chunk {
  id: string;
  docId: string;
  ordinal: number;
  heading: string | null;
  text: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;

/** Heading-aware chunking: one chunk per section, long sections split at blank lines. Ids are stable for a given text. */
export function chunkMarkdown(docId: string, text: string, opts: { maxChars?: number } = {}): Chunk[] {
  const max = opts.maxChars ?? 1200;
  const sections: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(HEADING);
    if (m) sections.push({ heading: m[2]!.trim(), lines: [line] });
    else sections[sections.length - 1]!.lines.push(line);
  }
  const pieces: Array<{ heading: string | null; text: string }> = [];
  for (const s of sections) {
    const body = s.lines.join('\n').trim();
    if (body === '') continue;
    // A heading with no body carries no information; skip it so it never ranks as a hit.
    if (s.heading !== null && s.lines.slice(1).join('\n').trim() === '') continue;
    if (body.length <= max) {
      pieces.push({ heading: s.heading, text: body });
      continue;
    }
    let current = '';
    for (const para of body.split(/\n\s*\n/)) {
      const candidate = current === '' ? para : `${current}\n\n${para}`;
      if (candidate.length > max && current !== '') {
        pieces.push({ heading: s.heading, text: current.trim() });
        current = para;
      } else {
        current = candidate;
      }
    }
    if (current.trim() !== '') pieces.push({ heading: s.heading, text: current.trim() });
  }
  return pieces.map((p, ordinal) => ({ id: `${docId}#${ordinal}`, docId, ordinal, heading: p.heading, text: p.text }));
}
