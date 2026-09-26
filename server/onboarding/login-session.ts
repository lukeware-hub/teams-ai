import type { Pty, PtySpec, SpawnPty } from './pty.js';
import { TranscriptReader, type Cli } from './transcripts.js';

export type SessionState =
  | { name: 'idle' }
  | { name: 'starting' }
  | { name: 'awaiting-browser'; url: string; code: string | null }
  | { name: 'awaiting-code'; url: string | null }
  | { name: 'verifying' }
  | { name: 'done'; detail: string }
  | { name: 'failed'; reason: string };

export type SessionEvent = { type: 'state'; state: SessionState } | { type: 'output'; chunk: string };

export interface LoginSessionDeps {
  cli: Cli;
  spawn: SpawnPty;
  command: PtySpec;
  probe: () => Promise<{ ok: boolean; detail: string }>;
  clock?: () => number;
  timeoutMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
  knownSecrets?: () => readonly string[];
  autoEnter?: boolean;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/**
 * Spec (onboarding) §3. One CLI login behind a pty. Every transition is an event; the transcript is
 * redacted before anything is stored or emitted; only the probe makes the session `done`.
 */
export class LoginSession {
  private current: SessionState = { name: 'idle' };
  private pty: Pty | null = null;
  private reader: TranscriptReader | null = null;
  private cancelTimeout: (() => void) | null = null;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  /** Codes seen or pasted in this process; redacted from every chunk (spec §3 "never persisted or logged"). */
  private readonly codes: string[] = [];
  private generation = 0;

  constructor(private readonly deps: LoginSessionDeps) {}

  get state(): SessionState {
    return this.current;
  }

  get output(): string {
    return this.reader?.tail ?? '';
  }

  get live(): boolean {
    return this.pty !== null;
  }

  on(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.pty) this.killProcess();
    const gen = ++this.generation;
    this.codes.length = 0;
    this.reader = new TranscriptReader(this.deps.cli, () => [...(this.deps.knownSecrets?.() ?? []), ...this.codes]);
    this.set({ name: 'starting' });
    const pty = this.deps.spawn(this.deps.command);
    this.pty = pty;
    let enterSent = false;
    let gitCredentialConfirmationSent = false;
    pty.onData((raw) => {
      if (gen !== this.generation || !this.reader) return;
      const clean = this.reader.push(raw);
      if (clean !== '') this.emit({ type: 'output', chunk: clean });
      const st = this.reader.state;
      if (this.deps.cli === 'gh' && !gitCredentialConfirmationSent && /Authenticate Git with your GitHub credentials\?\s*\(Y\/n\)/i.test(`${clean}\n${this.reader.tail}`)) {
        gitCredentialConfirmationSent = true;
        pty.write('y\r');
      }
      if (st.code && !this.codes.includes(st.code)) this.codes.push(st.code);
      if (this.current.name === 'starting' && st.url) this.set({ name: 'awaiting-browser', url: st.url, code: st.code });
      else if (this.current.name === 'awaiting-browser' && st.code && this.current.code === null) this.set({ ...this.current, code: st.code });
      if (this.current.name === 'awaiting-browser' && st.pasteCodePrompt && this.deps.cli === 'claude') this.set({ name: 'awaiting-code', url: st.url });
      const autoEnter = this.deps.autoEnter ?? this.deps.cli === 'gh';
      if (autoEnter && !enterSent && st.url && st.code) {
        enterSent = true;
        pty.write('\n');
      }
      if (st.success && (this.current.name === 'awaiting-browser' || this.current.name === 'awaiting-code')) this.set({ name: 'verifying' });
    });
    pty.onExit((code) => {
      if (gen !== this.generation) return;
      this.pty = null;
      this.cancelTimeout?.();
      this.cancelTimeout = null;
      if (this.current.name === 'failed' || this.current.name === 'done') return;
      if (this.current.name !== 'verifying') this.set({ name: 'verifying' });
      void this.verify(gen, code);
    });
    this.cancelTimeout = (this.deps.schedule ?? defaultSchedule)(() => {
      if (gen !== this.generation || !this.pty) return;
      this.generation += 1; // same as cancel(): the killed process's exit callback must not run verify()
      this.killProcess();
      this.set({ name: 'failed', reason: 'timeout' });
    }, this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  sendCode(code: string): boolean {
    if (this.current.name !== 'awaiting-code' || !this.pty) return false;
    const trimmed = code.trim();
    if (trimmed === '') return false;
    this.codes.push(trimmed);
    this.pty.write(`${trimmed}\n`);
    this.set({ name: 'verifying' });
    return true;
  }

  cancel(): void {
    if (!this.pty) return;
    this.generation += 1; // the exit callback of the killed process must not run verify()
    this.killProcess();
    this.set({ name: 'failed', reason: 'cancelled' });
  }

  private async verify(gen: number, exitCode: number | null): Promise<void> {
    let result = await this.deps.probe().catch((err: Error) => ({ ok: false, detail: err.message }));
    for (let attempt = 0; this.deps.cli === 'gh' && !result.ok && attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      result = await this.deps.probe().catch((err: Error) => ({ ok: false, detail: err.message }));
    }
    if (gen !== this.generation) return;
    if (result.ok) this.set({ name: 'done', detail: result.detail });
    else {
      const tail = this.output.trim().split('\n').slice(-5).join('\n');
      this.set({ name: 'failed', reason: `${result.detail} (exit ${exitCode ?? 'null'})${tail ? `\n${tail}` : ''}` });
    }
  }

  private killProcess(): void {
    const p = this.pty;
    this.pty = null;
    this.cancelTimeout?.();
    this.cancelTimeout = null;
    p?.kill();
  }

  private set(state: SessionState): void {
    this.current = state;
    this.emit({ type: 'state', state });
  }

  private emit(e: SessionEvent): void {
    for (const l of this.listeners) l(e);
  }
}
