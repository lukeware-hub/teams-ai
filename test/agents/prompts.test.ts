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

  it('tell the Dev that a command Bash refuses is no blocker: the same check runs with the stack command', () => {
    expect(agent('dev')).toContain('A command Bash refuses never makes a task blocked');
  });

  it('tell the Dev how to resolve the conflict markers of a task the orchestrator moved onto main', () => {
    // Any list of marked files triggers it, a resume's included, and it names which side is main's.
    expect(agent('dev')).toContain('When the feedback lists files that hold conflict markers');
    expect(agent('dev')).toContain("main's side sits between `<<<<<<< ours` and `=======`");
  });

  it('tell each implementer which mounted skills to use and how to request a missing one', () => {
    expect(agent('front')).toContain('impeccable');
    expect(agent('front')).toContain('no live browser unless SERVICE_URL is set');
    expect(agent('dev')).toContain('superpowers');
    expect(agent('sec')).toContain('cybersecurity-skills');
    expect(agent('test')).toContain('playwright');
    expect(agent('devops')).toContain('hashicorp-agent-skills');
    expect(agent('sm')).toContain('find-skills');
    expect(agent('reviewer')).toContain('/code-review medium');
    for (const role of ['front', 'dev', 'devops']) expect(agent(role)).toContain('skillRequest');
  });

  it('tell devops and the reviewer that a digest no one can look up is no blocker: the docs tag pins the image', () => {
    // Live: kayron-hub design-tokens-shell run-1 and run-2 blocked the Dockerfile tasks on "faltam os digests reais".
    expect(agent('devops')).toContain('A step has no network and no docker, so it can never look up an image digest');
    expect(agent('test')).toContain('Never ask for an image digest');
  });

  it('the environment agent names recipes, never sees a value, and picks the strategy by what the variable is', () => {
    const env = agent('env');
    expect(env).toContain('You never see, ask for or write a secret value');
    for (const strategy of ['`random`', '`fake`', '`from-service`', '`mint`']) expect(env).toContain(strategy);
    expect(env).toContain('A variable the pack already says exists is never in your answer');
  });

  it('tell Front and the Dev to take fonts from npm and never to reach the git remote (live: github.com denied in kayron-hub)', () => {
    for (const role of ['front', 'dev']) {
      expect(agent(role)).toContain("The sandbox reaches only the package registries (npm and the stack's own), never github.com, raw.githubusercontent.com");
      expect(agent(role)).toContain('Never run `git fetch`, `git pull`, `git push` or `git rebase`');
    }
  });

  it('tell the PO that a key never extends another key with a branch suffix', () => {
    expect(agent('po')).toContain('A key never equals another key followed by `-plan`, `-report`, `-done`, `-readme`, `-workflows` or a version such as `-v2`');
  });

  it('tell devops, Test and the PO what a service, its suites and the platform are', () => {
    const devops = agent('devops');
    expect(devops).toContain('named exactly like the service');
    expect(devops).toContain('never declares the platform containers');
    expect(devops).toContain('container_name');
    expect(agent('test')).toContain('SERVICE_URL_<SERVICE>');
    expect(agent('po')).toContain('`project.services`');
    expect(agent('po')).toContain('`project.platform`');
    // A credential a suite needs is declared up front, and an internal one is generated, so the run never fails at the end for a value nobody provided.
    expect(agent('po')).toContain('set `generated: true` for an internal credential of the project');
    expect(agent('po')).toContain('A datastore password of the service\'s own compose file needs no entry');
    for (const text of [SMOKE_CONTRACT, E2E_CONTRACT, e2eSuiteRules('e2e/')]) expect(text).toContain('SERVICE_URL_<SERVICE>');
  });
});
