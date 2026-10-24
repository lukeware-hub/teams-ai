import { DOCUMENT_PURPOSE } from '../agents/document-charter.js';
import type { Config } from '../config/config.js';
import { redactSecrets } from '../core/redact.js';
import { splitSections } from '../decide/windows.js';
import type { DocFile } from './draft.js';
import { MAX_STATE_CHARS, openJev } from './jev-validation.js';
import { DOUBT_BELOW, SCORE_CHECKS, UNSCORED, type DocScore, type DocsScoreRecord, type ScoreCheck, type ScoreDoubt, type ScoreUsage } from './readiness.js';
import { DOC_FILES } from './suggest.js';

interface Question {
  instructions: string;
  criteria: { true: string; false: string };
}

/** The four questions about one document; each one is a yes or no with explicit criteria. */
function questions(file: DocFile): Record<ScoreCheck, Question> {
  const about = `${file} must hold ${DOCUMENT_PURPOSE[file]}.`;
  return {
    complete: {
      instructions: `${about} Does it hold everything it must hold? A part the document marks as not applicable counts as present.`,
      criteria: { true: `${file} holds every part its purpose requires.`, false: `${file} misses a part its purpose requires.` },
    },
    concrete: {
      instructions: `${about} Is most of ${file} concrete and verifiable, with exact values, names, limits or observable behavior, rather than vague words, placeholders or open questions?`,
      criteria: { true: 'Most statements can be checked.', false: 'Most statements are vague, placeholders or open questions.' },
    },
    consistent: {
      instructions: `${about} Is ${file} free of statements that contradict each other?`,
      criteria: { true: 'No two statements contradict each other.', false: 'Two statements contradict each other.' },
    },
    scoped: {
      instructions: `${about} Does ${file} hold only what it must hold? Content that belongs in another document makes this false.`,
      criteria: { true: `${file} holds only what belongs in it.`, false: `${file} holds content that belongs in another document.` },
    },
  };
}

const NO_CHECKS: Record<ScoreCheck, number> = { complete: 0, concrete: 0, consistent: 0, scoped: 0 };
const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
const weightedMean = (rows: Array<{ value: number; size: number }>): number =>
  rows.reduce((sum, r) => sum + r.value * r.size, 0) / rows.reduce((sum, r) => sum + r.size, 0);

/** How the windows of one document combine into one check, as the validator does: a part held in any window counts, a contradiction or foreign part in any window counts, and concreteness is the share across the document. */
const COMBINE: Record<ScoreCheck, (rows: Array<{ value: number; size: number }>) => number> = {
  complete: (rows) => Math.max(...rows.map((r) => r.value)),
  concrete: weightedMean,
  consistent: (rows) => Math.min(...rows.map((r) => r.value)),
  scoped: (rows) => Math.min(...rows.map((r) => r.value)),
};

/** One answered window, for diagnosis: its place, its size, the heading it opens with and its four answers. */
export interface WindowAnswer {
  file: DocFile;
  part: number;
  parts: number;
  size: number;
  firstHeading: string | null;
  checks: Record<ScoreCheck, number>;
}

const headingOf = (text: string): string | null => text.split('\n').find((line) => line.startsWith('#'))?.trim() ?? null;

/** The places the Jev doubts in one document: each window below the cut, and the whole document once when no window reaches the cut for completeness. */
function doubtsOf(rows: WindowAnswer[]): ScoreDoubt[] {
  return SCORE_CHECKS.flatMap((check): ScoreDoubt[] => {
    if (check === 'complete') {
      const best = Math.max(...rows.map((r) => r.checks.complete));
      return best < DOUBT_BELOW ? [{ check, value: best, part: null }] : [];
    }
    return rows.flatMap((row, i) => {
      if (row.checks[check] >= DOUBT_BELOW) return [];
      const part = rows.length === 1 ? null : { index: row.part, of: row.parts, from: row.firstHeading, to: rows[i + 1]?.firstHeading ?? null };
      return [{ check, value: row.checks[check], part }];
    });
  });
}

/** The Jev's score of the documents asked for (all five by default): one request per window of each document, four yes-or-no checks in each request. */
export function createJevScorer(cfg: Config, secrets: () => Promise<Record<string, string>>, onWindow?: (window: WindowAnswer) => void): (docs: Record<DocFile, string>, files?: readonly DocFile[]) => Promise<DocsScoreRecord> {
  return async (docs, files = DOC_FILES) => {
    const values = await secrets();
    const key = values.OPENROUTER_API_KEY;
    if (!key) return UNSCORED;
    const jev = openJev(cfg, key);
    const secretValues = Object.values(values);
    const windows = files.flatMap((file) => {
      const text = redactSecrets(docs[file], secretValues);
      if (text.trim() === '') return [];
      const parts = splitSections([{ title: file, text }], MAX_STATE_CHARS);
      // Each window sees only part of its document, so a check must not fail for what lies outside it.
      return parts.map((state, i) => ({ file, state, part: i + 1, parts: parts.length, scope: parts.length > 1 ? `You see part ${i + 1} of ${parts.length} of ${file}. Judge only what is in this part and do not penalize what lies outside it. ` : '' }));
    });
    const results = await Promise.all(windows.map((w) => {
      const asked = questions(w.file);
      return jev.evaluate({
        state: w.state,
        questions: Object.fromEntries(SCORE_CHECKS.map((id) => [id, { type: 'noul' as const, instructions: w.scope + asked[id].instructions, criteria: asked[id].criteria }])),
        escalateTo: 'po',
      });
    }));
    const answered = results.flatMap((r) => (r.ok ? [r] : []));
    if (answered.length < results.length) return UNSCORED;
    if (answered.some((r) => SCORE_CHECKS.some((id) => r.answers[id]?.type !== 'noul'))) return UNSCORED;
    const reports: WindowAnswer[] = windows.map((w, i) => ({
      file: w.file,
      part: w.part,
      parts: w.parts,
      size: w.state.length,
      firstHeading: headingOf(w.state),
      checks: Object.fromEntries(SCORE_CHECKS.map((id) => [id, (answered[i]!.answers[id] as { value: number }).value])) as Record<ScoreCheck, number>,
    }));
    reports.forEach((report) => onWindow?.(report));
    const docScores = {} as Partial<Record<DocFile, DocScore>>;
    for (const file of files) {
      const mine = reports.filter((r) => r.file === file);
      if (mine.length === 0) {
        docScores[file] = { score: 0, checks: { ...NO_CHECKS } };
        continue;
      }
      const checks = {} as Record<ScoreCheck, number>;
      for (const id of SCORE_CHECKS) checks[id] = COMBINE[id](mine.map((r) => ({ value: r.checks[id], size: r.size })));
      docScores[file] = { score: mean(SCORE_CHECKS.map((id) => checks[id])), checks, doubts: doubtsOf(mine) };
    }
    const usage = answered.reduce<ScoreUsage>(
      (sum, r) => ({
        inputTokens: sum.inputTokens + r.usage.inputTokens,
        outputTokens: sum.outputTokens + r.usage.outputTokens,
        costUsd: r.usage.costUsd === null ? sum.costUsd : (sum.costUsd ?? 0) + r.usage.costUsd,
      }),
      { inputTokens: 0, outputTokens: 0, costUsd: null },
    );
    return { available: true, model: answered[0]?.model ?? null, average: mean(files.map((file) => docScores[file]!.score)), docs: docScores, usage };
  };
}
