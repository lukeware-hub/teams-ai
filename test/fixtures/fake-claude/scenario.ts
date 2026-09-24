import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StepKind } from '../../../server/agents/outputs.js';
import type { runStep as runStepFn, StepDeps, StepRequest } from '../../../server/runner/step.js';

export interface ScenarioStep {
  output: unknown;
  files?: Record<string, string>;
  failure?: { stderr: string; exitCode: number };
}

const key = (kind: string, taskId: string | null, attempt: number) => `${kind}/${taskId ?? '-'}/${attempt}`;

/** Scripted fake-claude outputs per (kind, taskId, attempt); the wrapper applies file side effects the real Dev would make. */
export class Scenario {
  private readonly steps = new Map<string, ScenarioStep>();
  readonly seen: string[] = [];

  constructor(readonly dir: string) {}

  set(kind: StepKind, taskId: string | null, attempt: number, step: ScenarioStep): this {
    this.steps.set(key(kind, taskId, attempt), step);
    return this;
  }

  static fixtureLines(structuredOutput: unknown, usage = { input: 500, output: 40 }): string[] {
    const init = { type: 'system', subtype: 'init', session_id: 'fake', model: 'fake', tools: ['StructuredOutput'], mcp_servers: [], permissionMode: 'dontAsk' };
    const result = {
      type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 5, duration_api_ms: 4, total_cost_usd: 0.001,
      usage: { input_tokens: usage.input, output_tokens: usage.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      terminal_reason: 'completed', api_error_status: null, session_id: 'fake',
      result: JSON.stringify(structuredOutput), structured_output: structuredOutput,
    };
    return [JSON.stringify(init), JSON.stringify(result)];
  }

  wrap(real: typeof runStepFn): typeof runStepFn {
    return (async (req: StepRequest, deps: StepDeps) => {
      const k = key(req.kind, req.taskId, req.attempt);
      this.seen.push(k);
      const step = this.steps.get(k);
      if (!step) throw new Error(`Scenario: no step for ${k}`);
      for (const [rel, text] of Object.entries(step.files ?? {})) {
        await fs.mkdir(path.dirname(path.join(req.cwd, rel)), { recursive: true });
        await fs.writeFile(path.join(req.cwd, rel), text);
      }
      const fixture = path.join(this.dir, `${k.replace(/[^a-zA-Z0-9]+/g, '_')}.ndjson`);
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(fixture, `${Scenario.fixtureLines(step.output).join('\n')}\n`);
      const env: Record<string, string> = { ...deps.binary.env, FAKE_CLAUDE_FIXTURE: fixture };
      if (step.failure) {
        env.FAKE_CLAUDE_STDERR = step.failure.stderr;
        env.FAKE_CLAUDE_EXIT_CODE = String(step.failure.exitCode);
      }
      return real(req, { ...deps, binary: { ...deps.binary, env } });
    }) as typeof runStepFn;
  }
}
