import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Decider } from '../../server/decide/decider.js';
import { CommandError, type CommandSpec, type Exec } from '../../server/exec/command.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import { createNewProject, draftPaths, speckitBaseDir, writeDoc } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { ConflictError, RefineJournal, RefineSession, type RunAgent } from '../../server/refine/session.js';
import { speckitPack } from '../../server/refine/speckit-pack.js';
import { SPECKIT_NOT_INSTALLED, speckitFeatureOf } from '../../server/refine/speckit.js';
import { canStart } from '../../server/refine/state.js';
import { loadEvents } from '../../server/store/event-store.js';
import { makeSpec } from '../fixtures/contracts.js';

let root = '';
let ws: Workspace;
let execCalls: CommandSpec[];
let agentCalls: Array<AgentStepRequest<'speckit'>>;
let docCalls: Array<AgentStepRequest<'speckit-answer'>>;
/** The web searches the preparation asked for, and what each one returns. */
let researchCalls: unknown[];
let researchReply: (req: unknown) => unknown;
let exec: Exec;
let answer: (req: AgentStepRequest<'speckit'>) => unknown;
/** What the PO or SM answers from the six documents; null is a failed call. */
let answerFromDocs: (req: AgentStepRequest<'speckit-answer'>) => unknown;

const draft = () => draftPaths(ws, 'hello-001');
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const summary = { usage, costUsd: 0, durationMs: 1, numTurns: 1, rateLimit: null };
const runAgent: RunAgent = (async (req: AgentStepRequest<'speckit'> | AgentStepRequest<'speckit-answer'>, ctx: { specHash: string }) => {
  if ((req as { kind: string }).kind === 'speckit-research') {
    researchCalls.push(req);
    return researchReply(req);
  }
  if (req.kind === 'speckit-answer') {
    docCalls.push(req);
    const out = answerFromDocs(req);
    return out === null ? { ok: false, failure: 'schema', errors: ['bad json'], summary } : { ok: true, value: { specHash: ctx.specHash, results: [], ...(out as object) }, summary };
  }
  agentCalls.push(req);
  const out = await answer(req);
  return out === null ? { ok: false, failure: 'schema', errors: ['bad json'], summary } : { ok: true, value: { specHash: ctx.specHash, questions: [], ...(out as object) }, summary };
}) as never;
const deps = () => ({ ws, draft: draft(), runAgent, exec: (spec: CommandSpec) => exec(spec), secretsDir: `${root}/secrets`, retrieval: () => [] });
const stepOf = (r: { pack: { feedback?: string } }): string => `${r.pack.feedback!.match(/speckit-(\w+)\/SKILL/)![1]}:${r.pack.feedback!.match(/"## (\w+):/)?.[1] ?? ''}`;
/** The criterion ids of the spec each item has, which a working agent keeps in every file it writes. */
const CRITERIA = makeSpec().acceptanceCriteria.map((c) => c.id).join(', ');
/** The file each item command writes in its feature folder. */
const OWN_FILE: Record<string, string> = { specify: 'spec.md', clarify: 'spec.md', plan: 'plan.md', tasks: 'tasks.md' };
/** A finished step that wrote `files` in the staging folder, as a working agent does. */
async function wrote(req: AgentStepRequest<'speckit'>, files: string[]) {
  for (const file of files) {
    await fs.mkdir(path.dirname(`${req.cwd}/${file}`), { recursive: true });
    await fs.writeFile(`${req.cwd}/${file}`, CRITERIA);
  }
  return { status: 'done', summary: 'ok', files };
}
/** A finished step with nothing else to report: an item step writes its own file in the item's feature folder. */
const done = (req: AgentStepRequest<'speckit'>) => {
  const [command, key] = stepOf(req).split(':');
  return wrote(req, key ? [`specs/${key}/${OWN_FILE[command!]}`] : []);
};
const item = (key: string, rank: number) => ({ key, title: `Item ${key}`, epic: 'core', priority: 'must', rank, size: 'S', scope: 's', rationale: 'r', dependsOn: [], sources: [] });

/** A Jev that calls each pair a repeat when `repeat` says so; null leaves the pair unanswered. The pair reads "Question A: ...\nQuestion B: ...". */
const jev = (repeat: (pair: string) => boolean | null) => ({
  decide: vi.fn(async (_id: string, pair: string, _questions: unknown, _ctx: { confidential: boolean }) => {
    const same = repeat(pair);
    return same === null ? { answered: false, reason: 'exhausted' } : { answered: true, answers: { q0: { type: 'noul', value: same ? 0.9 : 0.1 } }, backend: 'local', escalated: false };
  }),
});
/** Each item's steps ask the questions given for that item. */
const askItems = (asks: Record<string, Array<{ text: string; blocking: boolean }>>) => async (req: AgentStepRequest<'speckit'>) => {
  const key = Object.keys(asks).find((k) => req.pack.feedback!.includes(`"## ${k}:`));
  return { ...(await done(req)), questions: key ? asks[key] : [] };
};

/** The questions the PO or SM was asked: each line of its pack names the question id and its text. */
const askedOf = (req: AgentStepRequest<'speckit-answer'>) => [...req.pack.feedback!.matchAll(/^- (speckit-\w+) \(item: .*?\): (.*)$/gm)].map((m) => ({ questionId: m[1]!, text: m[2]! }));
/** A line of the briefing, which the answers cite. */
const LINK = 'O link de recuperação de senha vale por 90 dias depois do envio.';
/** The answers the documents give to every question asked: the number of the briefing line, and the card written for each. */
const answersIn = (req: AgentStepRequest<'speckit-answer'>) => ({
  results: askedOf(req).map((q) => ({ questionId: q.questionId, answer: '90 dias', evidence: [{ source: 'briefing.md', quote: LINK }], card: { subject: 'Prazo do link', context: 'Item Entrar. Sem prazo, o link fica aberto.', text: `Reescrita: ${q.text}`, options: [] } })),
});
const planLogin = (r: AgentStepRequest<'speckit'>) => r.pack.feedback!.includes('speckit-plan/SKILL') && r.pack.feedback!.includes('"## login:');

