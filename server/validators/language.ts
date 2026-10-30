/** Rule 1 of the global rules (code is English): a cheap check over the lines a task adds. The Test reviewer judges each hit. */

export interface LanguageHit {
  file: string;
  /** The line of the new file, or null when the hit is the file name. */
  line: number | null;
  text: string;
}

const HEADER = 'Language check (hints, not proof): these added lines hold Portuguese words or accents, and rule 1 requires English code. Product text, sample data and quoted words are not defects.';
const MAX_FILES = 12;
const MAX_LINES = 3;
const MAX_CHARS = 120;
const MAX_LINE = 400;

/** Owner documents, locale files, snapshots and lock files; the technical spec and the ADRs (docs/adr) are not exempt. */
const EXEMPT_PATH = /^docs\/(project|stack|flow|design|briefing)\.md$|^docs\/specs\/[^/]+\/(?!tech-spec\.md$)|(^|\/)_?(locales?|i18n|l10n|translations?|lang|intl)\/|\.(po|pot|arb|resx|xlf|properties|snap|lock|map)$|(^|\/)(__snapshots__|vendor|node_modules)\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|go\.sum)$/;

/** Portuguese accents: ã, õ and ç anywhere; the others only beside a letter, so a bare accent in a table is not flagged. */
const DIACRITIC = /[ãõçÃÕÇ]|[áàâéêíóôúÁÀÂÉÊÍÓÔÚ][A-Za-z]|[A-Za-z][áàâéêíóôúÁÀÂÉÊÍÓÔÚ]/;

/** Words of Portuguese that English code does not use; matched on whole words, accents removed. */
const PORTUGUESE_WORDS: ReadonlySet<string> = new Set('nao uma como isso esse essa quando onde deve pode quem porque tambem ainda apenas depois muito erro usuario senha arquivo mensagem cliente pedido sucesso criar buscar'.split(' '));

/** A URL or a hash of 7 or more hex digits is not text. */
const URL_OR_HASH = /https?:\/\/\S+|\b[0-9a-f]{7,}\b/gi;
/** A run of 40 letters, digits, `+` or `/` is an encoded blob, and the whole line is skipped. */
const BLOB = /[A-Za-z0-9+\/]{40,}/;

/** True when a line of text holds Portuguese: an accent of the language, or one of its words. */
export function isPortugueseLine(text: string): boolean {
  if (text.length > MAX_LINE || BLOB.test(text)) return false;
  const visible = text.replace(URL_OR_HASH, ' ');
  if (DIACRITIC.test(visible)) return true;
  const words = visible.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z]+/);
  return words.some((word) => PORTUGUESE_WORDS.has(word.toLowerCase()));
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The file a `+++` header names, or null for a deleted file. */
function pathOf(header: string): string | null {
  const name = header.split('\t')[0]!.replace(/^"(.*)"$/, '$1');
  return name === '/dev/null' ? null : name.replace(/^b\//, '');
}

/** The added lines that hold Portuguese, and the new files whose name does. Hunks are read by their counts, so an added `++` line is never a header. */
export function languageHits(diff: string): LanguageHit[] {
  const hits: LanguageHit[] = [];
  let file: string | null = null;
  let isNew = false;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        if (file !== null && isPortugueseLine(line.slice(1))) hits.push({ file, line: newLine, text: line.slice(1).trim() });
        newLeft -= 1;
        newLine += 1;
      } else if (line.startsWith('-')) {
        oldLeft -= 1;
      } else if (!line.startsWith('\\')) {
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      isNew = line === '--- /dev/null';
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = pathOf(line.slice(4));
      const checked = path !== null && !EXEMPT_PATH.test(path);
      if (checked && isNew && isPortugueseLine(path)) hits.push({ file: path, line: null, text: 'file name' });
      file = checked ? path : null;
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLine = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
  return hits;
}

/** Commit messages are text too: rule 1 covers them, so each of their lines is checked. */
function messageHits(messages: string): LanguageHit[] {
  return messages
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && isPortugueseLine(line))
    .map((text) => ({ file: 'commit message', line: null, text }));
}

/** The block the Test reviewer reads, or an empty string when the diff and the commit messages hold no hit. */
export function languageCheck(diff: string, messages = ''): string {
  const byFile = new Map<string, LanguageHit[]>();
  for (const hit of [...languageHits(diff), ...messageHits(messages)]) byFile.set(hit.file, [...(byFile.get(hit.file) ?? []), hit]);
  if (byFile.size === 0) return '';
  const lines = [HEADER];
  for (const [file, hits] of [...byFile].slice(0, MAX_FILES)) {
    for (const hit of hits.slice(0, MAX_LINES)) lines.push(hit.line === null ? `- ${file}: ${hit.text}` : `- ${file}:${hit.line} ${hit.text.slice(0, MAX_CHARS)}`);
    if (hits.length > MAX_LINES) lines.push(`- ${file}: ${hits.length - MAX_LINES} more`);
  }
  if (byFile.size > MAX_FILES) lines.push(`- ${byFile.size - MAX_FILES} more files`);
  return lines.join('\n');
}
