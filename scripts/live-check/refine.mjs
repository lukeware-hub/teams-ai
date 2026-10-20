// Live check driver for backlog refinement (R11.2): drives a throwaway target project through the local teams-ai API.
// Every step costs Claude quota and a few Jev calls: run it only with the human's ok. Usage: node scripts/live-check/refine.mjs <step> <projectId> [args]
//   create <projectId> <docsDir> <name> [--no-backlog]   new project, the five docs, backlog mode unless --no-backlog
//   evaluate <projectId>                  one evaluation, waits for it, prints a summary
//   summary | events | files <projectId>  state, steps and cost per cycle, generated files in the draft
//   placement <projectId>                 each planted piece in its right document, exactly once; exits 1 on a FAIL
//   answer <projectId> <questionId> <text> | skip <projectId> <questionId>
//   accept <projectId> <patchId> | reject <projectId> <patchId> <reason> | patch <projectId> <patchId>
//   question <projectId> <questionId> | getdoc <projectId> <file> | put <projectId> <file> <path>
//   start <projectId>                    must answer 409 until the backlog is ready (the evaluation details every item)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASE = process.env.TEAMS_AI_URL ?? 'http://localhost:8787/api';
const CONTAINER = process.env.TEAMS_AI_CONTAINER ?? 'teams-ai-teams-ai-1';

const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};
const S = (p) => `/refine/${p}/${p}-001`;
const clip = (t, n = 160) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const draftRoot = (p) => `/home/node/.teams-ai/workspaces/${p}/refine/${p}-001`;
const sh = (cmd) => execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', cmd], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

async function summary(p) {
  const { status, json } = await api('GET', S(p));
  if (status !== 200) return console.log(`snapshot ${status}`);
  const st = json.state;
  const b = st.backlog;
  console.log(JSON.stringify({
    status: st.status, stale: st.stale, cycle: st.cycle, error: st.error && clip(st.error, 400),
    failing: st.checklist.filter((i) => !i.passed).map((i) => `${i.id}: ${clip(i.detail, 120)}`),
    questions: st.questions.filter((q) => q.status === 'pending').map((q) => `${q.questionId}${q.blocking ? ' [B]' : ''} ${q.relatedAcIds.join(',')} ${clip(q.text, 220)}`),
    patches: st.patches.filter((x) => x.status === 'pending').map((x) => `${x.patchId} ${x.file}: ${clip(x.reason, 160)}`),
    backlog: b ? {
      detail: !!b.detail, flowHeadings: b.flowHeadings, acHighWater: b.acHighWater,
      items: b.items.map((i) => `${i.rank}.${i.key}(${i.priority},${i.epic})<-${i.sources.map((s) => `${s.doc}›${s.heading}`).join(';')}`),
      specs: Object.fromEntries(Object.entries(b.specs ?? {}).map(([k, r]) => [k, r.spec ? `${r.spec.specId} ${r.spec.acceptanceCriteria.map((c) => c.id).join(',')} c${r.cycle}` : `ERR ${clip(r.issues.join('; '), 200)}`])),
      preplans: Object.fromEntries(Object.entries(b.preplans ?? {}).map(([k, r]) => [k, r.preplan ? `${r.preplan.tasks.map((t) => `${t.id}[${t.criteriaRefs.join(',')}]`).join(' ')} c${r.cycle}` : `ERR ${clip(r.issues.join('; '), 200)}`])),
    } : null,
    tokens: json.tokens,
  }, null, 1));
}

async function waitDone(p) {
  const started = Date.now();
  for (;;) {
    await sleep(10_000);
    const { json } = await api('GET', S(p));
    if (json?.state?.status !== 'evaluating') break;
    if (Date.now() - started > 45 * 60_000) { console.log('timeout waiting for the evaluation'); break; }
  }
  console.log(`evaluation took ${Math.round((Date.now() - started) / 1000)}s`);
}

/** STEP_STARTED per cycle and kind, and cost per cycle, from the draft journal in the container. */
function events(p) {
  const lines = sh(`cat ${draftRoot(p)}/events.ndjson`).trim().split('\n').map((l) => JSON.parse(l));
  const steps = {};
  const cost = {};
  for (const e of lines) {
    const c = e.data.attempt;
    if (e.type === 'STEP_STARTED') { steps[c] ??= {}; const k = `${e.data.kind}/${e.data.role}`; steps[c][k] = (steps[c][k] ?? 0) + 1; }
    if (e.type === 'STEP_FINISHED') { cost[c] ??= 0; cost[c] += Number(e.data.costUsd ?? 0); }
  }
  const failed = lines.filter((e) => e.type === 'REFINE_CYCLE_FAILED').map((e) => `c${e.data.cycle}: ${clip(String(e.data.reason), 300)}`);
  console.log(JSON.stringify({ steps, usd: Object.fromEntries(Object.entries(cost).map(([c, v]) => [c, Number(v.toFixed(3))])), failed }, null, 1));
}

