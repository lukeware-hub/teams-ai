import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStreamJson, summarizeStream } from '../../server/runner/stream-events.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/stream/${name}.ndjson`, import.meta.url), 'utf8');

describe('parseStreamJson', () => {
  it('parses one event per line', () => {
    const parsed = parseStreamJson(fixture('success'));
    expect(parsed.events.map((e) => e.type)).toEqual(['system', 'assistant', 'result']);
    expect(parsed.malformed).toEqual([]);
  });

  it('keeps going past non-JSON lines and a truncated tail, reporting them', () => {
    const parsed = parseStreamJson(fixture('noisy'));
    expect(parsed.events.map((e) => e.type)).toEqual(['system', 'result']);
    expect(parsed.malformed.map((m) => m.line)).toEqual([1, 4]);
  });

  it('rejects a JSON line without a string type as malformed', () => {
    const parsed = parseStreamJson('{"foo":1}\n{"type":"result","subtype":"success"}\n');
    expect(parsed.malformed).toHaveLength(1);
    expect(parsed.events).toHaveLength(1);
  });
});

describe('summarizeStream', () => {
  it('extracts usage, cost, turns and the result text from a success', () => {
    const summary = summarizeStream(parseStreamJson(fixture('success')));
    expect(summary).toEqual({
      found: true,
      isError: false,
      subtype: 'success',
      numTurns: 3,
      durationMs: 4210,
      costUsd: 0.0421,
      usage: { inputTokens: 1200, outputTokens: 210, cacheReadTokens: 9000, cacheWriteTokens: 300 },
      sessionId: 's-1',
      resultText: '{"specHash":"sha256:aa","status":"done"}',
      structuredOutput: null,
      terminalReason: null,
      rateLimit: null,
      compactions: 0,
    });
  });

  it('reports an error result with zeroed usage and counts compactions', () => {
    const summary = summarizeStream(parseStreamJson(fixture('error-max-turns')));
    expect(summary).toMatchObject({
      found: true,
      isError: true,
      subtype: 'error_max_turns',
      numTurns: 25,
      costUsd: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      resultText: null,
      compactions: 1,
    });
  });

  it('reports found=false when the stream ended before a result (killed process)', () => {
    const summary = summarizeStream(parseStreamJson('{"type":"system","subtype":"init","session_id":"s-9"}\n'));
    expect(summary).toMatchObject({ found: false, isError: true, subtype: null, sessionId: 's-9', numTurns: 0 });
  });
});

describe('summarizeStream against real CLI 2.1.281 recordings', () => {
  it('trusts is_error over a success subtype (compaction breaker)', () => {
    const summary = summarizeStream(parseStreamJson(fixture('real-compaction-breaker')));
    expect(summary).toMatchObject({ found: true, isError: true, subtype: 'success', terminalReason: 'rapid_refill_breaker', compactions: 3 });
    expect(summary.usage.cacheWriteTokens).toBeGreaterThan(200000);
  });

  it('exposes structured_output from a --json-schema run', () => {
    const summary = summarizeStream(parseStreamJson(fixture('real-json-schema')));
    expect(summary.structuredOutput).toEqual({ specHash: 'sha256:aa', status: 'done' });
    expect(summary.terminalReason).toBe('completed');
  });

  it('reports the latest rate limit window utilization and reset times', () => {
    const summary = summarizeStream(parseStreamJson(fixture('real-json-schema')));
    expect(summary.rateLimit).toEqual({
      status: 'allowed',
      fiveHourUtilization: 0,
      fiveHourResetsAt: 1790259600,
      sevenDayUtilization: 0.64,
      sevenDayResetsAt: 1790424000,
    });
  });

  it('returns null structured output and rate limit when absent', () => {
    const summary = summarizeStream(parseStreamJson(fixture('success')));
    expect(summary.structuredOutput).toBeNull();
    expect(summary.rateLimit).toBeNull();
    expect(summary.terminalReason).toBeNull();
  });
});
