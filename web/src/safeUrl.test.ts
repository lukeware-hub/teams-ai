import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './safeUrl.js';

describe('safeHttpUrl', () => {
  it('keeps http(s) URLs and drops every other scheme or non-URL', () => {
    expect(safeHttpUrl('https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1');
    expect(safeHttpUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', 'not a url', '', undefined, null, 42]) {
      expect(safeHttpUrl(bad), String(bad)).toBeUndefined();
    }
  });
});