function files(p) {
  console.log(sh(`cd ${draftRoot(p)}/docs && ls -1 && echo --- && find specs -type f | sort && echo --- && for f in specs/*/spec.json; do [ -f "$f" ] || continue; printf '%s ' "$f"; node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(s.status, (s.acceptanceCriteria||[]).map(c=>c.id).join(","), s.derivedFrom ? "derivedFrom:"+s.derivedFrom.sources.map(x=>x.heading+"="+(x.hash?"ok":"null")).join("|") : "")' "$f"; done`));
}

const EXPECTED = new URL('./misplaced/expect.json', import.meta.url);
const count = (text, marker) => text.split(marker).length - 1;

/** Each planted piece: one copy, in an expected document; then the moves by role, undone moves, pending questions, models and cost. */
async function placement(p) {
  const { json } = await api('GET', S(p));
  const docs = json.docs;
  const names = Object.keys(docs);
  const { pieces } = JSON.parse(readFileSync(EXPECTED, 'utf8'));
  let failed = 0;
  for (const piece of pieces) {
    const total = names.reduce((n, f) => n + count(docs[f], piece.marker), 0);
    const home = names.find((f) => count(docs[f], piece.marker) > 0);
    const ok = total === 1 && (piece.expected === 'any' || piece.expected.includes(home));
    if (!ok) failed += 1;
    const where = total === 0 ? 'lost' : total > 1 ? `duplicated x${total}` : `in ${home}`;
    const want = piece.expected === 'any' ? 'any document' : piece.expected.join(' or ');
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${piece.name}: ${where}${ok ? '' : `, expected ${want}`}`);
  }
  const lines = sh(`cat ${draftRoot(p)}/events.ndjson`).trim().split('\n').map((l) => JSON.parse(l));
  const moves = {};
  for (const e of lines.filter((x) => x.type === 'DOC_MOVED')) moves[e.data.role] = (moves[e.data.role] ?? 0) + 1;
  const models = [...new Set(lines.filter((e) => e.type === 'STEP_STARTED' && e.data.kind === 'refine').map((e) => `${e.data.role}:${e.data.model}`))];
  const usd = lines.filter((e) => e.type === 'STEP_FINISHED').reduce((n, e) => n + Number(e.data.costUsd ?? 0), 0);
  console.log(JSON.stringify({
    status: json.state.status, cycle: json.state.cycle, moves,
    undone: lines.filter((e) => e.type === 'DOC_MOVE_UNDONE').length,
    questionsPending: json.state.questions.filter((q) => q.status === 'pending').length,
    models, usd: Number(usd.toFixed(3)),
  }, null, 1));
  console.log(`${pieces.length - failed}/${pieces.length} pieces in place`);
  if (failed > 0) process.exitCode = 1;
}

const [cmd, p, ...rest] = process.argv.slice(2);
const steps = {
  async create() {
    const [docsDir, name, flag] = rest;
    console.log('new', (await api('POST', '/projects/new', { projectId: p, name, description: '' })).status);
    for (const f of ['project.md', 'brief.md', 'stack.md', 'flow.md', 'design.md']) console.log('put', f, (await api('PUT', `${S(p)}/docs/${f}`, { text: readFileSync(`${docsDir}/${f}`, 'utf8') })).status);
    if (flag !== '--no-backlog') console.log('backlog', (await api('POST', `${S(p)}/backlog`)).status);
  },
  async evaluate() {
    const r = await api('POST', `${S(p)}/evaluate`);
    console.log('evaluate', r.status, r.status === 202 ? '' : clip(r.text, 300));
    if (r.status === 202) await waitDone(p);
    await summary(p);
  },
  summary: () => summary(p),
  async answer() { const [id, text] = rest; console.log('answer', (await api('POST', `${S(p)}/answers`, { questionId: id, text })).status); },
  async skip() { console.log('skip', (await api('POST', `${S(p)}/questions/${rest[0]}/skip`)).status); },
  async accept() { const r = await api('POST', `${S(p)}/patches/${rest[0]}/accept`); console.log('accept', r.status, r.status === 200 ? '' : clip(r.text, 200)); },
  async reject() { console.log('reject', (await api('POST', `${S(p)}/patches/${rest[0]}/reject`, { reason: rest[1] })).status); },
  async patch() { const st = (await api('GET', S(p))).json.state; const x = st.patches.find((y) => y.patchId === rest[0]); console.log(x ? `${x.file}\n${x.reason}\n${x.diff}` : 'no patch'); },
  async question() { const st = (await api('GET', S(p))).json.state; const q = st.questions.find((y) => y.questionId === rest[0]); console.log(q ? JSON.stringify(q, null, 1) : 'no question'); },
  async getdoc() { const s = await api('GET', S(p)); process.stdout.write(s.json.docs[rest[0]]); },
  async put() { const [file, path] = rest; console.log('put', file, (await api('PUT', `${S(p)}/docs/${file}`, { text: readFileSync(path, 'utf8') })).status); },
  async start() { const r = await api('POST', `${S(p)}/start`); console.log('start', r.status, clip(r.text, 200)); },
  events: () => events(p),
  files: () => files(p),
  placement: () => placement(p),
};
if (!steps[cmd]) throw new Error(`unknown step ${cmd}`);
await steps[cmd]();
