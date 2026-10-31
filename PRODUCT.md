# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A developer who owns the product to be built and runs Teams AI on their own machine (Windows, WSL2, Docker Desktop) or through the private Cloudflare Access address. They describe what to build, refine five documents with the agents, authorize development and validate the delivered service. Teammates follow the work on the same screens.

## Product Purpose

Turns five documents (flow, project, briefing, stack, design) into tested, published services with a team of AI agents run by the Claude Code CLI. The owner decides scope and starts development; agents refine, specify, plan, write tasks, build, test, review and deploy; a deterministic orchestrator validates, merges and deploys. Success: a refinement that ends in a validated plan per repository and a delivery that reaches awaiting-validation with the service running locally and its tests passing.

## Positioning

Agents propose and build; the owner keeps scope and the start. Every number on screen comes from real data, and what has no source says so.

## Operating Context

- Flow: onboarding, projects, refinement, execution, validation. Screens: project page, repository dashboard, refinement wizard, run, validation, settings, chat.
- Projects go from one application to dozens of repositories (the reference project has 23).
- Long programs: hours, many runs, screens read again and again, polled every few seconds.
- Wide screen at localhost:8787 next to a terminal and GitHub; the phone is a secondary check.

## Capabilities and Constraints

- Roles: PO, SM, Dev, Test, Security, DevOps, Front; the Jev reviews documents and only advises.
- Everything local; cost is an alert, never a stop; Iniciar stays a manual click; a confidential project never sends a document to the Jev or the web.
- Repository kinds: API, Workers, Web, Mobile, Workflow, or one Monolith repository.

## Brand Commitments

- Name: Teams AI, by Lukeware.
- Voice: Brazilian Portuguese, sentence case, short; controls name their action; errors name the problem and the recovery.
- The visual system is design.md; its refinement workspace (§26, §30) is the look to extend.

## Evidence on Hand

The reference project kayron-hub (40 specs, 23 repositories), two small reference apps, README, docs/superpowers, docs/guia. No testimonials, benchmarks, prices or licence terms: never invent.

## Product Principles

1. The owner decides scope and the start; the rest is the agents' work and stays traceable.
2. Honest state: running, waiting, blocked, failed, with real numbers only.
3. Security by construction: agents never touch credentials or infrastructure.
4. A tested, running service beats fast code.
5. Familiarity: no invented affordance for a common task.

## Accessibility & Inclusion

Visible keyboard focus, contrast per design.md §3.7, state never by colour alone, usable from 360 px, dark and light themes.