/** A wizard session whose backlog of two items is detailed. */
async function detailedSession(decider?: Pick<Decider, 'decide'>, extra: { speckitResearch?: () => Promise<boolean> } = {}): Promise<RefineSession> {
  const created = await RefineSession.create(deps(), 'new-project');
  await created.enableBacklog();
  await created.close();
  const journal = await RefineJournal.open(draft().events, { projectId: 'hello-app', specId: 'hello-001' });
  await journal.fact(RefineEvent.BacklogDerived, { project: null, epics: [], items: [item('login', 1), item('cart', 2)], cycle: 1 });
  for (const key of ['cart', 'login']) {
    const spec = makeSpec({ specId: key });
    await fs.mkdir(`${draft().docs}/specs/${key}`, { recursive: true });
    await fs.writeFile(`${draft().docs}/specs/${key}/spec.json`, JSON.stringify(spec));
    await journal.fact(RefineEvent.SpecDerived, { key, specId: key, inputHash: 'i', rev: 'r', spec, issues: [], cycle: 1 });
    await fs.writeFile(`${draft().docs}/specs/${key}/preplan.json`, '{"tasks":[]}');
    await journal.fact(RefineEvent.PreplanDerived, { key, inputHash: 'i', specRev: 'r', preplan: { tasks: [] }, issues: [], cycle: 1 });
  }
  await journal.close();
  return RefineSession.open({ ...deps(), decider, ...extra });
}

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-speckit-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  execCalls = [];
  agentCalls = [];
  exec = async (spec) => {
    execCalls.push(spec);
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false };
  };
  answer = done;
  answerFromDocs = () => null;
  docCalls = [];
  researchCalls = [];
  researchReply = () => ({ ok: false, failure: 'schema', errors: ['no search in this test'], summary });
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('speckitPack', () => {
  const inputs = '/w/refine/hello-001/speckit-input';
  const item = { key: 'login', specId: 'login', title: 'Entrar' };

  it('tells the agent to read the skill of its command and names the six markdown inputs by absolute path', () => {
    const p = speckitPack({ command: 'constitution', specHash: 'sha256:x', inputDir: inputs });
    expect(p).toMatchObject({ kind: 'speckit', role: 'dev' });
    expect(p.feedback).toContain('.claude/skills/speckit-constitution/SKILL.md');
    for (const file of ['project.md', 'flow.md', 'briefing.md', 'stack.md', 'design.md', 'specs.md']) expect(p.feedback).toContain(`${inputs}/${file}`);
    expect(p.feedback).not.toContain('.json');
    expect(p.feedback).toContain('derived from these six files');
    expect(p.feedback).toContain('Quality rules');
  });

  it('points an item command at its section of specs.md and its own feature directory', () => {
    for (const command of ['specify', 'clarify', 'plan', 'tasks'] as const) {
      const p = speckitPack({ command, specHash: 'sha256:x', inputDir: inputs, item });
      expect(p.feedback, command).toContain(`${inputs}/specs.md`);
      expect(p.feedback, command).toContain('"## login: Entrar"');
      expect(p.feedback, command).not.toContain('SPECIFY_FEATURE_DIRECTORY');
      expect(p.feedback, command).toContain(`.claude/skills/speckit-${command}/SKILL.md`);
    }
  });

  it('gives the answers taken from the documents as provisional decisions the files must follow', () => {
    const decisions = [{ question: 'Qual o prazo?', answer: '90 dias', by: 'sm' as const }];
    const p = speckitPack({ command: 'plan', specHash: 'sha256:x', inputDir: inputs, item, decisions });
    expect(p.decisions).toEqual(decisions);
    expect(p.feedback).toContain('provisional');
  });

  it('tells every item command to keep the acceptance criterion ids', () => {
    for (const command of ['specify', 'clarify', 'plan', 'tasks'] as const) {
      expect(speckitPack({ command, specHash: 'sha256:x', inputDir: inputs, item }).feedback, command).toContain('acceptance criterion ids');
    }
  });
});

