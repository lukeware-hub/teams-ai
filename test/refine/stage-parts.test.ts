import { describe, expect, it } from 'vitest';
import { stageParts } from '../../server/refine/stage-parts.js';

const section = (name: string, body: string) => `## ${name}\n${body}\n`;

describe('stageParts', () => {
  it('keeps a small document in one part, the document itself', () => {
    const doc = section('Um', 'texto curto');
    expect(stageParts(doc, 25_000)).toEqual([doc]);
  });

  it('gives an empty document one empty part', () => {
    expect(stageParts('', 25_000)).toEqual(['']);
  });

  it('joins the parts back into the document, byte for byte', () => {
    const doc = `intro\n${section('A', 'a'.repeat(380))}${section('B', 'b'.repeat(380))}${section('C', 'c'.repeat(380))}`;
    expect(stageParts(doc, 220).join('\n')).toBe(doc);
  });

  it('packs whole sections into a part, and cuts before the heading that does not fit', () => {
    const a = section('A', 'a'.repeat(380));
    const b = section('B', 'b'.repeat(380));
    const c = section('C', 'c'.repeat(380));
    const parts = stageParts(a + b + c, 220);
    expect(parts).toHaveLength(2);
    // The parts are joined with a newline, so the first one gives up the newline that ends its last line.
    expect(parts[0]).toBe((a + b).slice(0, -1));
    expect(parts[1]).toBe(c);
  });

  it('cuts a section too big for one part between its lines', () => {
    const body = `${'l'.repeat(99)}\n`.repeat(30);
    const doc = section('Grande', body);
    const parts = stageParts(doc, 300);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(Math.ceil(part.length / 4)).toBeLessThanOrEqual(300);
    expect(parts.join('\n')).toBe(doc);
  });

  it('keeps a single line bigger than the limit alone, in its own part', () => {
    const doc = `${'x'.repeat(5_000)}`;
    expect(stageParts(doc, 100)).toEqual([doc]);
  });
});
