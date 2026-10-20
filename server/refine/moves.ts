import { sha256 } from '../contracts/hash.js';
import { decisionsSpan } from './decisions.js';
import type { DocFile } from './draft.js';
import { count, docOf } from './patches.js';
import type { MoveRow } from './state.js';

/** A move quotes at most this many characters: a longer one rewrites a section, it does not move it. */
export const MAX_MOVE_QUOTE = 2000;
const DECISIONS_HEADING = /^##\s+(Decisões|Decisions)\s*$/m;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;
const FACT = /`[^`]+`|\d+(?:[.,]\d+)*/g;
const CODE_BLOCK = /^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm;

/** The text with `quote` cut out, and where it was, so undo can put it back. */
export interface Cut {
  next: string;
  removedAt: number;
  removed: string;
}

/** The text with `block` added, and where it went, so undo can take it out again. */
export interface Put {
  next: string;
  insertAt: number;
  inserted: string;
}

/** `quote` cut out of `text` as whole lines; null unless it occurs once and starts and ends at a line break. */
export function cutLines(text: string, quote: string): Cut | null {
  if (count(text, quote) !== 1) return null;
  const start = text.indexOf(quote);
  const end = start + quote.length;
  if ((start > 0 && text[start - 1] !== '\n') || (end < text.length && text[end] !== '\n')) return null;
  // The line break after the quote goes with it; at the end of the text, the one before it does.
  const from = end < text.length ? start : Math.max(start - 1, 0);
  let to = end < text.length ? end + 1 : end;
  // Between two blank lines one blank line goes too, so the gap does not double.
  if (text[from - 2] === '\n' && text[from - 1] === '\n' && text[to] === '\n') to += 1;
  return { next: text.slice(0, from) + text.slice(to), removedAt: from, removed: text.slice(from, to) };
}

/** `block` added below the line `after`, or at the end when `after` is absent; null when `after` is not one whole line found once. */
export function insertBlock(text: string, block: string, after?: string): Put | null {
  // A block that is already a whole run of lines in the text is not added twice.
  if (`\n${text}\n`.includes(`\n${block}\n`)) return { next: text, insertAt: 0, inserted: '' };
  if (after === undefined) {
    const sep = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    const inserted = `${sep}${block}\n`;
    return { next: text + inserted, insertAt: text.length, inserted };
  }
  if (count(text, after) !== 1) return null;
  const start = text.indexOf(after);
  const at = start + after.length;
  if ((start > 0 && text[start - 1] !== '\n') || (at < text.length && text[at] !== '\n')) return null;
  const rest = text.slice(at);
  // Items of one list stay together; any other block is set apart by blank lines.
  if (LIST_ITEM.test(after) && LIST_ITEM.test(block)) return { next: text.slice(0, at) + `\n${block}` + rest, insertAt: at, inserted: `\n${block}` };
  // A blank line already follows the anchor; otherwise the block gets one before the next line.
  const inserted = at === text.length || rest.startsWith('\n\n') ? `\n\n${block}` : `\n\n${block}\n`;
  return { next: text.slice(0, at) + inserted + rest, insertAt: at, inserted };
}

/** True when [from, to) touches a fenced code block, its fence lines included: a move never cuts from one or adds into one. */
function inCodeBlock(text: string, from: number, to: number): boolean {
  return [...text.matchAll(CODE_BLOCK)].some((m) => from < (m.index ?? 0) + m[0].length && to > (m.index ?? 0));
}

/** The first number or backticked name of `quote` that `text` does not keep; numbers and names are facts a move must not lose. */
function droppedFact(quote: string, text: string): string | undefined {
  const lines = quote.split('\n').map((line) => line.replace(LIST_ITEM, '')).join('\n');
  return [...lines.matchAll(FACT)].map((m) => m[0].replace(/`/g, '')).find((fact) => !text.includes(fact));
}

/** A move as a role proposes it: a path, a quote copied from `from`, the text written for `to`, and an optional anchor line in `to`. */
export interface MoveInput {
  from: string;
  to: string;
  quote: string;
  text: string;
  after?: string;
  reason: string;
}

