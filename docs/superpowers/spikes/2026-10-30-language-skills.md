# Spike: language skills for the role agents (2026-10-30)

**Question:** Should teams-ai install the language skills of the agents-migration repository (15 language folders) for its role agents, and would they cut failures or cost in real runs?

**Decision:** Do not adopt now. Keep the five language skills already in `skills/` as they are. Reopen with the criteria in the last section.

## Method

- Code: the skill pipeline (`server/skills/plugins.ts`, `server/runner/step.ts`, `server/runner/invocation.ts`, `server/runner/role-settings.ts`), the role tool policy (`server/agents/registry.ts`), the catalog and the tests that pin them.
- Real data: 17 runs of one target project (Kayron Hub, spec `platform-local-foundation`), read with read-only commands from the production container's data volume. Counts were cut at different moments between 16:37 and 17:13 UTC on 2026-10-30; run 17 kept writing and run 18 had started.
- Transcripts: 57 retained Claude Code session transcripts, for skill loads and per-call token counts.
- Literature: SkillsBench (arXiv 2602.12670), SWE-Skills-Bench (arXiv 2603.15401), the ETH Zurich study of context files (arXiv 2602.11988), and vendor and practitioner reports from 2026.
- No skill was installed and no code changed.

## Findings

### 1. A skill is loaded only when the prompt names it

- Every step runs with `CLAUDE_CODE_DISABLE_ATTACHMENTS=1` (`server/runner/invocation.ts:52`). In the 57 transcripts no skill listing attachment appears, while other attachments do (environment, model, date, sandbox instructions). Reading the Claude Code binary (version 2.1.295), the listing is an attachment that this flag skips. That reading is inferred from the binary, not tested live.
- Twenty of 538 finished steps (snapshot at 16:37 UTC) made 24 Skill calls. None called a language skill. The five language skills, installed since 2026-10-21, were loaded zero times in about 570 steps.
- Generic lines such as "use the installed skills" produced no calls in dev implement steps (0 of 85), test review steps (0 of 68) or security steps (0 of 68). The calls that happened came from steps whose prompt or role file named the skill: find-skills in 7 of 7 skill-select steps, and design skills in 11 of 76 front implement steps.
- Eight of 14 Skill calls visible in transcripts failed. `critique` (5) and `frontend-design` (1) are not installed in the front plugin. `impeccable` (2) is held by two plugins, `teams-ai-front` and `teams-ai-front-dynamic`, and its calls failed.

### 2. Gate and review failures are mostly not language errors

- Gates, up to 17:13 UTC: 947 passes and 39 failures. Failures: install 17, coverage 13, unit test 7, dependency scan 2. Format (gofmt), lint (go vet) and build never failed, in 76 to 100 runs each. There is no TypeScript gate.
- Blocks: 304 TASK_BLOCKED events from 11 root causes. The largest were a stale git worktree (126 events, 9 roots; fixed in commit `7b2efee5` on 2026-10-30), a Go toolchain older than `go.mod` requires (85 events, 6 roots), a coverage command that wrote an empty value (30 events, 2 roots) and review findings that used up the attempts (18 events, 8 roots).
- Review and security findings (209 in total), strict reading: language or framework pitfalls 11 (5.3%); with borderline items, up to 26 (12.4%). Acceptance-criteria proof and plan deviation: 136 (65%). Language-independent security: 36 (17%).
- A looser second reading counts fragile assertions in acceptance tests as language-level. It gives 44 of 165 blocking review findings (27%), and 35 of those 44 sit in front-end files (TSX, CSS, Playwright tests). Both readings put most findings in acceptance-criteria and plan conventions.
- Extra steps (395 steps beyond the first dev, review and security steps of each task): 19 (4.8%) trace to a language-level cause in the strict reading, 59 (14.9%) in the looser one.
- Counterfactual: removing every strict language finding would have avoided at most one of the 57 review-change loops.

### 3. Cost of a skill per step

- Corrected spend of the 17 runs is about US$ 17.20. The events record US$ 41.37 (see section 6).
- Implement steps (roles dev, front and devops; 245 steps): mean US$ 0.063, median US$ 0.030, 90th percentile US$ 0.166, maximum US$ 0.498. Mean 795,000 tokens per step, 93% of them cache reads.
- The CLI charges each call whose prompt is over 100,000 tokens at five times the base rate. This rule reproduces 205 of 205 clean segments. 51% of calls are above that line and carry 88% of the notional dollars. Removing the multiplier would cut implement spend by about 70%. The login is a subscription, so dollars are notional.
- One 5,000-token skill body adds to an implement step: 6.0% if cached as a static prefix, 9.2% if pasted into the prompt, 16.8% if loaded through a Skill call (one more API call). Per task: 6.5% when loaded once per task session, 23.1% when loaded at every dev step and carried in the resumed session. Over the 17 runs: US$ 0.78 to US$ 2.78, which is 4.5% to 16.2% of corrected spend.
- A retried attempt costs US$ 0.100 on average. To pay back a 5,000-token skill, it must prevent 8% (loaded once per task) to 30% (accumulating) of retried attempts. Language-level causes account for 5% to 15% of extra steps.

