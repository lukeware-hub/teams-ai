import { describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { mergeDoc } from '../../server/git/merge-doc.js';

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

describe('mergeDoc', () => {
  it('joins edits to different parts of a text doc, as git does', async () => {
    const base = '# Flow\n\none\n\ntwo\n\nthree\n';
    const main = '# Flow\n\nONE\n\ntwo\n\nthree\n';
    const draft = '# Flow\n\none\n\ntwo\n\nTHREE\n';
    expect(await mergeDoc('flow.md', base, main, draft, execCommand)).toBe('# Flow\n\nONE\n\ntwo\n\nTHREE\n');
  });

  it('keeps both sides of an edit to the same lines, never failing', async () => {
    const merged = await mergeDoc('flow.md', '# Flow v1\n', '# Flow from another spec\n', '# Flow v2\n', execCommand);
    expect(merged).toContain('# Flow from another spec');
    expect(merged).toContain('# Flow v2');
    expect(merged).not.toMatch(/<<<<<<<|>>>>>>>|=======/);
  });

  it('merges JSON field by field: each side keeps its changes, lists are joined and the draft wins a value both changed', async () => {
    const base = json({ name: 'Shop', vision: 'v0', constraints: ['a'], nested: { x: 1, y: 1 } });
    const main = json({ name: 'Shop', vision: 'v-main', constraints: ['a', 'from main'], nested: { x: 2, y: 1 } });
    const draft = json({ name: 'Shop 2', vision: 'v-draft', constraints: ['a', 'from draft'], nested: { x: 1, y: 3 } });
    expect(JSON.parse(await mergeDoc('project.json', base, main, draft, execCommand))).toEqual({
      name: 'Shop 2',
      vision: 'v-draft',
      constraints: ['a', 'from main', 'from draft'],
      nested: { x: 2, y: 3 },
    });
  });

  it('keeps what main changed in JSON when the draft left it alone, and drops a key the draft removed', async () => {
    const base = json({ a: 1, b: 1, c: 1 });
    const main = json({ a: 2, b: 1, c: 1 });
    const draft = json({ a: 1, b: 1 });
    expect(JSON.parse(await mergeDoc('x.json', base, main, draft, execCommand))).toEqual({ a: 2, b: 1 });
  });
});
