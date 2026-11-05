import { COST_STAGES, type CostFact, type CostMoney, type CostPeriod, type CostShare, type CostStage } from './cost-types.js';

const DAY_MS = 86_400_000;
const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0);
const costOf = (f: CostFact): number => f.costUsd ?? 0;

/** Whether a fact falls in the period. `hoje` starts at the local midnight of the server day. */
export function inPeriod(fact: CostFact, period: CostPeriod, now: Date): boolean {
  if (period === 'tudo') return true;
  const start = period === 'hoje' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() : now.getTime() - (period === '7d' ? 7 : 30) * DAY_MS;
  return Date.parse(fact.at) >= start;
}

/** The name a draft shows: the backlog and the follow-on requests have no spec of their own. */
export function specLabel(key: string): string {
  if (key.endsWith('-backlog')) return 'Backlog do projeto';
  const pedido = /-pedido-(\d+)$/.exec(key);
  return pedido ? `Pedido ${pedido[1]}` : key;
}

/** The agent a fact belongs to: its role, or the decision model that made the call. */
export function agentOf(f: CostFact): string {
  if (f.role !== null) return f.role;
  if (f.provider === 'openrouter') return 'jev';
  if (f.provider === 'local') return 'local';
  return 'escalonamento';
}

export function money(facts: readonly CostFact[]): CostMoney {
  return {
    costUsd: round(sum(facts.map(costOf))),
    tokens: sum(facts.map((f) => f.tokens.inputTokens + f.tokens.outputTokens)),
    steps: facts.length,
    semCusto: facts.filter((f) => f.costUsd === null).length,
  };
}

function groupBy(facts: readonly CostFact[], keyOf: (f: CostFact) => string): Map<string, CostFact[]> {
  const groups = new Map<string, CostFact[]>();
  for (const f of facts) {
    const key = keyOf(f);
    const group = groups.get(key);
    if (group) group.push(f);
    else groups.set(key, [f]);
  }
  return groups;
}

/** The biggest spend first; the key breaks ties so the order is stable. */
const rank = <T extends { costUsd: number; key: string }>(items: T[]): T[] => items.sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));

function sharesOf(facts: readonly CostFact[], keyOf: (f: CostFact) => string, base: number): CostShare[] {
  return rank([...groupBy(facts, keyOf)].map(([key, fs]) => ({ key, ...totalsOf(fs, base) })));
}

function totalsOf(facts: readonly CostFact[], base: number): Omit<CostShare, 'key'> {
  const m = money(facts);
  return { costUsd: m.costUsd, tokens: m.tokens, steps: m.steps, share: base > 0 ? round(m.costUsd / base) : 0 };
}

export interface OverviewInput {
  facts: readonly CostFact[];
  projects: ReadonlyArray<{ projectId: string; name: string }>;
  period: CostPeriod;
  now: Date;
  unreadJournals: number;
  /** The Jev ledger's total over every project and spec, or null when not known. */
  jevLedgerUsd: number | null;
}

export interface ProjectRow {
  projectId: string | null;
  name: string;
  total: CostMoney;
  byStage: Record<CostStage, CostMoney>;
  runs: number;
}

export interface CostOverview {
  period: CostPeriod;
  total: CostMoney;
  byStage: Record<CostStage, CostMoney>;
  projects: ProjectRow[];
  agents: Array<CostShare & { stage: CostStage }>;
  models: CostShare[];
  jevUnassignedUsd: number | null;
  unreadJournals: number;
  /** Failed Claude escalations with no recorded cost; they add nothing to the totals. */
  escalationsWithoutCost: number;
}

const byStageOf = (facts: readonly CostFact[]): Record<CostStage, CostMoney> =>
  Object.fromEntries(COST_STAGES.map((stage) => [stage, money(facts.filter((f) => f.stage === stage))])) as Record<CostStage, CostMoney>;

/** A Claude escalation that failed in an older run: it was billed, but no cost was recorded for it. */
const escalationWithoutCost = (f: CostFact): boolean => f.kind === 'decisao-claude' && f.costUsd === null;

const runsOf = (facts: readonly CostFact[]): number => new Set(facts.map((f) => f.runId).filter((id): id is string => id !== null)).size;

