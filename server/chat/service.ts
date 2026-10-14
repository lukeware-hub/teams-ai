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
import { buildChatContext, withoutCodes } from './context.js';
import { stageChatFiles } from './guide.js';
import { chatPack } from './pack.js';
import type { ChatCorrection, ChatMessage, ChatStore } from './store.js';

const MAX_QUESTION = 2_000;
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
  now?: () => Date;
}

/** Answers questions about a project and opens a correction spec when what is built goes against its spec. It never orders the orchestrator. */
export class ChatService {
  private readonly asking = new Set<string>();

  constructor(private readonly deps: ChatDeps) {}

  private slug(projectId: string): string {
    if (!ID_PATTERNS.SLUG.test(projectId)) throw new RangeError('projectId must be a lowercase slug');
    return projectId;
  }

  messages(projectId: string): Promise<ChatMessage[]> {
    return this.deps.store.read(this.slug(projectId));
  }

  clear(projectId: string): Promise<void> {
    return this.deps.store.clear(this.slug(projectId));
  }

  async ask(projectId: string, text: string): Promise<ChatMessage> {
    this.slug(projectId);
    const question = text.trim();
    if (question === '' || question.length > MAX_QUESTION) throw new RangeError(`a pergunta deve ter de 1 a ${MAX_QUESTION} caracteres`);
    if (this.asking.has(projectId)) throw new ConflictError('o chat ainda está respondendo a pergunta anterior deste projeto');
    this.asking.add(projectId);
    try {
      const context = await buildChatContext(await this.deps.index(), projectId);
      if (!context) throw new NotFoundError(`projeto ${projectId} não encontrado`);
      const history = await this.deps.store.read(projectId);
      const at = (this.deps.now?.() ?? new Date()).toISOString();
      const value = await this.run(projectId, { context: context.text, history, opened: history.flatMap((m) => (m.correction?.specId ? [m.correction.title] : [])), question }, at);
      const correction = value.correction ? await this.open(projectId, value.correction) : undefined;
      const answer: ChatMessage = { role: 'assistant', text: withoutCodes(value.answer), at, ...(correction ? { correction } : {}) };
      await this.deps.store.append(projectId, { role: 'user', text: question, at }, answer);
      return answer;
    } finally {
      this.asking.delete(projectId);
    }
  }

  /** One read-only agent step in a throwaway directory, like the name suggestion. */
  private async run(projectId: string, input: { context: string; history: readonly ChatMessage[]; opened: readonly string[]; question: string }, at: string): Promise<ChatOutput> {
    const specHash = sha256(canonicalJson({ projectId, question: input.question, at }));
    const root = await this.deps.workspacesRoot();
    const cwd = path.join(root, '_chat', randomUUID());
    await fs.mkdir(cwd, { recursive: true });
    let seq = 0;
    try {
      await stageChatFiles(cwd, this.deps.guideDir, input.history);
      const out = (await this.deps.runAgent<'chat'>(
        { kind: 'chat', role: 'po', pack: fitPackBudget(chatPack({ ...input, history: input.history.slice(-HISTORY_MESSAGES), specHash })), cwd, phase: 'refine', taskId: null, attempt: 1, extraAllow: CHAT_ALLOW, denyRead: await this.privateDirs(root) },
        { journal: { allocStepSeq: () => ++seq, fact: async () => undefined } as never, stepDir: (n) => path.join(cwd, 'steps', stepId(n)), specHash, signal: AbortSignal.timeout(TIMEOUT_MS) },
      )) as StepOutcome<ChatOutput>;
      if (out.ok) return out.value;
      // An answer in plain prose, with no JSON around it, is still the answer: only a correction proposal is lost.
      const prose = out.failure === 'schema' ? redactSecrets(out.summary.resultText?.trim() ?? '') : '';
      // Broken JSON is not an answer a person can read.
      if (prose && !/^\s*[{[]|```/.test(prose)) return { specHash, answer: prose, correction: null };
      this.deps.log?.(`chat ${projectId}: ${out.failure}: ${out.errors.join('; ')}`);
      throw new ChatUnavailableError(UNAVAILABLE[out.failure] ?? UNAVAILABLE_DEFAULT);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }

  /**
   * Everything of the user that the chat must not read, by listing instead of trusting the prompt: every project's whole workspace
   * and every entry of the data folder except the workspaces (configuration and its backups, runs, conversations, caches, secrets).
   * The step reads only its own working directory, which the staging filled. A listing that fails ends the step.
   */
  private async privateDirs(root: string): Promise<string[]> {
    const base = path.dirname(this.deps.store.dir);
    const projects = (await fs.readdir(root)).filter((name) => !name.startsWith('_'));
    const data = (await fs.readdir(base)).filter((name) => name !== path.basename(root));
    return [...new Set([
      ...PRIVATE_IN_WORKSPACE.map((dir) => path.join(root, '*', dir)),
      ...projects.map((project) => path.join(root, project)),
      ...data.map((name) => path.join(base, name)),
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
