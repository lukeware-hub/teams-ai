import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROLES, type Role } from '../config/config.js';
import { DOCUMENT_CHARTER } from './document-charter.js';

export interface AgentDefinition {
  role: Role;
  description: string;
  model: string;
  tools: string[];
  body: string;
}

const READ_ONLY = ['Read', 'Grep', 'Glob'] as const;
const EDITING = [...READ_ONLY, 'Edit', 'Write'] as const;

/** Spec §3.4: agents only edit files and return JSON; Bash only where a role must run the suite. */
export const ROLE_TOOL_POLICY: Record<Role, { allowed: readonly string[] }> = {
  sm: { allowed: [...READ_ONLY, 'Bash', 'Skill'] },
  po: { allowed: [...READ_ONLY, 'Bash'] },
  front: { allowed: [...EDITING, 'Bash', 'Skill'] },
  dev: { allowed: [...EDITING, 'Bash', 'Skill'] },
  test: { allowed: [...EDITING, 'Bash', 'Skill'] },
  sec: { allowed: [...READ_ONLY, 'Bash', 'Skill'] },
  devops: { allowed: [...EDITING, 'Bash', 'Skill'] },
  env: { allowed: [...READ_ONLY, 'Bash'] },
};

/** Never granted to any agent; the orchestrator owns these (spec §3.2, §14). */
export const ALWAYS_DENIED: readonly string[] = [
  'Bash(gh:*)',
  'Bash(git push:*)',
  'Bash(docker:*)',
  'Bash(kubectl:*)',
  // The project settings directory is where sandbox and permission rules would be read from;
  // an agent must never be able to rewrite it.
  'Edit(.claude/**)',
];

/**
 * Nested invocations of the orchestrator-only commands through allowed interpreters. These match the
 * command text, so they are defense in depth only: `node` and `npm run` can still build a command
 * string at runtime. The real boundary is the empty per-step HOME (no gh/kube/docker credentials to
 * use) plus the sandbox (network allowlist, filesystem confinement).
 */
export const NESTED_DENIED: readonly string[] = [
  'Bash(node -e:*)',
  'Bash(node --eval:*)',
  'Bash(node -p:*)',
  'Bash(node --print:*)',
  'Bash(python -c:*)',
  'Bash(python3 -c:*)',
  'Bash(npm exec:*)',
  'Bash(npm x:*)',
  'Bash(npx gh:*)',
  'Bash(npx kubectl:*)',
  'Bash(* git push*)',
  'Bash(* kubectl *)',
  'Bash(* docker *)',
  'Bash(* gh *)',
  'Bash(*/opt/teams-ai-bin/*)',
  // Shell redirects and scripts must not write the worktree settings directory either (audit M2).
  'Bash(*.claude/*)',
];

export class AgentFileError extends Error {}

/**
 * `model:` and `effort:` in an agent file's frontmatter are descriptive only. The real model always comes from
 * `server/config/config.ts` (`CLAUDE_DEFAULTS`); `buildInvocation` (`server/runner/invocation.ts:83,88`) sends
 * `input.model` (the step's model), never `fields.model`. `effort:` isn't even carried into `AgentDefinition`
 * below - it is parsed into `fields` and dropped. The real effort, when any is set, comes only from the
 * model-tier decision (`server/decide/decisions/model-tier.ts`, off by default) on implement and review steps.
 */
const REQUIRED_FIELDS = ['name', 'description', 'model', 'tools'] as const;

