/**
 * Manual, live: one choice, one noul and one score question against the local llama.cpp server (spec 10A.2a).
 *   npx tsx scripts/smoke/local-logprobs.ts [baseUrl]   (default http://127.0.0.1:8080)
 * Exits 1 unless every answer comes back with probabilities that sum to about 1.
 */
import { LocalLogprobsBackend } from '../../server/decide/local-logprobs.js';
import { GATE_TRIAGE_OPTIONS } from '../../server/decide/decisions/gate-triage.js';

const backend = new LocalLogprobsBackend({ fetch: globalThis.fetch, baseUrl: process.argv[2] ?? 'http://127.0.0.1:8080', timeoutMs: 60_000, nProbs: 20 });
const started = Date.now();
const result = await backend.evaluate({
  state: 'gate: unit-test\ncommand: npm test\nexit code: 1\njunit: 3 passed, 1 failed\nstderr (tail):\nAssertionError: expected 201 to equal 200 at todos.test.ts:14',
  questions: {
    kind: { type: 'choice', instructions: 'Classify why the quality gate failed.', options: GATE_TRIAGE_OPTIONS },
    flaky: { type: 'noul', instructions: 'Would re-running the gate without code changes likely pass?' },
    severity: { type: 'score', instructions: 'How much work does the fix need?', levels: ['trivial', 'small', 'medium', 'large'] },
  },
  escalateTo: 'test',
});
console.log(JSON.stringify({ ms: Date.now() - started, ...result }, null, 2));
if (!result.ok) process.exit(1);
for (const [id, a] of Object.entries(result.answers)) {
  const sum = Object.values(a.probabilities).reduce((s, p) => s + p, 0);
  if (Math.abs(sum - 1) > 0.05) {
    console.error(`${id}: probabilities sum to ${sum}`);
    process.exit(1);
  }
}
