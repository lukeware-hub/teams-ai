import type { RunAgent } from '../../server/refine/session.js';

export type Script = Record<string, unknown[]>; // `${kind}/${role}` → outputs per call
export const calls: Array<{ kind: string; role: string; prompt: string }> = [];

/** Scripted refine agent: journals STEP_STARTED/STEP_FINISHED like runAgentStep and answers from `script`. */
export function makeFakeRunAgent(script: Script): RunAgent {
  return (async (req, ctx) => {
    calls.push({ kind: req.kind, role: req.role, prompt: JSON.stringify(req.pack) });
    const seq = ctx.journal.allocStepSeq();
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await ctx.journal.fact('STEP_STARTED', { stepId: `s${seq}`, kind: req.kind, role: req.role, taskId: null, attempt: req.attempt });
    const next = req.role === 'front' && req.kind === 'refine'
      ? (script[`${req.kind}/${req.role}`]?.shift() ?? { checklist: [], questions: [], docPatch: [] })
      : script[`${req.kind}/${req.role}`]?.shift();
    await ctx.journal.fact('STEP_FINISHED', { stepId: `s${seq}`, kind: req.kind, taskId: null, attempt: req.attempt, ok: next !== undefined, failure: next === undefined ? 'schema' : null, usage, costUsd: 0.01, durationMs: 1, numTurns: 1 });
    const summary = { usage, costUsd: 0.01, durationMs: 1, numTurns: 1, rateLimit: null };
    if (next === undefined) return { ok: false, failure: 'schema', errors: ['no scripted output'], summary, sandboxDisabled: false } as never;
    return { ok: true, value: { ...(next as object), specHash: ctx.specHash }, summary } as never;
  }) as RunAgent;
}
