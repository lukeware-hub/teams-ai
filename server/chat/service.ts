import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runsDir, type IndexDeps } from '../api/run-index.js';
import type { ChatOutput } from '../agents/outputs.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { redactSecrets } from '../core/redact.js';
import { ID_PATTERNS, stepId } from '../core/ids.js';
import { ConflictError, NotFoundError } from '../refine/session.js';
import type { RunAgent } from '../refine/cycle.js';
import { fitPackBudget } from '../refine/fit-pack.js';
import type { FailureKind } from '../scheduler/retry-policy.js';
import type { StepOutcome } from '../runner/step.js';
import type { ResultSummary } from '../runner/stream-events.js';
import { buildChatContext, withoutCodes } from './context.js';
import { relatedMessages, stageChatFiles, stageFailureDetails, stageProjectGraph } from './guide.js';
import { chatPack, chatSystem } from './pack.js';
import { needsLabels, withRecordPointer } from './answer.js';
import { withSources } from './sources.js';
import type { ChatCorrection, ChatMessage, ChatStore, ChatUsage } from './store.js';

const MAX_QUESTION = 2_000;
/** The chat always answers with the small model: it only explains what the context and the guide say, and every question pays for the whole prompt. */
export const CHAT_MODEL = 'haiku';
const HISTORY_MESSAGES = 6;
const TIMEOUT_MS = 120_000;

/** The answer could not be produced; the message is plain Portuguese for the screen. */
export class ChatUnavailableError extends Error {}

const UNAVAILABLE: Partial<Record<FailureKind, string>> = {
  quota: 'O limite de uso do Claude acabou por agora. Tente de novo mais tarde, quando o limite renovar.',
  auth: 'A sessão do Claude expirou. Entre de novo em Status do ambiente e tente outra vez.',
  timeout: 'A resposta demorou demais. Tente uma pergunta mais curta ou mais específica.',
};
const UNAVAILABLE_DEFAULT = 'Não consegui responder agora. Tente de novo em instantes.';

/** The only commands the chat may run: queries on the guide graph. */
export const CHAT_ALLOW: readonly string[] = ['Bash(graphify query:*)', 'Bash(graphify explain:*)', 'Bash(graphify path:*)'];
/** What a project keeps inside its workspace; the wildcards cover a project created while a step runs. */
const PRIVATE_IN_WORKSPACE = ['repo', 'worktrees', 'graph', 'knowledge.sqlite', 'refine', 'services', 'environment', 'secrets'];

/** What the step reported it spent; absent when it reported nothing. */
export function usageOf(summary: Partial<ResultSummary> | undefined): ChatUsage | undefined {
  if (!summary?.usage) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = summary.usage;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: summary.costUsd ?? null, seconds: Math.round((summary.durationMs ?? 0) / 1000), turns: summary.numTurns ?? 0 };
}

export interface ChatDeps {
  /** The folder of the user guide (`docs/guia`), copied into each question's working directory. */
  guideDir: string;
  /** Where the technical detail of a failure goes; the screen only gets the plain message. */
  log?: (line: string) => void;
  store: ChatStore;
  index: () => Promise<IndexDeps>;
  runAgent: RunAgent;
  /** Where the step runner allows a working directory. */
  workspacesRoot: () => Promise<string>;
  /** A readable id for a new correction spec of the project. */
  suggestSpecId: (projectId: string, description: string) => Promise<string>;
  /** Opens the refinement draft of a spec; it never starts a run. */
  newSpec: (projectId: string, specId: string, description: string) => Promise<unknown>;
  /** Builds the project graph the chat queries again from the graphs its repositories already have. */
  refreshProjectGraph?: (projectId: string) => Promise<void>;
  /** Whether the project is confidential, so the chat may not search the web about it. A check that fails counts as confidential; without a check there is no search. */
  confidential?: (projectId: string) => Promise<boolean>;
  now?: () => Date;
}

/** A project graph older than this is rebuilt in the background; a question never waits for it. */
const GRAPH_TTL_MS = 30 * 60_000;
/** How long the first question of a project waits for its graph to be built. */
const GRAPH_WAIT_MS = 60_000;

/** Answers questions about a project and opens a correction spec when what is built goes against its spec. It never orders the orchestrator. */
export class ChatService {
  /** One question at a time: another chat's working directory is then never there for this step to read. */
  /** The question being answered, so clearing the conversation can stop it; its done resolves when the step has ended. */
  private inFlight: { projectId: string; controller: AbortController; done: Promise<void> } | null = null;
  /** The graph builds in flight, so two questions never build the same project graph at once. */
  private readonly refreshing = new Map<string, Promise<void>>();

  constructor(private readonly deps: ChatDeps) {}

  private slug(projectId: string): string {
    if (!ID_PATTERNS.SLUG.test(projectId)) throw new RangeError('projectId must be a lowercase slug');
    return projectId;
  }