/** The whole-installation view: every project, every agent, every model, and the Jev money no project owns. */
export function overview(input: OverviewInput): CostOverview {
  const facts = input.facts.filter((f) => inPeriod(f, input.period, input.now));
  const total = money(facts);
  const registered = new Set(input.projects.map((p) => p.projectId));
  const rowOf = (projectId: string | null, name: string): ProjectRow => {
    const own = facts.filter((f) => f.projectId === projectId);
    return { projectId, name, total: money(own), byStage: byStageOf(own), runs: runsOf(own) };
  };
  const unknown = [...new Set(facts.map((f) => f.projectId).filter((id): id is string => id !== null && !registered.has(id)))];
  const projects = [
    ...input.projects.map((p) => rowOf(p.projectId, p.name)),
    ...unknown.map((id) => rowOf(id, id)),
    ...(facts.some((f) => f.projectId === null) ? [rowOf(null, 'Sem projeto')] : []),
  ].sort((a, b) => b.total.costUsd - a.total.costUsd || a.name.localeCompare(b.name));
  const agents = rank(
    [...groupBy(facts, (f) => `${f.stage}/${agentOf(f)}`)].map(([, fs]) => ({ stage: fs[0]!.stage, key: agentOf(fs[0]!), ...totalsOf(fs, total.costUsd) })),
  );
  const jevPaid = sum(facts.filter((f) => f.provider === 'openrouter').map(costOf));
  return {
    period: input.period,
    total,
    byStage: byStageOf(facts),
    projects,
    agents,
    models: sharesOf(facts, (f) => f.model ?? 'sem modelo', total.costUsd),
    jevUnassignedUsd: input.period === 'tudo' && input.jevLedgerUsd !== null ? round(Math.max(0, input.jevLedgerUsd - jevPaid)) : null,
    unreadJournals: input.unreadJournals,
    escalationsWithoutCost: facts.filter(escalationWithoutCost).length,
  };
}

export interface StageCosts {
  total: CostMoney;
  byAgent: CostShare[];
  byModel: CostShare[];
  byKind: CostShare[];
  byPhase: CostShare[];
  byRepository: CostShare[];
}

function stageCosts(facts: readonly CostFact[], development: boolean): StageCosts {
  const total = money(facts).costUsd;
  return {
    total: money(facts),
    byAgent: sharesOf(facts, agentOf, total),
    byModel: sharesOf(facts, (f) => f.model ?? 'sem modelo', total),
    byKind: sharesOf(facts, (f) => f.kind, total),
    byPhase: development ? sharesOf(facts, (f) => f.phase, total) : [],
    byRepository: development ? sharesOf(facts, (f) => f.repository ?? 'sem repositório', total) : [],
  };
}

export interface SpecRow {
  key: string;
  label: string;
  refinement: number;
  development: number;
  total: number;
  runs: number;
}

export interface ProjectCosts {
  projectId: string;
  name: string;
  period: CostPeriod;
  refinement: StageCosts;
  development: StageCosts;
  chat: CostMoney;
  specs: SpecRow[];
  unreadJournals: number;
  escalationsWithoutCost: number;
}

export interface ProjectCostsInput {
  facts: readonly CostFact[];
  projectId: string;
  name: string;
  period: CostPeriod;
  now: Date;
  unreadJournals: number;
}

/** One project: refinement and development as two separate totals, each with its own breakdown, and the spec table. */
export function projectCosts(input: ProjectCostsInput): ProjectCosts {
  const facts = input.facts.filter((f) => f.projectId === input.projectId && inPeriod(f, input.period, input.now));
  const refinement = facts.filter((f) => f.stage === 'refinement');
  const development = facts.filter((f) => f.stage === 'development');
  const specs = [...groupBy(facts.filter((f) => f.specId !== null && f.stage !== 'chat'), (f) => f.specId!)].map(([key, fs]) => {
    const refined = money(fs.filter((f) => f.stage === 'refinement')).costUsd;
    const built = money(fs.filter((f) => f.stage === 'development')).costUsd;
    return { key, label: specLabel(key), refinement: refined, development: built, total: round(refined + built), runs: runsOf(fs) };
  });
  return {
    projectId: input.projectId,
    name: input.name,
    period: input.period,
    refinement: stageCosts(refinement, false),
    development: stageCosts(development, true),
    chat: money(facts.filter((f) => f.stage === 'chat')),
    specs: specs.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
    unreadJournals: input.unreadJournals,
    escalationsWithoutCost: facts.filter(escalationWithoutCost).length,
  };
}

/** A fact whose agent, spec or model the steps table filters on. */
export function filterFacts(facts: readonly CostFact[], filter: { period: CostPeriod; now: Date; agent?: string; spec?: string }): CostFact[] {
  return facts.filter(
    (f) => inPeriod(f, filter.period, filter.now) && (!filter.agent || agentOf(f) === filter.agent) && (!filter.spec || f.specId === filter.spec),
  );
}
