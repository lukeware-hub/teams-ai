import { describe, expect, it } from 'vitest';
import { docToJson } from './docJson.js';

describe('docToJson', () => {
  it('splits a Markdown doc into one section per heading', () => {
    const json = docToJson('stack.md', '# Stack\n\nintro\n\n## Banco\n\nPostgres\n');
    expect(json).toEqual({
      doc: 'stack.md',
      sections: [
        { level: 1, heading: 'Stack', body: 'intro' },
        { level: 2, heading: 'Banco', body: 'Postgres' },
      ],
    });
  });

  it('does not take a `#` line inside a code fence for a heading', () => {
    const json = docToJson('flow.md', '## Fluxo\n\n```mermaid\n# not a heading\n```\n');
    expect(json.sections.map((s) => s.heading)).toEqual(['Fluxo']);
    expect(json.sections[0].body).toContain('# not a heading');
  });
});
