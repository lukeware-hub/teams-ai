import type { CommandResult, CommandSpec, Exec } from '../../server/exec/command.js';

type Responder = (spec: CommandSpec) => Partial<CommandResult> | Promise<Partial<CommandResult>>;

/** Scripted Exec: `on(match, respond)` rules are tried in order; unmatched calls succeed with empty output. */
export class FakeExec {
  readonly calls: CommandSpec[] = [];
  private readonly rules: Array<{ match: (spec: CommandSpec) => boolean; respond: Responder }> = [];

  on(match: (spec: CommandSpec) => boolean, respond: Responder): this {
    this.rules.push({ match, respond });
    return this;
  }

  /** Convenience: match by binary and a leading argument prefix, e.g. `onArgs('gh', ['pr', 'list'], ...)`. */
  onArgs(bin: string, prefix: readonly string[], respond: Responder): this {
    return this.on((s) => s.bin === bin && prefix.every((a, i) => s.args[i] === a), respond);
  }

  exec: Exec = async (spec) => {
    this.calls.push(spec);
    const rule = this.rules.find((r) => r.match(spec));
    const partial = rule ? await rule.respond(spec) : {};
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false, ...partial };
  };

  /** Args of every call to `bin`, joined, for assertions. */
  lines(bin: string): string[] {
    return this.calls.filter((c) => c.bin === bin).map((c) => c.args.join(' '));
  }
}
