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
