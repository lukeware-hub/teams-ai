import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Accounting } from '../../budget/accounting.js';
import { attachE2e, type EvidenceRow } from '../../evidence/matrix.js';
import type { SmokeRow } from '../../exec/smoke.js';
import type { E2eRow } from '../../exec/e2e.js';
import { OrchEvent } from '../events.js';
import { resolveDocs, validateDocs } from '../../validators/docs.js';
import { reportPack } from '../steps.js';
import { commitAndMergeDocs, currentDocs, freshDocsWorktree, pauseForFailure, specDir, PAUSED_AUTH, type PhaseDeps } from './shared.js';
import { serviceLinks } from '../../deploy/service-links.js';
import { priorRunEvents } from '../workspace.js';
import { checkGaps, type GapsReport } from './gaps.js';

/** One service of a services run, as Phase 5 verified it. */
export interface ReportService { service: string; url: string; healthcheck: string; port?: number; healthcheckPath?: string; kind?: 'api' | 'front'; docsPath?: string }
/** A pull request the run opened: the task its branch carries (none for a docs branch), and whether it merged. */
export interface ReportPr { task: string | null; branch: string; number: number; url: string; repository: string; merged: boolean }
export interface Report { runId: string; specId: string; specHash: string; result: 'awaiting-validation' | 'verification-failed' | 'deploy-failed'; service: { url: string; healthcheck: string; smoke: SmokeRow[]; e2e?: E2eRow[]; port?: number; healthcheckPath?: string; kind?: 'api' | 'front' | 'mobile'; docsPath?: string; artifact?: string } | null; services?: ReportService[]; deploy: { attempts: number; lastFailure: Record<string, unknown> | null }; evidence: EvidenceRow[]; delivered: string[]; blocked: Array<{ taskId: string; reason: string }>; assumptions: string[]; exploratoryScript: Array<{ acId: string; steps: string[] }>; tokens: { byRole: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>; total: { inputTokens: number; outputTokens: number; costUsd: number } }; summary: string; securityFindings: SecurityFinding[]; prs: ReportPr[]; gaps?: GapsReport; }
export interface SecurityFinding { taskId: string; file: string; line: number | null; severity: 'critical' | 'high' | 'medium' | 'low'; category: string; problem: string; fix: string }
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

