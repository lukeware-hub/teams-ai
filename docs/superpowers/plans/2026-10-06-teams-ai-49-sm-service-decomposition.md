# Plan 49 - SM decides service/bounded-context decomposition during refine, instead of asking the human

Status: done (2026-10-06). Roadmap item R10.3.

## Goal

A live refinement session on a different project (lukeware-kayron-hub, `surgical-case-service` spec) showed the SM
asking the human an open-ended architecture question: which `<capability>-service` repositories the spec creates,
and whether a single edge service with bounded contexts separated internally (hexagonal, physical split deferred to
an ADR) is acceptable, or whether multi-service separation is mandatory.

That question is decidable from teams-ai's own delivery contract, not from the project docs: `plan.delivery`
(`sm.md`'s `plan` step, enforced by `server/validators/plan.ts` / `requireDelivery`) ships exactly one `dockerfile`,
one `compose`, one `e2eSuite` and one implicit `SERVICE_URL` per spec, and `devops.md` is explicit that the compose
file holds **one** service named like the project id. Teams-ai has no multi-repo or multi-service delivery path
today. So "start with one edge service, contexts separated internally, split recorded as an ADR for later" is not
a choice the SM needs to put to the human - it is the only thing the pipeline can ship, and the SM should say so
and move on.

## Approach

Distill this as a durable rule directly into `.claude/agents/sm.md`'s `refine` step, the same pattern used in plan
46 (R10.1): no live skill-loading mechanism exists (decided against in plan 46), so agent behavior is shaped by
the prompt body the orchestrator sends, not by a loaded skill file.

## Changes

- `.claude/agents/sm.md`: new "### Service and bounded-context decomposition" subsection under "Refining the
  documentation (`refine` step)". States the one-repo/one-service delivery fact, the default decision (one edge
  service, hexagonal internal separation, ADR-recorded deferral via `docPatch`), and narrows when a question to the
  human is still legitimate (the docs mandate something teams-ai cannot deliver: separate repos per bounded
  context, a specific org/repo layout, several independently deployable services) - phrased as a pipeline
  limitation, not an open architecture choice.
- `docs/superpowers/ROADMAP.md`: new item R10.3 under Stage 10.

## Out of scope

- Multi-repo/multi-service delivery itself is not built; this plan only stops the SM from asking about a
  capability the pipeline does not have.
- `po.md` is untouched: architecture/delivery decomposition is the SM's domain (it owns `plan.delivery`), not the
  PO's (product clarity/acceptance criteria).

## Verification

Prompt-only change, no runtime code path touched. Verified by re-reading the diff and confirming the new section
reads correctly in context; no unit test exists or is needed (no test in the repo asserts on agent `.md` body
content - confirmed by search before writing this plan). Cost: $0 (no agent run).
