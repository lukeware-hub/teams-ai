import { describe, expect, it } from 'vitest';
import { LoginSession, type LoginSessionDeps, type SessionEvent } from '../../server/onboarding/login-session.js';
import type { Pty, PtySpec } from '../../server/onboarding/pty.js';

/** A scripted pty: the test pushes chunks and exit codes; writes are recorded. */
class FakePty implements Pty {
  writes: string[] = [];
  killed = false;
  private data: Array<(c: string) => void> = [];
  private exit: Array<(c: number | null) => void> = [];
  write(d: string) { this.writes.push(d); }
  kill() { this.killed = true; this.emitExit(143); }
  onData(cb: (c: string) => void) { this.data.push(cb); }
  onExit(cb: (c: number | null) => void) { this.exit.push(cb); }
  emit(chunk: string) { for (const cb of this.data) cb(chunk); }
  emitExit(code: number | null) { for (const cb of this.exit) cb(code); }
}

function harness(over: Partial<LoginSessionDeps> = {}) {
  const ptys: FakePty[] = [];
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const events: SessionEvent[] = [];
  const probeResults: Array<{ ok: boolean; detail: string }> = [{ ok: true, detail: 'ada@example.com (max)' }];
  const deps: LoginSessionDeps = {
    cli: 'claude',
    spawn: (_spec: PtySpec) => { const p = new FakePty(); ptys.push(p); return p; },
    command: { bin: 'claude', args: ['auth', 'login', '--claudeai'] },
    probe: async () => probeResults.shift() ?? { ok: false, detail: 'no probe result' },
    clock: () => now,
    schedule: (fn, ms) => { const t = { at: now + ms, fn, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    knownSecrets: () => ['host-secret'],
    ...over,
  };
  const s = new LoginSession(deps);
  s.on((e) => events.push(e));
  const advance = (ms: number) => { now += ms; for (const t of timers) if (!t.cancelled && t.at <= now) { t.cancelled = true; t.fn(); } };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { s, ptys, events, advance, tick, probeResults };
}
const names = (events: SessionEvent[]) => events.filter((e) => e.type === 'state').map((e) => (e as { state: { name: string } }).state.name);

describe('LoginSession (claude flow)', () => {
  it('goes starting → awaiting-browser → awaiting-code → verifying → done and never emits the pasted code', async () => {
    const h = harness();
    h.s.start();
    const p = h.ptys[0]!;
    p.emit('Opening browser…\nhttps://claude.example/oauth/authorize?state=X\n');
    expect(h.s.state).toEqual({ name: 'awaiting-browser', url: 'https://claude.example/oauth/authorize?state=X', code: null });
    p.emit('Paste code here if prompted > ');
    expect(h.s.state.name).toBe('awaiting-code');
    expect(h.s.sendCode('p0SAAx#Uf52_state')).toBe(true);
    expect(p.writes).toEqual(['p0SAAx#Uf52_state\n']);
    expect(h.s.state.name).toBe('verifying');
    p.emit('Login successful\n');
    p.emitExit(0);
    await h.tick();
    expect(h.s.state).toEqual({ name: 'done', detail: 'ada@example.com (max)' });
    expect(names(h.events)).toEqual(['starting', 'awaiting-browser', 'awaiting-code', 'verifying', 'done']);
    expect(JSON.stringify(h.events)).not.toContain('p0SAAx');
    expect(h.s.output).not.toContain('p0SAAx');
  });

  it('writes the pasted code plus newline to the pty and never emits it, even when the CLI echoes it back', async () => {
    const h = harness();
    h.s.start();
    const p = h.ptys[0]!;
    p.emit('https://claude.example/a\nPaste code here if prompted > ');
    h.s.sendCode('c0de#st4te');
    p.emit('you typed c0de#st4te\n');
    expect(JSON.stringify(h.events)).not.toContain('c0de#st4te');
    expect(h.s.output).toContain('[REDACTED]');
  });

  it('a process that exits before printing a URL goes straight to verifying and lets the probe decide', async () => {
    const h = harness();
    h.s.start();
    h.ptys[0]!.emitExit(0);
    await h.tick();
    expect(names(h.events)).toEqual(['starting', 'verifying', 'done']);
  });

  it('fails with the exit code and the redacted tail when the probe stays red', async () => {
    const h = harness();
    h.probeResults.splice(0, 1, { ok: false, detail: 'not logged in' });
    h.s.start();
    const p = h.ptys[0]!;
    p.emit('https://claude.example/a\nPaste code here > ');
    h.s.sendCode('bad');
    p.emit('Invalid code, host-secret leaked\n');
    p.emitExit(1);
    await h.tick();
    expect(h.s.state.name).toBe('failed');
    const reason = (h.s.state as { reason: string }).reason;
    expect(reason).toContain('exit 1');
    expect(reason).toContain('not logged in');
    expect(reason).toContain('[REDACTED]');
    expect(reason).not.toContain('host-secret');
  });

  it('times out after ten minutes, killing the process', async () => {
    const h = harness();
    h.s.start();
    h.advance(600_000);
    await h.tick();
    expect(h.ptys[0]!.killed).toBe(true);
    expect(h.s.state).toEqual({ name: 'failed', reason: 'timeout' });
  });

  it('cancel kills the process and starting a new session kills the live one', async () => {
    const h = harness();
    h.s.start();
    h.s.cancel();
    expect(h.ptys[0]!.killed).toBe(true);
    expect(h.s.state).toEqual({ name: 'failed', reason: 'cancelled' });
    h.s.start();
    h.s.start();
    expect(h.ptys).toHaveLength(3);
    expect(h.ptys[1]!.killed).toBe(true);
    expect(h.ptys[2]!.killed).toBe(false);
    expect(h.s.live).toBe(true);
  });

  it('sendCode is refused outside awaiting-code', () => {
    const h = harness();
    expect(h.s.sendCode('x')).toBe(false);
    h.s.start();
    expect(h.s.sendCode('x')).toBe(false);
    expect(h.ptys[0]!.writes).toEqual([]);
  });
});

describe('LoginSession (gh flow)', () => {
  it('confirms GitHub credential storage before continuing to device login', () => {
    const h = harness({ cli: 'gh', command: { bin: 'gh', args: ['auth', 'login', '--web'] } });
    h.s.start();
    h.ptys[0]!.emit('? Authenticate Git with your GitHub credentials? (Y/n)\n');
    expect(h.ptys[0]!.writes).toEqual(['y\r']);
  });

  it('shows the one-time code with the URL, presses Enter itself, and finishes on the success line', async () => {
    const h = harness({ cli: 'gh', command: { bin: 'gh', args: ['auth', 'login', '--web'] } });
    h.probeResults.splice(0, 1, { ok: true, detail: 'lukeware70X7' });
    h.s.start();
    const p = h.ptys[0]!;
    p.emit('! First copy your one-time code: A1EB-D4E0\n');
    p.emit('Press Enter to open https://github.com/login/device in your browser...');
    expect(h.s.state).toEqual({ name: 'awaiting-browser', url: 'https://github.com/login/device', code: 'A1EB-D4E0' });
    expect(p.writes).toEqual(['\n']);
    p.emit('\n✓ Logged in as lukeware70X7\n');
    p.emitExit(0);
    await h.tick();
    expect(h.s.state).toEqual({ name: 'done', detail: 'lukeware70X7' });
    expect(names(h.events)).toEqual(['starting', 'awaiting-browser', 'verifying', 'done']);
  });
});
