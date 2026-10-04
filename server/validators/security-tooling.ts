import type { Gate, Plan } from '../contracts/plan.js';

/** Gate that makes the scanners available; gates are separate containers, so it installs into the worktree. */
export const TOOLS_GATE = 'security-tools';
export const TOOLS_DIR = '.tools/bin';
const PATH_PREFIX = 'PATH=$PWD/.tools/bin:$PATH';

export type StackKind = 'node' | 'python' | 'other';

export function stackKind(stack: string): StackKind {
  if (/\b(node|nodejs|typescript|javascript|npm|pnpm|yarn|bun|deno)\b/i.test(stack)) return 'node';
  if (/\b(python|pip|django|flask|fastapi|poetry)\b/i.test(stack)) return 'python';
  return 'other';
}

/** Prescribed commands per gate; for dependency-scan the stack-native audit comes first. */
export function prescribedCommands(kind: StackKind): Record<string, string[]> {
  const dependency = ['osv-scanner scan source -r .'];
  if (kind === 'node') dependency.unshift('npm audit --audit-level=high');
  if (kind === 'python') dependency.unshift('pip-audit');
  return {
    'secret-scan': ['gitleaks detect --no-git --source . --redact --exit-code 1'],
    sast: ['semgrep scan --config auto --severity ERROR --error --metrics off .'],
    'dependency-scan': dependency,
    'image-scan': ['trivy image --input <image-archive> --severity CRITICAL --exit-code 1'],
  };
}

const DISARMED = /\|\|\s*(true|exit\s+0|:)|--exit-code[= ]0\b|--exit-zero\b|--no-fail\b/;
const ENV_PREFIX = /^(?:[A-Za-z_]\w*=\S*\s+)+/;
const bare = (command: string) => command.trim().replace(ENV_PREFIX, '');

interface Rule {
  name: string;
  /** Per-stack allowlist test on the command with env assignments removed. */
  allowed: (cmd: string, kind: StackKind) => boolean;
  /** Extra requirements, as error fragments; empty when satisfied. */
  extra: (gate: Gate) => string[];
  /** Whether the gate must fetch from the network (DB or rule download). */
  egress: (gate: Gate) => boolean;
  what: string;
}

const RULES: Rule[] = [
  {
    name: 'secret-scan',
    what: 'gitleaks detect|dir',
    allowed: (c) => /^gitleaks\s+(detect|dir)\b/.test(c),
    extra: () => [],
    egress: () => false,
  },
  {
    name: 'sast',
    what: 'semgrep scan with --severity ERROR --error',
    allowed: (c) => /^semgrep(\s+scan)?\s/.test(c),
    extra: (g) => [
      ...(/--error\b/.test(g.command) ? [] : ['--error (non-zero exit on findings)']),
      ...(/--severity[= ]ERROR\b/.test(g.command) ? [] : ['--severity ERROR (high)']),
    ],
    egress: (g) => /--config[= ]\s*(auto|p\/|r\/)/.test(g.command),
  },
  {
    name: 'dependency-scan',
    what: 'osv-scanner, or npm audit --audit-level=high (node) / pip-audit (python)',
    allowed: (c, k) =>
      /^osv-scanner\s/.test(c) ||
      (k === 'node' && /^npm audit\b/.test(c) && /--audit-level[= ]high\b/.test(c)) ||
      (k === 'python' && /^pip-audit\b/.test(c)),
    extra: () => [],
    egress: () => true,
  },
  {
    name: 'image-scan',
    what: 'trivy image with --severity CRITICAL --exit-code 1',
    allowed: (c) => /^trivy\s+image\b/.test(c),
    extra: (g) => [
      ...(/--severity[= ]CRITICAL\b/.test(g.command) ? [] : ['--severity CRITICAL']),
      ...(/--exit-code[= ]1\b/.test(g.command) ? [] : ['--exit-code 1']),
    ],
    egress: () => true,
  },
];

/** Errors for a plan whose security gates are missing, non-blocking, disarmed or not the prescribed tools. */
export function validateSecurityGates(plan: Plan): string[] {
  const errors: string[] = [];
  const kind = stackKind(plan.stack);
  const index = (name: string) => plan.gates.findIndex((g) => g.name === name);

  const tools = plan.gates.find((g) => g.name === TOOLS_GATE);
  if (!tools) errors.push(`missing gate ${TOOLS_GATE}: a blocking egress gate that installs gitleaks, semgrep, osv-scanner and trivy into ${TOOLS_DIR}`);
  else {
    if (!tools.blocking) errors.push(`gate ${TOOLS_GATE} must be blocking`);
    if (tools.network !== 'egress') errors.push(`gate ${TOOLS_GATE} needs network egress to download the tools`);
  }

  for (const rule of RULES) {
    const gate = plan.gates.find((g) => g.name === rule.name);
    if (!gate) {
      errors.push(`missing security gate ${rule.name} (${rule.what})`);
      continue;
    }
    if (!gate.blocking) errors.push(`security gate ${rule.name} must be blocking`);
    const cmd = bare(gate.command);
    if (!rule.allowed(cmd, kind)) errors.push(`security gate ${rule.name} must run ${rule.what} for stack ${kind}; got "${gate.command}"`);
    else {
      const missing = rule.extra(gate);
      if (missing.length > 0) errors.push(`security gate ${rule.name} command must include ${missing.join(' and ')}`);
    }
    if (DISARMED.test(gate.command)) errors.push(`security gate ${rule.name} command ignores findings (${gate.command})`);
    if (rule.egress(gate) && gate.network !== 'egress') errors.push(`security gate ${rule.name} needs network egress (rule or database download)`);
    if (tools && index(TOOLS_GATE) > index(rule.name)) errors.push(`gate ${TOOLS_GATE} must come before ${rule.name}`);
  }

  const build = index('build');
  const image = index('image-scan');
  if (build >= 0 && image >= 0 && image < build) errors.push('gate image-scan must come after build');
  return errors;
}

/** Plan-pack text: the exact gates the SM must produce (roadmap R8.5). */
export function securityToolingRules(): string {
  const node = prescribedCommands('node');
  const py = prescribedCommands('python');
  const other = prescribedCommands('other');
  return [
    `- security gates are required, all blocking, in this order: ${TOOLS_GATE}, secret-scan, sast, dependency-scan, image-scan (image-scan after build)`,
    `  - ${TOOLS_GATE} (network egress): installs gitleaks, semgrep, osv-scanner and trivy into ${TOOLS_DIR} of the worktree (gates are separate containers, only the worktree persists; add .tools/ to .gitignore); gateImage must therefore have curl, tar and python3/pip (e.g. node:22-bookworm, not -slim). Every other security gate command starts with ${PATH_PREFIX} so it finds them`,
    `  - secret-scan: ${PATH_PREFIX} ${other['secret-scan']![0]}`,
    `  - sast (egress, rules are downloaded): ${PATH_PREFIX} ${other.sast![0]}`,
    `  - dependency-scan (egress): node stacks ${PATH_PREFIX} ${node['dependency-scan']![0]} (or ${node['dependency-scan']![1]}); python stacks ${py['dependency-scan']![0]} (or ${py['dependency-scan']![1]}); other stacks ${other['dependency-scan']![0]}`,
    `  - image-scan (egress, after build): ${PATH_PREFIX} ${other['image-scan']![0]}; <image-archive> is the image tarball the build writes inside the worktree (e.g. .tools/image.tar)`,
    '  - never weaken a security gate: no `|| true`, no `--exit-code 0`, no non-blocking gates; other tools are rejected',
  ].join('\n');
}
