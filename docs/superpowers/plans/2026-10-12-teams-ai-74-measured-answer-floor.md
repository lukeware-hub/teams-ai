# Plan 74 - The auto answer floor measures itself (R11.5.7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** answering refinement questions from the docs switches itself on once the project's labelled answers measure a trustworthy floor, with no number for a person to copy into the config.

**Architecture:** `decisions.autoAnswerFloor` becomes `'measured'` (the default), `'off'`, or a fixed number. With `'measured'`, `answerFloor` (`server/refine/auto-floor.ts`) reads the project's refinement journals at each evaluation, joins routes and labels with `routingSamples`, and returns the floor only when `autoAnswerFloor` finds one over at least 20 questions routed `auto` and `precisionNearFloor` holds at 0.95 too; otherwise the auto answer stays off. The refinement registry passes it to each session as the getter plan 73 introduced.

**Tech Stack:** TypeScript on Node 22 (ES modules), zod 4, vitest.

**Spec:** plan 66 (`docs/superpowers/plans/2026-10-12-teams-ai-66-autonomy-hardening.md`), section "Design", paragraph **R11.5.7 Jev answers from the docs** ("an eval over that data sets the confidence floor; then a question routed `auto` with enough confidence is answered"); plan 72 and its review lines in `docs/superpowers/ROADMAP.md`.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- The measured floor needs at least 20 questions routed `auto` and labelled, a precision of 0.95 over them and 0.95 over the 10 just above the floor; anything less keeps the auto answer off.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A project with no labelled answers yet: the floor is undefined and nothing is answered on its own.
2. A project whose labelled answers pass the overall precision but not near the floor: still off.
3. `'off'` and a fixed number in the config: they win over the measurement.
4. A refinement directory with a broken or missing journal: it counts for nothing, and the evaluation goes on.
5. Several drafts of one project: their labels add up, since they share the project's documents style and the same Jev.

## Limits

- The floor is measured per project, from that project's refinement journals only.

---

### Task 1: The floor measures itself

**Files:**
- Modify: `server/config/config.ts:189` (`decisions.autoAnswerFloor`)
- Create: `server/refine/auto-floor.ts`
- Modify: `server/refine/registry.ts:80` (the session getter)
- Test: `test/refine/auto-floor.test.ts`, `test/config/decisions.test.ts`

**Interfaces:**
- Consumes: `routingSamples`, `autoAnswerFloor`, `precisionNearFloor` from `server/decide/evals.ts`; `loadEvents` from `server/store/event-store.ts`.
- Produces: `answerFloor(setting: number | 'measured' | 'off', refineDir: string): Promise<number | undefined>`.

- [ ] **Step 1: Write the failing tests**

In `test/config/decisions.test.ts`, add to "per-decision defaults follow the spec escalation column":

```ts
    // The floor measures itself from the labelled answers unless the config fixes a number or turns it off.
    expect(DEFAULT_CONFIG.decisions.autoAnswerFloor).toBe('measured');
    expect(loadConfig({ decisions: { autoAnswerFloor: 0.9 } }).decisions.autoAnswerFloor).toBe(0.9);
    expect(loadConfig({ decisions: { autoAnswerFloor: 'off' } }).decisions.autoAnswerFloor).toBe('off');
    expect(() => loadConfig({ decisions: { autoAnswerFloor: 1.5 } })).toThrow(ConfigError);
```

Create `test/refine/auto-floor.test.ts`:

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { answerFloor } from '../../server/refine/auto-floor.js';

