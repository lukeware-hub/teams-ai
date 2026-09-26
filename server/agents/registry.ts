import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROLES, type Role } from '../config/config.js';

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
  sm: { allowed: READ_ONLY },
  po: { allowed: READ_ONLY },
  front: { allowed: [...EDITING, 'Bash'] },
  dev: { allowed: [...EDITING, 'Bash'] },
  test: { allowed: [...EDITING, 'Bash'] },
  devops: { allowed: EDITING },
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

export class AgentFileError extends Error {}

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
    out[role] = parseAgentFile(text, role);
  }
  return out;
}
