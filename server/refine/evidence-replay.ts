import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JournalEvent } from './agreement.js';
import { RefineEvent } from './events.js';
import { normalized } from './resolver.js';
import { diagnoseEvidence, type RuleSet } from './speckit-answers.js';
import { SPECKIT_INPUTS, type SpeckitInput } from './speckit-pack.js';
import { OrchEvent } from '../orchestrator/events.js';

/** One proposed answer of a Spec Kit question, as its saved answer step gave it. */
export interface Proposal {
  questionId: string;
  answer: string;
  evidence: Array<{ source: string; quote: string }>;
}

/** The proposals of one saved answer step. */
export interface ProposalStep {
  stepId: string;
  proposals: Proposal[];
}

interface SavedOutput {
  ok?: boolean;
  value?: { results?: Array<{ questionId: string; answer: string | null; evidence?: Array<{ source: string; quote: string }> }> };
}

const RULE_SETS: RuleSet[] = ['strict', 'sourceNames', 'decisions', 'perQuote'];

/** The saved answer steps the journal started, with the proposals each one saved; a failed step or one without its output gives none. */
export async function readProposalSteps(root: string, events: readonly JournalEvent[]): Promise<ProposalStep[]> {
  const steps: ProposalStep[] = [];
  for (const e of events) {
    if (e.type !== OrchEvent.StepStarted || e.data.kind !== 'speckit-answer') continue;
    const stepId = String(e.data.stepId);
    const text = await fs.readFile(path.join(root, 'steps', stepId, 'output.json'), 'utf8').catch(() => '');
    let saved: SavedOutput;
    try {
      saved = JSON.parse(text) as SavedOutput;
    } catch {
      continue;
    }
    if (saved.ok !== true) continue;
    const proposals = (saved.value?.results ?? []).flatMap((r) => (r.answer === null || r.answer === undefined ? [] : [{ questionId: r.questionId, answer: r.answer, evidence: r.evidence ?? [] }]));
    steps.push({ stepId, proposals });
  }
  return steps;
}

/** The six documents the last preparation wrote, which every saved quote is checked against. */
export async function readInputTexts(root: string): Promise<Record<SpeckitInput, string>> {
  const texts = await Promise.all(SPECKIT_INPUTS.map((file) => fs.readFile(path.join(root, 'speckit-input', file), 'utf8').catch(() => '')));
  return Object.fromEntries(SPECKIT_INPUTS.map((file, i) => [file, texts[i]])) as Record<SpeckitInput, string>;
}

/** The owner's answers: the latest text of each question, and every text the owner wrote. */
export function ownerTexts(events: readonly JournalEvent[]): { latest: Map<string, string>; texts: string[] } {
  const latest = new Map<string, string>();
  const texts: string[] = [];
  for (const e of events) {
    if (e.type !== RefineEvent.QuestionAnswered || e.data.by !== undefined) continue;
    const text = String(e.data.text ?? '');
    latest.set(String(e.data.questionId), text);
    texts.push(text);
  }
  return { latest, texts };
}

type Tally = { same: number; other: number };

export interface EvidenceReplay {
  steps: number;
  proposals: number;
  quotes: number;
  /** Why quotes do not verify under the strict rule, counted per quote. */
  reasons: Record<string, number>;
  /** Why numbers of an answer are not in any quote. */
  numbers: Record<string, number>;
  /** The proposals each rule set admits. */
  admitted: Record<RuleSet, number>;
  /** The proposals a relaxed rule admits that the strict rule refuses. */
  gained: Record<Exclude<RuleSet, 'strict'>, number>;
  /** The admitted proposals with the owner's later answer: whether the owner gave the same answer. */
  labelled: Record<RuleSet, Tally>;
  /** The strict refusals with the owner's later answer. */
  refused: Tally;
  unlabelled: number;
}

const tally = (): Tally => ({ same: 0, other: 0 });

/** Runs the diagnosis over every proposal and joins it with the owner's later answer to the same question. */
export function replayProposals(steps: readonly ProposalStep[], texts: Record<SpeckitInput, string>, owner: { latest: Map<string, string>; texts: string[] }): EvidenceReplay {
  const result: EvidenceReplay = {
    steps: steps.length,
    proposals: 0,
    quotes: 0,
    reasons: {},
    numbers: {},
    admitted: { strict: 0, sourceNames: 0, decisions: 0, perQuote: 0 },
    gained: { sourceNames: 0, decisions: 0, perQuote: 0 },
    labelled: { strict: tally(), sourceNames: tally(), decisions: tally(), perQuote: tally() },
    refused: tally(),
    unlabelled: 0,
  };
  for (const step of steps) {
    for (const p of step.proposals) {
      result.proposals += 1;
      result.quotes += p.evidence.length;
      const d = diagnoseEvidence(texts, p.evidence, p.answer, owner.texts);
      for (const q of d.quotes) if (q.reason !== 'ok') result.reasons[q.reason] = (result.reasons[q.reason] ?? 0) + 1;
      for (const n of d.numbers) result.numbers[n.reason] = (result.numbers[n.reason] ?? 0) + 1;
      for (const set of RULE_SETS) if (d.admits[set]) result.admitted[set] += 1;
      for (const set of ['sourceNames', 'decisions', 'perQuote'] as const) if (d.admits[set] && !d.admits.strict) result.gained[set] += 1;
      const ownerText = owner.latest.get(p.questionId);
      if (ownerText === undefined) {
        result.unlabelled += 1;
        continue;
      }
      const same = normalized(ownerText) === normalized(p.answer) ? 'same' : 'other';
      for (const set of RULE_SETS) if (d.admits[set]) result.labelled[set][same] += 1;
      if (!d.admits.strict) result.refused[same] += 1;
    }
  }
  return result;
}

const counts = (c: Record<string, number>): string => Object.entries(c).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
const pairs = (t: Tally): string => `the owner gave the same answer ${t.same}, another answer ${t.other}`;

/** The printed report of the evidence replay. */
export function renderReplay(r: EvidenceReplay): string[] {
  return [
    'evidence replay (saved answer steps; quotes checked against the six inputs of the last preparation, which some agents saw as digests):',
    `steps ${r.steps}; proposals with an answer ${r.proposals}; quotes ${r.quotes}`,
    `strict admits ${r.admitted.strict} of ${r.proposals}; refusals per quote: ${counts(r.reasons)}`,
    `numbers no quote holds: ${counts(r.numbers)}`,
    `rule sets admit: sourceNames ${r.admitted.sourceNames} (+${r.gained.sourceNames}), decisions ${r.admitted.decisions} (+${r.gained.decisions}), perQuote ${r.admitted.perQuote} (+${r.gained.perQuote}); the plus counts are the proposals strict refuses`,
    `with the owner's later answer: ${r.proposals - r.unlabelled}; unlabelled ${r.unlabelled}`,
    `  strict admitted: ${pairs(r.labelled.strict)}`,
    `  sourceNames admitted: ${pairs(r.labelled.sourceNames)}`,
    `  decisions admitted: ${pairs(r.labelled.decisions)}`,
    `  perQuote admitted: ${pairs(r.labelled.perQuote)}`,
    `  strict refused: ${pairs(r.refused)}`,
  ];
}
