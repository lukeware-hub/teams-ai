import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Accounting } from '../../budget/accounting.js';
import { attachE2e, type EvidenceRow } from '../../evidence/matrix.js';
import type { SmokeRow } from '../../exec/smoke.js';
import type { E2eRow } from '../../exec/e2e.js';
import { OrchEvent } from '../events.js';
import { validateDocs } from '../../validators/docs.js';
import { reportPack } from '../steps.js';
import { commitAndMergeDocs, docsWorktree, pauseForFailure, specDir, PAUSED_AUTH, type PhaseDeps } from './shared.js';
import { serviceLinks } from '../../deploy/service-links.js';

export interface Report { runId: string; specId: string; specHash: string; result: 'awaiting-validation' | 'verification-failed' | 'deploy-failed'; service: { url: string; healthcheck: string; smoke: SmokeRow[]; e2e?: E2eRow[]; port?: number; healthcheckPath?: string; kind?: 'api' | 'front'; docsPath?: string } | null; deploy: { attempts: number; lastFailure: Record<string, unknown> | null }; evidence: EvidenceRow[]; delivered: string[]; blocked: Array<{ taskId: string; reason: string }>; assumptions: string[]; exploratoryScript: Array<{ acId: string; steps: string[] }>; tokens: { byRole: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>; total: { inputTokens: number; outputTokens: number; costUsd: number } }; summary: string; securityFindings: SecurityFinding[]; }
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
const ROLES = ['po', 'sm', 'dev', 'front', 'test', 'sec', 'devops', 'system1'] as const;
/** Read after the report step so its own cost counts. */
function tokensOf(accounting: Accounting): Report['tokens'] {
  const pick = (u: { inputTokens: number; outputTokens: number; costUsd: number }) => ({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd });
  return { byRole: Object.fromEntries(ROLES.map((role) => [role, pick(accounting.total({ role }))])), total: pick(accounting.total()) };
}
export type Phase6Deps = PhaseDeps & { runId: string; accounting: Accounting; result: Report['result'] };

export async function runPhase6(deps: Phase6Deps): Promise<{ ok: boolean; report: Report; reason?: string }> {
  const existing = [...deps.journal.events].reverse().find((e) => e.type === OrchEvent.ReportReady); if (existing) return { ok: true, report: existing.data.report as Report };
  await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 6 });
  const events = deps.journal.events; const last = (t: string) => [...events].reverse().find((e) => e.type === t);
  const ve = [...events].reverse().find((e) => e.type === OrchEvent.VerificationPassed || e.type === OrchEvent.VerificationFailed);
  const dv = last(OrchEvent.DeployVerified); const failures = events.filter((e) => e.type === OrchEvent.DeployFailed);
  const base = { runId: deps.runId, specId: deps.spec.specId, specHash: deps.specHash, result: deps.result, service: dv ? { url: String(dv.data.url), healthcheck: String(dv.data.healthcheck), smoke: dv.data.smoke as SmokeRow[], ...(dv.data.e2e ? { e2e: dv.data.e2e as E2eRow[] } : {}), ...(typeof dv.data.port === 'number' ? { port: dv.data.port } : {}), ...(typeof dv.data.healthcheckPath === 'string' ? { healthcheckPath: dv.data.healthcheckPath } : {}), ...(dv.data.kind === 'api' || dv.data.kind === 'front' ? { kind: dv.data.kind as 'api' | 'front' } : {}), ...(typeof dv.data.docsPath === 'string' ? { docsPath: dv.data.docsPath } : {}) } : null, deploy: { attempts: failures.length || (dv ? Number(dv.data.attempt) : 0), lastFailure: failures.at(-1)?.data ?? null }, evidence: attachE2e((ve?.data.matrix as EvidenceRow[] | undefined) ?? [], dv?.data.e2e as E2eRow[] | undefined), delivered: [...deps.journal.state.tasks.values()].filter((t) => t.state === 'merged').map((t) => t.def.id), blocked: [...deps.journal.state.tasks.values()].filter((t) => t.state === 'blocked').map((t) => ({ taskId: t.def.id, reason: blockReason(events, t.def.id) })), assumptions: deps.journal.assumptions(), securityFindings: securityFindings(events), tokens: tokensOf(deps.accounting) };
  let script: Report['exploratoryScript'] = []; let summary = ''; let readme = ''; let runbook = ''; let apiDocs = ''; let error = ''; let docsErrors: string[] = []; let docsOk = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await deps.runAgent<'report'>({ kind: 'report', role: 'sm', pack: reportPack(deps.packBase(), { delivered: base.delivered, blocked: base.blocked, evidence: JSON.stringify(base.evidence), assumptions: base.assumptions, deploy: JSON.stringify(base.service ?? base.deploy), hostUrl: base.service ? serviceLinks(base.service, 'localhost').appUrl : null, tokens: JSON.stringify(base.tokens), security: base.securityFindings.map((f) => `- ${f.taskId} ${f.file}${f.line === null ? '' : `:${f.line}`} [${f.severity}] ${f.category}: ${f.problem}`).join('\n'), docsErrors }), cwd: deps.ws.repo, phase: 'phase6', taskId: null, attempt }) as any;
    if (out.ok && out.value) {
      script = out.value.exploratoryScript; summary = out.value.summary; readme = out.value.readme; runbook = out.value.runbook ?? ''; apiDocs = out.value.apiDocs ?? '';
      docsErrors = validateDocs({ readme, runbook, apiDocs }, deps.spec.features);
      if (docsErrors.length === 0) { docsOk = true; break; }
      error = `documentation rejected: ${docsErrors.join('; ')}`; continue;
    }
    if (out.failure === 'quota' || out.failure === 'auth') { if (await pauseForFailure(deps, out.failure)) return { ok: false, report: { ...base, exploratoryScript: [], summary: PAUSED_AUTH }, reason: PAUSED_AUTH }; continue; }
    error = out.errors?.join('; ') ?? 'report step failed';
  }
  if (!docsOk && !error) error = 'report step failed';
  if (!docsOk) { const reason = `Phase 6 blocked: ${error}`; await deps.journal.fact(OrchEvent.PhaseFailed, { phase: 6, reason }); return { ok: false, report: { ...base, exploratoryScript: script, summary: reason }, reason }; }
  const report: Report = { ...base, exploratoryScript: script, summary, tokens: tokensOf(deps.accounting) };
  const branch = `docs/${deps.spec.specId}-report`; const wt = await docsWorktree(deps, branch); const dir = path.join(wt, specDir(deps.spec.specId)); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.mkdir(path.join(wt, 'docs'), { recursive: true });
  await fs.writeFile(path.join(wt, 'docs', 'README.md'), `${readme.trimEnd()}\n`);
  await fs.writeFile(path.join(wt, 'docs', 'RUNBOOK.md'), `${runbook.trimEnd()}\n`);
  if (apiDocs.trim()) await fs.writeFile(path.join(wt, 'docs', 'API.md'), `${apiDocs.trimEnd()}\n`);
  if (deps.result === 'awaiting-validation') { const file = path.join(dir, 'spec.json'); const current = JSON.parse(await fs.readFile(file, 'utf8')); await fs.writeFile(file, `${JSON.stringify({ ...current, status: 'awaiting-validation' }, null, 2)}\n`); }
  const merged = await commitAndMergeDocs(deps, 6, branch, wt, `docs(${deps.spec.specId}): report`); await deps.journal.fact(OrchEvent.ReportReady, { report, merged: merged.ok }); return merged.ok ? { ok: true, report } : { ok: false, report, reason: merged.reason };
}
