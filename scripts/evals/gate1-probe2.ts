/**
 * Manual, live: runs the real Gate 1 functions (notReadyCriteria, duplicatePairs) through the real Decider and the
 * local llama.cpp backend, with the local-only chain and the default 0.9 threshold.
 *   npx tsx scripts/evals/gate1-probe2.ts [baseUrl]
 */
import { loadConfig, resolveDecision } from '../../server/config/config.js';
import { Decider } from '../../server/decide/decider.js';
import { duplicatePairs, notReadyCriteria } from '../../server/decide/decisions/gate1.js';
import { LocalLogprobsBackend } from '../../server/decide/local-logprobs.js';
import type { DecisionRecord } from '../../server/decide/types.js';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8080';
const only = { chain: ['local'] as const };
const cfg = loadConfig({ decisions: { enabled: true, local: { enabled: true, baseUrl }, perDecision: { 'gate1-readiness': only, 'question-dedup': only } } });
const records: DecisionRecord[] = [];
const decider = new Decider({
  backends: { local: new LocalLogprobsBackend({ fetch: globalThis.fetch, baseUrl, timeoutMs: 60_000, nProbs: 20 }) },
  config: (id) => resolveDecision(cfg, id),
  onDecision: (r) => records.push(r),
});
const ctx = { confidential: false };
const ac = (id: string, when: string, then: string) => ({ id, given: 'the service is running', when, then, smoke: false });

const criteria = [
  ac('AC-001', 'GET /hello is called without a name', 'it answers nicely'),
  ac('AC-002', 'GET /hello?name=Ada is called', 'the body is {"message":"Hello, Ada"} with status 200'),
  ac('AC-003', 'GET /health is called', 'the service responds properly'),
  ac('AC-004', 'GET /health is called', 'status 200 and {"ok":true}'),
  ac('AC-005', 'a todo is deleted', 'it is handled correctly'),
  ac('AC-006', 'DELETE /todos/1 is called', 'status 204 and the todo no longer appears in GET /todos'),
];
const vague = new Set(['AC-001', 'AC-003', 'AC-005']);
const notReady = (await notReadyCriteria(criteria, decider, ctx)) ?? [];
const hit = [...vague].filter((id) => notReady.includes(id)).length;
const falseAlarm = notReady.filter((id) => !vague.has(id)).length;
console.log(`readiness: flagged ${JSON.stringify(notReady)}; vague caught ${hit}/3, precise wrongly flagged ${falseAlarm}/3`);

const pairs = [
  { a: 'Quando GET /hello?name= é chamado com name vazio, o serviço deve responder 200 com Hello, stranger?', b: 'Quando GET /hello é chamado com o parâmetro name vazio ou só espaços, a resposta deve ser igual à de quem não informou nome?' },
  { a: 'Quando GET /hello?name= é chamado com name vazio, o serviço deve responder 200 com Hello, stranger?', b: 'Em qual porta o serviço deve escutar no container?' },
  { a: 'Em qual porta o serviço deve escutar no container?', b: 'A restrição Every endpoint answers JSON vale também para respostas de erro?' },
  { a: 'Which database does the service use?', b: 'What storage backend should the service persist todos in?' },
];
const expected = [true, false, false, true];
const dup = await duplicatePairs(pairs, decider, ctx);
console.log(`dedup: ${JSON.stringify(dup)} expected ${JSON.stringify(expected)}`);

const unanswered = records.filter((r) => r.answers === null).length;
console.log(`decide calls: ${records.length}, unanswered: ${unanswered}`);
for (const r of records) {
  const a = r.attempts.map((x) => `${x.outcome}${x.confidence === null ? '' : `@${x.confidence.toFixed(2)}`}`).join(',');
  const v = r.answers ? Object.values(r.answers).map((x) => Number(x.value).toFixed(2)).join(' ') : '-';
  console.log(`  ${r.decisionId} ${a} p=${v}`);
}
