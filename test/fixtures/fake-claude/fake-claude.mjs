#!/usr/bin/env node
// Replays a stream-json fixture as if it were `claude -p`. Controlled by environment variables:
//   FAKE_CLAUDE_FIXTURE   path to an .ndjson file (required unless FAKE_CLAUDE_HANG_IMMEDIATELY)
//   FAKE_CLAUDE_DELAY_MS  delay between lines (default 0)
//   FAKE_CLAUDE_HANG_AFTER  stop after N lines and never exit
//   FAKE_CLAUDE_STDERR    text to print on stderr before the stream
//   FAKE_CLAUDE_EXIT_CODE exit code after the stream (default 0)
//   FAKE_CLAUDE_CAPTURE   path; argv and env are written there as JSON for assertions
import { readFileSync, writeFileSync } from 'node:fs';

const env = process.env;
if (env.FAKE_CLAUDE_CAPTURE) {
  writeFileSync(env.FAKE_CLAUDE_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), env: { ...env }, cwd: process.cwd() }));
}
if (env.FAKE_CLAUDE_STDERR) process.stderr.write(`${env.FAKE_CLAUDE_STDERR}\n`);

const delay = Number(env.FAKE_CLAUDE_DELAY_MS ?? 0);
const hangAfter = env.FAKE_CLAUDE_HANG_AFTER === undefined ? Infinity : Number(env.FAKE_CLAUDE_HANG_AFTER);
const lines = env.FAKE_CLAUDE_FIXTURE ? readFileSync(env.FAKE_CLAUDE_FIXTURE, 'utf8').split('\n').filter((l) => l.trim()) : [];

let i = 0;
const tick = () => {
  if (i >= hangAfter) {
    setInterval(() => {}, 60_000); // keep the event loop alive: hang until the runner kills us
    return;
  }
  if (i >= lines.length) {
    process.exit(Number(env.FAKE_CLAUDE_EXIT_CODE ?? 0));
  }
  process.stdout.write(`${lines[i++]}\n`);
  setTimeout(tick, delay);
};
tick();
