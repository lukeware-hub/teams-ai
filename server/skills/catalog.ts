import type { Role } from '../config/config.js';

export interface PinnedSkill {
  id: string;
  repository: string;
  commit: string;
  roles: readonly Role[];
  purpose: string;
  /** The folder of the repository that holds the skill folders; the repository root when absent. */
  sourcePath?: string;
  /** A catalog the agent searches itself: its skills are never installed as native skills. */
  reference?: true;
}

export const PINNED_SKILLS: readonly PinnedSkill[] = [
  { id: 'impeccable', repository: 'https://github.com/pbakaus/impeccable', commit: '08d5b470495d242ca0470f4aeae1956c3a074f83', roles: ['front'], purpose: 'Design critique, visual craft and accessibility.', sourcePath: '.claude/skills' },
  { id: 'taste-skill', repository: 'https://github.com/leonxlnx/taste-skill', commit: 'f624f37a8c650b9cc550253104925efe4c8de246', roles: ['front'], purpose: 'Art direction, references and browser-based visual verification.', sourcePath: 'skills' },
  { id: 'playwright-cli', repository: 'https://github.com/microsoft/playwright-cli', commit: 'b85c7a736bb473bf55b584e54a09ffa698d6d871', roles: ['front', 'test'], purpose: 'Browser inspection, screenshots and selector diagnostics.', sourcePath: 'skills/playwright-cli' },
  { id: 'web-asset-generator', repository: 'https://github.com/alonw0/web-asset-generator', commit: 'c6d56dc54ab86eae4eeb1393d9c8cdc71ae8d1a8', roles: ['front'], purpose: 'Favicons, application icons and social media assets.', sourcePath: 'skills/web-asset-generator' },
  { id: 'ui-ux-pro-max', repository: 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill', commit: '56ea9cf174ed86786187daa9de0e6247cb0747e4', roles: ['front'], purpose: 'UI and UX design systems, patterns and platform guidance.', sourcePath: '.claude/skills' },
  { id: 'superpowers', repository: 'https://github.com/obra/superpowers', commit: 'bb92a77741419a4ab5f06e711a283343f1ada0c3', roles: ['dev', 'po', 'sm', 'front', 'devops', 'test'], purpose: 'Test-driven development, debugging, verification, brainstorming and planning.', sourcePath: 'skills' },
  { id: 'agentic-awesome-skills', repository: 'https://github.com/sickn33/agentic-awesome-skills', commit: 'c564f9f4aee8a143c48218805b65f0f6956c6264', roles: ['dev'], purpose: 'Local skill catalog and stack-aware capability discovery.', sourcePath: 'skills', reference: true },
  { id: 'cybersecurity-skills', repository: 'https://github.com/briiirussell/cybersecurity-skills', commit: 'c9ade0349f8ecd5c9c68a82a05d2b6012c5fa1d7', roles: ['sec'], purpose: 'Application security review patterns and vulnerability taxonomy.', sourcePath: 'skills' },
  { id: 'claude-cybersecurity', repository: 'https://github.com/AgriciDaniel/claude-cybersecurity', commit: 'bcc963894c065ab5ecbba0855c35fb5c4b1ef029', roles: ['sec'], purpose: 'OWASP, CWE, supply-chain, infrastructure and business-logic review.', sourcePath: 'skills/cybersecurity' },
  { id: 'hashicorp-agent-skills', repository: 'https://github.com/hashicorp/agent-skills', commit: 'f706481af9b8fedb66de909f6243ad29601afa0c', roles: ['devops'], purpose: 'Terraform and Packer implementation guidance.', sourcePath: 'plugins' },
  { id: 'devops-skills', repository: 'https://github.com/full-stack-skills/devops-skills', commit: 'd84e21931c485fe3b310178bbec297947f236743', roles: ['devops'], purpose: 'CI, deployment, containers and infrastructure automation.', sourcePath: 'skills' },
  { id: 'find-skills', repository: 'https://github.com/vercel-labs/skills', commit: '13e4063a1cf913f5606d57d42ab83a86f5001e04', roles: ['sm'], purpose: 'Search, assess and select the smallest suitable skill.', sourcePath: 'skills/find-skills' },
  { id: 'claude-code-setup', repository: 'https://github.com/anthropics/claude-plugins-official', commit: 'ea10b213686c90bb1984b2016937310e05336cf3', roles: ['dev'], purpose: 'Reads a new repository and recommends Claude Code hooks, subagents, skills and MCP servers.', sourcePath: 'plugins/claude-code-setup/skills' },
] as const;

export function skillsForRole(role: Role): readonly PinnedSkill[] {
  return PINNED_SKILLS.filter((skill) => skill.roles.includes(role));
}