export interface MoveContext {
  specId: string;
  projectBriefing: boolean;
  docs: Partial<Record<DocFile, string>>;
  /** Blank templates: no move reads from or writes to one, since the SM fills it first. */
  blank: ReadonlySet<DocFile>;
  /** Moves already applied: their text is not moved again, so content never bounces between documents. */
  applied: ReadonlyArray<Pick<MoveRow, 'text'>>;
  /** Moves the owner undid: the same move is not proposed again. */
  undone: ReadonlyArray<Pick<MoveRow, 'from' | 'to' | 'quote'>>;
}

export type MovePlan = { ok: true; from: DocFile; to: DocFile; cut: Cut; put: Put } | { ok: false; reason: string };

/** Checks a proposed move against the documents as they are now and returns what it would change; nothing is written. */
export function planMove(move: MoveInput, ctx: MoveContext): MovePlan {
  const refuse = (reason: string): MovePlan => ({ ok: false, reason });
  const from = docOf(move.from, ctx.specId, ctx.projectBriefing);
  const to = docOf(move.to, ctx.specId, ctx.projectBriefing);
  if (!from) return refuse(`arquivo desconhecido ${move.from}`);
  if (!to) return refuse(`arquivo desconhecido ${move.to}`);
  if (from === to) return refuse('o movimento precisa de dois documentos diferentes');
  const fromText = ctx.docs[from];
  const toText = ctx.docs[to];
  if (fromText === undefined || toText === undefined) return refuse('documento não carregado');
  if (ctx.blank.has(from) || ctx.blank.has(to)) return refuse('modelo em branco não recebe movimentos; o SM preenche antes');
  if (move.quote.length > MAX_MOVE_QUOTE) return refuse(`trecho com mais de ${MAX_MOVE_QUOTE} caracteres`);
  const block = move.text.trim();
  if (block === '') return refuse('o texto está vazio');
  if (DECISIONS_HEADING.test(block)) return refuse('o texto abriria uma seção de decisões');
  const fact = droppedFact(move.quote, block);
  if (fact !== undefined) return refuse(`o texto perde "${fact}" do trecho`);
  if (ctx.undone.some((m) => m.from === from && m.to === to && m.quote === move.quote)) return refuse('o dono já desfez este movimento');
  if (ctx.applied.some((m) => m.text.includes(move.quote))) return refuse('este conteúdo já foi movido');
  const cut = cutLines(fromText, move.quote);
  if (!cut) return refuse(`o trecho deve ser linhas inteiras encontradas uma vez em ${from}`);
  if (cut.next.trim() === '') return refuse(`o movimento esvaziaria ${from}`);
  const span = decisionsSpan(fromText);
  if (span && cut.removedAt < span.end && cut.removedAt + cut.removed.length > span.start) return refuse('o trecho está na seção de decisões');
  if (inCodeBlock(fromText, cut.removedAt, cut.removedAt + cut.removed.length)) return refuse('o trecho está em bloco de código');
  const put = insertBlock(toText, block, move.after || undefined);
  if (!put) return refuse(`a âncora deve ser uma linha inteira encontrada uma vez em ${to}`);
  const target = decisionsSpan(toText);
  if (target && put.insertAt >= target.start && put.insertAt <= target.end) return refuse('o texto iria para a seção de decisões');
  if (inCodeBlock(toText, put.insertAt, put.insertAt)) return refuse('o texto iria para um bloco de código');
  return { ok: true, from, to, cut, put };
}

/** The two documents as they were before a move; null when either changed since, so undo never guesses. */
export function restoreMove(
  row: Pick<MoveRow, 'removedAt' | 'removed' | 'insertAt' | 'inserted' | 'fromHash' | 'toHash'>,
  fromText: string,
  toText: string,
): { from: string; to: string } | null {
  if (sha256(fromText) !== row.fromHash || sha256(toText) !== row.toHash) return null;
  return {
    from: fromText.slice(0, row.removedAt) + row.removed + fromText.slice(row.removedAt),
    to: toText.slice(0, row.insertAt) + toText.slice(row.insertAt + row.inserted.length),
  };
}
