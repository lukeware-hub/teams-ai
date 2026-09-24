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