let dir: string;
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A refinement journal whose questions Jev routed `auto` at these confidences, each answered with the owner's mark when `docs` says so. */
async function draft(specId: string, routes: Array<{ confidence: number; docs: boolean }>): Promise<void> {
  const ids = routes.map((_, i) => `po-c1-${i}`);
  const lines = [
    { seq: 1, at: '', runId: 'x', specHash: 'draft', type: 'REFINE_EVALUATED', kind: 'fact', data: { cycle: 1, questionRouting: Object.fromEntries(routes.map((r, i) => [ids[i], { route: 'auto', confidence: r.confidence, source: 'jev' }])) } },
    ...routes.map((r, i) => ({ seq: i + 2, at: '', runId: 'x', specHash: 'draft', type: 'QUESTION_ANSWERED', kind: 'fact', data: { questionId: ids[i], text: 'a', ...(r.docs ? { docsAnswered: true } : {}) } })),
  ];
  await mkdir(path.join(dir, specId), { recursive: true });
  await writeFile(path.join(dir, specId, 'events.ndjson'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

describe('answerFloor', () => {
  it('measures the floor from the labelled answers of every draft of the project', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-floor-'));
    await draft('a', Array.from({ length: 12 }, (_, i) => ({ confidence: 0.99 - i * 0.005, docs: true })));
    await draft('b', Array.from({ length: 8 }, (_, i) => ({ confidence: 0.92 - i * 0.005, docs: true })));
    await mkdir(path.join(dir, 'empty'));
    expect(await answerFloor('measured', dir)).toBeCloseTo(0.885);
  });

  it('stays off without enough labels, or when the band right above the floor fails', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-floor-'));
    await draft('a', Array.from({ length: 19 }, (_, i) => ({ confidence: 0.99 - i * 0.005, docs: true })));
    expect(await answerFloor('measured', dir)).toBeUndefined();
    // 100 right at 0.99 and five wrong just below: 95% overall, 50% near the floor.
    await draft('b', [...Array.from({ length: 81 }, () => ({ confidence: 0.99, docs: true })), ...[0.9, 0.89, 0.88, 0.87, 0.86].map((confidence) => ({ confidence, docs: false }))]);
    expect(await answerFloor('measured', dir)).toBeUndefined();
  });

  it('takes a fixed number or off from the config over the measurement, and survives a missing directory', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-floor-'));
    expect(await answerFloor(0.93, dir)).toBe(0.93);
    expect(await answerFloor('off', dir)).toBeUndefined();
    expect(await answerFloor('measured', path.join(dir, 'missing'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/refine/auto-floor.test.ts test/config/decisions.test.ts`
Expected: the floor cases FAIL (the module does not exist) and the config case FAILS (the default is undefined).

- [ ] **Step 3: Implement**

In `server/config/config.ts`, replace the `autoAnswerFloor` lines with:

```ts
      /** R11.5.7: the confidence at or above which a blocking refinement question Jev routes `auto` is answered from the docs; `measured` (the default) takes it from the project's labelled answers, `off` never answers. */
      autoAnswerFloor: z.union([unit, z.enum(['measured', 'off'])]).default('measured'),
```

Create `server/refine/auto-floor.ts`:

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { autoAnswerFloor, precisionNearFloor, routingSamples, type RoutingSample } from '../decide/evals.js';
import { loadEvents } from '../store/event-store.js';

/** The precision the floor must keep overall and right above it before any question is answered on its own. */
const PRECISION = 0.95;

/** The floor a session answers at: a fixed number, nothing when off, or what the project's labelled answers measure. */
export async function answerFloor(setting: number | 'measured' | 'off', refineDir: string): Promise<number | undefined> {
  if (setting === 'off') return undefined;
  if (typeof setting === 'number') return setting;
  const samples: RoutingSample[] = [];
  for (const specId of await fs.readdir(refineDir).catch(() => [] as string[])) {
    samples.push(...routingSamples(await loadEvents(path.join(refineDir, specId, 'events.ndjson')).catch(() => [])));
  }
  const floor = autoAnswerFloor(samples, { precision: PRECISION });
  return floor !== null && (precisionNearFloor(samples, floor) ?? 0) >= PRECISION ? floor : undefined;
}
```

In `server/refine/registry.ts`, import `answerFloor` from `./auto-floor.js` and give the session `autoAnswerFloor: async () => answerFloor((await this.deps.cfg()).decisions.autoAnswerFloor, path.posix.join(ws.root, 'refine'))` (import `path` from `node:path` if the file does not).

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/refine test/config test/decide && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/config/config.ts server/refine/auto-floor.ts server/refine/registry.ts test/refine/auto-floor.test.ts test/config/decisions.test.ts
git commit -m "feat(refine): the auto answer floor measures itself from the labelled answers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Record the measured floor

**Files:**
- Modify: `scripts/evals/question-routing.ts` (header comment), `docs/superpowers/ROADMAP.md` (the R11.5 heading and a line after the plan 73 review line), `docs/superpowers/plans/README.md` (after row 73)

- [ ] **Step 1: Update the script, the roadmap and the index**

In `scripts/evals/question-routing.ts`, replace the header's last sentence with "The refinement sessions measure the same floor themselves (`decisions.autoAnswerFloor: measured`, the default); this script shows the numbers behind it.". In `docs/superpowers/ROADMAP.md`, change the R11.5 heading's parenthesis to `(plans 66 to 74, 2026-10-12; the auto answer of R11.5.7 switches itself on once the labelled answers measure a floor)` and add after the plan 73 review line:

```md
- Built (plan 74): the auto answer floor measures itself; `decisions.autoAnswerFloor` is `measured` by default, `off`, or a fixed number, and with `measured` each refinement evaluation reads the project's labelled answers and answers from the docs only once at least 20 questions routed `auto` show a precision of 0.95 overall and over the 10 just above the floor (`answerFloor` in `server/refine/auto-floor.ts`).
```

and after row 73 of `docs/superpowers/plans/README.md`:

```md
| 74 | [`2026-10-12-teams-ai-74-measured-answer-floor.md`](2026-10-12-teams-ai-74-measured-answer-floor.md) | Done — the auto answer floor measures itself from the labelled answers; ROADMAP R11.5.7. |
```

- [ ] **Step 2: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit -p . && (cd web && npx vitest run && npx tsc --noEmit -p .)`
Expected: every suite passes, both type checks clean.

- [ ] **Step 3: Commit**

```bash
git add scripts/evals/question-routing.ts docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): the auto answer floor measures itself

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