  messages(projectId: string): Promise<ChatMessage[]> {
    return this.deps.store.read(this.slug(projectId));
  }

  /** Clearing stops the answer in progress for this project, waits for its step to end, and then clears the conversation. */
  async clear(projectId: string): Promise<void> {
    const flight = this.inFlight;
    if (flight?.projectId === this.slug(projectId)) {
      flight.controller.abort();
      await flight.done;
    }
    await this.deps.store.clear(this.slug(projectId));
  }

  /** The answer, or null when the conversation was cleared while it was coming. */
  async ask(projectId: string, text: string): Promise<ChatMessage | null> {
    this.slug(projectId);
    const question = text.trim();
    if (question === '' || question.length > MAX_QUESTION) throw new RangeError(`a pergunta deve ter de 1 a ${MAX_QUESTION} caracteres`);
    if (this.inFlight) throw new ConflictError('o chat ainda está respondendo a pergunta anterior. Aguarde a resposta e pergunte de novo.');
    const controller = new AbortController();
    let finish = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.inFlight = { projectId, controller, done };
    try {
      const context = await buildChatContext(await this.deps.index(), projectId);
      if (!context) throw new NotFoundError(`projeto ${projectId} não encontrado`);
      const history = await this.deps.store.read(projectId);
      const at = (this.deps.now?.() ?? new Date()).toISOString();
      const input = { context: context.text, name: context.name, specIds: context.specIds, details: context.details, history, opened: history.flatMap((m) => (m.correction?.specId ? [m.correction.title] : [])), question };
      let result = await this.run(projectId, input, controller.signal);
      // A question about what happened gets the labelled answer; up to two more tries, so a repeat costs at most two more questions.
      for (let tries = 1; tries < 3 && needsLabels(question, result.value.answer); tries++) result = await this.run(projectId, input, controller.signal);
      const { value, usage, searched } = result;
      // An answer that searched the web never opens a correction: the text of a page must not steer one.
      const correction = value.correction && !searched ? await this.open(projectId, value.correction) : undefined;
      const answer: ChatMessage = { role: 'assistant', text: withRecordPointer(withoutCodes(value.answer)), at, ...(correction ? { correction } : {}), ...(usage ? { usage } : {}) };
      if (controller.signal.aborted) return null;
      await this.deps.store.append(projectId, { role: 'user', text: question, at }, answer);
      return answer;
    } catch (err) {
      if (controller.signal.aborted) return null;
      throw err;
    } finally {
      finish();
      this.inFlight = null;
    }
  }

  /** Without a graph the first question waits for the build; with an old one it answers from it while the build runs. A failed build only reaches the log. */
  private async ensureProjectGraph(projectId: string, graphFile: string): Promise<void> {
    const refresh = this.deps.refreshProjectGraph;
    if (!refresh) return;
    const age = await fs.stat(graphFile).then((s) => Date.now() - s.mtimeMs, () => null);
    if (age !== null && age < GRAPH_TTL_MS) return;
    let build = this.refreshing.get(projectId);
    if (!build) {
      build = refresh(projectId)
        .catch((err: Error) => this.deps.log?.(`project graph not built for ${projectId}: ${err.message}`))
        .finally(() => this.refreshing.delete(projectId));
      this.refreshing.set(projectId, build);
    }
    if (age === null) await Promise.race([build, new Promise<void>((resolve) => setTimeout(resolve, GRAPH_WAIT_MS).unref())]);
  }