/** Latest security review per task (a task may be reviewed once per attempt), most severe first. */
export function securityFindings(events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>): SecurityFinding[] {
  const latest = new Map<string, unknown[]>();
  for (const e of events) if (e.type === OrchEvent.SecurityApproved || e.type === OrchEvent.SecurityChanges) latest.set(String(e.data.taskId), (e.data.findings as unknown[] | undefined) ?? []);
  return [...latest].flatMap(([taskId, findings]) => (findings as Array<Omit<SecurityFinding, 'taskId'>>).map((f) => ({ taskId, ...f }))).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

/** The reason the orchestrator journaled when it blocked the task, so the report says why and not just that. */
export function blockReason(events: readonly { type: string; data: Record<string, unknown> }[], taskId: string): string {
  const e = [...events].reverse().find((x) => x.type === OrchEvent.TaskBlocked && x.data.taskId === taskId);
  return String(e?.data.reason ?? 'blocked');
}

/** Every pull request the run opened, once each; the repository comes from the URL, since a services run spans several. */
export function runPrs(events: readonly { type: string; data: Record<string, unknown> }[], specId: string): ReportPr[] {
  const prefix = `task/${specId}-`;
  // A merge recovered after a crash names its branch, which is the only way to tell a docs pull request's.
  const branchOf = (e: { data: Record<string, unknown> }) => (typeof e.data.branch === 'string' ? e.data.branch : `${prefix}${String(e.data.taskId)}`);
  const merged = new Set(events.flatMap((e) => (e.type === OrchEvent.PrMerged || e.type === OrchEvent.DocsMerged ? [`${branchOf(e)}#${String(e.data.pr)}`] : [])));
  const prs = new Map<string, ReportPr>();
  for (const e of events) {
    if (e.type !== OrchEvent.PrCreated) continue;
    const branch = String(e.data.branch);
    const number = Number(e.data.number);
    const url = String(e.data.url);
    prs.set(url, { task: branch.startsWith(prefix) ? branch.slice(prefix.length) : null, branch, number, url, repository: /([^/]+\/[^/]+)\/pull\/\d+$/.exec(url)?.[1] ?? '', merged: merged.has(`${branch}#${number}`) });
  }
  return [...prs.values()];
}
const ROLES = ['po', 'sm', 'dev', 'front', 'test', 'sec', 'devops', 'env', 'system1'] as const;
/** Read after the report step so its own cost counts. */
function tokensOf(accounting: Accounting): Report['tokens'] {
  const pick = (u: { inputTokens: number; outputTokens: number; costUsd: number }) => ({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd });
  return { byRole: Object.fromEntries(ROLES.map((role) => [role, pick(accounting.total({ role }))])), total: pick(accounting.total()) };
}
/** Where the human opens what was deployed: the service, or each published service with its name. */
function hostUrl(r: Pick<Report, 'service' | 'services'>): string | null {
  if (!r.services) return r.service ? serviceLinks(r.service, 'localhost').appUrl : null;
  const urls = r.services.flatMap((s) => { const url = serviceLinks(s, 'localhost').appUrl; return url ? [`${url} (${s.service})`] : []; });
  return urls.length > 0 ? urls.join(', ') : null;
}
/** A service card for the SM: without the address only the platform reaches, which the human never opens. */
const withoutUrl = <T extends { url: string }>({ url: _url, ...rest }: T): Omit<T, 'url'> => rest;
export type Phase6Deps = PhaseDeps & { runId: string; accounting: Accounting; result: Report['result'] };

export async function runPhase6(deps: Phase6Deps): Promise<{ ok: boolean; report: Report; reason?: string }> {
  const existing = [...deps.journal.events].reverse().find((e) => e.type === OrchEvent.ReportReady); if (existing) return { ok: true, report: existing.data.report as Report };
  await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 6 });
  const events = deps.journal.events; const last = (t: string) => [...events].reverse().find((e) => e.type === t);
  const ve = [...events].reverse().find((e) => e.type === OrchEvent.VerificationPassed || e.type === OrchEvent.VerificationFailed);
  const dv = last(OrchEvent.DeployVerified); const failures = events.filter((e) => e.type === OrchEvent.DeployFailed);
  // report.json belongs to the spec, so it lists the pull requests of the earlier runs this one went on from.
  const earlier = (await priorRunEvents(deps.ws, deps.spec.specId, deps.runId)).flat();
  const base = { runId: deps.runId, specId: deps.spec.specId, specHash: deps.specHash, result: deps.result, service: dv ? { url: String(dv.data.url), healthcheck: String(dv.data.healthcheck), smoke: dv.data.smoke as SmokeRow[], ...(dv.data.e2e ? { e2e: dv.data.e2e as E2eRow[] } : {}), ...(typeof dv.data.port === 'number' ? { port: dv.data.port } : {}), ...(typeof dv.data.healthcheckPath === 'string' ? { healthcheckPath: dv.data.healthcheckPath } : {}), ...(dv.data.kind === 'api' || dv.data.kind === 'front' || dv.data.kind === 'mobile' ? { kind: dv.data.kind as 'api' | 'front' | 'mobile' } : {}), ...(typeof dv.data.artifact === 'string' ? { artifact: dv.data.artifact } : {}), ...(typeof dv.data.docsPath === 'string' ? { docsPath: dv.data.docsPath } : {}) } : null, ...(Array.isArray(dv?.data.services) ? { services: dv!.data.services as ReportService[] } : {}), deploy: { attempts: failures.length || (dv ? Number(dv.data.attempt) : 0), lastFailure: failures.at(-1)?.data ?? null }, evidence: attachE2e((ve?.data.matrix as EvidenceRow[] | undefined) ?? [], dv?.data.e2e as E2eRow[] | undefined), delivered: [...deps.journal.state.tasks.values()].filter((t) => t.state === 'merged').map((t) => t.def.id), blocked: [...deps.journal.state.tasks.values()].filter((t) => t.state === 'blocked').map((t) => ({ taskId: t.def.id, reason: blockReason(events, t.def.id) })), assumptions: deps.journal.assumptions(), securityFindings: securityFindings(events), prs: runPrs([...earlier, ...events], deps.spec.specId), tokens: tokensOf(deps.accounting) };
  // The step works in the docs worktree, a checkout of main, so it can read whole any document the pack cuts.
  const branch = `docs/${deps.spec.specId}-report`; const wt = await freshDocsWorktree(deps, branch, 6); const current = await currentDocs(wt);
  // The gap check reads the code on main before the report step writes into this checkout; a resume reuses what it journaled.
  const journaled = [...deps.journal.events].reverse().find((e) => e.type === OrchEvent.GapsChecked);
  const gaps = journaled ? journaled.data.gaps as GapsReport : await checkGaps(deps, wt, { evidence: base.evidence, tasks: new Map([...deps.journal.state.tasks].map(([id, t]) => [id, { state: t.state, dependsOn: t.def.dependsOn }] as const)), reasonOf: (id) => blockReason(deps.journal.events, id), result: deps.result });
  if (gaps === PAUSED_AUTH) return { ok: false, report: { ...base, exploratoryScript: [], summary: PAUSED_AUTH }, reason: PAUSED_AUTH };
  if (!journaled) await deps.journal.fact(OrchEvent.GapsChecked, { gaps });
  let script: Report['exploratoryScript'] = []; let summary = ''; let readme = ''; let runbook = ''; let apiDocs = ''; let error = ''; let docsErrors: string[] = []; let docsOk = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await deps.runAgent<'report'>({ kind: 'report', role: 'sm', pack: reportPack(deps.packBase(), { readmeSections: deps.plan?.delivery?.readmeSections, delivered: base.delivered, blocked: base.blocked, evidence: JSON.stringify(base.evidence), assumptions: base.assumptions, deploy: JSON.stringify(base.service && base.services ? { ...withoutUrl(base.service), services: base.services.map(withoutUrl) } : base.service ?? base.deploy), hostUrl: hostUrl(base), tokens: JSON.stringify(base.tokens), security: base.securityFindings.map((f) => `- ${f.taskId} ${f.file}${f.line === null ? '' : `:${f.line}`} [${f.severity}] ${f.category}: ${f.problem}`).join('\n'), docsErrors, current }), cwd: wt, phase: 'phase6', taskId: null, attempt }) as any;
    if (out.ok && out.value) {
      script = out.value.exploratoryScript; summary = out.value.summary;
      const resolved = resolveDocs(out.value, current); readme = resolved.docs.readme; runbook = resolved.docs.runbook ?? ''; apiDocs = resolved.docs.apiDocs ?? '';
      docsErrors = [...resolved.errors, ...validateDocs(resolved.docs, deps.spec.features, deps.plan?.delivery?.readmeSections, current)];
      if (docsErrors.length === 0) { docsOk = true; break; }
      error = `documentation rejected: ${docsErrors.join('; ')}`; continue;
    }
    if (out.failure === 'quota' || out.failure === 'auth') { if (await pauseForFailure(deps, out.failure)) return { ok: false, report: { ...base, exploratoryScript: [], summary: PAUSED_AUTH }, reason: PAUSED_AUTH }; continue; }
    error = out.errors?.join('; ') ?? 'report step failed';
  }
  if (!docsOk && !error) error = 'report step failed';
  if (!docsOk) { const reason = `Phase 6 blocked: ${error}`; await deps.journal.fact(OrchEvent.PhaseFailed, { phase: 6, reason }); return { ok: false, report: { ...base, exploratoryScript: script, summary: reason }, reason }; }
  const report: Report = { ...base, gaps, exploratoryScript: script, summary, tokens: tokensOf(deps.accounting) };
  const dir = path.join(wt, specDir(deps.spec.specId)); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.mkdir(path.join(wt, 'docs'), { recursive: true });
  await fs.writeFile(path.join(wt, 'docs', 'README.md'), `${readme.trimEnd()}\n`);
  await fs.writeFile(path.join(wt, 'docs', 'RUNBOOK.md'), `${runbook.trimEnd()}\n`);
  if (apiDocs.trim()) await fs.writeFile(path.join(wt, 'docs', 'API.md'), `${apiDocs.trimEnd()}\n`);
  if (deps.result === 'awaiting-validation') { const file = path.join(dir, 'spec.json'); const specJson = JSON.parse(await fs.readFile(file, 'utf8')); await fs.writeFile(file, `${JSON.stringify({ ...specJson, status: 'awaiting-validation' }, null, 2)}\n`); }
  const merged = await commitAndMergeDocs(deps, 6, branch, wt, `docs(${deps.spec.specId}): report`); await deps.journal.fact(OrchEvent.ReportReady, { report, merged: merged.ok }); return merged.ok ? { ok: true, report } : { ok: false, report, reason: merged.reason };
}
