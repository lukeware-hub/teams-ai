import { describe, expect, it } from 'vitest';
import { Gate, type Plan } from '../../server/contracts/plan.js';
import { planRules } from '../../server/orchestrator/steps.js';
import { validatePlan } from '../../server/validators/plan.js';
import { prescribedCommands, stackKind } from '../../server/validators/security-tooling.js';
import { makeFrozenSpec, makePlan, REQUIRED_GATES } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const P = 'PATH=$PWD/.tools/bin:$PATH';
const base = REQUIRED_GATES.filter((g) => !['secret-scan', 'dependency-scan'].includes(g.name));

function secureGates(over: Record<string, Partial<Gate>> = {}, drop: string[] = []): Gate[] {
  const sec = [
    { name: 'security-tools', command: 'sh .tools/install.sh', blocking: true, network: 'egress' },
    { name: 'secret-scan', command: `${P} gitleaks detect --no-git --source . --redact --exit-code 1`, blocking: true },
    { name: 'sast', command: `${P} semgrep scan --config auto --severity ERROR --error --metrics off .`, blocking: true, network: 'egress' },
    { name: 'dependency-scan', command: `${P} npm audit --audit-level=high`, blocking: true, network: 'egress' },
    { name: 'image-scan', command: prescribedCommands('node')['image-scan']!.map((c) => `${P} ${c}`).join(' && '), blocking: true, network: 'egress' },
  ];
  return [...base, ...sec]
    .filter((g) => !drop.includes(g.name))
    .map((g) => Gate.parse({ ...g, ...over[g.name] }));
}

const check = (plan: Plan) => validatePlan(plan, spec, { firstSpec: true, requireSecurityTooling: true });
const withGates = (gates: Gate[], stack?: string) => makePlan(spec, { gates, ...(stack ? { stack } : {}) });