  /** One read-only agent step in a throwaway directory, like the name suggestion. */
  private async run(projectId: string, input: { context: string; name: string; specIds: readonly string[]; details: ReadonlyMap<string, string>; history: readonly ChatMessage[]; opened: readonly string[]; question: string }, signal: AbortSignal): Promise<{ value: ChatOutput; usage: ChatUsage | undefined; searched: boolean }> {
    // The same for every question of a project: the hash sits above the project context in the prompt, and a prompt that starts the same way is read from the cache instead of paid for again.
    const specHash = sha256(canonicalJson({ kind: 'chat', projectId }));
    // The web search needs a check that the project is not confidential; a check that fails, or none, means no search.
    const webSearch = this.deps.confidential !== undefined && (await this.deps.confidential(projectId).catch(() => true)) === false;
    const root = await this.deps.workspacesRoot();
    const cwd = path.join(root, '_chat', randomUUID());
    await fs.mkdir(cwd, { recursive: true });
    let seq = 0;
    try {
      await stageChatFiles(cwd, this.deps.guideDir);
      await stageFailureDetails(cwd, input.details);
      const projectGraph = path.join(root, projectId, 'graph', 'project', 'graphify-out', 'graph.json');
      await this.ensureProjectGraph(projectId, projectGraph);
      await stageProjectGraph(cwd, projectGraph);
      const out = (await this.deps.runAgent<'chat'>(
        { kind: 'chat', role: 'po', pack: fitPackBudget(chatPack({ opened: input.opened, question: input.question, history: input.history.slice(-HISTORY_MESSAGES), older: relatedMessages(input.history.slice(0, -HISTORY_MESSAGES), input.question), specHash })), systemExtra: chatSystem(input.context), cwd, phase: 'refine', taskId: null, attempt: 1, model: CHAT_MODEL, extraAllow: CHAT_ALLOW, webSearch, denyRead: await this.privateDirs(root, cwd) },
        { journal: { allocStepSeq: () => ++seq, fact: async () => undefined } as never, stepDir: (n) => path.join(cwd, 'steps', stepId(n)), specHash, signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]), noQuotaWait: true, projectId },
      )) as StepOutcome<ChatOutput>;
      const usage = usageOf(out.summary);
      const sources = out.summary.webSearchSources ?? [];
      const queries = out.summary.webSearchQueries ?? [];
      const searched = queries.length > 0;
      // The sources are the links the search returned, appended by the server: the model names them, it never writes an address.
      const answered = (value: ChatOutput): ChatOutput => ({ ...value, answer: withSources(value.answer, sources) });
      if (usage) this.deps.log?.(`chat ${projectId}: ${usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens} tokens read, ${usage.outputTokens} written, ${usage.turns} turns, ${usage.seconds}s, ${usage.costUsd === null ? 'no price' : `US$ ${usage.costUsd.toFixed(4)}`}${out.ok ? '' : ` (${out.failure})`}`);
      if (sources.length > 0) this.deps.log?.(`chat ${projectId}: web search: ${sources.length} source(s)`);
      // The rules keep the queries generic: a query that names the project or a spec is logged so the rules can be checked.
      for (const query of queries) {
        const named = [projectId, input.name, ...input.specIds].some((name) => name !== '' && query.toLowerCase().includes(name.toLowerCase()));
        this.deps.log?.(`chat ${projectId}: web search query: ${redactSecrets(query)}${named ? ' (the query names the project or a spec, which the rules forbid)' : ''}`);
      }
      if (out.ok) return { value: answered(out.value), usage, searched };
      // An answer in plain prose, with no JSON around it, is still the answer: only a correction proposal is lost.
      const prose = out.failure === 'schema' ? redactSecrets(out.summary.resultText?.trim() ?? '') : '';
      // Broken JSON is not an answer a person can read.
      if (prose && !/^\s*[{[]|```/.test(prose)) return { value: answered({ specHash, answer: prose, correction: null }), usage, searched };
      this.deps.log?.(`chat ${projectId}: ${out.failure}: ${out.errors.join('; ')}`);
      throw new ChatUnavailableError(UNAVAILABLE[out.failure] ?? UNAVAILABLE_DEFAULT);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }

  /**
   * Everything of the user that the chat must not read, by listing instead of trusting the prompt: every project's whole workspace
   * and every entry of the data folder except the workspaces (configuration and its backups, runs, conversations, caches, secrets), and the leftovers of other steps.
   * The step reads only its own working directory, which the staging filled. A listing that fails ends the step.
   */
  private async privateDirs(root: string, cwd: string): Promise<string[]> {
    const base = path.dirname(this.deps.store.dir);
    const projects = (await fs.readdir(root)).filter((name) => !name.startsWith('_'));
    const data = (await fs.readdir(base)).filter((name) => name !== path.basename(root));
    // What an earlier chat or a name suggestion left in the workspaces folder (the chat's own directory stays readable).
    const leftovers = [path.join(root, '_naming'), ...(await fs.readdir(path.join(root, '_chat'))).filter((name) => name !== path.basename(cwd)).map((name) => path.join(root, '_chat', name))];
    return [...new Set([
      ...PRIVATE_IN_WORKSPACE.map((dir) => path.join(root, '*', dir)),
      ...projects.map((project) => path.join(root, project)),
      ...data.map((name) => path.join(base, name)),
      ...leftovers,
      runsDir(await this.deps.index()),
      this.deps.store.dir,
    ])];
  }

  /** A failure to open the correction never loses the answer: the message says why instead. */
  private async open(projectId: string, c: NonNullable<ChatOutput['correction']>): Promise<ChatCorrection> {
    const description = [`Tipo: correção (bug)`, `Título: ${c.title}`, `O que acontece: ${c.whatHappens}`, `O que deveria acontecer: ${c.whatShouldHappen}`, 'Aberta pelo chat de perguntas.'].join('\n\n');
    try {
      const specId = await this.deps.suggestSpecId(projectId, description);
      await this.deps.newSpec(projectId, specId, description);
      return { title: c.title, specId };
    } catch (err) {
      this.deps.log?.(`chat ${projectId}: correction not opened: ${err instanceof Error ? err.message : String(err)}`);
      return { title: c.title, error: 'não consegui criar o rascunho agora. Crie a spec de correção à mão em Projetos.' };
    }
  }
}
