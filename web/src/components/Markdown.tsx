import type { ReactNode } from 'react';
import { safeHttpUrl } from '../safeUrl.js';

// Small, dependency-free renderer for the README subset the report step produces. Everything becomes
// React elements (no raw HTML), and only http(s) links are followed.
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) return safeHttpUrl(link[2]) ? <a key={i} href={safeHttpUrl(link[2])} target="_blank" rel="noreferrer">{link[1]}</a> : <span key={i}>{link[1]}</span>;
    return part;
  });
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') { i++; continue; }
    const fence = /^```/.exec(line);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      i++;
      blocks.push(<pre key={blocks.length}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const Tag = `h${Math.min(heading[1]!.length + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(<Tag key={blocks.length}>{inline(heading[2]!)}</Tag>);
      i++;
      continue;
    }
    const list = /^\s*([-*]|\d+\.)\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]!);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]!); i++) items.push(lines[i]!.replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={blocks.length}>{items.map((item, n) => <li key={n}>{inline(item)}</li>)}</Tag>);
      continue;
    }
    const paragraph: string[] = [];
    for (; i < lines.length && lines[i]!.trim() !== '' && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s+)/.test(lines[i]!); i++) paragraph.push(lines[i]!);
    blocks.push(<p key={blocks.length}>{inline(paragraph.join(' '))}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}
