import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Accounting } from '../../budget/accounting.js';
import type { EvidenceRow } from '../../evidence/matrix.js';
import type { SmokeRow } from '../../exec/smoke.js';
import { OrchEvent } from '../events.js';
import { reportPack } from '../steps.js';
import { commitAndMergeDocs, docsWorktree, pauseForFailure, specDir, PAUSED_AUTH, type PhaseDeps } from './shared.js';

export interface Report { runId: string; specId: string; specHash: string; result: 'awaiting-validation' | 'verification-failed' | 'deploy-failed'; service: { url: string; healthcheck: string; smoke: SmokeRow[] } | null; deploy: { attempts: number; lastFailure: Record<string, unknown> | null }; evidence: EvidenceRow[]; delivered: string[]; blocked: Array<{ taskId: string; reason: string }>; assumptions: string[]; exploratoryScript: Array<{ acId: string; steps: string[] }>; tokens: { byRole: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>; total: { inputTokens: number; outputTokens: number; costUsd: number } }; summary: string; }
export type Phase6Deps = PhaseDeps & { runId: string; accounting: Accounting; result: Report['result'] };

export async function runPhase6(deps: Phase6Deps): Promise<{ ok: boolean; report: Report; reason?: string }> {
  const existing = [...deps.journal.events].reverse().find((e) => e.type === OrchEvent.ReportReady); if (existing) return { ok: true, report: existing.data.report as Report };
  await deps.journal.fact(OrchEvent.PhaseStarted, { phase: 6 });
  const events = deps.journal.events; const last = (t: string) => [...events].reverse().find((e) => e.type === t);
  const ve = [...events].reverse().find((e) => e.type === OrchEvent.VerificationPassed || e.type === OrchEvent.VerificationFailed);
  const dv = last(OrchEvent.DeployVerified); const failures = events.filter((e) => e.type === OrchEvent.DeployFailed);
  const total = deps.accounting.total();
  const roles = ['po', 'sm', 'dev', 'test', 'devops', 'system1'] as const;
  const byRole = Object.fromEntries(roles.map((role) => { const usage = deps.accounting.total({ role }); return [role, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd }]; }));
  const base = { runId: deps.runId, specId: deps.spec.specId, specHash: deps.specHash, result: deps.result, service: dv ? { url: String(dv.data.url), healthcheck: String(dv.data.healthcheck), smoke: dv.data.smoke as SmokeRow[] } : null, deploy: { attempts: failures.length || (dv ? Number(dv.data.attempt) : 0), lastFailure: failures.at(-1)?.data ?? null }, evidence: (ve?.data.matrix as EvidenceRow[] | undefined) ?? [], delivered: [...deps.journal.state.tasks.values()].filter((t) => t.state === 'merged').map((t) => t.def.id), blocked: [...deps.journal.state.tasks.values()].filter((t) => t.state === 'blocked').map((t) => ({ taskId: t.def.id, reason: 'blocked' })), assumptions: deps.journal.assumptions(), tokens: { byRole, total: { inputTokens: total.inputTokens, outputTokens: total.outputTokens, costUsd: total.costUsd } } };
  let script: Report['exploratoryScript'] = []; let summary = ''; let error = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await deps.runAgent<'report'>({ kind: 'report', role: 'sm', pack: reportPack(deps.packBase(), { delivered: base.delivered, blocked: base.blocked, evidence: JSON.stringify(base.evidence), assumptions: base.assumptions, deploy: JSON.stringify(base.service ?? base.deploy), tokens: JSON.stringify(base.tokens) }), cwd: deps.ws.repo, phase: 'phase6', taskId: null, attempt }) as any;
    if (out.ok && out.value) { script = out.value.exploratoryScript; summary = out.value.summary; break; }
    if (out.failure === 'quota' || out.failure === 'auth') { if (await pauseForFailure(deps, out.failure)) return { ok: false, report: { ...base, exploratoryScript: [], summary: PAUSED_AUTH }, reason: PAUSED_AUTH }; continue; }
    error = out.errors?.join('; ') ?? 'report step failed';
  }
  const report: Report = { ...base, exploratoryScript: script, summary: error ? `report step failed: ${error}` : summary };
  const branch = `docs/${deps.spec.specId}-report`; const wt = await docsWorktree(deps, branch); const dir = path.join(wt, specDir(deps.spec.specId)); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (deps.result === 'awaiting-validation') { const file = path.join(dir, 'spec.json'); const current = JSON.parse(await fs.readFile(file, 'utf8')); await fs.writeFile(file, `${JSON.stringify({ ...current, status: 'awaiting-validation' }, null, 2)}\n`); }
  const merged = await commitAndMergeDocs(deps, 6, branch, wt, `docs(${deps.spec.specId}): report`); await deps.journal.fact(OrchEvent.ReportReady, { report, merged: merged.ok }); return merged.ok ? { ok: true, report } : { ok: false, report, reason: merged.reason };
}
