const WEB_ADDRESS = /https?:\/\/\S+/g;
const MASKED = /\u0000(\d+)\u0000/g;

/** Removes criterion and task codes, which a lay reader cannot use; a web address stays whole. */
export function withoutCodes(text: string): string {
  const addresses: string[] = [];
  const masked = text.replace(WEB_ADDRESS, (address) => `\u0000${addresses.push(address) - 1}\u0000`);
  const plain = masked
    .replace(/\[?\b(?:AC-\d+|T\d+(?:-[a-z0-9]+)*)\b\]?/g, '')
    .replace(/\(\s*[,;]?\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  return plain.replace(MASKED, (_, index: string) => addresses[Number(index)]!);
}

const omittedMark = (omitted: number): string => `[… ${omitted} caracteres omitidos …]`;

/** Keeps the head and the tail of a long text with a mark of what was left out; the result never goes past `max`. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  // The mark states how much it left out, so its own length depends on the kept size: settle on a size that fits.
  let kept = Math.max(0, max - omittedMark(text.length).length);
  for (let i = 0; i < 5; i++) kept = Math.max(0, max - omittedMark(text.length - kept).length);
  const head = Math.floor(kept * 0.4);
  const tail = kept - head;
  const out = `${text.slice(0, head)}${omittedMark(text.length - kept)}${tail > 0 ? text.slice(-tail) : ''}`;
  return out.length <= max ? out : out.slice(0, max);
}
