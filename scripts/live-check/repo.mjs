// Live check of the repository flow (plan 117, increment K): drives one throwaway new project through the stages, the
// architecture, the backlog, the plans and the owner's authorization, through the local teams-ai API. It stops at the first
// point that needs the owner (a pending blocking question) and prints it. Every step costs Claude quota: run it only with the
// human's ok, and delete the project afterwards.
//   node scripts/live-check/repo.mjs <projectId> <docsDir> "<name>"
const BASE = process.env.TEAMS_AI_URL ?? 'http://localhost:8787/api';
const [projectId, docsDir, name] = process.argv.slice(2);
if (!projectId || !docsDir || !name) throw new Error('usage: repo.mjs <projectId> <docsDir> "<name>"');

const S = `/refine/${projectId}/${projectId}-001`;
const STAGES = ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { readFileSync, existsSync } = await import('node:fs');

const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};
const snap = async () => (await api('GET', S)).json;

/** Waits until the page's snapshot is not busy, or the limit runs out. */
async function settle(label, limitMin = 45) {
  const started = Date.now();
  for (;;) {
    await sleep(10_000);
    const s = await snap();
    if (!s || (!s.busy && s.state?.status !== 'evaluating')) break;
    if (Date.now() - started > limitMin * 60_000) { console.log(`timeout: ${label}`); break; }
  }
  console.log(`${label}: ${Math.round((Date.now() - started) / 1000)}s`);
}

/** Stops the run when the owner must answer a blocking question; the answer is the owner's, not the script's. */
async function ownerQuestions(where) {
  const s = await snap();
  const blocking = (s?.state?.questions ?? []).filter((q) => q.status === 'pending' && q.blocking);
  if (blocking.length > 0) {
    console.log(`STOP at ${where}: ${blocking.length} blocking question(s) need the owner:`);
    for (const q of blocking) console.log(` - [${q.questionId}] ${q.text}`);
    process.exit(3);
  }
}

// FROM_STAGE=<doc> continues a project that exists: the stages from that document on run, the project is not created again.
const FROM_STAGE = process.env.FROM_STAGE;
const RESUME = process.env.RESUME === '1' || FROM_STAGE !== undefined;
if (!RESUME) console.log('new project', (await api('POST', '/projects/new', { projectId, name, description: '' })).status);
for (const f of RESUME ? [] : ['project.md', 'briefing.md', 'stack.md', 'flow.md', 'design.md']) {
  // The agenda folder names the briefing brief.md; any other folder uses the document name.
  const source = [`${docsDir}/${f}`, `${docsDir}/${f.replace('briefing.md', 'brief.md')}`].find((p) => existsSync(p));
  console.log('put', f, (await api('PUT', `${S}/docs/${f}`, { text: readFileSync(source, 'utf8') })).status);
}
if (!RESUME) console.log('confidential', (await api('POST', `${S}/confidential`, { confidential: false })).status);

const stagesToRun = process.env.RESUME === '1' ? [] : STAGES.slice(FROM_STAGE ? STAGES.indexOf(FROM_STAGE) : 0);
for (const file of stagesToRun) {
  console.log('evaluate stage', file, (await api('POST', `${S}/docs/${file}/evaluate`)).status);
  await settle(`review ${file}`);
  await ownerQuestions(`review ${file}`);
  // The stage cannot continue while the model's suggestions wait: accepted here, as converge.mjs does for a live check.
  const pending = ((await snap())?.state?.patches ?? []).filter((p) => p.status === 'pending' && p.file === file);
  for (const patch of pending) console.log('accept patch', patch.patchId, (await api('POST', `${S}/patches/${patch.patchId}/accept`)).status);
  console.log('continue stage', file, (await api('POST', `${S}/stage/continue`, { doc: file })).status);
  await settle(`graph ${file}`, 20);
  const s = await snap();
  if (!(s?.state?.graphed ?? []).includes(file)) {
    console.log(`STOP: ${file} is not in the graph`, s?.state?.graphError ?? '');
    process.exit(4);
  }
}

console.log('architecture', (await api('POST', `${S}/architecture`)).status);
await settle('architecture');
const arch = (await snap())?.state?.architecture;
console.log('architecture decided:', arch ? arch.decision.style : 'NO', arch ? arch.decision.repositories.map((r) => r.name).join(', ') : '');
await ownerQuestions('architecture');

console.log('backlog', (await api('POST', `${S}/backlog`)).status);
for (let round = 1; round <= 3; round++) {
  console.log('evaluate backlog round', round, (await api('POST', `${S}/evaluate`)).status);
  await settle(`backlog round ${round}`);
  await ownerQuestions(`backlog round ${round}`);
  if ((await snap())?.state?.backlog?.detail) break;
}

console.log('plans', (await api('POST', `${S}/plans`)).status);
await settle('plans and tasks');
const after = await snap();
console.log('speckit status:', after?.state?.speckit?.status ?? 'none');
await ownerQuestions('plans');

// Closing rounds: a document that left the graph is added again, a stale architecture is decided again,
// and the checklist is evaluated until every check is green (three rounds at most).
for (let round = 1; round <= 3; round++) {
  const now = await snap();
  if (now?.closing?.ok) break;
  const graphed = now?.state?.graphed ?? [];
  for (const file of (now?.state?.doneStages ?? []).filter((d) => !graphed.includes(d))) {
    // A document that left the graph is reviewed again, its suggestions taken, and then added to the graph.
    console.log('close round', round, 'review', file, (await api('POST', `${S}/docs/${file}/evaluate`)).status);
    await settle(`review ${file}`, 20);
    for (const patch of ((await snap())?.state?.patches ?? []).filter((p) => p.status === 'pending' && p.file === file)) console.log('accept patch', patch.patchId, (await api('POST', `${S}/patches/${patch.patchId}/accept`)).status);
    console.log('close round', round, 're-graph', file, (await api('POST', `${S}/stage/continue`, { doc: file })).status);
    await settle(`re-graph ${file}`, 20);
  }
  if (now?.architectureStale || !now?.state?.architecture) {
    console.log('close round', round, 'architecture', (await api('POST', `${S}/architecture`)).status);
    await settle('architecture again');
  }
  // An item added after the plans step has no plan or task list: the step prepares only the missing ones.
  if (now?.closing?.checks?.some((c) => (c.id === 'plans' || c.id === 'tasks') && !c.ok)) {
    console.log('close round', round, 'plans', (await api('POST', `${S}/plans`)).status);
    await settle('plans again');
    await ownerQuestions('plans again');
  }
  console.log('close round', round, 'evaluate', (await api('POST', `${S}/evaluate`)).status);
  await settle('close evaluation');
  await ownerQuestions('close evaluation');
  const pendingNow = ((await snap())?.state?.patches ?? []).filter((p) => p.status === 'pending');
  for (const patch of pendingNow) console.log('accept patch', patch.patchId, (await api('POST', `${S}/patches/${patch.patchId}/accept`)).status);
}
const closing = (await snap())?.closing;
console.log('closing ok:', closing?.ok, closing?.checks?.filter((c) => !c.ok).map((c) => c.detail).join('; ') || 'all checks green');
if (!closing?.ok) { console.log('STOP: closing checks are not green'); process.exit(5); }
// NO_START=1 stops at the green closing: the screens of the closing dialog are checked without spending a development run.
if (process.env.NO_START === '1') { console.log('closing green; start skipped (NO_START=1)'); process.exit(0); }
const started = await api('POST', `${S}/start`, { summaryHash: closing.summaryHash });
console.log('start with the summary hash', started.status, started.text.slice(0, 160));
