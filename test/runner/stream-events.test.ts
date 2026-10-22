import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractJsonObject, parseStreamJson, summarizeStream } from '../../server/runner/stream-events.js';

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
      structuredOutput: { specHash: 'sha256:aa', status: 'done' },
      structuredSource: 'text',
      terminalReason: null,
      apiErrorStatus: null,
      rateLimit: null,
      compactions: 0,
      profile: { thinkingTokens: 0, durationApiMs: 0, toolCalls: {}, toolResultChars: 0 },
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

describe('summarizeStream step profile', () => {
  it('counts tool calls by name and the characters of tool results', () => {
    const profile = summarizeStream(parseStreamJson(fixture('real-turns'))).profile!;
    expect(profile.toolCalls).toEqual({ Read: 1 });
    expect(profile.toolResultChars).toBe(2);
  });

  it('counts skill calls by skill name', () => {
    const call = (id: string, skill: string) => JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] } });
    const text = [call('m1', 'teams-ai-dev:test-driven-development'), call('m2', 'teams-ai-dev:test-driven-development'), call('m3', 'teams-ai-dev:systematic-debugging')].join('\n');
    const profile = summarizeStream(parseStreamJson(text)).profile!;
    expect(profile.toolCalls).toEqual({ Skill: 3 });
    expect(profile.skills).toEqual({ 'teams-ai-dev:test-driven-development': 2, 'teams-ai-dev:systematic-debugging': 1 });
  });

  it('flags a tool result that says the sandbox could not start', () => {
    const text = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'Failed to create bridge sockets after 5 attempts' }] }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: '{}', session_id: 's', usage: {} }),
    ].join('\n');
    expect(summarizeStream(parseStreamJson(text)).profile).toMatchObject({ toolCalls: { Bash: 1 }, sandboxInitFailed: true });
    expect(summarizeStream(parseStreamJson(fixture('real-turns'))).profile!.sandboxInitFailed).toBeUndefined();
  });

  it('reads thinking tokens and API time from the result, and still profiles a stream without one', () => {
    const real = summarizeStream(parseStreamJson(fixture('real-json-schema'))).profile!;
    expect(real).toMatchObject({ thinkingTokens: 0, durationApiMs: 2357, toolCalls: {} });
    const withThinking = fixture('real-json-schema').replace('"thinking_tokens":0', '"thinking_tokens":41');
    expect(summarizeStream(parseStreamJson(withThinking)).profile!.thinkingTokens).toBe(41);
    const killed = summarizeStream(parseStreamJson(fixture('killed-partial'))).profile!;
    expect(killed).toMatchObject({ thinkingTokens: 0, durationApiMs: 0 });
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
      resetsAt: 1790259600,
      fiveHourUtilization: 0,
      fiveHourResetsAt: 1790259600,
      sevenDayUtilization: 0.64,
      sevenDayResetsAt: 1790424000,
    });
  });

  it('returns null structured output and rate limit when absent', () => {
    const summary = summarizeStream(parseStreamJson(fixture('error-max-turns')));
    expect(summary.structuredOutput).toBeNull();
    expect(summary.rateLimit).toBeNull();
    expect(summary.terminalReason).toBeNull();
  });
});

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown fences around the object', () => {
    expect(extractJsonObject('```json\n{\n  "status": "done"\n}\n```')).toEqual({ status: 'done' });
    expect(extractJsonObject('Here you go:\n```\n{"x":[1,2]}\n```\nDone.')).toEqual({ x: [1, 2] });
  });

  it('returns null for prose, arrays and invalid JSON', () => {
    expect(extractJsonObject('OK')).toBeNull();
    expect(extractJsonObject('[1,2]')).toBeNull();
    expect(extractJsonObject('{"a":')).toBeNull();
    expect(extractJsonObject(null)).toBeNull();
  });
});

describe('summarizeStream structured output fallback', () => {
  it('falls back to a JSON object in the result text when structured_output is absent', () => {
    const summary = summarizeStream(parseStreamJson('{"type":"result","subtype":"success","is_error":false,"result":"```json\\n{\\"status\\":\\"done\\"}\\n```"}\n'));
    expect(summary.structuredOutput).toEqual({ status: 'done' });
    expect(summary.structuredSource).toBe('text');
  });

  it('reports the source as structured when the CLI provided it', () => {
    const summary = summarizeStream(parseStreamJson(fixture('real-json-schema')));
    expect(summary.structuredSource).toBe('structured_output');
  });

  it('reports no source when neither is present', () => {
    expect(summarizeStream(parseStreamJson(fixture('success'))).structuredSource).toBe('text');
    expect(summarizeStream(parseStreamJson('{"type":"result","subtype":"success","is_error":false,"result":"OK"}\n')).structuredSource).toBeNull();
  });

  it('falls back to result text when structured_output is null', () => {
    const value = { specHash: 'sha256:aa', status: 'done' };
    const summary = summarizeStream(parseStreamJson(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(value), structured_output: null,
    }) + '\n'));
    expect(summary.structuredOutput).toEqual(value);
    expect(summary.structuredSource).toBe('text');
  });
});

describe('summarizeStream partial usage and API error status', () => {
  it('sums assistant usage by distinct message id when the stream has no result', () => {
    const summary = summarizeStream(parseStreamJson(fixture('killed-partial')));
    expect(summary.found).toBe(false);
    expect(summary.usage).toEqual({ inputTokens: 22, outputTokens: 50, cacheReadTokens: 2300, cacheWriteTokens: 300 });
    expect(summary.numTurns).toBe(2);
  });

  it('exposes api_error_status and the top-level rate limit resetsAt', () => {
    const text = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1790259600,"unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":1790259600}}}}',
      '{"type":"result","subtype":"error","is_error":true,"api_error_status":429,"result":"rate limited"}',
    ].join('\n');
    const summary = summarizeStream(parseStreamJson(text));
    expect(summary.apiErrorStatus).toBe(429);
    expect(summary.rateLimit?.resetsAt).toBe(1790259600);
  });

  it('reports null api_error_status when the CLI sends null or nothing', () => {
    expect(summarizeStream(parseStreamJson('{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"result":"OK"}\n')).apiErrorStatus).toBeNull();
    expect(summarizeStream(parseStreamJson(fixture('success'))).apiErrorStatus).toBeNull();
  });
});
