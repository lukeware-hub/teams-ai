export type DocSection = { level: number; heading: string; body: string };

/** A Markdown doc as JSON: one section per heading, so each backlog source (doc and heading) finds its text. */
export function docToJson(name: string, text: string): { doc: string; sections: DocSection[] } {
  const sections: DocSection[] = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) fence = !fence;
    const match = fence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) sections.push({ level: match[1]!.length, heading: match[2]!.trim(), body: '' });
    else if (sections.length > 0) sections[sections.length - 1]!.body += `${line}\n`;
  }
  return { doc: name, sections: sections.map((s) => ({ ...s, body: s.body.trim() })) };
}