export function parseAgentFile(text: string, expectedRole: Role): AgentDefinition {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new AgentFileError(`${expectedRole}: missing frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (m) fields[m[1]!] = m[2]!.trim();
  }
  for (const field of REQUIRED_FIELDS) {
    if (!fields[field]) throw new AgentFileError(`${expectedRole}: frontmatter is missing "${field}"`);
  }
  if (fields.name !== expectedRole) {
    throw new AgentFileError(`${expectedRole}: frontmatter name "${fields.name}" does not match the file`);
  }
  const tools = fields.tools!.split(',').map((t) => t.trim()).filter(Boolean);
  const allowed = ROLE_TOOL_POLICY[expectedRole].allowed;
  for (const tool of tools) {
    if (ALWAYS_DENIED.some((d) => tool === d || tool.startsWith(d.replace(/\*\)$/, '')))) {
      throw new AgentFileError(`${expectedRole}: tool "${tool}" is always denied`);
    }
    if (!allowed.includes(tool)) throw new AgentFileError(`${expectedRole}: tool "${tool}" is not allowed for this role`);
  }
  const body = match[2]!.trim();
  if (!body.includes('specHash')) throw new AgentFileError(`${expectedRole}: body must state the specHash echo rule`);
  return { role: expectedRole, description: fields.description!, model: fields.model!, tools, body };
}

/** Error rules every role follows: check the solutions first, search the web second, record what worked. */
export const ERROR_RULES = `Regras para erros, em todos os papéis:
Sempre que encontrar um erro:
1. Pense antes de agir: escreva uma hipótese curta com a causa provável e o plano de correção. Não altere nada antes disso.
2. Consulte primeiro a base de soluções da linguagem (skills/<linguagem>/solutions/). Se houver solução registrada, aplique-a.
3. Se não houver solução registrada, pesquise sempre com o Agent Reach (\`agent-reach\` no Bash) antes de tentar qualquer correção. Priorize documentação oficial, GitHub Issues e Stack Overflow, e soluções recentes compatíveis com a versão usada no projeto.
4. Aplique a solução e confirme que o erro foi resolvido, rodando de novo o comando, teste ou build.
5. Registre a solução validada na base de soluções. Se uma solução registrada falhar depois, atualize o registro em vez de criar um duplicado.
6. Nunca inclua segredos, tokens, senhas ou dados de clientes na pesquisa; remova-os da mensagem de erro antes de pesquisar.
7. Se o erro persistir após 3 tentativas, pare e reporte o que foi tentado.`;

/** Shared rules every role follows, whatever its job; appended to each agent prompt. */
export const QUALITY_RULES = `Quality rules for every role:
- Code comments: plain and very short, one sentence at most, easy to understand.
- Documentation: clear, simple and direct; no acronyms, no abbreviations, no references to look up elsewhere; each point summed up in one sentence with its context.
- Code: clear, objective, simple and bug-free; always apply:
  - KISS (keep it simple): smallest working solution, short functions, no needless variables; prefer the language's native features over hand-written logic.
  - YAGNI (you aren't gonna need it): build only what is used now; remove commented-out and unused code.
  - DRY (don't repeat yourself): no duplicated logic or ambiguity; split into small, reusable, clearly named functions.

Delivery goals to keep in mind in every decision:
- Code quality: readable, consistent and easy to change.
- Security: no vulnerabilities; validate input, protect secrets, least privilege.
- Very low cost: the cheapest software to run and maintain.
- Very high performance: fast and light on resources.
- Infrastructure: simple, reproducible and reliable.
- Architecture: clear boundaries, low coupling.
- Evolution: easy to extend without rewriting.
- Fewest failures: no hidden bugs and nothing that breaks later; cover edge cases.
- Delivery: complete, verified and working as asked.`;

export async function loadAgents(dir: string): Promise<Record<Role, AgentDefinition>> {
  const out = {} as Record<Role, AgentDefinition>;
  for (const role of ROLES) {
    const file = path.join(dir, `${role}.md`);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      throw new AgentFileError(`missing agent file ${file}`);
    }
    const def = parseAgentFile(text, role);
    out[role] = { ...def, body: `${def.body}\n\n${DOCUMENT_CHARTER}\n\n${QUALITY_RULES}\n\n${ERROR_RULES}` };
  }
  return out;
}
