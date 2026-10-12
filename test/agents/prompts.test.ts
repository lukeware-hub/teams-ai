import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { E2E_CONTRACT, SMOKE_CONTRACT, e2eSuiteRules } from '../../server/orchestrator/steps.js';

const agent = (name: string) => readFileSync(new URL(`../../.claude/agents/${name}.md`, import.meta.url), 'utf8');

describe('agent prompts for a project of services (R12.6)', () => {
  it('let the docs decide between one application and several services', () => {
    const sm = agent('sm');
    expect(sm).toContain('The docs decide');
    expect(sm).toContain('services-plan');
    expect(sm).not.toContain('teams-ai has no multi-repo or multi-service delivery mechanism today');
    expect(sm).not.toContain('one edge service');
  });

  it("tell Front that a service's repository gets the design doc in the pack, never as a file to edit", () => {
    expect(agent('front')).toContain("In a service's repository the pack carries the project's design.md: follow it there and never create or edit docs/design.md in that repository");
  });

  it('let a vulnerability with no fixed version pass the dependency scan only with a reason and a short expiry, which Sec holds the line on', () => {
    // Live: GO-2026-5932 in golang.org/x/crypto, which nats.go pulls in, has no fixed version, so no upgrade could pass the gate.
    expect(agent('dev')).toContain('[[IgnoredVulns]] entry in osv-scanner.toml at the repository root');
    expect(agent('dev')).toContain('never ignore a vulnerability that has a fixed version');
    expect(agent('sec')).toContain('any other ignore entry is a high finding');
  });

  it('tell devops, Test and the PO what a service, its suites and the platform are', () => {
    const devops = agent('devops');
    expect(devops).toContain('named exactly like the service');
    expect(devops).toContain('never declares the platform containers');
    expect(devops).toContain('container_name');
    expect(agent('test')).toContain('SERVICE_URL_<SERVICE>');
    expect(agent('po')).toContain('`project.services`');
    expect(agent('po')).toContain('`project.platform`');
    for (const text of [SMOKE_CONTRACT, E2E_CONTRACT, e2eSuiteRules('e2e/')]) expect(text).toContain('SERVICE_URL_<SERVICE>');
  });
});