### 4. The existing skills and the migration repository

- teams-ai already ships five language skills: go, java, python, rust and typescript-node. Each is 2.2 to 2.4 kilobytes, has a `solutions` folder, and is copied into all eight role plugins (commit `efbf3c77`, 2026-10-21).
- The agents-migration repository holds 15 language folders. Their `SKILL.md` files are 9.1 to 20.6 kilobytes, and their reference files add 13 to 34 kilobytes per skill. Between 22% and 36% of those bytes are about migration only; about 51% counting lines that use migration words.
- They point to `.claude/skills/migration-conduct/...`, a file this project does not have and that the sandbox blocks. They use ids such as `BR-` (this project uses `[AC-nnn]`), tell the agent to run gates that the orchestrator already runs, say "commit the lockfile", and fix versions and tools (Corretto with a Java 11 floor, a .NET 10 default, a Node 26 default, Next.js App Router). One probe uses `node -p`, which the sandbox denies (`server/agents/registry.ts:49`).
- Thirteen of the fifteen have a stack in teams-ai. Swift targets iOS, which is out of scope. Kotlin has no stack.
- The agents-migration repository has 15 commits, all from 2026-10-29 and 2026-10-30, no LICENSE file, and no recorded finished migration.

### 5. Published evidence

- SkillsBench (arXiv 2602.12670, version 4, June 2026): curated skills raise the mean pass rate from 33.9% to 50.5% across 18 model and harness setups. Software engineering tasks gain less (+11.6 points). Skills written by the agent itself fall below the no-skill baseline (−8.1 to −11.5 points). Four or more skills per task gain +10.1 points, against +18 to +19 for one to three. Long, comprehensive skill bodies gain +0.7 points.
- SWE-Skills-Bench (arXiv 2603.15401, version 2, 2026-10-27): 98 public skills and 3,920 paired runs. Mean gain +0.34 points; 92 of 98 skills show no significant effect. The helpful skills supply procedures that the agent would otherwise skip. Two skills hurt, by anchoring the agent on their own templates.
- ETH Zurich (arXiv 2602.11988): always-loaded repository context files do not improve success and add about 20% to cost.
- Vendor and practitioner reports: a skill was used in 41% to 68% of runs when the prompt did not force it (Tessl; SkillsBench with Claude Code, 68.2%; Vercel, 44%).
- The large gains come from knowledge the model lacks, such as new APIs and vendor tools. For mainstream language practice the measured gain is small or none.

### 6. Other facts from the same data, recorded for follow-up

- Cost booking: 147 implement steps store the session's running total instead of their own cost in `costUsd`, checked against the CLI's cost-state entries in 132 of 132 cases. The code at `server/runner/step.ts:308-312` treats a reset as the step's own total. Recorded spend is about 2.4 times the corrected spend. The usage part of this booking was fixed in commit `731d6375`; the reset branch was not.
- Model tier: 133 of 153 `MODEL_TIER_CHOSEN` events choose claude-sonnet-5-5 with `applied=true`. `server/orchestrator/task-runner.ts:186` sets that flag from the `tiers` setting and the absence of a manual agent setting. All 589 steps recorded claude-haiku-5-5. Where the choice is lost has not been traced.
- Error rules: `ERROR_RULES` (`server/agents/registry.ts:108` and `:111`) tell every role to consult and record fixes under `skills/<language>/solutions/`. The worktree that the agent works in has no such folder: a run-16 step listed it and got "No such file or directory". The two entries in that folder are marked "not validated" and cite a Kayron Hub run.
- Planning rules: a browser suite is allowed only for a plan whose service has deploy kind `front` (`server/orchestrator/steps.ts:258`). In the reviewed plan the Next.js front end sat inside the `api` service `web-bff-api`, and 10 acceptance criteria were exempted as browser-only.
- Fixed after the data was read: commit `731d6375` (2026-10-30) names front skills in full in `.claude/agents/front.md`, gives each step read rules for its role plugin folders, sends a repeated skill request to the owner or spec-gap path, and fixes the usage booking of resumed steps. Code cited in this spike was checked at that commit.

## Limits

- One target project, one spec, Go and Next.js with TypeScript only. All steps ran claude-haiku-5-5. Review classification was done by one reader. Run 17 was still running at the last cut.
- Nothing was measured for Python, Rust, Java, .NET or Flutter.
- Cost figures are notional, because the login is a subscription.

## Decision

Do not adopt the agents-migration language skills now. Keep the five skills in `skills/` as they are.

Reopen when either of these holds:

1. A stack beyond Go and Node shows repeated language-level findings in review.
2. A tool is newer than the model and the agents use it wrongly. The Tailwind v4 `@theme inline` case in run 16 is one example.

When reopened, use this method:

- Write one narrow skill, up to 2 kilobytes, from observed failures, not from a migration catalog.
- Name it in full, with its plugin prefix, in the prompt of the step that needs it.
- Measure loads in at least 90% of that stack's steps. Keep the skill only if tokens per task rise by at most 10% and the failures of that class go down.

## Follow-up

The defects found while answering this question are in `docs/superpowers/BACKLOG.md`, under "From the language skills spike (2026-10-30)".
