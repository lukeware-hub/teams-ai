import { describe, expect, it } from 'vitest';
import { parseStreamJson, summarizeStream } from '../../server/runner/stream-events.js';

const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: '{}', structured_output: null });

/** One web search and one fetch, each with its result: only the search's links count as searched addresses. */
const runWith = (searchResult: unknown) =>
  parseStreamJson([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ws1', name: 'WebSearch', input: { query: 'prazo' } }, { type: 'tool_use', id: 'wf1', name: 'WebFetch', input: { url: 'https://other.example/x' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ws1', content: searchResult }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'wf1', content: 'Visit https://other.example/fetched for more' }] } }),
    result,
  ].join('\n'));

describe('the addresses a web search returned', () => {
  it('keeps the addresses of the search results, in order, and no address of a fetch', () => {
    const summary = summarizeStream(runWith('Links: [{"title":"Prazo","url":"https://example.com/prazo"},{"title":"Outro","url":"https://example.com/outro"}]'));
    expect(summary.webSearchUrls).toEqual(['https://example.com/prazo', 'https://example.com/outro']);
  });

  it('reads the text of a result made of text parts too', () => {
    const summary = summarizeStream(runWith([{ type: 'text', text: 'Links: [{"url":"https://example.com/prazo"}]' }]));
    expect(summary.webSearchUrls).toEqual(['https://example.com/prazo']);
  });

  it('keeps the title and the address of each result, so the answer can name its sources', () => {
    const summary = summarizeStream(runWith('Links: [{"title":"Prazo","url":"https://example.com/prazo"}]'));
    expect(summary.webSearchSources).toEqual([{ title: 'Prazo', url: 'https://example.com/prazo' }]);
  });

  it('is absent when the run made no search', () => {
    const summary = summarizeStream(parseStreamJson(result));
    expect(summary.webSearchUrls).toBeUndefined();
  });
});