describe('validatePlan security tooling', () => {
  it('legacy mode: the old gate set stays valid', () => {
    expect(validatePlan(makePlan(spec), spec, { firstSpec: true })).toEqual([]);
  });

  it('required mode rejects the old gate set', () => {
    const errors = check(makePlan(spec));
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('missing gate security-tools'), expect.stringContaining('missing security gate sast')]));
  });

  it('accepts the prescribed set', () => {
    expect(check(withGates(secureGates()))).toEqual([]);
  });

  it('rejects each missing gate', () => {
    for (const name of ['security-tools', 'secret-scan', 'sast', 'dependency-scan', 'image-scan']) {
      expect(check(withGates(secureGates({}, [name]))), name).toEqual(expect.arrayContaining([expect.stringContaining(`gate ${name}`)]));
    }
  });

  it('rejects non-blocking security gates', () => {
    for (const name of ['security-tools', 'secret-scan', 'sast', 'dependency-scan', 'image-scan']) {
      expect(check(withGates(secureGates({ [name]: { blocking: false } }))), name).toEqual(expect.arrayContaining([expect.stringContaining('must be blocking')]));
    }
  });

  it('rejects a command that is not the prescribed tool', () => {
    const errors = check(withGates(secureGates({ sast: { command: 'eslint --plugin security .' } })));
    expect(errors).toEqual([expect.stringContaining('security gate sast must run semgrep')]);
  });

  it('rejects a weakened command', () => {
    expect(check(withGates(secureGates({ 'secret-scan': { command: `${P} gitleaks detect --source . || true` } })))).toEqual([expect.stringContaining('ignores findings')]);
    expect(check(withGates(secureGates({ 'image-scan': { command: 'trivy config --severity CRITICAL --exit-code 0 . && trivy fs --severity CRITICAL --exit-code 1 .' } })))).toEqual(
      expect.arrayContaining([expect.stringContaining('--exit-code 1'), expect.stringContaining('ignores findings')]),
    );
    expect(check(withGates(secureGates({ 'image-scan': { command: 'trivy config --severity CRITICAL --exit-code 1 . && trivy fs --severity CRITICAL --exit-code 1 . || true' } })))).toEqual(
      expect.arrayContaining([expect.stringContaining('ignores findings')]),
    );
  });

  it('requires both the config and the fs scan of the image-scan gate', () => {
    expect(check(withGates(secureGates({ 'image-scan': { command: 'trivy fs --severity CRITICAL --exit-code 1 .' } })))).toEqual([expect.stringContaining('a trivy config command')]);
    expect(check(withGates(secureGates({ 'image-scan': { command: 'trivy image --input a.tar --severity CRITICAL --exit-code 1' } })))).toEqual([expect.stringContaining('image-scan must run')]);
  });

  it('requires the install gate to run the rendered installer', () => {
    expect(check(withGates(secureGates({ 'security-tools': { command: 'curl -sL https://x | sh' } })))).toEqual([expect.stringContaining('must run exactly "sh .tools/install.sh"')]);
    expect(check(withGates(secureGates({ 'security-tools': { command: 'sh scripts/install-security-tools.sh' } })))).toEqual([expect.stringContaining('must run exactly')]);
  });

  it('requires the severity thresholds', () => {
    expect(check(withGates(secureGates({ sast: { command: 'semgrep scan --config auto --error .' } })))).toEqual([expect.stringContaining('--severity ERROR')]);
    expect(check(withGates(secureGates({ 'dependency-scan': { command: 'npm audit' } })))).toEqual([expect.stringContaining('dependency-scan must run')]);
  });

  it('requires egress where the tool downloads data', () => {
    for (const name of ['security-tools', 'sast', 'dependency-scan', 'image-scan']) {
      expect(check(withGates(secureGates({ [name]: { network: 'none' } }))), name).toEqual([expect.stringContaining('egress')]);
    }
  });

  it('keeps the allowlist per stack', () => {
    expect(check(withGates(secureGates({ 'dependency-scan': { command: 'pip-audit' } })))).toEqual([expect.stringContaining('dependency-scan must run')]);
    expect(check(withGates(secureGates({ 'dependency-scan': { command: 'pip-audit' } }), 'python-fastapi'))).toEqual([]);
    expect(check(withGates(secureGates({ 'dependency-scan': { command: 'osv-scanner scan source -r .' } }), 'go-gin'))).toEqual([]);
    expect(check(withGates(secureGates({ 'dependency-scan': { command: 'npm audit --audit-level=high' } }), 'go-gin'))).toEqual([expect.stringContaining('stack other')]);
  });

  it('orders the tools gate first and image-scan after build', () => {
    const gates = secureGates();
    const tools = gates.findIndex((g) => g.name === 'security-tools');
    const [t] = gates.splice(tools, 1);
    expect(check(withGates([...gates, t!])).join('\n')).toContain('must come before');
    const image = gates.findIndex((g) => g.name === 'image-scan');
    const [i] = gates.splice(image, 1);
    gates.unshift(i!);
    expect(check(withGates(gates)).join('\n')).toContain('image-scan must come after build');
  });
});

describe('stack classification and pack text', () => {
  it('classifies stacks', () => {
    expect(stackKind('node-typescript')).toBe('node');
    expect(stackKind('python-fastapi')).toBe('python');
    expect(stackKind('go-gin')).toBe('other');
    expect(prescribedCommands('node')['dependency-scan']![0]).toBe('npm audit --audit-level=high');
  });

  it('planRules states the exact commands only when required', () => {
    expect(planRules(false, false, false)).not.toContain('gitleaks');
    const text = planRules(false, false, true);
    for (const s of ['security-tools', 'gitleaks detect --no-git --source . --redact --exit-code 1', 'semgrep scan --config auto --severity ERROR --error', 'npm audit --audit-level=high', 'pip-audit', 'osv-scanner scan source -r .', 'trivy config', 'trivy fs', '--severity CRITICAL --exit-code 1', '.tools/bin']) {
      expect(text).toContain(s);
    }
  });
});