describe('RefineSession.runSpeckit answers from the documents', () => {
  /** The briefing holds the line the answers cite. */
  const briefing = (s: RefineSession) => s.saveDoc('briefing.md', `## Regras\n\n${LINK}\n`);

  it('a question the PO answers from the documents is not asked to the owner, and the next step reads the answer as a decision', async () => {
    answer = askItems({ login: [{ text: 'Qual o prazo do link?', blocking: true }] });
    answerFromDocs = answersIn;
    const s = await detailedSession();
    await briefing(s);
    await s.runSpeckit();
    expect(s.state.questions).toEqual([expect.objectContaining({ origin: 'speckit', status: 'answered', answer: '90 dias', answeredBy: 'po', text: 'Reescrita: Qual o prazo do link?' })]);
    expect(canStart(s.state)).toBe(true);
    const clarify = agentCalls.find((r) => r.pack.feedback!.includes('speckit-clarify/SKILL'));
    expect(clarify!.pack.decisions).toEqual([expect.objectContaining({ question: 'Reescrita: Qual o prazo do link?', answer: '90 dias', by: 'po' })]);
    await s.close();
  });

  it('an answer to a question of the plan makes the plan run once more with the answer, and the step is recorded once', async () => {
    let plans = 0;
    answer = async (req) => {
      if (!planLogin(req)) return done(req);
      plans += 1;
      return { ...(await done(req)), questions: plans === 1 ? [{ text: 'Qual o prazo do link?', blocking: true }] : [] };
    };
    answerFromDocs = answersIn;
    const s = await detailedSession();
    await briefing(s);
    await s.runSpeckit();
    const plan = agentCalls.filter(planLogin);
    expect(plan).toHaveLength(2);
    expect(plan[1]!.pack.decisions).toEqual([expect.objectContaining({ answer: '90 dias', by: 'sm' })]);
    expect(s.state.questions).toEqual([expect.objectContaining({ status: 'answered', answeredBy: 'sm' })]);
    expect(s.state.speckit!.steps.filter((st) => st.command === 'plan' && st.itemKey === 'login')).toHaveLength(1);
    expect(s.state.speckit).toMatchObject({ status: 'done', stale: false });
    expect(canStart(s.state)).toBe(true);
    await s.close();
  });

  it('an answer that arrives after a re-run makes the step run again with it, and a question asked again in its own words adds no row', async () => {
    let plans = 0;
    const first = { text: 'Qual o prazo do link?', blocking: true };
    const second = { text: 'Qual o limite de envios?', blocking: true };
    answer = async (req) => {
      if (!planLogin(req)) return done(req);
      plans += 1;
      return { ...(await done(req)), questions: plans === 1 ? [first] : [first, second] };
    };
    answerFromDocs = answersIn;
    const s = await detailedSession();
    await briefing(s);
    await s.runSpeckit();
    expect(s.state.questions.map((q) => q.status)).toEqual(['answered', 'answered']);
    // The plan ran three times: the second answer came in its second round, and the third round took it into the plan.
    expect(plans).toBe(3);
    expect(s.state.speckit?.stale).toBe(false);
    expect(canStart(s.state)).toBe(true);
    await s.close();
  });

  it('a question the PO cannot answer from the documents reaches the owner with the card the PO wrote', async () => {
    answer = askItems({ login: [{ text: 'Qual o prazo do link?', blocking: true }] });
    answerFromDocs = (req) => ({ results: askedOf(req).map((q) => ({ questionId: q.questionId, answer: null, evidence: [], card: { subject: 'Prazo do link', context: 'Item Entrar. Sem prazo, o link fica aberto.', text: `Para o dono: ${q.text}`, options: [] } })) });
    const s = await detailedSession();
    await briefing(s);
    await s.runSpeckit();
    expect(s.state.questions).toEqual([expect.objectContaining({ status: 'pending', text: 'Para o dono: Qual o prazo do link?', context: 'Item Entrar. Sem prazo, o link fica aberto.' })]);
    expect(s.state.speckit?.status).toBe('done');
    expect(canStart(s.state)).toBe(false);
    await s.close();
  });

  it('two failed answers in a row stop the answers for that run, and the questions stay with the owner', async () => {
    answer = async (req) => (req.pack.feedback!.includes('"## login:') ? { ...(await done(req)), questions: [{ text: `Pergunta de ${req.pack.feedback!.match(/speckit-(\w+)\/SKILL/)![1]}?`, blocking: false }] } : done(req));
    const s = await detailedSession();
    await briefing(s);
    await s.runSpeckit();
    // Each failed answer is retried once: two calls for each of the first two questions, and none after the stop.
    expect(docCalls).toHaveLength(4);
    expect(s.state.questions.map((q) => q.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(s.state.speckit?.status).toBe('done');
    await s.close();
  });

  it('the questions an earlier preparation left unanswered are answered at the start of the next one', async () => {
    answer = askItems({ login: [{ text: 'Qual o prazo do link?', blocking: false }] });
    const s = await detailedSession();
    await briefing(s);
    await s.runSpeckit();
    expect(s.state.questions).toHaveLength(1);
    expect(s.state.questions[0]!.context).toBeUndefined();
    answerFromDocs = answersIn;
    await s.runSpeckit();
    expect(s.state.questions).toEqual([expect.objectContaining({ status: 'answered', answer: '90 dias', answeredBy: 'po' })]);
    expect(s.state.speckit).toMatchObject({ status: 'done', stale: false });
    await s.close();
  });
});

describe('RefineSession.askSpeckitAnswers', () => {
  /** A preparation whose answerer could not answer: its questions keep no card, which is what the button finds. */
  async function unreadPreparation(): Promise<RefineSession> {
    answer = askItems({ login: [{ text: 'Qual o prazo do link?', blocking: true }] });
    answerFromDocs = () => null;
    const s = await detailedSession();
    await s.saveDoc('briefing.md', `## Regras\n\n${LINK}\n`);
    await s.runSpeckit();
    return s;
  }

  it('asks the PO and the SM about the questions nobody has read yet; the answers make the preparation stale', async () => {
    const s = await unreadPreparation();
    expect(s.state.questions.filter((q) => q.origin === 'speckit' && q.context === undefined)).toHaveLength(1);
    answerFromDocs = answersIn;
    await s.askSpeckitAnswers();
    expect(s.state.questions).toEqual([expect.objectContaining({ status: 'answered', answer: '90 dias', answeredBy: 'po' })]);
    expect(s.state.speckit?.stale).toBe(true);
    expect(canStart(s.state)).toBe(false);
    expect(s.state.speckitAnswering).toBeFalsy();
    const types = s.events.map((e) => e.type);
    expect(types).toContain(RefineEvent.SpeckitAnswersStarted);
    expect(types).toContain(RefineEvent.SpeckitAnswersDone);
    await s.close();
  });

  it('refuses while a preparation runs', async () => {
    const s = await unreadPreparation();
    const run = s.runSpeckit();
    expect(() => s.askSpeckitAnswers()).toThrow(ConflictError);
    await run;
    await s.close();
  });

  it('lets the owner replace an answer the PO or the SM gave, and refuses to replace the owner\'s own', async () => {
    const s = await unreadPreparation();
    answerFromDocs = answersIn;
    await s.askSpeckitAnswers();
    const id = s.state.questions[0]!.questionId;
    await expect(s.skip(id)).rejects.toThrow(ConflictError);
    await s.answer(id, 'Minha resposta');
    expect(s.state.questions[0]).toMatchObject({ status: 'answered', answer: 'Minha resposta', answeredBy: null });
    await expect(s.answer(id, 'De novo')).rejects.toThrow(ConflictError);
    await s.close();
  });
});

describe('RefineSession.runSpeckit web search', () => {
  /** The documents leave each question open, with its card: the web search is the one step left. */
  const openWithCard = () => {
    answerFromDocs = (req) => ({ results: askedOf(req).map((q) => ({ questionId: q.questionId, answer: null, evidence: [], card: { subject: 'Prazo', context: 'Item Entrar.', text: `Reescrita: ${q.text}`, options: [] } })) });
  };

  it('a confidential project gets no web search, even when the setting is on', async () => {
    answer = askItems({ login: [{ text: 'Qual o prazo do link?', blocking: true }] });
    openWithCard();
    const s = await detailedSession(undefined, { speckitResearch: async () => true });
    await s.runSpeckit();
    expect(researchCalls).toHaveLength(0);
    await s.close();
  });

  it('a project the owner marked not confidential gets one suggestion when the setting is on', async () => {
    answer = askItems({ login: [{ text: 'Qual o prazo do link?', blocking: true }] });
    openWithCard();
    researchReply = (req) => ({ ok: true, value: { specHash: 'h', results: askedOf(req as never).map((q) => ({ questionId: q.questionId, suggestion: { label: '30 dias', detail: 'O guia diz 30 dias.', url: 'https://example.com/prazo' } })) }, summary: { ...summary, webSearchUrls: ['https://example.com/prazo'] } });
    const s = await detailedSession(undefined, { speckitResearch: async () => true });
    await s.answerConfidentiality(false);
    await s.runSpeckit();
    expect(researchCalls).toHaveLength(1);
    expect(s.state.questions[0]!.options?.map((o) => o.label)).toEqual(['30 dias']);
    expect(s.state.questions[0]!.status).toBe('pending');
    await s.close();
  });
});

describe('RefineSession.runSpeckit', () => {
  it('initializes Spec Kit in a fresh staging folder, then runs the constitution and each item in rank order', async () => {
    const s = await detailedSession();
    await fs.mkdir(`${draft().root}/speckit`, { recursive: true });
    await fs.writeFile(`${draft().root}/speckit/old.txt`, 'from an earlier run');
    await s.runSpeckit();
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({ bin: 'specify', cwd: `${draft().root}/speckit` });
    expect(execCalls[0]!.args).toEqual(expect.arrayContaining(['init', '--here', '--force', '--non-interactive', '--integration', 'claude', '--script', 'sh']));
    await expect(fs.access(`${draft().root}/speckit/old.txt`)).rejects.toThrow();
    const order = agentCalls.map((r) => `${r.pack.feedback!.match(/speckit-(\w+)\/SKILL/)![1]}:${r.pack.feedback!.match(/"## (\w+):/)?.[1] ?? ''}`);
    expect(order).toEqual(['constitution:', 'specify:login', 'clarify:login', 'plan:login', 'tasks:login', 'specify:cart', 'clarify:cart', 'plan:cart', 'tasks:cart']);
    expect(agentCalls.every((r) => r.kind === 'speckit' && r.role === 'dev' && r.cwd === `${draft().root}/speckit` && r.taskId === null)).toBe(true);
    expect(agentCalls[0]!.extraAllow).toEqual(expect.arrayContaining(['Bash(bash:*)', 'Bash(.specify/scripts/bash/*:*)', `Read(//${`${draft().root}/speckit-input`.replace(/^\/+/, '')}/**)`]));
    const types = s.events.map((e) => e.type).filter((t) => t.startsWith('SPECKIT_'));
    expect(types).toEqual([RefineEvent.SpeckitStarted, ...Array.from({ length: 9 }, () => [RefineEvent.SpeckitStepStarted, RefineEvent.SpeckitStepDone]).flat(), RefineEvent.SpeckitDone]);
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitStarted)!.data).toMatchObject({ total: 9, inputHash: expect.any(String) });
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitStepStarted && e.data.command === 'plan')!.data).toEqual({ command: 'plan', itemKey: 'login' });
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitStepDone && e.data.command === 'plan')!.data).toEqual({ command: 'plan', itemKey: 'login', files: ['specs/login/plan.md'], basis: expect.any(String) });
    expect(s.state.speckit).toMatchObject({ status: 'done', stale: false, total: 9 });
    expect(s.state.speckit!.steps).toHaveLength(9);
    expect(canStart(s.state)).toBe(true);
    await s.close();
  });

  it('a document changed after the preparation shuts the start until it runs again', async () => {
    const s = await detailedSession();
    expect(canStart(s.state)).toBe(false);
    await s.runSpeckit();
    expect(canStart(s.state)).toBe(true);
    await s.saveDoc('stack.md', '# Stack\n\nNode 24\n');
    expect(s.state.speckit?.stale).toBe(true);
    expect(canStart(s.state)).toBe(false);
    await s.close();
  });

  it('a document written without its journal entry, as a crash between the two leaves it, shuts the start by the input hash recorded at the start of the preparation', async () => {
    const s = await detailedSession();
    await s.runSpeckit();
    const before = await fs.readFile(draft().stackMd, 'utf8');
    await writeDoc(draft(), 'stack.md', '# Stack\n\nNode 24\n');
    expect(s.state.speckit).toMatchObject({ status: 'done', stale: false });
    await expect(s.freezeProgram()).rejects.toThrow('Prepare o Spec Kit antes de iniciar');
    await writeDoc(draft(), 'stack.md', before);
    await expect(s.freezeProgram()).resolves.toHaveLength(2);
    await s.close();
  });

  it('says plainly when Spec Kit is not installed, and runs no agent', async () => {
    exec = async () => {
      throw new CommandError('cannot run specify: spawn specify ENOENT');
    };
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed', error: SPECKIT_NOT_INSTALLED });
    expect(agentCalls).toHaveLength(0);
    expect(s.busy).toBe(false);
    await s.close();
  });

  it('fails on an init that exits with an error', async () => {
    exec = async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'boom', timedOut: false, durationMs: 1, truncated: false });
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit?.status).toBe('failed');
    expect(s.state.speckit?.error).toContain('Spec Kit');
    expect(agentCalls).toHaveLength(0);
    await s.close();
  });

  it('keeps the stderr tail of a failed init in the state, so the owner reads why it failed', async () => {
    const stderr = "Usage: specify init [OPTIONS] [project_name]\nTry 'specify init --help' for help.\n╭─ Error ─╮\n│ No such option: --integration │\n╰─────────╯";
    exec = async () => ({ exitCode: 2, signal: null, stdout: '', stderr, timedOut: false, durationMs: 1, truncated: false });
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed', detail: stderr });
    await s.close();
  });

  it('keeps the questions of a blocked step on record, so the owner can answer them before a re-run', async () => {
    answer = (req) => (req.pack.feedback!.includes('speckit-plan/SKILL') ? { status: 'blocked', summary: 'parou', files: [], reason: 'o plano não fecha', questions: [{ text: 'Qual o prazo de retenção?', blocking: true }] } : done(req));
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.questions).toEqual([expect.objectContaining({ text: 'Qual o prazo de retenção?', blocking: true, status: 'pending', origin: 'speckit' })]);
    // The blocked plan is not finished: the last finished step is the clarify before it.
    expect(s.state.speckit?.steps.at(-1)).toMatchObject({ command: 'clarify' });
    await s.close();
  });

  it('stops at the first step that fails or that the agent reports blocked', async () => {
    answer = (req) => (req.pack.feedback!.includes('speckit-plan/SKILL') ? { status: 'blocked', summary: 'parou', files: [], reason: 'o plano não fecha' } : done(req));
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.speckit?.error).toContain('o plano não fecha');
    expect(agentCalls).toHaveLength(4);
    answer = () => null;
    await s.runSpeckit();
    // The second run resumes at the plan: the constitution and the first item's specify and clarify stay finished, and the plan is asked twice.
    expect(agentCalls).toHaveLength(6);
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.speckit!.steps).toHaveLength(3);
    expect(s.state.speckit?.error).toContain('Spec Kit');
    await s.close();
  });

  it('asks a step again once when its answer fails the output schema, with the error in the note', async () => {
    answer = (req) => (agentCalls.length === 1 ? null : done(req));
    const s = await detailedSession();
    await s.runSpeckit();
    expect(agentCalls[1]!.pack.feedback).toContain('did not match the output schema: bad json');
    expect(s.state.speckit).toMatchObject({ status: 'done' });
    await s.close();
  });

  it('stops with the format reason when the answer fails the output schema twice', async () => {
    answer = () => null;
    const s = await detailedSession();
    await s.runSpeckit();
    expect(agentCalls).toHaveLength(2);
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.speckit?.error).toContain('não devolveu o resultado em formato válido');
    await s.close();
  });

  it('a preparation that failed on the same inputs resumes at its failed step, and runs no finished step again', async () => {
    answer = (req) => (req.pack.feedback!.includes('speckit-plan/SKILL') ? { status: 'blocked', summary: 'parou', files: [], reason: 'o plano não fecha' } : done(req));
    const s = await detailedSession();
    await s.runSpeckit();
    const before = agentCalls.length;
    answer = done;
    await s.runSpeckit();
    expect(agentCalls.slice(before).map(stepOf)).toEqual(['plan:login', 'tasks:login', 'specify:cart', 'clarify:cart', 'plan:cart', 'tasks:cart']);
    expect(s.state.speckit).toMatchObject({ status: 'done', total: 9 });
    expect(s.state.speckit!.steps).toHaveLength(9);
    expect(canStart(s.state)).toBe(true);
    await s.close();
  });

  it('a preparation whose inputs changed after the failure starts over from the constitution', async () => {
    answer = (req) => (req.pack.feedback!.includes('speckit-plan/SKILL') ? { status: 'blocked', summary: 'parou', files: [], reason: 'o plano não fecha' } : done(req));
    const s = await detailedSession();
    await s.runSpeckit();
    await s.saveDoc('stack.md', '# Stack\n\nNode 24\n');
    answer = done;
    const before = agentCalls.length;
    await s.runSpeckit();
    expect(agentCalls.slice(before).map(stepOf)[0]).toBe('constitution:');
    expect(agentCalls.length - before).toBe(9);
    expect(s.state.speckit).toMatchObject({ status: 'done' });
    await s.close();
  });

  it('asks the owner the questions Spec Kit leaves open, once each, and a blocking one holds the start until answered', async () => {
    const choice = { label: 'Real', detail: '', recommended: true };
    answer = async (req) => {
      if (req.pack.feedback!.includes('speckit-specify/SKILL') && req.pack.feedback!.includes('"## login:')) {
        return { ...(await done(req)), questions: [{ text: 'Qual moeda?', blocking: true, options: [choice] }, { text: '  qual   MOEDA? ', blocking: false }, { text: 'Precisa de 2FA?', blocking: false }] };
      }
      return done(req);
    };
    const s = await detailedSession();
    await s.runSpeckit();
    const asked = s.state.questions.filter((q) => q.origin === 'speckit');
    expect(asked.map((q) => [q.text, q.blocking, q.itemKey, q.status])).toEqual([['Qual moeda?', true, 'login', 'pending'], ['Precisa de 2FA?', false, 'login', 'pending']]);
    expect(asked[0]!.options).toEqual([choice]);
    expect(new Set(asked.map((q) => q.questionId)).size).toBe(2);
    expect(s.state.speckit?.status).toBe('done');
    expect(canStart(s.state)).toBe(false);
    // The answer goes into briefing.md, which makes the preparation stale until the owner runs it again.
    await s.answer(asked[0]!.questionId, 'Real');
    expect(await fs.readFile(`${draft().docs}/briefing.md`, 'utf8')).toContain('Real');
    expect(s.state.speckit?.stale).toBe(true);
    expect(canStart(s.state)).toBe(false);
    // A re-run that asks the same questions again adds none.
    await s.runSpeckit();
    expect(s.state.questions.filter((q) => q.origin === 'speckit')).toHaveLength(2);
    expect(canStart(s.state)).toBe(true);
    await s.close();
  });

  it('drops a reworded question the Jev calls a repeat of one already asked', async () => {
    answer = askItems({ login: [{ text: 'Qual moeda?', blocking: false }], cart: [{ text: 'Em que moeda cobramos?', blocking: false }, { text: 'Precisa de 2FA?', blocking: false }] });
    const jevs = jev((pair) => /Question B: .*moeda/i.test(pair));
    const s = await detailedSession(jevs as never);
    await s.runSpeckit();
    const asked = s.state.questions.filter((q) => q.origin === 'speckit').map((q) => q.text);
    expect(asked).toHaveLength(2);
    expect(asked).toContain('Precisa de 2FA?');
    expect(asked.filter((t) => /moeda/i.test(t))).toHaveLength(1);
    await s.close();
  });

  it('keeps both questions when the Jev gives no answer', async () => {
    answer = askItems({ login: [{ text: 'Qual moeda?', blocking: false }], cart: [{ text: 'Em que moeda cobramos?', blocking: false }] });
    const s = await detailedSession(jev(() => null) as never);
    await s.runSpeckit();
    expect(s.state.questions.filter((q) => q.origin === 'speckit')).toHaveLength(2);
    await s.close();
  });

  it('keeps a blocking question that repeats a pending non-blocking one, so the start still waits for it', async () => {
    answer = askItems({ login: [{ text: 'Qual moeda?', blocking: false }], cart: [{ text: 'Em que moeda cobramos?', blocking: true }] });
    const s = await detailedSession(jev(() => true) as never);
    await s.runSpeckit();
    expect(s.state.questions.some((q) => q.origin === 'speckit' && q.blocking && /moeda/i.test(q.text))).toBe(true);
    expect(canStart(s.state)).toBe(false);
    await s.close();
  });

  it('drops an exact repeat without asking the Jev, on the first run and on a re-run', async () => {
    answer = askItems({ login: [{ text: 'Qual moeda?', blocking: false }], cart: [{ text: '  qual   MOEDA? ', blocking: false }] });
    const jevs = jev(() => true);
    const s = await detailedSession(jevs as never);
    await s.runSpeckit();
    await s.runSpeckit();
    expect(s.state.questions.filter((q) => q.origin === 'speckit')).toHaveLength(1);
    expect(jevs.decide).not.toHaveBeenCalled();
    await s.close();
  });

  it('sends the Jev the confidential flag, so a confidential project keeps its duplicate check local', async () => {
    answer = askItems({ login: [{ text: 'Qual moeda?', blocking: false }], cart: [{ text: 'Em que moeda cobramos?', blocking: false }] });
    const jevs = jev(() => false);
    const s = await detailedSession(jevs as never);
    await s.answerConfidentiality(true);
    await s.runSpeckit();
    expect(jevs.decide).toHaveBeenCalled();
    for (const [, , , ctx] of jevs.decide.mock.calls) expect(ctx).toEqual({ confidential: true });
    await s.close();
  });

  it('records each Jev answer on the spec as a DECISION_MADE, so evals can read it', async () => {
    answer = askItems({ login: [{ text: 'Qual moeda?', blocking: false }], cart: [{ text: 'Em que moeda cobramos?', blocking: false }] });
    const s = await detailedSession(jev(() => false) as never);
    await s.runSpeckit();
    const made = (await loadEvents(draft().events)).filter((e) => e.type === 'DECISION_MADE').map((e) => e.data as { cycle: number; record: { decisionId: string } });
    const dedup = made.filter((m) => m.record.decisionId === 'question-dedup');
    expect(dedup.length).toBeGreaterThan(0);
    expect(dedup.every((m) => m.cycle === s.state.cycle)).toBe(true);
    await s.close();
  });

  it('tells the agent to list open points as questions instead of asking, and to follow the decisions in briefing.md', () => {
    const p = speckitPack({ command: 'plan', specHash: 'sha256:x', inputDir: '/w/in', item: { key: 'login', specId: 'login', title: 'Entrar' } });
    expect(p.feedback).toContain('`questions`');
    expect(p.feedback).toContain('[NEEDS CLARIFICATION]');
    expect(p.feedback).toContain('## Decisões');
    expect(p.feedback).toContain('/w/in/briefing.md');
  });

  it("names each item's feature folder after its key, and hands it to that item's steps in the environment", async () => {
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit?.features).toEqual({ login: 'specs/login', cart: 'specs/cart' });
    expect(agentCalls.find((r) => stepOf(r) === 'specify:login')!.extraEnv).toEqual({ SPECIFY_FEATURE_DIRECTORY: 'specs/login', SPECIFY_FEATURE_NO_PERSIST: '1' });
    expect(agentCalls.find((r) => stepOf(r) === 'constitution:')!.extraEnv).toBeUndefined();
    await s.close();
    expect(await speckitFeatureOf(draft().root, 'cart')).toBe('specs/cart');
    expect(await speckitFeatureOf(draft().root, 'other')).toBeUndefined();
  });

  it('a step that reports a file it never wrote fails, and does not count as done', async () => {
    answer = (req) => (stepOf(req) === 'plan:login' ? { status: 'done', summary: 'ok', files: ['specs/login/plan.md'] } : done(req));
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.speckit?.error).toContain('/speckit-plan de login');
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitFailed)!.data.detail).toBe('specs/login/plan.md');
    expect(s.state.speckit?.steps.at(-1)).toMatchObject({ command: 'clarify', itemKey: 'login' });
    expect(canStart(s.state)).toBe(false);
    await s.close();
  });

  it('a specify step that leaves no feature folder fails, and does not count as done', async () => {
    answer = (req) => (stepOf(req) === 'specify:cart' ? wrote(req, ['notes.md']) : done(req));
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.speckit?.error).toContain('/speckit-specify de cart');
    expect(s.state.speckit?.steps.at(-1)).toMatchObject({ command: 'tasks', itemKey: 'login' });
    expect(s.state.speckit?.features).toEqual({ login: 'specs/login' });
    await s.close();
  });

  it('a specify step whose feature folder is not on disk fails, and records no feature', async () => {
    answer = async (req) => {
      if (stepOf(req) !== 'specify:cart') return done(req);
      // Spec Kit recorded a folder it never made, and the step reports no file; the item's own folder is the one that counts.
      await fs.mkdir(`${req.cwd}/.specify`, { recursive: true });
      await fs.writeFile(`${req.cwd}/.specify/feature.json`, '{"feature_directory":"specs/002-cart"}');
      return { status: 'done', summary: 'ok', files: [] };
    };
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.speckit?.error).toContain('não criou a pasta da feature em /speckit-specify de cart');
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitFailed)!.data.detail).toContain('no specs/cart/spec.md');
    expect(s.state.speckit?.features).toEqual({ login: 'specs/login' });
    await s.close();
  });

  it('a step that leaves a [NEEDS CLARIFICATION] marker in a file it wrote stops the preparation with its questions on record, and a re-run resumes at it', async () => {
    answer = async (req) => {
      if (stepOf(req) !== 'clarify:login') return done(req);
      await fs.writeFile(`${req.cwd}/specs/login/spec.md`, '- FR-001: reter os dados por [NEEDS CLARIFICATION: prazo de retenção]\n');
      return { status: 'done', summary: 'ok', files: ['specs/login/spec.md'], questions: [{ text: 'Qual o prazo de retenção?', blocking: false }] };
    };
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.speckit?.error).toContain('/speckit-clarify de login');
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitFailed)!.data.detail).toBe('specs/login/spec.md');
    expect(s.state.questions).toEqual([expect.objectContaining({ text: 'Qual o prazo de retenção?', origin: 'speckit', status: 'pending' })]);
    expect(s.state.speckit?.steps.at(-1)).toMatchObject({ command: 'specify', itemKey: 'login' });
    expect(canStart(s.state)).toBe(false);
    const before = agentCalls.length;
    answer = done;
    await s.runSpeckit();
    expect(agentCalls.slice(before).map(stepOf)[0]).toBe('clarify:login');
    expect(s.state.speckit).toMatchObject({ status: 'done' });
    expect(canStart(s.state)).toBe(true);
    await s.close();
  });

  it('a step whose own file leaves out an acceptance criterion id of its item stops the preparation, and a re-run resumes at it', async () => {
    answer = async (req) => {
      if (stepOf(req) !== 'tasks:login') return done(req);
      // An id counts only as a whole word: AC-0021 is not AC-002.
      await fs.writeFile(`${req.cwd}/specs/login/tasks.md`, '- T001 [AC-001] criar a rota\n- T002 [AC-0021] listar\n');
      return { status: 'done', summary: 'ok', files: ['specs/login/tasks.md'], questions: [{ text: 'Listar por data?', blocking: false }] };
    };
    const s = await detailedSession();
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.speckit?.error).toContain('critérios de aceite');
    expect(s.state.speckit?.error).toContain('/speckit-tasks de login');
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitFailed)!.data.detail).toBe('specs/login/tasks.md: AC-002');
    expect(s.state.questions).toEqual([expect.objectContaining({ text: 'Listar por data?', origin: 'speckit', status: 'pending' })]);
    expect(s.state.speckit?.steps.at(-1)).toMatchObject({ command: 'plan', itemKey: 'login' });
    expect(canStart(s.state)).toBe(false);
    const before = agentCalls.length;
    answer = done;
    await s.runSpeckit();
    expect(agentCalls.slice(before).map(stepOf)[0]).toBe('tasks:login');
    expect(s.state.speckit).toMatchObject({ status: 'done' });
    await s.close();
  });

  it('refuses before the backlog is detailed and while a preparation runs', async () => {
    const plain = await RefineSession.create(deps(), 'new-project');
    expect(() => plain.runSpeckit()).toThrow(ConflictError);
    await plain.close();
    const s = await detailedSession();
    let release!: () => void;
    exec = (spec) => new Promise((resolve) => (release = () => resolve({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: spec.args.length < 0 })));
    const first = s.runSpeckit();
    expect(() => s.runSpeckit()).toThrow(ConflictError);
    // The preparation first writes its inputs, so the command starts a little after the call: wait for it rather than a fixed time.
    await vi.waitFor(() => expect(release).toBeDefined());
    release();
    await first;
    await s.close();
  });

  it('an error before the preparation starts is journaled as a failure the owner sees', async () => {
    const s = await detailedSession();
    await fs.rm(draft().stackMd);
    await expect(s.runSpeckit()).resolves.toBeUndefined();
    expect(s.state.speckit).toMatchObject({ status: 'failed', error: 'A preparação do Spec Kit parou por um erro interno. Tente de novo.' });
    expect(s.events.find((e) => e.type === RefineEvent.SpeckitFailed)!.data.detail).toContain('ENOENT');
    expect(agentCalls).toHaveLength(0);
    await s.close();
  });

  it('a preparation cut by a restart reopens as failed', async () => {
    const s = await detailedSession();
    await s.close();
    const journal = await RefineJournal.open(draft().events, { projectId: 'hello-app', specId: 'hello-001' });
    await journal.fact(RefineEvent.SpeckitStarted, { total: 7 });
    await journal.close();
    const reopened = await RefineSession.open(deps());
    expect(reopened.state.speckit).toMatchObject({ status: 'failed', error: 'A preparação foi interrompida quando o servidor reiniciou.' });
    await reopened.close();
  });

  it('copies the five documents and writes specs.md outside the published folder, fresh on each run, and hashes them', async () => {
    const s = await detailedSession();
    const dir = `${draft().root}/speckit-input`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/old.md`, 'x');
    await writeDoc(draft(), 'briefing.md', '# Briefing\n\n## Objetivo\n\nVender\n');
    await s.runSpeckit();
    expect((await fs.readdir(dir)).sort()).toEqual(['briefing.md', 'design.md', 'flow.md', 'project.md', 'specs.md', 'stack.md']);
    const read = (file: string) => fs.readFile(`${dir}/${file}`, 'utf8');
    expect(await read('briefing.md')).toBe('# Briefing\n\n## Objetivo\n\nVender\n');
    expect(await read('stack.md')).toBe(await fs.readFile(draft().stackMd, 'utf8'));
    const specs = await read('specs.md');
    expect(specs.indexOf('## login: Item login')).toBeLessThan(specs.indexOf('## cart: Item cart'));
    await expect(fs.access(`${draft().root}/speckit/specs.md`)).rejects.toThrow();
    const first = s.events.find((e) => e.type === RefineEvent.SpeckitDone)!.data.inputHash;
    await s.saveDoc('stack.md', '# Stack\n\nGo\n');
    await s.runSpeckit();
    expect(s.events.filter((e) => e.type === RefineEvent.SpeckitDone).at(-1)!.data.inputHash).not.toBe(first);
    await s.close();
  });
});

describe('RefineSession.runSpeckit in parallel, and from an earlier run', () => {
  /** The detailed session, reopened with the options given. */
  async function detailedWith(extra: { speckitAgents?: () => Promise<number> }): Promise<RefineSession> {
    const s = await detailedSession();
    await s.close();
    return RefineSession.open({ ...deps(), ...extra });
  }
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('runs the items side by side, never more than the agents setting, and the constitution alone before them', async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    answer = async (req) => {
      const name = stepOf(req);
      order.push(`start ${name}`);
      active += 1;
      peak = Math.max(peak, active);
      await pause();
      active -= 1;
      order.push(`end ${name}`);
      return done(req);
    };
    const s = await detailedWith({ speckitAgents: async () => 2 });
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'done', total: 9 });
    expect(peak).toBe(2);
    expect(order.slice(0, 2)).toEqual(['start constitution:', 'end constitution:']);
    for (const key of ['login', 'cart']) {
      expect(order.filter((line) => line.startsWith('start') && line.endsWith(`:${key}`))).toEqual([`start specify:${key}`, `start clarify:${key}`, `start plan:${key}`, `start tasks:${key}`]);
    }
    expect(s.state.speckit!.steps).toHaveLength(9);
    await s.close();
  });

  it('a step that stops one item keeps the other from starting a new step, and the first error is reported', async () => {
    answer = async (req) => {
      if (stepOf(req) === 'specify:login') return { status: 'blocked', summary: 'parou', files: [], reason: 'o login não fecha' };
      await pause();
      return done(req);
    };
    const s = await detailedWith({ speckitAgents: async () => 2 });
    await s.runSpeckit();
    expect(s.state.speckit).toMatchObject({ status: 'failed' });
    expect(s.state.speckit?.error).toContain('/speckit-specify de login');
    expect(agentCalls.map(stepOf)).toEqual(['constitution:', 'specify:login', 'specify:cart']);
    await s.close();
  });

  it('two items asking the same question at once leave one question on record', async () => {
    answer = async (req) => {
      const out = await done(req);
      return stepOf(req).startsWith('specify') ? { ...out, questions: [{ text: 'Qual o prazo do link?', blocking: false }] } : out;
    };
    const s = await detailedWith({ speckitAgents: async () => 2 });
    await s.runSpeckit();
    expect(s.state.questions.map((q) => q.text)).toEqual(['Qual o prazo do link?']);
    await s.close();
  });

  it('a second preparation of the same inputs runs no agent step and calls Spec Kit init no more', async () => {
    const s = await detailedSession();
    await s.runSpeckit();
    const calls = agentCalls.length;
    const inits = execCalls.length;
    await s.runSpeckit();
    expect(agentCalls).toHaveLength(calls);
    expect(execCalls).toHaveLength(inits);
    expect(s.state.speckit).toMatchObject({ status: 'done', total: 9 });
    expect(s.state.speckit!.steps).toHaveLength(9);
    expect(s.state.speckit!.steps.every((step) => step.reused)).toBe(true);
    expect(canStart(s.state)).toBe(true);
    await s.close();
  });

  it("after an owner's answer, the next preparation runs every step again, on the files it has", async () => {
    let asks = true;
    answer = async (req) => {
      const out = await done(req);
      if (asks && stepOf(req) === 'plan:login') {
        asks = false;
        return { ...out, questions: [{ text: 'Quantas tentativas?', blocking: false }] };
      }
      return out;
    };
    const s = await detailedSession();
    await s.runSpeckit();
    const question = s.state.questions.find((q) => q.text === 'Quantas tentativas?')!;
    expect(question.status).toBe('pending');
    await s.answer(question.questionId, '5 tentativas');
    const before = agentCalls.length;
    const inits = execCalls.length;
    await s.runSpeckit();
    expect(agentCalls.slice(before).map(stepOf)).toEqual(['constitution:', 'specify:login', 'clarify:login', 'plan:login', 'tasks:login', 'specify:cart', 'clarify:cart', 'plan:cart', 'tasks:cart']);
    expect(agentCalls.slice(before).every((r) => r.pack.feedback!.includes('Its files from an earlier run'))).toBe(true);
    expect(execCalls).toHaveLength(inits);
    expect(s.state.speckit).toMatchObject({ status: 'done', total: 9 });
    expect(s.state.speckit!.steps).toHaveLength(9);
    await s.close();
  });

  it('an item removed from the backlog loses its feature folder from the staging folder', async () => {
    const s = await detailedSession();
    await s.runSpeckit();
    await s.close();
    const journal = await RefineJournal.open(draft().events, { projectId: 'hello-app', specId: 'hello-001' });
    await journal.fact(RefineEvent.BacklogDerived, { project: null, epics: [], items: [item('login', 1)], cycle: 1 });
    await journal.close();
    const reopened = await RefineSession.open(deps());
    await reopened.runSpeckit();
    await expect(fs.access(`${draft().root}/speckit/specs/cart`)).rejects.toThrow();
    await fs.access(`${draft().root}/speckit/specs/login`);
    await reopened.close();
  });

  it('reports the first failure, not a later one of a step that was already running', async () => {
    answer = async (req) => {
      if (stepOf(req) === 'constitution:') return done(req);
      if (stepOf(req) === 'specify:login') return { status: 'blocked', summary: 'parou', files: [], reason: 'o login não fecha' };
      await pause();
      return null;
    };
    const s = await detailedWith({ speckitAgents: async () => 2 });
    await s.runSpeckit();
    expect(s.state.speckit?.error).toContain('/speckit-specify de login');
    await s.close();
  });

  it('a step whose file is gone from the folder runs again, even when its basis still matches', async () => {
    const s = await detailedSession();
    await s.runSpeckit();
    await fs.rm(`${draft().root}/speckit/specs/login/plan.md`);
    const calls = agentCalls.length;
    await s.runSpeckit();
    expect(agentCalls.slice(calls).map(stepOf)).toEqual(['plan:login']);
    await s.close();
  });

  it('a question a step leaves pending does not make the next preparation run that step again', async () => {
    answer = async (req) => {
      const out = await done(req);
      return stepOf(req) === 'clarify:login' ? { ...out, questions: [{ text: 'Qual o limite?', blocking: false }] } : out;
    };
    const s = await detailedSession();
    await s.runSpeckit();
    const calls = agentCalls.length;
    await s.runSpeckit();
    expect(agentCalls.slice(calls).map(stepOf)).toEqual([]);
    await s.close();
  });

  it('shows the preparation as started before the questions an earlier one left are tried', async () => {
    answer = askItems({ login: [{ text: 'Qual o prazo do link?', blocking: false }] });
    const s = await detailedSession();
    await s.runSpeckit();
    const from = s.events.length;
    answerFromDocs = answersIn;
    await s.runSpeckit();
    const types = s.events.slice(from).map((e) => e.type);
    expect(types.indexOf(RefineEvent.SpeckitStarted)).toBeGreaterThanOrEqual(0);
    expect(types.indexOf(RefineEvent.SpeckitStarted)).toBeLessThan(types.indexOf(RefineEvent.SpeckitTriaged));
    await s.close();
  });
});

describe('RefineSession.runSpeckit for a project that already uses Spec Kit', () => {
  /** Main's constitution and feature folders, where the draft keeps them; main's cart folder shares its name with a backlog item. */
  const MAIN = { '.specify/memory/constitution.md': '# Main constitution\n', 'specs/001-orders/spec.md': '# Orders\n', 'specs/cart/spec.md': '# Main cart\n' };
  const staged = (rel: string) => fs.readFile(`${draft().root}/speckit/${rel}`, 'utf8');

  beforeEach(async () => {
    for (const [rel, text] of Object.entries(MAIN)) {
      const file = path.posix.join(speckitBaseDir(draft()), rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    }
    // Spec Kit init scaffolds its template constitution, as the real command does.
    exec = async (spec) => {
      execCalls.push(spec);
      await fs.mkdir(`${spec.cwd}/.specify/memory`, { recursive: true });
      await fs.writeFile(`${spec.cwd}/.specify/memory/constitution.md`, '# [PROJECT_NAME] Constitution\n');
      return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false };
    };
  });

  it("keeps main's constitution and feature folders in the staging folder, and the constitution step does not run", async () => {
    const s = await detailedSession();
    await s.runSpeckit();
    expect(agentCalls.map(stepOf)).toEqual(['specify:login', 'clarify:login', 'plan:login', 'tasks:login', 'specify:cart', 'clarify:cart', 'plan:cart', 'tasks:cart']);
    expect(await staged('.specify/memory/constitution.md')).toBe(MAIN['.specify/memory/constitution.md']);
    expect(await staged('specs/001-orders/spec.md')).toBe(MAIN['specs/001-orders/spec.md']);
    expect(s.state.speckit).toMatchObject({ status: 'done', total: 9 });
    expect(s.state.speckit!.steps).toHaveLength(9);
    expect(s.state.speckit!.steps[0]).toEqual({ command: 'constitution', reused: true });
    await s.close();
  });

  it("a later preparation does not run the constitution step either, and keeps main's folders as main has them", async () => {
    const s = await detailedSession();
    await s.runSpeckit();
    await s.close();
    // The cart item, whose steps rewrote main's cart folder, leaves the backlog.
    const journal = await RefineJournal.open(draft().events, { projectId: 'hello-app', specId: 'hello-001' });
    await journal.fact(RefineEvent.BacklogDerived, { project: null, epics: [], items: [item('login', 1)], cycle: 1 });
    await journal.close();
    const reopened = await RefineSession.open(deps());
    const calls = agentCalls.length;
    await reopened.runSpeckit();
    expect(agentCalls.slice(calls).map(stepOf)).not.toContain('constitution:');
    expect(reopened.state.speckit).toMatchObject({ status: 'done', total: 5 });
    for (const [rel, text] of Object.entries(MAIN)) expect(await staged(rel), rel).toBe(text);
    await reopened.close();
  });
});
